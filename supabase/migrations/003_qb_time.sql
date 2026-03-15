-- ============================================================
-- QuickBooks Time Integration Schema
-- ============================================================

-- QB Time OAuth tokens (one row per connected company)
create table qb_time_tokens (
  id            uuid primary key default gen_random_uuid(),
  realm_id      text not null unique,     -- Intuit company/realm ID
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  connected_by  uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger qb_time_tokens_updated_at
  before update on qb_time_tokens
  for each row execute function touch_updated_at();

-- Cache of QB Time job codes (synced from QB Time account)
create table qb_time_jobcodes (
  id           uuid primary key default gen_random_uuid(),
  qb_id        text not null unique,      -- QB Time jobcode ID
  name         text not null,
  parent_id    text,                      -- parent jobcode QB ID (for nested codes)
  jobcode_type text,                      -- 'regular', 'pto', 'paid_holiday', 'unpaid_time_off', etc.
  active       boolean not null default true,
  synced_at    timestamptz not null default now()
);

-- Link a job to a QB Time jobcode (so time entries roll up to that job)
alter table jobs add column if not exists qb_jobcode_id text;

-- RLS
alter table qb_time_tokens    enable row level security;
alter table qb_time_jobcodes  enable row level security;

create policy "Admin can manage QB Time tokens"
  on qb_time_tokens for all using (is_admin());

create policy "Authenticated users can read QB Time jobcodes"
  on qb_time_jobcodes for select using (auth.uid() is not null);

create policy "Admin can manage QB Time jobcodes"
  on qb_time_jobcodes for all using (is_admin());
