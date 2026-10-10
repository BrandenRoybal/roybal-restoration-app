-- ============================================================================
-- Assertions for 0026_carrier_packet.sql (operations spine phase 5: one
-- numbered, versioned carrier packet PDF per water job, filed as one
-- packet.send card, emailed to the adjuster once the owner approves it).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/carrier_packet.test.sql <staging url>
-- Everything it writes is rolled back (sequence values it draws are not; that
-- is what every proposal does anyway). The last transaction disables the
-- field_projects updated_at trigger for a moment, to date test jobs in the
-- past; that is rolled back with it.
--
-- All data is made up: Jane Sample, 123 Example St, Fairbanks, AK 99701,
-- claim DEMO-12345, Sample Mutual, adjuster@example.com. Packet numbers are
-- drawn in 2098 and 2099, which no real job reaches.
--
-- The rules it holds 0026 to:
--   1. packet.send@1 is comms, runtime sql, owner-approved, with the template,
--      emits and schema the worker, the office app and the executor read (the
--      To is the worker's address rule, rfc822.mjs EMAIL); packet.build is a
--      queue kind, never an operation; every proposable operation has an
--      executor.
--   2. The seventeen functions are owned by postgres, SECURITY DEFINER, with a
--      pinned search_path; the number allocator, the card helper, the
--      executor and the trigger function are callable by nobody; every door
--      by service_role alone, never anon or authenticated. (The
--      agent:documents seed and grant are contract_tables.test.sql 12 and
--      spine_lanes.test.sql 2d.)
--   3. The three tables have RLS on, no policy, and nothing but SELECT for
--      the service role; carrier_packets has its unique (job_id, seq), one
--      building, one ready and one sent row per version; the outbox channel
--      check accepts 'packet'; the trigger is AFTER UPDATE OF status FOR EACH
--      ROW on outbox for packet rows.
--   4. Where pg_cron exists, carrier-packet-hourly runs at minute 25 and
--      enqueues one packet.build row per Alaska hour for agent:documents.
--   5. document_next_number hands out KIND-YYYY-NNNN per kind and year, never
--      twice, past 9999 without wrapping, and refuses a bad kind or year.
--   6. Reserve: lane_off with no worker serving 'packet'; building while a
--      build is under 30 minutes old, and an older one fails as abandoned;
--      failed_cap after 3 counted failures or a permanent one (relabel does
--      not count); in_flight while the card is approved or executed; open and
--      declined for the same model; reoffer of a dead card or a failed send,
--      to offer_cap; too_large for a send Gmail refused for its size; sent
--      when the carrier has this model; else build, with the job's one number,
--      seq + 1, version 1 + the highest sent, the planned path and the job's
--      hold deleted (never the lane's).
--   7. File refuses a malformed PDF, a To or Cc, and evidence that is not a
--      list; answers lost to a wrong token or a row that is not building;
--      files the card as agent:documents (proposed_via agent, owner, 14 days,
--      no SMS code, offer 0, never a To); supersedes the open card it replaces
--      (event, superseded_by, supersedes_id), never a declined one, and the
--      rows nobody will send; lists only PDFs no outbox row references; and
--      fails as relabel, keeping the PDF's path, when the card it replaces is
--      in flight or a send moved the version.
--   8. Office cannot approve. The owner's approval needs the To: without it,
--      with any other edit, or with a To or Cc the worker would refuse for
--      good (a bracket, a comma, a semicolon, a name), nothing is queued; a
--      Cc of bare addresses apart by commas goes through. With it,
--      ONE outbox row on 'packet' carries exactly the payload the adapter
--      reads; approving again writes nothing. The executor refuses a deleted,
--      archived or missing job, a card that is no longer the packet's, a newer
--      live row, a removed PDF and a card naming no packet or another job.
--   9. The trigger marks the packet sent (sent_at, sent_to) when its outbox
--      row is sent or delivered, undelivered (the error) when it is dead, and
--      never fails the outbox write that fired it.
--  10. Reoffer files the same PDF at offer + 1 with no SMS code, clears the
--      outbox id and the error, and answers lost (open, not_latest,
--      offer_cap, missing, not_offerable) when the row no longer qualifies.
--  11. Fail is compare-and-set and says when the model is capped; withdraw
--      supersedes an open card and leaves an approved one alone; holds text
--      once per reason; state reads the photo numbers and the last send.
--  12. The cleanup lists superseded and failed PDFs and long-declined ready
--      ones no outbox row references, sent ones sent over 90 days ago and
--      offer-capped ready ones whose card died over 14 days ago while no
--      packet email naming them is going out, never an undelivered one or a
--      sent one 30 days old; the stamp re-checks the same rules, and a sent
--      row stays sent.
--  13. The storage helpers answer 0 and no rows without storage.objects, and
--      read sizes from it when it is there.
--  14. Candidates: live jobs with a certificate inside lookback + 2 days, live
--      jobs changed since their newest packet row, and every job with a ready
--      row, oldest first, with has_row (a packet row or a hold) and open_row.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the catalog row
do $$
declare
  c public.operation_catalog;
  r record;
begin
  select * into c from public.operation_catalog where name = 'packet.send' and version = 1;
  if not found then
    raise exception 'operation_catalog has no packet.send@1';
  end if;
  if c.action_type is distinct from 'comms' or c.runtime is distinct from 'sql' or c.approval_default is distinct from 'owner'
     or c.amount_field is not null or c.emits is distinct from array['packet.queued']
     or c.idempotency_template is distinct from 'packet.send:{packet_version_id}:{offer}'
     or c.deprecated_at is not null then
    raise exception 'packet.send@1 is %/%/%, amount %, emits %, template %, deprecated %',
      c.action_type, c.runtime, c.approval_default, c.amount_field, c.emits, c.idempotency_template, c.deprecated_at;
  end if;
  if c.definition_sha is distinct from md5(c.name || '@1:' || c.input_schema::text) then
    raise exception 'packet.send@1 definition_sha is not md5(name@1:schema)';
  end if;
  -- the inbox titles a card with the description's first sentence
  if c.description not like 'Email the carrier packet to the adjuster. %' then
    raise exception 'packet.send@1 description starts %', left(c.description, 80);
  end if;
  if c.input_schema -> 'required' is distinct from '["packet_version_id", "offer", "subject", "body", "filename"]'::jsonb
     or (c.input_schema ->> 'additionalProperties')::boolean is distinct from false then
    raise exception 'packet.send@1 schema requires % (additionalProperties %)',
      c.input_schema -> 'required', c.input_schema -> 'additionalProperties';
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k)
     is distinct from array['body', 'cc', 'filename', 'offer', 'packet_version_id', 'subject', 'suggested_from', 'suggested_to', 'to'] then
    raise exception 'packet.send@1 schema fields are %',
      (select array_agg(k order by k collate "C") from jsonb_object_keys(c.input_schema -> 'properties') k);
  end if;
  if c.input_schema #>> '{properties,offer,type}' is distinct from 'integer'
     or c.input_schema #>> '{properties,subject,maxLength}' is distinct from '300'
     or c.input_schema #>> '{properties,body,maxLength}' is distinct from '100000'
     or c.input_schema #>> '{properties,filename,maxLength}' is distinct from '200'
     or c.input_schema #>> '{properties,suggested_to,maxLength}' is distinct from '320'
     or c.input_schema #>> '{properties,suggested_from,maxLength}' is distinct from '200'
     or c.input_schema #>> '{properties,to,maxLength}' is distinct from '320'
     or c.input_schema #>> '{properties,cc,maxLength}' is distinct from '1000'
     or c.input_schema #>> '{properties,packet_version_id,pattern}' is null then
    raise exception 'packet.send@1 field limits are wrong: %', c.input_schema -> 'properties';
  end if;
  -- one bare address, as the worker's rfc822.mjs EMAIL takes it: no space,
  -- @, <, >, comma or semicolon in either part
  if c.input_schema #>> '{properties,to,pattern}'
     is distinct from '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+\.[^@[:space:]<>,;]+$' then
    raise exception 'packet.send@1''s To pattern is %, not the worker''s address rule', c.input_schema #>> '{properties,to,pattern}';
  end if;
  if exists (select 1 from public.operation_catalog where name = 'packet.build') then
    raise exception 'packet.build is catalogued; it is a queue kind, and a catalogued name is proposable';
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


-- 2. the seventeen functions and their grants
do $$
declare
  internal constant text[] := array[
    'public.document_next_number(text, integer)',
    'public.carrier_packet_offer_card(public.carrier_packets, jsonb, text, jsonb, integer)',
    'public.op_exec_packet_send(public.proposals, jsonb, text, uuid)',
    'public.outbox_packet_result()'];
  doors constant text[] := array[
    'public.carrier_packet_reserve(uuid, text, jsonb, jsonb, jsonb, integer, boolean)',
    'public.carrier_packet_file(uuid, uuid, jsonb, jsonb, text, jsonb)',
    'public.carrier_packet_reoffer(uuid, jsonb, text, jsonb)',
    'public.carrier_packet_fail(uuid, uuid, text, boolean)',
    'public.carrier_packet_withdraw(uuid, text)',
    'public.carrier_packet_hold(uuid, text, text)',
    'public.carrier_packet_hold_texted(uuid, text)',
    'public.carrier_packet_candidates(integer, integer)',
    'public.carrier_packet_state(uuid)',
    'public.carrier_packet_pdfs_to_remove(integer)',
    'public.carrier_packet_pdfs_removed(uuid[])',
    'public.carrier_packet_storage_bytes()',
    'public.carrier_packet_media_sizes(text[])'];
  readers constant text[] := array[
    'public.carrier_packet_candidates(integer, integer)',
    'public.carrier_packet_state(uuid)',
    'public.carrier_packet_pdfs_to_remove(integer)',
    'public.carrier_packet_storage_bytes()',
    'public.carrier_packet_media_sizes(text[])'];
  f text;
  problems text[] := '{}';
begin
  foreach f in array internal || doors loop
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
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('authenticated can execute %s', f);
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'carrier packet functions are wrong: %', array_to_string(problems, '; ');
  end if;

  foreach f in array internal loop
    if has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role can execute %s', f);
    end if;
  end loop;
  foreach f in array doors loop
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role cannot execute %s', f);
    end if;
  end loop;
  foreach f in array readers loop
    if (select provolatile from pg_proc where oid = f::regprocedure) is distinct from 's' then
      problems := problems || format('%s is not STABLE', f);
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'carrier\_packet\_%' or p.proname in
             ('document_next_number', 'op_exec_packet_send', 'outbox_packet_result'))) <> 17 then
    raise exception 'there are % carrier packet functions, not 17 (an overload left behind?)',
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'carrier\_packet\_%' or p.proname in
              ('document_next_number', 'op_exec_packet_send', 'outbox_packet_result')));
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'carrier packet grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 3. the tables, their indexes, the outbox channel and the trigger
do $$
declare
  t text;
  problems text[] := '{}';
begin
  foreach t in array array['public.carrier_packets', 'public.carrier_packet_holds', 'public.document_sequences'] loop
    if to_regclass(t) is null then
      problems := problems || format('%s is missing', t);
      continue;
    end if;
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      problems := problems || format('RLS is off on %s', t);
    end if;
    if (select pg_get_userbyid(relowner) from pg_class where oid = t::regclass) is distinct from 'postgres' then
      problems := problems || format('%s is not owned by postgres', t);
    end if;
    if exists (select 1 from pg_policies where schemaname || '.' || tablename = t) then
      problems := problems || format('%s has a policy; only the service role reads it', t);
    end if;
    if has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_table_privilege('authenticated', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      problems := problems || format('anon or authenticated holds a privilege on %s', t);
    end if;
    if has_table_privilege('service_role', t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or not has_table_privilege('service_role', t, 'SELECT') then
      problems := problems || format('service_role holds more or less than SELECT on %s (the doors write)', t);
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'carrier packet tables are wrong: %', array_to_string(problems, '; ');
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.carrier_packets'::regclass and contype = 'u'
                    and pg_get_constraintdef(oid) = 'UNIQUE (job_id, seq)') then
    problems := problems || 'carrier_packets has no unique (job_id, seq)'::text;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.document_sequences'::regclass and contype = 'p'
                    and pg_get_constraintdef(oid) = 'PRIMARY KEY (org_id, kind, year)') then
    problems := problems || 'document_sequences'' primary key is not (org_id, kind, year)'::text;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.carrier_packet_holds'::regclass and contype = 'p'
                    and pg_get_constraintdef(oid) = 'PRIMARY KEY (job_id)') then
    problems := problems || 'carrier_packet_holds'' primary key is not (job_id)'::text;
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'carrier_packets_one_building'
                    and indexdef ~* 'UNIQUE INDEX .* \(job_id\) WHERE \(status = ''building''::text\)') then
    problems := problems || 'carrier_packets_one_building is not unique (job_id) where building'::text;
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'carrier_packets_one_ready'
                    and indexdef ~* 'UNIQUE INDEX .* \(job_id\) WHERE \(status = ''ready''::text\)') then
    problems := problems || 'carrier_packets_one_ready is not unique (job_id) where ready'::text;
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'carrier_packets_sent_version_key'
                    and indexdef ~* 'UNIQUE INDEX .* \(job_id, version\) WHERE \(status = ''sent''::text\)') then
    problems := problems || 'carrier_packets_sent_version_key is not unique (job_id, version) where sent'::text;
  end if;

  -- the outbox takes packet rows, and still every channel it took before
  if pg_get_constraintdef((select oid from pg_constraint
                            where conrelid = 'public.outbox'::regclass and conname = 'outbox_channel_check'))
     !~ '''sms''.*''email''.*''qbo''.*''portal''.*''packet''' then
    problems := problems || format('outbox_channel_check is %s',
      pg_get_constraintdef((select oid from pg_constraint
                             where conrelid = 'public.outbox'::regclass and conname = 'outbox_channel_check')));
  end if;

  -- AFTER (0) | ROW (1) | UPDATE (16) = 17, on status only, for packet rows
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.outbox'::regclass and tgname = 'outbox_packet_result'
                    and tgfoid = 'public.outbox_packet_result()'::regprocedure
                    and tgtype = 17 and tgenabled = 'O' and not tgisinternal
                    and tgattr::text = (select attnum::text from pg_attribute
                                         where attrelid = 'public.outbox'::regclass and attname = 'status')
                    and pg_get_triggerdef(oid) ~ 'channel = ''packet'''
                    and pg_get_triggerdef(oid) ~ '''sent''' and pg_get_triggerdef(oid) ~ '''delivered'''
                    and pg_get_triggerdef(oid) ~ '''dead''') then
    problems := problems || 'outbox_packet_result is not an enabled AFTER UPDATE OF status FOR EACH ROW trigger on outbox for packet rows'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'carrier packet constraints are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- 4. the hourly cron row, where pg_cron exists
do $$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed here; carrier-packet-hourly not checked';
    return;
  end if;
  select * into j from cron.job where jobname = 'carrier-packet-hourly';
  if not found or not j.active then
    raise exception 'carrier-packet-hourly is not scheduled and active';
  end if;
  if j.schedule is distinct from '25 * * * *' then
    raise exception 'carrier-packet-hourly runs at %, not 25 * * * *', j.schedule;
  end if;
  if j.command !~ 'public\.enqueue\(' or j.command !~ '''packet\.build''' or j.command !~ '''run_hour'''
     or j.command !~ '''packet\.build:''' or j.command !~ 'America/Anchorage' or j.command !~ 'HH24'
     or j.command !~ '-10' or j.command !~ '''agent''' or j.command !~ 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65' then
    raise exception 'carrier-packet-hourly runs the wrong command: %', j.command;
  end if;
end
$$;


-- 5–13. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000c261', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cp-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000c262', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cp-office@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000c261', 'cp test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000c262', 'cp test office', 'office')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- Demo jobs, all certified: a walks the whole life of a packet; b fails;
-- c is withdrawn, then undelivered and re-offered; d is too large to email;
-- e is the executor's refusals; g is relabelled by a send it raced.
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object('id', j.id, 'rev', 3, 'updatedAt', '2098-10-01T10:00:00.000Z',
                          'title', j.title, 'customerName', 'Jane Sample',
                          'address', '123 Example St, Fairbanks, AK 99701',
                          'claimNumber', 'DEMO-12345', 'carrier', 'Sample Mutual',
                          'certDrying', jsonb_build_object('sigTech', 'data:image/png;base64,AAAA')),
       false
  from (values
    ('00000000-0000-0000-0000-00000000c2a0'::uuid, 'Jane Sample - water (a)'),
    ('00000000-0000-0000-0000-00000000c2b0'::uuid, 'Jane Sample - water (b)'),
    ('00000000-0000-0000-0000-00000000c2c0'::uuid, 'Jane Sample - water (c)'),
    ('00000000-0000-0000-0000-00000000c2d0'::uuid, 'Jane Sample - water (d)'),
    ('00000000-0000-0000-0000-00000000c2e0'::uuid, 'Jane Sample - water (e)'),
    ('00000000-0000-0000-0000-00000000c2f0'::uuid, 'Jane Sample - water (g)')
  ) as j(id, title);

create temp table cp_state (k text primary key, v text);
grant all on cp_state to anon, authenticated, service_role;

-- what the worker files with every card (never a To)
insert into cp_state values ('input', jsonb_build_object(
  'subject', 'Carrier packet - Claim DEMO-12345 - Jane Sample',
  'body', 'Attached is the drying packet for 123 Example St, Fairbanks, AK 99701 (claim DEMO-12345).',
  'filename', 'Claim DEMO-12345 - Sample.pdf',
  'suggested_to', 'adjuster@example.com',
  'suggested_from', 'Sample Mutual claim email')::text);


-- 5. document_next_number, as postgres (nobody else may call it)
do $$
declare
  n text;
begin
  if exists (select 1 from public.document_sequences where year in (2098, 2099)) then
    raise exception 'document_sequences already counts 2098 or 2099; this file numbers its test packets there';
  end if;
  n := public.document_next_number('PKT', 2099);
  if n is distinct from 'PKT-2099-0001' then raise exception 'the first number is %', n; end if;
  n := public.document_next_number('PKT', 2099);
  if n is distinct from 'PKT-2099-0002' then raise exception 'the second number is %', n; end if;
  n := public.document_next_number('INV', 2099);
  if n is distinct from 'INV-2099-0001' then raise exception 'another kind did not start at 1: %', n; end if;
  if (select next_value from public.document_sequences where kind = 'PKT' and year = 2099) is distinct from 3 then
    raise exception 'the counter does not hold the next number';
  end if;
  -- past 9999 it grows a digit rather than wrapping
  update public.document_sequences set next_value = 10000 where kind = 'PKT' and year = 2099;
  n := public.document_next_number('PKT', 2099);
  if n is distinct from 'PKT-2099-10000' then raise exception 'number 10000 is %', n; end if;

  begin
    perform public.document_next_number('pkt', 2099);
    raise exception 'document_next_number took a lowercase kind';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.document_next_number('P', 2099);
    raise exception 'document_next_number took a one-letter kind';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.document_next_number('PKT', 1999);
    raise exception 'document_next_number took year 1999';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.document_next_number('PKT', null);
    raise exception 'document_next_number took no year';
  exception when invalid_parameter_value then null;
  end;
end
$$;


-- 6. no worker serves 'packet' yet: nothing is reserved; bad calls refused
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  r jsonb;
begin
  if public.outbox_channel_ready('packet') then
    raise notice 'a worker serves the packet channel here; lane_off not checked';
  else
    r := public.carrier_packet_reserve(a, repeat('a1', 32), '{}', '{}', '{}', 2098);
    if r is distinct from '{"action": "skip", "reason": "lane_off"}' then
      raise exception 'with no packet worker, reserve answered %', r;
    end if;
    if exists (select 1 from public.carrier_packets where job_id = a) then
      raise exception 'lane_off reserved a row';
    end if;
  end if;

  begin
    perform public.carrier_packet_reserve(a, upper(repeat('a1', 32)), '{}', '{}', '{}', 2098);
    raise exception 'reserve took an uppercase hash';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_reserve(a, 'abc', '{}', '{}', '{}', 2098);
    raise exception 'reserve took a short hash';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_reserve(null, repeat('a1', 32), '{}', '{}', '{}', 2098);
    raise exception 'reserve took no job';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_reserve(a, repeat('a1', 32), '[]', '{}', '{}', 2098);
    raise exception 'reserve took section hashes that are a list';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_reserve(a, repeat('a1', 32), '{}', '{}', '{}', 98);
    raise exception 'reserve took a two-digit year';
  exception when invalid_parameter_value then null;
  end;
end
$$;
release savepoint s;
reset role;

-- a worker serving the packet lane (reserve's switch)
insert into public.worker_heartbeats (worker_id, at, meta)
values ('cp-test-worker', now(), '{"channels": ["sms", "email", "packet"]}');


-- 7. a's first build and its card, as the worker
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  docs constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';
  inp  jsonb := (select v::jsonb from cp_state where k = 'input');
  sec  jsonb := jsonb_build_object('cert', repeat('0c', 32), 'photos', repeat('0d', 32));
  r    jsonb;
  c    public.carrier_packets;
  p    public.proposals;
  pk1   uuid;
  tok  uuid;
  pdf  jsonb;
begin
  -- the lane's storage hold and a's own: a build means Storage had room, so
  -- it deletes both
  perform public.carrier_packet_hold('00000000-0000-0000-0000-000000000000', 'storage_full', 'Packets use over 300 MB');
  perform public.carrier_packet_hold(a, 'no_invoice', 'No invoice yet');

  if public.carrier_packet_state(a) is distinct from '{"photo_nums": null, "last_sent": null}' then
    raise exception 'a job with no packet has state %', public.carrier_packet_state(a);
  end if;

  r := public.carrier_packet_reserve(a, repeat('a1', 32), sec, '{"media:p1": 1, "media:p2": 2}', '{"photos": 2}', 2098);
  pk1 := (r ->> 'packet_id')::uuid;
  tok := (r ->> 'build_token')::uuid;
  if r - 'packet_id' - 'build_token' is distinct from jsonb_build_object(
       'action', 'build', 'number', 'PKT-2098-0001', 'version', 1, 'seq', 1,
       'path', a::text || '/PKT-2098-0001-v1-b1.pdf', 'sha256', null, 'bytes', null, 'pages', null,
       'mode', null, 'replaces', null)
     or pk1 is null or tok is null then
    raise exception 'a''s first reserve answered %', r;
  end if;
  select * into c from public.carrier_packets where id = (r ->> 'packet_id')::uuid;
  if c.job_id is distinct from a or c.status is distinct from 'building' or c.number is distinct from 'PKT-2098-0001'
     or c.version <> 1 or c.seq <> 1 or c.model_hash is distinct from repeat('a1', 32) or c.section_hashes is distinct from sec
     or c.photo_nums is distinct from '{"media:p1": 1, "media:p2": 2}' or c.meta is distinct from '{"photos": 2}'
     or c.build_token is distinct from tok or c.offer <> 0 or c.permanent or c.proposal_id is not null or c.path is not null then
    raise exception 'a''s building row is %', to_jsonb(c);
  end if;
  if exists (select 1 from public.carrier_packet_holds where job_id = a) then
    raise exception 'the build left a''s hold behind';
  end if;
  if exists (select 1 from public.carrier_packet_holds where job_id = '00000000-0000-0000-0000-000000000000') then
    raise exception 'a''s build left the lane''s storage_full hold behind';
  end if;
  if (select next_value from public.document_sequences where kind = 'PKT' and year = 2098) is distinct from 2 then
    raise exception 'the 2098 counter did not move to 2';
  end if;

  r := public.carrier_packet_reserve(a, repeat('a1', 32), sec, '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "building"}' then
    raise exception 'a second reserve during a build answered %', r;
  end if;

  insert into cp_state values ('a_p1', pk1::text), ('a_t1', tok::text);

  pdf := jsonb_build_object('bucket', 'carrier-packets', 'path', a::text || '/PKT-2098-0001-v1-b1.pdf',
                            'sha256', repeat('1f', 32), 'bytes', 123456, 'pages', 12, 'mode', 'full');
  insert into cp_state values ('a_pdf1', pdf::text);

  -- what file refuses, and what it answers lost
  if public.carrier_packet_file(pk1, gen_random_uuid(), pdf, inp, 'ready', '[]') is distinct from '{"status": "lost"}' then
    raise exception 'file took a wrong build token';
  end if;
  if public.carrier_packet_file(gen_random_uuid(), tok, pdf, inp, 'ready', '[]') is distinct from '{"status": "lost"}' then
    raise exception 'file did not answer lost for a missing packet';
  end if;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf, inp || '{"to": "adjuster@example.com"}', 'ready', '[]');
    raise exception 'file took a To';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf, inp || '{"cc": "someone@example.com"}', 'ready', '[]');
    raise exception 'file took a Cc';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf, inp, 'ready', '{}');
    raise exception 'file took evidence that is not a list';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf, null, 'ready', '[]');
    raise exception 'file took no input';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"bucket": "field-media"}', inp, 'ready', '[]');
    raise exception 'file took a PDF outside the carrier-packets bucket';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"path": "00000000-0000-0000-0000-00000000c2b0/PKT-2098-0001-v1-b1.pdf"}', inp, 'ready', '[]');
    raise exception 'file took a PDF stored under another job';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || jsonb_build_object('path', a::text || '/..PKT.pdf'), inp, 'ready', '[]');
    raise exception 'file took a path with ..';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || jsonb_build_object('path', a::text || '/PKT-2098-0001-v1-b1.txt'), inp, 'ready', '[]');
    raise exception 'file took a path that is not a PDF';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || jsonb_build_object('sha256', upper(repeat('1f', 32))), inp, 'ready', '[]');
    raise exception 'file took an uppercase sha256';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"bytes": 0}', inp, 'ready', '[]');
    raise exception 'file took a PDF of 0 bytes';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"bytes": "123456"}', inp, 'ready', '[]');
    raise exception 'file took bytes as a string';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"pages": 1.5}', inp, 'ready', '[]');
    raise exception 'file took a fraction of a page';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_file(pk1, tok, pdf || '{"mode": "tiny"}', inp, 'ready', '[]');
    raise exception 'file took a mode that is neither full nor compact';
  exception when invalid_parameter_value then null;
  end;
  if (select status from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1')) is distinct from 'building'
     or exists (select 1 from public.proposals where job_id = a) then
    raise exception 'a refused or lost file changed something';
  end if;

  r := public.carrier_packet_file(pk1, tok, pdf, inp, 'The drying packet is ready for the adjuster.',
                                  jsonb_build_array(jsonb_build_object('kind', 'job', 'id', a)));
  if r - 'proposal_id' is distinct from '{"status": "filed", "superseded": []}' or r ->> 'proposal_id' is null then
    raise exception 'a''s file answered %', r;
  end if;
  select * into p from public.proposals where id = (r ->> 'proposal_id')::uuid;
  if p.operation is distinct from 'packet.send@1' or p.action_type is distinct from 'comms' or p.status is distinct from 'proposed'
     or p.proposed_by_kind is distinct from 'agent' or p.proposed_by_id is distinct from docs or p.proposed_via is distinct from 'agent'
     or p.assigned_role is distinct from 'owner' or p.sms_code is not null or p.job_id is distinct from a
     or p.expires_at is distinct from now() + interval '14 days'
     or p.idempotency_key is distinct from 'packet.send:' || pk1 || ':0'
     or p.input is distinct from inp || jsonb_build_object('packet_version_id', pk1, 'offer', 0)
     or p.rationale is distinct from 'The drying packet is ready for the adjuster.'
     or p.evidence_refs is distinct from jsonb_build_array(jsonb_build_object('kind', 'job', 'id', a))
     or p.supersedes_id is not null then
    raise exception 'a''s card is %', to_jsonb(p);
  end if;
  if not exists (select 1 from public.events where kind = 'proposal.created' and idempotency_key = 'proposal.created:' || p.id) then
    raise exception 'a''s card has no proposal.created event';
  end if;
  select * into c from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1');
  if c.status is distinct from 'ready' or c.bucket is distinct from 'carrier-packets' or c.path is distinct from pdf ->> 'path'
     or c.sha256 is distinct from repeat('1f', 32) or c.bytes is distinct from 123456 or c.pages is distinct from 12
     or c.mode is distinct from 'full' or c.proposal_id is distinct from p.id or c.offer <> 0 or c.error is not null then
    raise exception 'a''s filed row is %', to_jsonb(c);
  end if;
  insert into cp_state values ('a_c1', p.id::text);

  if public.carrier_packet_file(pk1, tok, pdf, inp, 'again', '[]') is distinct from '{"status": "lost"}' then
    raise exception 'a filed row filed again';
  end if;
  r := public.carrier_packet_reserve(a, repeat('a1', 32), sec, '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "open"}' then
    raise exception 'reserve with the card open answered %', r;
  end if;
  if public.carrier_packet_state(a) is distinct from '{"photo_nums": {"media:p1": 1, "media:p2": 2}, "last_sent": null}' then
    raise exception 'a''s state is %', public.carrier_packet_state(a);
  end if;
end
$$;
release savepoint s;
reset role;


-- 8. office cannot approve a packet; the owner's approval needs a real To
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c262", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  perform public.op_proposal_approve((select v::uuid from cp_state where k = 'a_c1'), 'inbox', null,
                                     '{"to": "adjuster@example.com"}');
  raise exception 'office approved a packet.send card';
exception when insufficient_privilege then
  null;
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  pa  constant uuid := (select v::uuid from cp_state where k = 'a_c1');
  p   public.proposals;
  bad text;
begin
  begin
    perform public.op_proposal_approve(pa, 'inbox', null, '{"to": "adjuster at example"}');
    raise exception 'the approval took a To that is not an address';
  exception when invalid_parameter_value then null;
  end;
  -- a To the worker would refuse for good is refused before the card runs
  foreach bad in array array['adjuster@example.com>', '<adjuster@example.com', 'adj<uster@example.com',
                             'adjuster@example.com;', 'adjuster@example.com,'] loop
    begin
      perform public.op_proposal_approve(pa, 'inbox', null, jsonb_build_object('to', bad));
      raise exception 'the approval took the To %', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.op_proposal_approve(pa, 'inbox', null, '{"to": "adjuster@example.com", "bcc": "x@example.com"}');
    raise exception 'the approval took a field the schema does not have';
  exception when invalid_parameter_value then null;
  end;

  p := public.op_proposal_approve(pa, 'inbox', null, '{"to": "adjuster@example.com", "cc": ""}');
  if p.status is distinct from 'executed' or p.error is not null
     or p.result - 'outbox_id' is distinct from jsonb_build_object('packet_version_id', (select v from cp_state where k = 'a_p1'),
                                                                    'to', 'adjuster@example.com') then
    raise exception 'the owner''s approval is % (result %, error %)', p.status, p.result, p.error;
  end if;
  insert into cp_state values ('a_o1', p.result ->> 'outbox_id');

  -- approving twice is approving once
  p := public.op_proposal_approve(pa, 'inbox', null, '{"to": "adjuster@example.com", "cc": ""}');
  if p.status is distinct from 'executed' then raise exception 'the second approval is %', p.status; end if;
end
$$;
release savepoint s;
reset role;

do $$
declare
  a   constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  pk1  constant uuid := (select v::uuid from cp_state where k = 'a_p1');
  pa  constant uuid := (select v::uuid from cp_state where k = 'a_c1');
  pdf constant jsonb := (select v::jsonb from cp_state where k = 'a_pdf1');
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  o   public.outbox;
  c   public.carrier_packets;
begin
  if (select count(*) from public.outbox where job_id = a) <> 1 then
    raise exception 'a''s approval wrote % outbox rows', (select count(*) from public.outbox where job_id = a);
  end if;
  select * into o from public.outbox where id = (select v::uuid from cp_state where k = 'a_o1');
  if o.channel is distinct from 'packet' or o.operation is distinct from 'packet.send@1' or o.status is distinct from 'pending'
     or o.idempotency_key is distinct from 'outbox:packet.send:' || pk1 || ':0'
     or o.proposal_id is distinct from pa or o.job_id is distinct from a
     or o.principal_kind is distinct from 'human' or o.principal_id is distinct from '00000000-0000-0000-0000-00000000c261' then
    raise exception 'a''s outbox row is %', to_jsonb(o) - 'payload';
  end if;
  -- exactly what the packet adapter reads
  if o.payload is distinct from jsonb_build_object(
       'to', 'adjuster@example.com', 'cc', '',
       'subject', inp ->> 'subject', 'body', inp ->> 'body',
       'packet_version_id', pk1, 'job_id', a,
       'attachments', jsonb_build_array(jsonb_build_object(
         'bucket', 'carrier-packets', 'path', pdf ->> 'path', 'filename', inp ->> 'filename',
         'content_type', 'application/pdf', 'sha256', pdf ->> 'sha256', 'bytes', 123456))) then
    raise exception 'a''s outbox payload is %', o.payload;
  end if;
  select * into c from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1');
  if c.status is distinct from 'ready' or c.outbox_id is distinct from o.id or c.sent_at is not null then
    raise exception 'after the approval a''s row is %', to_jsonb(c);
  end if;
  if not exists (select 1 from public.events
                  where kind = 'packet.queued' and aggregate_type = 'outbox' and aggregate_id = o.id
                    and idempotency_key = 'packet.queued:' || o.id and proposal_id = pa
                    and data ->> 'to' = 'adjuster@example.com' and data ->> 'number' = 'PKT-2098-0001') then
    raise exception 'a''s approval emitted no packet.queued event';
  end if;
end
$$;


-- 9. in flight, then sent: the trigger never fails the send it reports
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  r jsonb;
begin
  r := public.carrier_packet_reserve(a, repeat('a1', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "in_flight"}' then
    raise exception 'reserve with the card executed answered %', r;
  end if;
  r := public.carrier_packet_reserve(a, repeat('a2', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "in_flight"}' then
    raise exception 'reserve for a changed job with the card executed answered %', r;
  end if;
  r := public.carrier_packet_withdraw(a, 'archived');
  if r is distinct from '{"withdrawn": false, "pdf": null}' then
    raise exception 'withdraw took an approved packet back: %', r;
  end if;
  if (select status from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1')) is distinct from 'ready' then
    raise exception 'withdraw moved an approved packet';
  end if;
end
$$;
release savepoint s;
reset role;

-- the worker leases a's email
update public.outbox
   set status = 'sending', locked_by = 'cp-test-worker', lease_until = now() + interval '2 minutes', attempts = attempts + 1
 where id = (select v::uuid from cp_state where k = 'a_o1');

-- a packet update that fails must not undo the send the worker reports
savepoint g;
alter table public.carrier_packets add constraint cp_test_refuse_sent check (status <> 'sent') not valid;
do $$
declare
  o constant uuid := (select v::uuid from cp_state where k = 'a_o1');
begin
  perform public.outbox_sent(o, 'cp-test-worker', 'gmail-test-1', 'sent', 0);
  if (select status from public.outbox where id = o) is distinct from 'sent' then
    raise exception 'a failing packet update failed the outbox write';
  end if;
  if (select status from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1')) is distinct from 'ready' then
    raise exception 'the refused packet update landed anyway';
  end if;
end
$$;
rollback to savepoint g;
release savepoint g;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  o constant uuid := (select v::uuid from cp_state where k = 'a_o1');
  c public.carrier_packets;
  r jsonb;
begin
  perform public.outbox_sent(o, 'cp-test-worker', 'gmail-test-1', 'sent', 0);
  select * into c from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1');
  if c.status is distinct from 'sent' or c.sent_at is distinct from (select sent_at from public.outbox where id = o)
     or c.sent_to is distinct from 'adjuster@example.com' or c.error is not null or c.outbox_id is distinct from o then
    raise exception 'after the send a''s row is %', to_jsonb(c);
  end if;

  r := public.carrier_packet_reserve(a, repeat('a1', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "sent"}' then
    raise exception 'reserve for the model the carrier has answered %', r;
  end if;
  r := public.carrier_packet_state(a);
  if r -> 'last_sent' is distinct from jsonb_build_object('version', 1, 'sent_at', c.sent_at, 'sent_to', 'adjuster@example.com',
                                                          'section_hashes', c.section_hashes) then
    raise exception 'a''s state after the send is %', r;
  end if;
end
$$;
release savepoint s;
reset role;

-- delivered after sent changes nothing
do $$
declare
  o constant uuid := (select v::uuid from cp_state where k = 'a_o1');
  t timestamptz := (select sent_at from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1'));
begin
  update public.outbox set status = 'delivered', delivered_at = now() where id = o;
  if (select row(status, sent_at)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1'))
     is distinct from row('sent', t)::text then
    raise exception 'delivered moved a sent packet';
  end if;
end
$$;


-- 10. a changes: version 2 replaces the card nobody answered, then a declined one
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a    constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  docs constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';
  inp  constant jsonb := (select v::jsonb from cp_state where k = 'input');
  s1   public.carrier_packets;
  r    jsonb;
  f    jsonb;
  p2   uuid;
  p3   uuid;
  c2   uuid;
  c3   uuid;
  pdf2 jsonb;
  pdf3 jsonb;
begin
  select * into s1 from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p1');

  r := public.carrier_packet_reserve(a, repeat('a2', 32), '{"cert": "x2"}', '{"media:p1": 1, "media:p2": 2, "media:p3": 3}', '{}', 2098);
  p2 := (r ->> 'packet_id')::uuid;
  if r - 'packet_id' - 'build_token' is distinct from jsonb_build_object(
       'action', 'build', 'number', 'PKT-2098-0001', 'version', 2, 'seq', 2,
       'path', a::text || '/PKT-2098-0001-v2-b2.pdf', 'sha256', null, 'bytes', null, 'pages', null, 'mode', null,
       'replaces', jsonb_build_object('version', 1, 'sent_at', s1.sent_at, 'sent_to', 'adjuster@example.com',
                                      'section_hashes', s1.section_hashes)) then
    raise exception 'a''s second reserve answered %', r;
  end if;
  if (select next_value from public.document_sequences where kind = 'PKT' and year = 2098) is distinct from 2 then
    raise exception 'version 2 drew a new number';
  end if;
  pdf2 := jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('2f', 32),
                             'bytes', 223456, 'pages', 14, 'mode', 'compact');
  f := public.carrier_packet_file(p2, (r ->> 'build_token')::uuid, pdf2, inp, 'Version 2', '[]');
  if f - 'proposal_id' is distinct from '{"status": "filed", "superseded": []}' then
    raise exception 'a''s second file answered %', f;
  end if;
  c2 := (f ->> 'proposal_id')::uuid;
  if (select idempotency_key from public.proposals where id = c2) is distinct from 'packet.send:' || p2 || ':0' then
    raise exception 'version 2''s card has key %', (select idempotency_key from public.proposals where id = c2);
  end if;

  -- changed again before the owner looked: version 2 again, replacing that card
  r := public.carrier_packet_reserve(a, repeat('a3', 32), '{"cert": "x3"}', '{}', '{}', 2098);
  p3 := (r ->> 'packet_id')::uuid;
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 2 or (r ->> 'seq')::int <> 3 then
    raise exception 'a''s third reserve answered %', r;
  end if;
  pdf3 := jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('3f', 32),
                             'bytes', 323456, 'pages', 15, 'mode', 'full');
  f := public.carrier_packet_file(p3, (r ->> 'build_token')::uuid, pdf3, inp, 'Version 2 again', '[]');
  c3 := (f ->> 'proposal_id')::uuid;
  if f - 'proposal_id' is distinct from jsonb_build_object('status', 'filed', 'superseded',
       jsonb_build_array(jsonb_build_object('bucket', 'carrier-packets', 'path', pdf2 ->> 'path'))) then
    raise exception 'the file that replaced an open card answered %', f;
  end if;
  if (select row(status, result)::text from public.proposals where id = c2)
     is distinct from row('superseded', jsonb_build_object('superseded_by', c3))::text then
    raise exception 'the replaced card is %', (select to_jsonb(x) from public.proposals x where id = c2);
  end if;
  if not exists (select 1 from public.events
                  where kind = 'proposal.superseded' and aggregate_id = c2 and idempotency_key = 'proposal.superseded:' || c2
                    and principal_kind = 'agent' and principal_id = docs
                    and data = jsonb_build_object('superseded_by', c3)) then
    raise exception 'superseding a''s card emitted no proposal.superseded event';
  end if;
  if (select supersedes_id from public.proposals where id = c3) is distinct from c2 then
    raise exception 'the new card does not name the card it supersedes';
  end if;
  if (select status from public.carrier_packets where id = p2) is distinct from 'superseded'
     or (select status from public.carrier_packets where id = p3) is distinct from 'ready' then
    raise exception 'after the replacement a''s rows are % and %',
      (select status from public.carrier_packets where id = p2), (select status from public.carrier_packets where id = p3);
  end if;

  insert into cp_state values ('a_p2', p2::text), ('a_c2', c2::text), ('a_p3', p3::text), ('a_c3', c3::text),
                              ('a_pdf3', pdf3::text);
end
$$;
release savepoint s;
reset role;

-- the owner declines version 2
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (public.op_proposal_decline((select v::uuid from cp_state where k = 'a_c3'), 'Wrong claim number')).status
     is distinct from 'declined' then
    raise exception 'the owner could not decline a''s card';
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
  a    constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  inp  constant jsonb := (select v::jsonb from cp_state where k = 'input');
  c3   constant uuid := (select v::uuid from cp_state where k = 'a_c3');
  pdf3 constant jsonb := (select v::jsonb from cp_state where k = 'a_pdf3');
  r    jsonb;
  f    jsonb;
  p4   uuid;
begin
  r := public.carrier_packet_reserve(a, repeat('a3', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "declined"}' then
    raise exception 'reserve for the declined model answered %', r;
  end if;
  if exists (select 1 from public.carrier_packet_pdfs_to_remove(100) x where x.id = (select v::uuid from cp_state where k = 'a_p3')) then
    raise exception 'a card declined today is up for removal';
  end if;

  -- the job changes after the decline: a new build replaces it
  r := public.carrier_packet_reserve(a, repeat('a4', 32), '{"cert": "x4"}', '{}', '{}', 2098);
  p4 := (r ->> 'packet_id')::uuid;
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 2 or (r ->> 'seq')::int <> 4 then
    raise exception 'the reserve after a decline answered %', r;
  end if;
  f := public.carrier_packet_file(p4, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('4f', 32),
                                                     'bytes', 423456, 'pages', 16, 'mode', 'full'),
                                  inp, 'Version 2, corrected', '[]');
  if f - 'proposal_id' is distinct from jsonb_build_object('status', 'filed', 'superseded',
       jsonb_build_array(jsonb_build_object('bucket', 'carrier-packets', 'path', pdf3 ->> 'path'))) then
    raise exception 'the file that replaced a declined card answered %', f;
  end if;
  -- a declined card stays declined: the owner's answer is the record
  if (select status from public.proposals where id = c3) is distinct from 'declined'
     or (select supersedes_id from public.proposals where id = (f ->> 'proposal_id')::uuid) is not null then
    raise exception 'filing over a declined card rewrote it';
  end if;
  if (select status from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p3')) is distinct from 'superseded' then
    raise exception 'the declined row was not superseded';
  end if;
  insert into cp_state values ('a_p4', p4::text), ('a_c4', f ->> 'proposal_id');

  -- one more change, reserved while version 2 is still open
  r := public.carrier_packet_reserve(a, repeat('a5', 32), '{"cert": "x5"}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'seq')::int <> 5 then
    raise exception 'the fifth reserve answered %', r;
  end if;
  insert into cp_state values ('a_p5', r ->> 'packet_id'), ('a_t5', r ->> 'build_token'), ('a_path5', r ->> 'path');
end
$$;
release savepoint s;
reset role;


-- 11. the owner approves version 2 while version 2' was building: it relabels
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp_state where k = 'a_c4'), 'inbox', null, '{"to": "adjuster@example.com"}');
  if p.status is distinct from 'executed' then
    raise exception 'approving a''s version 2 is % (%)', p.status, p.error;
  end if;
  insert into cp_state values ('a_o4', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a   constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  p5  constant uuid := (select v::uuid from cp_state where k = 'a_p5');
  f   jsonb;
  c   public.carrier_packets;
begin
  f := public.carrier_packet_file(p5, (select v::uuid from cp_state where k = 'a_t5'),
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', (select v from cp_state where k = 'a_path5'),
                                                     'sha256', repeat('5f', 32), 'bytes', 523456, 'pages', 17, 'mode', 'full'),
                                  inp, 'Version 2 again', '[]');
  if f is distinct from '{"status": "relabel"}' then
    raise exception 'filing over an approved card answered %', f;
  end if;
  select * into c from public.carrier_packets where id = p5;
  -- the PDF it stored is kept on the row, so the cleanup finds it
  if c.status is distinct from 'failed' or c.error is distinct from 'relabel' or c.permanent
     or c.path is distinct from (select v from cp_state where k = 'a_path5') or c.proposal_id is not null then
    raise exception 'the relabelled row is %', to_jsonb(c);
  end if;
  if (select count(*) from public.proposals where job_id = a and input ->> 'packet_version_id' = p5::text) <> 0 then
    raise exception 'a relabelled build filed a card';
  end if;
  if (select status from public.proposals where id = (select v::uuid from cp_state where k = 'a_c4')) is distinct from 'executed' then
    raise exception 'the relabel touched the approved card';
  end if;
end
$$;
release savepoint s;
reset role;

update public.outbox
   set status = 'sending', locked_by = 'cp-test-worker', lease_until = now() + interval '2 minutes', attempts = attempts + 1
 where id = (select v::uuid from cp_state where k = 'a_o4');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  a constant uuid := '00000000-0000-0000-0000-00000000c2a0';
  r jsonb;
begin
  perform public.outbox_sent((select v::uuid from cp_state where k = 'a_o4'), 'cp-test-worker', 'gmail-test-4', 'sent', 0);
  if (select row(status, version)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p4'))
     is distinct from row('sent', 2)::text then
    raise exception 'a''s version 2 is not sent';
  end if;
  r := public.carrier_packet_reserve(a, repeat('a4', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "sent"}' then
    raise exception 'reserve for version 2''s model answered %', r;
  end if;
  -- the relabel was not a try: the model builds as version 3
  r := public.carrier_packet_reserve(a, repeat('a5', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 3 or (r ->> 'seq')::int <> 6
     or (r #>> '{replaces,version}')::int <> 2 then
    raise exception 'the rebuild after the relabel answered %', r;
  end if;
  if public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, 'render failed: test', false)
     is distinct from '{"status": "failed", "capped": false}' then
    raise exception 'a''s first failure is capped';
  end if;
  insert into cp_state values ('a_p6', r ->> 'packet_id');
end
$$;
release savepoint s;
reset role;


-- 12. b fails: three tries, a permanent failure, an abandoned build; holds
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000c2b0';
  r jsonb;
  i int;
begin
  r := public.carrier_packet_reserve(b, repeat('b1', 32), '{}', '{}', '{}', 2098);
  if r ->> 'number' is distinct from 'PKT-2098-0002' then
    raise exception 'b''s number is %', r ->> 'number';
  end if;
  if public.carrier_packet_fail((r ->> 'packet_id')::uuid, gen_random_uuid(), 'x', false) is distinct from '{"status": "lost", "capped": false}' then
    raise exception 'fail took a wrong build token';
  end if;
  if public.carrier_packet_fail(gen_random_uuid(), gen_random_uuid(), 'x', false) is distinct from '{"status": "lost", "capped": false}' then
    raise exception 'fail did not answer lost for a missing packet';
  end if;
  for i in 1 .. 3 loop
    if i > 1 then
      r := public.carrier_packet_reserve(b, repeat('b1', 32), '{}', '{}', '{}', 2098);
    end if;
    if r ->> 'action' is distinct from 'build' or (r ->> 'seq')::int <> i or (r ->> 'version')::int <> 1
       or r ->> 'number' is distinct from 'PKT-2098-0002' then
      raise exception 'b''s reserve % answered %', i, r;
    end if;
    if public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  case i when 3 then repeat('e', 3000) else 'render failed' end, false)
       is distinct from jsonb_build_object('status', 'failed', 'capped', i = 3) then
      raise exception 'b''s failure % did not answer capped %', i, i = 3;
    end if;
    if public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, 'again', false)
       is distinct from '{"status": "lost", "capped": false}' then
      raise exception 'b''s failed row failed again';
    end if;
  end loop;
  if (select length(error) from public.carrier_packets where job_id = b and seq = 3) <> 2000 then
    raise exception 'a long error was not cut to 2000 characters';
  end if;
  r := public.carrier_packet_reserve(b, repeat('b1', 32), '{}', '{}', '{}', 2098);
  -- with the last try's error, cut to 300, for the hold the worker records
  if r - 'error' is distinct from '{"action": "skip", "reason": "failed_cap", "permanent": false}' or r ->> 'error' is distinct from repeat('e', 300) then
    raise exception 'reserve after three failures answered %', r;
  end if;

  -- a permanent failure caps its model at once
  r := public.carrier_packet_reserve(b, repeat('b2', 32), '{}', '{}', '{}', 2098);
  if public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, 'too_large', true)
     is distinct from '{"status": "failed", "capped": true}' then
    raise exception 'a permanent failure is not capped';
  end if;
  -- a PDF too large to email is held as that, never as a failed build
  r := public.carrier_packet_reserve(b, repeat('b2', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "too_large", "error": "too_large"}' then
    raise exception 'reserve after a too-large PDF answered %', r;
  end if;

  r := public.carrier_packet_reserve(b, repeat('b3', 32), '{}', '{}', '{}', 2098);
  insert into cp_state values ('b_p5', r ->> 'packet_id'), ('b_t5', r ->> 'build_token');
end
$$;
release savepoint s;
reset role;

-- the build has run for 31 minutes: the worker died
update public.carrier_packets set created_at = now() - interval '31 minutes'
 where id = (select v::uuid from cp_state where k = 'b_p5');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  b constant uuid := '00000000-0000-0000-0000-00000000c2b0';
  r jsonb;
begin
  r := public.carrier_packet_reserve(b, repeat('b3', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'seq')::int <> 6 then
    raise exception 'reserve past an abandoned build answered %', r;
  end if;
  -- it keeps the path it was to be stored at, so the cleanup removes an upload
  if (select row(status, error, permanent, bucket, path)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'b_p5'))
     is distinct from row('failed', 'abandoned', false, 'carrier-packets', b::text || '/PKT-2098-0002-v1-b5.pdf')::text then
    raise exception 'the abandoned build is %',
      (select row(status, error, permanent, bucket, path)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'b_p5'));
  end if;
  if public.carrier_packet_file((select v::uuid from cp_state where k = 'b_p5'), (select v::uuid from cp_state where k = 'b_t5'),
                                jsonb_build_object('bucket', 'carrier-packets', 'path', b::text || '/late.pdf', 'sha256', repeat('6f', 32),
                                                   'bytes', 1, 'pages', 1, 'mode', 'full'),
                                (select v::jsonb from cp_state where k = 'input'), 'late', '[]')
     is distinct from '{"status": "lost"}' then
    raise exception 'an abandoned build filed after all';
  end if;
  insert into cp_state values ('b_p6', r ->> 'packet_id');
end
$$;
release savepoint s;
reset role;

-- 29 minutes is still building
update public.carrier_packets set created_at = now() - interval '29 minutes'
 where id = (select v::uuid from cp_state where k = 'b_p6');

-- holds: one text per reason per job
do $$
declare
  b   constant uuid := '00000000-0000-0000-0000-00000000c2b0';
  r   jsonb;
  h   public.carrier_packet_holds;
begin
  if public.carrier_packet_reserve(b, repeat('b3', 32), '{}', '{}', '{}', 2098) is distinct from '{"action": "skip", "reason": "building"}' then
    raise exception 'a 29-minute build is not building';
  end if;

  if public.carrier_packet_hold(b, 'no_invoice', 'No invoice yet') is distinct from '{"text_due": true}'
     or public.carrier_packet_hold(b, 'no_invoice', 'No invoice yet') is distinct from '{"text_due": true}' then
    raise exception 'an untexted hold is not due a text';
  end if;
  if public.carrier_packet_hold_texted(b, 'no_invoice') is distinct from '{"recorded": true}' then
    raise exception 'hold_texted did not record';
  end if;
  update public.carrier_packet_holds set since = now() - interval '1 day' where job_id = b;
  if public.carrier_packet_hold(b, 'no_invoice', 'Still no invoice') is distinct from '{"text_due": false}' then
    raise exception 'a texted reason is due a second text';
  end if;
  select * into h from public.carrier_packet_holds where job_id = b;
  if h.since is distinct from now() - interval '1 day' or h.detail is distinct from 'Still no invoice'
     or h.texted_reason is distinct from 'no_invoice' or h.texted_at is null then
    raise exception 'the same reason again moved since or kept the old detail: %', to_jsonb(h);
  end if;
  if public.carrier_packet_hold(b, 'unchecked_fills', repeat('x', 600)) is distinct from '{"text_due": true}' then
    raise exception 'a new reason is not due a text';
  end if;
  select * into h from public.carrier_packet_holds where job_id = b;
  if h.since is distinct from now() or length(h.detail) <> 500 or h.reason is distinct from 'unchecked_fills' then
    raise exception 'a new reason did not restart since or cut the detail: %', to_jsonb(h) - 'detail';
  end if;
  if public.carrier_packet_hold_texted('00000000-0000-0000-0000-00000000c2ff', 'no_invoice') is distinct from '{"recorded": false}' then
    raise exception 'hold_texted recorded a job with no hold';
  end if;
  begin
    perform public.carrier_packet_hold(b, 'No Invoice', null);
    raise exception 'hold took a reason that is not snake_case';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.carrier_packet_hold(null, 'no_invoice', null);
    raise exception 'hold took no job';
  exception when invalid_parameter_value then null;
  end;
  if public.carrier_packet_hold('00000000-0000-0000-0000-000000000000', 'storage_full', 'Packets use over 300 MB')
     is distinct from '{"text_due": true}' then
    raise exception 'the lane''s hold is not due a text';
  end if;

  -- a build means Storage had room again: the lane-wide hold goes, so a later
  -- full bucket texts afresh (rolled back: the job is a throwaway)
  begin
    r := public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c2fe', repeat('fe', 32), '{}', '{}', '{}', 2098);
    if r ->> 'action' is distinct from 'build' then
      raise exception 'a fresh job did not build: %', r;
    end if;
    if exists (select 1 from public.carrier_packet_holds where job_id = '00000000-0000-0000-0000-000000000000') then
      raise exception 'a build left the lane-wide storage_full hold behind';
    end if;
    raise sqlstate 'CP015';
  exception when sqlstate 'CP015' then
    null;
  end;
end
$$;


-- 13. c: withdrawn, rebuilt, approved, undelivered, re-offered to the cap
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  c    constant uuid := '00000000-0000-0000-0000-00000000c2c0';
  docs constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';
  inp  constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r    jsonb;
  f    jsonb;
  p1   uuid;
  c1   uuid;
  pdf  jsonb;
begin
  r := public.carrier_packet_reserve(c, repeat('c1', 32), '{}', '{}', '{}', 2098);
  p1 := (r ->> 'packet_id')::uuid;
  if r ->> 'number' is distinct from 'PKT-2098-0003' then raise exception 'c''s number is %', r ->> 'number'; end if;
  pdf := jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('c0', 32),
                            'bytes', 99999, 'pages', 9, 'mode', 'full');
  f := public.carrier_packet_file(p1, (r ->> 'build_token')::uuid, pdf, inp, 'c', '[]');
  c1 := (f ->> 'proposal_id')::uuid;

  -- the job left scope: the open card goes, and its PDF with it
  r := public.carrier_packet_withdraw(c, 'deleted');
  if r is distinct from jsonb_build_object('withdrawn', true, 'pdf', jsonb_build_object('bucket', 'carrier-packets', 'path', pdf ->> 'path')) then
    raise exception 'withdraw answered %', r;
  end if;
  if (select row(status, result)::text from public.proposals where id = c1)
     is distinct from row('superseded', '{"superseded_reason": "withdrawn", "reason": "deleted"}'::jsonb)::text then
    raise exception 'the withdrawn card is %', (select to_jsonb(x) from public.proposals x where id = c1);
  end if;
  if not exists (select 1 from public.events where kind = 'proposal.superseded' and aggregate_id = c1
                    and principal_kind = 'agent' and principal_id = docs) then
    raise exception 'the withdrawal emitted no proposal.superseded event';
  end if;
  if (select row(status, error)::text from public.carrier_packets where id = p1)
     is distinct from row('superseded', 'withdrawn: deleted')::text then
    raise exception 'the withdrawn row is %', (select row(status, error)::text from public.carrier_packets where id = p1);
  end if;
  if public.carrier_packet_withdraw(c, 'deleted') is distinct from '{"withdrawn": false, "pdf": null}' then
    raise exception 'a second withdraw withdrew something';
  end if;
  if exists (select 1 from public.carrier_packet_holds where job_id = c) then
    raise exception 'withdraw wrote a hold';
  end if;

  -- back in scope, the same model is built again (a withdrawal is not a try)
  r := public.carrier_packet_reserve(c, repeat('c1', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 1 or (r ->> 'seq')::int <> 2 then
    raise exception 'c''s rebuild answered %', r;
  end if;
  pdf := jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('c2', 32),
                            'bytes', 88888, 'pages', 8, 'mode', 'compact');
  f := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, pdf, inp, 'c again', '[]');
  if f - 'proposal_id' is distinct from '{"status": "filed", "superseded": []}' then
    raise exception 'c''s second file answered %', f;
  end if;
  insert into cp_state values ('c_p1', p1::text), ('c_p2', r ->> 'packet_id'), ('c_c2', f ->> 'proposal_id'), ('c_pdf2', pdf::text);
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp_state where k = 'c_c2'), 'inbox', null,
                                  '{"to": "adjuster@example.com", "cc": "desk@example.com"}');
  if p.status is distinct from 'executed' then raise exception 'approving c is % (%)', p.status, p.error; end if;
  insert into cp_state values ('c_o2', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;

-- Gmail refuses c's email for good
update public.outbox
   set status = 'sending', locked_by = 'cp-test-worker', lease_until = now() + interval '2 minutes', attempts = attempts + 1
 where id = (select v::uuid from cp_state where k = 'c_o2');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  c   constant uuid := '00000000-0000-0000-0000-00000000c2c0';
  p2  constant uuid := (select v::uuid from cp_state where k = 'c_p2');
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  pdf constant jsonb := (select v::jsonb from cp_state where k = 'c_pdf2');
  r   jsonb;
  row_ public.carrier_packets;
  i   int;
begin
  if (select o.payload ->> 'cc' from public.outbox o where o.id = (select v::uuid from cp_state where k = 'c_o2')) is distinct from 'desk@example.com' then
    raise exception 'the Cc the owner added is not in the payload';
  end if;
  if public.carrier_packet_withdraw(c, 'archived') is distinct from '{"withdrawn": false, "pdf": null}' then
    raise exception 'withdraw took back a packet being sent';
  end if;

  perform public.outbox_failed((select v::uuid from cp_state where k = 'c_o2'), 'cp-test-worker', 'Gmail 550: mailbox unavailable', true);
  select * into row_ from public.carrier_packets where id = p2;
  if row_.status is distinct from 'undelivered' or row_.error is distinct from 'Gmail 550: mailbox unavailable' or row_.sent_at is not null then
    raise exception 'after the dead send c''s row is %', to_jsonb(row_);
  end if;

  -- the same PDF is offered again, as it is
  r := public.carrier_packet_reserve(c, repeat('c1', 32), '{}', '{}', '{}', 2098);
  if r is distinct from jsonb_build_object(
       'action', 'reoffer', 'packet_id', p2, 'number', 'PKT-2098-0003', 'version', 1, 'seq', 2,
       'build_token', row_.build_token, 'path', pdf ->> 'path', 'sha256', pdf ->> 'sha256', 'bytes', 88888,
       'pages', 8, 'mode', 'compact', 'replaces', null) then
    raise exception 'reserve after a dead send answered %', r;
  end if;
  begin
    perform public.carrier_packet_reoffer(p2, inp || '{"to": "adjuster@example.com"}', 'again', '[]');
    raise exception 'reoffer took a To';
  exception when invalid_parameter_value then null;
  end;
  if public.carrier_packet_reoffer(gen_random_uuid(), inp, 'again', '[]') is distinct from '{"status": "lost", "reason": "missing"}' then
    raise exception 'reoffer did not answer missing';
  end if;
  if public.carrier_packet_reoffer((select v::uuid from cp_state where k = 'c_p1'), inp, 'again', '[]')
     is distinct from '{"status": "lost", "reason": "not_offerable"}' then
    raise exception 'reoffer offered a withdrawn row';
  end if;

  for i in 1 .. 3 loop
    r := public.carrier_packet_reoffer(p2, inp, 'Offered again', '[]');
    if r - 'proposal_id' is distinct from jsonb_build_object('status', 'filed', 'offer', i, 'superseded', '[]'::jsonb) then
      raise exception 'reoffer % answered %', i, r;
    end if;
    select * into row_ from public.carrier_packets where id = p2;
    if row_.status is distinct from 'ready' or row_.offer <> i or row_.proposal_id is distinct from (r ->> 'proposal_id')::uuid
       or row_.outbox_id is not null or row_.error is not null or row_.path is distinct from pdf ->> 'path' then
      raise exception 'after reoffer % c''s row is %', i, to_jsonb(row_);
    end if;
    if (select row(idempotency_key, sms_code is null, status)::text from public.proposals where id = row_.proposal_id)
       is distinct from row('packet.send:' || p2 || ':' || i, true, 'proposed')::text then
      raise exception 'reoffer %''s card is %', i, (select to_jsonb(x) from public.proposals x where id = row_.proposal_id);
    end if;
    if public.carrier_packet_reoffer(p2, inp, 'Offered again', '[]') is distinct from '{"status": "lost", "reason": "open"}' then
      raise exception 'reoffer offered over an open card';
    end if;
    if public.carrier_packet_reserve(c, repeat('c1', 32), '{}', '{}', '{}', 2098) is distinct from '{"action": "skip", "reason": "open"}' then
      raise exception 'reserve with reoffer %''s card open did not skip', i;
    end if;
    -- nobody answers it: it expires
    update public.proposals set expires_at = now() - interval '1 second' where id = row_.proposal_id;
    r := public.carrier_packet_reserve(c, repeat('c1', 32), '{}', '{}', '{}', 2098);
    if (select status from public.proposals where id = row_.proposal_id) is distinct from 'expired' then
      raise exception 'reserve did not expire a stale card first';
    end if;
    if i < 3 and r ->> 'action' is distinct from 'reoffer' then
      raise exception 'reserve after reoffer %''s card expired answered %', i, r;
    end if;
  end loop;
  if r is distinct from '{"action": "skip", "reason": "offer_cap"}' then
    raise exception 'reserve after three re-offers answered %', r;
  end if;
  if public.carrier_packet_reoffer(p2, inp, 'again', '[]') is distinct from '{"status": "lost", "reason": "offer_cap"}' then
    raise exception 'reoffer went past the cap';
  end if;

  -- a new model replaces it; the dead email still names this PDF, so it stays
  r := public.carrier_packet_reserve(c, repeat('c3', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 1 or (r ->> 'seq')::int <> 3 then
    raise exception 'c''s new model answered %', r;
  end if;
  r := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('c3', 32),
                                                     'bytes', 77777, 'pages', 7, 'mode', 'full'),
                                  inp, 'c3', '[]');
  if r - 'proposal_id' is distinct from '{"status": "filed", "superseded": []}' then
    raise exception 'filing over a PDF a dead email names answered %', r;
  end if;
  if (select status from public.carrier_packets where id = p2) is distinct from 'superseded' then
    raise exception 'c''s re-offered row was not superseded';
  end if;
end
$$;
release savepoint s;
reset role;


-- 14. d: Gmail refuses the PDF as too large
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  d   constant uuid := '00000000-0000-0000-0000-00000000c2d0';
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  r := public.carrier_packet_reserve(d, repeat('d1', 32), '{}', '{}', '{}', 2098);
  insert into cp_state values ('d_p1', r ->> 'packet_id');
  r := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('d1', 32),
                                                     'bytes', 17000000, 'pages', 140, 'mode', 'compact'),
                                  inp, 'd', '[]');
  insert into cp_state values ('d_c1', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp_state where k = 'd_c1'), 'inbox', null, '{"to": "adjuster@example.com"}');
  insert into cp_state values ('d_o1', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;

update public.outbox
   set status = 'sending', locked_by = 'cp-test-worker', lease_until = now() + interval '2 minutes', attempts = attempts + 1
 where id = (select v::uuid from cp_state where k = 'd_o1');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  d   constant uuid := '00000000-0000-0000-0000-00000000c2d0';
  p1  constant uuid := (select v::uuid from cp_state where k = 'd_p1');
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  perform public.outbox_failed((select v::uuid from cp_state where k = 'd_o1'), 'cp-test-worker', 'Gmail 413: Request Entity Too Large', true);
  if (select status from public.carrier_packets where id = p1) is distinct from 'undelivered' then
    raise exception 'd''s dead send did not mark it undelivered';
  end if;
  -- only the packet that recorded the email: c's open card is untouched
  if (select row(status, error)::text from public.carrier_packets
       where job_id = '00000000-0000-0000-0000-00000000c2c0' and seq = 3) is distinct from row('ready', null)::text then
    raise exception 'd''s dead email moved c''s packet';
  end if;
  r := public.carrier_packet_reserve(d, repeat('d1', 32), '{}', '{}', '{}', 2098);
  if r is distinct from '{"action": "skip", "reason": "too_large", "error": "Gmail 413: Request Entity Too Large"}' then
    raise exception 'reserve after Gmail refused the size answered %', r;
  end if;
  insert into cp_state values ('d_r', r::text);
end
$$;
release savepoint s;
reset role;

-- the size refusal as other words may say it, and a refusal that is not about size
do $$
declare
  d  constant uuid := '00000000-0000-0000-0000-00000000c2d0';
  p1 constant uuid := (select v::uuid from cp_state where k = 'd_p1');
  e  text;
  r  jsonb;
begin
  foreach e in array array['message too_large', 'The message is too large to send', 'HTTP 413'] loop
    update public.carrier_packets set error = e where id = p1;
    r := public.carrier_packet_reserve(d, repeat('d1', 32), '{}', '{}', '{}', 2098);
    if r is distinct from jsonb_build_object('action', 'skip', 'reason', 'too_large', 'error', e) then
      raise exception 'the error "%" is not read as too large: %', e, r;
    end if;
  end loop;
  foreach e in array array['Gmail 550: mailbox unavailable', 'HTTP 4130', 'large attachment fine'] loop
    update public.carrier_packets set error = e where id = p1;
    r := public.carrier_packet_reserve(d, repeat('d1', 32), '{}', '{}', '{}', 2098);
    if r ->> 'action' is distinct from 'reoffer' then
      raise exception 'the error "%" is read as too large: %', e, r;
    end if;
  end loop;
  -- its stored PDF is gone or changed (the adapter's permanent refusals): the
  -- same PDF would fail again, so it is built afresh, never re-offered
  foreach e in array array['the packet PDF is missing from storage, so it was not sent',
                           'the packet PDF in storage does not match the approved one (its sha256 differs), so it was not sent'] loop
    begin
      update public.carrier_packets set error = e where id = p1;
      r := public.carrier_packet_reserve(d, repeat('d1', 32), '{}', '{}', '{}', 2098);
      if r ->> 'action' is distinct from 'build' or (r ->> 'version')::integer is distinct from 1 then
        raise exception 'the error "%" did not rebuild version 1: %', e, r;
      end if;
      raise sqlstate 'CP016';
    exception when sqlstate 'CP016' then
      null;
    end;
  end loop;
  update public.carrier_packets set error = 'Gmail 413: Request Entity Too Large' where id = p1;

  -- a newer live row: the undelivered one is not the latest, so it is not re-offered
  begin
    insert into public.carrier_packets (job_id, number, version, seq, model_hash, status, sent_at, sent_to,
                                        bucket, path, sha256, bytes, pages, mode)
    values (d, 'PKT-2098-0004', 1, 9, repeat('d9', 32), 'sent', now(), 'adjuster@example.com',
            'carrier-packets', d::text || '/x.pdf', repeat('d9', 32), 1, 1, 'full');
    r := public.carrier_packet_reoffer(p1, (select v::jsonb from cp_state where k = 'input'), 'again', '[]');
    if r is distinct from '{"status": "lost", "reason": "not_latest"}' then
      raise exception 'reoffer under a newer sent row answered %', r;
    end if;
    raise sqlstate 'CP014';
  exception when sqlstate 'CP014' then
    null;
  end;
end
$$;

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  d   constant uuid := '00000000-0000-0000-0000-00000000c2d0';
  p1  constant uuid := (select v::uuid from cp_state where k = 'd_p1');
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  -- a smaller model builds; the oversized row it replaces is superseded, and
  -- its PDF, which an outbox row names, is kept
  r := public.carrier_packet_reserve(d, repeat('d2', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 1 or (r ->> 'seq')::int <> 2 then
    raise exception 'd''s smaller model answered %', r;
  end if;
  r := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('d2', 32),
                                                     'bytes', 9000000, 'pages', 90, 'mode', 'compact'),
                                  inp, 'd2', '[]');
  if r - 'proposal_id' is distinct from '{"status": "filed", "superseded": []}' then
    raise exception 'd''s smaller file answered %', r;
  end if;
  if (select status from public.carrier_packets where id = p1) is distinct from 'superseded' then
    raise exception 'the undelivered row above the last send was not superseded';
  end if;
end
$$;
release savepoint s;
reset role;


-- 15. e: what the executor refuses, called the way op_execute calls it
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  e   constant uuid := '00000000-0000-0000-0000-00000000c2e0';
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  r := public.carrier_packet_reserve(e, repeat('e1', 32), '{}', '{}', '{}', 2098);
  insert into cp_state values ('e_p1', r ->> 'packet_id');
  r := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('e1', 32),
                                                     'bytes', 4444, 'pages', 4, 'mode', 'full'),
                                  inp, 'e', '[]');
  insert into cp_state values ('e_c1', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

do $$
declare
  e     constant uuid := '00000000-0000-0000-0000-00000000c2e0';
  owner constant uuid := '00000000-0000-0000-0000-00000000c261';
  pid   constant uuid := (select v::uuid from cp_state where k = 'e_p1');
  good  constant jsonb := '{"to": "adjuster@example.com"}';
  base  public.proposals;
  p     public.proposals;
  edit  jsonb;
  ok    boolean;
begin
  select * into base from public.proposals where id = (select v::uuid from cp_state where k = 'e_c1');

  -- the recipient the owner confirmed, and nothing else; a To or Cc the
  -- worker refuses for good (rfc822.mjs validAddresses), or one with a name
  foreach edit in array array[null, '{}', '[]', '{"cc": "desk@example.com"}', '{"to": "adjuster@example.com", "subject": "x"}',
                              '{"to": 5}', '{"to": "adjuster"}', '{"to": "adjuster@example.com", "cc": 5}',
                              '{"to": "adjuster@example.com>"}', '{"to": "<adjuster@example.com"}', '{"to": "adjuster@example.com;"}',
                              '{"to": "adjuster@example.com, desk@example.com"}',
                              '{"to": "adjuster@example.com", "cc": "desk@example.com>"}',
                              '{"to": "adjuster@example.com", "cc": "<desk@example.com"}',
                              '{"to": "adjuster@example.com", "cc": "desk@example.com, <office@example.com"}',
                              '{"to": "adjuster@example.com", "cc": "Jane Sample <desk@example.com>"}',
                              '{"to": "adjuster@example.com", "cc": "desk@example.com; office@example.com"}',
                              '{"to": "adjuster@example.com", "cc": "desk@example.com office@example.com"}',
                              '{"to": "adjuster@example.com", "cc": "desk"}',
                              '{"to": "adjuster@example.com", "cc": " , "}']::jsonb[] loop
    p := base;
    p.edited_params := edit;
    begin
      perform public.op_exec_packet_send(p, p.input || coalesce(edit, '{}'), 'human', owner);
      raise exception 'accepted';
    exception when others then
      if sqlerrm is distinct from 'Reload Approvals and confirm the recipient.' then
        raise exception 'the edit % was answered: %', edit, sqlerrm;
      end if;
    end;
  end loop;
  -- a Cc the worker takes: bare addresses apart by commas, blanks dropped
  -- (undone by its block)
  begin
    p := base;
    p.edited_params := '{"to": "adjuster@example.com", "cc": " desk@example.com,office@example.com , "}';
    if public.op_exec_packet_send(p, p.input || p.edited_params, 'human', owner) ->> 'outbox_id' is null then
      raise exception 'a Cc of two bare addresses queued nothing';
    end if;
    raise sqlstate 'CP017';
  exception when sqlstate 'CP017' then
    null;
  end;

  -- what must still be true under the lock; each change is undone by its block
  p := base;
  p.edited_params := good;
  begin
    update public.field_projects set deleted = true where id = e;
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'deleted' then raise exception 'a deleted job was answered: %', sqlerrm; end if;
  end;
  begin
    update public.field_projects set data = data || '{"archivedAt": "2098-10-02T00:00:00.000Z"}' where id = e;
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'archived' then raise exception 'an archived job was answered: %', sqlerrm; end if;
  end;
  begin
    update public.carrier_packets set pdf_removed_at = now() where id = pid;
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'PDF is no longer stored' then raise exception 'a removed PDF was answered: %', sqlerrm; end if;
  end;
  begin
    update public.carrier_packets set status = 'undelivered' where id = pid;
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'no longer the packet''s current card' then raise exception 'a row that is not ready was answered: %', sqlerrm; end if;
  end;
  begin
    insert into public.carrier_packets (job_id, number, version, seq, model_hash, status, error)
    values (e, 'PKT-2098-0005', 1, 9, repeat('e9', 32), 'undelivered', 'test');
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'a newer version' then raise exception 'a newer live row was answered: %', sqlerrm; end if;
  end;
  begin
    p.id := gen_random_uuid();
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'no longer the packet''s current card' then raise exception 'another card was answered: %', sqlerrm; end if;
  end;
  p := base;
  p.edited_params := good;
  begin
    p.job_id := '00000000-0000-0000-0000-00000000c2a0';
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'not the card''s job' then raise exception 'a card of another job was answered: %', sqlerrm; end if;
  end;
  p := base;
  p.edited_params := good;
  begin
    p.input := p.input - 'packet_version_id';
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'names no packet' then raise exception 'a card with no packet was answered: %', sqlerrm; end if;
  end;
  begin
    p.input := base.input || '{"packet_version_id": "not-a-uuid"}';
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'names no packet' then raise exception 'a card with a bad packet id was answered: %', sqlerrm; end if;
  end;
  -- a packet whose job has no row at all
  begin
    insert into public.carrier_packets (id, job_id, number, version, seq, model_hash, status, proposal_id, bucket, path, sha256, bytes, pages, mode)
    values ('00000000-0000-0000-0000-00000000c2e9', '00000000-0000-0000-0000-00000000c2ee', 'PKT-2098-9999', 1, 1, repeat('e8', 32),
            'ready', base.id, 'carrier-packets', '00000000-0000-0000-0000-00000000c2ee/x.pdf', repeat('e8', 32), 1, 1, 'full');
    p := base;
    p.edited_params := good;
    p.job_id := '00000000-0000-0000-0000-00000000c2ee';
    p.input := base.input || '{"packet_version_id": "00000000-0000-0000-0000-00000000c2e9"}';
    perform public.op_exec_packet_send(p, p.input || good, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm !~ 'does not exist' then raise exception 'a missing job was answered: %', sqlerrm; end if;
  end;

  if exists (select 1 from public.outbox where job_id = e)
     or (select row(status, outbox_id is null, pdf_removed_at is null)::text from public.carrier_packets where id = pid)
        is distinct from row('ready', true, true)::text then
    raise exception 'a refused execution left something behind';
  end if;
end
$$;

-- an approval with no recipient fails the card and sends nothing; the run offers it again
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp_state where k = 'e_c1'), 'inbox');
  if p.status is distinct from 'failed' or p.error is distinct from 'Reload Approvals and confirm the recipient.' then
    raise exception 'an approval with no To is % (%)', p.status, p.error;
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
  e constant uuid := '00000000-0000-0000-0000-00000000c2e0';
  r jsonb;
begin
  if exists (select 1 from public.outbox where job_id = e) then
    raise exception 'an approval with no To queued an email';
  end if;
  r := public.carrier_packet_reserve(e, repeat('e1', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'reoffer' or r ->> 'packet_id' is distinct from (select v from cp_state where k = 'e_p1') then
    raise exception 'reserve after a failed card answered %', r;
  end if;
end
$$;
release savepoint s;
reset role;


-- 16. g: version 1 is sent while its replacement builds, so the replacement relabels
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  g   constant uuid := '00000000-0000-0000-0000-00000000c2f0';
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  r := public.carrier_packet_reserve(g, repeat('f1', 32), '{}', '{}', '{}', 2098);
  if r ->> 'number' is distinct from 'PKT-2098-0006' then raise exception 'g''s number is %', r ->> 'number'; end if;
  insert into cp_state values ('g_p1', r ->> 'packet_id');
  r := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('f1', 32),
                                                     'bytes', 5555, 'pages', 5, 'mode', 'full'),
                                  inp, 'g', '[]');
  insert into cp_state values ('g_c1', r ->> 'proposal_id');
  r := public.carrier_packet_reserve(g, repeat('f2', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 1 then
    raise exception 'g''s second reserve answered %', r;
  end if;
  insert into cp_state values ('g_p2', r ->> 'packet_id'), ('g_t2', r ->> 'build_token'), ('g_path2', r ->> 'path');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c261", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp_state where k = 'g_c1'), 'inbox', null, '{"to": "adjuster@example.com"}');
  insert into cp_state values ('g_o1', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;

-- a provider that reports delivery straight away
update public.outbox set status = 'delivered', sent_at = now(), delivered_at = now()
 where id = (select v::uuid from cp_state where k = 'g_o1');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  inp constant jsonb := (select v::jsonb from cp_state where k = 'input');
  r   jsonb;
begin
  if (select row(status, sent_to)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'g_p1'))
     is distinct from row('sent', 'adjuster@example.com')::text then
    raise exception 'a delivered packet row is not sent';
  end if;
  r := public.carrier_packet_file((select v::uuid from cp_state where k = 'g_p2'), (select v::uuid from cp_state where k = 'g_t2'),
                                  jsonb_build_object('bucket', 'carrier-packets', 'path', (select v from cp_state where k = 'g_path2'),
                                                     'sha256', repeat('f2', 32), 'bytes', 6666, 'pages', 6, 'mode', 'full'),
                                  inp, 'g2', '[]');
  if r is distinct from '{"status": "relabel"}' then
    raise exception 'a build labelled version 1 after version 1 was sent answered %', r;
  end if;
  if (select row(status, error)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'g_p2'))
     is distinct from row('failed', 'relabel')::text then
    raise exception 'g''s stale build was not failed as relabel';
  end if;
end
$$;
release savepoint s;
reset role;


-- however often the label moves, relabels never cap a model
do $$
declare
  g constant uuid := '00000000-0000-0000-0000-00000000c2f0';
  r jsonb;
begin
  insert into public.carrier_packets (job_id, number, version, seq, model_hash, status, error)
  values (g, 'PKT-2098-0006', 1, 11, repeat('f2', 32), 'failed', 'relabel'),
         (g, 'PKT-2098-0006', 1, 12, repeat('f2', 32), 'failed', 'relabel');
  r := public.carrier_packet_reserve(g, repeat('f2', 32), '{}', '{}', '{}', 2098);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 2 or (r ->> 'seq')::int <> 13 then
    raise exception 'reserve after three relabels answered %', r;
  end if;
  if public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, 'render failed', false)
     is distinct from '{"status": "failed", "capped": false}' then
    raise exception 'one failure after three relabels is capped';
  end if;
end
$$;


-- 17. the cleanup: what may be deleted, and the stamp that re-checks it
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  listed uuid[] := array(select x.id from public.carrier_packet_pdfs_to_remove(100) x);
  nm     text;
  n      int;
begin
  -- a_p6 failed before it was filed: it keeps the path it was to be stored
  -- at, so an upload the worker could not delete is still cleaned up
  foreach nm in array array['a_p2', 'a_p3', 'a_p5', 'c_p1', 'g_p2', 'a_p6'] loop
    if not ((select v::uuid from cp_state where k = nm) = any (listed)) then
      raise exception 'the PDF of % is not up for removal', nm;
    end if;
  end loop;
  if (select row(bucket, path)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p6'))
     is distinct from row('carrier-packets', '00000000-0000-0000-0000-00000000c2a0/PKT-2098-0001-v3-b6.pdf')::text then
    raise exception 'a_p6 did not keep its planned path: %',
      (select row(bucket, path)::text from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p6'));
  end if;
  -- sent today (a_p1, a_p4, g_p1), named by an outbox row (c_p2, d_p1), on
  -- a card the run offers again (e_p1)
  foreach nm in array array['a_p1', 'a_p4', 'g_p1', 'c_p2', 'd_p1', 'e_p1'] loop
    if (select v::uuid from cp_state where k = nm) = any (listed) then
      raise exception 'the PDF of % is up for removal', nm;
    end if;
  end loop;
  if (select count(*) from public.carrier_packet_pdfs_to_remove(1)) <> 1
     or (select count(*) from public.carrier_packet_pdfs_to_remove(0)) <> 1 then
    raise exception 'the cleanup''s limit is not clamped to 1..100';
  end if;

  n := public.carrier_packet_pdfs_removed(array[(select v::uuid from cp_state where k = 'a_p2'),
                                                (select v::uuid from cp_state where k = 'a_p1'),
                                                (select v::uuid from cp_state where k = 'c_p2'),
                                                (select v::uuid from cp_state where k = 'd_p1'),
                                                (select v::uuid from cp_state where k = 'e_p1'),
                                                gen_random_uuid()]);
  if n <> 1 then raise exception 'the stamp stamped % rows, not just the superseded one', n; end if;
  if (select pdf_removed_at from public.carrier_packets where id = (select v::uuid from cp_state where k = 'a_p2')) is null
     or exists (select 1 from public.carrier_packets
                 where id in (select v::uuid from cp_state where k in ('a_p1', 'c_p2', 'd_p1', 'e_p1')) and pdf_removed_at is not null) then
    raise exception 'the stamp landed on the wrong rows';
  end if;
  if public.carrier_packet_pdfs_removed(array[(select v::uuid from cp_state where k = 'a_p2')]) <> 0
     or public.carrier_packet_pdfs_removed(null) <> 0 then
    raise exception 'the stamp stamped a row twice, or took no ids';
  end if;
  if (select v::uuid from cp_state where k = 'a_p2') = any (array(select x.id from public.carrier_packet_pdfs_to_remove(100) x)) then
    raise exception 'a removed PDF is up for removal again';
  end if;
end
$$;
release savepoint s;
reset role;


-- 18. the storage helpers, with and without storage.objects (read here as
--     postgres, which can read storage.objects where it exists)
do $$
declare
  n bigint;
begin
  if to_regclass('storage.objects') is null then
    if public.carrier_packet_storage_bytes() <> 0 then
      raise exception 'with no storage.objects the bytes are not 0';
    end if;
    if exists (select 1 from public.carrier_packet_media_sizes(array['m-1'])) then
      raise exception 'with no storage.objects a media size came back';
    end if;
  else
    begin
      select coalesce(sum(case when o.metadata ->> 'size' ~ '^[0-9]{1,18}$' then (o.metadata ->> 'size')::bigint else 0 end), 0)
        into n from storage.objects o where o.bucket_id = 'carrier-packets';
      if public.carrier_packet_storage_bytes() is distinct from n then
        raise exception 'storage_bytes is %, storage.objects says %', public.carrier_packet_storage_bytes(), n;
      end if;
      if (select count(*) from public.carrier_packet_media_sizes(array(select o.name from storage.objects o
                                                                       where o.bucket_id = 'field-media' limit 3)))
         is distinct from (select count(*) from (select 1 from storage.objects o where o.bucket_id = 'field-media' limit 3) x) then
        raise exception 'media_sizes does not answer every field-media object it was asked about';
      end if;
    exception when insufficient_privilege then
      raise notice 'storage.objects is not readable here; the storage sizes are not compared';
    end;
  end if;
  if exists (select 1 from public.carrier_packet_media_sizes(null)) or exists (select 1 from public.carrier_packet_media_sizes('{}')) then
    raise exception 'media_sizes answered no names';
  end if;
  begin
    perform public.carrier_packet_media_sizes(array(select 'm-' || i from generate_series(1, 5001) i));
    raise exception 'media_sizes took 5001 names';
  exception when invalid_parameter_value then null;
  end;
end
$$;

-- where storage-api never ran, a stand-in storage.objects shows the dynamic
-- reads work once it exists (rolled back with the savepoint)
savepoint st;
do $$
begin
  if to_regclass('storage.objects') is not null then
    return;
  end if;
  begin
    create schema if not exists storage;
    create table storage.objects (bucket_id text, name text, metadata jsonb);
  exception when insufficient_privilege then
    raise notice 'cannot create a stand-in storage.objects here; the dynamic storage reads are not exercised';
    return;
  end;
  insert into storage.objects values
    ('carrier-packets', 'x/a.pdf', '{"size": 100}'),
    ('carrier-packets', 'x/b.pdf', '{"size": "250"}'),
    ('carrier-packets', 'x/c.pdf', '{"size": "lots"}'),
    ('field-media', 'm-1', '{"size": 1234}'),
    ('field-media', 'm-2', '{}'),
    ('other', 'm-3', '{"size": 7}');
  if public.carrier_packet_storage_bytes() <> 350 then
    raise exception 'storage_bytes over the stand-in is %', public.carrier_packet_storage_bytes();
  end if;
  if (select jsonb_agg(jsonb_build_array(name, bytes) order by name) from public.carrier_packet_media_sizes(array['m-1', 'm-2', 'm-3', 'm-9']))
     is distinct from '[["m-1", 1234], ["m-2", null]]' then
    raise exception 'media_sizes over the stand-in is %',
      (select jsonb_agg(jsonb_build_array(name, bytes) order by name) from public.carrier_packet_media_sizes(array['m-1', 'm-2', 'm-3', 'm-9']));
  end if;
end
$$;
rollback to savepoint st;
release savepoint st;

rollback;


-- 19. candidates and the cleanup of declined, sent and offered-out PDFs, with
--     jobs, cards and emails dated in the past. Its own transaction: the updated_at trigger on field_projects
--     is off for its length, and both come back with the rollback.
begin;

-- the earlier rollback leaves the claims setting empty, which the blob's
-- updated_by trigger cannot read
set local request.jwt.claims = '{"role": "service_role"}';
alter table public.field_projects disable trigger trg_field_projects_touch;

-- k1 certified 3 days ago; k2 certified 20 days ago (upload); k3 certified now
-- (an uploaded document); k4 a certificate with nothing in it; k5 deleted with
-- an open card; k6 changed since its packet; k7 not changed since; k8
-- certified and deleted; k9 a certificate of the wrong shapes; k10 has an open
-- card and no job row at all. k11 and k12 hold cards declined 15 and 13 days
-- ago (no job rows; they are not in the candidate checks).
insert into public.field_projects (id, data, deleted, updated_at)
select j.id, jsonb_build_object('id', j.id, 'title', 'Jane Sample - ' || j.n) || j.extra, j.deleted, now() - j.age
  from (values
    ('00000000-0000-0000-0000-00000000c3a1'::uuid, 'k1', '{"certDrying": {"sigTech": "data:image/png;base64,AAAA"}}'::jsonb, false, interval '3 days'),
    ('00000000-0000-0000-0000-00000000c3a2'::uuid, 'k2', '{"certDrying": {"mode": "upload", "uploadedPages": ["media:p1"]}}'::jsonb, false, interval '20 days'),
    ('00000000-0000-0000-0000-00000000c3a3'::uuid, 'k3', '{"certDrying": {"mode": "upload", "uploadedDoc": {"ref": "media:d1"}}}'::jsonb, false, interval '0'),
    ('00000000-0000-0000-0000-00000000c3a4'::uuid, 'k4', '{"certDrying": {"sigTech": "", "uploadedPages": [], "uploadedDoc": ""}}'::jsonb, false, interval '0'),
    ('00000000-0000-0000-0000-00000000c3a5'::uuid, 'k5', '{}'::jsonb, true, interval '40 days'),
    ('00000000-0000-0000-0000-00000000c3a6'::uuid, 'k6', '{}'::jsonb, false, interval '30 days'),
    ('00000000-0000-0000-0000-00000000c3a7'::uuid, 'k7', '{}'::jsonb, false, interval '30 days'),
    ('00000000-0000-0000-0000-00000000c3a8'::uuid, 'k8', '{"certDrying": {"sigTech": "data:image/png;base64,AAAA"}}'::jsonb, true, interval '0'),
    ('00000000-0000-0000-0000-00000000c3a9'::uuid, 'k9', '{"certDrying": {"sigTech": 5, "uploadedPages": "media:p1", "uploadedDoc": {}}}'::jsonb, false, interval '0')
  ) as j(id, n, extra, deleted, age);

-- cards declined 15 and 13 days ago, as their last update left them (an
-- insert does not fire proposals' updated_at trigger)
insert into public.proposals (id, operation, action_type, input, proposed_by_kind, proposed_by_id, proposed_via,
                              job_id, assigned_role, status, expires_at, idempotency_key, created_at, updated_at)
values
  ('00000000-0000-0000-0000-00000000c3d1', 'packet.send@1', 'comms', '{}', 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent',
   '00000000-0000-0000-0000-00000000c3ab', 'owner', 'declined', now() - interval '2 days', 'cp-test:declined-15',
   now() - interval '16 days', now() - interval '15 days'),
  ('00000000-0000-0000-0000-00000000c3d2', 'packet.send@1', 'comms', '{}', 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent',
   '00000000-0000-0000-0000-00000000c3ac', 'owner', 'declined', now() + interval '1 day', 'cp-test:declined-13',
   now() - interval '14 days', now() - interval '13 days'),
  ('00000000-0000-0000-0000-00000000c3d5', 'packet.send@1', 'comms', '{}', 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent',
   '00000000-0000-0000-0000-00000000c3a5', 'owner', 'proposed', now() + interval '10 days', 'cp-test:open-k5', now(), now()),
  ('00000000-0000-0000-0000-00000000c3d0', 'packet.send@1', 'comms', '{}', 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent',
   '00000000-0000-0000-0000-00000000c3b0', 'owner', 'proposed', now() + interval '10 days', 'cp-test:open-k10', now(), now());

insert into public.carrier_packets (id, job_id, number, version, seq, model_hash, status, proposal_id,
                                    bucket, path, sha256, bytes, pages, mode, created_at)
select p.id, p.job, 'PKT-2098-' || p.n, 1, 1, repeat('9a', 32), p.status, p.card,
       'carrier-packets', p.job::text || '/PKT-2098-' || p.n || '-v1-b1.pdf', repeat('9b', 32), 10, 1, 'full', now() - p.age
  from (values
    ('00000000-0000-0000-0000-00000000c3e5'::uuid, '00000000-0000-0000-0000-00000000c3a5'::uuid, '0905', 'ready',      '00000000-0000-0000-0000-00000000c3d5'::uuid, interval '41 days'),
    ('00000000-0000-0000-0000-00000000c3e6'::uuid, '00000000-0000-0000-0000-00000000c3a6'::uuid, '0906', 'superseded', null::uuid, interval '31 days'),
    ('00000000-0000-0000-0000-00000000c3e7'::uuid, '00000000-0000-0000-0000-00000000c3a7'::uuid, '0907', 'superseded', null::uuid, interval '29 days'),
    ('00000000-0000-0000-0000-00000000c3e0'::uuid, '00000000-0000-0000-0000-00000000c3b0'::uuid, '0910', 'ready',      '00000000-0000-0000-0000-00000000c3d0'::uuid, interval '1 day'),
    ('00000000-0000-0000-0000-00000000c3eb'::uuid, '00000000-0000-0000-0000-00000000c3ab'::uuid, '0911', 'ready',      '00000000-0000-0000-0000-00000000c3d1'::uuid, interval '16 days'),
    ('00000000-0000-0000-0000-00000000c3ec'::uuid, '00000000-0000-0000-0000-00000000c3ac'::uuid, '0912', 'ready',      '00000000-0000-0000-0000-00000000c3d2'::uuid, interval '14 days')
  ) as p(id, job, n, status, card, age);

-- Sent and offered-out rows for the cleanup (no job rows; not in the
-- candidate checks): f1 sent 91 days ago; f2 sent 30 days ago; f3 sent 91
-- days ago with an old dead email of it set going again (failed, to be
-- retried); f4 undelivered 200 days ago; f5, f6 and f8 offered 3 times, the
-- last card expired 15, 13 and 15 days ago (f5's first send went dead, f8's
-- dead send is set going again); f7 offered twice, expired 15 days ago.
insert into public.proposals (id, operation, action_type, input, proposed_by_kind, proposed_by_id, proposed_via,
                              job_id, assigned_role, status, expires_at, idempotency_key, created_at, updated_at)
select c.id, 'packet.send@1', 'comms', '{}', 'agent', 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'agent',
       c.job, 'owner', 'expired', now() - c.age, 'cp-test:' || c.id, now() - c.age - interval '14 days', now() - c.age
  from (values
    ('00000000-0000-0000-0000-00000000c3d6'::uuid, '00000000-0000-0000-0000-00000000c3c5'::uuid, interval '15 days'),
    ('00000000-0000-0000-0000-00000000c3d7'::uuid, '00000000-0000-0000-0000-00000000c3c6'::uuid, interval '13 days'),
    ('00000000-0000-0000-0000-00000000c3d8'::uuid, '00000000-0000-0000-0000-00000000c3c7'::uuid, interval '15 days'),
    ('00000000-0000-0000-0000-00000000c3d9'::uuid, '00000000-0000-0000-0000-00000000c3c8'::uuid, interval '15 days')
  ) as c(id, job, age);

insert into public.carrier_packets (id, job_id, number, version, seq, model_hash, status, proposal_id, offer,
                                    bucket, path, sha256, bytes, pages, mode, outbox_id, sent_at, sent_to, error,
                                    created_at, updated_at)
select p.id, p.job, 'PKT-2098-' || p.n, 1, 1, repeat('9c', 32), p.status, p.card, p.offer,
       'carrier-packets', p.job::text || '/PKT-2098-' || p.n || '-v1-b1.pdf', repeat('9d', 32), 10, 1, 'full',
       p.outbox, case when p.status = 'sent' then now() - p.age end,
       case when p.status = 'sent' then 'adjuster@example.com' end,
       case when p.status = 'undelivered' then 'Gmail 550: mailbox unavailable' end,
       now() - p.age - interval '1 day', now() - p.age
  from (values
    ('00000000-0000-0000-0000-00000000c3f1'::uuid, '00000000-0000-0000-0000-00000000c3c1'::uuid, '0921', 'sent',        null::uuid, 0, '00000000-0000-0000-0000-00000000c3b1'::uuid, interval '91 days'),
    ('00000000-0000-0000-0000-00000000c3f2'::uuid, '00000000-0000-0000-0000-00000000c3c2'::uuid, '0922', 'sent',        null::uuid, 0, '00000000-0000-0000-0000-00000000c3b2'::uuid, interval '30 days'),
    ('00000000-0000-0000-0000-00000000c3f3'::uuid, '00000000-0000-0000-0000-00000000c3c3'::uuid, '0923', 'sent',        null::uuid, 0, '00000000-0000-0000-0000-00000000c3b3'::uuid, interval '91 days'),
    ('00000000-0000-0000-0000-00000000c3f4'::uuid, '00000000-0000-0000-0000-00000000c3c4'::uuid, '0924', 'undelivered', null::uuid, 0, '00000000-0000-0000-0000-00000000c3b4'::uuid, interval '200 days'),
    ('00000000-0000-0000-0000-00000000c3f5'::uuid, '00000000-0000-0000-0000-00000000c3c5'::uuid, '0925', 'ready', '00000000-0000-0000-0000-00000000c3d6'::uuid, 3, null::uuid, interval '15 days'),
    ('00000000-0000-0000-0000-00000000c3f6'::uuid, '00000000-0000-0000-0000-00000000c3c6'::uuid, '0926', 'ready', '00000000-0000-0000-0000-00000000c3d7'::uuid, 3, null::uuid, interval '13 days'),
    ('00000000-0000-0000-0000-00000000c3f7'::uuid, '00000000-0000-0000-0000-00000000c3c7'::uuid, '0927', 'ready', '00000000-0000-0000-0000-00000000c3d8'::uuid, 2, null::uuid, interval '15 days'),
    ('00000000-0000-0000-0000-00000000c3f8'::uuid, '00000000-0000-0000-0000-00000000c3c8'::uuid, '0928', 'ready', '00000000-0000-0000-0000-00000000c3d9'::uuid, 3, null::uuid, interval '15 days')
  ) as p(id, job, n, status, card, offer, outbox, age);

-- the emails: each sent row's own (sent or delivered), the undelivered row's
-- (dead), and the earlier sends of f3, f5 and f8 that name them by payload
insert into public.outbox (id, channel, operation, payload, idempotency_key, status, sent_at, error, job_id, created_at)
select o.id, 'packet', 'packet.send@1', jsonb_build_object('to', 'adjuster@example.com', 'packet_version_id', o.pkt),
       'cp-test:outbox:' || o.id, o.status, case when o.status in ('sent', 'delivered') then now() - o.age end,
       case when o.status in ('dead', 'failed') then 'Gmail upload timed out' end, o.job, now() - o.age
  from (values
    ('00000000-0000-0000-0000-00000000c3b1'::uuid, '00000000-0000-0000-0000-00000000c3f1'::uuid, '00000000-0000-0000-0000-00000000c3c1'::uuid, 'sent',      interval '91 days'),
    ('00000000-0000-0000-0000-00000000c3b2'::uuid, '00000000-0000-0000-0000-00000000c3f2'::uuid, '00000000-0000-0000-0000-00000000c3c2'::uuid, 'sent',      interval '30 days'),
    ('00000000-0000-0000-0000-00000000c3b3'::uuid, '00000000-0000-0000-0000-00000000c3f3'::uuid, '00000000-0000-0000-0000-00000000c3c3'::uuid, 'delivered', interval '91 days'),
    ('00000000-0000-0000-0000-00000000c3e3'::uuid, '00000000-0000-0000-0000-00000000c3f3'::uuid, '00000000-0000-0000-0000-00000000c3c3'::uuid, 'failed',    interval '92 days'),
    ('00000000-0000-0000-0000-00000000c3b4'::uuid, '00000000-0000-0000-0000-00000000c3f4'::uuid, '00000000-0000-0000-0000-00000000c3c4'::uuid, 'dead',      interval '200 days'),
    ('00000000-0000-0000-0000-00000000c3b5'::uuid, '00000000-0000-0000-0000-00000000c3f5'::uuid, '00000000-0000-0000-0000-00000000c3c5'::uuid, 'dead',      interval '60 days'),
    ('00000000-0000-0000-0000-00000000c3b8'::uuid, '00000000-0000-0000-0000-00000000c3f8'::uuid, '00000000-0000-0000-0000-00000000c3c8'::uuid, 'pending',   interval '60 days')
  ) as o(id, pkt, job, status, age);

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  mine constant uuid[] := array['00000000-0000-0000-0000-00000000c3a1', '00000000-0000-0000-0000-00000000c3a2',
                                '00000000-0000-0000-0000-00000000c3a3', '00000000-0000-0000-0000-00000000c3a4',
                                '00000000-0000-0000-0000-00000000c3a5', '00000000-0000-0000-0000-00000000c3a6',
                                '00000000-0000-0000-0000-00000000c3a7', '00000000-0000-0000-0000-00000000c3a8',
                                '00000000-0000-0000-0000-00000000c3a9', '00000000-0000-0000-0000-00000000c3b0']::uuid[];
  got  jsonb;
  want jsonb;
  removable uuid[];
begin
  -- 14 days: the window is 16, so k1 and k3 (certified), not k2 (20 days old)
  select jsonb_agg(jsonb_build_array(right(c.job_id::text, 4), c.has_row, c.open_row) order by c.ord)
    into got
    from public.carrier_packet_candidates(14, 2000) with ordinality as c(job_id, updated_at, has_row, open_row, ord)
   where c.job_id = any (mine);
  -- oldest first: k10 (no job row), k5 (40 days), k6 (30 days), k1 (3 days), k3 (now)
  want := '[["c3b0", true, true], ["c3a5", true, true], ["c3a6", true, false], ["c3a1", false, false], ["c3a3", false, false]]';
  if got is distinct from want then
    raise exception 'candidates (14 days) are %, not %', got, want;
  end if;

  select jsonb_agg(right(c.job_id::text, 4) order by c.ord) into got
    from public.carrier_packet_candidates(30, 2000) with ordinality as c(job_id, updated_at, has_row, open_row, ord)
   where c.job_id = any (mine);
  if got is distinct from '["c3b0", "c3a5", "c3a6", "c3a2", "c3a1", "c3a3"]' then
    raise exception 'candidates (30 days) are %', got;
  end if;

  select jsonb_agg(right(c.job_id::text, 4) order by c.ord) into got
    from public.carrier_packet_candidates(0, 2000) with ordinality as c(job_id, updated_at, has_row, open_row, ord)
   where c.job_id = any (mine);
  if got is distinct from '["c3b0", "c3a5", "c3a6", "c3a3"]' then
    raise exception 'candidates (0 days, a 2-day window) are %', got;
  end if;
  if (select count(*) from public.carrier_packet_candidates(14, 1)) <> 1 then
    raise exception 'candidates ignored its limit';
  end if;

  -- k1 held (the owner was texted it waits on a numbered invoice): it counts
  -- as having a row, so the gate skips the lookback once it qualifies
  perform public.carrier_packet_hold('00000000-0000-0000-0000-00000000c3a1', 'no_invoice', 'Waiting on a numbered invoice');
  select jsonb_agg(jsonb_build_array(right(c.job_id::text, 4), c.has_row, c.open_row) order by c.ord)
    into got
    from public.carrier_packet_candidates(14, 2000) with ordinality as c(job_id, updated_at, has_row, open_row, ord)
   where c.job_id = any (mine);
  want := '[["c3b0", true, true], ["c3a5", true, true], ["c3a6", true, false], ["c3a1", true, false], ["c3a3", false, false]]';
  if got is distinct from want then
    raise exception 'candidates with k1 held are %, not %', got, want;
  end if;

  -- declined 15 days ago: removable; 13 days ago: kept
  removable := array(select x.id from public.carrier_packet_pdfs_to_remove(100) x);
  if not ('00000000-0000-0000-0000-00000000c3eb'::uuid = any (removable))
     or '00000000-0000-0000-0000-00000000c3ec'::uuid = any (removable)
     or '00000000-0000-0000-0000-00000000c3e5'::uuid = any (removable) then
    raise exception 'the declined-card cleanup listed %', removable;
  end if;
  if public.carrier_packet_pdfs_removed(array['00000000-0000-0000-0000-00000000c3eb', '00000000-0000-0000-0000-00000000c3ec',
                                              '00000000-0000-0000-0000-00000000c3e5']::uuid[]) <> 1 then
    raise exception 'the stamp took an open card''s PDF, or not the long-declined one';
  end if;

  -- sent 91 days ago (f1): removable, Gmail's Sent folder has the copy; sent
  -- 30 days ago (f2), with an email of it going out again (f3), or
  -- undelivered (f4): kept. Offered 3 times, the card expired 15 days ago
  -- (f5, a dead email naming it): removable; 13 days ago (f6), below the cap
  -- (f7), or with its dead email set going again (f8): kept
  if not ('00000000-0000-0000-0000-00000000c3f1'::uuid = any (removable))
     or not ('00000000-0000-0000-0000-00000000c3f5'::uuid = any (removable))
     or removable && array['00000000-0000-0000-0000-00000000c3f2', '00000000-0000-0000-0000-00000000c3f3',
                           '00000000-0000-0000-0000-00000000c3f4', '00000000-0000-0000-0000-00000000c3f6',
                           '00000000-0000-0000-0000-00000000c3f7', '00000000-0000-0000-0000-00000000c3f8']::uuid[] then
    raise exception 'the sent and offered-out cleanup listed %', removable;
  end if;
  if public.carrier_packet_pdfs_removed(array['00000000-0000-0000-0000-00000000c3f1', '00000000-0000-0000-0000-00000000c3f2',
                                              '00000000-0000-0000-0000-00000000c3f3', '00000000-0000-0000-0000-00000000c3f4',
                                              '00000000-0000-0000-0000-00000000c3f5', '00000000-0000-0000-0000-00000000c3f6',
                                              '00000000-0000-0000-0000-00000000c3f7', '00000000-0000-0000-0000-00000000c3f8']::uuid[]) <> 2
     or exists (select 1 from public.carrier_packets
                 where id in ('00000000-0000-0000-0000-00000000c3f2', '00000000-0000-0000-0000-00000000c3f3',
                              '00000000-0000-0000-0000-00000000c3f4', '00000000-0000-0000-0000-00000000c3f6',
                              '00000000-0000-0000-0000-00000000c3f7', '00000000-0000-0000-0000-00000000c3f8')
                   and pdf_removed_at is not null) then
    raise exception 'the stamp did not take exactly f1 and f5';
  end if;
  -- the sent row is still the record of the send: only the stamp is new
  if (select row(status, version, sent_at < now() - interval '90 days', sent_to, outbox_id, path, sha256, pdf_removed_at is not null)::text
        from public.carrier_packets where id = '00000000-0000-0000-0000-00000000c3f1')
     is distinct from row('sent', 1, true, 'adjuster@example.com', '00000000-0000-0000-0000-00000000c3b1'::uuid,
                          '00000000-0000-0000-0000-00000000c3c1/PKT-2098-0921-v1-b1.pdf', repeat('9d', 32), true)::text then
    raise exception 'the sent row whose PDF was removed is %',
      (select to_jsonb(x) from public.carrier_packets x where id = '00000000-0000-0000-0000-00000000c3f1');
  end if;
end
$$;
release savepoint s;
reset role;

rollback;


-- 20. what an independent review found, held: nobody files packet.send by
--     hand; revoking the grant, deprecating the operation or disabling
--     agent:documents stops reserving;
--     a send going out (a dead row someone set going again) blocks a build, a
--     re-offer and a second approval, and its send is recorded on the packet
--     even after a re-offer cleared outbox_id, superseding the fresh card;
--     undoing a change while a newer card is open withdraws the card instead
--     of building a "version 2" identical to what the carrier has. Its own
--     transaction, rolled back.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000c461', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cp4-owner@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000c463', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-cp4-lead@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;
insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000c461', 'cp4 test owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c463', 'cp4 test lead',  'crew_lead')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

set local request.jwt.claims = '{"role": "service_role"}';
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object('id', j.id, 'rev', 3, 'updatedAt', '2099-10-01T10:00:00.000Z', 'title', j.title,
                          'customerName', 'Jane Sample', 'address', '123 Example St, Fairbanks, AK 99701',
                          'claimNumber', 'DEMO-12345', 'carrier', 'Sample Mutual',
                          'certDrying', jsonb_build_object('sigTech', 'data:image/png;base64,AAAA')),
       false
  from (values
    ('00000000-0000-0000-0000-00000000c4a0'::uuid, 'Jane Sample - water (h)'),
    ('00000000-0000-0000-0000-00000000c4b0'::uuid, 'Jane Sample - water (i)')
  ) as j(id, title);

insert into public.worker_heartbeats (worker_id, at, meta)
values ('cp4-test-worker', now(), '{"channels": ["sms", "email", "packet"]}');

create temp table cp4 (k text primary key, v text);
grant all on cp4 to anon, authenticated, service_role;
insert into cp4 values ('input', jsonb_build_object(
  'subject', 'Carrier packet - Claim DEMO-12345 - Jane Sample', 'body', 'Attached is the drying packet.',
  'filename', 'Claim DEMO-12345 - Sample.pdf', 'suggested_to', 'adjuster@example.com')::text);

-- 20a. a crew lead, and the owner himself, cannot file a packet.send card
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c463", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  perform public.op_propose('packet.send',
    jsonb_build_object('packet_version_id', gen_random_uuid(), 'offer', 1, 'subject', 's', 'body', 'b', 'filename', 'f.pdf',
                       'suggested_to', 'someone@example.com'),
    '00000000-0000-0000-0000-00000000c4a0', null, 'by hand', '[]', 'ui', null, interval '30 days');
  raise exception 'a crew lead filed a packet.send card';
exception when insufficient_privilege then
  null;
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c461", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  perform public.op_propose('packet.send',
    jsonb_build_object('packet_version_id', gen_random_uuid(), 'offer', 1, 'subject', 's', 'body', 'b', 'filename', 'f.pdf'),
    '00000000-0000-0000-0000-00000000c4a0', null, 'by hand', '[]', 'ui', null, interval '30 days');
  raise exception 'the owner filed a packet.send card by hand';
exception when insufficient_privilege then
  null;
end
$$;
release savepoint s;
reset role;

do $$
begin
  if not public.op_role_permits('owner', 'packet.send', 'comms', 'approve') then
    raise exception 'the deny rows took away the owner''s approval';
  end if;
  if public.op_role_permits('office', 'packet.send', 'comms', 'propose')
     or public.op_role_permits('crew', 'packet.send', 'comms', 'propose')
     or public.op_role_permits('viewer', 'packet.send', 'comms', 'propose') then
    raise exception 'a human role may still propose packet.send';
  end if;
  if not public.op_agent_permits('b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65', 'packet.send', 'comms', 'propose') then
    raise exception 'agent:documents lost its propose';
  end if;
end
$$;

-- 20b. the owner's switches stop the reserve before anything is built
update public.agent_authority set revoked_at = now()
 where agent_id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65' and operation = 'packet.send' and revoked_at is null;
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  h constant uuid := '00000000-0000-0000-0000-00000000c4a0';
  r jsonb;
begin
  r := public.carrier_packet_reserve(h, repeat('d1', 32), '{}', '{}', '{}', 2099);
  if r is distinct from '{"action": "skip", "reason": "not_permitted"}' then
    raise exception 'with the grant revoked, reserve answered %', r;
  end if;
  if exists (select 1 from public.carrier_packets where job_id = h) then
    raise exception 'a revoked grant still reserved a row';
  end if;
end
$$;
release savepoint s;
reset role;
update public.agent_authority set revoked_at = null
 where agent_id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65' and operation = 'packet.send'
   and id = (select id from public.agent_authority
              where agent_id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65' and operation = 'packet.send'
              order by revoked_at desc nulls last limit 1);

update public.operation_catalog set deprecated_at = now() where name = 'packet.send' and version = 1;
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
begin
  if public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c4a0', repeat('d1', 32), '{}', '{}', '{}', 2099)
     is distinct from '{"action": "skip", "reason": "not_permitted"}' then
    raise exception 'with packet.send deprecated, reserve did not skip';
  end if;
end
$$;
release savepoint s;
reset role;
update public.operation_catalog set deprecated_at = null where name = 'packet.send' and version = 1;

-- agent:documents disabled: op_resolve_caller would refuse its card, so
-- nothing is built (and no failed tries are counted); enabled again, h builds
-- (20c)
update public.agents set enabled = false where id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
begin
  if public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c4a0', repeat('d1', 32), '{}', '{}', '{}', 2099)
     is distinct from '{"action": "skip", "reason": "not_permitted"}' then
    raise exception 'with agent:documents disabled, reserve did not skip';
  end if;
  if exists (select 1 from public.carrier_packets where job_id = '00000000-0000-0000-0000-00000000c4a0') then
    raise exception 'a disabled agent:documents still reserved a row';
  end if;
end
$$;
release savepoint s;
reset role;
update public.agents set enabled = true where id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';

-- 20c. h: version 1 is sent; a change is offered as version 2; the change
--      is undone, so the carrier already has this document
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  h   constant uuid := '00000000-0000-0000-0000-00000000c4a0';
  inp constant jsonb := (select v::jsonb from cp4 where k = 'input');
  r   jsonb;
  f   jsonb;
begin
  r := public.carrier_packet_reserve(h, repeat('d1', 32), '{"cert": "1"}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'build' then raise exception 'with the switches back on, h''s reserve answered %', r; end if;
  f := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
         jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('d1', 32), 'bytes', 1000, 'pages', 3, 'mode', 'full'),
         inp, 'h v1', '[]');
  insert into cp4 values ('h_p1', r ->> 'packet_id'), ('h_c1', f ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c461", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp4 where k = 'h_c1'), 'inbox', null, '{"to": "adjuster@example.com"}');
  if p.status is distinct from 'executed' then raise exception 'h''s approval is % (%)', p.status, p.error; end if;
  insert into cp4 values ('h_o1', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;
update public.outbox set status = 'sent', sent_at = now() where id = (select v::uuid from cp4 where k = 'h_o1');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  h    constant uuid := '00000000-0000-0000-0000-00000000c4a0';
  docs constant uuid := 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65';
  inp  constant jsonb := (select v::jsonb from cp4 where k = 'input');
  r    jsonb;
  f    jsonb;
  p2   uuid;
  c2   uuid;
begin
  if (select status from public.carrier_packets where id = (select v::uuid from cp4 where k = 'h_p1')) is distinct from 'sent' then
    raise exception 'h''s version 1 is not sent';
  end if;
  r := public.carrier_packet_reserve(h, repeat('d2', 32), '{"cert": "2"}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int <> 2 then raise exception 'h''s change answered %', r; end if;
  p2 := (r ->> 'packet_id')::uuid;
  f := public.carrier_packet_file(p2, (r ->> 'build_token')::uuid,
         jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('d2', 32), 'bytes', 1000, 'pages', 3, 'mode', 'full'),
         inp, 'h v2', '[]');
  c2 := (f ->> 'proposal_id')::uuid;

  -- undone: the model is version 1's again
  r := public.carrier_packet_reserve(h, repeat('d1', 32), '{"cert": "1"}', '{}', '{}', 2099);
  if r is distinct from '{"action": "skip", "reason": "sent"}' then
    raise exception 'undoing the change answered %', r;
  end if;
  -- a reason code, as the gate's are: the office app words it
  if (select row(status, error)::text from public.carrier_packets where id = p2)
     is distinct from row('superseded', 'withdrawn: already_sent')::text then
    raise exception 'the undone version 2 is %', (select row(status, error)::text from public.carrier_packets where id = p2);
  end if;
  if (select row(status, result)::text from public.proposals where id = c2)
     is distinct from row('superseded', '{"superseded_reason": "withdrawn", "reason": "already_sent"}'::jsonb)::text then
    raise exception 'the undone version 2''s card is %', (select row(status, result)::text from public.proposals where id = c2);
  end if;
  if not exists (select 1 from public.events where kind = 'proposal.superseded' and aggregate_id = c2
                    and principal_kind = 'agent' and principal_id = docs) then
    raise exception 'withdrawing the undone card emitted no event';
  end if;
  if public.carrier_packet_reserve(h, repeat('d1', 32), '{"cert": "1"}', '{}', '{}', 2099) is distinct from '{"action": "skip", "reason": "sent"}'
     or (select count(*) from public.carrier_packets where job_id = h) <> 2 then
    raise exception 'h built again after the undo';
  end if;
end
$$;
release savepoint s;
reset role;

-- 20d. i: version 1 is approved and its send goes dead
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i   constant uuid := '00000000-0000-0000-0000-00000000c4b0';
  inp constant jsonb := (select v::jsonb from cp4 where k = 'input');
  r   jsonb;
  f   jsonb;
begin
  r := public.carrier_packet_reserve(i, repeat('e5', 32), '{}', '{}', '{}', 2099);
  f := public.carrier_packet_file((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid,
         jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('e5', 32), 'bytes', 1000, 'pages', 3, 'mode', 'full'),
         inp, 'i v1', '[]');
  insert into cp4 values ('i_p1', r ->> 'packet_id'), ('i_c1', f ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000c461", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select v::uuid from cp4 where k = 'i_c1'), 'inbox', null, '{"to": "adjuster@example.com"}');
  insert into cp4 values ('i_o1', p.result ->> 'outbox_id');
end
$$;
release savepoint s;
reset role;
update public.outbox set status = 'dead', error = 'Gmail upload timed out' where id = (select v::uuid from cp4 where k = 'i_o1');
-- someone sets the dead row going again (the dead-letter retry)
update public.outbox set status = 'failed', attempts = 0, next_attempt_at = now() where id = (select v::uuid from cp4 where k = 'i_o1');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i   constant uuid := '00000000-0000-0000-0000-00000000c4b0';
  pk  constant uuid := (select v::uuid from cp4 where k = 'i_p1');
  inp constant jsonb := (select v::jsonb from cp4 where k = 'input');
  r   jsonb;
begin
  if (select status from public.carrier_packets where id = pk) is distinct from 'undelivered' then
    raise exception 'i''s dead send did not make it undelivered';
  end if;
  -- while it is going again: no card, no build, nothing the carrier could get twice
  r := public.carrier_packet_reserve(i, repeat('e5', 32), '{}', '{}', '{}', 2099);
  if r is distinct from '{"action": "skip", "reason": "in_flight"}' then
    raise exception 'reserve with the dead row going again answered %', r;
  end if;
  r := public.carrier_packet_reserve(i, repeat('e6', 32), '{}', '{}', '{}', 2099);
  if r is distinct from '{"action": "skip", "reason": "in_flight"}' then
    raise exception 'reserve for a changed job with a send going out answered %', r;
  end if;
  r := public.carrier_packet_reoffer(pk, inp, 'again', '[]');
  if r is distinct from '{"status": "lost", "reason": "in_flight"}' then
    raise exception 'reoffer with the dead row going again answered %', r;
  end if;
end
$$;
release savepoint s;
reset role;

-- it dies again, and the lane offers the same PDF on a fresh card
update public.outbox set status = 'dead', error = 'Gmail upload timed out' where id = (select v::uuid from cp4 where k = 'i_o1');
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  i   constant uuid := '00000000-0000-0000-0000-00000000c4b0';
  pk  constant uuid := (select v::uuid from cp4 where k = 'i_p1');
  inp constant jsonb := (select v::jsonb from cp4 where k = 'input');
  r   jsonb;
begin
  r := public.carrier_packet_reserve(i, repeat('e5', 32), '{}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'reoffer' then raise exception 'the dead send was not re-offered: %', r; end if;
  r := public.carrier_packet_reoffer(pk, inp, 'again', '[]');
  if r ->> 'status' is distinct from 'filed' then raise exception 'the re-offer answered %', r; end if;
  insert into cp4 values ('i_c2', r ->> 'proposal_id');
end
$$;
release savepoint s;
reset role;

-- and someone sets the old row going again after all
update public.outbox set status = 'pending', attempts = 0, next_attempt_at = now() where id = (select v::uuid from cp4 where k = 'i_o1');
do $$
declare
  owner constant uuid := '00000000-0000-0000-0000-00000000c461';
  p     public.proposals;
begin
  select * into p from public.proposals where id = (select v::uuid from cp4 where k = 'i_c2');
  p.edited_params := '{"to": "adjuster@example.com"}';
  begin
    perform public.op_exec_packet_send(p, p.input || p.edited_params, 'human', owner);
    raise exception 'accepted';
  exception when others then
    if sqlerrm is distinct from 'packet.send: an earlier send of this packet is still going out, so nothing was sent' then
      raise exception 'approving the fresh card with the old send going out was answered: %', sqlerrm;
    end if;
  end;
end
$$;

-- the old row goes out: the packet is sent, and the fresh card goes
update public.outbox set status = 'sent', sent_at = now() where id = (select v::uuid from cp4 where k = 'i_o1');
do $$
declare
  pk constant uuid := (select v::uuid from cp4 where k = 'i_p1');
  o1 constant uuid := (select v::uuid from cp4 where k = 'i_o1');
  c2 constant uuid := (select v::uuid from cp4 where k = 'i_c2');
  c  public.carrier_packets;
begin
  select * into c from public.carrier_packets where id = pk;
  if c.status is distinct from 'sent' or c.outbox_id is distinct from o1 or c.sent_to is distinct from 'adjuster@example.com'
     or c.sent_at is null then
    raise exception 'the old row''s send was not recorded: %', to_jsonb(c);
  end if;
  if (select row(status, result)::text from public.proposals where id = c2)
     is distinct from row('superseded', jsonb_build_object('superseded_reason', 'sent', 'outbox_id', o1))::text then
    raise exception 'the fresh card is %', (select row(status, result)::text from public.proposals where id = c2);
  end if;
  if not exists (select 1 from public.events where kind = 'proposal.superseded' and aggregate_id = c2) then
    raise exception 'superseding the fresh card emitted no event';
  end if;
end
$$;
savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
begin
  if public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c4b0', repeat('e5', 32), '{}', '{}', '{}', 2099)
     is distinct from '{"action": "skip", "reason": "sent"}' then
    raise exception 'after the old row went out, reserve did not answer sent';
  end if;
end
$$;
release savepoint s;
reset role;

rollback;


-- 21. the build lane's review: a reserve the worker says may not build (no
--     room, or no builds left this run) still answers skips and re-offers
--     but reserves nothing; a re-offer whose PDF is no longer stored is
--     built afresh; a permanent failure says it stopped short of 3 tries.
--     Its own transaction, rolled back.
begin;

set local request.jwt.claims = '{"role": "service_role"}';
insert into public.field_projects (id, data, deleted)
select j.id,
       jsonb_build_object('id', j.id, 'rev', 3, 'updatedAt', '2099-10-01T10:00:00.000Z',
                          'title', j.title, 'customerName', 'Jane Sample',
                          'claimNumber', 'DEMO-12345', 'certDrying', jsonb_build_object('sigTech', 'data:image/png;base64,AAAA')),
       false
  from (values
    ('00000000-0000-0000-0000-00000000c5a0'::uuid, 'Jane Sample - water (k)'),
    ('00000000-0000-0000-0000-00000000c5b0'::uuid, 'Jane Sample - water (l)')
  ) as j(id, title);
insert into public.worker_heartbeats (worker_id, at, meta)
values ('cp5-test-worker', now(), '{"channels": ["sms", "email", "packet"]}');

savepoint s;
set local role service_role;
set local request.jwt.claims = '{"role": "service_role"}';
do $$
declare
  k   constant uuid := '00000000-0000-0000-0000-00000000c5a0';
  inp constant jsonb := jsonb_build_object(
    'subject', 'Carrier packet - Claim DEMO-12345 - Jane Sample', 'body', 'Attached is the drying packet.',
    'filename', 'Claim DEMO-12345 - Sample.pdf', 'suggested_to', 'adjuster@example.com');
  n   bigint := (select count(*) from public.document_sequences);
  r   jsonb;
  f   jsonb;
  p1  uuid;
begin
  -- 21a. no room: nothing is reserved, no number is taken
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099, false);
  if r is distinct from '{"action": "skip", "reason": "no_build"}' then
    raise exception 'a reserve that may not build answered %', r;
  end if;
  if exists (select 1 from public.carrier_packets where job_id = k) then
    raise exception 'a reserve that may not build left a row';
  end if;
  if (select count(*) from public.document_sequences) <> n
     or exists (select 1 from public.document_sequences where kind = 'PKT' and year = 2099) then
    raise exception 'a reserve that may not build took a number';
  end if;

  -- 21b. version 1 filed; its card expires unanswered
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'build' then raise exception 'k''s first reserve answered %', r; end if;
  p1 := (r ->> 'packet_id')::uuid;
  f := public.carrier_packet_file(p1, (r ->> 'build_token')::uuid,
         jsonb_build_object('bucket', 'carrier-packets', 'path', r ->> 'path', 'sha256', repeat('f1', 32), 'bytes', 1000, 'pages', 3, 'mode', 'full'),
         inp, 'k v1', '[]');
  if f ->> 'status' is distinct from 'filed' then raise exception 'k''s filing answered %', f; end if;
  update public.proposals set expires_at = now() - interval '1 minute' where id = (f ->> 'proposal_id')::uuid;

  -- a re-offer needs no room, so it is answered while the worker may not build
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099, false);
  if r ->> 'action' is distinct from 'reoffer' or (r ->> 'packet_id')::uuid is distinct from p1 then
    raise exception 'an expired card with no room answered %', r;
  end if;

  -- 21c. l: a permanent failure other than size is failed_cap, short of 3 tries
  r := public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c5b0', repeat('f2', 32), '{}', '{}', '{}', 2099);
  perform public.carrier_packet_fail((r ->> 'packet_id')::uuid, (r ->> 'build_token')::uuid, 'render: bad data', true);
  r := public.carrier_packet_reserve('00000000-0000-0000-0000-00000000c5b0', repeat('f2', 32), '{}', '{}', '{}', 2099);
  if r is distinct from '{"action": "skip", "reason": "failed_cap", "error": "render: bad data", "permanent": true}' then
    raise exception 'reserve after a permanent failure answered %', r;
  end if;
end
$$;
release savepoint s;
reset role;

-- its PDF stamped removed: built afresh (the new row is still version 1),
-- then undone
do $$
declare
  k  constant uuid := '00000000-0000-0000-0000-00000000c5a0';
  p1 constant uuid := (select id from public.carrier_packets where job_id = '00000000-0000-0000-0000-00000000c5a0' and seq = 1);
  r  jsonb;
begin
  begin
    update public.carrier_packets set pdf_removed_at = now() where id = p1;
    r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099);
    if r ->> 'action' is distinct from 'build' or (r ->> 'version')::int is distinct from 1 or (r ->> 'seq')::int is distinct from 2 then
      raise exception 'a re-offer whose PDF was removed answered %', r;
    end if;
    raise exception 'cp5-undo';
  exception when raise_exception then
    if sqlerrm <> 'cp5-undo' then raise; end if;
  end;
  if (select pdf_removed_at from public.carrier_packets where id = p1) is not null
     or exists (select 1 from public.carrier_packets where job_id = k and seq = 2) then
    raise exception 'the undo did not undo';
  end if;

end
$$;

-- with Storage: the stored PDF is offered again; once it is gone from its
-- bucket (removed by hand), it is built afresh. Asserted against stand-in
-- storage tables, so only where Storage is not installed (db-replay); a
-- local stack's real bucket is left alone.
do $$
declare
  k  constant uuid := '00000000-0000-0000-0000-00000000c5a0';
  p1 constant uuid := (select id from public.carrier_packets where job_id = '00000000-0000-0000-0000-00000000c5a0' and seq = 1);
  r  jsonb;
begin
  if to_regclass('storage.objects') is not null then
    raise notice 'Storage is installed here; the stored-PDF check is asserted in db-replay only';
    return;
  end if;
  create schema storage;
  create table storage.buckets (id text primary key);
  create table storage.objects (bucket_id text, name text, metadata jsonb);
  insert into storage.objects (bucket_id, name)
  select 'carrier-packets', path from public.carrier_packets where job_id = k;

  -- no bucket: Storage cannot say, so the row's own fields decide
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'reoffer' then raise exception 'with no bucket, reserve answered %', r; end if;

  insert into storage.buckets values ('carrier-packets');
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'reoffer' or (r ->> 'packet_id')::uuid is distinct from p1 then
    raise exception 'a stored PDF was not offered again: %', r;
  end if;

  delete from storage.objects where bucket_id = 'carrier-packets';
  r := public.carrier_packet_reserve(k, repeat('f1', 32), '{}', '{}', '{}', 2099);
  if r ->> 'action' is distinct from 'build' or (r ->> 'seq')::int is distinct from 2 then
    raise exception 'a PDF gone from the bucket was offered again: %', r;
  end if;
end
$$;

rollback;
