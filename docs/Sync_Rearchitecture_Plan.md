# Field App Data Architecture — Phased Rebuild Plan

*Drafted 2026-08-10, prompted by the Awthentis contents loss (stale-device override, Aug 6).*

## Why this plan exists

On Aug 6 at 7:22 AM Alaska time, a device that hadn't synced the Awthentis job since July 31
pushed its whole copy of the job to the server, erasing the contents inventory that had been
captured on the company iPad. Weeks of field documentation vanished with no warning, no record
of what was lost, and no undo.

The direct cause is already partially fixed: PR #97 added rev-guarded writes
([supa.js](../apps/field/js/supa.js) `guardedUpsertRow`), union merge on conflict
([merge.js](../apps/field/js/merge.js)), and delete tombstones. If every device runs that code,
an Aug-6-style wholesale clobber can't happen the same way again.

But three fundamental gaps remain, and they are the subject of this plan:

1. **All protection lives in the client.** The server accepts any raw write to `field_projects`
   from anyone holding the shared login. A device running a stale cached build (the service-worker
   staleness trap) bypasses every safeguard we ship. The Aug 6 device was exactly this.
2. **One shared login.** No record of *who* changed anything, no way to say "techs can add but
   not erase," no way to cut off a lost or compromised device without re-crendentialing everyone.
3. **No server-side history.** When an overwrite does happen, the previous state is simply gone.
   The Awthentis recovery required forensic archaeology instead of a one-line restore.

There is also a structural cost we pay daily: each job is one JSONB blob (Fidler's is 3.2 MB),
and every save rewrites the whole thing — this is most of our database WAL churn (see the July
disk-IO diagnosis) and the merge logic must grow with every feature the app gains.

## Target state (where we land after Phase 4)

- Every tech signs in as themselves. Roles: **admin** (delete/restore/everything),
  **tech** (create + edit own work, cannot destroy anything), **office** (edit, no delete).
- Photos, contents items, readings, logs are **individual rows**, not blob sections. Two devices
  working the same job produce a union of rows — there is nothing to clobber.
- "Delete" means a `deleted_at` flag that only admins can set, reversible for 60 days.
- The server — not the app — enforces all of the above via RLS and a guarded write path.
  A stale client build physically cannot destroy data; the database refuses.
- Every photo and item carries who/when — which also strengthens insurance documentation.

Each phase below is independently valuable and independently shippable. If we stop after any
phase, we are still strictly better off than the day before.

---

## Phase 0 — Tourniquet ✅ SHIPPED 2026-08-10 (migration 215)

*Applied to production after a 3-lens adversarial review (9 findings fixed, incl. 2 critical:
rolling capture so the immediate pre-image always survives, and a flood floor on regression
captures). Verified live with a 7-scenario synthetic test, fully rolled back. 3 MB worst-case
save costs 61 ms of capture against an 8 s statement timeout. History is in `blob_history`
(RLS-locked, service-role only), triggers on `field_projects` + `coordination_jobs`, nightly
purge via pg_cron. Restore recipe is in the header of
[215_blob_history.sql](../supabase/migrations/215_blob_history.sql).*

*Goal: no further loss is unrecoverable, starting this week. No app changes.*

1. **History trigger on `field_projects`**: on every UPDATE, write the prior row
   (id, old data, old rev, changed_at) to `field_projects_history`. Nightly purge past 30 days.
   Any future overwrite becomes a one-query restore. (~20 lines of SQL, zero app impact.)
2. **Same trigger on `coordination_jobs`** (board data has the same exposure).
3. **Fleet check**: confirm every device is on the current build (post-PR #97). The app's
   update prompt only helps if the service worker actually activates the new build — verify on
   each device, especially the iPad.
4. Wire the history purge into a pg_cron job; confirm the existing trash-tombstone trigger from
   PR #97 is live in production.

**Rollback:** drop the trigger. **Done when:** overwriting a job and restoring it from history
takes under five minutes, demonstrated once.

*Note: the Awthentis recovery (iPad / Aug 6 backup) comes before everything, including this.*

## Phase 1 — Individual logins and roles ✅ SHIPPED 2026-08-10 (migration 216)

*Applied to production after a 3-lens adversarial review that caught a **critical
privilege-escalation hole** (is_admin() was self-grantable: open signup trusted the role in
signup metadata, and `authenticated` could PATCH its own `profiles.role`). Both paths closed in
216 — signups always land as `tech`, and role-column writes are revoked from app clients so role
changes happen only via SQL. Verified live by dropping to the `authenticated` role with simulated
tech/admin JWTs: tech cannot self-promote (403 on the role column) and cannot hard-delete (RLS
filters to 0 rows); admin can. Authorship stamping verified: authenticated write → writer's uid,
service/automation write → NULL (honest system marker, never an inherited human). App side:
factories stamp `by`/`createdBy`, blank-scaffold reuse re-stamps the adopting tech, full test
suite green. **Operator to-do before rollout: disable public signups (invite-only) in the
dashboard** — see the header of [216_individual_logins.sql](../supabase/migrations/216_individual_logins.sql).
Residual (a self-signup `tech` still reads/writes all job data via legacy USING(true) policies)
is unchanged from before and closes in Phase 3.*

*Goal: attribution and revocability. Behavior of the app otherwise unchanged.*

1. Create a Supabase Auth user per person. The `profiles` table already exists (empty) —
   add `role` (`admin` / `tech` / `office`) and display name.
2. The app's existing email/password sign-in ([supa.js](../apps/field/js/supa.js) `signIn`)
   stays as-is; sessions are long-lived with refresh, so field friction is a one-time login
   per device, not a daily password.
3. Stamp authorship: `updated_by` on every push; `createdBy` on new photos, contents items,
   log entries as they're created (cheap to add in the model factories now, and it migrates
   cleanly into row columns in Phase 3).
4. RLS: all authenticated users read/write as today (no behavior change yet) — but hard DELETE
   on `field_projects` becomes admin-only (deletes are tombstoned anyway; this closes the raw
   REST path).
5. Retire the shared login last, after every device has a personal session.

**Rollback:** shared login keeps working throughout; flip back anytime.
**Done when:** every device signs in as a person, and every new push carries `updated_by`.

## Phase 2 — Server-side write authority (~1 week of work) ⭐ the clobber-killer

*Goal: a stale or buggy client can no longer destroy anything, even in the blob model.*

1. Add an RPC `push_project(id, base_rev, blob)` (Postgres function or edge function):
   - If `base_rev` matches current rev → accept, bump rev, history row, stamp author.
   - If it doesn't → the **server** re-runs the union merge (port of
     [merge.js](../apps/field/js/merge.js) rules — the module is pure and has tests, so the
     port is mechanical and verifiable against the same test vectors).
   - Reject pushes from app builds older than a `min_app_version` the function knows.
2. Client change is small: [sync.js](../apps/field/js/sync.js) calls the RPC instead of
   PATCHing the table (its local merge stays as a fast path; the server merge is the authority).
3. RLS then **revokes direct INSERT/UPDATE on `field_projects`** from non-admin roles — the
   RPC (security definer) becomes the only door. Old builds get a clean failure telling them
   to update, instead of silently clobbering.

**Rollback:** re-grant direct writes; clients that already use the RPC keep working.
**Done when:** a deliberately stale test device pushing an old blob loses nothing — the server
merges it — and a pre-Phase-2 build is refused.

## Phase 3 — Rows for the real data (~2–3 weeks, section by section)

*Goal: eliminate the blob as the unit of saving for high-value data.*

Order: **photos → contents + boxes → moisture maps / drying logs → receipts, invoices,
change orders → single forms last** (forms fit naturally as one row with a jsonb column).

For each section, the same recipe:

1. **Table** with real columns: `id, job_id, created_by, created_at, updated_at, updated_by,
   deleted_at, deleted_by, payload/columns`. (Several exist already from the original schema —
   `photos`, `moisture_readings`, `rooms` — reuse or replace as fits.)
2. **Dual-write**: new captures insert a row *and* still land in the blob. Nothing reads rows yet.
3. **Backfill**: script explodes existing blobs into rows; verify counts match per job.
4. **Flip reads** for that section to rows; blob keeps a legacy stub.
5. **RLS per role**: techs insert freely and edit their own rows; only admins may set
   `deleted_at`. In-app trash view; 60-day recovery window; nothing hard-deletes in normal use.
6. Sync becomes per-row upsert (id-keyed, so retries are idempotent; offline queue in IndexedDB
   drains in order when back on Wi-Fi). Incremental pull per table via `updated_at` cursor —
   same pattern as today's `fetchSince`.

This phase also delivers the disk-IO fix: adding one photo becomes one small insert instead of
rewriting a multi-megabyte blob.

**Rollback:** per section — flip reads back to the blob (dual-write means the blob stayed true).
**Done when:** photos and contents live as rows end-to-end and a two-device
add/add/delete-attempt test shows union behavior with tech-proof deletes.

## Phase 4 — Retire the blob (~1 week)

1. Stop writing migrated sections into the blob; `field_projects.data` shrinks to job header +
   not-yet-migrated forms.
2. PDF/export/portal paths read rows (or a server-generated snapshot view, if a single-document
   shape stays convenient for exports).
3. Blob history trigger stays for whatever remains in the blob; row tables rely on soft deletes
   + per-row authorship (plus the Phase 0-style history trigger on any table where field edits
   matter enough to keep versions).

**Done when:** the app never pushes a whole-job blob and WAL volume drops accordingly.

## Phase 5 — Later, if wanted

- Admin console: history browser, restore buttons, per-user activity feed.
- Append-only event journal if audit requirements grow beyond soft deletes.
- Field-level conflict prompts for the rare same-row simultaneous edit.

---

## Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| Stale PWA builds during transition | all | Phase 2 min-version gate; verify SW activation per device before each flip |
| Backfill mangles a job | 3 | Dual-write means blob remains authority until counts verified; per-section flips, not big-bang |
| RPC merge diverges from client merge | 2 | Port merge.js test vectors; run both and compare in dual mode before enforcement |
| Login friction in the field | 1 | Long-lived sessions; one login per device; shared login kept until fleet converted |
| Offline queue grows on Wi-Fi-only iPad | 3 | Idempotent id-keyed upserts — a week offline drains safely; test that path explicitly |
| A phase stalls half-done | all | Every phase leaves the system strictly safer than before it started |

## Sequencing and estimates

| Step | Calendar | Depends on |
|---|---|---|
| Awthentis recovery (iPad / backup) | now | — |
| Phase 0 tourniquet | this week | — |
| Phase 1 logins | week 1–2 | Phase 0 |
| Phase 2 server authority | week 2–3 | Phase 1 (roles) |
| Phase 3 rows (photos, contents first) | week 3–6 | Phase 2 |
| Phase 4 blob retirement | week 6–7 | Phase 3 |

Estimates assume current solo pace with AI assist and that phases ship one at a time with a
few days of field soak between them. Testing on a staging copy: the second Supabase project
(`mlfaeqdqycxdxvoxsgbq`, currently inactive) can be revived as staging, or use a database
branch — either way, Phases 2–4 rehearse there before production.
