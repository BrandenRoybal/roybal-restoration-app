-- ============================================================================
-- Assertions for 0022_equipment_scan.sql (the fleet list, the server copy of
-- every equipment scan, and the scan log joining the server merge).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/equipment_scan.test.sql <staging url>
-- Everything it inserts is rolled back.
--
-- The rules it holds the tables to:
--   1. RLS is on; anon holds nothing; authenticated holds SELECT and nothing
--      else (no TRUNCATE, which would bypass RLS); one read policy per table;
--      the service role only reads equipment_scans. The two doors are
--      SECURITY DEFINER, owned by postgres, executable by authenticated and
--      never by anon; the key helper, the projection helper and the trigger
--      function by nobody. The trigger is on field_projects.
--   2. equipment_tag_key is the field app's tagKey(): the cases in section 2
--      are also run through scans.js by apps/field/test/merge-sql-parity.test.mjs.
--   3. The owner, the office and a crew lead add and change units through
--      equipment_unit_save and equipment_units_add_range: the tag is
--      normalised, the type defaults from the prefix, a key already listed
--      is refused (23505) by one door and skipped by the other, numbers are
--      padded and never cut, a change keeps what it leaves out, and every
--      write is stamped with the caller. Even the owner cannot write the
--      table directly.
--   4. anon, a viewer, a crew member and the agent login are refused by both
--      doors (42501); a crew member reads the fleet list and no scans; a
--      viewer and the agent read neither.
--   5. The trigger copies each scan event once, stamped received_at by the
--      server: an edited copy of the same id keeps its first row, a dropped
--      event keeps its row, what isn't an event is passed over, a phone time
--      the calendar doesn't have is kept as null, and the job write never
--      fails. Nobody writes the copy: not the owner, not the service role.
--   6. merge_project_blobs unions equipmentScans from both sides and honours
--      a tombstone; _mf_sweep_tombstones drops a tombstoned scan; two phones
--      pushing one job through push_project keep both phones' scans.
-- Counts are of this file's own rows (tags ZQ-*, AM-98765 and the like, jobs
-- …0e0022/…0e0023), so it passes on a database that already holds a real
-- fleet and real scans (staging).
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. grants, RLS, policies, definer
do $$
declare
  t text;
  p text;
  problems text[] := '{}';
begin
  foreach t in array array['public.equipment_units', 'public.equipment_scans'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = t::regclass) then
      problems := problems || format('RLS is not enabled on %s', t);
    end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', t, p) then
        problems := problems || format('anon has %s on %s', p, t);
      end if;
      if p <> 'SELECT' and has_table_privilege('authenticated', t, p) then
        problems := problems || format('authenticated has %s on %s', p, t);
      end if;
    end loop;
    if not has_table_privilege('authenticated', t, 'SELECT') then
      problems := problems || format('authenticated cannot SELECT %s', t);
    end if;
    if (select count(*) from pg_policy where polrelid = t::regclass) <> 1 then
      problems := problems || format('%s should carry exactly one policy', t);
    end if;
  end loop;
  -- the audit copy: the service role reads it and writes nothing
  foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('service_role', 'public.equipment_scans', p) then
      problems := problems || format('service_role has %s on equipment_scans', p);
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.equipment_scans', 'SELECT') then
    problems := problems || 'service_role cannot SELECT equipment_scans'::text;
  end if;
  foreach p in array array['public.equipment_unit_save(jsonb)',
                           'public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text)'] loop
    if has_function_privilege('anon', p, 'EXECUTE') then
      problems := problems || format('anon can execute %s', p);
    end if;
    if not has_function_privilege('authenticated', p, 'EXECUTE') then
      problems := problems || format('authenticated cannot execute %s', p);
    end if;
  end loop;
  foreach p in array array['public.equipment_tag_key(text)', 'public.record_equipment_scans(uuid, jsonb)',
                           'public.project_equipment_scans()'] loop
    foreach t in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(t, p, 'EXECUTE') then
        problems := problems || format('%s can execute %s', t, p);
      end if;
    end loop;
  end loop;
  foreach p in array array['public.equipment_unit_save(jsonb)',
                           'public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text)',
                           'public.record_equipment_scans(uuid, jsonb)', 'public.project_equipment_scans()'] loop
    if not (select prosecdef from pg_proc where oid = p::regprocedure) then
      problems := problems || format('%s is not SECURITY DEFINER', p);
    end if;
    if not exists (select 1 from pg_proc where oid = p::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
      problems := problems || format('%s does not pin search_path to public, pg_temp', p);
    end if;
  end loop;
  foreach p in array array['public.equipment_unit_save(jsonb)',
                           'public.equipment_units_add_range(text, integer, integer, integer, text, text, text, text, text)',
                           'public.equipment_tag_key(text)', 'public.record_equipment_scans(uuid, jsonb)',
                           'public.project_equipment_scans()', 'public.merge_project_blobs(jsonb, jsonb)',
                           'public._mf_sweep_tombstones(jsonb)'] loop
    if (select pg_get_userbyid(proowner) from pg_proc where oid = p::regprocedure) <> 'postgres' then
      problems := problems || format('%s is not owned by postgres', p);
    end if;
  end loop;
  if (select provolatile from pg_proc where oid = 'public.equipment_tag_key(text)'::regprocedure) <> 'i' then
    problems := problems || 'equipment_tag_key is not IMMUTABLE'::text;
  end if;
  if (select provolatile from pg_proc where oid = 'public.merge_project_blobs(jsonb, jsonb)'::regprocedure) <> 'i'
     or (select provolatile from pg_proc where oid = 'public._mf_sweep_tombstones(jsonb)'::regprocedure) <> 'i' then
    problems := problems || 'the merge functions are no longer IMMUTABLE'::text;
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'project_equipment_scans' and tgrelid = 'public.field_projects'::regclass and tgenabled <> 'D') then
    problems := problems || 'the project_equipment_scans trigger is missing from field_projects'::text;
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'equipment scan grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2. the tag key. merge-sql-parity.test.mjs reads the cases between the two
--    marker lines and runs each input through scans.js tagKey(): keep one
--    (input, key) pair per line, as SQL literals.
do $$
declare c record; got text; bad text[] := '{}';
begin
  for c in select * from (values
    -- tag-key cases: begin
    ('AM-014', 'AM-14'),
    ('AM-14', 'AM-14'),
    ('am 014', 'AM-14'),
    ('am  014', 'AM-14'),
    ('AM0014', 'AM-14'),
    ('am_14', 'AM-14'),
    ('am.014', 'AM-14'),
    ('AM--014', 'AM-14'),
    (E'AM−014', 'AM-14'),
    (E'AM– 014', 'AM-14'),
    (E'AM 014', 'AM-14'),
    (E'  dh\t 7 ', 'DH-7'),
    ('AM-000', 'AM-0'),
    ('007', '7'),
    ('101', '101'),
    ('000', '0'),
    (' d-1 ', 'D-1'),
    ('n/a', 'N/A'),
    ('AM-0-14', 'AM-0-14'),
    ('A-014', 'A-014'),
    ('AMX-014', 'AMX-014'),
    ('RC:AM-014', 'RC:AM-014'),
    ('1 2', '1 2'),
    ('x1', 'X1'),
    ('', ''),
    ('   ', ''),
    (null, '')
    -- tag-key cases: end
  ) as v(input, want) loop
    got := public.equipment_tag_key(c.input);
    if got is distinct from c.want then
      bad := bad || format('%s → %s (want %s)', coalesce(quote_literal(c.input), 'null'), quote_literal(got), quote_literal(c.want));
    end if;
  end loop;
  if array_length(bad, 1) is not null then
    raise exception 'equipment_tag_key differs from tagKey(): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- 3–6. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000e220', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e221', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-lead@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e223', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e224', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-viewer@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e225', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-eq-agent@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000e220', 'eq test owner',     'owner'),
  ('00000000-0000-0000-0000-00000000e221', 'eq test office',    'office'),
  ('00000000-0000-0000-0000-00000000e222', 'eq test crew lead', 'crew_lead'),
  ('00000000-0000-0000-0000-00000000e223', 'eq test crew',      'crew'),
  ('00000000-0000-0000-0000-00000000e224', 'eq test viewer',    'viewer'),
  ('00000000-0000-0000-0000-00000000e225', 'eq test agent',     'agent')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 3a. the owner adds units one at a time and in ranges, stamped as the owner
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e220", "role": "authenticated", "aud": "authenticated"}';
do $$
declare u public.equipment_units; n int; bad text;
begin
  u := public.equipment_unit_save('{"tag": " am-98765 ", "make": " Acme ", "model": "X3", "rating": "1/3 hp", "serial": ""}');
  if u.tag is distinct from 'AM-98765' or u.tag_key is distinct from 'AM-98765' or u.type is distinct from 'air_mover' or u.owned is distinct from 'owned' or u.status is distinct from 'active'
     or u.make is distinct from 'Acme' or u.model is distinct from 'X3' or u.rating is distinct from '1/3 hp' or u.serial is not null
     or u.created_by is distinct from '00000000-0000-0000-0000-00000000e220' or u.updated_by is distinct from '00000000-0000-0000-0000-00000000e220'
     or u.org_id is distinct from 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb' then
    raise exception 'the owner''s unit landed wrong: %', row_to_json(u);
  end if;
  if not exists (select 1 from public.equipment_units where id = u.id and tag = 'AM-98765') then
    raise exception 'the returned unit is not the stored one';
  end if;

  -- AM-098765 is AM-98765 with a zero: the same machine
  begin
    perform public.equipment_unit_save('{"tag": "AM-098765"}');
    raise exception 'a second AM-98765 (as AM-098765) was accepted';
  exception when unique_violation then
    if sqlerrm not like '%AM-098765%AM-98765%' then raise exception 'the duplicate message does not name both tags: %', sqlerrm; end if;
  end;

  -- a plain number needs a type; with one it is fine
  begin
    perform public.equipment_unit_save('{"tag": "987654"}');
    raise exception 'a plain-number tag with no type was accepted';
  exception when check_violation then null;
  end;
  u := public.equipment_unit_save('{"tag": "987654", "type": "dehu_lgr", "owned": "Rented"}');
  if u.tag_key is distinct from '987654' or u.type is distinct from 'dehu_lgr' or u.owned is distinct from 'rented' then
    raise exception 'the plain-number unit landed wrong: %', row_to_json(u);
  end if;
  u := public.equipment_unit_save('{"tag": "ht-98765"}');
  if u.type is distinct from 'heater' then raise exception 'HT did not default to heater: %', u.type; end if;

  -- what the checks refuse
  foreach bad in array array['{"tag": "AM 014"}', '{"tag": ""}', '{"make": "no tag"}', '{"tag": "ÀM-1"}',
                             '{"tag": "-AM-1"}', '{"tag": "AM-12345678901234"}',
                             '{"tag": "ZQ-98765", "type": "fan"}', '{"tag": "ZQ-98765", "type": "air_mover", "owned": "borrowed"}',
                             '{"tag": "ZQ-98765", "type": "air_mover", "status": "lost"}'] loop
    begin
      perform public.equipment_unit_save(bad::jsonb);
      raise exception 'equipment_unit_save accepted %', bad;
    exception when check_violation then null;
    end;
  end loop;
  begin
    perform public.equipment_unit_save('["not", "an", "object"]');
    raise exception 'equipment_unit_save accepted an array';
  exception when invalid_parameter_value then null;
  end;

  -- a range: padded to the digits asked for, never cut, rented, stamped
  n := public.equipment_units_add_range('zq', 1, 5, 3, 'air_mover', 'Acme', 'X3', '1/3 hp', 'rented');
  if n is distinct from 5 then raise exception 'add_range ZQ 1-5 added %, expected 5', n; end if;
  if (select array_agg(tag order by tag) from public.equipment_units where tag like 'ZQ-%')
     is distinct from array['ZQ-001', 'ZQ-002', 'ZQ-003', 'ZQ-004', 'ZQ-005'] then
    raise exception 'add_range wrote %', (select array_agg(tag order by tag) from public.equipment_units where tag like 'ZQ-%');
  end if;
  if exists (select 1 from public.equipment_units where tag like 'ZQ-%'
              and (owned is distinct from 'rented' or make is distinct from 'Acme' or rating is distinct from '1/3 hp' or type is distinct from 'air_mover'
                   or created_by is distinct from '00000000-0000-0000-0000-00000000e220'::uuid)) then
    raise exception 'add_range rows carry the wrong details';
  end if;
  -- ZQ-04 and ZQ-05 are ZQ-004 and ZQ-005: skipped, not doubled
  n := public.equipment_units_add_range('ZQ', 4, 8, 2, 'air_mover', null, null, null, 'owned');
  if n is distinct from 3 then raise exception 'add_range ZQ 4-8 added %, expected 3 (4 and 5 are listed)', n; end if;
  if (select count(*) from public.equipment_units where tag_key in ('ZQ-4', 'ZQ-5')) is distinct from 2
     or not exists (select 1 from public.equipment_units where tag = 'ZQ-06') then
    raise exception 'add_range doubled a listed tag or lost a new one';
  end if;
  n := public.equipment_units_add_range('ZQ', 1000, 1000, 3, 'air_mover', null, null, null, null);
  if n is distinct from 1 or not exists (select 1 from public.equipment_units where tag = 'ZQ-1000') then
    raise exception 'add_range cut 1000 to fit 3 digits';
  end if;
  -- the type from the prefix, and pad left out (3)
  n := public.equipment_units_add_range(p_prefix => 'AF', p_from => 99990, p_to => 99991);
  if n is distinct from 2 or (select count(*) from public.equipment_units where tag in ('AF-99990', 'AF-99991') and type = 'air_scrubber') is distinct from 2 then
    raise exception 'add_range AF did not default to air scrubbers';
  end if;
  -- plain numbers: a blank prefix, and a type is needed
  n := public.equipment_units_add_range('', 987650, 987652, 3, 'heater', null, null, null, null);
  if n is distinct from 3 or not exists (select 1 from public.equipment_units where tag = '987651' and tag_key = '987651') then
    raise exception 'add_range of plain numbers added % or wrote the wrong tags', n;
  end if;
  begin
    perform public.equipment_units_add_range('', 987660, 987661, 3, null, null, null, null, null);
    raise exception 'plain numbers with no type were accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.equipment_units_add_range('ZQ', 1, 2, 3, 'air_mover', null, null, null, 'borrowed');
    raise exception 'add_range accepted owned "borrowed"';
  exception when check_violation then null;
  end;
  begin
    perform public.equipment_units_add_range('ZQ', 1, 201, 3, 'air_mover', null, null, null, null);
    raise exception '201 units in one call were accepted';
  exception when invalid_parameter_value then null;
  end;
  foreach bad in array array['ZQX', 'Z', 'Z1', 'Z-'] loop
    begin
      perform public.equipment_units_add_range(bad, 1, 2, 3, 'air_mover', null, null, null, null);
      raise exception 'prefix % was accepted', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.equipment_units_add_range('ZQ', 9, 2, 3, 'air_mover', null, null, null, null);
    raise exception 'a backwards range was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.equipment_units_add_range('ZQ', 1, 2, 7, 'air_mover', null, null, null, null);
    raise exception 'seven digits were accepted';
  exception when invalid_parameter_value then null;
  end;

  -- even the owner cannot write the table directly: the doors are the only way in
  begin
    insert into public.equipment_units (tag, tag_key, type) values ('ZQ-777', 'ZQ-777', 'other');
    raise exception 'the owner inserted into equipment_units directly';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.equipment_units set status = 'retired' where tag = 'AM-98765';
    raise exception 'the owner updated equipment_units directly';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;

-- 3b. a crew lead changes a unit: what the JSON leaves out stays, stamped as the lead
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e222", "role": "authenticated", "aud": "authenticated"}';
do $$
declare u public.equipment_units; id0 uuid;
begin
  select id into id0 from public.equipment_units where tag = 'AM-98765';
  u := public.equipment_unit_save(jsonb_build_object('id', id0, 'status', 'Repair'));
  if u.id is distinct from id0 or u.status is distinct from 'repair' or u.make is distinct from 'Acme' or u.model is distinct from 'X3' or u.rating is distinct from '1/3 hp' or u.type is distinct from 'air_mover'
     or u.updated_by is distinct from '00000000-0000-0000-0000-00000000e222' or u.created_by is distinct from '00000000-0000-0000-0000-00000000e220' then
    raise exception 'the crew lead''s status change landed wrong: %', row_to_json(u);
  end if;
  u := public.equipment_unit_save(jsonb_build_object('id', id0, 'make', '', 'notes', 'cord frayed'));
  if u.make is not null or u.model is distinct from 'X3' or u.notes is distinct from 'cord frayed' or u.status is distinct from 'repair' then
    raise exception 'clearing make changed more than make: %', row_to_json(u);
  end if;
  -- renumbering onto a listed key is refused, and the message names the holder
  begin
    perform public.equipment_unit_save(jsonb_build_object('id', id0, 'tag', 'ZQ-1'));
    raise exception 'AM-98765 was renumbered onto ZQ-001';
  exception when unique_violation then
    if sqlerrm not like '%ZQ-001%' then raise exception 'the duplicate message does not name ZQ-001: %', sqlerrm; end if;
  end;
  -- renumbering onto a free tag moves the key with it
  u := public.equipment_unit_save(jsonb_build_object('id', id0, 'tag', 'AM-098766'));
  if u.tag is distinct from 'AM-098766' or u.tag_key is distinct from 'AM-98766' or u.type is distinct from 'air_mover' then
    raise exception 'the renumber landed wrong: %', row_to_json(u);
  end if;
  if (select count(*) from public.equipment_units where tag like 'ZQ-%') is distinct from 9 then
    raise exception 'the crew lead reads % ZQ units, expected 9', (select count(*) from public.equipment_units where tag like 'ZQ-%');
  end if;
  if public.equipment_units_add_range('ZQ', 9, 9, 3, 'air_mover', null, null, null, null) is distinct from 1 then
    raise exception 'a crew lead could not add a range';
  end if;
end
$$;
release savepoint s;

-- 3c. the office adds a unit under an id the office app chose
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare u public.equipment_units;
begin
  u := public.equipment_unit_save('{"id": "00000000-0000-0000-0000-0000000ee022", "tag": "DH-98765", "model": "LGR 2800"}');
  if u.id is distinct from '00000000-0000-0000-0000-0000000ee022' or u.type is distinct from 'dehumidifier' or u.created_by is distinct from '00000000-0000-0000-0000-00000000e221' then
    raise exception 'the office''s unit landed wrong: %', row_to_json(u);
  end if;
  begin
    perform public.equipment_unit_save('{"id": "not-a-uuid", "tag": "DH-98766"}');
    raise exception 'a malformed id was accepted';
  exception when invalid_text_representation then null;
  end;
end
$$;
release savepoint s;

-- 4. anon, a viewer, a crew member and the agent login: both doors refuse;
--    only the crew member reads the fleet list
do $$
declare
  uid text;
  n int;
begin
  foreach uid in array array['00000000-0000-0000-0000-00000000e223', '00000000-0000-0000-0000-00000000e224', '00000000-0000-0000-0000-00000000e225'] loop
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated", "aud": "authenticated"}', uid), true);
    select count(*) into n from public.equipment_units where tag like 'ZQ-%' or tag_key in ('AM-98766', 'DH-98765', '987654');
    if uid = '00000000-0000-0000-0000-00000000e223' and n is distinct from 13 then
      raise exception 'the crew member reads % of 13 test units (the scanner needs the fleet list)', n;
    elsif uid is distinct from '00000000-0000-0000-0000-00000000e223' and n is distinct from 0 then
      raise exception '% reads % equipment_units rows', uid, n;
    end if;
    select count(*) into n from public.equipment_scans;
    if n is distinct from 0 then raise exception '% reads % equipment_scans rows', uid, n; end if;
    begin
      perform public.equipment_unit_save('{"tag": "ZQ-555", "type": "other"}');
      raise exception '% saved a unit', uid;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.equipment_units_add_range('ZQ', 500, 501, 3, 'other', null, null, null, null);
      raise exception '% added a range', uid;
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.equipment_units (tag, tag_key, type) values ('ZQ-556', 'ZQ-556', 'other');
      raise exception '% inserted into equipment_units', uid;
    exception when insufficient_privilege then null;
    end;
    perform set_config('role', 'postgres', true);
  end loop;
  reset role;
  if exists (select 1 from public.equipment_units where tag in ('ZQ-555', 'ZQ-500', 'ZQ-556')) then
    raise exception 'a refused caller added a unit';
  end if;
end
$$;

savepoint s;
set local role anon;
do $$
begin
  begin
    perform 1 from public.equipment_units;
    raise exception 'anon can read equipment_units';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.equipment_scans;
    raise exception 'anon can read equipment_scans';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.equipment_unit_save('{"tag": "ZQ-555", "type": "other"}');
    raise exception 'anon can call equipment_unit_save';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.equipment_units_add_range('ZQ', 500, 501, 3, 'other', null, null, null, null);
    raise exception 'anon can call equipment_units_add_range';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 5a. a job's scan events become rows, once, stamped by the server's clock
set local role service_role;
insert into public.field_projects (id, data) values
  ('00000000-0000-0000-0000-0000000e0022',
   '{"customer": "Scan test", "equipmentScans": [
      {"id": "sc-1", "tag": "AM-098766", "act": "place", "at": "2026-10-08T18:00:00.000Z", "room": "Kitchen",
       "type": "Air mover", "model": "Acme X3 · 1/3 hp", "logId": "log-1", "how": "camera",
       "by": "test-eq-crew@example.invalid", "tech": "Test Tech", "build": "v208",
       "elsewhere": {"jobId": "00000000-0000-0000-0000-0000000e0099", "label": "Other test job", "since": "2026-10-07T17:00"}},
      {"id": "sc-2", "tag": "AM-098766", "act": "remove", "at": "2026-10-09T18:30:00.000Z", "room": "Kitchen",
       "how": "typed", "by": "test-eq-crew@example.invalid", "tech": "Test Tech", "build": "v208"},
      {"id": "sc-3", "tag": "am 98766", "act": "move", "at": "2026-02-30T10:00:00.000Z", "room": "Hall", "how": "photo"},
      {"id": "sc-4", "tag": "AM-098766", "act": "void", "at": "now", "voids": "sc-2", "room": ""},
      {"tag": "AM-098766", "act": "place", "room": "no id"},
      {"id": 5, "tag": "AM-098766", "act": "place"},
      {"id": "", "tag": "AM-098766", "act": "place"},
      {"id": "sc-bad-act", "tag": "AM-098766", "act": "edit"},
      "not an object"
    ]}'::jsonb);
reset role;
do $$
declare r public.equipment_scans;
begin
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 4 then
    raise exception 'expected 4 scan rows, got %', (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022');
  end if;
  if exists (select 1 from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022'
              and (received_at is distinct from now() or tag_key is distinct from 'AM-98766')) then
    raise exception 'a scan row is not stamped with the server''s time or carries the wrong key';
  end if;
  select * into r from public.equipment_scans where id = 'sc-1';
  if r.act is distinct from 'place' or r.tag is distinct from 'AM-098766' or r.room is distinct from 'Kitchen' or r.type is distinct from 'Air mover' or r.model is distinct from 'Acme X3 · 1/3 hp'
     or r.how is distinct from 'camera' or r.by_email is distinct from 'test-eq-crew@example.invalid' or r.tech is distinct from 'Test Tech' or r.build is distinct from 'v208'
     or r.scanned_at is distinct from '2026-10-08T18:00:00Z'::timestamptz or r.voids is not null
     or r.elsewhere ->> 'label' is distinct from 'Other test job' or r.raw ->> 'logId' is distinct from 'log-1' then
    raise exception 'the place event landed wrong: %', row_to_json(r);
  end if;
  if (select scanned_at from public.equipment_scans where id = 'sc-2') is distinct from '2026-10-09T18:30:00Z'::timestamptz then
    raise exception 'the remove event''s phone time was lost';
  end if;
  if (select scanned_at from public.equipment_scans where id = 'sc-3') is not null
     or (select scanned_at from public.equipment_scans where id = 'sc-4') is not null then
    raise exception 'a phone time that is not a real ISO time was read as one';
  end if;
  if (select voids from public.equipment_scans where id = 'sc-4') is distinct from 'sc-2' then
    raise exception 'the void event lost the id it cancels';
  end if;
end
$$;

-- 5b. an edited copy of sc-1 keeps sc-1's first row; a new event is added
set local role service_role;
update public.field_projects
   set data = jsonb_set(data, '{equipmentScans}',
                (select jsonb_agg(case when e ->> 'id' = 'sc-1' then e || '{"room": "Bedroom", "at": "2026-10-01T00:00:00.000Z"}' else e end)
                   from jsonb_array_elements(data -> 'equipmentScans') e)
                || '[{"id": "sc-5", "tag": "DH-98765", "act": "place", "at": "2026-10-10T19:00:00.000Z", "room": "Basement"}]'::jsonb)
 where id = '00000000-0000-0000-0000-0000000e0022';
reset role;
do $$
begin
  if (select room from public.equipment_scans where id = 'sc-1') is distinct from 'Kitchen'
     or (select raw ->> 'room' from public.equipment_scans where id = 'sc-1') is distinct from 'Kitchen'
     or (select scanned_at from public.equipment_scans where id = 'sc-1') is distinct from '2026-10-08T18:00:00Z'::timestamptz then
    raise exception 'an edited copy of sc-1 changed its row';
  end if;
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 5
     or (select tag_key from public.equipment_scans where id = 'sc-5') is distinct from 'DH-98765' then
    raise exception 'the new event sc-5 was not recorded';
  end if;
end
$$;

-- 5c. the blob drops its events, then the key: every row stays
set local role service_role;
update public.field_projects set data = jsonb_set(data, '{equipmentScans}', '[]'::jsonb)
 where id = '00000000-0000-0000-0000-0000000e0022';
update public.field_projects set data = data - 'equipmentScans'
 where id = '00000000-0000-0000-0000-0000000e0022';
reset role;
do $$
begin
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 5 then
    raise exception 'dropping events from the blob removed rows: % left', (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022');
  end if;
end
$$;

-- 5d. a trashed job's new scans are still recorded, and an id nobody would
--     write (129 characters) is passed over without costing the rest
set local role service_role;
update public.field_projects
   set deleted = true,
       data = jsonb_set(data, '{equipmentScans}', jsonb_build_array(
                jsonb_build_object('id', repeat('x', 129), 'tag', 'AM-098766', 'act', 'place'),
                '{"id": "sc-6", "tag": "AM-098766", "act": "remove", "at": "2026-10-11T20:00:00.000+00:00"}'::jsonb))
 where id = '00000000-0000-0000-0000-0000000e0022';
reset role;
do $$
begin
  if (select scanned_at from public.equipment_scans where id = 'sc-6') is distinct from '2026-10-11T20:00:00Z'::timestamptz then
    raise exception 'a trashed job''s new scan was not recorded';
  end if;
  if exists (select 1 from public.equipment_scans where char_length(id) > 128) then
    raise exception 'a 129-character id became a row';
  end if;
  if not (select deleted from public.field_projects where id = '00000000-0000-0000-0000-0000000e0022') then
    raise exception 'the job write was blocked';
  end if;
end
$$;

-- 5e. owner and crew lead read the rows; nobody writes them
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e220", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 6 then
    raise exception 'the owner reads % of 6 scan rows', (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022');
  end if;
  begin
    insert into public.equipment_scans (id, job_id, tag, tag_key, act, raw)
    values ('forged', '00000000-0000-0000-0000-0000000e0022', 'AM-1', 'AM-1', 'place', '{}');
    raise exception 'the owner inserted a scan row';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.equipment_scans set room = 'forged' where id = 'sc-1';
    raise exception 'the owner edited a scan row';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e222", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 6 then
    raise exception 'the crew lead reads % of 6 scan rows', (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022');
  end if;
end
$$;
rollback to savepoint s;

-- a crew member, a viewer and the agent login read none of them
do $$
declare uid text; n int;
begin
  foreach uid in array array['00000000-0000-0000-0000-00000000e223', '00000000-0000-0000-0000-00000000e224', '00000000-0000-0000-0000-00000000e225'] loop
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated", "aud": "authenticated"}', uid), true);
    select count(*) into n from public.equipment_scans;
    if n is distinct from 0 then raise exception '% reads % equipment_scans rows', uid, n; end if;
    perform set_config('role', 'postgres', true);
  end loop;
  reset role;
end
$$;

savepoint s;
set local role service_role;
do $$
begin
  if (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022') is distinct from 6 then
    raise exception 'the service role reads % of 6 scan rows', (select count(*) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0022');
  end if;
  begin
    update public.equipment_scans set room = 'forged' where id = 'sc-1';
    raise exception 'the service role edited a scan row';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.equipment_scans where id = 'sc-1';
    raise exception 'the service role deleted a scan row';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 6a. the server merge: both sides' scans survive, the newer copy of a
--     shared event wins whole, and a tombstone outranks both
do $$
declare m jsonb;
begin
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-08T18:00:00.000Z", "equipmentScans": [{"id": "e1", "act": "place", "room": "Kitchen"}, {"id": "e2", "act": "place"}]}',
    '{"updatedAt": "2026-10-08T19:00:00.000Z", "equipmentScans": [{"id": "e1", "act": "place", "room": "Hall"}, {"id": "e3", "act": "remove"}]}');
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(m -> 'equipmentScans') e) is distinct from array['e1', 'e2', 'e3'] then
    raise exception 'merge_project_blobs did not union equipmentScans: %', m -> 'equipmentScans';
  end if;
  if (select e ->> 'room' from jsonb_array_elements(m -> 'equipmentScans') e where e ->> 'id' = 'e1') is distinct from 'Hall' then
    raise exception 'the newer copy of e1 did not win';
  end if;
  -- the newer side has no scan log at all: the older side's events are kept
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-08T18:00:00.000Z", "equipmentScans": [{"id": "e1", "act": "place"}]}',
    '{"updatedAt": "2026-10-08T19:00:00.000Z", "customer": "newer"}');
  if jsonb_array_length(m -> 'equipmentScans') is distinct from 1 then
    raise exception 'an older phone''s scans were lost to a newer copy without any: %', m;
  end if;
  m := public.merge_project_blobs(
    '{"updatedAt": "2026-10-08T18:00:00.000Z", "equipmentScans": [{"id": "e1", "act": "place"}, {"id": "e2", "act": "place"}]}',
    '{"updatedAt": "2026-10-08T19:00:00.000Z", "equipmentScans": [{"id": "e3", "act": "place"}], "deletedIds": {"e2": "2026-10-08T18:30:00.000Z"}}');
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(m -> 'equipmentScans') e) is distinct from array['e1', 'e3'] then
    raise exception 'a tombstoned scan came back through the merge: %', m -> 'equipmentScans';
  end if;
  m := public._mf_sweep_tombstones(
    '{"equipmentScans": [{"id": "e1"}, {"id": "e2"}], "deletedIds": {"e2": "2026-10-08T18:30:00.000Z"}}');
  if jsonb_array_length(m -> 'equipmentScans') is distinct from 1 or m -> 'equipmentScans' -> 0 ->> 'id' is distinct from 'e1' then
    raise exception '_mf_sweep_tombstones kept a tombstoned scan: %', m -> 'equipmentScans';
  end if;
end
$$;

-- 6b. two phones, one job, through push_project: phone A creates the job
--     with its scan, phone B pushes from rev 0 with its own; the job keeps
--     both, and so does the copy. Then A tombstones its scan: the blob loses
--     it, the copy keeps it.
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e223", "role": "authenticated", "aud": "authenticated"}';
do $$
declare res jsonb; d jsonb;
begin
  res := public.push_project('00000000-0000-0000-0000-0000000e0023', 0,
    '{"id": "00000000-0000-0000-0000-0000000e0023", "customer": "Push test", "updatedAt": "2026-10-08T18:00:00.000Z",
      "equipmentScans": [{"id": "pa-1", "tag": "ZQ-001", "act": "place", "at": "2026-10-08T18:00:00.000Z", "room": "Kitchen"}]}', null);
  if res ->> 'status' is distinct from 'insert' then raise exception 'phone A''s first push: %', res; end if;
  res := public.push_project('00000000-0000-0000-0000-0000000e0023', 0,
    '{"id": "00000000-0000-0000-0000-0000000e0023", "customer": "Push test", "updatedAt": "2026-10-08T18:05:00.000Z",
      "equipmentScans": [{"id": "pb-1", "tag": "ZQ-002", "act": "place", "at": "2026-10-08T18:05:00.000Z", "room": "Hall"}]}', null);
  if res ->> 'status' is distinct from 'merged' then raise exception 'phone B''s stale push was not merged: %', res; end if;
  select data into d from public.field_projects where id = '00000000-0000-0000-0000-0000000e0023';
  if (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(d -> 'equipmentScans') e) is distinct from array['pa-1', 'pb-1'] then
    raise exception 'push_project lost a phone''s scans: %', d -> 'equipmentScans';
  end if;
  res := public.push_project('00000000-0000-0000-0000-0000000e0023', (d ->> 'rev')::int,
    jsonb_set(d, '{deletedIds}', '{"pa-1": "2026-10-08T18:10:00.000Z"}'), null);
  if res ->> 'status' is distinct from 'applied' then raise exception 'phone A''s tombstone push: %', res; end if;
end
$$;
release savepoint s;
reset role;
-- read back as postgres: the crew member reads no scan rows
do $$
begin
  if exists (select 1 from public.field_projects p, jsonb_array_elements(p.data -> 'equipmentScans') e
              where p.id = '00000000-0000-0000-0000-0000000e0023' and e ->> 'id' = 'pa-1') then
    raise exception 'push_project kept the tombstoned scan pa-1 in the blob';
  end if;
  if (select array_agg(id order by id) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0023')
     is distinct from array['pa-1', 'pb-1'] then
    raise exception 'the copy of the pushed job holds %, expected pa-1 and pb-1',
      (select array_agg(id order by id) from public.equipment_scans where job_id = '00000000-0000-0000-0000-0000000e0023');
  end if;
end
$$;

rollback;
