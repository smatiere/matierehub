// netlify/functions/xero-attachment.js
// Pulls receipt/bill attachment files from Xero and returns as base64
// so they can be displayed or parsed in the chat interface

export async function handler(event) {
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

    // First get list of attachments if no filename specified
    if (!filename) {
      const listRes = await fetch(
        `https://api.xero.com/api.xro/2.0/Invoices/${invoice_id}/Attachments`,
        {
          headers: {
            'Authorization':  `Bearer ${access_token}`,
            'Xero-Tenant-Id': tenant_id,
            'Accept':         'application/json'
          }
        }
      );
      const list = await listRes.json();
      return { statusCode: 200, headers, body: JSON.stringify(list) };
    }

    // Download the actual file
    const fileRes = await fetch(
      `https://api.xero.com/api.xro/2.0/Invoices/${invoice_id}/Attachments/${filename}`,
      {
        headers: {
          'Authorization':  `Bearer ${access_token}`,
          'Xero-Tenant-Id': tenant_id
        }
      }
    );

    const buffer     = await fileRes.arrayBuffer();
    const base64     = Buffer.from(buffer).toString('base64');
    const mimeType   = fileRes.headers.get('content-type') || 'image/jpeg';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ base64, mimeType, filename })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}
