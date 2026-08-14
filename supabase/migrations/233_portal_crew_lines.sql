-- ============================================================
-- 233_portal_crew_lines — CF-2's who's-coming-today line
-- (docs/CRM_Design.md §8 CF-2).
--
-- A NEW schedule-driven publisher: every weekday morning, each
-- enabled portal job whose office toggle allows it gets one thread
-- message naming the crew scheduled at the property today — computed
-- from the board blob's crewIds/crewSpans/dayCrew (the pure helper
-- crewtoday.mjs, node-tested). Kills the stranger-at-my-door problem
-- with data the Gantt already computes.
--
-- Facts only: WHO is scheduled TODAY. Never a finish date — the same
-- readings-only discipline as the drying card (231).
--
--   portal_jobs.notify_crew    — the office's default-on toggle
--   portal_jobs.crew_line_date — dedupe: one line per job per day
--   pg_cron 'portal-crew-lines' — 15:30 UTC ≈ 7:30 AM Alaska, hitting
--     roybal-portal's cron-guarded dailyCrewLines action
--
-- The cron secret is EXTRACTED at apply time from the morning-brief
-- job already scheduled on this database — the repo file never
-- carries it (206's __CRON_SECRET__ discipline, one step further).
--
-- SAFE & additive. Rollback: cron.unschedule('portal-crew-lines');
-- drop the two columns.
-- ============================================================

alter table public.portal_jobs add column if not exists notify_crew boolean not null default true;
alter table public.portal_jobs add column if not exists crew_line_date date;

comment on column public.portal_jobs.notify_crew is
  'Office toggle: post the weekday who''s-coming-today line to this job''s thread.';
comment on column public.portal_jobs.crew_line_date is
  'Last Alaska date a crew line was posted — one per job per day.';

do $$
declare
  v_secret text;
begin
  -- reuse the cron secret the morning-brief job already carries; never
  -- write it into a repo file
  select substring(command from 'x-cron-secret'', ''([^'']+)') into v_secret
    from cron.job where jobname = 'morning-brief' limit 1;
  if v_secret is null or v_secret = '' then
    raise exception 'portal-crew-lines: could not extract the cron secret from the morning-brief job — schedule manually';
  end if;

  if exists (select 1 from cron.job where jobname = 'portal-crew-lines') then
    perform cron.unschedule('portal-crew-lines');
  end if;

  perform cron.schedule(
    'portal-crew-lines',
    '30 15 * * 1-5',    -- weekdays 15:30 UTC ≈ 7:30 AM Alaska (6:30 in winter)
    format($j$
    select net.http_post(
      url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-portal',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', %L
      ),
      body := '{"action":"dailyCrewLines"}'::jsonb
    );
    $j$, v_secret));
end $$;
