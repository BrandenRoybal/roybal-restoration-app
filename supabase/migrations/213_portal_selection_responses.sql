-- ============================================================
-- Roybal — the customer's answer on a selection.
--
-- 212 created the decisions; this lets the customer respond to them.
-- There is no product catalog yet, so the honest interaction is not
-- "pick a floor" — it is:
--
--     keep what was there   (covered by insurance, costs them nothing)
--     I'd like something different   (opens the conversation)
--
-- That second answer is the whole point. It surfaces an upgrade at the
-- moment the customer is looking at their own gutted room, and hands the
-- office a named list of who wants to talk — without promising a price
-- for a product we cannot yet quote.
--
-- The chosen_* columns from 212 stay reserved for when a catalog exists;
-- these columns are about intent, which is a different thing and should
-- not be smuggled into them.
--
-- SAFE & additive. Run once: Supabase Dashboard -> SQL Editor -> Run.
-- ============================================================

alter table public.portal_selections
  add column if not exists customer_choice text;         -- 'match' | 'change' | null (unanswered)
alter table public.portal_selections
  add column if not exists customer_note text;           -- free text when they want something different
alter table public.portal_selections
  add column if not exists responded_at timestamptz;

-- Only the two answers the portal can send, or nothing yet.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'portal_selections_choice_chk'
  ) then
    alter table public.portal_selections
      add constraint portal_selections_choice_chk
      check (customer_choice is null or customer_choice in ('match', 'change'));
  end if;
end $$;

-- The office view that matters: who is waiting on a conversation.
create index if not exists portal_selections_wants_change_idx
  on public.portal_selections (portal_job_id)
  where customer_choice = 'change';

alter table public.portal_jobs
  add column if not exists selections_submitted_at timestamptz;
