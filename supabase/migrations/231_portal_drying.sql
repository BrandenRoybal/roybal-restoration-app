-- ============================================================
-- 231_portal_drying — CF-2's drying card (docs/CRM_Design.md §8).
--
-- One nullable jsonb column on the customer-safe portal projection:
--
--   portal_jobs.drying — { asOf, areas: [{area, material, current,
--                          goal, dry}], equipmentOut }
--
-- READINGS ONLY, by design (the doc's adversarial review): a computed
-- "two more days" trend is a completion promise, and the shipped portal
-- discipline is that dates and commitments are human-only — the
-- concierge is grounded in this slice and would repeat whatever sits
-- here. So the projection carries measured facts (today's %, the dry
-- standard, machines running) and nothing predictive.
--
-- Populated by publishPortal() only when the office turns the "Share
-- drying progress" toggle on; null means the card simply doesn't render.
-- Served through the roybal-portal gateway's allow-list, like
-- everything else on the page.
--
-- Documents (the other CF-2 half) need NO DDL — portal_jobs.documents
-- has been reserved since migration 107 and finally gets its writer
-- (publishPortal) and its reader (the gateway) in this same change.
--
-- SAFE & additive. Rollback: alter table portal_jobs drop column drying.
-- ============================================================

alter table public.portal_jobs add column if not exists drying jsonb;

comment on column public.portal_jobs.drying is
  'Customer-safe drying summary — readings only (asOf, per-area current vs dry standard, equipment count). Never a trend or ETA; dates and commitments stay human-only.';
