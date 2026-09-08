-- ============================================================
-- Roybal — morning brief (pg_cron + pg_net)
-- Every morning, POST to the roybal-brief Edge Function so the owner gets
-- one text with everything that needs attention: overdue invoices, budget-hot
-- jobs, equipment out too long, board slips, portal messages, and the
-- questions the office should be asking ("no drying log since Monday…").
--
-- SETUP (run once in the Supabase SQL Editor):
--   1. The Edge Function secret CRON_SECRET must already be set (it is —
--      the QB Time nightly pull uses the same one).
--   2. Replace __CRON_SECRET__ below with that exact value, then run this.
-- Mirrors 202_qb_time_cron.sql exactly.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'morning-brief') then
    perform cron.unschedule('morning-brief');
  end if;
end $$;

-- 15:00 UTC ≈ 7:00 AM Alaska in summer (6:00 AM in winter — the brief just
-- arrives an hour keener when it's dark out).
select cron.schedule(
  'morning-brief',
  '0 15 * * *',
  $$
  select net.http_post(
    url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Verify:   select jobname, schedule, active from cron.job;
-- Run logs: select * from cron.job_run_details order by start_time desc limit 10;
