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
--   3. merge_project_blobs: a photo deleted while the number it filled in was
--      unchecked takes that number out of the merged map too, when the other
--      copy already took it out — the twin of the same rule in merge.js.
--   4. app_settings min_field_build is raised to 211 (THE PHONE CHECK below).
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
-- THE PHONE CHECK — this file raises the floor. A build before v211 merges
-- meterPhotos on the phone as one value (its own list whole), so after a
-- merge on the phone it can hold a copy missing another phone's photos,
-- reads and checks on the rev it adopted, and push it: push_project writes a
-- copy on the current rev over the server's as is (the 'applied' path never
-- merges). A dropped photo has no other copy. Meter photos only exist once
-- this file is applied (the phones' check above), so the same step raises
-- app_settings min_field_build to 211 (never lowers it): from then on
-- _sync_guard refuses every save from an older build with "update the app",
-- and its saves wait on the phone until it reloads onto v211. v211 re-bases
-- any row an older build left dirty, once per install, so the server merges
-- it (apps/field/js/sync.js rebaseDirtyOnce). Unlike 0018 and 0022, which
-- left the floor to the owner, this one is not optional.
--
-- ROLLBACK: put 0022's two definitions back. Phones that already switched the
-- 📷 on keep it on, so only roll back once no phone writes meter photos. The
-- floor stays; lowering it is the owner's call.
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
  d record; locn numeric; loc int; mi int; ri int; mri int; ori int; s int;
  mm jsonb; om jsonb; cur jsonb; theirs jsonb; same_cur boolean; same_theirs boolean;
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

  -- ---------- a deleted photo's unchecked number goes with it ----------
  -- Twin of the same block in apps/field/js/merge.js (new in 0024). Deleting
  -- or retaking a meter photo whose number the reader filled in, unchecked,
  -- takes the number out of its cell on the phone. A moisture map merges
  -- whole, so a newer copy of the map saved before the delete would put it
  -- back, looking typed. For each photo the marks drop that carries an
  -- unchecked `filled` (the first non-empty one, newer copy first; no copy
  -- has `ok`), when the newer copy has its map: if the merged cell still
  -- holds that number and the older copy's cell does not, the merged cell
  -- takes the older copy's value ("" for none). The row is the one with the
  -- photo's rowKey, else the one row with its date. A cell matches when both
  -- are the same string, or both are short numbers (40 characters, a 2-digit
  -- exponent at most) equal as float8, after the first comma becomes a point
  -- and edge whitespace goes; a null cell is "", and a non-string never
  -- matches. Photos go in the order merge.js meets them.
  if any_gone and jsonb_typeof(merged -> 'moistureMaps') = 'array' then
    for d in
      with sides as (
        select sd.side, e.el, e.ord
          from (values (0, newer -> 'meterPhotos'), (1, older -> 'meterPhotos')) as sd(side, list)
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(sd.list) = 'array' then sd.list else '[]'::jsonb end) with ordinality as e(el, ord)
         where jsonb_typeof(e.el) = 'object'
           and jsonb_typeof(e.el -> 'id') = 'string' and e.el ->> 'id' <> ''
           and jsonb_exists(marks, e.el ->> 'id')
      )
      select (array_agg(el order by side, ord))[1] as ph,
             (array_agg(el ->> 'filled' order by side, ord)
                filter (where jsonb_typeof(el -> 'filled') = 'string' and el ->> 'filled' <> ''))[1] as filled,
             bool_or(jsonb_typeof(el -> 'ok') = 'string' and el ->> 'ok' <> '') as ok
        from sides
       group by el ->> 'id'
       order by min(side::bigint * 4294967296 + ord)
    loop
      if d.filled is null or d.ok then continue; end if;
      if jsonb_typeof(d.ph -> 'mapId') is distinct from 'string' or d.ph ->> 'mapId' = '' then continue; end if;
      if jsonb_typeof(d.ph -> 'loc') is distinct from 'number' then continue; end if;
      locn := (d.ph ->> 'loc')::numeric;
      -- past any real array: merge.js finds nothing there either
      if locn < 0 or locn <> trunc(locn) or locn > 2147483646 then continue; end if;
      loc := locn::int;
      if not exists (
        select 1 from jsonb_array_elements(
          case when jsonb_typeof(newer -> 'moistureMaps') = 'array' then newer -> 'moistureMaps' else '[]'::jsonb end) x
         where jsonb_typeof(x) = 'object' and x -> 'id' = d.ph -> 'mapId') then
        continue;                                                 -- the merged map is not the newer copy's
      end if;
      select (x.ord - 1)::int, x.el into mi, mm
        from jsonb_array_elements(merged -> 'moistureMaps') with ordinality as x(el, ord)
       where jsonb_typeof(x.el) = 'object' and x.el -> 'id' = d.ph -> 'mapId'
       order by x.ord limit 1;
      select x.el into om
        from jsonb_array_elements(
          case when jsonb_typeof(older -> 'moistureMaps') = 'array' then older -> 'moistureMaps' else '[]'::jsonb end)
          with ordinality as x(el, ord)
       where jsonb_typeof(x.el) = 'object' and x.el -> 'id' = d.ph -> 'mapId'
       order by x.ord limit 1;
      mri := null; ori := null;
      for s in 0..1 loop
        ri := null;
        if jsonb_typeof(d.ph -> 'rowKey') = 'string' and d.ph ->> 'rowKey' <> '' then
          select (x.ord - 1)::int into ri
            from jsonb_array_elements(case when jsonb_typeof((case s when 0 then mm else om end) -> 'readings') = 'array'
                                           then (case s when 0 then mm else om end) -> 'readings' else '[]'::jsonb end)
                 with ordinality as x(el, ord)
           where jsonb_typeof(x.el) = 'object' and jsonb_typeof(x.el -> 'rk') = 'string'
             and x.el ->> 'rk' = d.ph ->> 'rowKey'
           order by x.ord limit 1;
        end if;
        if ri is null and jsonb_typeof(d.ph -> 'date') = 'string' and d.ph ->> 'date' <> '' then
          select case when count(*) = 1 then (min(x.ord) - 1)::int end into ri
            from jsonb_array_elements(case when jsonb_typeof((case s when 0 then mm else om end) -> 'readings') = 'array'
                                           then (case s when 0 then mm else om end) -> 'readings' else '[]'::jsonb end)
                 with ordinality as x(el, ord)
           where jsonb_typeof(x.el) = 'object' and jsonb_typeof(x.el -> 'date') = 'string'
             and x.el ->> 'date' = d.ph ->> 'date';
        end if;
        if s = 0 then mri := ri; else ori := ri; end if;
      end loop;
      if mri is null or ori is null then continue; end if;
      if jsonb_typeof(mm -> 'readings' -> mri -> 'values') is distinct from 'array' then continue; end if;
      cur := mm -> 'readings' -> mri -> 'values' -> loc;
      theirs := case when jsonb_typeof(om -> 'readings' -> ori -> 'values') = 'array'
                     then om -> 'readings' -> ori -> 'values' -> loc end;
      select bool_or(t.same) filter (where t.k = 0), bool_or(t.same) filter (where t.k = 1)
        into same_cur, same_theirs
        from (
          select c.k,
                 case when c.x is null then false
                      when c.x = '' or c.y = '' then c.x = c.y
                      when c.x ~ '^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]{1,2})?$'
                       and c.y ~ '^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]{1,2})?$'
                       and length(c.x) <= 40 and length(c.y) <= 40
                        then c.x::float8 = c.y::float8
                      else c.x = c.y
                 end as same
            from (
              select v.k,
                     regexp_replace(regexp_replace(
                       case when v.val is null or jsonb_typeof(v.val) = 'null' then ''
                            when jsonb_typeof(v.val) = 'string' then v.val #>> '{}' end,
                       ',', '.'), '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g') as x,
                     regexp_replace(regexp_replace(d.filled, ',', '.'), '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g') as y
                from (values (0, cur), (1, theirs)) as v(k, val)
            ) c
        ) t;
      if same_cur and not same_theirs then
        merged := jsonb_set(merged, array['moistureMaps', mi::text, 'readings', mri::text, 'values', loc::text],
                            case when theirs is null or jsonb_typeof(theirs) = 'null' then '""'::jsonb else theirs end,
                            false);
      end if;
    end loop;
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
-- The build floor: 211 or more (THE PHONE CHECK above). Raised, never
-- lowered; read the way _sync_guard reads it.
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values ('min_field_build', to_jsonb(211))
on conflict (key) do update set value = excluded.value, updated_at = now()
 where not (jsonb_typeof(public.app_settings.value) = 'number'
            and (public.app_settings.value)::text::numeric >= 211);


-- ---------------------------------------------------------------------------
-- Assertions. Structural, so they bind on the CI replay too: both server lists
-- carry the meter photos (and still carry the scan log), and the floor holds.
-- ---------------------------------------------------------------------------
do $$
declare f text; k text;
begin
  if coalesce((select (value)::text::int from public.app_settings where key = 'min_field_build'), 0) < 211 then
    raise exception '0024: min_field_build is below 211';
  end if;
  foreach f in array array['public.merge_project_blobs(jsonb, jsonb)', 'public._mf_sweep_tombstones(jsonb)'] loop
    foreach k in array array['equipmentScans', 'meterPhotos'] loop
      if position('''' || k || '''' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
        raise exception '0024: % does not list % in its id collections', f, k;
      end if;
    end loop;
  end loop;
end
$$;
