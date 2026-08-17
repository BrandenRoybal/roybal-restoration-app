-- ============================================================
-- 244_crew_digest_cron — every crew member's "where you're working
-- today" text, weekday mornings.
--
-- roybal-brief mode:"crewDigest" slices the Job Board's live
-- schedule per crew member (crewdigest.ts, running the board's own
-- engine) and texts each one their day through roybal-notify
-- (kind 'scheduleCrew' — quiet-hours-guarded backstop), plus one
-- roll-up to the owner (kind 'brief'). Members with nothing
-- scheduled, out days, or no phone are skipped and named in the
-- roll-up; a re-run inside 20h never double-texts (the function
-- checks the sms ledger first).
--
-- 16:00 UTC = 8:00am AKDT (summer) / 7:00am AKST (winter) — inside
-- the 7am–8pm send window year-round, after the crew's day starts
-- forming but before they leave the house. Weekdays only here;
-- the function itself also honors the board's work-calendar
-- holidays (a holiday morning sends nothing).
--
-- Auth headers are EXTRACTED at apply time from the morning-brief
-- job already on this database (236's discipline) — the repo file
-- never carries them.
--
-- SAFE & additive (no schema change). Rollback:
--   select cron.unschedule('crew-schedule-digest');
-- ============================================================

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
    raise exception 'crew-schedule-digest: could not extract auth from the morning-brief job — schedule manually';
  end if;

  if exists (select 1 from cron.job where jobname = 'crew-schedule-digest') then
    perform cron.unschedule('crew-schedule-digest');
  end if;

  perform cron.schedule(
    'crew-schedule-digest',
    '0 16 * * 1-5',
    format($j$
    select net.http_post(
      url     := 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-brief',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', %L,
        'Authorization', %L,
        'x-cron-secret', %L
      ),
      body := '{"mode":"crewDigest"}'::jsonb
    );
    $j$, v_apikey, v_authz, v_secret));
end $$;
