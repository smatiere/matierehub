const https = require('https');
const querystring = require('querystring');

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
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables XERO_CLIENT_ID or XERO_CLIENT_SECRET' }) };
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

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'identity.xero.com',
        path: '/connect/token',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(params);
      req.end();
    });

    return { statusCode: result.status, headers, body: result.body };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
