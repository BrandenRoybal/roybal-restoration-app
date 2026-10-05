-- ============================================================================
-- 0017 — the worker extends only the leases it is actually working, and the
--        dead-worker alarm re-posts while the worker is down.
--
-- Two findings from the review of 0016 (PR #258), both in code nothing runs
-- yet: no worker has been deployed, so no row was ever affected.
--
-- 1. worker_heartbeat() extended EVERY jobs_queue/outbox lease whose
--    locked_by was this worker id. The id is the Fly machine's, so it survives
--    a crash or a deploy: rows the dead process left in `sending`/`leased`
--    were renewed every 30 s by its successor and never expired, so the
--    sweeper never turned them into retries — approved texts stuck forever,
--    invisible to every alarm. Now the worker passes the ids it is working
--    this instant (p_active_jobs, p_active_outbox) and only those are
--    extended; null or empty extends nothing. A predecessor's rows, and a row
--    whose settle call failed, expire at their own lease_until and the
--    sweeper retries them.
--
-- 2. worker_liveness_check() wrote its 24 h guard the moment it enqueued the
--    pg_net POST, before anyone knew whether roybal-webhooks received it or
--    texted anyone. One timed-out or refused POST muted the alarm for a day.
--    The 24 h "one text per outage" rule already lives in the edge function
--    (app_settings worker.alert_texted, re-read on every POST), so the
--    database now re-posts every 15 minutes for as long as the worker is
--    stale, and worker.liveness_alert is only the recovery marker. The
--    no-secret branch keys its event per day instead of per minute, so a
--    missing secret cannot fill the append-only events table.
--
-- Census: unchanged (a function dropped and re-created under a new
-- signature, a function replaced).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. worker_heartbeat — new signature. The 8-argument form from 0016 is
--    dropped so PostgREST has exactly one function of this name to resolve.
-- ---------------------------------------------------------------------------
drop function if exists public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer);

create or replace function public.worker_heartbeat(
  p_worker_id      text,
  p_version        text    default null,
  p_queue_depth    integer default null,
  p_leased         integer default null,
  p_outbox_pending integer default null,
  p_meta           jsonb   default '{}'::jsonb,
  p_edge_base_url  text    default null,
  p_lease_seconds  integer default 300,
  p_active_jobs    uuid[]  default null,
  p_active_outbox  uuid[]  default null
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

  -- Only the rows this process is working right now. A row this worker id
  -- holds but did not name (left by a crashed predecessor, or abandoned after
  -- a failed settle) keeps its lease_until and expires into a retry.
  if p_active_jobs is not null and cardinality(p_active_jobs) > 0 then
    update public.jobs_queue
       set lease_until  = greatest(lease_until, now() + make_interval(secs => p_lease_seconds)),
           heartbeat_at = now()
     where status = 'leased' and locked_by = p_worker_id and id = any(p_active_jobs);
  end if;

  if p_active_outbox is not null and cardinality(p_active_outbox) > 0 then
    update public.outbox
       set lease_until = greatest(lease_until, now() + make_interval(secs => p_lease_seconds))
     where status = 'sending' and locked_by = p_worker_id and id = any(p_active_outbox);
  end if;

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

alter function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer, uuid[], uuid[]) owner to postgres;
comment on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer, uuid[], uuid[]) is
  'The worker''s 30 s check-in: upserts worker_heartbeats, extends the jobs_queue and outbox leases named in p_active_jobs / p_active_outbox (only those; a row this worker holds but is no longer working expires into a retry), records app_settings edge.base_url for the liveness alarm. service_role only.';
revoke all on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.worker_heartbeat(text, text, integer, integer, integer, jsonb, text, integer, uuid[], uuid[]) to service_role;


-- ---------------------------------------------------------------------------
-- 2. worker_liveness_check — re-post every 15 minutes while stale. Return
--    values as in 0016, with one meaning changed:
--      stale-guarded   a POST went out in the last 15 minutes (was: 24 h)
--    The edge function decides whether a POST becomes a text (once per 24 h,
--    app_settings worker.alert_texted); the database's job is only to keep
--    knocking until the worker is back. worker.liveness_alert keeps
--    first_stale_at so the worker.recovered event can say how long it was out.
-- ---------------------------------------------------------------------------
create or replace function public.worker_liveness_check(p_dry_run boolean default false) returns text
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_url      text;
  v_last     timestamptz;
  v_worker   text;
  v_state    jsonb;
  v_secret   text;
  v_req      bigint;
  v_first    timestamptz;
  v_stale    constant interval := interval '10 minutes';
  v_repost   constant interval := interval '15 minutes';
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
        jsonb_build_object('worker_id', v_worker, 'heartbeat_at', v_last,
                           'first_stale_at', v_state ->> 'first_stale_at',
                           'alerted_at', v_state ->> 'alerted_at',
                           'posts', coalesce((v_state ->> 'posts')::integer, 0)),
        'worker.recovered:' || to_char(v_last at time zone 'UTC', 'YYYYMMDDHH24MISS'));
    end if;
    return 'fresh';
  end if;

  if v_state is not null
     and (v_state ->> 'alerted_at')::timestamptz > now() - v_repost then
    return 'stale-guarded';
  end if;

  if coalesce(p_dry_run, false) then
    return 'stale-would-alert';
  end if;

  v_first := coalesce((v_state ->> 'first_stale_at')::timestamptz, now());

  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s
   where s.name = 'worker_alert_secret'
   order by s.created_at desc
   limit 1;
  if v_secret is null then
    -- One ledger row per day, not per tick: events is append-only.
    perform public.emit_event(
      'worker.stale', null, 'worker', null, null, null, null,
      jsonb_build_object('worker_id', v_worker, 'last_heartbeat_at', v_last, 'alert', 'no worker_alert_secret in the vault'),
      'worker.stale:no-secret:' || to_char(now() at time zone 'UTC', 'YYYYMMDD'));
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
           timeout_milliseconds => 20000)
    into v_req;

  insert into public.app_settings (key, value)
  values ('worker.liveness_alert',
          jsonb_build_object('alerted_at', now(), 'first_stale_at', v_first, 'last_heartbeat_at', v_last,
                             'worker_id', v_worker, 'request_id', v_req,
                             'posts', coalesce((v_state ->> 'posts')::integer, 0) + 1))
  on conflict (key) do update set value = excluded.value, updated_at = now();

  perform public.emit_event(
    'worker.stale', null, 'worker', null, null, null, null,
    jsonb_build_object('worker_id', v_worker, 'last_heartbeat_at', v_last, 'first_stale_at', v_first, 'request_id', v_req),
    'worker.stale:' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MI'));

  return 'stale-alerted';
end;
$$;

alter function public.worker_liveness_check(boolean) owner to postgres;
comment on function public.worker_liveness_check(boolean) is
  'The dead-worker alarm: no heartbeat for 10 minutes → a pg_net POST to <edge.base_url>/functions/v1/roybal-webhooks/alert carrying the vault secret worker_alert_secret, repeated every 15 minutes while stale (the edge function texts the owner at most once per 24 h). app_settings worker.liveness_alert is the recovery marker. pg_cron job worker-liveness-check, every 5 minutes. p_dry_run reports without posting.';
revoke all on function public.worker_liveness_check(boolean) from public, anon, authenticated;
grant execute on function public.worker_liveness_check(boolean) to service_role;
