-- ============================================================
-- Roybal — Job Coordination schema (the digital whiteboard)
-- Adds two NEW tables used by the Job Board app (apps/board):
--   coordination_jobs  — one row per scheduled job (any type:
--                        remodel, new build, water mitigation, …)
--   crew_members       — the crew roster (assignment + tap-to-call,
--                        and an optional hourly_rate for future cost)
-- Both are JSONB + last-edit-wins, mirroring field_projects exactly.
-- SAFE & additive: does NOT touch field_projects or any other table.
-- Run once: Supabase Dashboard → SQL Editor → paste → Run.
-- ============================================================

create extension if not exists pgcrypto;

-- Stamp updated_at on the server so multi-device "last edit wins" is
-- reliable regardless of device clocks. Shared by both tables below.
create or replace function public.coordination_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- coordination_jobs — one row per job on the board
-- ------------------------------------------------------------
create table if not exists public.coordination_jobs (
  id          uuid primary key,
  data        jsonb       not null,
  deleted     boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_coordination_jobs_touch on public.coordination_jobs;
create trigger trg_coordination_jobs_touch
  before insert or update on public.coordination_jobs
  for each row execute function public.coordination_touch();

create index if not exists coordination_jobs_updated_idx
  on public.coordination_jobs (updated_at);

alter table public.coordination_jobs enable row level security;
drop policy if exists coordination_jobs_all on public.coordination_jobs;
create policy coordination_jobs_all on public.coordination_jobs
  for all to authenticated
  using (true) with check (true);

-- ------------------------------------------------------------
-- crew_members — the roster (9-person crew)
-- ------------------------------------------------------------
create table if not exists public.crew_members (
  id          uuid primary key,
  data        jsonb       not null,
  deleted     boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_crew_members_touch on public.crew_members;
create trigger trg_crew_members_touch
  before insert or update on public.crew_members
  for each row execute function public.coordination_touch();

create index if not exists crew_members_updated_idx
  on public.crew_members (updated_at);

alter table public.crew_members enable row level security;
drop policy if exists crew_members_all on public.crew_members;
create policy crew_members_all on public.crew_members
  for all to authenticated
  using (true) with check (true);
