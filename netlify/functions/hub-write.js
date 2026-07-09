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

// ── Allow-list: { table: [columns the HUB may PATCH (update existing rows)] } ──
const WRITABLE = {
  bank_transactions: ['project', 'notes', 'expense_log_id'],
  expense_log:       ['project', 'category', 'description', 'notes'],
  // Feature 3 — hand-link an invoice line item to a project (HUB-only column).
  invoice_items:     ['project'],
  // 2026-06-30 batch — hand-link a quote line item to a project (mirrors invoice_items).
  quote_items:       ['project'],
  // Feature 3 — manual revenue + light project edits from the Projects tab.
  // 2026-07-09 — scope_of_work added (see supabase_scope_of_work.sql); status is
  // also written automatically by autoUpdatePaidProjects() (index.html) when every
  // hand-linked invoice on a project comes back PAID from Xero.
  projects:          ['manual_revenue', 'manual_revenue_note', 'quoted', 'status', 'notes', 'name', 'scope_of_work']
};

// ── Insert allow-list: { table: [columns the HUB may set when CREATING a row] }
// Used for "create a project on the spot" (Feature 1). The row id is generated
// server-side (PR-### sequence) — never accepted from the client.
const CREATABLE = {
  projects: ['name', 'status', 'quoted', 'notes', 'manual_revenue', 'manual_revenue_note']
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

async function sbGet(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${res.status} ${txt}`);
  return txt ? JSON.parse(txt) : [];
}

// Generate the next PR-### project id by scanning existing ids.
async function nextProjectId() {
  const rows = await sbGet('projects', '?select=id');
  const nums = rows
    .map(r => parseInt(String(r.id || '').replace(/^PR-/, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `PR-${String(next).padStart(3, '0')}`;
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
    const { table, id, fields, insert } = JSON.parse(event.body || '{}');

    // ── INSERT path (create a new row, e.g. a project on the spot) ─────────────
    if (insert) {
      if (!table || !CREATABLE[table]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Table not creatable: ${table}` }) };
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields object' }) };
      }
      const allowedCreate = CREATABLE[table];
      const row = {};
      for (const k of Object.keys(fields)) {
        if (allowedCreate.includes(k)) row[k] = fields[k];
      }
      if (table === 'projects') {
        if (!row.name || !String(row.name).trim()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Project name required' }) };
        }
        row.name = String(row.name).trim();
        // Reject duplicate name (case-insensitive) — return the existing row instead.
        const dupe = await sbGet('projects', `?select=*&name=ilike.${encodeURIComponent(row.name)}`);
        if (dupe.length) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, row: dupe[0], existed: true }) };
        }
        row.id     = await nextProjectId();
        row.status = row.status || 'Active';
        if (row.quoted == null) row.quoted = 0;
        if (!row.notes) row.notes = `Created ${new Date().toISOString().slice(0, 10)} via HUB`;
      }
      const created = await sbPost(table, row);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, row: Array.isArray(created) ? created[0] : created }) };
    }

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
