/**
 * xero-sync.js — Server-side Xero data sync for MatiereHub
 *
 * What this does:
 *   1. Reads a long-lived Xero refresh token (stored in Netlify Blobs / env var)
 *   2. Exchanges it for a fresh access token (saves rotated token back to Blobs)
 *   3. Fetches all required data from Xero: quotes, invoices, P&L (3 FYs × monthly), balance sheet
 *   4. Transforms the raw data into structured xero_cache keys
 *   5. Upserts all keys directly into Supabase xero_cache table
 *
 * Security:
 *   - Protected by SYNC_SECRET env var — callers must send the right bearer token
 *   - Xero credentials never leave the server
 *   - Refresh token stored in Netlify Blobs (persists across calls, no redeploy needed)
 *
 * Required Netlify env vars:
 *   XERO_CLIENT_ID       — from your Xero developer app
 *   XERO_CLIENT_SECRET   — from your Xero developer app
 *   XERO_REFRESH_TOKEN   — initial token (paste from browser localStorage once)
 *   SYNC_SECRET          — a password you choose; Claude sends this to authenticate
 *   SUPABASE_URL         — https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY — service_role JWT (from Supabase Settings → API)
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Token management ──────────────────────────────────────────────────────────
// In-memory override for the current invocation only — set when the caller seeds
// a fresh token via the request body. Takes priority over Blobs/env to avoid a
// save-then-immediate-read propagation race that was causing "token consumed"
// errors even right after a successful re-auth.
let _seededRefreshToken = null;

// getStore('xero-tokens') cannot auto-detect its context in this deploy — it throws
// "environment has not been configured to use Netlify Blobs". xero-auth.js works around
// this by passing siteID/token explicitly (NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN). This
// function MUST do the same — otherwise it silently falls through to the auto-detect
// branch (which throws, caught below) and ends up reading/writing a DIFFERENT store than
// xero-auth.js, so freshly-rotated tokens saved on reconnect are never seen here, and the
// stale `XERO_REFRESH_TOKEN` env var keeps getting reused → "Refresh token has been
// consumed" on every sync no matter how many times Xero is reconnected. Fixed 2026-06-08
// — see BUGS.md "Removing NETLIFY_SITE_ID/NETLIFY_BLOBS_TOKEN broke Xero token propagation".
function tokenStore() {
  return getStore({ name: 'xero-tokens', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
}

async function getRefreshToken() {
  if (_seededRefreshToken) return _seededRefreshToken;
  try {
    const store = tokenStore();
    const token = await store.get('refresh_token');
    if (token) return token;
  } catch (e) {
    console.log('Blobs not available yet, falling back to env var:', e.message);
  }
  return process.env.XERO_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  try {
    const store = tokenStore();
    await store.set('refresh_token', token);
  } catch (e) {
    console.warn('Could not save refresh token to Blobs:', e.message);
  }
}

async function getAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token available. Re-authenticate via the Hub first.');

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET env vars.');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;

  const result = await httpRequest({
    hostname: 'identity.xero.com',
    path: '/connect/token',
    method: 'POST',
    headers: {
      'Authorization':  `Basic ${credentials}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  const tokens = JSON.parse(result.body);
  if (tokens.error) throw new Error(`Xero auth error: ${tokens.error} — ${tokens.error_description || ''}`);
  if (tokens.refresh_token) await saveRefreshToken(tokens.refresh_token);
  return { accessToken: tokens.access_token, expiresIn: tokens.expires_in };
}

// ── Xero API caller ───────────────────────────────────────────────────────────
async function xeroGet(endpoint, accessToken, tenantId) {
  const result = await httpRequest({
    hostname: 'api.xero.com',
    path: `/api.xro/2.0/${endpoint}`,
    method: 'GET',
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept':         'application/json'
    }
  });
  if (result.status >= 400) throw new Error(`Xero API error ${result.status} on ${endpoint}: ${result.body.slice(0, 200)}`);
  return JSON.parse(result.body);
}

// ── Tenant lookup ─────────────────────────────────────────────────────────────
async function getTenantId(accessToken) {
  const result = await httpRequest({
    hostname: 'api.xero.com',
    path: '/connections',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
  });
  const tenants = JSON.parse(result.body);
  if (!Array.isArray(tenants) || tenants.length === 0) throw new Error('No Xero organisation found.');
  return tenants[0].tenantId;
}

// ── Chart of accounts lookup ──────────────────────────────────────────────────
// Maps account NAME → Xero account CODE. We look this up live (rather than hardcoding
// codes) because account codes can be renumbered in Xero but names stay stable — this
// is what lets us find "ATO/BAS Clearing" / "Superannuation Payable" transactions
// without Seb (or Claude, in a future session) having to go hunting for magic numbers.
async function getAccountCodeMap(accessToken, tenantId) {
  const res = await xeroGet('Accounts', accessToken, tenantId);
  const map = {};
  for (const acc of (res.Accounts || [])) {
    if (acc.Name && acc.Code) map[acc.Name] = acc.Code;
  }
  return map;
}

// ── Paginated fetch ───────────────────────────────────────────────────────────
async function fetchAllPages(baseEndpoint, key, accessToken, tenantId) {
  let all = [], page = 1;
  while (true) {
    const sep = baseEndpoint.includes('?') ? '&' : '?';
    const res = await xeroGet(`${baseEndpoint}${sep}page=${page}`, accessToken, tenantId);
    const batch = res[key] || [];
    all = all.concat(batch);
    if (batch.length < 100) break;
    page++;
    if (page > 30) break; // safety cap — raised from 10: full-history bank-transaction
                          // fetches (Dec 2022→now, ~3.5 yrs) can exceed 1,000 records
  }
  return all;
}

// ── Supabase upsert ───────────────────────────────────────────────────────────
async function sbUpsert(key, data) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set');
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/xero_cache`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key, data, updated_at: new Date().toISOString() })
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Supabase upsert "${key}" failed: ${res.status} ${msg.slice(0, 200)}`);
  }
}

// ── Supabase upsert for contacts table ───────────────────────────────────────
// Same chunk pattern as sbUpsertInvoiceItems. Note column intentionally excluded
// from the payload — it holds HUB-entered notes that must not be overwritten by sync.
async function sbUpsertContacts(rows, log) {
  if (!rows.length) { if (log) log.push('  → 0 contacts to write'); return; }
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Supabase contacts upsert failed (chunk ${i}): ${res.status} ${msg.slice(0, 200)}`);
    }
  }
  if (log) log.push(`  → ${rows.length} contacts written to contacts table`);
}

// ── Transform Xero contacts → contacts table rows ─────────────────────────────
//
// Column mapping:
//   id            ← c.ContactID       (Xero UUID — primary key, matches invoice_items.contact_id)
//   name          ← c.Name
//   first_name    ← c.FirstName
//   last_name     ← c.LastName
//   email         ← c.EmailAddress
//   address_line1 ← c.Addresses → prefer AddressType=POBOX, fall back to STREET
//   city          ← same address object → City
//   region        ← same address object → Region
//   postal_code   ← same address object → PostalCode
//   country       ← same address object → Country
//   phone         ← c.Phones → prefer PhoneType=DEFAULT, fall back to MOBILE
//                   built as: (AreaCode ? AreaCode + ' ' : '') + PhoneNumber
//   is_customer   ← c.IsCustomer (bool) — true for Xero "Customer" contacts
//   note          ← intentionally OMITTED — HUB-input field, never synced
//   updated_at    ← current time (refreshed on every sync run)
//
function transformContacts(contacts) {
  const rows = [];
  const now  = new Date().toISOString();

  for (const c of contacts) {
    if (!c.ContactID) continue;

    // Address: POBOX preferred, STREET as fallback
    const addrs   = c.Addresses || [];
    const addr    = addrs.find(a => a.AddressType === 'POBOX')
                 || addrs.find(a => a.AddressType === 'STREET')
                 || {};

    // Phone: DEFAULT preferred, MOBILE as fallback
    const phones  = c.Phones || [];
    const ph      = phones.find(p => p.PhoneType === 'DEFAULT')
                 || phones.find(p => p.PhoneType === 'MOBILE')
                 || {};
    const phoneStr = [ph.AreaCode, ph.PhoneNumber].filter(Boolean).join(' ').trim();

    rows.push({
      id:            c.ContactID,
      name:          (c.Name         || '').trim(),
      first_name:    (c.FirstName    || '').trim(),
      last_name:     (c.LastName     || '').trim(),
      email:         (c.EmailAddress || '').trim(),
      address_line1: (addr.AddressLine1 || '').trim(),
      city:          (addr.City        || '').trim(),
      region:        (addr.Region      || '').trim(),
      postal_code:   (addr.PostalCode  || '').trim(),
      country:       (addr.Country     || '').trim(),
      phone:         phoneStr,
      abn:           (c.TaxNumber || '').trim(),
      is_customer:   !!c.IsCustomer,
      updated_at:    now
      // note, categories, rating, is_supplier intentionally omitted — HUB-only fields, never overwritten by sync
    });
  }
  return rows;
}

// ── Transform Xero bank transactions → bank_transactions table rows ───────────
//
// One row per BankTransaction (not per line item).
// Multi-line-item transactions: first LineItem drives account_code/account_name;
// all descriptions are concatenated with " | ".
//
// Column mapping:
//   id            ← tx.BankTransactionID
//   date          ← tx.DateString (YYYY-MM-DD)
//   type          ← tx.Type  (SPEND | RECEIVE)
//   contact       ← tx.Contact.Name
//   contact_id    ← tx.Contact.ContactID
//   account_code  ← tx.LineItems[0].AccountCode
//   account_name  ← resolved via codeToName map (inverted getAccountCodeMap result)
//   description   ← tx.LineItems[*].Description joined with " | "
//   reference     ← tx.Reference
//   gross         ← tx.Total (incl. GST)
//   tax           ← tx.TotalTax
//   net           ← tx.SubTotal (excl. GST)
//   debit         ← tx.Total if SPEND, else 0
//   credit        ← tx.Total if RECEIVE, else 0
//   bank_account  ← tx.BankAccount.Name
//   status        ← tx.Status
//   is_reconciled ← tx.IsReconciled
//   expense_log_id← null (manually linked or auto-matched later)
//
function transformBankTransactions(bankTx, accountCodeMap) {
  // Build reverse map: code → name
  const codeToName = {};
  for (const [name, code] of Object.entries(accountCodeMap)) codeToName[code] = name;

  const rows = [];
  for (const tx of bankTx) {
    if (!tx.BankTransactionID) continue;
    if (tx.Status === 'DELETED') continue; // skip deleted transactions

    const lineItems  = tx.LineItems || [];
    const firstLI    = lineItems[0] || {};
    const accCode    = (firstLI.AccountCode || '').trim();

    // Concatenate all non-empty descriptions
    const desc = lineItems
      .map(li => (li.Description || '').trim())
      .filter(Boolean)
      .join(' | ');

    const gross = round2(Math.abs(tx.Total     || 0));
    const tax   = round2(Math.abs(tx.TotalTax  || 0));
    const net   = round2(Math.abs(tx.SubTotal  || 0));

    rows.push({
      id:            tx.BankTransactionID,
      date:          (tx.DateString || tx.Date || '').slice(0, 10) || null,
      type:          tx.Type || '',
      contact:       (tx.Contact?.Name      || '').trim(),
      contact_id:    (tx.Contact?.ContactID || '').trim(),
      account_code:  accCode,
      account_name:  (codeToName[accCode] || '').trim(),
      description:   desc,
      reference:     (tx.Reference || '').trim(),
      gross,
      tax,
      net,
      debit:         tx.Type === 'SPEND'   ? gross : 0,
      credit:        tx.Type === 'RECEIVE' ? gross : 0,
      bank_account:  (tx.BankAccount?.Name || '').trim(),
      status:        tx.Status || '',
      is_reconciled: !!tx.IsReconciled
      // expense_log_id intentionally omitted — defaults to NULL; manually linked or auto-matched later
    });
  }
  return rows;
}

// ── Supabase upsert for bank_transactions table ───────────────────────────────
async function sbUpsertBankTransactions(rows, log) {
  if (!rows.length) { if (log) log.push('  → 0 bank transactions to write'); return; }
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bank_transactions`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Supabase bank_transactions upsert failed (chunk ${i}): ${res.status} ${msg.slice(0, 200)}`);
    }
  }
  if (log) log.push(`  → ${rows.length} bank transactions written to bank_transactions table`);
}

// ── Supabase upsert for invoice_items table (separate from xero_cache) ────────
// Rows are batched in chunks of 100 to stay within Supabase request size limits.
// Uses Xero's LineItemID as the primary key — stable even if line items are reordered.
async function sbUpsertInvoiceItems(rows, log) {
  if (!rows.length) { if (log) log.push('  → 0 invoice line items to write'); return; }
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/invoice_items`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Supabase invoice_items upsert failed (chunk ${i}): ${res.status} ${msg.slice(0, 200)}`);
    }
  }
  if (log) log.push(`  → ${rows.length} invoice line items written to invoice_items table`);
}

// ── Transform Xero invoices → invoice_items rows ──────────────────────────────
//
// Column mapping:
//   id             ← li.LineItemID (Xero UUID — stable primary key)
//                    fallback: {InvoiceNumber}-{padded index} if no LineItemID
//   invoice_number ← inv.InvoiceNumber  (e.g. 'INV-0345')
//   item           ← li.ItemCode        (short code, often blank)
//   description    ← li.Description     (full text as on Xero)
//   qty            ← li.Quantity
//   unit_price     ← li.UnitAmount      (excl. GST)
//   price_excl_gst ← li.LineAmount      (Xero's stored value — respects Xero rounding)
//   quote_number   ← inv.Reference      (Xero's "Ref" column — auto-populated with the
//                    linked quote number, e.g. 'QU-0259', when invoice was created from
//                    a quote; blank string when no quote is linked)
//   contact        ← inv.Contact.Name
//   contact_id     ← inv.Contact.ContactID (Xero UUID — foreign key for a future contacts
//                    table that will hold email, suburb, address, etc. Storing it now means
//                    revenue-by-suburb queries can be done with a simple JOIN later without
//                    any backfilling.)
//   date           ← inv.DateString     (YYYY-MM-DD)
//   status         ← inv.Status         (PAID, AUTHORISED, DRAFT, VOIDED, …)
//   notes          ← ''                 (HUB input — written via claude-parse, not this sync)
//   paid           ← li.LineAmount × (inv.AmountPaid / inv.Total)
//                    Both AmountPaid and Total are incl. GST from Xero — ratio is correct.
//                    Fully-paid invoice  → paid = price_excl_gst.
//                    75%-paid invoice    → paid = 75% of price_excl_gst.
//                    DRAFT/unpaid        → paid = 0.
//
// Skips line items with no Description AND no LineAmount (empty Xero placeholder rows).
function transformInvoiceItems(invoices) {
  const rows = [];
  for (const inv of invoices) {
    const total      = inv.Total      || 0;   // incl. GST
    const amountPaid = inv.AmountPaid || 0;   // incl. GST
    const payRatio   = total > 0 ? Math.min(amountPaid / total, 1) : 0;
    const quoteRef   = (inv.Reference || '').trim();  // 'QU-0259' or '' when no quote linked

    (inv.LineItems || []).forEach((li, idx) => {
      const desc    = (li.Description || '').trim();
      const lineAmt = li.LineAmount || 0;
      if (!desc && lineAmt === 0) return;      // skip empty placeholder rows

      rows.push({
        id:             li.LineItemID || `${inv.InvoiceNumber}-${String(idx + 1).padStart(2, '0')}`,
        invoice_number: inv.InvoiceNumber || '',
        item:           (li.ItemCode || '').trim(),
        description:    desc,
        qty:            li.Quantity   || 1,
        unit_price:     li.UnitAmount || 0,
        price_excl_gst: lineAmt,
        quote_number:   quoteRef,
        contact:        inv.Contact?.Name       || '',
        contact_id:     inv.Contact?.ContactID  || '',
        date:           (inv.DateString    || inv.Date    || '').slice(0, 10) || null,
        due_date:       (inv.DueDateString || inv.DueDate || '').slice(0, 10) || null,
        status:         inv.Status || '',
        // notes intentionally omitted — HUB input written by claude-parse.js and must
        // not be overwritten by the sync. Supabase merge-duplicates only updates columns
        // present in the payload, so leaving notes out preserves any manually-added notes.
        paid:           round2(lineAmt * payRatio)
      });
    });
  }
  return rows;
}

// ── Supabase read (used to merge new chunks into previously-cached history) ───
async function sbSelect(key) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/xero_cache?key=eq.${key}&select=data`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0]?.data || null;
  } catch (e) {
    return null;
  }
}

// ── P&L parsing helpers ───────────────────────────────────────────────────────

const MONTH_NUM = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

// Handles both Xero formats:
//   "30 Jun 26"  (DD Mon YY  — what Xero actually returns for periods)
//   "Jun 2025"   (Mon YYYY   — older/alternative format)
// → { period: "2026-06", label: "Jun '26" }
function parseMonthLabel(label) {
  // "30 Jun 26"
  const m1 = (label || '').match(/^\d{1,2}\s+(\w{3})\s+(\d{2})$/);
  if (m1 && MONTH_NUM[m1[1]]) {
    const year = 2000 + parseInt(m1[2], 10);
    return { period: `${year}-${MONTH_NUM[m1[1]]}`, label: `${m1[1]} '${m1[2]}` };
  }
  // "Jun 2025"
  const m2 = (label || '').match(/^(\w{3})\s+(\d{4})$/);
  if (m2 && MONTH_NUM[m2[1]]) {
    return { period: `${m2[2]}-${MONTH_NUM[m2[1]]}`, label: `${m2[1]} '${m2[2].slice(2)}` };
  }
  return null;
}

// Parse a Xero P&L report (single-period or multi-period monthly).
// Returns { headerPeriods: string[], sectionMap: { sectionTitle: { rowName: number[] } } }
function parsePnL(reportObj) {
  const report = reportObj?.Reports?.[0] || reportObj;
  if (!report?.Rows) return { headerPeriods: [], sectionMap: {} };

  const headerRow     = report.Rows.find(r => r.RowType === 'Header');
  const headerPeriods = (headerRow?.Cells || []).slice(1).map(c => c.Value || '');
  const n             = Math.max(1, headerPeriods.length);

  const sectionMap = {};
  for (const section of report.Rows) {
    if (section.RowType !== 'Section') continue;
    const title = (section.Title || '').trim();
    if (!title) continue;
    sectionMap[title] = {};
    for (const row of (section.Rows || [])) {
      if (!row.Cells?.length) continue;
      const name = (row.Cells[0].Value || '').trim();
      if (!name) continue;
      const vals = row.Cells.slice(1).map(c => {
        const v = parseFloat((c.Value || '').replace(/,/g, ''));
        return isNaN(v) ? 0 : v;
      });
      while (vals.length < n) vals.push(0);
      sectionMap[title][name] = vals.slice(0, n);
    }
  }
  return { headerPeriods, sectionMap };
}

// ── Calendar-month range helpers (for fetching discrete, non-overlapping monthly P&L) ────
// See BUGS.md "Revenue/costs inflated ~9-10x" — Xero's `periods`+`timeframe=MONTH`
// comparison-report mode returns rolling trailing-12-month windows, not calendar months.
// The fix is to fetch one bounded `fromDate`/`toDate` report per calendar month instead.

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// "2023-07" → "Jul 2023" — a label format parseMonthLabel already understands
function periodToHeaderLabel(period) {
  const [y, m] = period.split('-');
  return `${MONTH_ABBR[parseInt(m, 10) - 1]} ${y}`;
}

// {from, to, period} for each calendar month from (startYear,startMonth) to (endYear,endMonth) inclusive
function monthRange(startYear, startMonth, endYear, endMonth) {
  const out = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const mm = String(m).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`, period: `${y}-${mm}` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Find a section by partial/exact title match; returns its accounts object or {}
function findSection(sectionMap, ...candidates) {
  for (const c of candidates) {
    const key = Object.keys(sectionMap).find(k =>
      k === c ||
      k.toLowerCase().includes(c.toLowerCase()) ||
      c.toLowerCase().includes(k.toLowerCase())
    );
    if (key) return sectionMap[key];
  }
  return {};
}

// Return the "Total …" summary row values from a section, or sum all non-total rows
function sectionTotals(accounts) {
  for (const [name, vals] of Object.entries(accounts)) {
    if (name.startsWith('Total ') || name === 'Net Profit' || name === 'Net Loss') return vals;
  }
  const rows = Object.entries(accounts).filter(([n]) => !n.startsWith('Total ') && !n.startsWith('Net '));
  if (!rows.length) return [0];
  const len = rows[0][1].length;
  return rows.reduce((sum, [, v]) => sum.map((s, i) => s + (v[i] || 0)), Array(len).fill(0));
}

// Find a specific account across all sections (exact then case-insensitive)
function findAccount(sectionMap, ...names) {
  for (const name of names) {
    for (const accounts of Object.values(sectionMap)) {
      const key = Object.keys(accounts).find(k => k === name || k.toLowerCase() === name.toLowerCase());
      if (key) return accounts[key];
    }
  }
  return null;
}

// Element-wise sum of multiple same-length arrays
function addArrays(...arrays) {
  const len = Math.max(...arrays.map(a => a.length), 1);
  return Array.from({ length: len }, (_, i) => arrays.reduce((s, a) => s + (a[i] || 0), 0));
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Merge monthly chunks into the persisted history ───────────────────────────
// Lets us backfill years of history in several short runs (each run only fetches a
// bounded `from`/`to` window of P&L months — see monthRange call below) without
// ever losing months synced in a previous run, AND lets a future lightweight
// "just sync last month" run update one period without wiping the rest. Sources
// are merged in order — later sources overwrite earlier ones for the same period —
// so freshly-fetched data always wins over what's cached.
function mergeMonthly(...sources) {
  const map = {};
  for (const src of sources) {
    if (!src || !Array.isArray(src.periods)) continue;
    src.periods.forEach((period, i) => {
      map[period] = map[period] || { period, label: src.labels?.[i] || period };
      if (src.labels?.[i]) map[period].label = src.labels[i];
      for (const field of Object.keys(src)) {
        if (field === 'periods' || field === 'labels') continue;
        if (Array.isArray(src[field])) map[period][field] = src[field][i] ?? 0;
      }
    });
  }
  const periods = Object.keys(map).sort();
  const fields = [...new Set(periods.flatMap(p => Object.keys(map[p])))].filter(f => f !== 'period' && f !== 'label');
  const out = { periods, labels: periods.map(p => map[p].label) };
  for (const f of fields) out[f] = periods.map(p => map[p][f] ?? 0);
  return out;
}

// ── Transaction-level BAS / Super / Owner-drawings (the "source of truth" fix) ──
// ATO/BAS Clearing, Superannuation Payable, Loan - Sebastien Matiere and Wages Payable
// are Balance Sheet LIABILITY accounts — they never post to the P&L, which is why the
// dashboard always showed $0 for tax/BAS/super even though real cash went out the door
// (see BUGS.md "fy26_owner_drawings is 0" / project_bas_tax_gap memory). Real spend is
// what actually left the bank account, so we sum SPEND bank-transaction line items coded
// to these accounts, bucketed by month — the same proven mechanism that already produces
// the (correct) owner-drawings figure, just generalised across accounts and full history.
function bucketLiabilitiesByMonth(bankTx, accountCodeMap, periods, log) {
  const GROUPS = {
    tax_bas:        { names: ['ATO/BAS Clearing'],                              fallbackCodes: [] },
    super:          { names: ['Superannuation Payable'],                        fallbackCodes: [] },
    owner_drawings: { names: ['Loan - Sebastien Matiere', 'Wages Payable'],     fallbackCodes: ['896', '804'] }
  };
  const codeSets = {};
  for (const [key, { names, fallbackCodes }] of Object.entries(GROUPS)) {
    let codes = names.map(n => accountCodeMap[n]).filter(Boolean);
    if (!codes.length && fallbackCodes.length) {
      codes = fallbackCodes;
      if (log) log.push(`  ⚠ "${names.join('"/"')}" not found in chart of accounts — using last-known code(s) ${fallbackCodes.join(', ')}`);
    } else if (codes.length < names.length && log) {
      const missing = names.filter(n => !accountCodeMap[n]);
      log.push(`  ⚠ Couldn't find account code for: ${missing.join(', ')} — ${key} figures may be partial`);
    }
    codeSets[key] = codes;
  }

  const buckets = {};
  for (const key of Object.keys(GROUPS)) buckets[key] = Object.fromEntries(periods.map(p => [p, 0]));
  const periodSet = new Set(periods);

  for (const tx of bankTx) {
    if (tx.Type !== 'SPEND') continue;
    const period = (tx.DateString || tx.Date || '').slice(0, 7);
    if (!periodSet.has(period)) continue;
    for (const li of (tx.LineItems || [])) {
      for (const key of Object.keys(GROUPS)) {
        if (codeSets[key].includes(li.AccountCode)) {
          buckets[key][period] += Math.abs(li.LineAmount || 0);
        }
      }
    }
  }

  const out = {};
  for (const key of Object.keys(GROUPS)) out[key] = periods.map(p => round2(buckets[key][p] || 0));
  return out;
}

// ── Transaction-level liability detail (for Seb's BAS/Super/Drawings audit) ───
// Same SPEND-transaction scan as bucketLiabilitiesByMonth, but instead of summing into
// monthly totals we keep each line item — date, payee, account, description, amount —
// so the dashboard can show Seb exactly which transactions make up a liability total
// (he asked: "how can I audit why TAX and BAS are showing zero... I don't see the
// details of transactions"). Grouped the same way (tax_bas / super / owner_drawings)
// so the front-end can match them 1:1 against the monthly series and the P&L category map.
function extractLiabilityTransactions(bankTx, accountCodeMap, log) {
  const GROUPS = {
    tax_bas:        { names: ['ATO/BAS Clearing'],                          fallbackCodes: [] },
    super:          { names: ['Superannuation Payable'],                    fallbackCodes: [] },
    owner_drawings: { names: ['Loan - Sebastien Matiere', 'Wages Payable'], fallbackCodes: ['896', '804'] }
  };
  const codeToName = {};
  for (const [name, code] of Object.entries(accountCodeMap)) codeToName[code] = name;

  const codeSets = {};
  for (const [key, { names, fallbackCodes }] of Object.entries(GROUPS)) {
    let codes = names.map(n => accountCodeMap[n]).filter(Boolean);
    if (!codes.length && fallbackCodes.length) codes = fallbackCodes;
    codeSets[key] = codes;
  }

  const out = { tax_bas: [], super: [], owner_drawings: [] };
  for (const tx of bankTx) {
    if (tx.Type !== 'SPEND') continue;
    const date  = (tx.DateString || tx.Date || '').slice(0, 10);
    const payee = tx.Contact?.Name || '—';
    const ref   = tx.Reference || tx.InvoiceNumber || null;
    for (const li of (tx.LineItems || [])) {
      for (const key of Object.keys(GROUPS)) {
        if (codeSets[key].includes(li.AccountCode)) {
          out[key].push({
            date,
            payee,
            account_code: li.AccountCode,
            account_name: codeToName[li.AccountCode] || GROUPS[key].names[0],
            description:  (li.Description || '').trim(),
            amount:       round2(Math.abs(li.LineAmount || 0)),
            ref
          });
        }
      }
    }
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => (a.date < b.date ? 1 : (a.date > b.date ? -1 : 0)));
  if (log) for (const key of Object.keys(out)) log.push(`  → ${key}: ${out[key].length} liability transactions extracted for audit detail`);
  return out;
}

// Recursively search balance sheet rows for "Total Bank Accounts" and return its value
function parseCashBalance(bsObj) {
  const report = bsObj?.Reports?.[0] || bsObj;
  if (!report?.Rows) return 0;

  function searchRows(rows) {
    for (const row of rows) {
      if (row.RowType === 'SummaryRow') {
        const name = (row.Cells?.[0]?.Value || '').toLowerCase();
        if (name.includes('bank') || name === 'total cash') {
          const v = parseFloat((row.Cells?.[1]?.Value || '').replace(/,/g, ''));
          if (!isNaN(v)) return v;
        }
      }
      if (row.Rows) {
        const found = searchRows(row.Rows);
        if (found !== null) return found;
      }
    }
    return null;
  }

  const balance = searchRows(report.Rows);
  return round2(Math.abs(balance || 0));
}

// Fetch ONE P&L report PER CALENDAR MONTH and stitch them into a single combined
// {headerPeriods, sectionMap} structure spanning the whole range.
//
// WHY: Xero's `periods`+`timeframe=MONTH` "comparison report" mode does NOT return discrete,
// non-overlapping calendar months — it returns rolling trailing-12-month windows anchored to
// the report date. That caused every "monthly" revenue/cost figure on the dashboard to be a
// ~12-month rolling total instead of that month's actual figure (~9-10x inflation — Seb
// spotted "March '24 showing $165k when it should be ~$10-15k"; full investigation in
// BUGS.md "Revenue/costs inflated ~9-10x"). Fetching one bounded `fromDate`/`toDate` report
// per month is slower (N calls, batched) but each report can only return the single
// calendar-month period we explicitly asked for — guaranteed correct, no API guesswork.
async function fetchDiscreteMonthlyPnL(months, accessToken, tenantId, log) {
  // Xero enforces a hard concurrency limit of 5 simultaneous calls per org (429 if exceeded),
  // plus 60/minute. BATCH=6 was tripping the concurrency limit. Drop to 3 concurrent and add
  // a short pause between batches so we comfortably sit under both limits.
  const BATCH = 3;
  const PAUSE_MS = 700;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const reports = [];
  for (let i = 0; i < months.length; i += BATCH) {
    const batch = months.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(({ from, to }) => xeroGet(`Reports/ProfitAndLoss?fromDate=${from}&toDate=${to}`, accessToken, tenantId))
    );
    reports.push(...batchResults);
    if (log) log.push(`  → fetched discrete monthly P&L: ${Math.min(i + BATCH, months.length)}/${months.length}`);
    if (i + BATCH < months.length) await sleep(PAUSE_MS);
  }

  const headerPeriods = months.map(m => periodToHeaderLabel(m.period));
  const sectionMap    = {};
  reports.forEach((reportObj, i) => {
    const parsed = parsePnL(reportObj);
    for (const [section, accounts] of Object.entries(parsed.sectionMap)) {
      sectionMap[section] = sectionMap[section] || {};
      for (const [name, vals] of Object.entries(accounts)) {
        if (!sectionMap[section][name]) sectionMap[section][name] = Array(months.length).fill(0);
        sectionMap[section][name][i] = vals[0] || 0; // single-period report → one value per month
      }
    }
  });

  return { headerPeriods, sectionMap };
}

// Static account → dashboard category mapping (drives cost_detail_monthly colours/grouping)
const ACCOUNT_CATEGORIES = {
  'Sales':                                  'Income',
  'Materials':                              'Materials',
  'Purchases':                              'Materials',
  'Consumables':                            'Materials',
  'Tools':                                  'Materials',
  'Subcontractors':                         'Subcontractors',
  'Wages & Salaries':                       'Wages & Owner Pay',
  'Wages Payable':                          'Wages & Owner Pay',
  'Loan - Sebastien Matiere':               'Wages & Owner Pay',
  'Superannuation Payable':                 'Wages & Owner Pay',
  'Motor Vehicles - Registration & Insurance': 'Motor Vehicles',
  'Motor Vehicles - Fuel & Oil':            'Motor Vehicles',
  'Motor Vehicles - Repairs & Maintenance': 'Motor Vehicles',
  'Motor Vehicles - Tolls':                 'Motor Vehicles',
  'ATO/BAS Clearing':                       'Tax & BAS',
  'Accounting & Bookkeeping Fees':          'Operating',
  'Mobile Phone':                           'Operating',
  'Subscriptions & Memberships':            'Operating',
  'Insurance':                              'Operating',
  'Sundry Expenses':                        'Operating',
  'Advertising & Marketing':                'Operating',
  'Postage':                                'Operating',
  'Bank Fees':                              'Operating',
  'Printing & Stationery':                  'Operating',
  'Office Expenses':                        'Operating',
  'Uniforms':                               'Operating',
  'Fines & Penalties':                      'Operating',
  'Client Gift':                            'Operating',
  'Donations':                              'Operating',
  'Filing Fees':                            'Operating',
  'Staff Amenities':                        'Operating',
  'Office Equipment':                       'Operating',
  'Training & Conferences':                 'Operating',
  'Hire of Plant & Equipment':              'Operating',
  'Suspense':                               'Operating'
};

// ── Transform raw Xero data → write all xero_cache keys to Supabase ───────────
// Format a 'YYYY-MM' period string as a chart label ('2022-07' → 'Jul 2022') —
// independent of Xero's report-header format, so liability series spanning the
// full history (which has no Xero header strings of its own) can still be labelled.
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function periodLabel(period) {
  const [y, m] = period.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

async function writeToSupabase(result, log) {
  // ── Parse P&L reports ─────────────────────────────────────────────────────
  // FY23 + FY24 + FY25 + FY26: single-period summaries (clean fromDate→toDate ranges,
  // ONE total per account) → used for fy_summary and FY26 KPIs. This is the same
  // mechanism that already produced correct FY24/FY25 totals — now extended back to
  // FY23 (Matiere's first full financial year — Xero data starts Dec 2022) and used
  // for FY26 too instead of (incorrectly) summing rolling-window monthly columns.
  const p23 = parsePnL(result.pnl_fy23 || {});
  const p24 = parsePnL(result.pnl_fy24 || {});
  const p25 = parsePnL(result.pnl_fy25 || {});
  const p26 = parsePnL(result.pnl_fy26 || {});

  // Presence flags — only true when this run's `scope` actually included that section.
  // Used below to guard kpis/meta/fy_summary/open_invoices/top_customers so a partial-scope
  // run (e.g. ?scope=bank) can't blank out fields it never fetched (mirrors `haveBankData`).
  const havePnLData     = !!result.pnl_fy26;

  // Discrete calendar-month P&L for the chart arrays — fetched one bounded report per
  // month (see fetchDiscreteMonthlyPnL), combined into one {headerPeriods, sectionMap}.
  // NOTE: this is now only a CHUNK of the full history (bounded by ?from=/?to=, default
  // 2022-07→current month) — see the `pnl` scope block. It gets merged with whatever's
  // already cached below (mergeMonthly), so a multi-run backfill never loses earlier months.
  const pChunk       = result.pnl_monthly || { headerPeriods: [], sectionMap: {} };
  const chunkPeriods = pChunk.headerPeriods.map(parseMonthLabel).filter(Boolean);
  const nChunk       = chunkPeriods.length;

  // Helper: extract FY totals from a sectionMap (works for both single and multi-period)
  function fyTotals(sm) {
    const incomeAccts = findSection(sm, 'Income', 'Trading Income', 'Revenue');
    const cosAccts    = findSection(sm, 'Less Cost of Sales', 'Cost of Sales', 'Direct Costs');
    const opexAccts   = findSection(sm, 'Operating Expenses', 'Expenses');
    const netRow      = findAccount(sm, 'Net Profit', 'Net Surplus', 'Net Loss');

    // For multi-period, sum all columns; for single-period, [0] is the only value
    const sumVals = vals => (vals || [0]).reduce((a, b) => a + b, 0);

    const revenue = round2(Math.abs(sumVals(sectionTotals(incomeAccts))));
    const cos     = round2(Math.abs(sumVals(sectionTotals(cosAccts))));
    const gross   = round2(revenue - cos);
    const opex    = round2(Math.abs(sumVals(sectionTotals(opexAccts))));
    const net     = netRow ? round2(sumVals(netRow)) : round2(revenue - cos - opex);
    return { revenue, cos, gross_profit: gross, opex, net_profit: net };
  }

  const fy23s = fyTotals(p23.sectionMap);
  const fy24s = fyTotals(p24.sectionMap);
  const fy25s = fyTotals(p25.sectionMap);
  const fy26s = fyTotals(p26.sectionMap);

  // ── Invoice-derived values ─────────────────────────────────────────────────
  const invoices        = result.invoices || [];
  const haveInvoiceData = Array.isArray(result.invoices);
  const openInvs    = invoices.filter(inv => inv.Status === 'AUTHORISED');
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const outstanding = round2(openInvs.reduce((s, inv) => s + (inv.AmountDue || inv.Total || 0), 0));
  const overdueXero = round2(
    openInvs
      .filter(inv => new Date(inv.DueDateString || inv.DateString || inv.Date) < today)
      .reduce((s, inv) => s + (inv.AmountDue || inv.Total || 0), 0)
  );

  // ── Quote-derived values ───────────────────────────────────────────────────
  const allQuotes     = result.quotes || [];
  const haveQuoteData = Array.isArray(result.quotes);
  const pipeline  = round2(
    allQuotes
      .filter(q => q.status === 'DRAFT' || q.status === 'SENT')
      .reduce((s, q) => s + (q.total || 0), 0)
  );

  // ── Fresh P&L-derived monthly chunk (only the date-range this run fetched) ────
  const incomeSect = findSection(pChunk.sectionMap, 'Income', 'Trading Income');
  const cosSect    = findSection(pChunk.sectionMap, 'Less Cost of Sales', 'Cost of Sales');

  const revRow     = incomeSect['Total Income'] || incomeSect['Total Trading Income'] || sectionTotals(incomeSect);
  const matsRow    = cosSect['Materials'] || Array(nChunk).fill(0);

  const wagesP     = findAccount(pChunk.sectionMap, 'Wages Payable')            || Array(nChunk).fill(0);
  const loanSeb    = findAccount(pChunk.sectionMap, 'Loan - Sebastien Matiere') || Array(nChunk).fill(0);
  const wagesSal   = findAccount(pChunk.sectionMap, 'Wages & Salaries')         || Array(nChunk).fill(0);
  const wagesOwner = addArrays(wagesP, loanSeb, wagesSal);

  const mvRows     = Object.values(pChunk.sectionMap).flatMap(s =>
    Object.entries(s).filter(([k]) => k.startsWith('Motor Vehicles')).map(([, v]) => v)
  );
  const motorVeh   = mvRows.length ? addArrays(...mvRows) : Array(nChunk).fill(0);

  const subconRow  = findAccount(pChunk.sectionMap, 'Subcontractors') || Array(nChunk).fill(0);

  // 'Operating' bucket = sum of every P&L account mapped to 'Operating' in
  // ACCOUNT_CATEGORIES (Bank Fees, Insurance, Mobile Phone, Office Expenses, etc.)
  // — added 2026-06-08 to fix the P&L tab showing $0 for Operating (it was reading
  // monthly.operating, which never existed; see project_wages_owner_pay_mapping_verified memory).
  const operatingNames = Object.entries(ACCOUNT_CATEGORIES)
    .filter(([, cat]) => cat === 'Operating')
    .map(([name]) => name);
  const opRows = Object.values(pChunk.sectionMap).flatMap(s =>
    Object.entries(s).filter(([k]) => operatingNames.includes(k)).map(([, v]) => v)
  );
  const operatingRow = opRows.length ? addArrays(...opRows) : Array(nChunk).fill(0);

  const clamp = arr => arr.slice(0, nChunk).map(v => round2(Math.abs(v)));

  const freshChunk = {
    periods:        chunkPeriods.map(p => p.period),
    labels:         chunkPeriods.map(p => p.label),
    revenue:        clamp(revRow),
    materials:      clamp(matsRow),
    wages_owner:    clamp(wagesOwner),
    motor_vehicles: clamp(motorVeh),
    subcontractors: clamp(subconRow),
    operating:      clamp(operatingRow)
    // NOTE: tax_bas deliberately omitted here — it used to be sourced from the P&L
    // 'ATO/BAS Clearing' account, which is a Balance Sheet liability that never posts
    // to the P&L and was therefore always $0 (see project_bas_tax_gap memory). The
    // transaction-derived `freshLiability` series below supplies the real figure and
    // wins on merge for every period, retiring the broken P&L-based field entirely.
  };

  // ── Liability series (BAS, Super, Owner Drawings) — sourced from bank TRANSACTIONS,
  // not the P&L, because 'ATO/BAS Clearing', 'Superannuation Payable', 'Loan - Sebastien
  // Matiere' and 'Wages Payable' are Balance Sheet LIABILITY accounts that structurally
  // never appear in a Profit & Loss report (see BUGS.md "fy26_owner_drawings is 0" /
  // project_bas_tax_gap memory — root cause of the long-standing $0 BAS/Tax/Super bug).
  // Real spend is cash that actually left the bank account, so we bucket SPEND
  // transactions coded to these accounts by month — across the FULL transaction history
  // (independent of whichever P&L date-chunk this run covers), so these figures are
  // always complete and correct, never partial.
  const todayStr2        = todayISO();
  const fullHistoryMonths  = monthRange(2022, 7, parseInt(todayStr2.slice(0, 4), 10), parseInt(todayStr2.slice(5, 7), 10));
  const fullHistoryPeriods = fullHistoryMonths.map(m => m.period);
  const bankTx           = result.bank_transactions || [];
  const accountCodeMap   = result.account_code_map  || {};
  const haveBankData     = Array.isArray(result.bank_transactions); // only present when scope included 'bank'

  let freshLiability    = null;
  let liabilityTxDetail = null;
  if (haveBankData) {
    const liability = bucketLiabilitiesByMonth(bankTx, accountCodeMap, fullHistoryPeriods, log);
    freshLiability = {
      periods: fullHistoryPeriods,
      labels:  fullHistoryPeriods.map(periodLabel),
      tax_bas:        liability.tax_bas,
      super:          liability.super,
      owner_drawings: liability.owner_drawings
    };
    liabilityTxDetail = extractLiabilityTransactions(bankTx, accountCodeMap, log);
  } else {
    log.push('  ⚠ scope did not include "bank" — leaving cached BAS/Super/Owner-Drawings figures and liability_transactions untouched');
  }

  // ── Merge: cached history ← fresh P&L chunk ← fresh liability series ──────────
  // Order matters: existing cache is the base (so months outside this run's chunk
  // survive), the fresh P&L chunk overwrites its covered months' revenue/cost fields,
  // and — only if this run actually fetched bank data — the liability series overwrites
  // tax_bas/super/owner_drawings for the FULL history (it always wins where present,
  // since it's the only correct source for those fields).
  const existingMonthly = await sbSelect('monthly');
  const mergeSources    = [existingMonthly, freshChunk];
  if (freshLiability) mergeSources.push(freshLiability);
  const merged   = mergeMonthly(...mergeSources);
  const nPeriods = merged.periods.length;

  // ── FY26 KPI-specific values ──────────────────────────────────────────────
  const wages26Sum = round2(Math.abs((findAccount(p26.sectionMap, 'Wages & Salaries') || []).reduce((a, b) => a + b, 0)));
  const cashBal    = parseCashBalance(result.balance_sheet || {});

  // FY26 = periods '2025-07' through '2026-06'. Derived from the MERGED series (always
  // complete) rather than the current chunk or a one-off transaction filter — so these
  // KPIs are correct on every run regardless of which date-range was synced this time.
  const fy26Mask = merged.periods.map(p => p >= '2025-07' && p <= '2026-06');
  const sumFy26  = arr => round2((arr || []).reduce((s, v, i) => s + (fy26Mask[i] ? (v || 0) : 0), 0));

  const ownerDrawings26 = sumFy26(merged.owner_drawings);
  const taxBas26        = sumFy26(merged.tax_bas);
  const super26         = sumFy26(merged.super);

  // ── cost_detail_monthly — current-FY (FY26) cost breakdown, sliced from this run's
  // P&L chunk. Only rebuilt when the chunk actually includes FY26 months — otherwise
  // (e.g. a backfill run covering FY23 only) we'd overwrite good FY26 data with empty
  // FY23-era figures. Guarded by `nP26Chunk > 0`; the existing cached value is left as-is
  // when skipped (we simply don't include the key in this run's upsert batch).
  const fy26ChunkIdx = chunkPeriods.reduce((acc, p, i) => { if (p.period >= '2025-07') acc.push(i); return acc; }, []);
  const nP26Chunk    = fy26ChunkIdx.length;
  const sliceFy26    = arr => fy26ChunkIdx.map(i => arr[i] || 0);

  let costDetail = null;
  if (nP26Chunk > 0) {
    costDetail = {};
    for (const accounts of Object.values(pChunk.sectionMap)) {
      for (const [name, vals] of Object.entries(accounts)) {
        if (name.startsWith('Total ') || name.startsWith('Net ')) continue;
        if (ACCOUNT_CATEGORIES[name]) {
          costDetail[name] = sliceFy26(vals).map(v => round2(Math.abs(v)));
        }
      }
    }
  } else {
    log.push('  ℹ this run\'s P&L chunk has no FY26 months — leaving cached cost_detail_monthly untouched');
  }

  // ── top_customers ──────────────────────────────────────────────────────────
  const custMap = {};
  for (const inv of invoices) {
    if (inv.Status !== 'PAID' && inv.Status !== 'AUTHORISED') continue;
    const name = inv.Contact?.Name || 'Unknown';
    custMap[name] = (custMap[name] || 0) + (inv.SubTotal || 0);
  }
  const topCustomers = Object.entries(custMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, revenue]) => ({ name, revenue: round2(revenue) }));

  // ── Guarded reads of currently-cached kpis/meta ───────────────────────────
  // `kpis` and `meta` are composite objects whose sub-fields come from FOUR different
  // scopes (pnl, invoices, quotes, bank). A partial-scope run (e.g. ?scope=bank, used to
  // backfill liability_transactions) must not blank out the fields it didn't fetch — that
  // is exactly what caused the empty Cash & Invoices tab on 2026-06-08 (kpis/meta were
  // unconditionally rewritten from `result.invoices||[]`/`result.quotes||[]`/`fy26s`, all
  // empty when scope=bank). Fix: start from the EXISTING cached object and only overwrite
  // the sub-fields whose source scope was actually included this run — same spirit as the
  // `if (costDetail)` / `allQuotes.length ?` guards already used for cost_detail_monthly/quotes.
  const existingKpis = (await sbSelect('kpis')) || {};
  const existingMeta = (await sbSelect('meta')) || {};

  const kpisOut = { ...existingKpis, sebRate_per_hour: 100 };
  if (havePnLData) {
    Object.assign(kpisOut, {
      fy26_revenue:          round2(fy26s.revenue),
      fy26_materials:        round2(fy26s.cos),
      fy26_gross_profit:     round2(fy26s.gross_profit),
      fy26_gp_margin:        fy26s.revenue ? round2(fy26s.gross_profit / fy26s.revenue * 100) : 0,
      fy26_opex:             round2(fy26s.opex),
      fy26_wages:            wages26Sum,
      fy26_net_profit:       round2(fy26s.net_profit),
      cash_balance:          cashBal,
      total_revenue_alltime: round2(fy23s.revenue + fy24s.revenue + fy25s.revenue + fy26s.revenue)
    });
  }
  // owner_drawings/tax_bas/super are always derived from `merged`, which carries the full
  // history forward from `existingMonthly` regardless of this run's scope — safe to always set.
  Object.assign(kpisOut, {
    fy26_owner_drawings: ownerDrawings26,
    fy26_tax_bas:        taxBas26,
    fy26_super:          super26
  });
  if (haveInvoiceData) {
    Object.assign(kpisOut, { total_outstanding: outstanding, overdue_xero: overdueXero });
  }
  if (haveQuoteData) {
    Object.assign(kpisOut, { pipeline_total: pipeline });
  }

  // ── Write all keys in parallel ─────────────────────────────────────────────
  const syncedAt = new Date().toISOString();

  const metaOut = {
    ...existingMeta,
    last_updated:   syncedAt,
    source:         'xero-sync',
    period_count:   nPeriods,
    bank_tx_synced: haveBankData
  };
  if (haveInvoiceData) metaOut.invoice_count = invoices.length;
  if (haveQuoteData)   metaOut.quotes_count  = allQuotes.length;
  if (havePnLData)     metaOut.pnl_chunk_range = result.pnl_chunk_range || null;

  const writes = [

    // fy_summary needs all four FY P&L reports — only rebuilt (and only overwrites the
    // cache) when this run's scope included 'pnl'; otherwise the existing cached value
    // (from a prior full sync) is left untouched.
    havePnLData ? sbUpsert('fy_summary', {
      fy23: { revenue: fy23s.revenue, cos: fy23s.cos, gross_profit: fy23s.gross_profit, opex: fy23s.opex, net_profit: fy23s.net_profit },
      fy24: { revenue: fy24s.revenue, cos: fy24s.cos, gross_profit: fy24s.gross_profit, opex: fy24s.opex, net_profit: fy24s.net_profit },
      fy25: { revenue: fy25s.revenue, cos: fy25s.cos, gross_profit: fy25s.gross_profit, opex: fy25s.opex, net_profit: fy25s.net_profit },
      fy26: { revenue: fy26s.revenue, cos: fy26s.cos, gross_profit: fy26s.gross_profit, opex: fy26s.opex, net_profit: fy26s.net_profit }
    }) : Promise.resolve(),

    // kpis/meta — built above as existing-cache ⊕ this-run's-fetched-sections, so a
    // partial-scope run can never zero out fields belonging to scopes it didn't fetch.
    sbUpsert('kpis', kpisOut),
    sbUpsert('meta', metaOut),

    // `merged` = cached history ⊕ this run's fresh P&L chunk ⊕ (if fetched) the full
    // transaction-derived liability series — see the merge step above. Spans full
    // history (Jul'22→now) once fully backfilled, regardless of how many runs it took.
    sbUpsert('monthly', merged),

    // open_invoices / top_customers are both derived purely from `result.invoices` — only
    // refreshed (and only overwrite the cache) when this run's scope included 'invoices'.
    haveInvoiceData ? sbUpsert('open_invoices', openInvs.map(inv => ({
      invoice: inv.InvoiceNumber,
      contact: inv.Contact?.Name || '—',
      date:    (inv.DateString || inv.Date || '').slice(0, 10),
      amount:  round2(inv.AmountDue || inv.Total || 0)
    }))) : Promise.resolve(),

    haveInvoiceData ? sbUpsert('top_customers', topCustomers) : Promise.resolve(),

    haveQuoteData && allQuotes.length ? sbUpsert('quotes', allQuotes) : Promise.resolve(),

    sbUpsert('account_categories', ACCOUNT_CATEGORIES)

  ];

  // cost_detail_monthly is only rebuilt when this run's P&L chunk covers FY26 — see guard
  // above. Omitting the upsert (rather than writing an empty object) leaves the cached
  // value untouched, so a backfill run over older FYs can't blank out current-year data.
  if (costDetail) writes.push(sbUpsert('cost_detail_monthly', costDetail));

  // liability_transactions — line-item audit detail (date, payee, account, amount) backing
  // the BAS/Super/Owner-Drawings totals, so Seb can see exactly which transactions make up
  // each figure (he asked to "audit why TAX and BAS are showing zero" and see "lines of
  // money in and out with codes"). Only written when this run fetched bank data — same
  // guard as freshLiability, for the same reason (must be complete, never partial).
  if (liabilityTxDetail) {
    writes.push(sbUpsert('liability_transactions', {
      ...liabilityTxDetail,
      generated_at: syncedAt
    }));
  }

  await Promise.all(writes);

  log.push(`  → Wrote ${writes.length} keys to Supabase xero_cache (${nPeriods} monthly periods merged${result.pnl_chunk_range ? `, this run's P&L chunk: ${result.pnl_chunk_range.from}→${result.pnl_chunk_range.to}` : ''})`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type':                 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── Authentication ─────────────────────────────────────────────────────────
  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret) {
    const auth     = event.headers['authorization'] || event.headers['Authorization'] || '';
    const provided = auth.replace('Bearer ', '').trim();
    if (provided !== syncSecret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised. Provide the correct SYNC_SECRET.' }) };
    }
  }

  // ── Scope (default: everything) ────────────────────────────────────────────
  const params = event.queryStringParameters || {};
  const scope  = params.scope ? params.scope.split(',') : ['quotes', 'invoices', 'pnl', 'bank'];

  // ── Optional: seed a fresh refresh token from POST body ──────────────────
  // Useful when Netlify Blobs has a stale token and the fresh one is in the browser.
  // Pass { "refresh_token": "..." } in the request body to override Blobs.
  try {
    if (event.body) {
      const bodyData = JSON.parse(event.body);
      if (bodyData.refresh_token) {
        _seededRefreshToken = bodyData.refresh_token;       // used immediately by getAccessToken — no Blobs round-trip
        await saveRefreshToken(bodyData.refresh_token);     // also persist for future invocations
        console.log('Seeded fresh refresh token from request body (in-memory override + Blobs)');
      }
    }
  } catch(e) { /* non-fatal — body may be empty or non-JSON */ }

  try {
    const startTime = Date.now();
    const log       = [];

    log.push('Getting Xero access token…');
    const { accessToken } = await getAccessToken();
    const tenantId        = await getTenantId(accessToken);
    log.push(`Connected to tenant: ${tenantId}`);

    const result = { synced_at: new Date().toISOString(), tenant_id: tenantId, log };

    // ── Quotes ─────────────────────────────────────────────────────────────
    if (scope.includes('quotes')) {
      log.push('Fetching quotes…');
      const quotes = await fetchAllPages('Quotes', 'Quotes', accessToken, tenantId);
      log.push(`  → ${quotes.length} quotes fetched`);
      result.quotes = quotes.map(q => ({
        number:       q.QuoteNumber,
        contact:      q.Contact ? q.Contact.Name : '—',
        contact_id:   q.Contact ? q.Contact.ContactID : null,
        date:         (q.DateString   || q.Date        || '').slice(0, 10),
        expiry:       (q.ExpiryDateString || q.ExpiryDate || '').slice(0, 10),
        status:       q.Status,
        total:        Math.abs(q.SubTotal || 0),
        total_inc_gst: Math.abs(q.Total   || 0),
        line_items:   (q.LineItems || [])
          .filter(li => (li.Description || '').trim())
          .map(li => ({
            desc:    (li.Description || '').trim(),
            qty:     li.Quantity   || null,
            unit:    Math.abs(li.UnitAmount  || 0),
            total:   Math.abs(li.LineAmount  || 0),
            account: li.AccountCode || null
          }))
      }));
    }

    // ── Invoices (FY26) ────────────────────────────────────────────────────
    if (scope.includes('invoices')) {
      log.push('Fetching FY26 invoices…');
      const invoices = await fetchAllPages(
        'Invoices?where=Type%3D%3D%22ACCREC%22%26%26Date%3E%3DDateTime(2025%2C7%2C1)&unitdp=2&summaryOnly=false',
        'Invoices', accessToken, tenantId
      );
      log.push(`  → ${invoices.length} invoices fetched`);
      result.invoices = invoices;
    }

    // ── Invoice line items (all-time history → invoice_items table) ────────────
    // Fetches ALL ACCREC invoices (no date filter) so the table covers every
    // invoice ever raised in Xero — not just FY26. Line items from each invoice
    // are transformed by transformInvoiceItems() and upserted directly into the
    // `invoice_items` Supabase table (not xero_cache).
    //
    // Run once with ?scope=invoice_items to build the initial history.
    // Re-run any time to pick up new invoices or updated payment statuses —
    // upsert (resolution=merge-duplicates) means it's always safe to re-run.
    if (scope.includes('invoice_items')) {
      log.push('Fetching all-time ACCREC invoices for line-item history…');
      const allInvoices = await fetchAllPages(
        'Invoices?where=Type%3D%3D%22ACCREC%22&unitdp=2&summaryOnly=false',
        'Invoices', accessToken, tenantId
      );
      log.push(`  → ${allInvoices.length} invoices fetched`);

      const itemRows = transformInvoiceItems(allInvoices);
      log.push(`  → ${itemRows.length} line items extracted`);

      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        await sbUpsertInvoiceItems(itemRows, log);
      } else {
        log.push('  ⚠ SUPABASE_URL/KEY not set — skipping invoice_items write');
      }

      result.invoice_items_count = itemRows.length;
    }

    // ── Contacts (all Xero contacts → contacts table) ─────────────────────────
    // Fetches all contacts (paginated) and upserts into the `contacts` table.
    // is_customer=true for contacts marked as customers in Xero.
    // The `note` column is excluded from the upsert payload — it's a HUB-only field.
    // Safe to re-run at any time; upsert key is ContactID.
    if (scope.includes('contacts')) {
      log.push('Fetching all Xero contacts…');
      const allContacts = await fetchAllPages('Contacts', 'Contacts', accessToken, tenantId);
      log.push(`  → ${allContacts.length} contacts fetched`);

      const contactRows = transformContacts(allContacts);
      log.push(`  → ${contactRows.length} contacts transformed`);

      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        await sbUpsertContacts(contactRows, log);
      } else {
        log.push('  ⚠ SUPABASE_URL/KEY not set — skipping contacts write');
      }

      result.contacts_count = contactRows.length;
    }

    // ── P&L reports — FY summaries + discrete monthly breakdown + balance sheet ──
    // FY24/FY25/FY26 are each fetched as a single bounded fromDate→toDate report (one
    // total per account — the mechanism already proven correct for FY24/FY25). The monthly
    // chart data is built from N individually-fetched calendar-month reports rather than
    // Xero's `periods`+`timeframe` comparison mode — see fetchDiscreteMonthlyPnL for why.
    if (scope.includes('pnl')) {
      log.push('Fetching P&L reports and balance sheet…');
      const todayStr   = todayISO();
      const FY26_START = '2025-07-01', FY26_END = '2026-06-30';
      const fy26ToDate = todayStr < FY26_END ? todayStr : FY26_END;

      const [pnl23, pnl24, pnl25, pnl26, balSheet] = await Promise.all([
        xeroGet('Reports/ProfitAndLoss?fromDate=2022-07-01&toDate=2023-06-30', accessToken, tenantId),
        xeroGet('Reports/ProfitAndLoss?fromDate=2023-07-01&toDate=2024-06-30', accessToken, tenantId),
        xeroGet('Reports/ProfitAndLoss?fromDate=2024-07-01&toDate=2025-06-30', accessToken, tenantId),
        xeroGet(`Reports/ProfitAndLoss?fromDate=${FY26_START}&toDate=${fy26ToDate}`, accessToken, tenantId),
        xeroGet('Reports/BalanceSheet', accessToken, tenantId)
      ]);
      result.pnl_fy23      = pnl23;   // single-period FY23 summary (Matiere's first full FY in Xero — Dec 2022 start)
      result.pnl_fy24      = pnl24;   // single-period FY24 summary (for fy_summary)
      result.pnl_fy25      = pnl25;   // single-period FY25 summary (for fy_summary)
      result.pnl_fy26      = pnl26;   // single-period FY26-to-date summary (for fy_summary + KPIs)
      result.balance_sheet = balSheet;
      log.push('  → FY summary P&L reports (FY23–FY26) and balance sheet fetched');

      // Discrete monthly P&L is the slow part (~1 Xero call per calendar month — 11 max
      // per `periods` request, so we fetch one bounded report per month). Fetching all
      // ~47 months (Jul'22 → now) in one run risks the Netlify Function timeout, so the
      // range is chunkable via ?from=YYYY-MM&to=YYYY-MM — e.g. run once per FY to backfill
      // (from=2022-07&to=2023-06, then 2023-07&to=2024-06, etc), and a future lightweight
      // weekly sync can pass just the last month or two. Chunks are merged with whatever's
      // already cached (see mergeMonthly in writeToSupabase) — nothing already-synced is lost.
      const DEFAULT_FROM = '2022-07', DEFAULT_TO = todayStr.slice(0, 7);
      const fromParam = /^\d{4}-\d{2}$/.test(params.from || '') ? params.from : DEFAULT_FROM;
      const toParam   = /^\d{4}-\d{2}$/.test(params.to   || '') ? params.to   : DEFAULT_TO;
      const [fy, fm] = fromParam.split('-').map(n => parseInt(n, 10));
      const [ty, tm] = toParam.split('-').map(n => parseInt(n, 10));

      log.push(`Fetching discrete monthly P&L (${fromParam} → ${toParam})…`);
      const months = monthRange(fy, fm, ty, tm);
      result.pnl_monthly = await fetchDiscreteMonthlyPnL(months, accessToken, tenantId, log);
      result.pnl_chunk_range = { from: fromParam, to: toParam };
      log.push(`  → ${months.length} discrete monthly P&L reports fetched and combined`);
    }

    // ── Bank transactions (full history) — liability-account figures (BAS/Super/   ──
    // Owner Drawings) are computed from these, NOT the P&L, because those accounts are
    // Balance Sheet liabilities that never post to P&L (see project_bas_tax_gap memory /
    // BUGS.md). Fetched in full (not chunked) — at ~11 paginated calls even across 4 years
    // this is cheap relative to the monthly-P&L fetch, and these figures must always be
    // complete regardless of which P&L date-chunk a given run covers.
    if (scope.includes('bank')) {
      log.push('Fetching full bank transaction history (Dec 2022 → now)…');
      const bank = await fetchAllPages(
        'BankTransactions?where=Date%3E%3DDateTime(2022%2C12%2C1)&unitdp=2',
        'BankTransactions', accessToken, tenantId
      );
      log.push(`  → ${bank.length} bank transactions fetched`);
      result.bank_tx_count    = bank.length;
      result.bank_transactions = bank; // used by writeToSupabase to compute liability series; not written to Supabase directly

      log.push('Looking up chart-of-accounts codes for liability accounts…');
      result.account_code_map = await getAccountCodeMap(accessToken, tenantId);
    }

    // ── bank_transactions scope — write ALL bank transactions to the bank_transactions ──
    // Supabase table for full drill-down (date, contact, account, debit/credit, ref).
    // This is the raw transaction ledger — every line of real money in/out.
    // Separate from the `bank` scope which only computes liability bucket totals for the
    // P&L dashboard. Run once to seed history; safe to re-run any time (upsert by ID).
    // Requires the bank_transactions table to exist (see supabase_bank_transactions.sql).
    if (scope.includes('bank_transactions')) {
      log.push('Fetching full bank transaction history for bank_transactions table…');
      // Re-use already-fetched data if `bank` scope also ran this request
      let bankAll = result.bank_transactions;
      if (!bankAll) {
        bankAll = await fetchAllPages(
          'BankTransactions?where=Date%3E%3DDateTime(2022%2C12%2C1)&unitdp=2',
          'BankTransactions', accessToken, tenantId
        );
        log.push(`  → ${bankAll.length} bank transactions fetched`);
      } else {
        log.push(`  → re-using ${bankAll.length} bank transactions already fetched by 'bank' scope`);
      }

      // Need the account code map to resolve account names
      let codeMap = result.account_code_map;
      if (!codeMap) {
        log.push('Looking up chart-of-accounts codes…');
        codeMap = await getAccountCodeMap(accessToken, tenantId);
        result.account_code_map = codeMap;
      }

      const txRows = transformBankTransactions(bankAll, codeMap);
      log.push(`  → ${txRows.length} rows transformed (${bankAll.length - txRows.length} DELETED skipped)`);

      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        await sbUpsertBankTransactions(txRows, log);
      } else {
        log.push('  ⚠ SUPABASE_URL/KEY not set — skipping bank_transactions write');
      }

      result.bank_transactions_count = txRows.length;
    }

    result.duration_ms = Date.now() - startTime;
    log.push(`Fetches complete in ${result.duration_ms}ms`);

    // ── Transform & write to Supabase ──────────────────────────────────────
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      log.push('Transforming and writing to Supabase xero_cache…');
      await writeToSupabase(result, log);
    } else {
      log.push('⚠ SUPABASE_URL or SUPABASE_SERVICE_KEY not set — skipping Supabase write');
    }

    result.duration_total_ms = Date.now() - startTime;
    log.push(`Total duration: ${result.duration_total_ms}ms`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...result,
        // Strip raw Xero blobs from the response to keep it readable
        invoices:          result.invoices?.length    ? `[${result.invoices.length} invoices]`        : undefined,
        bank_transactions: result.bank_transactions   ? `[${result.bank_transactions.length} bank tx]` : undefined,
        pnl_monthly:       result.pnl_monthly         ? `[P&L: ${result.pnl_monthly.headerPeriods.length} discrete months]` : undefined,
        balance_sheet:     result.balance_sheet       ? '[Balance Sheet]'                              : undefined
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
