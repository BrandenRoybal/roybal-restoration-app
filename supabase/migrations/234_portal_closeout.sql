-- ============================================================
-- 234_portal_closeout — CF-4 closeout + the home file
-- (docs/CRM_Design.md §8 CF-4, absorbing portal roadmap C3 and the
-- AI roadmap Phase-5 review engine's "tracks who was asked").
--
-- When a job reaches 'complete', the portal flips from progress
-- tracker to permanent RECORD:
--
--   portal_jobs.closeout — office-curated jsonb:
--     { completedAt, warrantyMonths, homeFile: [{label, value}] }
--   The home file is the retention moat: paint colors, materials,
--   shutoff locations — captured once, kept forever, every future
--   touch-up opens OUR portal.
--
--   contact_mark_review_asked(contact) — the never-ask-twice stamp.
--   contacts.review_asked_at is an RPC-only column (228's column-
--   privilege fence), so the office's "ask for a review" button needs
--   this narrow definer door: office roles only, stamps once, returns
--   whether THIS call did the stamping.
--
-- The warranty-request lane (a customer button that becomes a
-- channel:'repeat' board lead) needs NO DDL — leads are
-- coordination_jobs blobs, created by the service-role gateway
-- exactly like the three existing lead lanes.
--
-- SAFE & additive. Rollback: drop the function; drop the column.
-- ============================================================

alter table public.portal_jobs add column if not exists closeout jsonb;

comment on column public.portal_jobs.closeout is
  'CF-4 closeout record: {completedAt, warrantyMonths, homeFile:[{label,value}]}. Office-curated in the Client Portal form; served through the gateway allow-list only when status=complete.';

-- ------------------------------------------------------------
-- contact_mark_review_asked — stamp review_asked_at exactly once.
-- Returns true only when THIS call did the stamping (so the office UI
-- can distinguish "sent" from "was already asked").
-- ------------------------------------------------------------
create or replace function public.contact_mark_review_asked(p_contact uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  rc     int;
begin
  -- fail closed (the 228 lesson): a missing profiles row refuses
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office', 'tech') then
      return false;
    end if;
  end if;
  update public.contacts
     set review_asked_at = now()
   where id = p_contact and merged_into is null and review_asked_at is null;
  get diagnostics rc = row_count;
  return rc = 1;
end;
$$;

revoke execute on function public.contact_mark_review_asked(uuid) from public, anon;
grant  execute on function public.contact_mark_review_asked(uuid) to authenticated, service_role;

comment on function public.contact_mark_review_asked is
  'CF-4: the never-ask-twice review stamp. Office roles only (in-function gate); true = this call stamped it.';
