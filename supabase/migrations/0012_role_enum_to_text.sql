-- 0012_role_enum_to_text.sql
--
-- Step N+2 of the role-enum move (docs/architecture/09 §6). One week after
-- 0006 remapped every profile to the target vocabulary (production
-- 2026-09-22), and after 0007 put the recreated office-brief login back on
-- `agent`, this file retires the old names for good:
--
--   * `profiles.role` becomes `text` with a check constraint over the six
--     target names (03 §3.4: enumerations are text + check, never a Postgres
--     enum) — there is no ALTER TYPE … DROP VALUE, so this is how the old
--     labels are actually dropped;
--   * `public.user_role` is dropped;
--   * `role_is()` and `current_role_name()` lose their admin→owner /
--     tech→crew arm and become a plain membership test / plain read;
--   * `sync_fleet` is dropped and recreated verbatim around the `alter`
--     (a view that selects the column blocks the type change), with its
--     grants restated because default privileges would otherwise hand the
--     recreated view to anon and authenticated.
--
-- Nothing else changes. Every gate 0006 rewrote compares `role::text` or
-- goes through `role_is()`, so no other function or policy is touched. The
-- four long RPCs (contact_mark_review_asked, contact_merge, contact_resolve,
-- coordination_job_patch) keep the dead 'admin'/'tech' entries in their
-- `in (…)` lists; unreachable once the check constraint holds, and trimmed
-- whenever each is next touched for its own reasons (09 §4.1). The three
-- proxy edge functions drop the dead names from their role arrays in this
-- same PR and are deployed through the connector on the owner's word.
--
-- Data touched: the type of one column on the profiles rows (10 on
-- production at the time of writing). No value changes. If any row still
-- holds a label outside the six, the precondition block below stops the file
-- before anything is altered, and the check constraint would refuse it
-- regardless.
--
-- Census: EXPECT_ENUMS 7 → 6. Tables, policies, triggers, views, functions
-- and pk/unique counts are unchanged (a check constraint is contype 'c',
-- which the census does not count; the view is dropped and recreated inside
-- the same transaction).
--
-- Rollback: forward-only. Recreating the enum and casting back is mechanical
-- but the old vocabulary is gone by design; anything found after this file
-- is fixed forward.

-- ---------------------------------------------------------------------------
-- 0. Preconditions: every row already holds a target name, and nothing but
--    the column, its default and the sync_fleet view depends on the type.
-- ---------------------------------------------------------------------------
do $$
declare
  n_bad  int;
  n_deps int;
begin
  select count(*) into n_bad
    from public.profiles
   where role::text not in ('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent');
  if n_bad > 0 then
    raise exception 'role enum to text: % profile row(s) still hold a label outside the six target names; 0006/0007 did not finish here', n_bad;
  end if;

  select count(*) into n_deps
    from pg_depend d
    join pg_type t on t.oid = d.refobjid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname = 'user_role'
     and d.deptype = 'n'
     and not (d.classid = 'pg_class'::regclass  and d.objid = 'public.profiles'::regclass)
     and not (d.classid = 'pg_attrdef'::regclass);
  if n_deps > 0 then
    raise exception 'role enum to text: % object(s) besides profiles.role and its default still depend on public.user_role', n_deps;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. The view that selects the column has to go first.
-- ---------------------------------------------------------------------------
drop view if exists public.sync_fleet;

-- ---------------------------------------------------------------------------
-- 2. The column: text, checked, defaulting to viewer (0006 set the default;
--    it is re-set here because the old default is typed on the enum).
-- ---------------------------------------------------------------------------
alter table public.profiles
  alter column role drop default,
  alter column role type text using role::text,
  alter column role set default 'viewer',
  add constraint profiles_role_check
    check (role in ('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent'));

-- ---------------------------------------------------------------------------
-- 3. The type.
-- ---------------------------------------------------------------------------
drop type public.user_role;

-- ---------------------------------------------------------------------------
-- 4. sync_fleet, recreated verbatim from 0006 (body unchanged; the column is
--    text now, so the casts are no-ops). Owner, comment and grants restated:
--    the baseline granted the view to service_role only, and a recreated
--    relation would otherwise pick up the default grants to anon and
--    authenticated.
-- ---------------------------------------------------------------------------
CREATE VIEW "public"."sync_fleet" AS
 SELECT "u"."email",
    ("p"."role")::"text" AS "role",
    "c"."build",
    "c"."last_seen",
    "c"."calls",
        CASE
            WHEN (("p"."role")::"text" = ANY (ARRAY['viewer'::"text", 'agent'::"text"])) THEN 'n/a (service account)'::"text"
            WHEN ("c"."user_id" IS NULL) THEN 'never synced through the RPC'::"text"
            WHEN ("c"."last_seen" < ("now"() - '3 days'::interval)) THEN 'quiet 3+ days'::"text"
            ELSE 'ok'::"text"
        END AS "status"
   FROM (("public"."profiles" "p"
     JOIN "auth"."users" "u" ON (("u"."id" = "p"."id")))
     LEFT JOIN "public"."sync_clients" "c" ON (("c"."user_id" = "p"."id")))
  ORDER BY ("c"."last_seen" IS NULL) DESC, "c"."last_seen" DESC NULLS LAST;

ALTER VIEW "public"."sync_fleet" OWNER TO "postgres";
COMMENT ON VIEW "public"."sync_fleet" IS 'Roster vs. reality: who has synced through the RPCs, from which build, and who has not appeared at all. After migration 219, anyone flagged here is a device still on a pre-RPC build whose saves are being refused.';
revoke all on public.sync_fleet from public, anon, authenticated;
grant all on public.sync_fleet to service_role;

-- ---------------------------------------------------------------------------
-- 5. role_is(): the normalisation arm is gone; one membership test. Shape,
--    grants and comment as 0006 left them (grants survive CREATE OR REPLACE).
-- ---------------------------------------------------------------------------
create or replace function public.role_is(variadic p_roles text[]) returns boolean
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce((
    select p.role = any (p_roles)
      from public.profiles p
     where p.id = (select auth.uid())
  ), false);
$$;
comment on function public.role_is(variadic text[]) is
  'True when the caller''s profiles.role is one of the given names. The vocabulary is owner/office/crew_lead/crew/viewer/agent, enforced by profiles_role_check since 0012 (doc 09 §6).';

-- ---------------------------------------------------------------------------
-- 6. current_role_name(): same trim. The JWT claim still wins when present
--    (0004), else the profile's role as held.
-- ---------------------------------------------------------------------------
create or replace function public.current_role_name() returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''),
    (select p.role from public.profiles p where p.id = (select auth.uid()))
  );
$$;

-- ---------------------------------------------------------------------------
-- 7. Assertions. Structural, so they bind on the CI replay too.
-- ---------------------------------------------------------------------------
do $$
declare
  d text;
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'public' and t.typname = 'user_role') then
    raise exception 'role enum to text: public.user_role still exists';
  end if;
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.profiles'::regclass and a.attname = 'role') <> 'text' then
    raise exception 'role enum to text: profiles.role is not text';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.profiles'::regclass
                    and conname = 'profiles_role_check' and contype = 'c') then
    raise exception 'role enum to text: profiles_role_check is missing';
  end if;
  if (select pg_get_expr(ad.adbin, ad.adrelid) from pg_attrdef ad
        join pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
       where ad.adrelid = 'public.profiles'::regclass and a.attname = 'role') !~ '''viewer''' then
    raise exception 'role enum to text: profiles.role default is not viewer';
  end if;
  if not exists (select 1 from pg_views where schemaname = 'public' and viewname = 'sync_fleet') then
    raise exception 'role enum to text: sync_fleet was not recreated';
  end if;
  if has_table_privilege('anon', 'public.sync_fleet', 'select')
     or has_table_privilege('authenticated', 'public.sync_fleet', 'select') then
    raise exception 'role enum to text: sync_fleet picked up a default grant to anon or authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.sync_fleet', 'select') then
    raise exception 'role enum to text: service_role lost its grant on sync_fleet';
  end if;
  d := pg_get_functiondef('public.role_is(text[])'::regprocedure);
  if d ~ '''admin''' or d ~ '''tech''' then
    raise exception 'role enum to text: role_is() still carries the old-name arm';
  end if;
  d := pg_get_functiondef('public.current_role_name()'::regprocedure);
  if d ~ '''admin''' or d ~ '''tech''' then
    raise exception 'role enum to text: current_role_name() still carries the old-name arm';
  end if;
  if has_function_privilege('anon', 'public.role_is(text[])', 'execute')
     or has_function_privilege('anon', 'public.current_role_name()', 'execute') then
    raise exception 'role enum to text: anon can execute role_is() or current_role_name()';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '_sync_guard'
       and pg_get_function_identity_arguments(p.oid) = 'p_build text'
  ) then
    raise exception 'role enum to text: push_project can no longer resolve _sync_guard(p_build text)';
  end if;
end
$$;
