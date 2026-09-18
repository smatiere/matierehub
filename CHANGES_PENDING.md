# CHANGES — batch tracker

**Purpose:** accumulate many edits locally, deploy ONCE. Editing files is free; only a push to `main` triggers a Netlify build (= credits). See CLAUDE.md → "Deploying changes" for the full workflow.

**Status:** ⏳ Pending — three features built 2026-09-18, not yet deployed (needs one `supabase_shopping_list_and_baseline.sql` run + one `git push` + `MCP_SHARED_SECRET` env var + connector registration in Claude).

---

## Pending batch — 2026-09-18 (Xero MCP connector + Shopping List + Job-status baseline)

Seb's three "tonight" asks, built together since the baseline + shopping list are wired into the connector's `create_quote` tool. ⚠️ **Run `supabase_shopping_list_and_baseline.sql` in the Supabase SQL editor at/before deploy** — creates `shopping_lists` and adds `projects.baseline_*` columns. Everything else is backward-compatible (guarded with `.catch(() => [])` where it reads the new table) so skipping this step temporarily won't break the rest of the Hub.

| # | Ask | Built | Where |
|---|-----|-------|-------|
| 1 | Custom Xero MCP connector — phone-only, no browser/desktop | New standalone Netlify function `netlify/functions/xero-mcp.js` implementing a stateless MCP JSON-RPC endpoint with 4 tools: `find_contact`, `create_contact`, `create_quote`, `create_invoice`. Reuses the exact OAuth/token logic already proven in `xero-sync.js` (refresh token in Netlify Blobs, tenant looked up live) — no new Xero app, no new scopes. | `netlify/functions/xero-mcp.js` (new), `netlify.toml` (timeout) |
| 2 | Shopping list feature | `shopping_lists` table (job reference, `items` JSONB with `checked` state) + new **Shopping List** tab (tap to tick, mark done/reopen, "+ New list") + `hub-write.js` allow-list entry, following the same pattern as Expenses/For Action | `supabase_shopping_list_and_baseline.sql` (new), `index.html` (`renderShopping`, `shopToggleItem`, `shopSetStatus`, `shopNewList`), `hub-write.js` |
| 3 | Job-status baseline | Extends `projects` (not a new table — a baseline IS a project at "quoted" stage) with `baseline_scope/price/labour_hours/materials_estimate/set_at` + new `Quoted` status value. Set automatically by `create_quote` when Seb approves a quote (from the connector); shown read-only in the Projects detail modal as baseline vs. actual hours/materials | `supabase_shopping_list_and_baseline.sql`, `index.html` (`projRenderBaseline`, `PROJECT_STATUSES`), `hub-write.js` |

**Outstanding for Seb before this is live end-to-end:**
1. Run `supabase_shopping_list_and_baseline.sql` in Supabase SQL editor.
2. Add `MCP_SHARED_SECRET` env var in Netlify (pick any password).
3. After deploy, register `https://matierehub2.netlify.app/.netlify/functions/xero-mcp` as a Custom Connector in the Claude iOS/desktop app, with header `Authorization: Bearer <that password>`.

**Deploy command:** `git push <https-with-PAT> master:main` (one build, one commit).

---

## Batch — 2026-07-10 (Project tab improvements) — ✅ shipped, verified live

Seb's asks + what was built. All in `index.html` + one line in `hub-write.js`. No SQL/schema changes needed — `timesheets.notes` and `projects.scope_of_work` already existed.

| # | Ask | Built | Where |
|---|-----|-------|-------|
| 1 | Auto-match to invoice/quote by name was summing ALL matching invoices — too many lines (e.g. PR-016 "Kim - Manly #6" pulling in old jobs) | New `projAutoMatchInvoices()` — brings only the single most recent invoice (by date) per client, not the full history. Used by the main table's Invoiced column, the "auto-matched" warning box, and its "convert to explicit link" action, so all three now agree. (Quotes were never fuzzy-matched — only invoices are, so nothing to change there.) | `projAutoMatchInvoices`, `renderProjects`, `projRenderAutoMatchedSection`, `projConvertAutoMatched` |
| 2 | "Eléa's bed" should be listed with non-billable projects, not the billable table | Added to `NON_BILLABLE` (both accented/unaccented spellings) — same pattern as "Admin" | `NON_BILLABLE` |
| 3 | Scope of Work looked like a manual input box | Replaced the free-text textarea+Save with a read-only, auto-derived bullet list of unique descriptions pulled from linked (or fuzzy-matched) quote/invoice lines | `projRenderScope` (new), replaces `projToggleScope`/`projSaveScope` (removed) |
| 4 | Timesheet section in the project modal should allow notes input | Notes cell is now an inline-editable input (same save-on-change pattern as Expenses/Transactions), writes to `timesheets.notes` | `projSaveTsNote` (new) + `hub-write.js` (`timesheets: ['notes']` added to `WRITABLE`) |
| 5 | Dates should all show DD-MM-YYYY | New `fmtDMYDash()` helper (dash-separated, vs the existing slash-separated `fmtDMY` used elsewhere in the HUB); applied to Start/End, Timesheets, Expenses, auto-matched box, and the link-search results within the Projects tab | `fmtDMYDash` (new) |
| 6 | Linked Quotes / Linked Invoices sections too busy — merge into one, smaller bars, drop "nothing linked yet" filler text | Combined into one "Linked Quotes & Invoices" section: compact one-line bars (Q/INV badge) instead of two full tables, one merged search box (`projRenderCombinedCandidates`, replaces `projRenderLinkCandidates`/`projRenderQuoteLinkCandidates`), empty state renders nothing instead of placeholder copy | `projRenderCombinedCandidates` (new) |

**Deploy command:** `git push <https-with-PAT> master:main` (one build).

---

## Batch — 2026-07-09b (Seb's follow-up comments) — ✅ shipped, verified live

Three commits, `eafcca3..52c8142`. All in `index.html`/`hub-write.js` + one new SQL migration.

| # | Ask | Built | Commit |
|---|-----|-------|--------|
| 1 | Unlink not available for auto-matched invoices (PR-016 "Kim - Manly #6" had a wrong total) | New "Auto-matched Invoices" section in the modal (shown only when zero hand-links exist) lists what's being fuzzy-matched, with dates, + a "convert all to explicit links" button — after which the existing unlink works | `9c9cda2` |
| 2 | Show project Scope of Work, small + expandable | New `projects.scope_of_work` column; small 2-row textarea + Expand/Collapse + Save in the modal | `9c9cda2` |
| 3 | Invoice linked → quote should link too, Est. Value should reflect quote | New `autoLinkQuotesFromInvoices()` + `cascadeLinkedQuotesAndInvoices()` wrapper, called on load + every link action | `9c9cda2` |
| 4 | (reminder) multiple invoice/quote items per project | Already supported — no change needed, confirmed | — |
| 5 | Invoice paid → project status auto → Paid | New `autoUpdatePaidProjects()`, runs on load + every link action | `9c9cda2` |
| — | **Same-session bug found + fixed:** cascade #3 auto-linked a partial quote and silently wiped Mark - Nth Balgowlah's real $39,450 estimate down to $8,135 | Est. Value formula changed to `Math.max(linkedQuoteValue, quoted)` — a linked quote (auto or hand) can only raise Est. Value, never shrink it below the manual figure | `52c8142` |

**Outstanding for Seb:** open "Kim - Manly #6", click "+ convert all 10 to explicit links" under Auto-matched Invoices, then unlink whichever of the 10 aren't actually job #6 (probably keep only the 2026-07-04 invoice). Deliberately left for Seb's judgment, not guessed at.

---

---

## Pending batch — 2026-07-09 (Quote/invoice ↔ project linking refinements)

Follow-up to the Projects tab quote/invoice linking feature (2026-06-30 batch, already live). Seb's asks + what was built:

| # | Ask | Built | Where | Commit |
|---|-----|-------|-------|--------|
| 1 | Can't pick a whole quote/invoice at once — linking line-by-line too slow on phone | Search results now group by invoice #/quote # — a "+ link all N lines" action appears whenever a document has multiple lines, alongside the existing per-line "+ link" | `index.html` (`projRenderLinkCandidates`, `projRenderQuoteLinkCandidates`, new `projLinkAllInvoice`, `projLinkAllQuote`) | `eafcca3` |
| 2 | Need to unlink a quote/invoice from inside the project window | Already existed (`✕ unlink` on every row under Linked Quotes/Linked Invoices, calling `projUnlinkItem`/`projUnlinkQuoteItem`) — confirmed live, nothing to build | — | — |
| 3 | Leverage Xero's auto-populated quote-reference on invoices (accepted quote → invoice keeps the quote # for traceability) to auto-apply the project | New `autoLinkInvoicesFromQuotes()`: whenever a quote is linked to a project, any invoice line whose `quote_number` matches gets the same project automatically (never overwrites an existing different link). Runs on every page load (catches new syncs) and immediately after any quote link/bulk-link action | `index.html` (`autoLinkInvoicesFromQuotes`, hooked into `loadData`, `projLinkQuoteItem`, `projLinkAllQuote`) | `eafcca3` |
| 4 | Search should only match contact name + invoice/quote #, and show the date so the right line is easy to pick | Dropped `description` from the search haystack in both search boxes; every result row now shows its date first, sorted newest-first | `index.html` (`projRenderLinkCandidates`, `projRenderQuoteLinkCandidates`) | `eafcca3` |

No DB/schema changes — pure `index.html` front-end logic, backward-compatible, no SQL to run before deploy.

**Deploy command:** `git push <https-with-PAT> master:main` (one build, 1 commit).

---

## Pending batch — 2026-06-30 (Projects tab rewrite + Non-Billable window + Timesheets filtering/summary + quote_items backend)

⚠️ **Run `supabase_quote_items_setup.sql` in Supabase SQL editor at/before deploy** — creates the `quote_items` table. Quote-linking in the Projects detail modal and the daily `xero-sync?scope=quote_items` step will error until this table exists. Everything else in this batch is backward-compatible and won't break the rest of the HUB if this step is skipped temporarily.

`data.json` and the stray untracked files in the working tree (`.github_config.json`, `EXPENSE_PARSING_HANDOFF.md`, `SYNC_RUNBOOK.md`, `create_quote_mark_balustrade.js`, `matiere-widget.js`, `matiere_dashboard.html`) are NOT part of this batch and were left untouched/uncommitted.

| # | Feature | Where | Commit | Status |
|---|---------|-------|--------|--------|
| 1 | `quote_items` table + Xero sync (mirrors `invoice_items`, sourced from Xero Quotes) — powers quote-linking in the Projects detail modal | `supabase_quote_items_setup.sql` (new), `netlify/functions/xero-sync.js`, `netlify/functions/hub-write.js` (`quote_items:['project']`), `.github/workflows/xero-sync.yml` (new sync step) | `e1b7798` | ☑ built |
| 2 | Projects tab rewrite: 9-column table, default filter = Active, row-click detail modal (status pills, multi-select quote+invoice line-item linking, manual Est.Value + manual Revenue) | `index.html` | `5079d0b` | ☑ built |
| 3 | Non-Billable Projects — separate wide modal, period presets, category selector, hours-over-time chart | `index.html` | `5079d0b` | ☑ built |
| 4 | Timesheets: Period Summary section (plain-text digest + KPI tiles) + Timesheet Log table filters (project + notes/project search, scoped to the table only) | `index.html` | `5079d0b` | ☑ built |
| 5 | Docs: CLAUDE.md Tabs section corrected (was stale, missing Scan Receipt) + `quote_items` table/column/sync docs added | `CLAUDE.md` | `3bf776d` | ☑ built |

**Deploy command:** `git push <https-with-PAT> master:main` (one build, 3 commits).

---

## Pending batch — 2026-06-24 (Projects/Receipts/Non-billable + Elea fix) — ✅ shipped 2026-06-24

⚠️ **Run `supabase_feature_updates.sql` in Supabase BEFORE/at deploy** — adds `invoice_items.project`, `projects.manual_revenue`, `projects.manual_revenue_note`, and backfills the `Eléa's bed` project row. The new linking & manual-revenue features error until these columns exist (code is otherwise backward-compatible and won't break the rest of the HUB).

This deploy ships 8 commits in one push: the 6 below + 2 prior un-pushed receipt tweaks (`b4defcd` Cancel/discard, `eede2dc` catalog project filter). `data.json` stays uncommitted → not pushed.

| # | Feature (from Seb's list) | Where | Commit | Status |
|---|---------------------------|-------|--------|--------|
| 1 | Create a project on the spot when logging an expense (and on receipts/transactions) — Smart Suggest now shows "＋ Create '<name>'" | `index.html` (smartSuggest, rcCreateProj, exSaveCell, txSaveCell) + `hub-write.js` INSERT path (auto PR-id) | `bb469a8`,`c0a0acb` | ☑ built |
| 5 | Receipt parsing: "Allocate one project to every line" bar (apply to all, then tweak exceptions) | `index.html` (rcRenderTable, rcApplyProjectAll) | `bb469a8` | ☑ built |
| 4 | Non-Billable rolled-up line in Projects tab — one expandable row, per-category breakdown. List = Daddy, Admin, Consumables, Wasted Time, Office, Holidays, Sick days, Carer days (case-insensitive; single source of truth = `NON_BILLABLE`) | `index.html` (renderProjects, projToggleNB) + `claude-parse.js` | `01ee6db`,`128fe79` | ☑ built |
| 3 | Link specific invoice line items to a project (overrides client-name auto-match); set Est. Value + manual cash revenue when no invoice exists | `index.html` (renderProjects data + project detail modal, projLink/Unlink/SaveRevenue) + `hub-write.js` writable cols + SQL | `01ee6db`,`1e9add6`,`c0a0acb` | ☑ built |
| 2 | "Eléa's bed" had no project number — it existed only on expense rows, no `projects` row. SQL backfills a proper PR-### row matching the exact name | `supabase_feature_updates.sql` | `17d64b1` | ☑ built (runs with SQL) |

**Note for Seb:** there's a junk project `PR-011 = "quote"` (with stray timesheet hours) and possible name drift — not touched here. Say the word and I'll clean it up.

**Deploy command (when approved):** `git push <https-with-PAT> master:main` (one build).

---

## How a batch works

1. Log each requested change in the "Pending" table below **before** touching code.
2. Edit locally + commit to local git (free, no deploy).
3. Preview locally (`index.html` reads live Supabase). Note: `hubWrite` saves only work on the deployed site, not the local file.
4. When the batch is approved → **one push** (`git push <PAT-url> master:main`) = one build.
5. Verify live via Claude-in-Chrome; move the batch from Pending → Shipped.

**Rollback (any file):** `git checkout origin/main -- <file>`

---

## Pending (next batch) — ✅ RESOLVED, shipped 2026-06-21

_Logged 2026-06-20 as "documentation only, don't build yet." Verified 2026-06-25: all 11 items below were in fact built and shipped as part of commit `77836c6` ("P&L revamp + tab trim") on 2026-06-21 — confirmed by reading the live code (8-tab nav, `rangeLbl` single-month header, `pnlSetAllCats` All/None buttons, `pnlExpandedCats`/`pnlExpandedAccts` drill-down, prior-period month label). Table left as historical record; nothing left to do here._

**Tab removals** (hide these `showTab` pages + their nav buttons):

| # | Area | Change requested | File(s) | Status |
|---|------|------------------|---------|--------|
| 1 | Nav/tabs | Remove **Activity Log** tab | `index.html` | ☑ |
| 2 | Nav/tabs | Remove **Cash & Invoices** tab | `index.html` | ☑ |
| 3 | Nav/tabs | Remove **Profitability** tab | `index.html` | ☑ |
| 4 | Nav/tabs | Remove **Overview** tab | `index.html` | ☑ |
| 5 | Nav/tabs | Remove **Materials** tab | `index.html` | ☑ |

→ Remaining tabs after removal: Timesheets · P&L · Projects · Quotes & Pricing · Transactions · Expenses · For Action. **Decide new default tab** (Overview was likely the landing tab — pick its replacement, e.g. P&L or Timesheets).

**P&L tab changes:**

| # | Area | Change requested | File(s) | Status |
|---|------|------------------|---------|--------|
| 6 | P&L | Profit line stays **independent of selected categories** — toggling cost categories must NOT change the profit figure (profit always reflects full actuals) | `index.html` | ☑ |
| 7 | P&L summary | Label the **prior period** with its actual month, e.g. "May 2026" (not a generic "prior period" label) | `index.html` | ☑ |
| 8 | P&L header | When **This Month** is selected, show only the month name in the header — currently renders "June - June 2026", should be just "June 2026" | `index.html` | ☑ |
| 9 | P&L | Make **all bottom lines expandable** — click a line to drill into its detail | `index.html` | ☑ |
| 10 | P&L | Remove the **"$0" shown under TAX and BAS clearing** | `index.html` | ☑ |
| 11 | P&L | Add an easy **"toggle off all cost categories"** control so a single category can be isolated/focused | `index.html` | ☑ |

**Round 2 — cleanup + receipt parsing (committed `c697bac`):**

| # | Area | Change requested | File(s) | Status |
|---|------|------------------|---------|--------|
| 12 | Cleanup | Prune the 5 now-orphaned render functions (~226 lines dead code) | `index.html` | ☑ |
| 13 | Receipts | Capture EVERY receipt line (was dropping most). Image now sent at 1568px/0.90 (was 900px/0.80); `max_tokens` 800→8000; salvage truncated arrays; user note no longer overwrites the extract-every-line directive; per-line project fuzzy-matched to exact active project, blank if unsure | `index.html`, `netlify/functions/claude-parse.js` | ☑ |

⚠ **Round 2 needs a deploy to take effect** — `claude-parse.js` is a Netlify function; receipt parsing only changes on the live site, not the local file preview.

**Round 3 — dedicated Scan Receipt page + Materials catalog (preview-before-save):**

| # | Area | Change requested | File(s) | Status |
|---|------|------------------|---------|--------|
| 14 | Backend | Add `previewOnly:true` flag to `claude-parse` — parses + normalises receipt lines (qty×price=amount, fuzzy project, blank category if unsure) and **returns the array WITHOUT inserting**. No new save code: commit reuses the existing `pendingAction:{action:'expense_batch',items}` path. | `netlify/functions/claude-parse.js` | ☑ |
| 15 | New tab | **Scan Receipt** tab (next to Expenses). Drop/upload receipt (image/PDF) + optional note → Parse → **editable preview table** (include checkbox, description, category + project Smart Suggest, qty/unit$ with live amount recalc, running total, add/delete rows, amber outline on blank fields). **Save lines** commits the batch; nothing hits the DB until Save. | `index.html` | ☑ |
| 16 | New view | **Materials catalog** sub-view (same tab): dedupes `expense_log` by supplier+description → latest unit price, last-seen date, category, times purchased; search by description/supplier; **Copy** button puts a quote-ready line on the clipboard (no in-app quote builder exists to inject into). | `index.html` | ☑ |

Design settled with Seb (2026-06-21): **preview-before-save** (junk/GST lines never reach the DB or catalog); catalog **in this build**; dedupe key = **supplier+description**; new tab named **Scan Receipt**.

⚠ **Needs a deploy to take effect** — `previewOnly` lives in the `claude-parse` Netlify function, so the page's Parse step only works on the live site (local `index.html` preview can render the UI but can't parse/save, same caveat as all function-backed features).

---

## Pending (next batch) — Scan Receipt tweaks — ✅ RESOLVED, shipped 2026-06-24

_All three items confirmed live in `index.html` as of 2026-06-25 (part of the Jun 24 Projects/Receipts batch, commit `c200644` and earlier in that run)._

| # | Area | Change requested | File(s) | Status |
|---|------|------------------|---------|--------|
| 17 | Scan Receipt | **Cancel/discard** button on a parsed receipt — clears the preview table (confirms first if there are edits), keeps attached file(s) so it can be re-parsed/swapped. `rcCancel()`. | `index.html` | ☑ shipped `b4defcd` |
| 18 | Claude-bar "+" | The **+ button now routes receipts to the Scan Receipt preview flow** instead of auto-saving. `claudeFilesSelected()` hands attachments to new `rcReceiveFiles()`, which switches to the Scan Receipt tab and auto-parses into the editable preview (review before save). Same on desktop + Safari iOS. | `index.html` | ☑ shipped — confirmed live |
| 19 | Materials catalog | Added **Project column** (latest project, `+N` if bought across several, full list on hover), **2-decimal prices** (`fmt(r.unit_price,2)` + copy-line), and a **Project filter** (Smart Suggest). `rcBuildCatalog` now tracks project + distinct-projects set. | `index.html` | ☑ shipped — confirmed live |

**Status:** nothing left to deploy from this section.

---

## Shipped

### 2026-06-21 — P&L revamp + receipt fix + Scan Receipt page (single build, push `d5cce84..1576c67`)

Four commits shipped in one build: `77836c6` (P&L revamp + tab trim, Timesheets now default), `c697bac` (receipt parsing capture-every-line fix + dead-code prune), `dd4dff8` (Scan Receipt page + Materials catalog, preview-before-save), `1576c67` (add-line for missed items + iOS Safari polish). Files: `index.html`, `netlify/functions/claude-parse.js`. Verified live via Claude-in-Chrome: Scan Receipt tab + both sub-views render, Materials catalog auto-populated 10 deduped items, no console errors. Full parse→save round-trip (needs a real receipt upload) left for Seb to exercise on next receipt.

### 2026-06-20 — Batches 1–3 (single build, push `49a90c6..d5cce84`)

Files: `index.html`, `netlify/functions/hub-write.js` (new), `CLAUDE.md`. Verified live (tabs render, no console errors, hub-write persists for bank_transactions + expense_log).

**Transactions tab:** Smart Suggest contact filter · date preset chips (now shared `.hub-pill-btn` style) + custom range · removed "Bank Transactions" title · dd/mm/yyyy date column · inline-editable Project (Smart Suggest) + Notes · blank cells show no dash · fixed see-through dropdown (defined `--bg-1`/`--ink-1`).

**For Action tab (new):** aggregates expense matches, overdue invoices, uncategorised transactions, untagged contacts; count badge.

**Timesheet tab:** 10-colour neon palette (now `HUB_PALETTE`) + auto-contrast treemap labels · merged Holidays+Sick into one "Leave" tile · incomplete-day flag (amber, distinct from red 0h) · centred/larger public-holiday codes · Missing Days KPI + "Not logged" treemap block open a clickable list of missing days · removed glitchy treemap click-tooltip.

**Architecture:** `hub-write.js` generic write API (service key, server-side allow-list) — anon key stays read-only; all HUB inline edits route through it. Allow-list: `bank_transactions` (project, notes, expense_log_id), `expense_log` (project, category, description, notes).

**Expenses tab (new):** review parsed `expense_log`; date chips + project + category filters; inline-edit Description, Category (Smart Suggest), Project (Smart Suggest), Notes.

**Shared/documented:** `.hub-pill-btn` (canonical pill/preset button) and `HUB_PALETTE` (canonical 10-colour palette) — single sources of truth, see CLAUDE.md.

**Manual DB step done:** `ALTER TABLE expense_log ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';` (run 2026-06-20).
