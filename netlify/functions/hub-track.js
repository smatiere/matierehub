// hub-track.js — records which tabs and buttons are used (usage_events table).
// POST { events: [{session, device, standalone, tab, kind, name, ts?}] }. Insert-only,
// password-gated, tiny strings only. Never stores text typed by the user or client names.
const { guardHub } = require('../lib/hub-guard');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const KINDS = ['open', 'view', 'tap'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[^\w.:\- ]/g, '').slice(0, n);

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
    const { events } = JSON.parse(event.body || '{}');
    if (!Array.isArray(events) || !events.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No events' }) };
    const rows = events.slice(0, 50).filter(e => e && KINDS.includes(e.kind)).map(e => {
      const row = {
        session: clean(e.session, 24), device: clean(e.device, 12), standalone: !!e.standalone,
        tab: clean(e.tab, 30), kind: e.kind, name: clean(e.name, 60)
      };
      const t = Date.parse(e.ts);
      if (!isNaN(t) && Math.abs(Date.now() - t) < 864e5) row.ts = new Date(t).toISOString();
      return row;
    });
    if (!rows.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid events' }) };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!res.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: (await res.text()).slice(0, 200) }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, n: rows.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
