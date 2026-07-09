-- supabase_scope_of_work.sql
-- Run once in the Supabase SQL editor (or via Claude-in-Chrome the same way
-- supabase_quote_items_setup.sql was run on 2026-06-30).
--
-- Adds a free-text "Scope of Work" field to the projects table so Seb can note
-- what's actually being done on a job. Shown as a small collapsed/expandable
-- textarea in the Projects tab detail modal (index.html, showProjectDetail).
-- Editable via the HUB (hub-write.js WRITABLE.projects now includes
-- 'scope_of_work') — never touched by the Xero sync, so nothing will overwrite it.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS scope_of_work TEXT DEFAULT '';
