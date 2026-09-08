-- ============================================================
-- 230_coordination_job_patch — Board coordination_jobs server write
-- authority, Tier 1 (docs/Board_Sync_RPC_Plan.md §3).
--
-- The board replaces the WHOLE data blob under a guard that only
-- notices a HIGHER server rev (apps/board/js/data.js:97-119). So a
-- server-side stamp of data.contactId that does not bump rev is both
-- invisible to the guard AND destroyed by the board's next save.
-- Migration 229 deferred the board-blob contactId link for exactly
-- this reason (229:20-22).
--
-- This migration adds the rev-bumping patch the board's own guard then
-- adopts instead of clobbering, and wires the two post-hoc stampers
-- through it:
--   1. coordination_job_patch(id, patch)  — service-role-only helper
--   2. contact_merge  — repoint the board blob's contactId (extends 229)
--   3. backfill        — stamp contactId onto existing lead cards
--
-- Tier 2 (the full field-style board sync rework) is intentionally NOT
-- here — see the plan's §4 "recommended stopping point".
--
-- SAFE & additive. Rollback: drop coordination_job_patch; re-apply the
-- migration-229 contact_merge (without the board loop). The backfill is
-- idempotent (a card already carrying contactId is skipped) and
-- reversible (null the blob key).
-- ============================================================

-- ------------------------------------------------------------
-- 1. coordination_job_patch — merge a top-level patch onto a live
--    job blob, bump rev so the board's whole-blob guard SEES the
--    change, and stamp a clock-skew-safe updatedAt.
--
--    Service-role ONLY: a definer function defaults EXECUTE to PUBLIC
--    and the anon key is in git (the 227 lesson). No crew/board device
--    calls this; it exists for server code (contact_merge, backfill).
--
--    Verified in a rolled-back prod transaction: rev bump, caller
--    cannot override rev/updatedAt, malformed OR absent prior
--    updatedAt does not throw, missing/deleted row → null no-op.
-- ------------------------------------------------------------
create or replace function public.coordination_job_patch(
  p_id    uuid,
  p_patch jsonb          -- top-level keys only, e.g. {"contactId":"…"}
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_data jsonb;
  v_rev  int;
  v_prev timestamptz;
  v_ts   text;
begin
  select data into v_data from public.coordination_jobs
    where id = p_id and deleted = false
    for update;                                  -- serialize against a concurrent board save
  if v_data is null then return null; end if;    -- gone or tombstoned → no-op, not an error

  v_rev := coalesce((v_data->>'rev')::int, 0) + 1;
  -- prior timestamp, tolerant of a missing OR malformed updatedAt: a bare
  -- ('')::timestamptz RAISES 22007 and coalesce cannot catch it, so one bad
  -- blob would abort the whole merge/backfill. Both precedents wrap it
  -- (218_sync_rpcs_and_build_gate.sql:256-257, 225_photo_trash_and_restore.sql:123).
  begin v_prev := (v_data->>'updatedAt')::timestamptz; exception when others then v_prev := null; end;
  -- strictly newer than what's on file and not behind the clock (the 218 rule)
  v_ts := to_char(greatest(now(), coalesce(v_prev, to_timestamp(0)) + interval '1 ms')
            at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- shallow merge (patch keys win), then OVERLAY rev+updatedAt so the caller
  -- can never set them — they are function-controlled
  v_data := (v_data || p_patch) || jsonb_build_object('rev', v_rev, 'updatedAt', v_ts);
  update public.coordination_jobs set data = v_data where id = p_id;   -- coordination_touch() stamps the updated_at COLUMN
  return v_data;
end;
$$;

revoke execute on function public.coordination_job_patch(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.coordination_job_patch(uuid, jsonb) to service_role;

comment on function public.coordination_job_patch is
  'Board Tier 1: server-side rev-bumping shallow patch of a coordination_jobs blob so the board adopts (not clobbers) the change on its next save. service_role only.';

-- ------------------------------------------------------------
-- 2. contact_merge — extend the migration-229 definition to repoint
--    the board lead blob's contactId THROUGH the rev-bumping patch.
--    Everything else is byte-identical to the deployed 229 function.
-- ------------------------------------------------------------
create or replace function public.contact_merge(p_winner uuid, p_loser uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_l    public.contacts%rowtype;
  r      record;
  v_a    uuid;
  v_b    uuid;
begin
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office') then
      return false;
    end if;
  end if;

  if p_winner is null or p_loser is null or p_winner = p_loser then return false; end if;

  perform pg_advisory_xact_lock(hashtext('roybal.contact_resolve'));

  select * into v_l from public.contacts where id = p_loser  and merged_into is null;
  if v_l.id is null then return false; end if;
  perform 1 from public.contacts where id = p_winner and merged_into is null;
  if not found then return false; end if;

  update public.contacts w set
    phone   = case when w.phone   = '' then v_l.phone   else w.phone   end,
    email   = case when w.email   = '' then v_l.email   else w.email   end,
    address = case when w.address = '' then v_l.address else w.address end,
    company = case when w.company = '' then v_l.company else w.company end,
    notes   = case when v_l.notes = '' then w.notes
                   when w.notes  = ''  then v_l.notes
                   else w.notes || E'\n' || v_l.notes end,
    qbo_customer_id  = coalesce(w.qbo_customer_id, v_l.qbo_customer_id),
    marketing_opt_in = w.marketing_opt_in or v_l.marketing_opt_in,
    review_asked_at  = greatest(w.review_asked_at, v_l.review_asked_at)
  where w.id = p_winner;

  update public.contacts set merged_into = p_winner where id = p_loser;
  update public.contacts set merged_into = p_winner where merged_into = p_loser;

  update public.unified_jobs   set contact_id = p_winner where contact_id = p_loser;
  update public.sms_messages   set contact_id = p_winner where contact_id = p_loser;
  update public.email_messages set contact_id = p_winner where contact_id = p_loser;
  update public.portal_jobs    set contact_id = p_winner where contact_id = p_loser;
  update public.capture_events set contact_id = p_winner where contact_id = p_loser;

  -- NEW in 230: the board lead blob stores contactId as a JSON string; repoint
  -- it through the rev-bumping patch so a coordinator's next save adopts the
  -- winner instead of clobbering it back to the loser (or to nothing).
  for r in select id from public.coordination_jobs
            where deleted = false and data->>'contactId' = p_loser::text
  loop
    perform public.coordination_job_patch(r.id, jsonb_build_object('contactId', p_winner::text));
  end loop;

  update public.contact_merge_suggestions
     set status = 'merged', resolved_at = now()
   where status = 'open' and contact_b is not null
     and contact_a in (p_winner, p_loser) and contact_b in (p_winner, p_loser);

  for r in select * from public.contact_merge_suggestions
            where status = 'open' and (contact_a = p_loser or contact_b = p_loser)
  loop
    v_a := case when r.contact_a = p_loser then p_winner else r.contact_a end;
    v_b := case when r.contact_b = p_loser then p_winner else r.contact_b end;
    if v_a = v_b then
      delete from public.contact_merge_suggestions where id = r.id;
    else
      begin
        update public.contact_merge_suggestions
           set contact_a = v_a, contact_b = v_b where id = r.id;
      exception when unique_violation then
        delete from public.contact_merge_suggestions where id = r.id;
      end;
    end if;
  end loop;

  return true;
end;
$$;

comment on function public.contact_merge is
  'Office-only merge: unions blanks into the winner, tombstones the loser, repoints the five link columns AND the board blob contactId (230, via coordination_job_patch), closes the pair''s suggestions, repoints the rest.';

-- ------------------------------------------------------------
-- 3. Backfill — stamp contactId onto existing lead cards.
--    Each card's customer was already seeded into contacts by
--    migration 228 (loop d), so contact_resolve returns the EXISTING
--    contact via ladder step 0 / phone match — no duplicates minted.
--    Trusted (these are office-created cards). Idempotent: a card that
--    already carries contactId is skipped by the filter.
-- ------------------------------------------------------------
do $$
declare
  r record;
  v uuid;
begin
  for r in select id,
                  data->>'customer' as customer, data->>'phone' as phone,
                  data->>'email' as email, data->>'address' as address,
                  coalesce(nullif(data->>'channel',''), 'backfill') as source
             from public.coordination_jobs
            where deleted = false
              and coalesce(data->>'contactId','') = ''
              and (coalesce(data->>'customer','') <> '' or coalesce(data->>'phone','') <> '')
  loop
    v := public.contact_resolve(r.customer, r.phone, r.email, r.address, r.source, true, 'customer');
    if v is not null then
      perform public.coordination_job_patch(r.id, jsonb_build_object('contactId', v::text));
    end if;
  end loop;
end;
$$;
