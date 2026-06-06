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
async function getRefreshToken() {
  try {
    const store = getStore('xero-tokens');
    const token = await store.get('refresh_token');
    if (token) return token;
  } catch (e) {
    console.log('Blobs not available yet, falling back to env var:', e.message);
  }
  return process.env.XERO_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  try {
    const store = getStore('xero-tokens');
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
    if (page > 10) break; // safety cap
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

// ── P&L parsing helpers ───────────────────────────────────────────────────────

const MONTH_NUM = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};

// "Jul 2023" → { period: "2023-07", label: "Jul '23" }
function parseMonthLabel(label) {
  const m = (label || '').match(/^(\w{3})\s+(\d{4})$/);
  if (!m || !MONTH_NUM[m[1]]) return null;
  return { period: `${m[2]}-${MONTH_NUM[m[1]]}`, label: `${m[1]} '${m[2].slice(2)}` };
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

// Xero returns period columns newest-first; reverse to oldest-first for our charts.
function ensureChronological(parsed) {
  if (parsed.headerPeriods.length < 2) return parsed;
  const a = parseMonthLabel(parsed.headerPeriods[0]);
  const b = parseMonthLabel(parsed.headerPeriods[1]);
  if (a && b && a.period > b.period) {
    return {
      headerPeriods: [...parsed.headerPeriods].reverse(),
      sectionMap: Object.fromEntries(
        Object.entries(parsed.sectionMap).map(([s, accounts]) => [
          s,
          Object.fromEntries(Object.entries(accounts).map(([acc, vals]) => [acc, [...vals].reverse()]))
        ])
      )
    };
  }
  return parsed;
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

// Merge 3 monthly P&L parsed results into one spanning all periods (FY24 + FY25 + FY26)
function combineMonthly(p24, p25, p26) {
  const headerPeriods = [...p24.headerPeriods, ...p25.headerPeriods, ...p26.headerPeriods];
  const sectionMap    = {};

  const allSections = new Set([
    ...Object.keys(p24.sectionMap),
    ...Object.keys(p25.sectionMap),
    ...Object.keys(p26.sectionMap)
  ]);

  for (const section of allSections) {
    sectionMap[section] = {};
    const allAccounts = new Set([
      ...Object.keys(p24.sectionMap[section] || {}),
      ...Object.keys(p25.sectionMap[section] || {}),
      ...Object.keys(p26.sectionMap[section] || {})
    ]);
    for (const account of allAccounts) {
      const n24 = p24.headerPeriods.length, n25 = p25.headerPeriods.length, n26 = p26.headerPeriods.length;
      const v24 = p24.sectionMap[section]?.[account] || Array(n24).fill(0);
      const v25 = p25.sectionMap[section]?.[account] || Array(n25).fill(0);
      const v26 = p26.sectionMap[section]?.[account] || Array(n26).fill(0);
      sectionMap[section][account] = [...v24, ...v25, ...v26];
    }
  }

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
async function writeToSupabase(result, log) {
  // ── Parse monthly P&L reports (reverse to chronological order) ────────────
  const p24 = ensureChronological(parsePnL(result.pnl_fy24_monthly || {}));
  const p25 = ensureChronological(parsePnL(result.pnl_fy25_monthly || {}));
  const p26 = ensureChronological(parsePnL(result.pnl_fy26_monthly || {}));
  const all = combineMonthly(p24, p25, p26);

  const allPeriods = all.headerPeriods.map(parseMonthLabel).filter(Boolean);
  const nPeriods   = allPeriods.length;

  // Helper: extract single-FY summary from a sectionMap
  function fyTotals(sm) {
    const incomeAccts = findSection(sm, 'Income', 'Trading Income', 'Revenue');
    const cosAccts    = findSection(sm, 'Less Cost of Sales', 'Cost of Sales', 'Direct Costs');
    const opexAccts   = findSection(sm, 'Operating Expenses', 'Expenses');
    const netRow      = findAccount(sm, 'Net Profit', 'Net Surplus', 'Net Loss');

    const revenue = round2(Math.abs(sectionTotals(incomeAccts)[0] || 0));
    const cos     = round2(Math.abs(sectionTotals(cosAccts)[0] || 0));
    const gross   = round2(revenue - cos);
    const opex    = round2(Math.abs(sectionTotals(opexAccts)[0] || 0));
    const net     = netRow ? round2(netRow[0] || 0) : round2(revenue - cos - opex);
    return { revenue, cos, gross_profit: gross, opex, net_profit: net };
  }

  const fy24s = fyTotals(p24.sectionMap);
  const fy25s = fyTotals(p25.sectionMap);
  const fy26s = fyTotals(p26.sectionMap);

  // ── Invoice-derived values ─────────────────────────────────────────────────
  const invoices    = result.invoices || [];
  const openInvs    = invoices.filter(inv => inv.Status === 'AUTHORISED');
  const today       = new Date(); today.setHours(0, 0, 0, 0);
  const outstanding = round2(openInvs.reduce((s, inv) => s + (inv.AmountDue || inv.Total || 0), 0));
  const overdueXero = round2(
    openInvs
      .filter(inv => new Date(inv.DueDateString || inv.DateString || inv.Date) < today)
      .reduce((s, inv) => s + (inv.AmountDue || inv.Total || 0), 0)
  );

  // ── Quote-derived values ───────────────────────────────────────────────────
  const allQuotes = result.quotes || [];
  const pipeline  = round2(
    allQuotes
      .filter(q => q.status === 'DRAFT' || q.status === 'SENT')
      .reduce((s, q) => s + (q.total || 0), 0)
  );

  // ── Monthly arrays ─────────────────────────────────────────────────────────
  const incomeSect = findSection(all.sectionMap, 'Income', 'Trading Income');
  const cosSect    = findSection(all.sectionMap, 'Less Cost of Sales', 'Cost of Sales');

  // Revenue: prefer the "Total Income" SummaryRow, fall back to summing section rows
  const revRow     = incomeSect['Total Income'] || incomeSect['Total Trading Income'] || sectionTotals(incomeSect);

  // Materials: direct account within Cost of Sales section
  const matsRow    = cosSect['Materials'] || Array(nPeriods).fill(0);

  // Wages owner = Wages Payable + Loan - Sebastien Matiere (combined)
  const wagesP     = findAccount(all.sectionMap, 'Wages Payable')            || Array(nPeriods).fill(0);
  const loanSeb    = findAccount(all.sectionMap, 'Loan - Sebastien Matiere') || Array(nPeriods).fill(0);
  const wagesOwner = addArrays(wagesP, loanSeb);

  // Motor vehicles: sum all Motor Vehicles accounts across all sections
  const mvRows     = Object.values(all.sectionMap).flatMap(s =>
    Object.entries(s).filter(([k]) => k.startsWith('Motor Vehicles')).map(([, v]) => v)
  );
  const motorVeh   = mvRows.length ? addArrays(...mvRows) : Array(nPeriods).fill(0);

  // Subcontractors and Tax/BAS
  const subconRow  = findAccount(all.sectionMap, 'Subcontractors') || Array(nPeriods).fill(0);
  const taxRow     = findAccount(all.sectionMap, 'ATO/BAS Clearing') || Array(nPeriods).fill(0);

  const clamp = arr => arr.slice(0, nPeriods).map(v => round2(Math.abs(v)));

  // ── FY26-only values for kpis ─────────────────────────────────────────────
  const loanSeb26Sum = round2(Math.abs((findAccount(p26.sectionMap, 'Loan - Sebastien Matiere') || []).reduce((a, b) => a + b, 0)));
  const wagesP26Sum  = round2(Math.abs((findAccount(p26.sectionMap, 'Wages Payable')            || []).reduce((a, b) => a + b, 0)));
  const wages26Sum   = round2(Math.abs((findAccount(p26.sectionMap, 'Wages & Salaries')         || []).reduce((a, b) => a + b, 0)));
  const cashBal      = parseCashBalance(result.balance_sheet || {});

  // ── cost_detail_monthly ────────────────────────────────────────────────────
  const costDetail = {};
  for (const accounts of Object.values(all.sectionMap)) {
    for (const [name, vals] of Object.entries(accounts)) {
      if (name.startsWith('Total ') || name.startsWith('Net ')) continue;
      if (ACCOUNT_CATEGORIES[name]) {
        costDetail[name] = vals.slice(0, nPeriods).map(v => round2(Math.abs(v)));
      }
    }
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

  // ── Write all keys in parallel ─────────────────────────────────────────────
  const syncedAt = new Date().toISOString();
  await Promise.all([

    sbUpsert('fy_summary', {
      fy24: { revenue: fy24s.revenue, cos: fy24s.cos, gross_profit: fy24s.gross_profit, opex: fy24s.opex, net_profit: fy24s.net_profit },
      fy25: { revenue: fy25s.revenue, cos: fy25s.cos, gross_profit: fy25s.gross_profit, opex: fy25s.opex, net_profit: fy25s.net_profit },
      fy26: { revenue: fy26s.revenue, cos: fy26s.cos, gross_profit: fy26s.gross_profit, opex: fy26s.opex, net_profit: fy26s.net_profit }
    }),

    sbUpsert('kpis', {
      fy26_revenue:         round2(fy26s.revenue),
      fy26_materials:       round2(fy26s.cos),
      fy26_gross_profit:    round2(fy26s.gross_profit),
      fy26_gp_margin:       fy26s.revenue ? round2(fy26s.gross_profit / fy26s.revenue * 100) : 0,
      fy26_opex:            round2(fy26s.opex),
      fy26_wages:           wages26Sum,
      fy26_owner_drawings:  round2(loanSeb26Sum + wagesP26Sum),
      fy26_net_profit:      round2(fy26s.net_profit),
      cash_balance:         cashBal,
      total_outstanding:    outstanding,
      overdue_xero:         overdueXero,
      pipeline_total:       pipeline,
      total_revenue_alltime: round2(fy24s.revenue + fy25s.revenue + fy26s.revenue),
      sebRate_per_hour:     100
    }),

    sbUpsert('monthly', {
      labels:         allPeriods.map(p => p.label),
      periods:        allPeriods.map(p => p.period),
      revenue:        clamp(revRow),
      materials:      clamp(matsRow),
      wages_owner:    clamp(wagesOwner),
      motor_vehicles: clamp(motorVeh),
      subcontractors: clamp(subconRow),
      tax_bas:        clamp(taxRow)
    }),

    sbUpsert('open_invoices', openInvs.map(inv => ({
      invoice: inv.InvoiceNumber,
      contact: inv.Contact?.Name || '—',
      date:    (inv.DateString || inv.Date || '').slice(0, 10),
      amount:  round2(inv.AmountDue || inv.Total || 0)
    }))),

    sbUpsert('top_customers', topCustomers),

    allQuotes.length ? sbUpsert('quotes', allQuotes) : Promise.resolve(),

    sbUpsert('cost_detail_monthly', costDetail),

    sbUpsert('account_categories', ACCOUNT_CATEGORIES),

    sbUpsert('meta', {
      last_updated:  syncedAt,
      source:        'xero-sync',
      invoice_count: invoices.length,
      quotes_count:  allQuotes.length,
      period_count:  nPeriods
    })

  ]);

  log.push(`  → Wrote 9 keys to Supabase xero_cache (${nPeriods} monthly periods)`);
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

    // ── P&L reports — 3 FYs (monthly) + balance sheet ─────────────────────
    if (scope.includes('pnl')) {
      log.push('Fetching P&L reports (monthly, FY24–FY26) and balance sheet…');
      const [pnl24m, pnl25m, pnl26m, balSheet] = await Promise.all([
        xeroGet('Reports/ProfitAndLoss?toDate=2024-06-30&periods=12&timeframe=MONTH', accessToken, tenantId),
        xeroGet('Reports/ProfitAndLoss?toDate=2025-06-30&periods=12&timeframe=MONTH', accessToken, tenantId),
        xeroGet('Reports/ProfitAndLoss?toDate=2026-05-31&periods=11&timeframe=MONTH', accessToken, tenantId),
        xeroGet('Reports/BalanceSheet', accessToken, tenantId)
      ]);
      result.pnl_fy24_monthly = pnl24m;
      result.pnl_fy25_monthly = pnl25m;
      result.pnl_fy26_monthly = pnl26m;
      result.balance_sheet    = balSheet;
      log.push('  → P&L monthly reports and balance sheet fetched');
    }

    // ── Bank transactions (FY26) — kept for reference / future use ─────────
    if (scope.includes('bank')) {
      log.push('Fetching bank transactions…');
      const bank = await fetchAllPages(
        'BankTransactions?where=Date%3E%3DDateTime(2025%2C7%2C1)&unitdp=2',
        'BankTransactions', accessToken, tenantId
      );
      log.push(`  → ${bank.length} bank transactions fetched`);
      result.bank_tx_count = bank.length;
      // Not written to Supabase — P&L reports are the authoritative source for monthly data
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
        invoices:          result.invoices?.length   ? `[${result.invoices.length} invoices]`   : undefined,
        bank_transactions: undefined,
        pnl_fy24_monthly:  result.pnl_fy24_monthly   ? '[P&L FY24 monthly]'                     : undefined,
        pnl_fy25_monthly:  result.pnl_fy25_monthly   ? '[P&L FY25 monthly]'                     : undefined,
        pnl_fy26_monthly:  result.pnl_fy26_monthly   ? '[P&L FY26 monthly]'                     : undefined,
        balance_sheet:     result.balance_sheet       ? '[Balance Sheet]'                        : undefined
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
