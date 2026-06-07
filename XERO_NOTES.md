# Xero Connection Playbook — MatiereHub

Read this before touching anything Xero-related. It documents every trap we've
already fallen into, so we don't fall into them again.

---

## 1. How the connection works (architecture)

Two separate things use Xero credentials:

1. **`xero-auth.js`** — handles the OAuth dance (authorisation-code exchange and
   refresh-token renewal). Called from the browser by `getXeroToken()` in
   `index.html`. Every time it mints a new token pair, it writes the new
   refresh token to **Netlify Blobs** (`xero-tokens` store, key `refresh_token`).
2. **`xero-sync.js`** — the server-side function that actually pulls P&L,
   invoices, quotes, balance sheet from Xero and writes 9 keys into the
   Supabase `xero_cache` table (this is what the live dashboard reads).
   It gets its access token via `getAccessToken()`, which reads the refresh
   token from **Netlify Blobs** (falling back to the `XERO_REFRESH_TOKEN` env
   var only if Blobs is empty).

**Netlify Blobs is the single source of truth for the refresh token.**
`xero-auth.js` is the only thing that should ever write to it. (See §3 for why
this matters — we broke this rule once and paid for it.)

---

## 2. Reconnecting Xero from scratch

1. Click the green **⚡ Matiere Pty Ltd** button (top right of the Hub) → Disconnect
2. Click **⚡ Connect Xero** → choose **Matiere Pty Ltd** in the Xero org picker
3. `xero-auth.js` (`action: callback`/`exchange`) exchanges the code, looks up
   the tenant, and saves the fresh refresh token to Blobs **and** the browser
   saves it to `localStorage`
4. **Do nothing else for ~10 seconds.** Don't click "Sync Xero", don't reload —
   just let the page settle. (See §3 — every extra refresh is another rotation.)
5. Then trigger one clean server-side sync (§5)

---

## 3. The token-rotation race ("refresh token has been consumed") — RESOLVED

**Symptom:** `xero-sync` fails with `Xero auth error: invalid_grant — Refresh
token has been consumed`, even right after a fresh reconnect.

**Root cause:** Xero refresh tokens are **single-use** — every exchange
(whether for a new access token or explicitly refreshing) invalidates the old
refresh token and issues a new one. We had **two independent writers** to the
same Blobs store:
- `xero-auth.js`, which correctly wrote every newly-rotated token to Blobs
  as part of each browser-side refresh, AND
- a "seed from POST body" feature in `xero-sync.js` that let you pass
  `{ refresh_token: <token from localStorage> }` to "fix" a stale Blobs token.

The seed feature was the bug, not the fix: if the browser had refreshed in the
background since the page loaded, `localStorage` held an **older, already-
consumed** token than what `xero-auth.js` had since written to Blobs. Seeding
overwrote the genuinely-fresh Blobs token with the dead one — guaranteeing
the very error the seed was meant to cure.

**Fix (commit `70a72d2e`):** removed the seed-from-POST-body path entirely.
`xero-sync.js` now *only* reads from Blobs via `getAccessToken()`. Blobs is
written exclusively by `xero-auth.js`, atomically with each real Xero exchange.
No more dual-writer race.

**Lesson:** never pass a client-side (`localStorage`) token into a server-side
function "to be safe." If two systems both think they own the source of truth
for a single-use credential, one of them is wrong by definition.

---

## 4. The P&L monthly-fetch date range rule — RESOLVED

**Symptom:** `Reports/ProfitAndLoss?...&periods=11&timeframe=MONTH` calls for
FY24 and FY25 (more than ~365 days in the past) failed with `"fromDate and
toDate parameters must be with 365 days of each other"`, while the FY26 (most
recent) call succeeded.

**Wrong assumption we started with:** "`fromDate`+`toDate` cannot be combined
with `periods`+`timeframe`" — this is **false**.

**Actual rule, confirmed by live testing:**
> You MUST pass `fromDate` AND `toDate` together with `periods=11&timeframe=MONTH`
> to get a monthly breakdown for a historical financial year.

If you omit `toDate`, Xero validates `fromDate` against an *implicit* "today"
as the end date. For FY26 (within 365 days of today) that implicit range
passes; for FY24/FY25 (>365 days ago) it fails the 365-day cap. Supplying both
dates explicitly keeps each FY span at ~365 days and the check passes.

**Correct call shape** (one per fiscal year, three calls total for a 36-month /
3-year breakdown):
```
Reports/ProfitAndLoss?fromDate=2023-07-01&toDate=2024-06-30&periods=11&timeframe=MONTH   // FY24
Reports/ProfitAndLoss?fromDate=2024-07-01&toDate=2025-06-30&periods=11&timeframe=MONTH   // FY25
Reports/ProfitAndLoss?fromDate=2025-07-01&toDate=2026-06-30&periods=11&timeframe=MONTH   // FY26 (YTD)
```
Fixed in `index.html` (commit `c386e50a`) and `xero-sync.js` (commit `35a13add`).
Verified clean: 36 periods, zero errors (`xero_sync_2026-06-07 (3).json`).

---

## 5. Other Xero API quirks (don't relitigate)

- **`periods` caps at 11`, never 12.** Asking for 12 throws an error — Xero
  counts the "from" period separately, so 11 extra periods = 12 months of data.
- **Period headers come back as `"30 Jun 26"` (DD Mon YY)**, not `"Jun 2025"`.
  `parseMonthLabel()` in both `index.html` and `xero-sync.js` handles both
  formats — don't "fix" it back to assuming one format.
- **`api.xero.com` has no CORS headers.** All Xero API calls (including
  `/connections` tenant lookups) must go through a server-side function —
  never call `api.xero.com` directly from the browser.

---

## 6. Manually triggering a server-side sync (refreshes the live dashboard)

From the Hub's browser console (after step 4 of §2, or any time you need a
fresh pull):
```javascript
fetch('/.netlify/functions/xero-sync', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer matiere2026', 'Content-Type': 'application/json' }
  // NOTE: do NOT pass a refresh_token in the body — see §3. Blobs handles it.
}).then(r => r.text()).then(d => console.log(d))
```
Expect: `"Wrote 9 keys to Supabase xero_cache"` with **36 monthly periods**
(FY24+FY25+FY26) and non-zero `wages_owner` values.

`SYNC_SECRET` is `matiere2026` (set in Netlify env vars).

---

## 7. Failed approaches — do not retry

- **Direct browser calls to `api.xero.com`** — blocked by CORS
- **Wrong OAuth scopes** (`OUTPUT2`, `payroll.*`) — caused auth failures;
  correct scope list is documented in the `xero_connection` reference memory
- **Missing `node_bundler = "esbuild"` in `netlify.toml`** — broke the
  Netlify function build for the OAuth bridge
- **Passing a client-side refresh token into the server sync "to seed Blobs"**
  — see §3, this *causes* the consumed-token error, doesn't fix it
- **Omitting `toDate` from historical P&L monthly calls** — see §4

---

*Last updated: 2026-06-07. If you hit a NEW Xero error, add it here before
fixing it blind — chances are good it's a variant of something above.*
