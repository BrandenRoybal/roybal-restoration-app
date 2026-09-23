-- 0009 — the customer portal's insurance claim panel.
--
-- One nullable jsonb column on portal_jobs, written by the field app's
-- Client Portal form when the office turns the panel on, and read only by
-- the roybal-portal gateway, which re-projects it through an allow-list
-- (carrier, claim number, date of loss, where the claim stands, deductible).
-- Null means no panel: nothing shows until the office fills it in.
--
-- No new table, policy, trigger or constraint, so the db-replay census is
-- unchanged. The column inherits portal_jobs' existing grants and RLS.
-- The gateway and the field app both tolerate this column being absent,
-- so code can ship before or after this applies.

alter table public.portal_jobs add column if not exists claim jsonb;

comment on column public.portal_jobs.claim is
  'Customer portal claim panel (office-curated): {carrier, claimNo, dateOfLoss, stage, deductible, deductibleState}. Null = panel off.';
