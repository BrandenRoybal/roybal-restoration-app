-- ============================================================
-- 218: tombstone/revive RPCs + min-build gate (Phase 2b, server half)
-- ------------------------------------------------------------
-- 217 gave field_projects one authoritative WRITE path (push_project).
-- Sync also deletes and revives rows, so those need the same door before
-- direct table writes can be revoked. This adds:
--
--   tombstone_project(id, data, build)  — soft-delete carrying the job's
--       last-known content inside the tombstone (recoverable server-side,
--       matches today's upsertRows([{id,data,deleted:true}]) behavior).
--   revive_project(id, data, base_rev, build) — the ONLY sanctioned way to
--       flip a tombstone back alive, guarded on the row still being
--       deleted so two devices reviving at once can't clobber each other
--       (mirrors supa.js reviveRow's deleted=eq.true guard).
--   app_settings + a min-build gate on all three RPCs.
--
-- BEHAVIOR-NEUTRAL BY DESIGN. A cutover migration must not also change
-- policy: every crew role that can soft-delete today can still soft-delete
-- through the RPC. Restricting deletes to admins is a real product change
-- (the crew deletes repeat-tap blank scaffolds) and belongs in Phase 3
-- alongside the UI that hides the affordance — see the plan doc.
--
-- MIN-BUILD GATE: inert until switched on. app_settings.min_field_build
-- defaults to 0, so every caller passes. Once the fleet is on the RPC
-- build, an operator raises it and pre-cutover builds are refused with a
-- distinguishable message instead of silently writing:
--     update app_settings set value = to_jsonb(132)
--      where key = 'min_field_build';
-- The client sends its service-worker cache number as p_build; a null
-- build always passes (the gate only rejects a build it can compare and
-- finds too old).
--
-- ⚠️ STILL ADDITIVE: nothing calls these yet and direct table writes stay
-- granted. The revoke that makes the RPCs the only door is 219, applied by
-- an operator once telemetry shows every device on the new build.
-- ============================================================

set lock_timeout = '5s';

create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

comment on table public.app_settings is
  'Server-side operational settings (migration 218). RLS intentionally has '
  'no policies: only postgres/service_role may read or write. The sync RPCs '
  'read it as SECURITY DEFINER.';

insert into public.app_settings (key, value)
values ('min_field_build', to_jsonb(0))
on conflict (key) do nothing;

-- Shared guard for every sync RPC: caller must be real crew, and their
-- build must not be older than the floor. Raises on refusal.
create or replace function public._sync_guard(p_build text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare min_build int; caller_build int;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tech','admin','office')
  ) then
    raise exception 'sync: this account may not write field_projects';
  end if;

  select coalesce((value)::text::int, 0) into min_build
    from public.app_settings where key = 'min_field_build';
  min_build := coalesce(min_build, 0);
  if min_build > 0 and p_build is not null then
    begin
      caller_build := regexp_replace(p_build, '\D', '', 'g')::int;
    exception when others then
      caller_build := null;                      -- unparseable → don't block
    end;
    if caller_build is not null and caller_build < min_build then
      raise exception 'sync: app build % is older than the required build % — update the app',
        caller_build, min_build
        using errcode = 'P0002';                 -- client maps this to "update required"
    end if;
  end if;
end;
$$;

-- ---------- soft delete through the one door ----------
-- Stores the job's last-known content inside the tombstone so a deleted job
-- stays recoverable server-side (214's trash trigger + 215's history also
-- fire, since this is an ordinary UPDATE).
create or replace function public.tombstone_project(
  p_id uuid, p_data jsonb default null, p_build text default null)
returns jsonb
language plpgsql security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare cur_data jsonb; cur_deleted boolean; body jsonb; rc int;
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

  update public.field_projects set data = body, deleted = true where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'tombstone_project: row vanished, retry'; end if;
  return jsonb_build_object('status','tombstoned');
end;
$$;

-- ---------- deliberate revive through the one door ----------
-- Guarded on the row still being DELETED: if another device already revived
-- it, this returns conflict + the live row so the caller merges against it
-- next cycle instead of clobbering (mirrors supa.js reviveRow).
create or replace function public.revive_project(
  p_id uuid, p_data jsonb, p_build text default null)
returns jsonb
language plpgsql security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare cur_rev int; cur_data jsonb; cur_deleted boolean; new_rev int; rc int;
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'revive_project: id and a JSON-object data are required';
  end if;
  perform public._sync_guard(p_build);

  select (data->>'rev')::int, data, deleted
    into cur_rev, cur_data, cur_deleted
    from public.field_projects where id = p_id for update;

  if not found then
    return jsonb_build_object('status','missing');
  end if;
  if not cur_deleted then                        -- someone already revived it
    return jsonb_build_object('status','conflict','rev',coalesce(cur_rev,0),'data',cur_data);
  end if;

  new_rev := coalesce(cur_rev, 0) + 1;
  update public.field_projects
     set data = jsonb_set(p_data - 'rev', '{rev}', to_jsonb(new_rev)), deleted = false
   where id = p_id and deleted;
  get diagnostics rc = row_count;
  if rc = 0 then                                 -- lost the race after the read
    select (data->>'rev')::int, data into cur_rev, cur_data
      from public.field_projects where id = p_id;
    return jsonb_build_object('status','conflict','rev',coalesce(cur_rev,0),'data',cur_data);
  end if;
  return jsonb_build_object('status','revived','rev',new_rev);
end;
$$;

-- ---------- push_project gains the same build gate ----------
-- (identical to 217 otherwise; the role check moves into _sync_guard)
create or replace function public.push_project(
  p_id uuid, p_base_rev int, p_data jsonb, p_build text default null)
returns jsonb
language plpgsql security definer
set search_path = public
set lock_timeout = '5s'
as $$
declare
  cur_rev int; cur_data jsonb; cur_deleted boolean; found_row boolean;
  new_rev int; merged jsonb; rc int;
  ts_in timestamptz; ts_cur timestamptz; ts_new timestamptz; now_iso text;
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'push_project: id and a JSON-object data are required';
  end if;
  perform public._sync_guard(p_build);

  select (data->>'rev')::int, data, deleted
    into cur_rev, cur_data, cur_deleted
    from public.field_projects where id = p_id
    for update;
  found_row := found;

  if not found_row then
    begin
      insert into public.field_projects (id, data, deleted)
      values (p_id, jsonb_set(p_data - 'rev', '{rev}', to_jsonb(1)), false);
      return jsonb_build_object('status','insert','rev',1);
    exception when unique_violation then
      select (data->>'rev')::int, data, deleted
        into cur_rev, cur_data, cur_deleted
        from public.field_projects where id = p_id for update;
      if not found then
        raise exception 'push_project: row vanished mid-insert, retry';
      end if;
    end;
  end if;

  cur_rev := coalesce(cur_rev, 0);

  if cur_deleted then
    return jsonb_build_object('status','deleted','rev',cur_rev,'data',cur_data);
  end if;

  if cur_rev = coalesce(p_base_rev, 0) then
    new_rev := cur_rev + 1;
    update public.field_projects
       set data = jsonb_set(p_data - 'rev', '{rev}', to_jsonb(new_rev)), deleted = false
     where id = p_id;
    get diagnostics rc = row_count;
    if rc = 0 then raise exception 'push_project: row vanished mid-apply, retry'; end if;
    return jsonb_build_object('status','applied','rev',new_rev);
  end if;

  merged := public.merge_project_blobs(p_data - 'rev', cur_data);

  -- SELF-ECHO GUARD: the union adds nothing the server doesn't already hold
  -- (stale bookkeeping re-pushing identical content, or a device that already
  -- merged). Write NOTHING and hand back the current copy to adopt clean.
  -- Without this every no-op re-save rewrites the whole row — on the 3 MB job
  -- that is the Jul-2026 disk-IO burn, and two such devices ping-pong revs.
  if (merged - 'rev' - 'updatedAt') = (cur_data - 'rev' - 'updatedAt') then
    return jsonb_build_object('status','current','rev',cur_rev,'data',cur_data);
  end if;

  new_rev := cur_rev + 1;
  merged := jsonb_set(merged, '{rev}', to_jsonb(new_rev));
  -- Stamp an updatedAt that is strictly newer than BOTH inputs and never
  -- behind the server clock. Plain now() is not enough: field tablets run
  -- with skewed clocks, and a merged blob that isn't strictly newer gets
  -- silently skipped by every other device's "local wins ties" pull guard,
  -- so the unioned-in work would never propagate.
  begin ts_in  := (p_data   ->> 'updatedAt')::timestamptz; exception when others then ts_in  := null; end;
  begin ts_cur := (cur_data ->> 'updatedAt')::timestamptz; exception when others then ts_cur := null; end;
  ts_new := greatest(coalesce(ts_in, to_timestamp(0)), coalesce(ts_cur, to_timestamp(0)))
            + interval '1 millisecond';
  if ts_new < now() then ts_new := now(); end if;
  now_iso := to_char(ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  merged := jsonb_set(merged, '{updatedAt}', to_jsonb(now_iso));
  update public.field_projects set data = merged, deleted = false where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'push_project: row vanished mid-merge, retry'; end if;
  return jsonb_build_object('status','merged','rev',new_rev,'data',merged);
end;
$$;

-- ---------- grants ----------
-- Supabase's default privileges GRANT execute to anon+authenticated on new
-- public functions, so role grants must be revoked explicitly.
revoke execute on function public._sync_guard(text)                       from public, anon, authenticated;
revoke execute on function public.tombstone_project(uuid, jsonb, text)    from public, anon;
revoke execute on function public.revive_project(uuid, jsonb, text)       from public, anon;
revoke execute on function public.push_project(uuid, int, jsonb, text)    from public, anon;
grant  execute on function public.tombstone_project(uuid, jsonb, text)    to authenticated;
grant  execute on function public.revive_project(uuid, jsonb, text)       to authenticated;
grant  execute on function public.push_project(uuid, int, jsonb, text)    to authenticated;
