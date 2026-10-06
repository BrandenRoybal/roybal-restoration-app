-- ============================================================================
-- Assertions for 0013_op_spine.sql and 0014_ops_first_five.sql (3d also
-- reads the one agent_authority grant 0019 seeds; 0019's own rules are in
-- spine_lanes.test.sql).
--
-- Run by the DB replay workflow after the census, against the database
-- `supabase db reset` rebuilt from supabase/migrations/. Every block raises on
-- the first rule it finds broken. The rules are the ones 03 §2.1–§2.4, doc 09
-- §7 and the owner ruling of 2026-09-06 state; each is a thing the spine
-- would be silently wrong about if a later migration drifted.
--
-- The replay database has no auth.users rows, so the behaviour blocks create
-- their own people inside one transaction and roll it back at the end.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Grants. ALTER DEFAULT PRIVILEGES hands anon and authenticated EXECUTE on
--    every new function in public (0000_baseline.sql:6366-6367). The doors
--    doc 09 §7.1 opens are the only ones open.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  problems text[] := '{}';
  -- what authenticated may call
  open_to_users text[] := array['op_propose', 'op_proposal_approve', 'op_proposal_decline'];
  -- what only service_role (and the op bodies, as postgres) may call
  service_only text[] := array['emit_event', 'enqueue', 'claim_job', 'op_execute',
                               'op_expire_proposals', 'op_quiet_hours_release'];
begin
  for r in
    select p.proname, p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'op\_%' or p.proname in ('emit_event', 'enqueue', 'claim_job'))
  loop
    if has_function_privilege('anon', r.sig, 'EXECUTE') then
      problems := problems || format('anon can execute %s', r.proname);
    end if;
    if has_function_privilege('authenticated', r.sig, 'EXECUTE') <> (r.proname = any (open_to_users)) then
      problems := problems || format('authenticated execute on %s is %s', r.proname,
                                     has_function_privilege('authenticated', r.sig, 'EXECUTE'));
    end if;
    if r.proname = any (open_to_users || service_only)
       and not has_function_privilege('service_role', r.sig, 'EXECUTE') then
      problems := problems || format('service_role cannot execute %s', r.proname);
    end if;
    if r.proname like 'op\_resolve%' or r.proname like 'op\_role%' or r.proname like 'op\_agent%'
       or r.proname like 'op\_validate%' or r.proname like 'op\_render%' or r.proname like 'op\_catalog%'
       or r.proname like 'op\_check%' or r.proname like 'op\_exec\_%' then
      if has_function_privilege('service_role', r.sig, 'EXECUTE') then
        problems := problems || format('service_role can execute internal helper %s', r.proname);
      end if;
    end if;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'op spine grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The catalog: the five operations of doc 09 §7.2, every one approved by
--    the owner by default, every proposable one with an executor.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from public.operation_catalog
   where deprecated_at is null
     and name in ('proposal.approve', 'proposal.decline', 'email.send', 'sms.send', 'job.set_stage');
  if n <> 5 then
    raise exception 'operation_catalog holds % of the first five operations', n;
  end if;
  if exists (select 1 from public.operation_catalog where approval_default = 'auto') then
    raise exception 'a catalog operation defaults to auto approval';
  end if;
  if exists (select 1 from public.approval_policies where auto or approver_role <> 'owner') then
    raise exception 'approval_policies no longer owner-only with auto = false (ruling 2026-09-06)';
  end if;

  -- the matrix as the spine reads it: the owner approves everything; office
  -- holds comms but not money (the explicit deny of 0004 wins over its
  -- conditional execute); a conditional execute never implies approval
  if not public.op_role_permits('owner', 'invoice.add_line', 'money', 'approve') then
    raise exception 'the owner may not approve money';
  end if;
  if not public.op_role_permits('owner', 'job.set_stage', 'job', 'approve') then
    raise exception 'the owner may not approve a job move (unconditional execute should imply it)';
  end if;
  if public.op_role_permits('office', 'invoice.add_line', 'money', 'approve') then
    raise exception 'office may approve money (ruling 2026-09-06)';
  end if;
  if not public.op_role_permits('office', 'email.send', 'comms', 'approve') then
    raise exception 'office may not approve comms';
  end if;
  if public.op_role_permits('crew', 'sms.send', 'comms', 'approve') then
    raise exception 'crew may approve comms through its conditional execute row';
  end if;
  if public.op_role_permits('crew_lead', 'sms.send', 'comms', 'approve') then
    raise exception 'crew_lead may approve comms through its conditional execute row';
  end if;
  if not public.op_role_permits('crew', 'sms.send', 'comms', 'propose') then
    raise exception 'crew may not propose a text';
  end if;
  if public.op_role_permits('crew', 'invoice.add_line', 'money', 'propose') then
    raise exception 'crew may propose money';
  end if;
  if public.op_role_permits('viewer', 'email.send', 'comms', 'propose') then
    raise exception 'a viewer may propose';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. Behaviour, as each caller. One transaction, rolled back at the end.
-- ---------------------------------------------------------------------------
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-op-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-op-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-op-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-op-agent@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-op-agent2@example.invalid', '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000d001', 'op test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000d002', 'op test office', 'office'),
  ('00000000-0000-0000-0000-00000000d003', 'op test crew',   'crew'),
  ('00000000-0000-0000-0000-00000000d004', 'op test agent',  'agent'),
  ('00000000-0000-0000-0000-00000000d005', 'op test agent 2', 'agent')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- the agent login is agent:brief; the second is agent:web, which holds no grant
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d004'
 where id = '1af33481-7f1c-4485-87f5-7b0ec5e27554';
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d005'
 where id = '951f7f7d-eb77-4cda-9d98-1db89cf30541';

-- a board job to move
insert into public.coordination_jobs (id, data) values
  ('00000000-0000-0000-0000-00000000d0b1', '{"stage": "lead", "rev": 3, "title": "op test job"}'::jsonb);

create temp table op_test_state (k text primary key, v text);
grant all on op_test_state to anon, authenticated, service_role;

-- 3a. the owner proposes an email, with the claims a real token carries;
--     the same request twice is one proposal
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p1 public.proposals;
  p2 public.proposals;
begin
  p1 := public.op_propose('email.send',
          '{"to": "adjuster@example.invalid", "subject": "Invoice RC-TEST-1", "body": "Attached."}'::jsonb,
          null, null, 'overdue reminder', '[]'::jsonb, 'ui');
  if p1.status <> 'proposed' then raise exception 'new proposal is %', p1.status; end if;
  if p1.assigned_role <> 'owner' then raise exception 'email.send routed to % not owner', p1.assigned_role; end if;
  if p1.sms_code is null then raise exception 'no sms_code allocated'; end if;
  if p1.proposed_by_kind <> 'human' or p1.proposed_by_id <> '00000000-0000-0000-0000-00000000d001' then
    raise exception 'proposed_by is %/%', p1.proposed_by_kind, p1.proposed_by_id;
  end if;
  if p1.operation <> 'email.send@1' then raise exception 'operation recorded as %', p1.operation; end if;
  if not exists (select 1 from public.events where kind = 'proposal.created' and proposal_id = p1.id
                    and principal_id = '00000000-0000-0000-0000-00000000d001') then
    raise exception 'no proposal.created event for the owner';
  end if;

  p2 := public.op_propose('email.send',
          '{"to": "adjuster@example.invalid", "subject": "Invoice RC-TEST-1", "body": "Attached."}'::jsonb,
          null, null, 'again', '[]'::jsonb, 'ui');
  if p2.id <> p1.id then raise exception 'the same request filed two proposals'; end if;

  insert into op_test_state values ('email_proposal', p1.id::text);

  -- bad input is refused before anything is written
  begin
    perform public.op_propose('email.send', '{"to": "not an address", "subject": "x", "body": "y"}'::jsonb);
    raise exception 'an invalid email.send input was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.op_propose('email.send', '{"to": "a@b.co", "subject": "x", "body": "y", "bcc": "z"}'::jsonb);
    raise exception 'an unknown input field was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.op_propose('invoice.add_line', '{}'::jsonb);
    raise exception 'an unknown operation was accepted';
  exception when no_data_found then null;
  end;
  begin
    perform public.op_propose('proposal.approve', '{"proposal_id": "x"}'::jsonb);
    raise exception 'proposal.approve was accepted as a proposal';
  exception when others then
    if sqlerrm !~ 'not proposable' then raise; end if;
  end;

  -- a signed-in owner cannot write the ledgers directly
  begin
    perform public.emit_event('forged');
    raise exception 'an authenticated user called emit_event';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue('forged');
    raise exception 'an authenticated user called enqueue';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 3b. a crew member may propose a text but never approve
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d003", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
  eid uuid := (select v::uuid from op_test_state where k = 'email_proposal');
begin
  p := public.op_propose('sms.send', '{"to": "+19075550100", "body": "On our way", "kind": "onOurWay"}'::jsonb,
                         null, null, null, '[]'::jsonb, 'ui');
  if p.status <> 'proposed' then raise exception 'crew sms proposal is %', p.status; end if;
  insert into op_test_state values ('sms_proposal', p.id::text);

  begin
    perform public.op_proposal_approve(eid, 'inbox');
    raise exception 'a crew member approved a proposal';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.op_proposal_approve(p.id, 'inbox');
    raise exception 'a crew member approved their own proposal';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.op_proposal_decline(eid, 'no');
    raise exception 'a crew member declined a proposal';
  exception when insufficient_privilege then null;
  end;
  -- crew may not propose a board move (job:* propose is allowed, but the
  -- executor is not the question here; the ruling is who approves)
end
$$;
release savepoint s;
reset role;

-- 3c. office holds `approve` on comms in the matrix, but every policy routes
--     to the owner (ruling 2026-09-06), so office is refused today
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d002", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  eid uuid := (select v::uuid from op_test_state where k = 'email_proposal');
begin
  begin
    perform public.op_proposal_approve(eid, 'inbox');
    raise exception 'office approved a proposal routed to the owner';
  exception when insufficient_privilege then
    if sqlerrm !~ 'waits on owner' then raise; end if;
  end;
end
$$;
release savepoint s;
reset role;

-- 3d. an agent login: nothing until the owner grants it, and never approval.
--     agent:web holds no grant and is refused; agent:brief holds the one
--     grant 0019 seeded (propose email.send) and nothing beyond it
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d005", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  begin
    perform public.op_propose('email.send', '{"to": "a@b.co", "subject": "x", "body": "y"}'::jsonb,
                              null, null, null, '[]'::jsonb, 'agent');
    raise exception 'an agent with no agent_authority row proposed';
  exception when insufficient_privilege then
    if sqlerrm !~ 'may not propose' then raise; end if;
  end;
end
$$;
rollback to savepoint s;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d004", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_propose('email.send', '{"to": "a@b.co", "subject": "x", "body": "y"}'::jsonb,
                         null, null, null, '[]'::jsonb, 'cron');
  if p.status <> 'proposed' or p.proposed_by_kind <> 'agent'
     or p.proposed_by_id <> '1af33481-7f1c-4485-87f5-7b0ec5e27554' then
    raise exception 'agent:brief email.send under its 0019 grant is %, by %/%', p.status, p.proposed_by_kind, p.proposed_by_id;
  end if;

  begin
    perform public.op_propose('sms.send', '{"to": "+19075550100", "body": "x"}'::jsonb,
                              null, null, null, '[]'::jsonb, 'cron');
    raise exception 'agent:brief proposed a text; 0019 grants it email.send only';
  exception when insufficient_privilege then
    if sqlerrm !~ 'may not propose' then raise; end if;
  end;
end
$$;
rollback to savepoint s;

-- the owner grants agent:brief comms proposals (through a direct row here;
-- the agent_authority.grant op is later)
insert into public.agent_authority (agent_id, operation, capability, granted_by_kind, granted_by_id)
values ('1af33481-7f1c-4485-87f5-7b0ec5e27554', 'comms:*', 'propose', 'human', '00000000-0000-0000-0000-00000000d001');

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d004", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_propose('email.send', '{"to": "pm@example.invalid", "subject": "Draft", "body": "Hello"}'::jsonb,
                         null, null, 'brief', '[]'::jsonb, 'agent');
  if p.proposed_by_kind <> 'agent' or p.proposed_by_id <> '1af33481-7f1c-4485-87f5-7b0ec5e27554' then
    raise exception 'agent proposal recorded as %/%', p.proposed_by_kind, p.proposed_by_id;
  end if;
  insert into op_test_state values ('agent_proposal', p.id::text);

  begin
    perform public.op_proposal_approve(p.id, 'inbox');
    raise exception 'an agent approved a proposal';
  exception when insufficient_privilege then
    if sqlerrm !~ 'never approves' then raise; end if;
  end;

  -- and a job move is outside its grant
  begin
    perform public.op_propose('job.set_stage',
      '{"job_id": "00000000-0000-0000-0000-00000000d0b1", "stage": "scheduled"}'::jsonb,
      null, null, null, '[]'::jsonb, 'agent');
    raise exception 'an agent proposed outside its grant';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 3e. the owner approves the email from the inbox: executed inline, one
--     outbox row, the events in order; approving again changes nothing
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  eid uuid := (select v::uuid from op_test_state where k = 'email_proposal');
  p public.proposals;
  n_events int;
  n_outbox int;
begin
  p := public.op_proposal_approve(eid, 'inbox');
  if p.status <> 'executed' then raise exception 'approved email.send is % (%)', p.status, p.error; end if;
  if p.approved_by_kind <> 'human' or p.approved_by_ref <> '00000000-0000-0000-0000-00000000d001'
     or p.approved_via <> 'inbox' or p.approved_at is null then
    raise exception 'approval not recorded: %/%/%', p.approved_by_kind, p.approved_by_ref, p.approved_via;
  end if;
  if p.executed_event_id is null then raise exception 'executed_event_id is null'; end if;

  select count(*) into n_outbox from public.outbox where proposal_id = eid and channel = 'email' and status = 'pending';
  if n_outbox <> 1 then raise exception '% outbox rows for the email', n_outbox; end if;

  if (select array_agg(kind order by id) from public.events where proposal_id = eid)
     <> array['proposal.created', 'proposal.approved', 'email.queued', 'proposal.executed'] then
    raise exception 'event trail is %', (select array_agg(kind order by id) from public.events where proposal_id = eid);
  end if;

  select count(*) into n_events from public.events;
  p := public.op_proposal_approve(eid, 'inbox');
  if p.status <> 'executed' then raise exception 'second approval changed status to %', p.status; end if;
  if (select count(*) from public.events) <> n_events then raise exception 'a second approval wrote events'; end if;
  if (select count(*) from public.outbox where proposal_id = eid) <> 1 then raise exception 'a second approval wrote a second outbox row'; end if;

  -- the owner cannot write the outbox or the queue directly either
  begin
    insert into public.outbox (channel, idempotency_key) values ('sms', 'forged');
    raise exception 'an authenticated owner wrote the outbox directly';
  exception when insufficient_privilege then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 3f. "YES 12": the service role approving as the owner, the way
--     roybal-webhooks will; a service-role call with no principal is refused;
--     the text is held until quiet hours end
savepoint s;
set local role service_role;
do $$
declare
  sid uuid := (select v::uuid from op_test_state where k = 'sms_proposal');
  p public.proposals;
  o public.outbox;
  local_t time;
begin
  begin
    perform public.op_proposal_approve(sid, 'sms', 'sms', null, null);
    raise exception 'a service-role call with no principal approved';
  exception when insufficient_privilege then null;
  end;

  p := public.op_proposal_approve(sid, 'sms', 'sms', null, '00000000-0000-0000-0000-00000000d001');
  if p.status <> 'executed' then raise exception 'sms.send approved by text is % (%)', p.status, p.error; end if;
  if p.approved_by_kind <> 'human' or p.approved_by_ref <> '00000000-0000-0000-0000-00000000d001'
     or p.approved_via <> 'sms' or p.second_factor <> 'sms' then
    raise exception 'sms approval not recorded as the owner';
  end if;

  select * into o from public.outbox where proposal_id = sid;
  if o.channel <> 'sms' then raise exception 'sms outbox channel is %', o.channel; end if;
  local_t := (o.next_attempt_at at time zone 'America/Anchorage')::time;
  if local_t < time '07:00' or local_t >= time '20:00' then
    raise exception 'sms release % is outside quiet hours', local_t;
  end if;
  if o.next_attempt_at < now() - interval '1 minute' then
    raise exception 'sms release is in the past';
  end if;

  -- the ledger functions are open to the service role and idempotent
  if public.emit_event('test.ping', null, null, null, null, null, null, '{}', 'test:spine:ping')
     <> public.emit_event('test.ping', null, null, null, null, null, null, '{}', 'test:spine:ping') then
    raise exception 'emit_event wrote twice on one key';
  end if;
end
$$;
release savepoint s;
reset role;

-- 3g. the queue: enqueue is idempotent, claim_job leases once, a second
--     claim finds nothing
savepoint s;
set local role service_role;
do $$
declare
  j1 public.jobs_queue;
  j2 public.jobs_queue;
  c  public.jobs_queue;
  n  int;
begin
  j1 := public.enqueue('test.kind', '{"a": 1}'::jsonb, 'test:spine:queue:1');
  j2 := public.enqueue('test.kind', '{"a": 1}'::jsonb, 'test:spine:queue:1');
  if j1.id <> j2.id then raise exception 'enqueue wrote twice on one key'; end if;
  if j1.status <> 'queued' then raise exception 'enqueued row is %', j1.status; end if;

  select * into c from public.claim_job('worker-test', array['test.kind'], 60);
  if c.id is null or c.id <> j1.id then raise exception 'claim_job did not lease the row'; end if;
  if c.status <> 'leased' or c.locked_by <> 'worker-test' or c.lease_until is null or c.attempts <> 1 then
    raise exception 'lease not recorded: %/%/%', c.status, c.locked_by, c.attempts;
  end if;

  select count(*) into n from public.claim_job('worker-test-2', array['test.kind'], 60);
  if n <> 0 then raise exception 'a leased row was claimed again'; end if;
end
$$;
release savepoint s;
reset role;

-- 3h. the owner declines the agent's proposal; declining twice is once
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  aid uuid := (select v::uuid from op_test_state where k = 'agent_proposal');
  p public.proposals;
  n int;
begin
  p := public.op_proposal_decline(aid, 'not now');
  if p.status <> 'declined' or p.decline_reason <> 'not now' then raise exception 'decline not recorded'; end if;
  select count(*) into n from public.events where proposal_id = aid and kind = 'proposal.declined';
  if n <> 1 then raise exception '% proposal.declined events', n; end if;
  p := public.op_proposal_decline(aid, 'still not');
  if p.decline_reason <> 'not now' then raise exception 'a second decline rewrote the reason'; end if;
  begin
    perform public.op_proposal_approve(aid, 'inbox');
    raise exception 'a declined proposal was approved';
  exception when object_not_in_prerequisite_state then null;
  end;
  if (select count(*) from public.outbox where proposal_id = aid) <> 0 then
    raise exception 'a declined proposal wrote an outbox row';
  end if;
end
$$;
release savepoint s;
reset role;

-- 3i. job.set_stage: the board blob moves, rev-bumped, with from/to recorded
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
  d jsonb;
begin
  p := public.op_propose('job.set_stage',
         '{"job_id": "00000000-0000-0000-0000-00000000d0b1", "stage": "scheduled"}'::jsonb,
         null, null, null, '[]'::jsonb, 'ui');
  if p.job_id <> '00000000-0000-0000-0000-00000000d0b1' then raise exception 'job_id not taken from input'; end if;
  p := public.op_proposal_approve(p.id, 'inbox');
  if p.status <> 'executed' then raise exception 'job.set_stage is % (%)', p.status, p.error; end if;

  select data into d from public.coordination_jobs where id = '00000000-0000-0000-0000-00000000d0b1';
  if d ->> 'stage' <> 'scheduled' then raise exception 'board stage is %', d ->> 'stage'; end if;
  if (d ->> 'rev')::int <> 4 then raise exception 'board rev is %', d ->> 'rev'; end if;
  if d ->> 'title' <> 'op test job' then raise exception 'the patch clobbered the blob'; end if;
  if not exists (select 1 from public.events where kind = 'job.stage_set' and proposal_id = p.id
                    and data ->> 'from' = 'lead' and data ->> 'to' = 'scheduled') then
    raise exception 'no job.stage_set event with from/to';
  end if;

  -- a bad stage never becomes a proposal
  begin
    perform public.op_propose('job.set_stage',
      '{"job_id": "00000000-0000-0000-0000-00000000d0b1", "stage": "invoiced"}'::jsonb);
    raise exception 'an unknown stage was accepted';
  exception when invalid_parameter_value then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 3j. a stale proposal is refused at approval and swept by the next propose,
--     which frees its SMS code
savepoint s;
do $$
declare
  p public.proposals;
  q public.proposals;
  code int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
  p := public.op_propose('sms.send', '{"to": "+19075550199", "body": "stale"}'::jsonb,
                         null, null, null, '[]'::jsonb, 'ui', null, interval '1 minute');
  code := p.sms_code;
  reset role;

  update public.proposals set expires_at = now() - interval '1 second' where id = p.id;

  set local role authenticated;
  set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d001", "role": "authenticated", "aud": "authenticated"}';
  begin
    perform public.op_proposal_approve(p.id, 'inbox');
    raise exception 'an expired proposal was approved';
  exception when object_not_in_prerequisite_state then null;
  end;

  q := public.op_propose('sms.send', '{"to": "+19075550198", "body": "fresh"}'::jsonb);
  if (select status from public.proposals where id = p.id) <> 'expired' then
    raise exception 'the stale proposal was not swept';
  end if;
  if not exists (select 1 from public.events where kind = 'proposal.expired' and proposal_id = p.id) then
    raise exception 'no proposal.expired event';
  end if;
  if not exists (select 1 from public.proposals where sms_code = code and status = 'proposed' and id <> p.id)
     and (select count(*) from public.proposals where status = 'proposed' and sms_code = code) <> 0 then
    raise exception 'the expired code is still counted as live';
  end if;
  reset role;
end
$$;
release savepoint s;
reset role;

rollback;
