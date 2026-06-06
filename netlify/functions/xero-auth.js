/**
 * xero-auth.js — Xero OAuth2 token handler for MatiereHub
 *
 * Handles two actions:
 *   callback — exchanges an authorization code for access + refresh tokens
 *   refresh  — exchanges a refresh token for a new access token
 *
 * In both cases the new refresh token is saved to Netlify Blobs so that
 * xero-sync.js always has a fresh token to work with.
 *
 * Called by getXeroToken() and handleXeroCallback() in index.html.
 *
 * Request body (JSON):
 *   { action: 'callback', code: '...', redirect_uri: '...' }
 *   { action: 'refresh',  refresh_token: '...' }
 */

const https  = require('https');
const { getStore } = require('@netlify/blobs');

const CLIENT_ID     = process.env.XERO_CLIENT_ID;
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;

function httpPost(path, body, authHeader) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname: 'identity.xero.com',
      path,
      method: 'POST',
      headers: {
        'Authorization':  authHeader,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function saveRefreshToken(token) {
  try {
    const store = getStore('xero-tokens');
    await store.set('refresh_token', token);
  } catch (e) {
    console.warn('Could not save refresh token to Blobs:', e.message);
  }
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET env vars' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message, rawBody: (event.body||'').slice(0,100) }) }; }

  if (!payload || typeof payload !== 'object') {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Body must be a JSON object', got: typeof payload }) };
  }

  const { action } = payload;
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const authHeader  = `Basic ${credentials}`;

  try {
    let formBody;

    if (action === 'callback' || action === 'exchange') {
      const { code, redirect_uri } = payload;
      if (!code) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing code' }) };
      // redirect_uri may be omitted in older callers — fall back to registered URI
      const uri = redirect_uri || 'https://matierehub2.netlify.app/xero-callback';
      formBody = { grant_type: 'authorization_code', code, redirect_uri: uri };

    } else if (action === 'refresh') {
      const { refresh_token } = payload;
      if (!refresh_token) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing refresh_token' }) };
      formBody = { grant_type: 'refresh_token', refresh_token };

    } else {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'action must be "callback", "exchange", or "refresh"' }) };
    }

    const result = await httpPost('/connect/token', formBody, authHeader);
    const tokens = JSON.parse(result.body);

    if (tokens.error) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: tokens.error, error_description: tokens.error_description }) };
    }

    // Always save the latest refresh token to Blobs so xero-sync stays in sync
    if (tokens.refresh_token) {
      await saveRefreshToken(tokens.refresh_token);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify(tokens) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
