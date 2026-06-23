-- MatiereHub — schema additions for the 2026-06-24 feature batch
-- Run once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- All columns are idempotent (IF NOT EXISTS) and safe to re-run.
--
-- These are HUB-only columns. They are NEVER included in the Xero sync upsert
-- payloads (xero-sync.js), so — exactly like invoice_items.notes — Supabase's
-- merge-duplicates only touches columns present in the sync payload, and these
-- survive every future sync run untouched.

-- Feature 3 — hand-link specific invoice line items to a project.
-- Blank by default; set to a project name via the HUB to attribute that line's
-- revenue to a project (overrides the client-name auto-match for that project).
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS project TEXT DEFAULT '';

-- Feature 3 — manual cash revenue for a project when no Xero invoice/quote exists.
-- One figure + an optional note per project.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS manual_revenue NUMERIC DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS manual_revenue_note TEXT DEFAULT '';

-- (Optional, future-proofing) helps querying linked lines quickly.
CREATE INDEX IF NOT EXISTS idx_invoice_items_project ON invoice_items (project);

-- Feature 2 — "Eléa's bed" has no project number.
-- Cause: it exists ONLY as a project name on expense_log rows; there is no row in
-- the projects table, so the HUB renders its ID as "#—". This backfills a proper
-- PR-### row (matching the exact existing name) so it gets a project number and can
-- carry an est. value / manual revenue. Safe + idempotent (won't duplicate).
INSERT INTO projects (id, name, status, quoted, notes)
SELECT 'PR-' || LPAD((COALESCE(MAX(CAST(NULLIF(regexp_replace(id, '\D', '', 'g'), '') AS INTEGER)), 0) + 1)::text, 3, '0'),
       'Eléa''s bed', 'Active', 0, 'Backfilled 2026-06-24 — previously existed only in expenses'
FROM projects
HAVING NOT EXISTS (SELECT 1 FROM projects WHERE lower(name) = lower('Eléa''s bed'));
