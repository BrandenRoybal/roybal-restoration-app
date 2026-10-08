-- ============================================================================
-- Assertions for 0023_receipts_qbo_link.sql (receipts phase 3, v1: the
-- nightly QuickBooks match notes what is already in QuickBooks, files one
-- receipts.qbo_link card per job for what needs a tag or a photo, and the
-- owner's approval queues one 'qbo' outbox row per receipt).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/receipts_qbo_link.test.sql <staging url>
-- Everything it writes is rolled back (sequence values it draws are not; that
-- is what every proposal does anyway).
--
-- The rules it holds 0023 to:
--   1. The catalog row is money, runtime sql, owner-approved, with the
--      template, emits, amount field and schema the worker and the inbox
--      read; receipts.qbo_match is a queue kind, never an operation; every
--      proposable operation has an executor.
--   2. The fingerprint, the executor and the trigger function are callable
--      by nobody; the filing door, the note door and the ping by
--      service_role alone; the picker by authenticated alone. All are owned
--      by postgres, SECURITY DEFINER, with a pinned search_path. (The
--      agent:integrations seed and grant are contract_tables.test.sql 12 and
--      spine_lanes.test.sql 2c.)
--   3. Both tables have RLS on, one owner/office SELECT policy, no write
--      grant for anon, authenticated or the service role, and the partial
--      unique index that lets one expense be claimed by one receipt; the
--      trigger is AFTER UPDATE OF status FOR EACH ROW on outbox.
--   4. Where pg_cron exists, receipts-qbo-match-nightly is scheduled at 14:50
--      UTC, active, and its command enqueues one receipts.qbo_match row per
--      Alaska date for agent:integrations.
--   5. The fingerprint moves with each receipt's amount, date, photo, deletion
--      and move, and with nothing else.
--   6. The note door writes in_qbo, unmatched and conflict rows, rewrites
--      nothing unchanged, never touches a queued, done or failed row, removes
--      what left a job it covers (first, so an expense it held is free for
--      tonight's claim), refuses rows outside its jobs and receipt ids
--      qbo-proxy cannot carry, and turns a claim on an expense another
--      receipt holds into a conflict; the unique index refuses a second claim
--      written directly.
--   7. The filing door returns each of its shapes, refuses malformed input,
--      skips receipts edited since the worker read them, files as
--      agent:integrations (proposed_via agent, waiting on the owner, 14
--      days), stamps the fingerprint, the items hash and offer 0, returns the
--      open card for a repeated filing, supersedes the job's older open card,
--      offers a superseded or expired one again, and files afresh when the
--      job is relinked. A card that failed a filing-time check is offered
--      again once the receipts or the link are back as filed; one that failed
--      on its items stays quiet.
--   8. Office cannot approve. The owner's approval links the job the card
--      suggested, marks the receipt queued and writes one outbox row with the
--      payload qbo-proxy reads; approving again writes nothing. A later card
--      skips a receipt already done for the same expense and fails for a
--      different one.
--   9. A moved fingerprint fails the run with nothing written (no outbox row,
--      no link row, no job link); so does an expense another receipt holds, a
--      job relinked since filing, a malformed item and a malformed store
--      entry.
--  10. An edit may only drop items: a changed item, a foreign item or a
--      changed top-level field fails; a dropped one is simply not queued.
--  11. The trigger maps a sent outbox row to done (provider id, new sync
--      token) and a dead one to failed (the error), and the note door keeps
--      both. An approved store entry is queued with no expense id; sent, it
--      records the new expense, unless another receipt holds that one.
--  12. The picker refuses anyone but owner/office, a deleted or missing job
--      and a malformed id; it links, relinks (an unchanged pick writes
--      nothing) and unlinks, with events; owner and office read the links,
--      crew reads nothing.
--  13. qbo_service_ping answers true to the service role.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the catalog row
do $$
declare
  c public.operation_catalog;
  r record;
begin
  select * into c from public.operation_catalog where name = 'receipts.qbo_link' and version = 1;
  if not found then
    raise exception 'operation_catalog has no receipts.qbo_link@1';
  end if;
  if c.action_type is distinct from 'money' or c.runtime is distinct from 'sql' or c.approval_default is distinct from 'owner'
     or c.amount_field is distinct from 'total_usd' or c.emits is distinct from array['receipts.qbo_link_queued']
     or c.idempotency_template is distinct from 'receipts.qbo_link:{job_id}:{receipts_fingerprint}:{items_hash}:{offer}'
     or c.deprecated_at is not null then
    raise exception 'receipts.qbo_link@1 is %/%/%, amount %, emits %, template %, deprecated %',
      c.action_type, c.runtime, c.approval_default, c.amount_field, c.emits, c.idempotency_template, c.deprecated_at;
  end if;
  if c.definition_sha is distinct from md5(c.name || '@1:' || c.input_schema::text) then
    raise exception 'receipts.qbo_link@1 definition_sha is not md5(name@1:schema)';
  end if;
  -- the inbox titles a card with the description's first sentence
  if c.description not like 'Update QuickBooks for this job''s receipts. %' then
    raise exception 'receipts.qbo_link@1 description starts %', left(c.description, 80);
  end if;
  if c.input_schema -> 'required'
     is distinct from '["job_id", "job_name", "receipts_fingerprint", "items_hash", "offer", "qbo_customer_id", "items", "total_usd", "matcher"]'::jsonb
     or (c.input_schema ->> 'additionalProperties')::boolean is distinct from false then
    raise exception 'receipts.qbo_link@1 schema requires % (additionalProperties %)',
      c.input_schema -> 'required', c.input_schema -> 'additionalProperties';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k)
     is distinct from array['items', 'items_hash', 'job_id', 'job_name', 'link', 'matcher', 'offer', 'qbo_customer_id',
              'qbo_name', 'receipts_fingerprint', 'total_usd'] then
    raise exception 'receipts.qbo_link@1 schema fields are %',
      (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k);
  end if;
  if c.input_schema #>> '{properties,offer,type}' is distinct from 'integer'
     or c.input_schema #>> '{properties,link,type}' is distinct from 'object' then
    raise exception 'receipts.qbo_link@1 offer is % and link is %', c.input_schema #> '{properties,offer}', c.input_schema #> '{properties,link}';
  end if;
  if exists (select 1 from public.operation_catalog where name = 'receipts.qbo_match') then
    raise exception 'receipts.qbo_match is catalogued; it is a queue kind, and a catalogued name is proposable';
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


-- 2. the seven functions and their grants
do $$
declare
  fp     constant text := 'public.receipts_qbo_fingerprint(uuid, text[])';
  ex     constant text := 'public.op_exec_receipts_qbo_link(public.proposals, jsonb, text, uuid)';
  door   constant text := 'public.receipts_qbo_link_file(uuid, jsonb, text, jsonb, interval)';
  note   constant text := 'public.receipt_qbo_links_note(uuid[], jsonb)';
  pick   constant text := 'public.job_qbo_link_set(uuid, text, text, text)';
  trig   constant text := 'public.outbox_qbo_link_result()';
  ping   constant text := 'public.qbo_service_ping()';
  f text;
  problems text[] := '{}';
begin
  foreach f in array array[fp, ex, door, note, pick, trig, ping] loop
    if to_regprocedure(f) is null then
      problems := problems || format('%s is missing', f);
      continue;
    end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = f::regprocedure) is distinct from 'postgres' then
      problems := problems || format('%s is not owned by postgres', f);
    end if;
    if not coalesce((select 'search_path=public, pg_temp' = any (proconfig) from pg_proc where oid = f::regprocedure), false) then
      problems := problems || format('%s has no pinned search_path', f);
    end if;
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      problems := problems || format('%s is not SECURITY DEFINER', f);
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      problems := problems || format('anon can execute %s', f);
    end if;
    if f is distinct from pick and has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('authenticated can execute %s', f);
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'receipts qbo link functions are wrong: %', array_to_string(problems, '; ');
  end if;

  foreach f in array array[fp, ex, trig, pick] loop
    if has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role can execute %s', f);
    end if;
  end loop;
  foreach f in array array[door, note, ping] loop
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role cannot execute %s', f);
    end if;
  end loop;
  if not has_function_privilege('authenticated', pick, 'EXECUTE') then
    problems := problems || 'authenticated cannot execute the picker'::text;
  end if;
  if (select provolatile from pg_proc where oid = fp::regprocedure) is distinct from 's' then
    problems := problems || 'the fingerprint is not STABLE (it reads job_receipts)'::text;
  end if;
  if pg_get_function_arguments(door::regprocedure) !~ 'p_expires_in interval DEFAULT ''14 days''::interval' then
    problems := problems || format('the door''s expiry default is not 14 days: %s', pg_get_function_arguments(door::regprocedure));
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'receipts qbo link grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 3. the tables, their reads, the one-expense index and the trigger
do $$
declare
  t text;
  problems text[] := '{}';
begin
  foreach t in array array['public.job_qbo_links', 'public.receipt_qbo_links'] loop
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      problems := problems || format('RLS is off on %s', t);
    end if;
    if (select pg_get_userbyid(relowner) from pg_class where oid = t::regclass) is distinct from 'postgres' then
      problems := problems || format('%s is not owned by postgres', t);
    end if;
    if (select count(*) from pg_policies where schemaname || '.' || tablename = t) is distinct from 1
       or not exists (select 1 from pg_policies
                       where schemaname || '.' || tablename = t and cmd = 'SELECT' and permissive = 'PERMISSIVE'
                         and roles = array['authenticated']::name[] and qual ~ 'role_is\(.*owner.*office') then
      problems := problems || format('%s does not have exactly one owner/office SELECT policy', t);
    end if;
    if has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      problems := problems || format('anon holds a privilege on %s', t);
    end if;
    if has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or not has_table_privilege('authenticated', t, 'SELECT') then
      problems := problems || format('authenticated holds more or less than SELECT on %s', t);
    end if;
    if has_table_privilege('service_role', t, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or not has_table_privilege('service_role', t, 'SELECT') then
      problems := problems || format('service_role holds more or less than SELECT on %s (the doors write)', t);
    end if;
  end loop;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'receipt_qbo_links' and indexname = 'receipt_qbo_links_txn_key'
                    and indexdef ~* 'UNIQUE INDEX .* \(qbo_txn_type, qbo_txn_id\) WHERE \(state = ANY'
                    and indexdef ~ 'in_qbo' and indexdef ~ 'queued' and indexdef ~ 'done'
                    and indexdef !~ 'unmatched' and indexdef !~ 'failed') then
    problems := problems || 'receipt_qbo_links_txn_key is not a unique (qbo_txn_type, qbo_txn_id) index over in_qbo, queued and done'::text;
  end if;

  -- AFTER (0) | ROW (1) | UPDATE (16) = 17, on status only, when channel qbo
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.outbox'::regclass and tgname = 'outbox_qbo_link_result'
                    and tgfoid = 'public.outbox_qbo_link_result()'::regprocedure
                    and tgtype = 17 and tgenabled = 'O' and not tgisinternal
                    and tgattr::text = (select attnum::text from pg_attribute
                                         where attrelid = 'public.outbox'::regclass and attname = 'status')
                    and pg_get_triggerdef(oid) ~ 'channel = ''qbo''') then
    problems := problems || 'outbox_qbo_link_result is not an enabled AFTER UPDATE OF status FOR EACH ROW trigger on outbox for qbo'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'receipts qbo link tables are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 4. the nightly cron row, where pg_cron exists
do $$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed here; receipts-qbo-match-nightly not checked';
    return;
  end if;
  select * into j from cron.job where jobname = 'receipts-qbo-match-nightly';
  if not found or not j.active then
    raise exception 'receipts-qbo-match-nightly is not scheduled and active';
  end if;
  if j.schedule is distinct from '50 14 * * *' then
    raise exception 'receipts-qbo-match-nightly runs at %, not 50 14 * * *', j.schedule;
  end if;
  if j.command !~ 'public\.enqueue\(' or j.command !~ '''receipts\.qbo_match''' or j.command !~ '''run_date'''
     or j.command !~ '''receipts\.qbo_match:''' or j.command !~ 'America/Anchorage' or j.command !~ '-10'
     or j.command !~ '''agent''' or j.command !~ '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10' then
    raise exception 'receipts-qbo-match-nightly runs the wrong command: %', j.command;
  end if;
end
$$;


-- 5–13. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000f221', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rq-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000f222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rq-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000f223', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-rq-crew@example.invalid',   '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000f221', 'rq test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000f222', 'rq test office', 'office'),
  ('00000000-0000-0000-0000-00000000f223', 'rq test crew',   'crew')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- Jobs, their receipts projected into job_receipts by 0015's trigger.
-- a: 2156 Alston rd. (the Oct 7 shapes); b: deleted; c: 1192 Bemis Ct.;
-- d: its receipts change after filing; e: edits and a refusal
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object('id', j.id, 'rev', 3, 'updatedAt', '2026-10-01T10:00:00.000Z', 'title', j.title,
                          'receipts', j.receipts),
       j.deleted
  from (values
    ('00000000-0000-0000-0000-00000000f2a0'::uuid, '2156 Alston rd.', false, jsonb_build_array(
       jsonb_build_object('id', 'r-hd', 'vendor', 'Home Depot', 'date', '2026-09-30', 'amount', '1369.50',
                          'paidWith', 'card', 'cardLast4', '3176', 'receiptNo', '1303 00001 50615',
                          'photo', 'media:' || repeat('a', 64) || ':1234'),
       jsonb_build_object('id', 'r-sbs', 'vendor', 'Spenard Builders Supply', 'date', '2026-09-28', 'amount', '212.28',
                          'paidWith', 'account', 'receiptNo', '700624817', 'photo', 'media:' || repeat('b', 64) || ':99'),
       jsonb_build_object('id', 'r-sw', 'vendor', 'Sherwin-Williams', 'date', '2026-09-28', 'amount', '36.00',
                          'paidWith', 'account', 'receiptNo', '8066-9', 'photo', 'media:' || repeat('c', 64) || ':99'),
       jsonb_build_object('id', 'r-hd2', 'vendor', 'Home Depot', 'date', '2026-10-05', 'amount', '8.80',
                          'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('d', 64) || ':99'))),
    ('00000000-0000-0000-0000-00000000f2b0'::uuid, 'Trashed job', true, jsonb_build_array(
       jsonb_build_object('id', 'r-b1', 'vendor', 'Home Depot', 'date', '2026-09-30', 'amount', '10.00'))),
    ('00000000-0000-0000-0000-00000000f2c0'::uuid, '1192 Bemis Ct.', false, jsonb_build_array(
       jsonb_build_object('id', 'r-c1', 'vendor', 'Home Depot', 'date', '2026-10-02', 'amount', '45.06',
                          'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('e', 64) || ':99'))),
    ('00000000-0000-0000-0000-00000000f2d0'::uuid, 'Fingerprint job', false, jsonb_build_array(
       jsonb_build_object('id', 'r-d1', 'vendor', 'Home Depot', 'date', '2026-10-01', 'amount', '27.90',
                          'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('f', 64) || ':99'))),
    ('00000000-0000-0000-0000-00000000f2e0'::uuid, 'Edits job', false, jsonb_build_array(
       jsonb_build_object('id', 'r-e1', 'vendor', 'Lowe''s', 'date', '2026-10-01', 'amount', '50.00',
                          'paidWith', 'card', 'photo', 'media:' || repeat('1', 64) || ':99'),
       jsonb_build_object('id', 'r-e2', 'vendor', 'Lowe''s', 'date', '2026-10-02', 'amount', '-12.00',
                          'paidWith', 'card', 'photo', 'media:' || repeat('2', 64) || ':99')))
  ) as j(id, title, deleted, receipts);

-- a worker serving the qbo lane (the door's switch)
insert into public.worker_heartbeats (worker_id, at, meta)
values ('rq-test-worker', now(), '{"channels": ["sms", "email", "qbo"]}');

create temp table rq_state (k text primary key, v text);
grant all on rq_state to anon, authenticated, service_role;

-- What the worker files for a (the Oct 7 Home Depot charge, Purchase 10577):
-- tag it to Pollen Apartments and attach the photo; the job has no link yet,
-- so the card suggests one from the expenses already tagged.
insert into rq_state values ('item_hd', jsonb_build_object(
  'receipt_id', 'r-hd', 'vendor', 'Home Depot', 'date', '2026-09-30', 'amount', 1369.50,
  'receipt_no', '1303 00001 50615', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10577', 'qbo_sync_token', '0',
  'qbo_doc_number', null, 'qbo_account_name', '3176 - Citi - Home Depot Consumer Credit Card', 'qbo_total', 1369.50,
  'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('a', 64) || ':1234'),
  'project_ref', '412739523', 'read_photo_ref', 'media:' || repeat('a', 64) || ':1234')::text);
insert into rq_state values ('input_a', jsonb_build_object(
  'job_id', '00000000-0000-0000-0000-00000000f2a0', 'job_name', '2156 Alston rd.',
  'qbo_customer_id', '112', 'qbo_name', 'Pollen Apartments',
  'link', jsonb_build_object('qbo_customer_id', '112', 'qbo_name', 'Pollen Apartments', 'qbo_project_ref', '412739523',
                             'source', 'suggested_tagged', 'why', '2 expenses on this job are tagged to Pollen Apartments'),
  'items', jsonb_build_array((select v::jsonb from rq_state where k = 'item_hd')),
  'total_usd', 1369.50, 'matcher', 'receipts.qbo_match@1')::text);
-- the fingerprint the door should stamp (the service role cannot call it)
insert into rq_state values ('fp_a', public.receipts_qbo_fingerprint('00000000-0000-0000-0000-00000000f2a0', array['r-hd']));


-- 5. the fingerprint moves with what the owner approves and nothing else
do $$
declare
  d constant uuid := '00000000-0000-0000-0000-00000000f2d0';
  f text := public.receipts_qbo_fingerprint('00000000-0000-0000-0000-00000000f2d0', array['r-d1']);
  g text;
begin
  if coalesce(f, '') !~ '^[0-9a-f]{32}$' then raise exception 'the fingerprint is %', f; end if;
  if public.receipts_qbo_fingerprint(d, array['r-d1', 'r-d1']) is distinct from f then
    raise exception 'a repeated id moved the fingerprint';
  end if;
  if public.receipts_qbo_fingerprint(d, array['r-d1', 'r-none']) is not distinct from f
     or public.receipts_qbo_fingerprint(d, array['r-none']) is distinct from md5(jsonb_build_array(jsonb_build_object('id', 'r-none', 'missing', true))::text) then
    raise exception 'an id with no receipt on the job does not fingerprint as {id, missing}';
  end if;
  if public.receipts_qbo_fingerprint(d, '{}') is distinct from md5('[]') then
    raise exception 'no receipts does not fingerprint as the empty list';
  end if;

  -- not moved: fields the card does not stand on
  update public.field_projects set data = jsonb_set(jsonb_set(data, '{receipts,0,notes}', '"left the bag"'),
                                                    '{receipts,0,vendor}', '"The Home Depot"') where id = d;
  if public.receipts_qbo_fingerprint(d, array['r-d1']) is distinct from f then
    raise exception 'the fingerprint moved with the notes or the vendor';
  end if;

  -- moved: amount, date, photo, deletion, a move to another job
  update public.field_projects set data = jsonb_set(data, '{receipts,0,amount}', '"27.91"') where id = d;
  g := public.receipts_qbo_fingerprint(d, array['r-d1']);
  update public.field_projects set data = jsonb_set(data, '{receipts,0,amount}', '"27.90"') where id = d;
  if g is not distinct from f or public.receipts_qbo_fingerprint(d, array['r-d1']) is distinct from f then
    raise exception 'the fingerprint did not move with the amount, or did not come back';
  end if;
  update public.field_projects set data = jsonb_set(data, '{receipts,0,date}', '"2026-10-02"') where id = d;
  g := public.receipts_qbo_fingerprint(d, array['r-d1']);
  update public.field_projects set data = jsonb_set(data, '{receipts,0,date}', '"2026-10-01"') where id = d;
  if g is not distinct from f then raise exception 'the fingerprint did not move with the date'; end if;
  update public.field_projects set data = jsonb_set(data, '{receipts,0,photo}', to_jsonb('media:' || repeat('9', 64) || ':99')) where id = d;
  g := public.receipts_qbo_fingerprint(d, array['r-d1']);
  update public.field_projects set data = jsonb_set(data, '{receipts,0,photo}', to_jsonb('media:' || repeat('f', 64) || ':99')) where id = d;
  if g is not distinct from f then raise exception 'the fingerprint did not move with the photo'; end if;
  update public.field_projects set data = jsonb_set(data, '{receipts}', '[]') where id = d;
  g := public.receipts_qbo_fingerprint(d, array['r-d1']);
  if g is not distinct from f or g is not distinct from public.receipts_qbo_fingerprint(d, array['r-none']) then
    raise exception 'the fingerprint did not move with the deletion (or a deleted receipt reads as missing)';
  end if;
  update public.field_projects
     set data = jsonb_set(data, '{receipts}', jsonb_build_array(jsonb_build_object(
                  'id', 'r-d1', 'vendor', 'Home Depot', 'date', '2026-10-01', 'amount', '27.90',
                  'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('f', 64) || ':99')))
   where id = d;
  if public.receipts_qbo_fingerprint(d, array['r-d1']) is distinct from f then
    raise exception 'the restored receipt does not fingerprint as before';
  end if;

  -- moved to another job (c), with nothing else about it changed; undone
  begin
    update public.field_projects set data = jsonb_set(data, '{receipts}', '[]') where id = d;
    update public.field_projects
       set data = jsonb_set(data, '{receipts}', (data -> 'receipts') || jsonb_build_array(jsonb_build_object(
                    'id', 'r-d1', 'vendor', 'Home Depot', 'date', '2026-10-01', 'amount', '27.90',
                    'paidWith', 'card', 'cardLast4', '3176', 'photo', 'media:' || repeat('f', 64) || ':99')))
     where id = '00000000-0000-0000-0000-00000000f2c0';
    if not exists (select 1 from public.job_receipts
                    where job_id = '00000000-0000-0000-0000-00000000f2c0' and id = 'r-d1' and deleted_at is null) then
      raise exception 'the move to c was not projected';
    end if;
    if public.receipts_qbo_fingerprint(d, array['r-d1']) is not distinct from f then
      raise exception 'the fingerprint did not move when the receipt moved to another job';
    end if;
    raise sqlstate 'RQ005';
  exception when sqlstate 'RQ005' then
    null;
  end;
  if public.receipts_qbo_fingerprint(d, array['r-d1']) is distinct from f then
    raise exception 'undoing the move did not restore the fingerprint';
  end if;
end
$$;


-- 6. the note door, as the worker (service role)
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a  constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  c  constant uuid := '00000000-0000-0000-0000-00000000f2c0';
  rows_a jsonb := jsonb_build_array(
    jsonb_build_object('receipt_id', 'r-sbs', 'job_id', a, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
                       'qbo_txn_id', '10563', 'qbo_sync_token', '0', 'qbo_customer_id', '112', 'amount', 212.28,
                       'receipt_date', '2026-09-28', 'detail', '{"qbo_doc_number": "700624817"}'::jsonb),
    jsonb_build_object('receipt_id', 'r-sw', 'job_id', a, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase',
                       'qbo_txn_id', '10566', 'qbo_sync_token', '0', 'qbo_customer_id', '112', 'amount', 36.00,
                       'receipt_date', '2026-09-28', 'detail', '{"qbo_doc_number": "80669163000926"}'::jsonb),
    jsonb_build_object('receipt_id', 'r-hd2', 'job_id', a, 'state', 'unmatched', 'amount', 8.80,
                       'receipt_date', '2026-10-05', 'detail', '{"reason": "waiting_feed"}'::jsonb));
  r  jsonb;
  l  public.receipt_qbo_links;
  at timestamptz;
begin
  -- refusals write nothing
  begin
    perform public.receipt_qbo_links_note(array[a], rows_a || jsonb_build_array(jsonb_build_object(
      'receipt_id', 'r-x', 'job_id', a, 'state', 'queued', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '1')));
    raise exception 'the note door wrote a queued row';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipt_qbo_links_note(array[c], rows_a);
    raise exception 'the note door wrote rows of a job the call does not cover';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipt_qbo_links_note(array[a], jsonb_build_array(jsonb_build_object(
      'receipt_id', 'r-sbs', 'job_id', a, 'state', 'in_qbo')));
    raise exception 'the note door wrote an in_qbo row naming no expense';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipt_qbo_links_note(array[a], rows_a || jsonb_build_array(rows_a -> 0));
    raise exception 'the note door wrote one receipt twice';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipt_qbo_links_note(array[a], jsonb_build_array(jsonb_build_object(
      'receipt_id', 'r-hd2', 'job_id', a, 'state', 'unmatched', 'receipt_date', '2026-02-30')));
    raise exception 'the note door wrote a date that is not on the calendar';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipt_qbo_links_note(array[a], jsonb_build_array(jsonb_build_object(
      'receipt_id', repeat('r', 65), 'job_id', a, 'state', 'unmatched')));
    raise exception 'the note door wrote a receipt id longer than qbo-proxy''s 64 characters';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from public.receipt_qbo_links) then
    raise exception 'a refused note left a row behind';
  end if;

  r := public.receipt_qbo_links_note(array[a], rows_a);
  if r is distinct from '{"written": 3, "kept": 0, "removed": 0}' then raise exception 'the first note answered %', r; end if;
  select * into l from public.receipt_qbo_links where receipt_id = 'r-sbs';
  if l.job_id is distinct from a or l.state is distinct from 'in_qbo' or l.qbo_txn_type is distinct from 'Purchase' or l.qbo_txn_id is distinct from '10563'
     or l.qbo_sync_token is distinct from '0' or l.qbo_customer_id is distinct from '112' or l.amount is distinct from 212.28 or l.receipt_date is distinct from '2026-09-28'
     or l.changes is distinct from '{}' or l.proposal_id is not null or l.outbox_id is not null
     or l.detail is distinct from '{"qbo_doc_number": "700624817"}' then
    raise exception 'the in_qbo row is %', to_jsonb(l);
  end if;
  if (select detail ->> 'reason' from public.receipt_qbo_links where receipt_id = 'r-hd2') is distinct from 'waiting_feed' then
    raise exception 'the unmatched row lost its reason';
  end if;

  -- the same night twice rewrites nothing
  at := l.updated_at;
  r := public.receipt_qbo_links_note(array[a], rows_a);
  if r is distinct from '{"written": 0, "kept": 0, "removed": 0}' then raise exception 'an unchanged note answered %', r; end if;

  -- 1192 Bemis Ct.'s charge "matched" the expense r-sbs holds: a conflict, no claim
  r := public.receipt_qbo_links_note(array[c], jsonb_build_array(jsonb_build_object(
    'receipt_id', 'r-c1', 'job_id', c, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10563',
    'amount', 45.06, 'receipt_date', '2026-10-02', 'detail', '{}'::jsonb)));
  select * into l from public.receipt_qbo_links where receipt_id = 'r-c1';
  if r is distinct from '{"written": 1, "kept": 0, "removed": 0}' or l.state is distinct from 'conflict' or l.detail ->> 'reason' is distinct from 'claimed_by_other'
     or (select state from public.receipt_qbo_links where receipt_id = 'r-sbs') is distinct from 'in_qbo' then
    raise exception 'a claim on a held expense answered % and wrote %', r, to_jsonb(l);
  end if;

  -- r-hd2 left the job: tonight's rows for a no longer name it
  r := public.receipt_qbo_links_note(array[a], jsonb_build_array(rows_a -> 0, rows_a -> 1));
  if r is distinct from '{"written": 0, "kept": 0, "removed": 1}' or exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-hd2') then
    raise exception 'a receipt that left the job answered %', r;
  end if;
  if not exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-c1') then
    raise exception 'a note for job a removed a row of job c, which it does not cover';
  end if;

  -- r-sw left the job and r-hd2 matched the expense it held, in one night:
  -- the departed row goes first, so the expense is free for r-hd2's claim
  -- (not a conflict until the next night); then back as it was, the same way
  r := public.receipt_qbo_links_note(array[a], jsonb_build_array(rows_a -> 0, jsonb_build_object(
    'receipt_id', 'r-hd2', 'job_id', a, 'state', 'in_qbo', 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10566',
    'qbo_sync_token', '0', 'qbo_customer_id', '112', 'amount', 8.80, 'receipt_date', '2026-10-05', 'detail', '{}'::jsonb)));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 1}'
     or (select state from public.receipt_qbo_links where receipt_id = 'r-hd2') is distinct from 'in_qbo'
     or exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-sw') then
    raise exception 'a claim on the expense a departed receipt held answered % (r-hd2 is %)', r,
      (select state from public.receipt_qbo_links where receipt_id = 'r-hd2');
  end if;
  r := public.receipt_qbo_links_note(array[a], jsonb_build_array(rows_a -> 0, rows_a -> 1));
  if r is distinct from '{"written": 1, "kept": 0, "removed": 1}'
     or (select state from public.receipt_qbo_links where receipt_id = 'r-sw') is distinct from 'in_qbo'
     or exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-hd2') then
    raise exception 'putting r-sw back answered %', r;
  end if;
end
$$;
release savepoint s;
reset role;

-- the approval path's rows are never the note door's: queued and done are
-- kept, never rewritten and never removed
savepoint q;
update public.receipt_qbo_links set state = 'queued', changes = '{attach}', outbox_id = gen_random_uuid() where receipt_id = 'r-sw';
set local role service_role;
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  r jsonb;
begin
  r := public.receipt_qbo_links_note(array[a], jsonb_build_array(jsonb_build_object(
    'receipt_id', 'r-sw', 'job_id', a, 'state', 'unmatched', 'detail', '{"reason": "not_found"}'::jsonb)));
  if r is distinct from '{"written": 0, "kept": 1, "removed": 1}' then raise exception 'a note over a queued row answered %', r; end if;
  if (select state from public.receipt_qbo_links where receipt_id = 'r-sw') is distinct from 'queued'
     or (select changes from public.receipt_qbo_links where receipt_id = 'r-sw') is distinct from '{attach}' then
    raise exception 'the note door rewrote a queued row';
  end if;
  r := public.receipt_qbo_links_note(array[a], '[]');
  if r is distinct from '{"written": 0, "kept": 0, "removed": 0}' or not exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-sw') then
    raise exception 'the note door removed a queued row (answered %)', r;
  end if;
end
$$;
reset role;
-- and a second claim on one expense, written past the doors, is refused
do $$
begin
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state, qbo_txn_type, qbo_txn_id)
    values ('r-dup', '00000000-0000-0000-0000-00000000f2c0', 'done', 'Purchase', '10566');
    raise exception 'two receipts claim Purchase 10566';
  exception when unique_violation then null;
  end;
end
$$;
rollback to savepoint q;
release savepoint q;

-- put a's two in_qbo rows back as the note door left them
set local role service_role;
select public.receipt_qbo_links_note(array['00000000-0000-0000-0000-00000000f2a0'::uuid], jsonb_build_array(
  jsonb_build_object('receipt_id', 'r-sbs', 'job_id', '00000000-0000-0000-0000-00000000f2a0', 'state', 'in_qbo',
                     'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10563', 'qbo_sync_token', '0', 'qbo_customer_id', '112',
                     'amount', 212.28, 'receipt_date', '2026-09-28', 'detail', '{"qbo_doc_number": "700624817"}'::jsonb),
  jsonb_build_object('receipt_id', 'r-sw', 'job_id', '00000000-0000-0000-0000-00000000f2a0', 'state', 'in_qbo',
                     'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10566', 'qbo_sync_token', '0', 'qbo_customer_id', '112',
                     'amount', 36.00, 'receipt_date', '2026-09-28', 'detail', '{"qbo_doc_number": "80669163000926"}'::jsonb))) \g /dev/null
reset role;


-- 7a. the filing door's refusals and skips, as the worker; nothing is filed
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  b    constant uuid := '00000000-0000-0000-0000-00000000f2b0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a');
  item jsonb := (select v::jsonb from rq_state where k = 'item_hd');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file('00000000-0000-0000-0000-00000000f2ff', v_in || '{"job_id": "00000000-0000-0000-0000-00000000f2ff"}', 'x', '[]');
  if r is distinct from '{"skipped": "job_missing"}' then raise exception 'a missing job answered %', r; end if;
  r := public.receipts_qbo_link_file(b, v_in || jsonb_build_object('job_id', b), 'x', '[]');
  if r is distinct from '{"skipped": "job_deleted"}' then raise exception 'a deleted job answered %', r; end if;
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item || '{"receipt_id": "r-elsewhere"}')), 'x', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then raise exception 'a receipt not on the job answered %', r; end if;
  -- edited since the worker read it: the amount, the date, a photo added
  -- (the worker read none) or replaced
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item || '{"amount": 1396.50}')), 'x', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then raise exception 'a receipt whose amount changed answered %', r; end if;
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item || '{"date": "2026-09-03"}')), 'x', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then raise exception 'a receipt whose date changed answered %', r; end if;
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item || '{"read_photo_ref": null}')), 'x', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then raise exception 'a receipt whose photo arrived since answered %', r; end if;
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(
         item || jsonb_build_object('read_photo_ref', 'media:' || repeat('9', 64) || ':1234'))), 'x', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then raise exception 'a receipt whose photo was replaced answered %', r; end if;
  r := public.receipts_qbo_link_file(a, v_in || '{"items": []}', null, null);
  if r is distinct from '{"skipped": "empty", "superseded": 0}' then raise exception 'nothing to do answered %', r; end if;
  r := public.receipts_qbo_link_file(a, null, null, null);
  if r is distinct from '{"skipped": "empty", "superseded": 0}' then raise exception 'a null input answered %', r; end if;

  begin
    perform public.receipts_qbo_link_file(a, v_in || '{"job_id": "00000000-0000-0000-0000-00000000f2c0"}', 'x', '[]');
    raise exception 'the door filed items for another job';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in - 'items', 'x', '[]');
    raise exception 'the door filed an input with no items';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', (select jsonb_agg(item) from generate_series(1, 51))), 'x', '[]');
    raise exception 'the door filed 51 items';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item, item)), 'x', '[]');
    raise exception 'the door filed one receipt twice';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(
      item || jsonb_build_object('receipt_id', repeat('r', 65)))), 'x', '[]');
    raise exception 'the door filed a receipt id longer than qbo-proxy''s 64 characters';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item || '{"changes": ["retag"]}')), 'x', '[]');
    raise exception 'the door filed a change it does not know';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(item - 'read_photo_ref')), 'x', '[]');
    raise exception 'the door filed an item that does not say which photo the worker read';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in, 'x', '{"kind": "photo"}');
    raise exception 'the door filed evidence that is not a list';
  exception when invalid_parameter_value then null;
  end;
  -- op_propose's own input check, behind the door
  begin
    perform public.receipts_qbo_link_file(a, v_in || '{"matcher": "something.else@1"}', 'x', '[]');
    raise exception 'the door filed a matcher the schema refuses';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || '{"surprise": 1}', 'x', '[]');
    raise exception 'the door filed a field the schema does not know';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.receipts_qbo_link_file(a, v_in || '{"qbo_customer_id": "Pollen"}', 'x', '[]');
    raise exception 'the door filed a project id that is not a QuickBooks id';
  exception when invalid_parameter_value then null;
  end;

  if exists (select 1 from public.proposals where operation like 'receipts.qbo_link@%') then
    raise exception 'a refused filing left a proposal behind';
  end if;
end
$$;
-- no worker serving qbo: nothing is filed
delete from public.worker_heartbeats;
do $$
begin
  if public.receipts_qbo_link_file('00000000-0000-0000-0000-00000000f2a0', (select v::jsonb from rq_state where k = 'input_a'), 'x', '[]')
     is distinct from '{"skipped": "qbo_lane_off"}' then
    raise exception 'the door filed with no worker serving the qbo lane';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 7b. file a's card: one proposal, as agent:integrations, waiting on the
--     owner; the same filing again is the same card
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a');
  r    jsonb;
  r2   jsonb;
  p    public.proposals;
begin
  r := public.receipts_qbo_link_file(a, v_in,
         '1 receipt on 2156 Alston rd. matches a QuickBooks expense that has no job tag or photo.', '[]');
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
     is distinct from array['filed', 'proposal_id', 'status', 'superseded']
     or r -> 'filed' is distinct from 'true' or r ->> 'status' is distinct from 'proposed' or r -> 'superseded' is distinct from '0' then
    raise exception 'a first filing answered %', r;
  end if;

  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if p.operation is distinct from 'receipts.qbo_link@1' or p.action_type is distinct from 'money' or p.status is distinct from 'proposed'
     or p.assigned_role is distinct from 'owner' or p.proposed_via is distinct from 'agent' or p.proposed_by_kind is distinct from 'agent'
     or p.proposed_by_id is distinct from '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10' or p.job_id is distinct from a then
    raise exception 'the filed proposal is % % % by %/% via %, job %',
      p.operation, p.status, p.assigned_role, p.proposed_by_kind, p.proposed_by_id, p.proposed_via, p.job_id;
  end if;
  if p.expires_at is distinct from now() + interval '14 days' then
    raise exception 'the card expires at %, not in 14 days', p.expires_at;
  end if;
  if (p.input - 'receipts_fingerprint' - 'items_hash' - 'offer') is distinct from v_in
     or p.input ->> 'receipts_fingerprint' is distinct from (select v from rq_state where k = 'fp_a')
     or coalesce(p.input ->> 'items_hash', '') !~ '^[0-9a-f]{32}$' or p.input -> 'offer' is distinct from '0' then
    raise exception 'the door filed % for %', p.input, v_in;
  end if;
  if p.idempotency_key is distinct from 'receipts.qbo_link:' || a || ':' || (p.input ->> 'receipts_fingerprint') || ':'
                          || (p.input ->> 'items_hash') || ':0' then
    raise exception 'the key is %', p.idempotency_key;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.created' and proposal_id = p.id and principal_kind = 'agent'
                    and principal_id = '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10' and data ->> 'proposed_via' = 'agent') then
    raise exception 'no proposal.created event by agent:integrations';
  end if;

  r2 := public.receipts_qbo_link_file(a, v_in, 'again', '[]');
  if r2 is distinct from jsonb_build_object('filed', false, 'proposal_id', p.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'the same filing twice answered %', r2;
  end if;
  -- the stamps are the door's: ones the worker sends are overwritten
  r2 := public.receipts_qbo_link_file(a, v_in || '{"offer": 7, "items_hash": "00000000000000000000000000000000"}', 'again', '[]');
  if r2 is distinct from jsonb_build_object('filed', false, 'proposal_id', p.id, 'status', 'proposed', 'superseded', 0) then
    raise exception 'a filing that sent its own stamps answered %', r2;
  end if;

  insert into rq_state values ('pa', p.id::text);
end
$$;
release savepoint s;
reset role;

-- 7c. a different set of items supersedes the open card; nothing to do
--     supersedes the newer one; the first set then comes back as offer 1
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  pa   uuid := (select v::uuid from rq_state where k = 'pa');
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a');
  r    jsonb;
  pb   uuid;
  p    public.proposals;
begin
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(
         (v_in -> 'items' -> 0) || '{"changes": ["attach"]}')), 'attach only', '[]');
  if r -> 'filed' is distinct from 'true' or r -> 'superseded' is distinct from '1' then raise exception 'a new set over an open card answered %', r; end if;
  pb := (r ->> 'proposal_id')::uuid;
  select * into p from public.proposals where id = pa;
  if p.status is distinct from 'superseded' or p.result is distinct from jsonb_build_object('superseded_by', pb) then
    raise exception 'the older card is % with result %', p.status, p.result;
  end if;
  if (select supersedes_id from public.proposals where id = pb) is distinct from pa then
    raise exception 'the new card does not name the card it superseded';
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.superseded' and proposal_id = pa and idempotency_key = 'proposal.superseded:' || pa
                    and principal_kind = 'agent' and principal_id = '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10') then
    raise exception 'no proposal.superseded event for the older card';
  end if;

  r := public.receipts_qbo_link_file(a, v_in || '{"items": []}', null, null);
  if r is distinct from '{"skipped": "empty", "superseded": 1}'
     or (select result from public.proposals where id = pb) is distinct from '{"superseded_reason": "nothing_to_do"}' then
    raise exception 'nothing to do over an open card answered %', r;
  end if;

  r := public.receipts_qbo_link_file(a, v_in, 'again', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' is distinct from 'true' or p.input -> 'offer' is distinct from '1' or p.id is not distinct from pa then
    raise exception 'a superseded card was not offered again as offer 1: % / %', r, p.input -> 'offer';
  end if;
  insert into rq_state values ('pa', p.id::text) on conflict (k) do update set v = excluded.v;
end
$$;
release savepoint s;
reset role;

-- 7d. a card past its expiry that no sweep has marked yet is expired, not
--     open: the same items come back as the next offer
update public.proposals set expires_at = now() - interval '1 second' where id = (select v::uuid from rq_state where k = 'pa');
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  pa   uuid := (select v::uuid from rq_state where k = 'pa');
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a');
  r    jsonb;
  p    public.proposals;
begin
  r := public.receipts_qbo_link_file(a, v_in, 'again', '[]');
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if r -> 'filed' is distinct from 'true' or r -> 'superseded' is distinct from '0'
     or p.input -> 'offer' is distinct from '2'
     or (select status from public.proposals where id = pa) is distinct from 'expired' then
    raise exception 'a card past its expiry was not offered again as offer 2: % (offer %)', r, p.input -> 'offer';
  end if;
  update rq_state set v = p.id::text where k = 'pa';
end
$$;
release savepoint s;
reset role;


-- 8a. office holds no money approval (ruling 2026-09-06)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f222", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.op_proposal_approve((select v::uuid from rq_state where k = 'pa'), 'inbox');
    raise exception 'office approved a receipts.qbo_link card';
  exception when insufficient_privilege then
    if sqlerrm !~ 'may not approve' then raise; end if;
  end;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

-- 8b. the owner approves a's card from the inbox: the job is linked as the
--     card suggested, r-hd is queued, and one outbox row carries the change
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  pa uuid := (select v::uuid from rq_state where k = 'pa');
  p  public.proposals;
begin
  p := public.op_proposal_approve(pa, 'inbox');
  if p.status is distinct from 'executed' then
    raise exception 'the approval left the card % (error %)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;

do $$
declare
  a     constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  owner constant uuid := '00000000-0000-0000-0000-00000000f221';
  pa    uuid := (select v::uuid from rq_state where k = 'pa');
  p     public.proposals;
  j     public.job_qbo_links;
  l     public.receipt_qbo_links;
  o     public.outbox;
  n     bigint;
begin
  select * into p from public.proposals where id = pa;
  select * into o from public.outbox where proposal_id = pa;
  if p.result is distinct from jsonb_build_object('queued', 1, 'skipped', 0, 'outbox_ids', jsonb_build_array(o.id)) then
    raise exception 'the executor answered %', p.result;
  end if;

  select * into j from public.job_qbo_links where job_id = a;
  if j.qbo_customer_id is distinct from '112' or j.qbo_project_ref is distinct from '412739523'
     or j.qbo_name is distinct from 'Pollen Apartments' or j.source is distinct from 'suggested_tagged'
     or j.set_by_kind is distinct from 'human' or j.set_by_id is distinct from owner then
    raise exception 'the approval linked a as %', to_jsonb(j);
  end if;
  if not exists (select 1 from public.events
                  where kind = 'job.qbo_linked' and proposal_id = pa and job_id = a and principal_id = owner
                    and idempotency_key = 'job.qbo_linked:' || pa and data ->> 'source' = 'suggested_tagged') then
    raise exception 'no job.qbo_linked event for the approval''s link';
  end if;

  select * into l from public.receipt_qbo_links where receipt_id = 'r-hd';
  if l.state is distinct from 'queued' or l.job_id is distinct from a or l.qbo_txn_type is distinct from 'Purchase' or l.qbo_txn_id is distinct from '10577'
     or l.qbo_sync_token is distinct from '0' or l.qbo_customer_id is distinct from '112' or l.amount is distinct from 1369.50 or l.receipt_date is distinct from '2026-09-30'
     or l.changes is distinct from '{tag,attach}' or l.proposal_id is distinct from pa or l.outbox_id is distinct from o.id
     or l.detail ->> 'vendor' is distinct from 'Home Depot' or (l.detail -> 'qbo_total')::numeric is distinct from 1369.50 then
    raise exception 'r-hd''s link row is %', to_jsonb(l);
  end if;

  if (select count(*) from public.outbox where proposal_id = pa) is distinct from 1 or o.channel is distinct from 'qbo' or o.status is distinct from 'pending'
     or o.operation is distinct from 'receipts.qbo_link@1' or o.job_id is distinct from a or o.principal_kind is distinct from 'human' or o.principal_id is distinct from owner
     or o.idempotency_key is distinct from 'outbox:' || p.idempotency_key || ':r-hd' then
    raise exception 'the outbox row is %', to_jsonb(o) - 'payload';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(o.payload) k)
     is distinct from array['changes', 'customer_id', 'expect_sync_token', 'expect_total', 'file_base', 'job_id', 'photo_refs',
              'project_ref', 'proposal_id', 'qbo_txn_id', 'qbo_txn_type', 'receipt_id'] then
    raise exception 'the outbox payload carries %', (select array_agg(k order by k collate "C") from jsonb_object_keys(o.payload) k);
  end if;
  if o.payload is distinct from jsonb_build_object(
       'receipt_id', 'r-hd', 'job_id', a, 'proposal_id', pa, 'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10577',
       'expect_sync_token', '0', 'expect_total', 1369.50, 'changes', '["tag", "attach"]'::jsonb, 'customer_id', '112',
       'project_ref', '412739523', 'photo_refs', jsonb_build_array('media:' || repeat('a', 64) || ':1234'),
       'file_base', 'Home Depot 2026-09-30 1303-00001-50615') then
    raise exception 'the outbox payload is %', o.payload;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'receipts.qbo_link_queued' and proposal_id = pa and job_id = a
                    and idempotency_key = 'receipts.qbo_link_queued:' || pa and principal_id = owner
                    and data = '{"count": 1, "total_usd": 1369.50}') then
    raise exception 'no receipts.qbo_link_queued event with the count and total';
  end if;

  -- approving again, and running it again, write nothing
  n := (select count(*) from public.events);
  insert into rq_state values ('events', n::text);
end
$$;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  pa uuid := (select v::uuid from rq_state where k = 'pa');
begin
  perform public.op_proposal_approve(pa, 'inbox');
end
$$;
release savepoint s;
reset role;
do $$
declare
  pa uuid := (select v::uuid from rq_state where k = 'pa');
begin
  perform public.op_execute(pa, 'human', '00000000-0000-0000-0000-00000000f221');
  if (select count(*) from public.events) is distinct from (select v::bigint from rq_state where k = 'events')
     or (select count(*) from public.outbox where proposal_id = pa) is distinct from 1 then
    raise exception 'a second approval or op_execute wrote something';
  end if;
end
$$;

-- the executor stands on its own checks, not the door's: a card whose input
-- names another job than the proposal (one filed past the door) is refused
do $$
declare
  p public.proposals := (select p from public.proposals p where id = (select v::uuid from rq_state where k = 'pa'));
begin
  p.job_id := '00000000-0000-0000-0000-00000000f2c0';
  begin
    perform public.op_exec_receipts_qbo_link(p, p.input, 'human', '00000000-0000-0000-0000-00000000f221');
    raise exception 'the executor queued a card whose input names another job';
  exception when raise_exception then
    if sqlerrm !~ 'is not the proposal''s job' then raise; end if;
  end;
end
$$;


-- 11a. the trigger: the worker reports a's row sent (tagged, photo attached)
do $$
declare
  o uuid := (select outbox_id from public.receipt_qbo_links where receipt_id = 'r-hd');
begin
  update public.outbox set status = 'sending', locked_by = 'rq-test-worker', lease_until = now() + interval '2 minutes',
                           attempts = attempts + 1
   where id = o;
end
$$;
savepoint s;
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'r-hd'), 'rq-test-worker',
                          'Purchase:10577:1', 'tagged=done;attached=1', 0) \g /dev/null
release savepoint s;
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'r-hd';
  if l.state is distinct from 'done' or l.qbo_txn_id is distinct from '10577' or l.qbo_sync_token is distinct from '1'
     or l.detail ->> 'provider_id' is distinct from 'Purchase:10577:1' or l.detail ->> 'provider_status' is distinct from 'tagged=done;attached=1'
     or l.detail ->> 'delivered_at' is null or l.detail ? 'error' then
    raise exception 'a sent row left r-hd as %', to_jsonb(l);
  end if;
end
$$;


-- 8c. a later card naming r-hd, now done for Purchase 10577: for the same
--     expense it is skipped (nothing queued, no event); for another expense
--     the run fails. Both undone afterwards.
savepoint x;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a') - 'link';
  r    jsonb;
begin
  -- the job is linked now, so the card suggests nothing; attach only
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(
         (v_in -> 'items' -> 0) || '{"changes": ["attach"]}')), 'again', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'a later card for r-hd answered %', r; end if;
  insert into rq_state values ('pa_same', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq_state where k = 'pa_same'), 'inbox');
begin
  if p.status is distinct from 'executed' or p.result is distinct from '{"queued": 0, "skipped": 1, "outbox_ids": []}' then
    raise exception 'a card naming a receipt done for the same expense left % with %', p.status, coalesce(p.error, p.result::text);
  end if;
  if exists (select 1 from public.outbox where proposal_id = p.id)
     or exists (select 1 from public.events where proposal_id = p.id and kind = 'receipts.qbo_link_queued')
     or (select proposal_id from public.receipt_qbo_links where receipt_id = 'r-hd') = p.id then
    raise exception 'a skipped receipt was queued again';
  end if;
end
$$;
reset role;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000f2a0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_a') - 'link';
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(a, v_in || jsonb_build_object('items', jsonb_build_array(
         (v_in -> 'items' -> 0) || '{"qbo_txn_id": "10578"}')), 'other expense', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'a card for r-hd on another expense answered %', r; end if;
  insert into rq_state values ('pa_other', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq_state where k = 'pa_other'), 'inbox');
begin
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'receipt r-hd is already done with QuickBooks Purchase 10577' then
    raise exception 'a card moving a done receipt to another expense left % (error %)', p.status, p.error;
  end if;
  if exists (select 1 from public.outbox where proposal_id = p.id)
     or (select state || ':' || qbo_txn_id from public.receipt_qbo_links where receipt_id = 'r-hd') is distinct from 'done:10577' then
    raise exception 'a refused move wrote something';
  end if;
end
$$;
rollback to savepoint x;
release savepoint x;
reset role;


-- 9a. a moved fingerprint: d's card fails with nothing written
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  d    constant uuid := '00000000-0000-0000-0000-00000000f2d0';
  v_in jsonb;
  r    jsonb;
begin
  v_in := jsonb_build_object(
         'job_id', d, 'job_name', 'Fingerprint job', 'qbo_customer_id', '444', 'qbo_name', 'Bemis',
         'link', jsonb_build_object('qbo_customer_id', '444', 'qbo_name', 'Bemis', 'qbo_project_ref', null,
                                    'source', 'suggested_qbtime', 'why', 'QB Time job name'),
         'items', jsonb_build_array(jsonb_build_object(
           'receipt_id', 'r-d1', 'vendor', 'Home Depot', 'date', '2026-10-01', 'amount', 27.90,
           'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10584', 'qbo_sync_token', '0', 'qbo_total', 27.90,
           'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('f', 64) || ':99'),
           'project_ref', null, 'read_photo_ref', 'media:' || repeat('f', 64) || ':99')),
         'total_usd', 27.90, 'matcher', 'receipts.qbo_match@1');
  r := public.receipts_qbo_link_file(d, v_in, 'd', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'd''s filing answered %', r; end if;
  insert into rq_state values ('pd', r ->> 'proposal_id');
  insert into rq_state values ('input_d', v_in::text);
end
$$;
release savepoint s;
reset role;

update public.field_projects set data = jsonb_set(data, '{receipts,0,amount}', '"29.70"')
 where id = '00000000-0000-0000-0000-00000000f2d0';

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from rq_state where k = 'pd'), 'inbox');
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'receipts changed since this card was filed' then
    raise exception 'a moved fingerprint left the card % (error %)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;
do $$
declare
  pd uuid := (select v::uuid from rq_state where k = 'pd');
begin
  if exists (select 1 from public.outbox where proposal_id = pd)
     or exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-d1')
     or exists (select 1 from public.job_qbo_links where job_id = '00000000-0000-0000-0000-00000000f2d0')
     or exists (select 1 from public.events where proposal_id = pd and kind in ('receipts.qbo_link_queued', 'job.qbo_linked')) then
    raise exception 'a failed run wrote something';
  end if;
end
$$;

-- the same items again while the amount stays changed are not filed (the
-- worker read 27.90); the amount put back, they come back as offer 1, since
-- the card failed on a filing-time check and the owner's approval never ran
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  d    constant uuid := '00000000-0000-0000-0000-00000000f2d0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_d');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(d, v_in, 'd', '[]');
  if r is distinct from '{"skipped": "receipts_moved"}' then
    raise exception 'items the receipts no longer agree with answered %', r;
  end if;
end
$$;
reset role;
update public.field_projects set data = jsonb_set(data, '{receipts,0,amount}', '"27.90"')
 where id = '00000000-0000-0000-0000-00000000f2d0';
set local role service_role;
do $$
declare
  d    constant uuid := '00000000-0000-0000-0000-00000000f2d0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_d');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(d, v_in, 'd', '[]');
  if r -> 'filed' is distinct from 'true' or r ->> 'proposal_id' is not distinct from (select v from rq_state where k = 'pd')
     or (select input -> 'offer' from public.proposals where id = (r ->> 'proposal_id')::uuid) is distinct from '1' then
    raise exception 'the card that failed on the changed amount did not come back once it was put back: %', r;
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 12. the picker, as each role, on c (which 9b then uses)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f223", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2c0', '444', 'Bemis');
    raise exception 'crew linked a job to QuickBooks';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.receipt_qbo_links) or exists (select 1 from public.job_qbo_links) then
    raise exception 'crew reads QuickBooks links';
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f222", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  c      constant uuid := '00000000-0000-0000-0000-00000000f2c0';
  office constant uuid := '00000000-0000-0000-0000-00000000f222';
  r      jsonb;
  r2     jsonb;
  n      bigint;
begin
  begin
    perform public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2b0', '444', 'Bemis');
    raise exception 'the picker linked a deleted job';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2ff', '444', 'Bemis');
    raise exception 'the picker linked a job that does not exist';
  exception when no_data_found then null;
  end;
  begin
    perform public.job_qbo_link_set(c, 'Bemis', 'Bemis');
    raise exception 'the picker linked a name, not a QuickBooks id';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.job_qbo_link_set(c, '444', 'Bemis', 'p-1');
    raise exception 'the picker took a project ref that is not a QuickBooks id';
  exception when invalid_parameter_value then null;
  end;

  r := public.job_qbo_link_set(c, ' 444 ', '1192 Bemis Ct.', '');
  if r ->> 'job_id' is distinct from c::text or r ->> 'qbo_customer_id' is distinct from '444' or r -> 'qbo_project_ref' is distinct from 'null'
     or r ->> 'qbo_name' is distinct from '1192 Bemis Ct.' or r ->> 'source' is distinct from 'picked' or r ->> 'set_by_kind' is distinct from 'human'
     or r ->> 'set_by_id' is distinct from office::text then
    raise exception 'the pick answered %', r;
  end if;
  if (select count(*) from public.job_qbo_links where job_id = c) is distinct from 1 then
    raise exception 'office cannot read the link it set';
  end if;
  n := (select count(*) from public.events where kind = 'job.qbo_linked' and job_id = c);
  r2 := public.job_qbo_link_set(c, '444', '1192 Bemis Ct.');
  if r2 is distinct from r or (select count(*) from public.events where kind = 'job.qbo_linked' and job_id = c) is distinct from n then
    raise exception 'saving the same pick again answered % or wrote an event', r2;
  end if;
  if n is distinct from 1 or not exists (select 1 from public.events
                            where kind = 'job.qbo_linked' and job_id = c and principal_kind = 'human'
                              and principal_id = office and data ->> 'qbo_customer_id' = '444'
                              and data ->> 'source' = 'picked') then
    raise exception 'no job.qbo_linked event for the pick';
  end if;

  -- unlink, then link again: the card filed next is filed against this link
  -- (each call its own statement: a query does not see what a function it
  -- calls wrote)
  r := public.job_qbo_link_set(c, null, null);
  if r is not null or exists (select 1 from public.job_qbo_links where job_id = c) then
    raise exception 'unlinking answered % or left a row', r;
  end if;
  if not exists (select 1 from public.events where kind = 'job.qbo_unlinked' and job_id = c
                                               and data ->> 'qbo_customer_id' = '444') then
    raise exception 'no job.qbo_unlinked event';
  end if;
  r := public.job_qbo_link_set(c, '', null);
  if r is not null then
    raise exception 'unlinking an unlinked job answered %', r;
  end if;
  perform public.job_qbo_link_set(c, '444', '1192 Bemis Ct.');
end
$$;
release savepoint s;
reset role;


-- 9b. c's card names project 444; the office relinks c to 445 before the
--     owner gets to it: the tag is refused and nothing is written. Filed
--     again against the new link, the same items are a new card; with c
--     linked back to 444, the failed card's items are offered again.
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  c    constant uuid := '00000000-0000-0000-0000-00000000f2c0';
  v_in jsonb := jsonb_build_object(
         'job_id', c, 'job_name', '1192 Bemis Ct.', 'qbo_customer_id', '444', 'qbo_name', '1192 Bemis Ct.',
         'items', jsonb_build_array(jsonb_build_object(
           'receipt_id', 'r-c1', 'vendor', 'Home Depot', 'date', '2026-10-02', 'amount', 45.06,
           'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10614', 'qbo_sync_token', '0', 'qbo_total', 45.06,
           'changes', '["tag"]'::jsonb, 'photo_refs', '[]'::jsonb, 'read_photo_ref', 'media:' || repeat('e', 64) || ':99')),
         'total_usd', 45.06, 'matcher', 'receipts.qbo_match@1');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(c, v_in, 'c', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'c''s filing answered %', r; end if;
  insert into rq_state values ('pc', r ->> 'proposal_id');
  insert into rq_state values ('input_c', v_in::text);
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  perform public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2c0', '445', 'Bemis (new project)');
  p := public.op_proposal_approve((select v::uuid from rq_state where k = 'pc'), 'inbox');
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'job linked to a different QuickBooks project since filing' then
    raise exception 'a relinked job left the card % (error %)', p.status, p.error;
  end if;
  if exists (select 1 from public.outbox where proposal_id = p.id)
     or (select state from public.receipt_qbo_links where receipt_id = 'r-c1') is distinct from 'conflict' then
    raise exception 'a refused tag wrote something';
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
  c    constant uuid := '00000000-0000-0000-0000-00000000f2c0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_c');
  r    jsonb;
begin
  -- the same items against the new link are a new card
  r := public.receipts_qbo_link_file(c, v_in || '{"qbo_customer_id": "445", "qbo_name": "Bemis (new project)"}', 'c', '[]');
  if r -> 'filed' is distinct from 'true' then
    raise exception 'relinking the job did not file a fresh card: %', r;
  end if;
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f222", "role": "authenticated", "aud": "authenticated"}';
select public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2c0', '444', '1192 Bemis Ct.') \g /dev/null
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  c    constant uuid := '00000000-0000-0000-0000-00000000f2c0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_c');
  r    jsonb;
begin
  -- c is on 444 again, as the failed card was filed: its items are offered
  -- again (offer 1), not kept quiet by a refusal that no longer holds
  r := public.receipts_qbo_link_file(c, v_in, 'c', '[]');
  if r -> 'filed' is distinct from 'true' or r ->> 'proposal_id' is not distinct from (select v from rq_state where k = 'pc')
     or (select input -> 'offer' from public.proposals where id = (r ->> 'proposal_id')::uuid) is distinct from '1' then
    raise exception 'the card that failed on the relink did not come back once c was linked back: %', r;
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 9c. an expense another receipt holds, and a malformed item, each fail the
--     run with nothing written
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  e    constant uuid := '00000000-0000-0000-0000-00000000f2e0';
  base jsonb := jsonb_build_object(
         'job_id', e, 'job_name', 'Edits job', 'qbo_customer_id', '', 'qbo_name', '',
         'total_usd', 50, 'matcher', 'receipts.qbo_match@1');
  item jsonb := jsonb_build_object(
         'receipt_id', 'r-e1', 'vendor', 'Lowe''s', 'date', '2026-10-01', 'amount', 50,
         'qbo_txn_type', 'Purchase', 'qbo_txn_id', '10563', 'qbo_sync_token', '0', 'qbo_total', 50,
         'changes', '["attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('1', 64) || ':99'),
         'read_photo_ref', 'media:' || repeat('1', 64) || ':99');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(e, base || jsonb_build_object('items', jsonb_build_array(item)), 'held', '[]');
  insert into rq_state values ('pe_held', r ->> 'proposal_id');
  -- three faults: a sync token that is not digits, an attach with no photo
  -- (qbo-proxy would refuse that one for good, so the executor refuses it
  -- first), and a QuickBooks vendor name too long for the card line
  r := public.receipts_qbo_link_file(e, base || jsonb_build_object('items', jsonb_build_array(
         item || '{"qbo_txn_id": "20001", "qbo_sync_token": "x"}',
         item || jsonb_build_object('receipt_id', 'r-e2', 'date', '2026-10-02', 'amount', -12, 'qbo_txn_id', '20002',
                                    'photo_refs', '[]'::jsonb, 'read_photo_ref', 'media:' || repeat('2', 64) || ':99',
                                    'qbo_vendor_name', repeat('v', 201)))),
       'malformed', '[]');
  insert into rq_state values ('pe_bad', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
-- the held card was superseded by the malformed one's filing; open it again
-- so each is approved on its own
update public.proposals set status = 'proposed', result = null
 where id = (select v::uuid from rq_state where k = 'pe_held');
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from rq_state where k = 'pe_held'), 'inbox');
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'Purchase 10563 is already matched to receipt r-sbs' then
    raise exception 'a held expense left the card % (error %)', p.status, p.error;
  end if;
  p := public.op_proposal_approve((select v::uuid from rq_state where k = 'pe_bad'), 'inbox');
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'qbo_sync_token must be digits'
     or coalesce(p.error, '') !~ 'item 2 attaches the photo but names none'
     or coalesce(p.error, '') !~ 'item 2 qbo_vendor_name must be text of at most 200 characters' then
    raise exception 'a malformed item left the card % (error %)', p.status, p.error;
  end if;
  if exists (select 1 from public.outbox where proposal_id in (select v::uuid from rq_state where k in ('pe_held', 'pe_bad')))
     or exists (select 1 from public.receipt_qbo_links where receipt_id in ('r-e1', 'r-e2')) then
    raise exception 'a refused run wrote something';
  end if;
end
$$;
-- a card that failed on its items, not on a filing-time check, stays quiet:
-- the same items would fail the same way
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  e  constant uuid := '00000000-0000-0000-0000-00000000f2e0';
  pe uuid := (select v::uuid from rq_state where k = 'pe_held');
  r  jsonb;
begin
  r := public.receipts_qbo_link_file(e, (select input - 'receipts_fingerprint' - 'items_hash' - 'offer' from public.proposals where id = pe),
                                     'held', '[]');
  if r is distinct from jsonb_build_object('filed', false, 'proposal_id', pe, 'status', 'failed', 'superseded', 0) then
    raise exception 'the card that failed on a held expense filed again: %', r;
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 10. edits may only drop items. e's card: r-e1 (attach) and r-e2 (a return,
--     tag and attach) on project 112
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
begin
  -- the worker links nothing by hand: the picker is the office's
  perform public.job_qbo_link_set('00000000-0000-0000-0000-00000000f2e0', '112', 'Pollen Apartments');
  raise exception 'the service role used the picker';
exception when insufficient_privilege then
  null;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;
insert into public.job_qbo_links (job_id, qbo_customer_id, qbo_name, source, set_by_kind)
values ('00000000-0000-0000-0000-00000000f2e0', '112', 'Pollen Apartments', 'picked', 'system');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  e    constant uuid := '00000000-0000-0000-0000-00000000f2e0';
  v_in jsonb := jsonb_build_object(
         'job_id', e, 'job_name', 'Edits job', 'qbo_customer_id', '112', 'qbo_name', 'Pollen Apartments',
         'items', jsonb_build_array(
           jsonb_build_object('receipt_id', 'r-e1', 'vendor', 'Lowe''s', 'date', '2026-10-01', 'amount', 50,
                              'qbo_txn_type', 'Purchase', 'qbo_txn_id', '20001', 'qbo_sync_token', '3', 'qbo_total', 50,
                              'changes', '["attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('1', 64) || ':99'),
                              'read_photo_ref', 'media:' || repeat('1', 64) || ':99'),
           jsonb_build_object('receipt_id', 'r-e2', 'vendor', 'Lowe''s', 'date', '2026-10-02', 'amount', -12,
                              'qbo_txn_type', 'Purchase', 'qbo_txn_id', '20002', 'qbo_sync_token', '0', 'qbo_total', 12,
                              'changes', '["tag", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('2', 64) || ':99'),
                              'project_ref', null, 'read_photo_ref', 'media:' || repeat('2', 64) || ':99')),
         'total_usd', 62, 'matcher', 'receipts.qbo_match@1');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(e, v_in, 'e', '[]');
  -- (9c's malformed card is the one still open)
  if r -> 'filed' is distinct from 'true' or r -> 'superseded' is distinct from '1' then raise exception 'e''s filing answered %', r; end if;
  insert into rq_state values ('pe', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  pe   uuid := (select v::uuid from rq_state where k = 'pe');
  card jsonb := (select input from public.proposals where id = (select v::uuid from rq_state where k = 'pe'));
  p    public.proposals;
  ed   jsonb;
begin
  -- a changed item, a foreign item, an empty selection and a changed field all fail
  foreach ed in array array[
    jsonb_build_object('items', jsonb_build_array((card -> 'items' -> 1) || '{"changes": ["attach"]}')),
    jsonb_build_object('items', jsonb_build_array((card -> 'items' -> 1) || '{"receipt_id": "r-other"}')),
    jsonb_build_object('items', '[]'::jsonb),
    jsonb_build_object('items', jsonb_build_array(card -> 'items' -> 1, card -> 'items' -> 1)),
    jsonb_build_object('items', jsonb_build_array(card -> 'items' -> 1), 'qbo_customer_id', '113')]
  loop
    -- each attempt in its own subtransaction, undone afterwards so the card
    -- is open for the next one
    begin
      p := public.op_proposal_approve(pe, 'inbox', null, ed);
      if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'may only drop items|kept no items' then
        raise exception 'the edit % left the card % (error %)', ed, p.status, p.error;
      end if;
      if exists (select 1 from public.outbox where proposal_id = pe) then
        raise exception 'the refused edit % queued something', ed;
      end if;
      raise sqlstate 'RQ001';
    exception when sqlstate 'RQ001' then
      null;
    end;
  end loop;

  -- dropping r-e1 queues r-e2 alone, exactly as filed
  p := public.op_proposal_approve(pe, 'inbox', null, jsonb_build_object('items', jsonb_build_array(card -> 'items' -> 1)));
  if p.status is distinct from 'executed' or (p.result ->> 'queued')::int is distinct from 1 or (p.result ->> 'skipped')::int is distinct from 0 then
    raise exception 'the drop left the card % with %', p.status, coalesce(p.error, p.result::text);
  end if;
end
$$;
release savepoint s;
reset role;

do $$
declare
  pe uuid := (select v::uuid from rq_state where k = 'pe');
  o  public.outbox;
begin
  if exists (select 1 from public.receipt_qbo_links where receipt_id = 'r-e1') then
    raise exception 'a dropped item was queued';
  end if;
  select * into o from public.outbox where proposal_id = pe;
  if (select count(*) from public.outbox where proposal_id = pe) is distinct from 1 or o.payload ->> 'receipt_id' is distinct from 'r-e2'
     or o.payload -> 'changes' is distinct from '["tag", "attach"]' or o.payload ->> 'customer_id' is distinct from '112'
     or o.payload -> 'project_ref' is distinct from 'null' or o.payload ->> 'file_base' is distinct from 'Lowe''s 2026-10-02' then
    raise exception 'the drop queued %', o.payload;
  end if;
  if not exists (select 1 from public.events where kind = 'receipts.qbo_link_queued' and proposal_id = pe
                                               and data = '{"count": 1, "total_usd": 12.00}') then
    raise exception 'the queued event does not count the return as $12';
  end if;
  if exists (select 1 from public.events where kind = 'job.qbo_linked' and proposal_id = pe) then
    raise exception 'a card with no link suggestion linked the job';
  end if;
end
$$;


-- 11b. the trigger: QuickBooks refuses r-e2 for good, and the note door
--      keeps both approval-path rows
do $$
begin
  update public.outbox set status = 'sending', locked_by = 'rq-test-worker', lease_until = now() + interval '2 minutes',
                           attempts = attempts + 1
   where id = (select outbox_id from public.receipt_qbo_links where receipt_id = 'r-e2');
end
$$;
savepoint s;
set local role service_role;
select public.outbox_failed((select outbox_id from public.receipt_qbo_links where receipt_id = 'r-e2'), 'rq-test-worker',
                            'tagged_other: the expense is tagged to Pollen Apartments', true) \g /dev/null
release savepoint s;
reset role;
savepoint s;
set local role service_role;
do $$
declare
  l public.receipt_qbo_links;
  r jsonb;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'r-e2';
  if l.state is distinct from 'failed' or coalesce(l.detail ->> 'error', '') !~ '^tagged_other' or l.detail ->> 'failed_at' is null
     or l.qbo_sync_token is distinct from '0' then
    raise exception 'a dead row left r-e2 as %', to_jsonb(l);
  end if;
  r := public.receipt_qbo_links_note(array['00000000-0000-0000-0000-00000000f2a0'::uuid, '00000000-0000-0000-0000-00000000f2e0'::uuid],
         jsonb_build_array(
           jsonb_build_object('receipt_id', 'r-hd', 'job_id', '00000000-0000-0000-0000-00000000f2a0', 'state', 'unmatched'),
           jsonb_build_object('receipt_id', 'r-e2', 'job_id', '00000000-0000-0000-0000-00000000f2e0', 'state', 'unmatched')));
  -- r-sbs and r-sw are not in tonight's rows, so they go; r-hd and r-e2 stay
  if r is distinct from '{"written": 0, "kept": 2, "removed": 2}'
     or (select state from public.receipt_qbo_links where receipt_id = 'r-hd') is distinct from 'done'
     or (select state from public.receipt_qbo_links where receipt_id = 'r-e2') is distinct from 'failed' then
    raise exception 'the note door touched a done or failed row (answered %)', r;
  end if;
end
$$;
release savepoint s;
reset role;


-- 11c. store entry (the 'create' change, built but off until app_settings
--      receipts.qbo_store_accounts is set): a malformed create fails the run;
--      an approved one queues an entry with no expense id yet, and the sent
--      row records the new expense, unless another receipt already holds it.
--      Undone afterwards.
savepoint x;
insert into public.field_projects (id, data, deleted)
values ('00000000-0000-0000-0000-00000000f2f0',
        jsonb_build_object('id', '00000000-0000-0000-0000-00000000f2f0', 'rev', 1, 'updatedAt', '2026-10-01T10:00:00.000Z',
                           'title', 'Store job', 'receipts', jsonb_build_array(
          jsonb_build_object('id', 'r-f1', 'vendor', 'Sherwin-Williams', 'date', '2026-09-28', 'amount', '36.00',
                             'paidWith', 'account', 'receiptNo', '8066-9', 'photo', 'media:' || repeat('3', 64) || ':99'),
          jsonb_build_object('id', 'r-f2', 'vendor', 'Spenard Builders Supply', 'date', '2026-09-29', 'amount', '88.10',
                             'paidWith', 'account', 'receiptNo', '700630001', 'photo', 'media:' || repeat('4', 64) || ':99'))),
        false);
insert into public.job_qbo_links (job_id, qbo_customer_id, qbo_project_ref, qbo_name, source, set_by_kind)
values ('00000000-0000-0000-0000-00000000f2f0', '112', '412739523', 'Pollen Apartments', 'picked', 'system');
insert into rq_state values ('item_f1', jsonb_build_object(
  'receipt_id', 'r-f1', 'vendor', 'Sherwin-Williams', 'date', '2026-09-28', 'amount', 36.00, 'receipt_no', '8066-9',
  'qbo_txn_type', 'Purchase', 'qbo_txn_id', '', 'qbo_sync_token', '', 'qbo_total', null,
  'changes', '["create", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('3', 64) || ':99'),
  'project_ref', '412739523', 'read_photo_ref', 'media:' || repeat('3', 64) || ':99',
  'create', jsonb_build_object('account_id', '52', 'vendor_id', '9', 'payment_type', 'CreditCard', 'credit', false,
                               'doc_number', '80669', 'expense_account_id', '42', 'class_id', '1000000001',
                               'txn_date', '2026-09-28', 'amount_abs', 36.00,
                               'memo', 'Sherwin-Williams 8066-9 (from the job receipts app)'))::text);
insert into rq_state values ('item_f2', jsonb_build_object(
  'receipt_id', 'r-f2', 'vendor', 'Spenard Builders Supply', 'date', '2026-09-29', 'amount', 88.10, 'receipt_no', '700630001',
  'qbo_txn_type', 'Purchase', 'qbo_txn_id', '', 'qbo_sync_token', '', 'qbo_total', null,
  'changes', '["create", "attach"]'::jsonb, 'photo_refs', jsonb_build_array('media:' || repeat('4', 64) || ':99'),
  'project_ref', '412739523', 'read_photo_ref', 'media:' || repeat('4', 64) || ':99',
  'create', jsonb_build_object('account_id', '53', 'vendor_id', '65', 'payment_type', 'CreditCard', 'credit', false,
                               'doc_number', '700630001', 'expense_account_id', '42', 'class_id', '1000000001',
                               'txn_date', '2026-09-29', 'amount_abs', 88.10,
                               'memo', 'Spenard Builders Supply 700630001 (from the job receipts app)'))::text);
insert into rq_state values ('input_f', jsonb_build_object(
  'job_id', '00000000-0000-0000-0000-00000000f2f0', 'job_name', 'Store job', 'qbo_customer_id', '112',
  'qbo_name', 'Pollen Apartments', 'total_usd', 124.10, 'matcher', 'receipts.qbo_match@1')::text);

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  f    constant uuid := '00000000-0000-0000-0000-00000000f2f0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_f');
  i1   jsonb := (select v::jsonb from rq_state where k = 'item_f1');
  i2   jsonb := (select v::jsonb from rq_state where k = 'item_f2');
  r    jsonb;
begin
  -- four digits, too short to find the entry by (they start other
  -- invoices' numbers too); a create that also tags
  r := public.receipts_qbo_link_file(f, v_in || jsonb_build_object('items', jsonb_build_array(
         jsonb_set(i1, '{create,doc_number}', '"8066"'), i2 || '{"changes": ["create", "tag", "attach"]}')), 'bad', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the malformed store card answered %', r; end if;
  insert into rq_state values ('pf_bad', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq_state where k = 'pf_bad'), 'inbox');
begin
  if p.status is distinct from 'failed' or coalesce(p.error, '') !~ 'item 1 create needs a doc_number of 5 to 21 digits'
     or coalesce(p.error, '') !~ 'item 2 changes .* never with tag' then
    raise exception 'a malformed create left the card % (error %)', p.status, p.error;
  end if;
  if exists (select 1 from public.outbox where proposal_id = p.id)
     or exists (select 1 from public.receipt_qbo_links where receipt_id in ('r-f1', 'r-f2')) then
    raise exception 'a malformed create wrote something';
  end if;
end
$$;
reset role;

set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  f    constant uuid := '00000000-0000-0000-0000-00000000f2f0';
  v_in jsonb := (select v::jsonb from rq_state where k = 'input_f');
  r    jsonb;
begin
  r := public.receipts_qbo_link_file(f, v_in || jsonb_build_object('items', jsonb_build_array(
         (select v::jsonb from rq_state where k = 'item_f1'), (select v::jsonb from rq_state where k = 'item_f2'))),
         '2 store invoices on Store job are not in QuickBooks yet.', '[]');
  if r -> 'filed' is distinct from 'true' then raise exception 'the store card answered %', r; end if;
  insert into rq_state values ('pf', r ->> 'proposal_id');
end
$$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals := public.op_proposal_approve((select v::uuid from rq_state where k = 'pf'), 'inbox');
begin
  if p.status is distinct from 'executed' or (p.result ->> 'queued')::int is distinct from 2 then
    raise exception 'the store card left % with %', p.status, coalesce(p.error, p.result::text);
  end if;
end
$$;
reset role;
do $$
declare
  pf uuid := (select v::uuid from rq_state where k = 'pf');
  i1 jsonb := (select v::jsonb from rq_state where k = 'item_f1');
  l  public.receipt_qbo_links;
  o  public.outbox;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'r-f1';
  if l.state is distinct from 'queued' or l.qbo_txn_type is distinct from 'Purchase' or l.qbo_txn_id is not null or l.qbo_sync_token is not null
     or l.qbo_customer_id is distinct from '112' or l.changes is distinct from '{create,attach}' or l.proposal_id is distinct from pf
     or l.detail ->> 'qbo_doc_number' is distinct from '80669' then
    raise exception 'r-f1''s link row is %', to_jsonb(l);
  end if;
  select * into o from public.outbox where id = l.outbox_id;
  if o.payload is distinct from jsonb_build_object(
       'receipt_id', 'r-f1', 'job_id', '00000000-0000-0000-0000-00000000f2f0', 'proposal_id', pf,
       'qbo_txn_type', 'Purchase', 'qbo_txn_id', '', 'expect_sync_token', '', 'expect_total', null,
       'changes', '["create", "attach"]'::jsonb, 'customer_id', '112', 'project_ref', '412739523',
       'photo_refs', i1 -> 'photo_refs', 'file_base', 'Sherwin-Williams 2026-09-28 8066-9', 'create', i1 -> 'create') then
    raise exception 'the store entry''s outbox payload is %', o.payload;
  end if;

  update public.outbox set status = 'sending', locked_by = 'rq-test-worker', lease_until = now() + interval '2 minutes',
                           attempts = attempts + 1
   where proposal_id = pf;
end
$$;
-- qbo-proxy entered r-f1 as Purchase 10999; r-f2's run then adopted that same
-- entry (it can only be a mistake: the expense is r-f1's)
savepoint s;
set local role service_role;
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'r-f1'), 'rq-test-worker',
                          'Purchase:10999:0', 'tagged=done;attached=1', 0) \g /dev/null
select public.outbox_sent((select outbox_id from public.receipt_qbo_links where receipt_id = 'r-f2'), 'rq-test-worker',
                          'Purchase:10999:0', 'tagged=adopted;attached=0', 0) \g /dev/null
release savepoint s;
reset role;
do $$
declare
  l public.receipt_qbo_links;
begin
  select * into l from public.receipt_qbo_links where receipt_id = 'r-f1';
  if l.state is distinct from 'done' or l.qbo_txn_id is distinct from '10999' or l.qbo_sync_token is distinct from '0' then
    raise exception 'a sent store entry left r-f1 as %', to_jsonb(l);
  end if;
  select * into l from public.receipt_qbo_links where receipt_id = 'r-f2';
  if l.state is distinct from 'done' or l.qbo_txn_id is not null or l.detail ->> 'txn_held_by' is distinct from 'r-f1'
     or l.detail ->> 'provider_id' is distinct from 'Purchase:10999:0' then
    raise exception 'a store entry another receipt holds left r-f2 as %', to_jsonb(l);
  end if;
end
$$;
rollback to savepoint x;
release savepoint x;
reset role;


-- 12b. who reads the links: owner and office everything, crew nothing
insert into rq_state values ('counts', (select count(*) from public.receipt_qbo_links) || ':' || (select count(*) from public.job_qbo_links));
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f221", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (select count(*) from public.receipt_qbo_links) || ':' || (select count(*) from public.job_qbo_links)
     is distinct from (select v from rq_state where k = 'counts') or (select v from rq_state where k = 'counts') is distinct from '3:3' then
    raise exception 'the owner reads % of the QuickBooks links (receipts:jobs), not %',
      (select count(*) from public.receipt_qbo_links) || ':' || (select count(*) from public.job_qbo_links),
      (select v from rq_state where k = 'counts');
  end if;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000f223", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if exists (select 1 from public.receipt_qbo_links) or exists (select 1 from public.job_qbo_links) then
    raise exception 'crew reads QuickBooks links';
  end if;
  begin
    insert into public.job_qbo_links (job_id, qbo_customer_id, source, set_by_kind)
    values ('00000000-0000-0000-0000-00000000f2d0', '1', 'picked', 'human');
    raise exception 'a signed-in user wrote job_qbo_links directly';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;


-- 13. the ping proves the service role
savepoint s;
set local role service_role;
do $$
begin
  if public.qbo_service_ping() is distinct from true then
    raise exception 'qbo_service_ping did not answer true to the service role';
  end if;
  begin
    insert into public.receipt_qbo_links (receipt_id, job_id, state) values ('r-direct', '00000000-0000-0000-0000-00000000f2a0', 'unmatched');
    raise exception 'the service role wrote receipt_qbo_links past the note door';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;
release savepoint s;
reset role;

rollback;
