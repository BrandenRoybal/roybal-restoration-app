-- ============================================================================
-- 0014 — the first five operations on the spine of 0013
--
-- docs/architecture/09-ROLE-ENUM-AND-OPERATION-CATALOG.md §7.2:
--
--   operation          action_type  runtime  emits
--   proposal.approve   admin        sql      proposal.approved
--   proposal.decline   admin        sql      proposal.declined
--   email.send         comms        sql      email.queued
--   sms.send           comms        sql      sms.queued
--   job.set_stage      job          sql      job.stage_set
--
-- One departure from doc 09's table, deliberate: email.send and sms.send are
-- runtime 'sql', not 'worker'. Their execution IS the outbox row ("write an
-- outbox row and nothing else; the worker delivers it", §7.2), and §7.4 asks
-- that an approval reach events AND an outbox row with no worker running. A
-- worker-runtime op would wait in jobs_queue for a worker that does not exist
-- yet; a sql-runtime op writes the outbox row inside the approval. Delivery —
-- the part that talks to Gmail and Twilio — is the worker's outbox deliverer,
-- and nothing in this migration sends anything.
--
-- WHAT THIS CHANGES TODAY: five rows in operation_catalog and three executor
-- functions. Nothing calls op_propose yet, so no outbox row is written and no
-- job's stage changes until a later PR wires a caller. Every agent still holds
-- no agent_authority grant, so no agent can propose any of these.
--
-- THE CATALOG IS SEEDED HERE. 0004 says operation_catalog is published by CI
-- from packages/domain/ops; neither exists yet. These rows are what that
-- publisher will emit for the five operations, and definition_sha is an md5
-- of name, version and schema until the publisher writes its own.
--
-- QUIET HOURS. sms.send never queues a text for delivery outside the window in
-- role_permissions.conditions.quiet_hours (0004 seeds 07:00–20:00
-- America/Anchorage on the comms rows): outside it the outbox row waits until
-- the window opens. One predicate, read from data (doc 09 §7.2).
--
-- IDEMPOTENCY. Each key carries the Alaska date ({day}), so a double tap or a
-- retried "YES 12" files once, while the same reminder can be sent again on a
-- later day. job.set_stage to the same stage twice in one day is one proposal.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The catalog rows.
-- ---------------------------------------------------------------------------
insert into public.operation_catalog
  (name, version, action_type, description, input_schema, runtime, approval_default,
   amount_field, emits, idempotency_template, definition_sha)
select c.name, 1, c.action_type, c.description, c.input_schema::jsonb, 'sql', 'owner',
       null, c.emits, c.idempotency_template,
       md5(c.name || '@1:' || c.input_schema::jsonb::text)
  from (values
    ('proposal.approve', 'admin',
     'Approve a proposal. Called directly (op_proposal_approve), never proposed.',
     '{"type": "object", "required": ["proposal_id"], "additionalProperties": false,
       "properties": {"proposal_id": {"type": "string"}, "edited_params": {"type": "object"}}}',
     array['proposal.approved'], 'proposal.approve:{proposal_id}'),

    ('proposal.decline', 'admin',
     'Decline a proposal. Called directly (op_proposal_decline), never proposed.',
     '{"type": "object", "required": ["proposal_id"], "additionalProperties": false,
       "properties": {"proposal_id": {"type": "string"}, "reason": {"type": "string", "maxLength": 2000}}}',
     array['proposal.declined'], 'proposal.decline:{proposal_id}'),

    ('email.send', 'comms',
     'Send one email. Execution writes one outbox row; the worker delivers it through Gmail.',
     '{"type": "object", "required": ["to", "subject", "body"], "additionalProperties": false,
       "properties": {
         "to":           {"type": "string", "maxLength": 320, "pattern": "^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$"},
         "cc":           {"type": "string", "maxLength": 1000},
         "subject":      {"type": "string", "maxLength": 300},
         "body":         {"type": "string", "maxLength": 100000},
         "thread_id":    {"type": "string", "maxLength": 200},
         "document_ref": {"type": "string", "maxLength": 500}}}',
     array['email.queued'], 'email.send:{to}:{md5:subject}:{md5:body}:{job_id}:{day}'),

    ('sms.send', 'comms',
     'Send one text message. Execution writes one outbox row, held until quiet hours end; the worker delivers it through Twilio.',
     '{"type": "object", "required": ["to", "body"], "additionalProperties": false,
       "properties": {
         "to":   {"type": "string", "pattern": "^\\+[1-9][0-9]{7,14}$"},
         "body": {"type": "string", "maxLength": 1600},
         "kind": {"type": "string", "maxLength": 40}}}',
     array['sms.queued'], 'sms.send:{to}:{md5:body}:{day}'),

    ('job.set_stage', 'job',
     'Move a job on the board to another stage (coordination_jobs.data.stage).',
     '{"type": "object", "required": ["job_id", "stage"], "additionalProperties": false,
       "properties": {
         "job_id": {"type": "string", "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},
         "stage":  {"type": "string", "enum": ["lead", "scheduled", "in_progress", "on_hold", "final", "done"]}}}',
     array['job.stage_set'], 'job.set_stage:{job_id}:{stage}:{day}')
  ) as c(name, action_type, description, input_schema, emits, idempotency_template)
on conflict (name, version) do nothing;


-- ---------------------------------------------------------------------------
-- 2. op_quiet_hours_release — when a text may go out, given the comms
--    quiet-hours condition in role_permissions.
-- ---------------------------------------------------------------------------
create or replace function public.op_quiet_hours_release(p_at timestamptz default now())
  returns timestamptz
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_qh    jsonb;
  v_tz    text;
  v_start time;
  v_end   time;
  v_local timestamp;
begin
  select rp.conditions -> 'quiet_hours' into v_qh
    from public.role_permissions rp
   where rp.org_id = public.current_org()
     and rp.operation = 'comms:*'
     and rp.conditions ? 'quiet_hours'
   order by rp.role
   limit 1;

  v_tz    := coalesce(v_qh ->> 'tz', 'America/Anchorage');
  v_start := coalesce((v_qh ->> 'start')::time, time '07:00');
  v_end   := coalesce((v_qh ->> 'end')::time, time '20:00');
  v_local := p_at at time zone v_tz;

  if v_local::time >= v_start and v_local::time < v_end then
    return p_at;
  elsif v_local::time < v_start then
    return (v_local::date + v_start) at time zone v_tz;
  else
    return (v_local::date + 1 + v_start) at time zone v_tz;
  end if;
end;
$$;

alter function public.op_quiet_hours_release(timestamptz) owner to postgres;
comment on function public.op_quiet_hours_release(timestamptz) is
  'The earliest time a text may be delivered: p_at inside the comms quiet-hours window of role_permissions (default 07:00–20:00 America/Anchorage), else the next window opening.';
revoke all on function public.op_quiet_hours_release(timestamptz) from public, anon, authenticated;
grant execute on function public.op_quiet_hours_release(timestamptz) to service_role;


-- ---------------------------------------------------------------------------
-- 3. The executors. Each is called only by op_execute (0013), inside the
--    approval, as postgres; none is granted to anyone.
-- ---------------------------------------------------------------------------
create or replace function public.op_exec_email_send(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_outbox uuid;
begin
  insert into public.outbox
    (channel, operation, payload, idempotency_key, principal_kind, principal_id, proposal_id, job_id)
  values
    ('email', p_proposal.operation, p_params, 'outbox:' || p_proposal.idempotency_key,
     p_principal_kind, p_principal_id, p_proposal.id, p_proposal.job_id)
  on conflict (idempotency_key) do nothing
  returning id into v_outbox;

  if v_outbox is null then
    select id into v_outbox from public.outbox where idempotency_key = 'outbox:' || p_proposal.idempotency_key;
  end if;

  perform public.emit_event(
    'email.queued', p_proposal.operation, 'outbox', v_outbox, p_proposal.job_id, p_proposal.claim_id, p_proposal.id,
    jsonb_build_object('to', p_params ->> 'to', 'subject', p_params ->> 'subject'),
    'email.queued:' || v_outbox, p_principal_kind, p_principal_id);

  return jsonb_build_object('outbox_id', v_outbox);
end;
$$;

alter function public.op_exec_email_send(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_email_send(public.proposals, jsonb, text, uuid) is
  'Executor for email.send@1: one outbox row (channel email) keyed on the proposal, plus email.queued. Sends nothing; the worker delivers.';
revoke all on function public.op_exec_email_send(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


create or replace function public.op_exec_sms_send(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_outbox  uuid;
  v_release timestamptz := public.op_quiet_hours_release(now());
begin
  insert into public.outbox
    (channel, operation, payload, idempotency_key, principal_kind, principal_id, proposal_id, job_id, next_attempt_at)
  values
    ('sms', p_proposal.operation, p_params, 'outbox:' || p_proposal.idempotency_key,
     p_principal_kind, p_principal_id, p_proposal.id, p_proposal.job_id, v_release)
  on conflict (idempotency_key) do nothing
  returning id into v_outbox;

  if v_outbox is null then
    select id into v_outbox from public.outbox where idempotency_key = 'outbox:' || p_proposal.idempotency_key;
  end if;

  perform public.emit_event(
    'sms.queued', p_proposal.operation, 'outbox', v_outbox, p_proposal.job_id, p_proposal.claim_id, p_proposal.id,
    jsonb_build_object('to', p_params ->> 'to', 'kind', p_params ->> 'kind', 'not_before', v_release),
    'sms.queued:' || v_outbox, p_principal_kind, p_principal_id);

  return jsonb_build_object('outbox_id', v_outbox, 'not_before', v_release);
end;
$$;

alter function public.op_exec_sms_send(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_sms_send(public.proposals, jsonb, text, uuid) is
  'Executor for sms.send@1: one outbox row (channel sms) held until the quiet-hours window opens, plus sms.queued. Sends nothing; the worker delivers.';
revoke all on function public.op_exec_sms_send(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


create or replace function public.op_exec_job_set_stage(
  p_proposal public.proposals, p_params jsonb, p_principal_kind text, p_principal_id uuid
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_job   uuid := (p_params ->> 'job_id')::uuid;
  v_stage text := p_params ->> 'stage';
  v_prev  text;
  v_data  jsonb;
begin
  select data ->> 'stage' into v_prev
    from public.coordination_jobs
   where id = v_job and deleted = false;
  if not found then
    raise exception 'job.set_stage: no live job %', v_job;
  end if;

  -- The board's own rev-bumping patch, so an open board adopts the change
  -- instead of overwriting it. It refuses (null) a signed-in caller whose role
  -- may not edit the board.
  v_data := public.coordination_job_patch(v_job, jsonb_build_object('stage', v_stage));
  if v_data is null then
    raise exception 'job.set_stage: the board refused the change for job %', v_job;
  end if;

  perform public.emit_event(
    'job.stage_set', p_proposal.operation, 'coordination_job', v_job, v_job, p_proposal.claim_id, p_proposal.id,
    jsonb_build_object('from', v_prev, 'to', v_stage, 'rev', v_data -> 'rev'),
    'job.stage_set:' || p_proposal.id, p_principal_kind, p_principal_id);

  return jsonb_build_object('job_id', v_job, 'from', v_prev, 'to', v_stage);
end;
$$;

alter function public.op_exec_job_set_stage(public.proposals, jsonb, text, uuid) owner to postgres;
comment on function public.op_exec_job_set_stage(public.proposals, jsonb, text, uuid) is
  'Executor for job.set_stage@1: patches coordination_jobs.data.stage through coordination_job_patch (rev-bumped, so the board adopts it) and emits job.stage_set with from/to.';
revoke all on function public.op_exec_job_set_stage(public.proposals, jsonb, text, uuid) from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. Every catalog operation that can be proposed has an executor. A future
--    migration that adds a catalog row without its op_exec_ body fails here.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select name from public.operation_catalog
     where deprecated_at is null and runtime = 'sql'
       and name not in ('proposal.approve', 'proposal.decline')
  loop
    if to_regprocedure(format('public.%I(public.proposals, jsonb, text, uuid)',
                              'op_exec_' || replace(r.name, '.', '_'))) is null then
      raise exception 'ops: % has no op_exec_ executor', r.name;
    end if;
  end loop;
end
$$;
