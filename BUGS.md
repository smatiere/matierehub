# MatiereHub — Known Bugs

Format: **[Status]** Description → Fix applied

---

## Open

**[OPEN — CRITICAL]** Revenue, costs, gross profit, opex and net profit are inflated ~9-10x across the board (monthly chart AND FY26 KPIs)
- **Reported by Seb:** "the revenue showing are widely wrong, March 24 $165k is way too high, the truth should be around $10k to $15k" / "the costs are also widely inflated"
- **Confirmed root cause:** `xero-sync.js` fetches Xero's monthly P&L via `Reports/ProfitAndLoss?periods=11&timeframe=MONTH`. The code (and its comments) assume each returned column is a **discrete single calendar month**. They are not — they are **trailing-twelve-month (TTM) rolling totals**. Proof: the value in the monthly array for the LAST month of each fiscal year exactly equals that year's annual total —
  - `monthly.revenue[11]` (Jun '24) = `144,649.30` = `fy_summary.fy24.revenue` exactly
  - `monthly.revenue[23]` (Jun '25) = `129,586.23` = `fy_summary.fy25.revenue` exactly
  - Same pattern holds for `monthly.materials` (cost of sales)
  This can only happen if each "month" column is actually "12 months ending at that date" — a TTM window that, when it lands on a fiscal year-end, exactly spans that whole FY.
- **Two compounding effects:**
  1. **Monthly chart is mislabeled:** every point on the Revenue/Costs charts shows a ~12-month rolling total (~$120-167k) instead of that single month's figure (~$10-15k) — roughly a 10x inflation per "month".
  2. **FY26 annual KPIs are double-compounded:** `kpis.fy26_revenue` / `fy26_materials` / `fy26_gross_profit` / `fy26_opex` / `fy26_net_profit` and `fy_summary.fy26` are computed by SUMMING all 12 of these already-inflated TTM columns (`fyTotals()` → `sumVals(sectionTotals(...))`, line ~404 of `xero-sync.js`). Summing twelve ~12-month rolling totals produces a number ~9-10x the true annual figure: `fy26_revenue` shows **$1,797,723.71** when the true FY26 annual revenue is almost certainly in the same ~$130-200k range as FY24 ($144,649) and FY25 ($129,586). (FY24/FY25 totals in `fy_summary` are correct because they come from separate single-period report fetches — `p24`/`p25` — not the monthly breakdown.)
- **Fix needed:** Re-fetch Xero monthly P&L using calendar-month boundaries (explicit `fromDate`/`toDate` per month, or whatever Xero parameter combination yields discrete non-overlapping months — NOT the `periods`+`timeframe=MONTH` comparison-report mechanism, which returns rolling/comparison windows). Then `fyTotals()` for FY26 should either sum genuinely-discrete monthly columns, or better, use a single-period FY26-to-date fetch (matching the `p24`/`p25` approach) rather than summing monthly columns at all.
- **Scope:** affects Business Health, Pipeline, Profitability, Financials and P&L tabs — essentially every revenue/cost figure derived from the monthly P&L breakdown. Figures NOT affected (verified independently sourced and structurally sound): open invoices/outstanding/overdue ($9,718.07), pipeline total, top customers, cash balance — these come directly from invoice/quote records, not the broken P&L parsing.

**[OPEN]** `kpis.fy26_owner_drawings` is `0` in Supabase `xero_cache`
- **Where it shows:** Overview tab "Owner Drawings" card and P&L tab "Owner Drawings" card both correctly read `D.kpis.fy26_owner_drawings` — but the value stored in Supabase is `0`, while an older local snapshot of `data.json` had `64421.70`.
- **Root cause (confirmed):** `xero-sync.js` (lines 458-460, 503) looks up `'Loan - Sebastien Matiere'` and `'Wages Payable'` inside `p26.sectionMap`, which is parsed from a **Profit & Loss** report. Both accounts are confirmed **Balance Sheet LIABILITY accounts** (Chart of Accounts: codes 896 and 804, class `LIABILITY`) — they structurally never appear in a P&L report, so `findAccount()` always returns `null`/0.
- **Supporting evidence:** raw Xero bank-transaction export shows 99 transactions tagged "Salary"/"Loan"/"Wages" paid to Sebastien Matiere totalling $190,676.82 across all years — drawings are real and substantial, just not retrievable from the P&L.
- **Fix needed:** Source owner drawings from the Balance Sheet report (already fetched as `result.balance_sheet` for `cashBal`) or from bank-transaction categorisation (the old `data.json` value of $64,421.70 likely came from exactly this kind of bank-tx-level matching via the `normalizePnLCat` regex in `index.html`), not from the P&L sectionMap.

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
