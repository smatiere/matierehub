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
