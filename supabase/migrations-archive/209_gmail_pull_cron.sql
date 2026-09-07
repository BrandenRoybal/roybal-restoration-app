-- ============================================================
-- Roybal — email lane inbox pull (pg_cron + pg_net)
-- Every 15 minutes, POST {action:"pullInbox"} to the gmail-proxy Edge
-- Function: it scans new inbox mail on the connected Gmail account and
-- files JOB-MATCHED messages into email_messages (unmatched mail is
-- never stored — the privacy contract in gmail-proxy/emailmatch.ts).
--
-- SETUP (run once in the Supabase SQL Editor, AFTER connecting Gmail
-- from the office admin):
--   Replace __CRON_SECRET__ with the CRON_SECRET value and __ANON_KEY__
--   with the project's anon key (Settings → API), then run this.
--   (Or use the lifted-secret installer from the PR notes — no
--   placeholders needed, it copies the secret from an existing job.)
-- Mirrors 207_qbo_payments_cron.sql.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'gmail-inbox-pull') then
    perform cron.unschedule('gmail-inbox-pull');
  end if;
end $$;

select cron.schedule(
  'gmail-inbox-pull',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/gmail-proxy',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__',
      'apikey', '__ANON_KEY__',
      'Authorization', 'Bearer __ANON_KEY__'
    ),
    body := '{"action":"pullInbox"}'::jsonb
  );
  $$
);

-- Verify:   select jobname, schedule, active from cron.job;
-- Run logs: select * from cron.job_run_details order by start_time desc limit 10;
