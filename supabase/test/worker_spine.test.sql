-- ============================================================================
-- Assertions for 0016_worker_spine.sql and 0017_worker_leases.sql (the
-- heartbeat extends only the leases it names; the alarm re-posts every 15 min).
--
-- Run by the DB replay workflow after the census, against the database
-- `supabase db reset` rebuilt from supabase/migrations/. Every block raises on
-- the first rule it finds broken. The rules are the worker contract of
-- 03 §2.2: a lease is held by exactly one worker and outlives its transaction,
-- only the holder may settle a row, an expired lease becomes a retry (never a
-- silent loss, never a second holder), a spent row is dead, and the dead-worker
-- alarm keeps posting every 15 minutes while the worker is stale (the edge
-- function texts at most once per 24 h).
--
-- The behaviour blocks run as service_role (the worker's role) inside one
-- transaction and roll it back at the end.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Grants. ALTER DEFAULT PRIVILEGES hands anon and authenticated EXECUTE on
--    every new function and ALL on every new table. The worker's functions are
--    service_role only; worker_heartbeats is readable by owner and office.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  problems text[] := '{}';
  worker_fns text[] := array['worker_heartbeat', 'finish_job', 'sweep_leases', 'outbox_claim',
                             'outbox_sent', 'outbox_failed', 'worker_liveness_check', 'worker_alert_secret'];
  n int;
begin
  select count(distinct p.proname) into n
    from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
   where n2.nspname = 'public' and p.proname = any (worker_fns);
  if n <> array_length(worker_fns, 1) then
    raise exception 'expected % worker functions, found %', array_length(worker_fns, 1), n;
  end if;

  for r in
    select p.proname, p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
     where n2.nspname = 'public' and p.proname = any (worker_fns)
  loop
    if has_function_privilege('anon', r.sig, 'EXECUTE') then
      problems := problems || format('anon can execute %s', r.proname);
    end if;
    if has_function_privilege('authenticated', r.sig, 'EXECUTE') then
      problems := problems || format('authenticated can execute %s', r.proname);
    end if;
    if not has_function_privilege('service_role', r.sig, 'EXECUTE') then
      problems := problems || format('service_role cannot execute %s', r.proname);
    end if;
  end loop;

  if has_table_privilege('anon', 'public.worker_heartbeats', 'SELECT, INSERT, UPDATE, DELETE') then
    problems := problems || 'anon has a privilege on worker_heartbeats';
  end if;
  if not has_table_privilege('authenticated', 'public.worker_heartbeats', 'SELECT') then
    problems := problems || 'authenticated cannot read worker_heartbeats';
  end if;
  if has_table_privilege('authenticated', 'public.worker_heartbeats', 'INSERT, UPDATE, DELETE') then
    problems := problems || 'authenticated can write worker_heartbeats';
  end if;
  if not has_table_privilege('service_role', 'public.worker_heartbeats', 'INSERT, UPDATE, DELETE') then
    problems := problems || 'service_role cannot write worker_heartbeats';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.worker_heartbeats'::regclass) then
    problems := problems || 'worker_heartbeats has no RLS';
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'worker_heartbeats'
                    and policyname = 'worker_heartbeats_read_admin' and cmd = 'SELECT') then
    problems := problems || 'worker_heartbeats_read_admin policy is missing';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'worker spine grants are wrong: %', array_to_string(problems, '; ');
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. The outbox lease has the shape of the jobs_queue lease.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'outbox'
         and column_name in ('locked_by', 'lease_until', 'max_attempts')) <> 3 then
    raise exception 'outbox is missing a lease column';
  end if;
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'outbox' and column_name = 'max_attempts') <> '6' then
    raise exception 'outbox.max_attempts default is not 6';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'outbox_lease_recorded' and conrelid = 'public.outbox'::regclass) then
    raise exception 'outbox_lease_recorded check is missing';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'outbox' and indexname = 'outbox_lease_idx') then
    raise exception 'outbox_lease_idx is missing';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. The cron rows and the vault secret, where the extensions exist.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if (select count(*) from cron.job
         where jobname in ('jobs-queue-sweep-leases', 'worker-liveness-check') and active) <> 2 then
      raise exception 'the worker cron jobs are not both scheduled and active';
    end if;
    if (select command from cron.job where jobname = 'jobs-queue-sweep-leases') !~ 'public\.sweep_leases\(\)' then
      raise exception 'jobs-queue-sweep-leases runs the wrong command';
    end if;
    if (select schedule from cron.job where jobname = 'jobs-queue-sweep-leases') <> '* * * * *' then
      raise exception 'jobs-queue-sweep-leases is not every minute';
    end if;
    if (select command from cron.job where jobname = 'worker-liveness-check') !~ 'public\.worker_liveness_check\(\)' then
      raise exception 'worker-liveness-check runs the wrong command';
    end if;
    if (select schedule from cron.job where jobname = 'worker-liveness-check') <> '*/5 * * * *' then
      raise exception 'worker-liveness-check is not every 5 minutes';
    end if;
  else
    raise notice 'pg_cron is not installed here; cron rows not checked';
  end if;

  if exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if not exists (select 1 from vault.secrets where name = 'worker_alert_secret') then
      raise exception 'the vault holds no worker_alert_secret';
    end if;
    if length(public.worker_alert_secret()) < 32 then
      raise exception 'worker_alert_secret is shorter than 32 characters';
    end if;
  else
    raise notice 'supabase_vault is not installed here; the secret is not checked';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. Behaviour, as the worker (service_role). One transaction, rolled back.
-- ---------------------------------------------------------------------------
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-worker-owner@example.invalid', '', now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-worker-crew@example.invalid',  '', now(), now(), now(), '{}', '{}')
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role) values
  ('00000000-0000-0000-0000-00000000e001', 'worker test owner', 'owner'),
  ('00000000-0000-0000-0000-00000000e003', 'worker test crew',  'crew')
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;

-- 4a. the queue: claim → heartbeat extends → finish; backoff; dead; sweep
savepoint s;
set local role service_role;
do $$
declare
  j      public.jobs_queue;
  c      public.jobs_queue;
  f      public.jobs_queue;
  before timestamptz;
begin
  j := public.enqueue('test.noop', '{"n": 1}'::jsonb, 'test.noop:1');
  select * into c from public.claim_job('w-test-1', array['test.noop'], 60);
  if c.id is distinct from j.id or c.status <> 'leased' or c.attempts <> 1 then
    raise exception 'claim_job did not lease the test job (status %, attempts %)', c.status, c.attempts;
  end if;
  before := c.lease_until;

  -- a heartbeat that does not name the job (nothing in flight, or a successor
  -- process on the same machine) leaves its lease alone — that lease must be
  -- allowed to expire into a retry (0017)
  perform public.worker_heartbeat('w-test-1', 'test', 0, 1, 0, '{"pid": 1}'::jsonb, 'https://example.supabase.co/', 600);
  if (select lease_until from public.jobs_queue where id = j.id) <> before then
    raise exception 'worker_heartbeat extended a lease it was not told about';
  end if;
  perform public.worker_heartbeat('w-test-1', 'test', 0, 1, 0, '{"pid": 1}'::jsonb, 'https://example.supabase.co/', 600, array[]::uuid[], null);
  if (select lease_until from public.jobs_queue where id = j.id) <> before then
    raise exception 'worker_heartbeat extended a lease with an empty active list';
  end if;
  perform public.worker_heartbeat('w-test-1', 'test', 0, 1, 0, '{"pid": 1}'::jsonb, 'https://example.supabase.co/', 600, array[gen_random_uuid()], null);
  if (select lease_until from public.jobs_queue where id = j.id) <> before then
    raise exception 'worker_heartbeat extended a lease outside its active list';
  end if;
  -- another worker naming our job cannot extend it either
  perform public.worker_heartbeat('w-other', 'test', 0, 0, 0, '{}'::jsonb, null, 600, array[j.id], null);
  if (select lease_until from public.jobs_queue where id = j.id) <> before then
    raise exception 'another worker extended a lease it does not hold';
  end if;

  -- the heartbeat extends the lease it names, and records where the edge functions live
  perform public.worker_heartbeat('w-test-1', 'test', 0, 1, 0, '{"pid": 1}'::jsonb, 'https://example.supabase.co/', 600, array[j.id], null);
  if (select lease_until from public.jobs_queue where id = j.id) <= before then
    raise exception 'worker_heartbeat did not extend the lease';
  end if;
  if (select heartbeat_at from public.jobs_queue where id = j.id) is null then
    raise exception 'worker_heartbeat did not stamp heartbeat_at';
  end if;
  if (select value ->> 'url' from public.app_settings where key = 'edge.base_url') <> 'https://example.supabase.co' then
    raise exception 'worker_heartbeat did not record edge.base_url (trailing slash trimmed)';
  end if;
  if (select count(*) from public.worker_heartbeats where worker_id = 'w-test-1' and version = 'test' and leased = 1) <> 1 then
    raise exception 'worker_heartbeats row missing or wrong';
  end if;

  -- only the holder may settle the row
  begin
    perform public.finish_job(j.id, 'w-other', true);
    raise exception 'another worker finished a job it does not hold';
  exception when object_not_in_prerequisite_state then null;
  end;

  f := public.finish_job(j.id, 'w-test-1', true, null, '{"ok": true}'::jsonb);
  if f.status <> 'done' or f.locked_by is not null or f.lease_until is not null or f.finished_at is null then
    raise exception 'finish_job(ok) left status % locked_by %', f.status, f.locked_by;
  end if;
  if not exists (select 1 from public.events where kind = 'job.done' and aggregate_id = j.id) then
    raise exception 'no job.done event';
  end if;
  begin
    perform public.finish_job(j.id, 'w-test-1', true);
    raise exception 'a done job was finished twice';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- a failure backs off, then dies when attempts are spent
  j := public.enqueue('test.noop', '{"n": 2}'::jsonb, 'test.noop:2');
  update public.jobs_queue set max_attempts = 2 where id = j.id;
  select * into c from public.claim_job('w-test-1', array['test.noop'], 60);
  if c.id is distinct from j.id then raise exception 'second job not claimed'; end if;
  f := public.finish_job(c.id, 'w-test-1', false, 'boom');
  if f.status <> 'failed' or f.run_after <= now() or f.last_error <> 'boom' or f.locked_by is not null then
    raise exception 'finish_job(failed) left status % run_after %', f.status, f.run_after;
  end if;
  if not exists (select 1 from public.events where kind = 'job.failed' and aggregate_id = j.id) then
    raise exception 'no job.failed event';
  end if;
  if exists (select 1 from public.claim_job('w-test-1', array['test.noop'], 60)) then
    raise exception 'a backed-off job was claimed before run_after';
  end if;
  update public.jobs_queue set run_after = now() - interval '1 second' where id = j.id;
  select * into c from public.claim_job('w-test-1', array['test.noop'], 60);
  if c.id is distinct from j.id or c.attempts <> 2 then
    raise exception 'retry claim returned % with attempts %', c.id, c.attempts;
  end if;
  f := public.finish_job(c.id, 'w-test-1', false, 'boom again');
  if f.status <> 'dead' or f.finished_at is null then
    raise exception 'spent attempts left status %', f.status;
  end if;
  if not exists (select 1 from public.events where kind = 'job.dead' and aggregate_id = j.id) then
    raise exception 'no job.dead event';
  end if;
  if exists (select 1 from public.claim_job('w-test-1', array['test.noop'], 60)) then
    raise exception 'a dead job was claimed';
  end if;

  -- a permanent failure is dead on the first attempt
  j := public.enqueue('test.unknown', '{}'::jsonb, 'test.unknown:1');
  select * into c from public.claim_job('w-test-1', array['test.unknown'], 60);
  f := public.finish_job(c.id, 'w-test-1', false, 'no handler for kind test.unknown', null, true);
  if f.status <> 'dead' or f.attempts <> 1 then
    raise exception 'permanent failure left status % attempts %', f.status, f.attempts;
  end if;

  -- the sweeper: an expired lease goes back to queued and is claimable again
  j := public.enqueue('test.noop', '{"n": 3}'::jsonb, 'test.noop:3');
  select * into c from public.claim_job('w-dead', array['test.noop'], 60);
  if c.id is distinct from j.id then raise exception 'third job not claimed'; end if;
  if public.sweep_leases() <> 0 then
    raise exception 'sweep_leases swept a live lease';
  end if;
  update public.jobs_queue set lease_until = now() - interval '1 second' where id = j.id;
  if public.sweep_leases() < 1 then
    raise exception 'sweep_leases found nothing to sweep';
  end if;
  select * into f from public.jobs_queue where id = j.id;
  if f.status <> 'queued' or f.locked_by is not null or f.lease_until is not null or f.last_error !~ 'w-dead' then
    raise exception 'sweep left status % locked_by % last_error %', f.status, f.locked_by, f.last_error;
  end if;
  if not exists (select 1 from public.events where kind = 'job.lease_expired' and aggregate_id = j.id) then
    raise exception 'no job.lease_expired event';
  end if;
  select * into c from public.claim_job('w-test-1', array['test.noop'], 60);
  if c.id is distinct from j.id or c.attempts <> 2 then
    raise exception 'swept job not reclaimed as attempt 2';
  end if;
  perform public.finish_job(c.id, 'w-test-1', true);

  -- a swept lease with spent attempts is dead, not requeued
  j := public.enqueue('test.noop', '{"n": 4}'::jsonb, 'test.noop:4');
  update public.jobs_queue set max_attempts = 1 where id = j.id;
  select * into c from public.claim_job('w-dead', array['test.noop'], 60);
  update public.jobs_queue set lease_until = now() - interval '1 second' where id = j.id;
  perform public.sweep_leases();
  if (select status from public.jobs_queue where id = j.id) <> 'dead' then
    raise exception 'a swept job with spent attempts was requeued';
  end if;
end
$$;
release savepoint s;
reset role;

-- 4b. the outbox: claim → sent (idempotent); failed with quiet-hours backoff;
--     dead; channel filter; sweep into a retry that adopts
savepoint s;
set local role service_role;
do $$
declare
  o public.outbox;
  c public.outbox;
  f public.outbox;
  before timestamptz;
begin
  insert into public.outbox (channel, operation, payload, idempotency_key)
  values ('email', 'email.send@1', '{"to": "pm@example.invalid", "subject": "x", "body": "y"}'::jsonb, 'test.outbox:email1')
  returning * into o;

  select * into c from public.outbox_claim('w-test-1', array['email', 'sms'], 60, 10);
  if c.id is distinct from o.id or c.status <> 'sending' or c.attempts <> 1 or c.locked_by <> 'w-test-1' or c.lease_until is null then
    raise exception 'outbox_claim left status % attempts % locked_by %', c.status, c.attempts, c.locked_by;
  end if;

  -- 0017: the heartbeat extends only the outbox leases it names, and only the holder's
  before := c.lease_until;
  perform public.worker_heartbeat('w-test-1', 'test', 0, 0, 1, '{}'::jsonb, null, 600, null, null);
  if (select lease_until from public.outbox where id = o.id) <> before then
    raise exception 'worker_heartbeat extended an outbox lease it was not told about';
  end if;
  perform public.worker_heartbeat('w-test-2', 'test', 0, 0, 0, '{}'::jsonb, null, 600, null, array[o.id]);
  if (select lease_until from public.outbox where id = o.id) <> before then
    raise exception 'another worker extended an outbox lease it does not hold';
  end if;
  perform public.worker_heartbeat('w-test-1', 'test', 0, 0, 1, '{}'::jsonb, null, 600, null, array[o.id]);
  if (select lease_until from public.outbox where id = o.id) <= before then
    raise exception 'worker_heartbeat did not extend the outbox lease it named';
  end if;
  if exists (select 1 from public.outbox_claim('w-test-2', null, 60, 10)) then
    raise exception 'a sending row was claimed by a second worker';
  end if;
  begin
    perform public.outbox_sent(o.id, 'w-test-2', 'gm1');
    raise exception 'another worker settled an outbox row it does not hold';
  exception when object_not_in_prerequisite_state then null;
  end;

  f := public.outbox_sent(o.id, 'w-test-1', 'gm1', 'sent', null, false, '0a7ac824-5042-4bb5-ab0d-8569cea209b1');
  if f.status <> 'sent' or f.provider_id <> 'gm1' or f.sent_at is null or f.locked_by is not null or f.lease_until is not null then
    raise exception 'outbox_sent left status % provider %', f.status, f.provider_id;
  end if;
  if not exists (select 1 from public.events
                  where kind = 'email.sent' and aggregate_id = o.id
                    and principal_kind = 'agent' and principal_id = '0a7ac824-5042-4bb5-ab0d-8569cea209b1') then
    raise exception 'no email.sent event attributed to agent:outbox';
  end if;
  -- the same report again is a no-op, not an error (a retried RPC)
  f := public.outbox_sent(o.id, 'w-test-1', 'gm1');
  if f.status <> 'sent' then raise exception 'a repeated outbox_sent changed the row'; end if;
  if exists (select 1 from public.outbox_claim('w-test-1', null, 60, 10)) then
    raise exception 'a sent row was claimed';
  end if;

  -- sms: failed → backoff inside the quiet-hours window → dead when spent
  insert into public.outbox (channel, operation, payload, idempotency_key)
  values ('sms', 'sms.send@1', '{"to": "+19075550100", "body": "On our way"}'::jsonb, 'test.outbox:sms1')
  returning * into o;
  update public.outbox set max_attempts = 2 where id = o.id;
  select * into c from public.outbox_claim('w-test-1', array['sms'], 60, 10);
  if c.id is distinct from o.id then raise exception 'sms row not claimed'; end if;
  f := public.outbox_failed(o.id, 'w-test-1', 'twilio 503');
  if f.status <> 'failed' or f.next_attempt_at <= now() or f.error <> 'twilio 503' or f.locked_by is not null then
    raise exception 'outbox_failed left status % next_attempt_at %', f.status, f.next_attempt_at;
  end if;
  if f.next_attempt_at <> public.op_quiet_hours_release(f.next_attempt_at) then
    raise exception 'an sms retry was scheduled outside the quiet-hours window';
  end if;
  if not exists (select 1 from public.events where kind = 'sms.failed' and aggregate_id = o.id) then
    raise exception 'no sms.failed event';
  end if;
  if exists (select 1 from public.outbox_claim('w-test-1', array['sms'], 60, 10)) then
    raise exception 'a backed-off sms row was claimed before next_attempt_at';
  end if;
  update public.outbox set next_attempt_at = now() - interval '1 second' where id = o.id;
  select * into c from public.outbox_claim('w-test-1', array['sms'], 60, 10);
  if c.id is distinct from o.id or c.attempts <> 2 then
    raise exception 'sms retry claim returned % with attempts %', c.id, c.attempts;
  end if;
  f := public.outbox_failed(o.id, 'w-test-1', 'twilio 503 again');
  if f.status <> 'dead' then raise exception 'spent attempts left status %', f.status; end if;
  if not exists (select 1 from public.events where kind = 'sms.dead' and aggregate_id = o.id) then
    raise exception 'no sms.dead event';
  end if;
  if exists (select 1 from public.outbox_claim('w-test-1', null, 60, 10)) then
    raise exception 'a dead outbox row was claimed';
  end if;

  -- a permanent refusal (bad number) is dead on the first attempt
  insert into public.outbox (channel, operation, payload, idempotency_key)
  values ('sms', 'sms.send@1', '{"to": "+1907", "body": "hi"}'::jsonb, 'test.outbox:sms2')
  returning * into o;
  select * into c from public.outbox_claim('w-test-1', array['sms'], 60, 10);
  f := public.outbox_failed(o.id, 'w-test-1', 'not a valid phone number', true);
  if f.status <> 'dead' or f.attempts <> 1 then
    raise exception 'permanent refusal left status % attempts %', f.status, f.attempts;
  end if;
  if not exists (select 1 from public.events where kind = 'sms.dead' and aggregate_id = o.id and (data ->> 'permanent')::boolean) then
    raise exception 'permanent refusal not recorded as such';
  end if;

  -- the channel filter: a qbo row is never taken by the comms lanes
  insert into public.outbox (channel, operation, payload, idempotency_key)
  values ('qbo', 'invoice.push@1', '{}'::jsonb, 'test.outbox:qbo1')
  returning * into o;
  if exists (select 1 from public.outbox_claim('w-test-1', array['sms', 'email'], 60, 10)) then
    raise exception 'a qbo row was claimed by the comms lanes';
  end if;

  -- the sweeper: an expired sending lease becomes a retry due now, and the
  -- retry can report an adopted send
  insert into public.outbox (channel, operation, payload, idempotency_key)
  values ('email', 'email.send@1', '{"to": "a@example.invalid", "subject": "x", "body": "y"}'::jsonb, 'test.outbox:email2')
  returning * into o;
  select * into c from public.outbox_claim('w-dead', array['email'], 60, 10);
  if c.id is distinct from o.id then raise exception 'email2 not claimed'; end if;
  update public.outbox set lease_until = now() - interval '1 second' where id = o.id;
  if public.sweep_leases() < 1 then raise exception 'outbox sweep found nothing'; end if;
  select * into f from public.outbox where id = o.id;
  if f.status <> 'failed' or f.locked_by is not null or f.lease_until is not null or f.next_attempt_at > now() or f.error !~ 'w-dead' then
    raise exception 'outbox sweep left status % locked_by % next_attempt_at %', f.status, f.locked_by, f.next_attempt_at;
  end if;
  if not exists (select 1 from public.events where kind = 'outbox.lease_expired' and aggregate_id = o.id) then
    raise exception 'no outbox.lease_expired event';
  end if;
  select * into c from public.outbox_claim('w-test-1', array['email'], 60, 10);
  if c.id is distinct from o.id or c.attempts <> 2 then
    raise exception 'swept outbox row not reclaimed as attempt 2';
  end if;
  f := public.outbox_sent(o.id, 'w-test-1', 'gm2', 'sent', null, true);
  if f.status <> 'sent' then raise exception 'adopted send left status %', f.status; end if;
  if not exists (select 1 from public.events where kind = 'email.sent' and aggregate_id = o.id and (data ->> 'adopted')::boolean) then
    raise exception 'the adopted send was not recorded as adopted';
  end if;

  -- the constraint: sending without a lease is refused at the table
  begin
    update public.outbox set status = 'sending', locked_by = null, lease_until = null where id = o.id;
    raise exception 'a sending row without a lease was accepted';
  exception when check_violation then null;
  end;
end
$$;
release savepoint s;
reset role;

-- 4c. the dead-worker alarm, dry run at every state
savepoint s;
set local role service_role;
do $$
declare
  s text;
begin
  delete from public.app_settings where key in ('edge.base_url', 'worker.liveness_alert');
  delete from public.worker_heartbeats;

  s := public.worker_liveness_check(true);
  if s <> 'unconfigured' then raise exception 'liveness with no edge url: %', s; end if;

  perform public.worker_heartbeat('w-live', 'test', 0, 0, 0, '{}'::jsonb, 'https://example.supabase.co');
  s := public.worker_liveness_check(true);
  if s <> 'fresh' then raise exception 'liveness right after a heartbeat: %', s; end if;

  update public.worker_heartbeats set at = now() - interval '9 minutes' where worker_id = 'w-live';
  s := public.worker_liveness_check(true);
  if s <> 'fresh' then raise exception 'liveness 9 minutes after the last heartbeat: %', s; end if;

  update public.worker_heartbeats set at = now() - interval '11 minutes' where worker_id = 'w-live';
  s := public.worker_liveness_check(true);
  if s <> 'stale-would-alert' then raise exception 'liveness 11 minutes after the last heartbeat: %', s; end if;

  -- a POST in the last 15 minutes holds the next one; after that the database
  -- knocks again (the edge function owns the once-per-24-h text) — 0017
  insert into public.app_settings (key, value)
  values ('worker.liveness_alert', jsonb_build_object('alerted_at', now() - interval '5 minutes', 'first_stale_at', now() - interval '16 minutes'));
  s := public.worker_liveness_check(true);
  if s <> 'stale-guarded' then raise exception 'liveness 5 minutes after a POST: %', s; end if;

  update public.app_settings set value = jsonb_build_object('alerted_at', now() - interval '16 minutes', 'first_stale_at', now() - interval '27 minutes')
   where key = 'worker.liveness_alert';
  s := public.worker_liveness_check(true);
  if s <> 'stale-would-alert' then raise exception 'liveness 16 minutes after a POST: %', s; end if;

  update public.app_settings set value = jsonb_build_object('alerted_at', now() - interval '1 hour')
   where key = 'worker.liveness_alert';
  s := public.worker_liveness_check(true);
  if s <> 'stale-would-alert' then raise exception 'liveness an hour after a POST (the old 24 h guard must be gone): %', s; end if;

  -- a fresh heartbeat clears the alarm state and records the recovery
  perform public.worker_heartbeat('w-live', 'test', 0, 0, 0, '{}'::jsonb);
  s := public.worker_liveness_check(true);
  if s <> 'fresh' then raise exception 'liveness after recovery: %', s; end if;
  if exists (select 1 from public.app_settings where key = 'worker.liveness_alert') then
    raise exception 'the alarm state survived the recovery';
  end if;
  if not exists (select 1 from public.events where kind = 'worker.recovered') then
    raise exception 'no worker.recovered event';
  end if;

  delete from public.worker_heartbeats where worker_id = 'w-live';
  s := public.worker_liveness_check(true);
  if s <> 'no-heartbeats' then raise exception 'liveness with no heartbeat rows: %', s; end if;

  -- a non-https edge url is refused
  begin
    perform public.worker_heartbeat('w-live', 'test', 0, 0, 0, '{}'::jsonb, 'http://evil.example');
    raise exception 'a non-https edge url was accepted';
  exception when raise_exception then
    if sqlerrm !~ 'https' then raise; end if;
  end;
end
$$;
release savepoint s;
reset role;

-- 4d. who may read the heartbeats: owner yes, crew no, nobody writes
savepoint s;
set local role service_role;
select public.worker_heartbeat('w-rls', 'test', 0, 0, 0, '{}'::jsonb);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e001", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (select count(*) from public.worker_heartbeats where worker_id = 'w-rls') <> 1 then
    raise exception 'the owner cannot read worker_heartbeats';
  end if;
  begin
    insert into public.worker_heartbeats (worker_id) values ('w-forged');
    raise exception 'the owner inserted a heartbeat';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.worker_heartbeat('w-forged', 'test', 0, 0, 0, '{}'::jsonb);
    raise exception 'the owner called worker_heartbeat';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e003", "role": "authenticated", "aud": "authenticated"}';
do $$
begin
  if (select count(*) from public.worker_heartbeats) <> 0 then
    raise exception 'a crew member can read worker_heartbeats';
  end if;
  begin
    perform public.outbox_claim('w-crew', null, 60, 1);
    raise exception 'a crew member claimed the outbox';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
release savepoint s;

rollback;
