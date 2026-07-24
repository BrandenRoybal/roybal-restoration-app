-- ============================================================
-- Roybal — weekly "what the AI did" report (pg_cron + pg_net)
-- Sundays 17:00 UTC ≈ 9:00 AM Alaska: POST {mode:"weekly"} to
-- roybal-brief — one text summarizing the week's automated work
-- (payments recorded, email filed/sent, briefs, text approvals,
-- after-hours calls). Mirrors 206_morning_brief_cron.sql.
--
-- SETUP: replace __CRON_SECRET__ (or use the lifted-secret installer
-- from the PR notes — no placeholders needed).
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-ai-report') then
    perform cron.unschedule('weekly-ai-report');
  end if;
end $$;

select cron.schedule(
  'weekly-ai-report',
  '0 17 * * 0',
  $$
  select net.http_post(
    url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__'
    ),
    body := '{"mode":"weekly"}'::jsonb
  );
  $$
);

-- Verify:   select jobname, schedule, active from cron.job;
