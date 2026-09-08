-- ============================================================
-- Roybal — portal_selections: the decisions a customer gets to make.
--
-- One row per DECISION (not per estimate line). The office imports the
-- Xactimate "Export to Excel" of an approved reconstruction estimate;
-- apps/field/js/xactimate.js works out which put-back lines a homeowner
-- can actually choose about and collapses them — carpet and its pad into
-- one, baseboard across ten rooms into one, both toilets into one.
--
-- What is NOT here, deliberately:
--   * No Xactimate price list. The like-kind-and-quality baseline is
--     whatever THIS job's approved estimate says, carried in lkq_* below.
--   * No scope lines. Extraction, demo, drywall board and paint masking
--     are not choices and never reach this table.
--
-- `selection_id` is deterministic (e.g. 'flooring--living-room'), so a
-- re-import of a revised estimate updates decisions in place instead of
-- orphaning a customer's picks.
--
-- Access mirrors portal_jobs: crew (authenticated) read/write over REST;
-- customers have NO direct table access and reach their sheet only
-- through the roybal-portal edge function, by share_token.
--
-- SAFE & additive. Run once: Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================

create table if not exists public.portal_selections (
  id               uuid primary key default gen_random_uuid(),
  portal_job_id    uuid not null,                          -- portal_jobs.id (= portalShare.id)

  selection_id     text not null,                          -- deterministic, e.g. 'flooring--living-room'
  sort_order       integer not null default 0,

  -- what the decision is
  type             text not null default '',               -- flooring | cabinets | paint | trim | ...
  label            text not null default '',               -- "Flooring"
  scope            text not null default 'room',           -- room | house | item
  room             text not null default '',
  room_key         text not null default '',
  rooms            jsonb not null default '[]'::jsonb,     -- every room this decision touches
  title            text not null default '',               -- "Living Room — Flooring"

  -- the like-kind-and-quality baseline, straight off the approved estimate
  descr            text not null default '',               -- primary item's description
  cat              text not null default '',               -- Xactimate category, kept as an interop key
  sel              text not null default '',               -- Xactimate selector
  qty              numeric(12,2),
  unit             text not null default '',
  lkq_unit_cost    numeric(12,2),                          -- loaded unit price for the primary item
  lkq_total        numeric(12,2),                          -- whole decision, the credit basis
  waste_pct        numeric(5,2),                           -- FCC/FCV exclude waste from unit price
  items            jsonb not null default '[]'::jsonb,     -- per-catalog-item rollup

  -- the customer's answer (null until they choose)
  chosen_option_id text,
  chosen_label     text,
  delta_cents      integer not null default 0,             -- their cost above LKQ; 0 = fully covered
  chosen_at        timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (portal_job_id, selection_id)
);

create index if not exists portal_selections_job_idx
  on public.portal_selections (portal_job_id, sort_order);

-- Unanswered decisions, for the office nudge.
create index if not exists portal_selections_pending_idx
  on public.portal_selections (portal_job_id)
  where chosen_option_id is null;

create or replace function public.portal_selections_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_portal_selections_touch on public.portal_selections;
create trigger trg_portal_selections_touch
  before insert or update on public.portal_selections
  for each row execute function public.portal_selections_touch();

alter table public.portal_selections enable row level security;
drop policy if exists portal_selections_all on public.portal_selections;
create policy portal_selections_all on public.portal_selections
  for all to authenticated
  using (true) with check (true);

-- Where the sheet came from, so the office panel can say "GRAHAM-RESTORATION.xlsx,
-- 39 decisions, imported Jul 31" without reading every row back.
alter table public.portal_jobs
  add column if not exists selections_source jsonb;
alter table public.portal_jobs
  add column if not exists selections_published_at timestamptz;
