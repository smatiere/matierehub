-- ============================================================
-- MatiereHub — usage tracking (which tabs and buttons get used)
-- Run this entire script in the Supabase SQL Editor once.
-- No personal data: only the tab name, a button's function name,
-- device type and a random per-visit id. No client names or text.
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_events (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ DEFAULT NOW(),
  session    TEXT,
  device     TEXT,            -- iphone | ipad | mac | android | other
  standalone BOOLEAN,         -- true = opened from the Home Screen icon
  tab        TEXT,            -- tab the person was on
  kind       TEXT,            -- open | view | tap
  name       TEXT             -- tab name (view) or button function (tap)
);
CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts DESC);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;   -- no anon access at all
GRANT ALL ON usage_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE usage_events_id_seq TO service_role;
