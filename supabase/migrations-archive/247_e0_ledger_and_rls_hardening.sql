-- ============================================================
-- 247: E0 — ledgers become append-only for clients, payroll hours
--      stop being deletable, the zombie proposals get swept, and
--      automation gets a health surface.
-- ------------------------------------------------------------
-- WHY (findings.json F-004, Critical; F-005, Critical — roadmap
-- docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md §7.2):
--
--   F-004  ai_usage (201:77-79) and capture_events (200:235-237) are
--          `for all to authenticated using (true)`, and time_entries
--          (102:32-34) is the same. The apps sign in with real logins
--          (216) and hold the publishable key, which is served on the
--          public site — so ANY crew login can DELETE the month's AI
--          cost ledger, the AI audit trail, or payroll hours over
--          plain PostgREST. Those three tables are evidence: the AI
--          ledger is what the spend cap sums, capture_events is the
--          "AI proposed / human confirmed" record, and time_entries is
--          claim documentation. Evidence tables are append-only to the
--          people they describe.
--
--   F-005  Gmail died 2026-09-01 and QB Time ~2026-09-04 while
--          cron.job_run_details reported both "succeeded" (net.http_post
--          is asynchronous) and the admin cards showed "● Connected"
--          (getStatus is a row-exists check). Nothing in the database
--          could answer "which lane is dead right now". integration_runs
--          + integration_health below is that surface.
--
-- Plus the one-time pending_actions sweep (§7.2 "Sweep the zombie
-- proposals"): three boardEdit rows have been 'pending' since
-- 2026-07-25 and count forever against MAX_LIVE_PROPOSALS = 3.
--
-- WHAT IS PRESERVED. Every legitimate caller keeps working:
--   * the field/admin/board apps read both ledgers and insert into them
--     through the edge functions, which forward the caller's JWT
--     (roybal-ai-ingest, roybal-ai-narrative, roybal-ai-office) — the
--     insert and select policies below are exactly those paths;
--   * the browser assistant stamps capture_events.result.executed
--     (apps/field/js/assist.js:211-223) and the three ai-* functions
--     patch status/processed_at/result/transcript/raw_payload/error;
--     the Fly phone agent — which runs on a MACHINE LOGIN, not the
--     service key (services/phone-agent/supa.mjs:1-9) — patches those
--     plus contact_id (server.mjs:175-181, tools.mjs:127). A COLUMN-
--     LEVEL grant keeps exactly that set writable and nothing else;
--   * the crons and every server lane (gmail-proxy, qbo-proxy,
--     qb-time-proxy, roybal-brief, roybal-portal) use the SERVICE ROLE,
--     which BYPASSES RLS and is never revoked here, so nothing granted
--     below is needed for them and nothing revoked below reaches them.
--     That is why no service_role grant appears in this file.
--
-- SAFE + ADDITIVE + IDEMPOTENT: one new table, one new view, four
-- policy sets, three privilege changes, one data sweep. No column of
-- any existing table is altered or dropped. Re-running is a no-op
-- (the sweep matches zero rows the second time).
--
-- Apply + rollback: see the bottom of this file.
-- ============================================================


-- ============================================================
-- 1. ai_usage — INSERT + SELECT only for `authenticated`
-- ------------------------------------------------------------
-- The cost ledger IS the spend cap: every AI lane sums this month's
-- cost_usd before spending (roybal-ai-ingest:349, roybal-ai-office:117,
-- roybal-ai-narrative:70, qb-time-proxy:306, phone-agent supa.mjs:82).
-- A row deleted here is a dollar the cap forgets, silently. Reads and
-- inserts stay open because the cap check and the ledger write both run
-- under the caller's JWT; UPDATE and DELETE have no caller at all —
-- grep of apps/, supabase/functions/ and services/ finds ai_usage only
-- in select and insert positions.
-- ============================================================
drop policy if exists ai_usage_all    on public.ai_usage;
drop policy if exists ai_usage_read   on public.ai_usage;
drop policy if exists ai_usage_insert on public.ai_usage;

create policy ai_usage_read on public.ai_usage
  for select to authenticated using (true);

create policy ai_usage_insert on public.ai_usage
  for insert to authenticated with check (true);

-- Privileges are checked BEFORE RLS, so the revoke is the real lock;
-- the policy set above is the second wall. anon is included for
-- completeness — the publishable key is in git (apps/field/js/config.js:8).
revoke update, delete, truncate on public.ai_usage from anon, authenticated;
grant  select, insert            on public.ai_usage to   authenticated;

comment on table public.ai_usage is
  'AI cost ledger (201). Append-only to clients since 247: authenticated may SELECT (the cap sum) and INSERT (the ledger row); UPDATE/DELETE are revoked. service_role bypasses RLS and retains full access.';


-- ============================================================
-- 2. capture_events — INSERT + SELECT, and a NARROW UPDATE
-- ------------------------------------------------------------
-- capture_events is the audit trail: one envelope per AI input, written
-- BEFORE any paid call, then patched with what came back. Deleting a row
-- erases the record that an AI proposal was ever made — so DELETE goes.
--
-- UPDATE cannot go yet, and this is DEBT, not a design: five live
-- callers patch the envelope on the CALLER'S JWT (not the service key):
--   apps/field/js/assist.js:211-223   result.executed (what the human ran)
--   roybal-ai-ingest/index.ts:519,528 transcript, result, status,
--                                     processed_at, raw_payload, error
--   roybal-ai-narrative/index.ts:96,123,136  status, processed_at, result, error
--   roybal-ai-office/index.ts:1780,1797,1839 same set
--   services/phone-agent (machine login, NOT service role):
--     server.mjs:175-181 status/processed_at/result; tools.mjs:127 contact_id
-- So UPDATE is scoped by COLUMN GRANT to exactly those seven columns —
-- id, unified_job_id, phase_instance_id, source_type, form_key,
-- captured_by, captured_at, created_at and updated_at are NOT writable,
-- which means a client can annotate an envelope but can never re-point
-- it at another job or re-attribute who captured it.
--
-- P1 REMOVES THIS: when execution moves server-side (§7.3), the stamp is
-- written by the worker on the service role and this grant is revoked in
-- full. Until then the column list is the boundary — do not widen it.
-- ============================================================
drop policy if exists capture_events_all    on public.capture_events;
drop policy if exists capture_events_read   on public.capture_events;
drop policy if exists capture_events_insert on public.capture_events;
drop policy if exists capture_events_update on public.capture_events;

create policy capture_events_read on public.capture_events
  for select to authenticated using (true);

create policy capture_events_insert on public.capture_events
  for insert to authenticated with check (true);

-- The row filter stays open; the COLUMN GRANT below is what narrows this.
create policy capture_events_update on public.capture_events
  for update to authenticated using (true) with check (true);

revoke update, delete, truncate on public.capture_events from anon, authenticated;
grant  select, insert            on public.capture_events to   authenticated;
grant  update (status, processed_at, result, transcript, raw_payload, error, contact_id)
                                 on public.capture_events to   authenticated;

comment on table public.capture_events is
  'AI audit trail (200). Since 247: authenticated may SELECT/INSERT and UPDATE only (status, processed_at, result, transcript, raw_payload, error, contact_id) — the result-stamp path (assist.js, the three ai-* functions, the phone agent). DELETE revoked. The narrow UPDATE is P1 debt: it goes when execution moves server-side.';


-- ============================================================
-- 3. time_entries — no DELETE for `authenticated`
-- ------------------------------------------------------------
-- Payroll hours are claim documentation and the basis of the labor
-- numbers in the GL audit. Nothing in the tree deletes them: the QB Time
-- proxy SOFT-deletes on the service role (qb-time-proxy/index.ts:633,
-- `update({deleted: true})`), and every app reads with `deleted=eq.false`
-- (apps/board/js/data.js, apps/admin/js/analytics.js, field qbtime.js /
-- myweek.js / calibration.js). INSERT/UPDATE/SELECT are untouched, so the
-- board's manual-hours editor (merge-duplicates upsert) still saves.
--
-- The permissive `for all` policy is replaced by three explicit policies
-- rather than left standing, so that a future re-grant of DELETE cannot
-- quietly re-open the hole through a policy nobody re-read. The
-- RESTRICTIVE deny policies from 205 (the brief machine user) subtract on
-- top of these and are unaffected.
-- ============================================================
drop policy if exists time_entries_all    on public.time_entries;
drop policy if exists time_entries_read   on public.time_entries;
drop policy if exists time_entries_insert on public.time_entries;
drop policy if exists time_entries_update on public.time_entries;

create policy time_entries_read on public.time_entries
  for select to authenticated using (true);

create policy time_entries_insert on public.time_entries
  for insert to authenticated with check (true);

create policy time_entries_update on public.time_entries
  for update to authenticated using (true) with check (true);

revoke delete, truncate        on public.time_entries from anon, authenticated;
grant  select, insert, update  on public.time_entries to   authenticated;

comment on table public.time_entries is
  'Logged crew hours (102). Since 247 authenticated may SELECT/INSERT/UPDATE but not DELETE — the QB Time proxy soft-deletes with data.deleted on the service role, and hours are claim documentation.';


-- ============================================================
-- 4. ONE-TIME SWEEP — the zombie boardEdit proposals
-- ------------------------------------------------------------
-- qb-time-proxy counted live proposals with `.eq("status","pending")` and
-- NO expiry filter, against MAX_LIVE_PROPOSALS = 3. Three boardEdit rows
-- have been 'pending' since 2026-07-25 and expired 2026-07-26, so the
-- counter has read 3 every run since 2026-07-26 and the phase-suggestion
-- lane has proposed nothing for six weeks — silently, with no error
-- anywhere. (A row is 'pending' forever unless something acts on it:
-- expires_at is enforced on READ, migration 210, and never written back.)
--
-- THIS IS THE ONE-TIME SWEEP. It clears the jam that already exists. What
-- stops the NEXT one is the expiry filter now on that count —
-- `.gt("expires_at", now)` at qb-time-proxy/index.ts:615-620, same E0
-- change set — so run this AFTER (or with) that deploy, or three fresh
-- expiries re-jam the lane. The third half, a RECURRING sweep, is a P1
-- queue job (§7.3) — not a cron row here, because E0 adds no cron.
-- 'expired' is already a legal value of the status check (210:32-33).
-- ============================================================
update public.pending_actions
   set status = 'expired'
 where status = 'pending'
   and expires_at < now();


-- ============================================================
-- 5. integration_runs + integration_health — the surface that
--    would have shown Gmail and QB Time dead (F-005)
-- ------------------------------------------------------------
-- One row per adapter call — pull, push, refresh or webhook — so a lane
-- that fails leaves a record whether or not anyone reads the HTTP
-- response. This is the P1 shape (§2.6) landed early because the E0
-- alert needs something to read; the only simplification is that
-- `connection` is text ('gmail' | 'qb_time' | 'qbo' | ...) instead of a
-- FK into the `connections` table P1 introduces. When `connections`
-- lands, connection_id replaces this column and the view is rewritten —
-- expected, and cheap while the table is small.
--
-- WRITERS: service role only. Every lane that would write here already
-- runs on the service key (gmail-proxy:81, qbo-proxy:69, qb-time-proxy),
-- so no insert policy and no client grant is needed — and a client that
-- could write its own health rows could also lie about them.
-- ============================================================
create table if not exists public.integration_runs (
  id            bigint generated always as identity primary key,
  connection    text        not null,               -- 'gmail' | 'qb_time' | 'qbo' | 'twilio' | ...
  kind          text        not null check (kind in ('pull', 'push', 'refresh', 'webhook')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,                        -- null = still in flight
  ok            boolean,                            -- null until it finishes
  error         text,
  rows_affected int,
  external_ref  text,                               -- provider-side id (message id, realm, batch)
  created_at    timestamptz not null default now()
);

-- The health query is always "this lane, newest first".
create index if not exists integration_runs_conn_started_idx
  on public.integration_runs (connection, started_at desc);

alter table public.integration_runs enable row level security;

drop policy if exists integration_runs_read on public.integration_runs;
create policy integration_runs_read on public.integration_runs
  for select to authenticated using (true);

revoke insert, update, delete, truncate on public.integration_runs from anon, authenticated;
grant  select on public.integration_runs to authenticated;

-- the identity sequence too, by lookup rather than by name: an identity
-- column's sequence is normally integration_runs_id_seq, but a wrong guess
-- here would abort the whole migration on a statement that protects nothing
-- a client can reach anyway.
do $$
declare s text := pg_get_serial_sequence('public.integration_runs', 'id');
begin
  if s is not null then
    execute format('revoke all on sequence %s from anon, authenticated', s);
  end if;
end $$;

comment on table public.integration_runs is
  'One row per integration adapter call (247, F-005). Written by the service role only; authenticated may read. P1 replaces `connection` text with connection_id -> connections(id) (roadmap §2.6).';

-- ------------------------------------------------------------
-- integration_health — per lane: last_ok_at, last_error,
-- consecutive_failures, and the token expiry.
--
-- DELIBERATELY NOT security_invoker. A normal (definer-semantics) view
-- runs as its owner, so it can read the three token tables whose RLS
-- denies `authenticated` outright (qbo_tokens 104:24-29, gmail_tokens
-- 208:27-31, qb_time_tokens 003 admin-only). With security_invoker the
-- view would return nothing to the admin app and be useless. What
-- crosses that boundary is ONLY the expiry timestamp and the account
-- label already shown on the admin card (apps/admin/js/gmailconnect.js:75)
-- — never access_token or refresh_token, which are not selected here and
-- must never be added. Supabase's linter flags owner-run views; this one
-- is intentional and this comment is the record of why.
--
-- WHY THE TOKEN CLOCK IS READ THE WAY IT IS. expires_at on all three
-- tables is the ACCESS token expiry (about an hour), refreshed on every
-- successful call — so `expires_at < now()` is NORMAL and would cry wolf
-- constantly. What actually happened on 09-01 and 09-04 is that refresh
-- FAILED and expires_at stopped advancing: gmail_tokens froze at
-- 2026-09-01 04:15Z, qb_time_tokens at 2026-09-04 19:38Z. So the signal
-- is "the clock stopped", and the threshold is 25 hours — comfortably
-- past the slowest lane that still refreshes on a schedule (the nightly
-- qbo payment pull, 14:30Z daily), which a 6-hour threshold would have
-- falsely condemned every morning.
-- ------------------------------------------------------------
create or replace view public.integration_health as
with tok as (
  -- newest token row per lane — the same "latest row wins" rule the
  -- proxies use today (gmail-proxy:110-111, qbo-proxy:76-77)
  select distinct on (connection) connection, account, token_expires_at
  from (
    select 'gmail'::text as connection, g.account   as account,
           g.expires_at  as token_expires_at, g.updated_at as updated_at
      from public.gmail_tokens g
    union all
    select 'qb_time', q.realm_id, q.expires_at, q.updated_at
      from public.qb_time_tokens q
    union all
    select 'qbo', o.realm_id, o.expires_at, o.updated_at
      from public.qbo_tokens o
  ) t
  order by connection, updated_at desc
),
lanes as (
  -- every lane that has a token, has a run, or is expected to exist —
  -- so a lane whose token row was deleted still reports, instead of
  -- vanishing from the health board exactly when it broke
  select connection from tok
  union
  select connection from public.integration_runs
  union
  select v.connection from (values ('gmail'::text), ('qb_time'), ('qbo')) as v(connection)
),
done as (
  -- finished runs only; an in-flight row (ok is null) is not evidence
  select r.connection, coalesce(r.finished_at, r.started_at) as at, r.ok, r.error
    from public.integration_runs r
   where r.ok is not null
),
last_ok as (
  select d.connection, max(d.at) as at from done d where d.ok group by d.connection
),
fails as (
  -- failures SINCE the last success = the consecutive-failure streak
  select d.connection, count(*) as n,
         (array_agg(d.error order by d.at desc))[1] as last_error
    from done d
    left join last_ok k on k.connection = d.connection
   where not d.ok
     and d.at > coalesce(k.at, '-infinity'::timestamptz)
   group by d.connection
)
select l.connection,
       t.account,
       t.token_expires_at,
       k.at                    as last_ok_at,
       f.last_error,
       coalesce(f.n, 0)::int   as consecutive_failures,
       case
         when t.token_expires_at is null                                then 'not_connected'
         when t.token_expires_at < now() - interval '25 hours'          then 'token_stale'
         when coalesce(f.n, 0) >= 3                                     then 'failing'
         when k.at is null                                              then 'no_runs_yet'
         else 'ok'
       end                     as status
  from lanes l
  left join tok     t on t.connection = l.connection
  left join last_ok k on k.connection = l.connection
  left join fails   f on f.connection = l.connection;

revoke all    on public.integration_health from anon;
grant  select on public.integration_health to   authenticated;

comment on view public.integration_health is
  'Per-lane automation health (247, F-005): last_ok_at, last_error, consecutive_failures and token expiry. status token_stale = the refresh loop stopped advancing expires_at for 25h+ (how Gmail 09-01 and QB Time 09-04 actually failed). Owner-run on purpose so it can read the token tables; it exposes expiry and account only, never a token.';


-- ============================================================
-- Verify (read-only, safe to run against production):
--
--   -- 1/2/3: the ledgers and hours are append-only to clients
--   select relname, polname, polcmd, polroles::regrole[]
--     from pg_policy p join pg_class c on c.oid = p.polrelid
--    where relname in ('ai_usage','capture_events','time_entries')
--    order by relname, polname;
--   select table_name, privilege_type from information_schema.table_privileges
--    where grantee = 'authenticated'
--      and table_name in ('ai_usage','capture_events','time_entries','integration_runs')
--    order by table_name, privilege_type;   -- no DELETE rows expected
--   select column_name from information_schema.column_privileges
--    where grantee = 'authenticated' and table_name = 'capture_events'
--      and privilege_type = 'UPDATE' order by column_name;  -- the seven columns
--
--   -- 4: the jam is cleared (roadmap §7.2 acceptance)
--   select count(*) from public.pending_actions
--    where status = 'pending' and expires_at < now();        -- expect 0
--
--   -- 5: the health board
--   select * from public.integration_health order by connection;
--   select connection, status, last_ok_at, last_error
--     from public.integration_health where status <> 'ok';
--
-- Then, from a TECH login (not the owner), these must affect 0 rows /
-- return 401-403 rather than succeeding:
--   curl -X DELETE "$URL/rest/v1/ai_usage?id=eq.<any>"      -H "apikey: $PUB" -H "Authorization: Bearer $TECH_JWT"
--   curl -X DELETE "$URL/rest/v1/time_entries?id=eq.<any>"  -H "apikey: $PUB" -H "Authorization: Bearer $TECH_JWT"
--   curl -X PATCH  "$URL/rest/v1/capture_events?id=eq.<any>" -d '{"captured_by":"someone else"}' ...
-- while a board hours save and an AI capture still succeed.
-- ============================================================


-- ============================================================
-- APPLY (owner's step — this file is NOT applied by the agent that
-- wrote it). Migrations reach production by hand today (22 headers say
-- "SQL Editor"); `supabase db push` against this directory is unsafe
-- until the P1 baseline lands, because 204/205 contain non-idempotent
-- `create policy` statements that would re-run and fail
-- (docs/architecture/00-SYSTEM-INVENTORY.md §6.8):
--
--   1. Supabase Dashboard -> SQL Editor -> paste this whole file -> Run.
--   2. Run the verify block above.
--   3. Record it so the journal and production agree:
--        supabase migration repair --status applied 247
--
-- ROLLBACK (paste as 248, or run as-is — it restores the exact
-- pre-247 state; the swept pending_actions rows are NOT un-swept,
-- deliberately: they were expired six weeks ago and un-expiring them
-- re-jams the proposal queue):
--
--   -- ai_usage / capture_events / time_entries back to `for all`
--   drop policy if exists ai_usage_read   on public.ai_usage;
--   drop policy if exists ai_usage_insert on public.ai_usage;
--   create policy ai_usage_all on public.ai_usage
--     for all to authenticated using (true) with check (true);
--   grant all on public.ai_usage to authenticated;
--
--   drop policy if exists capture_events_read   on public.capture_events;
--   drop policy if exists capture_events_insert on public.capture_events;
--   drop policy if exists capture_events_update on public.capture_events;
--   create policy capture_events_all on public.capture_events
--     for all to authenticated using (true) with check (true);
--   grant all on public.capture_events to authenticated;
--
--   drop policy if exists time_entries_read   on public.time_entries;
--   drop policy if exists time_entries_insert on public.time_entries;
--   drop policy if exists time_entries_update on public.time_entries;
--   create policy time_entries_all on public.time_entries
--     for all to authenticated using (true) with check (true);
--   grant all on public.time_entries to authenticated;
--
--   -- the health surface (drop the view first: it depends on the table)
--   drop view  if exists public.integration_health;
--   drop table if exists public.integration_runs;
--
-- Rolling back items 1-3 alone is enough to restore any broken caller;
-- item 5 is additive and breaks nothing if left in place.
-- ============================================================
