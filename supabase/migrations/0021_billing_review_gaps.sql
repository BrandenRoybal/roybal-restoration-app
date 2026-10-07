-- ============================================================================
-- 0021 — invoice.review_gaps: the nightly billing check files the work a job
--        documented but never billed, and the owner adds it with one approval
--        (phase 2, billing.reconcile v0).
--
-- WHAT IT IS FOR: a water job's drying logs, labor and Cat 3 steps record more
-- than its invoices bill, and today only someone rereading the job finds the
-- difference. The worker's new billing.reconcile queue kind (services/worker,
-- detector apps/field/js/reconcile.js) compares the two every night and files
-- what is missing as ONE proposal per job; approving it adds those lines to
-- the job as a new draft invoice. This file is the database half:
--
--   invoice.review_gaps@1          the catalog row: money, runtime sql, waits
--                                  on the owner (the seeded money policy)
--   billing_invoices_fingerprint   md5 of a job's non-void invoices (id,
--                                  billingModel, every line's desc, qty,
--                                  unit, price): what the proposal was filed
--                                  against. Internal
--   op_exec_invoice_review_gaps    the executor: under the job's row lock,
--                                  appends one new draft supplement invoice
--                                  with a deterministic id, rev + 1, a newer
--                                  updatedAt, and nothing else. Internal
--   billing_review_gaps_file       the filing door the worker calls: stamps
--                                  the fingerprint and the offer number,
--                                  files through op_propose as agent:billing,
--                                  offers an unanswered gap again, and
--                                  supersedes the job's older open proposal
--                                  (service_role only)
--   agent:billing may propose      the second agent_authority row: propose
--   invoice.review_gaps            only, with its agent_authority.granted event
--   billing-reconcile-nightly      pg_cron, 14:45 UTC (05:45/06:45 Alaska):
--                                  enqueue billing.reconcile for the Alaska
--                                  date, once per date (the key)
--
-- WHAT THIS CHANGES TODAY: from the first night the worker runs the new kind,
-- each water job in scope with documented-but-unbilled work gets one card in
-- the Approvals inbox. Nothing is written to a job until the owner approves a
-- card; a job whose invoices already cover the work gets nothing, and its open
-- card, if any, is superseded with superseded_reason no_gaps. Cards expire in
-- 14 days; a gap still there after its card expired or was superseded
-- unanswered is offered again the next night, while one the owner declined
-- stays quiet until the job's findings or invoice lines change (a payment
-- marking an invoice paid is not a change). billing.reconcile
-- is a queue kind, not a catalog operation, so nobody can propose it.
--
-- WHY A NEW INVOICE: the merge keeps a newer copy's invoice whole on an id
-- clash and never unions items[] (0002), so lines appended inside an invoice an
-- office device has open would be dropped by that device's next push, and the
-- next night would render the same key and get the executed row back: the
-- loss would never re-file. A new element with an id no device has survives
-- every merge. It carries no status and no qboInvoiceId, so billing totals,
-- the brief and QuickBooks ignore it until the office prices, reviews and
-- sends it; deductible and previousPayments stay blank so totals never count
-- them twice. Unpriced lines arrive with price "" and the flag "no rate on
-- this job: price it"; prices only ever come from this job's own invoices.
--
-- RUNTIME sql: approval runs the executor inline (0013 op_proposal_approve), so
-- the card shows the result at once and no worker takes part in the write.
-- APPROVAL: the owner only (the money policy of 0004, ruling 2026-09-06), in
-- the inbox only: proposals are filed proposed_via 'agent', never 'cron', and
-- roybal-notify (deployed before the worker; services/worker/README.md) skips
-- invoice.review_gaps in its spine reads, so no text answers one. An edited
-- approval may only drop lines.
--
-- EXACTLY ONCE: the approval is locked and idempotent and op_execute never
-- re-runs (0013); the executor finds its own deterministic invoice id, or the
-- office's tombstone of it, and writes nothing; and if the job's invoices
-- changed since filing, the fingerprint no longer matches and the run fails
-- with nothing written. The key carries the fingerprint, the findings hash
-- and an offer number, so the next night files a new state as a new
-- proposal, and the same state again (the next offer) only when its card
-- expired or was superseded with nobody answering it.
--
-- THE GRANT. The owner said go on 2026-10-07 for this phase, which includes
-- agent:billing proposing invoice.review_gaps. As in 0019, the
-- agent_authority.grant operation does not exist yet, so this file writes that
-- one row and its event, and skips it when any such row has ever existed, so
-- re-applying the file never revives a grant the owner revoked.
--
-- WHO: the executor and the fingerprint are callable by nobody (op_execute and
-- the door run them as postgres); the door by service_role alone. Owner
-- postgres throughout.
--
-- Census: +3 functions; tables, policies, triggers, views, enums, primary keys
-- and unique constraints unchanged. The catalog row, the grant and the cron row
-- are data.
-- Roles: the service role gains the door and agent:billing one propose grant;
-- owner, office, crew_lead, crew, viewer and anon read and write exactly what
-- they did before (the owner approves invoice.review_gaps as he approves every
-- money operation; office's money approval stays an explicit deny).
--
-- KILL SWITCH AND ROLLBACK: BILLING_RECONCILE=off on the worker makes every run
-- return {skipped: "off"} and file nothing. To stop the schedule,
-- select cron.unschedule('billing-reconcile-nightly'). To stop filing for good,
-- revoke the grant (update agent_authority set revoked_at = now() where
-- agent_id = agent:billing and operation = 'invoice.review_gaps'; the row and
-- its event stay, events is append-only): the door then refuses with 42501 and
-- the run records it. Open cards expire on their own; setting the catalog row's
-- deprecated_at makes them decline-only. Additive: dropping the three
-- functions restores the schema exactly as it was. An approved supplement is an
-- ordinary draft invoice the office can edit or delete.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The catalog row.
--
-- input_schema is the top-level subset op_validate_input checks (0013): it
-- never looks inside lines[] or hints[], so the executor checks every line
-- itself. invoice_fingerprint and offer are required but never sent by the
-- worker: the door stamps both (offer counts the earlier offers of this gap on
-- these invoices, 0 first; section 4). amount_field names the input total the
-- money policy would threshold against.
-- ---------------------------------------------------------------------------
insert into public.operation_catalog
  (name, version, action_type, description, input_schema, runtime, approval_default,
   amount_field, emits, idempotency_template, definition_sha)
select c.name, 1, 'money', c.description, c.input_schema::jsonb, 'sql', 'owner',
       'total_usd', array['invoice.review_gaps_applied'], c.idempotency_template,
       md5(c.name || '@1:' || c.input_schema::jsonb::text)
  from (values
    ('invoice.review_gaps',
     'Add the lines the nightly billing check found documented but not billed. Execution appends them to the job as one new draft supplement invoice; it never edits an existing invoice, and it refuses if the job''s invoices changed since the proposal was filed.',
     '{"type": "object", "additionalProperties": false,
       "required": ["job_id", "invoice_fingerprint", "offer", "findings_hash", "lines", "total_usd", "detector"],
       "properties": {
         "job_id":              {"type": "string", "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},
         "invoice_fingerprint": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
         "offer":               {"type": "integer"},
         "findings_hash":       {"type": "string", "pattern": "^[0-9a-f]{32}$"},
         "base_rev":            {"type": "integer"},
         "rate_invoice_id":     {"type": "string", "maxLength": 64},
         "rate_invoice_no":     {"type": "string", "maxLength": 60},
         "sent":                {"type": "boolean"},
         "lines":               {"type": "array"},
         "hints":               {"type": "array"},
         "total_usd":           {"type": "number"},
         "unpriced_count":      {"type": "integer"},
         "detector":            {"type": "string", "maxLength": 40, "pattern": "^billing\\.reconcile@[0-9.]+$"},
         "limits":              {"type": "string", "maxLength": 600}}}',
     'invoice.review_gaps:{job_id}:{invoice_fingerprint}:{findings_hash}:{offer}')
  ) as c(name, description, input_schema, idempotency_template)
on conflict (name, version) do nothing;


-- ---------------------------------------------------------------------------
-- 2. billing_invoices_fingerprint — what a review_gaps proposal was filed
--    against.
--
-- md5 of every non-void invoice in the blob, ordered by id, each as {id,
-- billingModel, items: [{desc, qty, unit, price}] in array order}. Values are
-- compared as stored (the string "3" and the number 3 differ), so any edit to
-- a line's description, quantity, unit or price, voiding an invoice, and any
-- new or removed invoice moves it. A non-void status change does not (the
-- office sending a draft, or the QuickBooks payment pull marking one paid at
-- 14:30 UTC): it bills nothing new, and hashing it would re-file a gap the
-- owner declined and fail an approval over a payment. Notes, terms, O&P and
-- the order of the invoices array do not move it either. Only SQL computes it:
-- the door stamps it into the proposal and the executor compares it under the
-- row lock.
-- ---------------------------------------------------------------------------
create or replace function public.billing_invoices_fingerprint(p_data jsonb) returns text
  language sql
  immutable
  set search_path to 'public', 'pg_temp'
as $$
  select md5(coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',           inv -> 'id',
        'billingModel', inv -> 'billingModel',
        'items',        coalesce((
          select jsonb_agg(jsonb_build_object('desc', it -> 'desc', 'qty', it -> 'qty',
                                              'unit', it -> 'unit', 'price', it -> 'price')
                           order by io)
            from jsonb_array_elements(case when jsonb_typeof(inv -> 'items') = 'array'
                                           then inv -> 'items' else '[]'::jsonb end)
                 with ordinality as li(it, io)), '[]'::jsonb))
      order by (inv ->> 'id') collate "C", ord),
    '[]'::jsonb)::text)
    from jsonb_array_elements(case when jsonb_typeof(p_data -> 'invoices') = 'array'
                                   then p_data -> 'invoices' else '[]'::jsonb end)
         with ordinality as x(inv, ord)
   where jsonb_typeof(inv) = 'object'
     and coalesce(inv ->> 'status', '') <> 'void';
$$;

alter function public.billing_invoices_fingerprint(jsonb) owner to postgres;
comment on function public.billing_invoices_fingerprint(jsonb) is
  'md5 hex of a field_projects blob''s non-void invoices ordered by id, each {id, billingModel, items:[{desc, qty, unit, price}]} (a non-void status change does not move it; voiding does): what an invoice.review_gaps proposal was filed against. Internal: the filing door stamps it and op_exec_invoice_review_gaps compares it (0021).';
revoke all on function public.billing_invoices_fingerprint(jsonb) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. op_exec_invoice_review_gaps — the executor. Called only by op_execute
--    (0013), inside the owner's approval, as postgres.
--
-- Every line is checked here, because op_validate_input never looks inside
-- lines[]. Content always comes from the proposal's own input: an edited
-- approval selects which of its lines to keep (edited_params.lines, matched by
-- finding_id) and can change nothing else.
--
-- The write follows restore_photo (0000): the row lock, rev + 1 so a device on
-- the old base merges instead of overwriting, and updatedAt strictly newer
-- (greatest(stored, now()) + 1 ms) so clean devices adopt the row. No
-- lock_timeout: a lock timeout is an error op_execute catches, which would
-- fail the proposal for good over a busy row, while a statement cancel is not
-- caught, so the whole approval rolls back and the card can be approved again.
--
-- result: {status: added | already_present | deleted_by_office, invoice_id,
-- lines_added, total_usd, unpriced, rev}. Only added writes the job and emits
-- invoice.review_gaps_applied; the other two write nothing.
-- ---------------------------------------------------------------------------
create or replace function public.op_exec_invoice_review_gaps(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_in       jsonb := p_proposal.input;
  v_job      uuid  := p_proposal.job_id;
  v_inv      text  := md5('invoice.review_gaps:' || p_proposal.id::text)::uuid::text;
  v_lines    jsonb;
  v_sel      jsonb;
  v_line     jsonb;
  v_i        bigint;
  v_fid      text;
  v_ids      text[] := '{}';
  v_keep     text[];
  v_problems text[] := '{}';
  v_data     jsonb;
  v_deleted  boolean;
  v_rev      bigint;
  v_rate     jsonb;
  v_items    jsonb;
  v_count    integer;
  v_unpriced integer;
  v_total    numeric;
  v_amount   boolean;
  v_elem     jsonb;
  v_ts_cur   timestamptz;
  v_ts_new   timestamptz;
  v_approved timestamptz := coalesce(p_proposal.approved_at, now());
  v_rc       integer;
begin
  -- 1. the input, line by line, as billing.reconcile files it
  if v_job is null or lower(coalesce(v_in ->> 'job_id', '')) <> v_job::text then
    raise exception 'invoice.review_gaps: input job_id % is not the proposal''s job %', v_in ->> 'job_id', v_job;
  end if;
  v_lines := v_in -> 'lines';
  if coalesce(jsonb_array_length(case when jsonb_typeof(v_lines) = 'array' then v_lines end), 0)
     not between 1 and 40 then
    raise exception 'invoice.review_gaps: lines must be an array of 1 to 40 lines';
  end if;

  for v_line, v_i in select e, o from jsonb_array_elements(v_lines) with ordinality as t(e, o) loop
    if jsonb_typeof(v_line) <> 'object' then
      v_problems := v_problems || format('line %s is not an object', v_i);
      continue;
    end if;
    v_fid := v_line ->> 'finding_id';
    if jsonb_typeof(v_line -> 'finding_id') is distinct from 'string' or v_fid !~ '^[a-z0-9_:.-]{1,80}$' then
      v_problems := v_problems || format('line %s has a bad finding_id', v_i);
    elsif v_fid = any (v_ids) then
      v_problems := v_problems || format('finding_id %s appears twice', v_fid);
    else
      v_ids := v_ids || v_fid;
    end if;
    if jsonb_typeof(v_line -> 'desc') is distinct from 'string'
       or length(btrim(v_line ->> 'desc')) = 0 or length(v_line ->> 'desc') > 300 then
      v_problems := v_problems || format('line %s needs a desc of 1 to 300 characters', v_i);
    end if;
    if (case coalesce(jsonb_typeof(v_line -> 'qty'), 'null')
          when 'null' then false
          when 'number' then (v_line ->> 'qty')::numeric < 0
          else true end) then
      v_problems := v_problems || format('line %s qty must be a number of at least 0, or null', v_i);
    end if;
    if jsonb_typeof(v_line -> 'unit') is distinct from 'string'
       or (v_line ->> 'unit') not in ('EA', 'DA', 'HR', 'SF', 'LF', 'LS') then
      v_problems := v_problems || format('line %s unit must be one of EA DA HR SF LF LS', v_i);
    end if;
    if (case coalesce(jsonb_typeof(v_line -> 'price'), 'null')
          when 'null' then false
          when 'number' then (v_line ->> 'price')::numeric < 0
          else true end) then
      v_problems := v_problems || format('line %s price must be a number of at least 0, or null', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'amount'), 'null') not in ('number', 'null') then
      v_problems := v_problems || format('line %s amount must be a number or null', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'class'), 'null') not in ('string', 'null') then
      v_problems := v_problems || format('line %s class must be text', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'room'), 'null') not in ('string', 'null')
       or length(v_line ->> 'room') > 60 then
      v_problems := v_problems || format('line %s room must be text of at most 60 characters', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'code'), 'null') not in ('string', 'null')
       or length(v_line ->> 'code') > 20 then
      v_problems := v_problems || format('line %s code must be text of at most 20 characters', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'basis'), 'null') not in ('string', 'null')
       or length(v_line ->> 'basis') > 300 then
      v_problems := v_problems || format('line %s basis must be text of at most 300 characters', v_i);
    end if;
    if coalesce(jsonb_typeof(v_line -> 'refs'), 'null') not in ('array', 'null')
       or coalesce(jsonb_array_length(case when jsonb_typeof(v_line -> 'refs') = 'array'
                                           then v_line -> 'refs' end), 0) > 10 then
      v_problems := v_problems || format('line %s refs must be a list of at most 10', v_i);
    end if;
  end loop;
  if array_length(v_problems, 1) is not null then
    raise exception 'invoice.review_gaps: the proposal''s lines are invalid: %', array_to_string(v_problems, '; ');
  end if;

  -- 2. which lines to add: op_execute hands over input || edited_params, so
  --    p_params.lines is the owner's selection when he edited, else every line
  v_sel := p_params -> 'lines';
  if jsonb_typeof(v_sel) is distinct from 'array' then
    raise exception 'invoice.review_gaps: the approved lines are not a list';
  end if;
  select coalesce(array_agg(e ->> 'finding_id'), '{}') into v_keep from jsonb_array_elements(v_sel) e;
  if exists (select 1 from unnest(v_keep) k where k is null or not (k = any (v_ids))) then
    raise exception 'invoice.review_gaps: an approval may only drop lines; it named a line the proposal does not hold';
  end if;
  select jsonb_agg(e order by o) into v_lines
    from jsonb_array_elements(v_in -> 'lines') with ordinality as t(e, o)
   where e ->> 'finding_id' = any (v_keep);
  if v_lines is null then
    raise exception 'invoice.review_gaps: the approval kept no lines';
  end if;

  -- 3. the job, locked
  select data, deleted into v_data, v_deleted
    from public.field_projects where id = v_job for update;
  if not found then
    raise exception 'invoice.review_gaps: job % does not exist', v_job;
  end if;
  if v_deleted then
    raise exception 'invoice.review_gaps: job % is deleted', v_job;
  end if;
  begin
    v_rev := coalesce((v_data ->> 'rev')::numeric, 0)::bigint;
  exception when others then
    v_rev := 0;
  end;

  -- 4. already applied, or the office deleted what was applied: write nothing,
  --    and never bring a deleted invoice back (the tombstone outranks a merge)
  if exists (select 1
               from jsonb_array_elements(case when jsonb_typeof(v_data -> 'invoices') = 'array'
                                              then v_data -> 'invoices' else '[]'::jsonb end) e
              where jsonb_typeof(e) = 'object' and e ->> 'id' = v_inv) then
    return jsonb_build_object('status', 'already_present', 'invoice_id', v_inv, 'lines_added', 0,
                              'total_usd', 0, 'unpriced', 0, 'rev', v_rev);
  end if;
  if jsonb_typeof(v_data -> 'deletedIds') = 'object' and (v_data -> 'deletedIds') ? v_inv then
    return jsonb_build_object('status', 'deleted_by_office', 'invoice_id', v_inv, 'lines_added', 0,
                              'total_usd', 0, 'unpriced', 0, 'rev', v_rev);
  end if;

  -- 5. the invoices the owner saw are still the invoices on the job
  if public.billing_invoices_fingerprint(v_data) is distinct from v_in ->> 'invoice_fingerprint' then
    raise exception 'invoice.review_gaps: the job''s invoices changed since this was proposed, so nothing was added; the nightly check files a fresh card if the work is still unbilled and the job is still one it checks (not archived, not every invoice paid)';
  end if;

  -- 6. the new element: newInvoice's shape (apps/field/js/model.js), lines as
  --    strings the way blankLineItem stores them, ids deterministic
  select e into v_rate
    from jsonb_array_elements(case when jsonb_typeof(v_data -> 'invoices') = 'array'
                                   then v_data -> 'invoices' else '[]'::jsonb end) e
   where jsonb_typeof(e) = 'object' and e ->> 'id' = v_in ->> 'rate_invoice_id'
   limit 1;

  select jsonb_agg(jsonb_build_object(
           'id',     md5(p_proposal.id::text || ':' || (e ->> 'finding_id'))::uuid::text,
           'room',   coalesce(e ->> 'room', ''),
           'desc',   e ->> 'desc',
           'qty',    case when jsonb_typeof(e -> 'qty') = 'number' then e ->> 'qty' else '' end,
           'unit',   e ->> 'unit',
           'price',  case when jsonb_typeof(e -> 'price') = 'number' then e ->> 'price' else '' end,
           'code',   coalesce(e ->> 'code', ''),
           'priced', case when jsonb_typeof(e -> 'price') = 'number' then 'invoice_rate' else 'flag' end,
           'flag',   case when jsonb_typeof(e -> 'price') = 'number' then 'review_gaps'
                          else 'no rate on this job: price it' end,
           'basis',  coalesce(e ->> 'basis', ''))
         order by o),
         count(*),
         count(*) filter (where jsonb_typeof(e -> 'price') is distinct from 'number'),
         round(coalesce(sum((e ->> 'qty')::numeric * (e ->> 'price')::numeric)
                          filter (where jsonb_typeof(e -> 'qty') = 'number'
                                    and jsonb_typeof(e -> 'price') = 'number'), 0), 2)
    into v_items, v_count, v_unpriced, v_total
    from jsonb_array_elements(v_lines) with ordinality as t(e, o);

  -- O&P and tax follow the invoice the rates came from, frozen (opAuto false).
  -- Fixed-dollar O&P (opMode amount) is NOT copied: it is already on that
  -- invoice, so the supplement starts with none and the office sets it. With
  -- no rate invoice the supplement takes newInvoice's defaults and the editor's
  -- O&P rule.
  v_amount := v_rate ->> 'opMode' = 'amount';
  v_elem := jsonb_build_object(
    'id',               v_inv,
    'by',               'Billing check',
    'createdAt',        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'invoiceNo',        '',
    'invoiceDate',      to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD'),
    'dueDate',          '',
    'terms',            coalesce(nullif(v_rate ->> 'terms', ''), 'Due on receipt'),
    -- lossSummary and notes print on the invoice and become the QuickBooks
    -- CustomerMemo: customer wording only. Where it came from rides reviewGaps,
    -- which nothing prints.
    'lossSummary',      'Supplemental mitigation charges',
    'items',            v_items,
    'billingModel',     'tm',
    'contractAmount',   '',
    'opMode',           case when v_amount then 'amount' else 'pct' end,
    'opAuto',           v_rate is null,
    'scopeInterview',   null,
    'overheadPct',      case when v_rate is null then to_jsonb('10'::text)
                             else coalesce(v_rate -> 'overheadPct', to_jsonb(''::text)) end,
    'profitPct',        case when v_rate is null then to_jsonb('10'::text)
                             else coalesce(v_rate -> 'profitPct', to_jsonb(''::text)) end,
    'overheadAmount',   '',
    'profitAmount',     '',
    'deductible',       '',
    'previousPayments', '',
    'taxRate',          coalesce(v_rate -> 'taxRate', to_jsonb(''::text)),
    'notes',            '',
    'attachments',      '[]'::jsonb,
    'reviewGaps',       jsonb_build_object(
                          'proposalId',   p_proposal.id,
                          'findingsHash', v_in ->> 'findings_hash',
                          'approvedAt',   to_char(v_approved at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));

  -- 7. the write: the new element, rev + 1, updatedAt strictly newer
  begin v_ts_cur := (v_data ->> 'updatedAt')::timestamptz; exception when others then v_ts_cur := null; end;
  v_ts_new := greatest(coalesce(v_ts_cur, to_timestamp(0)), now()) + interval '1 millisecond';

  update public.field_projects
     set data = jsonb_set(
                  jsonb_set(
                    jsonb_set(v_data, '{invoices}',
                      coalesce(case when jsonb_typeof(v_data -> 'invoices') = 'array'
                                    then v_data -> 'invoices' end, '[]'::jsonb) || jsonb_build_array(v_elem)),
                    '{rev}', to_jsonb(v_rev + 1)),
                  '{updatedAt}',
                  to_jsonb(to_char(v_ts_new at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = v_job;
  get diagnostics v_rc = row_count;
  if v_rc = 0 then
    raise exception 'invoice.review_gaps: job % vanished, retry', v_job;
  end if;

  perform public.emit_event(
    'invoice.review_gaps_applied', p_proposal.operation, 'field_project', v_job, v_job, p_proposal.claim_id, p_proposal.id,
    jsonb_build_object('invoice_id', v_inv, 'lines_added', v_count, 'total_usd', v_total, 'rev', v_rev + 1),
    'invoice.review_gaps_applied:' || p_proposal.id, p_principal_kind, p_principal_id);

  return jsonb_build_object('status', 'added', 'invoice_id', v_inv, 'lines_added', v_count,
                            'total_usd', v_total, 'unpriced', v_unpriced, 'rev', v_rev + 1);
end;
$$;

alter function public.op_exec_invoice_review_gaps(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_invoice_review_gaps(public.proposals, jsonb, text, uuid) is
  'Executor for invoice.review_gaps@1: under the field_projects row lock, appends one new draft invoice (id md5(''invoice.review_gaps:''||proposal id)) holding the approved lines, rev + 1, updatedAt strictly newer, nothing else; emits invoice.review_gaps_applied. Writes nothing when that invoice is already there or tombstoned; fails when the job''s invoices changed since filing. An edited approval may only drop lines (0021).';
revoke all on function public.op_exec_invoice_review_gaps(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. billing_review_gaps_file — the filing door the worker calls.
--
-- With lines (p_input not null): checks the job still exists, is not deleted
-- and is at the rev the worker read (p_base_rev), stamps the invoice
-- fingerprint and the offer number, and files through op_propose as
-- agent:billing (proposed_via 'agent', expiry 14 days by default). A new
-- proposal supersedes the job's other open invoice.review_gaps rows
-- (result.superseded_by, and its own supersedes_id names the newest of them).
-- With no gaps (p_input null) it supersedes the open rows with
-- result.superseded_reason no_gaps. Each superseded row gets a
-- proposal.superseded event.
--
-- THE OFFER (Q8, ruled 2026-10-07): the key is the job, the fingerprint, the
-- findings hash and the offer, and the door tries offer 0, 1, 2 … in turn. A
-- free key is filed. A key whose card expired or was superseded, so nobody
-- answered it, moves on to the next offer: the same gap on the same invoices
-- comes back as a fresh card. A key whose card is still open returns it,
-- unchanged. Any other status (declined, failed, approved, executing,
-- executed) stays quiet, because the owner already answered these findings on
-- these invoices; the job's other open rows are then superseded with
-- result.superseded_reason findings_changed, since they hold findings
-- tonight's check no longer makes. After 50 offers (0–49) the gap stays quiet
-- the same way. op_expire_proposals runs first, so a card past its expiry
-- that no sweep has marked yet counts as expired, not open.
--
-- Superseding is UPDATE … WHERE status = 'proposed', which takes each row's
-- lock and re-reads its status after any concurrent approval commits, so a
-- row the owner approved meanwhile is left to run. The per-job advisory lock
-- keeps two filings for one job from missing each other.
--
-- Returns exactly one of
--   {filed: true,  proposal_id, status: "proposed", superseded: n}
--   {filed: false, proposal_id, status: "proposed", superseded: 0}   (still open)
--   {filed: false, proposal_id, status: <its status>, superseded: n} (quiet)
--   {filed: false, superseded: n}                                    (no gaps)
--   {skipped: "missing" | "deleted" | "rev_moved"}
-- and raises on a malformed input, or 42501 from op_propose when agent:billing
-- holds no live grant.
-- ---------------------------------------------------------------------------
create or replace function public.billing_review_gaps_file(
  p_job_id        uuid,
  p_base_rev      integer,
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
  v_agent     constant uuid := '193d7dd0-74f9-407d-9891-8cb7aab22f82';   -- agent:billing (0004 seed)
  v_offers    constant integer := 50;   -- offers 0–49 of one gap on one set of invoices
  v_data      jsonb;
  v_deleted   boolean;
  v_rev       numeric;
  v_fp        text;
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
    raise exception 'billing_review_gaps_file: job id is required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_input is not null then
    if jsonb_typeof(p_input) <> 'object' then
      raise exception 'billing_review_gaps_file: input must be a JSON object'
        using errcode = 'invalid_parameter_value';
    end if;
    if lower(coalesce(p_input ->> 'job_id', '')) <> p_job_id::text then
      raise exception 'billing_review_gaps_file: input job_id % is not job %', p_input ->> 'job_id', p_job_id
        using errcode = 'invalid_parameter_value';
    end if;
    if coalesce(jsonb_array_length(case when jsonb_typeof(p_input -> 'lines') = 'array'
                                        then p_input -> 'lines' end), 0) not between 1 and 40 then
      raise exception 'billing_review_gaps_file: lines must be an array of 1 to 40 lines; send a null input when there are no gaps'
        using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from jsonb_array_elements(p_input -> 'lines') e
                where jsonb_typeof(e) <> 'object'
                   or jsonb_typeof(e -> 'finding_id') is distinct from 'string'
                   or (e ->> 'finding_id') !~ '^[a-z0-9_:.-]{1,80}$')
       or (select count(distinct e ->> 'finding_id') from jsonb_array_elements(p_input -> 'lines') e)
          <> jsonb_array_length(p_input -> 'lines') then
      raise exception 'billing_review_gaps_file: every line needs its own finding_id'
        using errcode = 'invalid_parameter_value';
    end if;
    if coalesce(jsonb_array_length(case when jsonb_typeof(p_input -> 'hints') = 'array'
                                        then p_input -> 'hints' end), 0) > 20 then
      raise exception 'billing_review_gaps_file: at most 20 hints'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_evidence_refs is not null and jsonb_typeof(p_evidence_refs) <> 'array' then
    raise exception 'billing_review_gaps_file: evidence_refs must be a JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice.review_gaps:' || p_job_id::text, 0));

  select data, deleted into v_data, v_deleted from public.field_projects where id = p_job_id;
  if not found then
    return jsonb_build_object('skipped', 'missing');
  end if;
  if v_deleted then
    return jsonb_build_object('skipped', 'deleted');
  end if;
  begin
    v_rev := (v_data ->> 'rev')::numeric;
  exception when others then
    v_rev := null;
  end;
  if v_rev is distinct from p_base_rev::numeric then
    return jsonb_build_object('skipped', 'rev_moved');
  end if;

  if p_input is null then
    v_result := jsonb_build_object('superseded_reason', 'no_gaps');
  else
    perform public.op_expire_proposals();   -- a card past its expiry is expired, not open
    v_fp := public.billing_invoices_fingerprint(v_data);
    v_op := public.op_catalog_lookup('invoice.review_gaps');
    -- the first offer that is free, still open, or was answered
    for v_offer in 0 .. v_offers - 1 loop
      v_input := p_input || jsonb_build_object('invoice_fingerprint', v_fp, 'offer', v_offer);
      v_key := public.op_render_key(v_op.idempotency_template, v_op.name, v_input, p_job_id);
      select * into v_prev from public.proposals where idempotency_key = v_key;
      exit when v_prev.id is null or v_prev.status not in ('expired', 'superseded');
    end loop;

    if v_prev.id is null then
      v_row := public.op_propose('invoice.review_gaps', v_input, p_job_id, null, p_rationale,
                                 coalesce(p_evidence_refs, '[]'::jsonb), 'agent', v_agent, p_expires_in);
      v_result := jsonb_build_object('superseded_by', v_row.id);
    elsif v_prev.status = 'proposed' then
      return jsonb_build_object('filed', false, 'proposal_id', v_prev.id, 'status', 'proposed', 'superseded', 0);
    else
      v_result := jsonb_build_object('superseded_reason', 'findings_changed');
    end if;
  end if;

  for r in
    update public.proposals p
       set status = 'superseded', result = v_result
     where p.job_id = p_job_id
       and p.operation like 'invoice.review\_gaps@%'
       and p.status = 'proposed'
       and p.expires_at > now()
       and p.id is distinct from v_row.id
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

  if p_input is null then
    return jsonb_build_object('filed', false, 'superseded', v_n);
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

alter function public.billing_review_gaps_file(uuid, integer, jsonb, text, jsonb, interval) owner to postgres;
comment on function public.billing_review_gaps_file(uuid, integer, jsonb, text, jsonb, interval) is
  'The filing door for invoice.review_gaps (worker, billing.reconcile): checks the job is live and at p_base_rev, stamps billing_invoices_fingerprint and the offer number into the input, files through op_propose as agent:billing (proposed_via agent), and supersedes the job''s other open review_gaps rows; a null input supersedes them as no_gaps. The same findings on the same invoices are offered again (offer + 1, at most 50 offers) only when the last card expired or was superseded; an open card is returned as is, and a declined, failed or executed one stays quiet and supersedes the job''s other open rows as findings_changed. Returns {filed, proposal_id, status, superseded} or {skipped}. service_role only (0021).';
revoke all on function public.billing_review_gaps_file(uuid, integer, jsonb, text, jsonb, interval) from public, anon, authenticated;
grant execute on function public.billing_review_gaps_file(uuid, integer, jsonb, text, jsonb, interval) to service_role;


-- ---------------------------------------------------------------------------
-- 5. agent:billing may PROPOSE invoice.review_gaps — the owner's go,
--    2026-10-07.
--
-- The bare name, as op_agent_permits matches it (0013). Propose only: no other
-- money operation, never execute, and no agent can approve.
-- ---------------------------------------------------------------------------
do $$
declare
  v_agent  constant uuid := '193d7dd0-74f9-407d-9891-8cb7aab22f82';   -- agent:billing (0004 seed)
  v_reason constant text :=
    'Phase 2 billing check: the nightly billing.reconcile run files each job''s documented-but-unbilled lines '
    || 'as one invoice.review_gaps proposal; the owner approves every one in the inbox. '
    || 'Granted by migration 0021 on the owner''s go, 2026-10-07.';
  v_id     uuid;
begin
  if not exists (select 1 from public.agents where id = v_agent) then
    raise exception '0021: agent:billing (agents %) is missing; 0004 seeds it', v_agent;
  end if;

  insert into public.agent_authority as aa
    (agent_id, operation, capability, granted_by_kind, granted_by_id, reason)
  select v_agent, 'invoice.review_gaps', 'propose', 'system', null, v_reason
   where not exists (select 1 from public.agent_authority x
                      where x.agent_id = v_agent and x.operation = 'invoice.review_gaps'
                        and x.capability = 'propose')
  on conflict (agent_id, operation, capability) where revoked_at is null do nothing
  returning aa.id into v_id;

  if v_id is not null then
    perform public.emit_event(
      'agent_authority.granted', null, 'agent_authority', v_id, null, null, null,
      jsonb_build_object('agent_id', v_agent, 'agent', 'agent:billing',
                         'operation', 'invoice.review_gaps', 'capability', 'propose',
                         'reason', v_reason, 'granted_by', 'migration 0021'),
      'agent_authority.granted:' || v_id, 'system', null);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 6. Every catalog operation that can be proposed has an executor, whatever
--    its runtime: a worker-runtime op runs through op_execute too (0013), so
--    0014's sql-only check is widened here.
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
-- 7. The nightly run. 14:45 UTC is after the QB Time pull (14:00) and the QBO
--    payment pull (14:30), and before the morning brief (15:00). The Alaska
--    date is the key, so a second firing the same day is the same queue row.
--    Priority -10 lets approvals (0) go first. cron.schedule is idempotent on
--    the name; the job runs as postgres, which owns enqueue.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0021: pg_cron is not installed here; billing-reconcile-nightly not scheduled';
    return;
  end if;
  perform cron.schedule('billing-reconcile-nightly', '45 14 * * *', $cmd$select public.enqueue(
    'billing.reconcile',
    jsonb_build_object('run_date', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')),
    'billing.reconcile:' || to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD'),
    now(), -10, 'agent', '193d7dd0-74f9-407d-9891-8cb7aab22f82'::uuid)$cmd$);
end
$$;
