-- ============================================================================
-- Assertions for 0024_meter_photos.sql (the server merge learns meterPhotos,
-- the meter-screen photos on Moisture Map readings, as an id collection).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/meter_photos.test.sql <staging url>
-- Its one write (section 6) is rolled back.
--
-- The rules it holds the merge to:
--   1. Both functions list meterPhotos and still list equipmentScans, stay
--      IMMUTABLE and owned by postgres, and authenticated and anon still
--      cannot call merge_project_blobs directly (0008's revoke survived).
--   2. merge_project_blobs unions meterPhotos from both copies (the newer
--      copy of a shared photo wins whole), keeps an older phone's photos when
--      the newer copy has none, and drops a tombstoned photo from both sides;
--      _mf_sweep_tombstones drops a tombstoned photo.
--   3. The case the collection exists for: two phones each photograph a
--      reading on the SAME moisture map. The newer copy of the map wins whole,
--      and both phones' photos still survive.
--   4. A photo's `read` (with `filled`) and `ok` (with `fixed`) are never
--      undone by a newer copy saved before they landed; a newer copy's own
--      read or check stands. (The twin of merge.js; meterphotos.test.mjs.)
--   5. Crew logins can call _mf_sweep_tombstones (checked in section 1): the
--      phones' check for this migration (apps/field/js/meterui.js
--      checkMeterServer) depends on it.
--   6. Through push_project as a crew login: a stale push from another
--      device keeps both phones' photos and the reader's number, and a late
--      check from the first phone lands on the newer stored copy. Rolled back.
--   7. A photo deleted (or retaken) while the reader's number in its cell was
--      unchecked takes the number out of a newer copy of the map that still
--      has it; a checked number, or one either phone typed, stays.
--      (The twin of merge.js; meterphotos.test.mjs.)
--   8. The migration raised app_settings min_field_build to 211 or more.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the lists, volatility, owner, grants
do $$
declare
  f text;
  k text;
  problems text[] := '{}';
begin
  foreach f in array array['public.merge_project_blobs(jsonb, jsonb)', 'public._mf_sweep_tombstones(jsonb)'] loop
    foreach k in array array['equipmentScans', 'meterPhotos'] loop
      if position('''' || k || '''' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
        problems := problems || format('%s does not list %s', f, k);
      end if;
    end loop;
    if (select provolatile from pg_proc where oid = f::regprocedure) <> 'i' then
      problems := problems || format('%s is no longer IMMUTABLE', f);
    end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = f::regprocedure) <> 'postgres' then
      problems := problems || format('%s is not owned by postgres', f);
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.merge_project_blobs(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.merge_project_blobs(jsonb, jsonb)', 'EXECUTE') then
    problems := problems || 'merge_project_blobs is callable by a client role'::text;
  end if;
  if not has_function_privilege('authenticated', 'public._mf_sweep_tombstones(jsonb)', 'EXECUTE') then
    problems := problems || 'crew logins can no longer call _mf_sweep_tombstones (the phones'' meter photo check needs it)'::text;
  end if;
  if coalesce((select case when jsonb_typeof(value) = 'number' then (value)::text::numeric end
                 from public.app_settings where key = 'min_field_build'), 0) < 211 then
    problems := problems || 'min_field_build is below 211: phones before v211 can still drop meter photos'::text;
  end if;
  if array_length(problems, 1) > 0 then
    raise exception 'meter photos merge: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2. union, newer-wins on a clash, an empty newer side, tombstones
do $$
declare m jsonb;
begin
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z", "meterPhotos": [{"id": "mp1", "loc": 0, "read": null}, {"id": "mp2", "loc": 1}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z", "meterPhotos": [{"id": "mp1", "loc": 0, "read": {"value": "17.4"}}, {"id": "mp3", "loc": 2}]}');
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(m -> 'meterPhotos') e) is distinct from array['mp1', 'mp2', 'mp3'] then
    raise exception 'merge_project_blobs did not union meterPhotos: %', m -> 'meterPhotos';
  end if;
  if (select e #>> '{read,value}' from jsonb_array_elements(m -> 'meterPhotos') e where e ->> 'id' = 'mp1') is distinct from '17.4' then
    raise exception 'the newer copy of mp1 did not win';
  end if;
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z", "meterPhotos": [{"id": "mp1", "loc": 0}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z", "customer": "newer"}');
  if jsonb_array_length(m -> 'meterPhotos') is distinct from 1 then
    raise exception 'an older phone''s meter photos were lost to a newer copy without any: %', m;
  end if;
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z", "meterPhotos": [{"id": "mp1"}, {"id": "mp2"}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z", "meterPhotos": [{"id": "mp3"}], "deletedIds": {"mp2": "2026-10-09T18:30:00.000Z"}}');
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(m -> 'meterPhotos') e) is distinct from array['mp1', 'mp3'] then
    raise exception 'a tombstoned meter photo came back through the merge: %', m -> 'meterPhotos';
  end if;
  m := public._mf_sweep_tombstones(
    '{"meterPhotos": [{"id": "mp1"}, {"id": "mp2"}], "deletedIds": {"mp2": "2026-10-09T18:30:00.000Z"}}');
  if jsonb_array_length(m -> 'meterPhotos') is distinct from 1 or m -> 'meterPhotos' -> 0 ->> 'id' is distinct from 'mp1' then
    raise exception '_mf_sweep_tombstones kept a tombstoned meter photo: %', m -> 'meterPhotos';
  end if;
end
$$;

-- 3. two phones, one moisture map: the map merges whole, the photos union
do $$
declare m jsonb;
begin
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z",
      "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["17.4", ""]}]}],
      "meterPhotos": [{"id": "mpA", "mapId": "map-1", "rowKey": "r1", "loc": 0}]}',
    '{"updatedAt": "2026-10-09T18:05:00.000Z",
      "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["", "12"]}]}],
      "meterPhotos": [{"id": "mpB", "mapId": "map-1", "rowKey": "r1", "loc": 1}]}');
  if m #>> '{moistureMaps,0,readings,0,values,1}' is distinct from '12' then
    raise exception 'the newer copy of the map did not win whole: %', m -> 'moistureMaps';
  end if;
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(m -> 'meterPhotos') e) is distinct from array['mpA', 'mpB'] then
    raise exception 'a phone''s meter photo was lost with the older copy of its map: %', m -> 'meterPhotos';
  end if;
end
$$;

-- 4. a photo's read and check are never undone by a newer copy
do $$
declare m jsonb; e jsonb;
begin
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z", "meterPhotos": [
      {"id": "mp1", "loc": 0, "read": {"value": "17.4"}, "filled": "17.4", "ok": ""},
      {"id": "mp2", "loc": 1, "read": {"value": "22"}, "filled": "22", "ok": "2026-10-09T18:10:00.000Z", "fixed": "21"},
      {"id": "mp3", "loc": 2, "read": {"value": "5"}, "filled": ""},
      {"id": "mp5", "loc": 4, "read": {"value": "9"}, "filled": "9", "ok": "2026-10-09T18:20:00.000Z", "fixed": "1"}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z", "meterPhotos": [
      {"id": "mp1", "loc": 0, "read": null, "filled": "", "ok": ""},
      {"id": "mp2", "loc": 1, "read": {"value": "22"}, "filled": "22"},
      {"id": "mp3", "loc": 2, "read": {"value": "6"}, "filled": ""},
      {"id": "mp4", "loc": 3, "read": null},
      {"id": "mp5", "loc": 4, "read": {"value": "9"}, "filled": "9", "ok": "2026-10-09T18:30:00.000Z", "fixed": "2"}]}');
  if (select array_agg(x ->> 'id' order by x ->> 'id') from jsonb_array_elements(m -> 'meterPhotos') x) is distinct from array['mp1', 'mp2', 'mp3', 'mp4', 'mp5'] then
    raise exception 'meter photos lost in the read rule: %', m -> 'meterPhotos';
  end if;
  select x into e from jsonb_array_elements(m -> 'meterPhotos') x where x ->> 'id' = 'mp1';
  if e #>> '{read,value}' is distinct from '17.4' or e ->> 'filled' is distinct from '17.4' then
    raise exception 'a newer copy without the read undid it: %', e;
  end if;
  select x into e from jsonb_array_elements(m -> 'meterPhotos') x where x ->> 'id' = 'mp2';
  if e ->> 'ok' is distinct from '2026-10-09T18:10:00.000Z' or e ->> 'fixed' is distinct from '21' then
    raise exception 'a newer copy without the check undid it: %', e;
  end if;
  select x into e from jsonb_array_elements(m -> 'meterPhotos') x where x ->> 'id' = 'mp3';
  if e #>> '{read,value}' is distinct from '6' then
    raise exception 'the newer copy''s own read was replaced: %', e;
  end if;
  select x into e from jsonb_array_elements(m -> 'meterPhotos') x where x ->> 'id' = 'mp4';
  if e is distinct from '{"id": "mp4", "loc": 3, "read": null}'::jsonb then
    raise exception 'a photo only the newer copy has was changed: %', e;
  end if;
  select x into e from jsonb_array_elements(m -> 'meterPhotos') x where x ->> 'id' = 'mp5';
  if e ->> 'ok' is distinct from '2026-10-09T18:30:00.000Z' or e ->> 'fixed' is distinct from '2' then
    raise exception 'the newer copy''s own check was replaced: %', e;
  end if;
  -- the newer copy has no meter photos at all, or a tombstone: nothing comes back
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z", "meterPhotos": [{"id": "mp1", "read": {"value": "17.4"}}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z", "meterPhotos": [{"id": "mp1", "read": null}], "deletedIds": {"mp1": "2026-10-09T18:30:00.000Z"}}');
  if jsonb_array_length(m -> 'meterPhotos') is distinct from 0 then
    raise exception 'a tombstoned meter photo came back with its read: %', m -> 'meterPhotos';
  end if;
end
$$;

-- 7. a deleted photo's unchecked number goes with it, whichever copy is newer
do $$
declare
  m jsonb;
  a jsonb := '{"updatedAt": "2026-10-09T18:00:00.000Z",
    "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["", "12"]}]}],
    "meterPhotos": [], "deletedIds": {"mp1": "2026-10-09T17:59:00.000Z"}}';
  b jsonb := '{"updatedAt": "2026-10-09T19:00:00.000Z",
    "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["17.40", "14"]}]}],
    "meterPhotos": [{"id": "mp1", "mapId": "map-1", "rowKey": "r1", "date": "2026-10-09", "loc": 0, "read": {"value": "17.4"}, "filled": "17,4", "ok": ""}]}';
begin
  -- phone A deleted the photo (and its prefill); phone B's copy is newer
  m := public.merge_project_blobs(a, b);
  if m #> '{moistureMaps,0,readings,0,values}' is distinct from '["", "14"]'::jsonb then
    raise exception 'a deleted photo''s unchecked number came back with a newer map: %', m -> 'moistureMaps';
  end if;
  if jsonb_array_length(m -> 'meterPhotos') is distinct from 0 then
    raise exception 'the deleted meter photo came back: %', m -> 'meterPhotos';
  end if;
  -- argument order does not matter
  if public.merge_project_blobs(b, a) is distinct from m then
    raise exception 'the merge depends on argument order: %', public.merge_project_blobs(b, a);
  end if;
  -- phone A typed its own number after the delete: that number stands
  m := public.merge_project_blobs(jsonb_set(a, '{moistureMaps,0,readings,0,values,0}', '"18"'), b);
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '18' then
    raise exception 'the deleting phone''s typed number was lost: %', m -> 'moistureMaps';
  end if;
  -- the number was checked on phone B: it stays
  m := public.merge_project_blobs(a, jsonb_set(b, '{meterPhotos,0,ok}', '"2026-10-09T18:30:00.000Z"'));
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '17.40' then
    raise exception 'a checked number was taken out with its photo: %', m -> 'moistureMaps';
  end if;
  -- phone B typed a different number there: not the photo's, so it stays
  m := public.merge_project_blobs(a, jsonb_set(b, '{moistureMaps,0,readings,0,values,0}', '"16"'));
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '16' then
    raise exception 'a typed number was taken out with a photo: %', m -> 'moistureMaps';
  end if;
  -- the deleting copy is the newer one: its empty cell already wins
  m := public.merge_project_blobs(jsonb_set(a, '{updatedAt}', '"2026-10-09T20:00:00.000Z"'), b);
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '' then
    raise exception 'the newer deleting copy lost its empty cell: %', m -> 'moistureMaps';
  end if;
  -- the NEWER copy deleted the photo and has a number there again (typed, or a
  -- retake checked): it stands, though the older copy still has the photo
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-09T18:00:00.000Z",
      "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["", "12"]}]}],
      "meterPhotos": [{"id": "mp1", "mapId": "map-1", "rowKey": "r1", "date": "2026-10-09", "loc": 0, "read": {"value": "17.4"}, "filled": "17.4", "ok": ""}]}',
    '{"updatedAt": "2026-10-09T19:00:00.000Z",
      "moistureMaps": [{"id": "map-1", "readings": [{"rk": "r1", "date": "2026-10-09", "values": ["17.4", "12"]}]}],
      "meterPhotos": [{"id": "mp2", "mapId": "map-1", "rowKey": "r1", "date": "2026-10-09", "loc": 0, "read": {"value": "17.4"}, "filled": "17.4", "ok": "2026-10-09T18:50:00.000Z"}],
      "deletedIds": {"mp1": "2026-10-09T18:40:00.000Z"}}');
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '17.4' then
    raise exception 'a number put back after the newer copy''s own delete was taken out: %', m -> 'moistureMaps';
  end if;
  -- a row found by date when the newer copy's row has no rk
  m := public.merge_project_blobs(a, jsonb_set(b, '{moistureMaps,0,readings,0}', '{"date": "2026-10-09", "values": ["17.4", "14"]}'));
  if m #>> '{moistureMaps,0,readings,0,values,0}' is distinct from '' then
    raise exception 'the rule missed a row found by date: %', m -> 'moistureMaps';
  end if;
end
$$;

-- 6. two devices through push_project, as a crew login. Rolled back.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d0224', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-crew@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;
insert into public.profiles (id, full_name, role) values ('00000000-0000-0000-0000-0000000d0224', 'mp test crew', 'crew')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000d0224", "role": "authenticated", "aud": "authenticated"}';
do $$
declare res jsonb; d jsonb; e jsonb;
begin
  -- phone A takes a meter photo, then its read lands
  res := public.push_project('00000000-0000-0000-0000-0000000d0024', 0,
    '{"id": "00000000-0000-0000-0000-0000000d0024", "customer": "Push test", "updatedAt": "2026-10-09T18:00:00.000Z",
      "meterPhotos": [{"id": "mpA", "dev": "phone-a", "mapId": "map-1", "rowKey": "r1", "loc": 0, "read": null, "filled": "", "ok": ""}]}', null);
  if res ->> 'status' is distinct from 'insert' then raise exception 'phone A''s first push: %', res; end if;
  res := public.push_project('00000000-0000-0000-0000-0000000d0024', 1,
    '{"id": "00000000-0000-0000-0000-0000000d0024", "customer": "Push test", "updatedAt": "2026-10-09T18:01:00.000Z",
      "meterPhotos": [{"id": "mpA", "dev": "phone-a", "mapId": "map-1", "rowKey": "r1", "loc": 0, "read": {"value": "17.4"}, "filled": "17.4", "ok": ""}]}', null);
  if res ->> 'status' is distinct from 'applied' then raise exception 'phone A''s read push: %', res; end if;
  -- phone B pulled before the read, adds its own photo, and its copy is the newer one
  res := public.push_project('00000000-0000-0000-0000-0000000d0024', 1,
    '{"id": "00000000-0000-0000-0000-0000000d0024", "customer": "Push test", "updatedAt": "2030-01-01T00:00:00.000Z",
      "meterPhotos": [{"id": "mpA", "dev": "phone-a", "mapId": "map-1", "rowKey": "r1", "loc": 0, "read": null, "filled": "", "ok": ""},
                      {"id": "mpB", "dev": "phone-b", "mapId": "map-1", "rowKey": "r1", "loc": 1, "read": null, "filled": "", "ok": ""}]}', null);
  if res ->> 'status' is distinct from 'merged' then raise exception 'phone B''s stale push was not merged: %', res; end if;
  -- phone A's check lands from its own older copy
  res := public.push_project('00000000-0000-0000-0000-0000000d0024', 2,
    '{"id": "00000000-0000-0000-0000-0000000d0024", "customer": "Push test", "updatedAt": "2026-10-09T18:02:00.000Z",
      "meterPhotos": [{"id": "mpA", "dev": "phone-a", "mapId": "map-1", "rowKey": "r1", "loc": 0, "read": {"value": "17.4"}, "filled": "17.4", "ok": "2026-10-09T18:02:00.000Z"}]}', null);
  if res ->> 'status' is distinct from 'merged' then raise exception 'phone A''s late check was not merged: %', res; end if;
  select data into d from public.field_projects where id = '00000000-0000-0000-0000-0000000d0024';
  if (select array_agg(x ->> 'id' order by x ->> 'id') from jsonb_array_elements(d -> 'meterPhotos') x) is distinct from array['mpA', 'mpB'] then
    raise exception 'push_project lost a phone''s meter photo: %', d -> 'meterPhotos';
  end if;
  select x into e from jsonb_array_elements(d -> 'meterPhotos') x where x ->> 'id' = 'mpA';
  if e #>> '{read,value}' is distinct from '17.4' or e ->> 'filled' is distinct from '17.4' then
    raise exception 'a stale push undid the reader''s number: %', e;
  end if;
  if e ->> 'ok' is distinct from '2026-10-09T18:02:00.000Z' then
    raise exception 'the tech''s check did not land on the newer stored copy: %', e;
  end if;
end
$$;

rollback;
