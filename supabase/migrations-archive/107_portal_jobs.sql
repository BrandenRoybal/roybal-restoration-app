-- ============================================================
-- Roybal — portal_jobs: the customer-safe projection of a job.
-- One row per job the office has shared to the customer portal
-- (portal.roybalconstruction.com). Holds ONLY the curated slice the
-- customer may see — status, milestones, shared photo/document
-- references. Internal data (costs, adjuster notes, Field Reports) is
-- never written here, so the portal cannot reach it.
--
-- Access (Phase A):
--   * Crew (authenticated) publish + manage these rows via REST.
--   * Customers have NO direct table access. They present a random,
--     revocable share_token to the `roybal-portal` edge function, which
--     returns the slice (and signed URLs for the referenced media). The
--     token is the bearer credential.
--   * Phase B ADDS a portal_access(user_id, portal_job_id) map + an RLS
--     policy letting a logged-in customer select their own row — an
--     addition, not a change to this table.
--
-- SAFE & additive. Run once: Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.portal_jobs (
  id               uuid primary key default gen_random_uuid(),
  field_project_id uuid,                                   -- source field job (soft link)
  unified_job_id   uuid,                                   -- job spine (soft link, like sms_messages)
  share_token      text not null unique,                   -- random, revocable; the Phase-A credential
  enabled          boolean not null default true,          -- office on/off switch
  customer_name    text not null default '',
  property_address text not null default '',
  status           text not null default '',               -- current milestone key
  milestones       jsonb not null default '[]'::jsonb,     -- [{key,label,state,at}]
  photos           jsonb not null default '[]'::jsonb,     -- [{mediaHash,caption,stage}] — references, not image data
  documents        jsonb not null default '[]'::jsonb,     -- [{label,type,mediaHash}] — reserved for a later chunk
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists portal_jobs_project_idx on public.portal_jobs (field_project_id);
create index if not exists portal_jobs_token_idx   on public.portal_jobs (share_token);
create index if not exists portal_jobs_updated_idx on public.portal_jobs (updated_at);

-- Always stamp updated_at server-side.
create or replace function public.portal_jobs_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_portal_jobs_touch on public.portal_jobs;
create trigger trg_portal_jobs_touch
  before insert or update on public.portal_jobs
  for each row execute function public.portal_jobs_touch();

-- Row Level Security: crew (the shared company login) may read/write; the
-- anon role gets nothing. Customers never hit this table directly — the
-- roybal-portal edge function serves them by share_token.
alter table public.portal_jobs enable row level security;
drop policy if exists portal_jobs_all on public.portal_jobs;
create policy portal_jobs_all on public.portal_jobs
  for all to authenticated
  using (true) with check (true);
