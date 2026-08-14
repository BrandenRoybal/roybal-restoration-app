-- ============================================================
-- 237_cron_keys_new_format — INCIDENT FIX 2026-08-14: every
-- function-calling pg_cron job was 401ing with
-- UNAUTHORIZED_INVALID_JWT_FORMAT (first retained failure
-- 17:00 UTC) because the legacy JWT-format anon key their
-- apikey/Authorization headers carried stopped validating —
-- the project's legacy API keys were disabled/rotated (the
-- platform-wide JWT-key sunset). Edge functions themselves
-- kept working (Supabase injects fresh keys at deploy), the
-- apps kept working (they ship the new sb_publishable key);
-- only the headers frozen inside cron.job commands died.
--
-- Fix: rewrite every net.http_post cron job's apikey and
-- Authorization headers to the sb_publishable key — verified
-- live to pass the functions verify_jwt gate. This key is
-- PUBLIC by design (it ships in apps/field/js/config.js), so
-- unlike the x-cron-secret (which stays untouched, never in
-- the repo) it can live in this file.
--
-- Affected jobs: morning-brief, gmail-inbox-pull,
-- qbo-payment-pull, qb-time-daily-pull, weekly-ai-report,
-- qb-clockin-sweep. (purge-blob-history and
-- repair-field-photos are SQL-only — no HTTP, untouched.)
--
-- Note for future migrations: 233/236 extracted these headers
-- from the morning-brief job — after this rewrite that
-- technique still works and now yields the durable key.
-- ============================================================

do $$
declare
  r record;
  v_new text;
  k_pub constant text := 'sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4';
begin
  for r in select jobid, jobname, command from cron.job
           where command like '%net.http_post%' loop
    v_new := regexp_replace(r.command,
      '''apikey'', ''[^'']+''',
      format('''apikey'', %L', k_pub));
    v_new := regexp_replace(v_new,
      '''Authorization'', ''[^'']+''',
      format('''Authorization'', %L', 'Bearer ' || k_pub));
    if v_new is distinct from r.command then
      perform cron.alter_job(job_id := r.jobid, command := v_new);
      raise notice 'rewrote cron auth: %', r.jobname;
    end if;
  end loop;
end $$;
