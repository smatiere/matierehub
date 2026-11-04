-- 2026-11-05: site address on each project card (filled from the Xero contact / quote).
-- Run once in the Supabase SQL editor.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_address TEXT DEFAULT '';
