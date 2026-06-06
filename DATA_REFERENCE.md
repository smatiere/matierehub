# MatiereHub — Data Reference

This file is the single source of truth for how data must be structured in `data.json`.
Claude (both this session and the `claude-parse` Netlify function) must match these exact formats and allowed values.

---

## Canonical Project List

These are the ONLY valid values for the `project` field across timesheets and expense_log.
Reference projects by their **name** string. The `id` is a stable primary key that never changes even if the name is edited.

| ID | Project Name | Status | Notes |
|---|---|---|---|
| `PR-001` | `Mark - Nth Balgowlah` | Active | Full client name: Mark Shippen |
| `PR-002` | `Rob - Balgowlah` | Active | |
| `PR-003` | `IBK - Mosman` | Active | IBathrooms and Kitchen Renovations Pty Ltd |
| `PR-004` | `Neil - Balgowlah` | Active | |
| `PR-005` | `Admin` | Ongoing | Non-billable internal time |
| `PR-006` | `IBK - Mosman 2` | Active | Second engagement with IBK — separate job |
| `PR-007` | `Wasted Time` | Ongoing | Non-billable — tracking unproductive time |
| `PR-008` | `Mark - Nth Balgowlah - Walkway` | Active | Walkway sub-job under Mark Shippen engagement |

**Naming rules:**
- Base format: `FirstName - Suburb` — always use a hyphen (`-`), never an em dash (`–`)
- Numbers and descriptors are allowed: `Mark - Nth Balgowlah 2` or `Mark - Nth Balgowlah - Walkway` are both valid
- Capitalisation must match exactly — copy the name from this table when in doubt

**Adding new projects:**
- When Seb says "new project [name]", register the name exactly as stated and assign the next `PR-xxx` ID
- Example: *"8hrs today on new project Serena - Laundry Room"* → creates `PR-006 Serena - Laundry Room`
- New projects are added to this table AND to the `projects` array in `data.json` immediately
- **Never invent a project name** — if the project isn't in this list and Seb didn't say "new project", ask for confirmation before creating it

**When in doubt, ask:**
- If an entry references a name not in this list, ask Seb: *"I don't recognise [name] — is this a new project, or did you mean [closest match]?"*
- Never silently map an unknown name to an existing project

**Invalid values (not project names):**
- `Office` → NOT a project name — ask Seb what project/category to use
- `Consumables` → NOT a project name — it is an expense category; ask which project the purchase belongs to

---

## Timesheets

**Canonical schema:**

```json
{
  "id": "TS-042",
  "date": "2026-06-06",
  "employee": "Seb",
  "project": "Mark - Nth Balgowlah",
  "hours": 8,
  "rate": 100,
  "value": 800,
  "notes": "Deck framing - joist installation"
}
```

| Field | Type | Rules |
|---|---|---|
| `id` | string | Sequential: `TS-001`, `TS-002`, etc. Never reuse. Check last entry and increment. |
| `date` | string | ISO format: `YYYY-MM-DD` |
| `employee` | string | `Seb` (only employee for now) |
| `project` | string | Must match a name from the Canonical Project Names table above |
| `hours` | number | Decimal allowed (e.g. `3.5`). No string. |
| `rate` | number | Default `100` (Seb's rate ex GST). |
| `value` | number | Always `hours × rate`. Computed, never guessed. |
| `notes` | string | Free text. Empty string `""` if nothing to say. |

**Banned fields** (remove if found): `total_ex_gst`, `logged_via`

---

## Expense Log

**Canonical schema:**

```json
{
  "id": "EXP-042",
  "date": "2026-06-06",
  "supplier": "Bunnings Balgowlah",
  "description": "Deck Screws Titan T25 SS304 10Gx50mm BX1000",
  "category": "Materials",
  "project": "Mark - Nth Balgowlah",
  "qty": 3,
  "unit_price": 86.32,
  "amount": 258.95
}
```

| Field | Type | Rules |
|---|---|---|
| `id` | string | Sequential: `EXP-001`, `EXP-002`, etc. Never reuse. |
| `date` | string | ISO format: `YYYY-MM-DD` |
| `supplier` | string | Name of shop or supplier (e.g. `Bunnings Balgowlah`, `Kimbriki`, `Kennards`) |
| `description` | string | Product name exactly as it appears on the receipt. No quantity in the description — that goes in `qty`. |
| `category` | string | Must match an entry from the Expense Categories table below |
| `project` | string | Must match a name from the Canonical Project List above |
| `qty` | number | Quantity purchased. Default `1` if not specified. |
| `unit_price` | number | Unit price **ex GST**. |
| `amount` | number | Always `qty × unit_price` ex GST. Computed — never guessed independently. |

**Banned fields** (never save these): `total_inc_gst`, `gst`, `total_ex_gst`, `payment_method`, `reference`, `logged_via`

**Capture rules — all input methods:**

These rules apply regardless of how an expense is entered: Claude chat, voice, receipt photo, email drop, or any future method.

- **One entry per product line.** Each distinct product on a receipt becomes its own `EXP-xxx` entry. This builds a price catalog over time.
- **Multi-project receipts.** A single receipt can have items assigned to different projects. Each line item carries its own `project` value — assign based on context (what the item was for).
- **Same date and supplier** across all lines from the same receipt.
- **If project is unknown** for a line item, leave `project` as `""` and flag it for follow-up rather than guessing.

---

## Expense Categories

These are the ONLY valid values for the `category` field in `expense_log`.
They match the Xero chart of accounts so expenses can be reconciled.

| Category | When to use |
|---|---|
| `Materials` | Timber, plasterboard, fixings, adhesives — anything physically installed |
| `Consumables` | Blades, sandpaper, cutting discs, tape — used up on the job |
| `Tools` | Power tools, hand tools, tool accessories |
| `Hire of Plant & Equipment` | Scaffold hire, equipment rental |
| `Motor Vehicles - Fuel & Oil` | Petrol, diesel, oil |
| `Motor Vehicles - Repairs & Maintenance` | Servicing, tyres, repairs |
| `Motor Vehicles - Registration & Insurance` | Rego, CTP, vehicle insurance |
| `Motor Vehicles - Tolls` | Toll road charges |
| `Fines & Penalties` | Parking fines, infringement notices |
| `Subcontractors` | Payments to subbies |
| `Mobile Phone` | Phone bill, accessories |
| `Uniforms` | Work wear, boots, PPE |
| `Accounting & Bookkeeping Fees` | Accountant invoices |
| `Insurance` | Business insurance (non-vehicle) |
| `Subscriptions & Memberships` | Software subscriptions, trade memberships |
| `Advertising & Marketing` | Website, ads |
| `Staff Amenities` | Coffee, food on site |
| `Client Gift` | Gifts to clients |
| `Sundry Expenses` | Anything that doesn't fit above — use sparingly |

**Common mistakes to correct:**
- `Vehicle` → `Motor Vehicles - Fuel & Oil` (or whichever subcategory fits)
- `Disposal` → `Sundry Expenses` (no Xero category for tip runs — or add one)
- `Office` → is NOT a category, it's not a project either — clarify with Seb

---

## Projects

**Canonical schema:**

```json
{
  "id": "PR-001",
  "name": "Mark - Nth Balgowlah",
  "status": "Active",
  "quoted": 39450,
  "notes": "Deck replacement — started May 2026"
}
```

| Field | Type | Rules |
|---|---|---|
| `id` | string | Sequential: `PR-001`, `PR-002`, etc. Never reuse. Permanent — does not change if name changes. |
| `name` | string | Must match Canonical Project List exactly |
| `status` | string | One of: `Active`, `Quoted`, `Completed`, `On Hold` |
| `quoted` | number | Total quoted value ex GST. `0` if no quote issued yet. |
| `notes` | string | Free text. Running log of key milestones, invoice numbers, dates. |

---

## Quotes

**Canonical schema:**

```json
{
  "number": "QU-0045",
  "contact": "Mark - Nth Balgowlah",
  "date": "2026-05-01",
  "status": "ACCEPTED",
  "total": 39450.00,
  "line_items": [
    {
      "desc": "Supply and install new hardwood deck — 45sqm",
      "qty": 1,
      "unit": 39450,
      "total": 39450
    }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `number` | string | Format `QU-XXXX` zero-padded to 4 digits. Matches Xero quote number. |
| `contact` | string | Client name as it appears in Xero |
| `date` | string | ISO format: `YYYY-MM-DD` |
| `status` | string | One of: `DRAFT`, `SENT`, `ACCEPTED`, `DECLINED`, `INVOICED`, `EXPIRED` |
| `total` | number | Total ex GST |
| `line_items` | array | At least one item. See line item schema below. |

**Line item schema:**

| Field | Type | Rules |
|---|---|---|
| `desc` | string | Description of the work or material |
| `qty` | number | Quantity |
| `unit` | number | Unit price ex GST |
| `total` | number | Always `qty × unit` |

---

## Known Dirty Data (fix on next full sync)

These existing entries in `data.json` don't match the canonical schema and should be corrected:

| Table | ID / identifier | Issue | Correct value |
|---|---|---|---|
| timesheets | TS-003 | project: `Mark Shippen – Nth Balgowlah` | `Mark - Nth Balgowlah` |
| timesheets | TS-004 | project: `Mark Shippen – Nth Balgowlah` | `Mark - Nth Balgowlah` |
| timesheets | TS-003, TS-004 | project: `Mark Shippen – Nth Balgowlah` | `Mark - Nth Balgowlah` ✓ Fixed |
| timesheets | TS-008 | project: `Wasted Time` | Valid — PR-007 registered ✓ Fixed |
| timesheets | TS-MOB-1 | project: `IBK – Mosman 2`, uses `total_ex_gst` | Renamed to `IBK - Mosman 2` (PR-006), field → `value` ✓ Fixed |
| timesheets | TS-MOB-2/3/4 | project: `Mark Shippen – Nth Balgowlah`, uses `total_ex_gst` | `Mark - Nth Balgowlah`, field → `value` ✓ Fixed |
| expense_log | EXP-MOB-1a/b/c/d/e | Extra fields, project `Mark Shippen – Nth Balgowlah` | Stripped to 7 fields, project → `Mark - Nth Balgowlah` ✓ Fixed |
| expense_log | 2026-06-04 Kimbriki | project: `Mark - Walkway`, category: `Disposal` | → `Mark - Nth Balgowlah - Walkway` (PR-008), category → `Sundry Expenses` ✓ Fixed |
| expense_log | 2026-05-25 circular saw | project: `Consumables`, category: `Materials` | → project: `Admin`, category: `Consumables` ✓ Fixed |

---

## Xero Sync — How It Works

### Trigger

The "⬇ Sync Xero" button in the Hub calls `syncFromXero()` (in `index.html`), which:

1. Fetches all data from Xero via `xeroApiCall()` → `/.netlify/functions/xero-api` (browser proxy)
2. Downloads the result as `xero_sync_YYYY-MM-DD.json` to your computer
3. You upload that file to Claude and say **"Merge this Xero sync into data.json"**
4. Claude transforms and merges it into `data.json` and pushes to GitHub

### What gets fetched

| Key in sync file | Xero API call | Coverage |
|---|---|---|
| `invoices` | `Invoices?where=Type=="ACCREC"` | Sales invoices, 3 years from Jul 2023 |
| `bills` | `Invoices?where=Type=="ACCPAY"` | Purchase bills, 3 years from Jul 2023 |
| `quotes` | `Quotes` | All quotes, all time |
| `contacts` | `Contacts` | All contacts |
| `bank_transactions` | `BankTransactions` | 3 years from Jul 2023 |
| `accounts` | `Accounts?where=Status=="ACTIVE"` | Chart of accounts |
| `pnl_monthly_3y` | `Reports/ProfitAndLoss?periods=36&timeframe=MONTH` | Monthly P&L, Jul 2023 – Jun 2026 |
| `pnl_fy24` | `Reports/ProfitAndLoss?fromDate=2023-07-01&toDate=2024-06-30` | FY24 annual |
| `pnl_fy25` | `Reports/ProfitAndLoss?fromDate=2024-07-01&toDate=2025-06-30` | FY25 annual |
| `pnl_fy26` | `Reports/ProfitAndLoss?fromDate=2025-07-01&toDate=2026-06-30` | FY26 YTD |
| `balance_sheet` | `Reports/BalanceSheet` | Current |
| `trial_balance` | `Reports/TrialBalance` | Current |
| `journals` | `Journals` | General ledger, all time (if scope allows) |

---

### Financial Year boundaries

| FY | Start | End |
|---|---|---|
| FY24 | 2023-07-01 | 2024-06-30 |
| FY25 | 2024-07-01 | 2025-06-30 |
| FY26 | 2025-07-01 | 2026-06-30 |

**Rule:** Any invoice, transaction, or P&L period with a date in `YYYY-MM` where MM ∈ {07..12} belongs to FY `YYYY+1`, and MM ∈ {01..06} belongs to FY `YYYY`.

---

### P&L Report structure (Xero format)

The Xero P&L report is a nested `Rows` array. Parsing rules:

```
Report.Rows[]
  RowType: "Header"   → column headings (month labels for multi-period, or just "Total")
  RowType: "Section"  → named section (Trading Income, Cost of Sales, Gross Profit, Expenses, Net Profit)
    .Title            → section name string
    .Rows[]           → child rows within section
      RowType: "Row"        → individual account line
        .Cells[0].Value     → account name
        .Cells[1..n].Value  → numeric value per period (or single total)
      RowType: "SummaryRow" → section total
```

**To extract a value:**
1. Find the `Section` with the matching `.Title`
2. Within that section, find the `Row` where `Cells[0].Value` matches the account name
3. Read `Cells[i].Value` where `i` = the period column index (0-based after the label column)

**Negative values:** Xero sometimes returns expenses as negative in P&L rows. Always use `Math.abs()` when storing cost figures.

---

### data.json field sources

| data.json field | Source | Logic |
|---|---|---|
| `monthly.labels[]` | `pnl_monthly_3y` Header row | Extract month label strings from `Cells[].Value` |
| `monthly.periods[]` | `pnl_monthly_3y` Header row | Convert labels to `YYYY-MM` format |
| `monthly.revenue[]` | `pnl_monthly_3y` | Sum all rows in the **Trading Income** section per period |
| `monthly.materials[]` | `pnl_monthly_3y` | Row named **"Materials"** (or **"Cost of Goods Sold"**) in the **Cost of Sales** section |
| `monthly.wages_owner[]` | `pnl_monthly_3y` | Row named **"Wages & Salaries"** or **"Owner's Wages"** in the **Expenses** section |
| `kpis.fy26_revenue` | `pnl_fy26` | SummaryRow of **Trading Income** section — single total cell |
| `kpis.fy26_materials` | `pnl_fy26` | Row **"Materials"** in **Cost of Sales** — single total cell |
| `kpis.fy26_gross_profit` | `pnl_fy26` | SummaryRow of **Gross Profit** section — single total cell |
| `kpis.fy26_gp_margin` | Computed | `(fy26_gross_profit / fy26_revenue) × 100`, rounded to 2dp |
| `kpis.fy26_opex` | `pnl_fy26` | SummaryRow of **Expenses** section — single total cell (abs value) |
| `kpis.fy26_owner_drawings` | `pnl_fy26` | Row for owner wages/drawings in **Expenses** section |
| `kpis.fy26_net_profit` | `pnl_fy26` | SummaryRow of **Net Profit** section — single total cell |
| `kpis.cash_balance` | `balance_sheet` | **Bank** or **Cash** row in Assets section |
| `kpis.total_outstanding` | `invoices` | Sum of `AmountDue` for all ACCREC invoices with `Status == "AUTHORISED"` |
| `kpis.overdue_xero` | `invoices` | Sum of `AmountDue` where `Status == "AUTHORISED"` and `DueDateString < today` |
| `kpis.pipeline_total` | `quotes` | Sum of `SubTotal` for all quotes with `Status` in `["DRAFT","SENT","ACCEPTED"]` |
| `open_invoices[]` | `invoices` | ACCREC invoices with `Status == "AUTHORISED"`, mapped to compact schema |
| `top_customers[]` | `invoices` | All ACCREC invoices, grouped by `Contact.Name`, sum of `SubTotal` per contact, top 10 by revenue |
| `quotes[]` | `quotes` | Full quotes list mapped to compact schema (see Quotes section above) |
| `fy_summary` | `pnl_fy24`, `pnl_fy25`, `pnl_fy26` | Revenue, gross profit, net profit totals per FY |
| `cost_detail_monthly` | `pnl_monthly_3y` | Each named account row in **Expenses** section → array of monthly values |
| `meta.last_updated` | Computed | ISO timestamp of when the merge was run |
| `meta.invoice_count` | `invoices` | `invoices.length` |
| `meta.bank_tx_count` | `bank_transactions` | `bank_transactions.length` |

---

### open_invoices compact schema

Mapped from raw Xero ACCREC invoices with `Status == "AUTHORISED"`:

```json
{
  "invoice": "INV-0042",
  "contact": "Mark Shippen",
  "date": "2026-05-15",
  "due_date": "2026-06-15",
  "amount": 3945.00,
  "amount_due": 3945.00
}
```

| Xero field | data.json field |
|---|---|
| `InvoiceNumber` | `invoice` |
| `Contact.Name` | `contact` |
| `DateString` (slice 0,10) | `date` |
| `DueDateString` (slice 0,10) | `due_date` |
| `SubTotal` | `amount` (ex GST) |
| `AmountDue` | `amount_due` |

**Note:** `days_old` is NOT stored — it is computed dynamically in the browser from `date` vs today's date.

---

### Merge rules — what to overwrite vs preserve

When merging a Xero sync file into `data.json`:

| Section | Rule |
|---|---|
| `monthly.*` | **Replace entirely** — always rebuild from the fresh P&L |
| `kpis.*` | **Replace entirely** — always recompute from fresh P&L + invoices |
| `open_invoices[]` | **Replace entirely** — reflects live Xero state |
| `top_customers[]` | **Replace entirely** |
| `quotes[]` | **Replace entirely** |
| `fy_summary` | **Replace entirely** |
| `cost_detail_monthly` | **Replace entirely** |
| `timesheets[]` | **NEVER touch** — managed by Claude chat only |
| `expense_log[]` | **NEVER touch** — managed by Claude chat only |
| `projects[]` | **NEVER touch** — managed by Claude chat only |
| `meta` | Update `last_updated`, `invoice_count`, `bank_tx_count`; preserve other keys |

---

### P&L account names to watch for (verify from real sync)

These are the expected Xero account names for Matiere Pty Ltd. Confirm on first merge after a reconnect — account names can change if the chart of accounts is edited in Xero.

| data.json field | Expected Xero account name |
|---|---|
| Revenue | `Sales` (in Trading Income) |
| Materials cost | `Materials` (in Cost of Sales) |
| Owner wages | `Wages & Salaries` or `Owner's Wages` (in Expenses) |
| Subcontractors | `Subcontractors` (in Cost of Sales or Expenses) |

---

*Last updated: 2026-06-06 — v4: Xero sync section added (proxy function, fetch inventory, P&L parsing, field mappings, merge rules)*
