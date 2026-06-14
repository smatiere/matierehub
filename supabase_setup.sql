-- ============================================================
-- MatiereHub — Supabase Setup Script
-- Run this entire script in the Supabase SQL Editor once.
-- ============================================================

-- 1. CREATE TABLES

CREATE TABLE IF NOT EXISTS timesheets (
  id          TEXT PRIMARY KEY,
  date        DATE NOT NULL,
  project     TEXT NOT NULL,
  hours       NUMERIC(5,2) NOT NULL,
  rate        NUMERIC(8,2) DEFAULT 100,
  value       NUMERIC(10,2),
  employee    TEXT DEFAULT 'Seb',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expense_log (
  id          TEXT PRIMARY KEY,
  date        DATE NOT NULL,
  supplier    TEXT DEFAULT '',
  description TEXT NOT NULL,
  category    TEXT NOT NULL,
  project     TEXT DEFAULT '',
  qty         NUMERIC(10,3) DEFAULT 1,
  unit_price  NUMERIC(10,2) NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT DEFAULT 'Active',
  quoted      NUMERIC(12,2) DEFAULT 0,
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- xero_cache stores Xero-synced financial data as JSON blobs
-- keys: kpis, monthly, open_invoices, top_customers, quotes, fy_summary, cost_detail_monthly, account_categories, meta
CREATE TABLE IF NOT EXISTS xero_cache (
  key         TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);


-- invoice_items stores line-item history from Xero invoices.
-- Paid amount logic: paid = price_excl_gst × (invoice_amount_paid / invoice_total)
-- i.e. every line item on an invoice shares the same payment percentage.
CREATE TABLE IF NOT EXISTS invoice_items (
  id              TEXT PRIMARY KEY,                  -- e.g. 'II-INV0342-01'
  invoice_number  TEXT NOT NULL,                     -- Xero invoice number, e.g. 'INV-0342'
  item            TEXT NOT NULL DEFAULT '',          -- short item name
  description     TEXT NOT NULL DEFAULT '',          -- full description as shown on Xero
  qty             NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,  -- excl. GST
  price_excl_gst  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- stored: qty × unit_price
  quote_number    TEXT DEFAULT '',                   -- from inv.Reference (e.g. 'QU-0259'); blank when no quote linked
  contact         TEXT NOT NULL DEFAULT '',          -- customer/client name
  contact_id      TEXT DEFAULT '',                   -- Xero ContactID UUID — foreign key for future contacts table (email, suburb, etc.)
  date            DATE,                              -- invoice date
  due_date        DATE,                              -- invoice due date (overdue = status AUTHORISED AND due_date < today)
  status          TEXT DEFAULT '',                   -- e.g. PAID, AUTHORISED, DRAFT, VOIDED
  notes           TEXT DEFAULT '',
  paid            NUMERIC(10,2) DEFAULT 0,           -- line-item share of amount paid
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- contacts table: synced from Xero via xero-sync.js?scope=contacts
-- PK is Xero ContactID UUID — matches invoice_items.contact_id for JOIN queries.
-- categories, rating, note are HUB-only — never touched by the Xero sync.
CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,         -- Xero ContactID UUID
  name          TEXT DEFAULT '',
  first_name    TEXT DEFAULT '',
  last_name     TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  address_line1 TEXT DEFAULT '',
  city          TEXT DEFAULT '',
  region        TEXT DEFAULT '',
  postal_code   TEXT DEFAULT '',
  country       TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  abn           TEXT DEFAULT '',          -- from Xero TaxNumber (ABN or ACN)
  is_customer   BOOLEAN DEFAULT false,    -- from Xero IsCustomer
  is_supplier   BOOLEAN DEFAULT false,    -- from Xero IsSupplier
  categories    TEXT[] DEFAULT '{}',      -- HUB-only; values must exist in category_list
  rating        SMALLINT CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)), -- HUB-only; 0-10
  note          TEXT DEFAULT '',          -- HUB-only; never overwritten by sync
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Added 2026-06-14 (run ALTER TABLE if contacts already exists):
-- ALTER TABLE contacts ADD COLUMN IF NOT EXISTS abn TEXT DEFAULT '';
-- ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_supplier BOOLEAN DEFAULT false;
-- ALTER TABLE contacts ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}';
-- ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10));

-- category_list: lookup table for valid contact categories. Managed via HUB or Supabase directly.
CREATE TABLE IF NOT EXISTS category_list (
  name        TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO category_list (name) VALUES
  ('Hardware'), ('Timber & Sheet'), ('Tools & Equipment'),
  ('Subcontractor'), ('Doors'), ('Professional Services'), ('Docs')
ON CONFLICT (name) DO NOTHING;


-- 2. PERMISSIONS (allow frontend to read without service_role key)

GRANT SELECT ON timesheets    TO anon;
GRANT SELECT ON expense_log   TO anon;
GRANT SELECT ON projects      TO anon;
GRANT SELECT ON xero_cache    TO anon;
GRANT SELECT ON invoice_items TO anon;
GRANT SELECT ON contacts      TO anon;
GRANT SELECT ON category_list TO anon;

-- Allow the service_role (used by Netlify functions) full access
GRANT ALL ON timesheets    TO service_role;
GRANT ALL ON expense_log   TO service_role;
GRANT ALL ON projects      TO service_role;
GRANT ALL ON xero_cache    TO service_role;
GRANT ALL ON invoice_items TO service_role;
GRANT ALL ON contacts      TO service_role;
GRANT ALL ON category_list TO service_role;


-- 3. DISABLE ROW LEVEL SECURITY (single-user app, no auth needed)

ALTER TABLE timesheets    DISABLE ROW LEVEL SECURITY;
ALTER TABLE expense_log   DISABLE ROW LEVEL SECURITY;
ALTER TABLE projects      DISABLE ROW LEVEL SECURITY;
ALTER TABLE xero_cache    DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE contacts      DISABLE ROW LEVEL SECURITY;
ALTER TABLE category_list DISABLE ROW LEVEL SECURITY;


-- 4. MIGRATE EXISTING DATA

-- Timesheets
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-001', '2026-05-25', 'Admin', 6, 100, 600, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-002', '2026-05-25', 'Neil - Balgowlah', 3, 100, 300, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-003', '2026-05-21', 'Mark - Nth Balgowlah', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-004', '2026-05-20', 'Mark - Nth Balgowlah', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-006', '2026-05-26', 'IBK - Mosman', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-007', '2026-05-27', 'IBK - Mosman', 6, 100, 600, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-008', '2026-05-27', 'Wasted Time', 3, 100, 300, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-009', '2026-05-28', 'Admin', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-MOB-1', '2026-06-01', 'IBK - Mosman 2', 3, 100, 300, 'Seb', 'New project – client TBC') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-MOB-2', '2026-06-01', 'Mark - Nth Balgowlah', 5, 100, 500, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-MOB-3', '2026-06-02', 'Mark - Nth Balgowlah', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-MOB-4', '2026-06-03', 'Mark - Nth Balgowlah', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-010', '2026-05-29', 'Admin', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-011', '2026-06-04', 'Mark - Nth Balgowlah - Walkway', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-012', '2026-06-05', 'Mark - Nth Balgowlah - Walkway', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;
INSERT INTO timesheets (id, date, project, hours, rate, value, employee, notes) VALUES ('TS-013', '2026-05-22', 'Mark - Nth Balgowlah', 8, 100, 800, 'Seb', '') ON CONFLICT (id) DO NOTHING;

-- Expenses
INSERT INTO expense_log (id, date, supplier, description, category, project, qty, unit_price, amount) VALUES ('EXP-MOB-1a', '2026-06-03', 'Bunnings Balgowlah', 'Deck Screws Titan T25 SS304 10Gx50mm BX1000', 'Materials', 'Mark - Nth Balgowlah', 1, 235.41, 258.95) ON CONFLICT (id) DO NOTHING;
INSERT INTO expense_log (id, date, supplier, description, category, project, qty, unit_price, amount) VALUES ('EXP-MOB-1b', '2026-06-03', 'Bunnings Balgowlah', 'Sika Construction Adhesive 300g Instant Nails', 'Materials', 'Mark - Nth Balgowlah', 1, 13.78, 15.16) ON CONFLICT (id) DO NOTHING;
INSERT INTO expense_log (id, date, supplier, description, category, project, qty, unit_price, amount) VALUES ('EXP-MOB-1c', '2026-06-03', 'Bunnings Balgowlah', 'Hose Connector Plastic Holman 12mm Flow Grip N Lock', 'Materials', 'Mark - Nth Balgowlah', 1, 4.13, 4.54) ON CONFLICT (id) DO NOTHING;
INSERT INTO expense_log (id, date, supplier, description, category, project, qty, unit_price, amount) VALUES ('EXP-MOB-1d', '2026-06-03', 'Bunnings Balgowlah', 'Cable Mgmt Label Straps Cordtech 300mm Cinch', 'Materials', 'Mark - Nth Balgowlah', 1, 5.15, 5.67) ON CONFLICT (id) DO NOTHING;
INSERT INTO expense_log (id, date, supplier, description, category, project, qty, unit_price, amount) VALUES ('EXP-MOB-1e', '2026-06-03', 'Bunnings Balgowlah', 'Cable Tie Releasable 100mm Black 25pk', 'Materials', 'Mark - Nth Balgowlah', 1, 1.89, 2.08) ON CONFLICT (id) DO NOTHING;

-- Projects
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-001', 'Mark - Nth Balgowlah', 'Active', 39450, 'Active project') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-002', 'Rob - Balgowlah', 'Active', 2035, 'Active project') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-003', 'IBK - Mosman', 'Active', 1248.5, 'IBK (Ibathrooms and kitchen renovations pty Ltd). INV-0343 raised 2026-05-27') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-004', 'Neil - Balgowlah', 'Active', 495, 'INV-0342 raised 2026-05-25') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-005', 'Admin', 'Ongoing', 0, 'Non-billable internal time') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-006', 'IBK - Mosman 2', 'Active', 0, 'Second engagement with IBK') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-007', 'Wasted Time', 'Ongoing', 0, 'Non-billable tracking') ON CONFLICT (id) DO NOTHING;
INSERT INTO projects (id, name, status, quoted, notes) VALUES ('PR-008', 'Mark - Nth Balgowlah - Walkway', 'Active', 0, 'Walkway sub-job under Mark Shippen engagement') ON CONFLICT (id) DO NOTHING;
