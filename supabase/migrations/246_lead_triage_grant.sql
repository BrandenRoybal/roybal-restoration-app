-- ============================================================
-- 246_lead_triage_grant — open coordination_job_patch to verified
-- office callers (CRM home, docs/CRM_Design.md §13.3).
--
-- The Leads Inbox in the office admin triages lead cards: set a
-- follow-up, stamp first touch, mark lost. Those are POST-HOC writes
-- to blobs the board saves whole under its rev guard — exactly what
-- coordination_job_patch (230) exists for. The doc's instruction:
-- extend this function's reach, never write a second RPC.
--
-- 230 made it service-role-only because its callers were server code.
-- The admin runs in a browser on a crew JWT, so this re-creates the
-- function with the contact_merge role gate (230:103-108 pattern):
-- a caller with auth.uid() (i.e. any JWT) must hold profiles.role
-- admin|office or the call is a null no-op; service-role calls
-- (auth.uid() is null) pass untouched, so 230's server callers —
-- contact_merge's board-repoint loop, backfills — are unaffected.
--
-- No new exposure: an authenticated office session can ALREADY write
-- coordination_jobs rows directly (the legacy for-all policies 216
-- documents). This grant only makes such writes rev-SAFE.
--
-- SAFE & additive. Rollback: re-apply the 230 definition and
--   revoke execute on public.coordination_job_patch(uuid, jsonb)
--     from authenticated;
-- ============================================================

create or replace function public.coordination_job_patch(
  p_id    uuid,
  p_patch jsonb          -- top-level keys only, e.g. {"nextActionAt":"…"}
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_data jsonb;
  v_rev  int;
  v_prev timestamptz;
  v_ts   text;
begin
  -- 246: a JWT caller must be a verified office user (the contact_merge
  -- gate). Refusal is a null no-op, same as a missing row — this function
  -- must not become an existence oracle for job ids.
  if v_uid is not null then
    select p.role::text into v_role from public.profiles p where p.id = v_uid;
    if v_role is null or v_role not in ('admin', 'office') then
      return null;
    end if;
  end if;

  select data into v_data from public.coordination_jobs
    where id = p_id and deleted = false
    for update;                                  -- serialize against a concurrent board save
  if v_data is null then return null; end if;    -- gone or tombstoned → no-op, not an error

  v_rev := coalesce((v_data->>'rev')::int, 0) + 1;
  -- prior timestamp, tolerant of a missing OR malformed updatedAt (the 218/225
  -- precedent: a bare ('')::timestamptz raises 22007 and coalesce can't catch it)
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

-- anon stays revoked (the key is in git); authenticated is admitted but the
-- in-function gate above is what actually decides.
revoke execute on function public.coordination_job_patch(uuid, jsonb) from public, anon;
grant  execute on function public.coordination_job_patch(uuid, jsonb) to service_role, authenticated;

comment on function public.coordination_job_patch is
  'Board Tier 1 + CRM §13.3: rev-bumping shallow patch of a coordination_jobs blob so the board adopts (not clobbers) the change. service_role, or a JWT whose profiles.role is admin|office (others: null no-op).';
