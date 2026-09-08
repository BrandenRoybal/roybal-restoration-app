-- ============================================================
-- Roybal AI Field Data Backbone — additive schema (Option B)
-- ============================================================
-- This migration ADDS the backbone layer described in
-- "Roybal AI Backbone — Architecture & Phase 1". It is SAFE and
-- ADDITIVE: it creates new tables only and does NOT touch
-- field_projects, coordination_jobs, jobs, or any existing object.
--
--   Reference "brain"  : phase_templates, required_forms, field_requirements
--   Single source ----- : unified_jobs (the spine), phase_instances
--   Ingest + result --- : capture_events, completeness_state
--
-- Run once: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- Depends on coordination_touch() from migration 101 (run 101 first).
-- ============================================================

create extension if not exists pgcrypto;

-- Reuse the shared updated_at stamper if 101 ran; define defensively otherwise.
create or replace function public.coordination_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- 1. PHASE TEMPLATES  (typed reference data — the reusable definition)
--    e.g. "Cat 3 Water Mitigation"
-- ============================================================
create table if not exists public.phase_templates (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,          -- 'water_mit' | 'water_mit_cat3' | ...
  name        text not null,
  loss_type   text not null default 'water', -- water | fire | mold | smoke | other
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- 2. REQUIRED FORMS  (per template: which forms must exist)
--    form_key matches the field app's FORMS keys exactly.
-- ============================================================
create table if not exists public.required_forms (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.phase_templates (id) on delete cascade,
  form_key      text not null,                 -- moistureMaps | dryingLogs | photos |
                                               -- constructionLogs | workAuth | certDrying |
                                               -- floorPlan | contents | changeOrders
  form_label    text not null,
  requirement   text not null default 'always',-- 'always' | 'conditional'
  condition_key text,                          -- when conditional: 'contents'|'cleaning'|'cat3'
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (template_id, form_key)
);

-- ============================================================
-- 3. FIELD REQUIREMENTS  (per required form: which fields gate completeness)
--    field_path is a dot/bracket path into the field_projects blob.
--    gate = 'hard' blocks billing; 'soft' warns only.
-- ============================================================
create table if not exists public.field_requirements (
  id               uuid primary key default gen_random_uuid(),
  required_form_id uuid not null references public.required_forms (id) on delete cascade,
  field_path       text not null,               -- e.g. 'dryingLogs[].readings[].affRH'
  label            text not null,
  gate             text not null default 'hard', -- 'hard' | 'soft'
  requirement      text not null default 'always', -- 'always' | 'conditional'
  condition_key    text,
  note             text,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (required_form_id, field_path)            -- idempotent re-runs: one rule per (form, field)
);

-- ============================================================
-- 4. UNIFIED JOBS  (THE SPINE — single source of truth / crosswalk)
--    Links the three job records that exist today by real IDs.
-- ============================================================
create table if not exists public.unified_jobs (
  id                  uuid primary key default gen_random_uuid(),
  -- carrier / loss identity
  claim_number        text,
  insurance_carrier   text,
  adjuster_name       text,
  adjuster_phone      text,
  adjuster_email      text,
  property_address    text,
  owner_name          text,
  owner_phone         text,
  owner_email         text,
  date_of_loss        date,
  loss_type           text,                       -- water | fire | mold | smoke | other
  water_category      text,                       -- '1' | '2' | '3'
  water_class         text,                       -- '1'..'4'
  status              text not null default 'new',
  current_phase_id    uuid,                        -- -> phase_instances.id (set later)
  -- crosswalk to the three existing job records
  field_project_id    uuid unique,                 -- -> field_projects.id (blob); unique = one spine row per field job (upsert key)
  coordination_job_id uuid,                        -- -> coordination_jobs.id (blob)
  relational_job_id   uuid,                        -- -> jobs.id (typed web/mobile app) IF that schema exists; intentionally no hard FK so this migration runs standalone on the field/board database
  qb_jobcode_id       text,                        -- -> QuickBooks Time jobcode
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists unified_jobs_field_idx  on public.unified_jobs (field_project_id);
create index if not exists unified_jobs_coord_idx  on public.unified_jobs (coordination_job_id);
create index if not exists unified_jobs_claim_idx  on public.unified_jobs (claim_number);

drop trigger if exists trg_unified_jobs_touch on public.unified_jobs;
create trigger trg_unified_jobs_touch
  before insert or update on public.unified_jobs
  for each row execute function public.coordination_touch();

-- ============================================================
-- 5. PHASE INSTANCES  (a template applied to a specific job)
-- ============================================================
create table if not exists public.phase_instances (
  id             uuid primary key default gen_random_uuid(),
  unified_job_id uuid not null references public.unified_jobs (id) on delete cascade,
  template_id    uuid references public.phase_templates (id) on delete set null,
  name           text not null default '',
  status         text not null default 'active',  -- active | complete | billable | closed
  conditions     jsonb not null default '{}'::jsonb, -- e.g. {"contents":true,"cleaning":false}
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists phase_instances_job_idx on public.phase_instances (unified_job_id);

drop trigger if exists trg_phase_instances_touch on public.phase_instances;
create trigger trg_phase_instances_touch
  before insert or update on public.phase_instances
  for each row execute function public.coordination_touch();

-- ============================================================
-- 6. CAPTURE EVENTS  (the ingest envelope — heart of the backbone)
--    EVERY input lands here first, in one standard shape.
-- ============================================================
create table if not exists public.capture_events (
  id                uuid primary key default gen_random_uuid(),
  unified_job_id    uuid references public.unified_jobs (id) on delete cascade,
  phase_instance_id uuid references public.phase_instances (id) on delete set null,
  source_type       text not null,             -- 'voice'|'photo_meta'|'manual'|'email'|'qbo_time'
  form_key          text,                      -- target form when known (voice scoped to a form)
  raw_payload       jsonb,                     -- original input metadata (audio ref, exif, etc.)
  transcript        text,                      -- STT output for voice
  result            jsonb,                     -- extracted candidate fields (pre-confirm)
  captured_by       text,                      -- WHICH tech (shared-login attribution)
  status            text not null default 'pending', -- pending|extracted|confirmed|discarded
  error             text,
  captured_at       timestamptz not null default now(),
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists capture_events_job_idx    on public.capture_events (unified_job_id);
create index if not exists capture_events_status_idx on public.capture_events (status);

drop trigger if exists trg_capture_events_touch on public.capture_events;
create trigger trg_capture_events_touch
  before insert or update on public.capture_events
  for each row execute function public.coordination_touch();

-- ============================================================
-- 7. COMPLETENESS STATE  (computed: required vs present + gap list)
--    One row per (job, phase); drives the missing-field prompt and
--    the "not billable until complete" gate.
-- ============================================================
create table if not exists public.completeness_state (
  id                uuid primary key default gen_random_uuid(),
  unified_job_id    uuid not null references public.unified_jobs (id) on delete cascade,
  phase_instance_id uuid references public.phase_instances (id) on delete cascade,
  required_count    integer not null default 0,
  present_count     integer not null default 0,
  hard_gaps         jsonb not null default '[]'::jsonb,  -- [{form_key, field_path, label}]
  soft_gaps         jsonb not null default '[]'::jsonb,
  is_billable       boolean not null default false,      -- true only when hard_gaps = []
  computed_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (unified_job_id, phase_instance_id)
);

create index if not exists completeness_job_idx on public.completeness_state (unified_job_id);

drop trigger if exists trg_completeness_touch on public.completeness_state;
create trigger trg_completeness_touch
  before insert or update on public.completeness_state
  for each row execute function public.coordination_touch();

-- ============================================================
-- ROW LEVEL SECURITY
-- Reference tables: any signed-in user may READ (the field PWA uses the
-- shared company login and must read the rules to run completeness checks).
-- Writes to reference data are intended via the office/admin path.
-- Operational tables: full access to authenticated (single-company account),
-- mirroring the existing coordination_jobs / field_projects policies.
-- ============================================================
alter table public.phase_templates    enable row level security;
alter table public.required_forms     enable row level security;
alter table public.field_requirements enable row level security;
alter table public.unified_jobs       enable row level security;
alter table public.phase_instances    enable row level security;
alter table public.capture_events     enable row level security;
alter table public.completeness_state enable row level security;

-- reference data: read for all authenticated
drop policy if exists phase_templates_read on public.phase_templates;
create policy phase_templates_read on public.phase_templates
  for select to authenticated using (true);
drop policy if exists required_forms_read on public.required_forms;
create policy required_forms_read on public.required_forms
  for select to authenticated using (true);
drop policy if exists field_requirements_read on public.field_requirements;
create policy field_requirements_read on public.field_requirements
  for select to authenticated using (true);

-- operational tables: full access for authenticated (single-company account)
drop policy if exists unified_jobs_all on public.unified_jobs;
create policy unified_jobs_all on public.unified_jobs
  for all to authenticated using (true) with check (true);
drop policy if exists phase_instances_all on public.phase_instances;
create policy phase_instances_all on public.phase_instances
  for all to authenticated using (true) with check (true);
drop policy if exists capture_events_all on public.capture_events;
create policy capture_events_all on public.capture_events
  for all to authenticated using (true) with check (true);
drop policy if exists completeness_state_all on public.completeness_state;
create policy completeness_state_all on public.completeness_state
  for all to authenticated using (true) with check (true);

-- ============================================================
-- SEED: the standard Water-Mitigation phase template + required matrix
-- Mirrors the doc's Part 2.2. Idempotent (safe to re-run).
-- ============================================================
insert into public.phase_templates (key, name, loss_type, description)
values ('water_mit', 'Water Mitigation (standard)', 'water',
        'Standard IICRC S500 water mitigation packet. Conditional add-ons: contents, cleaning, cat3.')
on conflict (key) do nothing;

-- Required forms for the standard water-mit template
with t as (select id from public.phase_templates where key = 'water_mit')
insert into public.required_forms (template_id, form_key, form_label, requirement, condition_key, sort_order)
select t.id, v.form_key, v.form_label, v.requirement, v.condition_key, v.sort_order
from t, (values
  ('workAuth',         'Work Authorization',        'always',      null,      10),
  ('floorPlan',        'Floor Plan / Job Map',      'always',      null,      20),
  ('moistureMaps',     'Moisture Map',              'always',      null,      30),
  ('dryingLogs',       'Drying Log',                'always',      null,      40),
  ('photos',           'Photo Log',                 'always',      null,      50),
  ('certDrying',       'Certificate of Drying',     'always',      null,      60),
  ('constructionLogs', 'Daily Construction Log',    'always',      null,      70),
  ('contents',         'Contents Inventory',        'conditional', 'contents',80),
  ('changeOrders',     'Change Order (cleaning)',   'conditional', 'cleaning',90)
) as v(form_key, form_label, requirement, condition_key, sort_order)
on conflict (template_id, form_key) do nothing;

-- Field requirements (the hard/soft gates). field_path uses '[]' to mean
-- "for each instance / each affected room/day".
with rf as (
  select rf.id, rf.form_key
  from public.required_forms rf
  join public.phase_templates t on t.id = rf.template_id and t.key = 'water_mit'
)
insert into public.field_requirements (required_form_id, field_path, label, gate, requirement, condition_key, note, sort_order)
select rf.id, v.field_path, v.label, v.gate, v.requirement, v.condition_key, v.note, v.sort_order
from rf, (values
  -- Work Authorization
  ('workAuth',         'workAuth.ownerSig|workAuth.uploadedPages', 'Owner signature (signed or uploaded)', 'hard', 'always', null, 'On-device signature OR uploaded wet-signed copy', 10),
  ('workAuth',         'workAuth.ownerName',        'Owner name',                 'hard', 'always', null, null, 11),
  ('workAuth',         'workAuth.date',             'Authorization date',         'hard', 'always', null, null, 12),
  -- Floor plan
  ('floorPlan',        'floorPlan.present',         'At least one floor plan',    'hard', 'always', null, 'Magicplan import or drawn map', 20),
  -- Moisture Map
  ('moistureMaps',     'moistureMaps[].material',   'Material per affected area', 'hard', 'always', null, null, 30),
  ('moistureMaps',     'moistureMaps[].dryGoal',    'Dry goal (auto-fills)',      'hard', 'always', null, null, 31),
  ('moistureMaps',     'moistureMaps[].readings[].values', 'Dated MC% reading per location', 'hard', 'always', null, 'At least one dated reading per location', 32),
  -- Drying Log -> Psychrometric (split #1)
  ('dryingLogs',       'dryingLogs[].readings[].affT',  'Affected area temp (daily)',  'hard', 'always', null, 'Psychrometric — most-skipped field', 40),
  ('dryingLogs',       'dryingLogs[].readings[].affRH', 'Affected area RH (daily)',    'hard', 'always', null, null, 41),
  ('dryingLogs',       'dryingLogs[].readings[].outT',  'Outside temp (daily)',        'hard', 'always', null, null, 42),
  ('dryingLogs',       'dryingLogs[].readings[].outRH', 'Outside RH (daily)',          'hard', 'always', null, null, 43),
  ('dryingLogs',       'dryingLogs[].readings[].gd',    'Grain depression (auto-calc)','soft', 'always', null, null, 44),
  -- Drying Log -> Equipment (split #2)
  ('dryingLogs',       'dryingLogs[].equipment[].type',     'Equipment type',          'hard', 'always', null, null, 45),
  ('dryingLogs',       'dryingLogs[].equipment[].location', 'Equipment location',      'hard', 'always', null, null, 46),
  ('dryingLogs',       'dryingLogs[].equipment[].placed',   'Date placed',             'hard', 'always', null, null, 47),
  ('dryingLogs',       'dryingLogs[].equipment[].removed',  'Date removed (at end)',   'soft', 'always', null, 'Required to close the phase', 48),
  -- Photo Log
  ('photos',           'photos[].stage(before)',    'Before photo per affected room', 'hard', 'always', null, null, 50),
  ('photos',           'photos[].stage(during)',    'During photo per affected room', 'soft', 'always', null, null, 51),
  ('photos',           'photos[].stage(after)',     'After photo per affected room',  'hard', 'always', null, null, 52),
  ('photos',           'photos[].caption',          'Caption on each photo',          'hard', 'always', null, 'AI-generated caption acceptable', 53),
  -- Certificate of Drying
  ('certDrying',       'certDrying.verification[].final', 'Final reading per material', 'hard', 'always', null, null, 60),
  ('certDrying',       'certDrying.verification[].goal',  'Dry goal per material',      'hard', 'always', null, null, 61),
  ('certDrying',       'certDrying.sigTech|certDrying.uploadedPages', 'Tech sign-off',  'hard', 'always', null, null, 62),
  -- Daily Construction Log
  ('constructionLogs', 'constructionLogs[].rows[].employee', 'Crew member',           'hard', 'always', null, null, 70),
  ('constructionLogs', 'constructionLogs[].rows[].hours',    'Hours per crew/task',   'hard', 'always', null, 'Feeds Board + QBO Time', 71),
  -- Conditional: Contents
  ('contents',         'contents[].room',           'Room per item',              'hard', 'conditional', 'contents', null, 80),
  ('contents',         'contents[].disposition',    'Disposition per item',       'hard', 'conditional', 'contents', null, 81),
  -- Conditional: Cat 3 justification
  ('moistureMaps',     'cat3.floodCutJustification','Flood-cut / containment / HEPA justification', 'hard', 'conditional', 'cat3', 'Adjusters push hardest here', 85)
) as v(form_key, field_path, label, gate, requirement, condition_key, note, sort_order)
where rf.form_key = v.form_key
on conflict (required_form_id, field_path) do nothing;

-- ============================================================
-- Done. Verify with:
--   select key, name from public.phase_templates;
--   select form_key, requirement from public.required_forms order by sort_order;
--   select label, gate from public.field_requirements order by sort_order;
-- ============================================================
