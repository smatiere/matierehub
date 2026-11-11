// Reads tables that must NOT be open to the browser's public key (they hold client phone/email).
// POST { table } -> { ok, rows }. Password-gated like hub-write; reads with the service key.
const { guardHub } = require('../lib/hub-guard');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const READABLE = { bookings: 'select=*&order=created_at.desc', usage_events: 'select=*&order=ts.desc&limit=20000' };

const BROWSER_TABLES = ['category_list','contacts','expense_log','invoice_items','price_list','projects','quote_items','shopping_lists','timesheets','xero_cache','bank_transactions','bookings'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-hub-key',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  const denied = guardHub(event, headers);
  if (denied) return denied;
  try {
    const { table, query, range } = JSON.parse(event.body || '{}');
    // Browser data loads: any table in BROWSER_TABLES with the page's own query string.
    if (BROWSER_TABLES.includes(table) && typeof query === 'string') {
      const h = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
      if (range) { h['Range'] = String(range); h['Range-Unit'] = 'items'; }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query.replace(/^\?/, '')}`, { headers: h });
      const t = await r.text();
      if (!r.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: t.slice(0, 300) }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rows: JSON.parse(t) }) };
    }
    if (!READABLE[table]) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Table not readable: ' + table }) };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${READABLE[table]}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const txt = await res.text();
    if (!res.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: txt.slice(0, 300) }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rows: JSON.parse(txt) }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
