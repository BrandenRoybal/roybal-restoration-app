-- ============================================================
-- 217: push_project RPC — server-side merge authority (Phase 2a)
-- ------------------------------------------------------------
-- Phase 2 of the sync rearchitecture (docs/Sync_Rearchitecture_Plan.md):
-- the clobber-killer. Today every field_projects write is a rev-guarded
-- PATCH and the union MERGE runs on the CLIENT (apps/field/js/merge.js). A
-- stale or buggy client that bypasses the guard, or that merges wrong, can
-- still lose data (the Aug 6 Awthentis clobber).
--
-- This migration ports merge.js into SQL and adds one authoritative write
-- path, push_project():
--   • row absent           → INSERT (rev 1)
--   • caller's base == rev  → wholesale APPLY (honors intentional element
--                             deletions — the caller is up to date)
--   • caller's base != rev  → server MERGES (union) so nothing the caller
--                             lacks is lost, stores it, returns the merged
--                             blob for the caller to adopt
--   • row is deleted        → returns the tombstone; the caller decides
--                             revive-vs-respect (blank-detection is
--                             client-side) — no server write
-- Called WITH the user's JWT: SECURITY DEFINER bypasses RLS to write, while
-- auth.uid() inside still resolves to the real user, so stamp_updated_by
-- (216) and blob_history (215) attribute and version correctly.
--
-- ⚠️ Phase 2a is ADDITIVE: nothing calls push_project yet, and direct
-- table writes stay granted, so old clients keep working. Phase 2b wires
-- apps/field/js/sync.js to this RPC, adds revive+tombstone RPCs and a
-- min-build gate, then REVOKES direct INSERT/UPDATE from app clients so the
-- RPC is the only door. Scope here is field_projects only (the board's
-- coordination_jobs gets its own RPC later).
--
-- The SQL merge is a line-for-line port of merge.js and is proven
-- equivalent by differential testing (JS mergeProjects vs SQL over the
-- merge.test.mjs vectors + randomized cases) before wiring — see the PR.
-- ============================================================

set lock_timeout = '5s';

-- ---------- merge.js port (pure, immutable) ----------

-- isEmptyish(v): null | JSON null | "" | [] | {}
create or replace function public._mf_emptyish(v jsonb)
returns boolean immutable language sql as $$
  select v is null
      or jsonb_typeof(v) = 'null'
      or (jsonb_typeof(v) = 'string' and v #>> '{}' = '')
      or (jsonb_typeof(v) = 'array'  and jsonb_array_length(v) = 0)
      or (jsonb_typeof(v) = 'object' and not exists (select 1 from jsonb_object_keys(v)));
$$;

-- isObj(v): non-null JSON object (not an array)
create or replace function public._mf_is_obj(v jsonb)
returns boolean immutable language sql as $$
  select v is not null and jsonb_typeof(v) = 'object';
$$;

-- every element is an object carrying a truthy id (empty array → true),
-- i.e. the array is safe to union by id
create or replace function public._mf_all_ids(arr jsonb)
returns boolean immutable language sql as $$
  select jsonb_typeof(arr) = 'array' and not exists (
    select 1 from jsonb_array_elements(arr) e
    where jsonb_typeof(e) <> 'object' or coalesce(e->>'id','') = ''
  );
$$;

-- mergeForm(newerV, olderV): a filled field beats an empty one; id-keyed
-- sub-arrays union; objects merge key-by-key. Returns the merged value
-- (SQL NULL models JS `undefined` so a caller can omit the key).
create or replace function public._mf_form(nv jsonb, ov jsonb)
returns jsonb immutable language plpgsql as $$
declare
  out jsonb; k text; missing jsonb; v jsonb;
begin
  if ov is null then return nv; end if;                         -- olderV === undefined
  if public._mf_emptyish(nv) and not public._mf_emptyish(ov) then
    return ov;                                                  -- empty never beats filled
  end if;

  if jsonb_typeof(nv) = 'array' and jsonb_typeof(ov) = 'array' then
    if public._mf_all_ids(nv) and public._mf_all_ids(ov) then
      -- union older elements whose id (compared by jsonb VALUE, so 1 <> "1"
      -- like JS ===) is not already present; order-preserving + set-based
      -- (no O(n^2) accumulator copy under the push lock)
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into missing
      from jsonb_array_elements(ov) with ordinality as t(e, ord)
      where not exists (select 1 from jsonb_array_elements(nv) x where x -> 'id' = e -> 'id');
      if jsonb_array_length(missing) > 0 then return nv || missing; end if;
      return nv;
    end if;
    return nv;                                                  -- non-id arrays: newer wins
  end if;

  if public._mf_is_obj(nv) and public._mf_is_obj(ov) then
    out := nv;
    for k in select jsonb_object_keys(ov) loop
      v := public._mf_form(nv -> k, ov -> k);
      if v is not null then out := jsonb_set(out, array[k], v, true);
      else out := out - k; end if;                              -- JS undefined → omitted
    end loop;
    return out;
  end if;

  return nv;
end;
$$;

-- mergeProjects(a, b).merged — union two copies of one project.
-- newer (by updatedAt, ties → a) is the base; older contributes anything
-- the newer lacks. C collation makes the string compare match JS's.
create or replace function public.merge_project_blobs(a jsonb, b jsonb)
returns jsonb immutable language plpgsql as $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs'];
  form_slots text[] := array[
    'workAuth','certDrying','laborLog','scopeOfWork','preConChecklist',
    'selections','subSchedule','punchList','drawSchedule','certCompletion',
    'portalShare','floorPlan'];
  newer jsonb; older jsonb; merged jsonb;
  k text; ol jsonb; nl jsonb; missing jsonb;
  o_rooms jsonb; n_rooms jsonb; r jsonb; m jsonb; ov jsonb;
begin
  -- NOTE ON PARITY: proven byte-equal to apps/field/js/merge.js over 2033
  -- randomized cases. Two divergences remain, both UNREACHABLE with real data
  -- (every id is a non-empty UUID string; updatedAt is always an ISO string):
  --   • id truthiness: JS excludes falsy ids (0, false); the SQL id-present
  --     gate is `->>'id' <> ''`, which keeps '0'/'false'.
  --   • updatedAt newer-pick: JS coerces falsy non-strings (0, false) to '';
  --     `->>` here yields their literal text.
  if coalesce(a->>'updatedAt','') collate "C" >= coalesce(b->>'updatedAt','') collate "C"
    then newer := a; older := b;
    else newer := b; older := a;
  end if;
  merged := newer;

  -- id-keyed collections union by id (newer's element wins an id clash),
  -- set-based + order-preserving; id membership compared by jsonb VALUE
  foreach k in array id_cols loop
    ol := older -> k;
    if ol is null or jsonb_typeof(ol) <> 'array' or jsonb_array_length(ol) = 0 then continue; end if;
    nl := case when jsonb_typeof(merged -> k) = 'array' then merged -> k else '[]'::jsonb end;
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into missing
    from jsonb_array_elements(ol) with ordinality as t(e, ord)
    where jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> ''
      and not exists (
        select 1 from jsonb_array_elements(nl) x
        where jsonb_typeof(x) = 'object' and x -> 'id' = e -> 'id');
    if jsonb_array_length(missing) > 0 then
      merged := jsonb_set(merged, array[k], nl || missing, true);
    elsif jsonb_typeof(merged -> k) is distinct from 'array' then
      merged := jsonb_set(merged, array[k], nl, true);           -- older had rows → key is now an array
    end if;
  end loop;

  -- rooms: shared string list, union by value
  o_rooms := older -> 'rooms';
  if jsonb_typeof(o_rooms) = 'array' and jsonb_array_length(o_rooms) > 0 then
    n_rooms := case when jsonb_typeof(merged -> 'rooms') = 'array' then merged -> 'rooms' else '[]'::jsonb end;
    for r in select e from jsonb_array_elements(o_rooms) e loop
      if not exists (select 1 from jsonb_array_elements(n_rooms) x where x = r) then
        n_rooms := n_rooms || jsonb_build_array(r);
      end if;
    end loop;
    merged := jsonb_set(merged, array['rooms'], n_rooms, true);
  end if;

  -- single-form slots: filled beats empty; two filled merge field-wise
  foreach k in array form_slots loop
    m := merged -> k;
    ov := older -> k;
    if m is null or jsonb_typeof(m) = 'null' then
      if ov is not null and jsonb_typeof(ov) <> 'null' then
        merged := jsonb_set(merged, array[k], ov, true);
      end if;
    elsif ov is null or jsonb_typeof(ov) = 'null' then
      null;                                                      -- newer holds it, older empty → keep
    else
      merged := jsonb_set(merged, array[k], public._mf_form(m, ov), true);
    end if;
  end loop;

  return merged;
end;
$$;

-- ---------- the one authoritative write path ----------
-- CONTRACT (for the Phase 2b client wiring):
--   'insert'  → row created at rev 1. Adopt CLEAN (revs=1, pushed=updatedAt).
--   'applied' → caller was up to date; wholesale stored at rev. Adopt CLEAN.
--   'merged'  → server already committed the union at rev, with a FRESH
--               server-clock updatedAt in `data`. Client MUST adopt it CLEAN
--               (inflate media markers, drop rev, Store.putIf, revs=rev,
--               pushed=data.updatedAt) with NO updatedAt bump and NO re-push —
--               re-dirtying it re-creates the Jul-2026 self-echo rev-storm.
--               (merge stats/toast counts are not returned; diff client-side if
--               the "recovered N" toast is wanted.)
--   'deleted' → row is a tombstone; NO write happened. Client runs its own
--               revive-vs-respect decision (blank detection is client-side).
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
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'push_project: id and a JSON-object data are required';
  end if;
  -- RLS is BYPASSED inside this SECURITY DEFINER function (owner has BYPASSRLS),
  -- so re-assert who may write: only real crew (tech/admin/office). Keeps the AI
  -- service accounts (role viewer) and any profile-less caller out — the fence
  -- the agent-deny RLS policies give on the direct write path.
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tech','admin','office')
  ) then
    raise exception 'push_project: this account may not write field_projects';
  end if;

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
    exception when unique_violation then                        -- concurrent insert: re-read + fall through
      select (data->>'rev')::int, data, deleted
        into cur_rev, cur_data, cur_deleted
        from public.field_projects where id = p_id for update;
      if not found then                                        -- inserted then hard-deleted in the window
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

  -- stale base: server merges the union so nothing the caller lacks is lost.
  -- Stamp a FRESH server-clock updatedAt so the unioned-in elements actually
  -- propagate — otherwise the merged blob keeps the already-distributed newer
  -- updatedAt and other devices' pull tie-guard (<=) silently skips it.
  merged := public.merge_project_blobs(p_data - 'rev', cur_data);
  new_rev := cur_rev + 1;
  merged := jsonb_set(merged, '{rev}', to_jsonb(new_rev));
  merged := jsonb_set(merged, '{updatedAt}', to_jsonb(now_iso));
  update public.field_projects set data = merged, deleted = false where id = p_id;
  get diagnostics rc = row_count;
  if rc = 0 then raise exception 'push_project: row vanished mid-merge, retry'; end if;
  return jsonb_build_object('status','merged','rev',new_rev,'data',merged);
end;
$$;

-- Grants. Supabase's default privileges GRANT execute to anon+authenticated
-- on new public functions, so `from public` alone is not enough — the role
-- grants must be revoked explicitly. push_project is reachable only by a
-- signed-in user; the merge + helpers are internal (the SECURITY DEFINER
-- push_project calls them as its owner, so app roles need no grant).
revoke execute on function public._mf_emptyish(jsonb)              from public, anon, authenticated;
revoke execute on function public._mf_is_obj(jsonb)                from public, anon, authenticated;
revoke execute on function public._mf_all_ids(jsonb)              from public, anon, authenticated;
revoke execute on function public._mf_form(jsonb, jsonb)          from public, anon, authenticated;
revoke execute on function public.merge_project_blobs(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.push_project(uuid, int, jsonb, text) from public, anon;
grant  execute on function public.push_project(uuid, int, jsonb, text) to authenticated;
