-- ============================================================================
-- Assertions for 0010_magicplan_exports.sql (docs/Magicplan_Integration_Design.md §4.1).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/magicplan_exports.test.sql <staging url>
-- Everything it inserts is rolled back.
--
-- The rules it holds the table to:
--   1. RLS is on; anon holds nothing; authenticated holds SELECT and nothing
--      else (the baseline's default privileges would grant ALL otherwise).
--   2. The service role can write a row (magicplan-proxy's only door).
--   3. An owner-role user reads it — with a REAL user JWT's claims, which
--      carry role = "authenticated". That is the case current_role_name()
--      gets wrong and the reason the policy uses role_is().
--   4. A crew-role user reads zero rows.
--   5. An authenticated INSERT is refused; anon reads nothing.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. grants and RLS
do $$
declare
  p text;
  problems text[] := '{}';
begin
  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'magicplan_exports') then
    raise exception 'RLS is not enabled on magicplan_exports';
  end if;
  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
    if has_table_privilege('anon', 'public.magicplan_exports', p) then
      problems := problems || format('anon has %s', p);
    end if;
    if p <> 'SELECT' and has_table_privilege('authenticated', 'public.magicplan_exports', p) then
      problems := problems || format('authenticated has %s', p);
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.magicplan_exports', 'SELECT') then
    problems := problems || 'authenticated cannot SELECT'::text;
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'magicplan_exports grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2–5. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-owner@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-crew@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

-- today's vocabulary, as production holds it: the owner is `admin`, crew are `tech`
insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000c001', 'mp test owner', 'admin'),
  ('00000000-0000-0000-0000-00000000c002', 'mp test crew',  'tech')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 2. the service role writes
savepoint s;
set local role service_role;
insert into public.magicplan_exports (mp_project_id, mp_plan_id, field_project_id, status, files)
values ('test-mp-project', 'test-mp-plan', 'bj-test-mp', 'ready',
        '[{"path": "sitevisit/bj-test-mp/mp-aaaaaaaa-Report.pdf", "hash": "aaaaaaaa"}]'::jsonb);
release savepoint s;
reset role;

-- 3. the owner reads it, with the claims a real access token carries
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.magicplan_exports where mp_project_id = 'test-mp-project';
  if n <> 1 then
    raise exception 'the owner (profiles.role admin, JWT role authenticated) reads % of 1 magicplan_exports row', n;
  end if;
end
$$;
rollback to savepoint s;

-- 4. a crew member reads nothing
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c002", "role": "authenticated", "aud": "authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.magicplan_exports;
  if n <> 0 then
    raise exception 'a crew member reads % magicplan_exports row(s)', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5a. an authenticated insert is refused — even the owner's
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c001", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    insert into public.magicplan_exports (mp_project_id, mp_plan_id) values ('forged', 'forged');
    raise exception 'an authenticated user inserted into magicplan_exports';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.magicplan_exports set status = 'imported';
    raise exception 'an authenticated user updated magicplan_exports';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 5b. anon has nothing at all
savepoint s;
set local role anon;
do $$
begin
  begin
    perform 1 from public.magicplan_exports;
    raise exception 'anon can read magicplan_exports';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

rollback;
