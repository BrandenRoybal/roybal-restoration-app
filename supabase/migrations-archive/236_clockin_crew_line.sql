-- ============================================================
-- 236_clockin_crew_line — CF-2 rework: the who's-on-the-job-today
-- line fires on the crew's first QuickBooks Time clock-in of the
-- day, not at a fixed weekday morning (docs/CRM_Design.md §8 CF-2).
--
-- The 15:30 UTC weekday blast (233's 'portal-crew-lines') told the
-- customer who was SCHEDULED — even on days nobody showed. Now
-- qb-time-proxy's cron-guarded clockinSweep polls QB Time every 15
-- minutes: the first timesheet of the day on a linked job triggers
-- roybal-portal's publisher for exactly that job. Same board-schedule
-- names, same one-line-per-job-per-day dedupe (crew_line_date), plus
-- an SMS mirror when the customer converses by text. Weekends now
-- message too (a real Saturday clock-in is a real visit); jobs with
-- no QB jobcode link have no signal and stay silent.
--
-- The sweep gates itself to 8am–8pm Alaska — roybal-notify's SMS
-- quiet-hours window, which REFUSES (never queues) kind 'portal'
-- outside it — so an earlier clock-in is held and posts on the first
-- tick after 8, thread and text together. The schedule here can stay
-- a plain every-15-min. Auth headers are EXTRACTED at apply time from
-- the morning-brief job already on this database — the repo file
-- never carries them (233's discipline).
--
-- SAFE & additive (no schema change). Rollback: unschedule
-- 'qb-clockin-sweep' and re-run 233's do-block to restore the
-- morning schedule.
-- ============================================================

-- the 233 comment described the retired weekday-morning trigger
comment on column public.portal_jobs.notify_crew is
  'Office toggle: post the who''s-on-the-job-today line to this job''s thread on the crew''s first QB Time clock-in of the day (migration 236).';

do $$
declare
  v_cmd    text;
  v_secret text; v_apikey text; v_authz text;
begin
  select command into v_cmd from cron.job where jobname = 'morning-brief' limit 1;
  v_secret := substring(v_cmd from 'x-cron-secret'', ''([^'']+)');
  v_apikey := substring(v_cmd from '''apikey'', ''([^'']+)');
  v_authz  := substring(v_cmd from 'Authorization'', ''([^'']+)');
  if v_secret is null or v_apikey is null or v_authz is null then
    raise exception 'qb-clockin-sweep: could not extract auth from the morning-brief job — schedule manually';
  end if;

  -- the fixed-morning publisher this replaces
  if exists (select 1 from cron.job where jobname = 'portal-crew-lines') then
    perform cron.unschedule('portal-crew-lines');
  end if;
  if exists (select 1 from cron.job where jobname = 'qb-clockin-sweep') then
    perform cron.unschedule('qb-clockin-sweep');
  end if;

  perform cron.schedule(
    'qb-clockin-sweep',
    -- :03/:18/:33/:48 — every 15 min, offset so it never fires in the same
    -- minute as qb-time-daily-pull (14:00), which also refreshes the QB Time
    -- token; two simultaneous refreshes race on the rotating refresh token.
    -- The function itself skips 8pm–8am Alaska (the SMS quiet-hours window).
    '3-59/15 * * * *',
    format($j$
    select net.http_post(
      url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/qb-time-proxy',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', %L,
        'Authorization', %L,
        'x-cron-secret', %L
      ),
      body := '{"action":"clockinSweep"}'::jsonb
    );
    $j$, v_apikey, v_authz, v_secret));
end $$;
