-- ============================================================
-- Roybal Field Forms — cloud sync schema
-- SAFE to run in your EXISTING Supabase project. It only adds new
-- objects (a "field_projects" table + a "field-media" storage bucket)
-- and does NOT touch any tables from the old Restoration app.
-- Run it once: Supabase Dashboard → SQL Editor → paste → Run.
-- ============================================================

create extension if not exists pgcrypto;

-- One row per job. The whole job (forms, moisture, drying, contents, …)
-- is stored as JSON, mirroring exactly what the field app keeps on-device.
create table if not exists public.field_projects (
  id          uuid primary key,
  data        jsonb       not null,
  deleted     boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Always stamp updated_at on the server so "pull everything changed since X"
-- is reliable regardless of device clocks.
create or replace function public.field_projects_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_field_projects_touch on public.field_projects;
create trigger trg_field_projects_touch
  before insert or update on public.field_projects
  for each row execute function public.field_projects_touch();

create index if not exists field_projects_updated_idx
  on public.field_projects (updated_at);

-- Row Level Security: the crew shares one login, so any signed-in user
-- may read/write all field projects (single-company account).
alter table public.field_projects enable row level security;

drop policy if exists field_projects_all on public.field_projects;
create policy field_projects_all on public.field_projects
  for all to authenticated
  using (true) with check (true);

-- Private bucket for media (photos, signatures, floor plans) — used in the
-- next sync stage so large images don't bloat the JSON rows.
insert into storage.buckets (id, name, public)
values ('field-media', 'field-media', false)
on conflict (id) do nothing;

drop policy if exists field_media_rw on storage.objects;
create policy field_media_rw on storage.objects
  for all to authenticated
  using (bucket_id = 'field-media')
  with check (bucket_id = 'field-media');
