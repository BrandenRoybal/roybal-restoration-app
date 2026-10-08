-- ============================================================================
-- Assertions for 0019_spine_first_lanes.sql (spine step 5: the brief's
-- overdue-invoice reminder and the adjuster email become proposals, with one
-- "YES n" number space across both approval queues).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/spine_lanes.test.sql <staging url>
-- Everything it writes is rolled back (sequence values it draws are not; that
-- is what every proposal does anyway).
--
-- The rules it holds 0019 to:
--   1. The four functions are SECURITY DEFINER, owned by postgres, with a
--      pinned search_path; current_agent_id, sms_codes_in_use and
--      outbox_channel_ready are callable by authenticated and service_role,
--      never anon; the trigger function by nobody. The trigger is BEFORE
--      INSERT FOR EACH ROW on proposals; the policy is a SELECT for
--      authenticated on proposals.
--   2. agent:brief may PROPOSE email.send, spelled the way op_agent_permits
--      matches it, and nothing else: not sms.send, not execute, never approve.
--      The lane's second grant, 0021's (agent:billing may PROPOSE
--      invoice.review_gaps), is held to the same shape beside it (2b); the
--      rest of 0021 is billing_review_gaps.test.sql. So is the third, 0023's
--      (agent:integrations may PROPOSE receipts.qbo_link, 2c); the rest of
--      0023 is receipts_qbo_link.test.sql.
--   3. current_agent_id is the agents row a machine login acts as, and null
--      for a human, a disabled agent, a human login wrongly linked to an
--      agents row, and a caller with no identity.
--   4. An agent login reads the proposals it filed and no one else's; nobody
--      else reads more than before; the brief's 7-day dedupe read finds its
--      reminder by invoice key; it still reads no events, and no outbox row
--      but those of its own proposals (none before 0020; 0020 and
--      agent_outbox_read.test.sql give it those).
--   5. sms_codes_in_use is every pending text-lane code plus every code of
--      a proposal that is live or was answered in the last 48 hours (by
--      updated_at, exactly 48 hours included), in the caller's org only,
--      distinct and ascending, '{}' when none. A proposal the owner just
--      approved keeps its code there.
--   6. A new proposal never lands on a code a pending text-lane ask holds, or
--      one a text ask filed in the last 48 hours holds whatever became of it
--      (exactly 48 hours included), including when moving it off lands on a
--      live proposal's code (the unique index and op_propose's retry finish
--      the job), and its proposal.created event names the code it ended up
--      with.
--   7. outbox_channel_ready is true only for a heartbeat under 10 minutes old
--      that lists the channel in meta.channels as a string element.
--   8. The owner's step-5 test at the SQL level: the brief files a reminder,
--      the owner approves it twice from the inbox and once by text, and one
--      outbox row is all that ever exists.
-- The code-space and heartbeat blocks start from an empty space inside the
-- transaction, so the file passes on a database that already holds real asks
-- and a live worker (staging).
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. functions, grants, the trigger and the policy
do $$
declare
  f text;
  problems text[] := '{}';
  readers text[] := array['public.current_agent_id()', 'public.sms_codes_in_use()',
                          'public.outbox_channel_ready(text)'];
  trig constant text := 'public.proposals_sms_code_skip_text()';
begin
  foreach f in array readers || trig loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then
      problems := problems || format('%s is not SECURITY DEFINER', f);
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
  end loop;

  foreach f in array readers loop
    if not has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('authenticated cannot execute %s', f);
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      problems := problems || format('service_role cannot execute %s', f);
    end if;
    if (select provolatile from pg_proc where oid = f::regprocedure) <> 's' then
      problems := problems || format('%s is not STABLE', f);
    end if;
  end loop;

  if has_function_privilege('authenticated', trig, 'EXECUTE')
     or has_function_privilege('service_role', trig, 'EXECUTE') then
    problems := problems || format('%s is executable by authenticated or service_role', trig);
  end if;

  -- BEFORE (2) | INSERT (4) | FOR EACH ROW (1), enabled, calling the function above
  if not exists (select 1 from pg_trigger
                  where tgname = 'proposals_sms_code_skip_text'
                    and tgrelid = 'public.proposals'::regclass
                    and tgfoid = trig::regprocedure
                    and tgtype = 7 and tgenabled = 'O' and not tgisinternal) then
    problems := problems || 'proposals_sms_code_skip_text is not an enabled BEFORE INSERT FOR EACH ROW trigger on proposals'::text;
  end if;

  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'proposals'
                    and policyname = 'proposals_read_own_agent' and cmd = 'SELECT'
                    and permissive = 'PERMISSIVE' and roles = array['authenticated']::name[]) then
    problems := problems || 'proposals_read_own_agent is not a permissive SELECT policy for authenticated on proposals'::text;
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'spine lanes objects are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;

-- 2. agent:brief's grant, as op_agent_permits reads it
do $$
declare
  brief constant uuid := '1af33481-7f1c-4485-87f5-7b0ec5e27554';
  web   constant uuid := '951f7f7d-eb77-4cda-9d98-1db89cf30541';
begin
  if (select count(*) from public.agent_authority
       where agent_id = brief and operation = 'email.send' and capability = 'propose'
         and revoked_at is null) <> 1 then
    raise exception 'agent:brief does not hold exactly one live email.send propose grant';
  end if;
  if exists (select 1 from public.agent_authority where operation like '%@%') then
    raise exception 'an agent_authority row names a versioned operation; op_agent_permits matches only the bare name';
  end if;
  if not exists (select 1 from public.agent_authority g
                   join public.events e on e.aggregate_type = 'agent_authority' and e.aggregate_id = g.id
                  where g.agent_id = brief and g.operation = 'email.send'
                    and e.kind = 'agent_authority.granted' and e.principal_kind = 'system'
                    and e.idempotency_key = 'agent_authority.granted:' || g.id
                    and e.data ->> 'operation' = 'email.send' and e.data ->> 'capability' = 'propose') then
    raise exception 'the agent:brief grant has no agent_authority.granted event naming it';
  end if;
  if (select reason from public.agent_authority
       where agent_id = brief and operation = 'email.send' and revoked_at is null) !~ 'step 5.*2026-10-06' then
    raise exception 'the agent:brief grant does not say it is spine step 5 on the owner''s go of 2026-10-06';
  end if;

  if not public.op_agent_permits(brief, 'email.send', 'comms', 'propose') then
    raise exception 'agent:brief may not propose email.send';
  end if;
  if public.op_agent_permits(brief, 'sms.send', 'comms', 'propose') then
    raise exception 'agent:brief may propose sms.send; 0019 grants email.send only';
  end if;
  if public.op_agent_permits(brief, 'email.send', 'comms', 'execute') then
    raise exception 'agent:brief may execute email.send; 0019 grants propose only';
  end if;
  if public.op_agent_permits(brief, 'email.send', 'comms', 'approve') then
    raise exception 'agent:brief may approve';
  end if;
  if public.op_agent_permits(brief, 'job.set_stage', 'job', 'propose') then
    raise exception 'agent:brief may propose a job move';
  end if;
  if public.op_agent_permits(web, 'email.send', 'comms', 'propose') then
    raise exception 'agent:web may propose email.send with no grant of its own';
  end if;
end
$$;

-- 2b. agent:billing's grant (0021), the same way
do $$
declare
  billing constant uuid := '193d7dd0-74f9-407d-9891-8cb7aab22f82';
  brief   constant uuid := '1af33481-7f1c-4485-87f5-7b0ec5e27554';
begin
  if (select count(*) from public.agent_authority
       where agent_id = billing and operation = 'invoice.review_gaps' and capability = 'propose'
         and revoked_at is null) <> 1 then
    raise exception 'agent:billing does not hold exactly one live invoice.review_gaps propose grant';
  end if;
  if (select count(*) from public.agent_authority where agent_id = billing and revoked_at is null) <> 1 then
    raise exception 'agent:billing holds a live grant beside invoice.review_gaps propose';
  end if;
  if not exists (select 1 from public.agent_authority g
                   join public.events e on e.aggregate_type = 'agent_authority' and e.aggregate_id = g.id
                  where g.agent_id = billing and g.operation = 'invoice.review_gaps'
                    and e.kind = 'agent_authority.granted' and e.principal_kind = 'system'
                    and e.idempotency_key = 'agent_authority.granted:' || g.id
                    and e.data ->> 'operation' = 'invoice.review_gaps' and e.data ->> 'capability' = 'propose'
                    and e.data ->> 'agent' = 'agent:billing') then
    raise exception 'the agent:billing grant has no agent_authority.granted event naming it';
  end if;
  if (select reason from public.agent_authority
       where agent_id = billing and operation = 'invoice.review_gaps' and revoked_at is null) !~ '0021.*2026-10-07' then
    raise exception 'the agent:billing grant does not say it is 0021 on the owner''s go of 2026-10-07';
  end if;

  if not public.op_agent_permits(billing, 'invoice.review_gaps', 'money', 'propose') then
    raise exception 'agent:billing may not propose invoice.review_gaps';
  end if;
  if public.op_agent_permits(billing, 'invoice.review_gaps', 'money', 'execute') then
    raise exception 'agent:billing may execute invoice.review_gaps; 0021 grants propose only';
  end if;
  if public.op_agent_permits(billing, 'invoice.review_gaps', 'money', 'approve') then
    raise exception 'agent:billing may approve';
  end if;
  if public.op_agent_permits(billing, 'invoice.add_line', 'money', 'propose') then
    raise exception 'agent:billing may propose another money operation';
  end if;
  if public.op_agent_permits(billing, 'email.send', 'comms', 'propose') then
    raise exception 'agent:billing may propose email.send';
  end if;
  if public.op_agent_permits(brief, 'invoice.review_gaps', 'money', 'propose') then
    raise exception 'agent:brief may propose invoice.review_gaps with no grant of its own';
  end if;
end
$$;

-- 2c. agent:integrations' grant (0023), the same way
do $$
declare
  integ   constant uuid := '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10';
  billing constant uuid := '193d7dd0-74f9-407d-9891-8cb7aab22f82';
begin
  if (select count(*) from public.agent_authority
       where agent_id = integ and operation = 'receipts.qbo_link' and capability = 'propose'
         and revoked_at is null) <> 1 then
    raise exception 'agent:integrations does not hold exactly one live receipts.qbo_link propose grant';
  end if;
  if (select count(*) from public.agent_authority where agent_id = integ and revoked_at is null) <> 1 then
    raise exception 'agent:integrations holds a live grant beside receipts.qbo_link propose';
  end if;
  if not exists (select 1 from public.agent_authority g
                   join public.events e on e.aggregate_type = 'agent_authority' and e.aggregate_id = g.id
                  where g.agent_id = integ and g.operation = 'receipts.qbo_link'
                    and e.kind = 'agent_authority.granted' and e.principal_kind = 'system'
                    and e.idempotency_key = 'agent_authority.granted:' || g.id
                    and e.data ->> 'operation' = 'receipts.qbo_link' and e.data ->> 'capability' = 'propose'
                    and e.data ->> 'agent' = 'agent:integrations') then
    raise exception 'the agent:integrations grant has no agent_authority.granted event naming it';
  end if;
  if (select reason from public.agent_authority
       where agent_id = integ and operation = 'receipts.qbo_link' and revoked_at is null) !~ '0023.*2026-10-07' then
    raise exception 'the agent:integrations grant does not say it is 0023 on the owner''s go of 2026-10-07';
  end if;

  if not public.op_agent_permits(integ, 'receipts.qbo_link', 'money', 'propose') then
    raise exception 'agent:integrations may not propose receipts.qbo_link';
  end if;
  if public.op_agent_permits(integ, 'receipts.qbo_link', 'money', 'execute') then
    raise exception 'agent:integrations may execute receipts.qbo_link; 0023 grants propose only';
  end if;
  if public.op_agent_permits(integ, 'receipts.qbo_link', 'money', 'approve') then
    raise exception 'agent:integrations may approve';
  end if;
  if public.op_agent_permits(integ, 'invoice.review_gaps', 'money', 'propose') then
    raise exception 'agent:integrations may propose invoice.review_gaps';
  end if;
  if public.op_agent_permits(integ, 'email.send', 'comms', 'propose') then
    raise exception 'agent:integrations may propose email.send';
  end if;
  if public.op_agent_permits(billing, 'receipts.qbo_link', 'money', 'propose') then
    raise exception 'agent:billing may propose receipts.qbo_link with no grant of its own';
  end if;
end
$$;


-- 3–8. behaviour, as each caller. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000d190', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-sl-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d191', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-sl-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d192', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-sl-brief@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d193', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-sl-web@example.invalid',    '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d194', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-sl-office@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000d190', 'sl test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000d191', 'sl test crew',   'crew'),
  ('00000000-0000-0000-0000-00000000d192', 'sl test brief',  'agent'),
  ('00000000-0000-0000-0000-00000000d193', 'sl test web',    'agent'),
  ('00000000-0000-0000-0000-00000000d194', 'sl test office', 'office')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- the brief's login is agent:brief, the second machine login is agent:web,
-- and a human (office) login is linked to agent:projection by mistake
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d192'
 where id = '1af33481-7f1c-4485-87f5-7b0ec5e27554';
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d193'
 where id = '951f7f7d-eb77-4cda-9d98-1db89cf30541';
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d194'
 where id = 'a40bbef2-cf95-4b7f-85bf-4712534e8217';

create temp table spine_lanes_state (k text primary key, v text);
grant all on spine_lanes_state to anon, authenticated, service_role;

-- 3. current_agent_id, as each caller
savepoint s;
do $$
declare
  got uuid;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
  got := public.current_agent_id();
  if got is distinct from '1af33481-7f1c-4485-87f5-7b0ec5e27554' then
    raise exception 'the brief login resolves to agent %, not agent:brief', got;
  end if;

  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d193", "role": "authenticated", "aud": "authenticated"}';
  if public.current_agent_id() is distinct from '951f7f7d-eb77-4cda-9d98-1db89cf30541' then
    raise exception 'the second machine login does not resolve to agent:web';
  end if;

  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  if public.current_agent_id() is not null then
    raise exception 'the owner resolves to an agent';
  end if;

  -- linked, but the login is a person (office): op_resolve_caller would treat
  -- it as human, so it is no agent here either
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d194", "role": "authenticated", "aud": "authenticated"}';
  if public.current_agent_id() is not null then
    raise exception 'a human login linked to an agents row resolves to that agent';
  end if;

  set local role service_role;
  set local request.jwt.claims = '{"role": "service_role"}';
  if public.current_agent_id() is not null then
    raise exception 'the service role resolves to an agent';
  end if;
  reset role;

  -- a disabled agent is nobody
  update public.agents set enabled = false where id = '951f7f7d-eb77-4cda-9d98-1db89cf30541';
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d193", "role": "authenticated", "aud": "authenticated"}';
  if public.current_agent_id() is not null then
    raise exception 'a disabled agent still resolves';
  end if;
  reset role;
end
$$;
rollback to savepoint s;

savepoint s;
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
do $$
begin
  begin
    perform public.current_agent_id();
    raise exception 'anon called current_agent_id';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.sms_codes_in_use();
    raise exception 'anon called sms_codes_in_use';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.outbox_channel_ready('email');
    raise exception 'anon called outbox_channel_ready';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback to savepoint s;


-- 4 and 8. The reminder lane end to end. Start from an empty code space so
--    the codes below are this file's own.
update public.pending_actions set status = 'expired' where status = 'pending';
update public.proposals set status = 'expired' where status = 'proposed';

-- 4a. the brief files a reminder under its 0019 grant, exactly as roybal-brief
--     does (p_proposed_via cron, 24 hours, the invoice key in evidence_refs)
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_propose(
         'email.send',
         jsonb_build_object('to', 'billing@example.invalid',
                            'subject', 'Payment reminder — invoice SL-TEST-1 (Spine Lanes Test)',
                            'body', 'Hello, a reminder that invoice SL-TEST-1 is past due. Thank you,'),
         '00000000-0000-0000-0000-00000000d1a1', null,
         'email the SL-TEST-1 reminder to Spine Lanes Test (12 days past due, $1,234.00 open)',
         '[{"kind": "invoice", "id": "00000000-0000-0000-0000-00000000d1a1:SL-TEST-1", "label": "Invoice SL-TEST-1 · $1,234.00 open · due 2026-09-24"}]'::jsonb,
         'cron', null, interval '24 hours');
  if p.status <> 'proposed' or p.proposed_by_kind <> 'agent'
     or p.proposed_by_id <> '1af33481-7f1c-4485-87f5-7b0ec5e27554' then
    raise exception 'the brief''s reminder is %, by %/%', p.status, p.proposed_by_kind, p.proposed_by_id;
  end if;
  if p.operation <> 'email.send@1' or p.job_id <> '00000000-0000-0000-0000-00000000d1a1'
     or p.sms_code is null or p.expires_at <= now() then
    raise exception 'the brief''s reminder landed wrong: % job % code % expires %', p.operation, p.job_id, p.sms_code, p.expires_at;
  end if;
  insert into spine_lanes_state values ('reminder', p.id::text);

  -- and nothing else
  begin
    perform public.op_propose('sms.send', '{"to": "+19075550100", "body": "x"}'::jsonb,
                              null, null, null, '[]'::jsonb, 'cron');
    raise exception 'the brief proposed a text';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 4b. one email from the owner, and one agent:web row (written directly: it
--     holds no grant), so there is something the brief must NOT see
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_propose('email.send',
         '{"to": "adjuster@example.invalid", "subject": "SL claim documentation", "body": "Links below."}'::jsonb,
         '00000000-0000-0000-0000-00000000d1a1', null, 'Claim documentation email to the adjuster',
         '[]'::jsonb, 'ui', null, interval '72 hours');
  insert into spine_lanes_state values ('owner_email', p.id::text);
end
$$;
release savepoint s;
reset role;

insert into public.proposals
  (operation, action_type, input, proposed_by_kind, proposed_by_id, proposed_via,
   evidence_refs, idempotency_key, assigned_role, sms_code)
values
  ('email.send@1', 'comms', '{"to": "web@example.invalid", "subject": "s", "body": "b"}'::jsonb,
   'agent', '951f7f7d-eb77-4cda-9d98-1db89cf30541', 'agent',
   '[{"kind": "invoice", "id": "00000000-0000-0000-0000-00000000d1a1:SL-TEST-1"}]'::jsonb,
   'test:spine_lanes:web', 'owner', null);

-- 4c. what each caller reads
savepoint s;
do $$
declare
  rid uuid := (select v::uuid from spine_lanes_state where k = 'reminder');
  owner_pid uuid := (select v::uuid from spine_lanes_state where k = 'owner_email');
  n int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
  -- everything it can see is its own (a live brief may have filed real ones),
  -- and its reminder is among it
  select count(*) into n from public.proposals
   where not (proposed_by_kind = 'agent' and proposed_by_id = '1af33481-7f1c-4485-87f5-7b0ec5e27554');
  if n <> 0 then raise exception 'the brief reads % proposal(s) it did not file', n; end if;
  if not exists (select 1 from public.proposals where id = rid) then
    raise exception 'the brief cannot read back the reminder it filed';
  end if;
  -- the brief's dedupe read (operation=eq.email.send@1&created_at=gte.<week ago>)
  select count(*) into n from public.proposals
   where operation = 'email.send@1' and created_at >= now() - interval '7 days'
     and status in ('proposed', 'approved', 'executing', 'executed')
     and evidence_refs @> '[{"kind": "invoice", "id": "00000000-0000-0000-0000-00000000d1a1:SL-TEST-1"}]'::jsonb;
  if n <> 1 then raise exception 'the brief''s dedupe read finds % reminder(s) for its invoice, not 1', n; end if;
  if (select count(*) from public.events) <> 0 then
    raise exception 'an agent login reads the events ledger';
  end if;
  -- the proposals read here is the brief's own RLS view, so this counts every
  -- outbox row it reads that is not of a proposal it filed (a live brief's
  -- approved reminders are, once 0020 is in)
  select count(*) into n from public.outbox o
   where not exists (select 1 from public.proposals p
                      where p.id = o.proposal_id and p.proposed_by_kind = 'agent'
                        and p.proposed_by_id = '1af33481-7f1c-4485-87f5-7b0ec5e27554');
  if n <> 0 then raise exception 'an agent login reads % outbox row(s) of proposals it did not file', n; end if;

  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d193", "role": "authenticated", "aud": "authenticated"}';
  select count(*) into n from public.proposals
   where not (proposed_by_kind = 'agent' and proposed_by_id = '951f7f7d-eb77-4cda-9d98-1db89cf30541');
  if n <> 0 then raise exception 'agent:web reads % proposal(s) it did not file', n; end if;
  if not exists (select 1 from public.proposals where idempotency_key = 'test:spine_lanes:web') then
    raise exception 'agent:web cannot read its own proposal';
  end if;

  -- a crew member gains nothing: both agent rows wait on the owner
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d191", "role": "authenticated", "aud": "authenticated"}';
  select count(*) into n from public.proposals where id = rid or idempotency_key = 'test:spine_lanes:web';
  if n <> 0 then raise exception 'a crew member reads % agent proposal(s) routed to the owner', n; end if;

  -- the office login wrongly linked to agent:projection is still office:
  -- it reads no agent rows through the new policy
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d194", "role": "authenticated", "aud": "authenticated"}';
  select count(*) into n from public.proposals
   where proposed_by_id = 'a40bbef2-cf95-4b7f-85bf-4712534e8217';
  if n <> 0 then raise exception 'a human login linked to an agents row reads that agent''s proposals'; end if;

  -- the owner still reads everything
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  select count(*) into n from public.proposals
   where id in (rid, owner_pid) or idempotency_key = 'test:spine_lanes:web';
  if n <> 3 then raise exception 'the owner reads % of the 3 test proposals', n; end if;
  reset role;
end
$$;
rollback to savepoint s;

-- 8. approve it twice from the inbox and once by text: one outbox row, ever
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  rid uuid := (select v::uuid from spine_lanes_state where k = 'reminder');
  p public.proposals;
  n_events int;
begin
  p := public.op_proposal_approve(rid, 'inbox');
  if p.status <> 'executed' or p.approved_via <> 'inbox' then
    raise exception 'the inbox approval is % via % (%)', p.status, p.approved_via, p.error;
  end if;
  if (select count(*) from public.outbox where proposal_id = rid) <> 1 then
    raise exception 'the first approval wrote % outbox rows', (select count(*) from public.outbox where proposal_id = rid);
  end if;
  if (select array_agg(kind order by id) from public.events where proposal_id = rid)
     <> array['proposal.created', 'proposal.approved', 'email.queued', 'proposal.executed'] then
    raise exception 'the reminder''s event trail is %', (select array_agg(kind order by id) from public.events where proposal_id = rid);
  end if;
  select count(*) into n_events from public.events where proposal_id = rid;
  insert into spine_lanes_state values ('events_after_approve', n_events::text);

  p := public.op_proposal_approve(rid, 'inbox');
  if p.status <> 'executed' or (select count(*) from public.events where proposal_id = rid) <> n_events then
    raise exception 'the second inbox approval changed something';
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
  rid uuid := (select v::uuid from spine_lanes_state where k = 'reminder');
  n_events int := (select v::int from spine_lanes_state where k = 'events_after_approve');
  p public.proposals;
  o public.outbox;
begin
  -- "YES n" as roybal-notify sends it: the owner's principal, via sms
  p := public.op_proposal_approve(rid, 'sms', 'sms', null, '00000000-0000-0000-0000-00000000d190');
  if p.status <> 'executed' or p.approved_via <> 'inbox' then
    raise exception 'the text approval after the inbox one is % via %; the first door must stand', p.status, p.approved_via;
  end if;
  if (select count(*) from public.events where proposal_id = rid) <> n_events then
    raise exception 'the text approval after the inbox one wrote events';
  end if;
  if (select count(*) from public.outbox where proposal_id = rid) <> 1 then
    raise exception 'three approvals wrote % outbox rows', (select count(*) from public.outbox where proposal_id = rid);
  end if;
  select * into o from public.outbox where proposal_id = rid;
  if o.channel <> 'email' or o.status <> 'pending' or o.job_id <> '00000000-0000-0000-0000-00000000d1a1'
     or o.payload ->> 'to' <> 'billing@example.invalid' or o.principal_id <> '00000000-0000-0000-0000-00000000d190' then
    raise exception 'the reminder''s outbox row is wrong: %', row_to_json(o);
  end if;
end
$$;
release savepoint s;
reset role;

-- and the brief's dedupe read now sees it decided, still blocking a re-file
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if not exists (select 1 from public.proposals
                  where operation = 'email.send@1' and status = 'executed'
                    and evidence_refs @> '[{"kind": "invoice", "id": "00000000-0000-0000-0000-00000000d1a1:SL-TEST-1"}]'::jsonb) then
    raise exception 'the brief cannot see its approved reminder';
  end if;
end
$$;
rollback to savepoint s;


-- 5. sms_codes_in_use, from an empty code space (4 left only decided rows and
--    the two live ones above; clear those too). An answered proposal holds
--    its code for 48 hours, and so does any text ask filed in that window
--    against new proposals, so the real and earlier rows give theirs up and
--    leave the window.
update public.pending_actions set status = 'expired' where status = 'pending';
update public.proposals set status = 'expired' where status = 'proposed';
update public.proposals set sms_code = null where sms_code is not null;
update public.pending_actions set created_at = now() - interval '49 hours'
 where created_at >= now() - interval '48 hours';

savepoint s;
do $$
declare
  got integer[];
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
  got := public.sms_codes_in_use();
  if got is distinct from '{}'::integer[] then
    raise exception 'an empty code space reads %, not {}', got;
  end if;
  reset role;

  -- proposals first (the trigger would move one that met a pending ask): live,
  -- stale, and answered ones either side of the 48-hour line. updated_at is
  -- given here because an update would stamp it now().
  insert into public.proposals
    (operation, action_type, proposed_by_kind, proposed_via, idempotency_key, status, sms_code, expires_at,
     approved_by_kind, approved_via, approved_at, created_at, updated_at, org_id)
  values
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:live',     'proposed', 15, now() + interval '1 hour',
     null, null, null, now(), now(), default),
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:declined', 'declined', 16, now() + interval '1 hour',
     null, null, null, now() - interval '1 hour', now(), default),
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:stale',    'proposed', 17, now() - interval '1 hour',
     null, null, null, now() - interval '25 hours', now() - interval '25 hours', default),
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:nocode',   'proposed', null, now() + interval '1 hour',
     null, null, null, now(), now(), default),
    -- approved and sent 47 hours ago: a late YES is still answered from it
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:sent47h',  'executed', 18, now() - interval '23 hours',
     'human', 'inbox', now() - interval '47 hours', now() - interval '47 hours', now() - interval '47 hours', default),
    -- declined exactly 48 hours ago: still inside notify's window (gte)
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:edge48h',  'declined', 19, now() - interval '24 hours',
     null, null, null, now() - interval '49 hours', now() - interval '48 hours', default),
    -- expired a second past 48 hours: free again
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:past48h',  'expired',  20, now() - interval '24 hours',
     null, null, null, now() - interval '3 days', now() - interval '48 hours 1 second', default),
    -- approved three days ago: free again
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:old',      'executed', 21, now() - interval '2 days',
     'human', 'inbox', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days', default),
    -- approved 50 hours ago, its run finished 47 hours ago: notify reads
    -- updated_at, so the code is still held
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:ranlate',  'executed', 22, now() - interval '26 hours',
     'human', 'inbox', now() - interval '50 hours', now() - interval '50 hours', now() - interval '47 hours', default),
    -- just declined in another org: not this caller's number space
    ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:codes:otherorg', 'declined', 23, now() + interval '1 hour',
     null, null, null, now(), now(), '00000000-0000-0000-0000-00000000d1ff');
  if (select sms_code from public.proposals where idempotency_key = 'test:spine_lanes:codes:nocode') is not null then
    raise exception 'the trigger gave a code to a proposal that had none';
  end if;

  -- then text-lane asks: pending, pending past its expiry, decided, and one
  -- pending on a live proposal's code (an allocator that ran before 0019)
  insert into public.pending_actions (code, kind, label, status, expires_at) values
    (11, 'sendText',  'sl pending',         'pending',  now() + interval '1 hour'),
    (12, 'boardEdit', 'sl pending expired', 'pending',  now() - interval '1 day'),
    (13, 'emailSend', 'sl executed',        'executed', now() + interval '1 hour'),
    (14, 'emailSend', 'sl declined',        'declined', now() + interval '1 hour'),
    (15, 'sendText',  'sl pending dup',     'pending',  now() + interval '1 hour');

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
  got := public.sms_codes_in_use();
  if got is distinct from '{11,12,15,16,17,18,19,22}'::integer[] then
    raise exception 'sms_codes_in_use as the brief reads %, expected {11,12,15,16,17,18,19,22}', got;
  end if;

  set local role service_role;
  set local request.jwt.claims = '{"role": "service_role"}';
  if public.sms_codes_in_use() is distinct from '{11,12,15,16,17,18,19,22}'::integer[] then
    raise exception 'sms_codes_in_use as the service role reads %', public.sms_codes_in_use();
  end if;
  reset role;
end
$$;
rollback to savepoint s;

-- 5b. the review's case: the owner approves a reminder in the inbox, and its
--     number stays out of the text-lane allocators while a late "YES n" for
--     it is still answered from the spine
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p    public.proposals;
  code integer;
begin
  p := public.op_propose('email.send',
         '{"to": "billing@example.invalid", "subject": "SL reminder", "body": "A reminder."}'::jsonb,
         '00000000-0000-0000-0000-00000000d1a1', null, 'email the SL-TEST-2 reminder to Spine Lanes Test',
         '[]'::jsonb, 'ui', null, interval '24 hours');
  code := p.sms_code;
  if code is null or not (code = any (public.sms_codes_in_use())) then
    raise exception 'a live proposal''s code % is not in use', code;
  end if;

  p := public.op_proposal_approve(p.id, 'inbox');
  if p.status <> 'executed' or p.sms_code is distinct from code then
    raise exception 'the inbox approval is % with code % (%)', p.status, p.sms_code, p.error;
  end if;
  if not (code = any (public.sms_codes_in_use())) then
    raise exception 'a just-approved proposal''s code % was freed: %', code, public.sms_codes_in_use();
  end if;
end
$$;
rollback to savepoint s;
reset role;


-- 6. the trigger: a new proposal steps over pending text-lane codes
savepoint s;
do $$
declare
  n  integer;
  c1 integer; c2 integer; c3 integer;
  p  public.proposals;
  ev jsonb;
begin
  -- the next codes the sequence will hand out (1..9999, cycling)
  n  := nextval('public.proposals_sms_code_seq');
  c1 := case when n  >= 9999 then 1 else n  + 1 end;
  c2 := case when c1 >= 9999 then 1 else c1 + 1 end;
  c3 := case when c2 >= 9999 then 1 else c2 + 1 end;

  insert into public.pending_actions (code, kind, label, status) values
    (c1, 'sendText', 'sl trigger 1', 'pending'),
    (c2, 'sendText', 'sl trigger 2', 'pending');

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  p := public.op_propose('sms.send', '{"to": "+19075550111", "body": "sl trigger"}'::jsonb);
  reset role;

  if p.sms_code is distinct from c3 then
    raise exception 'with text asks on % and % the proposal took %, expected %', c1, c2, p.sms_code, c3;
  end if;
  if exists (select 1 from public.pending_actions where status = 'pending' and code = p.sms_code) then
    raise exception 'a new proposal holds code % that a pending text ask holds', p.sms_code;
  end if;
  select data into ev from public.events where kind = 'proposal.created' and proposal_id = p.id;
  if (ev ->> 'sms_code')::int is distinct from p.sms_code then
    raise exception 'proposal.created says code %, the row holds %', ev ->> 'sms_code', p.sms_code;
  end if;
end
$$;
rollback to savepoint s;

-- 6b. a text ask decided and filed more than 48 hours ago does not hold its code
savepoint s;
do $$
declare
  n  integer;
  c1 integer;
  p  public.proposals;
begin
  n  := nextval('public.proposals_sms_code_seq');
  c1 := case when n >= 9999 then 1 else n + 1 end;
  insert into public.pending_actions (code, kind, label, status, created_at, expires_at, executed_at)
  values (c1, 'sendText', 'sl decided', 'executed', now() - interval '3 days', now() - interval '2 days', now() - interval '3 days');

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  p := public.op_propose('sms.send', '{"to": "+19075550112", "body": "sl decided"}'::jsonb);
  reset role;

  if p.sms_code is distinct from c1 then
    raise exception 'an executed text ask on % pushed the proposal to %', c1, p.sms_code;
  end if;
end
$$;
rollback to savepoint s;

-- 6c. a text ask filed in the last 48 hours holds its code whatever became of
--     it: roybal-notify still answers a late "YES n" for it, and a live
--     proposal on that number would take the YES instead. Exactly 48 hours
--     counts; a second more does not.
savepoint s;
do $$
declare
  n  integer;
  c1 integer; c2 integer; c3 integer;
  p  public.proposals;
begin
  n  := nextval('public.proposals_sms_code_seq');
  c1 := case when n  >= 9999 then 1 else n  + 1 end;
  c2 := case when c1 >= 9999 then 1 else c1 + 1 end;
  c3 := case when c2 >= 9999 then 1 else c2 + 1 end;

  insert into public.pending_actions (code, kind, label, status, created_at, expires_at, executed_at) values
    (c1, 'boardEdit', 'sl ran 47h ago',     'executed', now() - interval '47 hours', now() - interval '23 hours', now() - interval '46 hours'),
    (c2, 'sendText',  'sl declined at 48h', 'declined', now() - interval '48 hours', now() - interval '24 hours', null),
    (c3, 'sendText',  'sl expired past 48h', 'expired', now() - interval '48 hours 1 second', now() - interval '24 hours', null);

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  p := public.op_propose('sms.send', '{"to": "+19075550114", "body": "sl recent"}'::jsonb);
  reset role;

  if p.sms_code is distinct from c3 then
    raise exception 'text asks filed 47h and 48h ago on % and %, 48h+1s ago on %: the proposal took %, expected %',
      c1, c2, c3, p.sms_code, c3;
  end if;
end
$$;
rollback to savepoint s;

-- 6d. stepping over a text ask onto a live proposal's code: the unique index
--     refuses it, op_propose retries with a fresh code, and the trigger checks
--     that one too
savepoint s;
do $$
declare
  n  integer;
  c1 integer; c2 integer; c3 integer;
  p  public.proposals;
begin
  n  := nextval('public.proposals_sms_code_seq');
  c1 := case when n  >= 9999 then 1 else n  + 1 end;
  c2 := case when c1 >= 9999 then 1 else c1 + 1 end;
  c3 := case when c2 >= 9999 then 1 else c2 + 1 end;

  insert into public.pending_actions (code, kind, label, status) values (c1, 'sendText', 'sl retry', 'pending');
  insert into public.proposals
    (operation, action_type, proposed_by_kind, proposed_via, idempotency_key, status, sms_code)
  values ('sms.send@1', 'comms', 'human', 'ui', 'test:spine_lanes:retry:live', 'proposed', c2);

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  p := public.op_propose('sms.send', '{"to": "+19075550113", "body": "sl retry"}'::jsonb);
  reset role;

  if p.sms_code is distinct from c3 then
    raise exception 'text ask on %, live proposal on %: the proposal took %, expected %', c1, c2, p.sms_code, c3;
  end if;
  if (select count(*) from public.proposals where status = 'proposed' and sms_code = c2) <> 1 then
    raise exception 'two live proposals share code %', c2;
  end if;
end
$$;
rollback to savepoint s;


-- 7. outbox_channel_ready, from no heartbeats at all
delete from public.worker_heartbeats;

savepoint s;
do $$
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d192", "role": "authenticated", "aud": "authenticated"}';
  if public.outbox_channel_ready('email') then raise exception 'no heartbeat, yet email is ready'; end if;
  reset role;

  -- production today: a live worker sending texts only
  insert into public.worker_heartbeats (worker_id, at, meta)
  values ('sl-worker-sms', now(), '{"channels": ["sms"], "email": false}');
  set local role authenticated;
  if public.outbox_channel_ready('email') then raise exception 'an sms-only worker reads as email-ready'; end if;
  if not public.outbox_channel_ready('sms') then raise exception 'a fresh sms worker is not sms-ready'; end if;
  if public.outbox_channel_ready(null) then raise exception 'a null channel is ready'; end if;
  if public.outbox_channel_ready('') then raise exception 'an empty channel is ready'; end if;
  reset role;

  -- shapes that are not a list of strings never count
  insert into public.worker_heartbeats (worker_id, at, meta) values
    ('sl-worker-string', now(), '{"channels": "email"}'),
    ('sl-worker-object', now(), '{"channels": {"email": true}}'),
    ('sl-worker-nested', now(), '{"channels": [["email"]]}'),
    ('sl-worker-flag',   now(), '{"email": true}');
  set local role authenticated;
  if public.outbox_channel_ready('email') then raise exception 'a malformed meta.channels reads as email-ready'; end if;
  reset role;

  -- a worker that went quiet 10 minutes ago is not ready; under 10 it is
  insert into public.worker_heartbeats (worker_id, at, meta)
  values ('sl-worker-email', now() - interval '10 minutes', '{"channels": ["sms", "email"]}');
  set local role authenticated;
  if public.outbox_channel_ready('email') then raise exception 'a 10-minute-old heartbeat reads as email-ready'; end if;
  reset role;

  update public.worker_heartbeats set at = now() - interval '9 minutes 59 seconds' where worker_id = 'sl-worker-email';
  set local role authenticated;
  if not public.outbox_channel_ready('email') then raise exception 'a fresh email worker is not email-ready'; end if;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d190", "role": "authenticated", "aud": "authenticated"}';
  if not public.outbox_channel_ready('email') then raise exception 'the owner sees email as not ready'; end if;
  set local role service_role;
  set local request.jwt.claims = '{"role": "service_role"}';
  if not public.outbox_channel_ready('email') then raise exception 'the service role sees email as not ready'; end if;
  reset role;
end
$$;
rollback to savepoint s;

rollback;
