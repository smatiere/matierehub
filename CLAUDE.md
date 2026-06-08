# MatiereHub — Claude Context File

Read this at the start of every session before making any changes.

---

## What this is

A single-page business operating system for **Matiere Pty Ltd**, a carpentry and handyman business on the Northern Beaches of Sydney, owned by Sebastien Benoit.

- Live URL: **https://matierehub2.netlify.app**
- GitHub repo: **smatiere/matierehub** (branch: `main`)
- Netlify auto-deploys on every push to `main`
- Claude chat is the primary interface for all data entry

---

## File map

| File | Purpose |
|------|---------|
| `index.html` | The entire front-end — all tabs, charts, CSS, JS in one file. Reads/writes Supabase directly via `SB_URL` |
| `data.json` | **Legacy** — the original database file. Superseded by Supabase (see below); no longer the live data source. Kept locally for reference/migration history only |
| `supabase_setup.sql` | One-time setup script that created the Supabase tables and migrated the original `data.json` rows in |
| `netlify/functions/claude-parse.js` | Parses natural language input via Claude Haiku API, writes updates directly to **Supabase** (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`) — no longer touches `data.json` or GitHub |
| `netlify/functions/xero-sync.js` | Syncs financial data from Xero into the Supabase `xero_cache` table (was: `data.json`) |
| `XERO_NOTES.md` | Xero connection playbook — OAuth flow, token-rotation race fix, P&L date-range rules, all failed approaches. Read before touching anything Xero-related |
| `netlify.toml` | Netlify build config |
| `BUGS.md` | Known issues tracker — check before suggesting fixes |
| `DECISIONS.md` | Architectural decisions log — check before suggesting alternatives |

---

## Database: Supabase (supersedes the old `data.json`/GitHub approach)

As of June 2026 the live database is **Supabase** (project URL `https://nwpzjqblhywclqharggu.supabase.co`), not `data.json`. `index.html` and `claude-parse.js` read/write it directly over the REST API. See [[project_supabase_migration]] in memory for migration status and remaining checklist items.

**Tables** (defined in `supabase_setup.sql`):

```
timesheets   { id, date, project, hours, rate, value, employee, notes, created_at }
expense_log  { id, date, supplier, description, category, project, qty, unit_price, amount, created_at }
projects     { id, name, status, quoted, notes, created_at }
xero_cache   { key, data (JSONB), updated_at }
             ← key is one of: kpis, monthly, open_invoices, top_customers,
               quotes, fy_summary, cost_detail_monthly, account_categories, meta
```

`xero_cache` stores Xero-synced financial data as JSON blobs (written by `xero-sync.js`), mirroring the old `data.json` top-level keys of the same names. `timesheets`, `expense_log`, and `projects` are proper relational tables that Claude reads/writes via `claude-parse.js`.

**Important:** `expense_log` only contains entries logged via Claude chat. It does NOT contain the 1,046 Xero transactions — those feed `xero_cache.monthly` and `xero_cache.cost_detail_monthly` via `xero-sync.js`.

**`days_old`** on open invoices is computed dynamically in the browser from the `date` field at render time — never trust a stored value.

---

## Active projects (as of June 2026)

- Mark - Nth Balgowlah
- Rob - Balgowlah
- IBK - Mosman
- Neil - Balgowlah
- Admin (non-billable)

Seb's hourly rate: **$100/hr ex GST**

---

## How data entry works

1. User types or speaks into the Claude bar at the bottom of `index.html`
2. `claudeBarSend()` POSTs text to `/.netlify/functions/claude-parse`
3. The function calls **Claude Haiku** to parse the natural language into a JSON action
4. The function writes the result directly to **Supabase** (`timesheets`/`expense_log`/`projects` tables) via the Supabase REST API — it no longer touches `data.json` or GitHub
5. The front-end does an optimistic in-memory update (no re-fetch needed)

**Note:** pushing `data.json` to GitHub is NOT part of this flow and should not be done as a substitute — see `BUGS.md` "Race condition wipes entries" for why writing `data.json` directly is unsafe, and [[feedback_github_push]] in memory for the corrected push process (code files only, never `data.json`).

---

## Environment variables (set in Netlify dashboard)

- `ANTHROPIC_API_KEY` — Claude API key (used by `claude-parse.js` to call Haiku)
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — live database connection (used by `claude-parse.js` and `xero-sync.js`)
- `SYNC_SECRET` — bearer-token password Claude sends to authenticate `xero-sync` runs
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` / `XERO_REFRESH_TOKEN` — Xero OAuth (see `XERO_NOTES.md` / [[reference_xero_connection]]). The redirect URI is hardcoded in `index.html` and `xero-auth.js` (`https://matierehub2.netlify.app/xero-callback`) — there is no `XERO_REDIRECT_URI` env var

**Note:** `GITHUB_TOKEN` and `XERO_REDIRECT_URI` were removed from Netlify on 2026-06-08 as genuinely unused — the only function that read `GITHUB_TOKEN` (`migrate-to-supabase.js`, a one-off helper whose job was already done) has also been deleted. **Claude pushing code changes to GitHub does NOT use any Netlify env var** — it uses a personal-access token Claude holds in memory ([[reference_github_token]]) and calls the GitHub Contents API directly from its own sandbox.

**`NETLIFY_SITE_ID` and `NETLIFY_BLOBS_TOKEN` are NOT unused — never remove them.** They were *mistakenly* deleted alongside `GITHUB_TOKEN` on 2026-06-08 based on an incorrect "unused" call (see BUGS.md → "Removing NETLIFY_SITE_ID/NETLIFY_BLOBS_TOKEN broke Xero token propagation" for the full incident writeup and a lesson-learned note on verifying "unused" claims by grepping the codebase before deleting any config). They are actively read by `netlify/functions/xero-auth.js` (`saveRefreshToken()`, ~line 76) to persist rotated Xero refresh tokens into the shared Netlify Blobs store `xero-tokens` — the same store `xero-sync.js` reads from on every sync run. Without them, `xero-auth.js` silently fails to save the freshly-issued token (the failure is swallowed by a try/catch and only logs a console warning), so `xero-sync.js` keeps reading a stale/already-consumed token and every sync fails with `invalid_grant: Refresh token has been consumed` — no matter how many times Seb reconnects Xero from the UI.
- `NETLIFY_SITE_ID` = `c5358d04-2f41-4b7f-bcef-f132c44476d7` (the Netlify "Project ID" — visible at Project configuration → General → Project details; not a secret, safe to record here)
- `NETLIFY_BLOBS_TOKEN` = a Netlify **Personal Access Token** (a secret credential, only shown once at creation). If its value can't be recovered, Seb needs to regenerate one himself from his Netlify account (User settings → Applications → Personal access tokens) and add it to the env vars — this is account-credential territory Claude should not touch.

---

## What has been tried and FAILED — do not retry

- **Google Sheets row-level writing** via Drive connector — connector can only create new files, cannot append rows
- **Google Apps Script web endpoints** — robots.txt blocks Claude from fetching script.google.com
- **Airtable** — not pursued, no paid subscriptions
- **Early Xero OAuth attempts** — failed due to CORS (direct browser calls to api.xero.com), wrong scopes (`OUTPUT2`, `payroll.*`), and missing `node_bundler = "esbuild"` in netlify.toml. All fixed — Xero write-back now works. See DECISIONS.md.

---

## Key constraints

- No paid subscriptions beyond existing Claude Pro
- Seb is not a developer — keep everything simple and explainable
- Accountant has separate Xero access — do not disrupt that
- All solutions must be maintainable without a developer on call
- One HTML file for the front-end — do not split into separate CSS/JS files
