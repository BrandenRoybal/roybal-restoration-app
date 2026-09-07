-- ============================================================
-- 241: per-item delete tombstones in the server-side merge
-- ------------------------------------------------------------
-- merge_project_blobs (217) is a pure union: id-keyed collections take
-- everything both sides have. That makes a DELETE unrepresentable. To the
-- merge, "the desktop deleted this photo" and "the desktop never had this
-- photo" are the same input, so any device still holding the element pushes
-- it straight back — every cycle, forever.
--
-- Aug 15 2026, job a28754b4 (Fidler): 163 photos were deleted on the desktop
-- and the phone kept showing all 187. Nothing was broken — the union was doing
-- exactly what it was written to do. Re-syncing could never have fixed it, and
-- the moment that phone landed one clean push, the delete would have been
-- undone for everyone.
--
-- The fix (apps/field/js/merge.js, ported here): a delete records a mark in
-- `data->'deletedIds'` (element id -> ISO stamp) that travels with the job like
-- any other edit, and the merge honours it — a tombstoned id is dropped from
-- the union no matter which side still carries the element.
--
-- The tombstone wins UNCONDITIONALLY, with no clock comparison. Element ids are
-- uuids and are never reused, so "deleted" is terminal for an id and there is
-- no later version to lose; a device with a skewed clock therefore cannot
-- un-delete anything, which is the failure mode that matters in the field.
--
-- Deleted content is still recoverable: field_photos keeps the row and stamps
-- deleted_at (225), field_projects_trash keeps whole-job deletes, and every
-- device snapshots to its local backups store before a merge.
--
-- PARITY: this stays a line-for-line port of merge.js. Same two documented
-- divergences as 217 (both unreachable with real data), plus one new one that
-- is only reachable past the 2000-tombstone cap: JS orders the cap by
-- localeCompare, this orders by C collation with a key tiebreak. Deleting
-- 2000+ elements from one job is not a real workload.
-- ============================================================

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
  max_tombstones int := 2000;      -- keep in step with MAX_TOMBSTONES in merge.js
  newer jsonb; older jsonb; merged jsonb;
  k text; ol jsonb; nl jsonb; missing jsonb; kept jsonb;
  o_rooms jsonb; n_rooms jsonb; r jsonb; m jsonb; ov jsonb;
  marks jsonb; any_gone boolean;
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

  -- ---------- deletes are decided FIRST, and bind BOTH sides ----------
  -- union of both copies' marks; for an id both sides deleted, the EARLIER
  -- stamp is kept (it is the truthful one). Capped to the newest N marks.
  with all_marks as (
    select key, value from jsonb_each(
      case when jsonb_typeof(older -> 'deletedIds') = 'object' then older -> 'deletedIds' else '{}'::jsonb end)
    union all
    select key, value from jsonb_each(
      case when jsonb_typeof(newer -> 'deletedIds') = 'object' then newer -> 'deletedIds' else '{}'::jsonb end)
  ), picked as (
    select key, min((value #>> '{}') collate "C") as ts from all_marks group by key
  ), capped as (
    select key, ts from picked order by ts desc, key desc limit max_tombstones
  )
  select coalesce(jsonb_object_agg(key, to_jsonb(ts)), '{}'::jsonb) into marks from capped;

  any_gone := marks <> '{}'::jsonb;
  -- an empty map is never written: it would be noise in every row, and the
  -- client's self-echo check (sync.js sameContent) compares content exactly
  if any_gone then merged := jsonb_set(merged, array['deletedIds'], marks, true); end if;

  -- id-keyed collections union by id (newer's element wins an id clash),
  -- set-based + order-preserving; id membership compared by jsonb VALUE.
  -- A tombstoned id is neither carried over from the older copy nor kept in
  -- the newer one — the mark outranks both.
  foreach k in array id_cols loop
    ol := older -> k;
    if ol is null or jsonb_typeof(ol) <> 'array' then ol := '[]'::jsonb; end if;
    if jsonb_typeof(merged -> k) = 'array' then
      nl := merged -> k;
    elsif jsonb_array_length(ol) > 0 then
      nl := '[]'::jsonb;                                         -- older had rows → key becomes an array
    else
      continue;                                                  -- neither side has this collection
    end if;

    if jsonb_array_length(ol) > 0 then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into missing
      from jsonb_array_elements(ol) with ordinality as t(e, ord)
      where jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> ''
        and not (marks ? (e->>'id'))                             -- blocked resurrection
        and not exists (
          select 1 from jsonb_array_elements(nl) x
          where jsonb_typeof(x) = 'object' and x -> 'id' = e -> 'id');
      nl := nl || missing;
    end if;

    if any_gone then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into kept
      from jsonb_array_elements(nl) with ordinality as t(e, ord)
      where not (jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> '' and marks ? (e->>'id'));
      nl := kept;
    end if;

    merged := jsonb_set(merged, array[k], nl, true);
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


-- ---------- the invariant, enforced on every write path ----------
-- merge_project_blobs above only runs on a STALE-base push. The insert and
-- applied paths in push_project store the client's blob verbatim, so a device
-- running a build that predates tombstones can still write a copy that
-- contradicts its own deletedIds map (its client-side union re-adds the
-- element while carrying the mark forward) and undo the delete for everyone.
--
-- So the rule is made a property of the STORED ROW, not of the merge: a blob
-- is never stored holding an element its own deletedIds tombstones. Cheap,
-- idempotent, and independent of which build the caller is running.
create or replace function public._mf_sweep_tombstones(blob jsonb)
returns jsonb immutable language plpgsql as $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs'];
  marks jsonb; k text; arr jsonb; kept jsonb;
begin
  marks := blob -> 'deletedIds';
  if marks is null or jsonb_typeof(marks) <> 'object' or marks = '{}'::jsonb then return blob; end if;
  foreach k in array id_cols loop
    arr := blob -> k;
    if jsonb_typeof(arr) <> 'array' or jsonb_array_length(arr) = 0 then continue; end if;
    select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into kept
    from jsonb_array_elements(arr) with ordinality as t(e, ord)
    where not (jsonb_typeof(e) = 'object' and coalesce(e->>'id','') <> '' and marks ? (e->>'id'));
    if jsonb_array_length(kept) <> jsonb_array_length(arr) then
      blob := jsonb_set(blob, array[k], kept, true);
    end if;
  end loop;
  return blob;
end;
$$;

-- push_project, unchanged from 218 except that the two paths which store the
-- caller's blob verbatim (insert, applied) now sweep it first.
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
  clean jsonb;
begin
  if p_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'push_project: id and a JSON-object data are required';
  end if;
  perform public._sync_guard(p_build);

  clean := public._mf_sweep_tombstones(p_data - 'rev');   -- a blob never contradicts its own deletes

  select (data->>'rev')::int, data, deleted
    into cur_rev, cur_data, cur_deleted
    from public.field_projects where id = p_id
    for update;
  found_row := found;

  if not found_row then
    begin
      insert into public.field_projects (id, data, deleted)
      values (p_id, jsonb_set(clean, '{rev}', to_jsonb(1)), false);
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
       set data = jsonb_set(clean, '{rev}', to_jsonb(new_rev)), deleted = false
     where id = p_id;
    get diagnostics rc = row_count;
    if rc = 0 then raise exception 'push_project: row vanished mid-apply, retry'; end if;
    return jsonb_build_object('status','applied','rev',new_rev);
  end if;

  merged := public.merge_project_blobs(clean, cur_data);

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
