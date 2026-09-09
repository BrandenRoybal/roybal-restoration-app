-- ============================================================================
-- 0003 — give the cron lanes longer than five seconds to answer
--
-- pg_net's default request timeout is 5000 ms, and not one of the nine cron
-- jobs set `timeout_milliseconds`. Every scheduled call therefore inherited a
-- five-second cap on functions that talk to Gmail, QuickBooks Time and QBO —
-- none of which reliably answer that fast. Measured 2026-09-09:
--
--   qb-time-proxy   up to 16,155 ms
--   qbo-proxy           10,043 ms
--   gmail-proxy          6,443 ms   (avg 2,868 ms — intermittent)
--
-- WHAT THIS DOES AND DOES NOT FIX. The functions run to completion regardless:
-- time_entries was written at 14:00:13 today by a call pg_net had already given
-- up on. So the damage is not lost work, it is lost VISIBILITY — the response
-- is discarded, net._http_response records only a timeout, and a lane that
-- genuinely breaks looks identical to one that is merely slow. That is exactly
-- how the integrations went days without anyone noticing. Raising the timeout
-- makes the difference observable again.
--
-- ONLY THE HTTP JOBS. `purge-blob-history` and `repair-field-photos` are plain
-- SQL, not net.http_post, and appending a pg_net parameter to them produces
-- `select public.repair_field_photos(, timeout_milliseconds := 30000);` — SQL
-- that does not parse, silently replacing a working nightly job with a broken
-- one. The `command ~ 'net\.http_post'` guard below is load-bearing; a dry run
-- is what caught it.
--
-- Idempotent: a job that already carries the parameter is skipped, so this can
-- be re-applied against a database where some jobs were fixed by hand.
-- ============================================================================

do $$
declare
  j record;
  new_command text;
  changed int := 0;
begin
  for j in
    select jobid, jobname, command
      from cron.job
     where command ~ 'net\.http_post'          -- HTTP lanes only (see above)
       and command !~* 'timeout_milliseconds'  -- idempotent
  loop
    -- append the parameter to the http_post argument list: the command ends
    -- with the call's own `);`, so this lands inside the parentheses.
    new_command := regexp_replace(j.command, '\)\s*;\s*$', ', timeout_milliseconds := 30000);');

    if new_command = j.command then
      raise warning 'cron job % not rewritten — unexpected command shape, left alone', j.jobname;
      continue;
    end if;

    perform cron.alter_job(j.jobid, command => new_command);
    changed := changed + 1;
  end loop;

  raise notice 'cron http timeout: % job(s) updated', changed;
end $$;
