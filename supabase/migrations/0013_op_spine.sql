-- ============================================================================
-- 0013 — the op spine: the only doors into proposals, events and jobs_queue
--
-- docs/architecture/09-ROLE-ENUM-AND-OPERATION-CATALOG.md §7.1, built on the
-- nine contract tables of 0004. 0004 created those tables with writes granted
-- to nobody but service_role; this migration adds the SECURITY DEFINER
-- functions that are the only way anything else writes to them:
--
--   emit_event            the only writer of events (idempotent on its key)
--   op_propose            file a proposal: catalog lookup, input check,
--                         permission check, approver routing, SMS code
--   op_proposal_approve   approve: authority check, then run the operation
--                         inline (runtime 'sql') or queue it (runtime 'worker')
--   op_proposal_decline   decline: same authority check
--   enqueue               the only writer of jobs_queue
--   claim_job             the worker's lease (FOR UPDATE SKIP LOCKED, lease
--                         as columns so it outlives the claiming transaction)
--
-- plus the internal helpers they share (caller resolution, the permission
-- test, the input check, the idempotency key, the expiry sweep, the executor
-- dispatch). The operations themselves — approve, decline, email.send,
-- sms.send, job.set_stage — are 0014.
--
-- WHAT THIS CHANGES FOR ANYONE TODAY: nothing. No app, edge function or cron
-- calls these yet; pending_actions stays the live spine (03 §7.3). The one
-- existing function touched is current_role_name() (section 0), which only the
-- 0004 read policies use, and nothing reads those tables yet either.
--
-- RULES THESE FUNCTIONS ENFORCE (03 §2.1–§2.4, Decision record §17):
--   * a proposal does nothing until it is approved; input is immutable (0004)
--   * every transition writes an events row in the same transaction
--   * an agent never approves anything, whatever any table says
--   * the approver must hold `approve` in role_permissions AND be the role
--     approval_policies routed the proposal to (the owner may always approve);
--     today every policy routes to the owner, so only the owner approves
--   * nobody but the owner approves their own money/comms/external proposal
--     (doc 09 states the two-person rule without the owner exception; with one
--     office person the owner would deadlock on his own proposals, so the
--     exception is his alone)
--   * a repeated request returns what the first one made: same idempotency key
--     → same proposal, same event, same queue row
--   * a service-role caller must name the principal it acts for; a signed-in
--     caller acts as themselves and cannot name anyone else
--
-- NOT HERE, ON PURPOSE:
--   * auto-approval by policy. approval_policies.auto is false on every row
--     (owner ruling 2026-09-06); op_propose routes by approver_role and ignores
--     auto. Turning the threshold lane on is its own reviewed change.
--   * pg_jsonschema. It is not installed (0000_baseline.sql creates no such
--     extension), so op_validate_input checks the subset of JSON Schema the
--     catalog uses: type object, required, properties.type, enum, pattern,
--     maxLength, additionalProperties false.
--   * a pg_cron registration. Expired proposals are swept at the top of every
--     op_propose and refused at approval, which is what frees their SMS codes;
--     the lease sweeper arrives with the worker that holds leases.
--   * ai_reserve / ai_settle (doc 09 §7.1: their own migration).
--
-- GRANTS. 0000_baseline.sql:6366-6367 grants ALL on every new function in
-- public to anon and authenticated by default. Every function below is
-- therefore followed by an explicit revoke from public, anon, authenticated
-- and a grant to exactly the roles doc 09 §7.1 names.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. current_role_name(): honour the JWT `role` claim only when it is one of
--    the six names.
--
-- A real Supabase access token carries "role": "authenticated" (PostgREST
-- uses that claim to pick the database role), so 0004's "claim first" read
-- returned 'authenticated' for every signed-in person and every 0004 read
-- policy matched nobody. The Custom Access Token hook will stamp the app role
-- under that claim only if it is one of these names; anything else falls
-- through to profiles, which is the truth today.
-- ---------------------------------------------------------------------------
create or replace function public.current_role_name() returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select c.r
       from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' as r) c
      where c.r in ('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent')),
    (select p.role from public.profiles p where p.id = (select auth.uid()))
  );
$$;


-- ---------------------------------------------------------------------------
-- 1. op_resolve_caller — who is calling, as the spine sees it.
--
-- Trusted callers (the service role, or a direct postgres session such as a
-- pg_cron job) hold no identity of their own and MUST name one: an enabled
-- agents row, or a profiles row (roybal-webhooks approving "YES 12" as the
-- owner resolved from his number). A signed-in caller is themselves; a machine
-- login whose profile role is 'agent' resolves to its linked agents row.
-- ---------------------------------------------------------------------------
create or replace function public.op_resolve_caller(
  p_principal_id uuid,
  out principal_kind text,
  out principal_id   uuid,
  out role_name      text
)
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text  := coalesce(nullif(current_setting('role', true), ''), 'none');
  v_trusted boolean;
  v_uid     uuid;
begin
  v_trusted := v_role = 'service_role'
            or coalesce(v_claims ->> 'role', '') = 'service_role'
            or (v_role = 'none' and v_claims is null and session_user in ('postgres', 'supabase_admin'));

  if v_trusted then
    if p_principal_id is null then
      raise exception 'op spine: a service-role call must name the principal it acts for'
        using errcode = 'insufficient_privilege';
    end if;
    select 'agent', a.id, 'agent' into principal_kind, principal_id, role_name
      from public.agents a
     where a.id = p_principal_id and a.enabled and a.org_id = public.current_org();
    if found then return; end if;
    select 'human', p.id, p.role into principal_kind, principal_id, role_name
      from public.profiles p
     where p.id = p_principal_id;
    if found then return; end if;
    raise exception 'op spine: principal % is neither an enabled agent nor a profile', p_principal_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A signed-in caller. p_principal_id is ignored: nobody names someone else.
  v_uid := public.current_principal();
  role_name := public.current_role_name();
  if v_uid is null or role_name is null
     or role_name not in ('owner', 'office', 'crew_lead', 'crew', 'viewer', 'agent') then
    raise exception 'op spine: the caller has no role'
      using errcode = 'insufficient_privilege';
  end if;

  if role_name = 'agent' then
    select 'agent', a.id into principal_kind, principal_id
      from public.agents a
     where a.auth_user_id = v_uid and a.enabled and a.org_id = public.current_org();
    if not found then
      raise exception 'op spine: agent login % is not linked to an enabled agents row', v_uid
        using errcode = 'insufficient_privilege';
    end if;
    return;
  end if;

  principal_kind := 'human';
  principal_id := v_uid;
end;
$$;

alter function public.op_resolve_caller(uuid) owner to postgres;
comment on function public.op_resolve_caller(uuid) is
  'Internal to the op spine: resolves the calling principal (kind, id, target-vocabulary role). Service-role and postgres callers must name one; signed-in callers are themselves (03 §2.4, doc 09 §7.1).';
revoke all on function public.op_resolve_caller(uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. op_role_permits — the permission matrix of 0004, read as data.
--
-- Rows naming the operation itself beat the action-type wildcard ('money:*').
-- Among the rows at the winning level an explicit deny for the capability
-- wins. `execute` implies `propose`: whoever may do a thing may ask for it
-- (the seed gives the owner execute, not propose, on job/money/comms). An
-- UNCONDITIONAL `execute` row (conditions = {}) also implies `approve`: the
-- matrix of 03 §2.4 gives nobody an A on `job`, and the person who may move
-- a job themselves is the one who approves a crew member's request to. A
-- conditional execute row (drafts_only, pulls_only, crew-line kinds) implies
-- no approval. `approve` itself implies nothing. Scope ('division',
-- 'assigned', 'own') is recorded, not enforced, until job_assignments (P3).
-- ---------------------------------------------------------------------------
create or replace function public.op_role_permits(
  p_role text, p_operation text, p_action_type text, p_capability text
) returns boolean
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  with candidates as (
    select rp.allow, rp.capability,
           case when rp.operation = p_operation then 2 else 1 end as specificity
      from public.role_permissions rp
     where rp.org_id = public.current_org()
       and rp.role = p_role
       and rp.operation in (p_operation, p_action_type || ':*')
       and (rp.capability = p_capability
            or (p_capability = 'propose' and rp.capability = 'execute')
            or (p_capability = 'approve' and rp.capability = 'execute'
                and rp.conditions = '{}'::jsonb))
  ),
  winning as (
    select * from candidates
     where specificity = (select max(specificity) from candidates)
  )
  select coalesce(bool_or(allow), false)
     and not coalesce(bool_or(not allow and capability = p_capability), false)
    from winning;
$$;

alter function public.op_role_permits(text, text, text, text) owner to postgres;
comment on function public.op_role_permits(text, text, text, text) is
  'Internal to the op spine: does role_permissions allow this role this capability on this operation? Exact operation rows beat the action-type wildcard; an explicit deny wins; execute implies propose, and an unconditional execute implies approve.';
revoke all on function public.op_role_permits(text, text, text, text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 3. op_agent_permits — an agent needs BOTH the `agent` role ceiling and a
--    live agent_authority grant of its own. Every agent starts with no grant
--    (0004 seed), so today no agent may propose anything until the owner
--    grants it.
-- ---------------------------------------------------------------------------
create or replace function public.op_agent_permits(
  p_agent_id uuid, p_operation text, p_action_type text, p_capability text
) returns boolean
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select p_capability <> 'approve'
     and public.op_role_permits('agent', p_operation, p_action_type, p_capability)
     and exists (
       select 1 from public.agent_authority aa
        where aa.agent_id = p_agent_id
          and aa.org_id = public.current_org()
          and aa.operation in (p_operation, p_action_type || ':*')
          and (aa.capability = p_capability
               or (p_capability = 'propose' and aa.capability = 'execute'))
          and aa.revoked_at is null
          and (aa.expires_at is null or aa.expires_at > now())
     );
$$;

alter function public.op_agent_permits(uuid, text, text, text) owner to postgres;
comment on function public.op_agent_permits(uuid, text, text, text) is
  'Internal to the op spine: an agent may act only where the agent role ceiling AND its own live agent_authority row both allow. Never approve.';
revoke all on function public.op_agent_permits(uuid, text, text, text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. op_validate_input — the subset of JSON Schema the catalog uses.
--    Returns the list of problems; empty means valid.
-- ---------------------------------------------------------------------------
create or replace function public.op_validate_input(p_schema jsonb, p_input jsonb)
  returns text[]
  language plpgsql
  immutable
  set search_path to 'public', 'pg_temp'
as $$
declare
  problems text[] := '{}';
  k        text;
  prop     jsonb;
  v        jsonb;
  want     text;
  got      text;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    return array['input must be a JSON object'];
  end if;
  if p_schema is null or p_schema = '{}'::jsonb then
    return problems;
  end if;

  for k in select jsonb_array_elements_text(coalesce(p_schema -> 'required', '[]'::jsonb)) loop
    if not (p_input ? k) or jsonb_typeof(p_input -> k) = 'null' then
      problems := problems || format('%s is required', k);
    end if;
  end loop;

  if coalesce((p_schema ->> 'additionalProperties')::boolean, true) = false then
    for k in select jsonb_object_keys(p_input) loop
      if not (coalesce(p_schema -> 'properties', '{}'::jsonb) ? k) then
        problems := problems || format('%s is not a known field', k);
      end if;
    end loop;
  end if;

  for k, prop in select * from jsonb_each(coalesce(p_schema -> 'properties', '{}'::jsonb)) loop
    v := p_input -> k;
    continue when v is null or jsonb_typeof(v) = 'null';
    want := prop ->> 'type';
    got := jsonb_typeof(v);
    if want is not null and not (
         got = want
         or (want = 'integer' and got = 'number' and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric))
       ) then
      problems := problems || format('%s must be %s, got %s', k, want, got);
      continue;
    end if;
    if prop ? 'enum' and not (prop -> 'enum') @> jsonb_build_array(v) then
      problems := problems || format('%s must be one of %s', k, prop -> 'enum');
    end if;
    if got = 'string' and prop ? 'pattern' and not ((v #>> '{}') ~ (prop ->> 'pattern')) then
      problems := problems || format('%s does not match %s', k, prop ->> 'pattern');
    end if;
    if got = 'string' and prop ? 'maxLength' and length(v #>> '{}') > (prop ->> 'maxLength')::int then
      problems := problems || format('%s is longer than %s characters', k, prop ->> 'maxLength');
    end if;
  end loop;

  return problems;
end;
$$;

alter function public.op_validate_input(jsonb, jsonb) owner to postgres;
comment on function public.op_validate_input(jsonb, jsonb) is
  'Internal to the op spine: checks a proposal input against an operation_catalog.input_schema (type object, required, properties.type, enum, pattern, maxLength, additionalProperties false). pg_jsonschema is not installed.';
revoke all on function public.op_validate_input(jsonb, jsonb) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. op_render_key — an idempotency key from a catalog template.
--
--   {field}       the input value, as text
--   {md5:field}   md5 of the input value (long bodies, subjects)
--   {job_id}      the proposal's job
--   {day}         today's date in Alaska, so the same message can be sent
--                 again tomorrow but not twice today
--
-- No template: the operation plus an md5 of the input and job.
-- ---------------------------------------------------------------------------
create or replace function public.op_render_key(
  p_template text, p_operation text, p_input jsonb, p_job_id uuid
) returns text
  language plpgsql
  stable
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_key text := p_template;
  m     text[];
begin
  if p_template is null or btrim(p_template) = '' then
    return p_operation || ':' || md5(coalesce(p_input::text, '') || ':' || coalesce(p_job_id::text, ''));
  end if;

  v_key := replace(v_key, '{job_id}', coalesce(p_job_id::text, ''));
  v_key := replace(v_key, '{day}', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD'));

  for m in select regexp_matches(v_key, '\{md5:([a-z_]+)\}', 'g') loop
    v_key := replace(v_key, '{md5:' || m[1] || '}', md5(coalesce(p_input ->> m[1], '')));
  end loop;
  for m in select regexp_matches(v_key, '\{([a-z_]+)\}', 'g') loop
    v_key := replace(v_key, '{' || m[1] || '}', lower(btrim(coalesce(p_input ->> m[1], ''))));
  end loop;

  return v_key;
end;
$$;

alter function public.op_render_key(text, text, jsonb, uuid) owner to postgres;
comment on function public.op_render_key(text, text, jsonb, uuid) is
  'Internal to the op spine: renders operation_catalog.idempotency_template ({field}, {md5:field}, {job_id}, {day}) into a proposal idempotency key.';
revoke all on function public.op_render_key(text, text, jsonb, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 6. emit_event — the only writer of events.
--
-- A repeated idempotency_key returns the existing row's id instead of
-- raising, so a retried caller is a no-op (doc 09 §7.1). service_role only;
-- every op_* calls it from inside its own transaction.
-- ---------------------------------------------------------------------------
create or replace function public.emit_event(
  p_kind            text,
  p_operation       text    default null,
  p_aggregate_type  text    default null,
  p_aggregate_id    uuid    default null,
  p_job_id          uuid    default null,
  p_claim_id        uuid    default null,
  p_proposal_id     uuid    default null,
  p_data            jsonb   default '{}'::jsonb,
  p_idempotency_key text    default null,
  p_principal_kind  text    default 'system',
  p_principal_id    uuid    default null,
  p_correlation_id  uuid    default null,
  p_causation_id    bigint  default null
) returns bigint
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_id bigint;
begin
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'emit_event: kind is required';
  end if;

  insert into public.events
    (kind, operation, aggregate_type, aggregate_id, job_id, claim_id, proposal_id,
     data, idempotency_key, principal_kind, principal_id, correlation_id, causation_id)
  values
    (p_kind, p_operation, p_aggregate_type, p_aggregate_id, p_job_id, p_claim_id, p_proposal_id,
     coalesce(p_data, '{}'::jsonb), p_idempotency_key, coalesce(p_principal_kind, 'system'),
     p_principal_id, p_correlation_id, p_causation_id)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_id from public.events e where e.idempotency_key = p_idempotency_key;
  end if;
  return v_id;
end;
$$;

alter function public.emit_event(text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, uuid, uuid, bigint) owner to postgres;
comment on function public.emit_event(text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, uuid, uuid, bigint) is
  'The only writer of public.events. Idempotent on idempotency_key: a repeat returns the existing id. service_role only; op_* call it internally (doc 09 §7.1).';
revoke all on function public.emit_event(text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.emit_event(text, text, text, uuid, uuid, uuid, uuid, jsonb, text, text, uuid, uuid, bigint) to service_role;


-- ---------------------------------------------------------------------------
-- 7. op_expire_proposals — the expiry sweep.
--
-- The live spine has been jammed since July by proposals that expired and
-- were never marked so (03 §2). Here a stale proposal is marked expired, with
-- its event, at the top of every op_propose, which also frees its SMS code.
-- ---------------------------------------------------------------------------
create or replace function public.op_expire_proposals() returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    update public.proposals
       set status = 'expired'
     where status = 'proposed' and expires_at <= now()
    returning id, operation, job_id, claim_id
  loop
    perform public.emit_event(
      'proposal.expired', r.operation, 'proposal', r.id, r.job_id, r.claim_id, r.id,
      '{}'::jsonb, 'proposal.expired:' || r.id, 'system', null);
    n := n + 1;
  end loop;
  return n;
end;
$$;

alter function public.op_expire_proposals() owner to postgres;
comment on function public.op_expire_proposals() is
  'Marks proposals past expires_at as expired, one proposal.expired event each. Called at the top of op_propose; safe to schedule on pg_cron later.';
revoke all on function public.op_expire_proposals() from public, anon, authenticated;
grant execute on function public.op_expire_proposals() to service_role;


-- ---------------------------------------------------------------------------
-- 8. op_catalog_lookup — 'email.send@1' or 'email.send' (latest live version).
-- ---------------------------------------------------------------------------
create or replace function public.op_catalog_lookup(p_operation text)
  returns public.operation_catalog
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_name    text := split_part(p_operation, '@', 1);
  v_version text := nullif(split_part(p_operation, '@', 2), '');
  v_row     public.operation_catalog;
begin
  if v_version is not null and v_version !~ '^[0-9]+$' then
    raise exception 'op spine: bad operation reference %', p_operation;
  end if;
  select * into v_row
    from public.operation_catalog c
   where c.name = v_name
     and (v_version is null or c.version = v_version::int)
     and c.deprecated_at is null
   order by c.version desc
   limit 1;
  if not found then
    raise exception 'op spine: no live operation %', p_operation
      using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

alter function public.op_catalog_lookup(text) owner to postgres;
comment on function public.op_catalog_lookup(text) is
  'Internal to the op spine: resolves name or name@version to its live operation_catalog row.';
revoke all on function public.op_catalog_lookup(text) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 9. op_propose — file a proposal.
-- ---------------------------------------------------------------------------
create or replace function public.op_propose(
  p_operation     text,
  p_input         jsonb,
  p_job_id        uuid    default null,
  p_claim_id      uuid    default null,
  p_rationale     text    default null,
  p_evidence_refs jsonb   default '[]'::jsonb,
  p_proposed_via  text    default 'ui',
  p_principal_id  uuid    default null,
  p_expires_in    interval default interval '24 hours'
) returns public.proposals
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_caller   record;
  v_op       public.operation_catalog;
  v_opref    text;
  v_problems text[];
  v_key      text;
  v_row      public.proposals;
  v_policy   public.approval_policies;
  v_assigned text;
  v_code     integer;
  v_job      uuid;
  v_tries    integer := 0;
begin
  select * into v_caller from public.op_resolve_caller(p_principal_id);
  v_op := public.op_catalog_lookup(p_operation);
  v_opref := v_op.name || '@' || v_op.version;

  -- approve and decline are what you do TO a proposal, never something you propose
  if v_op.name in ('proposal.approve', 'proposal.decline') then
    raise exception 'op spine: % is not proposable; call op_proposal_% directly',
      v_op.name, split_part(v_op.name, '.', 2);
  end if;

  if v_caller.principal_kind = 'agent' then
    if not public.op_agent_permits(v_caller.principal_id, v_op.name, v_op.action_type, 'propose') then
      raise exception 'op spine: agent % may not propose %', v_caller.principal_id, v_opref
        using errcode = 'insufficient_privilege';
    end if;
  elsif not public.op_role_permits(v_caller.role_name, v_op.name, v_op.action_type, 'propose') then
    raise exception 'op spine: role % may not propose %', v_caller.role_name, v_opref
      using errcode = 'insufficient_privilege';
  end if;

  v_problems := public.op_validate_input(v_op.input_schema, p_input);
  if array_length(v_problems, 1) is not null then
    raise exception 'op spine: % input is invalid: %', v_opref, array_to_string(v_problems, '; ')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_proposed_via not in ('ui', 'chip', 'agent', 'cron', 'sms', 'mcp', 'voice') then
    raise exception 'op spine: unknown proposed_via %', p_proposed_via
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expires_in is null or p_expires_in <= interval '0' or p_expires_in > interval '30 days' then
    raise exception 'op spine: expiry must be between now and 30 days';
  end if;

  v_job := coalesce(p_job_id, nullif(p_input ->> 'job_id', '')::uuid);
  v_key := public.op_render_key(v_op.idempotency_template, v_op.name, p_input, v_job);

  -- the same request twice is the same proposal
  select * into v_row from public.proposals where idempotency_key = v_key;
  if found then
    return v_row;
  end if;

  perform public.op_expire_proposals();

  -- who it waits on: the most specific active policy, else the catalog default
  select * into v_policy
    from public.approval_policies ap
   where ap.org_id = public.current_org()
     and ap.active
     and ap.action_type = v_op.action_type
     and (ap.operation is null or ap.operation in (v_op.name, v_opref))
     and ap.division_id is null
   order by (ap.operation is not null) desc, ap.created_at
   limit 1;
  v_assigned := coalesce(v_policy.approver_role,
                         nullif(v_op.approval_default, 'auto'),
                         'owner');

  -- a code unique among live proposals, so "YES 12" stays two digits
  loop
    v_tries := v_tries + 1;
    v_code := nextval('public.proposals_sms_code_seq');
    continue when exists (select 1 from public.proposals
                           where status = 'proposed' and sms_code = v_code
                             and org_id = public.current_org())
              and v_tries < 10000;
    begin
      insert into public.proposals
        (operation, action_type, input, input_schema_hash,
         proposed_by_kind, proposed_by_id, proposed_via,
         rationale, evidence_refs, job_id, claim_id,
         assigned_role, sms_code, expires_at, idempotency_key)
      values
        (v_opref, v_op.action_type, p_input, md5(v_op.input_schema::text),
         v_caller.principal_kind, v_caller.principal_id, p_proposed_via,
         p_rationale, coalesce(p_evidence_refs, '[]'::jsonb), v_job, p_claim_id,
         v_assigned, v_code, now() + p_expires_in, v_key)
      returning * into v_row;
      exit;
    exception when unique_violation then
      -- a concurrent caller filed the same request: theirs is ours
      select * into v_row from public.proposals where idempotency_key = v_key;
      if found then
        return v_row;
      end if;
      -- otherwise the SMS code was taken between the check and the insert
      if v_tries >= 10000 then
        raise;
      end if;
    end;
  end loop;

  perform public.emit_event(
    'proposal.created', v_opref, 'proposal', v_row.id, v_row.job_id, v_row.claim_id, v_row.id,
    jsonb_build_object('action_type', v_row.action_type, 'assigned_role', v_row.assigned_role,
                       'sms_code', v_row.sms_code, 'proposed_via', v_row.proposed_via),
    'proposal.created:' || v_row.id, v_caller.principal_kind, v_caller.principal_id);

  return v_row;
end;
$$;

alter function public.op_propose(text, jsonb, uuid, uuid, text, jsonb, text, uuid, interval) owner to postgres;
comment on function public.op_propose(text, jsonb, uuid, uuid, text, jsonb, text, uuid, interval) is
  'Files a proposal: catalog lookup, input check, propose permission (role_permissions; agents also need agent_authority), approver routing from approval_policies, a live-unique SMS code, and a proposal.created event. A repeated idempotency key returns the existing row. Does nothing else: a proposal is inert until approved (03 §2.1, doc 09 §7.1).';
revoke all on function public.op_propose(text, jsonb, uuid, uuid, text, jsonb, text, uuid, interval) from public, anon, authenticated;
grant execute on function public.op_propose(text, jsonb, uuid, uuid, text, jsonb, text, uuid, interval) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 10. op_check_approver — the authority test approve and decline share.
-- ---------------------------------------------------------------------------
create or replace function public.op_check_approver(p_proposal public.proposals, p_caller record)
  returns void
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_name text := split_part(p_proposal.operation, '@', 1);
begin
  if p_caller.principal_kind = 'agent' then
    raise exception 'op spine: an agent never approves or declines (proposal %)', p_proposal.id
      using errcode = 'insufficient_privilege';
  end if;

  if not public.op_role_permits(p_caller.role_name, v_name, p_proposal.action_type, 'approve') then
    raise exception 'op spine: role % may not approve %', p_caller.role_name, p_proposal.operation
      using errcode = 'insufficient_privilege';
  end if;

  if p_caller.role_name <> 'owner'
     and p_proposal.assigned_role is not null
     and p_caller.role_name <> p_proposal.assigned_role then
    raise exception 'op spine: proposal % waits on %, not %',
      p_proposal.id, p_proposal.assigned_role, p_caller.role_name
      using errcode = 'insufficient_privilege';
  end if;

  if p_caller.role_name <> 'owner'
     and p_proposal.action_type in ('money', 'comms', 'external')
     and p_proposal.proposed_by_id = p_caller.principal_id then
    raise exception 'op spine: % may not approve their own % proposal', p_caller.principal_id, p_proposal.action_type
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

alter function public.op_check_approver(public.proposals, record) owner to postgres;
comment on function public.op_check_approver(public.proposals, record) is
  'Internal to the op spine: refuses agents, roles without approve, roles other than the one the proposal waits on (the owner excepted), and self-approval of money/comms/external by anyone but the owner.';
revoke all on function public.op_check_approver(public.proposals, record) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 11. op_execute — run an approved proposal's operation inline.
--
-- The body is op_exec_<name with dots as underscores>(proposal, params,
-- principal_kind, principal_id) → jsonb, shipped by the migration that adds
-- the operation (0014 adds the first ones). A failure inside the body rolls
-- back the body's own writes and leaves the proposal `failed` with the error,
-- and the approval still stands: "who approved" is never lost to a bad body.
-- ---------------------------------------------------------------------------
create or replace function public.op_execute(
  p_proposal_id uuid, p_principal_kind text, p_principal_id uuid
) returns public.proposals
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row    public.proposals;
  v_fname  text;
  v_params jsonb;
  v_result jsonb;
  v_event  bigint;
  v_err    text;
begin
  select * into v_row from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'op spine: no proposal %', p_proposal_id;
  end if;
  if v_row.status in ('executed', 'failed') then
    return v_row;
  end if;
  if v_row.status not in ('approved', 'executing') then
    raise exception 'op spine: proposal % is %, not approved', v_row.id, v_row.status;
  end if;

  v_fname := 'op_exec_' || replace(split_part(v_row.operation, '@', 1), '.', '_');
  if to_regprocedure(format('public.%I(public.proposals, jsonb, text, uuid)', v_fname)) is null then
    raise exception 'op spine: % has no executor', v_row.operation;
  end if;

  update public.proposals set status = 'executing' where id = v_row.id;
  v_params := v_row.input || coalesce(v_row.edited_params, '{}'::jsonb);

  begin
    execute format('select public.%I($1, $2, $3, $4)', v_fname)
       into v_result
      using v_row, v_params, p_principal_kind, p_principal_id;

    v_event := public.emit_event(
      'proposal.executed', v_row.operation, 'proposal', v_row.id, v_row.job_id, v_row.claim_id, v_row.id,
      coalesce(v_result, '{}'::jsonb), 'proposal.executed:' || v_row.id, p_principal_kind, p_principal_id);

    update public.proposals
       set status = 'executed', result = v_result, executed_event_id = v_event, error = null
     where id = v_row.id
    returning * into v_row;
  exception when others then
    get stacked diagnostics v_err = message_text;
    v_event := public.emit_event(
      'proposal.failed', v_row.operation, 'proposal', v_row.id, v_row.job_id, v_row.claim_id, v_row.id,
      jsonb_build_object('error', v_err), 'proposal.failed:' || v_row.id, p_principal_kind, p_principal_id);
    update public.proposals
       set status = 'failed', error = v_err, executed_event_id = v_event
     where id = v_row.id
    returning * into v_row;
  end;

  return v_row;
end;
$$;

alter function public.op_execute(uuid, text, uuid) owner to postgres;
comment on function public.op_execute(uuid, text, uuid) is
  'Runs an approved proposal through its op_exec_<name> body: executing → executed (with result and a proposal.executed event) or failed (with the error and a proposal.failed event). The worker calls it for runtime=worker operations.';
revoke all on function public.op_execute(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.op_execute(uuid, text, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 12. op_proposal_approve — approve, then execute or queue.
--
-- Callable by the Approvals inbox (a signed-in owner) and by roybal-webhooks
-- for "YES 12" (service role, naming the owner's profile id), so an approval
-- records without the worker running (03 §7.3).
-- ---------------------------------------------------------------------------
create or replace function public.op_proposal_approve(
  p_proposal_id   uuid,
  p_via           text  default 'inbox',
  p_second_factor text  default null,
  p_edited_params jsonb default null,
  p_principal_id  uuid  default null
) returns public.proposals
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_caller   record;
  v_row      public.proposals;
  v_op       public.operation_catalog;
  v_problems text[];
  v_job      public.jobs_queue;
begin
  select * into v_caller from public.op_resolve_caller(p_principal_id);

  select * into v_row from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'op spine: no proposal %', p_proposal_id using errcode = 'no_data_found';
  end if;

  perform public.op_check_approver(v_row, v_caller);

  -- approving twice is approving once
  if v_row.status in ('approved', 'executing', 'executed', 'failed') then
    return v_row;
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'op spine: proposal % is %', v_row.id, v_row.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A stale row is refused here and marked expired by the next op_propose's
  -- sweep (a raise would undo any marking done in this call).
  if v_row.expires_at <= now() then
    raise exception 'op spine: proposal % expired at %', v_row.id, v_row.expires_at
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_via not in ('inbox', 'chip', 'sms', 'override', 'voice') then
    raise exception 'op spine: unknown approval channel %', p_via
      using errcode = 'invalid_parameter_value';
  end if;

  v_op := public.op_catalog_lookup(v_row.operation);
  if p_edited_params is not null then
    v_problems := public.op_validate_input(v_op.input_schema, v_row.input || p_edited_params);
    if array_length(v_problems, 1) is not null then
      raise exception 'op spine: edited input is invalid: %', array_to_string(v_problems, '; ')
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  update public.proposals
     set status = 'approved',
         approved_by_kind = v_caller.principal_kind,
         approved_by_ref = v_caller.principal_id,
         approved_via = p_via,
         second_factor = p_second_factor,
         approved_at = now(),
         edited_params = p_edited_params
   where id = v_row.id
  returning * into v_row;

  perform public.emit_event(
    'proposal.approved', v_row.operation, 'proposal', v_row.id, v_row.job_id, v_row.claim_id, v_row.id,
    jsonb_build_object('via', p_via, 'edited', p_edited_params is not null),
    'proposal.approved:' || v_row.id, v_caller.principal_kind, v_caller.principal_id);

  if v_op.runtime = 'sql' then
    v_row := public.op_execute(v_row.id, v_caller.principal_kind, v_caller.principal_id);
  else
    v_job := public.enqueue(
      'proposal.execute', jsonb_build_object('proposal_id', v_row.id),
      'proposal.execute:' || v_row.id, now(), 0,
      v_caller.principal_kind, v_caller.principal_id, v_row.job_id, v_row.id);
    update public.proposals set execution_job_id = v_job.id
     where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

alter function public.op_proposal_approve(uuid, text, text, jsonb, uuid) owner to postgres;
comment on function public.op_proposal_approve(uuid, text, text, jsonb, uuid) is
  'Approves a proposal (agents never; approve permission; the routed role or the owner; no self-approval of money/comms/external except the owner), emits proposal.approved, then executes inline (runtime sql) or queues proposal.execute (runtime worker). Approving twice returns the same row (doc 09 §7.1).';
revoke all on function public.op_proposal_approve(uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.op_proposal_approve(uuid, text, text, jsonb, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 13. op_proposal_decline
-- ---------------------------------------------------------------------------
create or replace function public.op_proposal_decline(
  p_proposal_id  uuid,
  p_reason       text default null,
  p_principal_id uuid default null
) returns public.proposals
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_caller record;
  v_row    public.proposals;
begin
  select * into v_caller from public.op_resolve_caller(p_principal_id);

  select * into v_row from public.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'op spine: no proposal %', p_proposal_id using errcode = 'no_data_found';
  end if;

  perform public.op_check_approver(v_row, v_caller);

  if v_row.status = 'declined' then
    return v_row;
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'op spine: proposal % is %; only a proposed row can be declined', v_row.id, v_row.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.proposals
     set status = 'declined', decline_reason = left(p_reason, 2000)
   where id = v_row.id
  returning * into v_row;

  perform public.emit_event(
    'proposal.declined', v_row.operation, 'proposal', v_row.id, v_row.job_id, v_row.claim_id, v_row.id,
    jsonb_build_object('reason', v_row.decline_reason),
    'proposal.declined:' || v_row.id, v_caller.principal_kind, v_caller.principal_id);

  return v_row;
end;
$$;

alter function public.op_proposal_decline(uuid, text, uuid) owner to postgres;
comment on function public.op_proposal_decline(uuid, text, uuid) is
  'Declines a proposed row under the same authority test as approval; emits proposal.declined. Declining twice returns the same row.';
revoke all on function public.op_proposal_decline(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.op_proposal_decline(uuid, text, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 14. enqueue — the only writer of jobs_queue. A repeated key returns the
--     existing row. service_role only for now; doc 09 lets authenticated
--     enqueue kinds role_permissions allows, and no such kind exists yet.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue(
  p_kind            text,
  p_payload         jsonb       default '{}'::jsonb,
  p_idempotency_key text        default null,
  p_run_after       timestamptz default now(),
  p_priority        integer     default 0,
  p_principal_kind  text        default 'system',
  p_principal_id    uuid        default null,
  p_job_id          uuid        default null,
  p_correlation_id  uuid        default null
) returns public.jobs_queue
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row public.jobs_queue;
  v_key text := coalesce(p_idempotency_key, p_kind || ':' || md5(coalesce(p_payload::text, '')));
begin
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'enqueue: kind is required';
  end if;

  insert into public.jobs_queue
    (kind, payload, idempotency_key, run_after, priority, principal_kind, principal_id, job_id, correlation_id)
  values
    (p_kind, coalesce(p_payload, '{}'::jsonb), v_key, coalesce(p_run_after, now()), coalesce(p_priority, 0),
     coalesce(p_principal_kind, 'system'), p_principal_id, p_job_id, p_correlation_id)
  on conflict (idempotency_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.jobs_queue where idempotency_key = v_key;
  else
    perform public.emit_event(
      'job.queued', null, 'jobs_queue', v_row.id, v_row.job_id, null, null,
      jsonb_build_object('kind', v_row.kind), 'job.queued:' || v_row.id,
      v_row.principal_kind, v_row.principal_id, v_row.correlation_id);
  end if;
  return v_row;
end;
$$;

alter function public.enqueue(text, jsonb, text, timestamptz, integer, text, uuid, uuid, uuid) owner to postgres;
comment on function public.enqueue(text, jsonb, text, timestamptz, integer, text, uuid, uuid, uuid) is
  'The only writer of public.jobs_queue; idempotent on idempotency_key. The target of every pg_cron row, which stays SQL-only (doc 09 §7.1).';
revoke all on function public.enqueue(text, jsonb, text, timestamptz, integer, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue(text, jsonb, text, timestamptz, integer, text, uuid, uuid, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 15. claim_job — the worker's lease.
--
-- Takes the highest-priority due row of the given kinds (queued, or failed
-- and due for retry), skipping rows another worker holds, and stamps the lease
-- as columns. Returns no row when nothing is due.
-- ---------------------------------------------------------------------------
create or replace function public.claim_job(
  p_worker_id     text,
  p_kinds         text[]  default null,
  p_lease_seconds integer default 300
) returns setof public.jobs_queue
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'claim_job: worker id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'claim_job: lease must be between 10 and 3600 seconds';
  end if;

  return query
  update public.jobs_queue q
     set status = 'leased',
         locked_by = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         attempts = q.attempts + 1
   where q.id = (
           select c.id
             from public.jobs_queue c
            where c.status in ('queued', 'failed')
              and c.run_after <= now()
              and c.attempts < c.max_attempts
              and (p_kinds is null or c.kind = any (p_kinds))
            order by c.priority desc, c.run_after
            for update skip locked
            limit 1
         )
  returning q.*;
end;
$$;

alter function public.claim_job(text, text[], integer) owner to postgres;
comment on function public.claim_job(text, text[], integer) is
  'Leases one due jobs_queue row (queued, or failed and due) by UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED), lease as columns so it outlives the transaction. service_role only (03 §2.2, doc 09 §7.1).';
revoke all on function public.claim_job(text, text[], integer) from public, anon, authenticated;
grant execute on function public.claim_job(text, text[], integer) to service_role;
