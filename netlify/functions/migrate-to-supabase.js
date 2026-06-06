// migrate-to-supabase.js — ONE-TIME migration helper
// Seeds xero_cache in Supabase from the current data.json in GitHub.
// Call once via: POST /.netlify/functions/migrate-to-supabase
// Protected by SYNC_SECRET env var.

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN;
const GITHUB_REPO         = 'smatiere/matierehub';
const GITHUB_FILE         = 'data.json';

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  // Auth check
  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret) {
    const auth = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (auth !== syncSecret) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  try {
    // 1. Fetch data.json from GitHub
    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'MatiereHub' } }
    );
    if (!ghRes.ok) throw new Error(`GitHub fetch failed: ${ghRes.status}`);
    const ghData = await ghRes.json();
    const data   = JSON.parse(Buffer.from(ghData.content, 'base64').toString('utf-8'));

    // 2. Keys to cache in Supabase xero_cache
    const xeroKeys = ['kpis','monthly','open_invoices','top_customers','quotes','fy_summary','cost_detail_monthly','account_categories'];
    const results  = [];

    for (const key of xeroKeys) {
      if (!data[key]) { results.push({ key, status: 'skipped (not in data.json)' }); continue; }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/xero_cache`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ key, data: data[key], updated_at: new Date().toISOString() })
      });
      results.push({ key, status: res.ok ? 'ok' : `error ${res.status}` });
    }

    // Also seed meta
    const metaRes = await fetch(`${SUPABASE_URL}/rest/v1/xero_cache`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key: 'meta', data: data.meta || {}, updated_at: new Date().toISOString() })
    });
    results.push({ key: 'meta', status: metaRes.ok ? 'ok' : `error ${metaRes.status}` });

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', results }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
