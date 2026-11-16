// READ-ONLY look at Xero Payroll (Australia) for the accounting agent and super checks.
// GET/POST ?path=PayRuns  (only these paths, nothing is ever written). Auth: Authorization: Bearer <SYNC_SECRET>.
const crypto = require('crypto');
const { getAccessToken, getTenantId } = require('./xero-mcp').xeroServer;
const ALLOWED = /^(PayRuns|Payslip|Employees|SuperFunds|PayrollCalendars|Settings|Timesheets)(\/[0-9a-fA-F-]{36})?(\?[A-Za-z0-9=&_.:%()+-]*)?$/;
function authorised(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const s = process.env.SYNC_SECRET;
  return !!(s && h.startsWith('Bearer ') && h.slice(7).length === s.length && crypto.timingSafeEqual(Buffer.from(h.slice(7)), Buffer.from(s)));
}
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  if (!authorised(event)) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  try {
    const p = (event.queryStringParameters && event.queryStringParameters.path) || '';
    const q = event.rawQuery && event.rawQuery.includes('path=') ? '' : '';
    if (!ALLOWED.test(p)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Path not allowed' }) };
    const token = await getAccessToken(), tenant = await getTenantId(token);
    const r = await fetch(`https://api.xero.com/payroll.xro/1.0/${p}`, { headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenant, Accept: 'application/json' } });
    return { statusCode: r.status, headers, body: await r.text() };
  } catch (e) { return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) }; }
};
