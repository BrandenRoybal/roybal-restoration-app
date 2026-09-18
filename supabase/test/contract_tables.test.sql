-- ============================================================================
-- Assertions for 0004_backbone_contract_tables.sql.
--
-- Run by the DB replay workflow (.github/workflows/db-replay.yml) against the
-- database `supabase db reset` has just rebuilt from supabase/migrations/ —
-- the real baseline, with production's roles and default privileges under it,
-- which is the only place asserting anything about grants and policies means
-- something. To run it by hand: `supabase start && supabase db reset --no-seed`,
-- then `psql -v ON_ERROR_STOP=1 -f supabase/test/contract_tables.test.sql <url>`.
--
-- The census step ahead of this one says the right objects came back. This says
-- they behave. It runs after the census, so the rows it inserts cannot skew it.
--
-- Each block raises on failure, so the first broken invariant stops the file
-- with a message naming it. Nothing here is a smoke test: every assertion below
-- is a rule stated in docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md
-- that would be silently wrong if the migration drifted.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The nine tables exist and RLS is on.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  missing text[] := '{}';
  unprotected text[] := '{}';
begin
  foreach t in array array['proposals', 'events', 'jobs_queue', 'outbox', 'agents',
                           'agent_authority', 'role_permissions', 'approval_policies',
                           'operation_catalog']
  loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relkind = 'r') then
      missing := missing || t;
    elsif not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = t) then
      unprotected := unprotected || t;
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception 'missing contract tables: %', missing;
  end if;
  if array_length(unprotected, 1) is not null then
    raise exception 'RLS is not enabled on: %', unprotected;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The grant trap. ALTER DEFAULT PRIVILEGES hands anon and authenticated
--    GRANT ALL on every new table in this database (0000_baseline.sql:6375).
--    anon must hold nothing at all, and authenticated must hold SELECT and
--    nothing else: writes arrive through op_* functions, never a table grant.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  problems text[] := '{}';
begin
  for r in
    select c.relname as tbl, p.priv
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
     where n.nspname = 'public'
       and c.relname in ('proposals', 'events', 'jobs_queue', 'outbox', 'agents',
                         'agent_authority', 'role_permissions', 'approval_policies',
                         'operation_catalog')
  loop
    if has_table_privilege('anon', format('public.%I', r.tbl), r.priv) then
      problems := problems || format('anon has %s on %s', r.priv, r.tbl);
    end if;
    if has_table_privilege('authenticated', format('public.%I', r.tbl), r.priv)
       and r.priv <> 'SELECT' then
      problems := problems || format('authenticated has %s on %s', r.priv, r.tbl);
    end if;
    if not has_table_privilege('authenticated', format('public.%I', r.tbl), 'SELECT') then
      problems := problems || format('authenticated cannot SELECT %s', r.tbl);
    end if;
  end loop;

  if array_length(problems, 1) is not null then
    raise exception 'table grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. events is append-only for EVERY role, service_role included. An audit
--    table a leaked service key can rewrite is not an audit table.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('service_role', 'public.events', 'UPDATE')
     or has_table_privilege('service_role', 'public.events', 'DELETE')
     or has_table_privilege('service_role', 'public.events', 'TRUNCATE') then
    raise exception 'service_role can modify public.events';
  end if;
end
$$;

insert into public.events (principal_kind, kind, data)
values ('system', 'test.append_only', '{"n": 1}'::jsonb);

do $$
declare
  id_ bigint;
begin
  select id into id_ from public.events where kind = 'test.append_only' limit 1;

  begin
    update public.events set kind = 'test.rewritten' where id = id_;
    raise exception 'events accepted an UPDATE';
  exception
    when restrict_violation then null;
  end;

  begin
    delete from public.events where id = id_;
    raise exception 'events accepted a DELETE';
  exception
    when restrict_violation then null;
  end;

  -- TRUNCATE is refused twice over: proposals.executed_event_id references
  -- events, and the statement trigger raises on top of that. Either refusal is
  -- the right answer; accepting the statement is not.
  begin
    truncate public.events;
    raise exception 'events accepted a TRUNCATE';
  exception
    when restrict_violation or feature_not_supported then null;
  end;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. proposals.input is immutable after insert — an approver's change belongs
--    in edited_params, or the audit trail says the owner approved something
--    nobody proposed.
-- ---------------------------------------------------------------------------
do $$
declare
  p_ uuid;
begin
  insert into public.proposals
    (operation, action_type, input, proposed_by_kind, proposed_via, idempotency_key)
  values
    ('sms.send@1', 'comms', '{"to": "+19075550100"}'::jsonb, 'agent', 'agent', 'test:immutable:1')
  returning id into p_;

  begin
    update public.proposals set input = '{"to": "+19075550999"}'::jsonb where id = p_;
    raise exception 'proposals accepted an edit to input';
  exception
    when restrict_violation then null;
  end;

  begin
    update public.proposals set operation = 'email.send@1' where id = p_;
    raise exception 'proposals accepted an edit to operation';
  exception
    when restrict_violation then null;
  end;

  -- but the supported path works
  update public.proposals
     set edited_params = '{"to": "+19075550999"}'::jsonb
   where id = p_;
end
$$;


-- ---------------------------------------------------------------------------
-- 5. An approved proposal always says who approved it and how (§7.3's verify
--    step: "approved_by_kind is never null").
-- ---------------------------------------------------------------------------
do $$
declare
  p_ uuid;
begin
  select id into p_ from public.proposals where idempotency_key = 'test:immutable:1';

  begin
    update public.proposals set status = 'approved' where id = p_;
    raise exception 'a proposal reached approved with no approver recorded';
  exception
    when check_violation then null;
  end;

  update public.proposals
     set status = 'approved', approved_by_kind = 'human',
         approved_via = 'inbox', approved_at = now()
   where id = p_;
end
$$;


-- ---------------------------------------------------------------------------
-- 6. sms_code is unique among LIVE proposals only. That is what lets "YES 12"
--    stay two digits forever, and it is what replaces the two app-side
--    "lowest free integer" allocators.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.proposals
    (operation, action_type, proposed_by_kind, proposed_via, idempotency_key, sms_code, status)
  values ('sms.send@1', 'comms', 'agent', 'agent', 'test:code:a', 12, 'proposed');

  begin
    insert into public.proposals
      (operation, action_type, proposed_by_kind, proposed_via, idempotency_key, sms_code, status)
    values ('sms.send@1', 'comms', 'agent', 'agent', 'test:code:b', 12, 'proposed');
    raise exception 'two live proposals share sms_code 12';
  exception
    when unique_violation then null;
  end;

  -- expiring the first frees the code
  update public.proposals set status = 'expired' where idempotency_key = 'test:code:a';
  insert into public.proposals
    (operation, action_type, proposed_by_kind, proposed_via, idempotency_key, sms_code, status)
  values ('sms.send@1', 'comms', 'agent', 'agent', 'test:code:c', 12, 'proposed');
end
$$;


-- ---------------------------------------------------------------------------
-- 7. Idempotency keys are unique on all four tables that carry one (§2.3).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  missing text[] := '{}';
begin
  foreach t in array array['proposals', 'events', 'jobs_queue', 'outbox']
  loop
    if not exists (
      select 1
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
       where n.nspname = 'public' and c.relname = t
         and i.indisunique and a.attname = 'idempotency_key'
    ) then
      missing := missing || t;
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception 'no unique index on idempotency_key: %', missing;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 8. A leased queue row always names its worker and its lease. Without both,
--    a dead worker orphans the row and nothing ever re-claims it.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.jobs_queue (kind, idempotency_key) values ('test.kind', 'test:queue:1');

  begin
    update public.jobs_queue set status = 'leased' where idempotency_key = 'test:queue:1';
    raise exception 'a queue row was leased with no locked_by / lease_until';
  exception
    when check_violation then null;
  end;

  update public.jobs_queue
     set status = 'leased', locked_by = 'worker-1', lease_until = now() + interval '5 minutes'
   where idempotency_key = 'test:queue:1';
end
$$;


-- ---------------------------------------------------------------------------
-- 9. Every foreign key column is indexed (§8.5, "New table", step 2).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  problems text[] := '{}';
begin
  for r in
    select c.relname as tbl, a.attname as col
      from pg_constraint fk
      join pg_class c on c.oid = fk.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = fk.conkey[1]
     where fk.contype = 'f'
       and n.nspname = 'public'
       and c.relname in ('proposals', 'events', 'jobs_queue', 'outbox', 'agents',
                         'agent_authority', 'role_permissions', 'approval_policies',
                         'operation_catalog')
  loop
    if not exists (
      select 1
        from pg_index i
        join pg_class ic on ic.oid = i.indrelid
        join pg_namespace n2 on n2.oid = ic.relnamespace
        join pg_attribute a2 on a2.attrelid = ic.oid and a2.attnum = i.indkey[0]
       where n2.nspname = 'public' and ic.relname = r.tbl and a2.attname = r.col
    ) then
      problems := problems || format('%s.%s', r.tbl, r.col);
    end if;
  end loop;

  if array_length(problems, 1) is not null then
    raise exception 'foreign key columns with no leading index: %', array_to_string(problems, ', ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 10. The owner ruling of 2026-09-06 (Decision record §17), as shipped:
--     approval_policies is seeded owner-only with auto = false, and no money
--     row names a non-owner approver. §7.3's verify step reads exactly this.
-- ---------------------------------------------------------------------------
do $$
declare
  n_auto  int;
  n_other int;
  n_rows  int;
begin
  select count(*) into n_auto  from public.approval_policies where auto;
  select count(*) into n_other from public.approval_policies
   where action_type = 'money' and approver_role <> 'owner';
  select count(*) into n_rows  from public.approval_policies;

  if n_rows = 0 then
    raise exception 'approval_policies was not seeded';
  end if;
  if n_auto > 0 then
    raise exception '% approval_policies row(s) have auto = true; the ruling of 2026-09-06 is auto = false everywhere', n_auto;
  end if;
  if n_other > 0 then
    raise exception '% money approval_policies row(s) name a non-owner approver', n_other;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 11. The same ruling in role_permissions: office may not approve money, and
--     the row is an explicit deny rather than an absent one, so nobody later
--     mistakes it for an oversight.
-- ---------------------------------------------------------------------------
do $$
declare
  allowed boolean;
begin
  select allow into allowed
    from public.role_permissions
   where role = 'office' and operation = 'money:*' and capability = 'approve';

  if allowed is null then
    raise exception 'office x money x approve has no role_permissions row at all; an explicit deny is required';
  end if;
  if allowed then
    raise exception 'office may approve money; the ruling of 2026-09-06 is owner-only';
  end if;

  if not exists (select 1 from public.role_permissions
                  where role = 'owner' and operation = 'money:*' and capability = 'approve' and allow) then
    raise exception 'the owner cannot approve money';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 12. The six seed agents exist and hold nothing. Deny by default is the whole
--     point of agent_authority: a machine gets its grants from the owner, one
--     at a time, through an operation that emits an event.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from public.agents
   where name in ('agent:billing', 'agent:projection', 'agent:outbox',
                  'agent:brief', 'agent:phone', 'agent:web');
  if n <> 6 then
    raise exception 'expected the six seed agents, found %', n;
  end if;

  select count(*) into n from public.agent_authority where revoked_at is null;
  if n <> 0 then
    raise exception '% agent_authority grant(s) were seeded; agents must start with none', n;
  end if;
end
$$;

-- An agent can never hold `approve`, whatever anyone later tries to insert.
do $$
begin
  begin
    insert into public.agent_authority (agent_id, operation, capability)
    select id, 'money:*', 'approve' from public.agents where name = 'agent:billing';
    raise exception 'agent_authority accepted the approve capability';
  exception
    when check_violation then null;
  end;
end
$$;


-- ---------------------------------------------------------------------------
-- 13. RLS as the roles actually see it. The claim path is exercised here; the
--     profiles fallback in current_role_name() is what carries pre-hook tokens
--     and is covered by the two inserts below that never set a claim.
-- ---------------------------------------------------------------------------
do $$
declare
  owner_id uuid := gen_random_uuid();
  crew_id  uuid := gen_random_uuid();
begin
  insert into public.proposals
    (operation, action_type, proposed_by_kind, proposed_by_id, proposed_via,
     idempotency_key, assigned_role, assignee_id)
  values
    ('invoice.add_line@1', 'money', 'agent', null, 'agent', 'test:rls:owner-only', 'owner', owner_id),
    ('job.set_stage@1',    'job',   'human', crew_id, 'ui',  'test:rls:crew-own',   'office', crew_id);
end
$$;

-- the owner sees both. Each scenario is its own transaction: SET LOCAL needs
-- one, and rolling back keeps a role switch from leaking into the next block.
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000aa", "role": "owner"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.proposals where idempotency_key like 'test:rls:%';
  if n <> 2 then
    raise exception 'owner sees % of the 2 test proposals', n;
  end if;
end
$$;
rollback;

-- a crew principal sees only what is theirs or unassigned
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000bb", "principal_id": "00000000-0000-0000-0000-0000000000bb", "role": "crew"}';
do $$
declare
  n int;
begin
  select count(*) into n from public.proposals where idempotency_key = 'test:rls:owner-only';
  if n <> 0 then
    raise exception 'a crew principal can read a proposal assigned to the owner';
  end if;

  select count(*) into n from public.events;
  if n <> 0 then
    raise exception 'a crew principal can read % event(s) that are not theirs', n;
  end if;

  select count(*) into n from public.jobs_queue;
  if n <> 0 then
    raise exception 'a crew principal can read the work queue';
  end if;

  select count(*) into n from public.role_permissions;
  if n <> 0 then
    raise exception 'a crew principal can read the permission matrix';
  end if;

  -- but the operation catalog is the tool list and everyone may read it
  perform 1 from public.operation_catalog limit 1;
end
$$;
rollback;

-- and nobody signed in may write, whatever their role
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000aa", "role": "owner"}';
do $$
begin
  begin
    insert into public.proposals
      (operation, action_type, proposed_by_kind, proposed_via, idempotency_key)
    values ('sms.send@1', 'comms', 'human', 'ui', 'test:rls:direct-write');
    raise exception 'an authenticated owner wrote a proposal directly instead of through op_propose';
  exception
    when insufficient_privilege then null;
  end;
end
$$;
rollback;
