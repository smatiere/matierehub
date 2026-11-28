/**
 * xero-mcp.js — Custom MCP connector for MatiereHub / Xero
 *
 * Exposes find_contact, create_contact, create_quote, create_invoice as MCP
 * tools over a stateless JSON-RPC "Streamable HTTP" endpoint, so Seb can drive
 * Xero straight from the Claude iOS app — no browser, no desktop, no Hub tab
 * open. Register this URL as a Custom Connector:
 *
 *   https://matierehub2.netlify.app/.netlify/functions/xero-mcp
 *
 * with header  Authorization: Bearer <MCP_SHARED_SECRET>
 *
 * Reuses the EXACT auth pattern already proven in netlify/functions/xero-sync.js:
 *   - refresh token lives in Netlify Blobs ('xero-tokens' store, key 'refresh_token'),
 *     written only by xero-auth.js on browser reconnect
 *   - getAccessToken() exchanges it for a short-lived access token (rotating the
 *     stored refresh token as it goes — Xero refresh tokens are single-use)
 *   - getTenantId() looks up the connected org live via /connections (never persisted)
 * No new Xero credentials, no new OAuth flow — just a new caller.
 *
 * Also writes straight to Supabase (same SUPABASE_URL / SUPABASE_SERVICE_KEY
 * env vars as hub-write.js) so that approving a quote from the phone does the
 * whole job in one call: DRAFT Xero quote + shopping list + baseline estimate
 * (job-status "quoted") — see create_quote below.
 *
 * Required env vars (all already set for xero-sync.js / hub-write.js):
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET, NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN,
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 * New env var to add:
 *   MCP_SHARED_SECRET — a password Seb picks; sent as "Authorization: Bearer <secret>"
 *                       when registering the connector in Claude
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MCP_SHARED_SECRET    = process.env.MCP_SHARED_SECRET;

// ── HTTP helper ────────────────────────────────────────────────────────────
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Xero token management — mirrors xero-sync.js exactly (see BUGS.md / XERO_NOTES.md) ──
function tokenStore() {
  return getStore({ name: 'xero-tokens', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

async function getRefreshToken() {
  try {
    const token = await tokenStore().get('refresh_token');
    if (token) return token;
  } catch (e) { console.log('Blobs not available, falling back to env var:', e.message); }
  return process.env.XERO_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  try { await tokenStore().set('refresh_token', token); }
  catch (e) { console.warn('Could not save refresh token to Blobs:', e.message); }
}

async function getAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('No Xero refresh token available. Reconnect Xero from the Hub first (⚡ button).');

  const clientId = process.env.XERO_CLIENT_ID, clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing XERO_CLIENT_ID / XERO_CLIENT_SECRET env vars.');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const result = await httpRequest({
    hostname: 'identity.xero.com', path: '/connect/token', method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);

  const tokens = JSON.parse(result.body);
  if (tokens.error) throw new Error(`Xero auth error: ${tokens.error} — ${tokens.error_description || ''}`);
  if (tokens.refresh_token) await saveRefreshToken(tokens.refresh_token);
  return tokens.access_token;
}

async function getTenantId(accessToken) {
  const result = await httpRequest({
    hostname: 'api.xero.com', path: '/connections', method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  const tenants = JSON.parse(result.body);
  if (!Array.isArray(tenants) || !tenants.length) throw new Error('No Xero organisation connected.');
  return tenants[0].tenantId;
}

async function xeroCall(endpoint, method, accessToken, tenantId, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' };
  if (bodyStr) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(bodyStr); }
  const result = await httpRequest({ hostname: 'api.xero.com', path: `/api.xro/2.0/${endpoint}`, method, headers }, bodyStr);
  if (result.status >= 400) {
    // surface the actual validation messages first (they sit at the end of Xero's long reply)
    let why = '';
    try { const j = JSON.parse(result.body); const msgs = []; (j.Elements || []).forEach(e => (e.ValidationErrors || []).forEach(v => msgs.push(v.Message))); why = msgs.join(' | ') || j.Message || j.Detail || ''; } catch (e) { /* not JSON */ }
    throw new Error(`Xero API error ${result.status} on ${method} ${endpoint}: ${why || result.body.slice(0, 400)}`);
  }
  return JSON.parse(result.body);
}

// ── Supabase helpers — mirrors hub-write.js ───────────────────────────────
async function sbGet(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}
async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}
async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}
async function nextId(table, prefix) {
  const rows = await sbGet(table, `?select=id&id=like.${prefix}-*`);
  const nums = rows.map(r => parseInt(String(r.id || '').replace(`${prefix}-`, ''), 10)).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// ── Job-baseline + shopping-list side effects (shared by create_quote) ────
// Mirrors Seb's standing workflow (see [[trade-quoting]] memory): once a quote
// is approved it becomes a Xero DRAFT quote + a shopping list of materials +
// a baseline estimate on the project record to compare against actuals later.
async function upsertJobBaseline({ job_name, scope, price, labour_hours, materials_estimate }) {
  if (!job_name) return null;
  const existing = await sbGet('projects', `?select=*&name=ilike.${encodeURIComponent(job_name)}`);
  const fields = {
    status: 'Quoted',
    quoted: price != null ? price : undefined,
    baseline_scope: scope || undefined,
    baseline_price: price != null ? price : undefined,
    baseline_labour_hours: labour_hours != null ? labour_hours : undefined,
    baseline_materials_estimate: materials_estimate != null ? materials_estimate : undefined,
    baseline_set_at: new Date().toISOString()
  };
  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  if (existing.length) {
    const rows = await sbPatch('projects', `?id=eq.${encodeURIComponent(existing[0].id)}`, fields);
    return rows[0];
  }
  const id = await nextId('projects', 'PR');
  const rows = await sbPost('projects', { id, name: job_name, notes: `Created via Xero MCP connector ${new Date().toISOString().slice(0,10)}`, ...fields });
  return rows[0];
}

// 2026-09-24 — items can now carry supplier/special-order details captured at
// quoting time (special, supplier, supplier_email, lead_time, specs,
// delivery_fee, order_url) so the Shopping List tab can surface them without
// a schema change (items is JSONB — extra keys just ride along).
async function createShoppingList({ job_name, client_name, materials }) {
  if (!materials || !materials.length) return null;
  const items = materials.map(m => {
    const item = { name: m.name || m.description || String(m), qty: m.qty || '', checked: false };
    if (m.special)         item.special = true;
    if (m.supplier)        item.supplier = m.supplier;
    if (m.supplier_email)  item.supplier_email = m.supplier_email;
    if (m.lead_time)       item.lead_time = m.lead_time;
    if (m.specs)           item.specs = m.specs;
    if (m.delivery_fee != null) item.delivery_fee = m.delivery_fee;
    if (m.order_url)       item.order_url = m.order_url;
    return item;
  });
  // 2026-11-23 — a re-quote of the same job used to leave two lists. If this job
  // already has an open list with nothing ticked off yet, replace its items.
  if (job_name) {
    const open = await sbGet('shopping_lists', `?project=ilike.${encodeURIComponent(job_name)}&status=eq.open&select=id,items`).catch(() => []);
    const untouched = (open || []).find(l => !(l.items || []).some(i => i && (i.checked || i.ordered)));
    if (untouched) {
      const upd = await sbPatch('shopping_lists', `?id=eq.${encodeURIComponent(untouched.id)}`, { items, updated_at: new Date().toISOString() });
      return { ...(upd[0] || { id: untouched.id }), replaced_existing: true };
    }
  }
  const id = await nextId('shopping_lists', 'SL');
  const rows = await sbPost('shopping_lists', {
    id, project: job_name || '', title: client_name ? `${client_name} — materials` : 'Materials', items, status: 'open'
  });
  return rows[0];
}

// 2026-11-01 — an approved quote also lands in the Schedule pipeline (bookings)
// as 'approved' (needs a date). Hours come from labour_hours; special-order
// items with a lead_time are picked up by the Schedule tab from the shopping
// list. Swallows errors upstream so a missing bookings table never blocks a quote.
async function createBooking({ job_name, client_name, quote_number, labour_hours, title, site_address, client_phone, client_email }) {
  if (!job_name) return null;
  const id = await nextId('bookings', 'BK');
  const rows = await sbPost('bookings', {
    id, project: job_name, title: title || '', quote_number: quote_number || '', approval_source: 'xero',
    approved_at: new Date().toISOString().slice(0, 10), status: 'approved',
    client_name: client_name || '', hours: labour_hours != null ? labour_hours : null,
    site_address: site_address || '', client_phone: client_phone || '', client_email: client_email || ''
  });
  return rows[0];
}

// ── Price library (Supabase price_list, ex GST) ──────────────────────────────
// 2026-11-05 — one library for quoting: fed by saved receipts (database trigger on
// expense_log), by prices found online in a chat (save_price) and by hand.
const PRICE_STOP = new Set(['the','and','for','with','of','a','an','to','in','pk','pack']);
async function toolSearchPrices({ query, supplier, limit }) {
  const toks = String(query || '').toLowerCase().split(/[^a-z0-9.]+/).filter(t => t && t.length >= 2 && !PRICE_STOP.has(t)).slice(0, 8);
  if (!toks.length) throw new Error('Give a search like "treated pine 90x45 2.4m"');
  const ors = toks.map(t => `item.ilike.*${encodeURIComponent(t)}*`).join(',');
  let q = `?select=*&or=(${ors})&limit=300`;
  if (supplier) q += `&supplier=ilike.*${encodeURIComponent(supplier)}*`;
  const rows = await sbGet('price_list', q);
  const today = Date.now();
  const scored = rows.map(r => {
    const hay = String(r.item).toLowerCase();
    const hits = toks.filter(t => hay.includes(t)).length;
    return { r, hits, days: Math.round((today - new Date(r.last_seen + 'T00:00:00').getTime()) / 86400000) };
  }).sort((a, b) => b.hits - a.hits || a.days - b.days).slice(0, Math.min(Number(limit) || 12, 30));
  return {
    note: 'Prices are EX GST (add 10% for inc-GST). "stale" = last seen over 120 days ago — re-check before quoting. If nothing fits, search the web, then call save_price so the library grows.',
    count: scored.length,
    matches: scored.map(({ r, hits, days }) => ({
      item: r.item, supplier: r.supplier || '(unknown)', unit: r.unit || undefined,
      price_ex_gst: Number(r.unit_price), price_inc_gst: Math.round(Number(r.unit_price) * 110) / 100,
      last_seen: r.last_seen, days_old: days, stale: days > 120,
      times_seen: r.times_seen, range_ex_gst: r.low != null && Number(r.low) !== Number(r.high) ? [Number(r.low), Number(r.high)] : undefined,
      source: r.source, url: r.source_url || undefined, category: r.category || undefined, words_matched: `${hits}/${toks.length}`
    }))
  };
}
async function toolSavePrice({ item, supplier, unit_price, gst_included, unit, url, category, notes, source }) {
  if (!item || unit_price == null) throw new Error('item and unit_price are required');
  const ex = gst_included ? Math.round(Number(unit_price) / 1.1 * 100) / 100 : Number(unit_price);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_price`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_item: item, p_supplier: supplier || '', p_price: ex, p_unit: unit || '', p_category: category || '',
      p_source: ['web', 'quote', 'manual'].includes(source) ? source : 'web', p_url: url || '', p_seen: new Date().toISOString().slice(0, 10), p_notes: notes || '' })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Saving price failed: ${res.status} ${txt.slice(0, 200)}`);
  const r = JSON.parse(txt);
  return { saved: true, item: r.item, supplier: r.supplier, price_ex_gst: Number(r.unit_price), times_seen: r.times_seen };
}

// ── Tool implementations ──────────────────────────────────────────────────
async function toolFindContact({ query }) {
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const res = await xeroCall('Contacts', 'GET', accessToken, tenantId);
  const q = (query || '').toLowerCase();
  const matches = (res.Contacts || [])
    .filter(c => (c.Name || '').toLowerCase().includes(q))
    .slice(0, 15)
    .map(c => ({ ContactID: c.ContactID, Name: c.Name, EmailAddress: c.EmailAddress, Phone: (c.Phones||[])[0]?.PhoneNumber || '' }));
  return { matches };
}

// 2026-11-23 — Xero's "Primary person" First name / Last name were left blank on
// every contact made here. Use what the caller passes; otherwise work them out
// from the name ("Stephen Wright - Mosman" → Stephen / Wright). Business-looking
// names are left alone.
function splitPersonName(name) {
  const person = String(name || '').split(/\s+[-–—]\s+/)[0].trim();
  if (!person || /\d|&|\b(pty|ltd|limited|inc|co|company|group|services|constructions?|building|builders|plumbing|electrical|strata|real estate|property|properties|design|studio|trust|council|school|club)\b/i.test(person)) return {};
  const parts = person.split(/\s+/);
  if (parts.length > 4) return {};
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

async function toolCreateContact({ name, first_name, last_name, email, phone, address_line1, city, postal_code }) {
  // Guard: a blank/whitespace Name silently produces a Xero contact with no
  // client details on quotes/invoices (see BUGS.md 2026-09-18 — QU-0285).
  // Fail loudly instead so the caller fixes the call rather than shipping a
  // broken contact.
  const cleanName = (name || '').trim();
  if (!cleanName) {
    throw new Error('name is required and cannot be blank. Use the same "FirstName - Suburb" identifier as the quote title, e.g. "Vladimir - Manly Vale" — not just the first name.');
  }
  const guess = splitPersonName(cleanName);
  const first = (first_name || '').trim() || ((last_name || '').trim() ? '' : guess.first) || '';
  const last = (last_name || '').trim() || ((first_name || '').trim() ? '' : guess.last) || '';
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const payload = { Contacts: [{
    Name: cleanName,
    FirstName: first || undefined,
    LastName: last || undefined,
    EmailAddress: email || undefined,
    Phones: phone ? [{ PhoneType: 'MOBILE', PhoneNumber: phone }] : undefined,
    Addresses: (address_line1 || city) ? [{ AddressType: 'STREET', AddressLine1: address_line1 || '', City: city || '', PostalCode: postal_code || '' }] : undefined
  }] };
  const res = await xeroCall('Contacts', 'POST', accessToken, tenantId, payload);
  const c = res.Contacts[0];
  return { ContactID: c.ContactID, Name: c.Name, FirstName: c.FirstName || '', LastName: c.LastName || '' };
}

// 2026-11-23 — edit an existing Xero contact (the connector could only create).
// Only the fields passed are changed; Xero keeps everything else.
async function toolUpdateContact({ contact_id, contact_name, name, first_name, last_name, email, phone, address_line1, city, postal_code }) {
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  let id = contact_id;
  if (!id && contact_name) {
    const found = await toolFindContact({ query: contact_name });
    const exact = found.matches.filter(m => (m.Name || '').toLowerCase() === String(contact_name).toLowerCase());
    if (exact.length === 1) id = exact[0].ContactID;
    else if (found.matches.length === 1) id = found.matches[0].ContactID;
    else if (!found.matches.length) throw new Error(`No Xero contact matched "${contact_name}".`);
    else throw new Error(`Several contacts match "${contact_name}": ${found.matches.map(m => m.Name).join(', ')}. Pass contact_id.`);
  }
  if (!id) throw new Error('Provide contact_id or contact_name.');
  const c = { ContactID: id };
  if (name != null && String(name).trim()) c.Name = String(name).trim();
  if (first_name != null) c.FirstName = String(first_name).trim();
  if (last_name != null) c.LastName = String(last_name).trim();
  if (email != null) c.EmailAddress = String(email).trim();
  if (phone != null) c.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: String(phone).trim() }];
  if (address_line1 != null || city != null || postal_code != null) c.Addresses = [{ AddressType: 'STREET', AddressLine1: address_line1 || '', City: city || '', PostalCode: postal_code || '' }];
  if (Object.keys(c).length === 1) throw new Error('Nothing to change: pass at least one field.');
  const res = await xeroCall(`Contacts/${id}`, 'POST', accessToken, tenantId, { Contacts: [c] });
  const u = res.Contacts[0];
  return { ContactID: u.ContactID, Name: u.Name, FirstName: u.FirstName || '', LastName: u.LastName || '', EmailAddress: u.EmailAddress || '' };
}

// 2026-11-28 — delete redundant quotes and invoices, only ever on Seb's say-so.
// Quotes: Draft, Sent, Declined and Accepted can be deleted; Invoiced ones are
// refused (a real invoice hangs off them). Invoices: Draft / Awaiting approval are
// deleted; an approved, unpaid one is VOIDED and only when allow_void is true;
// anything with a payment or credit on it is refused.
function quoteBody(q) {
  return {
    QuoteID: q.QuoteID, QuoteNumber: q.QuoteNumber, Contact: { ContactID: q.Contact.ContactID },
    Date: String(q.DateString || '').slice(0, 10) || undefined,
    ExpiryDate: q.ExpiryDateString ? String(q.ExpiryDateString).slice(0, 10) : undefined,
    LineAmountTypes: q.LineAmountTypes, Title: q.Title, Summary: q.Summary, Terms: q.Terms, Reference: q.Reference,
    LineItems: (q.LineItems || []).map(li => ({
      LineItemID: li.LineItemID, Description: li.Description, Quantity: li.Quantity, UnitAmount: li.UnitAmount,
      ItemCode: li.ItemCode, AccountCode: li.AccountCode, TaxType: li.TaxType, DiscountRate: li.DiscountRate, Tracking: li.Tracking
    }))
  };
}
async function sbPatchQuiet(table, query, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH', headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  }).catch(() => {});
}
function numberList(one, many, max) {
  const list = [].concat(many || [], one || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  const uniq = [...new Set(list)];
  if (!uniq.length) throw new Error('Give at least one number.');
  if (uniq.length > max) throw new Error(`At most ${max} per call; send the rest in another call.`);
  return uniq;
}

async function deleteOneQuote(accessToken, tenantId, qn) {
  if (!/^QU-\d+$/.test(qn)) return { quote_number: qn, deleted: false, note: 'Not a quote number (e.g. QU-0310).' };
  const found = await xeroCall(`Quotes?QuoteNumber=${encodeURIComponent(qn)}`, 'GET', accessToken, tenantId);
  const q = (found.Quotes || []).find(x => (x.QuoteNumber || '').toUpperCase() === qn);
  if (!q) return { quote_number: qn, deleted: false, note: 'Not found in Xero.' };
  const info = { quote_number: qn, contact: q.Contact && q.Contact.Name, total: q.Total, was: q.Status };
  if (q.Status === 'DELETED') return { ...info, deleted: false, note: 'Already deleted.' };
  if (q.Status === 'INVOICED') return { ...info, deleted: false, note: 'Refused: this quote is Invoiced (a real invoice was raised from it).' };
  const base = quoteBody(q);
  let d;
  try {
    const r = await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [{ ...base, Status: 'DELETED' }] });
    d = (r.Quotes || [])[0] || {};
  } catch (e1) {
    // Xero would not go straight to Deleted from this status: step back to Draft first.
    if (q.Status === 'DRAFT') throw e1;
    await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [{ ...base, Status: 'DRAFT' }] });
    const r = await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [{ ...base, Status: 'DELETED' }] });
    d = (r.Quotes || [])[0] || {};
  }
  if (d.Status !== 'DELETED') return { ...info, deleted: false, status: d.Status, note: 'Xero did not mark it Deleted.' };
  // tidy the Hub's copy: its lines stop counting, and its follow-up reminder stops
  await sbPatchQuiet('quote_items', `quote_number=eq.${encodeURIComponent(qn)}`, { status: 'DELETED' });
  await sbPatchQuiet('quote_followups', `id=eq.${encodeURIComponent(qn)}&status=eq.open`, { status: 'stopped' });
  return { ...info, deleted: true, status: 'DELETED' };
}

async function toolDeleteQuote({ quote_number, quote_numbers }) {
  const list = numberList(quote_number, quote_numbers, 10);
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const results = [];
  for (const qn of list) {
    try { results.push(await deleteOneQuote(accessToken, tenantId, qn)); }
    catch (e) { results.push({ quote_number: qn, deleted: false, note: String(e.message || e).slice(0, 300) }); }
  }
  return { deleted: results.filter(r => r.deleted).length, not_deleted: results.filter(r => !r.deleted).length, results };
}

async function deleteOneInvoice(accessToken, tenantId, num, allowVoid) {
  if (!/^INV-\d+$/.test(num)) return { invoice_number: num, removed: false, note: 'Not an invoice number (e.g. INV-0345).' };
  const found = await xeroCall(`Invoices?InvoiceNumbers=${encodeURIComponent(num)}`, 'GET', accessToken, tenantId);
  const inv = (found.Invoices || []).find(x => (x.InvoiceNumber || '').toUpperCase() === num && x.Type === 'ACCREC');
  if (!inv) return { invoice_number: num, removed: false, note: 'Not found in Xero (sales invoices only).' };
  const info = { invoice_number: num, contact: inv.Contact && inv.Contact.Name, total: inv.Total, was: inv.Status };
  if (inv.Status === 'DELETED' || inv.Status === 'VOIDED') return { ...info, removed: false, note: `Already ${inv.Status.toLowerCase()}.` };
  if (Number(inv.AmountPaid || 0) !== 0 || Number(inv.AmountCredited || 0) !== 0 || inv.Status === 'PAID')
    return { ...info, removed: false, note: 'Refused: this invoice has a payment or credit on it.' };
  let target;
  if (inv.Status === 'DRAFT' || inv.Status === 'SUBMITTED') target = 'DELETED';
  else if (inv.Status === 'AUTHORISED') {
    if (!allowVoid) return { ...info, removed: false, note: 'Refused: this invoice is approved (it is in the books). It can only be voided, and only when Seb says so for this invoice: call again with allow_void true.' };
    target = 'VOIDED';
  } else return { ...info, removed: false, note: `Refused: status ${inv.Status}.` };
  const r = await xeroCall(`Invoices/${inv.InvoiceID}`, 'POST', accessToken, tenantId, { Invoices: [{ InvoiceID: inv.InvoiceID, Status: target }] });
  const d = (r.Invoices || [])[0] || {};
  if (d.Status !== target) return { ...info, removed: false, status: d.Status, note: `Xero did not mark it ${target}.` };
  await sbPatchQuiet('invoice_items', `invoice_number=eq.${encodeURIComponent(num)}`, { status: target });
  return { ...info, removed: true, status: target };
}

async function toolDeleteInvoice({ invoice_number, invoice_numbers, allow_void }) {
  const list = numberList(invoice_number, invoice_numbers, 10);
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const results = [];
  for (const num of list) {
    try { results.push(await deleteOneInvoice(accessToken, tenantId, num, allow_void === true)); }
    catch (e) { results.push({ invoice_number: num, removed: false, note: String(e.message || e).slice(0, 300) }); }
  }
  return { removed: results.filter(r => r.removed).length, not_removed: results.filter(r => !r.removed).length, results };
}

// 2026-11-28 — look up and edit quotes and invoices.
// Look-up reads Xero live (read-only). Edits keep each line's Xero ID by position
// so the Hub's hand-links (quote line → job, invoice notes) survive.
const d10 = v => String(v || '').slice(0, 10);
const round2c = n => Math.round((Number(n) || 0) * 100) / 100;
function statusList(status, allowed) {
  const list = [].concat(status || []).map(x => String(x).trim().toUpperCase()).filter(Boolean)
    .map(x => x === 'AWAITING APPROVAL' ? 'SUBMITTED' : x === 'APPROVED' || x === 'AWAITING PAYMENT' ? 'AUTHORISED' : x);
  const bad = list.filter(x => !allowed.includes(x));
  if (bad.length) throw new Error(`Unknown status ${bad.join(', ')}. Use: ${allowed.join(', ')}.`);
  return list;
}
function dateWindow({ date_from, date_to, older_than_days }) {
  let from = d10(date_from), to = d10(date_to);
  if (older_than_days) { const c = d10(new Date(Date.now() - Number(older_than_days) * 86400000).toISOString()); if (!to || c < to) to = c; }
  return { from, to };
}
const lineOut = li => ({ description: li.Description, quantity: li.Quantity, unit_amount: li.UnitAmount, line_amount: li.LineAmount });

async function toolFindQuotes(args) {
  const { quote_number, contact_name, status, limit } = args || {};
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const links = {};
  try { (await sbGet('quote_items', '?select=quote_number,project&project=neq.')).forEach(r => { if (r.project) links[r.quote_number] = r.project; }); } catch (e) { /* job links are a bonus */ }
  if (quote_number) {
    const qn = String(quote_number).trim().toUpperCase();
    const found = await xeroCall(`Quotes?QuoteNumber=${encodeURIComponent(qn)}`, 'GET', accessToken, tenantId);
    const q = (found.Quotes || []).find(x => (x.QuoteNumber || '').toUpperCase() === qn);
    if (!q) return { found: 0, note: `Quote ${qn} not found in Xero.` };
    return { found: 1, quote: { quote_number: q.QuoteNumber, status: q.Status, contact: q.Contact && q.Contact.Name, date: d10(q.DateString), expiry_date: d10(q.ExpiryDateString),
      title: q.Title || '', summary: q.Summary || '', reference: q.Reference || '', subtotal_ex_gst: q.SubTotal, total_inc_gst: q.Total, job: links[q.QuoteNumber] || '', lines: (q.LineItems || []).map(lineOut) } };
  }
  const wanted = statusList(status, ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'INVOICED', 'DELETED']);
  const { from, to } = dateWindow(args || {});
  const name = String(contact_name || '').trim().toLowerCase();
  let all = [];
  for (let page = 1; page <= 15; page++) {
    let qs = `page=${page}`;
    if (wanted.length === 1) qs += `&Status=${wanted[0]}`;
    if (from) qs += `&DateFrom=${from}`;
    if (to) qs += `&DateTo=${to}`;
    const r = await xeroCall(`Quotes?${qs}`, 'GET', accessToken, tenantId);
    const got = r.Quotes || [];
    const before = all.length;
    got.forEach(q => { if (!all.some(x => x.QuoteID === q.QuoteID)) all.push(q); });
    if (got.length < 100 || all.length === before) break;
  }
  all = all.filter(q => (wanted.length ? wanted.includes(q.Status) : q.Status !== 'DELETED')
    && (!name || ((q.Contact && q.Contact.Name) || '').toLowerCase().includes(name))
    && (!from || d10(q.DateString) >= from) && (!to || d10(q.DateString) <= to));
  all.sort((a, b) => d10(b.DateString).localeCompare(d10(a.DateString)));
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const by = {}; all.forEach(q => { by[q.Status] = (by[q.Status] || 0) + 1; });
  return { found: all.length, shown: Math.min(all.length, max), by_status: by,
    quotes: all.slice(0, max).map(q => ({ quote_number: q.QuoteNumber, status: q.Status, contact: q.Contact && q.Contact.Name, date: d10(q.DateString),
      expiry_date: d10(q.ExpiryDateString), title: q.Title || '', subtotal_ex_gst: q.SubTotal, job: links[q.QuoteNumber] || '' })) };
}

async function toolFindInvoices(args) {
  const { invoice_number, contact_name, status, limit, unpaid_only } = args || {};
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const sum = inv => ({ invoice_number: inv.InvoiceNumber, status: inv.Status, contact: inv.Contact && inv.Contact.Name, date: d10(inv.DateString), due_date: d10(inv.DueDateString),
    quote_number: inv.Reference || '', subtotal_ex_gst: inv.SubTotal, total_inc_gst: inv.Total, paid: inv.AmountPaid, owing: inv.AmountDue });
  if (invoice_number) {
    const num = String(invoice_number).trim().toUpperCase();
    const found = await xeroCall(`Invoices?InvoiceNumbers=${encodeURIComponent(num)}`, 'GET', accessToken, tenantId);
    const inv = (found.Invoices || []).find(x => (x.InvoiceNumber || '').toUpperCase() === num && x.Type === 'ACCREC');
    if (!inv) return { found: 0, note: `Invoice ${num} not found in Xero (sales invoices only).` };
    return { found: 1, invoice: { ...sum(inv), lines: (inv.LineItems || []).map(lineOut) } };
  }
  const wanted = statusList(status, ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED']);
  const { from, to } = dateWindow(args || {});
  const dt = d => { const [y, m, dd] = d.split('-').map(Number); return `DateTime(${y},${m},${dd})`; };
  let where = 'Type=="ACCREC"';
  if (from) where += `&&Date>=${dt(from)}`;
  if (to) where += `&&Date<=${dt(to)}`;
  let qs = `where=${encodeURIComponent(where)}&order=${encodeURIComponent('Date DESC')}`;
  if (wanted.length) qs += `&Statuses=${wanted.join(',')}`;
  const r = await xeroCall(`Invoices?${qs}`, 'GET', accessToken, tenantId);
  const name = String(contact_name || '').trim().toLowerCase();
  const all = (r.Invoices || []).filter(inv => (wanted.length ? true : !['DELETED', 'VOIDED'].includes(inv.Status))
    && (!name || ((inv.Contact && inv.Contact.Name) || '').toLowerCase().includes(name))
    && (!unpaid_only || (inv.Status === 'AUTHORISED' && Number(inv.AmountDue) > 0)));
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const by = {}; all.forEach(inv => { by[inv.Status] = (by[inv.Status] || 0) + 1; });
  return { found: all.length, shown: Math.min(all.length, max), by_status: by, total_owing: round2c(all.reduce((t, inv) => t + (Number(inv.AmountDue) || 0), 0)), invoices: all.slice(0, max).map(sum) };
}

// New lines replace all the old ones. Line 1 keeps old line 1's Xero ID, and so on.
function mergeLines(oldLines, newLines) {
  return newLines.map((li, i) => {
    const old = (oldLines || [])[i] || {};
    if (li.description == null || li.unit_amount == null) throw new Error('Each line needs description and unit_amount.');
    return { LineItemID: old.LineItemID, Description: li.description, Quantity: li.quantity || 1, UnitAmount: li.unit_amount,
      ItemCode: old.ItemCode, AccountCode: old.AccountCode || '200', TaxType: old.TaxType || 'OUTPUT' };
  });
}
// Bring the Hub's copy of one quote/invoice in line with Xero straight away (the daily sync would only add, never remove).
async function hubReplaceLines(table, numberCol, number, rows, carry) {
  try {
    const old = await sbGet(table, `?select=id,${carry}&${numberCol}=eq.${encodeURIComponent(number)}`);
    const carried = [...new Set(old.map(r => r[carry]).filter(Boolean))];
    const oldIds = new Set(old.map(r => r.id));
    const keep = new Set(rows.map(r => r.id));
    // a line that is new to the Hub takes the job link / note the other lines share
    const out = rows.map(r => (!oldIds.has(r.id) && carried.length === 1) ? { ...r, [carry]: carried[0] } : r);
    const same = out.filter(r => oldIds.has(r.id)), fresh = out.filter(r => !oldIds.has(r.id));
    for (const set of [same, fresh]) {
      if (!set.length) continue;
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(set) });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
    }
    const gone = old.filter(r => !keep.has(r.id)).map(r => r.id);
    if (gone.length) await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=in.(${gone.map(g => `"${g}"`).join(',')})`, { method: 'DELETE', headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
    return { updated: true, job_or_note_kept: carried.length === 1 ? carried[0] : '' };
  } catch (e) { return { updated: false, note: 'Xero was changed but the Hub copy was not; the daily sync will catch up. ' + String(e.message || e).slice(0, 150) }; }
}

async function toolUpdateQuote(args) {
  const { quote_number, title, summary, expiry_date, line_items } = args || {};
  const qn = String(quote_number || '').trim().toUpperCase();
  if (!/^QU-\d+$/.test(qn)) throw new Error('quote_number is required, e.g. QU-0312.');
  if (title == null && summary == null && !expiry_date && !(line_items && line_items.length)) throw new Error('Nothing to change: give title, summary, expiry_date or line_items.');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const found = await xeroCall(`Quotes?QuoteNumber=${encodeURIComponent(qn)}`, 'GET', accessToken, tenantId);
  const q = (found.Quotes || []).find(x => (x.QuoteNumber || '').toUpperCase() === qn);
  if (!q) throw new Error(`Quote ${qn} not found in Xero.`);
  if (['INVOICED', 'DELETED'].includes(q.Status)) throw new Error(`Quote ${qn} is ${q.Status} and cannot be edited.`);
  const body = { ...quoteBody(q), Status: q.Status };
  if (title != null) body.Title = title;
  if (summary != null) body.Summary = summary;
  if (expiry_date) body.ExpiryDate = d10(expiry_date);
  if (line_items && line_items.length) body.LineItems = mergeLines(q.LineItems, line_items);
  const r = await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [body] });
  const n = (r.Quotes || [])[0] || {};
  const rows = [];
  (n.LineItems || []).forEach((li, idx) => {
    const desc = (li.Description || '').trim(), amt = Math.abs(li.LineAmount || 0);
    if (!desc && amt === 0) return;
    rows.push({ id: li.LineItemID || `${n.QuoteNumber}-${String(idx + 1).padStart(2, '0')}`, quote_number: n.QuoteNumber, item: (li.ItemCode || '').trim(), description: desc,
      qty: li.Quantity || 1, unit_price: Math.abs(li.UnitAmount || 0), line_amount: amt, contact: (n.Contact && n.Contact.Name) || '', contact_id: (n.Contact && n.Contact.ContactID) || '',
      date: d10(n.DateString) || null, expiry_date: d10(n.ExpiryDateString) || null, status: n.Status || '' });
  });
  const hub = await hubReplaceLines('quote_items', 'quote_number', qn, rows, 'project');
  const out = { quote_number: qn, status: n.Status, was_status: q.Status, subtotal_before: q.SubTotal, subtotal_after: n.SubTotal, total_inc_gst: n.Total,
    lines_before: (q.LineItems || []).length, lines_after: (n.LineItems || []).length, hub };
  // keep the linked job's quoted price in step, only when it still showed the old quote total
  if (hub.job_or_note_kept && Number(q.SubTotal) !== Number(n.SubTotal)) {
    try {
      const pr = await sbGet('projects', `?select=id,quoted,baseline_price&name=eq.${encodeURIComponent(hub.job_or_note_kept)}`);
      if (pr.length === 1) {
        const f = {};
        if (Number(pr[0].quoted) === Number(q.SubTotal)) f.quoted = n.SubTotal;
        if (Number(pr[0].baseline_price) === Number(q.SubTotal)) f.baseline_price = n.SubTotal;
        if (Object.keys(f).length) { await sbPatch('projects', `?id=eq.${encodeURIComponent(pr[0].id)}`, f); out.job_price_updated = hub.job_or_note_kept; }
        else out.note = `Job "${hub.job_or_note_kept}" keeps its own quoted price (it did not match the old quote total). Tell Seb.`;
      }
    } catch (e) { /* job price left as is */ }
  }
  if (q.Status !== 'DRAFT') out.reminder = `This quote was already ${q.Status}: the client has the old version until Seb re-sends it from Xero.`;
  return out;
}

async function toolUpdateInvoice(args) {
  const { invoice_number, line_items, due_date, date, quote_number, allow_approved } = args || {};
  const num = String(invoice_number || '').trim().toUpperCase();
  if (!/^INV-\d+$/.test(num)) throw new Error('invoice_number is required, e.g. INV-0345.');
  if (!due_date && !date && quote_number == null && !(line_items && line_items.length)) throw new Error('Nothing to change: give line_items, due_date, date or quote_number.');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const found = await xeroCall(`Invoices?InvoiceNumbers=${encodeURIComponent(num)}`, 'GET', accessToken, tenantId);
  const inv = (found.Invoices || []).find(x => (x.InvoiceNumber || '').toUpperCase() === num && x.Type === 'ACCREC');
  if (!inv) throw new Error(`Invoice ${num} not found in Xero (sales invoices only).`);
  if (Number(inv.AmountPaid || 0) !== 0 || Number(inv.AmountCredited || 0) !== 0 || inv.Status === 'PAID') throw new Error(`Invoice ${num} has a payment or credit on it and cannot be edited here.`);
  if (inv.Status === 'AUTHORISED' && allow_approved !== true) throw new Error(`Invoice ${num} is approved (it is in the books and may be with the client). Edit it only when Seb says so for this invoice: call again with allow_approved true.`);
  if (!['DRAFT', 'SUBMITTED', 'AUTHORISED'].includes(inv.Status)) throw new Error(`Invoice ${num} is ${inv.Status} and cannot be edited.`);
  const body = { InvoiceID: inv.InvoiceID };
  if (due_date) body.DueDate = d10(due_date);
  if (date) body.Date = d10(date);
  if (quote_number != null) body.Reference = String(quote_number).trim().toUpperCase();
  if (line_items && line_items.length) body.LineItems = mergeLines(inv.LineItems, line_items);
  const r = await xeroCall(`Invoices/${inv.InvoiceID}`, 'POST', accessToken, tenantId, { Invoices: [body] });
  const n = (r.Invoices || [])[0] || {};
  const rows = [];
  (n.LineItems || []).forEach((li, idx) => {
    const desc = (li.Description || '').trim(), amt = li.LineAmount || 0;
    if (!desc && amt === 0) return;
    rows.push({ id: li.LineItemID || `${n.InvoiceNumber}-${String(idx + 1).padStart(2, '0')}`, invoice_number: n.InvoiceNumber, item: (li.ItemCode || '').trim(), description: desc,
      qty: li.Quantity || 1, unit_price: li.UnitAmount || 0, price_excl_gst: amt, quote_number: (n.Reference || '').trim(), contact: (n.Contact && n.Contact.Name) || '',
      contact_id: (n.Contact && n.Contact.ContactID) || '', date: d10(n.DateString) || null, due_date: d10(n.DueDateString) || null, status: n.Status || '', paid: 0 });
  });
  const hub = await hubReplaceLines('invoice_items', 'invoice_number', num, rows, 'notes');
  const out = { invoice_number: num, status: n.Status, subtotal_before: inv.SubTotal, subtotal_after: n.SubTotal, total_inc_gst: n.Total, due_date: d10(n.DueDateString), quote_number: n.Reference || '',
    lines_before: (inv.LineItems || []).length, lines_after: (n.LineItems || []).length, hub };
  if (inv.Status === 'AUTHORISED') out.reminder = 'This invoice was already approved: if the client has it, Seb needs to re-send it from Xero.';
  return out;
}

// 2026-11-28 — the rest of the scope: quote status, approve / email an invoice,
// payments, credit notes, supplier bills (draft only), attachments.
// Each one changes the books or reaches the client, so each is only for when Seb
// asked for that exact thing; emailing also needs confirm_send true.
async function getQuoteByNumber(accessToken, tenantId, quote_number) {
  const qn = String(quote_number || '').trim().toUpperCase();
  if (!/^QU-\d+$/.test(qn)) throw new Error('quote_number is required, e.g. QU-0310.');
  const found = await xeroCall(`Quotes?QuoteNumber=${encodeURIComponent(qn)}`, 'GET', accessToken, tenantId);
  const q = (found.Quotes || []).find(x => (x.QuoteNumber || '').toUpperCase() === qn);
  if (!q) throw new Error(`Quote ${qn} not found in Xero.`);
  return q;
}
async function getSalesInvoice(accessToken, tenantId, invoice_number) {
  const num = String(invoice_number || '').trim().toUpperCase();
  if (!/^INV-\d+$/.test(num)) throw new Error('invoice_number is required, e.g. INV-0345.');
  const found = await xeroCall(`Invoices?InvoiceNumbers=${encodeURIComponent(num)}`, 'GET', accessToken, tenantId);
  const inv = (found.Invoices || []).find(x => (x.InvoiceNumber || '').toUpperCase() === num && x.Type === 'ACCREC');
  if (!inv) throw new Error(`Invoice ${num} not found in Xero (sales invoices only).`);
  return inv;
}
// keep the Hub's copy of an invoice in step after a payment or credit (the daily sync does the same)
async function hubInvoiceRefresh(accessToken, tenantId, num) {
  try {
    const inv = await getSalesInvoice(accessToken, tenantId, num);
    const ratio = Number(inv.Total) > 0 ? Number(inv.AmountPaid || 0) / Number(inv.Total) : 0;
    const rows = await sbGet('invoice_items', `?select=id,price_excl_gst&invoice_number=eq.${encodeURIComponent(num)}`);
    for (const r of rows) await sbPatchQuiet('invoice_items', `id=eq.${encodeURIComponent(r.id)}`, { status: inv.Status, paid: round2c((Number(r.price_excl_gst) || 0) * ratio) });
    return inv;
  } catch (e) { return null; }
}

async function toolSetQuoteStatus({ quote_number, status }) {
  const target = String(status || '').trim().toUpperCase();
  if (!['SENT', 'ACCEPTED', 'DECLINED', 'DRAFT'].includes(target)) throw new Error('status must be SENT, ACCEPTED, DECLINED or DRAFT. (Invoiced: use mark_quote_invoiced. Deleted: use delete_quote.)');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const q = await getQuoteByNumber(accessToken, tenantId, quote_number);
  const qn = q.QuoteNumber;
  if (q.Status === target) return { quote_number: qn, changed: false, status: q.Status, note: `Already ${target}.` };
  if (q.Status === 'INVOICED' || q.Status === 'DELETED') throw new Error(`Quote ${qn} is ${q.Status}; its status cannot be changed.`);
  // Xero wants a draft to be Sent before it can be Accepted or Declined
  const steps = (q.Status === 'DRAFT' && target !== 'SENT') ? ['SENT', target] : [target];
  const base = quoteBody(q);
  let now = q;
  for (const st of steps) {
    const r = await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [{ ...base, Status: st }] });
    now = (r.Quotes || [])[0] || now;
  }
  if (now.Status !== target) return { quote_number: qn, changed: false, was: q.Status, status: now.Status, note: 'Xero did not move it to the status asked.' };
  await sbPatchQuiet('quote_items', `quote_number=eq.${encodeURIComponent(qn)}`, { status: target });
  if (target === 'ACCEPTED') await sbPatchQuiet('quote_followups', `id=eq.${encodeURIComponent(qn)}&status=eq.open`, { status: 'won' });
  if (target === 'DECLINED') await sbPatchQuiet('quote_followups', `id=eq.${encodeURIComponent(qn)}&status=eq.open`, { status: 'lost' });
  const out = { quote_number: qn, changed: true, was: q.Status, status: now.Status, contact: q.Contact && q.Contact.Name, total_before: q.Total, total_after: now.Total };
  if (target === 'SENT') out.note = 'Marked as Sent in Xero. Nothing was emailed: Xero does not let a connector email a quote, so Seb sends it from Xero.';
  if (target === 'ACCEPTED') out.note = 'The Hub moves the linked job to Won and puts it on the Schedule the next time the Hub is opened.';
  if (target === 'DECLINED') out.note = 'The Hub moves the linked job to Lost the next time the Hub is opened.';
  return out;
}

async function toolApproveInvoice({ invoice_number }) {
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const inv = await getSalesInvoice(accessToken, tenantId, invoice_number);
  const num = inv.InvoiceNumber;
  if (inv.Status === 'AUTHORISED' || inv.Status === 'PAID') return { invoice_number: num, changed: false, status: inv.Status, note: 'Already approved.' };
  if (!['DRAFT', 'SUBMITTED'].includes(inv.Status)) throw new Error(`Invoice ${num} is ${inv.Status} and cannot be approved.`);
  const r = await xeroCall(`Invoices/${inv.InvoiceID}`, 'POST', accessToken, tenantId, { Invoices: [{ InvoiceID: inv.InvoiceID, Status: 'AUTHORISED' }] });
  const n = (r.Invoices || [])[0] || {};
  if (n.Status !== 'AUTHORISED') return { invoice_number: num, changed: false, status: n.Status, note: 'Xero did not approve it.' };
  await sbPatchQuiet('invoice_items', `invoice_number=eq.${encodeURIComponent(num)}`, { status: 'AUTHORISED' });
  return { invoice_number: num, changed: true, was: inv.Status, status: 'AUTHORISED', contact: inv.Contact && inv.Contact.Name, total_inc_gst: n.Total, due_date: d10(n.DueDateString),
    note: 'Approved: it now counts in the books as money owed. It has NOT been sent to the client.' };
}

async function toolEmailInvoice({ invoice_number, confirm_send }) {
  if (confirm_send !== true) throw new Error('Not sent. This emails the client. Call again with confirm_send true only after Seb has said, in this chat, to send this invoice.');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const inv = await getSalesInvoice(accessToken, tenantId, invoice_number);
  const num = inv.InvoiceNumber;
  if (['DRAFT', 'SUBMITTED'].includes(inv.Status)) throw new Error(`Invoice ${num} is still a draft. Approve it first (approve_invoice), then send.`);
  if (!['AUTHORISED', 'PAID'].includes(inv.Status)) throw new Error(`Invoice ${num} is ${inv.Status} and cannot be sent.`);
  const c = await xeroCall(`Contacts/${inv.Contact.ContactID}`, 'GET', accessToken, tenantId);
  const email = (((c.Contacts || [])[0] || {}).EmailAddress || '').trim();
  if (!email) throw new Error(`Not sent: ${inv.Contact.Name} has no email address in Xero. Add one with update_contact first.`);
  const res = await httpRequest({ hostname: 'api.xero.com', path: `/api.xro/2.0/Invoices/${inv.InvoiceID}/Email`, method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Content-Length': 2 } }, '{}');
  if (res.status >= 300) throw new Error(`Xero did not send the email (${res.status}): ${String(res.body || '').slice(0, 300)}`);
  return { invoice_number: num, sent: true, to: email, contact: inv.Contact.Name, total_inc_gst: inv.Total, amount_due: inv.AmountDue,
    note: "Sent by Xero with Xero's standard invoice email and the PDF. The wording cannot be changed from here." };
}

async function bankAccounts(accessToken, tenantId) {
  const r = await xeroCall(`Accounts?where=${encodeURIComponent('Type=="BANK"&&Status=="ACTIVE"')}`, 'GET', accessToken, tenantId);
  return (r.Accounts || []).map(a => ({ AccountID: a.AccountID, name: a.Name, code: a.Code || '' }));
}

async function toolRecordPayment({ invoice_number, amount, date, bank_account, reference }) {
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const inv = await getSalesInvoice(accessToken, tenantId, invoice_number);
  const num = inv.InvoiceNumber;
  if (inv.Status === 'PAID') return { invoice_number: num, recorded: false, note: 'Already fully paid.' };
  if (inv.Status !== 'AUTHORISED') throw new Error(`Invoice ${num} is ${inv.Status}. Only an approved invoice can take a payment (approve_invoice first).`);
  const due = Number(inv.AmountDue || 0);
  const amt = amount == null ? due : round2c(amount);
  if (!(amt > 0)) throw new Error('amount must be more than zero (inc GST).');
  if (amt > due + 0.005) throw new Error(`Refused: ${amt} is more than the ${due} still owing on ${num}.`);
  const banks = await bankAccounts(accessToken, tenantId);
  if (!banks.length) throw new Error('No active bank account found in Xero.');
  let bank;
  const want = String(bank_account || '').toLowerCase().trim();
  if (want) bank = banks.find(b => b.name.toLowerCase() === want || b.code.toLowerCase() === want) || banks.find(b => b.name.toLowerCase().includes(want));
  else if (banks.length === 1) bank = banks[0];
  if (!bank) throw new Error(`Which bank account did the money land in? Call again with bank_account set to one of: ${banks.map(b => b.name).join(' | ')}`);
  const payDate = d10(date) || new Date().toISOString().slice(0, 10);
  const r = await xeroCall('Payments', 'PUT', accessToken, tenantId, { Payments: [{ Invoice: { InvoiceID: inv.InvoiceID }, Account: { AccountID: bank.AccountID }, Date: payDate, Amount: amt, Reference: reference || undefined }] });
  const p = (r.Payments || [])[0] || {};
  const after = await hubInvoiceRefresh(accessToken, tenantId, num);
  return { invoice_number: num, recorded: true, payment_id: p.PaymentID, amount: amt, date: payDate, into: bank.name, contact: inv.Contact && inv.Contact.Name,
    status: after ? after.Status : undefined, still_owing: after ? after.AmountDue : round2c(due - amt),
    note: 'When this deposit shows up in the Xero bank feed, match it to this payment in Reconcile; do not create a second one.' };
}

async function toolCreateCreditNote({ invoice_number, contact_id, contact_name, line_items, reference, apply_to_invoice }) {
  if (!line_items || !line_items.length) throw new Error('line_items is required (at least one {description, quantity, unit_amount ex GST}, positive amounts).');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  let inv = null, contactRef = contact_id;
  if (invoice_number) { inv = await getSalesInvoice(accessToken, tenantId, invoice_number); contactRef = inv.Contact.ContactID; }
  if (!contactRef && contact_name) {
    const found = await toolFindContact({ query: contact_name });
    if (!found.matches.length) throw new Error(`No Xero contact matched "${contact_name}".`);
    contactRef = found.matches[0].ContactID;
  }
  if (!contactRef) throw new Error('Give invoice_number, or contact_id / contact_name.');
  const apply = apply_to_invoice === true;
  if (apply) {
    if (!inv) throw new Error('apply_to_invoice needs invoice_number.');
    if (inv.Status !== 'AUTHORISED' || !(Number(inv.AmountDue) > 0)) throw new Error(`Invoice ${inv.InvoiceNumber} is ${inv.Status} with ${inv.AmountDue} owing: a credit can only be applied to an approved invoice that still has money owing. Create the credit note without apply_to_invoice and Seb handles the refund in Xero.`);
  }
  const r = await xeroCall('CreditNotes', 'PUT', accessToken, tenantId, { CreditNotes: [{
    Type: 'ACCRECCREDIT', Contact: { ContactID: contactRef }, Date: new Date().toISOString().slice(0, 10), Status: apply ? 'AUTHORISED' : 'DRAFT',
    LineAmountTypes: 'Exclusive', Reference: reference || (inv ? `Credit for ${inv.InvoiceNumber}` : undefined),
    LineItems: line_items.map(li => ({ Description: li.description, Quantity: li.quantity || 1, UnitAmount: Math.abs(Number(li.unit_amount) || 0), AccountCode: '200', TaxType: 'OUTPUT' }))
  }] });
  const cn = (r.CreditNotes || [])[0] || {};
  const out = { credit_note_number: cn.CreditNoteNumber, status: cn.Status, contact: (cn.Contact && cn.Contact.Name) || (inv && inv.Contact.Name), subtotal: cn.SubTotal, total_inc_gst: cn.Total };
  if (!apply) { out.note = 'Created as a DRAFT credit note. Nothing is applied or refunded until it is approved in Xero.'; return out; }
  const use = round2c(Math.min(Number(cn.Total) || 0, Number(inv.AmountDue) || 0));
  try {
    await xeroCall(`CreditNotes/${cn.CreditNoteID}/Allocations`, 'PUT', accessToken, tenantId, { Allocations: [{ Invoice: { InvoiceID: inv.InvoiceID }, Amount: use, Date: new Date().toISOString().slice(0, 10) }] });
    const after = await hubInvoiceRefresh(accessToken, tenantId, inv.InvoiceNumber);
    out.applied = { invoice_number: inv.InvoiceNumber, amount: use, invoice_status: after ? after.Status : undefined, still_owing: after ? after.AmountDue : undefined };
    if (use < Number(cn.Total)) out.note = `Only ${use} was applied; ${round2c(cn.Total - use)} of the credit is left on the client's account in Xero.`;
  } catch (e) {
    out.applied = false;
    out.note = 'The credit note is approved but could NOT be applied to the invoice: ' + String(e.message || e).slice(0, 250) + ' Tell Seb; it can be applied in Xero.';
  }
  return out;
}

async function toolCreateBill({ supplier_name, contact_id, line_items, account, date, due_date, reference, gst_included, gst_free }) {
  if (!line_items || !line_items.length) throw new Error('line_items is required (at least one {description, quantity, unit_amount}).');
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  let contactRef = contact_id, supplier = supplier_name || '';
  if (!contactRef && supplier_name) {
    const found = await toolFindContact({ query: supplier_name });
    if (!found.matches.length) throw new Error(`No Xero contact matched "${supplier_name}". Call create_contact first.`);
    contactRef = found.matches[0].ContactID; supplier = found.matches[0].Name || supplier;
  }
  if (!contactRef) throw new Error('Give supplier_name or contact_id.');
  const ar = await xeroCall(`Accounts?where=${encodeURIComponent('Status=="ACTIVE"')}`, 'GET', accessToken, tenantId);
  const costAccounts = (ar.Accounts || []).filter(a => ['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS'].includes(a.Type) && a.Code);
  const pick = want => { const w = String(want || '').toLowerCase().trim(); if (!w) return null;
    return costAccounts.find(a => a.Code.toLowerCase() === w || a.Name.toLowerCase() === w) || costAccounts.find(a => a.Name.toLowerCase().includes(w)) || null; };
  const main = pick(account);
  const lines = line_items.map(li => {
    const acc = pick(li.account) || main;
    if (!acc) throw new Error(`Which Xero account does this cost belong to? Call again with account set to one of: ${costAccounts.map(a => a.Name).join(' | ')}`);
    return { Description: li.description, Quantity: li.quantity || 1, UnitAmount: Number(li.unit_amount) || 0, AccountCode: acc.Code, TaxType: gst_free === true ? 'EXEMPTEXPENSES' : 'INPUT' };
  });
  const billDate = d10(date) || new Date().toISOString().slice(0, 10);
  const r = await xeroCall('Invoices', 'POST', accessToken, tenantId, { Invoices: [{
    Type: 'ACCPAY', Contact: { ContactID: contactRef }, Date: billDate, DueDate: d10(due_date) || undefined, Status: 'DRAFT',
    InvoiceNumber: reference || undefined, LineAmountTypes: gst_included === false ? 'Exclusive' : 'Inclusive', LineItems: lines
  }] });
  const b = (r.Invoices || [])[0] || {};
  return { bill_id: b.InvoiceID, supplier: (b.Contact && b.Contact.Name) || supplier, reference: b.InvoiceNumber || '', status: b.Status, subtotal: b.SubTotal, gst: b.TotalTax, total_inc_gst: b.Total, date: billDate, due_date: d10(b.DueDateString),
    note: 'Created as a DRAFT bill (Xero: Business > Bills to pay > Draft). It is not approved and not paid.' };
}

const ATTACH_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
async function toolAttachFile({ quote_number, invoice_number, file_url, content_base64, filename, show_to_client }) {
  if (!quote_number === !invoice_number) throw new Error('Give exactly one of quote_number or invoice_number.');
  if (!file_url === !content_base64) throw new Error('Give exactly one of file_url (a web link to the file) or content_base64 (the file itself; small files only).');
  let buf, name = String(filename || '').trim(), mime = '';
  if (file_url) {
    let u; try { u = new URL(file_url); } catch (e) { throw new Error('file_url is not a valid link.'); }
    if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname)) throw new Error('file_url must be a public https link.');
    const res = await fetch(u.href);
    if (!res.ok) throw new Error(`Could not download the file (${res.status}).`);
    buf = Buffer.from(await res.arrayBuffer());
    mime = String(res.headers.get('content-type') || '').split(';')[0].trim();
    if (!name) name = decodeURIComponent(u.pathname.split('/').pop() || '');
  } else {
    buf = Buffer.from(String(content_base64).replace(/^data:[^,]*,/, ''), 'base64');
  }
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > 4 * 1024 * 1024) throw new Error(`The file is ${(buf.length / 1048576).toFixed(1)} MB; the limit here is 4 MB.`);
  name = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (!ext || !ATTACH_TYPES[ext.toLowerCase()]) throw new Error('Give a filename with its ending, e.g. site-photo.jpg or plan.pdf (pdf, jpg, png, gif, webp, heic, txt, csv, doc, docx, xls, xlsx).');
  if (/html/i.test(mime)) throw new Error('That link opens a web page, not the file itself. Use a direct link to the file.');
  mime = ATTACH_TYPES[ext.toLowerCase()];
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  let kind, id, number;
  if (quote_number) { const q = await getQuoteByNumber(accessToken, tenantId, quote_number); kind = 'Quotes'; id = q.QuoteID; number = q.QuoteNumber; }
  else { const inv = await getSalesInvoice(accessToken, tenantId, invoice_number); kind = 'Invoices'; id = inv.InvoiceID; number = inv.InvoiceNumber; }
  const online = kind === 'Invoices' && show_to_client === true;
  const res = await httpRequest({ hostname: 'api.xero.com', method: 'PUT', path: `/api.xro/2.0/${kind}/${id}/Attachments/${encodeURIComponent(name)}${online ? '?IncludeOnline=true' : ''}`,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json', 'Content-Type': mime, 'Content-Length': buf.length } }, buf);
  if (res.status >= 300) throw new Error(`Xero did not take the file (${res.status}): ${String(res.body || '').slice(0, 300)}`);
  return { attached: true, to: number, filename: name, size_kb: Math.round(buf.length / 1024), client_can_see_it: online,
    note: online ? 'The client sees this file on the online invoice.' : 'The file is kept on the record in Xero for Seb; the client does not see it.' };
}

// 2026-11-05 — the client's address/phone/email as saved on the Xero contact card,
// so a new quote's booking (and the project) get the site address straight away.
async function contactDetails(accessToken, tenantId, contactId) {
  try {
    const res = await xeroCall(`Contacts/${contactId}`, 'GET', accessToken, tenantId);
    const c = (res.Contacts || [])[0] || {};
    const a = (c.Addresses || []).find(x => x.AddressType === 'STREET' && x.AddressLine1) || (c.Addresses || []).find(x => x.AddressLine1) || {};
    const ph = (c.Phones || []).find(x => x.PhoneNumber && x.PhoneType === 'MOBILE') || (c.Phones || []).find(x => x.PhoneNumber) || {};
    return {
      address: [a.AddressLine1, a.City, a.Region || 'NSW', a.PostalCode].filter(Boolean).join(', '),
      phone: [ph.PhoneAreaCode, ph.PhoneNumber].filter(Boolean).join(' ').trim(), email: c.EmailAddress || ''
    };
  } catch (e) { return {}; }
}

async function toolCreateQuote(args) {
  const { contact_id, contact_name, title, summary, line_items, expiry_days = 28,
          job_name, materials, labour_hours } = args;
  if (!line_items || !line_items.length) throw new Error('line_items is required (at least one {description, quantity, unit_amount})');

  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);

  let contactRef = contact_id;
  if (!contactRef && contact_name) {
    const found = await toolFindContact({ query: contact_name });
    if (found.matches.length) contactRef = found.matches[0].ContactID;
    else throw new Error(`No Xero contact matched "${contact_name}" — pass contact_id, or call create_contact first.`);
  }
  if (!contactRef) throw new Error('Provide contact_id or contact_name.');

  const today = new Date();
  const expiry = new Date(today.getTime() + expiry_days * 86400000);
  const fmtDate = d => d.toISOString().slice(0, 10);

  const payload = { Quotes: [{
    Contact: { ContactID: contactRef },
    Date: fmtDate(today),
    ExpiryDate: fmtDate(expiry),
    Status: 'DRAFT',
    Title: title || '',
    Summary: summary || '',
    LineItems: line_items.map(li => ({
      Description: li.description, Quantity: li.quantity || 1, UnitAmount: li.unit_amount,
      AccountCode: '200', TaxType: 'OUTPUT'
    }))
  }] };
  const res = await xeroCall('Quotes', 'POST', accessToken, tenantId, payload);
  const q = res.Quotes[0];

  const priceTotal = q.SubTotal;
  const materialsTotal = (materials || []).reduce((s, m) => s + (Number(m.cost) || 0), 0) || undefined;

  // Fallback: if the caller didn't pass a separate `materials` breakdown, build
  // the shopping list straight from the quote's own line items instead of
  // skipping it — Seb's shopping lists are meant to exist for every approved
  // quote (see the empty-state copy on the Shopping List tab), so this is what
  // makes that true even when the assistant only fills in line_items.
  const materialsForList = (materials && materials.length)
    ? materials
    : line_items.map(li => ({ name: li.description, qty: li.quantity ? String(li.quantity) : '', cost: li.unit_amount }));

  const [baseline, shoppingList] = await Promise.all([
    upsertJobBaseline({
      job_name: job_name || contact_name || q.Contact?.Name,
      scope: summary || title,
      price: priceTotal,
      labour_hours,
      materials_estimate: materialsTotal
    }).catch(e => ({ error: e.message })),
    createShoppingList({ job_name: job_name || contact_name || q.Contact?.Name, client_name: contact_name || q.Contact?.Name, materials: materialsForList }).catch(e => ({ error: e.message }))
  ]);

  // 2026-11-05: NO schedule booking at quote time — a sent quote is not a won job. The Hub adds the job
  // to the Schedule when the quote is accepted in Xero or the project is marked Won.
  const cd = await contactDetails(accessToken, tenantId, contactRef);
  const booking = null;
  // Also keep the address on the project card (column added by supabase_projects_address.sql; ignored until it exists).
  if (cd.address) {
    sbPatch('projects', `?name=ilike.${encodeURIComponent(job_name || contact_name || q.Contact?.Name || '')}`, { site_address: cd.address }).catch(() => {});
  }

  return {
    QuoteNumber: q.QuoteNumber, QuoteID: q.QuoteID, Status: q.Status,
    SubTotal: q.SubTotal, Total: q.Total,
    job_baseline: baseline, shopping_list: shoppingList, booking
  };
}

// 2026-11-23 — mark a quote "Invoiced" in Xero, as Xero does itself when a quote
// is converted to an invoice. Xero only allows Sent → Accepted → Invoiced, so it
// steps through. Draft quotes are left alone (never sent to the client). The
// quote's lines are sent back unchanged and the total is checked afterwards.
async function markQuoteInvoiced(accessToken, tenantId, quoteNumber) {
  const qn = String(quoteNumber || '').trim().toUpperCase();
  if (!/^QU-\d+$/.test(qn)) return { quote_number: qn, changed: false, note: 'Not a quote number.' };
  const found = await xeroCall(`Quotes?QuoteNumber=${encodeURIComponent(qn)}`, 'GET', accessToken, tenantId);
  const q = (found.Quotes || []).find(x => (x.QuoteNumber || '').toUpperCase() === qn);
  if (!q) return { quote_number: qn, changed: false, note: 'Quote not found in Xero.' };
  const was = q.Status;
  if (was === 'INVOICED') return { quote_number: qn, changed: false, status: was, note: 'Already marked Invoiced.' };
  const steps = was === 'SENT' ? ['ACCEPTED', 'INVOICED'] : was === 'ACCEPTED' ? ['INVOICED'] : null;
  if (!steps) return { quote_number: qn, changed: false, status: was, note: `Quote is ${was}; only Sent or Accepted quotes are marked Invoiced.` };
  const base = quoteBody(q);
  let now = q;
  for (const st of steps) {
    const r = await xeroCall('Quotes', 'POST', accessToken, tenantId, { Quotes: [{ ...base, Status: st }] });
    now = (r.Quotes || [])[0] || now;
  }
  return { quote_number: qn, changed: true, was, status: now.Status, total_before: q.Total, total_after: now.Total,
    lines_before: (q.LineItems || []).length, lines_after: (now.LineItems || []).length };
}

async function toolMarkQuoteInvoiced({ quote_number }) {
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  return markQuoteInvoiced(accessToken, tenantId, quote_number);
}

async function toolCreateInvoice(args) {
  const { contact_id, contact_name, line_items, due_days = 14, quote_number } = args;
  if (!line_items || !line_items.length) throw new Error('line_items is required (at least one {description, quantity, unit_amount})');

  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);

  let contactRef = contact_id;
  if (!contactRef && contact_name) {
    const found = await toolFindContact({ query: contact_name });
    if (found.matches.length) contactRef = found.matches[0].ContactID;
    else throw new Error(`No Xero contact matched "${contact_name}" — pass contact_id, or call create_contact first.`);
  }
  if (!contactRef) throw new Error('Provide contact_id or contact_name.');

  // 2026-11-23 — show the quote number on the invoice, the way Xero does when a
  // quote is converted to an invoice (it goes in the invoice's Reference field).
  // Given: use it. Not given: if this client has exactly one accepted/sent quote,
  // use that one; if several, list them in the result and leave Reference blank.
  let quoteRef = '';
  let quoteNote = '';
  let quoteCandidates = [];
  const qn = String(quote_number || '').trim();
  if (qn) {
    const m = qn.match(/(\d+)\s*$/);
    quoteRef = /^qu-/i.test(qn) ? qn.toUpperCase() : (m ? 'QU-' + m[1].padStart(4, '0') : qn);
  } else {
    try {
      const qr = await xeroCall(`Quotes?ContactID=${contactRef}`, 'GET', accessToken, tenantId);
      quoteCandidates = (qr.Quotes || []).filter(q => ['ACCEPTED', 'SENT'].includes(q.Status))
        .map(q => ({ QuoteNumber: q.QuoteNumber, Status: q.Status, Title: q.Title || '', Total: q.Total, Date: q.DateString ? q.DateString.slice(0, 10) : '' }));
      if (quoteCandidates.length === 1) {
        quoteRef = quoteCandidates[0].QuoteNumber;
        quoteNote = `Quote ${quoteRef} was put on the invoice automatically (this client's only open quote). Tell Seb.`;
      } else if (quoteCandidates.length > 1) {
        quoteNote = 'This client has several open quotes, so no quote number was put on the invoice. Ask Seb which one it is for.';
      }
    } catch (e) { /* the invoice is still created without a quote number */ }
  }

  const today = new Date();
  const due = new Date(today.getTime() + due_days * 86400000);
  const fmtDate = d => d.toISOString().slice(0, 10);

  const payload = { Invoices: [{
    Reference: quoteRef || undefined,
    Type: 'ACCREC',
    Contact: { ContactID: contactRef },
    Date: fmtDate(today),
    DueDate: fmtDate(due),
    Status: 'DRAFT',
    LineItems: line_items.map(li => ({
      Description: li.description, Quantity: li.quantity || 1, UnitAmount: li.unit_amount,
      AccountCode: '200', TaxType: 'OUTPUT'
    }))
  }] };
  const res = await xeroCall('Invoices', 'POST', accessToken, tenantId, payload);
  const inv = res.Invoices[0];
  const out = { InvoiceNumber: inv.InvoiceNumber, InvoiceID: inv.InvoiceID, Status: inv.Status, SubTotal: inv.SubTotal, Total: inv.Total, QuoteNumber: inv.Reference || '' };
  if (quoteRef) {
    try { out.quote = await markQuoteInvoiced(accessToken, tenantId, quoteRef); }
    catch (e) { out.quote = { quote_number: quoteRef, changed: false, note: 'Could not mark the quote Invoiced: ' + String(e.message || e).slice(0, 200) }; }
  }
  if (quoteNote) out.note = quoteNote;
  if (!quoteRef && quoteCandidates.length > 1) out.open_quotes = quoteCandidates;
  return out;
}

// ── MCP tool catalogue ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_prices',
    description: 'Search Matiere\'s own PRICE LIBRARY — real prices from Seb\'s scanned receipts (Bunnings etc.), plus prices saved from earlier web searches. ALWAYS call this FIRST when pricing materials, supplies or services for a quote, before relying on memory or the web. Prices are ex GST, with date last paid, how often seen and the price range. Treat "stale" prices (over 120 days) as a guide only. Only go to the web for items the library does not have, then call save_price.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words describing the item, e.g. "treated pine 90x45 2.4m" or "deck screws 50mm"' },
      supplier: { type: 'string', description: 'Optional: limit to one supplier, e.g. Bunnings' },
      limit: { type: 'number', description: 'Max results (default 12)' }
    }, required: ['query'] }
  },
  {
    name: 'save_price',
    description: 'Save a price into Matiere\'s price library so future quotes can use it. Call this whenever you find a price online (or from a supplier quote/email) that was not in the library, and after Seb confirms a price. Records supplier, unit, ex-GST price and source URL.',
    inputSchema: { type: 'object', properties: {
      item: { type: 'string', description: 'Full item description incl. size/length, e.g. "Pine Structural Treated H3 90x45mm 2.4m"' },
      supplier: { type: 'string', description: 'Where the price is from, e.g. Bunnings, Mitre 10, Dunbar Timber' },
      unit_price: { type: 'number', description: 'Price per unit' },
      gst_included: { type: 'boolean', description: 'true if the price you give includes GST (it will be converted to ex GST). Default false.' },
      unit: { type: 'string', description: 'e.g. each, per metre, box of 500, per hour' },
      url: { type: 'string' }, category: { type: 'string' }, notes: { type: 'string' },
      source: { type: 'string', description: 'web (default), quote (supplier quote), or manual' }
    }, required: ['item', 'unit_price'] }
  },
  {
    name: 'find_contact',
    description: 'Search Matiere\'s Xero contacts by name. Use this before create_quote/create_invoice to get a ContactID, or to check whether a client already exists in Xero.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Name or partial name to search for' } }, required: ['query'] }
  },
  {
    name: 'create_contact',
    description: 'Create a new client contact in Xero (for a lead not yet in Xero). IMPORTANT: name must be the full client identifier in the same "FirstName - Suburb" pattern you will use as the create_quote title (e.g. "Vladimir - Manly Vale"), not just the first name — this is what shows as the client on the quote/invoice PDF. ALWAYS pass first_name and last_name too (the person\'s own first and last name, e.g. "Vladimir" / "Petrov") — they fill the Xero Primary person fields; if the last name is unknown pass first_name only. Also pass address_line1/city/postal_code when known, so the address prints too. Returns the new ContactID to use with create_quote/create_invoice.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, first_name: { type: 'string', description: "Person's first name (Xero Primary person)" }, last_name: { type: 'string', description: "Person's last name (Xero Primary person)" },
      email: { type: 'string' }, phone: { type: 'string' },
      address_line1: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' }
    }, required: ['name'] }
  },
  {
    name: 'update_contact',
    description: 'Edit an existing Xero contact: fix the name, first/last name (Primary person), email, phone or address. Only the fields you pass are changed.',
    inputSchema: { type: 'object', properties: {
      contact_id: { type: 'string', description: 'Xero ContactID (preferred)' }, contact_name: { type: 'string', description: 'Current contact name, if the id is not known' },
      name: { type: 'string', description: 'New display name (leave out to keep it)' },
      first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
      address_line1: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' }
    } }
  },
  {
    name: 'find_quotes',
    description: 'Look up Xero quotes (read-only, live from Xero). Give quote_number for one quote with its lines, or filter a list by client, status and date. Use it to check a quote before editing, or to list old quotes for Seb to choose which to delete. Amounts are ex GST unless named otherwise. "job" is the Hub job the quote is linked to, if any.',
    inputSchema: { type: 'object', properties: {
      quote_number: { type: 'string', description: 'One quote with full lines, e.g. QU-0312' },
      contact_name: { type: 'string', description: 'Part of the client name' },
      status: { type: 'array', items: { type: 'string' }, description: 'Any of DRAFT, SENT, ACCEPTED, DECLINED, INVOICED, DELETED. Left out: all except deleted.' },
      date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' },
      older_than_days: { type: 'number', description: 'Only quotes dated more than this many days ago' },
      limit: { type: 'number', description: 'Default 50, max 200 (newest first)' }
    } }
  },
  {
    name: 'find_invoices',
    description: 'Look up Xero sales invoices (read-only, live from Xero). Give invoice_number for one invoice with its lines, or filter a list by client, status and date. unpaid_only lists approved invoices still owing.',
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'One invoice with full lines, e.g. INV-0345' },
      contact_name: { type: 'string', description: 'Part of the client name' },
      status: { type: 'array', items: { type: 'string' }, description: 'Any of DRAFT, SUBMITTED (awaiting approval), AUTHORISED (approved, awaiting payment), PAID, VOIDED, DELETED. Left out: all except voided and deleted.' },
      unpaid_only: { type: 'boolean' },
      date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' },
      older_than_days: { type: 'number' },
      limit: { type: 'number', description: 'Default 50, max 200 (newest first)' }
    } }
  },
  {
    name: 'update_quote',
    description: 'Edit an existing Xero quote in place (same quote number): title, summary, expiry date and/or its lines. Call find_quotes with the quote_number first to see the current lines. Invoiced and deleted quotes are refused. Only fields you pass change. The Hub copy and a linked job price follow. If the quote was already sent, Seb must re-send it from Xero. Only edit when Seb asked for the change.',
    inputSchema: { type: 'object', properties: {
      quote_number: { type: 'string', description: 'e.g. QU-0312' },
      title: { type: 'string' }, summary: { type: 'string' }, expiry_date: { type: 'string', description: 'YYYY-MM-DD' },
      line_items: { type: 'array', description: 'The FULL new list of lines: it replaces all existing lines, so include the lines that stay.', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number', description: 'ex GST' } }, required: ['description', 'unit_amount'] } }
    }, required: ['quote_number'] }
  },
  {
    name: 'update_invoice',
    description: 'Edit an existing Xero sales invoice in place (same invoice number): lines, date, due date, or the quote number shown as its reference. Call find_invoices with the invoice_number first. Draft and awaiting-approval invoices are edited freely. An approved, unpaid invoice is in the books: edited only with allow_approved true, which needs Seb to have said so for that invoice. Anything with a payment or credit is refused. Only edit when Seb asked for the change.',
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-0345' },
      line_items: { type: 'array', description: 'The FULL new list of lines: it replaces all existing lines, so include the lines that stay.', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number', description: 'ex GST' } }, required: ['description', 'unit_amount'] } },
      date: { type: 'string', description: 'YYYY-MM-DD' }, due_date: { type: 'string', description: 'YYYY-MM-DD' },
      quote_number: { type: 'string', description: 'Quote number to show as the invoice reference' },
      allow_approved: { type: 'boolean', description: 'true = also edit an approved, unpaid invoice. Default false.' }
    }, required: ['invoice_number'] }
  },
  {
    name: 'set_quote_status',
    description: 'Mark an existing Xero quote as Sent, Accepted or Declined (or back to Draft). Only when Seb said so for that quote. Marking Sent does NOT email anything: Xero does not let a connector email a quote, Seb sends it from Xero. Accepted moves the linked Hub job to Won and onto the Schedule; Declined moves it to Lost. For Invoiced use mark_quote_invoiced; to remove a quote use delete_quote.',
    inputSchema: { type: 'object', properties: {
      quote_number: { type: 'string', description: 'e.g. QU-0312' },
      status: { type: 'string', enum: ['SENT', 'ACCEPTED', 'DECLINED', 'DRAFT'] }
    }, required: ['quote_number', 'status'] }
  },
  {
    name: 'approve_invoice',
    description: 'Approve a draft Xero sales invoice (Draft or Awaiting approval → Approved / awaiting payment). It then counts in the books as money owed. Does not send it. Only when Seb said to approve that invoice.',
    inputSchema: { type: 'object', properties: { invoice_number: { type: 'string', description: 'e.g. INV-0345' } }, required: ['invoice_number'] }
  },
  {
    name: 'email_invoice',
    description: "EMAILS THE CLIENT. Sends an approved Xero sales invoice to the client's email address on their Xero contact, using Xero's standard invoice email with the PDF (the wording cannot be changed here). Never call on your own judgement: only after Seb has said, in this chat, to send this exact invoice; then pass confirm_send true. Check the invoice with find_invoices first and tell Seb the client, the total and the email address it will go to. Quotes cannot be emailed through the connector.",
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-0345' },
      confirm_send: { type: 'boolean', description: 'true only when Seb said to send this invoice.' }
    }, required: ['invoice_number', 'confirm_send'] }
  },
  {
    name: 'record_payment',
    description: 'Record that a client paid a Xero sales invoice (full or part). Only when Seb said the money arrived. The invoice must be approved. amount is inc GST and defaults to everything still owing; more than what is owing is refused. If Seb has more than one bank account in Xero and none is named, the tool lists them: ask Seb which one. When the deposit later shows in the bank feed, it must be matched to this payment, not entered again.',
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'e.g. INV-0345' },
      amount: { type: 'number', description: 'inc GST. Default: the full amount still owing.' },
      date: { type: 'string', description: 'Day the money arrived, YYYY-MM-DD. Default today.' },
      bank_account: { type: 'string', description: 'Name of the Xero bank account the money landed in.' },
      reference: { type: 'string' }
    }, required: ['invoice_number'] }
  },
  {
    name: 'create_credit_note',
    description: 'Create a Xero credit note for a client (a correction or a reduction). Amounts are positive and ex GST. By default it is a DRAFT and changes nothing until approved in Xero. With apply_to_invoice true (needs invoice_number, and Seb to have said so) it is approved and taken off what is still owing on that approved invoice. A cash refund on an invoice already paid is not done here: create the draft and Seb finishes the refund in Xero.',
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'The invoice this credit is for, e.g. INV-0345. Gives the client too.' },
      contact_id: { type: 'string' }, contact_name: { type: 'string', description: 'Only when there is no invoice_number.' },
      line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number', description: 'ex GST, positive' } }, required: ['description', 'unit_amount'] } },
      reference: { type: 'string' },
      apply_to_invoice: { type: 'boolean', description: 'true = approve the credit note and apply it to the invoice now. Default false (draft).' }
    }, required: ['line_items'] }
  },
  {
    name: 'create_bill',
    description: "Create a DRAFT supplier bill in Xero (money Matiere owes a supplier or subcontractor, to be paid later). It is never approved or paid from here. NOT for things already paid by card or at the counter: those receipts go through the Hub's Scan Receipt flow, and a bill as well would count the cost twice. Amounts include GST unless gst_included is false. account is the Xero cost account (name or code); if missing or unknown the tool lists the choices.",
    inputSchema: { type: 'object', properties: {
      supplier_name: { type: 'string' }, contact_id: { type: 'string' },
      line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number', description: 'inc GST unless gst_included is false' }, account: { type: 'string', description: 'Cost account for this line, if different' } }, required: ['description', 'unit_amount'] } },
      account: { type: 'string', description: 'Xero cost account for all lines, by name or code.' },
      date: { type: 'string', description: 'Bill date YYYY-MM-DD. Default today.' }, due_date: { type: 'string', description: 'YYYY-MM-DD' },
      reference: { type: 'string', description: "The supplier's own invoice number." },
      gst_included: { type: 'boolean', description: 'Default true: amounts include GST.' },
      gst_free: { type: 'boolean', description: 'true when the supplier charges no GST.' }
    }, required: ['line_items'] }
  },
  {
    name: 'attach_file',
    description: 'Attach a photo or document (pdf, jpg, png and similar, up to 4 MB) to a Xero quote or sales invoice. Give the file as file_url (a direct, public https link to the file) or as content_base64 (small files only). A photo dropped into a chat cannot be passed here unless it has a link. On an invoice, show_to_client true makes the file visible to the client on the online invoice; otherwise it is for Seb only.',
    inputSchema: { type: 'object', properties: {
      quote_number: { type: 'string' }, invoice_number: { type: 'string' },
      file_url: { type: 'string' }, content_base64: { type: 'string' },
      filename: { type: 'string', description: 'With its ending, e.g. site-photo.jpg' },
      show_to_client: { type: 'boolean', description: 'Invoices only. Default false.' }
    } }
  },
  {
    name: 'delete_quote',
    description: 'Delete redundant Xero quotes (Draft, Sent, Declined or Accepted; Invoiced quotes are refused). Permanent. Only call for quote numbers Seb himself has named for deletion in this chat; never on your own judgement. Up to 10 per call. The Hub copy is marked deleted and its follow-up reminder stops.',
    inputSchema: { type: 'object', properties: {
      quote_number: { type: 'string', description: 'One quote, e.g. QU-0310' },
      quote_numbers: { type: 'array', items: { type: 'string' }, description: 'Several quotes, up to 10' }
    } }
  },
  {
    name: 'delete_draft_quote',
    description: 'Old name for delete_quote (kept so existing chats keep working). Same rules: only for quote numbers Seb has named for deletion.',
    inputSchema: { type: 'object', properties: { quote_number: { type: 'string', description: 'e.g. QU-0310' } }, required: ['quote_number'] }
  },
  {
    name: 'delete_invoice',
    description: 'Remove redundant Xero sales invoices. Draft and Awaiting-approval invoices are deleted. An approved, unpaid invoice is in the books: it is only VOIDED, and only with allow_void true, which needs Seb to have said to void that invoice. Anything with a payment or credit is refused. Only call for invoice numbers Seb himself has named in this chat. Up to 10 per call.',
    inputSchema: { type: 'object', properties: {
      invoice_number: { type: 'string', description: 'One invoice, e.g. INV-0345' },
      invoice_numbers: { type: 'array', items: { type: 'string' }, description: 'Several invoices, up to 10' },
      allow_void: { type: 'boolean', description: 'true = also void approved, unpaid invoices. Default false.' }
    } }
  },
  {
    name: 'create_quote',
    description: 'Create a DRAFT Xero quote for a client (Seb reviews and sends from within Xero). Price materials from search_prices (the price library) first, and save any new web prices with save_price. Also, when job_name/materials/labour_hours are given, creates a shopping list of materials and a job baseline record (status "quoted") to compare against actuals later — this is Matiere\'s standard approve-a-quote workflow.',
    inputSchema: { type: 'object', properties: {
      contact_id: { type: 'string', description: 'Xero ContactID — preferred if already known' },
      contact_name: { type: 'string', description: 'Client name — looked up via find_contact if contact_id is not given' },
      title: { type: 'string' }, summary: { type: 'string', description: 'Brief scope summary shown on the quote' },
      line_items: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number' }
      }, required: ['description', 'unit_amount'] } },
      expiry_days: { type: 'number', description: 'Days until the quote expires, default 28' },
      job_name: { type: 'string', description: 'Project/job name for the baseline + shopping list (defaults to contact_name)' },
      labour_hours: { type: 'number', description: 'Estimated labour hours behind this quote, for the baseline record' },
      materials: { type: 'array', description: 'Materials for the shopping list + baseline materials estimate', items: { type: 'object', properties: {
        name: { type: 'string' }, qty: { type: 'string' }, cost: { type: 'number', description: 'Estimated cost of this line, ex GST' },
        special: { type: 'boolean', description: 'True if this item needs a supplier quote or special/custom order — it is highlighted at the top of the Shopping List tab' },
        supplier: { type: 'string', description: 'Supplier name for this item, shown when the item is tapped' },
        supplier_email: { type: 'string', description: 'Supplier email, used to prefill the "Email supplier" draft when the item is tapped' },
        lead_time: { type: 'string', description: 'Lead time as quoted by the supplier, e.g. "2-3 weeks"' },
        specs: { type: 'string', description: 'Spec/size/finish details needed to order the exact item' },
        delivery_fee: { type: 'number', description: 'Delivery fee quoted for this item, ex GST' },
        order_url: { type: 'string', description: 'Link to the supplier\'s product page or online order form for this item' }
      } } }
    }, required: ['line_items'] }
  },
  {
    name: 'mark_quote_invoiced',
    description: 'Mark a Xero quote as Invoiced (housekeeping, for a quote whose invoice already exists). create_invoice does this by itself when it is given a quote_number, so this is only for older quotes. Sent or Accepted quotes only; the quote itself is not otherwise changed.',
    inputSchema: { type: 'object', properties: { quote_number: { type: 'string', description: 'e.g. QU-0312' } }, required: ['quote_number'] }
  },
  {
    name: 'create_invoice',
    description: 'Create a DRAFT Xero invoice (ACCREC) for a client (Seb reviews and sends from within Xero). When the invoice follows a quote, ALWAYS pass quote_number (e.g. QU-0312) so the quote number prints on the invoice as its reference and the quote is marked Invoiced, exactly as when a quote is converted to an invoice inside Xero.',
    inputSchema: { type: 'object', properties: {
      contact_id: { type: 'string' }, contact_name: { type: 'string' },
      line_items: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number' }
      }, required: ['description', 'unit_amount'] } },
      due_days: { type: 'number', description: 'Days until due, default 14' },
      quote_number: { type: 'string', description: 'The Xero quote this invoice is for, e.g. QU-0312. Shown on the invoice as its reference. If left out and the client has exactly one accepted/sent quote, that one is used.' }
    }, required: ['line_items'] }
  }
];

async function callTool(name, args) {
  switch (name) {
    case 'search_prices':   return toolSearchPrices(args || {});
    case 'save_price':      return toolSavePrice(args || {});
    case 'find_contact':    return toolFindContact(args || {});
    case 'mark_quote_invoiced': return toolMarkQuoteInvoiced(args || {});
    case 'update_contact':  return toolUpdateContact(args || {});
    case 'find_quotes':     return toolFindQuotes(args || {});
    case 'find_invoices':   return toolFindInvoices(args || {});
    case 'update_quote':    return toolUpdateQuote(args || {});
    case 'update_invoice':  return toolUpdateInvoice(args || {});
    case 'set_quote_status': return toolSetQuoteStatus(args || {});
    case 'approve_invoice': return toolApproveInvoice(args || {});
    case 'email_invoice':   return toolEmailInvoice(args || {});
    case 'record_payment':  return toolRecordPayment(args || {});
    case 'create_credit_note': return toolCreateCreditNote(args || {});
    case 'create_bill':     return toolCreateBill(args || {});
    case 'attach_file':     return toolAttachFile(args || {});
    case 'delete_quote':
    case 'delete_draft_quote': return toolDeleteQuote(args || {});
    case 'delete_invoice':  return toolDeleteInvoice(args || {});
    case 'create_contact':  return toolCreateContact(args || {});
    case 'create_quote':    return toolCreateQuote(args || {});
    case 'create_invoice':  return toolCreateInvoice(args || {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Minimal stateless MCP JSON-RPC handler (Streamable HTTP, no SSE) ──────
exports.handler = async function (event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (MCP_SHARED_SECRET) {
    // Claude's custom-connector UI only offers a fixed dropdown of extra header
    // names (Authorization is reserved there for the connector's own OAuth flow,
    // which this server doesn't implement) — X-Api-Key is one of the presets, so
    // that's what Seb enters in Claude, with Authentication set to "No sign-in".
    // Still accept a bare Authorization: Bearer header too, for anything else
    // (curl, a future integration) that can set arbitrary headers.
    const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'] || '';
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const ok = apiKey === MCP_SHARED_SECRET || auth === `Bearer ${MCP_SHARED_SECRET}`;
    if (!ok) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  let rpc;
  try { rpc = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }) }; }

  const { id, method, params } = rpc;
  const respond = (result) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  const respondErr = (code, message) => ({ statusCode: 200, headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) });

  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'matierehub-xero', version: '1.0.0' }
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // Notifications carry no id and expect no response body.
      return { statusCode: 202, headers: cors, body: '' };
    }
    if (method === 'tools/list') {
      return respond({ tools: TOOLS });
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      try {
        const result = await callTool(name, args);
        return respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return respond({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    return respondErr(-32601, `Method not found: ${method}`);
  } catch (e) {
    return respondErr(-32603, e.message);
  }
};

// Shared with receipt-xero.js (same server-side Xero connection, no browser sign-in needed).
exports.xeroServer = { getAccessToken, getTenantId, xeroCall };
