-- ============================================================
-- Roybal — QuickBooks Time on the FIELD / BOARD line
-- Re-points the QB Time tables (from migration 003, which targeted the
-- old React `apps/web` schema: `jobs` + is_admin()) at THIS line's auth
-- model: a single shared crew login, RLS = "any authenticated user".
-- Mirrors 102_time_entries.sql. Safe & additive — run once in the
-- Supabase SQL Editor. Requires 003 (the tables) to exist.
--
-- NOTE: 003 also ran `alter table jobs add column qb_jobcode_id` — that
-- `jobs` table does NOT exist on this line, so 003 will have failed at
-- that statement. Create the two tables directly here if they're absent,
-- then set the field-line policies. Idempotent.
--
-- How a job links to QB Time on this line: there is NO join column. The
-- field project blob (field_projects.data) carries `qbJobcodeId`, and QB
-- hours land in `time_entries` tagged with that same jobcode id + date.
-- ============================================================

-- ---- tables (create if 003 didn't land on this project) ----
create table if not exists public.qb_time_tokens (
  id            uuid primary key default gen_random_uuid(),
  realm_id      text not null unique,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,
  connected_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.qb_time_jobcodes (
  id           uuid primary key default gen_random_uuid(),
  qb_id        text not null unique,
  name         text not null,
  parent_id    text,
  jobcode_type text,
  active       boolean not null default true,
  synced_at    timestamptz not null default now()
);

-- ---- RLS: replace the is_admin() policies from 003 ----
alter table public.qb_time_tokens   enable row level security;
alter table public.qb_time_jobcodes enable row level security;

-- tokens: never exposed to the browser. The qb-time-proxy Edge Function
-- reads/writes them with the service role (bypasses RLS). Deny the
-- authenticated role entirely so the publishable key can't read secrets.
drop policy if exists "Admin can manage QB Time tokens"            on public.qb_time_tokens;
drop policy if exists "Authenticated users can read QB Time jobcodes" on public.qb_time_jobcodes;
drop policy if exists "Admin can manage QB Time jobcodes"          on public.qb_time_jobcodes;
drop policy if exists qb_time_tokens_none    on public.qb_time_tokens;
drop policy if exists qb_time_jobcodes_read  on public.qb_time_jobcodes;
create policy qb_time_tokens_none on public.qb_time_tokens
  for all to authenticated using (false) with check (false);

-- jobcodes: the crew login needs to LIST them (to link a job to a code)
-- but only the service-role sync writes them. Read-only for authenticated.
create policy qb_time_jobcodes_read on public.qb_time_jobcodes
  for select to authenticated using (true);

-- ============================================================
-- time_entries.data shape (JSONB — no DDL change; documented here)
-- Manual crew rows (from the Board) keep their original shape and are
-- treated as source:'manual'. QB-sourced rows add:
--   {
--     id, jobId,            -- jobId = the field project id these hours belong to
--     fieldProjectId,       -- same as jobId (explicit)
--     qbJobcodeId,          -- the QB Time jobcode (the real join key)
--     jobcodeName,
--     date,                 -- YYYY-MM-DD (the work day)
--     employee,             -- "First Last" from QB
--     task,                 -- QB timesheet notes (falls back to jobcode name)
--     start, finish,        -- HH:MM local wall-clock as recorded in QB
--     hours,                -- QB duration / 3600
--     source: 'qbtime',
--     qbTimesheetId,        -- stable QB id → idempotent re-pull
--     qbUserId,
--     enteredBy: 'quickbooks-time',
--     createdAt, updatedAt
--   }
-- Idempotency: the proxy reuses the existing row id for a given
-- qbTimesheetId, so re-pulling a day updates in place (no duplicates).
-- ============================================================
