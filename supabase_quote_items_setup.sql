-- MatiereHub — quote_items table (2026-06-30 batch)
-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- Idempotent — safe to re-run.
--
-- Why this table exists: the Projects tab needs to link specific QUOTE line items
-- to a project, the same way invoice_items.project already links invoice lines
-- (see supabase_feature_updates.sql, Feature 3). Until now, quotes only existed as
-- a flat JSON blob in xero_cache.quotes with NO per-line stable id — fine for the
-- read-only Quotes & Pricing tab, but not enough to hand-link one quote line to one
-- project. This table mirrors invoice_items exactly: one row per Xero quote line
-- item, keyed on Xero's LineItemID (stable even if lines are reordered).
--
-- `project` is a HUB-only column — like invoice_items.project, it must NEVER be
-- included in the xero-sync.js upsert payload, or Supabase's merge-duplicates will
-- wipe every hand-link on the next sync run.

CREATE TABLE IF NOT EXISTS quote_items (
  id              TEXT PRIMARY KEY,                  -- Xero LineItemID; fallback 'QU-XXXX-01'
  quote_number    TEXT NOT NULL DEFAULT '',          -- e.g. 'QU-0259'
  item            TEXT NOT NULL DEFAULT '',          -- short item code, often blank
  description     TEXT NOT NULL DEFAULT '',          -- full description as shown on Xero
  qty             NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(10,2) NOT NULL DEFAULT 0,  -- excl. GST
  line_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,  -- excl. GST, Xero's stored LineAmount
  contact         TEXT NOT NULL DEFAULT '',
  contact_id      TEXT DEFAULT '',                   -- Xero ContactID UUID — FK to contacts.id
  date            DATE,                               -- quote date
  expiry_date     DATE,
  status          TEXT DEFAULT '',                   -- DRAFT, SENT, ACCEPTED, DECLINED, INVOICED, DELETED
  project         TEXT NOT NULL DEFAULT '',          -- HUB-only — never synced, see note above
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quote_items_project      ON quote_items (project);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote_number ON quote_items (quote_number);

GRANT SELECT ON quote_items TO anon;
GRANT ALL    ON quote_items TO service_role;

ALTER TABLE quote_items DISABLE ROW LEVEL SECURITY;
