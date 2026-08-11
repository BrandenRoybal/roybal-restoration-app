-- ============================================================
-- 222: keep field_photos in step with the blob (Phase 3, step 1b)
-- ------------------------------------------------------------
-- The dual-write half of moving photos to rows. Rows must track the blob
-- exactly before anything can safely READ them.
--
-- WHY SERVER-SIDE, NOT IN THE CLIENT
-- The field app is offline-first: a tech on a job with no signal captures
-- photos into IndexedDB and syncs hours later. A capture-time row insert
-- would simply fail there, and queuing a second write stream beside the
-- existing sync would double the bookkeeping that Phases 0–2 just spent all
-- their effort making trustworthy. Instead the server derives the rows from
-- the blob it is already storing, in the SAME transaction. That means:
--   • no client change at all for this step, so every device — including one
--     that never updates — keeps the rows correct;
--   • atomic with the blob write: rows can never drift from it;
--   • self-healing: any later write re-reconciles the whole set;
--   • it covers every writer (the RPCs, a legacy direct PATCH, edge
--     functions), not just the current app build.
--
-- WHAT IT DOES, per job, whenever data->'photos' actually changes:
--   • a photo in the blob with no row      → insert (authorship from `by`)
--   • a row whose photo left the blob      → soft delete (never erased)
--   • a photo back after being removed     → un-delete
--   • changed fields                       → update (untouched rows are left
--                                             alone, so the stamp trigger does
--                                             not churn updated_by/updated_at)
--
-- SAFETY GUARDS — the projection must never mass-delete rows by accident:
--   • runs only when `photos` is genuinely an array (a malformed or partial
--     write leaves the rows untouched rather than wiping them);
--   • skips tombstoned rows entirely, so trashing a job does not sweep its
--     photos away — reviving it must find them intact;
--   • skips when the photos array is byte-identical to the previous write,
--     which makes it free for the many writes that touch other sections.
--
-- Still additive: nothing READS these rows yet.
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
  -- only a live row with a real photos array is a source of truth
  if new.deleted or arr is null or jsonb_typeof(arr) <> 'array' then return null; end if;
  if tg_op = 'UPDATE' and (old.data -> 'photos') is not distinct from arr then return null; end if;

  with incoming as (
    select
      (p->>'id')::uuid                                   as id,
      nullif(p->>'src','')                               as src,
      nullif(p->>'cloud','')                             as cloud,
      coalesce(p->>'room','')                            as room,
      coalesce(nullif(p->>'stage',''),'during')          as stage,
      coalesce(p->>'caption','')                         as caption,
      case when jsonb_typeof(p->'ai') in ('object','array') then p->'ai' end as ai,
      case when (p->>'ts') ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'ts')::timestamptz end as taken_at,
      (select u.id from auth.users u
        where lower(u.email) = lower(nullif(p->>'by','')) limit 1)          as by_uid
    from jsonb_array_elements(arr) p
    where jsonb_typeof(p) = 'object'
      and (p->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- add or refresh
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
          deleted_at = null,               -- back in the blob → restored
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
  -- gone from the blob → soft delete, never erase
  update public.field_photos f
     set deleted_at = now()
   where f.job_id = new.id
     and f.deleted_at is null
     and not exists (select 1 from incoming i where i.id = f.id);

  return null;
end;
$$;

drop trigger if exists project_field_photos on public.field_projects;
create trigger project_field_photos
  after insert or update on public.field_projects
  for each row execute function public.project_field_photos();

revoke execute on function public.project_field_photos() from public, anon, authenticated;
