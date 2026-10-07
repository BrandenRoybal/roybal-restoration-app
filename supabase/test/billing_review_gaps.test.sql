-- ============================================================================
-- Assertions for 0021_billing_review_gaps.sql (phase 2: the nightly billing
-- check files invoice.review_gaps proposals, and the owner's approval adds the
-- lines to the job as a new draft supplement invoice).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/billing_review_gaps.test.sql <staging url>
-- Everything it writes is rolled back (sequence values it draws are not; that
-- is what every proposal does anyway).
--
-- The rules it holds 0021 to:
--   1. The catalog row is money, runtime sql, owner-approved, with the
--      template, emits, amount field and schema the worker and the inbox
--      read; billing.reconcile is a queue kind, never an operation; every
--      proposable operation has an executor.
--   2. The fingerprint and the executor are callable by nobody, the filing
--      door by service_role alone; all three are owned by postgres with a
--      pinned search_path. (The agent:billing grant itself is
--      contract_tables.test.sql 12 and spine_lanes.test.sql 2b.)
--   3. Where pg_cron exists, billing-reconcile-nightly is scheduled at 14:45
--      UTC, active, and (9) its command enqueues one billing.reconcile row
--      per Alaska date for agent:billing.
--   4. The fingerprint moves with every billed field of every non-void
--      invoice and with nothing else: a status change short of void (a
--      payment, the office sending it) does not move it.
--   5. The door returns each of its shapes, refuses malformed input, files as
--      agent:billing (proposed_via agent, waiting on the owner, 14 days),
--      stamps offer 0 into the input and the key, returns the open row for a
--      repeated key, and supersedes the older open row (superseded_by).
--   6. Office cannot approve; the owner's approval runs inline and appends
--      exactly one invoice element with the deterministic id, rev + 1, a
--      strictly newer updatedAt and nothing else; an edit can only drop lines
--      and changes no line's content; unpriced lines carry price "" and the
--      flag text; running it again changes nothing. With no gaps the door
--      supersedes the open row (no_gaps), and the same gap filed again after
--      that is offered again (offer 1). O&P follows the rate invoice, never
--      its fixed dollars.
--   7. Changed invoices fail the run with nothing written; a tombstoned
--      supplement is never brought back; an edit naming a line the proposal
--      does not hold, or keeping none, fails; the executor checks every line.
--      Refiled, a failed or executed gap stays quiet (and supersedes the
--      job's other open row, findings_changed), and new invoices file afresh.
--   8. Only the service role reaches the door, and nobody the fingerprint; a
--      revoked grant is op_propose's 42501, through the door.
--  10. The offer (Q8): an unchanged gap whose card expired (marked by a sweep
--      or only past its expiry) or was superseded is offered again as the
--      next offer; an open one is returned unchanged; a declined one stays
--      quiet, superseding the job's other open row (findings_changed), until
--      the invoice lines change (a payment is not a change, and a card filed
--      before one still approves); after 50 offers the gap stays quiet.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the catalog row
do $$
declare
  c public.operation_catalog;
  r record;
begin
  select * into c from public.operation_catalog where name = 'invoice.review_gaps' and version = 1;
  if not found then
    raise exception 'operation_catalog has no invoice.review_gaps@1';
  end if;
  if c.action_type <> 'money' or c.runtime <> 'sql' or c.approval_default <> 'owner'
     or c.amount_field is distinct from 'total_usd' or c.emits <> array['invoice.review_gaps_applied']
     or c.idempotency_template is distinct from 'invoice.review_gaps:{job_id}:{invoice_fingerprint}:{findings_hash}:{offer}'
     or c.deprecated_at is not null then
    raise exception 'invoice.review_gaps@1 is %/%/%, amount %, emits %, template %, deprecated %',
      c.action_type, c.runtime, c.approval_default, c.amount_field, c.emits, c.idempotency_template, c.deprecated_at;
  end if;
  if c.definition_sha <> md5(c.name || '@1:' || c.input_schema::text) then
    raise exception 'invoice.review_gaps@1 definition_sha is not md5(name@1:schema)';
  end if;
  -- the inbox titles a card with the description's first sentence
  if c.description not like 'Add the lines the nightly billing check found documented but not billed. %' then
    raise exception 'invoice.review_gaps@1 description starts %', left(c.description, 80);
  end if;
  if c.input_schema -> 'required'
     <> '["job_id", "invoice_fingerprint", "offer", "findings_hash", "lines", "total_usd", "detector"]'::jsonb
     or (c.input_schema ->> 'additionalProperties')::boolean is distinct from false then
    raise exception 'invoice.review_gaps@1 schema requires % (additionalProperties %)',
      c.input_schema -> 'required', c.input_schema -> 'additionalProperties';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k)
     <> array['base_rev', 'detector', 'findings_hash', 'hints', 'invoice_fingerprint', 'job_id', 'limits',
              'lines', 'offer', 'rate_invoice_id', 'rate_invoice_no', 'sent', 'total_usd', 'unpriced_count'] then
    raise exception 'invoice.review_gaps@1 schema fields are %',
      (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k);
  end if;
  -- the door stamps offer, an integer, as it stamps the fingerprint
  if c.input_schema #>> '{properties,offer,type}' is distinct from 'integer' then
    raise exception 'invoice.review_gaps@1 offer is %', c.input_schema #> '{properties,offer}';
  end if;
  if exists (select 1 from public.operation_catalog where name = 'billing.reconcile') then
    raise exception 'billing.reconcile is catalogued; it is a queue kind, and a catalogued name is proposable';
  end if;

  for r in
    select name from public.operation_catalog
     where deprecated_at is null and runtime in ('sql', 'worker')
       and name not in ('proposal.approve', 'proposal.decline')
  loop
    if to_regprocedure(format('public.%I(public.proposals, jsonb, text, uuid)',
                              'op_exec_' || replace(r.name, '.', '_'))) is null then
      raise exception '% has no op_exec_ executor', r.name;
    end if;
  end loop;
end
$$;


-- 2. the three functions and their grants
do $$
declare
  fp   constant text := 'public.billing_invoices_fingerprint(jsonb)';
  ex   constant text := 'public.op_exec_invoice_review_gaps(public.proposals, jsonb, text, uuid)';
  door constant text := 'public.billing_review_gaps_file(uuid, integer, jsonb, text, jsonb, interval)';
  f text;
  problems text[] := '{}';
begin
  foreach f in array array[fp, ex, door] loop
    if to_regprocedure(f) is null then
      problems := problems || format('%s is missing', f);
      continue;
    end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = f::regprocedure) <> 'postgres' then
      problems := problems || format('%s is not owned by postgres', f);
    end if;
    if not coalesce((select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where oid = f::regprocedure), false) then
      problems := problems || format('%s has no pinned search_path', f);
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      problems := problems || format('anon can execute %s', f);
    end if;
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('authenticated can execute %s', f);
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'billing review gaps functions are wrong: %', array_to_string(problems, '; ');
  end if;

  if has_function_privilege('service_role', fp, 'EXECUTE') then
    problems := problems || 'service_role can execute the fingerprint'::text;
  end if;
  if has_function_privilege('service_role', ex, 'EXECUTE') then
    problems := problems || 'service_role can execute the executor'::text;
  end if;
  if not has_function_privilege('service_role', door, 'EXECUTE') then
    problems := problems || 'service_role cannot execute the filing door'::text;
  end if;
  if (select provolatile from pg_proc where oid = fp::regprocedure) <> 'i' then
    problems := problems || 'the fingerprint is not IMMUTABLE'::text;
  end if;
  if not (select prosecdef from pg_proc where oid = ex::regprocedure)
     or not (select prosecdef from pg_proc where oid = door::regprocedure) then
    problems := problems || 'the executor or the door is not SECURITY DEFINER'::text;
  end if;
  if pg_get_function_arguments(door::regprocedure) !~ 'p_expires_in interval DEFAULT ''14 days''::interval' then
    problems := problems || format('the door''s expiry default is not 14 days: %s', pg_get_function_arguments(door::regprocedure));
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'billing review gaps grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 3. the nightly cron row, where pg_cron exists
do $$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed here; billing-reconcile-nightly not checked';
    return;
  end if;
  select * into j from cron.job where jobname = 'billing-reconcile-nightly';
  if not found or not j.active then
    raise exception 'billing-reconcile-nightly is not scheduled and active';
  end if;
  if j.schedule <> '45 14 * * *' then
    raise exception 'billing-reconcile-nightly runs at %, not 45 14 * * *', j.schedule;
  end if;
  if j.command !~ 'public\.enqueue\(' or j.command !~ '''billing\.reconcile''' or j.command !~ '''run_date'''
     or j.command !~ '''billing\.reconcile:''' or j.command !~ 'America/Anchorage' or j.command !~ '-10'
     or j.command !~ '''agent''' or j.command !~ '193d7dd0-74f9-407d-9891-8cb7aab22f82' then
    raise exception 'billing-reconcile-nightly runs the wrong command: %', j.command;
  end if;
end
$$;


-- 4–9. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000e211', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-bg-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e212', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-bg-office@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000e211', 'bg test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000e212', 'bg test office', 'office')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- nine water jobs, each with one sent T&M invoice billing 3 dehu-days and one
-- void invoice; g is deleted. a: the full approval; b: no gaps; c: invoices
-- change after filing; d: the office deletes the supplement; e: edits; h: an
-- expired or superseded card offered again; i: a declined one stays quiet;
-- j: the offer cap
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object(
         'id', j.id, 'rev', 7, 'updatedAt', '2026-10-01T10:00:00.000Z',
         'jobType', 'restoration', 'customer', 'Gaps Test ' || upper(j.tag), 'lossTypes', '["water"]'::jsonb,
         'notes', 'keep me', 'photos', '[]'::jsonb,
         'dryingLogs', '[{"id": "log-1", "equipment": [{"asset": "D1", "type": "LGR dehu", "placed": "2026-09-20T09:00", "removed": "2026-09-28T09:00"}]}]'::jsonb,
         'invoices', jsonb_build_array(
           jsonb_build_object(
             'id', md5('gaps-test-' || j.tag || ':inv')::uuid, 'status', 'sent', 'billingModel', 'tm',
             'invoiceNo', 'RC-' || upper(j.tag), 'terms', 'Net 30', 'opMode', 'pct', 'opAuto', false,
             'overheadPct', '10', 'profitPct', '10', 'overheadAmount', '', 'profitAmount', '', 'taxRate', '2.5',
             'items', jsonb_build_array(jsonb_build_object(
               'id', md5('gaps-test-' || j.tag || ':line')::uuid, 'room', 'Basement',
               'desc', 'Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.',
               'qty', '3', 'unit', 'EA', 'price', '85', 'code', 'DHM'))),
           jsonb_build_object(
             'id', md5('gaps-test-' || j.tag || ':void')::uuid, 'status', 'void', 'billingModel', 'tm',
             'items', '[{"desc": "voided", "qty": "1", "unit": "EA", "price": "1"}]'::jsonb))),
       j.deleted
  from (values
    ('00000000-0000-0000-0000-00000000e2a0'::uuid, 'a', false),
    ('00000000-0000-0000-0000-00000000e2b0'::uuid, 'b', false),
    ('00000000-0000-0000-0000-00000000e2c0'::uuid, 'c', false),
    ('00000000-0000-0000-0000-00000000e2d0'::uuid, 'd', false),
    ('00000000-0000-0000-0000-00000000e2e0'::uuid, 'e', false),
    ('00000000-0000-0000-0000-00000000e2f0'::uuid, 'g', true),
    ('00000000-0000-0000-0000-00000000e3a0'::uuid, 'h', false),
    ('00000000-0000-0000-0000-00000000e3b0'::uuid, 'i', false),
    ('00000000-0000-0000-0000-00000000e3c0'::uuid, 'j', false)
  ) as j(id, tag, deleted);

create temp table billing_gaps_state (k text primary key, v text);
grant all on billing_gaps_state to anon, authenticated, service_role;

-- What the worker sends, less the per-job fields (job_id, findings_hash,
-- base_rev, rate_invoice_id, rate_invoice_no): 5 dehu-days at the job's own
-- $85, 2.25 h of labor at $72.50, and one unpriced Cat 3 item.
insert into billing_gaps_state values ('input', '{
  "sent": true,
  "lines": [
    {"finding_id": "equip:dehu", "class": "dehu", "desc": "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.",
     "qty": 5, "unit": "EA", "price": 85, "amount": 425, "room": "Basement", "code": "DHM",
     "basis": "8 dehu-days documented, 3 billed", "refs": [{"kind": "drying_log", "id": "log-1", "label": "Drying log"}]},
    {"finding_id": "labor:hours", "class": "labor", "desc": "Water Extraction & Remediation Technician - per hour",
     "qty": 2.25, "unit": "HR", "price": 72.5, "amount": 163.13, "room": "", "code": "LAB",
     "basis": "2.25 h in the mitigation window not billed", "refs": []},
    {"finding_id": "cat3:containment", "class": "cat3", "desc": "Containment barrier/airlock/decon. chamber",
     "qty": null, "unit": "SF", "price": null, "amount": null, "room": "", "code": "",
     "basis": "Category 3 loss with no containment line", "refs": []}],
  "hints": [{"kind": "undocumented_days", "label": "2 days with equipment on and no reading", "refs": []}],
  "total_usd": 588.13, "unpriced_count": 1, "detector": "billing.reconcile@0.1",
  "limits": "Unit-days are 24-hour periods rounded up; prices come only from this job''s own invoices."}');


-- 4. the fingerprint moves with every billed field and nothing else
do $$
declare
  d jsonb := (select data from public.field_projects where id = '00000000-0000-0000-0000-00000000e2a0');
  f text;
begin
  f := public.billing_invoices_fingerprint(d);
  if f !~ '^[0-9a-f]{32}$' then raise exception 'the fingerprint is %', f; end if;
  if public.billing_invoices_fingerprint(d) <> f then raise exception 'the fingerprint is not stable'; end if;

  -- not moved: a void invoice, the order of the array, fields nobody bills,
  -- and a status short of void (the QuickBooks payment pull, the office
  -- sending it): a payment bills nothing new
  if public.billing_invoices_fingerprint(jsonb_set(d, '{invoices}', (d -> 'invoices') - 1)) <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,status}', '"paid"')) <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,status}', '"partially_paid"')) <> f
     or public.billing_invoices_fingerprint(d #- '{invoices,0,status}') <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices}',
          '[{"id": "0-first", "status": "paid", "items": []}]'::jsonb || (d -> 'invoices')))
        <> public.billing_invoices_fingerprint(jsonb_set(d, '{invoices}',
          (d -> 'invoices') || '[{"id": "0-first", "status": "paid", "items": []}]'::jsonb))
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,terms}', '"Net 15"')) <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,room}', '"Attic"')) <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{notes}', '"other"')) <> f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,1,items,0,qty}', '"9"')) <> f then
    raise exception 'the fingerprint moved with something it does not cover';
  end if;

  -- moved: every billed field of a non-void invoice, and the set of invoices
  if public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,qty}', '"4"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,qty}', '3')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,price}', '"90"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,unit}', '"DA"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items,0,desc}', '"Dehu"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,status}', '"void"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,billingModel}', '"contract"')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices,0,items}',
          (d #> '{invoices,0,items}') || '[{"desc": "more", "qty": "1", "unit": "EA", "price": "1"}]')) = f
     or public.billing_invoices_fingerprint(jsonb_set(d, '{invoices}',
          (d -> 'invoices') || '[{"id": "x", "items": []}]')) = f then
    raise exception 'the fingerprint did not move with a billed field';
  end if;

  if public.billing_invoices_fingerprint('{}') <> md5('[]')
     or public.billing_invoices_fingerprint('{"invoices": "not a list"}') <> md5('[]') then
    raise exception 'a job with no invoices does not fingerprint as the empty list';
  end if;
end
$$;


-- 5a. the door's refusals and skips, as the worker (service role); nothing
--     is filed by any of them
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000e2a0';
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input');
  v_in jsonb;
  r    jsonb;
begin
  v_in := base || jsonb_build_object('job_id', a, 'findings_hash', md5('gaps a0'), 'base_rev', 7,
                                     'rate_invoice_id', md5('gaps-test-a:inv')::uuid, 'rate_invoice_no', 'RC-A');

  r := public.billing_review_gaps_file('00000000-0000-0000-0000-00000000e2ff', 7,
         v_in || '{"job_id": "00000000-0000-0000-0000-00000000e2ff"}', 'x', '[]');
  if r <> '{"skipped": "missing"}' then raise exception 'a missing job answered %', r; end if;
  r := public.billing_review_gaps_file('00000000-0000-0000-0000-00000000e2f0', 7,
         v_in || '{"job_id": "00000000-0000-0000-0000-00000000e2f0"}', 'x', '[]');
  if r <> '{"skipped": "deleted"}' then raise exception 'a deleted job answered %', r; end if;
  r := public.billing_review_gaps_file(a, 6, v_in, 'x', '[]');
  if r <> '{"skipped": "rev_moved"}' then raise exception 'a moved rev answered %', r; end if;
  r := public.billing_review_gaps_file(a, 6, null, null, null);
  if r <> '{"skipped": "rev_moved"}' then raise exception 'a moved rev with no gaps answered %', r; end if;

  begin
    perform public.billing_review_gaps_file(a, 7, v_in || '{"job_id": "00000000-0000-0000-0000-00000000e2b0"}', 'x', '[]');
    raise exception 'the door filed lines for another job';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7, v_in || '{"lines": []}', 'x', '[]');
    raise exception 'the door filed no lines';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7, v_in - 'lines', 'x', '[]');
    raise exception 'the door filed an input with no lines';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7,
      v_in || jsonb_build_object('lines', (base -> 'lines') || jsonb_build_array(base -> 'lines' -> 0)), 'x', '[]');
    raise exception 'the door filed two lines with one finding_id';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7,
      v_in || jsonb_build_object('hints', (select jsonb_agg(base -> 'hints' -> 0) from generate_series(1, 21))), 'x', '[]');
    raise exception 'the door filed 21 hints';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7, v_in, 'x', '{"kind": "photo"}');
    raise exception 'the door filed evidence that is not a list';
  exception when invalid_parameter_value then null;
  end;
  -- op_propose's own input check, behind the door
  begin
    perform public.billing_review_gaps_file(a, 7, v_in || '{"detector": "something.else@1"}', 'x', '[]');
    raise exception 'the door filed a detector the schema refuses';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.billing_review_gaps_file(a, 7, v_in || '{"surprise": 1}', 'x', '[]');
    raise exception 'the door filed a field the schema does not know';
  exception when invalid_parameter_value then null;
  end;

  if exists (select 1 from public.proposals
              where job_id in ('00000000-0000-0000-0000-00000000e2a0', '00000000-0000-0000-0000-00000000e2f0',
                               '00000000-0000-0000-0000-00000000e2ff')) then
    raise exception 'a refused filing left a proposal behind';
  end if;
end
$$;
release savepoint s;
reset role;

-- 5b. file on a: one proposal, as agent:billing, waiting on the owner; the
--     same findings on the same invoices again are the same proposal
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000e2a0';
  v_in jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', a, 'findings_hash', md5('gaps a1'), 'base_rev', 7,
                                      'rate_invoice_id', md5('gaps-test-a:inv')::uuid, 'rate_invoice_no', 'RC-A');
  r    jsonb;
  r2   jsonb;
  p    public.proposals;
begin
  r := public.billing_review_gaps_file(a, 7, v_in,
         'Add 3 lines ($588.13, 1 unpriced) to Gaps Test A: dehu-days, labor, cat3' || chr(10) || (v_in ->> 'limits'),
         '[{"kind": "drying_log", "id": "log-1", "label": "8 dehu-days from 1 unit row"}]');
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
     <> array['filed', 'proposal_id', 'status', 'superseded']
     or r -> 'filed' <> 'true' or r ->> 'status' <> 'proposed' or r -> 'superseded' <> '0' then
    raise exception 'a first filing answered %', r;
  end if;

  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if p.operation <> 'invoice.review_gaps@1' or p.action_type <> 'money' or p.status <> 'proposed'
     or p.assigned_role <> 'owner' or p.proposed_via <> 'agent' or p.proposed_by_kind <> 'agent'
     or p.proposed_by_id <> '193d7dd0-74f9-407d-9891-8cb7aab22f82' or p.job_id <> a or p.sms_code is null then
    raise exception 'the filed proposal is % % % by %/% via %, job %, code %',
      p.operation, p.status, p.assigned_role, p.proposed_by_kind, p.proposed_by_id, p.proposed_via, p.job_id, p.sms_code;
  end if;
  if p.expires_at <> now() + interval '14 days' then
    raise exception 'the proposal expires at %, not in 14 days', p.expires_at;
  end if;
  if (p.input - 'invoice_fingerprint' - 'offer') <> v_in or p.input ->> 'invoice_fingerprint' !~ '^[0-9a-f]{32}$'
     or p.input -> 'offer' <> '0' then
    raise exception 'the door filed % for %', p.input, v_in;
  end if;
  if p.idempotency_key <> 'invoice.review_gaps:' || a || ':' || (p.input ->> 'invoice_fingerprint') || ':' || md5('gaps a1') || ':0' then
    raise exception 'the key is %', p.idempotency_key;
  end if;
  if p.rationale !~ '^Add 3 lines' or p.evidence_refs -> 0 ->> 'label' <> '8 dehu-days from 1 unit row' then
    raise exception 'rationale or evidence not stored: % / %', p.rationale, p.evidence_refs;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.created' and proposal_id = p.id and principal_kind = 'agent'
                    and principal_id = '193d7dd0-74f9-407d-9891-8cb7aab22f82' and data ->> 'proposed_via' = 'agent') then
    raise exception 'no proposal.created event by agent:billing';
  end if;

  r2 := public.billing_review_gaps_file(a, 7, v_in, 'again', '[]');
  if r2 <> jsonb_build_object('filed', false, 'proposal_id', p.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'the same filing twice answered %', r2;
  end if;
  -- the offer is the door's count: one the worker sends is overwritten
  r2 := public.billing_review_gaps_file(a, 7, v_in || '{"offer": 7}', 'again', '[]');
  if r2 <> jsonb_build_object('filed', false, 'proposal_id', p.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'a filing that sent its own offer answered %', r2;
  end if;
  if (select count(*) from public.proposals where job_id = a) <> 1 then
    raise exception 'the same filing twice made two proposals';
  end if;

  insert into billing_gaps_state values ('p1', p.id::text);
end
$$;
release savepoint s;
reset role;

-- the fingerprint the door stamped is SQL's own
do $$
begin
  if (select input ->> 'invoice_fingerprint' from public.proposals
       where id = (select v::uuid from billing_gaps_state where k = 'p1'))
     <> public.billing_invoices_fingerprint((select data from public.field_projects
                                              where id = '00000000-0000-0000-0000-00000000e2a0')) then
    raise exception 'the stamped fingerprint is not billing_invoices_fingerprint of the job';
  end if;
end
$$;

-- 5c. the office edits a's invoice (and a device clock far ahead stamps
--     updatedAt); the next filing supersedes the open proposal
update public.field_projects
   set data = jsonb_set(jsonb_set(jsonb_set(data, '{invoices,0,items,0,qty}', '"4"'),
                '{rev}', '8'), '{updatedAt}', '"2099-01-01T00:00:00.000Z"')
 where id = '00000000-0000-0000-0000-00000000e2a0';

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000e2a0';
  p1   uuid := (select v::uuid from billing_gaps_state where k = 'p1');
  v_in jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', a, 'findings_hash', md5('gaps a2'), 'base_rev', 8,
                                      'rate_invoice_id', md5('gaps-test-a:inv')::uuid, 'rate_invoice_no', 'RC-A');
  r    jsonb;
  old  public.proposals;
  p    public.proposals;
begin
  r := public.billing_review_gaps_file(a, 8, v_in, 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r ->> 'status' <> 'proposed' or r -> 'superseded' <> '1' then
    raise exception 'a filing over an open proposal answered %', r;
  end if;
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  select * into old from public.proposals where id = p1;
  if old.status <> 'superseded' or old.result <> jsonb_build_object('superseded_by', p.id) then
    raise exception 'the older proposal is % with result %', old.status, old.result;
  end if;
  if p.supersedes_id is distinct from p1 then
    raise exception 'the new proposal supersedes %, not %', p.supersedes_id, p1;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.superseded' and proposal_id = p1 and aggregate_id = p1
                    and idempotency_key = 'proposal.superseded:' || p1
                    and data = jsonb_build_object('superseded_by', p.id)
                    and principal_kind = 'agent' and principal_id = '193d7dd0-74f9-407d-9891-8cb7aab22f82') then
    raise exception 'no proposal.superseded event for the older proposal';
  end if;
  insert into billing_gaps_state values ('p2', p.id::text);
end
$$;
release savepoint s;
reset role;

insert into billing_gaps_state
select 'a_before', data::text from public.field_projects where id = '00000000-0000-0000-0000-00000000e2a0';

-- 6a. office holds no money approval (ruling 2026-09-06)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e212", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.op_proposal_approve((select v::uuid from billing_gaps_state where k = 'p2'), 'inbox');
    raise exception 'office approved an invoice.review_gaps proposal';
  exception when insufficient_privilege then
    if sqlerrm !~ 'may not approve' then raise; end if;
  end;
end
$$;
rollback to savepoint s;
reset role;

-- 6b. the owner approves from the inbox, dropping the labor line and
--     (uselessly) retyping the dehu line: it runs inline, adds two lines with
--     the proposal's own content, and nothing is queued
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p2 uuid := (select v::uuid from billing_gaps_state where k = 'p2');
  p  public.proposals;
  ed jsonb;
begin
  select * into p from public.proposals where id = p2;
  ed := jsonb_build_object('lines',
          jsonb_build_array((p.input -> 'lines' -> 0) || '{"qty": 50, "price": 999}', p.input -> 'lines' -> 2));
  p := public.op_proposal_approve(p2, 'inbox', null, ed);
  if p.status <> 'executed' then
    raise exception 'the owner''s approval left the proposal % (%)', p.status, p.error;
  end if;
  if p.execution_job_id is not null then
    raise exception 'a runtime sql approval was queued for the worker';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p.result) k)
     <> array['invoice_id', 'lines_added', 'rev', 'status', 'total_usd', 'unpriced'] then
    raise exception 'the executor returned %', p.result;
  end if;
  if p.result ->> 'status' <> 'added'
     or p.result ->> 'invoice_id' <> md5('invoice.review_gaps:' || p2)::uuid::text
     or (p.result ->> 'lines_added')::int <> 2 or (p.result ->> 'total_usd')::numeric <> 425
     or (p.result ->> 'unpriced')::int <> 1 or (p.result ->> 'rev')::int <> 9 then
    raise exception 'the executor returned %', p.result;
  end if;
end
$$;
release savepoint s;
reset role;

-- 6c. the ledger and the blob: the applied event, nothing queued; one new
--     element with the deterministic id, rev + 1, a newer updatedAt, and not
--     one other change
do $$
declare
  p2     uuid  := (select v::uuid from billing_gaps_state where k = 'p2');
  inv    text  := md5('invoice.review_gaps:' || (select v from billing_gaps_state where k = 'p2'))::uuid::text;
  before jsonb := (select v::jsonb from billing_gaps_state where k = 'a_before');
  after  jsonb := (select data from public.field_projects where id = '00000000-0000-0000-0000-00000000e2a0');
  n      int   := jsonb_array_length(before -> 'invoices');
  el     jsonb;
  it     jsonb;
begin
  if exists (select 1 from public.jobs_queue where idempotency_key = 'proposal.execute:' || p2) then
    raise exception 'a runtime sql approval was queued for the worker';
  end if;
  if (select array_agg(kind order by id) from public.events where proposal_id = p2)
     <> array['proposal.created', 'proposal.approved', 'invoice.review_gaps_applied', 'proposal.executed'] then
    raise exception 'the event trail is %', (select array_agg(kind order by id) from public.events where proposal_id = p2);
  end if;
  if not exists (select 1 from public.events
                  where kind = 'invoice.review_gaps_applied' and proposal_id = p2
                    and idempotency_key = 'invoice.review_gaps_applied:' || p2
                    and aggregate_type = 'field_project' and aggregate_id = '00000000-0000-0000-0000-00000000e2a0'
                    and job_id = '00000000-0000-0000-0000-00000000e2a0'
                    and principal_kind = 'human' and principal_id = '00000000-0000-0000-0000-00000000e211'
                    and (data ->> 'lines_added')::int = 2 and (data ->> 'total_usd')::numeric = 425
                    and (data ->> 'rev')::int = 9 and data ->> 'invoice_id' = inv) then
    raise exception 'no invoice.review_gaps_applied event naming the invoice';
  end if;

  if (after - 'invoices' - 'rev' - 'updatedAt') <> (before - 'invoices' - 'rev' - 'updatedAt') then
    raise exception 'the approval changed the job beyond its invoices, rev and updatedAt';
  end if;
  if jsonb_array_length(after -> 'invoices') <> n + 1 or (after -> 'invoices') - n <> before -> 'invoices' then
    raise exception 'the approval did more than append one invoice: %', after -> 'invoices';
  end if;
  if (after ->> 'rev')::int <> (before ->> 'rev')::int + 1 then
    raise exception 'rev went % → %', before ->> 'rev', after ->> 'rev';
  end if;
  -- strictly newer, as a time and as the string merge.js and the SQL merge compare
  if after ->> 'updatedAt' <> '2099-01-01T00:00:00.001Z'
     or (after ->> 'updatedAt') collate "C" <= (before ->> 'updatedAt') collate "C" then
    raise exception 'updatedAt went % → %', before ->> 'updatedAt', after ->> 'updatedAt';
  end if;

  el := after -> 'invoices' -> n;
  if el ->> 'id' <> md5('invoice.review_gaps:' || p2)::uuid::text then
    raise exception 'the new invoice id is %', el ->> 'id';
  end if;
  if el ? 'status' or el ? 'qboInvoiceId' then
    raise exception 'the supplement carries a status or a QuickBooks id: %', el;
  end if;
  if el ->> 'by' <> 'Billing check' or el ->> 'invoiceNo' <> '' or el ->> 'dueDate' <> ''
     or el ->> 'invoiceDate' <> to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')
     or el ->> 'billingModel' <> 'tm' or el ->> 'contractAmount' <> '' or el ->> 'terms' <> 'Net 30'
     or el ->> 'opMode' <> 'pct' or el -> 'opAuto' <> 'false' or el ->> 'overheadPct' <> '10'
     or el ->> 'profitPct' <> '10' or el ->> 'taxRate' <> '2.5' or el ->> 'overheadAmount' <> ''
     or el ->> 'profitAmount' <> '' or el ->> 'deductible' <> '' or el ->> 'previousPayments' <> ''
     or el -> 'attachments' <> '[]' or el -> 'scopeInterview' <> 'null'
     -- both print on the invoice and become the QuickBooks CustomerMemo: customer wording only
     or el ->> 'notes' <> '' or el ->> 'lossSummary' <> 'Supplemental mitigation charges'
     or (el ->> 'lossSummary') || (el ->> 'notes') ~* 'proposal|nightly|unbilled|billing check'
     or el #>> '{reviewGaps,proposalId}' <> p2::text or el #>> '{reviewGaps,findingsHash}' <> md5('gaps a2')
     or el #>> '{reviewGaps,approvedAt}' is null then
    raise exception 'the supplement is %', el;
  end if;

  if jsonb_array_length(el -> 'items') <> 2 then
    raise exception 'the supplement holds % lines, not the 2 approved', jsonb_array_length(el -> 'items');
  end if;
  if exists (select 1 from jsonb_array_elements(el -> 'items') i, jsonb_each(i) kv
              where jsonb_typeof(kv.value) <> 'string') then
    raise exception 'a supplement line holds a value that is not a string: %', el -> 'items';
  end if;
  it := el -> 'items' -> 0;
  if it <> jsonb_build_object(
       'id', md5(p2 || ':equip:dehu')::uuid, 'room', 'Basement',
       'desc', 'Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.', 'qty', '5', 'unit', 'EA',
       'price', '85', 'code', 'DHM', 'priced', 'invoice_rate', 'flag', 'review_gaps',
       'basis', '8 dehu-days documented, 3 billed') then
    raise exception 'the priced line is % (an edit may only drop lines, never change one)', it;
  end if;
  it := el -> 'items' -> 1;
  if it <> jsonb_build_object(
       'id', md5(p2 || ':cat3:containment')::uuid, 'room', '',
       'desc', 'Containment barrier/airlock/decon. chamber', 'qty', '', 'unit', 'SF',
       'price', '', 'code', '', 'priced', 'flag', 'flag', 'no rate on this job: price it',
       'basis', 'Category 3 loss with no containment line') then
    raise exception 'the unpriced line is %', it;
  end if;

  insert into billing_gaps_state values ('a_after', after::text);
  insert into billing_gaps_state values ('events', (select count(*) from public.events)::text);
end
$$;

-- 6d. running it again changes nothing: a second approval, op_execute, and
--     the executor itself (which finds its own invoice)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from billing_gaps_state where k = 'p2'), 'inbox');
  if p.status <> 'executed' then
    raise exception 'a second approval left the proposal %', p.status;
  end if;
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_execute((select v::uuid from billing_gaps_state where k = 'p2'), 'human', '00000000-0000-0000-0000-00000000e211');
  if p.status <> 'executed' then
    raise exception 'op_execute over an executed proposal left it %', p.status;
  end if;
end
$$;
release savepoint s;
reset role;

do $$
declare
  p2 uuid := (select v::uuid from billing_gaps_state where k = 'p2');
  n  bigint := (select v::bigint from billing_gaps_state where k = 'events');
  p  public.proposals;
  r  jsonb;
begin
  if (select count(*) from public.events) <> n then
    raise exception 'a second approval or op_execute wrote % events', (select count(*) from public.events) - n;
  end if;
  select * into p from public.proposals where id = p2;
  r := public.op_exec_invoice_review_gaps(p, p.input || coalesce(p.edited_params, '{}'),
                                          'human', '00000000-0000-0000-0000-00000000e211');
  if r <> jsonb_build_object('status', 'already_present', 'invoice_id', md5('invoice.review_gaps:' || p2)::uuid::text,
                             'lines_added', 0, 'total_usd', 0, 'unpriced', 0, 'rev', 9) then
    raise exception 'the executor over its own invoice returned %', r;
  end if;
  if (select data from public.field_projects where id = '00000000-0000-0000-0000-00000000e2a0')
     <> (select v::jsonb from billing_gaps_state where k = 'a_after')
     or (select count(*) from public.events) <> n then
    raise exception 'the executor wrote again over its own invoice';
  end if;
end
$$;

-- 6e. no gaps: the door supersedes the open row with no_gaps; the same gap
--     back the next night is offered again (offer 1), and that open card then
--     stands
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000e2a0';
  b    constant uuid := '00000000-0000-0000-0000-00000000e2b0';
  v_in jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', b, 'findings_hash', md5('gaps b1'), 'base_rev', 7,
                                      'rate_invoice_id', md5('gaps-test-b:inv')::uuid, 'rate_invoice_no', 'RC-B');
  r    jsonb;
  p3   uuid;
  p    public.proposals;
begin
  -- a holds nothing open any more
  r := public.billing_review_gaps_file(a, 9, null, null, null);
  if r <> '{"filed": false, "superseded": 0}' then raise exception 'no gaps on a answered %', r; end if;

  r := public.billing_review_gaps_file(b, 7, v_in, 'Add 3 lines', '[]');
  p3 := (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' then raise exception 'b was not filed: %', r; end if;

  r := public.billing_review_gaps_file(b, 7, null, null, null);
  if r <> '{"filed": false, "superseded": 1}' then raise exception 'no gaps on b answered %', r; end if;
  select * into p from public.proposals where id = p3;
  if p.status <> 'superseded' or p.result <> '{"superseded_reason": "no_gaps"}' then
    raise exception 'the no-gaps proposal is % with result %', p.status, p.result;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.superseded' and proposal_id = p3
                    and data = '{"superseded_reason": "no_gaps"}') then
    raise exception 'no proposal.superseded event for no_gaps';
  end if;
  r := public.billing_review_gaps_file(b, 7, null, null, null);
  if r <> '{"filed": false, "superseded": 0}' then raise exception 'no gaps on b twice answered %', r; end if;

  r := public.billing_review_gaps_file(b, 7, v_in, 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r ->> 'status' <> 'proposed' or r -> 'superseded' <> '0'
     or (r ->> 'proposal_id')::uuid = p3 then
    raise exception 'refiling a superseded key answered %', r;
  end if;
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if p.input -> 'offer' <> '1' or (p.input - 'offer') <> ((select input from public.proposals where id = p3) - 'offer')
     or p.idempotency_key <> 'invoice.review_gaps:' || b || ':' || (p.input ->> 'invoice_fingerprint') || ':' || md5('gaps b1') || ':1'
     or p.supersedes_id is not null then
    raise exception 'the second offer is % with key %, superseding %', p.input, p.idempotency_key, p.supersedes_id;
  end if;
  r := public.billing_review_gaps_file(b, 7, v_in, 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', p.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'refiling an open second offer answered %', r;
  end if;
  insert into billing_gaps_state values ('p3', p3::text);
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.op_proposal_approve((select v::uuid from billing_gaps_state where k = 'p3'), 'inbox');
    raise exception 'a superseded proposal was approved';
  exception when object_not_in_prerequisite_state then null;
  end;
end
$$;
rollback to savepoint s;
reset role;

-- 6f. the supplement's O&P: fixed-dollar O&P is already on the rate invoice
--     and is never copied; with no rate invoice the supplement takes
--     newInvoice's defaults and the editor's O&P rule. The executor is run
--     directly over b's (superseded, never run) proposal, and rolled back.
savepoint s;
update public.field_projects
   set data = jsonb_set(jsonb_set(jsonb_set(data, '{invoices,0,opMode}', '"amount"'),
                '{invoices,0,overheadAmount}', '"500"'), '{invoices,0,profitAmount}', '"400"')
 where id = '00000000-0000-0000-0000-00000000e2b0';
do $$
declare
  p  public.proposals;
  r  jsonb;
  el jsonb;
begin
  select * into p from public.proposals where id = (select v::uuid from billing_gaps_state where k = 'p3');
  r := public.op_exec_invoice_review_gaps(p, p.input, 'human', '00000000-0000-0000-0000-00000000e211');
  if r ->> 'status' <> 'added' or (r ->> 'lines_added')::int <> 3 or (r ->> 'total_usd')::numeric <> 588.13
     or (r ->> 'unpriced')::int <> 1 then
    raise exception 'the executor over b returned %', r;
  end if;
  el := (select data -> 'invoices' -> -1 from public.field_projects where id = '00000000-0000-0000-0000-00000000e2b0');
  if el ->> 'opMode' <> 'amount' or el ->> 'overheadAmount' <> '' or el ->> 'profitAmount' <> ''
     or el -> 'opAuto' <> 'false' or el ->> 'terms' <> 'Net 30' or el ->> 'taxRate' <> '2.5' then
    raise exception 'a supplement to a fixed-O&P invoice is %', el;
  end if;
end
$$;
rollback to savepoint s;

savepoint s;
do $$
declare
  p  public.proposals;
  r  jsonb;
  el jsonb;
begin
  select * into p from public.proposals where id = (select v::uuid from billing_gaps_state where k = 'p3');
  p.input := p.input - 'rate_invoice_id';
  r := public.op_exec_invoice_review_gaps(p, p.input, 'human', '00000000-0000-0000-0000-00000000e211');
  if r ->> 'status' <> 'added' then raise exception 'the executor over b with no rate invoice returned %', r; end if;
  el := (select data -> 'invoices' -> -1 from public.field_projects where id = '00000000-0000-0000-0000-00000000e2b0');
  if el ->> 'opMode' <> 'pct' or el -> 'opAuto' <> 'true' or el ->> 'overheadPct' <> '10'
     or el ->> 'profitPct' <> '10' or el ->> 'terms' <> 'Due on receipt' or el ->> 'taxRate' <> '' then
    raise exception 'a supplement with no rate invoice is %', el;
  end if;
end
$$;
rollback to savepoint s;

-- 7a. c, d and e are filed; then c's invoice changes and d's supplement id is
--     tombstoned (the office deleted it on a device)
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input');
  r    jsonb;
  t    text;
  j    uuid;
begin
  foreach t in array array['c', 'd', 'e'] loop
    j := ('00000000-0000-0000-0000-00000000e2' || t || '0')::uuid;
    r := public.billing_review_gaps_file(j, 7,
           base || jsonb_build_object('job_id', j, 'findings_hash', md5('gaps ' || t || '1'), 'base_rev', 7,
                                      'rate_invoice_id', md5('gaps-test-' || t || ':inv')::uuid),
           'Add 3 lines', '[]');
    if r -> 'filed' <> 'true' then raise exception '% was not filed: %', t, r; end if;
    insert into billing_gaps_state values ('p_' || t, r ->> 'proposal_id');
  end loop;
end
$$;
release savepoint s;
reset role;

update public.field_projects
   set data = jsonb_set(jsonb_set(data, '{invoices,0,items,0,price}', '"90"'), '{rev}', '8')
 where id = '00000000-0000-0000-0000-00000000e2c0';
update public.field_projects
   set data = jsonb_set(data, '{deletedIds}',
                jsonb_build_object(md5('invoice.review_gaps:' || (select v from billing_gaps_state where k = 'p_d'))::uuid::text,
                                   '2026-10-07T00:00:00.000Z'))
 where id = '00000000-0000-0000-0000-00000000e2d0';
insert into billing_gaps_state
select 'before_' || right(left(id::text, 35), 1), data::text
  from public.field_projects
 where id in ('00000000-0000-0000-0000-00000000e2c0', '00000000-0000-0000-0000-00000000e2d0',
              '00000000-0000-0000-0000-00000000e2e0');

-- 7b. the owner approves each: c fails (stale), d does nothing (deleted by
--     the office), and e's edit, which names a line the proposal never held,
--     fails; nothing is written to any of them
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  pc uuid := (select v::uuid from billing_gaps_state where k = 'p_c');
  pd uuid := (select v::uuid from billing_gaps_state where k = 'p_d');
  pe uuid := (select v::uuid from billing_gaps_state where k = 'p_e');
  p  public.proposals;
begin
  p := public.op_proposal_approve(pc, 'inbox');
  if p.status <> 'failed' or p.error !~ 'invoices changed since this was proposed, so nothing was added'
     or p.error ~ 'tonight' or p.error !~ 'still one it checks \(not archived, not every invoice paid\)' then
    raise exception 'a stale approval is % (%)', p.status, p.error;
  end if;

  p := public.op_proposal_approve(pd, 'inbox');
  if p.status <> 'executed'
     or p.result <> jsonb_build_object('status', 'deleted_by_office',
                                       'invoice_id', md5('invoice.review_gaps:' || pd)::uuid::text,
                                       'lines_added', 0, 'total_usd', 0, 'unpriced', 0, 'rev', 7) then
    raise exception 'an approval over a tombstoned supplement is % with %', p.status, p.result;
  end if;

  -- an edit whose lines are not a list is refused before anything moves;
  -- one that names a line the proposal does not hold fails the run
  begin
    perform public.op_proposal_approve(pe, 'inbox', null, '{"lines": "all"}');
    raise exception 'an edit whose lines are not a list was approved';
  exception when invalid_parameter_value then null;
  end;
  if (select status from public.proposals where id = pe) <> 'proposed' then
    raise exception 'a refused edit moved the proposal';
  end if;
  select * into p from public.proposals where id = pe;
  p := public.op_proposal_approve(pe, 'inbox', null,
         jsonb_build_object('lines', jsonb_build_array(p.input -> 'lines' -> 0,
           '{"finding_id": "equip:heater", "class": "heater", "desc": "Heater", "qty": 3, "unit": "DA", "price": 1000}'::jsonb)));
  if p.status <> 'failed' or p.error !~ 'may only drop lines' then
    raise exception 'an edit adding a line is % (%)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;

-- e again, under new findings: filed beside the failed row (nothing open to
-- supersede), and an approval that keeps no line fails
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  e  constant uuid := '00000000-0000-0000-0000-00000000e2e0';
  r  jsonb;
begin
  r := public.billing_review_gaps_file(e, 7,
         (select v::jsonb from billing_gaps_state where k = 'input')
         || jsonb_build_object('job_id', e, 'findings_hash', md5('gaps e2'), 'base_rev', 7), 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' then
    raise exception 'refiling e under new findings answered %', r;
  end if;
  insert into billing_gaps_state values ('p_e2', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from billing_gaps_state where k = 'p_e2'), 'inbox', null, '{"lines": []}');
  if p.status <> 'failed' or p.error !~ 'kept no lines' then
    raise exception 'an approval keeping no lines is % (%)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;

-- 7c. refiled, an answered gap stays quiet: e's failed findings and d's
--     executed one (the office deleted its supplement) answer with their
--     row and file nothing, and e's open row under other findings is
--     superseded as findings_changed. c's invoices changed after its run
--     failed, so the same findings file afresh, offer 0 under the new
--     fingerprint (what the stale error promises).
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input');
  c    constant uuid := '00000000-0000-0000-0000-00000000e2c0';
  d    constant uuid := '00000000-0000-0000-0000-00000000e2d0';
  e    constant uuid := '00000000-0000-0000-0000-00000000e2e0';
  pe   uuid := (select v::uuid from billing_gaps_state where k = 'p_e');
  r    jsonb;
  e3   uuid;
  p    public.proposals;
begin
  r := public.billing_review_gaps_file(e, 7,
         base || jsonb_build_object('job_id', e, 'findings_hash', md5('gaps e3'), 'base_rev', 7), 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' then
    raise exception 'e under third findings answered %', r;
  end if;
  e3 := (r ->> 'proposal_id')::uuid;

  r := public.billing_review_gaps_file(e, 7,
         base || jsonb_build_object('job_id', e, 'findings_hash', md5('gaps e1'), 'base_rev', 7), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', pe, 'status', 'failed', 'superseded', 1) then
    raise exception 'refiling the failed key answered %', r;
  end if;
  if (select status from public.proposals where id = e3) <> 'superseded'
     or (select result from public.proposals where id = e3) <> '{"superseded_reason": "findings_changed"}' then
    raise exception 'the open row under other findings is % with %',
      (select status from public.proposals where id = e3), (select result from public.proposals where id = e3);
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.superseded' and proposal_id = e3
                    and data = '{"superseded_reason": "findings_changed"}'
                    and principal_kind = 'agent' and principal_id = '193d7dd0-74f9-407d-9891-8cb7aab22f82') then
    raise exception 'no proposal.superseded event for findings_changed';
  end if;
  r := public.billing_review_gaps_file(e, 7,
         base || jsonb_build_object('job_id', e, 'findings_hash', md5('gaps e2'), 'base_rev', 7), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', (select v::uuid from billing_gaps_state where k = 'p_e2'),
                             'status', 'failed', 'superseded', 0) then
    raise exception 'refiling the second failed key answered %', r;
  end if;
  if (select count(*) from public.proposals where job_id = e) <> 3 then
    raise exception 'a quiet refiling filed: e holds % proposals', (select count(*) from public.proposals where job_id = e);
  end if;

  r := public.billing_review_gaps_file(d, 7,
         base || jsonb_build_object('job_id', d, 'findings_hash', md5('gaps d1'), 'base_rev', 7,
                                    'rate_invoice_id', md5('gaps-test-d:inv')::uuid), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', (select v::uuid from billing_gaps_state where k = 'p_d'),
                             'status', 'executed', 'superseded', 0) then
    raise exception 'refiling the executed key answered %', r;
  end if;

  r := public.billing_review_gaps_file(c, 8,
         base || jsonb_build_object('job_id', c, 'findings_hash', md5('gaps c1'), 'base_rev', 8,
                                    'rate_invoice_id', md5('gaps-test-c:inv')::uuid), 'Add 3 lines', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' or p.input -> 'offer' <> '0'
     or p.input ->> 'invoice_fingerprint' = (select input ->> 'invoice_fingerprint' from public.proposals
                                              where id = (select v::uuid from billing_gaps_state where k = 'p_c')) then
    raise exception 'c''s findings on its changed invoices answered % (input %)', r, p.input;
  end if;
end
$$;
release savepoint s;
reset role;

do $$
declare
  t text;
begin
  foreach t in array array['c', 'd', 'e'] loop
    if (select data from public.field_projects where id = ('00000000-0000-0000-0000-00000000e2' || t || '0')::uuid)
       <> (select v::jsonb from billing_gaps_state where k = 'before_' || t) then
      raise exception 'job % changed though its approval wrote nothing', t;
    end if;
  end loop;
  if not exists (select 1 from public.events where kind = 'proposal.failed'
                    and proposal_id = (select v::uuid from billing_gaps_state where k = 'p_c')) then
    raise exception 'no proposal.failed event for the stale approval';
  end if;
  if exists (select 1 from public.events
              where kind = 'invoice.review_gaps_applied'
                and proposal_id in (select v::uuid from billing_gaps_state where k in ('p_c', 'p_d', 'p_e', 'p_e2'))) then
    raise exception 'a run that wrote nothing emitted invoice.review_gaps_applied';
  end if;
end
$$;

-- 7d. the executor checks every line itself (op_validate_input never looks
--     inside lines[]), before it touches the job
do $$
declare
  p     public.proposals;
  base  jsonb;
  line  jsonb;
  bad   jsonb;
  bads  jsonb[];
  n     bigint := (select count(*) from public.events);
begin
  select * into p from public.proposals where id = (select v::uuid from billing_gaps_state where k = 'p_e2');
  base := p.input;
  line := base -> 'lines' -> 0;
  bads := array[
    '[]'::jsonb,
    (select jsonb_agg(line || jsonb_build_object('finding_id', 'equip:dehu:' || g)) from generate_series(1, 41) g),
    jsonb_build_array('"a line"'::jsonb),
    jsonb_build_array(line || '{"finding_id": "Equip Dehu"}'),
    jsonb_build_array(line - 'finding_id'),
    jsonb_build_array(line, line),
    jsonb_build_array(line || '{"desc": ""}'),
    jsonb_build_array(line || jsonb_build_object('desc', repeat('x', 301))),
    jsonb_build_array(line || '{"qty": "5"}'),
    jsonb_build_array(line || '{"qty": -1}'),
    jsonb_build_array(line || '{"unit": "XX"}'),
    jsonb_build_array(line - 'unit'),
    jsonb_build_array(line || '{"price": "85"}'),
    jsonb_build_array(line || '{"price": -85}'),
    jsonb_build_array(line || '{"amount": "425"}'),
    jsonb_build_array(line || '{"class": 3}'),
    jsonb_build_array(line || jsonb_build_object('room', repeat('x', 61))),
    jsonb_build_array(line || jsonb_build_object('code', repeat('x', 21))),
    jsonb_build_array(line || jsonb_build_object('basis', repeat('x', 301))),
    jsonb_build_array(line || jsonb_build_object('refs', (select jsonb_agg(g) from generate_series(1, 11) g)))
  ];
  foreach bad in array bads loop
    p.input := jsonb_set(base, '{lines}', bad);
    begin
      perform public.op_exec_invoice_review_gaps(p, p.input, 'human', '00000000-0000-0000-0000-00000000e211');
      raise exception 'the executor accepted lines %', left(bad::text, 200);
    exception when others then
      if sqlerrm !~ '^invoice\.review_gaps: ' then raise; end if;
    end;
  end loop;

  p.input := base || '{"job_id": "00000000-0000-0000-0000-00000000e2a0"}';
  begin
    perform public.op_exec_invoice_review_gaps(p, p.input, 'human', '00000000-0000-0000-0000-00000000e211');
    raise exception 'the executor ran an input naming another job';
  exception when others then
    if sqlerrm !~ '^invoice\.review_gaps: input job_id' then raise; end if;
  end;

  if (select data from public.field_projects where id = '00000000-0000-0000-0000-00000000e2e0')
     <> (select v::jsonb from billing_gaps_state where k = 'before_e')
     or (select count(*) from public.events) <> n then
    raise exception 'a refused executor run wrote something';
  end if;
end
$$;

-- 8. who may call what: the door is the worker's alone; a revoked grant is
--    op_propose's 42501, through the door
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.billing_review_gaps_file('00000000-0000-0000-0000-00000000e2b0', 7, null, null, null);
    raise exception 'a signed-in owner called the filing door';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.billing_invoices_fingerprint('{}');
    raise exception 'a signed-in owner called the fingerprint';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;
reset role;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
begin
  begin
    perform public.billing_invoices_fingerprint('{}');
    raise exception 'the service role called the fingerprint';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;
reset role;

savepoint s;
update public.agent_authority set revoked_at = now()
 where agent_id = '193d7dd0-74f9-407d-9891-8cb7aab22f82' and operation = 'invoice.review_gaps';
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000e2b0';
begin
  begin
    perform public.billing_review_gaps_file(b, 7,
      (select v::jsonb from billing_gaps_state where k = 'input')
      || jsonb_build_object('job_id', b, 'findings_hash', md5('gaps b2'), 'base_rev', 7), 'Add 3 lines', '[]');
    raise exception 'the door filed for agent:billing with its grant revoked';
  exception when insufficient_privilege then
    if sqlerrm !~ 'may not propose' then raise; end if;
  end;
end
$$;
rollback to savepoint s;
reset role;

-- 9. where pg_cron exists, the scheduled command itself: run twice on one
--    Alaska date, it is one billing.reconcile row for agent:billing
do $$
declare
  cmd text;
  d   text := to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD');
  q   public.jobs_queue;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed here; the billing-reconcile-nightly command not run';
    return;
  end if;
  select command into cmd from cron.job where jobname = 'billing-reconcile-nightly';
  execute cmd;
  execute cmd;
  if (select count(*) from public.jobs_queue where idempotency_key = 'billing.reconcile:' || d) <> 1 then
    raise exception 'the nightly command did not enqueue exactly one row for %', d;
  end if;
  select * into q from public.jobs_queue where idempotency_key = 'billing.reconcile:' || d;
  if q.kind <> 'billing.reconcile' or q.payload <> jsonb_build_object('run_date', d) or q.priority <> -10
     or q.principal_kind <> 'agent' or q.principal_id <> '193d7dd0-74f9-407d-9891-8cb7aab22f82' then
    raise exception 'the nightly row is % % priority % for %/%', q.kind, q.payload, q.priority, q.principal_kind, q.principal_id;
  end if;
end
$$;

-- 10a. h: a card past its expiry that no sweep has marked yet is offered
--      again as offer 1 (the door sweeps it to expired first); that open
--      card stands; a card a sweep marked expired, and one superseded by
--      other findings, are offered again too, and that filing supersedes the
--      open row as any filing does
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  h    constant uuid := '00000000-0000-0000-0000-00000000e3a0';
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', h, 'base_rev', 7, 'rate_invoice_id', md5('gaps-test-h:inv')::uuid);
  h1   jsonb := base || jsonb_build_object('findings_hash', md5('gaps h1'));
  r    jsonb;
  p0   public.proposals;
  p1   public.proposals;
  p    public.proposals;
  hx   uuid;
begin
  r := public.billing_review_gaps_file(h, 7, h1, 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' then raise exception 'h was not filed: %', r; end if;
  select * into p0 from public.proposals where id = (r ->> 'proposal_id')::uuid;

  -- fourteen days on, nobody answered: past its expiry, still proposed
  update public.proposals set expires_at = now() - interval '1 second' where id = p0.id;
  r := public.billing_review_gaps_file(h, 7, h1, 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r ->> 'status' <> 'proposed' or r -> 'superseded' <> '0'
     or (r ->> 'proposal_id')::uuid = p0.id then
    raise exception 'an expired gap refiled answered %', r;
  end if;
  if (select status from public.proposals where id = p0.id) <> 'expired'
     or not exists (select 1 from public.events where kind = 'proposal.expired' and proposal_id = p0.id) then
    raise exception 'the door did not sweep the expired card first: it is %', (select status from public.proposals where id = p0.id);
  end if;
  select * into p1 from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if p1.input -> 'offer' <> '1' or (p1.input - 'offer') <> (p0.input - 'offer')
     or p1.idempotency_key <> left(p0.idempotency_key, -1) || '1' or p0.idempotency_key !~ ':0$'
     or p1.status <> 'proposed' or p1.proposed_via <> 'agent' or p1.sms_code is null
     or p1.expires_at <> now() + interval '14 days' or p1.supersedes_id is not null then
    raise exception 'the second offer is % % (key %, supersedes %)', p1.status, p1.input, p1.idempotency_key, p1.supersedes_id;
  end if;

  -- still open: the same gap again is that card
  r := public.billing_review_gaps_file(h, 7, h1, 'again', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', p1.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'an open second offer refiled answered %', r;
  end if;

  -- a card some sweep already marked expired: offer 2
  update public.proposals set status = 'expired' where id = p1.id;
  r := public.billing_review_gaps_file(h, 7, h1, 'Add 3 lines', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or p.input -> 'offer' <> '2' then
    raise exception 'a swept gap refiled answered % (offer %)', r, p.input -> 'offer';
  end if;

  -- other findings supersede offer 2; the first findings back again are
  -- offer 3, which supersedes the other findings' card
  r := public.billing_review_gaps_file(h, 7, base || jsonb_build_object('findings_hash', md5('gaps h2')), 'Add 3 lines', '[]');
  hx := (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '1'
     or (select result from public.proposals where id = p.id) <> jsonb_build_object('superseded_by', hx) then
    raise exception 'other findings over offer 2 answered %', r;
  end if;
  r := public.billing_review_gaps_file(h, 7, h1, 'Add 3 lines', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '1' or p.input -> 'offer' <> '3' or p.supersedes_id is distinct from hx
     or (select result from public.proposals where id = hx) <> jsonb_build_object('superseded_by', p.id) then
    raise exception 'a superseded gap refiled answered % (offer %, supersedes %)', r, p.input -> 'offer', p.supersedes_id;
  end if;
  if (select count(*) from public.proposals where job_id = h) <> 5 then
    raise exception 'h holds % proposals, not 5', (select count(*) from public.proposals where job_id = h);
  end if;
end
$$;
release savepoint s;
reset role;

-- 10b. i: the owner declines a card. The same findings on the same invoices
--      stay quiet, and supersede the job's open card under other findings
--      (findings_changed); a payment changes nothing billed, so they stay
--      quiet after one too, and a card filed before a payment still
--      approves; once the invoice lines change, the gap files afresh
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i constant uuid := '00000000-0000-0000-0000-00000000e3b0';
  r jsonb;
begin
  r := public.billing_review_gaps_file(i, 7,
         (select v::jsonb from billing_gaps_state where k = 'input')
         || jsonb_build_object('job_id', i, 'findings_hash', md5('gaps i1'), 'base_rev', 7), 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' then raise exception 'i was not filed: %', r; end if;
  insert into billing_gaps_state values ('p_i1', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_decline((select v::uuid from billing_gaps_state where k = 'p_i1'), 'Billed it by hand');
  if p.status <> 'declined' then raise exception 'the owner''s decline left the proposal %', p.status; end if;
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i    constant uuid := '00000000-0000-0000-0000-00000000e3b0';
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', i, 'base_rev', 7);
  p1   uuid := (select v::uuid from billing_gaps_state where k = 'p_i1');
  r    jsonb;
  i2   uuid;
begin
  r := public.billing_review_gaps_file(i, 7, base || jsonb_build_object('findings_hash', md5('gaps i2')), 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' then
    raise exception 'other findings beside a declined card answered %', r;
  end if;
  i2 := (r ->> 'proposal_id')::uuid;

  r := public.billing_review_gaps_file(i, 7, base || jsonb_build_object('findings_hash', md5('gaps i1')), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', p1, 'status', 'declined', 'superseded', 1) then
    raise exception 'refiling a declined gap answered %', r;
  end if;
  if (select status from public.proposals where id = i2) <> 'superseded'
     or (select result from public.proposals where id = i2) <> '{"superseded_reason": "findings_changed"}'
     or not exists (select 1 from public.events
                     where kind = 'proposal.superseded' and proposal_id = i2
                       and data = '{"superseded_reason": "findings_changed"}') then
    raise exception 'the open card under other findings is % with %',
      (select status from public.proposals where id = i2), (select result from public.proposals where id = i2);
  end if;
  r := public.billing_review_gaps_file(i, 7, base || jsonb_build_object('findings_hash', md5('gaps i1')), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', p1, 'status', 'declined', 'superseded', 0) then
    raise exception 'refiling a declined gap twice answered %', r;
  end if;
  if (select count(*) from public.proposals where job_id = i) <> 2
     or (select status from public.proposals where id = p1) <> 'declined' then
    raise exception 'a declined gap was offered again';
  end if;
end
$$;
release savepoint s;
reset role;

-- the QuickBooks payment pull (14:30 UTC, before the nightly run) marks the
-- invoice partially paid: rev + 1, no line touched
update public.field_projects
   set data = jsonb_set(jsonb_set(data, '{invoices,0,status}', '"partially_paid"'), '{rev}', '8')
 where id = '00000000-0000-0000-0000-00000000e3b0';

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i    constant uuid := '00000000-0000-0000-0000-00000000e3b0';
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', i, 'base_rev', 8);
  p1   uuid := (select v::uuid from billing_gaps_state where k = 'p_i1');
  r    jsonb;
begin
  r := public.billing_review_gaps_file(i, 8, base || jsonb_build_object('findings_hash', md5('gaps i1')), 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', p1, 'status', 'declined', 'superseded', 0) then
    raise exception 'a payment brought a declined gap back: %', r;
  end if;
  r := public.billing_review_gaps_file(i, 8, base || jsonb_build_object('findings_hash', md5('gaps i3')), 'Add 3 lines', '[]');
  if r -> 'filed' <> 'true' then raise exception 'other findings after the payment answered %', r; end if;
  insert into billing_gaps_state values ('p_i3', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

-- the next payment marks it paid before the owner gets to the new card: his
-- approval still adds the lines (rev 9 → 10)
update public.field_projects
   set data = jsonb_set(jsonb_set(data, '{invoices,0,status}', '"paid"'), '{rev}', '9')
 where id = '00000000-0000-0000-0000-00000000e3b0';

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e211", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from billing_gaps_state where k = 'p_i3'), 'inbox');
  if p.status <> 'executed' or p.result ->> 'status' <> 'added' or (p.result ->> 'rev')::int <> 10 then
    raise exception 'a card filed before a payment approved as % (% %)', p.status, p.error, p.result;
  end if;
end
$$;
release savepoint s;
reset role;

update public.field_projects
   set data = jsonb_set(jsonb_set(data, '{invoices,0,items,0,qty}', '"4"'), '{rev}', '11')
 where id = '00000000-0000-0000-0000-00000000e3b0';

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i constant uuid := '00000000-0000-0000-0000-00000000e3b0';
  p public.proposals;
  r jsonb;
begin
  r := public.billing_review_gaps_file(i, 11,
         (select v::jsonb from billing_gaps_state where k = 'input')
         || jsonb_build_object('job_id', i, 'findings_hash', md5('gaps i1'), 'base_rev', 11), 'Add 3 lines', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' or p.input -> 'offer' <> '0'
     or p.input ->> 'invoice_fingerprint' = (select input ->> 'invoice_fingerprint' from public.proposals
                                              where id = (select v::uuid from billing_gaps_state where k = 'p_i1')) then
    raise exception 'a declined gap on changed invoices answered % (input %)', r, p.input;
  end if;
end
$$;
release savepoint s;
reset role;

-- 10c. j: after 50 offers (0-49) of one gap on one set of invoices, each
--      expired or superseded unanswered, the door offers it no more: it
--      answers with the last offer's row, files nothing, and still
--      supersedes the job's open card under other findings
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  j    constant uuid := '00000000-0000-0000-0000-00000000e3c0';
  base jsonb := (select v::jsonb from billing_gaps_state where k = 'input')
                || jsonb_build_object('job_id', j, 'base_rev', 7);
  j1   jsonb := base || jsonb_build_object('findings_hash', md5('gaps j1'));
  r    jsonb;
  last uuid;
  jx   uuid;
begin
  for k in 0 .. 49 loop
    r := public.billing_review_gaps_file(j, 7, j1, 'Add 3 lines', '[]');
    last := (r ->> 'proposal_id')::uuid;
    if r -> 'filed' <> 'true' or (select input -> 'offer' from public.proposals where id = last) <> to_jsonb(k) then
      raise exception 'offer % answered %', k, r;
    end if;
    -- nobody answers it: expired and superseded in turn
    update public.proposals set status = case when k % 2 = 0 then 'expired' else 'superseded' end where id = last;
  end loop;

  r := public.billing_review_gaps_file(j, 7, base || jsonb_build_object('findings_hash', md5('gaps j2')), 'Add 3 lines', '[]');
  jx := (r ->> 'proposal_id')::uuid;
  if r -> 'filed' <> 'true' or r -> 'superseded' <> '0' then
    raise exception 'other findings beside the capped gap answered %', r;
  end if;

  r := public.billing_review_gaps_file(j, 7, j1, 'Add 3 lines', '[]');
  if r <> jsonb_build_object('filed', false, 'proposal_id', last, 'status', 'superseded', 'superseded', 1) then
    raise exception 'a gap past its 50th offer answered %', r;
  end if;
  if (select result from public.proposals where id = jx) <> '{"superseded_reason": "findings_changed"}' then
    raise exception 'the open card beside the capped gap is %', (select result from public.proposals where id = jx);
  end if;
  if (select count(*) from public.proposals where job_id = j) <> 51 then
    raise exception 'j holds % proposals, not 51', (select count(*) from public.proposals where job_id = j);
  end if;
end
$$;
release savepoint s;
reset role;

rollback;
