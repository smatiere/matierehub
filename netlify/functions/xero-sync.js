/**
 * xero-sync.js — Server-side Xero data sync for MatiereHub
 *
 * What this does:
 *   1. Reads a long-lived Xero refresh token (stored securely in Netlify env vars / Blobs)
 *   2. Exchanges it for a fresh access token
 *   3. Saves the new refresh token back (Xero uses rotating tokens)
 *   4. Fetches all required data from Xero: quotes, invoices, P&L, bank transactions
 *   5. Returns structured JSON ready for Claude to merge into data.json
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
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

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
  // Try Netlify Blobs first (updated token from previous runs)
  try {
    const store = getStore('xero-tokens');
    const token = await store.get('refresh_token');
    if (token) return token;
  } catch (e) {
    console.log('Blobs not available yet, falling back to env var:', e.message);
  }
  // Fall back to env var (used on first run or if Blobs unavailable)
  return process.env.XERO_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  try {
    const store = getStore('xero-tokens');
    await store.set('refresh_token', token);
  } catch (e) {
    console.warn('Could not save refresh token to Blobs:', e.message);
    // Non-fatal — token in env var still works for ~60 days if unused
  }
}

async function getAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token available. Re-authenticate via the Hub first.');

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET env vars.');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;

  const result = await httpRequest({
    hostname: 'identity.xero.com',
    path: '/connect/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  const tokens = JSON.parse(result.body);
  if (tokens.error) throw new Error(`Xero auth error: ${tokens.error} — ${tokens.error_description || ''}`);

  // Save the new refresh token (Xero rotates it each use)
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
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json'
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
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
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
    if (page > 10) break; // safety cap (1000 records max)
  }
  return all;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── Authentication ────────────────────────────────────────────────────────
  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret) {
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const provided = auth.replace('Bearer ', '').trim();
    if (provided !== syncSecret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised. Provide the correct SYNC_SECRET.' }) };
    }
  }

  // ── What to fetch (can be filtered via query param ?scope=quotes,invoices) ──
  const params = event.queryStringParameters || {};
  const scope = params.scope ? params.scope.split(',') : ['quotes', 'invoices', 'pnl', 'bank'];

  try {
    const startTime = Date.now();
    const log = [];

    // Get access token
    log.push('Getting Xero access token…');
    const { accessToken } = await getAccessToken();
    const tenantId = await getTenantId(accessToken);
    log.push(`Connected to tenant: ${tenantId}`);

    const result = { synced_at: new Date().toISOString(), tenant_id: tenantId, log };

    // ── Quotes (all pages, with line items) ───────────────────────────────────
    if (scope.includes('quotes')) {
      log.push('Fetching quotes…');
      const quotes = await fetchAllPages('Quotes', 'Quotes', accessToken, tenantId);
      log.push(`  → ${quotes.length} quotes fetched`);
      // Compact structure for data.json (strip heavy fields we don't need)
      result.quotes = quotes.map(q => ({
        number: q.QuoteNumber,
        contact: q.Contact ? q.Contact.Name : '—',
        contact_id: q.Contact ? q.Contact.ContactID : null,
        date: (q.DateString || q.Date || '').slice(0, 10),
        expiry: (q.ExpiryDateString || q.ExpiryDate || '').slice(0, 10),
        status: q.Status,
        total: Math.abs(q.SubTotal || 0),
        total_inc_gst: Math.abs(q.Total || 0),
        line_items: (q.LineItems || [])
          .filter(li => (li.Description || '').trim())
          .map(li => ({
            desc: (li.Description || '').trim(),
            qty: li.Quantity || null,
            unit: Math.abs(li.UnitAmount || 0),
            total: Math.abs(li.LineAmount || 0),
            account: li.AccountCode || null
          }))
      }));
    }

    // ── Invoices (FY26) ───────────────────────────────────────────────────────
    if (scope.includes('invoices')) {
      log.push('Fetching FY26 invoices…');
      const invoices = await fetchAllPages(
        'Invoices?where=Type%3D%3D%22ACCREC%22%26%26Date%3E%3DDateTime(2025%2C7%2C1)&unitdp=2&summaryOnly=false',
        'Invoices', accessToken, tenantId
      );
      log.push(`  → ${invoices.length} invoices fetched`);
      result.invoices = invoices;
    }

    // ── P&L reports ───────────────────────────────────────────────────────────
    if (scope.includes('pnl')) {
      log.push('Fetching P&L reports…');
      const [pnlMay, pnlFY] = await Promise.all([
        xeroGet('Reports/ProfitAndLoss?fromDate=2026-05-01&toDate=2026-05-31', accessToken, tenantId),
        xeroGet('Reports/ProfitAndLoss?fromDate=2025-07-01&toDate=2026-05-31', accessToken, tenantId)
      ]);
      result.pnl_may = pnlMay.Reports ? pnlMay.Reports[0] : pnlMay;
      result.pnl_fy26 = pnlFY.Reports ? pnlFY.Reports[0] : pnlFY;
      log.push('  → P&L reports fetched');
    }

    // ── Bank transactions (FY26 expenses/materials) ───────────────────────────
    if (scope.includes('bank')) {
      log.push('Fetching bank transactions…');
      const bank = await fetchAllPages(
        'BankTransactions?where=Date%3E%3DDateTime(2025%2C7%2C1)&unitdp=2',
        'BankTransactions', accessToken, tenantId
      );
      log.push(`  → ${bank.length} bank transactions fetched`);
      result.bank_transactions = bank;
    }

    result.duration_ms = Date.now() - startTime;
    log.push(`Done in ${result.duration_ms}ms`);

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
