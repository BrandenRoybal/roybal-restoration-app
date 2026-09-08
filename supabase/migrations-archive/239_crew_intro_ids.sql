-- ============================================================
-- 239: crew_intro_ids — introduce each crew member ONCE per job
--      (crew-bios phase 2).
--
-- The first morning the daily crew line NAMES a member, that one
-- text also carries the meet-the-crew intro (+ MMS headshot when
-- their bio is public) and the member's id lands here. Every later
-- day is the plain line — never a repeat intro. Board-named crew
-- only: QB-clock-in fallback names have no crew id and get no
-- intro (they're introduced the first day the board schedules
-- them). Claim-then-post semantics carry over: the intro stamps
-- with the same claim, so at worst an intro is lost, never spammed.
-- ============================================================

alter table public.portal_jobs
  add column if not exists crew_intro_ids jsonb not null default '[]'::jsonb;

comment on column public.portal_jobs.crew_intro_ids is
  'crew_members ids already introduced on this job''s crew line (crew-bios phase 2) — stamped with the day claim the first time the line names them';
