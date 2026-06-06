/**
 * xero-api.js — Xero API proxy for MatiereHub
 *
 * The browser cannot call api.xero.com directly (CORS). This function
 * acts as a transparent proxy: it receives the access token + request
 * details from the browser, forwards the call to Xero, and returns the
 * response.
 *
 * Called by xeroApiCall() in index.html.
 *
 * Request body (JSON):
 *   {
 *     endpoint:     string   — Xero API path, e.g. "Invoices?page=1"
 *     method:       string   — "GET" | "POST" | "PUT" | "DELETE"
 *     body:         object   — request body for POST/PUT (optional)
 *     access_token: string   — short-lived Xero access token from browser localStorage
 *     tenant_id:    string   — Xero organisation tenant ID
 *   }
 *
 * No secrets stored here — the access token is managed entirely in the
 * browser via the Xero OAuth2 PKCE flow (xeroConnect / getXeroToken).
 */

const https = require('https');

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { endpoint, method = 'GET', body: requestBody, access_token, tenant_id } = payload;

  if (!endpoint) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing endpoint' }) };
  if (!access_token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Missing access_token' }) };
  if (!tenant_id) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing tenant_id' }) };

  // Route: /connections uses a different base path
  const isConnections = endpoint === 'connections';
  const path = isConnections ? '/connections' : `/api.xro/2.0/${endpoint}`;

  const bodyStr = requestBody ? JSON.stringify(requestBody) : null;

  const reqHeaders = {
    'Authorization': `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Tenant ID not needed for /connections
  if (!isConnections) {
    reqHeaders['Xero-Tenant-Id'] = tenant_id;
  }

  if (bodyStr) {
    reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  try {
    const result = await httpRequest(
      { hostname: 'api.xero.com', path, method, headers: reqHeaders },
      bodyStr
    );

    // Pass through Xero's status code and body verbatim
    return {
      statusCode: result.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: result.body
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: cors,
      body: JSON.stringify({ error: `Upstream request failed: ${err.message}` })
    };
  }
};
