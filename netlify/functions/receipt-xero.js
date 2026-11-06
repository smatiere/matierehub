// Sends saved receipts from the Receipt Inbox to Xero as Spend Money, with the original file attached.
// Uses the server's own Xero connection (same as the quoting connector), so nothing needs connecting on a phone.
// POST { action:'status' }                   -> how many are waiting / failed, and which bank account will be used
// POST { action:'push', ids?:[...] }         -> sends up to 4 queued receipts (or the given ids); call again while remaining > 0
// Auth: the Hub login, or "Authorization: Bearer <SYNC_SECRET>" (for the scheduled batch).
const crypto = require('crypto');
const https = require('https');
const { guardHub } = require('../lib/hub-guard');
const { getAccessToken, getTenantId, xeroCall } = require('./xero-mcp').xeroServer;

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'receipts';
const sbH = (x) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, ...(x || {}) });
async function rest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: sbH({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Database ${method} failed: ${res.status} ${txt.slice(0, 160)}`);
  return txt ? JSON.parse(txt) : [];
}
const ext = (m) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf' }[m] || 'bin');

function authorised(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const s = process.env.SYNC_SECRET;
  if (s && h.startsWith('Bearer ') && h.slice(7).length === s.length && crypto.timingSafeEqual(Buffer.from(h.slice(7)), Buffer.from(s))) return true;
  return false;
}

async function xeroContext() {
  const token = await getAccessToken();
  const tenant = await getTenantId(token);
  const accs = (await xeroCall('Accounts', 'GET', token, tenant)).Accounts || [];
  const expenseMap = {};
  accs.filter(a => a.Class === 'EXPENSE').forEach(a => { if (a.Name) expenseMap[a.Name.toLowerCase().trim()] = a.Code; });
  const banks = accs.filter(a => a.Type === 'BANK' && a.Status === 'ACTIVE');
  let bank = null;
  if (process.env.XERO_RECEIPTS_BANK_ID) bank = banks.find(b => b.AccountID === process.env.XERO_RECEIPTS_BANK_ID);
  if (!bank && process.env.XERO_RECEIPTS_BANK_NAME) bank = banks.find(b => String(b.Name).toLowerCase().includes(String(process.env.XERO_RECEIPTS_BANK_NAME).toLowerCase()));
  if (!bank && banks.length === 1) bank = banks[0];
  return { token, tenant, expenseMap, banks, bank };
}

async function findOrCreateContact(ctx, name) {
  const safe = String(name).replace(/"/g, '');
  const found = await xeroCall(`Contacts?where=${encodeURIComponent('Name=="' + safe + '"')}`, 'GET', ctx.token, ctx.tenant);
  if (found.Contacts && found.Contacts.length) return found.Contacts[0].ContactID;
  const loose = await xeroCall(`Contacts?searchTerm=${encodeURIComponent(safe)}`, 'GET', ctx.token, ctx.tenant);
  const hit = (loose.Contacts || []).find(c => (c.Name || '').toLowerCase() === safe.toLowerCase()) || (loose.Contacts || []).find(c => (c.Name || '').toLowerCase().includes(safe.toLowerCase()));
  if (hit) return hit.ContactID;
  const made = await xeroCall('Contacts', 'POST', ctx.token, ctx.tenant, { Contacts: [{ Name: safe }] });
  return made.Contacts[0].ContactID;
}

function attach(ctx, txnId, filename, mime, buf, kind) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.xero.com', method: 'PUT', path: `/api.xro/2.0/${kind || 'BankTransactions'}/${encodeURIComponent(txnId)}/Attachments/${encodeURIComponent(filename)}`,
      headers: { Authorization: `Bearer ${ctx.token}`, 'Xero-Tenant-Id': ctx.tenant, 'Content-Type': mime, 'Content-Length': buf.length, Accept: 'application/json' }
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
    req.on('error', reject); req.write(buf); req.end();
  });
}

// Is this already in Xero? Looks for a payment with the same total within a few days: first under the same contact, then
// (because the bank feed often names the supplier differently: "Bunnings" vs "Bunnings Warehouse") by amount and date alone.
async function findExisting(ctx, contactId, date, expectedInc, supplierName) {
  const d = new Date(date + 'T00:00:00Z'), pad = (n) => String(n).padStart(2, '0');
  const dt = (x) => `DateTime(${x.getUTCFullYear()},${pad(x.getUTCMonth() + 1)},${pad(x.getUTCDate())})`;
  const lo = new Date(d.getTime() - 5 * 86400000), hi = new Date(d.getTime() + 5 * 86400000);
  const range = `Date>=${dt(lo)}&&Date<=${dt(hi)}`;
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const similar = (a2, b2) => { const x = norm(a2), y = norm(b2); return x && y && (x.includes(y.slice(0, 5)) || y.includes(x.slice(0, 5))); };
  const dayDiff = (x) => Math.abs(new Date(String(x.DateString || x.Date || '').slice(0, 10) + 'T00:00:00Z').getTime() - d.getTime());
  const pick = (list, idKey, kind) => {
    const fits = list.filter(x => Math.abs(Number(x.Total) - expectedInc) <= 0.06);
    if (!fits.length) return null;
    // prefer one with no file yet, then the closest date
    fits.sort((p, q) => (p.HasAttachments ? 1 : 0) - (q.HasAttachments ? 1 : 0) || dayDiff(p) - dayDiff(q));
    return { id: fits[0][idKey], kind, contact: (fits[0].Contact && fits[0].Contact.Name) || '', hadFile: !!fits[0].HasAttachments, multiple: fits.length > 1, total: Number(fits[0].Total), date: String(fits[0].DateString || fits[0].Date || '').slice(0, 10) };
  };
  try {
    if (contactId) {
      const bt = await xeroCall(`BankTransactions?where=${encodeURIComponent(`Contact.ContactID==Guid("${contactId}")&&Status!="DELETED"&&${range}`)}`, 'GET', ctx.token, ctx.tenant);
      const a = pick(bt.BankTransactions || [], 'BankTransactionID', 'BankTransactions'); if (a) return a;
    }
    // any contact, our bank account, matching name loosely OR a unique amount match
    const all = await xeroCall(`BankTransactions?where=${encodeURIComponent(`Type=="SPEND"&&Status!="DELETED"&&${range}`)}`, 'GET', ctx.token, ctx.tenant);
    const mine = (all.BankTransactions || []).filter(x => !ctx.bank || !x.BankAccount || x.BankAccount.AccountID === ctx.bank.AccountID);
    const byName = pick(mine.filter(x => similar(x.Contact && x.Contact.Name, supplierName)), 'BankTransactionID', 'BankTransactions'); if (byName) return byName;
    if (!contactId) return null;
    const iv = await xeroCall(`Invoices?where=${encodeURIComponent(`Type=="ACCPAY"&&Contact.ContactID==Guid("${contactId}")&&Status!="VOIDED"&&Status!="DELETED"&&${range}`)}`, 'GET', ctx.token, ctx.tenant);
    const b2 = pick(iv.Invoices || [], 'InvoiceID', 'Invoices'); if (b2) return b2;
  } catch (e) { /* if the lookup itself fails, carry on and create */ }
  return null;
}

async function pushOne(ctx, r) {
  if (!ctx.bank) throw new Error(ctx.banks.length ? 'More than one bank account in Xero — set XERO_RECEIPTS_BANK_ID' : 'No active bank account found in Xero');
  const lines = Array.isArray(r.lines) ? r.lines : [];
  if (!lines.length) throw new Error('No lines on this receipt');
  const sup = (r.supplier || '').trim() || 'Unknown supplier';
  const contactId = await findOrCreateContact(ctx, sup);
  const taxType = r.tax_mode === 'free' ? 'EXEMPTEXPENSES' : r.tax_mode === 'excl' ? 'BASEXCLUDED' : 'INPUT';
  const sundry = ctx.expenseMap['sundry expenses'];
  const lineItems = lines.map(l => {
    const code = ctx.expenseMap[String(l.category || '').toLowerCase().trim()] || sundry;
    if (!code) throw new Error(`No Xero account for category "${l.category || '(blank)'}"`);
    return { Description: l.description || '(no description)', Quantity: parseFloat(l.qty) || 1, UnitAmount: parseFloat(l.unit_price) || 0, AccountCode: code, TaxType: taxType };
  });
  const date = String(r.receipt_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  // Never create a second copy: if Xero already has it, just attach the file to that one.
  const sumEx = lines.reduce((t2, l) => t2 + (parseFloat(l.qty) || 1) * (parseFloat(l.unit_price) || 0), 0);
  const expectedInc = r.total_inc != null ? Number(r.total_inc) : (r.tax_mode === 'gst' || !r.tax_mode ? sumEx * 1.1 : sumEx);
  const have = await findExisting(ctx, contactId, date, expectedInc, sup);
  if (have) {
    const f0 = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${r.file_path}`, { headers: sbH() });
    let att0 = !!have.hadFile;
    if (f0.ok && !have.hadFile) { const buf0 = Buffer.from(await f0.arrayBuffer()); const nm = String(sup + '-' + date).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) + '.' + ext(r.mime); att0 = (await attach(ctx, have.id, nm, r.mime, buf0, have.kind)).status < 400; }
    await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(r.id)}`, { xero_status: 'sent', xero_txn_id: have.id, xero_attached: att0, xero_error: `Already in Xero (${have.kind === 'Invoices' ? 'as a bill' : 'as Spend Money'}${have.contact ? ', under ' + have.contact : ''}) — nothing duplicated${have.hadFile ? ' (it already had a file, so none added)' : att0 ? ', file attached to it' : ''}`, xero_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return { id: r.id, ok: true, attached: att0, existing: true };
  }
  const mk = (status) => ({ BankTransactions: [{
    Type: 'SPEND', Contact: { ContactID: contactId }, Date: date, Status: status, LineAmountTypes: 'Exclusive',
    Reference: r.reference || `MatiereHub — ${sup} ${date}`, BankAccount: { AccountID: ctx.bank.AccountID }, LineItems: lineItems
  }] });
  let res, used = 'DRAFT';
  try { res = await xeroCall('BankTransactions', 'POST', ctx.token, ctx.tenant, mk('DRAFT')); }
  catch (e1) {
    // Xero may not allow a draft Spend Money: try again as an approved entry, and report BOTH reasons if that fails too.
    used = 'AUTHORISED';
    try { res = await xeroCall('BankTransactions', 'POST', ctx.token, ctx.tenant, mk('AUTHORISED')); }
    catch (e2) { throw new Error(`Xero said: ${String(e2.message).replace(/^Xero API error \d+ on POST BankTransactions: /, '')} (draft attempt: ${String(e1.message).replace(/^Xero API error \d+ on POST BankTransactions: /, '').slice(0, 160)})`); }
  }
  const txn = res.BankTransactions && res.BankTransactions[0];
  if (!txn || !txn.BankTransactionID) throw new Error('Xero did not return the new transaction');
  // the original file
  const f = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${r.file_path}`, { headers: sbH() });
  let attached = false, attachNote = '';
  if (f.ok) {
    const buf = Buffer.from(await f.arrayBuffer());
    const nice = String(sup + '-' + date).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) + '.' + ext(r.mime);
    const a = await attach(ctx, txn.BankTransactionID, nice, r.mime, buf);
    attached = a.status < 400; if (!attached) attachNote = 'File did not attach: ' + a.body.slice(0, 120);
  } else attachNote = 'Could not read the stored file';
  await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(r.id)}`, {
    xero_status: 'sent', xero_txn_id: txn.BankTransactionID, xero_attached: attached, xero_error: attachNote || (used === 'AUTHORISED' ? 'Posted as approved (Xero has no draft for Spend Money)' : ''),
    xero_sent_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  return { id: r.id, ok: true, attached, status: used };
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-hub-key, Authorization', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  const out = (c, o) => ({ statusCode: c, headers, body: JSON.stringify(o) });
  try {
    const b = JSON.parse(event.body || '{}');
    // The shared server secret (used by the scheduled GitHub batch) may ONLY run the batch push, never read anything.
    if (!(authorised(event) && b.action === 'push' && !b.ids)) { const denied = guardHub(event, headers); if (denied) return denied; }
    if (b.action === 'status') {
      const rows = await rest('GET', 'receipt_inbox?select=id,xero_status&status=eq.processed');
      const n = (s) => rows.filter(r => (r.xero_status || '') === s).length;
      let bank = null, note = '';
      try { const c = await xeroContext(); bank = c.bank ? c.bank.Name : null; if (!c.bank) note = c.banks.length ? 'More than one bank account' : 'No bank account'; } catch (e) { note = e.message; }
      return out(200, { ok: true, queued: n('queued'), failed: n('failed'), sent: n('sent'), bank, note });
    }
    // The expense accounts exactly as they are in Xero's chart of accounts (what the Inbox category list shows).
    if (b.action === 'accounts') {
      const c = await xeroContext();
      const accs = (await xeroCall('Accounts', 'GET', c.token, c.tenant)).Accounts || [];
      const list = accs.filter(a => a.Class === 'EXPENSE' && a.Status === 'ACTIVE' && a.Name).map(a => ({ code: a.Code, name: a.Name, type: a.Type }));
      return out(200, { ok: true, accounts: list });
    }
    // Review-time look: is this receipt already in Xero? Never creates anything.
    if (b.action === 'check') {
      const rr = (await rest('GET', `receipt_inbox?select=*&id=eq.${encodeURIComponent(b.id)}`))[0];
      if (!rr) return out(404, { error: 'Receipt not found' });
      const date = String(b.date || rr.receipt_date || '').slice(0, 10), sup = String(b.supplier || rr.supplier || '').trim();
      const total = b.total != null && b.total !== '' ? Number(b.total) : (rr.total_inc != null ? Number(rr.total_inc) : NaN);
      if (!date || !sup || !(total > 0)) return out(200, { ok: true, found: false, skipped: true });
      const c = await xeroContext();
      const safe = sup.replace(/"/g, '');
      const f = await xeroCall(`Contacts?where=${encodeURIComponent('Name=="' + safe + '"')}`, 'GET', c.token, c.tenant);
      const contactId = f.Contacts && f.Contacts.length ? f.Contacts[0].ContactID : null;
      const have = await findExisting(c, contactId, date, total, sup);
      return out(200, { ok: true, found: !!have, have: have ? { id: have.id, kind: have.kind, contact: have.contact, hadFile: have.hadFile, total: have.total, date: have.date, multiple: have.multiple } : null });
    }
    // Many receipts at once: one pass over the year's Spend Money in Xero (a handful of calls), matched in memory.
    // Same rule as the single check: same amount (within 6c) within 5 days, on our bank account, similar supplier name.
    if (b.action === 'check_many') {
      const items = (Array.isArray(b.items) ? b.items : []).filter(x => x && x.id && x.date && Number(x.total) > 0).slice(0, 300);
      if (!items.length) return out(200, { ok: true, results: [] });
      const c = await xeroContext();
      const day = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z').getTime();
      const lo = new Date(Math.min(...items.map(x => day(x.date))) - 6 * 86400000), hi = new Date(Math.max(...items.map(x => day(x.date))) + 6 * 86400000);
      const pad = (n) => String(n).padStart(2, '0'), dt = (x) => `DateTime(${x.getUTCFullYear()},${pad(x.getUTCMonth() + 1)},${pad(x.getUTCDate())})`;
      const where = encodeURIComponent(`Type=="SPEND"&&Status!="DELETED"&&Date>=${dt(lo)}&&Date<=${dt(hi)}`);
      let txns = [];
      for (let page = 1; page <= 8; page++) {
        const r = await xeroCall(`BankTransactions?where=${where}&page=${page}`, 'GET', c.token, c.tenant);
        const got = r.BankTransactions || []; txns = txns.concat(got); if (got.length < 100) break;
      }
      txns = txns.filter(x => !c.bank || !x.BankAccount || x.BankAccount.AccountID === c.bank.AccountID);
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const similar = (a2, b2) => { const x = norm(a2), y = norm(b2); return x && y && (x.includes(y.slice(0, 5)) || y.includes(x.slice(0, 5))); };
      const results = items.map(it => {
        const d0 = day(it.date);
        const fits = txns.filter(x => Math.abs(Number(x.Total) - Number(it.total)) <= 0.06 && Math.abs(day(String(x.DateString || x.Date || '').slice(0, 10) || '1970-01-01') - d0) <= 5 * 86400000 && similar(x.Contact && x.Contact.Name, it.supplier));
        fits.sort((p2, q) => (p2.HasAttachments ? 1 : 0) - (q.HasAttachments ? 1 : 0));
        const h = fits[0];
        return h ? { id: it.id, found: true, hadFile: !!h.HasAttachments, txn: h.BankTransactionID, contact: (h.Contact && h.Contact.Name) || '' } : { id: it.id, found: false };
      });
      return out(200, { ok: true, results, scanned: txns.length });
    }
    if (b.action === 'banks') {
      const c = await xeroContext();
      return out(200, { ok: true, chosen: c.bank ? c.bank.Name : null, banks: c.banks.map(x => ({ id: x.AccountID, name: x.Name, code: x.Code, bank_type: x.BankAccountType, currency: x.CurrencyCode })) });
    }
    // Xero payments (Spend Money) from the last 90 days with no file attached, and any Inbox receipt that looks like each one.
    if (b.action === 'needs_receipt') {
      const c = await xeroContext();
      const since = new Date(Date.now() - 90 * 86400000), pad = (n) => String(n).padStart(2, '0');
      const where = encodeURIComponent(`Type=="SPEND"&&Status!="DELETED"&&Date>=DateTime(${since.getUTCFullYear()},${pad(since.getUTCMonth() + 1)},${pad(since.getUTCDate())})`);
      let txns = [];
      for (let page = 1; page <= 4; page++) {
        const r = await xeroCall(`BankTransactions?where=${where}&page=${page}`, 'GET', c.token, c.tenant);
        const got = r.BankTransactions || []; txns = txns.concat(got); if (got.length < 100) break;
      }
      const bare = txns.filter(x => !x.HasAttachments);
      const inbox = await rest('GET', 'receipt_inbox?select=id,status,supplier,receipt_date,total_inc,xero_status,xero_txn_id&status=in.(pending,processed)');
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const day = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime();
      const items = bare.map(x => {
        const name = (x.Contact && x.Contact.Name) || '';
        const xd = day(String(x.DateString || x.Date || '').slice(0, 10) || '1970-01-01');
        const cands = inbox.filter(r => r.total_inc != null && Math.abs(Number(r.total_inc) - Number(x.Total)) <= 0.06 && r.receipt_date && Math.abs(day(r.receipt_date) - xd) <= 6 * 86400000 &&
          (norm(r.supplier).includes(norm(name).slice(0, 5)) || norm(name).includes(norm(r.supplier).slice(0, 5)))).map(r => ({ id: r.id, status: r.status, xero_status: r.xero_status }));
        return { id: x.BankTransactionID, date: String(x.DateString || '').slice(0, 10), contact: name, total: Number(x.Total), reference: x.Reference || '', candidates: cands };
      });
      return out(200, { ok: true, checked: txns.length, without_receipt: items.length, items });
    }
    if (b.action === 'push') {
      const ids = Array.isArray(b.ids) && b.ids.length ? b.ids : null;
      const filter = ids ? `id=in.(${ids.map(encodeURIComponent).join(',')})` : `xero_status=eq.queued`;
      const rows = await rest('GET', `receipt_inbox?select=*&status=eq.processed&${filter}&order=receipt_date.asc&limit=${ids ? ids.length : 4}`);
      const ctx = rows.length ? await xeroContext() : null;
      const results = [];
      for (const r of rows) {
        try { results.push(await pushOne(ctx, r)); }
        catch (e) {
          await rest('PATCH', `receipt_inbox?id=eq.${encodeURIComponent(r.id)}`, { xero_status: 'failed', xero_error: String(e.message).slice(0, 300), updated_at: new Date().toISOString() }).catch(() => {});
          results.push({ id: r.id, ok: false, error: e.message });
        }
      }
      const left = await rest('GET', 'receipt_inbox?select=id&status=eq.processed&xero_status=eq.queued');
      return out(200, { ok: true, results, remaining: left.length });
    }
    return out(400, { error: 'Unknown action' });
  } catch (e) { return out(500, { error: e.message }); }
};
