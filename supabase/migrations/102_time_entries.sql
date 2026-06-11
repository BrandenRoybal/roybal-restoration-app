-- ============================================================
-- Roybal — Time entries (hours logged per job, per crew member)
-- Stage 2 of the Job Board: estimated-vs-actual hours + labor
-- allocation. One row per logged time entry.
-- JSONB + last-edit-wins, mirroring coordination_jobs.
-- Reuses the coordination_touch() trigger fn from migration 101,
-- so RUN 101 FIRST. Safe & additive.
-- Run once: Supabase Dashboard → SQL Editor → paste → Run.
--
-- data shape: { id, jobId, crewId, date (YYYY-MM-DD), hours (number),
--               note, enteredBy (email), createdAt, updatedAt }
-- ============================================================

create table if not exists public.time_entries (
  id          uuid primary key,
  data        jsonb       not null,
  deleted     boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_time_entries_touch on public.time_entries;
create trigger trg_time_entries_touch
  before insert or update on public.time_entries
  for each row execute function public.coordination_touch();

create index if not exists time_entries_updated_idx
  on public.time_entries (updated_at);

alter table public.time_entries enable row level security;
drop policy if exists time_entries_all on public.time_entries;
create policy time_entries_all on public.time_entries
  for all to authenticated
  using (true) with check (true);
