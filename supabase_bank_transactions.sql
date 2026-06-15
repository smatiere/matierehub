-- ─────────────────────────────────────────────────────────────────────────────
-- bank_transactions table
-- One row per Xero bank transaction (not per line item).
-- Synced via xero-sync.js?scope=bank_transactions
-- Primary key = BankTransactionID (Xero UUID) — safe to re-run (upsert).
--
-- expense_log_id: nullable link to the expense_log table for manual matching.
-- Auto-matching logic (date + supplier + amount) can be layered on later.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_transactions (
  id              TEXT PRIMARY KEY,                          -- BankTransactionID (Xero UUID)
  date            DATE,                                      -- transaction date
  type            TEXT,                                      -- SPEND | RECEIVE
  contact         TEXT        DEFAULT '',                    -- Contact.Name
  contact_id      TEXT        DEFAULT '',                    -- Contact.ContactID (FK → contacts.id)
  account_code    TEXT        DEFAULT '',                    -- first line item account code (e.g. "310")
  account_name    TEXT        DEFAULT '',                    -- resolved account name (e.g. "Materials")
  description     TEXT        DEFAULT '',                    -- line item description(s), joined with " | "
  reference       TEXT        DEFAULT '',                    -- Xero Reference field
  gross           NUMERIC(10,2) DEFAULT 0,                  -- Total incl. GST
  tax             NUMERIC(10,2) DEFAULT 0,                  -- TotalTax (GST component)
  net             NUMERIC(10,2) DEFAULT 0,                  -- SubTotal excl. GST
  debit           NUMERIC(10,2) DEFAULT 0,                  -- gross if SPEND, else 0 (money out)
  credit          NUMERIC(10,2) DEFAULT 0,                  -- gross if RECEIVE, else 0 (money in)
  bank_account    TEXT        DEFAULT '',                    -- bank account name (e.g. "Business Account")
  status          TEXT        DEFAULT '',                    -- AUTHORISED | DELETED
  is_reconciled   BOOLEAN     DEFAULT FALSE,
  expense_log_id  INTEGER,                                   -- optional link to expense_log.id (manual or auto-matched)
  project         TEXT        DEFAULT '',                    -- HUB-only: project this tx belongs to (never overwritten by sync)
  notes           TEXT        DEFAULT '',                    -- HUB-only: free text note (never overwritten by sync)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for common query patterns
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date        ON bank_transactions (date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_type        ON bank_transactions (type);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_contact_id  ON bank_transactions (contact_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_code ON bank_transactions (account_code);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_expense_log ON bank_transactions (expense_log_id) WHERE expense_log_id IS NOT NULL;

-- Enable row-level security (match pattern used by other tables)
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;

-- Allow the service role (used by xero-sync.js and claude-parse.js) full access
CREATE POLICY "service_role_all" ON bank_transactions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- If the table already exists (run on 2026-06-14), add the HUB-only columns:
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS project TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS notes   TEXT DEFAULT '';
