-- ============================================================
-- 227_web_receptionist — the atomic guards behind the public
-- website AI receptionist (supabase/functions/roybal-web-agent).
--
-- WHY THIS IS A MIGRATION AND NOT TYPESCRIPT
--
-- roybal-web-agent is public and unauthenticated: anyone on the
-- internet can call it, and every turn spends real money at
-- Anthropic. An adversarial review of the design found that the
-- obvious implementation — read a counter, check it, then write —
-- loses badly to concurrency. Two thousand simultaneous requests
-- all read "0 sessions this hour", all pass the check, and all
-- insert. The nominal cap is 120/hour; the attacker gets 2,000.
--
-- So every counter here is a single statement, and every statement
-- takes a transaction-scoped advisory lock FIRST.
--
-- ⚠️ The advisory lock is load-bearing and not decorative. Postgres
-- runs at READ COMMITTED by default, where `insert … select … where
-- (select count(*) …) < n` does NOT serialize: concurrent
-- transactions each see a snapshot from before the others committed
-- and all pass. Wrapping the count+insert in pg_advisory_xact_lock
-- on a fixed key is what actually makes it atomic. The lock is held
-- only for the duration of one INSERT and released at commit, so at
-- this volume (≤120 sessions/hour) the serialization costs nothing.
--
-- The spend ledger works the same way, and for a sharper reason:
-- cost is RESERVED at its worst case BEFORE the Anthropic call, in
-- the same transaction that checks the cap, then reconciled down
-- afterward. A caller who drops the connection mid-response cannot
-- evade the ledger — the money is already booked. Recording spend
-- after the call is what lets an attacker run an unbounded bill
-- while the cap reads $0.00.
--
-- No new tables. Sessions are capture_events rows; spend is ai_usage
-- rows; leads are coordination_jobs rows. Same shapes the phone lane
-- and the field app already use.
-- ============================================================

-- ------------------------------------------------------------
-- 1. web_session_begin — mint a session, or refuse
--
-- Returns the capture_events id, or NULL when any limiter trips.
-- NULL is not an error: the caller degrades to the quote form.
-- ------------------------------------------------------------
create or replace function public.web_session_begin(
  p_ip_hash     text,
  p_subnet_hash text,
  p_origin      text,
  p_path        text,
  p_ua          text,
  p_service     text,
  p_ip_max      int,
  p_subnet_max  int,
  p_hourly_max  int
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- serialize all session minting; released at commit
  perform pg_advisory_xact_lock(hashtext('roybal.web_session_begin'));

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour'
         and raw_payload->>'ipHash' = p_ip_hash) >= p_ip_max then
    return null;
  end if;

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour'
         and raw_payload->>'subnetHash' = p_subnet_hash) >= p_subnet_max then
    return null;
  end if;

  if (select count(*) from public.capture_events
       where form_key = 'webReceptionist'
         and created_at > now() - interval '1 hour') >= p_hourly_max then
    return null;
  end if;

  insert into public.capture_events
    (source_type, form_key, captured_by, status, raw_payload, result)
  values
    ('web_chat', 'webReceptionist', 'web-agent', 'pending',
     jsonb_build_object(
       'ipHash',     p_ip_hash,     -- hashed; a visitor IP never lands raw
       'subnetHash', p_subnet_hash,
       'origin',     p_origin,
       'path',       left(coalesce(p_path, ''), 200),
       'ua',         left(coalesce(p_ua, ''), 200),
       'service',    left(coalesce(p_service, ''), 80)),
     jsonb_build_object('turns', 0, 'calls', 0, 'lead', false))
  returning id into v_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 2. web_turn_begin — RESERVE the worst-case cost, or refuse
--
-- Returns the ai_usage id to reconcile against, or NULL if any cap
-- is already met. The row is written at p_est_usd (pessimistic)
-- BEFORE the model call, so an abandoned request still counts.
-- ------------------------------------------------------------
create or replace function public.web_turn_begin(
  p_session_id  uuid,
  p_est_usd     numeric,
  p_model       text,
  p_daily_cap   numeric,
  p_lane_cap    numeric,
  p_shared_cap  numeric,
  p_max_calls   int,
  p_session_ttl_minutes int default 20
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calls   int;
  v_created timestamptz;
  v_month   text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  v_id      uuid;
begin
  -- serialize the reserve-and-check; released at commit
  perform pg_advisory_xact_lock(hashtext('roybal.web_turn_begin'));

  select (result->>'calls')::int, created_at
    into v_calls, v_created
    from public.capture_events
   where id = p_session_id and form_key = 'webReceptionist';

  if v_created is null then return null; end if;                              -- unknown session
  if v_created < now() - make_interval(mins => p_session_ttl_minutes) then     -- expired
    return null;
  end if;
  if coalesce(v_calls, 0) >= p_max_calls then return null; end if;            -- turn budget spent

  -- today, this lane
  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where form_key = 'webReceptionist'
         and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') >= p_daily_cap then
    return null;
  end if;

  -- this month, this lane
  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where form_key = 'webReceptionist'
         and billing_month = v_month) >= p_lane_cap then
    return null;
  end if;

  -- this month, ALL lanes — the web receptionist must never be able to
  -- starve the field app's AI budget
  if (select coalesce(sum(cost_usd), 0) from public.ai_usage
       where billing_month = v_month) >= p_shared_cap then
    return null;
  end if;

  insert into public.ai_usage
    (capture_event_id, captured_by, form_key, provider, llm_model,
     input_tokens, output_tokens, llm_cost_usd, cost_usd, note)
  values
    (p_session_id, 'web-agent', 'webReceptionist', 'anthropic', p_model,
     0, 0, p_est_usd, p_est_usd, 'reserved')
  returning id into v_id;

  -- charge two model rounds up front: a turn may take a tool round, and the
  -- budget must assume it did even if the request never comes back
  update public.capture_events
     set result = jsonb_set(
                    jsonb_set(coalesce(result, '{}'::jsonb),
                              '{calls}', to_jsonb(coalesce(v_calls, 0) + 2)),
                    '{turns}', to_jsonb(coalesce((result->>'turns')::int, 0) + 1))
   where id = p_session_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 3. web_turn_end — reconcile the reservation down to actuals
--
-- Never raises: a failed reconcile leaves the pessimistic reservation
-- standing, which is the safe direction for a spend cap.
-- ------------------------------------------------------------
create or replace function public.web_turn_end(
  p_usage_id   uuid,
  p_in_tokens  int,
  p_out_tokens int,
  p_actual_usd numeric
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.ai_usage
     set input_tokens  = greatest(p_in_tokens, 0),
         output_tokens = greatest(p_out_tokens, 0),
         llm_cost_usd  = greatest(p_actual_usd, 0),
         cost_usd      = greatest(p_actual_usd, 0),
         note          = 'settled'
   where id = p_usage_id
     and note = 'reserved';
$$;

-- ------------------------------------------------------------
-- 4. web_lead_insert — one lead per session, capped per day
--
-- The envelope is built by the caller so it stays field-for-field
-- identical to services/phone-agent/tools.mjs createLead and to
-- roybal-lead. This function only enforces the limits and writes.
-- ------------------------------------------------------------
create or replace function public.web_lead_insert(
  p_session_id uuid,
  p_lead       jsonb,
  p_daily_max  int
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_lead_insert'));

  -- one lead per conversation, no matter how the model is coaxed
  if (select coalesce((result->>'lead')::boolean, false)
        from public.capture_events
       where id = p_session_id and form_key = 'webReceptionist') is distinct from false then
    return null;
  end if;

  -- and a hard daily ceiling so a bad day can't bury the board
  if (select count(*) from public.coordination_jobs
       where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
         and data->>'channel' = 'ai-chat') >= p_daily_max then
    return null;
  end if;

  v_id := (p_lead->>'id')::uuid;
  insert into public.coordination_jobs (id, data, deleted)
  values (v_id, p_lead, false);

  update public.capture_events
     set result = jsonb_set(coalesce(result, '{}'::jsonb), '{lead}', 'true'::jsonb),
         status = 'confirmed',
         processed_at = now()
   where id = p_session_id;

  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- 5. web_alert_claim — atomically buy the right to send ONE owner text
--
-- Returns true if this session may send another alert, false otherwise.
--
-- WHY THIS EXISTS: the owner SMS was originally fired straight from the
-- function with no counter at all. An adversarial review found that a single
-- 20-minute session token could be replayed to send unlimited texts to up to
-- five recipients — including on the branch that runs AFTER the spend cap is
-- exhausted, because that branch skips the model entirely and so skipped
-- every meter with it. Twilio charges per message and the monthly SMS pool is
-- shared with the phone receptionist, so "free" turns were the most expensive
-- thing in the design.
--
-- Two ceilings, both atomic:
--   p_session_max — texts this ONE conversation may ever produce
--   p_daily_max   — texts the whole web lane may produce today
-- ------------------------------------------------------------
create or replace function public.web_alert_claim(
  p_session_id  uuid,
  p_session_max int,
  p_daily_max   int
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sent  int;
  v_today int;
begin
  perform pg_advisory_xact_lock(hashtext('roybal.web_alert_claim'));

  select coalesce((result->>'alerts')::int, 0) into v_sent
    from public.capture_events
   where id = p_session_id and form_key = 'webReceptionist';

  if v_sent is null then return false; end if;        -- unknown session
  if v_sent >= p_session_max then return false; end if;

  select coalesce(sum(coalesce((result->>'alerts')::int, 0)), 0) into v_today
    from public.capture_events
   where form_key = 'webReceptionist'
     and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  if v_today >= p_daily_max then return false; end if;

  update public.capture_events
     set result = jsonb_set(coalesce(result, '{}'::jsonb), '{alerts}', to_jsonb(v_sent + 1))
   where id = p_session_id;

  return true;
end;
$$;

-- ------------------------------------------------------------
-- Indexes for the counter queries above
-- ------------------------------------------------------------
create index if not exists capture_events_web_recent_idx
  on public.capture_events (created_at)
  where form_key = 'webReceptionist';

create index if not exists capture_events_web_iphash_idx
  on public.capture_events ((raw_payload->>'ipHash'))
  where form_key = 'webReceptionist';

create index if not exists capture_events_web_subnet_idx
  on public.capture_events ((raw_payload->>'subnetHash'))
  where form_key = 'webReceptionist';

create index if not exists ai_usage_month_formkey_idx
  on public.ai_usage (billing_month, form_key);

create index if not exists coordination_jobs_channel_day_idx
  on public.coordination_jobs (created_at)
  where data->>'channel' = 'ai-chat';

-- ------------------------------------------------------------
-- Grants — MANDATORY, not hygiene.
--
-- SECURITY DEFINER functions grant EXECUTE to PUBLIC by default.
-- roybal-web-agent is deployed --no-verify-jwt and the anon key is
-- published in the site bundle, so without these REVOKEs every RPC
-- above becomes a public PostgREST endpoint — including the one that
-- inserts leads.
-- ------------------------------------------------------------
revoke execute on function public.web_session_begin(text, text, text, text, text, text, int, int, int) from public, anon, authenticated;
revoke execute on function public.web_turn_begin(uuid, numeric, text, numeric, numeric, numeric, int, int)  from public, anon, authenticated;
revoke execute on function public.web_turn_end(uuid, int, int, numeric)                                     from public, anon, authenticated;
revoke execute on function public.web_lead_insert(uuid, jsonb, int)                                         from public, anon, authenticated;
revoke execute on function public.web_alert_claim(uuid, int, int)                                           from public, anon, authenticated;

grant execute on function public.web_session_begin(text, text, text, text, text, text, int, int, int) to service_role;
grant execute on function public.web_turn_begin(uuid, numeric, text, numeric, numeric, numeric, int, int)  to service_role;
grant execute on function public.web_turn_end(uuid, int, int, numeric)                                     to service_role;
grant execute on function public.web_lead_insert(uuid, jsonb, int)                                         to service_role;
grant execute on function public.web_alert_claim(uuid, int, int)                                           to service_role;

comment on function public.web_session_begin is
  'Public web receptionist: atomically mint a session or refuse. NULL = degrade to the form.';
comment on function public.web_turn_begin is
  'Public web receptionist: reserve worst-case spend BEFORE the model call. NULL = a cap is met.';
comment on function public.web_turn_end is
  'Public web receptionist: reconcile a reservation down to measured usage.';
comment on function public.web_lead_insert is
  'Public web receptionist: insert one lead per session, capped per day.';
