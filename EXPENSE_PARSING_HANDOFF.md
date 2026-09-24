# Handoff — Dedicated Expense Parsing Page

Brief for a new chat that will design/build a **dedicated expense-parsing page** in MatiereHub.
(The new chat is in the same "MatiereHub" project, so it auto-loads `CLAUDE.md` + memory. This file is the focused brief on top of that.)

---

## Why we're building this

Today expenses are captured only through the floating Claude bar (type or attach a photo). That auto-commits straight to the database with **no review step**. Seb wants a proper page because:

- **Every receipt line must be captured** — the materials catalog (description + price) is the whole point; missing lines defeats it.
- **Each line should be attached to a project** so we can track real spend per project.
- He needs the chance to **review and correct before/after saving** — fix the project, fix the category, delete junk lines (subtotals/GST), or leave a field blank when unsure.
- The catalog of materials (description, unit price, supplier, category) should become **reusable when building quotes** in the Quotes & Pricing tab.

## Goal in one line

A receipt → **editable preview table of every line** → user confirms/corrects (project, category, qty, price) → save batch → lines flow into `expense_log` and feed a **materials catalog** used by quotes.

---

## What already exists (build on this, don't rebuild)

**Capture pipeline** (`netlify/functions/claude-parse.js`):
- **ACTION 2** — single text expense (`"$85 bunnings screws"`) → one `expense_log` insert.
- **`expense_batch`** — receipt photo/PDF → Claude **Sonnet** vision returns a JSON array of line items → each inserted into `expense_log`.
- Recent fixes (committed `c697bac`, **not yet deployed**): image sent at 1568px/0.90; `max_tokens` 8000; `extractJsonObjects()` salvages truncated arrays; user note adds project context without overwriting the extract-every-line directive; per-line project fuzzy-matched to an exact active project, **blank if unsure**.
- ⚠ It currently **auto-saves** the batch — there is NO review-before-commit step. That's the main gap a dedicated page should close (e.g. return the parsed lines to the UI for editing, then POST the confirmed batch).

**`expense_log` table (Supabase):**
`{ id, date, supplier, description, category, project, qty, unit_price, amount, notes, created_at }`
Holds only chat/photo-logged expenses (NOT the 1,046 Xero transactions — those live in `xero_cache`/`bank_transactions`).

**Expenses tab** (`index.html`, `renderExpenses`): review/edit parsed `expense_log` — date chips + project + category filters; inline-editable Description, Category (Smart Suggest), Project (Smart Suggest), Notes. Edits route through **`hub-write.js`** (generic write API, service key, server-side allow-list — anon key is read-only). `expense_log` writable columns: project, category, description, notes.

**Smart Suggest** (`smartSuggest(input, getItems, onPick)`): hub-wide type-ahead used on Contact/Project/Category fields — reuse it for the new page.

**`category_list` table:** valid expense/contact categories (lookup).

**Front-end is ONE file** (`index.html`) — all tabs/CSS/JS inline. Add the new page as another `showTab` page + nav button. Shared tokens: `HUB_PALETTE`, `.hub-pill-btn`, `:root` CSS vars (`--bg-1`, `--ink-1`, etc.).

---

## Suggested shape for the new page (for discussion, not fixed)

1. **Upload/drop a receipt** (image or PDF) → call `claude-parse` in a "parse only, don't save" mode (new flag, e.g. `previewOnly:true`) that returns the parsed line array WITHOUT inserting.
2. **Editable preview table**: one row per line — description, qty, unit_price, amount (auto-recalc), category (Smart Suggest), project (Smart Suggest, default = project from the prompt), checkbox to include/exclude. Add/delete rows. Flag low-confidence lines.
3. **Save** → POST the confirmed array to a save endpoint → `expense_log` inserts (reuse `expense_batch` logic minus the auto-parse).
4. **Materials catalog view**: dedupe `expense_log` by description (latest/avg unit_price, supplier, category) → searchable catalog → "add to quote" hook into Quotes & Pricing.

Open design questions to settle with Seb: preview-before-save vs. save-then-correct (current Expenses tab already does save-then-correct); how the catalog dedupes (by exact description? by supplier+description?); how catalog items get pulled into a quote.

---

## Hard constraints (from CLAUDE.md)

- No paid subscriptions beyond Claude Pro. Seb is not a developer — keep it simple.
- One HTML file for the front-end. Backend = Netlify functions + Supabase.
- **Deploy batching**: editing files is free; only `git push master:main` triggers a Netlify build (costs credits). Batch many edits, deploy once. Track in `CHANGES_PENDING.md`.
- Verify live via Claude-in-Chrome (sandbox can't reach matierehub2.netlify.app).

## ⚠ Current deploy state (read before pushing)

Local `master` is **2 commits ahead of `origin/main`**, un-deployed and waiting for Seb's go:
- `77836c6` — P&L revamp + removed 5 tabs (Timesheets is now default).
- `c697bac` — receipt-parsing fix + dead-code prune.

So a fresh checkout/preview already shows the trimmed tabs & new P&L, but the **live site does not** until deployed. Any new expense-page work stacks on top of these and ships in the same single deploy. Full checklist + rollback in `CHANGES_PENDING.md`. Memory: `project_matierehub_pending_deploy`.
