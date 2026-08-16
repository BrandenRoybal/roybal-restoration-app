-- ============================================================
-- 240: marketing_opt_in_at — WHEN consent was given (CF-5).
--
-- A boolean says yes; a timestamp says yes-and-when, which is what
-- a consent record needs. Stamped wherever the flag flips on:
--   * the portal "Stay in the loop" card (verified contact session —
--     the strongest consent evidence we hold: they proved the phone)
--   * the site quote form — NEW contacts only: the public lane never
--     enriches an existing person (228's rule), so a stranger typing
--     a customer's phone still can't flip their flag
--   * the admin contact page (office acting on a spoken/written yes)
-- Cleared to null when consent is withdrawn.
-- ============================================================

alter table public.contacts
  add column if not exists marketing_opt_in_at timestamptz;

comment on column public.contacts.marketing_opt_in_at is
  'when marketing consent was last given (null when off) — CF-5 consent record';
