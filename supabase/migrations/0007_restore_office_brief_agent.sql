-- 0007_restore_office_brief_agent.sql
--
-- Data repair after the 2026-09-22 login clean-up. Nothing here is DDL.
--
-- What happened. Minutes after 0006 remapped the eleven logins on production
-- (2026-09-22 00:59 UTC), the owner cleaned up Supabase Auth → Users and
-- hard-deleted two logins:
--
--   * office-brief@roybalconstruction.com — the machine login the
--     `roybal-brief` edge function signs in as for the morning brief, the
--     crew-schedule digest and the weekly report. Deleted by mistake.
--     `profiles` lost its row (fk cascade); `agents.auth_user_id` for
--     agent:brief went null (0004: `on delete set null`); the three crons kept
--     running, and the first would have failed at 15:00 UTC on 2026-09-22.
--   * davidjarman511@yahoo.com — David Jarman, lead carpenter. Deliberate:
--     he left the company that day (owner, 2026-09-22 01:23 UTC). His login
--     stays gone. His `sync_clients` row survived the delete because that
--     table has no foreign key, and is the one row this file removes.
--
-- The owner recreated office-brief on the Users page with the same email
-- (a new uuid; the old one is not worth reinserting, nothing keys on it) and
-- pointed the BRIEF_MACHINE_PASSWORD function secret at its new password.
-- `handle_new_user` seeded the new login as `viewer` (0006), so the brief
-- already signs in and reads: every fence it depends on is keyed on
-- `auth.email()`, not on the role. What is still wrong, and what this file
-- puts right in one transaction:
--
--   1. the office-brief profile holds `viewer`, not `agent`;
--   2. agent:brief (agents row 1af33481-…) is not linked to a login;
--   3. one `sync_clients` row points at a profile that no longer exists.
--
-- Keyed on auth.users.email for the same reason 0006 is: a reviewer can
-- check an email against the Users page and cannot check a uuid against
-- anything.
--
-- CI: the replay database has no auth.users rows; every statement below
-- matches nothing there and the assertions are guarded on "auth.users has
-- rows", exactly like 0006. On staging (0 auth.users rows) the same. On
-- production the assertions bind and the file refuses to commit unless the
-- office-brief login exists, holds `agent`, and is linked.
--
-- After this file the fleet is 10 logins: 1 owner, 2 crew_lead, 5 crew,
-- 2 agent, 0 office. The type-swap migration (doc 09 §6, now 0008) must
-- assert on THESE numbers, not on 0006's.

do $$
declare
  n_users      int;
  brief_uid    uuid;
  n_profile    int;
  n_agent_link int;
  n_orphans    int;
begin
  select count(*) into n_users from auth.users;

  select u.id into brief_uid
    from auth.users u
   where lower(u.email) = 'office-brief@roybalconstruction.com';

  -- 1. the profile. `handle_new_user` normally seeds it; the upsert covers a
  --    login created while that trigger was failing (it swallows errors).
  insert into public.profiles (id, full_name, role)
  select brief_uid, 'Office brief (agent)', 'agent'
   where brief_uid is not null
  on conflict (id) do update set role = 'agent'
   where profiles.role::text <> 'agent';

  -- 2. the agents link (fixed id from 0004:970).
  update public.agents a
     set auth_user_id = brief_uid
   where a.id = '1af33481-7f1c-4485-87f5-7b0ec5e27554'          -- agent:brief
     and brief_uid is not null
     and a.auth_user_id is distinct from brief_uid;
  get diagnostics n_agent_link = row_count;

  -- 3. the orphaned field-sync row (David's). No fk, so the delete left it.
  delete from public.sync_clients s
   where not exists (select 1 from public.profiles p where p.id = s.user_id);
  get diagnostics n_orphans = row_count;

  raise notice 'office-brief restore: % auth users, brief uid %, agents relinked %, orphaned sync rows removed %',
    n_users, brief_uid, n_agent_link, n_orphans;

  -- Assertions: trivial on CI and staging (no auth.users rows), binding on
  -- production. A failure means the owner has not recreated the login yet
  -- (or created it under a different email); the answer is to do that on
  -- the Users page and re-run, not to bend the checks.
  if n_users > 0 then
    if brief_uid is null then
      raise exception 'office-brief restore: no auth.users row for office-brief@roybalconstruction.com — recreate it on Authentication → Users (auto-confirmed) before applying';
    end if;
    select count(*) into n_profile
      from public.profiles where id = brief_uid and role::text = 'agent';
    if n_profile <> 1 then
      raise exception 'office-brief restore: the office-brief profile is not on the agent role';
    end if;
    if (select auth_user_id from public.agents where id = '1af33481-7f1c-4485-87f5-7b0ec5e27554') is distinct from brief_uid then
      raise exception 'office-brief restore: agent:brief is not linked to the office-brief login';
    end if;
    if (select count(*) from public.agents where auth_user_id is not null) < 2 then
      raise exception 'office-brief restore: expected both machine logins linked to their agents rows';
    end if;
    if (select count(*) filter (where role::text = 'owner')  from public.profiles) <> 1
    or (select count(*) filter (where role::text = 'agent')  from public.profiles) <> 2
    or (select count(*) filter (where role::text = 'office') from public.profiles) <> 0 then
      raise exception 'office-brief restore: expected 1 owner / 2 agent / 0 office among the profiles';
    end if;
  end if;

  -- holds at zero rows too
  if exists (select 1 from public.sync_clients s
              where not exists (select 1 from public.profiles p where p.id = s.user_id)) then
    raise exception 'office-brief restore: an orphaned sync_clients row remains';
  end if;
  if exists (select 1 from public.profiles where role::text in ('admin', 'tech')) then
    raise exception 'office-brief restore: a profile still holds admin or tech';
  end if;
end
$$;
