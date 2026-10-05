-- ============================================================================
-- Assertions for 0018_receipt_return_windows.sql (the office Receipts page's
-- store return windows and "Nothing left over" answers).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/receipt_return_windows.test.sql <staging url>
-- Everything it inserts is rolled back.
--
-- The rules it holds the tables to:
--   1. RLS is on; anon holds nothing; authenticated holds SELECT and nothing
--      else (no TRUNCATE, which would bypass RLS); one read policy per table;
--      the two doors are executable by authenticated, never by anon.
--   2. The owner and the office set, change and clear a window through
--      receipt_vendor_set, and clear / un-clear receipts through
--      receipt_return_review_set; each write is stamped with the caller.
--   3. A crew lead, a crew member and the brief's agent login read nothing
--      and are refused by both doors (42501); even the owner cannot write the
--      tables directly.
--   4. The checks hold: a key vendorKey() could never produce, 'unknown',
--      a window outside 0..365 days and an unknown status are rejected.
--   5. anon reads nothing and cannot call the doors.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. grants, RLS, policies
do $$
declare
  t text;
  p text;
  problems text[] := '{}';
begin
  foreach t in array array['public.receipt_vendors', 'public.receipt_return_reviews'] loop
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
  foreach p in array array['public.receipt_vendor_set(text, integer, text, text)', 'public.receipt_return_review_set(uuid, text[], text)'] loop
    if has_function_privilege('anon', p, 'EXECUTE') then
      problems := problems || format('anon can execute %s', p);
    end if;
    if not has_function_privilege('authenticated', p, 'EXECUTE') then
      problems := problems || format('authenticated cannot execute %s', p);
    end if;
    if not (select prosecdef from pg_proc where oid = p::regprocedure) then
      problems := problems || format('%s is not SECURITY DEFINER', p);
    end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = p::regprocedure) <> 'postgres' then
      problems := problems || format('%s is not owned by postgres', p);
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'receipt return windows grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2–5. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000d018', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rw-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d019', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rw-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d01a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rw-lead@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d01b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rw-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d01c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rw-agent@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000d018', 'rw test owner',     'owner'),
  ('00000000-0000-0000-0000-00000000d019', 'rw test office',    'office'),
  ('00000000-0000-0000-0000-00000000d01a', 'rw test crew lead', 'crew_lead'),
  ('00000000-0000-0000-0000-00000000d01b', 'rw test crew',      'crew'),
  ('00000000-0000-0000-0000-00000000d01c', 'rw test agent',     'agent')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 2a. the owner sets a window and clears two receipts, stamped as the owner
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d018", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int; v record;
begin
  n := public.receipt_vendor_set('home depot', 90, 'Home Depot', 'most items');
  if n <> 1 then raise exception 'receipt_vendor_set wrote % rows, expected 1', n; end if;
  select * into v from public.receipt_vendors where vendor_key = 'home depot';
  if v.return_days <> 90 or v.display_name <> 'Home Depot' or v.updated_by <> '00000000-0000-0000-0000-00000000d018' then
    raise exception 'the owner''s window landed wrong: %', row_to_json(v);
  end if;
  n := public.receipt_vendor_set('spenard builders supply', 30);
  n := public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array['R1', 'R2', 'R2'], 'nothing_to_return');
  if n <> 2 then raise exception 'receipt_return_review_set wrote % rows, expected 2 (duplicates folded)', n; end if;
  n := public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array['R1'], 'nothing_to_return');
  if n <> 1 or (select count(*) from public.receipt_return_reviews) <> 2 then
    raise exception 'clearing a receipt twice must update, not add a row';
  end if;
  if (select count(*) from public.receipt_return_reviews where updated_by = '00000000-0000-0000-0000-00000000d018') <> 2 then
    raise exception 'review rows are not stamped with the owner';
  end if;
  n := public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array[]::text[], 'nothing_to_return');
  if n <> 0 then raise exception 'an empty list wrote % rows', n; end if;
  -- even the owner cannot write the tables directly: the doors are the only way in
  begin
    insert into public.receipt_vendors (vendor_key, return_days) values ('forged', 10);
    raise exception 'the owner inserted into receipt_vendors directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.receipt_return_reviews where job_id = '00000000-0000-0000-0000-0000000e0018';
    raise exception 'the owner deleted from receipt_return_reviews directly';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;

-- 2b. the office changes the window and un-clears a receipt, stamped as the office
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d019", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int; v record;
begin
  if (select count(*) from public.receipt_vendors) <> 2 then
    raise exception 'the office reads % windows, expected 2', (select count(*) from public.receipt_vendors);
  end if;
  n := public.receipt_vendor_set('home depot', 60, 'Home Depot', '');
  select * into v from public.receipt_vendors where vendor_key = 'home depot';
  if v.return_days <> 60 or v.updated_by <> '00000000-0000-0000-0000-00000000d019' then
    raise exception 'the office''s change landed wrong: %', row_to_json(v);
  end if;
  n := public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array['R2'], null);
  if n <> 1 or (select count(*) from public.receipt_return_reviews) <> 1 then
    raise exception 'un-clearing a receipt removed % rows', n;
  end if;
  n := public.receipt_vendor_set('spenard builders supply', null);
  if n <> 1 or exists (select 1 from public.receipt_vendors where vendor_key = 'spenard builders supply') then
    raise exception 'days null must delete the window';
  end if;
end
$$;
release savepoint s;

-- 3. a crew lead, a crew member and the agent login: nothing to read, both doors refuse
do $$
declare
  uid text;
  n int;
begin
  foreach uid in array array['00000000-0000-0000-0000-00000000d01a', '00000000-0000-0000-0000-00000000d01b', '00000000-0000-0000-0000-00000000d01c'] loop
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated", "aud": "authenticated"}', uid), true);
    select count(*) into n from public.receipt_vendors;
    if n <> 0 then raise exception '% reads % receipt_vendors rows', uid, n; end if;
    select count(*) into n from public.receipt_return_reviews;
    if n <> 0 then raise exception '% reads % receipt_return_reviews rows', uid, n; end if;
    begin
      perform public.receipt_vendor_set('home depot', 1);
      raise exception '% set a return window', uid;
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array['R9'], 'nothing_to_return');
      raise exception '% cleared a receipt', uid;
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.receipt_vendors (vendor_key, return_days) values ('forged', 10);
      raise exception '% inserted into receipt_vendors', uid;
    exception when insufficient_privilege then null;
    end;
    perform set_config('role', 'postgres', true);
  end loop;
  reset role;
  -- and nothing they tried changed anything
  if (select return_days from public.receipt_vendors where vendor_key = 'home depot') <> 60 then
    raise exception 'a refused caller changed the home depot window';
  end if;
  if exists (select 1 from public.receipt_return_reviews where receipt_id = 'R9') then
    raise exception 'a refused caller cleared a receipt';
  end if;
end
$$;

-- 4. the checks
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d018", "role": "authenticated", "aud": "authenticated"}';
do $$
declare bad text;
begin
  foreach bad in array array['  home  depot ', 'unknown', 'Home Depot', 'home-depot', ''] loop
    begin
      perform public.receipt_vendor_set(bad, 30);
      raise exception 'vendor key % was accepted', quote_literal(bad);
    exception when check_violation then null;
    end;
  end loop;
  begin
    perform public.receipt_vendor_set('lowes', 400);
    raise exception 'a 400-day window was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.receipt_vendor_set('lowes', -1);
    raise exception 'a negative window was accepted';
  exception when check_violation then null;
  end;
  perform public.receipt_vendor_set('lowes', 0, 'Lowe''s', 'no returns');   -- 0 = takes no returns: allowed
  begin
    perform public.receipt_return_review_set('00000000-0000-0000-0000-0000000e0018', array['R1'], 'returned');
    raise exception 'an unknown review status was accepted';
  exception when check_violation then null;
  end;
end
$$;
rollback to savepoint s;

-- 5. anon has nothing at all
savepoint s;
set local role anon;
do $$
begin
  begin
    perform 1 from public.receipt_vendors;
    raise exception 'anon can read receipt_vendors';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.receipt_return_reviews;
    raise exception 'anon can read receipt_return_reviews';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.receipt_vendor_set('home depot', 1);
    raise exception 'anon can call receipt_vendor_set';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

rollback;
