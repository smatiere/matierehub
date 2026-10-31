-- ============================================================
-- MatiereHub — Schedule / pipeline (bookings)
-- Run this entire script in the Supabase SQL Editor once.
-- One row per job to be scheduled. Created when a quote is approved
-- (Xero or direct in the Hub); dates, constraints and the client
-- message log live here.
-- ============================================================

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,            -- e.g. 'BK-001' (generated server-side)
  project        TEXT DEFAULT '',             -- matches projects.name where possible
  title          TEXT DEFAULT '',             -- short job description
  quote_number   TEXT DEFAULT '',             -- e.g. 'QU-0259' when it came from a Xero quote
  approval_source TEXT DEFAULT 'hub',         -- 'xero' | 'hub'
  approved_at    DATE,
  status         TEXT DEFAULT 'approved',     -- approved | tentative | confirmed | in_progress | done | cancelled
  client_name    TEXT DEFAULT '',
  client_phone   TEXT DEFAULT '',
  client_email   TEXT DEFAULT '',
  site_address   TEXT DEFAULT '',
  lat            NUMERIC(9,6),                -- geocoded from site_address (travel-time estimate)
  lng            NUMERIC(9,6),
  env            TEXT DEFAULT 'indoor',       -- indoor | outdoor | both
  priority       INT  DEFAULT 2,              -- 1 high, 2 normal, 3 low
  hours          NUMERIC(7,2),                -- labour hours needed
  hours_per_day  NUMERIC(4,2) DEFAULT 8,
  start_date     DATE,
  start_time     TEXT DEFAULT '07:00',
  end_date       DATE,
  window_days    INT DEFAULT 0,               -- 0 = exact date; 2-3 = tell the client a window
  constraints    JSONB NOT NULL DEFAULT '[]', -- [{id,type,label,ready_date,confirmed,done}]
  notify_log     JSONB NOT NULL DEFAULT '[]', -- [{at,kind,channel,text,start_date}]
  notified_start DATE,                        -- start_date the client was last told
  notes          TEXT DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

GRANT SELECT ON bookings TO anon;
GRANT ALL    ON bookings TO service_role;
ALTER TABLE bookings DISABLE ROW LEVEL SECURITY;
