-- ============================================================================
-- 0023 — receipts.qbo_link: the nightly QuickBooks match tags each receipt's
--        expense to the job and attaches the photo, one owner approval per
--        job (receipts phase 3, v1).
--
-- WHAT IT IS FOR: a Home Depot charge on card 3176 reaches QuickBooks by bank
-- rule as an expense with no job tag and no photo, and today only someone
-- matching receipts by hand finds it and fixes it. The worker's new
-- receipts.qbo_match queue kind (services/worker lanes/receipts.mjs, matcher
-- lanes/qbomatch.mjs) matches every live receipt (job_receipts, 0015) to the
-- QuickBooks expense it belongs to each night. An expense that is already
-- complete is noted "In QuickBooks"; one that needs work becomes ONE card per
-- job listing each change, and approving the card queues one outbox row per
-- receipt that the worker's qbo adapter delivers through qbo-proxy. This file
-- is the database half:
--
--   agent:integrations          the machine principal the lane files as,
--                               seeded with a fixed id (0004 reserved the
--                               name for the lane that first runs under it)
--   job_qbo_links               which QuickBooks project a job's costs go to:
--                               set by the owner's picker, or by approving a
--                               card that suggested it
--   receipt_qbo_links           where each receipt stands with QuickBooks
--                               (in_qbo, unmatched, conflict, queued, done,
--                               failed), keyed by receipt id so a move
--                               between jobs keeps it; one QuickBooks
--                               expense is never claimed by two receipts
--   receipts.qbo_link@1         the catalog row: money, runtime sql, waits on
--                               the owner (the seeded money policy)
--   receipts_qbo_fingerprint    md5 of the card's receipts as job_receipts
--                               holds them (id, amount, date, photo, live):
--                               what the card was filed against. Internal
--   op_exec_receipts_qbo_link   the executor: under a per-job lock, re-checks
--                               the fingerprint, links the job when the card
--                               suggested a project, and writes one 'qbo'
--                               outbox row and one queued link row per
--                               receipt. Internal
--   receipts_qbo_link_file      the filing door the worker calls: stamps the
--                               fingerprint, the items hash and the offer
--                               number, files through op_propose as
--                               agent:integrations, offers an unanswered
--                               card again, and supersedes the job's older
--                               open card (service_role only)
--   receipt_qbo_links_note      the matcher's nightly write of the states
--                               that need no approval; never touches a
--                               receipt the approval path owns (service_role
--                               only)
--   job_qbo_link_set            the owner's picker door: link, change or
--                               unlink a job's QuickBooks project (owner and
--                               office, through authenticated)
--   outbox_qbo_link_result      AFTER UPDATE OF status on outbox: a 'qbo' row
--                               sent marks its receipt done, a dead one
--                               failed (with the error)
--   qbo_service_ping            select true, for service_role only: qbo-proxy
--                               calls it with a presented key to prove the
--                               key is the service role
--   agent:integrations may      the third agent_authority row: propose only,
--   propose receipts.qbo_link   with its agent_authority.granted event
--   receipts-qbo-match-nightly  pg_cron, 14:50 UTC (05:50/06:50 Alaska):
--                               enqueue receipts.qbo_match for the Alaska
--                               date, once per date (the key)
--
-- WHAT THIS CHANGES TODAY: nothing reaches QuickBooks until three things
-- happen, in this order: qbo-proxy and the worker carrying the new lane are
-- deployed (services/worker/README.md gives the order), the worker heartbeats
-- the 'qbo' channel (outbox_channel_ready('qbo'), the filing switch), and the
-- owner approves a card. From the first night after that, each job with a
-- receipt whose QuickBooks expense needs a tag or a photo gets one card in the
-- Approvals inbox, and the office Receipts page shows each receipt's
-- QuickBooks state from receipt_qbo_links. The cron row enqueues from the day
-- this is applied; until a worker claims receipts.qbo_match the row for each
-- date waits queued, harmlessly (0021 is in the same position). Entering
-- store-account invoices as new expenses (the 'create' change) is built but
-- off: it waits on app_settings 'receipts.qbo_store_accounts', which this file
-- does not set. receipts.qbo_match is a queue kind, not a catalog operation,
-- so nobody can propose it.
--
-- WHY AN OUTBOX ROW AND NOT THE EXECUTOR: a runtime 'worker' operation only
-- defers this same SQL body (the worker's proposal.execute handler calls
-- op_execute), so a write to QuickBooks cannot happen inside an approval. The
-- executor writes what op_exec_email_send writes, an outbox row, and the
-- worker delivers it. "executed" on a card therefore means queued; the
-- receipt's own state (done or failed, set by the trigger below) and the
-- outbox row are what say whether QuickBooks took it.
--
-- RUNTIME sql: approval runs the executor inline (0013 op_proposal_approve).
-- APPROVAL: the owner only (the money policy of 0004, ruling 2026-09-06; the
-- office's money approval is an explicit deny), in the inbox only: cards are
-- filed proposed_via 'agent', never 'cron', and roybal-notify skips
-- receipts.qbo_link in its spine reads (INBOX_ONLY_FILTER), so no text answers
-- one. An edited approval may only drop items, each kept item exactly as
-- filed.
--
-- EXACTLY ONCE: the approval is locked and idempotent and op_execute never
-- re-runs (0013). Each outbox row's key is the proposal's key plus the receipt
-- id, written ON CONFLICT DO NOTHING, and a receipt already queued or done for
-- the same expense is skipped. If any receipt on the card changed in
-- job_receipts since filing (amount, date, photo, left the job), the
-- fingerprint no longer matches and the run fails with nothing written. The
-- QuickBooks side is idempotent by itself (qbo-proxy completePurchase adopts
-- its own tag, its own "[r:<receipt id>]" attachment and its own create), so a
-- worker that dies mid-send retries safely. The key carries the fingerprint,
-- the items hash and an offer number, so the next night files a new state as a
-- new card, and the same state again (the next offer) only when its card
-- expired or was superseded with nobody answering it, or its approval failed
-- because the receipts or the job's link had moved since filing and they are
-- back as they were. The filing door also refuses to file when a receipt
-- changed between the worker's read and the filing.
--
-- NEVER A SECOND EXPENSE, NEVER AN OVERWRITTEN TAG: the unique index on
-- receipt_qbo_links lets one QuickBooks expense be claimed by one receipt
-- only, and qbo-proxy refuses (permanently) to tag an expense that carries a
-- tag already. The executor refuses a tag when the job was linked to another
-- project after the card was filed.
--
-- THE GRANT. The owner said "Start Phase 3" on 2026-10-07, which includes
-- agent:integrations proposing receipts.qbo_link. As in 0019 and 0021, the
-- agent_authority.grant operation does not exist yet, so this file writes that
-- one row and its event, and skips it when any such row has ever existed, so
-- re-applying the file never revives a grant the owner revoked.
--
-- WHO: the two tables are read by owner and office (RLS) and by the service
-- role, and written only by the doors below. The executor, the fingerprint and
-- the trigger function are callable by nobody (op_execute and the trigger run
-- them as postgres); the filing door, the note door and the ping by
-- service_role alone; the picker by authenticated, refusing anyone but owner
-- and office with 42501. Owner postgres throughout.
--
-- Census: +2 tables, +2 policies, +1 trigger, +2 primary keys, +7 functions;
-- views, enums and unique constraints unchanged (the one-expense-one-receipt
-- rule is a partial unique index, not a constraint). The agent, the catalog
-- row, the grant and the cron row are data.
-- Roles: owner and office gain read on job_qbo_links and receipt_qbo_links and
-- the picker (the owner approves receipts.qbo_link as he approves every money
-- operation); the service role gains the two doors, the ping and read on the
-- two tables; agent:integrations gains one propose grant; crew_lead, crew,
-- viewer, agent logins and anon read and write exactly what they did before.
--
-- PUSH ORDER: 0022_equipment_scan.sql (PR #271) goes to each database before
-- this file. db-push.yml runs `supabase db push` without --include-all, so a
-- database that has 0023 refuses a later 0022 ("Found local migration files
-- to be inserted before the last migration on remote database"). If this
-- file has to reach a database first, 0022 is renumbered after it instead;
-- --include-all is not the answer.
--
-- KILL SWITCH AND ROLLBACK: RECEIPTS_QBO=off on the worker makes every run
-- return {skipped: "off"} and stops serving the 'qbo' channel, so no outbox
-- row is delivered and the door files nothing (qbo_lane_off). To stop the
-- schedule, select cron.unschedule('receipts-qbo-match-nightly'). To stop
-- filing for good, revoke the grant (update agent_authority set revoked_at =
-- now() where agent_id = agent:integrations and operation =
-- 'receipts.qbo_link'; the row and its event stay, events is append-only): the
-- door then refuses with 42501 and the run records it. Open cards expire on
-- their own; setting the catalog row's deprecated_at makes them decline-only.
-- A queued outbox row nobody should deliver is cancelled by marking it dead
-- (its receipt then shows failed). Additive: dropping the trigger, the seven
-- functions and the two tables restores the schema exactly as it was. A tag
-- or attachment already written stays in QuickBooks, where the office can
-- edit it like any other.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. agent:integrations — the principal the lane files as.
--
-- A fixed id, as 0004 seeded the first six: the worker names it per queue
-- kind and the grant below has to be able to name it. It starts with no
-- agent_authority row; section 11 gives it the one the owner approved.
-- ---------------------------------------------------------------------------
insert into public.agents (id, name, kind, enabled, created_by_kind)
values ('5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10', 'agent:integrations', 'automation', true, 'system')
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. The two tables.
--
-- job_qbo_links: a job's QuickBooks project is a QBO Customer with Job = true;
-- its Id is what a line's CustomerRef carries. qbo_project_ref is a different
-- id space, the line-level ProjectRef QuickBooks shows on hand-tagged lines,
-- learned from those lines when known. No job has a link yet (2026-10-07).
--
-- receipt_qbo_links: one row per receipt the matcher has seen. Keyed by the
-- receipt id alone: ids are unique among live job_receipts rows, and a
-- receipt moved to another job keeps its id, so its QuickBooks state follows
-- it (a (job, id) key would be orphaned by the move). job_id is where it was
-- last seen. No foreign keys, for the reason 0018 gives: job_receipts is a
-- projection that can lag a job. A receipt id is at most 64 characters (the
-- field app's are UUIDs), the most qbo-proxy accepts in the "[r:<receipt
-- id>]" marker it names each attachment with.
-- ---------------------------------------------------------------------------
create table if not exists public.job_qbo_links (
  job_id           uuid        primary key,                  -- field_projects.id
  qbo_customer_id  text        not null check (qbo_customer_id ~ '^[0-9]{1,20}$'),
  qbo_project_ref  text        check (qbo_project_ref ~ '^[0-9]{1,20}$'),
  qbo_name         text        not null default '' check (char_length(qbo_name) <= 160),
  source           text        not null check (source in ('picked', 'suggested_tagged', 'suggested_qbtime')),
  set_by_kind      text        not null check (set_by_kind in ('human', 'agent', 'policy', 'integration', 'system')),
  set_by_id        uuid,
  set_at           timestamptz not null default now()
);

comment on table public.job_qbo_links is
  'Which QuickBooks project (a QBO Customer with Job = true) a job''s costs go to: qbo_customer_id is the CustomerRef a tagged expense line carries, qbo_project_ref the line-level ProjectRef when known, qbo_name the DisplayName at link time. source: picked (the office picker), suggested_tagged or suggested_qbtime (a receipts.qbo_link card the owner approved). Written only through job_qbo_link_set() and op_exec_receipts_qbo_link() (0023).';

create table if not exists public.receipt_qbo_links (
  receipt_id       text          primary key check (char_length(receipt_id) between 1 and 64),
  job_id           uuid          not null,                   -- field_projects.id the receipt was last seen on
  state            text          not null
                   check (state in ('in_qbo', 'unmatched', 'conflict', 'queued', 'done', 'failed')),
  qbo_txn_type     text          check (qbo_txn_type in ('Purchase')),
  qbo_txn_id       text          check (qbo_txn_id ~ '^[0-9]{1,20}$'),
  qbo_sync_token   text          check (qbo_sync_token ~ '^[0-9]{1,20}$'),
  qbo_customer_id  text          check (qbo_customer_id ~ '^[0-9]{1,20}$'),  -- the tag the expense carries or will carry
  amount           numeric(12,2),
  receipt_date     date,
  changes          text[]        not null default '{}' check (changes <@ array['tag', 'attach', 'create']::text[]),
  proposal_id      uuid,
  outbox_id        uuid,
  detail           jsonb         not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  first_seen_at    timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

comment on table public.receipt_qbo_links is
  'Where each receipt stands with QuickBooks: in_qbo (matched, nothing to change), unmatched (no expense found; detail.reason), conflict (found but not written; detail.reason), queued (approved, outbox row written), done (QuickBooks updated), failed (outbox row dead; detail.error). The matcher writes the first three through receipt_qbo_links_note(); the approval writes queued; the outbox_qbo_link_result trigger writes done and failed (0023).';
comment on column public.receipt_qbo_links.changes is
  'What the approved card asked QuickBooks for: tag (the job''s project on every line), attach (the receipt photo), create (a new expense, store-account entry; off until app_settings receipts.qbo_store_accounts is set).';

-- One QuickBooks expense is never claimed by two receipts. A partial index,
-- not a constraint: unmatched, conflict and failed rows claim nothing.
create unique index if not exists receipt_qbo_links_txn_key
  on public.receipt_qbo_links (qbo_txn_type, qbo_txn_id)
  where state in ('in_qbo', 'queued', 'done');
create index if not exists receipt_qbo_links_job_idx on public.receipt_qbo_links (job_id);

alter table public.job_qbo_links owner to postgres;
alter table public.receipt_qbo_links owner to postgres;
alter table public.job_qbo_links enable row level security;
alter table public.receipt_qbo_links enable row level security;

-- The baseline's default privileges grant ALL on every new table to anon,
-- authenticated and service_role (0000_baseline.sql; 0008). Take it all back:
-- anon holds nothing, authenticated and the service role may SELECT (RLS
-- narrows authenticated to owner/office; the worker reads both tables), and
-- every write goes through the doors below.
revoke all on public.job_qbo_links, public.receipt_qbo_links from public, anon, authenticated, service_role;
grant select on public.job_qbo_links, public.receipt_qbo_links to authenticated, service_role;

-- Read: owner/office, with role_is() for the reason 0010 gives.
drop policy if exists job_qbo_links_read_office on public.job_qbo_links;
create policy job_qbo_links_read_office on public.job_qbo_links
  for select to authenticated
  using ((select public.role_is('owner', 'office')));

drop policy if exists receipt_qbo_links_read_office on public.receipt_qbo_links;
create policy receipt_qbo_links_read_office on public.receipt_qbo_links
  for select to authenticated
  using ((select public.role_is('owner', 'office')));


-- ---------------------------------------------------------------------------
-- 3. The catalog row.
--
-- input_schema is the top-level subset op_validate_input checks (0013): it
-- never looks inside items[] or link, so the executor checks them itself.
-- link is not required, and the worker leaves it out (or sends null) when the
-- job already has a project: the subset cannot say "object or null".
-- receipts_fingerprint, items_hash and offer are required but never sent by
-- the worker: the door stamps all three (section 6). qbo_customer_id is ''
-- when no item tags. amount_field names the input total (Σ |amount| of the
-- items) the money policy would threshold against.
-- ---------------------------------------------------------------------------
insert into public.operation_catalog
  (name, version, action_type, description, input_schema, runtime, approval_default,
   amount_field, emits, idempotency_template, definition_sha)
select c.name, 1, 'money', c.description, c.input_schema::jsonb, 'sql', 'owner',
       'total_usd', array['receipts.qbo_link_queued'], c.idempotency_template,
       md5(c.name || '@1:' || c.input_schema::jsonb::text)
  from (values
    ('receipts.qbo_link',
     'Update QuickBooks for this job''s receipts. Execution queues one QuickBooks change per receipt: tag the matching expense to the job''s QuickBooks project and attach the receipt photo; it never edits a tag already set and it refuses if the receipts changed since the card was filed.',
     '{"type": "object", "additionalProperties": false,
       "required": ["job_id", "job_name", "receipts_fingerprint", "items_hash", "offer", "qbo_customer_id", "items", "total_usd", "matcher"],
       "properties": {
         "job_id":               {"type": "string", "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},
         "job_name":             {"type": "string", "maxLength": 160},
         "receipts_fingerprint": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
         "items_hash":           {"type": "string", "pattern": "^[0-9a-f]{32}$"},
         "offer":                {"type": "integer"},
         "qbo_customer_id":      {"type": "string", "pattern": "^([0-9]{1,20})?$"},
         "qbo_name":             {"type": "string", "maxLength": 160},
         "link":                 {"type": "object"},
         "items":                {"type": "array"},
         "total_usd":            {"type": "number"},
         "matcher":              {"type": "string", "maxLength": 40, "pattern": "^receipts\\.qbo_match@[0-9.]+$"}}}',
     'receipts.qbo_link:{job_id}:{receipts_fingerprint}:{items_hash}:{offer}')
  ) as c(name, description, input_schema, idempotency_template)
on conflict (name, version) do nothing;


-- ---------------------------------------------------------------------------
-- 4. receipts_qbo_fingerprint — what a receipts.qbo_link card was filed
--    against.
--
-- md5 of the job's job_receipts rows for the given receipt ids, ordered by id,
-- each {id, amount (as text), receipt_date, photo_ref, live}; an id with no
-- row on this job contributes {id, missing: true}. Retyping the total, moving
-- the date, retaking the photo, deleting the receipt or moving it to another
-- job all move it, so an approval never writes to QuickBooks for a receipt
-- the owner did not see. STABLE, not IMMUTABLE like 0021's fingerprint,
-- because it reads a table rather than a value it is handed. Only SQL computes
-- it: the door stamps it and the executor compares it under the job's lock.
-- ---------------------------------------------------------------------------
create or replace function public.receipts_qbo_fingerprint(p_job_id uuid, p_receipt_ids text[]) returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select md5(coalesce(jsonb_agg(x.j order by x.id collate "C"), '[]'::jsonb)::text)
    from (
      select i.id,
             coalesce(
               (select jsonb_build_object('id', r.id, 'amount', r.amount::text, 'receipt_date', r.receipt_date,
                                          'photo_ref', r.photo_ref, 'live', r.deleted_at is null)
                  from public.job_receipts r
                 where r.job_id = p_job_id and r.id = i.id),
               jsonb_build_object('id', i.id, 'missing', true)) as j
        from (select distinct u.id from unnest(coalesce(p_receipt_ids, '{}'::text[])) as u(id)
               where u.id is not null) i
    ) x;
$$;

alter function public.receipts_qbo_fingerprint(uuid, text[]) owner to postgres;
comment on function public.receipts_qbo_fingerprint(uuid, text[]) is
  'md5 hex of a job''s job_receipts rows for the given ids, ordered by id, each {id, amount::text, receipt_date, photo_ref, live} or {id, missing: true}: what a receipts.qbo_link card was filed against. STABLE (reads job_receipts). Internal: the filing door stamps it and op_exec_receipts_qbo_link compares it (0023).';
revoke all on function public.receipts_qbo_fingerprint(uuid, text[]) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. op_exec_receipts_qbo_link — the executor. Called only by op_execute
--    (0013), inside the owner's approval, as postgres.
--
-- Every item is checked here, because op_validate_input never looks inside
-- items[]. Content always comes from the proposal's own input: an edited
-- approval selects which of its items to keep (edited_params.items, each
-- exactly as filed) and can change nothing else.
--
-- The per-job advisory lock is the one the filing door and the note door
-- take, so a card is never approved while tonight's filing or noting for the
-- same job is half done, and two cards of one job never write the same
-- receipt at once. No lock_timeout, for the reason 0021 gives: a timeout is
-- an error op_execute catches, failing the card for good over a busy job,
-- while a statement cancel rolls the whole approval back and the card can be
-- approved again.
--
-- Per approved item: the receipt's link row becomes queued (with the proposal
-- and the expense), one outbox row on channel 'qbo' carries what qbo-proxy's
-- completePurchase needs, and the link row records that outbox row. A receipt
-- already queued or done for the same expense is skipped; one held for a
-- different expense, or an expense another receipt holds, fails the run.
--
-- result: {queued, skipped, outbox_ids}. Emits receipts.qbo_link_queued when
-- anything was queued, and job.qbo_linked when the card linked the job.
-- ---------------------------------------------------------------------------
create or replace function public.op_exec_receipts_qbo_link(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_in       jsonb := p_proposal.input;
  v_edit     jsonb := p_proposal.edited_params;
  v_job      uuid  := p_proposal.job_id;
  v_cust     text;
  v_items    jsonb;
  v_item     jsonb;
  v_i        bigint;
  v_rid      text;
  v_ids      text[] := '{}';
  v_ch       text[];
  v_ok       boolean;
  v_n        bigint;
  v_c        jsonb;
  v_link     jsonb;
  v_problems text[] := '{}';
  v_k        text;
  v_sel      jsonb;
  v_sel_ids  text[];
  v_gone     text;
  v_cur      public.job_qbo_links;
  v_row      public.receipt_qbo_links;
  v_txn      text;
  v_holder   text;
  v_payload  jsonb;
  v_base     text;
  v_outbox   uuid;
  v_outboxes uuid[] := '{}';
  v_queued   integer := 0;
  v_skipped  integer := 0;
  v_total    numeric := 0;
begin
  -- 1. the input, item by item, as receipts.qbo_match files it
  if v_job is null or lower(coalesce(v_in ->> 'job_id', '')) <> v_job::text then
    raise exception 'receipts.qbo_link: input job_id % is not the proposal''s job %', v_in ->> 'job_id', v_job;
  end if;
  v_cust := coalesce(v_in ->> 'qbo_customer_id', '');
  if jsonb_typeof(v_in -> 'qbo_customer_id') is distinct from 'string' or v_cust !~ '^([0-9]{1,20})?$' then
    raise exception 'receipts.qbo_link: qbo_customer_id must be a QuickBooks id or ''''';
  end if;
  v_items := v_in -> 'items';
  if coalesce(jsonb_array_length(case when jsonb_typeof(v_items) = 'array' then v_items end), 0)
     not between 1 and 50 then
    raise exception 'receipts.qbo_link: items must be an array of 1 to 50 items';
  end if;

  for v_item, v_i in select e, o from jsonb_array_elements(v_items) with ordinality as t(e, o) loop
    if jsonb_typeof(v_item) <> 'object' then
      v_problems := v_problems || format('item %s is not an object', v_i);
      continue;
    end if;
    v_rid := v_item ->> 'receipt_id';
    if jsonb_typeof(v_item -> 'receipt_id') is distinct from 'string' or length(v_rid) not between 1 and 64 then
      v_problems := v_problems || format('item %s has a bad receipt_id', v_i);
    elsif v_rid = any (v_ids) then
      v_problems := v_problems || format('receipt %s appears twice', v_rid);
    else
      v_ids := v_ids || v_rid;
    end if;

    v_ch := null;
    if jsonb_typeof(v_item -> 'changes') = 'array' then
      select array_agg(c #>> '{}' order by o), bool_and(jsonb_typeof(c) = 'string'), count(distinct c)
        into v_ch, v_ok, v_n
        from jsonb_array_elements(v_item -> 'changes') with ordinality as x(c, o);
    end if;
    if v_ch is null or not v_ok or v_n <> cardinality(v_ch)
       or not (v_ch <@ array['tag', 'attach', 'create']) or v_ch @> array['create', 'tag'] then
      v_problems := v_problems || format('item %s changes must be a list of tag, attach and create, without repeats (create tags its own line, so never with tag)', v_i);
      v_ch := '{}';
    end if;

    if jsonb_typeof(v_item -> 'qbo_txn_type') is distinct from 'string' or v_item ->> 'qbo_txn_type' <> 'Purchase' then
      v_problems := v_problems || format('item %s qbo_txn_type must be Purchase', v_i);
    end if;
    if 'create' = any (v_ch) then
      -- a new expense: no id or sync token yet, and the create block says what to enter
      if coalesce(v_item ->> 'qbo_txn_id', '') <> '' or coalesce(v_item ->> 'qbo_sync_token', '') <> '' then
        v_problems := v_problems || format('item %s creates an expense, so it names no qbo_txn_id or qbo_sync_token', v_i);
      end if;
      v_c := v_item -> 'create';
      if jsonb_typeof(v_c) is distinct from 'object' then
        v_problems := v_problems || format('item %s creates an expense but has no create object', v_i);
      else
        if coalesce(jsonb_typeof(v_c -> 'account_id'), '') <> 'string' or (v_c ->> 'account_id') !~ '^[0-9]{1,20}$'
           or coalesce(jsonb_typeof(v_c -> 'vendor_id'), '') <> 'string' or (v_c ->> 'vendor_id') !~ '^[0-9]{1,20}$'
           or coalesce(jsonb_typeof(v_c -> 'expense_account_id'), '') <> 'string' or (v_c ->> 'expense_account_id') !~ '^[0-9]{1,20}$' then
          v_problems := v_problems || format('item %s create needs account_id, vendor_id and expense_account_id as QuickBooks ids', v_i);
        end if;
        if coalesce(jsonb_typeof(v_c -> 'class_id'), 'null') not in ('string', 'null')
           or (v_c ->> 'class_id') !~ '^[0-9]{1,20}$' then
          v_problems := v_problems || format('item %s create class_id must be a QuickBooks id or null', v_i);
        end if;
        -- the receipt number's digits, as qbo-proxy looks the entry up and
        -- enters it (Sherwin's "8066-9" arrives as 80669). At least 5, the
        -- matcher's own floor for a number that identifies an invoice: qbo-proxy
        -- finds the bookkeeper's entry by this number's prefix, and a short
        -- one would start other invoices' numbers too
        if coalesce(jsonb_typeof(v_c -> 'doc_number'), '') <> 'string' or (v_c ->> 'doc_number') !~ '^[0-9]{5,21}$' then
          v_problems := v_problems || format('item %s create needs a doc_number of 5 to 21 digits', v_i);
        end if;
        if coalesce(jsonb_typeof(v_c -> 'credit'), '') <> 'boolean' then
          v_problems := v_problems || format('item %s create credit must be true or false', v_i);
        end if;
        if coalesce(jsonb_typeof(v_c -> 'payment_type'), 'null') <> 'null' and v_c -> 'payment_type' <> '"CreditCard"' then
          v_problems := v_problems || format('item %s create payment_type must be CreditCard', v_i);
        end if;
        if coalesce(jsonb_typeof(v_c -> 'txn_date'), 'null') not in ('string', 'null')
           or (v_c ->> 'txn_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          v_problems := v_problems || format('item %s create txn_date must be YYYY-MM-DD', v_i);
        end if;
        if (case when jsonb_typeof(v_c -> 'amount_abs') = 'number' then (v_c ->> 'amount_abs')::numeric <= 0
                 else true end) then
          v_problems := v_problems || format('item %s create amount_abs must be a number above 0', v_i);
        end if;
        if coalesce(jsonb_typeof(v_c -> 'memo'), 'null') not in ('string', 'null') or length(v_c ->> 'memo') > 4000 then
          v_problems := v_problems || format('item %s create memo must be text of at most 4000 characters', v_i);
        end if;
      end if;
    else
      if coalesce(jsonb_typeof(v_item -> 'qbo_txn_id'), '') <> 'string' or (v_item ->> 'qbo_txn_id') !~ '^[0-9]{1,20}$' then
        v_problems := v_problems || format('item %s qbo_txn_id must be a QuickBooks id', v_i);
      end if;
      if coalesce(jsonb_typeof(v_item -> 'qbo_sync_token'), '') <> 'string' or (v_item ->> 'qbo_sync_token') !~ '^[0-9]{1,20}$' then
        v_problems := v_problems || format('item %s qbo_sync_token must be digits', v_i);
      end if;
      if coalesce(jsonb_typeof(v_item -> 'create'), 'null') <> 'null' then
        v_problems := v_problems || format('item %s carries a create block without the create change', v_i);
      end if;
    end if;
    if (v_ch && array['tag', 'create']) and v_cust = '' then
      v_problems := v_problems || format('item %s tags the expense but the card names no QuickBooks project', v_i);
    end if;

    if coalesce(jsonb_typeof(v_item -> 'amount'), '') <> 'number' then
      v_problems := v_problems || format('item %s amount must be a number', v_i);
    end if;
    if coalesce(jsonb_typeof(v_item -> 'qbo_total'), 'null') not in ('number', 'null') then
      v_problems := v_problems || format('item %s qbo_total must be a number or null', v_i);
    end if;
    if coalesce(jsonb_typeof(v_item -> 'date'), 'null') not in ('string', 'null')
       or (v_item ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      v_problems := v_problems || format('item %s date must be YYYY-MM-DD', v_i);
    elsif v_item ->> 'date' is not null then
      begin
        perform (v_item ->> 'date')::date;
      exception when others then
        v_problems := v_problems || format('item %s date %s is not a calendar date', v_i, v_item ->> 'date');
      end;
    end if;
    if coalesce(jsonb_typeof(v_item -> 'project_ref'), 'null') not in ('string', 'null')
       or (v_item ->> 'project_ref') !~ '^[0-9]{1,20}$' then
      v_problems := v_problems || format('item %s project_ref must be a QuickBooks id or null', v_i);
    end if;
    if coalesce(jsonb_typeof(v_item -> 'photo_refs'), '') <> 'array'
       or jsonb_array_length(case when jsonb_typeof(v_item -> 'photo_refs') = 'array' then v_item -> 'photo_refs' end) > 4
       or exists (select 1
                    from jsonb_array_elements(case when jsonb_typeof(v_item -> 'photo_refs') = 'array'
                                                   then v_item -> 'photo_refs' else '[]'::jsonb end) p
                   where jsonb_typeof(p) <> 'string' or (p #>> '{}') !~ '^media:[0-9a-f]{64}:[0-9]+$') then
      v_problems := v_problems || format('item %s photo_refs must be a list of at most 4 media:<sha256>:<length> markers', v_i);
    elsif 'attach' = any (v_ch) and jsonb_array_length(v_item -> 'photo_refs') = 0 then
      -- qbo-proxy refuses an attach with no photo for good; refuse it here,
      -- before anything is queued
      v_problems := v_problems || format('item %s attaches the photo but names none in photo_refs', v_i);
    end if;
    foreach v_k in array array['vendor', 'receipt_no', 'qbo_doc_number', 'qbo_account_name', 'qbo_vendor_name'] loop
      if coalesce(jsonb_typeof(v_item -> v_k), 'null') not in ('string', 'null') or length(v_item ->> v_k) > 200 then
        v_problems := v_problems || format('item %s %s must be text of at most 200 characters', v_i, v_k);
      end if;
    end loop;
  end loop;

  -- the suggested link, when the card carries one
  v_link := v_in -> 'link';
  if coalesce(jsonb_typeof(v_link), 'null') not in ('object', 'null') then
    v_problems := v_problems || 'link must be an object or absent'::text;
  elsif jsonb_typeof(v_link) = 'object' then
    if coalesce(jsonb_typeof(v_link -> 'qbo_customer_id'), '') <> 'string'
       or (v_link ->> 'qbo_customer_id') !~ '^[0-9]{1,20}$' then
      v_problems := v_problems || 'link qbo_customer_id must be a QuickBooks id'::text;
    elsif v_cust <> '' and v_link ->> 'qbo_customer_id' <> v_cust then
      v_problems := v_problems || 'link names a different QuickBooks project than the card'::text;
    end if;
    if coalesce(jsonb_typeof(v_link -> 'source'), '') <> 'string'
       or (v_link ->> 'source') not in ('suggested_tagged', 'suggested_qbtime') then
      v_problems := v_problems || 'link source must be suggested_tagged or suggested_qbtime'::text;
    end if;
    if coalesce(jsonb_typeof(v_link -> 'qbo_project_ref'), 'null') not in ('string', 'null')
       or (v_link ->> 'qbo_project_ref') !~ '^[0-9]{1,20}$' then
      v_problems := v_problems || 'link qbo_project_ref must be a QuickBooks id or null'::text;
    end if;
    if coalesce(jsonb_typeof(v_link -> 'qbo_name'), 'null') not in ('string', 'null') then
      v_problems := v_problems || 'link qbo_name must be text'::text;
    end if;
  end if;

  if array_length(v_problems, 1) is not null then
    raise exception 'receipts.qbo_link: the card''s items are invalid: %', array_to_string(v_problems, '; ');
  end if;

  -- 2. which items to queue: op_execute hands over input || edited_params, so
  --    p_params.items is the owner's selection when he edited, else every
  --    item. An edit may drop items and nothing else.
  if v_edit is not null then
    for v_k in select jsonb_object_keys(v_edit) loop
      if v_k <> 'items' and (v_edit -> v_k) is distinct from (v_in -> v_k) then
        raise exception 'receipts.qbo_link: an approval may only drop items; it changed %', v_k;
      end if;
    end loop;
  end if;
  v_sel := p_params -> 'items';
  if jsonb_typeof(v_sel) is distinct from 'array' then
    raise exception 'receipts.qbo_link: the approved items are not a list';
  end if;
  if exists (select 1 from jsonb_array_elements(v_sel) s
              where not exists (select 1 from jsonb_array_elements(v_items) e where e = s))
     or (select count(distinct s ->> 'receipt_id') from jsonb_array_elements(v_sel) s) <> jsonb_array_length(v_sel) then
    raise exception 'receipts.qbo_link: an approval may only drop items; it named an item the card does not hold, or changed one';
  end if;
  if jsonb_array_length(v_sel) = 0 then
    raise exception 'receipts.qbo_link: the approval kept no items';
  end if;
  select array_agg(s ->> 'receipt_id') into v_sel_ids from jsonb_array_elements(v_sel) s;

  -- 3. the job, locked against tonight's filing and the job's other cards
  perform pg_advisory_xact_lock(hashtextextended('receipts.qbo_link:' || v_job::text, 0));

  -- 4. the receipts the owner saw are still the receipts on the job. These
  --    checks and the two link checks in 5 are the filing-time checks: the
  --    filing door offers such a card again when the same key comes back, and
  --    knows them by these words (its v_refiled), so they keep them.
  if public.receipts_qbo_fingerprint(v_job, v_ids) is distinct from v_in ->> 'receipts_fingerprint' then
    raise exception 'receipts.qbo_link: the receipts changed since this card was filed, so nothing was queued; tonight''s match files a fresh card if QuickBooks still needs the change';
  end if;
  select string_agg(i, ', ' order by i) into v_gone
    from unnest(v_sel_ids) i
   where not exists (select 1 from public.job_receipts r
                      where r.job_id = v_job and r.id = i and r.deleted_at is null);
  if v_gone is not null then
    raise exception 'receipts.qbo_link: receipt % is no longer on this job, so nothing was queued', v_gone;
  end if;

  -- 5. the link: a card that suggested a project links a job that has none
  --    (the owner's approval is the pick); a tag needs the job linked to the
  --    project the card names
  select * into v_cur from public.job_qbo_links where job_id = v_job for update;
  if jsonb_typeof(v_link) = 'object' and v_cur.job_id is null then
    insert into public.job_qbo_links
      (job_id, qbo_customer_id, qbo_project_ref, qbo_name, source, set_by_kind, set_by_id, set_at)
    values
      (v_job, v_link ->> 'qbo_customer_id', v_link ->> 'qbo_project_ref',
       left(coalesce(v_link ->> 'qbo_name', ''), 160), v_link ->> 'source',
       p_principal_kind, p_principal_id, now())
    returning * into v_cur;
    perform public.emit_event(
      'job.qbo_linked', p_proposal.operation, 'field_project', v_job, v_job, p_proposal.claim_id, p_proposal.id,
      jsonb_build_object('qbo_customer_id', v_cur.qbo_customer_id, 'qbo_project_ref', v_cur.qbo_project_ref,
                         'qbo_name', v_cur.qbo_name, 'source', v_cur.source, 'why', v_link ->> 'why'),
      'job.qbo_linked:' || p_proposal.id, p_principal_kind, p_principal_id);
  end if;
  if exists (select 1 from jsonb_array_elements(v_sel) s where (s -> 'changes') ?| array['tag', 'create']) then
    if v_cur.job_id is null then
      raise exception 'receipts.qbo_link: the job has no QuickBooks project link any more, so nothing was queued';
    end if;
    if v_cur.qbo_customer_id <> v_cust then
      raise exception 'receipts.qbo_link: job linked to a different QuickBooks project since filing (now %, the card says %), so nothing was queued',
        v_cur.qbo_customer_id, v_cust;
    end if;
  end if;

  -- 6. one queued link row and one outbox row per approved item, in card order
  for v_item in
    select e from jsonb_array_elements(v_items) with ordinality as t(e, o)
     where (e ->> 'receipt_id') = any (v_sel_ids)
     order by o
  loop
    v_rid := v_item ->> 'receipt_id';
    v_txn := nullif(v_item ->> 'qbo_txn_id', '');
    select array_agg(c) into v_ch from jsonb_array_elements_text(v_item -> 'changes') c;

    select * into v_row from public.receipt_qbo_links where receipt_id = v_rid for update;
    if v_row.receipt_id is not null and v_row.state in ('queued', 'done') then
      -- already on its way, or there, for this same expense: nothing to add
      if v_row.qbo_txn_type is not distinct from (v_item ->> 'qbo_txn_type')
         and (v_row.qbo_txn_id is not distinct from v_txn or (v_txn is null and 'create' = any (v_row.changes))) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      raise exception 'receipts.qbo_link: receipt % is already % with QuickBooks % %, so nothing was queued',
        v_rid, v_row.state, v_row.qbo_txn_type, coalesce(v_row.qbo_txn_id, '(new)');
    end if;
    if v_txn is not null then
      select l.receipt_id into v_holder
        from public.receipt_qbo_links l
       where l.qbo_txn_type = v_item ->> 'qbo_txn_type' and l.qbo_txn_id = v_txn
         and l.state in ('in_qbo', 'queued', 'done') and l.receipt_id <> v_rid
       limit 1;
      if v_holder is not null then
        raise exception 'receipts.qbo_link: QuickBooks % % is already matched to receipt %, so nothing was queued',
          v_item ->> 'qbo_txn_type', v_txn, v_holder;
      end if;
    end if;

    insert into public.receipt_qbo_links as l
      (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
       amount, receipt_date, changes, proposal_id, outbox_id, detail, updated_at)
    values
      (v_rid, v_job, 'queued', v_item ->> 'qbo_txn_type', v_txn, nullif(v_item ->> 'qbo_sync_token', ''),
       nullif(v_cust, ''), (v_item ->> 'amount')::numeric, (v_item ->> 'date')::date, v_ch, p_proposal.id, null,
       jsonb_strip_nulls(jsonb_build_object(
         'vendor', v_item ->> 'vendor', 'receipt_no', v_item ->> 'receipt_no',
         'qbo_doc_number', coalesce(v_item ->> 'qbo_doc_number', v_item #>> '{create,doc_number}'),
         'qbo_account_name', v_item ->> 'qbo_account_name', 'qbo_total', v_item -> 'qbo_total')),
       now())
    on conflict (receipt_id) do update
       set job_id          = excluded.job_id,
           state           = 'queued',
           qbo_txn_type    = excluded.qbo_txn_type,
           qbo_txn_id      = excluded.qbo_txn_id,
           qbo_sync_token  = excluded.qbo_sync_token,
           qbo_customer_id = excluded.qbo_customer_id,
           amount          = excluded.amount,
           receipt_date    = excluded.receipt_date,
           changes         = excluded.changes,
           proposal_id     = excluded.proposal_id,
           outbox_id       = null,
           detail          = excluded.detail,
           updated_at      = now();

    -- "Home Depot 2026-09-30 1303-00001-50615": the attachment's file name
    -- before " p1 [r:<receipt id>].jpg", without characters a file name or
    -- the adoption marker cannot carry
    v_base := left(btrim(regexp_replace(regexp_replace(
                concat_ws(' ', nullif(btrim(v_item ->> 'vendor'), ''), nullif(v_item ->> 'date', ''),
                          nullif(regexp_replace(btrim(coalesce(v_item ->> 'receipt_no', '')), '\s+', '-', 'g'), '')),
                '[\\/:*?"<>|\[\]]', '', 'g'), '\s+', ' ', 'g')), 80);
    v_payload := jsonb_build_object(
      'receipt_id',        v_rid,
      'job_id',            v_job,
      'proposal_id',       p_proposal.id,
      'qbo_txn_type',      v_item ->> 'qbo_txn_type',
      'qbo_txn_id',        coalesce(v_item ->> 'qbo_txn_id', ''),
      'expect_sync_token', coalesce(v_item ->> 'qbo_sync_token', ''),
      'expect_total',      v_item -> 'qbo_total',
      'changes',           v_item -> 'changes',
      'customer_id',       v_cust,
      'project_ref',       v_item -> 'project_ref',
      'photo_refs',        v_item -> 'photo_refs',
      'file_base',         coalesce(nullif(v_base, ''), 'Receipt'));
    if 'create' = any (v_ch) then
      v_payload := v_payload || jsonb_build_object('create', v_item -> 'create');
    end if;

    v_outbox := null;
    insert into public.outbox
      (channel, operation, payload, idempotency_key, principal_kind, principal_id, proposal_id, job_id)
    values
      ('qbo', p_proposal.operation, v_payload,
       'outbox:' || p_proposal.idempotency_key || ':' || v_rid, p_principal_kind, p_principal_id, p_proposal.id, v_job)
    on conflict (idempotency_key) do nothing
    returning id into v_outbox;
    if v_outbox is null then
      select id into v_outbox from public.outbox where idempotency_key = 'outbox:' || p_proposal.idempotency_key || ':' || v_rid;
    end if;

    update public.receipt_qbo_links set outbox_id = v_outbox where receipt_id = v_rid;
    v_outboxes := v_outboxes || v_outbox;
    v_queued := v_queued + 1;
    v_total := v_total + abs((v_item ->> 'amount')::numeric);
  end loop;

  -- 7. the fact
  if v_queued > 0 then
    perform public.emit_event(
      'receipts.qbo_link_queued', p_proposal.operation, 'field_project', v_job, v_job, p_proposal.claim_id, p_proposal.id,
      jsonb_build_object('count', v_queued, 'total_usd', round(v_total, 2)),
      'receipts.qbo_link_queued:' || p_proposal.id, p_principal_kind, p_principal_id);
  end if;

  return jsonb_build_object('queued', v_queued, 'skipped', v_skipped, 'outbox_ids', to_jsonb(v_outboxes));
end;
$$;

alter function public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid) is
  'Executor for receipts.qbo_link@1: under the job''s advisory lock, re-checks receipts_qbo_fingerprint (fails with nothing written when it moved), links the job when the card suggested a project and the job has none, refuses a tag when the job is linked to another project, then per approved item marks receipt_qbo_links queued and writes one outbox row on channel qbo (key outbox:<proposal key>:<receipt id>); emits receipts.qbo_link_queued. An edited approval may only drop items (0023).';
revoke all on function public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. receipts_qbo_link_file — the filing door the worker calls.
--
-- With items: checks the job exists and is not deleted, that the 'qbo' lane
-- is being served (a card nobody can deliver is not filed), and that every
-- item's receipt is still live on the job with the amount, date and photo
-- the worker read (the item's amount, date and read_photo_ref); stamps the
-- receipts fingerprint, the items hash (md5 of the items, the link and the
-- project id, in SQL's jsonb text) and the offer number; and files through
-- op_propose as agent:integrations (proposed_via 'agent', 14 days by
-- default). A new card supersedes the job's other open receipts.qbo_link
-- cards (result.superseded_by; its own supersedes_id names the newest). With
-- no items (an empty list, or a null input) it supersedes them with
-- result.superseded_reason nothing_to_do. Each superseded card gets a
-- proposal.superseded event.
--
-- THE OFFER, as 0021's: the door tries offer 0, 1, 2 … in turn. A free key is
-- filed. A key whose card expired or was superseded, so nobody answered it,
-- moves on to the next offer. So does a key whose approval failed on one of
-- the executor's four filing-time checks (the receipts changed since filing,
-- a receipt left the job, the job lost its link, or was linked to another
-- project): the same key coming back means the receipts and the link are as
-- they were at filing again (an edit undone, a receipt restored, the old
-- project picked again), so the change the owner approved can go through
-- now. A key whose card is still open returns it, unchanged. Any other
-- status (declined, approved, executing, executed, or failed on the items
-- themselves) stays quiet, because the owner already answered these items on
-- these receipts, or the same card would fail the same way again; the job's
-- other open cards are then superseded with superseded_reason items_changed.
-- After 50 offers (0–49) the card stays quiet the same way. The project id is
-- in the hash so that relinking the job files a fresh card instead of
-- returning one whose tag would now fail.
--
-- Superseding skips a card whose row is locked (SKIP LOCKED): that is an
-- approval in progress, which waits on this door's lock, so waiting for it
-- here would deadlock; the card is left to run, as 0021 leaves it.
--
-- Returns exactly one of
--   {filed: true,  proposal_id, status: "proposed", superseded: n}
--   {filed: false, proposal_id, status: "proposed", superseded: 0}   (still open)
--   {filed: false, proposal_id, status: <its status>, superseded: n} (quiet)
--   {skipped: "empty", superseded: n}                                (nothing to do)
--   {skipped: "job_missing" | "job_deleted" | "qbo_lane_off" | "receipts_moved"}
-- and raises on a malformed input, or 42501 from op_propose when
-- agent:integrations holds no live grant.
-- ---------------------------------------------------------------------------
create or replace function public.receipts_qbo_link_file(
  p_job_id        uuid,
  p_input         jsonb,
  p_rationale     text,
  p_evidence_refs jsonb,
  p_expires_in    interval default interval '14 days'
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_agent     constant uuid := '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10';   -- agent:integrations (0023 seed)
  v_offers    constant integer := 50;   -- offers 0–49 of one set of items on one set of receipts
  -- an approval that failed on a filing-time check, in op_exec_receipts_qbo_link's
  -- words (op_execute keeps only the message): offered again (THE OFFER, above)
  v_refiled   constant text := '^receipts\.qbo_link: (the receipts changed since this card was filed'
                               || '|receipt .* is no longer on this job'
                               || '|the job has no QuickBooks project link any more'
                               || '|job linked to a different QuickBooks project since filing)';
  v_items     jsonb;
  v_ids       text[];
  v_deleted   boolean;
  v_moved     boolean;
  v_fp        text;
  v_hash      text;
  v_input     jsonb;
  v_op        public.operation_catalog;
  v_key       text;
  v_prev      public.proposals;
  v_row       public.proposals;
  v_result    jsonb;
  v_newest    uuid;
  v_newest_at timestamptz;
  v_n         integer := 0;
  r           record;
begin
  if p_job_id is null then
    raise exception 'receipts_qbo_link_file: job id is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_input is not null then
    if jsonb_typeof(p_input) <> 'object' then
      raise exception 'receipts_qbo_link_file: input must be a JSON object'
        using errcode = 'invalid_parameter_value';
    end if;
    if lower(coalesce(p_input ->> 'job_id', '')) <> p_job_id::text then
      raise exception 'receipts_qbo_link_file: input job_id % is not job %', p_input ->> 'job_id', p_job_id
        using errcode = 'invalid_parameter_value';
    end if;
    v_items := p_input -> 'items';
    if jsonb_typeof(v_items) is distinct from 'array'
       or jsonb_array_length(case when jsonb_typeof(v_items) = 'array' then v_items end) > 50 then
      raise exception 'receipts_qbo_link_file: items must be a list of at most 50 items; send an empty list when there is nothing to do'
        using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from jsonb_array_elements(v_items) e
                where jsonb_typeof(e) <> 'object'
                   or jsonb_typeof(e -> 'receipt_id') is distinct from 'string'
                   or length(e ->> 'receipt_id') not between 1 and 64)
       or (select count(distinct e ->> 'receipt_id') from jsonb_array_elements(v_items) e)
          <> jsonb_array_length(v_items) then
      raise exception 'receipts_qbo_link_file: every item needs its own receipt_id'
        using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from jsonb_array_elements(v_items) e
                where jsonb_typeof(e -> 'changes') is distinct from 'array'
                   or jsonb_array_length(case when jsonb_typeof(e -> 'changes') = 'array' then e -> 'changes' end) = 0
                   or exists (select 1
                                from jsonb_array_elements(case when jsonb_typeof(e -> 'changes') = 'array'
                                                               then e -> 'changes' else '[]'::jsonb end) c
                               where jsonb_typeof(c) <> 'string' or (c #>> '{}') not in ('tag', 'attach', 'create'))) then
      raise exception 'receipts_qbo_link_file: every item needs changes, a list of tag, attach and create'
        using errcode = 'invalid_parameter_value';
    end if;
    -- the receipt's photo as the worker read it (null when it had none yet):
    -- photo_refs cannot say, since a tag-only item names no photo either way
    if exists (select 1 from jsonb_array_elements(v_items) e
                where coalesce(jsonb_typeof(e -> 'read_photo_ref'), 'missing') not in ('string', 'null')) then
      raise exception 'receipts_qbo_link_file: every item needs read_photo_ref, the receipt''s photo_ref as the worker read it (null for none)'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_evidence_refs is not null and jsonb_typeof(p_evidence_refs) <> 'array' then
    raise exception 'receipts_qbo_link_file: evidence_refs must be a JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('receipts.qbo_link:' || p_job_id::text, 0));

  select deleted into v_deleted from public.field_projects where id = p_job_id;
  if not found then
    return jsonb_build_object('skipped', 'job_missing');
  end if;
  if v_deleted then
    return jsonb_build_object('skipped', 'job_deleted');
  end if;
  if not public.outbox_channel_ready('qbo') then
    return jsonb_build_object('skipped', 'qbo_lane_off');
  end if;

  perform public.op_expire_proposals();   -- a card past its expiry is expired, not open

  if coalesce(jsonb_array_length(v_items), 0) = 0 then
    v_result := jsonb_build_object('superseded_reason', 'nothing_to_do');
  else
    select array_agg(e ->> 'receipt_id') into v_ids from jsonb_array_elements(v_items) e;
    -- the receipts are still the job's, live, with the amount, date and photo
    -- the worker read and matched on: a card is never filed for a receipt
    -- deleted, moved or edited since (a crew sync rewrites job_receipts
    -- outside this lock while the run reads QuickBooks), because the
    -- fingerprint would hold the new state and an approval would match it
    -- while the items still carry the old one. One statement, so the check
    -- and the fingerprint read the same rows.
    select exists (select 1 from jsonb_array_elements(v_items) e
                    where not exists (
                      select 1 from public.job_receipts jr
                       where jr.job_id = p_job_id and jr.id = e ->> 'receipt_id' and jr.deleted_at is null
                         and jr.amount = (case when jsonb_typeof(e -> 'amount') = 'number' then (e ->> 'amount')::numeric end)
                         and to_char(jr.receipt_date, 'YYYY-MM-DD') is not distinct from (e ->> 'date')
                         and jr.photo_ref is not distinct from (e ->> 'read_photo_ref'))),
           public.receipts_qbo_fingerprint(p_job_id, v_ids)
      into v_moved, v_fp;
    if v_moved then
      return jsonb_build_object('skipped', 'receipts_moved');
    end if;

    v_hash := md5(jsonb_build_array(v_items, coalesce(p_input -> 'link', 'null'::jsonb),
                                    coalesce(p_input -> 'qbo_customer_id', 'null'::jsonb))::text);
    v_op := public.op_catalog_lookup('receipts.qbo_link');
    -- the first offer that is free, still open, or was answered
    for v_offer in 0 .. v_offers - 1 loop
      v_input := p_input || jsonb_build_object('receipts_fingerprint', v_fp, 'items_hash', v_hash, 'offer', v_offer);
      v_key := public.op_render_key(v_op.idempotency_template, v_op.name, v_input, p_job_id);
      select * into v_prev from public.proposals where idempotency_key = v_key;
      exit when v_prev.id is null
             or not (v_prev.status in ('expired', 'superseded')
                     or (v_prev.status = 'failed' and coalesce(v_prev.error, '') ~ v_refiled));
    end loop;

    if v_prev.id is null then
      v_row := public.op_propose('receipts.qbo_link', v_input, p_job_id, null, p_rationale,
                                 coalesce(p_evidence_refs, '[]'::jsonb), 'agent', v_agent, p_expires_in);
      v_result := jsonb_build_object('superseded_by', v_row.id);
    elsif v_prev.status = 'proposed' then
      return jsonb_build_object('filed', false, 'proposal_id', v_prev.id, 'status', 'proposed', 'superseded', 0);
    else
      v_result := jsonb_build_object('superseded_reason', 'items_changed');
    end if;
  end if;

  for r in
    update public.proposals p
       set status = 'superseded', result = v_result
     where p.id in (select o.id
                      from public.proposals o
                     where o.job_id = p_job_id
                       and o.operation like 'receipts.qbo\_link@%'
                       and o.status = 'proposed'
                       and o.expires_at > now()
                       and o.id is distinct from v_row.id
                       for update skip locked)
    returning p.id, p.operation, p.job_id, p.claim_id, p.created_at, p.result
  loop
    perform public.emit_event(
      'proposal.superseded', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
      r.result, 'proposal.superseded:' || r.id, 'agent', v_agent);
    if v_newest_at is null or r.created_at > v_newest_at then
      v_newest := r.id;
      v_newest_at := r.created_at;
    end if;
    v_n := v_n + 1;
  end loop;

  if coalesce(jsonb_array_length(v_items), 0) = 0 then
    return jsonb_build_object('skipped', 'empty', 'superseded', v_n);
  end if;
  if v_row.id is null then
    return jsonb_build_object('filed', false, 'proposal_id', v_prev.id, 'status', v_prev.status, 'superseded', v_n);
  end if;

  if v_newest is not null then
    update public.proposals set supersedes_id = v_newest where id = v_row.id;
  end if;
  return jsonb_build_object('filed', true, 'proposal_id', v_row.id, 'status', 'proposed', 'superseded', v_n);
end;
$$;

alter function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) owner to postgres;
comment on function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) is
  'The filing door for receipts.qbo_link (worker, receipts.qbo_match): skips a missing or deleted job, a qbo lane no worker serves and receipts that left the job or changed (amount, date, photo) since the worker read them; stamps receipts_qbo_fingerprint, the items hash and the offer number into the input, files through op_propose as agent:integrations (proposed_via agent), and supersedes the job''s other open receipts.qbo_link cards; an empty items list supersedes them as nothing_to_do. The same items on the same receipts are offered again (offer + 1, at most 50 offers) only when the last card expired, was superseded, or failed one of the executor''s filing-time checks (receipts changed or left the job, the job unlinked or relinked); an open card is returned as is, and a declined or executed one, or one that failed on its items, stays quiet and supersedes the job''s other open cards as items_changed. Returns {filed, proposal_id, status, superseded} or {skipped}. service_role only (0023).';
revoke all on function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) from public, anon, authenticated;
grant execute on function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) to service_role;


-- ---------------------------------------------------------------------------
-- 7. receipt_qbo_links_note — the matcher's nightly write of the states that
--    need no approval.
--
-- First every in_qbo, unmatched or conflict row of a job in p_job_ids that
-- p_rows no longer names is removed: its receipt left the job or was
-- deleted, and an expense it held is free again before tonight's rows claim
-- it. Then each row {receipt_id, job_id, state: in_qbo | unmatched |
-- conflict, qbo_txn_type?, qbo_txn_id?, qbo_sync_token?, qbo_customer_id?,
-- amount, receipt_date, detail} is upserted by receipt id, unless the
-- receipt is queued, done or failed: the approval path owns those rows, and
-- they are reported as kept, never touched. A row whose job is not in
-- p_job_ids is refused, so one run never writes outside the jobs it read.
-- Every row is checked before anything is written, and the write holds each
-- job's lock (the executor's), taken in a fixed order.
--
-- An in_qbo row for an expense another receipt claimed after the matcher
-- read (an approval in between) is written as a conflict with detail.reason
-- claimed_by_other instead of failing the whole night on the unique index.
-- A row that changes nothing is not rewritten, so updated_at says when the
-- state last moved.
--
-- Returns {written, kept, removed}.
-- ---------------------------------------------------------------------------
create or replace function public.receipt_qbo_links_note(p_job_ids uuid[], p_rows jsonb) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row      jsonb;
  v_i        bigint;
  v_rid      text;
  v_ids      text[] := '{}';
  v_have     text;
  v_k        text;
  v_detail   jsonb;
  v_state    text;
  v_problems text[] := '{}';
  v_lock     bigint;
  v_n        integer;
  v_written  integer := 0;
  v_kept     integer := 0;
  v_removed  integer := 0;
begin
  if p_job_ids is null then
    raise exception 'receipt_qbo_links_note: job ids are required (an empty list notes nothing)'
      using errcode = 'invalid_parameter_value';
  end if;
  if cardinality(p_job_ids) > 1000 then
    raise exception 'receipt_qbo_links_note: at most 1000 jobs per call'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'receipt_qbo_links_note: rows must be a JSON array'
      using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'receipt_qbo_links_note: at most 5000 rows per call'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_row, v_i in select e, o from jsonb_array_elements(p_rows) with ordinality as t(e, o) loop
    if jsonb_typeof(v_row) <> 'object' then
      v_problems := v_problems || format('row %s is not an object', v_i);
      continue;
    end if;
    v_rid := v_row ->> 'receipt_id';
    if jsonb_typeof(v_row -> 'receipt_id') is distinct from 'string' or length(v_rid) not between 1 and 64 then
      v_problems := v_problems || format('row %s has a bad receipt_id', v_i);
    elsif v_rid = any (v_ids) then
      v_problems := v_problems || format('receipt %s appears twice', v_rid);
    else
      v_ids := v_ids || v_rid;
    end if;
    if jsonb_typeof(v_row -> 'job_id') is distinct from 'string'
       or (v_row ->> 'job_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_problems := v_problems || format('row %s has a bad job_id', v_i);
    elsif not ((v_row ->> 'job_id')::uuid = any (p_job_ids)) then
      v_problems := v_problems || format('row %s names job %s, which this call does not cover', v_i, v_row ->> 'job_id');
    end if;
    if coalesce(v_row ->> 'state', '') not in ('in_qbo', 'unmatched', 'conflict') then
      v_problems := v_problems || format('row %s state must be in_qbo, unmatched or conflict, not %s', v_i, coalesce(v_row ->> 'state', 'null'));
    end if;
    if coalesce(jsonb_typeof(v_row -> 'qbo_txn_type'), 'null') <> 'null' and v_row -> 'qbo_txn_type' <> '"Purchase"' then
      v_problems := v_problems || format('row %s qbo_txn_type must be Purchase or null', v_i);
    end if;
    foreach v_k in array array['qbo_txn_id', 'qbo_sync_token', 'qbo_customer_id'] loop
      if coalesce(jsonb_typeof(v_row -> v_k), 'null') not in ('string', 'null')
         or coalesce(v_row ->> v_k, '') !~ '^([0-9]{1,20})?$' then
        v_problems := v_problems || format('row %s %s must be a QuickBooks id or null', v_i, v_k);
      end if;
    end loop;
    if v_row ->> 'state' = 'in_qbo'
       and (coalesce(v_row ->> 'qbo_txn_type', '') = '' or coalesce(v_row ->> 'qbo_txn_id', '') = '') then
      v_problems := v_problems || format('row %s is in_qbo but names no expense', v_i);
    end if;
    if coalesce(jsonb_typeof(v_row -> 'amount'), 'null') not in ('number', 'null') then
      v_problems := v_problems || format('row %s amount must be a number or null', v_i);
    end if;
    if coalesce(jsonb_typeof(v_row -> 'receipt_date'), 'null') not in ('string', 'null')
       or (v_row ->> 'receipt_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      v_problems := v_problems || format('row %s receipt_date must be YYYY-MM-DD or null', v_i);
    elsif v_row ->> 'receipt_date' is not null then
      begin
        perform (v_row ->> 'receipt_date')::date;
      exception when others then
        v_problems := v_problems || format('row %s receipt_date %s is not a calendar date', v_i, v_row ->> 'receipt_date');
      end;
    end if;
    if coalesce(jsonb_typeof(v_row -> 'detail'), 'null') not in ('object', 'null') then
      v_problems := v_problems || format('row %s detail must be an object', v_i);
    end if;
  end loop;
  if array_length(v_problems, 1) is not null then
    raise exception 'receipt_qbo_links_note: % ', array_to_string(v_problems, '; ')
      using errcode = 'invalid_parameter_value';
  end if;

  -- each job's lock, the one the executor holds while it queues, taken in
  -- one fixed order before any row: an approval running now finishes first,
  -- and this write never holds a row the approval waits for while waiting on
  -- one the approval holds (a deadlock is an error op_execute catches, which
  -- would fail the owner's card for good)
  for v_lock in
    select distinct hashtextextended('receipts.qbo_link:' || j::text, 0) as k
      from unnest(p_job_ids) j
     where j is not null
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock);
  end loop;

  -- receipts that left a job this run covered, or were deleted: their
  -- no-approval state goes with them, before tonight's rows are written, so
  -- an expense a deleted receipt held in_qbo is free for the receipt that
  -- matched it tonight (the matcher already counts it free) instead of
  -- reading as another receipt's claim until the next night
  delete from public.receipt_qbo_links l
   where l.job_id = any (p_job_ids)
     and l.state in ('in_qbo', 'unmatched', 'conflict')
     and not (l.receipt_id = any (v_ids));
  get diagnostics v_removed = row_count;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_rid := v_row ->> 'receipt_id';
    select state into v_have from public.receipt_qbo_links where receipt_id = v_rid for update;
    if v_have in ('queued', 'done', 'failed') then
      v_kept := v_kept + 1;
      continue;
    end if;
    v_state := v_row ->> 'state';
    v_detail := coalesce(v_row -> 'detail', '{}'::jsonb);
    begin
      insert into public.receipt_qbo_links as l
        (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
         amount, receipt_date, changes, proposal_id, outbox_id, detail, updated_at)
      values
        (v_rid, (v_row ->> 'job_id')::uuid, v_state, nullif(v_row ->> 'qbo_txn_type', ''),
         nullif(v_row ->> 'qbo_txn_id', ''), nullif(v_row ->> 'qbo_sync_token', ''), nullif(v_row ->> 'qbo_customer_id', ''),
         (v_row ->> 'amount')::numeric, (v_row ->> 'receipt_date')::date, '{}', null, null, v_detail, now())
      on conflict (receipt_id) do update
         set job_id          = excluded.job_id,
             state           = excluded.state,
             qbo_txn_type    = excluded.qbo_txn_type,
             qbo_txn_id      = excluded.qbo_txn_id,
             qbo_sync_token  = excluded.qbo_sync_token,
             qbo_customer_id = excluded.qbo_customer_id,
             amount          = excluded.amount,
             receipt_date    = excluded.receipt_date,
             changes         = '{}',
             proposal_id     = null,
             outbox_id       = null,
             detail          = excluded.detail,
             updated_at      = now()
       where l.state not in ('queued', 'done', 'failed')
         and (l.job_id, l.state, l.qbo_txn_type, l.qbo_txn_id, l.qbo_sync_token, l.qbo_customer_id,
              l.amount, l.receipt_date, l.changes, l.proposal_id, l.outbox_id, l.detail)
             is distinct from
             (excluded.job_id, excluded.state, excluded.qbo_txn_type, excluded.qbo_txn_id, excluded.qbo_sync_token,
              excluded.qbo_customer_id, excluded.amount, excluded.receipt_date, '{}'::text[], null::uuid, null::uuid,
              excluded.detail);
      get diagnostics v_n = row_count;
    exception when unique_violation then
      -- another receipt holds this expense now: say so, claim nothing
      insert into public.receipt_qbo_links as l
        (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
         amount, receipt_date, detail, updated_at)
      values
        (v_rid, (v_row ->> 'job_id')::uuid, 'conflict', nullif(v_row ->> 'qbo_txn_type', ''),
         nullif(v_row ->> 'qbo_txn_id', ''), nullif(v_row ->> 'qbo_sync_token', ''), nullif(v_row ->> 'qbo_customer_id', ''),
         (v_row ->> 'amount')::numeric, (v_row ->> 'receipt_date')::date,
         v_detail || jsonb_build_object('reason', 'claimed_by_other'), now())
      on conflict (receipt_id) do update
         set job_id = excluded.job_id, state = 'conflict', qbo_txn_type = excluded.qbo_txn_type,
             qbo_txn_id = excluded.qbo_txn_id, qbo_sync_token = excluded.qbo_sync_token,
             qbo_customer_id = excluded.qbo_customer_id, amount = excluded.amount,
             receipt_date = excluded.receipt_date, changes = '{}', proposal_id = null, outbox_id = null,
             detail = excluded.detail, updated_at = now()
       where l.state not in ('queued', 'done', 'failed');
      get diagnostics v_n = row_count;
    end;
    v_written := v_written + v_n;
  end loop;

  return jsonb_build_object('written', v_written, 'kept', v_kept, 'removed', v_removed);
end;
$$;

alter function public.receipt_qbo_links_note(uuid[], jsonb) owner to postgres;
comment on function public.receipt_qbo_links_note(uuid[], jsonb) is
  'The receipts.qbo_match matcher''s nightly write: removes the in_qbo, unmatched and conflict rows of the given jobs that p_rows no longer names, then upserts in_qbo, unmatched and conflict rows of receipt_qbo_links by receipt id, never touching a queued, done or failed row (reported as kept). Returns {written, kept, removed}. service_role only (0023).';
revoke all on function public.receipt_qbo_links_note(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.receipt_qbo_links_note(uuid[], jsonb) to service_role;


-- ---------------------------------------------------------------------------
-- 8. job_qbo_link_set — the office picker: link a job to a QuickBooks
--    project, change it, or unlink it (a null or '' customer id).
--
-- The office Receipts page lists the projects through qbo-proxy listProjects
-- and saves the pick here. A pick is source 'picked', by the signed-in person,
-- now; it replaces a link a card suggested. Linking checks the job exists and
-- is not deleted. Saving the same pick again writes nothing. Emits
-- job.qbo_linked or job.qbo_unlinked: each pick is its own fact, so the
-- events carry no idempotency key.
--
-- Returns the link row as JSON, or null after an unlink. Raises 42501 for
-- anyone but owner/office.
-- ---------------------------------------------------------------------------
create or replace function public.job_qbo_link_set(
  p_job_id uuid, p_qbo_customer_id text, p_qbo_name text, p_qbo_project_ref text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_who     uuid := public.current_principal();
  v_cust    text := nullif(btrim(coalesce(p_qbo_customer_id, '')), '');
  v_ref     text := nullif(btrim(coalesce(p_qbo_project_ref, '')), '');
  v_name    text := left(btrim(coalesce(p_qbo_name, '')), 160);
  v_deleted boolean;
  v_old     public.job_qbo_links;
  v_row     public.job_qbo_links;
begin
  if not public.role_is('owner', 'office') then
    raise exception 'only the office can link a job to QuickBooks' using errcode = 'insufficient_privilege';
  end if;
  if p_job_id is null then
    raise exception 'job_qbo_link_set: job id is required' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_old from public.job_qbo_links where job_id = p_job_id for update;

  if v_cust is null then
    delete from public.job_qbo_links where job_id = p_job_id;
    if v_old.job_id is not null then
      perform public.emit_event(
        'job.qbo_unlinked', null, 'field_project', p_job_id, p_job_id, null, null,
        jsonb_build_object('qbo_customer_id', v_old.qbo_customer_id, 'qbo_name', v_old.qbo_name, 'source', v_old.source),
        null, 'human', v_who);
    end if;
    return null;
  end if;

  if v_cust !~ '^[0-9]{1,20}$' then
    raise exception 'job_qbo_link_set: % is not a QuickBooks id', v_cust using errcode = 'invalid_parameter_value';
  end if;
  if v_ref is not null and v_ref !~ '^[0-9]{1,20}$' then
    raise exception 'job_qbo_link_set: project ref % is not a QuickBooks id', v_ref using errcode = 'invalid_parameter_value';
  end if;
  select deleted into v_deleted from public.field_projects where id = p_job_id;
  if not found then
    raise exception 'job_qbo_link_set: no job %', p_job_id using errcode = 'no_data_found';
  end if;
  if v_deleted then
    raise exception 'job_qbo_link_set: job % is deleted', p_job_id using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_old.job_id is not null and v_old.source = 'picked'
     and (v_old.qbo_customer_id, v_old.qbo_project_ref, v_old.qbo_name) is not distinct from (v_cust, v_ref, v_name) then
    return to_jsonb(v_old);
  end if;

  insert into public.job_qbo_links as l
    (job_id, qbo_customer_id, qbo_project_ref, qbo_name, source, set_by_kind, set_by_id, set_at)
  values (p_job_id, v_cust, v_ref, v_name, 'picked', 'human', v_who, now())
  on conflict (job_id) do update
     set qbo_customer_id = excluded.qbo_customer_id,
         qbo_project_ref = excluded.qbo_project_ref,
         qbo_name        = excluded.qbo_name,
         source          = 'picked',
         set_by_kind     = 'human',
         set_by_id       = excluded.set_by_id,
         set_at          = now()
  returning * into v_row;

  perform public.emit_event(
    'job.qbo_linked', null, 'field_project', p_job_id, p_job_id, null, null,
    jsonb_build_object('qbo_customer_id', v_row.qbo_customer_id, 'qbo_project_ref', v_row.qbo_project_ref,
                       'qbo_name', v_row.qbo_name, 'source', 'picked',
                       'previous_qbo_customer_id', v_old.qbo_customer_id),
    null, 'human', v_who);

  return to_jsonb(v_row);
end;
$$;

alter function public.job_qbo_link_set(uuid, text, text, text) owner to postgres;
comment on function public.job_qbo_link_set(uuid, text, text, text) is
  'Office door for job_qbo_links: link a live job to a QuickBooks project (source picked, by the caller, now), change it, or unlink it with a null or empty customer id; emits job.qbo_linked / job.qbo_unlinked. Returns the row, or null after an unlink. Raises 42501 for anyone but owner/office (0023).';
revoke all on function public.job_qbo_link_set(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.job_qbo_link_set(uuid, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. outbox_qbo_link_result — a 'qbo' outbox row's fate becomes its
--    receipt's state.
--
-- outbox_sent and outbox_failed (0016) and sweep_leases settle the outbox row
-- and never touch a proposal, so without this the receipt would read "queued"
-- forever. sent → done, with the provider id (Purchase:<id>:<sync token>,
-- adapters/qbo.mjs) and the new sync token; a created expense also records
-- its new id, unless another receipt claimed that expense meanwhile (then
-- detail.txn_held_by names it). dead → failed, with the error. Only the link
-- row this outbox row wrote is touched (receipt id and outbox id both match).
-- Like project_job_receipts it can never fail the write that fired it: the
-- worker's report of a send QuickBooks already took must always land.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_qbo_link_result() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_rid text := new.payload ->> 'receipt_id';
  v_m   text[] := regexp_match(coalesce(new.provider_id, ''), '^Purchase:([0-9]{1,20}):([0-9]{1,20})$');
begin
  if v_rid is null then
    return null;
  end if;
  if new.status = 'sent' then
    begin
      update public.receipt_qbo_links
         set state          = 'done',
             qbo_txn_id     = coalesce(qbo_txn_id, v_m[1]),
             qbo_sync_token = coalesce(v_m[2], qbo_sync_token),
             detail         = (detail - 'error' - 'failed_at')
                              || jsonb_strip_nulls(jsonb_build_object(
                                   'provider_id', new.provider_id, 'provider_status', new.provider_status,
                                   'delivered_at', coalesce(new.sent_at, now()))),
             updated_at     = now()
       where receipt_id = v_rid and outbox_id = new.id;
    exception when unique_violation then
      update public.receipt_qbo_links
         set state          = 'done',
             qbo_sync_token = coalesce(v_m[2], qbo_sync_token),
             detail         = (detail - 'error' - 'failed_at')
                              || jsonb_strip_nulls(jsonb_build_object(
                                   'provider_id', new.provider_id, 'provider_status', new.provider_status,
                                   'delivered_at', coalesce(new.sent_at, now()), 'txn_held_by',
                                   (select l.receipt_id from public.receipt_qbo_links l
                                     where l.qbo_txn_type = 'Purchase' and l.qbo_txn_id = v_m[1]
                                       and l.state in ('in_qbo', 'queued', 'done') limit 1))),
             updated_at     = now()
       where receipt_id = v_rid and outbox_id = new.id;
    end;
  else
    update public.receipt_qbo_links
       set state      = 'failed',
           detail     = detail || jsonb_build_object('error', coalesce(new.error, 'failed'), 'failed_at', now()),
           updated_at = now()
     where receipt_id = v_rid and outbox_id = new.id;
  end if;
  return null;
exception when others then
  raise warning 'outbox_qbo_link_result failed for outbox %: %', new.id, sqlerrm;
  return null;
end;
$$;

alter function public.outbox_qbo_link_result() owner to postgres;
comment on function public.outbox_qbo_link_result() is
  'AFTER UPDATE OF status on outbox, channel qbo, status now sent or dead: marks the receipt_qbo_links row that wrote that outbox row done (provider id, sync token) or failed (error). Exception-guarded: it never fails the outbox update (0023).';
revoke all on function public.outbox_qbo_link_result() from public, anon, authenticated, service_role;

drop trigger if exists outbox_qbo_link_result on public.outbox;
create trigger outbox_qbo_link_result
  after update of status on public.outbox
  for each row
  when (new.channel = 'qbo' and new.status is distinct from old.status and new.status in ('sent', 'dead'))
  execute function public.outbox_qbo_link_result();


-- ---------------------------------------------------------------------------
-- 10. qbo_service_ping — true, for the service role only.
--
-- qbo-proxy's 'service' callers present a key that is not the function's own
-- SUPABASE_SERVICE_ROLE_KEY (a project can hold several sb_secret_ keys).
-- PostgREST runs this with the presented key, so a 200 answering true proves
-- the key is the service role; any other key gets 401 or 404.
-- ---------------------------------------------------------------------------
create or replace function public.qbo_service_ping() returns boolean
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select true;
$$;

alter function public.qbo_service_ping() owner to postgres;
comment on function public.qbo_service_ping() is
  'Returns true. Granted to service_role only: qbo-proxy calls it through PostgREST with a presented key to prove that key is the service role (0023).';
revoke all on function public.qbo_service_ping() from public, anon, authenticated;
grant execute on function public.qbo_service_ping() to service_role;


-- ---------------------------------------------------------------------------
-- 11. agent:integrations may PROPOSE receipts.qbo_link — the owner's go,
--     2026-10-07 ("Start Phase 3").
--
-- The bare name, as op_agent_permits matches it (0013). Propose only: no other
-- money operation, never execute, and no agent can approve.
-- ---------------------------------------------------------------------------
do $$
declare
  v_agent  constant uuid := '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10';   -- agent:integrations (0023 seed)
  v_reason constant text :=
    'Phase 3 QuickBooks link: the nightly receipts.qbo_match run files each job''s receipts whose QuickBooks expense '
    || 'needs a job tag or the photo as one receipts.qbo_link proposal; the owner approves every one in the inbox. '
    || 'Granted by migration 0023 on the owner''s go, 2026-10-07.';
  v_id     uuid;
begin
  if not exists (select 1 from public.agents where id = v_agent and name = 'agent:integrations') then
    raise exception '0023: agent:integrations (agents %) is missing; section 1 seeds it', v_agent;
  end if;

  insert into public.agent_authority as aa
    (agent_id, operation, capability, granted_by_kind, granted_by_id, reason)
  select v_agent, 'receipts.qbo_link', 'propose', 'system', null, v_reason
   where not exists (select 1 from public.agent_authority x
                      where x.agent_id = v_agent and x.operation = 'receipts.qbo_link'
                        and x.capability = 'propose')
  on conflict (agent_id, operation, capability) where revoked_at is null do nothing
  returning aa.id into v_id;

  if v_id is not null then
    perform public.emit_event(
      'agent_authority.granted', null, 'agent_authority', v_id, null, null, null,
      jsonb_build_object('agent_id', v_agent, 'agent', 'agent:integrations',
                         'operation', 'receipts.qbo_link', 'capability', 'propose',
                         'reason', v_reason, 'granted_by', 'migration 0023'),
      'agent_authority.granted:' || v_id, 'system', null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 12. Every catalog operation that can be proposed has an executor, whatever
--     its runtime (0021 section 6, repeated for the new row).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select name from public.operation_catalog
     where deprecated_at is null and runtime in ('sql', 'worker')
       and name not in ('proposal.approve', 'proposal.decline')
  loop
    if to_regprocedure(format('public.%I(public.proposals, jsonb, text, uuid)',
                              'op_exec_' || replace(r.name, '.', '_'))) is null then
      raise exception 'ops: % has no op_exec_ executor', r.name;
    end if;
  end loop;
end
$$;


-- ---------------------------------------------------------------------------
-- 13. The nightly run. 14:50 UTC is after the QBO payment pull (14:30), which
--     refreshes the QuickBooks token, and the billing check (14:45), and
--     before the morning brief (15:00). The Alaska date is the key, so a
--     second firing the same day is the same queue row. Priority -10 lets
--     approvals (0) go first. cron.schedule is idempotent on the name; the
--     job runs as postgres, which owns enqueue.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0023: pg_cron is not installed here; receipts-qbo-match-nightly not scheduled';
    return;
  end if;
  perform cron.schedule('receipts-qbo-match-nightly', '50 14 * * *', $cmd$select public.enqueue(
    'receipts.qbo_match',
    jsonb_build_object('run_date', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')),
    'receipts.qbo_match:' || to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD'),
    now(), -10, 'agent', '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10'::uuid)$cmd$);
end
$$;
