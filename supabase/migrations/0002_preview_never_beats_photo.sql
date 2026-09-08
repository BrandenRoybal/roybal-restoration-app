-- ============================================================================
-- 0002 -- a preview never beats the photograph (thumbnails, stage 2)
--
-- Stage 1 (PR #193) filled the field-media bucket with a `thumb_<sha256>`
-- beside every photo and deliberately read none of them. Stage 2 reads them:
-- a device that does not already hold a photo now pulls its ~12 KB thumbnail
-- instead of the ~228 KB original -- a fresh iPad goes from ~170 MB to ~9 MB
-- before it is usable -- and the full resolution is fetched on demand by
-- machinery that already shipped (photoFullSrc / the lightbox / ZIP export,
-- all keyed on the photo entry's `cloud` hash).
--
-- A previewed entry is marked: { src: <preview>, cloud: <hash>,
-- previewOf: "media:<hash>:<len>" }. The client undoes that mark before every
-- push, so the row it sends is byte-identical to the row it received and no
-- preview should ever reach this database.
--
-- This migration is what happens if that is ever untrue. merge_project_blobs
-- is the server-side twin of apps/field/js/merge.js, and it gains the same
-- rule: on a photos[] id clash, the copy holding the real bytes wins over the
-- copy holding a stand-in, whichever one is newer.
--
-- SCOPE: one function body, replaced. No table, column, policy or index
-- changes; nothing else in the merge is touched, so the parity with merge.js
-- that the rest of this function documents is preserved.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."merge_project_blobs"("a" "jsonb", "b" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
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

  return merged;
end;
$$;
