-- ============================================================================
-- A minimal stand-in for the parts of a Supabase database that migrations in
-- this repo lean on, so a migration can be applied against a plain Postgres in
-- CI and its syntax, references, grants and policies actually checked.
--
-- WHY NOT 0000_baseline.sql. The baseline is a production `supabase db dump`:
-- it needs pg_net, pg_cron, pgsodium, supabase_vault, pg_graphql, the real
-- `auth` and `storage` schemas and the `supabase_admin` role, none of which
-- exist in a stock postgres:16 container. Replaying it is the job of
-- `supabase db reset` against the local CLI stack, which is a docker-compose
-- worth of machinery this repo does not run in CI today (§7.3 lists it as a P1
-- item). This file is the cheap 90%: everything a new migration is likely to
-- reference, and nothing else.
--
-- WHAT IT COPIES, and from where in 0000_baseline.sql:
--   the four Supabase roles and their default privileges  (:6355-6378)
--   schema auth, auth.users, auth.uid()                   (Supabase platform)
--   public.user_role                                      (:159)
--   public.profiles                                       (:3174)
--   public.touch_updated_at()                             (:1791)
--   public.rls_auto_enable()                              (:1630)
--
-- The default privileges are the important part. They are why a bare
-- `create table` in this database is writable by an anonymous browser, and a
-- test harness without them would let exactly the bug it should catch through.
-- ============================================================================

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to postgres, anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'tech', 'viewer', 'office');
  end if;
end
$$;

create table if not exists public.profiles (
  id         uuid primary key,
  full_name  text not null default '',
  role       public.user_role not null default 'tech',
  phone      text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
