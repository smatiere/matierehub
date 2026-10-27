// hub-guard.js — shared secret check for the functions that read or write business data.
//
// Two ways in:
//  - the Hub web page sends the token it received at login (x-hub-token), the same one hub-auth hands out;
//  - other apps such as the Matiere Voice assistant send HUB_API_KEY (x-hub-key), a separate secret that can be
//    changed without touching the password.
// Fails closed: if neither secret is configured, nothing gets in.
const crypto = require('crypto');

function same(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Returns null when the caller may continue, or a ready-made response to send back.
function guardHub(event, headers) {
  const get = (name) => (event.headers && (event.headers[name] || event.headers[name.toLowerCase()])) || '';
  const password = process.env.HUB_ADMIN_PASSWORD;
  const apiKey = process.env.HUB_API_KEY;
  if (!password && !apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Access secret not configured' }) };
  }
  const token = password ? crypto.createHash('sha256').update('matiere-hub-admin:' + password).digest('hex') : '';
  if ((token && same(get('x-hub-token'), token)) || (apiKey && same(get('x-hub-key'), apiKey))) return null;
  return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
}

module.exports = { guardHub };
