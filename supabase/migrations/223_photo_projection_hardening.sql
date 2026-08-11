-- ============================================================
-- 223: the photo projection must never be able to block a field save
-- ------------------------------------------------------------
-- Two defences on 222's projection, both about failure blast radius rather
-- than correctness of the happy path.
--
-- 1. FAILURE ISOLATION. As written, project_field_photos is an AFTER trigger
--    with no exception handler, so ANY error it raises aborts the whole job
--    write — the crew simply cannot sync that job. blob_history (215) already
--    established the right rule for a derived, non-authoritative write:
--    swallow your own errors, warn, and never block the save. That applies
--    even more here, because NOTHING READS THESE ROWS YET: a missed
--    projection costs nothing and self-heals on the next write, while a
--    blocked save costs the crew their work.
--    ⚠️ This trade flips when reads move to the rows. Before that step, the
--    projection must become loud again (or gain a repair sweep), or a silent
--    failure would show up as photos missing from a job. The drift check at
--    the bottom of this file is the tool for that.
--
-- 2. DUPLICATE IDS IN ONE ARRAY. INSERT ... ON CONFLICT raises "cannot affect
--    row a second time" if the source holds the same id twice, which under
--    (1) would silently skip the whole projection for that job. No live blob
--    has duplicates today (checked: 0 across all 450 photos), but a legacy
--    or hand-edited blob could, so the source is deduped: last occurrence
--    wins, deterministically.
-- ============================================================

set lock_timeout = '5s';

create or replace function public.project_field_photos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  arr jsonb := new.data -> 'photos';
begin
  if new.deleted or arr is null or jsonb_typeof(arr) <> 'array' then return null; end if;
  if tg_op = 'UPDATE' and (old.data -> 'photos') is not distinct from arr then return null; end if;

  with parsed as (
    select
      (p->>'id')::uuid                                   as id,
      ord,
      nullif(p->>'src','')                               as src,
      nullif(p->>'cloud','')                             as cloud,
      coalesce(p->>'room','')                            as room,
      coalesce(nullif(p->>'stage',''),'during')          as stage,
      coalesce(p->>'caption','')                         as caption,
      case when jsonb_typeof(p->'ai') in ('object','array') then p->'ai' end as ai,
      case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end as taken_at,
      (select u.id from auth.users u
        where lower(u.email) = lower(nullif(p->>'by','')) limit 1)          as by_uid
    from jsonb_array_elements(arr) with ordinality as t(p, ord)
    where jsonb_typeof(p) = 'object'
      and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- one row per id: a duplicated id would otherwise abort the statement
  incoming as (
    select distinct on (id) id, src, cloud, room, stage, caption, ai, taken_at, by_uid
    from parsed order by id, ord desc
  ),
  upserted as (
    insert into public.field_photos
      (id, job_id, src, cloud, room, stage, caption, ai, taken_at, created_by, created_at, updated_at)
    select i.id, new.id, i.src, i.cloud, i.room, i.stage, i.caption, i.ai, i.taken_at,
           i.by_uid, coalesce(i.taken_at, now()), now()
    from incoming i
    on conflict (id) do update
      set job_id     = excluded.job_id,
          src        = excluded.src,
          cloud      = excluded.cloud,
          room       = excluded.room,
          stage      = excluded.stage,
          caption    = excluded.caption,
          ai         = excluded.ai,
          taken_at   = excluded.taken_at,
          deleted_at = null,
          deleted_by = null
      where (field_photos.src, field_photos.cloud, field_photos.room, field_photos.stage,
             field_photos.caption, field_photos.ai, field_photos.taken_at,
             field_photos.job_id, field_photos.deleted_at)
        is distinct from
            (excluded.src, excluded.cloud, excluded.room, excluded.stage,
             excluded.caption, excluded.ai, excluded.taken_at,
             excluded.job_id, null::timestamptz)
    returning 1
  )
  update public.field_photos f
     set deleted_at = now()
   where f.job_id = new.id
     and f.deleted_at is null
     and not exists (select 1 from incoming i where i.id = f.id);

  return null;
exception when others then
  -- derived data must never cost the crew a save; the next write re-reconciles
  raise warning 'project_field_photos failed for job %: %', new.id, sqlerrm;
  return null;
end;
$$;

revoke execute on function public.project_field_photos() from public, anon, authenticated;

-- ---------- operator tool: has the projection drifted from the blobs? ----------
-- Run before flipping reads to rows, and any time a warning above is seen.
-- Expect zero rows. Anything listed is repaired by re-saving that job (any
-- write re-runs the projection), or by re-running 221's backfill insert.
create or replace view public.field_photos_drift as
with blob_photos as (
  select fp.id as job_id, (p->>'id')::uuid as photo_id
  from public.field_projects fp,
       lateral jsonb_array_elements(fp.data->'photos') p
  where not fp.deleted
    and jsonb_typeof(fp.data->'photos') = 'array'
    and jsonb_typeof(p) = 'object'
    and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
select b.job_id, b.photo_id, 'missing row'::text as problem
  from blob_photos b
 where not exists (select 1 from public.field_photos f
                    where f.id = b.photo_id and f.deleted_at is null)
union all
select f.job_id, f.id, 'row not in blob'
  from public.field_photos f
 where f.deleted_at is null
   and not exists (select 1 from blob_photos b where b.photo_id = f.id);

revoke all on public.field_photos_drift from anon, authenticated;

comment on view public.field_photos_drift is
  'Operator check that field_photos still mirrors the job blobs (migration '
  '223). Expect zero rows. The projection swallows its own errors so a field '
  'save is never blocked, so this is how a missed projection is noticed — '
  'run it before Phase 3 flips reads onto the rows.';
