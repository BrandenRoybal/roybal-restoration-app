-- ============================================================================
-- 0015 — the worker's half of the spine.
--
-- 0013 gave the spine claim_job: a worker can lease a jobs_queue row. Nothing
-- could finish one, nothing swept a lease a dead worker left behind, and the
-- outbox had no lease at all — an outbox row was a fact with no one to deliver
-- it. This migration is everything a worker process needs from the database
-- and nothing a user ever calls:
--
--   worker_heartbeats       one row per worker process, refreshed every 30 s
--   outbox.locked_by,       the outbox lease, the same shape as jobs_queue's
--   outbox.lease_until,
--   outbox.max_attempts
--   worker_heartbeat()      upsert the heartbeat, extend every lease this worker
--                           holds, record where the edge functions live
--   finish_job()            done | failed (backoff) | dead
--   sweep_leases()          requeue what an expired lease left behind (pg_cron,
--                           every minute)
--   outbox_claim()          lease due outbox rows, FOR UPDATE SKIP LOCKED
--   outbox_sent()           sent, with the provider id, emits <channel>.sent
--   outbox_failed()         failed (backoff; texts wait for the quiet-hours
--                           window) | dead, emits <channel>.failed / .dead
--   worker_liveness_check() the dead-worker alarm (pg_cron, every 5 minutes):
--                           no heartbeat for 10 minutes → one POST to the
--                           roybal-webhooks/alert edge function, which texts
--                           the owner; guarded to one alarm per 24 h
--   worker_alert_secret()   the shared secret that POST carries, for the edge
--                           function to compare (service_role only)
--
-- Exactly-once is a database property here, not a promise the process makes:
-- a row is leased by exactly one worker (SKIP LOCKED + lease columns), a sent
-- row can never be claimed again (status), and a worker that dies mid-send
-- leaves a lease that expires into a RETRY whose adapter first looks for the
-- provider record the dead attempt may already have written (sms_messages /
-- email_messages tagged `outbox:<id>`), adopting it instead of resending.
--
-- Everything is service_role only. ALTER DEFAULT PRIVILEGES in the baseline
-- hands anon and authenticated EXECUTE on every new function and ALL on every
-- new table, so each object below is followed by the explicit revoke.
--
-- Census (db-replay.yml): +1 table, +1 policy, +1 primary key, +8 functions.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. worker_heartbeats — one row per worker process.
--
-- matrix: worker_heartbeats | owner: r | office: r | everyone else: -
-- ---------------------------------------------------------------------------
create table if not exists public.worker_heartbeats (
  worker_id       text primary key,
  org_id          uuid not null default 'eee3437b-c705-4459-bd5b-4ac2dc5d2fdb'::uuid,
  version         text,
  started_at      timestamptz not null default now(),
  at              timestamptz not null default now(),
  queue_depth     integer,
  leased          integer,
  outbox_pending  integer,
  meta            jsonb not null default '{}'::jsonb
);

alter table public.worker_heartbeats owner to postgres;
comment on table public.worker_heartbeats is
  'One row per worker process (services/worker), upserted by worker_heartbeat() every 30 s. worker_liveness_check() reads max(at); 10 minutes of silence is the alarm (03 §2.2).';

alter table public.worker_heartbeats enable row level security;
revoke all on public.worker_heartbeats from public, anon, authenticated;
grant select on public.worker_heartbeats to authenticated;
grant all on public.worker_heartbeats to service_role;

drop policy if exists worker_heartbeats_read_admin on public.worker_heartbeats;
create policy worker_heartbeats_read_admin on public.worker_heartbeats
  for select to authenticated
  using (org_id = (select public.current_org())
         and (select public.current_role_name()) in ('owner', 'office'));


-- ---------------------------------------------------------------------------
-- 2. The outbox lease: the same shape as jobs_queue's, for the same reason —
--    FOR UPDATE SKIP LOCKED releases at commit, and the send happens outside
--    the transaction.
--
--    pending → sending → sent | failed (retry: next_attempt_at = now() +
--                                      2^attempts min, capped at 1 h; texts
--                                      moved into the quiet-hours window)
--                      | dead  (attempts ≥ max_attempts, or a permanent
--                               provider refusal: a bad address or number)
-- ---------------------------------------------------------------------------
alter table public.outbox add column if not exists locked_by    text;
alter table public.outbox add column if not exists lease_until  timestamptz;
alter table public.outbox add column if not exists max_attempts integer not null default 6;

-- No row has ever been in `sending` (nothing could claim one before this
-- migration), but a stray would break the constraint below; park it instead.
update public.outbox set status = 'pending' where status = 'sending' and locked_by is null;

alter table public.outbox drop constraint if exists outbox_lease_recorded;
alter table public.outbox add constraint outbox_lease_recorded check (
  status <> 'sending' or (locked_by is not null and lease_until is not null)
);

create index if not exists outbox_lease_idx
  on public.outbox (lease_until)
  where status = 'sending';

comment on column public.outbox.locked_by is 'Worker id holding the send lease; set by outbox_claim(), cleared by outbox_sent()/outbox_failed()/sweep_leases().';
comment on column public.outbox.lease_until is 'When the send lease expires; sweep_leases() turns an expired sending row into a retry.';
comment on column public.outbox.max_attempts is 'Attempts before the row is dead (default 6: about an hour of backoff).';


-- ---------------------------------------------------------------------------
-- 3. worker_heartbeat — the worker checks in. Upserts its row, extends every
--    lease it holds (so a long send never loses its row to the sweeper while
--    the process is alive), and records the edge functions' base URL so the
--    liveness check knows where to POST — per project, with no owner step.
-- ---------------------------------------------------------------------------
create or replace function public.worker_heartbeat(
  p_worker_id      text,
  p_version        text    default null,
  p_queue_depth    integer default null,
  p_leased         integer default null,
  p_outbox_pending integer default null,
  p_meta           jsonb   default '{}'::jsonb,
  p_edge_base_url  text    default null,
  p_lease_seconds  integer default 300
) returns public.worker_heartbeats
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row public.worker_heartbeats;
  v_url text;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_heartbeat: worker id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'worker_heartbeat: lease must be between 10 and 3600 seconds';
  end if;

  insert into public.worker_heartbeats as h
    (worker_id, version, queue_depth, leased, outbox_pending, meta)
  values
    (p_worker_id, p_version, p_queue_depth, p_leased, p_outbox_pending, coalesce(p_meta, '{}'::jsonb))
  on conflict (worker_id) do update
    set at             = now(),
        version        = coalesce(excluded.version, h.version),
        queue_depth    = excluded.queue_depth,
        leased         = excluded.leased,
        outbox_pending = excluded.outbox_pending,
        meta           = excluded.meta
  returning * into v_row;

  update public.jobs_queue
     set lease_until  = greatest(lease_until, now() + make_interval(secs => p_lease_seconds)),
         heartbeat_at = now()
   where status = 'leased' and locked_by = p_worker_id;

  update public.outbox
     set lease_until = greatest(lease_until, now() + make_interval(secs => p_lease_seconds))
   where status = 'sending' and locked_by = p_worker_id;

  if p_edge_base_url is not null then
    v_url := rtrim(btrim(p_edge_base_url), '/');
    if v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' then
      raise exception 'worker_heartbeat: edge base url must be https://host';
    end if;
    if (select value ->> 'url' from public.app_settings where key = 'edge.base_url') is distinct from v_url then
      insert into public.app_settings (key, value)
      values ('edge.base_url', jsonb_build_object('url', v_url, 'set_by', p_worker_id))
      on conflict (key) do update set value = excluded.value, updated_at = now();
    end if;
  end if;

  return v_row;
end;
$$;

alter function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer) owner to postgres;
comment on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer) is
  'The worker''s 30 s check-in: upserts worker_heartbeats, extends every jobs_queue and outbox lease this worker holds, records app_settings edge.base_url for the liveness alarm. service_role only.';
revoke all on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 4. finish_job — the other half of claim_job. Only the worker holding the
--    lease may finish the row; a worker whose lease the sweeper already took
--    gets object_not_in_prerequisite_state and logs it rather than overwriting
--    another worker's outcome.
-- ---------------------------------------------------------------------------
create or replace function public.finish_job(
  p_job_id    uuid,
  p_worker_id text,
  p_ok        boolean,
  p_error     text    default null,
  p_result    jsonb   default null,
  p_permanent boolean default false
) returns public.jobs_queue
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row      public.jobs_queue;
  v_proposal uuid;
  v_next     timestamptz;
begin
  select * into v_row from public.jobs_queue where id = p_job_id for update;
  if not found then
    raise exception 'finish_job: no job %', p_job_id;
  end if;
  if v_row.status <> 'leased' or v_row.locked_by is distinct from p_worker_id then
    raise exception 'finish_job: job % is % (held by %), not leased by %',
      v_row.id, v_row.status, coalesce(v_row.locked_by, 'nobody'), p_worker_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_proposal := case when v_row.payload ? 'proposal_id' then (v_row.payload ->> 'proposal_id')::uuid end;

  if p_ok then
    update public.jobs_queue
       set status = 'done', finished_at = now(), locked_by = null, lease_until = null, last_error = null
     where id = v_row.id
    returning * into v_row;
    perform public.emit_event(
      'job.done', v_row.kind, 'jobs_queue', v_row.id, v_row.job_id, null, v_proposal,
      jsonb_build_object('attempts', v_row.attempts, 'result', coalesce(p_result, '{}'::jsonb)),
      'job.done:' || v_row.id, v_row.principal_kind, v_row.principal_id, v_row.correlation_id);

  elsif p_permanent or v_row.attempts >= v_row.max_attempts then
    update public.jobs_queue
       set status = 'dead', finished_at = now(), locked_by = null, lease_until = null,
           last_error = left(coalesce(p_error, 'failed'), 2000)
     where id = v_row.id
    returning * into v_row;
    perform public.emit_event(
      'job.dead', v_row.kind, 'jobs_queue', v_row.id, v_row.job_id, null, v_proposal,
      jsonb_build_object('attempts', v_row.attempts, 'max_attempts', v_row.max_attempts,
                         'error', v_row.last_error, 'permanent', p_permanent),
      'job.dead:' || v_row.id, v_row.principal_kind, v_row.principal_id, v_row.correlation_id);

  else
    v_next := now() + least(make_interval(mins => (2 ^ v_row.attempts)::integer), interval '1 hour');
    update public.jobs_queue
       set status = 'failed', run_after = v_next, locked_by = null, lease_until = null,
           last_error = left(coalesce(p_error, 'failed'), 2000)
     where id = v_row.id
    returning * into v_row;
    perform public.emit_event(
      'job.failed', v_row.kind, 'jobs_queue', v_row.id, v_row.job_id, null, v_proposal,
      jsonb_build_object('attempts', v_row.attempts, 'max_attempts', v_row.max_attempts,
                         'error', v_row.last_error, 'run_after', v_next),
      'job.failed:' || v_row.id || ':' || v_row.attempts, v_row.principal_kind, v_row.principal_id, v_row.correlation_id);
  end if;

  return v_row;
end;
$$;

alter function public.finish_job(uuid, text, boolean, text, jsonb, boolean) owner to postgres;
comment on function public.finish_job(uuid, text, boolean, text, jsonb, boolean) is
  'Settles a leased jobs_queue row: done, failed (run_after = now() + 2^attempts min, max 1 h) or dead (attempts ≥ max_attempts, or permanent). Only the lease holder may call it. Emits job.done / job.failed / job.dead. service_role only.';
revoke all on function public.finish_job(uuid, text, boolean, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.finish_job(uuid, text, boolean, text, jsonb, boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 5. sweep_leases — what a dead worker leaves behind. A leased jobs_queue row
--    past its lease goes back to queued (or dead, if its attempts are spent;
--    claim_job would never take it again). A sending outbox row past its
--    lease becomes a retry due now — the adapter's adopt-before-resend check
--    is what makes that retry safe. Runs from pg_cron every minute.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_leases() returns integer
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    update public.jobs_queue q
       set status      = case when q.attempts >= q.max_attempts then 'dead' else 'queued' end,
           locked_by   = null,
           lease_until = null,
           last_error  = left(format('lease expired (held by %s)', q.locked_by), 2000),
           finished_at = case when q.attempts >= q.max_attempts then now() else q.finished_at end
     where q.status = 'leased' and q.lease_until < now()
    returning q.*
  loop
    n := n + 1;
    perform public.emit_event(
      'job.lease_expired', r.kind, 'jobs_queue', r.id, r.job_id, null,
      case when r.payload ? 'proposal_id' then (r.payload ->> 'proposal_id')::uuid end,
      jsonb_build_object('attempts', r.attempts, 'max_attempts', r.max_attempts, 'now', r.status, 'note', r.last_error),
      'job.lease_expired:' || r.id || ':' || r.attempts, r.principal_kind, r.principal_id, r.correlation_id);
  end loop;

  for r in
    update public.outbox o
       set status          = case when o.attempts >= o.max_attempts then 'dead' else 'failed' end,
           locked_by       = null,
           lease_until     = null,
           next_attempt_at = case when o.channel = 'sms' then public.op_quiet_hours_release(now()) else now() end,
           error           = left(format('lease expired (held by %s)', o.locked_by), 2000)
     where o.status = 'sending' and o.lease_until < now()
    returning o.*
  loop
    n := n + 1;
    perform public.emit_event(
      'outbox.lease_expired', r.operation, 'outbox', r.id, r.job_id, null, r.proposal_id,
      jsonb_build_object('channel', r.channel, 'attempts', r.attempts, 'max_attempts', r.max_attempts, 'now', r.status),
      'outbox.lease_expired:' || r.id || ':' || r.attempts, r.principal_kind, r.principal_id);
  end loop;

  return n;
end;
$$;

alter function public.sweep_leases() owner to postgres;
comment on function public.sweep_leases() is
  'Requeues leased jobs_queue rows and failed-retries sending outbox rows whose lease has expired (dead when attempts are spent). pg_cron job jobs-queue-sweep-leases, every minute. Emits job.lease_expired / outbox.lease_expired.';
revoke all on function public.sweep_leases() from public, anon, authenticated;
grant execute on function public.sweep_leases() to service_role;


-- ---------------------------------------------------------------------------
-- 6. outbox_claim — the outbox lease. Due pending and failed rows of the
--    given channels, oldest due first, skipping what another worker holds.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_claim(
  p_worker_id     text,
  p_channels      text[]  default null,
  p_lease_seconds integer default 120,
  p_limit         integer default 10
) returns setof public.outbox
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'outbox_claim: worker id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'outbox_claim: lease must be between 10 and 3600 seconds';
  end if;

  return query
  update public.outbox o
     set status      = 'sending',
         locked_by   = p_worker_id,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts    = o.attempts + 1
   where o.id in (
           select c.id
             from public.outbox c
            where c.status in ('pending', 'failed')
              and c.next_attempt_at <= now()
              and c.attempts < c.max_attempts
              and (p_channels is null or c.channel = any (p_channels))
            order by c.next_attempt_at, c.created_at
            for update skip locked
            limit greatest(1, least(coalesce(p_limit, 10), 100))
         )
  returning o.*;
end;
$$;

alter function public.outbox_claim(text, text[], integer, integer) owner to postgres;
comment on function public.outbox_claim(text, text[], integer, integer) is
  'Leases up to p_limit due outbox rows (pending, or failed and due) of the given channels: status sending, locked_by, lease_until, attempts + 1. FOR UPDATE SKIP LOCKED. service_role only.';
revoke all on function public.outbox_claim(text, text[], integer, integer) from public, anon, authenticated;
grant execute on function public.outbox_claim(text, text[], integer, integer) to service_role;


-- ---------------------------------------------------------------------------
-- 7. outbox_sent — delivered to the provider. Idempotent for the holder: a
--    repeat with the same provider id on an already-sent row returns the row.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_sent(
  p_outbox_id       uuid,
  p_worker_id       text,
  p_provider_id     text    default null,
  p_provider_status text    default null,
  p_cost_usd        numeric default null,
  p_adopted         boolean default false,
  p_principal_id    uuid    default null
) returns public.outbox
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row public.outbox;
begin
  select * into v_row from public.outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'outbox_sent: no outbox row %', p_outbox_id;
  end if;
  if v_row.status in ('sent', 'delivered') and v_row.provider_id is not distinct from p_provider_id then
    return v_row;
  end if;
  if v_row.status <> 'sending' or v_row.locked_by is distinct from p_worker_id then
    raise exception 'outbox_sent: row % is % (held by %), not sending for %',
      v_row.id, v_row.status, coalesce(v_row.locked_by, 'nobody'), p_worker_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.outbox
     set status          = 'sent',
         sent_at         = now(),
         provider_id     = coalesce(p_provider_id, provider_id),
         provider_status = coalesce(p_provider_status, provider_status),
         cost_usd        = coalesce(p_cost_usd, cost_usd),
         error           = null,
         locked_by       = null,
         lease_until     = null
   where id = v_row.id
  returning * into v_row;

  perform public.emit_event(
    v_row.channel || '.sent', v_row.operation, 'outbox', v_row.id, v_row.job_id, null, v_row.proposal_id,
    jsonb_build_object('to', v_row.payload ->> 'to', 'provider_id', v_row.provider_id,
                       'provider_status', v_row.provider_status, 'attempts', v_row.attempts,
                       'adopted', coalesce(p_adopted, false)),
    v_row.channel || '.sent:' || v_row.id,
    case when p_principal_id is null then 'system' else 'agent' end, p_principal_id);

  return v_row;
end;
$$;

alter function public.outbox_sent(uuid, text, text, text, numeric, boolean, uuid) owner to postgres;
comment on function public.outbox_sent(uuid, text, text, text, numeric, boolean, uuid) is
  'The lease holder reports a send accepted by the provider: status sent, provider_id, cost. p_adopted marks a retry that found the earlier attempt''s provider record instead of resending. Emits <channel>.sent. service_role only.';
revoke all on function public.outbox_sent(uuid, text, text, text, numeric, boolean, uuid) from public, anon, authenticated;
grant execute on function public.outbox_sent(uuid, text, text, text, numeric, boolean, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 8. outbox_failed — the provider refused or could not be reached. Transient
--    → failed with backoff (texts moved into the quiet-hours window);
--    permanent (bad number, bad address) or attempts spent → dead.
-- ---------------------------------------------------------------------------
create or replace function public.outbox_failed(
  p_outbox_id    uuid,
  p_worker_id    text,
  p_error        text,
  p_permanent    boolean default false,
  p_principal_id uuid    default null
) returns public.outbox
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_row  public.outbox;
  v_next timestamptz;
  v_kind text;
begin
  select * into v_row from public.outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'outbox_failed: no outbox row %', p_outbox_id;
  end if;
  if v_row.status <> 'sending' or v_row.locked_by is distinct from p_worker_id then
    raise exception 'outbox_failed: row % is % (held by %), not sending for %',
      v_row.id, v_row.status, coalesce(v_row.locked_by, 'nobody'), p_worker_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_kind := case when p_principal_id is null then 'system' else 'agent' end;

  if coalesce(p_permanent, false) or v_row.attempts >= v_row.max_attempts then
    update public.outbox
       set status = 'dead', error = left(coalesce(p_error, 'failed'), 2000), locked_by = null, lease_until = null
     where id = v_row.id
    returning * into v_row;
    perform public.emit_event(
      v_row.channel || '.dead', v_row.operation, 'outbox', v_row.id, v_row.job_id, null, v_row.proposal_id,
      jsonb_build_object('to', v_row.payload ->> 'to', 'error', v_row.error, 'attempts', v_row.attempts,
                         'max_attempts', v_row.max_attempts, 'permanent', coalesce(p_permanent, false)),
      v_row.channel || '.dead:' || v_row.id, v_kind, p_principal_id);
  else
    v_next := now() + least(make_interval(mins => (2 ^ v_row.attempts)::integer), interval '1 hour');
    if v_row.channel = 'sms' then
      v_next := public.op_quiet_hours_release(v_next);
    end if;
    update public.outbox
       set status = 'failed', error = left(coalesce(p_error, 'failed'), 2000),
           next_attempt_at = v_next, locked_by = null, lease_until = null
     where id = v_row.id
    returning * into v_row;
    perform public.emit_event(
      v_row.channel || '.failed', v_row.operation, 'outbox', v_row.id, v_row.job_id, null, v_row.proposal_id,
      jsonb_build_object('to', v_row.payload ->> 'to', 'error', v_row.error, 'attempts', v_row.attempts,
                         'max_attempts', v_row.max_attempts, 'next_attempt_at', v_next),
      v_row.channel || '.failed:' || v_row.id || ':' || v_row.attempts, v_kind, p_principal_id);
  end if;

  return v_row;
end;
$$;

alter function public.outbox_failed(uuid, text, text, boolean, uuid) owner to postgres;
comment on function public.outbox_failed(uuid, text, text, boolean, uuid) is
  'The lease holder reports a failed send: failed with next_attempt_at = now() + 2^attempts min (max 1 h; sms moved into the quiet-hours window), or dead when permanent or attempts ≥ max_attempts. Emits <channel>.failed / <channel>.dead. service_role only.';
revoke all on function public.outbox_failed(uuid, text, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.outbox_failed(uuid, text, text, boolean, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 9. worker_liveness_check — the dead-worker alarm. pg_cron every 5 minutes.
--
--    Returns what it found, so a dry run from a thread can read it:
--      unconfigured       no edge.base_url yet (no worker has ever checked in)
--      no-heartbeats      the setting exists but worker_heartbeats is empty
--      fresh              a heartbeat inside the last 10 minutes
--      stale-guarded      stale, but the owner was already texted in the last 24 h
--      stale-would-alert  stale, and p_dry_run stopped short of the POST
--      stale-no-secret    stale, but the vault holds no worker_alert_secret
--      stale-alerted      stale; POSTed to roybal-webhooks/alert
--
--    The POST goes through pg_net (asynchronous; the request row is net._http_response).
--    The edge function re-checks worker_heartbeats itself before texting, so a
--    forged POST without the secret can cause nothing, and one with it can cause
--    at most a true alarm.
-- ---------------------------------------------------------------------------
create or replace function public.worker_liveness_check(p_dry_run boolean default false) returns text
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_url     text;
  v_last    timestamptz;
  v_worker  text;
  v_state   jsonb;
  v_secret  text;
  v_req     bigint;
  v_stale   constant interval := interval '10 minutes';
begin
  select value ->> 'url' into v_url from public.app_settings where key = 'edge.base_url';
  if v_url is null or v_url = '' then
    return 'unconfigured';
  end if;

  select h.at, h.worker_id into v_last, v_worker
    from public.worker_heartbeats h
   order by h.at desc
   limit 1;
  if v_last is null then
    return 'no-heartbeats';
  end if;

  select value into v_state from public.app_settings where key = 'worker.liveness_alert';

  if now() - v_last < v_stale then
    if v_state is not null then
      delete from public.app_settings where key = 'worker.liveness_alert';
      perform public.emit_event(
        'worker.recovered', null, 'worker', null, null, null, null,
        jsonb_build_object('worker_id', v_worker, 'heartbeat_at', v_last, 'alerted_at', v_state ->> 'alerted_at'),
        'worker.recovered:' || to_char(v_last at time zone 'UTC', 'YYYYMMDDHH24MISS'));
    end if;
    return 'fresh';
  end if;

  if v_state is not null
     and (v_state ->> 'alerted_at')::timestamptz > now() - interval '24 hours' then
    return 'stale-guarded';
  end if;

  if coalesce(p_dry_run, false) then
    return 'stale-would-alert';
  end if;

  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s
   where s.name = 'worker_alert_secret'
   order by s.created_at desc
   limit 1;
  if v_secret is null then
    perform public.emit_event(
      'worker.stale', null, 'worker', null, null, null, null,
      jsonb_build_object('worker_id', v_worker, 'last_heartbeat_at', v_last, 'alert', 'no worker_alert_secret in the vault'),
      'worker.stale:' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MI'));
    return 'stale-no-secret';
  end if;

  select net.http_post(
           url                  => v_url || '/functions/v1/roybal-webhooks/alert',
           body                 => jsonb_build_object(
                                     'kind', 'worker_down',
                                     'worker_id', v_worker,
                                     'last_heartbeat_at', v_last,
                                     'stale_minutes', floor(extract(epoch from (now() - v_last)) / 60),
                                     'checked_at', now()),
           headers              => jsonb_build_object('Content-Type', 'application/json', 'x-roybal-secret', v_secret),
           timeout_milliseconds => 10000)
    into v_req;

  insert into public.app_settings (key, value)
  values ('worker.liveness_alert',
          jsonb_build_object('alerted_at', now(), 'last_heartbeat_at', v_last, 'worker_id', v_worker, 'request_id', v_req))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  perform public.emit_event(
    'worker.stale', null, 'worker', null, null, null, null,
    jsonb_build_object('worker_id', v_worker, 'last_heartbeat_at', v_last, 'request_id', v_req),
    'worker.stale:' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MI'));

  return 'stale-alerted';
end;
$$;

alter function public.worker_liveness_check(boolean) owner to postgres;
comment on function public.worker_liveness_check(boolean) is
  'The dead-worker alarm: no heartbeat for 10 minutes → one pg_net POST to <edge.base_url>/functions/v1/roybal-webhooks/alert carrying the vault secret worker_alert_secret, at most once per 24 h (app_settings worker.liveness_alert). pg_cron job worker-liveness-check, every 5 minutes. p_dry_run reports without posting.';
revoke all on function public.worker_liveness_check(boolean) from public, anon, authenticated;
grant execute on function public.worker_liveness_check(boolean) to service_role;


-- ---------------------------------------------------------------------------
-- 10. worker_alert_secret — for the edge function, under the service key, to
--     compare against the x-roybal-secret header. Nothing else reads the vault.
-- ---------------------------------------------------------------------------
create or replace function public.worker_alert_secret() returns text
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $$
  select s.decrypted_secret
    from vault.decrypted_secrets s
   where s.name = 'worker_alert_secret'
   order by s.created_at desc
   limit 1;
$$;

alter function public.worker_alert_secret() owner to postgres;
comment on function public.worker_alert_secret() is
  'The vault secret worker_alert_secret, for roybal-webhooks/alert to verify the liveness POST. service_role only.';
revoke all on function public.worker_alert_secret() from public, anon, authenticated;
grant execute on function public.worker_alert_secret() to service_role;


-- ---------------------------------------------------------------------------
-- 11. The shared secret, minted here so there is no owner step and nothing to
--     paste. Two UUIDs from pg_strong_random, 64 hex characters. Rotating it is
--     `delete from vault.secrets where name = 'worker_alert_secret'` and a
--     re-run of this block; the edge function reads it live on every alarm.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise notice '0015: supabase_vault is not installed here; worker_alert_secret not created';
    return;
  end if;
  if exists (select 1 from vault.secrets where name = 'worker_alert_secret') then
    return;
  end if;
  perform vault.create_secret(
    replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    'worker_alert_secret',
    'Shared secret worker_liveness_check() sends to roybal-webhooks/alert (migration 0015).');
end
$$;


-- ---------------------------------------------------------------------------
-- 12. The two cron rows. cron.schedule(name, …) is idempotent on the name, so
--     a re-run updates rather than duplicates. The jobs run as the role that
--     scheduled them (postgres), which owns every function above.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0015: pg_cron is not installed here; sweeper and liveness check not scheduled';
    return;
  end if;
  perform cron.schedule('jobs-queue-sweep-leases', '* * * * *',   'select public.sweep_leases()');
  perform cron.schedule('worker-liveness-check',   '*/5 * * * *', 'select public.worker_liveness_check()');
end
$$;
