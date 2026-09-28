-- ============================================================================
-- Assertions for 0010_magicplan_exports.sql.
--
-- Run by the DB replay workflow (.github/workflows/db-replay.yml) against the
-- database `supabase db reset` has just rebuilt from supabase/migrations/,
-- after the census and after the other *.test.sql files. To run by hand:
-- `supabase start && supabase db reset --no-seed`, then
-- `psql -v ON_ERROR_STOP=1 -f supabase/test/magicplan_exports.test.sql <url>`.
--
-- magicplan_exports is the one table the Magicplan lane adds (design §4.1):
-- written only by the service role from magicplan-proxy, read by owner and
-- office through RLS, never by crew, never by an anonymous browser. Three
-- things a later migration could silently break are asserted here:
--   * the grant trap — default privileges hand anon and authenticated ALL on
--     every new table (0008, contract_tables.test.sql §2), so the revoke in
--     0010 is the only thing between this table and an anonymous DELETE;
--   * the read gate is role_is(), not current_role_name(). A real access
--     token carries role=authenticated, and current_role_name() returns that
--     claim before it reads profiles, so a policy on it refuses a real owner.
--     The impersonation blocks below set the claim exactly as a real token
--     would, so this is exercised rather than stated;
--   * the status check constraint, which is what keeps the client's five
--     status words the only ones a row can hold.
--
-- Each block raises on failure, so the first broken invariant stops the file
-- with a message naming it. Every row inserted is rolled back.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The table exists, RLS is on, and the columns are design §4.1's fourteen,
--    in order. The field app's PostgREST select lists (pendingQuery,
--    recentExportsQuery) name these columns; a rename here is a 400 there.
-- ---------------------------------------------------------------------------
do $$
declare
  cols text[];
  want text[] := array['id', 'mp_project_id', 'mp_plan_id', 'field_project_id', 'status',
                       'files', 'photos', 'statistics', 'floors_svg', 'error',
                       'received_at', 'synced_at', 'imported_at', 'imported_by'];
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'magicplan_exports' and c.relkind = 'r') then
    raise exception 'public.magicplan_exports is missing';
  end if;
  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'magicplan_exports') then
    raise exception 'RLS is not enabled on magicplan_exports';
  end if;

  select array_agg(a.attname::text order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = 'public.magicplan_exports'::regclass
     and a.attnum > 0 and not a.attisdropped;
  if cols <> want then
    raise exception 'magicplan_exports columns drifted from design §4.1: got %, want %', cols, want;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The constraints and indexes the census counts on: one primary key (the
--    +1 in EXPECT_PKUNIQUE), the status check, and the two lookup indexes —
--    (field_project_id, imported_at) is the adopt banner's query, and
--    (mp_plan_id, status) is the server's "already have it" lookup of prior
--    ready|imported rows before it downloads anything.
-- ---------------------------------------------------------------------------
do $$
declare
  idx text;
  missing text[] := '{}';
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.magicplan_exports'::regclass and contype = 'p') then
    raise exception 'magicplan_exports has no primary key';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.magicplan_exports'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) ~ 'unmatched') then
    raise exception 'magicplan_exports has no check constraint on status';
  end if;

  foreach idx in array array['magicplan_exports_job_idx', 'magicplan_exports_plan_idx']
  loop
    if not exists (select 1 from pg_indexes
                    where schemaname = 'public' and tablename = 'magicplan_exports' and indexname = idx) then
      missing := missing || idx;
    end if;
  end loop;
  if array_length(missing, 1) is not null then
    raise exception 'missing indexes on magicplan_exports: %', missing;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. The grant trap. anon holds nothing at all; authenticated holds SELECT and
--    nothing else (writes arrive through magicplan-proxy under the service
--    role, never a table grant); service_role can read, insert and update —
--    sync inserts, markImported and linkExport update in place.
-- ---------------------------------------------------------------------------
do $$
declare
  priv text;
  problems text[] := '{}';
begin
  foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
  loop
    if has_table_privilege('anon', 'public.magicplan_exports', priv) then
      problems := problems || format('anon has %s', priv);
    end if;
    if has_table_privilege('authenticated', 'public.magicplan_exports', priv)
       and priv <> 'SELECT' then
      problems := problems || format('authenticated has %s', priv);
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.magicplan_exports', 'SELECT') then
    problems := problems || 'authenticated cannot SELECT';
  end if;

  foreach priv in array array['SELECT', 'INSERT', 'UPDATE']
  loop
    if not has_table_privilege('service_role', 'public.magicplan_exports', priv) then
      problems := problems || format('service_role lacks %s', priv);
    end if;
  end loop;

  if array_length(problems, 1) is not null then
    raise exception 'magicplan_exports grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Exactly one policy, read-only, for authenticated, gated on role_is() and
--    not on current_role_name(). A text check, so a later CREATE OR REPLACE
--    that quietly swaps the gate back fails here before §5 has to explain why
--    the owner sees nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  p record;
  n int;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'magicplan_exports';
  if n <> 1 then
    raise exception 'magicplan_exports has % policies, expected exactly one read policy', n;
  end if;

  select policyname, cmd, roles, qual into p from pg_policies
   where schemaname = 'public' and tablename = 'magicplan_exports';
  if p.policyname <> 'magicplan_exports_read_office' then
    raise exception 'the magicplan_exports policy is named %, expected magicplan_exports_read_office', p.policyname;
  end if;
  if p.cmd <> 'SELECT' then
    raise exception 'magicplan_exports_read_office is FOR %, expected SELECT — writes are the service role''s alone', p.cmd;
  end if;
  if not ('authenticated' = any (p.roles)) then
    raise exception 'magicplan_exports_read_office is not granted to authenticated (roles = %)', p.roles;
  end if;
  if coalesce(p.qual, '') !~ 'role_is\(' then
    raise exception 'magicplan_exports_read_office does not gate on role_is(): %', p.qual;
  end if;
  if coalesce(p.qual, '') ~ 'current_role_name' then
    raise exception 'magicplan_exports_read_office gates on current_role_name(), which returns the token''s role=authenticated claim and refuses a real owner';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 5. Behaviour, as the roles actually see it. Four users — owner, crew, office
--    and a pre-remap `tech` row — the service role writes three rows, and each
--    user is asked what it can see and do. The replay has no auth trigger, so
--    the profiles rows are inserted directly. Everything is rolled back.
--
--    Fixed uuids so the impersonation blocks can name them as JWT subs. The
--    claims carry role=authenticated because that is what a real access token
--    carries; current_role_name() returns that claim, role_is() reads profiles.
-- ---------------------------------------------------------------------------
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000ee11', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee12', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee13', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee14', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-mp-tech@example.invalid',   '', now(), now(), now(), '{}', '{}');

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000ee11', 'mp owner',  'owner'),
  ('00000000-0000-0000-0000-00000000ee12', 'mp crew',   'crew'),
  ('00000000-0000-0000-0000-00000000ee13', 'mp office', 'office'),
  ('00000000-0000-0000-0000-00000000ee14', 'mp tech',   'tech')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 5a. the service role writes: two ready rows for one job (a first sync and a
--     re-pull an hour later) and one unmatched row (external_reference_id did
--     not match, so field_project_id is null). The jsonb columns default to
--     [] so the client can read them without a null guard, and a status word
--     outside the five is refused. Every path and name below is invented.
set local role service_role;

insert into public.magicplan_exports (mp_project_id, mp_plan_id, field_project_id, status, files, photos, statistics, synced_at)
values
  ('mp-test-1', 'plan-test-1', 'bj-test-job', 'ready',
   '[{"path": "sitevisit/bj-test-job/mp-0123abcd-Report.pdf", "name": "Report.pdf", "mime": "application/pdf", "size": 1024, "hash": "0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd0123abcd", "folder": "reports", "mp_last_modified": "2026-09-25 18:00:00", "file_type": "pdf"}]',
   '[]', '{"units": "imperial", "floors": []}', now() - interval '1 hour'),
  ('mp-test-1', 'plan-test-1', 'bj-test-job', 'ready',
   '[]', '[]', '{"units": "imperial", "floors": []}', now());

insert into public.magicplan_exports (mp_project_id, mp_plan_id, field_project_id, status, error)
values ('mp-test-2', 'plan-test-2', null, 'unmatched', 'external_reference_id did not match this job');

do $$
declare
  n int;
  r record;
begin
  select count(*) into n from public.magicplan_exports where mp_project_id like 'mp-test-%';
  if n <> 3 then
    raise exception 'service_role inserted % of the 3 test rows', n;
  end if;

  select * into r from public.magicplan_exports where mp_project_id = 'mp-test-2';
  if r.files <> '[]'::jsonb or r.photos <> '[]'::jsonb or r.floors_svg <> '[]'::jsonb then
    raise exception 'files/photos/floors_svg did not default to []';
  end if;
  if r.received_at is null then
    raise exception 'received_at did not default to now()';
  end if;

  begin
    insert into public.magicplan_exports (mp_project_id, mp_plan_id, status)
    values ('mp-test-3', 'plan-test-3', 'bogus');
    raise exception 'magicplan_exports accepted status ''bogus''';
  exception
    when check_violation then null;
  end;
end
$$;

reset role;

-- 5b. the owner sees all three rows, unmatched included — the admin Settings
--     panel lists unmatched rows so the office can link them to a job. The
--     first assertion pins the claim shape: if the token stops saying
--     role=authenticated this block no longer proves what its header says.
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee11", "role": "authenticated"}';
do $$
declare
  n int;
begin
  if public.current_role_name() is distinct from 'authenticated' then
    raise exception 'the claim no longer reads back as role=authenticated (current_role_name() = %); this block exists to prove role_is() works under exactly that claim', public.current_role_name();
  end if;
  select count(*) into n from public.magicplan_exports;
  if n <> 3 then
    raise exception 'owner sees % of the 3 export rows', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5c. office sees the same three
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee13", "role": "authenticated"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.magicplan_exports;
  if n <> 3 then
    raise exception 'office sees % of the 3 export rows', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5d. crew sees nothing — zero rows, not an error, so a crew device that
--     somehow asks gets an empty list and no toast
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee12", "role": "authenticated"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.magicplan_exports;
  if n <> 0 then
    raise exception 'a crew principal can read % magicplan_exports row(s)', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5e. a pre-remap `tech` row is a crew row (0006's normalisation): nothing
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee14", "role": "authenticated"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.magicplan_exports;
  if n <> 0 then
    raise exception 'a tech (old-vocabulary crew) principal can read % magicplan_exports row(s)', n;
  end if;
end
$$;
rollback to savepoint s;

-- 5f. nobody signed in may write, the owner included: the table grant, not
--     the policy, is what refuses, so each attempt fails with 42501 before
--     RLS is consulted. Writes go through magicplan-proxy under the service
--     role, which is the one write door design decision 4 allows.
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee11", "role": "authenticated"}';
do $$
begin
  begin
    insert into public.magicplan_exports (mp_project_id, mp_plan_id, field_project_id, status)
    values ('mp-test-4', 'plan-test-4', 'bj-test-job', 'ready');
    raise exception 'an authenticated owner inserted a magicplan_exports row directly instead of through magicplan-proxy';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.magicplan_exports set imported_at = now(), imported_by = 'test-mp-owner@example.invalid'
     where mp_project_id = 'mp-test-1';
    raise exception 'an authenticated owner stamped imported_at directly instead of through markImported';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.magicplan_exports where mp_project_id = 'mp-test-1';
    raise exception 'an authenticated owner deleted magicplan_exports rows directly';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

-- 5g. anon has nothing: not zero rows, a refusal (42501). The revoke in 0010
--     is what makes this true; without it the default privileges would let an
--     anonymous browser read every row.
savepoint s;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.magicplan_exports;
    raise exception 'anon can read magicplan_exports — the default-privilege grant was not revoked';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;

rollback;
