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
  v_cmd    text;
  v_secret text; v_apikey text; v_authz text;
begin
  -- reuse the cron secret AND the platform auth headers the morning-brief
  -- job already carries (roybal-portal deploys verify_jwt=true, so pg_cron
  -- must present the anon key like every other cron); never write any of
  -- them into a repo file
  select command into v_cmd from cron.job where jobname = 'morning-brief' limit 1;
  v_secret := substring(v_cmd from 'x-cron-secret'', ''([^'']+)');
  v_apikey := substring(v_cmd from '''apikey'', ''([^'']+)');
  v_authz  := substring(v_cmd from 'Authorization'', ''([^'']+)');
  if v_secret is null or v_apikey is null or v_authz is null then
    raise exception 'portal-crew-lines: could not extract auth from the morning-brief job — schedule manually';
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
        'apikey', %L,
        'Authorization', %L,
        'x-cron-secret', %L
      ),
      body := '{"action":"dailyCrewLines"}'::jsonb
    );
    $j$, v_apikey, v_authz, v_secret));
end $$;
