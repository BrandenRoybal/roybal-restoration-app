-- ============================================================================
-- 0024 — meter photos on moisture readings: the server merge learns
--        meterPhotos (field v211).
--
-- WHAT IT IS FOR: a tech photographs the moisture meter's screen beside a
-- reading on the Moisture Map (apps/field/js/meterphotos.js). The photo is
-- the evidence an adjuster can check the number against; the reader in
-- roybal-ai-office (meterRead) only ever offers the number as a prefill the
-- tech confirms. The photos live in the job blob as project.meterPhotos[], a
-- top-level collection whose elements carry their own ids, and NOT inside the
-- moisture map element: a map merges whole (the newer device's copy wins), so
-- a photo nested in it would vanish whenever another device's newer copy of
-- the map won. A top-level element with its own id survives every merge —
-- once the server merge knows the collection is one.
--
-- WHAT THIS CHANGES: merge_project_blobs and _mf_sweep_tombstones are 0022's
-- definitions with two additions, and nothing else:
--   1. 'meterPhotos' in both id_cols, so the server unions the photos and
--      honours their deletes. apps/field/test/merge-sql-parity.test.mjs holds
--      both lists to merge.js ID_COLLECTIONS.
--   2. merge_project_blobs: a photo's `read` and `ok` (with `filled` and
--      `fixed`) are never undone by a newer copy saved before they landed —
--      the twin of the same rule in merge.js.
-- Grants survive CREATE OR REPLACE; none are restated.
--
-- WHY THE PHONES WAIT FOR IT: until this is applied the server merge treats
-- meterPhotos as one plain value (the newer copy wins whole). Two phones
-- photographing the same job between syncs would then lose one phone's
-- photos on the server, and a clean device adopting that copy would lose
-- them too; nothing else holds a copy. So v211 keeps the 📷 switched off
-- until the server answers that it knows the collection: it asks
-- _mf_sweep_tombstones (which crew logins may already call) to sweep a
-- tombstoned test photo, and switches on only when the photo comes back
-- swept (apps/field/js/meterui.js checkMeterServer). Once on, it stays on.
--
-- No table, policy, trigger, view or enum is added; the two functions are
-- replaced, not added, so the db-replay census is unchanged. Nothing reads
-- the photos server-side yet: the office sees them in the field app's own
-- Moisture Map and Certificate of Drying views, from the blob.
--
-- THE PHONE CHECK: v210 and older never write meterPhotos and carry another
-- phone's as a plain value (filled beats empty), which this merge then
-- unions; raising min_field_build to v211 is optional and the owner's call.
--
-- ROLLBACK: put 0022's two definitions back. Phones that already switched the
-- 📷 on keep it on, so only roll back once no phone writes meter photos.
-- ============================================================================


CREATE OR REPLACE FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs','equipmentScans','meterPhotos'];
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

  -- ---------- a preview is never the photograph ----------
  -- Twin of the preview block in apps/field/js/merge.js. A photos[] entry
  -- carrying `previewOf` holds a ~320px stand-in plus the hash of the real
  -- bytes (apps/field/js/thumbs.js), not the photograph itself. When both
  -- copies carry the same photo id and one of them holds the real thing, the
  -- real thing wins -- regardless of which copy is newer, because "newer" says
  -- when a device last touched the job, not which copy of a photo is better.
  --
  -- Field-granular like the JS: the newer entry keeps its caption, room and
  -- stage edits and takes only `src` from the older one. `cloud` travels with
  -- `src` because they describe the same bytes.
  --
  -- THIS PATH SHOULD BE UNREACHABLE. The client restores every marker before
  -- it deflates anything (deflateSynced in sync.js), so a preview never
  -- reaches the wire. This is the backstop for when that stops being true --
  -- a build that skips the restore, a future writer that does not know about
  -- previews -- because the cost of being wrong is a 320px stand-in replacing
  -- the only photograph of the inside of someone's flooded house.
  --
  -- jsonb_exists() rather than the `?` operator on purpose: `?` is a parameter
  -- placeholder in several client drivers and this file must apply cleanly
  -- through all of them.
  if jsonb_typeof(merged -> 'photos') = 'array' and jsonb_typeof(older -> 'photos') = 'array' then
    select jsonb_agg(coalesce(real_photo.el, mp.el) order by mp.ord) into m
      from jsonb_array_elements(merged -> 'photos') with ordinality as mp(el, ord)
      left join lateral (
        select (mp.el - 'previewOf' - 'cloud')
               || jsonb_build_object('src', o.el -> 'src')
               || (case when jsonb_exists(o.el, 'cloud')
                        then jsonb_build_object('cloud', o.el -> 'cloud')
                        else '{}'::jsonb end) as el
          from jsonb_array_elements(older -> 'photos') as o(el)
         where jsonb_typeof(mp.el) = 'object'
           and jsonb_typeof(o.el) = 'object'
           and jsonb_exists(mp.el, 'previewOf')
           and not jsonb_exists(o.el, 'previewOf')
           and coalesce(o.el ->> 'id', '') <> ''
           and o.el ->> 'id' = mp.el ->> 'id'
           and not jsonb_exists(marks, mp.el ->> 'id')
         limit 1
      ) as real_photo on true;
    if m is not null then merged := jsonb_set(merged, array['photos'], m, true); end if;
  end if;

  -- ---------- a meter photo's read and check are never undone ----------
  -- Twin of the meterPhotos block in apps/field/js/merge.js (new in 0024).
  -- A meterPhotos element only ever GAINS its `read` (the number the reader
  -- saw, with the `filled` it put in an empty cell) and its `ok` (the tech's
  -- check, with any `fixed` typed over it). A copy of the job saved before
  -- either landed can still be the newer copy, and its element would win
  -- whole and drop them. So whichever copy has them keeps them, field by
  -- field: `read` when the newer element's is not an object and the older
  -- one's is; `ok` when the newer one's is not a non-empty string and the
  -- older one's is. The first older element with the id is the one used.
  if jsonb_typeof(merged -> 'meterPhotos') = 'array' and jsonb_typeof(older -> 'meterPhotos') = 'array' then
    select jsonb_agg(
             case when o.el is null then mp.el
                  else mp.el
                       || (case when jsonb_typeof(mp.el -> 'read') is distinct from 'object'
                                 and jsonb_typeof(o.el -> 'read') = 'object'
                            then jsonb_build_object('read', o.el -> 'read',
                                   'filled', case when jsonb_exists(o.el, 'filled') then o.el -> 'filled' else '""'::jsonb end)
                            else '{}'::jsonb end)
                       || (case when not coalesce(jsonb_typeof(mp.el -> 'ok') = 'string' and mp.el ->> 'ok' <> '', false)
                                 and jsonb_typeof(o.el -> 'ok') = 'string' and o.el ->> 'ok' <> ''
                            then jsonb_build_object('ok', o.el -> 'ok')
                                 || (case when jsonb_exists(o.el, 'fixed') then jsonb_build_object('fixed', o.el -> 'fixed') else '{}'::jsonb end)
                            else '{}'::jsonb end)
             end
             order by mp.ord) into m
      from jsonb_array_elements(merged -> 'meterPhotos') with ordinality as mp(el, ord)
      left join lateral (
        select oe.el
          from jsonb_array_elements(older -> 'meterPhotos') with ordinality as oe(el, ord)
         where jsonb_typeof(mp.el) = 'object'
           and jsonb_typeof(oe.el) = 'object'
           and jsonb_typeof(mp.el -> 'id') = 'string' and mp.el ->> 'id' <> ''
           and jsonb_typeof(oe.el -> 'id') = 'string'
           and oe.el ->> 'id' = mp.el ->> 'id'
           and not jsonb_exists(marks, mp.el ->> 'id')
         order by oe.ord
         limit 1
      ) as o on true;
    if m is not null then merged := jsonb_set(merged, array['meterPhotos'], m, true); end if;
  end if;

  return merged;
end;
$$;

ALTER FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
declare
  id_cols text[] := array[
    'photos','moistureMaps','dryingLogs','constructionLogs','invoices',
    'reconEstimates','changeOrders','receipts','inspections','contents',
    'boxes','supportDocs','equipmentScans','meterPhotos'];
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

ALTER FUNCTION "public"."_mf_sweep_tombstones"("blob" "jsonb") OWNER TO "postgres";


-- ---------------------------------------------------------------------------
-- Assertion. Structural, so it binds on the CI replay too: both server lists
-- carry the meter photos (and still carry the scan log).
-- ---------------------------------------------------------------------------
do $$
declare f text; k text;
begin
  foreach f in array array['public.merge_project_blobs(jsonb, jsonb)', 'public._mf_sweep_tombstones(jsonb)'] loop
    foreach k in array array['equipmentScans', 'meterPhotos'] loop
      if position('''' || k || '''' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
        raise exception '0024: % does not list % in its id collections', f, k;
      end if;
    end loop;
  end loop;
end
$$;
