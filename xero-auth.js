// netlify/functions/xero-auth.js
// Handles Xero OAuth2 token exchange and refresh
// Environment variables required:
//   XERO_CLIENT_ID     — your Xero app client ID
//   XERO_CLIENT_SECRET — your Xero app client secret
//   XERO_REDIRECT_URI  — e.g. https://matierehub.netlify.app/xero-callback

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
    const { action, code, refresh_token } = JSON.parse(event.body || '{}');
    const clientId     = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    const redirectUri  = process.env.XERO_REDIRECT_URI;
    const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    let body;
    if (action === 'exchange') {
      // Exchange auth code for tokens
      body = new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri
      });
    } else if (action === 'refresh') {
      // Refresh access token
      body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token
      });
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
    }

    const res = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body
    });

    const data = await res.json();
    if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data }) };
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}
