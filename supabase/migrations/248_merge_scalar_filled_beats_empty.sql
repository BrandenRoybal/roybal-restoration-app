-- 248 — a mid-flight edit is no longer destroyed by the merge it raced
--
-- WHY. A technician typing into a job while that job's push is being merged
-- server-side lost the keystrokes on the NEXT sync cycle, and the row was then
-- marked clean so it never re-pushed. The union this function returns is stamped
-- greatest(both inputs)+1ms and then FLOORED AT THE SERVER CLOCK (241:270-272),
-- so it is a fabricated stamp, not an observed edit time. `merged := newer`
-- handed it every top-level scalar — notes, customer, address, claim number,
-- contract amount — whenever the server's clock led the tablet's, which in the
-- field is the ordinary case, not the rare one.
--
-- Every structured type here already had a rule (id-collections union, rooms and
-- lossTypes union, form slots merge field-wise with filled-beating-empty). Plain
-- top-level scalars were the one category with no rule at all. This adds the same
-- filled-beats-empty rule the form slots have used since 217.
--
-- PARITY. apps/field/js/merge.js carries the identical loop and the same skip
-- list; the JS twin ships in the same PR. The trade-off, matching mergeForm:
-- deliberately CLEARING a scalar can be undone by a merge that still carries the
-- old text. Losing a clear is recoverable by clearing again; losing typing is not.
--
-- Idempotent: create-or-replace only, no data touched, no lock beyond the
-- function definitions. Roll back by re-running 243.

/* JS isEmptyish (merge.js): null / undefined / "" / [] / {} are empty; every
   number, boolean and non-empty value is filled. */
create or replace function public._blob_emptyish(v jsonb)
returns boolean immutable language sql as $fn$
  select v is null
      or jsonb_typeof(v) = 'null'
      or (jsonb_typeof(v) = 'string' and (v #>> '{}') = '')
      or (jsonb_typeof(v) = 'array'  and jsonb_array_length(v) = 0)
      or (jsonb_typeof(v) = 'object' and v = '{}'::jsonb);
$fn$;

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
  skip_keys text[];
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

  -- loss-type chips (field loss classification): union by value like rooms —
  -- two devices classifying concurrently are BOTH right (one taps Fire, one
  -- taps Storm). Scalars inside each block stay newer-wins like every other
  -- header scalar. Mirrors apps/field/js/merge.js.
  o_rooms := older -> 'lossTypes';
  if jsonb_typeof(o_rooms) = 'array' and jsonb_array_length(o_rooms) > 0 then
    n_rooms := case when jsonb_typeof(merged -> 'lossTypes') = 'array' then merged -> 'lossTypes' else '[]'::jsonb end;
    for r in select e from jsonb_array_elements(o_rooms) e loop
      if not exists (select 1 from jsonb_array_elements(n_rooms) x where x = r) then
        n_rooms := n_rooms || jsonb_build_array(r);
      end if;
    end loop;
    merged := jsonb_set(merged, array['lossTypes'], n_rooms, true);
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

  -- ---------- top-level scalars: filled beats empty ----------
  -- The twin of the loop at the end of mergeProjects() in apps/field/js/merge.js.
  -- `merged := newer` above hands every scalar to whichever blob carries the
  -- larger updatedAt — and THIS function fabricates that stamp a few lines down
  -- in push_project (greatest(both inputs)+1ms, then floored at now()). A tablet
  -- whose clock trails the server therefore lost text it genuinely typed later.
  -- Only a BLANK ever loses here: a real edit on the newer side still wins, so a
  -- concurrent rename from another device is never reverted.
  skip_keys := id_cols || form_slots
             || array['rooms','lossTypes','id','rev','updatedAt','deleted','deletedIds'];
  for k, ov in select key, value from jsonb_each(older) loop
    if k = any(skip_keys) then continue; end if;
    if public._blob_emptyish(merged -> k) and not public._blob_emptyish(ov) then
      merged := jsonb_set(merged, array[k], ov, true);
    end if;
  end loop;

  return merged;
end;
$$;
