// Reads tables that must NOT be open to the browser's public key (they hold client phone/email).
// POST { table } -> { ok, rows }. Password-gated like hub-write; reads with the service key.
const { guardHub } = require('../lib/hub-guard');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const READABLE = { bookings: 'select=*&order=created_at.desc', usage_events: 'select=*&order=ts.desc&limit=20000' };

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
    const { table } = JSON.parse(event.body || '{}');
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
