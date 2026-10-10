-- ============================================================================
-- 0025 — receipts.qbo_link v2: bills, a receipt paid in two or three charges,
--        and a second try for a receipt whose QuickBooks update failed.
--
-- WHAT IT IS FOR: the owner's three asks of 2026-10-10.
--   Bills. The office books FNSB dump tickets as Bills (a vendor's invoice
--     entered to pay later), so the v1 match, which read only Purchases,
--     could only say "Booked as a bill: not checked". qbo-proxy now reads
--     bills (listBills) and the matcher matches a dump ticket to its bill by
--     ticket number. Bills are only read: every FNSB bill so far was entered
--     tagged to the job with the ticket photo, so a matched bill is noted (in
--     QuickBooks, tagged elsewhere, or "booked without a job: tag it in
--     QuickBooks") and never goes on a card. A receipt_qbo_links note row
--     may now name a Bill; the executor still queues Purchases only.
--   Two charges. A rental is charged at checkout and the balance at return,
--     so one Rental Zone receipt ($351.00) is two card charges in QuickBooks
--     (10615 $126.90 + 10661 $224.10). The matcher finds such a set (2 or 3
--     untouched charges from the same store on the same card that add up to
--     the receipt to the cent, and only when exactly one set does), and one
--     card line tags them all. The row keeps every charge in `parts`, and a
--     new table, receipt_qbo_claims, holds every QuickBooks transaction a
--     receipt holds, a part included, so one charge is still held by one
--     receipt only (a primary key, as the v1 partial index does for one).
--   Second tries. A receipt whose delivery failed stayed failed for good. The
--     matcher now matches it again: a refusal that would come back the same
--     (the expense is tagged to another job, the photo is unreadable...)
--     keeps the failed row for a person; anything else goes on a new card
--     marked as a second try (item.refile), and the failed row names that
--     card while it is open (detail.refiled_proposal_id).
--
-- WHAT THIS CHANGES: one table gains a column, one table is added, and four
-- 0023 functions are replaced under their exact signatures (a new parameter
-- would add an overload the v1 worker's named rpc calls could not choose
-- between). Grants and owners survive CREATE OR REPLACE; they are restated
-- anyway so a re-run is exact.
--   receipt_qbo_links           qbo_txn_type may be Bill; new `parts` (null,
--                               or the 2 or 3 charges of a Purchase receipt:
--                               [{qbo_txn_id, qbo_sync_token, qbo_total,
--                               qbo_date}], the first the row's own
--                               qbo_txn_id)
--   receipt_qbo_claims          (qbo_txn_type, qbo_txn_id) primary key →
--                               receipt_id: every transaction an in_qbo,
--                               queued or done row holds. Kept by the trigger
--                               below and nothing else; the service role
--                               reads it (the worker's v2 probe)
--   receipt_qbo_links_claims    AFTER INSERT/UPDATE/DELETE trigger function on
--                               receipt_qbo_links: replaces the row's claims.
--                               A second holder raises unique_violation inside
--                               the statement, so the doors' handlers catch
--                               it as they catch the partial index's
--   op_exec_receipts_qbo_link   accepts items in parts (each part checked;
--                               their totals add up to the receipt) and a
--                               second try's refile marker, which the queued
--                               row keeps in detail.refile,
--                               checks every transaction against the claims,
--                               stores parts, records read_photo_ref, and
--                               hands qbo-proxy explicit parts with the top
--                               level naming none (a qbo-proxy older than
--                               this change refuses such a payload rather
--                               than tag one charge). A one-transaction
--                               Purchase item's payload is unchanged
--   receipts_qbo_link_file      offers a card again that lost a lock race
--                               (deadlock detected), and stamps each re-filed
--                               receipt's failed row with the open card
--   receipt_qbo_links_note      accepts Bill and parts; may now replace a
--                               failed row it is sent (a second try that
--                               found the receipt in QuickBooks, or found
--                               nothing), never a queued or done one, and
--                               still never removes a failed row it is not
--                               sent; an omitted `parts` keeps the row's own
--                               for the same transaction (a v1 worker never
--                               sends it)
--   outbox_qbo_link_result      writes the state first and the parts' new
--                               SyncTokens (provider_status
--                               parts=<id>:<token>,…) in their own block,
--                               names a claim's holder from
--                               receipt_qbo_claims, and reads a row marked
--                               dead by hand without an error as cancelled
--
-- ANY ORDER IS SAFE. The worker probes receipt_qbo_claims at the start of a
-- run: on a database without it (before this file) it matches as 0023 did.
-- Only 404 PGRST205 or 42P01 means "older database"; anything else (a
-- missing grant, a 5xx) fails the run, so a mis-granted 0025 is never mistaken
-- for 0024. A qbo-proxy that answers 404 to listBills alone is older than
-- this change: no bills and no receipts in parts; any other listBills error
-- only leaves the bills unread that night (dump tickets read "not checked",
-- a bill already matched keeps its row). 0025 accepts everything a
-- v1 worker sends (Purchase rows, v1 items, "Purchase:<id>:<token>"), and an
-- open v1 card executes exactly as before.
--
-- PUSH ORDER: this file after 0024 on each database (db-push.yml runs `db
-- push` without --include-all). If staging is rehearsed from the branch and
-- the file then changes in review, run `supabase migration repair --status
-- reverted 0025` on staging before the real push: db push tracks files by
-- version and would not re-apply it.
--
-- KILL SWITCH AND ROLLBACK: RECEIPTS_QBO=off on the worker still stops
-- everything (0023). To cancel one queued change, mark its outbox row dead
-- with error 'cancelled: <who and why>' (a row marked dead with no error
-- reads "cancelled: marked dead by hand"); the matcher never offers a
-- cancelled change again unless the receipt or its expense moves. To stop
-- only the v2 behaviour, run the previous worker
-- build: a v1 worker on this schema notes nothing in parts, never notes a
-- failed row, and its notes keep a row's parts (see the note door). To
-- remove 0025: under `lock table public.receipt_qbo_links in share row
-- exclusive mode`, set every Bill row and every row with parts to unmatched
-- (qbo_txn_type, qbo_txn_id, qbo_sync_token and parts null, detail
-- {"reason": "rolled_back"}; a tag already written stays in QuickBooks), drop
-- trigger receipt_qbo_links_claims, function receipt_qbo_links_claims() and
-- table receipt_qbo_claims, drop constraint receipt_qbo_links_parts_check and
-- column parts, put back check (qbo_txn_type in ('Purchase')) as
-- receipt_qbo_links_qbo_txn_type_check, and re-run 0023 sections 5, 6, 7 and
-- 9. The partial unique index still guards one transaction per receipt.
--
-- Census: +1 table (receipt_qbo_claims), +1 primary key, +1 trigger, +1
-- function (the trigger function; the four others are replaced); policies,
-- views and enums unchanged (receipt_qbo_claims has RLS on and no policy:
-- nobody but the trigger writes it and only the service role reads it).
-- Roles: the service role gains SELECT on receipt_qbo_claims and nothing
-- else; every other role reads and writes exactly what it did.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. receipt_qbo_links: a Bill, and a receipt in parts.
--
-- The type check is the column check 0023 wrote inline (named by Postgres),
-- swapped by name so a re-run is exact; the assertion at the end of this file
-- refuses a database where some other check still holds the type to Purchase.
-- parts is checked without jsonb_array_length on a non-array (the CASE), and
-- only a Purchase comes in parts: a bill is one transaction.
-- ---------------------------------------------------------------------------
alter table public.receipt_qbo_links drop constraint if exists receipt_qbo_links_qbo_txn_type_check;
alter table public.receipt_qbo_links
  add constraint receipt_qbo_links_qbo_txn_type_check check (qbo_txn_type in ('Purchase', 'Bill'));

alter table public.receipt_qbo_links add column if not exists parts jsonb;
alter table public.receipt_qbo_links drop constraint if exists receipt_qbo_links_parts_check;
alter table public.receipt_qbo_links
  add constraint receipt_qbo_links_parts_check check (
    parts is null
    or case when jsonb_typeof(parts) = 'array'
            then jsonb_array_length(parts) between 2 and 3 and qbo_txn_type is not distinct from 'Purchase'
            else false end);

comment on table public.receipt_qbo_links is
  'Where each receipt stands with QuickBooks: in_qbo (matched, nothing to change), unmatched (no expense or bill found; detail.reason), conflict (found but not written; detail.reason), queued (approved, outbox row written), done (QuickBooks updated), failed (outbox row dead; detail.error; detail.refiled_proposal_id names the card holding a second try). qbo_txn_type is Purchase (an expense) or, on a note only, Bill; parts lists the 2 or 3 card charges of a receipt paid in parts. The matcher writes the first three through receipt_qbo_links_note(); the approval writes queued; the outbox_qbo_link_result trigger writes done and failed (0023, 0025).';
comment on column public.receipt_qbo_links.parts is
  'null, or the 2 or 3 QuickBooks charges (Purchases) one receipt was paid in, in order, each {qbo_txn_id, qbo_sync_token, qbo_total, qbo_date}; the first is the row''s own qbo_txn_id. receipt_qbo_claims holds each of them for this receipt (0025).';


-- ---------------------------------------------------------------------------
-- 2. receipt_qbo_claims — one QuickBooks transaction, one receipt.
--
-- The v1 partial unique index covers the row's own transaction only; a
-- receipt in parts holds two or three. This table holds every transaction of
-- every in_qbo, queued or done row, kept by the trigger below. The primary
-- key is not deferrable, and the trigger is a plain AFTER ROW trigger (never
-- a constraint trigger), so a second holder raises 23505 inside the statement
-- that wrote it: inside the note door's subtransaction (which turns it into a
-- conflict, claimed_by_other), inside the executor (which checks the claims
-- first and words the refusal) and inside outbox_qbo_link_result (which
-- names the holder). The trigger replaces the receipt's claims whenever the
-- state, the transaction or the parts change, inserting them in id order so
-- two writers meet in the same order. No foreign key, as 0023's tables.
-- ---------------------------------------------------------------------------
create table if not exists public.receipt_qbo_claims (
  qbo_txn_type  text not null check (qbo_txn_type in ('Purchase', 'Bill')),
  qbo_txn_id    text not null check (qbo_txn_id ~ '^[0-9]{1,20}$'),
  receipt_id    text not null check (char_length(receipt_id) between 1 and 64),
  primary key (qbo_txn_type, qbo_txn_id)
);
create index if not exists receipt_qbo_claims_receipt_idx on public.receipt_qbo_claims (receipt_id);

comment on table public.receipt_qbo_claims is
  'Every QuickBooks transaction (Purchase or Bill) an in_qbo, queued or done receipt_qbo_links row holds: its qbo_txn_id and each of its parts. The primary key keeps one transaction on one receipt. Written only by the receipt_qbo_links_claims trigger; read by the service role (0025).';

alter table public.receipt_qbo_claims owner to postgres;
alter table public.receipt_qbo_claims enable row level security;
-- the baseline's default privileges grant ALL to anon, authenticated and the
-- service role (0023 section 2): take it all back; the worker reads it
revoke all on public.receipt_qbo_claims from public, anon, authenticated, service_role;
grant select on public.receipt_qbo_claims to service_role;

create or replace function public.receipt_qbo_links_claims() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'UPDATE'
     and (old.receipt_id, old.state, old.qbo_txn_type, old.qbo_txn_id, old.parts)
         is not distinct from (new.receipt_id, new.state, new.qbo_txn_type, new.qbo_txn_id, new.parts) then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.receipt_qbo_claims where receipt_id = old.receipt_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.state in ('in_qbo', 'queued', 'done') and new.qbo_txn_type is not null then
    insert into public.receipt_qbo_claims (qbo_txn_type, qbo_txn_id, receipt_id)
    select new.qbo_txn_type, t.id, new.receipt_id
      from (select new.qbo_txn_id as id
            union
            select p ->> 'qbo_txn_id'
              from jsonb_array_elements(case when jsonb_typeof(new.parts) = 'array' then new.parts
                                             else '[]'::jsonb end) p) t
     where t.id is not null
     order by t.id collate "C";
  end if;
  return null;
end;
$$;

alter function public.receipt_qbo_links_claims() owner to postgres;
comment on function public.receipt_qbo_links_claims() is
  'AFTER INSERT, DELETE or UPDATE OF receipt_id, state, type, id or parts on receipt_qbo_links: replaces the receipt''s receipt_qbo_claims rows with its transaction and parts while it is in_qbo, queued or done. A transaction another receipt holds raises unique_violation in the writing statement. Internal (0025).';
revoke all on function public.receipt_qbo_links_claims() from public, anon, authenticated, service_role;

drop trigger if exists receipt_qbo_links_claims on public.receipt_qbo_links;
create trigger receipt_qbo_links_claims
  after insert or delete or update of receipt_id, state, qbo_txn_type, qbo_txn_id, parts
  on public.receipt_qbo_links
  for each row
  execute function public.receipt_qbo_links_claims();

-- The claims of today's rows. The trigger is already in place, so a write
-- from here on keeps its own claims; the lock keeps every door out while the
-- table is rebuilt whole (a DO block is one statement, so the lock holds
-- whether or not the file runs as one transaction), and the delete makes a
-- re-run exact. Today's rows name one Purchase each and the partial index
-- already holds them to one receipt, so the insert cannot collide.
do $$
begin
  lock table public.receipt_qbo_links in share row exclusive mode;
  delete from public.receipt_qbo_claims;
  insert into public.receipt_qbo_claims (qbo_txn_type, qbo_txn_id, receipt_id)
  select l.qbo_txn_type, t.id, l.receipt_id
    from public.receipt_qbo_links l
   cross join lateral (
     select l.qbo_txn_id as id
     union
     select p ->> 'qbo_txn_id'
       from jsonb_array_elements(case when jsonb_typeof(l.parts) = 'array' then l.parts else '[]'::jsonb end) p
   ) t
   where l.state in ('in_qbo', 'queued', 'done') and l.qbo_txn_type is not null and t.id is not null
   order by t.id collate "C";
end
$$;


-- ---------------------------------------------------------------------------
-- 3. op_exec_receipts_qbo_link — 0023 section 5, with:
--    - qbo_txn_type still Purchase only (a bill is only read);
--    - an item in parts (a Purchase, never a create): 2 or 3 parts, each a
--      charge {qbo_txn_id, qbo_sync_token, qbo_total, qbo_date, changes},
--      distinct, the first the item's own transaction, each part's changes
--      within the item's (none: a charge already complete, only checked),
--      every item change asked of some part, and |totals| adding up to the
--      receipt's |amount| to the cent;
--    - refile {proposal_id, error, why?} accepted as the matcher files it,
--      and kept on the queued row (detail.refile) so the next failure knows
--      it was already a second try;
--    - every transaction of an item (its own, or each part) checked against
--      receipt_qbo_claims, in 0023's words plus "(part k of n)";
--    - a receipt already queued or done is skipped only for the same
--      transaction and the same parts;
--    - the link row stores parts (always: null for one transaction) and
--      detail.read_photo_ref, so the next failure can tell whether the photo
--      moved;
--    - an item in parts hands qbo-proxy parts [{qbo_txn_id,
--      expect_sync_token, expect_total, changes}] with qbo_txn_id and
--      expect_sync_token '' and expect_total null at the top; any other
--      item's payload is 0023's, key for key.
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
  v_type     text;
  v_holder   text;
  v_payload  jsonb;
  v_base     text;
  v_outbox   uuid;
  v_outboxes uuid[] := '{}';
  v_queued   integer := 0;
  v_skipped  integer := 0;
  v_total    numeric := 0;
  v_parts    jsonb;
  v_part     jsonb;
  v_j        bigint;
  v_pids     text[];
  v_pch      text[];
  v_pall     text[];
  v_sum      numeric;
  v_sumok    boolean;
  v_norm     jsonb;
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

    -- a bill is only read (the matcher notes it, never files it)
    v_type := v_item ->> 'qbo_txn_type';
    if jsonb_typeof(v_item -> 'qbo_txn_type') is distinct from 'string' or v_type <> 'Purchase' then
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
        -- the receipt number's digits (0023: at least 5, the matcher's floor)
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

    -- a receipt paid in two or three card charges
    v_parts := v_item -> 'parts';
    if coalesce(jsonb_typeof(v_parts), 'null') <> 'null' then
      if jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) not between 2 and 3 then
        v_problems := v_problems || format('item %s parts must list 2 or 3 charges', v_i);
      elsif v_type is distinct from 'Purchase' or 'create' = any (v_ch) then
        v_problems := v_problems || format('item %s comes in parts, which only card charges (Purchase, never entered) do', v_i);
      else
        v_pids := '{}';
        v_pall := '{}';
        v_sum := 0;
        v_sumok := true;
        for v_part, v_j in select e, o from jsonb_array_elements(v_parts) with ordinality as t(e, o) loop
          if jsonb_typeof(v_part) <> 'object' then
            v_problems := v_problems || format('item %s part %s is not an object', v_i, v_j);
            v_sumok := false;
            continue;
          end if;
          if coalesce(jsonb_typeof(v_part -> 'qbo_txn_id'), '') <> 'string' or (v_part ->> 'qbo_txn_id') !~ '^[0-9]{1,20}$' then
            v_problems := v_problems || format('item %s part %s qbo_txn_id must be a QuickBooks id', v_i, v_j);
          elsif (v_part ->> 'qbo_txn_id') = any (v_pids) then
            v_problems := v_problems || format('item %s names charge %s twice', v_i, v_part ->> 'qbo_txn_id');
          else
            v_pids := v_pids || (v_part ->> 'qbo_txn_id');
          end if;
          if coalesce(jsonb_typeof(v_part -> 'qbo_sync_token'), '') <> 'string' or (v_part ->> 'qbo_sync_token') !~ '^[0-9]{1,20}$' then
            v_problems := v_problems || format('item %s part %s qbo_sync_token must be digits', v_i, v_j);
          end if;
          if jsonb_typeof(v_part -> 'qbo_total') is distinct from 'number' then
            v_problems := v_problems || format('item %s part %s qbo_total must be a number', v_i, v_j);
            v_sumok := false;
          else
            v_sum := v_sum + abs((v_part ->> 'qbo_total')::numeric);
          end if;
          if coalesce(jsonb_typeof(v_part -> 'qbo_date'), 'null') not in ('string', 'null')
             or (v_part ->> 'qbo_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            v_problems := v_problems || format('item %s part %s qbo_date must be YYYY-MM-DD or null', v_i, v_j);
          end if;
          v_pch := null;
          if jsonb_typeof(v_part -> 'changes') = 'array' then
            select coalesce(array_agg(c #>> '{}' order by o), '{}'), coalesce(bool_and(jsonb_typeof(c) = 'string'), true),
                   count(distinct c)
              into v_pch, v_ok, v_n
              from jsonb_array_elements(v_part -> 'changes') with ordinality as x(c, o);
          end if;
          if v_pch is null or not v_ok or v_n <> cardinality(v_pch)
             or not (v_pch <@ array['tag', 'attach']) or not (v_pch <@ v_ch) then
            v_problems := v_problems || format('item %s part %s changes must be tag and/or attach, from the item''s changes, without repeats', v_i, v_j);
          else
            v_pall := v_pall || v_pch;
          end if;
        end loop;
        if (v_parts #>> '{0,qbo_txn_id}') is distinct from (v_item ->> 'qbo_txn_id')
           or (v_parts #>> '{0,qbo_sync_token}') is distinct from (v_item ->> 'qbo_sync_token') then
          v_problems := v_problems || format('item %s first part must be the charge the item names', v_i);
        end if;
        if not (v_ch <@ v_pall) then
          v_problems := v_problems || format('item %s asks for a change no part asks for', v_i);
        end if;
        if v_sumok and jsonb_typeof(v_item -> 'amount') = 'number'
           and round(v_sum, 2) <> round(abs((v_item ->> 'amount')::numeric), 2) then
          v_problems := v_problems || format('item %s parts add up to %s, not the receipt''s %s',
                                             v_i, round(v_sum, 2), abs((v_item ->> 'amount')::numeric));
        end if;
      end if;
    end if;

    -- a second try for a receipt whose last update failed, as the matcher files it
    if coalesce(jsonb_typeof(v_item -> 'refile'), 'null') not in ('object', 'null')
       or (jsonb_typeof(v_item -> 'refile') = 'object'
           and (coalesce(jsonb_typeof(v_item #> '{refile,proposal_id}'), 'null') not in ('string', 'null')
                or (v_item #>> '{refile,proposal_id}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                or coalesce(jsonb_typeof(v_item #> '{refile,error}'), '') <> 'string'
                or length(v_item #>> '{refile,error}') > 60
                or coalesce(jsonb_typeof(v_item #> '{refile,why}'), 'null') not in ('string', 'null')
                or length(v_item #>> '{refile,why}') > 200)) then
      v_problems := v_problems || format('item %s refile must be {proposal_id: a uuid or null, error: text of at most 60 characters, why: text of at most 200}', v_i);
    end if;
    if coalesce(jsonb_typeof(v_item -> 'read_photo_ref'), 'null') not in ('string', 'null') then
      v_problems := v_problems || format('item %s read_photo_ref must be text or null', v_i);
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
    v_type := v_item ->> 'qbo_txn_type';
    v_parts := case when jsonb_typeof(v_item -> 'parts') = 'array' then v_item -> 'parts' end;
    select array_agg(c) into v_ch from jsonb_array_elements_text(v_item -> 'changes') c;

    select * into v_row from public.receipt_qbo_links where receipt_id = v_rid for update;
    if v_row.receipt_id is not null and v_row.state in ('queued', 'done') then
      -- already on its way, or there, for this same transaction (and the same
      -- charges): nothing to add
      if v_row.qbo_txn_type is not distinct from v_type
         and (v_row.qbo_txn_id is not distinct from v_txn or (v_txn is null and 'create' = any (v_row.changes)))
         and (select array_agg(p ->> 'qbo_txn_id' order by p ->> 'qbo_txn_id' collate "C")
                from jsonb_array_elements(case when jsonb_typeof(v_row.parts) = 'array' then v_row.parts
                                               else '[]'::jsonb end) p)
             is not distinct from
             (select array_agg(p ->> 'qbo_txn_id' order by p ->> 'qbo_txn_id' collate "C")
                from jsonb_array_elements(coalesce(v_parts, '[]'::jsonb)) p) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      raise exception 'receipts.qbo_link: receipt % is already % with QuickBooks % %, so nothing was queued',
        v_rid, v_row.state, v_row.qbo_txn_type, coalesce(v_row.qbo_txn_id, '(new)');
    end if;
    -- every transaction the item would hold, against every one another
    -- receipt holds (receipt_qbo_claims: in_qbo, queued and done, parts too)
    v_pids := case when v_parts is not null
                   then array(select p ->> 'qbo_txn_id' from jsonb_array_elements(v_parts) with ordinality as t(p, o) order by o)
                   else array_remove(array[v_txn], null) end;
    for v_j in 1 .. coalesce(cardinality(v_pids), 0) loop
      v_holder := null;
      select c.receipt_id into v_holder
        from public.receipt_qbo_claims c
       where c.qbo_txn_type = v_type and c.qbo_txn_id = v_pids[v_j] and c.receipt_id <> v_rid;
      if v_holder is not null then
        raise exception 'receipts.qbo_link: QuickBooks % % is already matched to receipt %, so nothing was queued',
          v_type, v_pids[v_j] || case when v_parts is not null
                                      then format(' (part %s of %s)', v_j, cardinality(v_pids)) else '' end,
          v_holder;
      end if;
    end loop;

    v_norm := case when v_parts is not null then
                (select jsonb_agg(jsonb_build_object('qbo_txn_id', p ->> 'qbo_txn_id', 'qbo_sync_token', p ->> 'qbo_sync_token',
                                                     'qbo_total', p -> 'qbo_total', 'qbo_date', coalesce(p -> 'qbo_date', 'null'::jsonb))
                                  order by o)
                   from jsonb_array_elements(v_parts) with ordinality as t(p, o))
              end;

    insert into public.receipt_qbo_links as l
      (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
       amount, receipt_date, changes, proposal_id, outbox_id, detail, parts, updated_at)
    values
      (v_rid, v_job, 'queued', v_type, v_txn, nullif(v_item ->> 'qbo_sync_token', ''),
       nullif(v_cust, ''), (v_item ->> 'amount')::numeric, (v_item ->> 'date')::date, v_ch, p_proposal.id, null,
       jsonb_strip_nulls(jsonb_build_object(
         'vendor', v_item ->> 'vendor', 'receipt_no', v_item ->> 'receipt_no',
         'qbo_doc_number', coalesce(v_item ->> 'qbo_doc_number', v_item #>> '{create,doc_number}'),
         'qbo_account_name', v_item ->> 'qbo_account_name', 'qbo_total', v_item -> 'qbo_total'))
       -- the photo as the worker read it, null included: the next failure
       -- can tell whether it moved since
       || case when v_item ? 'read_photo_ref'
               then jsonb_build_object('read_photo_ref', v_item -> 'read_photo_ref') else '{}'::jsonb end
       -- a second try remembers the failure it retried: one that dies the
       -- same way, with nothing moved, is not tried a third time
       || case when jsonb_typeof(v_item -> 'refile') = 'object'
               then jsonb_build_object('refile', v_item -> 'refile') else '{}'::jsonb end,
       v_norm, now())
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
           parts           = excluded.parts,
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
      'qbo_txn_type',      v_type,
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
    if v_parts is not null then
      -- each charge as completePurchase checks one, and none at the top: a
      -- qbo-proxy older than parts refuses the empty id instead of tagging
      -- only the first charge
      v_payload := v_payload || jsonb_build_object(
        'qbo_txn_id', '', 'expect_sync_token', '', 'expect_total', null,
        'parts', (select jsonb_agg(jsonb_build_object('qbo_txn_id', p ->> 'qbo_txn_id',
                                                      'expect_sync_token', p ->> 'qbo_sync_token',
                                                      'expect_total', p -> 'qbo_total',
                                                      'changes', p -> 'changes') order by o)
                    from jsonb_array_elements(v_parts) with ordinality as t(p, o)));
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
  'Executor for receipts.qbo_link@1: under the job''s advisory lock, re-checks receipts_qbo_fingerprint (fails with nothing written when it moved), links the job when the card suggested a project and the job has none, refuses a tag when the job is linked to another project, then per approved item (an expense, or a receipt paid in 2 or 3 card charges; a bill is refused, since bills are only noted) checks every transaction against receipt_qbo_claims, marks receipt_qbo_links queued and writes one outbox row on channel qbo (key outbox:<proposal key>:<receipt id>); emits receipts.qbo_link_queued. An edited approval may only drop items (0023, 0025).';
revoke all on function public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. receipts_qbo_link_file — 0023 section 6, with two additions:
--    - a card whose approval failed with "deadlock detected" (two approvals
--      or a delivery meeting over the same transactions) is offered again,
--      like one that failed a filing-time check: nothing was written;
--    - THE SECOND-TRY STAMP: after the outcome, each failed row whose
--      receipt is on this filing as a second try (item.refile naming the
--      failed row's own proposal; the row may still carry the job the
--      receipt was on when it failed, since the receipt can have moved since:
--      the moved check above proves every item's receipt is live on this
--      job, and a receipt is live on one job only) names the card that holds that try
--      (detail.refiled_proposal_id): the new card, the one still open, or
--      the one that already answered these items (declined, executed with
--      this receipt edited out). The worker reads that card's status, so a
--      declined second try stays declined while the receipt's item is the
--      same, whatever else the job's card holds; the office page words the
--      badge from it. A stamp changes only detail, which the claims trigger
--      ignores, and the row's next state replaces detail whole.
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
  -- words (op_execute keeps only the message), or lost a lock race: offered
  -- again (THE OFFER, 0023)
  v_refiled   constant text := '^(receipts\.qbo_link: (the receipts changed since this card was filed'
                               || '|receipt .* is no longer on this job'
                               || '|the job has no QuickBooks project link any more'
                               || '|job linked to a different QuickBooks project since filing)'
                               || '|deadlock detected)';
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
  v_open      boolean := false;
  v_card      uuid;
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
    -- the worker read and matched on (0023)
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
      v_open := true;
    else
      v_result := jsonb_build_object('superseded_reason', 'items_changed');
    end if;
  end if;

  -- THE SECOND-TRY STAMP (above)
  v_card := coalesce(v_row.id, v_prev.id);
  if v_card is not null then
    update public.receipt_qbo_links l
       set detail = l.detail || jsonb_build_object('refiled_proposal_id', v_card)
      from jsonb_array_elements(v_items) e
     where l.state = 'failed'
       and l.receipt_id = e ->> 'receipt_id'
       and jsonb_typeof(e -> 'refile') = 'object'
       and lower(e #>> '{refile,proposal_id}') = l.proposal_id::text
       and (l.detail ->> 'refiled_proposal_id') is distinct from v_card::text;
  end if;

  if v_open then
    return jsonb_build_object('filed', false, 'proposal_id', v_prev.id, 'status', 'proposed', 'superseded', 0);
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
  'The filing door for receipts.qbo_link (worker, receipts.qbo_match): skips a missing or deleted job, a qbo lane no worker serves and receipts that left the job or changed (amount, date, photo) since the worker read them; stamps receipts_qbo_fingerprint, the items hash and the offer number into the input, files through op_propose as agent:integrations (proposed_via agent), and supersedes the job''s other open receipts.qbo_link cards; an empty items list supersedes them as nothing_to_do. The same items on the same receipts are offered again (offer + 1, at most 50 offers) only when the last card expired, was superseded, failed one of the executor''s filing-time checks (receipts changed or left the job, the job unlinked or relinked) or lost a lock race (deadlock detected); an open card is returned as is, and a declined or executed one, or one that failed on its items, stays quiet and supersedes the job''s other open cards as items_changed. Each failed row re-filed as a second try names the card holding it (new, open or already answered) in detail.refiled_proposal_id. Returns {filed, proposal_id, status, superseded} or {skipped}. service_role only (0023, 0025).';
revoke all on function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) from public, anon, authenticated;
grant execute on function public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval) to service_role;


-- ---------------------------------------------------------------------------
-- 5. receipt_qbo_links_note — 0023 section 7, with:
--    - qbo_txn_type Purchase, Bill or null;
--    - parts: absent, null, or 2 or 3 charges {qbo_txn_id, qbo_sync_token,
--      qbo_total, qbo_date} of an in_qbo, unmatched or conflict Purchase row,
--      distinct, the first the row's own transaction and SyncToken. A row
--      that omits the key keeps the parts it has for the same transaction (a
--      v1 worker, which knows nothing of parts, never drops a receipt's
--      second charge), and drops them for any other;
--    - a failed row the call sends is replaced (a second try that found the
--      receipt in QuickBooks already, found nothing, or found a conflict);
--      queued and done rows are still kept; a failed row the call does not
--      send is still never removed;
--    - the claimed_by_other handler also covers a part another receipt holds,
--      and a failed row.
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
  v_part     jsonb;
  v_j        bigint;
  v_pids     text[];
  v_parts    jsonb;
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
    if coalesce(jsonb_typeof(v_row -> 'qbo_txn_type'), 'null') <> 'null'
       and v_row -> 'qbo_txn_type' not in ('"Purchase"'::jsonb, '"Bill"'::jsonb) then
      v_problems := v_problems || format('row %s qbo_txn_type must be Purchase, Bill or null', v_i);
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
    -- the charges of a receipt paid in parts
    if coalesce(jsonb_typeof(v_row -> 'parts'), 'null') <> 'null' then
      if jsonb_typeof(v_row -> 'parts') <> 'array' or jsonb_array_length(v_row -> 'parts') not between 2 and 3 then
        v_problems := v_problems || format('row %s parts must list 2 or 3 charges', v_i);
      elsif v_row -> 'qbo_txn_type' is distinct from '"Purchase"'::jsonb then
        v_problems := v_problems || format('row %s comes in parts, which only card charges (Purchase) do', v_i);
      else
        v_pids := '{}';
        for v_part, v_j in select e, o from jsonb_array_elements(v_row -> 'parts') with ordinality as t(e, o) loop
          if jsonb_typeof(v_part) <> 'object'
             or coalesce(jsonb_typeof(v_part -> 'qbo_txn_id'), '') <> 'string' or (v_part ->> 'qbo_txn_id') !~ '^[0-9]{1,20}$'
             or coalesce(jsonb_typeof(v_part -> 'qbo_sync_token'), '') <> 'string' or (v_part ->> 'qbo_sync_token') !~ '^[0-9]{1,20}$'
             or coalesce(jsonb_typeof(v_part -> 'qbo_total'), 'null') not in ('number', 'null')
             or coalesce(jsonb_typeof(v_part -> 'qbo_date'), 'null') not in ('string', 'null')
             or (v_part ->> 'qbo_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            v_problems := v_problems || format('row %s part %s must be {qbo_txn_id, qbo_sync_token, qbo_total, qbo_date}', v_i, v_j);
          elsif (v_part ->> 'qbo_txn_id') = any (v_pids) then
            v_problems := v_problems || format('row %s names charge %s twice', v_i, v_part ->> 'qbo_txn_id');
          else
            v_pids := v_pids || (v_part ->> 'qbo_txn_id');
          end if;
        end loop;
        if (v_row #>> '{parts,0,qbo_txn_id}') is distinct from (v_row ->> 'qbo_txn_id')
           or (v_row #>> '{parts,0,qbo_sync_token}') is distinct from (v_row ->> 'qbo_sync_token') then
          v_problems := v_problems || format('row %s first part must be the charge the row names', v_i);
        end if;
      end if;
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
  -- one fixed order before any row (0023)
  for v_lock in
    select distinct hashtextextended('receipts.qbo_link:' || j::text, 0) as k
      from unnest(p_job_ids) j
     where j is not null
     order by 1
  loop
    perform pg_advisory_xact_lock(v_lock);
  end loop;

  -- receipts that left a job this run covered, or were deleted: their
  -- no-approval state goes with them, before tonight's rows are written
  -- (0023). A failed row is never removed this way: a person reads it.
  delete from public.receipt_qbo_links l
   where l.job_id = any (p_job_ids)
     and l.state in ('in_qbo', 'unmatched', 'conflict')
     and not (l.receipt_id = any (v_ids));
  get diagnostics v_removed = row_count;

  for v_row in select e from jsonb_array_elements(p_rows) e loop
    v_rid := v_row ->> 'receipt_id';
    select state into v_have from public.receipt_qbo_links where receipt_id = v_rid for update;
    if v_have in ('queued', 'done') then
      v_kept := v_kept + 1;
      continue;
    end if;
    v_state := v_row ->> 'state';
    v_detail := coalesce(v_row -> 'detail', '{}'::jsonb);
    v_parts := case when jsonb_typeof(v_row -> 'parts') = 'array' then
                 (select jsonb_agg(jsonb_build_object('qbo_txn_id', p ->> 'qbo_txn_id', 'qbo_sync_token', p ->> 'qbo_sync_token',
                                                      'qbo_total', coalesce(p -> 'qbo_total', 'null'::jsonb),
                                                      'qbo_date', coalesce(p -> 'qbo_date', 'null'::jsonb))
                                   order by o)
                    from jsonb_array_elements(v_row -> 'parts') with ordinality as t(p, o))
               end;
    begin
      insert into public.receipt_qbo_links as l
        (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
         amount, receipt_date, changes, proposal_id, outbox_id, detail, parts, updated_at)
      values
        (v_rid, (v_row ->> 'job_id')::uuid, v_state, nullif(v_row ->> 'qbo_txn_type', ''),
         nullif(v_row ->> 'qbo_txn_id', ''), nullif(v_row ->> 'qbo_sync_token', ''), nullif(v_row ->> 'qbo_customer_id', ''),
         (v_row ->> 'amount')::numeric, (v_row ->> 'receipt_date')::date, '{}', null, null, v_detail, v_parts, now())
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
             parts           = case when v_row ? 'parts' then excluded.parts
                                    when (l.qbo_txn_type, l.qbo_txn_id) is not distinct from (excluded.qbo_txn_type, excluded.qbo_txn_id)
                                    then l.parts end,
             updated_at      = now()
       where l.state not in ('queued', 'done')
         and (l.job_id, l.state, l.qbo_txn_type, l.qbo_txn_id, l.qbo_sync_token, l.qbo_customer_id,
              l.amount, l.receipt_date, l.changes, l.proposal_id, l.outbox_id, l.detail, l.parts)
             is distinct from
             (excluded.job_id, excluded.state, excluded.qbo_txn_type, excluded.qbo_txn_id, excluded.qbo_sync_token,
              excluded.qbo_customer_id, excluded.amount, excluded.receipt_date, '{}'::text[], null::uuid, null::uuid,
              excluded.detail,
              case when v_row ? 'parts' then excluded.parts
                   when (l.qbo_txn_type, l.qbo_txn_id) is not distinct from (excluded.qbo_txn_type, excluded.qbo_txn_id)
                   then l.parts end);
      get diagnostics v_n = row_count;
    exception when unique_violation then
      -- another receipt holds this transaction, or one of its charges: say
      -- so, claim nothing
      insert into public.receipt_qbo_links as l
        (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id, qbo_sync_token, qbo_customer_id,
         amount, receipt_date, detail, parts, updated_at)
      values
        (v_rid, (v_row ->> 'job_id')::uuid, 'conflict', nullif(v_row ->> 'qbo_txn_type', ''),
         nullif(v_row ->> 'qbo_txn_id', ''), nullif(v_row ->> 'qbo_sync_token', ''), nullif(v_row ->> 'qbo_customer_id', ''),
         (v_row ->> 'amount')::numeric, (v_row ->> 'receipt_date')::date,
         v_detail || jsonb_build_object('reason', 'claimed_by_other'), v_parts, now())
      on conflict (receipt_id) do update
         set job_id = excluded.job_id, state = 'conflict', qbo_txn_type = excluded.qbo_txn_type,
             qbo_txn_id = excluded.qbo_txn_id, qbo_sync_token = excluded.qbo_sync_token,
             qbo_customer_id = excluded.qbo_customer_id, amount = excluded.amount,
             receipt_date = excluded.receipt_date, changes = '{}', proposal_id = null, outbox_id = null,
             detail = excluded.detail, parts = excluded.parts, updated_at = now()
       where l.state not in ('queued', 'done')
         and (l.job_id, l.state, l.qbo_txn_type, l.qbo_txn_id, l.qbo_sync_token, l.qbo_customer_id,
              l.amount, l.receipt_date, l.changes, l.proposal_id, l.outbox_id, l.detail, l.parts)
             is distinct from
             (excluded.job_id, 'conflict'::text, excluded.qbo_txn_type, excluded.qbo_txn_id, excluded.qbo_sync_token,
              excluded.qbo_customer_id, excluded.amount, excluded.receipt_date, '{}'::text[], null::uuid, null::uuid,
              excluded.detail, excluded.parts);
      get diagnostics v_n = row_count;
    end;
    v_written := v_written + v_n;
  end loop;

  return jsonb_build_object('written', v_written, 'kept', v_kept, 'removed', v_removed);
end;
$$;

alter function public.receipt_qbo_links_note(uuid[], jsonb) owner to postgres;
comment on function public.receipt_qbo_links_note(uuid[], jsonb) is
  'The receipts.qbo_match matcher''s nightly write: removes the in_qbo, unmatched and conflict rows of the given jobs that p_rows no longer names, then upserts in_qbo, unmatched and conflict rows of receipt_qbo_links by receipt id (an expense, a bill, or a receipt in parts), replacing a failed row it is sent but never a queued or done one (reported as kept); a row that omits parts keeps its own for the same transaction; a transaction or charge another receipt holds becomes conflict claimed_by_other. Returns {written, kept, removed}. service_role only (0023, 0025).';
revoke all on function public.receipt_qbo_links_note(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.receipt_qbo_links_note(uuid[], jsonb) to service_role;


-- ---------------------------------------------------------------------------
-- 6. outbox_qbo_link_result — 0023 section 9, with:
--    - the state written first, on its own; then, in a block of its own, each
--      charge's new SyncToken from provider_status "parts=<id>:<token>,…",
--      so a status this trigger cannot read never leaves a delivered receipt
--      queued. A receipt in parts whose later charge QuickBooks refused after
--      an earlier one was written is sent, not dead (qbo-proxy answers ok
--      with part_error, the adapter writes part_error=<code> into
--      provider_status): the receipt is done and holds every charge, and the
--      office reads which one was refused;
--    - txn_held_by read from receipt_qbo_claims;
--    - THE CANCEL: the worker marks a row dead only from 'sending', always
--      with an error; a row a person marked dead from 'pending' or 'failed'
--      (waiting for its next try) reads "cancelled: <their words>", or
--      "cancelled: marked dead by hand" without words, a code the matcher
--      never retries on its own. A row marked dead after it was sent stays
--      done. The way to cancel a queued QuickBooks change is:
--        update public.outbox set status = 'dead', error = 'cancelled: <who and why>'
--         where id = <the row> and status in ('pending', 'failed');
--      UPDATE 0 means it is being sent right now or already went: check the
--      receipt again, and fix the expense in QuickBooks if it was written.
--      A change cancelled after a failed try may be partly in QuickBooks
--      already (a tag written before the photo failed, or a first charge).
-- The whole body still never fails the outbox update (0023).
-- ---------------------------------------------------------------------------
create or replace function public.outbox_qbo_link_result() returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_rid   text := new.payload ->> 'receipt_id';
  v_m     text[] := regexp_match(coalesce(new.provider_id, ''), '^Purchase:([0-9]{1,20}):([0-9]{1,20})$');
  v_parts text[];
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
             detail         = (detail - 'error' - 'failed_at' - 'refiled_proposal_id')
                              || jsonb_strip_nulls(jsonb_build_object(
                                   'provider_id', new.provider_id, 'provider_status', new.provider_status,
                                   'delivered_at', coalesce(new.sent_at, now()))),
             updated_at     = now()
       where receipt_id = v_rid and outbox_id = new.id;
    exception when unique_violation then
      update public.receipt_qbo_links l
         set state          = 'done',
             qbo_sync_token = coalesce(v_m[2], l.qbo_sync_token),
             detail         = (l.detail - 'error' - 'failed_at' - 'refiled_proposal_id')
                              || jsonb_strip_nulls(jsonb_build_object(
                                   'provider_id', new.provider_id, 'provider_status', new.provider_status,
                                   'delivered_at', coalesce(new.sent_at, now()), 'txn_held_by',
                                   (select c.receipt_id from public.receipt_qbo_claims c
                                     where c.qbo_txn_type = 'Purchase' and c.qbo_txn_id = v_m[1]
                                       and c.receipt_id <> v_rid limit 1))),
             updated_at     = now()
       where l.receipt_id = v_rid and l.outbox_id = new.id;
    end;
    -- each charge's new SyncToken, for a receipt in parts
    begin
      v_parts := regexp_match(coalesce(new.provider_status, ''), '(?:^|;)parts=([0-9]{1,20}:[0-9]{1,20}(?:,[0-9]{1,20}:[0-9]{1,20}){1,2})(?:;|$)');
      if v_parts is not null then
        update public.receipt_qbo_links l
           set parts = (select jsonb_agg(case when x.tok is not null then p || jsonb_build_object('qbo_sync_token', x.tok) else p end
                                         order by o)
                          from jsonb_array_elements(l.parts) with ordinality as e(p, o)
                          left join (select split_part(s, ':', 1) as id, split_part(s, ':', 2) as tok
                                       from unnest(string_to_array(v_parts[1], ',')) s) x
                            on x.id = p ->> 'qbo_txn_id')
         where l.receipt_id = v_rid and l.outbox_id = new.id and jsonb_typeof(l.parts) = 'array';
      end if;
    exception when others then
      raise warning 'outbox_qbo_link_result: the charges of receipt % kept their old SyncTokens: %', v_rid, sqlerrm;
    end;
  elsif old.status is distinct from 'sent' then
    -- the worker marks a row dead only while sending it (outbox_failed, or
    -- the lease sweep), always with an error; any other death is a person's
    -- cancel, read as one however it was typed ("Cancelled: …", no error,
    -- or the last retry's error left in place). A row already sent is in
    -- QuickBooks: marking it dead afterwards changes nothing here.
    update public.receipt_qbo_links
       set state      = 'failed',
           detail     = (detail - 'refiled_proposal_id')
                        || jsonb_build_object('error',
                             case when old.status = 'sending' then coalesce(new.error, 'cancelled: marked dead by hand')
                                  else 'cancelled: ' || left(coalesce(nullif(btrim(regexp_replace(
                                         case when new.error is distinct from old.error then coalesce(new.error, '') else '' end,
                                         '^\s*cancell?ed\s*:?\s*', '', 'i')), ''), 'marked dead by hand'), 500)
                             end,
                             'failed_at', now()),
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
  'AFTER UPDATE OF status on outbox, channel qbo, status now sent or dead: marks the receipt_qbo_links row that wrote that outbox row done (provider id Purchase:<id>:<token>, sync token, and each charge''s new token from provider_status parts=) or failed (the worker''s error from sending; cancelled: <words> when a person marked a waiting row dead; a sent row stays done). Exception-guarded: it never fails the outbox update, and the charges'' tokens never undo the state (0023, 0025).';
revoke all on function public.outbox_qbo_link_result() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 7. Checks this file holds itself to before it commits.
-- ---------------------------------------------------------------------------
do $$
begin
  -- no other check still holds the type to Purchase alone
  if exists (select 1 from pg_constraint c
              where c.conrelid = 'public.receipt_qbo_links'::regclass and c.contype = 'c'
                and pg_get_constraintdef(c.oid) ~ 'qbo_txn_type'
                and pg_get_constraintdef(c.oid) !~ 'parts'
                and pg_get_constraintdef(c.oid) !~ 'Bill') then
    raise exception '0025: a check on receipt_qbo_links still allows only Purchase; drop it by name and re-run';
  end if;
  -- every row's claims are in place
  if exists (select 1 from public.receipt_qbo_links l
              where l.state in ('in_qbo', 'queued', 'done') and l.qbo_txn_id is not null
                and not exists (select 1 from public.receipt_qbo_claims c
                                 where c.qbo_txn_type = l.qbo_txn_type and c.qbo_txn_id = l.qbo_txn_id
                                   and c.receipt_id = l.receipt_id)) then
    raise exception '0025: a receipt''s QuickBooks transaction has no claim row';
  end if;
  -- the four replaced functions kept their one signature each
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('op_exec_receipts_qbo_link', 'receipts_qbo_link_file', 'receipt_qbo_links_note',
                           'outbox_qbo_link_result', 'receipt_qbo_links_claims')) <> 5 then
    raise exception '0025: a receipts function has an overload';
  end if;
end
$$;
