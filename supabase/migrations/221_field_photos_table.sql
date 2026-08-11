-- ============================================================
-- 221: photos become rows (Phase 3, section 1 of N) — table + backfill
-- ------------------------------------------------------------
-- Phase 3 of the sync rearchitecture: stop storing field work inside one
-- per-job JSON blob. Photos go first because they ARE the blob — measured on
-- live data, photos are 68.6% of all job bytes (3.3 MB of 4.9 MB, 450 rows),
-- because 187 of them still carry a full inline thumbnail next to their
-- bucket link so the app works with no signal. Today adding a single photo
-- rewrites the entire multi-megabyte blob; after this it is one small insert.
--
-- WHAT THIS DOES (additive — nothing reads these rows yet)
--   • field_photos: one row per photo, with real columns and per-row
--     authorship + soft delete.
--   • Backfills every photo from every live job blob, preserving the photo's
--     existing id so the dual-write phase is idempotent and a row and its
--     blob entry always refer to the same photo.
--   • RLS: the crew (tech/admin/office) reads and writes; the AI service
--     accounts (viewer) cannot write; hard DELETE is admin-only, mirroring
--     the fence migration 216 put on field_projects.
--
-- WHY DIRECT ROW WRITES ARE SAFE (unlike blob writes)
--   Phase 2 forced job writes through an RPC because a whole-blob write
--   clobbers everything another device changed. That does not apply per row:
--   two devices adding photos touch different rows, so the union is automatic
--   — which is the entire point of this phase. Same-row last-write-wins
--   matches what merge.js already did on an id clash.
--
-- DELETE POLICY, DELIBERATELY UNCHANGED FOR NOW
--   `deleted_at`/`deleted_by` make photo removal reversible (nothing is ever
--   erased in normal operation) — that recoverability is the win, and it does
--   not depend on who may flag. Restricting the flag to admins is a real
--   behavior change for the crew and ships WITH the UI that hides the button,
--   in a later increment. Cutover steps stay behavior-neutral.
--
-- NOT BACKFILLED: photos inside tombstoned jobs. Those blobs are already the
-- recoverable copy (214 trash + 215 history); reviving a job re-materializes
-- them through the normal dual-write path.
-- ============================================================

set lock_timeout = '5s';

create table if not exists public.field_photos (
  id          uuid primary key,                    -- the photo's existing blob id
  job_id      uuid not null,
  -- content
  src         text,                                -- inline data URL, or a 'media:<sha256>:<len>' marker
  cloud       text,                                -- full-res object in the field-media bucket
  room        text        not null default '',
  stage       text        not null default 'during',
  caption     text        not null default '',
  ai          jsonb,                               -- vision analysis, when present
  taken_at    timestamptz,                         -- the capture's own clock (blob `ts`)
  -- authorship + lifecycle
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);

-- No FK to field_projects on purpose: an admin hard-deleting a job must not
-- cascade its photos away — the orphans are what makes the job recoverable
-- alongside the 214 trash copy.
create index if not exists field_photos_job on public.field_photos (job_id) where deleted_at is null;
create index if not exists field_photos_sync on public.field_photos (updated_at desc);
create index if not exists field_photos_trash on public.field_photos (deleted_at) where deleted_at is not null;

alter table public.field_photos alter column src set compression lz4;

comment on table public.field_photos is
  'One row per job photo (migration 221, Phase 3). Replaces the photos[] '
  'array inside field_projects.data so adding a photo is one small insert '
  'instead of a multi-megabyte blob rewrite. Soft delete only: deleted_at is '
  'a flag, rows are purged by an operator, never by the app.';

-- ---------- authorship + lifecycle, stamped server-side ----------
create or replace function public.stamp_field_photo()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := auth.uid();
    new.updated_at := now();
  else
    -- authorship only moves when something actually changed
    if new.* is not distinct from old.* then return new; end if;
    new.created_by := old.created_by;               -- never rewritten
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := auth.uid();                 -- who flagged it
    elsif new.deleted_at is null then
      new.deleted_by := null;                       -- restored
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_field_photo on public.field_photos;
create trigger stamp_field_photo
  before insert or update on public.field_photos
  for each row execute function public.stamp_field_photo();

-- ---------- RLS: crew reads/writes, agents cannot, hard delete is admin ----------
alter table public.field_photos enable row level security;

drop policy if exists field_photos_crew_read on public.field_photos;
create policy field_photos_crew_read on public.field_photos
  for select to authenticated
  using (exists (select 1 from public.profiles
                  where id = auth.uid() and role in ('tech','admin','office','viewer')));

drop policy if exists field_photos_crew_write on public.field_photos;
create policy field_photos_crew_write on public.field_photos
  for insert to authenticated
  with check (exists (select 1 from public.profiles
                       where id = auth.uid() and role in ('tech','admin','office')));

drop policy if exists field_photos_crew_update on public.field_photos;
create policy field_photos_crew_update on public.field_photos
  for update to authenticated
  using (exists (select 1 from public.profiles
                  where id = auth.uid() and role in ('tech','admin','office')))
  with check (exists (select 1 from public.profiles
                       where id = auth.uid() and role in ('tech','admin','office')));

-- hard delete: admins only (the app never hard-deletes; this closes the raw path)
drop policy if exists field_photos_admin_delete on public.field_photos;
create policy field_photos_admin_delete on public.field_photos
  for delete to authenticated
  using (public.is_admin());

-- ---------- backfill from the live job blobs ----------
-- Idempotent: keyed on the photo's existing id, so re-running (or a later
-- dual-write of the same photo) inserts nothing new.
insert into public.field_photos
  (id, job_id, src, cloud, room, stage, caption, ai, taken_at, created_by, created_at, updated_at)
select
  (p->>'id')::uuid,
  fp.id,
  nullif(p->>'src',''),
  nullif(p->>'cloud',''),
  coalesce(p->>'room',''),
  coalesce(nullif(p->>'stage',''),'during'),
  coalesce(p->>'caption',''),
  case when jsonb_typeof(p->'ai') in ('object','array') then p->'ai' end,
  case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end,
  u.id,     -- the blob stamps `by` as the signed-in EMAIL (Phase 1), not a uuid
  coalesce(case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end, now()),
  coalesce(case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end, now())
from public.field_projects fp,
     lateral jsonb_array_elements(fp.data->'photos') p
     left join auth.users u on lower(u.email) = lower(nullif(p->>'by',''))
where not fp.deleted
  and jsonb_typeof(fp.data->'photos') = 'array'
  and jsonb_typeof(p) = 'object'
  and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict (id) do nothing;
