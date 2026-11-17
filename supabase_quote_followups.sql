-- ============================================================
-- MatiereHub — Quote follow-ups
-- One row per sent quote Seb wants to nudge. Created when he sets, snoozes or
-- closes a follow-up; quotes with no row use the default (quote date + 2 weeks).
-- Private: row security ON, no public policy. Read via hub-read, write via hub-write.
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_followups (
  id            TEXT PRIMARY KEY,          -- the quote number, e.g. 'QU-0259'
  contact       TEXT DEFAULT '',
  status        TEXT DEFAULT 'open',       -- open | won | lost | stopped
  due_date      DATE,                      -- when to send the next nudge
  nudges        INT  DEFAULT 0,            -- how many nudges have been sent
  last_nudged   DATE,
  note          TEXT DEFAULT '',           -- e.g. 'Dan: will look again in the new year'
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE quote_followups ENABLE ROW LEVEL SECURITY;
