-- ============================================================================
-- 0010_magicplan_exports.sql — the Magicplan sync landing table
-- (docs/Magicplan_Integration_Design.md §4.1; brief §4.1 — numbered 0010
-- because 0009_portal_claim.sql already exists on main).
--
-- Written ONLY by the service role from magicplan-proxy (`sync`, `markImported`,
-- `linkExport`). Read by the owner's / office's field app (adopt banner, ⟳ Pull)
-- and the admin Settings panel. Never read by crew; never written from a
-- browser; nothing here writes field_projects — the field app merges what it
-- reads into project.siteVisit through Store.put (design decision 4).
--
-- Grant trap (0008, contract_tables.test.sql §2): default privileges hand
-- anon/authenticated ALL on every new table; the revoke below is load-bearing.
-- Read gate is role_is() (0006), NOT current_role_name(): a real access token
-- carries role=authenticated and current_role_name() returns that claim first,
-- so it would refuse a real owner. Idempotent: safe to replay.
-- ============================================================================

create table if not exists public.magicplan_exports (
  id                uuid primary key default gen_random_uuid(),
  mp_project_id     text not null,
  mp_plan_id        text not null,
  field_project_id  text,
  status            text not null default 'queued'
                    check (status in ('queued','ready','imported','failed','unmatched')),
  files             jsonb not null default '[]',
  photos            jsonb not null default '[]',
  statistics        jsonb,
  floors_svg        jsonb not null default '[]',
  error             text,
  received_at       timestamptz not null default now(),
  synced_at         timestamptz,
  imported_at       timestamptz,
  imported_by       text
);

comment on table public.magicplan_exports is
  'One row per Magicplan sync of a plan into a field job. Written only by the service role (magicplan-proxy sync/markImported/linkExport); read by owner/office through RLS (field app adopt banner and ⟳ Pull, admin Settings). field_project_id null = unmatched (external_reference_id did not match). files/photos/floors_svg hold field-media paths under sitevisit/<job>/mp-<hash8>-<name>; statistics is the normalized quantities block.';
comment on column public.magicplan_exports.files is '[{path,name,mime,size,hash,folder,mp_last_modified,file_type}]';
comment on column public.magicplan_exports.photos is '[{path,name,mime,size,hash,folder,mp_last_modified,file_type,room,floor,caption,symbol_instance_id}]';
comment on column public.magicplan_exports.floors_svg is '[{floor,path,hash,name,size}]';
comment on column public.magicplan_exports.statistics is '{units, floors:[{name, rooms:[{name,floorSF,perimLF,ceilingFt,wallSF,wallSFNet,doors,windows,volumeCF,dims}]}]}';

create index if not exists magicplan_exports_job_idx
  on public.magicplan_exports (field_project_id, imported_at);
create index if not exists magicplan_exports_plan_idx
  on public.magicplan_exports (mp_plan_id, status);

alter table public.magicplan_exports enable row level security;

revoke all on public.magicplan_exports from anon, authenticated;
grant select on public.magicplan_exports to authenticated;
grant all on public.magicplan_exports to service_role;

drop policy if exists magicplan_exports_read_office on public.magicplan_exports;
create policy magicplan_exports_read_office on public.magicplan_exports
  for select to authenticated
  using (public.role_is('owner', 'office'));
-- no insert/update/delete policy: writes are the service role's alone (216/227 posture)
