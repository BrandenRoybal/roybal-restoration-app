-- ============================================================
-- 216: individual logins — roles, authorship, admin-only deletes
-- ------------------------------------------------------------
-- Phase 1 of the sync rearchitecture (docs/Sync_Rearchitecture_Plan.md).
-- Every tech signs in as themselves; every server write records who made
-- it; destructive rights concentrate in admin accounts.
--
--  • profiles: seeded for the 4 accounts that predate the
--    on_auth_user_created trigger (owner = admin, shared crew login = tech,
--    the two AI service accounts = viewer). New auth users auto-profile
--    as tech via the existing handle_new_user trigger.
--  • 'office' added to user_role for later phases (edit, no delete);
--    unused until then.
--  • updated_by on field_projects + coordination_jobs, stamped
--    server-side from auth.uid() — clients cannot spoof it, and legacy
--    clients need no changes. blob_history records each preserved
--    version's author.
--  • hard DELETE on both blob tables becomes admin-only via a RESTRICTIVE
--    policy (same mechanism that fences the AI service accounts). The app
--    only ever soft-deletes, so nothing changes for the crew.
--  • is_admin() / handle_new_user() hardened with a pinned search_path.
--
-- SECURITY NOTE (why role changes are SQL-only): this migration makes
-- profiles.role the boundary for destructive rights. So it also (a) revokes
-- role-column writes from app clients — a tech cannot PATCH themselves to
-- admin — and (b) stops trusting a signup's self-declared role. Public
-- signup is still enabled on this project (Auth → Providers → Email); with
-- (b) a self-signup can only ever land as 'tech', but a stranger as 'tech'
-- still gets full job-data read/write via the legacy USING(true) policies.
-- RECOMMENDED: disable public signups (invite-only) in the dashboard; the
-- Phase 3 role-aware policies close the tech-level data exposure for good.
--
-- Rollout (operator steps, dashboard):
--   0. Auth → Providers → Email: turn OFF public sign-ups (invite-only).
--   1. Auth → Add user for each crew member (or invite by email).
--      Their profile auto-creates with role 'tech'.
--   2. Promote someone (SQL editor — only postgres/service_role can):
--        update profiles set role='admin' where id =
--          (select id from auth.users where email='person@…');
--   3. Sign each device in with its person's account. The shared
--      roybalconstruction@icloud.com login keeps working until every
--      device is converted; disable it in Auth → Users when done.
--   4. Verify:  select u.email, p.role from profiles p
--                 join auth.users u on u.id = p.id order by p.role;
--      expect branden=admin, shared=tech, the two agents=viewer.
-- ============================================================

set lock_timeout = '5s';

alter type public.user_role add value if not exists 'office';

-- harden the auth-era helpers (definer functions need a pinned search_path)
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- New users ALWAYS start as 'tech'. Never trust raw_user_meta_data->>'role':
-- it is attacker-controlled through /auth/v1/signup, and role is now the
-- destructive-rights boundary. Elevated roles are granted only by an operator
-- via SQL (rollout step 2).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'tech'
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  return new;   -- a profile hiccup must never block user creation
end;
$$;

-- seed profiles for the accounts that predate the on_auth_user_created
-- trigger. Authoritative for these four known accounts: converge the role
-- even if a row already exists, so an AI service account can't be left at a
-- non-viewer role.
insert into public.profiles (id, full_name, role)
select u.id, v.full_name, v.role::public.user_role
from (values
  ('branden@roybalconstruction.com',      'Branden Roybal',      'admin'),
  ('roybalconstruction@icloud.com',       'Field Crew (shared)', 'tech'),
  ('phone-agent@roybalconstruction.com',  'Phone Agent (AI)',    'viewer'),
  ('office-brief@roybalconstruction.com', 'Office Brief (AI)',   'viewer')
) as v(email, full_name, role)
join auth.users u on u.email = v.email
on conflict (id) do update
  set role = excluded.role, full_name = excluded.full_name;

-- profiles.role is now the boundary for destructive rights, so app clients
-- must not be able to change it. Column-level privileges are checked BEFORE
-- RLS, so this makes a self-service `PATCH /profiles {role:admin}` fail 403
-- while leaving the existing "update own profile" policy working for the
-- safe columns. Role changes happen only as postgres/service_role.
revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
grant  update (full_name, phone, avatar_url) on public.profiles to authenticated;

-- ---------- authorship: who wrote this row version ----------

alter table public.field_projects   add column if not exists updated_by uuid;
alter table public.coordination_jobs add column if not exists updated_by uuid;
alter table public.blob_history      add column if not exists updated_by uuid;

-- Stamp the writer. Unconditional assignment is deliberate:
--   • authenticated client → its own auth.uid() (cannot be spoofed in the
--     request body, since we overwrite whatever was sent)
--   • service_role / SQL write → auth.uid() is NULL, an HONEST "system/
--     automation" marker — never the previous human author inherited by
--     Postgres, which would fabricate authorship on AI-applied writes.
-- A genuine no-op write (content unchanged) leaves authorship untouched so an
-- idempotent re-push can't re-attribute the live row to whoever retried it.
create or replace function public.stamp_updated_by()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.data is not distinct from old.data
     and new.deleted is not distinct from old.deleted then
    return new;   -- no content change → authorship does not move
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists stamp_updated_by on public.field_projects;
create trigger stamp_updated_by
  before insert or update on public.field_projects
  for each row execute function public.stamp_updated_by();

drop trigger if exists stamp_updated_by on public.coordination_jobs;
create trigger stamp_updated_by
  before insert or update on public.coordination_jobs
  for each row execute function public.stamp_updated_by();

-- capture the preserved version's author in history (extends 215's function;
-- capture rules unchanged, see 215 for the design)
create or replace function public.capture_blob_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  regression     boolean := false;
  last_reg       timestamptz;
  rolling_id     bigint;
  rolling_anchor timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.data is not distinct from new.data
       and old.deleted is not distinct from new.deleted then
      return new;
    end if;

    begin
      regression :=
           ((new.data ? 'rev') and (old.data ? 'rev')
             and (new.data->>'rev')::numeric < (old.data->>'rev')::numeric)
        or ((new.data ? 'updatedAt') and (old.data ? 'updatedAt')
             and (new.data->>'updatedAt')::timestamptz
               < (old.data->>'updatedAt')::timestamptz);
    exception when others then
      regression := true;
      raise warning 'blob_history: malformed rev/updatedAt on %.% (%) — treating as regression',
        tg_table_name, old.id, sqlerrm;
    end;

    if regression then
      select max(replaced_at) into last_reg
        from public.blob_history
       where table_name = tg_table_name and id = old.id and was_regression;
      if last_reg is not null and last_reg > now() - interval '1 minute' then
        return new;
      end if;
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', true, old.updated_by);
      return new;
    end if;

    select hist_id, first_captured_at into rolling_id, rolling_anchor
      from public.blob_history
     where table_name = tg_table_name and id = old.id
       and op = 'update' and not was_regression
     order by replaced_at desc
     limit 1;

    if rolling_id is not null and rolling_anchor > now() - interval '60 minutes' then
      update public.blob_history
         set data = old.data, deleted = old.deleted,
             row_updated_at = old.updated_at, replaced_at = now(),
             updated_by = old.updated_by
       where hist_id = rolling_id;
    else
      insert into public.blob_history
        (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
      values
        (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'update', false, old.updated_by);
    end if;
    return new;

  elsif tg_op = 'DELETE' then
    insert into public.blob_history
      (table_name, id, data, deleted, row_updated_at, op, was_regression, updated_by)
    values
      (tg_table_name, old.id, old.data, old.deleted, old.updated_at, 'delete', false, old.updated_by);
    return old;
  end if;
  return null;
exception when others then
  raise warning 'blob_history capture failed for %.%: %', tg_table_name, old.id, sqlerrm;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- ---------- destructive rights: admins only ----------
-- RESTRICTIVE (ANDed with the permissive *_all policies), same mechanism
-- already fencing the AI service accounts. The app never hard-deletes —
-- soft deletes (deleted=true) are UPDATEs and stay open to every role.

drop policy if exists admin_only_hard_delete on public.field_projects;
create policy admin_only_hard_delete on public.field_projects
  as restrictive for delete to authenticated
  using (public.is_admin());

drop policy if exists admin_only_hard_delete on public.coordination_jobs;
create policy admin_only_hard_delete on public.coordination_jobs
  as restrictive for delete to authenticated
  using (public.is_admin());
