-- ============================================================
-- 242: restore_photo must lift the delete, not just re-add the row
-- ------------------------------------------------------------
-- 241 made a delete a recorded fact (`data->'deletedIds'`) that outranks the
-- union and is swept out of every stored blob. That silently broke the other
-- half of the story: restore_photo (225) puts the photo object back into
-- data->'photos' but leaves the tombstone standing, so the very next push
-- sweeps it straight back out and the admin's restore evaporates — worse,
-- with no error, since the restore itself reports 'restored'.
--
-- An admin restore is a deliberate reversal of the delete, so it must clear
-- the mark. Same for the 'already_present' branch: a photo sitting in the
-- blob while its id is tombstoned is exactly the contradiction 241 sweeps,
-- so that path must clear the mark too or it stays a no-op forever.
--
-- KNOWN LIMIT, stated plainly rather than papered over. Clearing the mark
-- server-side fixes every device that pulls the row CLEANLY. A device holding
-- unsynced edits merges instead, and its own copy still carries the mark —
-- and since a tombstone wins unconditionally (241), that device re-strips the
-- photo and pushes the strip back. So an admin restore can still be undone by
-- one dirty device. Closing that needs a revocation that propagates the same
-- way a delete does (a `restoredIds` map compared against `deletedIds` by
-- stamp, replacing 241's unconditional rule); until then the remedy is
-- "☁ Take the cloud's copy" on the offending device. restore_photo is
-- admin-only and rare, which is why this is documented rather than rushed.
--
-- Unchanged from 225 apart from clearing the mark on both restore paths.
-- ============================================================

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

  -- already listed? then there is nothing to put back — but the tombstone may
  -- still be standing, which is the contradiction 241 sweeps out on the next
  -- write. Lift it, and bump the row so devices actually learn about it.
  if exists (
    select 1 from jsonb_array_elements(coalesce(cur_data->'photos','[]'::jsonb)) p
     where (p->>'id') = p_photo::text
  ) then
    update public.field_photos
       set deleted_at = null, deleted_by = null, purged_at = null
     where job_id = p_job and id = p_photo;
    if cur_data #> array['deletedIds', p_photo::text] is not null then
      begin ts_cur := (cur_data->>'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
      ts_new := greatest(coalesce(ts_cur, to_timestamp(0)), now()) + interval '1 millisecond';
      update public.field_projects
         set data = jsonb_set(
                      jsonb_set(cur_data #- array['deletedIds', p_photo::text],
                        '{rev}', to_jsonb(coalesce(cur_rev,0) + 1)),
                      '{updatedAt}',
                      to_jsonb(to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
       where id = p_job;
      return jsonb_build_object('status','already_present','rev', coalesce(cur_rev,0) + 1,'tombstone','cleared');
    end if;
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
                    jsonb_set(cur_data #- array['deletedIds', p_photo::text],   -- lift the delete (241)
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
