-- ============================================================
-- 219: make the RPCs the ONLY door (Phase 2b cutover)
-- ------------------------------------------------------------
-- ⚠️⚠️  DO NOT APPLY AUTOMATICALLY. OPERATOR-GATED. ⚠️⚠️
-- This is the one irreversible-feeling step of the rearchitecture: after it,
-- an app build that still writes field_projects directly can no longer sync
-- at all. Applied too early it stops the crew mid-job; applied at the right
-- moment it permanently ends the clobber class that erased the Awthentis
-- contents.
--
-- WHAT IT DOES
--   Revokes INSERT/UPDATE/DELETE on field_projects from the app roles, so
--   every write must go through push_project / tombstone_project /
--   revive_project (217/218) — which merge server-side and therefore cannot
--   lose another device's work. SELECT is deliberately KEPT: sync pull reads
--   the table directly.
--   service_role is unaffected (edge functions: qbo-proxy's payment
--   writeback, etc. — verified those are the only other writers).
--
-- PRECONDITIONS — verify ALL of these first
--   1. The RPC build is deployed and every device has actually taken it.
--      A device's build is its service-worker cache version; the app sends
--      it on every RPC call. Check what the fleet is really running:
--        select p_build, count(*), max(replaced_at)
--          from blob_history where replaced_at > now() - interval '7 days'
--         group by 1;                       -- (once build telemetry lands)
--      Simplest reliable check: open the app on each device and read the
--      "build vNNN" label at the bottom of the menu. All must be >= 133,
--      the build that shipped SYNC_VIA_RPC (sw.js CACHE roybal-field-v133).
--   2. Arm the build floor FIRST and watch for a day — it produces a clear
--      "update the app" error instead of a silent failure:
--        update app_settings set value = to_jsonb(133) where key = 'min_field_build';
--   3. Confirm no non-service-role writer remains:
--        grep -rn "field_projects" apps/ supabase/functions/ | grep -iE "patch|post|upsert"
--   4. Apply during a quiet window (evening), not mid-job.
--
-- ROLLBACK (instant, if the crew reports sync errors)
--   grant insert, update, delete on public.field_projects to authenticated;
--   …and set SYNC_VIA_RPC = false in apps/field/js/config.js, then redeploy.
-- ============================================================

set lock_timeout = '5s';

revoke insert, update, delete on public.field_projects from anon, authenticated;
-- SELECT stays: the sync pull reads rows directly.
grant  select on public.field_projects to authenticated;

comment on table public.field_projects is
  'Job blobs. WRITES GO THROUGH THE RPCs ONLY (push_project / '
  'tombstone_project / revive_project, migrations 217/218): they merge '
  'server-side so a stale client cannot clobber another device. Direct '
  'INSERT/UPDATE/DELETE was revoked from app roles in migration 219 — do not '
  'grant it back without also reverting the client (SYNC_VIA_RPC).';
