const https = require('https');

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
    const { invoice_id, filename, access_token, tenant_id } = JSON.parse(event.body || '{}');
    const path = filename
      ? `/api.xro/2.0/Invoices/${invoice_id}/Attachments/${filename}`
      : `/api.xro/2.0/Invoices/${invoice_id}/Attachments`;

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.xero.com',
        path,
        method: 'GET',
        headers: {
          'Authorization':  `Bearer ${access_token}`,
          'Xero-Tenant-Id': tenant_id,
          'Accept': filename ? '*/*' : 'application/json'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, body: buf, contentType: res.headers['content-type'] || 'application/json' });
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (filename) {
      const base64 = result.body.toString('base64');
      return { statusCode: result.status, headers, body: JSON.stringify({ base64, mimeType: result.contentType, filename }) };
    }
    return { statusCode: result.status, headers, body: result.body.toString() };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
