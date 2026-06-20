// hub-write.js — the HUB's single generic write API.
//
// Why this exists: the browser uses the PUBLIC anon key, which is read-only on
// every table. ALL writes go through a server function holding the secret
// service_role key (same model as claude-parse.js). This is the one endpoint
// every direct-from-HUB input path should use (inline edits, buttons, forms,
// and future Xero write-back), so we never scatter write logic or widen the
// public key's access.
//
// Request:  POST /.netlify/functions/hub-write
//   { "table": "bank_transactions", "id": "<row id>", "fields": { "notes": "…" } }
// Response: { "ok": true, "row": { … } }
//
// Security model: anon stays read-only. This function is the gatekeeper — only
// the tables/columns in WRITABLE below can ever be changed, so even though the
// endpoint is public (like claude-parse), the blast radius is a fixed allow-list
// of safe, HUB-only columns. To make a new field editable, add it here (one line)
// and it rides the next deploy — no Supabase admin, no schema/policy changes.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Allow-list: { table: [columns the HUB may write] } ───────────────────────
const WRITABLE = {
  bank_transactions: ['project', 'notes', 'expense_log_id']
};

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars not configured' }) };

  try {
    const { table, id, fields } = JSON.parse(event.body || '{}');

    if (!table || !WRITABLE[table]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Table not writable: ${table}` }) };
    }
    if (id === undefined || id === null || id === '') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing row id' }) };
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields object' }) };
    }

    // Keep only allow-listed columns
    const allowed = WRITABLE[table];
    const clean = {};
    for (const k of Object.keys(fields)) {
      if (allowed.includes(k)) clean[k] = fields[k];
    }
    if (!Object.keys(clean).length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `No writable columns for ${table}. Allowed: ${allowed.join(', ')}` }) };
    }

    const rows = await sbPatch(table, `?id=eq.${encodeURIComponent(id)}`, clean);
    if (!rows.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No row matched that id' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, row: rows[0] }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
