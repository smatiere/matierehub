# MatiereHub — Architectural Decisions

Why things are built the way they are. Read before suggesting alternatives.

---

## Database: Supabase (supersedes the original `data.json`-on-GitHub decision)

**Original decision (now superseded):** Use a single `data.json` file committed to GitHub as the database, with Netlify functions reading/writing it via the GitHub Contents API.
**Why it was tried:** No backend server, no paid database subscription. Netlify auto-deploys on push so the front-end always gets fresh data on page load.
**Why it was replaced:** Concurrent-write conflicts proved real, not theoretical — see `BUGS.md` "Race condition wipes entries when two saves happen close together" (Claude pushing a stale `data.json` snapshot overwrote live entries). A GitHub-commit-as-database also meant every data change triggered a full site rebuild/redeploy just to update numbers.
**Current decision:** Migrated to **Supabase** (free tier, Postgres + REST API) as the live database. `index.html` and `claude-parse.js` read/write it directly; `xero-sync.js` writes Xero-derived data into the `xero_cache` table. `data.json` is kept locally as a legacy reference only — it is NOT read by the live site. See [[project_supabase_migration]] in memory for migration status, and `supabase_setup.sql` for the schema.
**Trade-off:** Adds an external dependency (Supabase), but it's free at this scale, supports proper concurrent writes, and updates are instant (no rebuild/redeploy needed for data changes — only for code changes to `index.html`).
**Rule going forward:** Never push `data.json` to GitHub as a way of updating live data (see `BUGS.md` and [[feedback_github_push]]). Code files (`index.html`, functions) still get pushed to GitHub to trigger redeploys.

---

## Front-end: single `index.html` file

**Decision:** All HTML, CSS, and JavaScript lives in one file.
**Why:** Seb is not a developer. One file = easy to understand, easy to deploy, easy to ask Claude to edit. No build step, no npm, no bundler.
**Trade-off:** File gets long (~2,000+ lines). Manageable with ctrl+F.

---

## AI parsing: Claude Haiku via Netlify function

**Decision:** Natural language input is parsed by Claude Haiku (not Sonnet) via a Netlify serverless function.
**Why:** Haiku is fast and cheap for structured JSON extraction. The API key lives server-side in Netlify env vars, never exposed in the browser.
**Trade-off:** Haiku can hallucinate on ambiguous input. Mitigated by tight prompt + server-side validation.

---

## Xero: read for financials, write for quotes/invoices

**Decision:** Xero is used in two directions:
1. **Read** — `xero-sync.js` pulls P&L, cash, receivables into `data.json` for the dashboard
2. **Write** — Claude can create DRAFT quotes and invoices directly in Xero by injecting JavaScript into the Hub browser tab via the Chrome extension

**How write-back works:**
- The Hub defines `xeroApiCall(endpoint, method, body)` which proxies all calls through `netlify/functions/xero-api.js`
- Claude runs `xeroApiCall("Quotes", "POST", payload)` or `xeroApiCall("Invoices", "POST", payload)` via `mcp__Claude_in_Chrome__javascript_tool`
- Results land as DRAFT in Xero — Seb reviews and sends from within Xero
- **Always use `TaxType: "OUTPUT"`** (GST on Income, 10%) for all sales line items
- **Always use `AccountCode: "200"`** (Sales) for job income

**Constraints:**
- Hub tab must be open at `https://matierehub2.netlify.app` with green ⚡ Xero button visible
- ContactID must be looked up via `xeroApiCall("Contacts", "GET")` — never guess
- Mark Shippen ContactID: `d79444a2-34cf-40ee-bf53-fc2fed4bad89` (cached — verify before use)

**What failed earlier (don't retry):**
- Direct browser calls to `api.xero.com` — blocked by CORS
- `OUTPUT2` tax type — does not exist in this Xero org
- `payroll.*` and `app.connections` scopes — Xero gates these, causes `access_denied`
- See `reference_xero_connection.md` in memory for full OAuth2 setup history

---

## Xero sync schedule: daily relational sync + weekly dashboard sync

**Decision (2026-06-13, superseded 2026-06-16):** Originally planned as two Claude scheduled tasks. The weekly one never worked — Claude's sandbox proxy blocks outbound calls to `matierehub2.netlify.app` (403 Forbidden), so a Claude-scheduled-task approach for this is a dead end. **Both syncs are now GitHub Actions workflows instead** (GitHub's runners have no such restriction — proven working for the daily workflow since 2026-06-08 and for the weekly one since 2026-06-16):

- **`.github/workflows/xero-sync.yml`** ("Xero Daily Sync") — daily at 21:00 UTC (~7am AEST). Runs `scope=invoice_items`, `scope=contacts`, `scope=bank_transactions` — the three relational tables (`invoice_items`, `contacts`, `bank_transactions`). Fast (~seconds each), keeps payment statuses, new invoices, contact details and the full bank ledger current.
- **`.github/workflows/xero-weekly-sync.yml`** ("Xero Weekly Dashboard Sync") — weekly, Saturday 20:00 UTC = Sunday 6am AEST (cron `0 20 * * 6`; note day-of-week in cron is UTC, so it's specified as Saturday to land Sunday morning in AEST). Runs `scope=quotes,invoices,pnl,bank` — the dashboard-facing `xero_cache` keys (`kpis`, `monthly`, `quotes`, `open_invoices`, `top_customers`, `fy_summary`, `cost_detail_monthly`, BAS/Super/Owner-Drawings liability buckets). This is the scope the daily workflow does NOT cover.

**Why two workflows instead of one:** The dashboard sync's `pnl` scope is slow — one Xero P&L report per calendar month. A full 47-month re-fetch would risk a Netlify function timeout, so the weekly workflow passes `&from=<1 month ago>&to=<this month>` (computed dynamically each run) to refresh only the trailing 2 months; older months stay as already-cached values (merged, never dropped — see `mergeMonthly` in `xero-sync.js`). Running the full dashboard sync daily would also add unnecessary Xero API load for data (quotes pipeline, P&L) that doesn't change that often.

**Both workflows use the same curl/http-code-check bash pattern** and the same `SYNC_SECRET` GitHub Actions secret. See `BUGS.md` → "Fixed (2026-06-16)" for a YAML pitfall to avoid when editing these: `curl -w "\n%{http_code}"` must stay on one line (literal `\n` escape) — an actual embedded newline breaks the `run: |` block scalar.

---

## Supabase upsert: exclude HUB-owned columns from sync payloads

**Decision (2026-06-13):** Any column on a Supabase table that is written by the HUB (claude-parse) and never by the Xero sync must be **omitted entirely from the sync's upsert payload** — not set to a default value.

**Why:** Supabase's `Prefer: resolution=merge-duplicates` translates to `ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col` for every column present in the INSERT payload. Sending `notes: ''` means every sync run silently overwrites whatever the user typed. Omitting `notes` from the payload means the DO UPDATE SET clause never references it — the column retains its current value on conflict, and new rows get the Postgres column default.

**Applied to:** `invoice_items.notes` — excluded from `transformInvoiceItems()` in `xero-sync.js` since 2026-06-13.

**Rule going forward:** whenever a new column is added to a table that is jointly written by both the sync and the HUB, decide at design time which side "owns" it. Sync-owned columns go in the payload; HUB-owned columns are excluded.

---

## No Google Sheets, no Airtable

**Decision:** Not used.
**Why:** Google Sheets Drive connector can only create new files, cannot append rows. Airtable requires a paid subscription. See CLAUDE.md failed approaches for full history.
