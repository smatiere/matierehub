const https = require('https');
const querystring = require('querystring');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { action, code, refresh_token } = JSON.parse(event.body || '{}');
    const clientId     = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const redirectUri  = process.env.XERO_REDIRECT_URI;

    if (!clientId || !clientSecret) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET env vars' }) };
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let params;
    if (action === 'exchange') {
      params = querystring.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    } else if (action === 'refresh') {
      params = querystring.stringify({ grant_type: 'refresh_token', refresh_token });
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action: ' + action }) };
    }

    // Step 1: Exchange code / refresh token
    const tokenResult = await makeRequest({
      hostname: 'identity.xero.com',
      path: '/connect/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      }
    }, params);

    const tokenData = JSON.parse(tokenResult.body);
    if (tokenData.error || tokenResult.status >= 400) {
      return { statusCode: tokenResult.status, headers, body: tokenResult.body };
    }

    // Step 2 (exchange only): fetch tenant/org info server-side so browser never calls Xero directly
    if (action === 'exchange') {
      try {
        const tenantResult = await makeRequest({
          hostname: 'api.xero.com',
          path: '/connections',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json'
          }
        }, null);

        const tenants = JSON.parse(tenantResult.body);
        const tenant  = Array.isArray(tenants) && tenants.length > 0 ? tenants[0] : null;

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ...tokenData,
            tenant_id:   tenant ? tenant.tenantId   : null,
            tenant_name: tenant ? tenant.tenantName : null
          })
        };
      } catch (tenantErr) {
        // Return tokens even if tenant fetch fails — caller can handle missing tenant
        return { statusCode: 200, headers, body: JSON.stringify({ ...tokenData, tenant_id: null, tenant_name: null }) };
      }
    }

    // Refresh: just return the new tokens
    return { statusCode: 200, headers, body: JSON.stringify(tokenData) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
