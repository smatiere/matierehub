// Receipt Inbox — one place for every receipt (photo, upload, email) until it is sorted.
// POST { action, ... } behind the Hub login (or HUB_API_KEY for the Comms Hub / iPhone Shortcut).
//   add         { name, mime, data(base64), source?, email_from?, email_subject?, email_date? } -> stores the file, reads it, creates a Pending row
//   list        { status? }                       -> rows (no file data) + counts per pile
//   url         { id }                            -> short-lived link to view the original file
//   update      { id, fields }                    -> edit / move between piles (allow-listed fields)
//   xero_attach { id, txn_id, access_token, tenant_id } -> attaches the original file to a Xero bank transaction
// Files live in a PRIVATE Supabase Storage bucket ("receipts"); the table has no public read access.
const crypto = require('crypto');
const https = require('https');
const { guardHub } = require('../lib/hub-guard');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'receipts';
const EDITABLE = ['status', 'supplier', 'receipt_date', 'total_inc', 'lines', 'project', 'no_project', 'expense_ids', 'xero_txn_id', 'xero_attached', 'notes'];
const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

const sbHeaders = (extra) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...(extra || {}) });
async function rest(method, path, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' }),
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Database ${method} ${path.split('?')[0]} failed: ${res.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : [];
}
const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf' }[mime] || 'bin');

async function readReceipt(event, name, mime, data) {
  try {
    const { handler } = require('./claude-parse');
    const r = await handler({ httpMethod: 'POST', headers: event.headers, body: JSON.stringify({ previewOnly: true, images: [{ name, mediaType: mime, data }] }) });
    const j = JSON.parse(r.body);
    if (j.status !== 'preview' || !Array.isArray(j.items) || !j.items.length) return null;
    return j;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-hub-key',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  const out = (code, o) => ({ statusCode: code, headers, body: JSON.stringify(o) });
  try {
    const b = JSON.parse(event.body || '{}');
    // RECEIPT_INBOX_KEY (given to the Comms Hub / iPhone Shortcut) can ONLY add receipts. Everything else needs the Hub login.
    const sent = (event.headers && (event.headers['x-hub-key'] || event.headers['X-Hub-Key'])) || '';
    const inboxKey = process.env.RECEIPT_INBOX_KEY;
    const addOnly = inboxKey && b.action === 'add' && sent && sent.length === inboxKey.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(inboxKey));
    if (!addOnly) { const denied = guardHub(event, headers); if (denied) return denied; }

    if (b.action === 'add') {
      const mime = String(b.mime || '').toLowerCase();
      if (!ALLOWED_MIME.test(mime)) return out(400, { error: 'Only photos and PDFs can be added' });
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return out(400, { error: 'Empty file' });
      if (buf.length > 4.5 * 1024 * 1024) return out(413, { error: 'File is over 4.5 MB' });
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const dup = await rest('GET', `receipt_inbox?select=id,status,supplier,receipt_date,total_inc&file_hash=eq.${hash}`);
      if (dup.length) return out(200, { ok: true, duplicate: true, row: dup[0] });
      const day = new Date().toISOString().slice(0, 7);
      const path = `${day}/${hash.slice(0, 24)}.${extOf(mime)}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST', headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buf
      });
      if (!up.ok) throw new Error('File upload failed: ' + (await up.text()).slice(0, 200));
      const parsed = await readReceipt(event, b.name || 'receipt', mime, String(b.data));
      const items = parsed ? parsed.items : [];
      const first = items[0] || {};
      const row = (await rest('POST', 'receipt_inbox', {
        status: 'pending', source: ['upload', 'photo', 'email'].includes(b.source) ? b.source : 'upload',
        file_path: path, file_name: String(b.name || '').slice(0, 120), mime, size: buf.length, file_hash: hash,
        email_from: String(b.email_from || '').slice(0, 200), email_subject: String(b.email_subject || '').slice(0, 300), email_date: b.email_date || null,
        supplier: parsed ? (parsed.supplier || first.supplier || '') : '', receipt_date: first.date || b.email_date || null,
        total_inc: parsed && parsed.check && parsed.check.total ? parsed.check.total : (items.length ? Math.round(items.reduce((t, i) => t + (Number(i.amount) || 0), 0) * 110) / 100 : null),
        lines: items, check_info: parsed ? parsed.check : null
      }))[0];
      return out(200, { ok: true, row, read: !!parsed });
    }

    if (b.action === 'list') {
      const counts = {};
      const all = await rest('GET', 'receipt_inbox?select=id,status');
      all.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);
      const order = b.status === 'pending' ? 'received_at.asc' : 'updated_at.desc';
      const flt = b.status === 'all' ? '' : `&status=eq.${encodeURIComponent(b.status || 'pending')}`;
      const rows = await rest('GET', `receipt_inbox?select=*${flt}&order=${order}&limit=500`);
      return out(200, { ok: true, rows, counts });
    }

    if (b.action === 'url') {
      const r = (await rest('GET', `receipt_inbox?select=file_path,mime&id=eq.${encodeURIComponent(b.id)}`))[0];
      if (!r) return out(404, { error: 'Not found' });
      const s = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${r.file_path}`, {
        method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600 })
      });
      const j = await s.json();
      if (!s.ok || !j.signedURL) throw new Error('Could not link the file');
      return out(200, { ok: true, url: `${SUPABASE_URL}/storage/v1${j.signedURL}`, mime: r.mime });
    }

    if (b.action === 'update') {
      const fields = {};
      EDITABLE.forEach(k => { if (b.fields && k in b.fields) fields[k] = b.fields[k]; });
      if (!Object.keys(fields).length) return out(400, { error: 'Nothing to update' });
      fields.updated_at = new Date().toISOString();
      const row = (await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(b.id)}`, fields))[0];
      return out(200, { ok: true, row });
    }

    if (b.action === 'xero_attach') {
      const r = (await rest('GET', `receipt_inbox?select=*&id=eq.${encodeURIComponent(b.id)}`))[0];
      if (!r) return out(404, { error: 'Not found' });
      const f = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${r.file_path}`, { headers: sbHeaders() });
      if (!f.ok) throw new Error('Could not read the stored file');
      const buf = Buffer.from(await f.arrayBuffer());
      const nice = String((r.supplier || 'receipt') + '-' + (r.receipt_date || '')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) + '.' + extOf(r.mime);
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.xero.com', path: `/api.xro/2.0/BankTransactions/${encodeURIComponent(b.txn_id)}/Attachments/${encodeURIComponent(nice)}`, method: 'PUT',
          headers: { Authorization: `Bearer ${b.access_token}`, 'Xero-Tenant-Id': b.tenant_id, 'Content-Type': r.mime, 'Content-Length': buf.length, Accept: 'application/json' }
        }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d })); });
        req.on('error', reject); req.write(buf); req.end();
      });
      if (res.status >= 400) throw new Error('Xero refused the attachment: ' + res.body.slice(0, 200));
      await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(b.id)}`, { xero_txn_id: b.txn_id, xero_attached: true, updated_at: new Date().toISOString() });
      return out(200, { ok: true, filename: nice });
    }

    return out(400, { error: 'Unknown action' });
  } catch (e) {
    return out(500, { error: e.message });
  }
};
