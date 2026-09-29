-- ============================================================================
-- Assertions for 0005_role_enum_add_values.sql,
-- 0006_role_remap_and_dual_vocabulary.sql and 0012_role_enum_to_text.sql.
--
-- Run by the DB replay workflow (.github/workflows/db-replay.yml) against the
-- database `supabase db reset` has just rebuilt from supabase/migrations/,
-- after the census and after contract_tables.test.sql. To run by hand:
-- `supabase start && supabase db reset --no-seed`, then
-- `psql -v ON_ERROR_STOP=1 -f supabase/test/role_enum.test.sql <url>`.
--
-- The replay database has no auth.users rows, so 0006's remap moved nothing
-- there and its count assertions did not bite. These blocks create the rows
-- they need inside transactions they roll back. Until 0012 they asserted that
-- every gate gave the same answer for a row holding an OLD label as for its
-- TARGET label; now that 0012 has made the column text + check, they assert
-- the end state: only the six target names are storable, the old names are
-- refused at the row, and every gate answers from the name as held.
--
-- Each block raises on failure, so the first broken invariant stops the file
-- with a message naming it.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. 0012: the enum is gone; profiles.role is text, checked over the six
--    target names, defaulting to viewer. Storing an old label is a
--    check_violation, which is how the old vocabulary is actually dropped.
-- ---------------------------------------------------------------------------
do $$
declare
  coltype text;
  chk     text;
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public' and t.typname = 'user_role') then
    raise exception 'public.user_role still exists after 0012';
  end if;

  select format_type(a.atttypid, a.atttypmod) into coltype
    from pg_attribute a where a.attrelid = 'public.profiles'::regclass and a.attname = 'role';
  if coltype <> 'text' then
    raise exception 'profiles.role is % rather than text', coltype;
  end if;

  select pg_get_constraintdef(c.oid) into chk
    from pg_constraint c where c.conrelid = 'public.profiles'::regclass and c.conname = 'profiles_role_check';
  if chk is null then
    raise exception 'profiles_role_check is missing';
  end if;
  if chk !~ '''owner''' or chk !~ '''office''' or chk !~ '''crew_lead''' or chk !~ '''crew''' or chk !~ '''viewer''' or chk !~ '''agent''' then
    raise exception 'profiles_role_check does not name all six target roles: %', chk;
  end if;
  if chk ~ '''admin''' or chk ~ '''tech''' then
    raise exception 'profiles_role_check still admits an old label: %', chk;
  end if;
end
$$;

-- the constraint bites: an old label is refused at the row
begin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000ee00', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-old@example.invalid', '', now(), now(), now(), '{}', '{}');
do $$
declare
  lbl text;
begin
  foreach lbl in array array['admin', 'tech', 'nonsense']
  loop
    begin
      insert into public.profiles (id, full_name, role) values ('00000000-0000-0000-0000-00000000ee00', 'old', lbl)
      on conflict (id) do update set role = excluded.role;
      raise exception 'profiles accepted role %; profiles_role_check is not holding', lbl;
    exception when check_violation then
      null;  -- the expected refusal
    end;
  end loop;
end
$$;
rollback;


-- ---------------------------------------------------------------------------
-- 2. role_is() exists with the shape the gates rely on: stable, security
--    definer, search_path pinned, callable by authenticated and service_role
--    and by nobody else. The grant trap applies to functions as well as
--    tables: default privileges hand EXECUTE to anon.
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
begin
  select p.oid, p.provolatile, p.prosecdef, p.proconfig into f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'role_is';
  if not found then
    raise exception 'public.role_is() is missing';
  end if;
  if f.provolatile <> 's' then
    raise exception 'role_is() is not STABLE (volatility %)', f.provolatile;
  end if;
  if not f.prosecdef then
    raise exception 'role_is() is not SECURITY DEFINER';
  end if;
  if f.proconfig is null or not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%') then
    raise exception 'role_is() does not pin search_path';
  end if;

  if not has_function_privilege('authenticated', f.oid, 'execute') then
    raise exception 'authenticated cannot execute role_is()';
  end if;
  if not has_function_privilege('service_role', f.oid, 'execute') then
    raise exception 'service_role cannot execute role_is()';
  end if;
  if has_function_privilege('anon', f.oid, 'execute') then
    raise exception 'anon can execute role_is() — the default-privilege grant was not revoked';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. The rewritten definitions say what 0006 says they say. Text checks, so
--    a later CREATE OR REPLACE that quietly restores an old list fails here.
-- ---------------------------------------------------------------------------
do $$
declare
  d text;
begin
  -- handle_new_user: signups land on viewer (owner's decision, 2026-09-19)
  d := pg_get_functiondef('public.handle_new_user()'::regprocedure);
  if d !~ '''viewer''' or d ~ '''tech''' then
    raise exception 'handle_new_user() does not seed new signups as viewer';
  end if;
  if (select pg_get_expr(ad.adbin, ad.adrelid)
        from pg_attrdef ad join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
       where ad.adrelid = 'public.profiles'::regclass and a.attname = 'role') !~ '''viewer''' then
    raise exception 'profiles.role column default is not viewer';
  end if;

  -- _sync_guard: goes through role_is, and names neither of the two labels
  -- that are renamed (office and viewer keep their names, so they may appear)
  d := pg_get_functiondef('public._sync_guard(text)'::regprocedure);
  if d !~ 'role_is\(' then
    raise exception '_sync_guard() does not use role_is()';
  end if;
  if d ~ '''tech''' or d ~ '''admin''' then
    raise exception '_sync_guard() still names a renamed old-vocabulary label';
  end if;

  -- is_admin: owner is the admin of the target vocabulary
  d := pg_get_functiondef('public.is_admin()'::regprocedure);
  if d !~ 'role_is\(''owner''\)' then
    raise exception 'is_admin() is not role_is(''owner'')';
  end if;

  -- role_is and current_role_name: the admin→owner / tech→crew arm is gone
  -- (0012); both read the role as held and name no old label
  d := pg_get_functiondef('public.role_is(text[])'::regprocedure);
  if d ~ '''admin''' or d ~ '''tech''' then
    raise exception 'role_is() still carries the old-name arm after 0012';
  end if;
  d := pg_get_functiondef('public.current_role_name()'::regprocedure);
  if d ~ '''admin''' or d ~ '''tech''' then
    raise exception 'current_role_name() still carries the old-name arm after 0012';
  end if;
  if d !~ 'request\.jwt\.claims' then
    raise exception 'current_role_name() no longer prefers the JWT role claim';
  end if;

  -- the four long RPCs: each list admits the target vocabulary (the dead
  -- old names they still carry are unreachable behind profiles_role_check
  -- and are trimmed when each function is next touched; doc 09 §4.1)
  foreach d in array array['contact_mark_review_asked', 'contact_merge', 'contact_resolve', 'coordination_job_patch']
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = d
                      and pg_get_functiondef(p.oid) ~ '''owner''') then
      raise exception '%() does not admit the target vocabulary (no ''owner'' in its list)', d;
    end if;
  end loop;

  -- field_photos: four policies, same names as before, three on role_is
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'field_photos') <> 4 then
    raise exception 'field_photos policy count changed';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'field_photos'
         and policyname in ('field_photos_crew_read', 'field_photos_crew_update', 'field_photos_crew_write')
         and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'role_is\(') <> 3 then
    raise exception 'a field_photos crew policy does not use role_is()';
  end if;

  -- sync_fleet: recreated by 0012, still service_role-only (the default
  -- grants to anon and authenticated must not have come back with it)
  if not exists (select 1 from pg_views where schemaname = 'public' and viewname = 'sync_fleet') then
    raise exception 'sync_fleet is missing after 0012';
  end if;
  if has_table_privilege('anon', 'public.sync_fleet', 'select')
     or has_table_privilege('authenticated', 'public.sync_fleet', 'select') then
    raise exception 'sync_fleet is readable by anon or authenticated; 0012 did not restate its grants';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Behaviour. Six users, one per target role, then role_is(), is_admin()
--    and current_role_name() are asked as each of them. The replay has no
--    auth trigger, so the profiles rows are inserted directly. Everything is
--    rolled back.
--
--    Fixed uuids so the impersonation blocks can name them as JWT subs.
-- ---------------------------------------------------------------------------
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-office@example.invalid',    '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-owner@example.invalid',     '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-crew@example.invalid',      '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee04', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-crew-lead@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee05', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-agent@example.invalid',     '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000ee06', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-role-viewer@example.invalid',    '', now(), now(), now(), '{}', '{}');

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000ee01', 'office',     'office'),
  ('00000000-0000-0000-0000-00000000ee02', 'new owner',  'owner'),
  ('00000000-0000-0000-0000-00000000ee03', 'crew',       'crew'),
  ('00000000-0000-0000-0000-00000000ee04', 'crew lead',  'crew_lead'),
  ('00000000-0000-0000-0000-00000000ee05', 'machine',    'agent'),
  ('00000000-0000-0000-0000-00000000ee06', 'read only',  'viewer')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 4a. an `office` row: office-level, may sync, is not the owner
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee01"}';
do $$
begin
  if not public.role_is('office') then raise exception 'office row: role_is(office) is false'; end if;
  if not public.role_is('owner', 'office') then raise exception 'office row: the owner/office list refuses it'; end if;
  if not public.role_is('owner', 'office', 'crew_lead', 'crew') then raise exception 'office row: the _sync_guard list refuses it'; end if;
  if public.is_admin() then raise exception 'office row: is_admin() is true'; end if;
  if public.role_is('admin') then raise exception 'office row: role_is(admin) is true'; end if;
  if public.role_is('owner', 'crew', 'crew_lead', 'viewer', 'agent') then raise exception 'office row matched a role it does not hold'; end if;
  if public.current_role_name() is distinct from 'office' then raise exception 'office row: current_role_name() = %', public.current_role_name(); end if;
end
$$;
rollback to savepoint s;

-- 4a2. the owner row
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee02"}';
do $$
begin
  if not public.role_is('owner') then raise exception 'owner row: role_is(owner) is false'; end if;
  if not public.is_admin() then raise exception 'owner row: is_admin() is false'; end if;
  if public.role_is('admin') then raise exception 'owner row: role_is(admin) is true'; end if;
  if public.current_role_name() is distinct from 'owner' then raise exception 'owner row: current_role_name() = %', public.current_role_name(); end if;
end
$$;
rollback to savepoint s;

-- 4b. a `crew` row: may sync, is not admin
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee03"}';
do $$
begin
  if not public.role_is('crew') then raise exception 'crew row: role_is(crew) is false'; end if;
  if not public.role_is('owner', 'office', 'crew_lead', 'crew') then raise exception 'crew row: the _sync_guard list refuses it'; end if;
  if public.is_admin() then raise exception 'crew row: is_admin() is true'; end if;
  if public.role_is('tech') then raise exception 'crew row: role_is(tech) is true'; end if;
  if public.current_role_name() is distinct from 'crew' then raise exception 'crew row: current_role_name() = %', public.current_role_name(); end if;
end
$$;
rollback to savepoint s;

-- 4c. a `crew_lead` row: may sync, is not admin, passes through unchanged
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee04"}';
do $$
begin
  if not public.role_is('crew_lead') then raise exception 'crew_lead row: role_is(crew_lead) is false'; end if;
  if not public.role_is('owner', 'office', 'crew_lead', 'crew') then raise exception 'crew_lead row: the _sync_guard list refuses it'; end if;
  if public.is_admin() then raise exception 'crew_lead row: is_admin() is true'; end if;
  if public.current_role_name() is distinct from 'crew_lead' then raise exception 'crew_lead row: current_role_name() = %', public.current_role_name(); end if;
end
$$;
rollback to savepoint s;

-- 4d. `agent` and `viewer` rows: cannot sync, are not admin
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee05"}';
do $$
begin
  if not public.role_is('agent') then raise exception 'agent row: role_is(agent) is false'; end if;
  if public.role_is('owner', 'office', 'crew_lead', 'crew') then raise exception 'agent row passes the _sync_guard list'; end if;
  if public.is_admin() then raise exception 'agent row: is_admin() is true'; end if;
end
$$;
rollback to savepoint s;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee06"}';
do $$
begin
  if not public.role_is('viewer') then raise exception 'viewer row: role_is(viewer) is false'; end if;
  if public.role_is('owner', 'office', 'crew_lead', 'crew') then raise exception 'viewer row passes the _sync_guard list'; end if;
  if public.is_admin() then raise exception 'viewer row: is_admin() is true'; end if;
end
$$;
rollback to savepoint s;

-- 4e. no caller at all: false, never null, never an error
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{}';
do $$
begin
  if public.role_is('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent') is distinct from false then
    raise exception 'role_is() with no caller did not return false';
  end if;
  if public.is_admin() is distinct from false then
    raise exception 'is_admin() with no caller did not return false';
  end if;
end
$$;
rollback to savepoint s;

-- 4f. _sync_guard itself, for a crew row, on a build the gate accepts: the
--     whole field-sync lane in one call. Only service_role and its owner may
--     call it directly (push_project does, as SECURITY DEFINER), so this runs
--     as the superuser with just the JWT claims set — auth.uid() and role_is()
--     read the claims, not the session role. Any exception here is the outage
--     the one-transaction rule exists to prevent.
savepoint s;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee03"}';
do $$
begin
  perform public._sync_guard('99999');
end
$$;
rollback to savepoint s;

-- ...and a viewer row is refused by it, with the message the field app shows.
savepoint s;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000ee06"}';
do $$
begin
  begin
    perform public._sync_guard('99999');
    raise exception '_sync_guard() admitted a viewer row';
  exception when others then
    if sqlerrm !~ 'may not write field_projects' then
      raise;
    end if;
  end;
end
$$;
rollback to savepoint s;

rollback;
