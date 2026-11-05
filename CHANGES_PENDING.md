# CHANGES — batch tracker

**Purpose:** accumulate many edits locally, deploy ONCE. Editing files is free; only a push to `main` triggers a Netlify build (= credits). See CLAUDE.md → "Deploying changes" for the full workflow.

## Feature — 2026-11-01 (Schedule tab: pipeline + bookings calendar)

Seb asked for a pipeline / future-bookings tool: approved quotes (Xero or direct in the Hub)
flow into a calendar with hours, address, priority, constraints (e.g. plumber first, ready 15/11),
indoor/outdoor, special-order lead times, easy re-shuffling, and client messages when a date
slides or is confirmed. Optional client "window" policy (2–3 days).

- **New table `bookings`** — `supabase_bookings.sql` (RUN ONCE in the Supabase SQL editor; until
  then the tab shows a copy-SQL setup card). Statuses approved → tentative → confirmed →
  in_progress → done / cancelled. `constraints` and `notify_log` are JSONB; `notified_start`
  tracks which date the client was last told (drives the "client not told" warnings).
- **`netlify/functions/hub-write.js`** — `bookings` added to `WRITABLE` + `CREATABLE`; ids `BK-###`
  generated server-side (`nextBookingId`).
- **`netlify/functions/xero-mcp.js`** — `create_quote` now also inserts an `approved` booking
  (hours = `labour_hours`), errors swallowed so a missing table never blocks a quote.
- **`index.html`** — new **Schedule** tab (JS block starting `SCHEDULE — pipeline…`, `sch*` functions,
  `SCH` state, CSS `.sch-*`). Pipeline column (needs a date / tentative / confirmed, "approved in
  Xero" banner → one-tap add), week + month calendar, drag-and-drop (desktop) or "Pick a day"
  tap-to-place (touch), suggest-next-free-day, capacity bars (8 h/day, editable), overbooking +
  constraint + rain + late-order warnings, delivery lead-time timeline (reads
  `shopping_lists.items[].lead_time`, "Mark ordered" writes `ordered/eta`), Open-Meteo weather,
  OSM geocoding → travel-time gaps in the day plan, per-job client window, Notify panel
  (templates: proposed / confirmed / date moved / window → Comms Hub draft, SMS, email, copy;
  every notification logged). Snackbar with Undo after every move.
- **Hub-wide polish** (CSS only): safe-area insets, bottom-sheet modals + 16px inputs + 46px tabs on
  phones, compact header, focus rings, reduced-motion.
- **Comms Hub link** — new `POST /api/schedule/draft` in `~/Developer/comms-hub` (own key, CORS for
  the Hub origin only, DRAFT ONLY — hard rule 3). Hub's Schedule ⚙ settings take the Tailscale https
  address + key (`npm run schedule:key` in comms-hub).
- Tested: 25 behavioural checks in headless Chrome against mocked Supabase (all pass), comms-hub
  suite 253/253.

**To go fully live (Seb):** (1) run `supabase_bookings.sql` once; (2) in comms-hub: `npm test`,
commit, `npm run service -- restart`, `npm run schedule:key`, paste address + key into Schedule ⚙.

---

## Fix + feature — 2026-09-24b (Shopping List: filters, priority items, collapse — not yet deployed)

Root cause of the Shopping List tab showing nothing at all (SL-002 → SL-005) was fixed
separately the same day — RLS was enabled on `shopping_lists` with no policy, silently
returning `[]` to the anon key; Seb disabled RLS directly in Supabase (no code change,
already live). This batch is the follow-up UX Seb asked for once the tab was visible again:

1. **Filters at the top of the tab** (`shopFilterBar`, `SHOP` state, `index.html`) — by
   default the tab now only shows lists for non-"Quoted" projects that aren't marked done.
   Two pill toggles reveal the rest: "Done (N hidden)" and "Quoted-only jobs (N hidden)".
   Project status is looked up by matching `shopping_lists.project` to `projects.name`
   (case-insensitive); a list whose project can't be matched is shown (fails open, not hidden).
2. **Special/custom-order items float to the top + get a detail popup** — `items` (JSONB,
   no schema change needed) can now carry optional `special`, `supplier`, `supplier_email`,
   `lead_time`, `specs`, `delivery_fee`, `order_url` per item, captured at quoting time via
   `netlify/functions/xero-mcp.js`'s `create_quote` `materials` array (schema extended,
   `createShoppingList` carries the fields through). A `special:true` item gets an amber
   left-border + "⚡ SPECIAL ORDER" tag and sorts above normal items (stable sort — order
   within each group unchanged). Tapping a special item opens a modal (`shopShowSpecial`)
   with whatever details were captured, a "✉ Email supplier" mailto: link (prefilled subject
   + body from the item/job), and a "🛒 Order online" link when `order_url` is set. Tapping
   its checkbox (not the row) still ticks it off directly, same as a normal item.
3. **Collapse by default** — only the most recent open list starts expanded
   (`SHOP.expanded`, lazily defaulted once); every other list starts collapsed with a
   chevron, click the header to expand/collapse. State is in-memory only (resets on reload),
   consistent with the rest of the tab's UI state elsewhere in the Hub.

Files: `index.html`, `netlify/functions/xero-mcp.js`. No Supabase schema change (items stays
JSONB). Syntax-checked locally (`node -c`). **Not yet deployed** — needs the next batch push,
same as the fuzzy-match fix below.

---

## Fix — 2026-09-24 (Scan Receipt project field — fuzzy match, not yet deployed)

Seb reported: on a multi-line scanned receipt, editing a line's Project field (or the
"apply one project to every line" box) required typing the EXACT existing project name —
anything close-but-not-exact (e.g. "mark" instead of "Mark - Nth Balgowlah") was saved
verbatim with no warning, so the line silently never linked to the real project.

Root cause: `rcApplyProjectAll()` only did a case-insensitive exact-string match, and the
per-line `rc-cell[data-field="project"]` change handler did no matching at all — it just
saved whatever was typed. Meanwhile natural-language entries via the Claude bar
(`claude-parse.js`'s `fuzzyMatchProject`, three-tier token-overlap scoring, 0.6 confidence
threshold) already handle this correctly server-side.

Fix — brought the same fuzzy-match logic client-side (`index.html`):
- New `fuzzyMatchProject(name, candidates)` — token-overlap scorer mirroring
  claude-parse.js's server-side matcher exactly (same 0.6 threshold).
- New `ssProjectCandidates()` — valid project names ordered Active-first, then most
  recently created, so a tied score resolves to the more likely intended project.
- Per-line project field (`rc-cell[data-field="project"]` change handler, via new
  `rcApplyProjectToRow()`) and `rcApplyProjectAll()` both now canonicalise typed text
  through this matcher instead of requiring an exact match.
- If nothing scores >= 0.6, the typed text is kept but the row is flagged (amber outline,
  same treatment as a blank field, via `it._projUnmatched`) and a toast warns it won't
  link to a real project — previously this failed completely silently.

**Not yet deployed** — committed locally only. Add to the next batch push.

---

**Status:** ⏳ Pending — three features built 2026-09-18, not yet deployed (needs one `supabase_shopping_list_and_baseline.sql` run + one `git push` + `MCP_SHARED_SECRET` env var + connector registration in Claude).

---

## Follow-up fix — 2026-09-18b (create_contact blank-name bug, deployed)

Seb reported QU-0285's client details were missing on the PDF even though the Xero contact
existed — root cause: `create_contact` was called with just "Vladimir" instead of the full
"Vladimir - Manly Vale" identifier (and no address), so the contact printed with a thin/blank
name on the quote. Fixed in `netlify/functions/xero-mcp.js`:
- `toolCreateContact` now rejects a blank/whitespace name outright (fails loudly instead of
  silently creating a broken contact).
- `create_contact`'s tool description now explicitly tells the calling model to pass the same
  "FirstName - Suburb" identifier used as the `create_quote` title, plus the address fields.
- Deployed as a single commit (`9087fbd5`) via the Git Data API + device_bash method — no code
  change to `toolCreateQuote`'s contact-linking logic, since auto-renaming an *existing* Xero
  contact to match a new quote's title would be unsafe for repeat clients.
- **One-off manual fix still needed**: Seb, please rename the existing "Vladimir" contact in
  Xero to "Vladimir - Manly Vale" and add the address (11 Kenneth Rd, Manly Vale NSW 2093) —
  takes 30 seconds in the Xero contact editor. QU-0285 itself can be left as-is or re-quoted.

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


## Batch 2026-11-05 — Projects fixes (local, not yet pushed)
- Scope of Work no longer pulls in another job's invoice once anything is hand-linked.
- Auto-match box disappears as soon as a quote or invoice is picked.
- Auto-link: quotes made from Claude are linked to their job by the quote number saved in the Schedule bookings.
- Picking one quote line no longer drags in the rest of that quote; Est. Value = picked lines (manual figure only when none picked).
- Detail tiles: Labour and Expenses show actual / quoted with a coloured difference; Remaining shows $ and % of the job.
- Project table: margin % chip beside the name; compact card rows on phones.
- Status filter: tags (Active, Finished, Quoted, Paid, Inactive) plus All / None; default Active + Finished; list ordered by status.

## 2026-11-05 — Performance tab
- New "Performance" tab: operating margin per day (sales − expenses per job, spread over every hour worked on it, summed per day/week/month).
- Month calendar with $ per day, green at/above 8h × nominal rate ($800), red below; tap a day to list its jobs, tap a job to open its card.
- Bar chart (daily/weekly/monthly, 2–8 weeks, 8–26 weeks, 6–24 months) with benchmark line and trend line.

## 2026-11-05 — Performance tab v2
- Orange for $700–$800 days; ★ public holidays (NSW, to 2027); 🌴 leave (Holidays / Sick days / Carer days) never counted against you.
- Non-billable time (Admin, Wasted Time…) now counts as hours earning $0; every past weekday is clickable (even "no hours").
- Chart redesigned (gradient bars, smooth 7-day trend line, benchmark line, tooltip); same pill selectors as other tabs (2w/4w/3m/6m/1y/All + Day/Week/Month).
- New sections: Jobs to watch (doing well / needs attention), and a rule-based "What the numbers say" by type of work, for a chosen period (this month, last month, 3m, 6m, 12m, all time, or any month).

## 2026-11-05 — Damien fence fix
- Auto-link: an unlinked invoice whose client matches a job and whose total equals that job's quoted figure is linked to it (only if exactly one job fits).
- Performance: "Sales counted: Invoiced | Paid only" switch (default Invoiced).

## Batch — Schedule gap-fill (2026-11-05)
- Schedule: jobs missing hours now take the quoted labour hours (project baseline, else labour lines on the quote); missing address/phone/email come from the Xero contact (matched via the quote's contact, then name). Runs on every load, saves to the booking; geocodes the new address.
- Address also saved on the project (needs `supabase_projects_address.sql` run once; shown on the project card as 📍).
- New quotes (xero-mcp create_quote) read the contact card and store address/phone/email on the booking and project from day one.
- Contact sync fix: addresses were blank when Xero's first address slot was empty; now takes whichever slot has the street line. Fills in on the next daily contacts sync (or run scope=contacts).

## Batch — Schedule placeholders (2026-11-05)
- Accepted Xero quotes are added to the Schedule automatically on load.
- Calendar opens on today (week starts today), past days blanked and unreachable.
- Won jobs with no date show in the calendar as dashed placeholders laid out from today (priority first, free capacity); drag one to a day to lock it in as Tentative. Pipeline list sits under the calendar on phone.

## Batch — Schedule hours, project link, smart note, Won/Lost (2026-11-05)
- Jobs find their real project card (quote link, name prefix, quoted amount) → hours come from the project's baseline hours; booking is re-pointed to the card's name.
- Job sheet slimmed: project-card button, when, address/client, one smart note; everything else under "More details".
- New `smart-note.js` function: quick note → tidy note with exact dates (Haiku).
- Duplicate guard when auto-adding accepted quotes (checks the database first).
- Project statuses Won and Lost; Quoted → Won when the Xero quote is ACCEPTED, → Lost when DECLINED. Filter default: Active, Won, Finished.

## Batch — bookings visible again + Won jobs flow into Schedule (2026-11-05)
- Root cause of "jobs not showing": bookings table has row-level security with no read rule, so the browser's public key saw nothing. Now read through new password-gated `hub-read.js` (DB left locked: bookings hold client phone/email).
- Every Won project is added to the Schedule automatically; "Add job" now lists Quoted/Lost jobs and marks the pick Won. "approved in Xero" banner removed.

## Batch — Price library (2026-11-05)
- New Supabase table `price_list` (supabase_price_list.sql, already run): one library of prices (ex GST) with supplier, unit, last paid, times seen, low–high, source (receipt / web / quote / manual).
- Fed automatically: a database trigger on `expense_log` adds every saved receipt/expense line (any entry route). Backfilled 189 items from existing receipts.
- Xero MCP connector (used by the quoting chat) gains `search_prices` and `save_price`; `create_quote` description tells Claude to check the library first and save web finds.
- Hub: Scan Receipt → "Price library" now shows the shared library (source, price range).

## Batch — Multi-receipt scan (2026-11-05)
- Scan Receipt takes many receipts at once (different suppliers and dates). One request per receipt, in parallel; each gets its own header (supplier + date editable), a lines-vs-printed-total check, and an "already saved?" warning.
- claude-parse: receipts are read by Haiku first; if lines don't add up to the printed total (within 3%, ex-GST x1.1 or GST-free) the receipt is re-read by Sonnet. Day-first (Australian) dates enforced in the prompt.
- Xero export (if ticked) makes one draft per receipt. Saved lines feed the price library automatically (trigger).

## Batch — Receipt Inbox (2026-11-05)
- New table `receipt_inbox` + private storage bucket `receipts` (supabase_receipt_inbox.sql, already run). New function `receipt-inbox.js` (add / list / url / update / xero_attach), login token or HUB_API_KEY.
- Scan Receipt tab → "📥 Inbox": Pending / Processed / Personal / Missing receipts. Swipe card: photo, supplier/date/total, project chips from that day's timesheets, No project, Personal, Skip, Save & next (expenses + price library) with optional Xero draft + the original file attached.
- Missing receipts: bank money-out in the last 90 days with no matching receipt.
- Fix: login token now sent to hub-read / smart-note / receipt-inbox (bookings were refused → schedule showed the setup card).

## Batch — quotes are not won jobs (2026-11-05)
- create_quote no longer adds a Schedule booking. Jobs enter the Schedule only when Won (Xero ACCEPTED or status set by hand).
- "✕ Not won" on cards and in the job sheet takes a job off (Undo; returns if later Won). Finished/Paid jobs auto-close, Lost/Inactive auto-cancel.
- Sam - Fairlight (3 quotes) removed from the schedule.

## Batch — Receipt Inbox facelift + Xero fields (2026-11-05)
- Fix: Inbox's internal reader was refusing the add-only key, so email receipts arrived with no lines. Reader now authenticates internally; new `reread` action; the Inbox re-reads empty pending receipts automatically on open.
- Card redesign (phone-first, aligned grid): PDF drawn inline (pdf.js, up to 4 pages) / photo inline; supplier suggested (from reading, else the sender's domain) with a list of known suppliers; total suggested from the read; reference/invoice no.; description; Xero account (category), GST mode (10% / GST-free / BAS excluded); Paid from (remembered); job chips. Per-supplier memory (category, GST, project/no project).
- No lines read? Enter the total + what it was for and it saves as one line. Xero draft uses Reference, tax type and attaches the file.
- Inbox learns: suppliers usually saved with no project (80%+ of 3+ past expenses, any device) default to No project; bank account remembered per supplier; clear hint when Xero is not connected on the device.

## Batch — Receipts queue to Xero in batches (2026-11-05)
- No more per-receipt Xero step or "Connect Xero" on the phone. Save & next saves to expenses and marks the receipt "queued". New `receipt-xero.js` sends queued receipts to Xero as Spend Money (file attached) using the server's own Xero link (same as the quoting connector); bank account auto-picked (only active bank account, or XERO_RECEIPTS_BANK_ID).
- Processed pile: shows Waiting / In Xero ✓ (+file) / Failed (reason) per receipt, "Send N to Xero now", per-receipt Send/Retry.
- Workflow `receipts-to-xero.yml`: manual for now; schedule lines ready to un-comment (twice daily) after the first batch is checked.
- Needs supabase columns xero_status, xero_error, tax_mode, reference, xero_sent_at (already run).
