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
const EDITABLE = ['status', 'supplier', 'receipt_date', 'total_inc', 'lines', 'project', 'no_project', 'expense_ids', 'xero_txn_id', 'xero_attached', 'notes', 'xero_status', 'xero_error', 'tax_mode', 'reference'];
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

// The reader is asked for EX-GST amounts, but on receipts that only print GST-inclusive prices (Kimbriki, Warringah Timbers...) it sometimes
// returns those printed prices as they are. Tell: the GST is shown as included, and the lines add up to the printed TOTAL instead of total / 1.1.
// Then every amount is divided by 1.1 so the Hub (which stores ex GST) and Xero get the right numbers.
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
function exGstFix(j) {
  try {
    const c = j.check;
    if (!c || c.gst_status !== 'included' || !(Number(c.total) > 0)) return j;
    const S = j.items.reduce((t, i) => t + (Number(i.amount) || 0), 0), tol = Math.max(0.05, c.total * 0.005);
    if (Math.abs(S - c.total) <= tol && Math.abs(S - c.total / 1.1) > tol) {
      j.items.forEach(i => { i.amount = r2(i.amount / 1.1); i.unit_price = r2(i.unit_price / 1.1); });
      j.check = { ...c, ok: true, lines_inc_gst: r2(S), fixed_inc_gst: true };
    }
  } catch (e) { /* leave as read */ }
  return j;
}
async function readReceipt(event, name, mime, data) {
  try {
    const { handler } = require('./claude-parse');
    // Internal call: authenticate with the server's own secret (the add-only key is not accepted by the reader).
    const internal = {};
    if (process.env.HUB_API_KEY) internal['x-hub-key'] = process.env.HUB_API_KEY;
    else if (process.env.HUB_ADMIN_PASSWORD) internal['x-hub-token'] = crypto.createHash('sha256').update('matiere-hub-admin:' + process.env.HUB_ADMIN_PASSWORD).digest('hex');
    const r = await handler({ httpMethod: 'POST', headers: internal, body: JSON.stringify({ previewOnly: true, images: [{ name, mediaType: mime, data }] }) });
    const j = JSON.parse(r.body);
    if (j.status !== 'preview' || !Array.isArray(j.items) || !j.items.length) return null;
    return exGstFix(j);
  } catch (e) { return null; }
}

// Receipts that should never be processed (our own sales invoices, anything Seb says "never"): rules live in receipt_ignore.
const keyOf = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
async function ignoreReason(supplier, from, subject) {
  let rules = [];
  try { rules = await rest('GET', 'receipt_ignore?select=supplier_key,reason'); } catch (e) { return ''; }
  const hay = [keyOf(supplier), keyOf(from), keyOf(subject)];
  const hit = rules.find(r => r.supplier_key && hay.some(h => h.includes(r.supplier_key)));
  return hit ? (hit.reason || 'Ignored by rule') : '';
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

    // Is this receipt already in the common record (scanned OR pulled in)? Same total within 6c, within 5 days, similar supplier.
    if (b.action === 'find_match') {
      const total = Number(b.total), d = String(b.date || '').slice(0, 10);
      if (!(total > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return out(200, { ok: true, matches: [] });
      const t = new Date(d + 'T00:00:00Z').getTime(), day = 86400000;
      const iso = (x) => new Date(x).toISOString().slice(0, 10);
      const rows = await rest('GET', `receipt_inbox?select=id,status,source,supplier,receipt_date,total_inc,xero_status&status=in.(pending,processed)&receipt_date=gte.${iso(t - 5 * day)}&receipt_date=lte.${iso(t + 5 * day)}`);
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const sup = norm(b.supplier);
      const matches = rows.filter(r => r.total_inc != null && Math.abs(Number(r.total_inc) - total) <= 0.06 && (!sup || !norm(r.supplier) || norm(r.supplier).includes(sup.slice(0, 5)) || sup.includes(norm(r.supplier).slice(0, 5))));
      return out(200, { ok: true, matches });
    }

    if (b.action === 'add') {
      const mime = String(b.mime || '').toLowerCase();
      if (!ALLOWED_MIME.test(mime)) return out(400, { error: 'Only photos and PDFs can be added' });
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length) return out(400, { error: 'Empty file' });
      if (buf.length > 4.5 * 1024 * 1024) return out(413, { error: 'File is over 4.5 MB' });
      const hash = crypto.createHash('sha256').update(buf).update(String(b.salt || '')).digest('hex');
      const dup = await rest('GET', `receipt_inbox?select=id,status,supplier,receipt_date,total_inc&file_hash=eq.${hash}`);
      if (dup.length) return out(200, { ok: true, duplicate: true, row: dup[0] });
      const day = new Date().toISOString().slice(0, 7);
      const path = `${day}/${hash.slice(0, 24)}.${extOf(mime)}`;
      const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST', headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buf
      });
      if (!up.ok) throw new Error('File upload failed: ' + (await up.text()).slice(0, 200));
      // prefill = already read by the multi-receipt import (no second reading)
      const parsed = b.prefill && Array.isArray(b.prefill.items) && b.prefill.items.length
        ? { items: b.prefill.items, supplier: b.prefill.supplier || '', check: b.prefill.check || null }
        : await readReceipt(event, b.name || 'receipt', mime, String(b.data));
      const items = parsed ? parsed.items : [];
      const first = items[0] || {};
      const supplierRead = parsed ? (parsed.supplier || first.supplier || '') : '';
      const ignoredWhy = await ignoreReason(supplierRead, b.email_from, b.email_subject);
      // Same receipt already scanned (or pulled in) from a different photo? Flag it on the card, don't hide it.
      let dupNote = '';
      try {
        const tot0 = parsed && parsed.check && parsed.check.total ? Number(parsed.check.total) : 0, d0 = String(first.date || '').slice(0, 10);
        if (!ignoredWhy && tot0 > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d0)) {
          const t0 = new Date(d0 + 'T00:00:00Z').getTime(), iso0 = (x) => new Date(x).toISOString().slice(0, 10);
          const near = await rest('GET', `receipt_inbox?select=id,status,source,supplier,receipt_date,total_inc&status=in.(pending,processed)&receipt_date=gte.${iso0(t0 - 5 * 86400000)}&receipt_date=lte.${iso0(t0 + 5 * 86400000)}`);
          const hit = near.find(r => r.total_inc != null && Math.abs(Number(r.total_inc) - tot0) <= 0.06);
          if (hit) dupNote = `Possible duplicate: a receipt for the same total (${hit.supplier || 'unknown'}, ${hit.receipt_date}) is already in the record as ${hit.status}${hit.source === 'scan' ? ' (scanned)' : ''}.`;
        }
      } catch (e) { /* the check is a courtesy only */ }
      const row = (await rest('POST', 'receipt_inbox', {
        status: ignoredWhy ? 'ignored' : 'pending', notes: ignoredWhy || dupNote || '', source: ['upload', 'photo', 'email', 'scan'].includes(b.source) ? b.source : 'upload',
        file_path: path, file_name: String(b.name || '').slice(0, 120), mime, size: buf.length, file_hash: hash,
        email_from: String(b.email_from || '').slice(0, 200), email_subject: String(b.email_subject || '').slice(0, 300), email_date: b.email_date || null,
        supplier: parsed ? (parsed.supplier || first.supplier || '') : '', receipt_date: first.date || b.email_date || null,
        total_inc: parsed && parsed.check && parsed.check.total ? parsed.check.total : (items.length ? Math.round(items.reduce((t, i) => t + (Number(i.amount) || 0), 0) * 110) / 100 : null),
        lines: items, check_info: parsed ? parsed.check : null, reference: parsed && parsed.check && parsed.check.invoice_no ? parsed.check.invoice_no : ''
      }))[0];
      return out(200, { ok: true, row, read: !!parsed });
    }

    // Reads a PDF (a few pages of a combined export) that holds SEVERAL receipts; returns each with its page range.
    if (b.action === 'read_multi') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key || !b.data) return out(400, { error: 'Missing data' });
      const prompt = `This PDF holds several separate receipts / tax invoices one after another (e.g. Bunnings). A receipt may run over several pages; two short receipts may share a page. Return ONLY a JSON array, one object per receipt, in order:
[{"first_page":1,"last_page":1,"complete":true,"supplier":"Bunnings","date":"YYYY-MM-DD","invoice_number":"","gst_status":"included","receipt_total":123.45,"lines":[{"description":"","qty":1,"unit_price":0.00,"amount":0.00}]}]
Rules: pages are numbered from 1 within this PDF. "complete" is false only if the LAST receipt is cut off at the end of this PDF (its total is not shown yet). Include EVERY product line, none merged or skipped. unit_price and amount are EX-GST (divide printed GST-inclusive prices by 1.1 and round to 2dp; if gst_status is "none" because the receipt shows no GST, use printed prices). gst_status: "included", "none" or "unknown". receipt_total = the grand total paid as printed (inc GST) or null. date = printed date as YYYY-MM-DD; Australian receipts print DAY first (02/11/2026 = 2 November 2026). Include returns and credit notes with negative amounts. Do not include totals, GST, rounding, change or payment lines as products.`;
      const run = async (model) => {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(b.data) } }, { type: 'text', text: prompt }] }] }) });
        const d = await r.json();
        if (!r.ok) throw new Error((d.error && d.error.message) || 'Claude error ' + r.status);
        const raw = d.content[0].text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        const arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
        return Array.isArray(arr) ? arr : [];
      };
      let arr;
      try { arr = await run('claude-haiku-4-5-20251001'); } catch (e) { arr = await run('claude-sonnet-4-6'); }
      const receipts = arr.filter(x => x && Array.isArray(x.lines) && x.lines.length).map(x => {
        const sum = x.lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
        const tot = x.receipt_total != null ? parseFloat(x.receipt_total) : null;
        const tol = tot ? Math.max(1, Math.abs(tot) * 0.03) : 0;
        const ok = !tot || Math.abs(sum * 1.1 - tot) <= tol || Math.abs(sum - tot) <= tol;
        return { first_page: x.first_page, last_page: x.last_page, complete: x.complete !== false, supplier: x.supplier || '', date: x.date || '', invoice_number: x.invoice_number || '',
          gst_status: x.gst_status || 'unknown', receipt_total: tot, check_ok: ok, lines: x.lines.map(l => ({ description: String(l.description || ''), qty: parseFloat(l.qty) || 1, unit_price: parseFloat(l.unit_price) || 0, amount: parseFloat(l.amount) || 0 })) };
      });
      return out(200, { ok: true, receipts });
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

    if (b.action === 'reread') {
      const r = (await rest('GET', `receipt_inbox?select=*&id=eq.${encodeURIComponent(b.id)}`))[0];
      if (!r) return out(404, { error: 'Not found' });
      const f = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${r.file_path}`, { headers: sbHeaders() });
      if (!f.ok) throw new Error('Could not read the stored file');
      const data = Buffer.from(await f.arrayBuffer()).toString('base64');
      const parsed = await readReceipt(event, r.file_name || 'receipt', r.mime, data);
      if (!parsed) return out(200, { ok: true, read: false, row: r });
      if (b.only_ref) {   // keep everything Seb already edited; just learn the invoice number
        const inv = parsed.check && parsed.check.invoice_no ? parsed.check.invoice_no : '';
        const row2 = (await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(b.id)}`, { ...(inv ? { reference: inv } : {}), updated_at: new Date().toISOString() }))[0];
        return out(200, { ok: true, read: true, invoice_no: inv, row: row2 });
      }
      const items = parsed.items, first = items[0] || {};
      const why = r.status === 'pending' ? await ignoreReason(parsed.supplier || first.supplier, r.email_from, r.email_subject) : '';
      const row = (await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(b.id)}`, {
        ...(why ? { status: 'ignored', notes: why } : {}),
        supplier: parsed.supplier || first.supplier || r.supplier || '', receipt_date: first.date || r.receipt_date || r.email_date || null,
        total_inc: parsed.check && parsed.check.total ? parsed.check.total : Math.round(items.reduce((t2, i) => t2 + (Number(i.amount) || 0), 0) * 110) / 100,
        lines: items, check_info: parsed.check, ...(parsed.check && parsed.check.invoice_no && !r.reference ? { reference: parsed.check.invoice_no } : {}), updated_at: new Date().toISOString()
      }))[0];
      return out(200, { ok: true, read: true, row });
    }

    if (b.action === 'ignore_rule') {
      const k = keyOf(b.supplier);
      if (k.length < 3) return out(400, { error: 'Supplier name too short' });
      await rest('POST', 'receipt_ignore', { supplier_key: k, supplier: String(b.supplier).slice(0, 80), reason: b.reason || 'Not a cost — ignored' });
      // also move anything already waiting from that supplier
      const waiting = await rest('GET', 'receipt_inbox?select=id,supplier,email_from,email_subject&status=eq.pending');
      let moved = 0;
      for (const w of waiting) { if ([keyOf(w.supplier), keyOf(w.email_from), keyOf(w.email_subject)].some(h => h.includes(k))) { await rest('PATCH', `receipt_inbox?id=eq.${w.id}`, { status: 'ignored', notes: b.reason || 'Not a cost — ignored', updated_at: new Date().toISOString() }); moved++; } }
      return out(200, { ok: true, moved });
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
