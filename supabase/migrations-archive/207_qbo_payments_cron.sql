-- ============================================================
-- Roybal — QuickBooks payment loop (pg_cron + pg_net)
-- Every night, POST {action:"pullPayments"} to the qbo-proxy Edge Function:
-- it reads the Balance of every invoice the app pushed to QuickBooks,
-- records new payments on the app's copy (payments[] + previousPayments +
-- status forward to partially_paid/paid), and the 7am morning brief then
-- reports "💰 received" and drops paid invoices from the overdue chase.
--
-- Runs at 14:30 UTC ≈ 6:30 AM Alaska in summer — half an hour BEFORE the
-- morning brief (15:00 UTC, migration 206) so the brief sees fresh payments.
--
-- SETUP (run once in the Supabase SQL Editor):
--   1. CRON_SECRET is already set (QB Time nightly pull + morning brief use it).
--   2. Replace __CRON_SECRET__ with that value and __ANON_KEY__ with the
--      project's anon/publishable key (Settings → API), then run this.
-- Mirrors 202_qb_time_cron.sql / 206_morning_brief_cron.sql.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'qbo-payment-pull') then
    perform cron.unschedule('qbo-payment-pull');
  end if;
end $$;

select cron.schedule(
  'qbo-payment-pull',
  '30 14 * * *',
  $$
  select net.http_post(
    url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/qbo-proxy',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__',
      'apikey', '__ANON_KEY__',
      'Authorization', 'Bearer __ANON_KEY__'
    ),
    body := '{"action":"pullPayments"}'::jsonb
  );
  $$
);

-- Verify:   select jobname, schedule, active from cron.job;
-- Run logs: select * from cron.job_run_details order by start_time desc limit 10;
