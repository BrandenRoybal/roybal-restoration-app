-- ============================================================
-- Roybal — QuickBooks Time nightly auto-pull (pg_cron + pg_net)
-- Each morning, POST {action:"pullAllLinked"} to the qb-time-proxy Edge
-- Function so EVERY field job linked to a QB jobcode gets yesterday+today's
-- crew hours refreshed into `time_entries`. The daily construction log then
-- shows those hours automatically when opened (see qbTimeBar auto-load).
--
-- SETUP (run once in the Supabase SQL Editor):
--   1. The Edge Function secret CRON_SECRET must already be set (done via CLI).
--   2. Replace __CRON_SECRET__ below with that exact same value, then run this.
-- pg_cron + pg_net are pre-installed on Supabase.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Make re-running safe: drop any prior copy of the job first.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qb-time-daily-pull') then
    perform cron.unschedule('qb-time-daily-pull');
  end if;
end $$;

-- 14:00 UTC ≈ 6:00 AM Alaska. Pulls yesterday + today (Alaska local dates) so
-- both late edits to yesterday and same-day hours land. Server upsert is
-- idempotent and marks QB-removed rows deleted, so daily re-runs self-heal.
select cron.schedule(
  'qb-time-daily-pull',
  '0 14 * * *',
  $$
  select net.http_post(
    url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/qb-time-proxy',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__'
    ),
    body := jsonb_build_object(
      'action', 'pullAllLinked',
      'dates', jsonb_build_array(
        to_char((now() at time zone 'America/Anchorage')::date - 1, 'YYYY-MM-DD'),
        to_char((now() at time zone 'America/Anchorage')::date,     'YYYY-MM-DD')
      )
    )
  );
  $$
);

-- Verify:   select jobname, schedule, active from cron.job;
-- Run logs: select * from cron.job_run_details order by start_time desc limit 10;
-- Manual test now (replace secret): the same net.http_post body above.
