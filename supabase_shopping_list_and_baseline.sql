-- ============================================================
-- MatiereHub — Shopping List + Job Baseline
-- Run this entire script in the Supabase SQL Editor once, before/at deploy.
-- ============================================================

-- 1. Shopping lists — one row per job's materials list, items as JSONB so the
--    whole checklist (name/qty/checked) can be PATCHed in one write from the
--    Hub or from the create_quote MCP tool. No separate line-items table —
--    matches the "shopping list deliverable" Seb described: client/job at the
--    top, then materials to buy, ticked off from his phone as he shops.
CREATE TABLE IF NOT EXISTS shopping_lists (
  id          TEXT PRIMARY KEY,            -- e.g. 'SL-001'
  project     TEXT DEFAULT '',             -- job/project reference (matches projects.name where possible)
  title       TEXT DEFAULT '',             -- short job description, e.g. "Mark Shippen — materials"
  items       JSONB NOT NULL DEFAULT '[]', -- [{ "name": "...", "qty": "...", "checked": false }, ...]
  status      TEXT DEFAULT 'open',         -- open | done
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT ON shopping_lists TO anon;
GRANT ALL    ON shopping_lists TO service_role;
ALTER TABLE shopping_lists DISABLE ROW LEVEL SECURITY;

-- 2. Job-status baseline — extends the existing projects table rather than a
--    new table (a baseline IS a project, just at "quoted" stage). Captures
--    what was quoted (scope, price, labour/materials estimate) so it can be
--    compared against actuals (timesheets.hours, expense_log.amount) once the
--    job is done, to see whether it ran on-budget, over/under on materials,
--    or over/under on time. 'Quoted' becomes a new status value alongside the
--    existing Active/Finished/Paid/Inactive.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_scope TEXT DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_price NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_labour_hours NUMERIC(8,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_materials_estimate NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_set_at TIMESTAMPTZ;

-- No new GRANT/RLS statements needed for projects — already open to anon
-- (SELECT) / service_role (ALL) and RLS already disabled (supabase_setup.sql).
