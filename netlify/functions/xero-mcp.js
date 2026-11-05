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
  if (result.status >= 400) throw new Error(`Xero API error ${result.status} on ${method} ${endpoint}: ${result.body.slice(0, 400)}`);
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
  const id = await nextId('shopping_lists', 'SL');
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

async function toolCreateContact({ name, email, phone, address_line1, city, postal_code }) {
  // Guard: a blank/whitespace Name silently produces a Xero contact with no
  // client details on quotes/invoices (see BUGS.md 2026-09-18 — QU-0285).
  // Fail loudly instead so the caller fixes the call rather than shipping a
  // broken contact.
  const cleanName = (name || '').trim();
  if (!cleanName) {
    throw new Error('name is required and cannot be blank. Use the same "FirstName - Suburb" identifier as the quote title, e.g. "Vladimir - Manly Vale" — not just the first name.');
  }
  const accessToken = await getAccessToken();
  const tenantId = await getTenantId(accessToken);
  const payload = { Contacts: [{
    Name: cleanName,
    EmailAddress: email || undefined,
    Phones: phone ? [{ PhoneType: 'MOBILE', PhoneNumber: phone }] : undefined,
    Addresses: (address_line1 || city) ? [{ AddressType: 'STREET', AddressLine1: address_line1 || '', City: city || '', PostalCode: postal_code || '' }] : undefined
  }] };
  const res = await xeroCall('Contacts', 'POST', accessToken, tenantId, payload);
  const c = res.Contacts[0];
  return { ContactID: c.ContactID, Name: c.Name };
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

async function toolCreateInvoice(args) {
  const { contact_id, contact_name, line_items, due_days = 14 } = args;
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
  const due = new Date(today.getTime() + due_days * 86400000);
  const fmtDate = d => d.toISOString().slice(0, 10);

  const payload = { Invoices: [{
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
  return { InvoiceNumber: inv.InvoiceNumber, InvoiceID: inv.InvoiceID, Status: inv.Status, SubTotal: inv.SubTotal, Total: inv.Total };
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
    description: 'Create a new client contact in Xero (for a lead not yet in Xero). IMPORTANT: name must be the full client identifier in the same "FirstName - Suburb" pattern you will use as the create_quote title (e.g. "Vladimir - Manly Vale"), not just the first name — this is what shows as the client on the quote/invoice PDF. Also pass address_line1/city/postal_code when known, so the address prints too. Returns the new ContactID to use with create_quote/create_invoice.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
      address_line1: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' }
    }, required: ['name'] }
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
    name: 'create_invoice',
    description: 'Create a DRAFT Xero invoice (ACCREC) for a client (Seb reviews and sends from within Xero).',
    inputSchema: { type: 'object', properties: {
      contact_id: { type: 'string' }, contact_name: { type: 'string' },
      line_items: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number' }
      }, required: ['description', 'unit_amount'] } },
      due_days: { type: 'number', description: 'Days until due, default 14' }
    }, required: ['line_items'] }
  }
];

async function callTool(name, args) {
  switch (name) {
    case 'search_prices':   return toolSearchPrices(args || {});
    case 'save_price':      return toolSavePrice(args || {});
    case 'find_contact':    return toolFindContact(args || {});
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
