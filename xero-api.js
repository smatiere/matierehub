// netlify/functions/xero-api.js
// Proxies all Xero API calls — reads bills, contacts, invoices, quotes
// and WRITES bills, contacts, invoices, quotes, attaches receipts
// Environment variables required:
//   XERO_CLIENT_ID
//   XERO_CLIENT_SECRET

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { endpoint, method = 'GET', body, access_token, tenant_id } = JSON.parse(event.body || '{}');

    if (!access_token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No access token' }) };
    if (!endpoint)     return { statusCode: 400, headers, body: JSON.stringify({ error: 'No endpoint specified' }) };

    const xeroRes = await fetch(`https://api.xero.com/api.xro/2.0/${endpoint}`, {
      method,
      headers: {
        'Authorization':  `Bearer ${access_token}`,
        'Xero-Tenant-Id': tenant_id,
        'Content-Type':   'application/json',
        'Accept':         'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const data = await xeroRes.json();
    return { statusCode: xeroRes.status, headers, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}
