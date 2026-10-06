-- ============================================================================
-- 0018 — receipt return windows: how many days each store takes returns, and
-- the office's "nothing left over" answers (Job Receipts plan, phase 2).
--
-- WHAT IT IS FOR: the office Receipts page (apps/admin/js/receiptlibrary.js)
-- flags "Home Depot on 1192 Bemis Ct — window closes in 10 days, anything
-- left over to take back?" For that it needs each store's return window, set
-- once by the office, and a way to clear a flag ("Nothing left over") that a
-- crew phone holding an older copy of the job can never undo — so neither
-- lives in the job blob.
--
--   receipt_vendors         one row per store, keyed by the field app's
--                           vendorKey() ("home depot"). A key also covers
--                           longer keys that start with it as whole words
--                           ("home depot pro"); the client applies that rule
--                           (receiptlib.js windowFor). return_days 0 = the
--                           store takes no returns.
--   receipt_return_reviews  one row per (job, receipt) the office cleared.
--                           receipt_id is the receipt's id inside the job's
--                           receipts array (the same id job_receipts.id holds);
--                           no foreign key, because job_receipts is a
--                           projection that can lag a job.
--
-- RETURNS THEMSELVES are not here: a return is a credit element in the job's
-- receipts array (kind "return", negative amount), written by the office
-- page and synced like any receipt; 0015's job_receipts projects it as a
-- negative row with no change.
--
-- WHO: owner/office read (RLS); writes only through the two SECURITY DEFINER
-- doors below, which refuse anyone else with 42501 and stamp who and when —
-- the 0011 shape and the target architecture's write contract (docs/
-- architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md: writes through
-- operations, direct INSERT/UPDATE/DELETE revoked). No org_id, like 0015.
--
-- THE PHONE CHECK. A field app older than v202 (the build that shipped with
-- this migration) shows a credit as an ordinary receipt: retyping its total
-- or an AI re-read turns the refund into a cost, and its 🗑 deletes it for
-- good. So the office page logs no return until every crew phone that synced
-- in the last two weeks is on v202 or later. field_builds_behind() counts
-- the ones that aren't, from public.sync_clients (the build each person last
-- synced from, written by _sync_guard), for owner/office only — that table
-- and the sync_fleet view stay service-role only (0008). A count, no names.
--
-- Census: +2 tables, +2 policies, +2 primary keys, +3 functions, no triggers.
-- Roles: owner/office read and write; crew_lead, crew, agent, customer and
-- anon see nothing and write nothing.
--
-- Additive: dropping the three functions and the two tables restores the app
-- exactly as it was.
-- ============================================================================

create table if not exists public.receipt_vendors (
  vendor_key    text        primary key
                check (vendor_key ~ '^[a-z0-9]+( [a-z0-9]+)*$' and char_length(vendor_key) <= 120 and vendor_key <> 'unknown'),
  display_name  text        not null default '' check (char_length(display_name) <= 120),
  return_days   integer     not null check (return_days between 0 and 365),
  notes         text        not null default '' check (char_length(notes) <= 400),
  updated_at    timestamptz not null default now(),
  updated_by    uuid                                         -- auth.uid() of who set it
);

comment on table public.receipt_vendors is
  'Each store''s return window, set once by the office (Receipts → Return windows). vendor_key is the field app''s vendorKey() of the printed vendor and also covers longer keys that start with it as whole words. return_days 0 = takes no returns. Written only through receipt_vendor_set().';

create table if not exists public.receipt_return_reviews (
  job_id      uuid        not null,                          -- field_projects.id
  receipt_id  text        not null check (char_length(receipt_id) between 1 and 80),
  status      text        not null check (status in ('nothing_to_return')),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (job_id, receipt_id)
);

comment on table public.receipt_return_reviews is
  'The office''s answer to a return-window flag on one receipt (nothing_to_return = "Nothing left over"). Kept out of the job blob so a stale crew copy cannot undo it. Written only through receipt_return_review_set().';

alter table public.receipt_vendors owner to postgres;
alter table public.receipt_return_reviews owner to postgres;
alter table public.receipt_vendors enable row level security;
alter table public.receipt_return_reviews enable row level security;

-- The baseline's default privileges grant ALL on every new table to anon and
-- authenticated (0000_baseline.sql; 0008). Take it all back: anon holds
-- nothing, authenticated may SELECT (RLS narrows that to owner/office), and
-- every write goes through the doors below.
revoke all on public.receipt_vendors, public.receipt_return_reviews from public, anon, authenticated;
grant select on public.receipt_vendors, public.receipt_return_reviews to authenticated;
grant all on public.receipt_vendors, public.receipt_return_reviews to service_role;

-- Read: owner/office, with role_is() for the reason 0010 gives.
drop policy if exists receipt_vendors_read_office on public.receipt_vendors;
create policy receipt_vendors_read_office on public.receipt_vendors
  for select to authenticated
  using ((select public.role_is('owner', 'office')));

drop policy if exists receipt_return_reviews_read_office on public.receipt_return_reviews;
create policy receipt_return_reviews_read_office on public.receipt_return_reviews
  for select to authenticated
  using ((select public.role_is('owner', 'office')));


-- ---------------------------------------------------------------------------
-- receipt_vendor_set(key, days, display, notes): set a store's window, or
-- clear it with days null. Returns the rows written or removed (0 or 1).
-- ---------------------------------------------------------------------------
create or replace function public.receipt_vendor_set(
  p_key text, p_days integer, p_display text default '', p_notes text default ''
) returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare n int;
begin
  if not public.role_is('owner', 'office') then
    raise exception 'only the office can set return windows' using errcode = 'insufficient_privilege';
  end if;
  if p_days is null then
    delete from public.receipt_vendors where vendor_key = p_key;
    get diagnostics n = row_count;
    return n;
  end if;
  insert into public.receipt_vendors as v (vendor_key, display_name, return_days, notes, updated_at, updated_by)
  values (p_key, coalesce(p_display, ''), p_days, coalesce(p_notes, ''), now(), auth.uid())
  on conflict (vendor_key) do update
     set display_name = excluded.display_name,
         return_days  = excluded.return_days,
         notes        = excluded.notes,
         updated_at   = now(),
         updated_by   = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

alter function public.receipt_vendor_set(text, integer, text, text) owner to postgres;
comment on function public.receipt_vendor_set(text, integer, text, text) is
  'Office door for receipt_vendors: upsert a store''s return window (days 0..365, 0 = no returns), or delete it when days is null. Raises 42501 for anyone but owner/office.';
revoke all on function public.receipt_vendor_set(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.receipt_vendor_set(text, integer, text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- receipt_return_review_set(job, receipt ids, status): mark receipts cleared
-- (one call clears a whole job + store group), or un-clear them with status
-- null. Returns the rows written or removed.
-- ---------------------------------------------------------------------------
create or replace function public.receipt_return_review_set(
  p_job uuid, p_receipts text[], p_status text
) returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare n int;
begin
  if not public.role_is('owner', 'office') then
    raise exception 'only the office can clear return-window flags' using errcode = 'insufficient_privilege';
  end if;
  if p_job is null or p_receipts is null or cardinality(p_receipts) = 0 then
    return 0;
  end if;
  if cardinality(p_receipts) > 500 then
    raise exception 'at most 500 receipts per call' using errcode = 'invalid_parameter_value';
  end if;
  if p_status is null then
    delete from public.receipt_return_reviews where job_id = p_job and receipt_id = any (p_receipts);
    get diagnostics n = row_count;
    return n;
  end if;
  insert into public.receipt_return_reviews as r (job_id, receipt_id, status, updated_at, updated_by)
  select p_job, rid, p_status, now(), auth.uid()
    from (select distinct unnest(p_receipts) as rid) ids
  on conflict (job_id, receipt_id) do update
     set status = excluded.status, updated_at = now(), updated_by = auth.uid();
  get diagnostics n = row_count;
  return n;
end;
$$;

alter function public.receipt_return_review_set(uuid, text[], text) owner to postgres;
comment on function public.receipt_return_review_set(uuid, text[], text) is
  'Office door for receipt_return_reviews: mark receipts of one job reviewed (status nothing_to_return), or clear the marks when status is null. Raises 42501 for anyone but owner/office.';
revoke all on function public.receipt_return_review_set(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.receipt_return_review_set(uuid, text[], text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- field_builds_behind(min build): how many people who could sync a job
-- (owner, office, crew lead, crew) last synced, within the past 14 days, from
-- a field app build older than p_min_build ("v201" < 202). Builds with no
-- digits are not counted; nor is anyone not seen for 14 days (a phone back
-- from a long break updates itself on its first open with signal).
-- ---------------------------------------------------------------------------
create or replace function public.field_builds_behind(p_min_build integer)
returns integer
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare n int;
begin
  if not public.role_is('owner', 'office') then
    raise exception 'only the office can check field app versions' using errcode = 'insufficient_privilege';
  end if;
  select count(*) into n
    from public.sync_clients c
    join public.profiles p on p.id = c.user_id
   where p.role in ('owner', 'office', 'crew_lead', 'crew')
     and c.last_seen > now() - interval '14 days'
     and c.build ~ '[0-9]'
     and regexp_replace(c.build, '[^0-9]', '', 'g')::numeric < p_min_build;
  return n;
end;
$$;

alter function public.field_builds_behind(integer) owner to postgres;
comment on function public.field_builds_behind(integer) is
  'How many owner/office/crew_lead/crew logins synced in the last 14 days from a field app build older than p_min_build (sync_clients). The office Receipts page logs returns only at 0. Raises 42501 for anyone but owner/office.';
revoke all on function public.field_builds_behind(integer) from public, anon, authenticated;
grant execute on function public.field_builds_behind(integer) to authenticated, service_role;
