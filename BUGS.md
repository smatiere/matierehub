# MatiereHub — Known Bugs

Format: **[Status]** Description → Fix applied

---

## Open

*(none currently — both items below were verified fixed and live on 2026-06-08)*

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
