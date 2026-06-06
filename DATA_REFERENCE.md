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
  "description": "Deck screws SS304 10Gx50mm BX1000 (x3)",
  "category": "Materials",
  "project": "Mark - Nth Balgowlah",
  "amount": 258.95
}
```

| Field | Type | Rules |
|---|---|---|
| `id` | string | Sequential: `EXP-001`, `EXP-002`, etc. Never reuse. |
| `date` | string | ISO format: `YYYY-MM-DD` |
| `supplier` | string | Name of shop or supplier (e.g. `Bunnings Balgowlah`, `Kimbriki`, `Kennards`) |
| `description` | string | What was bought. Be specific enough to justify the expense. |
| `category` | string | Must match an entry from the Expense Categories table below |
| `project` | string | Must match a name from the Canonical Project Names table above |
| `amount` | number | Amount **ex GST** in AUD. Always ex GST. |

**Banned fields** (strip from receipt captures before saving): `qty`, `unit_price`, `total_inc_gst`, `gst`, `total_ex_gst`, `payment_method`, `reference`, `logged_via`

**Note on receipt photo capture:** When Seb photos a receipt, Claude Haiku will extract multiple line items from it. Each line item becomes a separate `expense_log` entry with its own `EXP-xxx` id, all sharing the same date and supplier.

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

*Last updated: 2026-06-06 — v2: flexible project naming, PR-xxx primary keys, ask-before-assuming rule*
