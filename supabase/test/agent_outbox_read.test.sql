-- ============================================================================
-- Assertions for 0020_agent_outbox_read.sql (an agent login reads the outbox
-- rows of the proposals it filed, so the brief's 7-day check can see that an
-- approved reminder died and offer it again).
--
-- Run by the DB replay workflow against the database rebuilt from
-- supabase/migrations/, and by hand on staging:
--   psql -v ON_ERROR_STOP=1 -f supabase/test/agent_outbox_read.test.sql <staging url>
-- Everything it writes is rolled back.
--
-- The rules it holds 0020 to:
--   1. outbox_read_own_agent is a permissive SELECT policy for authenticated
--      on outbox, and outbox has exactly the 0004 read policies besides it.
--   2. The brief's login reads the outbox rows of the proposals agent:brief
--      filed, through the real path (the brief proposes, the owner approves)
--      and as the brief's read asks for them (proposal_id=in.(...), status),
--      and nothing else: not another agent's, not a proposal a person filed,
--      not another org's (whether the proposal or only the outbox row is
--      there), not a row with no proposal. Every row it can read, test rows
--      or real ones, belongs to one of its own proposals.
--   3. A second agent login reads only its own agent's rows, and nothing once
--      that agent is disabled; a person whose login is linked to an agents row
--      by mistake reads only what their role read before.
--   4. Owner, office and viewer still read every row in the org and none
--      outside it; crew still reads only the rows it is the principal of.
-- ============================================================================

\set ON_ERROR_STOP on

-- 1. the policy, and nothing else on outbox changed
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'outbox'
                    and policyname = 'outbox_read_own_agent' and cmd = 'SELECT'
                    and permissive = 'PERMISSIVE' and roles = array['authenticated']::name[]) then
    raise exception 'outbox_read_own_agent is not a permissive SELECT policy for authenticated on outbox';
  end if;
  -- it names the filing agent itself. The behaviour below cannot tell, because
  -- the exists reads proposals under the caller's own RLS, which today shows an
  -- agent only its own rows; a later read policy on proposals would change that.
  if (select qual from pg_policies
       where schemaname = 'public' and tablename = 'outbox' and policyname = 'outbox_read_own_agent')
     !~ 'proposed_by_kind = ''agent''.*proposed_by_id = \( SELECT (public\.)?current_agent_id\(\)' then
    raise exception 'outbox_read_own_agent does not test the proposal''s filer against current_agent_id(): %',
      (select qual from pg_policies
        where schemaname = 'public' and tablename = 'outbox' and policyname = 'outbox_read_own_agent');
  end if;
  if (select array_agg(policyname::text order by policyname) from pg_policies
       where schemaname = 'public' and tablename = 'outbox')
     is distinct from array['outbox_read_office', 'outbox_read_own', 'outbox_read_own_agent'] then
    raise exception 'outbox policies are %, expected the two of 0004 and outbox_read_own_agent',
      (select array_agg(policyname::text order by policyname) from pg_policies
        where schemaname = 'public' and tablename = 'outbox');
  end if;
end
$$;


-- 2–4. who reads which row. One transaction, rolled back at the end.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000d2a0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-owner@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d2a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-office@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d2a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-viewer@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d2a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-crew@example.invalid',   '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d2a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-brief@example.invalid',  '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000d2a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-aor-web@example.invalid',    '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000d2a0', 'aor test owner',  'owner'),
  ('00000000-0000-0000-0000-00000000d2a1', 'aor test office', 'office'),
  ('00000000-0000-0000-0000-00000000d2a2', 'aor test viewer', 'viewer'),
  ('00000000-0000-0000-0000-00000000d2a3', 'aor test crew',   'crew'),
  ('00000000-0000-0000-0000-00000000d2a4', 'aor test brief',  'agent'),
  ('00000000-0000-0000-0000-00000000d2a5', 'aor test web',    'agent')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- the brief's login is agent:brief, the second machine login is agent:web,
-- and the crew login is linked to agent:projection by mistake
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d2a4'
 where id = '1af33481-7f1c-4485-87f5-7b0ec5e27554';
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d2a5'
 where id = '951f7f7d-eb77-4cda-9d98-1db89cf30541';
update public.agents set auth_user_id = '00000000-0000-0000-0000-00000000d2a3'
 where id = 'a40bbef2-cf95-4b7f-85bf-4712534e8217';

-- label → outbox row, readable by every caller below so each can name what it sees
create temp table aor_rows (label text primary key, outbox_id uuid not null unique, proposal_id uuid);
grant select on aor_rows to authenticated;

-- A. the real path: the brief files a reminder the way roybal-brief does, and
--    the owner approves it in the inbox, which queues one outbox row
savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d2a4", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_propose(
         'email.send',
         jsonb_build_object('to', 'billing@example.invalid',
                            'subject', 'Payment reminder — invoice AOR-TEST-1 (Outbox Read Test)',
                            'body', 'Hello, a reminder that invoice AOR-TEST-1 is past due. Thank you,'),
         '00000000-0000-0000-0000-00000000d2b1', null,
         'email the AOR-TEST-1 reminder to Outbox Read Test (12 days past due, $1,234.00 open)',
         '[{"kind": "invoice", "id": "00000000-0000-0000-0000-00000000d2b1:AOR-TEST-1", "label": "Invoice AOR-TEST-1"}]'::jsonb,
         'cron', null, interval '24 hours');
  if p.proposed_by_kind <> 'agent' or p.proposed_by_id <> '1af33481-7f1c-4485-87f5-7b0ec5e27554' then
    raise exception 'the brief''s reminder was filed by %/%', p.proposed_by_kind, p.proposed_by_id;
  end if;
  -- nothing is queued yet, so there is nothing to read
  if exists (select 1 from public.outbox where proposal_id = p.id) then
    raise exception 'the brief reads an outbox row for a reminder nobody approved';
  end if;
  reset role;
  insert into aor_rows (label, outbox_id, proposal_id) values ('A', gen_random_uuid(), p.id);
end
$$;
release savepoint s;
reset role;

savepoint s;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000d2a0", "role": "authenticated", "aud": "authenticated"}';
do $$
declare
  p public.proposals;
begin
  p := public.op_proposal_approve((select proposal_id from aor_rows where label = 'A'), 'inbox');
  if p.status <> 'executed' then
    raise exception 'the owner''s approval left the reminder % (%)', p.status, p.error;
  end if;
end
$$;
release savepoint s;
reset role;

update aor_rows set outbox_id = (select o.id from public.outbox o where o.proposal_id = aor_rows.proposal_id)
 where label = 'A';

-- the rest, written directly as the worker and the other doors would leave them
do $$
declare
  brief constant uuid := '1af33481-7f1c-4485-87f5-7b0ec5e27554';
  web   constant uuid := '951f7f7d-eb77-4cda-9d98-1db89cf30541';
  proj  constant uuid := 'a40bbef2-cf95-4b7f-85bf-4712534e8217';
  owner constant uuid := '00000000-0000-0000-0000-00000000d2a0';
  crew  constant uuid := '00000000-0000-0000-0000-00000000d2a3';
  other constant uuid := '00000000-0000-0000-0000-00000000d2ff';
  r record;
  v_pid uuid;
begin
  -- label, proposal filed by (kind, id; null kind = no proposal), proposal org,
  -- outbox org, outbox status, outbox principal
  for r in
    select * from (values
      ('B',  'agent', brief, null::uuid, null::uuid, 'dead',      owner),  -- the brief's, Gmail refused it
      ('W',  'agent', web,   null,       null,       'sent',      owner),  -- another agent's
      ('H',  'human', owner, null,       null,       'pending',   owner),  -- one a person filed
      ('P',  'agent', proj,  null,       null,       'sent',      owner),  -- the mislinked crew login's agent
      ('N',  null,    null,  null,       null,       'delivered', crew),   -- no proposal: crew is its principal
      ('Y',  'agent', brief, other,      other,      'dead',      owner)   -- the brief's, in another org
    ) v(label, by_kind, by_id, p_org, o_org, o_status, o_principal)
  loop
    v_pid := null;
    if r.by_kind is not null then
      insert into public.proposals
        (operation, action_type, input, proposed_by_kind, proposed_by_id, proposed_via, evidence_refs,
         idempotency_key, assigned_role, status, approved_by_kind, approved_via, approved_at, org_id)
      values
        ('email.send@1', 'comms', '{"to": "aor@example.invalid", "subject": "s", "body": "b"}'::jsonb,
         r.by_kind, r.by_id, case when r.by_kind = 'agent' then 'cron' else 'ui' end, '[]'::jsonb,
         'test:aor:proposal:' || r.label, 'owner', 'executed', 'human', 'inbox', now(),
         coalesce(r.p_org, public.current_org()))
      returning id into v_pid;
    end if;

    insert into aor_rows (label, outbox_id, proposal_id) values (r.label, gen_random_uuid(), v_pid);
    insert into public.outbox
      (id, channel, operation, payload, idempotency_key, status, error, principal_kind, principal_id,
       proposal_id, org_id, sent_at)
    values
      ((select outbox_id from aor_rows where label = r.label), 'email', 'email.send@1',
       '{"to": "aor@example.invalid", "subject": "s", "body": "b"}'::jsonb, 'test:aor:outbox:' || r.label,
       r.o_status, case when r.o_status = 'dead' then 'Gmail refused the address' end, 'human', r.o_principal,
       v_pid, coalesce(r.o_org, public.current_org()),
       case when r.o_status in ('sent', 'delivered') then now() end);
  end loop;

  -- X: an outbox row in another org on the brief's own reminder B. Contrived,
  -- but it holds the policy's own org test apart from the proposals read's
  insert into aor_rows (label, outbox_id, proposal_id)
  values ('X', gen_random_uuid(), (select proposal_id from aor_rows where label = 'B'));
  insert into public.outbox
    (id, channel, operation, payload, idempotency_key, status, principal_kind, principal_id, proposal_id, org_id)
  values
    ((select outbox_id from aor_rows where label = 'X'), 'email', 'email.send@1', '{}'::jsonb,
     'test:aor:outbox:X', 'pending', 'human', owner,
     (select proposal_id from aor_rows where label = 'B'), other);
end
$$;


-- 2–4. what each caller reads of the test rows
savepoint s;
do $$
declare
  r record;
  got text[];
  stray int;
begin
  for r in
    select * from (values
      ('the brief',  '00000000-0000-0000-0000-00000000d2a4', array['A', 'B']),
      ('agent:web',  '00000000-0000-0000-0000-00000000d2a5', array['W']),
      ('the owner',  '00000000-0000-0000-0000-00000000d2a0', array['A', 'B', 'H', 'N', 'P', 'W']),
      ('the office', '00000000-0000-0000-0000-00000000d2a1', array['A', 'B', 'H', 'N', 'P', 'W']),
      ('the viewer', '00000000-0000-0000-0000-00000000d2a2', array['A', 'B', 'H', 'N', 'P', 'W']),
      -- crew, though its login is linked to agent:projection: its own row only
      ('the crew',   '00000000-0000-0000-0000-00000000d2a3', array['N'])
    ) v(who, sub, want)
  loop
    perform set_config('request.jwt.claims',
                       json_build_object('sub', r.sub, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
    set local role authenticated;
    select coalesce(array_agg(m.label order by m.label), '{}') into got
      from public.outbox o join aor_rows m on m.outbox_id = o.id;
    reset role;
    if got is distinct from r.want then
      raise exception '% reads outbox rows %, expected %', r.who, got, r.want;
    end if;
  end loop;

  -- the brief's own read, as roybal-brief asks it: its executed reminders'
  -- ids, plus everyone else's for good measure; only its own answer
  perform set_config('request.jwt.claims',
                     '{"sub": "00000000-0000-0000-0000-00000000d2a4", "role": "authenticated", "aud": "authenticated"}', true);
  set local role authenticated;
  select coalesce(array_agg(m.label || ':' || o.status order by m.label), '{}') into got
    from public.outbox o join aor_rows m on m.outbox_id = o.id
   where o.proposal_id in (select proposal_id from aor_rows where proposal_id is not null);
  -- and nothing it can read anywhere (real rows on staging included) is
  -- another proposal's: the proposals read below is the brief's own RLS view
  select count(*) into stray from public.outbox o
   where not exists (select 1 from public.proposals p
                      where p.id = o.proposal_id and p.proposed_by_kind = 'agent'
                        and p.proposed_by_id = '1af33481-7f1c-4485-87f5-7b0ec5e27554'
                        and p.org_id = o.org_id);
  reset role;
  if got is distinct from array['A:pending', 'B:dead'] then
    raise exception 'the brief''s outbox read by proposal_id answers %, expected {A:pending,B:dead}', got;
  end if;
  if stray <> 0 then
    raise exception 'the brief reads % outbox row(s) that are not of a proposal agent:brief filed', stray;
  end if;

  -- a disabled agent reads nothing, its own rows included
  update public.agents set enabled = false where id = '951f7f7d-eb77-4cda-9d98-1db89cf30541';
  perform set_config('request.jwt.claims',
                     '{"sub": "00000000-0000-0000-0000-00000000d2a5", "role": "authenticated", "aud": "authenticated"}', true);
  set local role authenticated;
  select coalesce(array_agg(m.label order by m.label), '{}') into got
    from public.outbox o join aor_rows m on m.outbox_id = o.id;
  reset role;
  if got <> '{}' then
    raise exception 'a disabled agent still reads outbox rows %', got;
  end if;
end
$$;
rollback to savepoint s;

rollback;
