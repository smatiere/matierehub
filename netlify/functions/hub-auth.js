// hub-auth.js — password gate for the Hub's front door.
//
// Why this exists: the HUB (index.html) was reachable by anyone with the
// URL, with zero protection, even though it shows financial data. This adds
// a single shared password check before the page renders anything.
//
// This is a front-door deterrent, not a full auth system: the browser's
// Supabase anon key is already read-only (see hub-write.js), so someone who
// dug into devtools/network requests directly could still reach read data.
// What this closes is the much more likely gap — anyone who just opens the
// URL (a stray link, a search index, a phone left unlocked) landing straight
// on live business data with no prompt at all.
//
// Request:  POST /.netlify/functions/hub-auth   { "password": "…" }
// Response: { "ok": true,  "token": "…", "role": "admin" }   (200)
//        or { "ok": false, "error": "…" }                    (401/400/500)
//
// The client stores `token` in localStorage and never asks again on that
// browser/device — matches "password not required after first time". The
// token is derived from the password itself (one-way hash) so it can't be
// produced without knowing HUB_ADMIN_PASSWORD, but needs no second secret
// env var and never expires.
//
// Roles: only "admin" exists today (full access, matches Seb). member/guest
// roles with restricted access can be added later — see CLAUDE.md.

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let password;
  try {
    ({ password } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Bad request' }) };
  }

  const expected = process.env.HUB_ADMIN_PASSWORD;
  if (!expected) {
    // Fails closed: if the env var isn't set yet, nobody gets in (rather than
    // silently accepting any password).
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Hub password not configured — set HUB_ADMIN_PASSWORD in Netlify env vars' }) };
  }

  if (typeof password !== 'string' || password !== expected) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Wrong password' }) };
  }

  const token = crypto.createHash('sha256').update('matiere-hub-admin:' + expected).digest('hex');

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, token, role: 'admin' })
  };
};
