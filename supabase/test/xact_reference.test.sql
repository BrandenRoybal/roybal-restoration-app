-- ============================================================================
-- Assertions for 0011_xact_reference.sql — the owner's past Xactimate
-- estimates, kept as a private pricing reference.
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/xact_reference.test.sql <staging url>
-- Everything it inserts is rolled back.
--
-- SYNTHETIC DATA ONLY. The repository is public: every code, description and
-- price below is invented (categories TST/ZZZ, codes TST1/ZZZ9).
--
-- The rules it holds the two tables to:
--   1. RLS is on, there are no policies, and anon and authenticated hold no
--      privilege at all on either table (the baseline's default privileges
--      would grant ALL otherwise).
--   2. The two functions are SECURITY DEFINER with search_path pinned, and
--      authenticated may execute them while anon and PUBLIC may not.
--   3. The owner — with a REAL user JWT's claims, role = "authenticated" —
--      can reload, and a reload replaces the tables whole.
--   4. Owner and office read rows through xact_ref_prices_for().
--   5. A crew member reads zero rows through it, without an error.
--   6. Office, crew and anon calling xact_ref_reload() get 42501.
--   7. Nobody signed in reads either table directly; nor does anon.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. grants, RLS, no policies, the key and the index
do $$
declare
  t text;
  p text;
  problems text[] := '{}';
begin
  foreach t in array array['xact_ref_prices', 'xact_ref_lines'] loop
    if not coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = t), false) then
      problems := problems || format('RLS is not enabled on %s', t);
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      problems := problems || format('%s has a policy; the functions are meant to be the only door', t);
    end if;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', t), p) then
        problems := problems || format('anon has %s on %s', p, t);
      end if;
      if has_table_privilege('authenticated', format('public.%I', t), p) then
        problems := problems || format('authenticated has %s on %s', p, t);
      end if;
    end loop;
  end loop;

  if (select array_agg(a.attname::text order by k.ord)
        from pg_constraint c
        cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'public.xact_ref_prices'::regclass and c.contype = 'p')
     is distinct from array['category', 'code', 'activity', 'unit'] then
    problems := problems || 'xact_ref_prices primary key is not (category, code, activity, unit)'::text;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'xact_ref_lines'
                    and indexdef ~ '\(category, code\)') then
    problems := problems || 'xact_ref_lines has no (category, code) index'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'xact reference tables are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2. the two doors: shape and who may execute them
do $$
declare
  f record;
  problems text[] := '{}';
begin
  for f in
    select p.oid, p.proname, p.provolatile, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('xact_ref_prices_for', 'xact_ref_reload')
  loop
    if not f.prosecdef then
      problems := problems || format('%s() is not SECURITY DEFINER', f.proname);
    end if;
    if f.proconfig is null or not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%') then
      problems := problems || format('%s() does not pin search_path', f.proname);
    end if;
    if not has_function_privilege('authenticated', f.oid, 'execute') then
      problems := problems || format('authenticated cannot execute %s()', f.proname);
    end if;
    if has_function_privilege('anon', f.oid, 'execute') then
      problems := problems || format('anon can execute %s() — the default-privilege grant was not revoked', f.proname);
    end if;
    if has_function_privilege('public', f.oid, 'execute') then
      problems := problems || format('PUBLIC can execute %s()', f.proname);
    end if;
  end loop;

  if to_regprocedure('public.xact_ref_prices_for(text[])') is null then
    problems := problems || 'public.xact_ref_prices_for(text[]) is missing'::text;
  elsif (select provolatile from pg_proc where oid = 'public.xact_ref_prices_for(text[])'::regprocedure) <> 's' then
    problems := problems || 'xact_ref_prices_for() is not STABLE'::text;
  end if;
  if to_regprocedure('public.xact_ref_reload(jsonb, jsonb)') is null then
    problems := problems || 'public.xact_ref_reload(jsonb, jsonb) is missing'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'xact reference functions are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 3–7. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-xr-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-xr-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-xr-crew@example.invalid',   '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

-- the vocabulary profiles_role_check enforces since 0012: owner / office / crew
insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000d001', 'xr test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000d002', 'xr test office', 'office'),
  ('00000000-0000-0000-0000-00000000d003', 'xr test crew',   'crew')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 3a. the owner loads two price rows and three lines (all invented)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  res jsonb;
  n int;
begin
  res := public.xact_ref_reload(
    '[{"category": "TST", "code": "TST1", "activity": "Replace", "unit": "SF",
       "description": "test item one", "n_lines": 3, "n_estimates": 2,
       "median": 1.25, "min": 1.00, "max": 1.50, "latest_median": 1.40,
       "latest_price_list": "TESTLIST_JAN26", "price_lists": ["TESTLIST_JAN26"],
       "job_types": ["restoration"], "first_date": "2026-01-02", "last_date": "2026-02-03"},
      {"category": "ZZZ", "code": "ZZZ9", "unit": "EA",
       "description": "test item two", "n_lines": 1, "n_estimates": 1,
       "median": 10.00, "min": 10.00, "max": 10.00, "latest_median": null,
       "latest_price_list": null, "price_lists": [], "job_types": [],
       "first_date": "", "last_date": null}]'::jsonb,
    '[{"estimate_id": "T-1", "job_type": "restoration", "loss_type": "water", "est_date": "2026-01-02",
       "room": "Test Room", "line_no": 1, "category": "TST", "code": "TST1", "description": "test item one",
       "activity": "Replace", "unit": "SF", "qty": 12.5, "unit_cost": 1.25, "remove_price": null,
       "replace_price": null, "line_total": 15.63, "price_list": "TESTLIST_JAN26", "note": null},
      {"estimate_id": "T-1", "job_type": "restoration", "loss_type": "water", "est_date": "2026-01-02",
       "room": null, "line_no": 2, "category": "TST", "code": "TST1", "description": "test item one",
       "activity": "Replace", "unit": "SF", "qty": 4, "unit_cost": 1.00, "remove_price": 0.25,
       "replace_price": 0.75, "line_total": 4.00, "price_list": "TESTLIST_JAN26", "note": "test note"},
      {"estimate_id": "T-2", "job_type": "mitigation", "loss_type": "water", "est_date": "",
       "room": "Other Room", "line_no": 1, "category": "ZZZ", "code": "ZZZ9", "description": "test item two",
       "activity": "", "unit": "EA", "qty": 1, "unit_cost": 10.00, "remove_price": null,
       "replace_price": null, "line_total": 10.00, "price_list": null, "note": null}]'::jsonb);
  if res is distinct from '{"prices": 2, "lines": 3}'::jsonb then
    raise exception 'the owner''s reload returned %, expected {"prices": 2, "lines": 3}', res;
  end if;

  select count(*) into n from public.xact_ref_prices_for();
  if n <> 2 then
    raise exception 'after the owner''s reload, xact_ref_prices_for() returns % of 2 rows', n;
  end if;
  select count(*) into n from public.xact_ref_prices_for(array['ZZZ']);
  if n <> 1 then
    raise exception 'xact_ref_prices_for(array[ZZZ]) returns % of 1 row', n;
  end if;
  select count(*) into n from public.xact_ref_prices_for(array['NOPE']);
  if n <> 0 then
    raise exception 'xact_ref_prices_for(array[NOPE]) returns % rows, expected 0', n;
  end if;
  select count(*) into n from public.xact_ref_prices_for()
   where category = 'TST' and code = 'TST1' and activity = 'Replace' and unit = 'SF'
     and median = 1.25 and latest_median = 1.40 and price_lists = array['TESTLIST_JAN26']
     and first_date = date '2026-01-02' and loaded_at is not null;
  if n <> 1 then
    raise exception 'the TST1 reference row did not round-trip (median, latest_median, price_lists, first_date, loaded_at)';
  end if;
  select count(*) into n from public.xact_ref_prices_for()
   where code = 'ZZZ9' and activity = '' and first_date is null and latest_median is null;
  if n <> 1 then
    raise exception 'a missing activity or an empty date did not load as '''' / null';
  end if;
end
$$;
release savepoint s;
reset role;

-- 3b. as the database owner: what landed in the lines table
do $$
declare n int;
begin
  select count(*) into n from public.xact_ref_lines;
  if n <> 3 then
    raise exception 'xact_ref_lines holds % of 3 rows after the reload', n;
  end if;
  select count(*) into n from public.xact_ref_lines
   where id is not null and loaded_at is not null and estimate_id is not null;
  if n <> 3 then
    raise exception 'a reference line is missing its generated id, loaded_at or estimate_id';
  end if;
  select count(*) into n from public.xact_ref_lines where estimate_id = 'T-2' and est_date is null;
  if n <> 1 then
    raise exception 'an empty est_date did not load as null';
  end if;
end
$$;

-- 3c. a second reload REPLACES both tables; nothing accumulates
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare res jsonb;
begin
  res := public.xact_ref_reload(
    '[{"category": "TST", "code": "TST2", "activity": "Remove", "median": 2.00}]'::jsonb,
    '[{"estimate_id": "T-3", "category": "TST", "code": "TST2", "activity": "Remove", "unit": "LF", "qty": 3, "unit_cost": 2.00, "line_total": 6.00}]'::jsonb);
  if res is distinct from '{"prices": 1, "lines": 1}'::jsonb then
    raise exception 'the second reload returned %, expected {"prices": 1, "lines": 1}', res;
  end if;
end
$$;
release savepoint s;
reset role;

do $$
begin
  if (select count(*) from public.xact_ref_prices) <> 1
     or (select count(*) from public.xact_ref_lines) <> 1
     or exists (select 1 from public.xact_ref_prices where code <> 'TST2') then
    raise exception 'a second reload did not replace the tables whole';
  end if;
  if not exists (select 1 from public.xact_ref_prices where code = 'TST2' and unit = '') then
    raise exception 'a price row with no unit did not load with unit = ''''';
  end if;
end
$$;

-- 3d. a malformed payload is refused, and the tables are left as they were
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.xact_ref_reload('{"not": "an array"}'::jsonb, '[]'::jsonb);
    raise exception 'xact_ref_reload accepted an object for p_prices';
  exception
    when invalid_parameter_value then null;
  end;
  -- a null would read as "no rows" and silently empty both tables
  begin
    perform public.xact_ref_reload('[]'::jsonb, null);
    raise exception 'xact_ref_reload accepted a null p_lines';
  exception
    when invalid_parameter_value then null;
  end;
  begin
    perform public.xact_ref_reload('[{"code": "NOCAT"}]'::jsonb, '[]'::jsonb);
    raise exception 'xact_ref_reload accepted a price row with no category';
  exception
    when not_null_violation then null;
  end;
  if (select count(*) from public.xact_ref_prices_for()) <> 1 then
    raise exception 'a refused reload changed the reference rows';
  end if;
end
$$;
release savepoint s;
reset role;

-- 4. office reads through the function, and cannot reload
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d002", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.xact_ref_prices_for();
  if n <> 1 then
    raise exception 'office reads % of 1 reference row through xact_ref_prices_for()', n;
  end if;
  begin
    perform public.xact_ref_reload('[]'::jsonb, '[]'::jsonb);
    raise exception 'office reloaded the Xactimate reference';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 5–6. crew: zero rows and no error from the read door; 42501 from the write door
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d003", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.xact_ref_prices_for();
  if n <> 0 then
    raise exception 'a crew member reads % reference row(s) through xact_ref_prices_for()', n;
  end if;
  begin
    perform public.xact_ref_reload('[]'::jsonb, '[]'::jsonb);
    raise exception 'a crew member reloaded the Xactimate reference';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 7a. signed in — even as the owner — the tables themselves are closed
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform 1 from public.xact_ref_prices;
    raise exception 'an authenticated user selected from xact_ref_prices directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.xact_ref_lines;
    raise exception 'an authenticated user selected from xact_ref_lines directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.xact_ref_prices (category, code) values ('FORGED', 'FORGED');
    raise exception 'an authenticated user inserted into xact_ref_prices directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.xact_ref_lines where true;
    raise exception 'an authenticated user deleted from xact_ref_lines directly';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 7b. anon has nothing at all: no table, no read door, no write door
savepoint s;
set local role anon;
do $$
begin
  begin
    perform 1 from public.xact_ref_prices;
    raise exception 'anon can read xact_ref_prices';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.xact_ref_lines;
    raise exception 'anon can read xact_ref_lines';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.xact_ref_prices_for();
    raise exception 'anon can execute xact_ref_prices_for()';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.xact_ref_reload('[]'::jsonb, '[]'::jsonb);
    raise exception 'anon can execute xact_ref_reload()';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

rollback;
