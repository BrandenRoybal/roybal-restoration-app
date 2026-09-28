-- ============================================================================
-- 0011 — xact_ref_prices / xact_ref_lines: the owner's own past Xactimate
--        estimates, kept as a private pricing REFERENCE
--
-- Owner decision, 2026-09-28 (project thread): use what his past Xactimate
-- estimates show to teach the estimate engine, and keep their prices as a
-- reference even where Roybal prices from its own list. He was told about the
-- Verisk EULA risk (docs/architecture/04 C9, 03 ADR-12) and chose this. Every
-- choice below keeps the data private, owner/office-only, flagged, and
-- removable in one statement.
--
-- REFERENCE ONLY. price_list stays the pricing basis and stays frozen. The
-- estimate engine (roybal-ai-office) falls back to a row here only when
-- price_list has no row for the line, only for piecework claim work — never
-- construction, never T&M — and stamps the line priced='reference' so it is
-- flagged for review. A reference price never reaches a customer surface:
-- not the PDF, not the portal, not QuickBooks.
--
-- WHO WRITES IT: only xact_ref_reload(), and only the owner. It is called by
-- tools/xact-ref/load.mjs, run by hand with a JSON file that lives outside
-- this repository. Each call replaces both tables whole: delete every row,
-- insert the file. There is no incremental write and no other door.
--
-- WHO READS IT: only xact_ref_prices_for(), under the caller's own JWT (the
-- estimate paths in roybal-ai-office). Owner and office get rows; every other
-- caller — crew, viewer, agent, a service-role call with no user — gets zero
-- rows, not an error, so the engine degrades to "no reference" rather than
-- failing. Nobody reads the tables directly: RLS is on, there are no
-- policies, and anon and authenticated hold no privilege on either table.
-- xact_ref_lines has no reader yet; it is the evidence behind each price row
-- (which estimates, which rooms, which quantities), kept for later mining.
--
-- NO ROWS IN THE REPO. The repository is public. This migration creates two
-- empty tables and two functions; the data is loaded out of band and never
-- committed. Test fixtures (supabase/test/xact_reference.test.sql) use
-- invented codes and prices only.
--
-- Additive. THE KILL SWITCH is dropping the tables:
--   drop table if exists public.xact_ref_prices, public.xact_ref_lines cascade;
--   drop function if exists public.xact_ref_reload(jsonb, jsonb);
-- (cascade takes xact_ref_prices_for with it: it returns the table's row
-- type.) The engine treats a failed or missing RPC as "no reference rows" and
-- prices exactly as it did before this file.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. One row per (category, code, activity, unit) seen across the past
--    estimates, with the spread of unit prices it was billed at.
--    activity is 'Replace' | 'Remove' | 'R&R' | 'D&R' | 'Reset' |
--    'Material only' | 'Labor only' | '' (not recorded on the estimate).
-- ---------------------------------------------------------------------------
create table if not exists public.xact_ref_prices (
  category           text not null,
  code               text not null,
  activity           text not null default '',
  unit               text not null default '',
  description        text,
  n_lines            int,             -- estimate lines behind this row
  n_estimates        int,             -- distinct estimates behind this row
  median             numeric(12,2),   -- unit price, all price lists
  min                numeric(12,2),
  max                numeric(12,2),
  latest_median      numeric(12,2),   -- unit price on the newest price list seen
  latest_price_list  text,
  price_lists        text[],
  job_types          text[],
  first_date         date,
  last_date          date,
  loaded_at          timestamptz default now(),
  primary key (category, code, activity, unit)
);

comment on table public.xact_ref_prices is
  'REFERENCE ONLY (0011): unit prices seen on the owner''s own past Xactimate estimates, one row per category/code/activity/unit. Written only by xact_ref_reload() (owner); read only through xact_ref_prices_for() (owner/office). A fallback for piecework claim lines when price_list has no row, stamped priced=reference for review; never construction, never T&M, never on a customer surface. Loaded out of band — no rows in the repo. Drop the table to switch it off.';


-- ---------------------------------------------------------------------------
-- 2. The estimate lines the price rows were built from.
-- ---------------------------------------------------------------------------
create table if not exists public.xact_ref_lines (
  id             uuid primary key default gen_random_uuid(),
  estimate_id    text not null,
  job_type       text,
  loss_type      text,
  est_date       date,
  room           text,
  line_no        int,
  category       text,
  code           text,
  description    text,
  activity       text,
  unit           text,
  qty            numeric,
  unit_cost      numeric(12,2),
  remove_price   numeric(12,2),
  replace_price  numeric(12,2),
  line_total     numeric(12,2),
  price_list     text,
  note           text,
  loaded_at      timestamptz default now()
);

comment on table public.xact_ref_lines is
  'REFERENCE ONLY (0011): the past Xactimate estimate lines behind xact_ref_prices. Written only by xact_ref_reload() (owner); no reader yet. Loaded out of band — no rows in the repo. Drop the table to switch it off.';

create index if not exists xact_ref_lines_category_code_idx
  on public.xact_ref_lines (category, code);


-- ---------------------------------------------------------------------------
-- 3. Lock both tables. The baseline's default privileges grant ALL on every
--    new table to anon and authenticated (0000_baseline.sql; 0008). Take it
--    all back and grant nothing: the two functions below are the only doors.
--    RLS on with no policy is the second lock — if a grant ever leaks back,
--    it still reads zero rows.
--
--    Owned by postgres so the SECURITY DEFINER functions (also postgres) own
--    what they read and write, whatever login role applied the migration.
-- ---------------------------------------------------------------------------
alter table public.xact_ref_prices owner to postgres;
alter table public.xact_ref_lines  owner to postgres;

alter table public.xact_ref_prices enable row level security;
alter table public.xact_ref_lines  enable row level security;

revoke all on public.xact_ref_prices from anon, authenticated;
revoke all on public.xact_ref_lines  from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The read door. Owner/office see every row (optionally only the given
--    categories); anyone else sees none. Zero rows rather than an error: the
--    engine calls this on every piecework estimate under the caller's JWT,
--    and a crew member's estimate must still price — from price_list alone.
--
--    role_is() rather than current_role_name(): a real user JWT carries
--    role = "authenticated" as a claim, which current_role_name() returns
--    before it reads profiles (the same reason 0010's policy uses it).
-- ---------------------------------------------------------------------------
create or replace function public.xact_ref_prices_for(p_categories text[] default null)
  returns setof public.xact_ref_prices
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select r.*
    from public.xact_ref_prices r
   where (select public.role_is('owner', 'office'))
     and (p_categories is null or r.category = any (p_categories))
   order by r.category, r.code, r.activity, r.unit;
$$;

alter function public.xact_ref_prices_for(text[]) owner to postgres;
comment on function public.xact_ref_prices_for(text[]) is
  'REFERENCE ONLY (0011): the owner''s past-Xactimate reference prices, optionally limited to the given categories. Returns rows only when the caller is owner or office (role_is); every other caller gets zero rows, never an error.';
-- Default privileges hand EXECUTE on every new function to anon directly as
-- well as through PUBLIC (0006). Revoke both.
revoke execute on function public.xact_ref_prices_for(text[]) from public, anon;
grant execute on function public.xact_ref_prices_for(text[]) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. The write door. Owner only. Replaces both tables with the two arrays,
--    in one transaction: a bad row anywhere rolls the whole reload back and
--    leaves the previous load in place.
--
--    `where true` on the deletes: production loads pg-safeupdate for
--    PostgREST sessions, which refuses a DELETE with no WHERE clause.
--
--    Dates arrive as text and '' means none; the PK columns activity and unit
--    are never null ('' = not recorded). loaded_at and id take their
--    defaults.
-- ---------------------------------------------------------------------------
create or replace function public.xact_ref_reload(p_prices jsonb, p_lines jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_prices int;
  v_lines  int;
begin
  if not public.role_is('owner') then
    raise exception 'only the owner can load the Xactimate reference'
      using errcode = 'insufficient_privilege';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array'
     or p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'xact_ref_reload takes two JSON arrays: p_prices and p_lines'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from public.xact_ref_lines  where true;
  delete from public.xact_ref_prices where true;

  insert into public.xact_ref_prices
    (category, code, activity, unit, description, n_lines, n_estimates,
     median, min, max, latest_median, latest_price_list, price_lists, job_types,
     first_date, last_date)
  select r.category, r.code, coalesce(r.activity, ''), coalesce(r.unit, ''),
         r.description, r.n_lines, r.n_estimates,
         r.median, r.min, r.max, r.latest_median, r.latest_price_list,
         r.price_lists, r.job_types,
         nullif(r.first_date, '')::date, nullif(r.last_date, '')::date
    from jsonb_to_recordset(p_prices) as r(
           category text, code text, activity text, unit text, description text,
           n_lines int, n_estimates int,
           median numeric, min numeric, max numeric, latest_median numeric,
           latest_price_list text, price_lists text[], job_types text[],
           first_date text, last_date text);
  get diagnostics v_prices = row_count;

  insert into public.xact_ref_lines
    (estimate_id, job_type, loss_type, est_date, room, line_no, category, code,
     description, activity, unit, qty, unit_cost, remove_price, replace_price,
     line_total, price_list, note)
  select r.estimate_id, r.job_type, r.loss_type, nullif(r.est_date, '')::date,
         r.room, r.line_no, r.category, r.code, r.description, r.activity,
         r.unit, r.qty, r.unit_cost, r.remove_price, r.replace_price,
         r.line_total, r.price_list, r.note
    from jsonb_to_recordset(p_lines) as r(
           estimate_id text, job_type text, loss_type text, est_date text,
           room text, line_no int, category text, code text, description text,
           activity text, unit text, qty numeric, unit_cost numeric,
           remove_price numeric, replace_price numeric, line_total numeric,
           price_list text, note text);
  get diagnostics v_lines = row_count;

  return jsonb_build_object('prices', v_prices, 'lines', v_lines);
end
$$;

alter function public.xact_ref_reload(jsonb, jsonb) owner to postgres;
comment on function public.xact_ref_reload(jsonb, jsonb) is
  'REFERENCE ONLY (0011): owner-only. Replaces xact_ref_prices and xact_ref_lines whole with the two JSON arrays and returns {"prices": n, "lines": m}. Called by tools/xact-ref/load.mjs; raises insufficient_privilege (42501) for anyone but the owner.';
revoke execute on function public.xact_ref_reload(jsonb, jsonb) from public, anon;
grant execute on function public.xact_ref_reload(jsonb, jsonb) to authenticated;
