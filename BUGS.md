# MatiereHub — Known Bugs

Format: **[Status]** Description → Fix applied

---

## Open

**[OPEN]** Removing `NETLIFY_SITE_ID`/`NETLIFY_BLOBS_TOKEN` broke Xero token propagation → "Refresh token has been consumed" on every sync, no matter how many times Xero is reconnected
- **Reported by Seb:** Cash & Invoices and Profitability tabs went blank/zeroed; a fresh Xero sync was attempted to repair the cache but kept failing with `invalid_grant: Refresh token has been consumed` — even immediately after Seb reconnected Xero (first on the Mac, then again on his iPhone).
- **Confirmed root cause:** On 2026-06-08, `CLAUDE.md` was updated to say `GITHUB_TOKEN`, `NETLIFY_BLOBS_TOKEN`, `NETLIFY_SITE_ID` and `XERO_REDIRECT_URI` were "removed from Netlify as unused," and the first three were deleted from the Netlify env vars. **`NETLIFY_SITE_ID`/`NETLIFY_BLOBS_TOKEN` were not actually unused.** `netlify/functions/xero-auth.js` (`saveRefreshToken()`, ~line 76) explicitly needs them:
  ```js
  // getStore('xero-tokens') cannot auto-detect its context in this deploy — it throws
  // "environment has not been configured to use Netlify Blobs". Pass siteID/token
  // explicitly (NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN — a Netlify Personal Access
  // Token) so this lands in the SAME store xero-sync.js reads from.
  const store = getStore({ name: 'xero-tokens', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
  ```
  Without these two vars, every time the OAuth flow issues a fresh Xero token pair, the browser successfully stores it in that device's `localStorage` — but the server-side save to the shared Netlify Blobs store (`xero-tokens`, the store `xero-sync.js` reads from) silently fails. The failure is swallowed by a `try { } catch (e) { console.warn(...) }`, so nothing visibly errors; `xero-sync.js` simply keeps reading the old, already-rotated-away token from Blobs and every sync attempt fails with "Refresh token has been consumed," regardless of how many times Seb reconnects (the fresh token never leaves whichever device/browser did the reconnecting).
- **Diagnostic trail that confirmed it:** checked the refresh-token value and expiry timestamp stored in the Mac/Chrome browser's `localStorage` before and after a hard reload — both identical (`expiry = 2026-06-08T01:25:53Z`, hours stale), proving the dashboard the sync runs from was still holding the dead pre-reconnect token even after Seb reconnected on his iPhone (whose fresh token landed only in *that* device's localStorage, never reaching the shared Blobs store).
- **Fix:** restore `NETLIFY_SITE_ID` (`c5358d04-2f41-4b7f-bcef-f132c44476d7` — the Netlify Project ID, not a secret) and `NETLIFY_BLOBS_TOKEN` (a Netlify Personal Access Token — a secret; Seb needs to regenerate it from his Netlify account if the original value is lost, since PATs are shown only once) to the Netlify env vars. Once both are present again, reconnecting Xero from any device will correctly propagate the fresh token to the shared store and `xero-sync.js` will pick it up on the next run.
- **Lesson learned — verify "unused" before deleting config:** a prior pass flagged `NETLIFY_SITE_ID`/`NETLIFY_BLOBS_TOKEN` as unused and recommended removing them, based on stale/incomplete documentation rather than checking the live code. **Before removing any env var, secret, or config value flagged as "unused," grep the actual codebase (`netlify/functions/*.js` and `index.html`) for every reference to its name** — `process.env.<NAME>` calls can be buried in helper functions (here, inside `saveRefreshToken()`, several layers from the obvious entry points) and easily missed by documentation review alone. A wrong "unused" call here didn't throw a build error or a loud runtime exception — it failed silently behind a `try/catch`, which is exactly the kind of mistake that ages into a confusing, hard-to-trace outage days later.

---

## Fixed (2026-06-17)

**[FIXED]** GitHub Actions `schedule` trigger unreliable for both Xero sync workflows — cron fires inconsistently, sometimes not at all
- **Root cause identified:** Both `xero-sync.yml` (`cron: "0 21 * * *"`) and `xero-weekly-sync.yml` (`cron: "0 20 * * 6"`) were scheduled exactly on the hour. GitHub's own docs warn that the `schedule` event is delayed or dropped most often "during periods of high load... at the start of every hour," and recommend scheduling jobs at an off-the-hour minute to reduce that risk. Both workflows were squarely in the highest-congestion slot — every other GitHub Actions cron in the world competing for the same `:00` tick.
- **Evidence this was the mechanism, not a config error:** the cron value itself was correct and unchanged since creation; repo/Actions weren't disabled; the two confirmed historical `schedule` runs landed nowhere near `21:00 UTC` and were ~31.5h apart instead of ~24h — consistent with GitHub silently delaying/dropping `:00`-aligned runs rather than a broken trigger.
- **Fix (commits `9ef0721`/`fcb1d82`, 2026-06-17):**
  1. Moved both crons off the top of the hour: daily primary `7 21 * * *` (~7:07am AEST), weekly primary `13 20 * * 6` (~6:13am AEST Sunday).
  2. Added a second, independent backup trigger ~45 min after each primary: daily backup `52 21 * * *`, weekly backup `58 20 * * 6`. Both syncs are upsert-based and safe to run twice (see `invoice_items`/`contacts`/`bank_transactions` sync details in `CLAUDE.md`) — a normal day now gets two independent shots at firing instead of one, and even if GitHub drops one, the other almost certainly isn't dropped by the same load spike.
- **Verified:** both workflow files re-fetched from GitHub post-push — `state: active`, schedule blocks match exactly what was pushed. Job steps themselves were untouched (already verified working via manual `workflow_dispatch` on 2026-06-16), so no fresh dispatch test was needed.
- **Not eliminated, just made much less likely:** GitHub does not give a 100%-guaranteed schedule SLA even off-hour. If a daily/weekly run is ever missed despite this, the next escalation step (not yet built, no need unless this recurs) would be an external trigger path independent of GitHub's own scheduler — e.g. a free cron-ping service hitting the GitHub Actions dispatch API, or a Claude scheduled task doing the same. Flagging as a future option only; not needed today.

## Fixed (2026-06-16)

**[FIXED]** `xero-sync.yml` GitHub Actions workflow failing with "Invalid workflow file... error in your yaml syntax on line 15" — 4 failure emails from GitHub
- **Problem:** Each of the 3 `run: |` blocks used `curl -s -w "\n%{http_code}" ...`, but the `\n` had been written as an actual embedded newline inside the quoted string rather than the two-character escape `\n`. The continuation line (`%{http_code}" -X POST ...`) had zero indentation, which is less than the block scalar's content indentation — YAML treats that as the block scalar ending early, so the next line is parsed as a new (invalid) node at the mapping level.
- **Fix (commit `164adbd`, 2026-06-16):** Rewrote all 3 curl commands as single lines using the literal two-character `\n` escape inside the `-w` flag (`curl -s -w "\n%{http_code}" ...`), which is the standard idiom — curl itself interprets `\n`/`\r` in `-w` format strings, so this doesn't need an actual newline.
- **Verified:** Validated locally with `yaml.safe_load`, pushed to `main`, confirmed workflow registration state is `active`, triggered a `workflow_dispatch` run — all 3 steps (invoice_items, contacts, bank_transactions) completed successfully.
- **Doc correction:** The workflow file is `.github/workflows/xero-sync.yml`, not `xero-daily-sync.yml`/`xero-weekly-sync.yml` as `CLAUDE.md` previously stated — and it already syncs all three scopes (invoice_items, contacts, bank_transactions) daily at 21:00 UTC, not just invoice_items. `CLAUDE.md` updated to match.

---

## Fixed (2026-06-07)

**[FIXED]** Revenue, costs, gross profit, opex and net profit were inflated ~9-10x across the board (monthly chart AND FY26 KPIs)
- **Reported by Seb:** "the revenue showing are widely wrong, March 24 $165k is way too high, the truth should be around $10k to $15k" / "the costs are also widely inflated"
- **Confirmed root cause:** `xero-sync.js` fetched Xero's monthly P&L via `Reports/ProfitAndLoss?periods=11&timeframe=MONTH`, which returns **trailing-twelve-month (TTM) rolling totals**, not discrete calendar months. `fyTotals()` then summed twelve already-inflated TTM columns, producing `fy26_revenue = $1,797,723.71` against a true annual figure in the ~$130-200k range.
- **Fix (commit `33fa00a`, 2026-06-07):** Added `fetchDiscreteMonthlyPnL()`, which fetches one bounded `fromDate`/`toDate` Xero P&L report per calendar month instead of the rolling-window comparison report. FY totals now come from single-period `p24`/`p25`/`p26` fetches via `fyTotals()` rather than summing monthly columns.
- **Verified live in Supabase `xero_cache` (synced 2026-06-07T12:55:42Z):**
  - `kpis.fy26_revenue = $159,228.78` (in line with FY24 $144,649.30 and FY25 $129,586.23 — no longer ~10x inflated)
  - `kpis.fy26_gross_profit = $104,123.47`, `fy26_opex = $20,778.79`, `fy26_net_profit = $83,344.68`
  - `monthly.revenue` now holds discrete single-month figures (e.g. `[0, 1540, 9409.77, 16820.11, ...]`) instead of ~12-month rolling totals
- **Scope:** Business Health, Pipeline, Profitability, Financials and P&L tabs all now read correct figures.

**[FIXED]** `kpis.fy26_owner_drawings` was `0` in Supabase `xero_cache`
- **Where it shows:** Overview tab "Owner Drawings" card and P&L tab "Owner Drawings" card.
- **Root cause (confirmed):** `xero-sync.js` looked up `'Loan - Sebastien Matiere'` / `'Wages Payable'` inside `p26.sectionMap` (parsed from a **Profit & Loss** report). Both accounts are Balance Sheet LIABILITY accounts (codes 896, 804) and structurally never appear in a P&L — `findAccount()` always returned `null`/0.
- **Fix (commit `33fa00a`, 2026-06-07):** `ownerDrawings26` is now sourced from FY26 bank SPEND transactions matched against `DRAWING_ACCOUNT_CODES = ['896', '804']` — actual cash paid to Seb, not a P&L lookup.
- **Verified live in Supabase `xero_cache` (synced 2026-06-07T12:55:42Z):** `kpis.fy26_owner_drawings = $59,421.70` — consistent with the ~$64,421.70 figure from the old `data.json` snapshot and the bank-transaction evidence ($190,676.82 in "Salary"/"Loan"/"Wages" payments to Sebastien Matiere across all years).

---

## Fixed (2026-06-05)

**[FIXED]** Time Distribution treemap showed false "Not logged" hours for today
- **Problem:** The treemap's available-hours loop ran `d <= to` where `to = today`. This added 8h to `avail` for today (an in-progress day), while today's partial hours were subtracted from it, surfacing a "Not logged Xh" block even though the KPI tile correctly showed 0 missing days.
- **Root cause:** The KPI tile loop uses `d < today` (excludes today). The treemap loop used `d <= to` (included today). Inconsistent boundary.
- **Fix:** Added `&& ds(d) < todayStr` to the treemap's avail loop so today is excluded from available hours — matching the KPI tile's logic that an in-progress day is not a gap.

---

## Fixed (2026-06-04)

**[FIXED]** Timesheet ID collision after delete
- **Problem:** New IDs were generated as `TS-${timesheets.length + 1}`. After any delete, the count drops and the next entry gets a duplicate ID. Breaks delete/edit targeting.
- **Fix:** Changed `claude-parse.js` to scan all existing IDs and use `max + 1` instead of `length + 1`.

**[FIXED]** Stale `days_old` on open invoices
- **Problem:** `days_old` values in `data.json` were calculated at Xero import time and never updated. Every day they get more wrong.
- **Fix:** `days_old` is now computed dynamically in the browser from the `date` field at render time.

**[FIXED]** Haiku creates new project instead of matching existing one (fuzzy name input)
- **Problem 1:** Prompt examples hardcoded the old project name "Mark - Nth Balgowlah". Haiku follows examples literally, so it kept outputting the old name even after the canonical name was updated to "Mark Shippen – Nth Balgowlah".
- **Problem 2:** Server-side validation was exact-match only. When Haiku returned a close-but-wrong name, instead of consolidating to the canonical project, it either rejected as "unclear" or (if `new_project` flag was set) created a duplicate project.
- **Fix 1:** Prompt examples are now built dynamically from the live project list, so they always reflect the current canonical names.
- **Fix 2:** Server now runs fuzzy token-overlap scoring when exact match fails. If the returned name shares ≥50% tokens with a real project, it auto-consolidates. Only rejects as "unclear" if no good match found.
- **Rule:** `new_project:true` is only set by Haiku when the user explicitly types the words "new project". Fuzzy inputs never create new projects.

**[FIXED]** Race condition wipes entries when two saves happen close together
- **Problem:** The Netlify function fetches `data.json`, spends ~3s calling Claude API, then pushes back. If another entry was saved during those 3 seconds, the push overwrites it. Retry logic existed but checked for HTTP 409 — GitHub actually returns 422 for stale SHA conflicts, so the retry never fired.
- **Fix:** Changed the retry condition to catch both 409 and 422. On conflict, the function now re-fetches the latest data, re-applies the new entry on top, and retries up to 3 times.
- **Note:** Claude also contributed to this by pushing `data.json` directly with a stale snapshot. Claude should never push `data.json` directly — only the Netlify function should write it.

**[FIXED]** No server-side project validation
- **Problem:** Claude Haiku could hallucinate a project name that doesn't exist in the project list. The fabricated project would be silently written to `data.json`.
- **Fix:** `claude-parse.js` now validates the returned project name against `current.projects` and returns `unclear` if not matched.

---

## Known limitations (not bugs, by design)

- `expense_log` only stores chat-logged expenses, not the full Xero transaction history
- The live database is now **Supabase** (`timesheets`, `expense_log`, `projects` tables + `xero_cache` JSON blobs) — `data.json` is a legacy local file, no longer read by the site or written by `claude-parse.js`/`xero-sync.js`. See `CLAUDE.md` and `DECISIONS.md` for the migration record
- Quotes data (280 records) is read-only from Xero; cannot be updated via chat — but Claude *can* create new DRAFT quotes/invoices directly in Xero (see `reference_xero_quote_invoice_creation` in memory and `DECISIONS.md` → "Xero: read for financials, write for quotes/invoices")
