-- 2026-11-05: Receipt Inbox — every receipt (photo, upload, email) lands here until sorted.
create table if not exists receipt_inbox (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',            -- pending | processed | personal
  source text not null default 'upload',             -- upload | photo | email
  file_path text not null, file_name text default '', mime text default '', size int default 0,
  file_hash text unique,
  received_at timestamptz default now(),
  email_from text default '', email_subject text default '', email_date date,
  supplier text default '', receipt_date date, total_inc numeric(12,2),
  lines jsonb not null default '[]'::jsonb,           -- parsed lines (ex GST)
  check_info jsonb,
  project text default '', no_project boolean default false,
  expense_ids jsonb not null default '[]'::jsonb,
  xero_txn_id text default '', xero_attached boolean default false,
  notes text default '',
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table receipt_inbox enable row level security;   -- no policies: only the gated function (service key) can read it
grant all on receipt_inbox to service_role;
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false) on conflict (id) do nothing;
