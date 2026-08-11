-- ============================================================
-- 225: make a deleted photo actually recoverable (Phase 3, step 1d)
-- ------------------------------------------------------------
-- 221–224 made photo deletion *reversible in principle*: removing a photo
-- soft-deletes its row, recording what it was, who removed it and when,
-- instead of erasing it. But nothing could put one BACK, so the promise was
-- only half true — the record existed and the photo was still gone.
--
-- This closes the loop:
--   • field_photos_deleted — what was deleted, from which job, by whom, when.
--   • restore_photo(job, photo) — admin-only; puts the photo back into the
--     job's blob, which is what every device actually reads. The projection
--     then clears the row's deleted flag on its own.
--
-- WHY RESTORE WRITES THE BLOB, NOT THE ROW
-- The rows are still a projection: devices render from the blob, and the
-- projection would re-delete a row whose photo is not in it. Restoring means
-- putting the photo back where the app looks. When Phase 3 finishes moving
-- photos out of the blob, this function changes with it.
--
-- The restore bumps rev and stamps an updatedAt strictly newer than the
-- current one, because a device only applies a pulled row when it is
-- strictly newer than its local copy — without that the restored photo
-- would sit on the server and never reach anyone.
-- ============================================================

set lock_timeout = '5s';

-- ---------- what is in the bin ----------
create or replace view public.field_photos_deleted as
select
  f.job_id,
  fp.data->>'customer'                      as customer,
  f.id                                      as photo_id,
  f.room,
  f.stage,
  f.caption,
  f.deleted_at,
  du.email                                  as deleted_by,
  cu.email                                  as taken_by,
  f.taken_at,
  f.purged_at is not null                   as purged,
  (f.cloud is not null or f.src is not null) as recoverable
from public.field_photos f
left join public.field_projects fp on fp.id = f.job_id
left join auth.users du on du.id = f.deleted_by
left join auth.users cu on cu.id = f.created_by
where f.deleted_at is not null
order by f.deleted_at desc;

revoke all on public.field_photos_deleted from anon, authenticated;

comment on view public.field_photos_deleted is
  'Photos removed from a job (migration 225). The row keeps the image and who '
  'removed it; restore_photo(job_id, photo_id) puts one back. Operator-only.';

-- ---------- put one back ----------
create or replace function public.restore_photo(p_job uuid, p_photo uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  r public.field_photos%rowtype;
  cur_data jsonb; cur_rev int; cur_deleted boolean;
  entry jsonb; by_email text; ts_cur timestamptz; ts_new timestamptz; rc int;
begin
  -- An operator running this from the SQL editor has no JWT, so auth.uid() is
  -- null there; that context is already privileged. A request that DOES carry
  -- a user must be an admin — which is what fences techs out once the admin
  -- app calls this directly.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'restore_photo: only an admin may restore a deleted photo';
  end if;

  select * into r from public.field_photos where job_id = p_job and id = p_photo;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;
  if r.src is null and r.cloud is null then
    return jsonb_build_object('status','no_image');   -- nothing left to put back
  end if;

  select data, (data->>'rev')::int, deleted
    into cur_data, cur_rev, cur_deleted
    from public.field_projects where id = p_job for update;
  if not found then
    return jsonb_build_object('status','job_missing');
  end if;
  if cur_deleted then
    return jsonb_build_object('status','job_deleted',
      'hint','revive the job first — its photos come back with it');
  end if;

  -- already listed? then there is nothing to restore; just clear the flags
  if exists (
    select 1 from jsonb_array_elements(coalesce(cur_data->'photos','[]'::jsonb)) p
     where (p->>'id') = p_photo::text
  ) then
    update public.field_photos
       set deleted_at = null, deleted_by = null, purged_at = null
     where job_id = p_job and id = p_photo;
    return jsonb_build_object('status','already_present');
  end if;

  select email into by_email from auth.users where id = r.created_by;

  entry := jsonb_strip_nulls(jsonb_build_object(
    'id',      r.id,
    'src',     r.src,
    'cloud',   r.cloud,
    'room',    nullif(r.room,''),
    'stage',   r.stage,
    'caption', nullif(r.caption,''),
    'ai',      r.ai,
    'ts',      to_char(coalesce(r.taken_at, r.created_at) at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'by',      by_email));

  -- a device only takes a pulled row that is STRICTLY newer than its own copy
  begin ts_cur := (cur_data->>'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
  ts_new := greatest(coalesce(ts_cur, to_timestamp(0)), now()) + interval '1 millisecond';

  update public.field_projects
     set data = jsonb_set(
                  jsonb_set(
                    jsonb_set(cur_data,
                      '{photos}',
                      coalesce(case when jsonb_typeof(cur_data->'photos') = 'array'
                                    then cur_data->'photos' end, '[]'::jsonb) || jsonb_build_array(entry)),
                    '{rev}', to_jsonb(coalesce(cur_rev,0) + 1)),
                  '{updatedAt}',
                  to_jsonb(to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = p_job;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'restore_photo: job vanished, retry'; end if;

  -- a purge is deliberate, but an admin restoring is a deliberate reversal
  update public.field_photos
     set purged_at = null
   where job_id = p_job and id = p_photo and purged_at is not null;

  -- the projection clears deleted_at itself, since the photo is in the blob again
  return jsonb_build_object('status','restored','rev', coalesce(cur_rev,0) + 1);
end;
$$;

revoke execute on function public.restore_photo(uuid, uuid) from public, anon;
grant  execute on function public.restore_photo(uuid, uuid) to authenticated;
-- Callable two ways: an operator from the SQL editor (no JWT — already
-- privileged), or an admin from the app. is_admin() inside is what actually
-- fences techs out, so the grant is safe.
