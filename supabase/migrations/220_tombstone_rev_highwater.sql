-- ============================================================
-- 220: keep `rev` monotonic across delete → revive
-- ------------------------------------------------------------
-- The whole no-clobber guarantee rests on `rev` being a token the server
-- never issues twice: push_project only takes the wholesale 'applied' path
-- when the caller's base EQUALS the current rev. Deleting a job broke that.
--
-- The bug (found in adversarial review, reproduced against prod):
--   tombstone_project stored `p_data - 'rev'` as the tombstone body, so the
--   rev vanished with the delete. revive_project then computed
--   coalesce(cur_rev,0)+1 = 1 and the row restarted its rev sequence,
--   re-issuing numbers it had already handed out. A device still holding
--   pre-delete bookkeeping (say base 3) would later push, match the
--   re-climbed rev 3, and get 'applied' — overwriting the row wholesale with
--   its own subset copy. Every photo added after the revive is erased, and no
--   other device notices: the clobber carries the newest updatedAt, so their
--   pull tie-guard skips it.
--
-- Live data confirmed the exposure: all 27 tombstones carried no rev, while
-- live rows had already reached rev 1550.
--
-- Fix: the tombstone keeps a high-water rev, so a revive always issues one
-- ABOVE anything previously handed out. Existing tombstones are backfilled
-- past any rev they could collide with — rev is a bare equality token, so
-- jumping it is harmless (clients adopt whatever the server returns).
-- ============================================================

set lock_timeout = '5s';

create or replace function public.tombstone_project(
  p_id uuid, p_data jsonb default null, p_build text default null)
returns jsonb
language plpgsql security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare cur_data jsonb; cur_deleted boolean; body jsonb; hw int; rc int;
begin
  if p_id is null then raise exception 'tombstone_project: id is required'; end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'tombstone_project: data must be a JSON object';
  end if;
  perform public._sync_guard(p_build);

  select data, deleted into cur_data, cur_deleted
    from public.field_projects where id = p_id for update;

  if not found then                              -- never synced (or already purged)
    insert into public.field_projects (id, data, deleted)
    values (p_id, coalesce(p_data - 'rev', jsonb_build_object('id', p_id)), true);
    return jsonb_build_object('status','tombstoned','created',true);
  end if;

  if cur_deleted then
    return jsonb_build_object('status','already_deleted');
  end if;

  -- keep the richer copy: a caller with no snapshot must not blank out
  -- content the server already holds inside the tombstone
  body := case
            when p_data is null then cur_data
            when length(p_data::text) >= length(coalesce(cur_data,'{}'::jsonb)::text) then p_data - 'rev'
            else cur_data
          end;

  -- HIGH-WATER REV: carry the highest rev this row ever held into the
  -- tombstone so revive_project issues cur_rev+1 above every rev already
  -- handed out. Without this the row restarts at 1 and a device holding
  -- pre-delete bookkeeping can later match a re-issued rev and clobber.
  hw := greatest(
          coalesce((cur_data ->> 'rev')::int, 0),
          coalesce((p_data   ->> 'rev')::int, 0),
          coalesce((body     ->> 'rev')::int, 0));
  body := jsonb_set(coalesce(body, jsonb_build_object('id', p_id)), '{rev}', to_jsonb(hw));

  update public.field_projects set data = body, deleted = true where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'tombstone_project: row vanished, retry'; end if;
  return jsonb_build_object('status','tombstoned','rev',hw);
end;
$$;

revoke execute on function public.tombstone_project(uuid, jsonb, text) from public, anon;
grant  execute on function public.tombstone_project(uuid, jsonb, text) to authenticated;

-- Backfill the tombstones that predate the fix. They carry no rev at all, so
-- a revive would hand out rev 1 and climb back through revs that devices are
-- still holding in their bookkeeping. Park them far above the live maximum
-- (1550 at time of writing) so no re-issued rev can ever collide.
update public.field_projects
   set data = jsonb_set(data, '{rev}', to_jsonb(1000000))
 where deleted and not (data ? 'rev');
