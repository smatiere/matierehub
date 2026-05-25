const https = require('https');

exports.handler = async function(event) {
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
    if (!endpoint)     return { statusCode: 400, headers, body: JSON.stringify({ error: 'No endpoint' }) };

    const postData = body ? JSON.stringify(body) : null;

    const result = await new Promise((resolve, reject) => {
      const reqHeaders = {
        'Authorization':  `Bearer ${access_token}`,
        'Xero-Tenant-Id': tenant_id,
        'Accept':         'application/json'
      };
      if (postData) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request({
        hostname: 'api.xero.com',
        path: `/api.xro/2.0/${endpoint}`,
        method,
        headers: reqHeaders
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });

    return { statusCode: result.status, headers, body: result.body };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
