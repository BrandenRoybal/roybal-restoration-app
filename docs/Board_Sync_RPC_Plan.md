# Board `coordination_jobs` — server write authority

**Status:** Tier 1 ✅ SHIPPED 2026-08-14 (migration 230). Tier 2 parked.
**Date:** 2026-08-14
**Author:** Lead engineer
**Scope:** give `coordination_jobs` a safe server-side write path so post-hoc blob stamps (the CRM `contactId` link, `contact_merge` repoints, and any future server automation) stop being clobbered by the board's whole-blob rev-guarded PATCH — the "board gets its own RPC later" promised in migration 217's header and `docs/Sync_Rearchitecture_Plan.md` Phase 2b. Companion to that plan (which covered `field_projects`) and to `docs/CRM_Design.md` §5.

*The whole point of this doc is to separate the small thing the CRM actually needs now from the large thing the board would need to reach field-app-grade sync safety — and to not build the large thing until a real problem asks for it.*

---

## 1. The race, confirmed

The board writes every job through one funnel — `saveJob` (`apps/board/js/data.js:156-173`) → `guardedJobWrite` (`:97-119`). It reads `base = Number(job.rev) || 0`, then PATCHes `coordination_jobs?id=eq.<id>&data->>rev=eq.<base>` with a body that **replaces the entire `data` column** at `rev = base+1`. The guard only ever fires on a *higher* server rev.

That is exactly the hole the CRM steps into. A server-side stamp of `data.contactId` that does **not** bump `rev` is:

1. **invisible to the guard** — the board's next save still matches `data->>rev=eq.<base>` (rev unchanged), so the PATCH lands and reports success with no conflict; and
2. **destroyed by that same PATCH** — the whole-blob replace overwrites the row with the device's copy, which never had `contactId`.

The `flushQueue` path (`data.js:63-80`) recomputes from the same stored base and has the identical exposure. This is verified against the code, not hypothetical — it is why migration 229 deliberately repointed the five link *columns* but left `coordination_jobs.data.contactId` alone with the note *"post-hoc blob writes need the rev-bumping RPC that lands with the board's own RPC cutover"* (`229_contact_links.sql:20-22`).

The fix the guard itself dictates: **a server stamp must bump `rev`.** Then the board's guard sees the row changed, matches zero rows, falls to its conflict path (`data.js:106-118`), adopts the server copy (now carrying `contactId`), and shows the office the normal "changed on another device" notice. The link survives; the device loses only an unsaved in-flight edit, which is the same trade the board already makes for any two-device collision.

## 2. Two tiers — and the CRM only needs the first

The field app got a *large* treatment: three RPCs, a SQL merge engine proven byte-equal to `merge.js` across 2,033 cases, a client cutover behind `SYNC_VIA_RPC`, fleet telemetry (migration 226), a build-floor gate, and an operator-gated revoke (219). Mirroring all of that for the board is weeks of work, and — this is the key finding — **the board is missing every prerequisite the field app already had**:

- the board blob's collections are shaped nothing like `field_projects`' id-keyed arrays (see §4), so `merge_project_blobs` does not transfer;
- there is **no board `merge.js`** to port or to differentially-test a SQL merge against;
- the board emits **no build tag and no cache version of its own**, so there is nothing to gate on and no way to prove the fleet converted (migration 226's `sync_fleet` tracks field-app RPC callers only). Its assets *are* already cached — by the **field** service worker at scope `/` (`apps/field/sw.js`) — which is a constraint on Tier 2, not a substitute for a board build tag (see §4.3).

And most of what the board writes is already rev-safe, but for two different reasons worth separating:
- `saveJob` bumps rev, and `roybal-notify boardEdit` hand-rolls a service-role rev-guarded bump — these are safe because they bump.
- `boardpush`'s field-owned annotations (`fieldActuals`, `fieldJobId`) deliberately write at the *same* rev, and are safe **only because the field app re-pushes them every sync** — a clobbered annotation self-heals on the next rollup (`boardpush.js:475-480`). The rev choice isn't what makes them safe; the re-push loop is.

That distinction is the real dividing line. The CRM's `contact_merge`/backfill stamps are **one-shot** — no re-push loop — so a same-rev write would be lost with nothing to restore it. That, not "they don't bump rev," is why they need Tier 1. (The lead-lifecycle *UI* from CRM §6 — Won/Lost, follow-up date — writes through the board editor → `saveJob` → rev bump, so it's safe on its own.)

So the honest split:

| Tier | What it is | Who needs it | Size |
|---|---|---|---|
| **1** | A targeted, service-role, rev-bumping field-merge RPC for **server-side** blob stamps | The CRM `contactId` link surviving `contact_merge` + backfill. Ships now. | ~1 migration, **no client change** |
| **2** | The full field-style rework: board merge engine + client cutover + build tag + telemetry + operator-gated revoke | Closing the *general* two-device board-clobber class (today the board just drops the stale write) | Weeks; deferred until a real problem asks |

What Tier 1 actually unblocks is narrower than "step 4": CRM step 4's lead-lifecycle *UI* (source badge, follow-up chip, Won/Lost, pipeline view) writes through the board editor → `saveJob`, and new lead cards already get `contactId` at creation from the CRM step-2 writers — so that UI can ship on step 2 alone. Tier 1 is required for the piece migration 229 **deliberately deferred**: keeping the `contactId` link correct on *existing* board cards through `contact_merge` and a one-time backfill — i.e. merge integrity and the contact page (CRM step 3's remainder feeding step 5), not step 4's buttons. Tier 2 is documented here so the path is known, then parked — the same "recommended stopping point" discipline `docs/Sync_Rearchitecture_Plan.md` applied to Phase 3.

## 3. Tier 1 — `coordination_job_patch` (the CRM unblock)

One small function, one migration (proposed `230_coordination_job_patch.sql`), **no board-client change at all**.

```sql
-- Server-side ONLY (service_role). Merges a shallow patch of top-level keys
-- onto a live job blob, bumps rev so the board's whole-blob guard SEES the
-- change (and adopts it on its next save instead of clobbering it), and
-- stamps a clock-skew-safe updatedAt. This is the migration-225 restore_photo
-- precedent generalized: any server stamp of an existing board card rides it.
create or replace function public.coordination_job_patch(
  p_id    uuid,
  p_patch jsonb          -- {"contactId":"…"} etc. — top-level keys only
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
    for update;                                  -- serialize against a concurrent save
  if v_data is null then return null; end if;    -- gone or tombstoned → no-op, not an error

  v_rev := coalesce((v_data->>'rev')::int, 0) + 1;
  -- prior timestamp, tolerant of a missing OR malformed updatedAt: a bare
  -- ('' )::timestamptz RAISES 22007 and coalesce can't catch it, so one bad
  -- blob would abort the whole merge/backfill. Both cited precedents wrap it
  -- (218:256-257, 225:123); this must too.
  begin v_prev := (v_data->>'updatedAt')::timestamptz; exception when others then v_prev := null; end;
  -- strictly newer than what's on file and not behind the clock (the 218 rule)
  v_ts  := to_char(greatest(now(), coalesce(v_prev, to_timestamp(0)) + interval '1 ms')
             at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_data := (v_data || p_patch)                  -- shallow merge: patch keys win
            || jsonb_build_object('rev', v_rev, 'updatedAt', v_ts);
  update public.coordination_jobs set data = v_data where id = p_id;   -- touch() stamps updated_at column
  return v_data;
end;
$$;

revoke execute on function public.coordination_job_patch(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.coordination_job_patch(uuid, jsonb) to service_role;
```

Design notes:

- **Service-role only.** The 227 discipline — a definer function defaults `EXECUTE` to PUBLIC, and the anon key is in git, so the revoke is mandatory. No crew/board device ever calls this; it exists for server code (`contact_merge`, the backfill) alone.
- **Shallow merge is enough for the CRM.** `contactId` is a top-level scalar, so `data || p_patch` sets it without disturbing anything else. If a future stamp targets a *nested* path, it takes a `jsonb_set` variant — out of scope until something needs it.
- **The rev bump is the whole point** (§1). `updatedAt` is stamped for cross-device consistency, tolerant of a malformed prior value; the server `updated_at` *column* is handled automatically by the existing `coordination_touch()` trigger.
- **Tombstones are excluded** by `deleted = false` — this only ever patches a live job. There's no `__settings__` row to guard against: `coordination_jobs.id` is a `uuid` column, so the board's settings blob (keyed `'__settings__'`) can't persist here at all — it lives in localStorage, not this table.
- **`for update`** serializes against a board PATCH landing in the same instant, so the rev bump and the board write can't interleave into a lost update.

**Wiring it to the CRM** (a follow-on migration, e.g. `231`): extend `contact_merge` (migration 229) so that after it repoints the five link columns it also repoints the board blob — `perform coordination_job_patch(id, jsonb_build_object('contactId', p_winner)) for each coordination_jobs row where data->>'contactId' = p_loser`. And a one-shot backfill that stamps `contactId` onto existing lead cards by resolving each card's blob through the same function. Both run as the definer/service-role, both rev-bump, both survive.

**Rollback:** `drop function public.coordination_job_patch(uuid, jsonb);` — nothing calls it until the wiring migration lands, and that migration is independently revertible. Additive; no board client, no existing writer touched.
**Done when:** the office merges two contacts whose loser is on a board lead card, and the winner's `contactId` shows on that card after the board's next sync — with no lost office edit beyond the normal conflict notice; and a re-run of the backfill is idempotent.

## 4. Tier 2 — full board write authority (deferred)

To make the RPC the *only* board write door (closing the general clobber class, not just the CRM stamp), the board needs the field app's whole stack rebuilt for a differently-shaped blob. Sketch, so the path is known:

**4.1 A board merge engine — the hard part.** `merge_project_blobs` hard-codes `field_projects` collection names and assumes id-keyed arrays. The board blob's collections need their own per-shape union rules:

| Collection | Shape | Union rule |
|---|---|---|
| `crewSpans` | **object-map** keyed by crew id → `[{from,to}]` | per-key union; a naive newer-wins silently drops a span another device added |
| `dayCrew` | **object-map** keyed by day-ISO → `{add:[], remove:[]}` | per-key (per-day) union of the `{add,remove}` deltas — a value-union would corrupt it |
| `subtasks` | array of `{id, name, durationDays, lagDays, estimatedHours, crewIds, done?}` — **carries `uid()` ids** | union by `id`, exactly like the field's `id_cols` |
| `deps` | array of `{predId, type, lagDays}` | union by `predId` (id-keyed), not value-union |
| `crewIds` | plain string array | value-union (like `rooms`) |
| `archived` / `archivedAt` | scalar lane state | decide: mergeable field, or delete-like state that interacts with tombstone |
| everything else | scalars | newer-wins by `updatedAt` |

So the board blob is *more* mergeable than a first glance suggested — `subtasks` and `deps` already have stable keys — but the two object-maps (`crewSpans`, `dayCrew`) have no analogue in `field_projects`, and `crewIds` is a value array. The rules are per-collection either way. This must be written as a board `merge.js` first (the board has none), then ported to SQL and differentially tested the way `merge.js`↔`merge_project_blobs` was (2,033 cases). No reference implementation exists today, so this is net-new, not a port.

**4.2 Three RPCs** mirroring 217/218/220: `push_coordination_job` (insert / CAS-apply / stale-merge / return-tombstone, self-echo short-circuit, clock-skew timestamp), `tombstone_coordination_job`, `revive_coordination_job` — reusing the `_sync_guard` role+build fence, extended with a **board build key** (`min_board_build`) since the board has no build tag yet.

**4.3 Client cutover** in `apps/board/js/data.js` behind a `SYNC_VIA_RPC_BOARD` kill switch: route `saveJob`/`deleteJob` through the RPCs, add `adoptServerMerge` (adopt a server union clean, no re-push), and send a board build tag on every call. Prerequisite: **introduce a board `BUILD` constant** — the board emits none today. A board **cache version** is subtler: board assets are already stale-while-revalidated by the *field* SW at scope `/`, so a second SW registered under `/board` would collide with it. The clean options are a board SW scoped to `/board`, or a shared build key both apps report — decide before adding one.

**4.4 Telemetry + revoke**, operator-gated exactly like 219/226: a board equivalent of `sync_clients`/`sync_fleet` (the field one tracks field RPC callers only, so it can't prove board devices converted), *then* an operator-gated `revoke insert, update, delete on coordination_jobs from authenticated` during a quiet window, with the `grant … to authenticated` one-line rollback. Scope note: `crew_members` and `time_entries` are their own tables with their own last-write-wins path (untouched by this revoke), and the board's settings blob never persists to `coordination_jobs` anyway (the `uuid` id rejects `'__settings__'`) — so the revoke's only concern is job rows and their delete/tombstone path.

**Rollback (per step):** each phase is additive until the revoke; flip `SYNC_VIA_RPC_BOARD=false` and re-grant to restore direct writes.
**Done when:** a deliberately stale board device loses nothing on a two-device add/add/delete test — the server merges it — and a pre-RPC board build is refused.

**Recommended stopping point:** don't build Tier 2 until two-device board clobbering is an observed, real problem. Today the board *drops* a stale write (409 → re-queue/adopt) rather than silently corrupting — annoying, not dangerous. The office is a handful of coordinators on one board, not a field fleet of offline iPads; the collision rate that justified the field rework may never appear here. Revisit if it does.

## 5. Every `coordination_jobs` writer, and what it needs

| Writer | Kind | Rev today | Needs |
|---|---|---|---|
| `roybal-lead` (REST, service_role) | insert | `rev:1`; stamps `contactId` at creation *when the resolver matches* (best-effort) | ✅ safe (creation) |
| `roybal-web-agent` → `web_lead_insert` (227 RPC) | insert | `rev:1`; `contactId` at creation when resolved | ✅ safe |
| phone-agent `createLead` (`insertRow`) | insert | `rev:1`; `contactId` when resolved; 204 fences it to insert-only | ✅ safe |
| board `saveJob` / `guardedJobWrite` (every editor/drag/schedule write) | update | client rev-bump + guard | ✅ safe; Tier-2 relocates it |
| `boardpush` (field→board) | insert + update | rev-bump; **or** same-rev annotations kept safe by the field app's re-push loop | ✅ safe (re-push self-heals) |
| `roybal-notify boardEdit` (phase approval) | update | service_role, hand-rolled rev-guard + bump | ✅ safe |
| board `deleteJob` / boardpush dup-tombstone | upsert / PATCH-tombstone | no rev (delete isn't rev-managed) | ✅ safe today; Tier-2 decides tombstone-vs-rev |
| **`contact_merge` repoint of board `contactId`** | post-hoc update | — | **⛔ Tier 1** |
| **backfill `contactId` onto existing lead cards** | post-hoc update | — | **⛔ Tier 1** |
| CRM §6 lead-lifecycle (Won/Lost/follow-up) | update via board editor | inherits `saveJob` rev-bump | ✅ safe (client write) |

The two ⛔ rows are the entire CRM dependency. Everything else is already correct. (Note the insert writers stamp `contactId` only when `contact_resolve` matched — a resolver miss leaves a lead card `contactId`-less, which is exactly what the backfill ⛔ row later fills.)

## 6. Risks

| Risk | Reality | Mitigation |
|---|---|---|
| Server stamp still clobbered | The failure this doc exists to fix | Tier 1 bumps rev; the board's own guard then adopts it (§1) |
| Office loses an in-flight edit when a stamp lands mid-edit | Same as any two-device board collision | Accepted per CRM §5 ("device conflicts as the cost of correctness"); the office sees the normal conflict toast |
| Tier 1 patch races a board PATCH into a lost update | Two writers, same row, same instant | `for update` row lock serializes them |
| Over-building Tier 2 for a collision rate the board may never see | Weeks of merge-engine work for a 3-coordinator board | §4 stopping point: build only on an observed problem |
| A future nested-field stamp needs more than shallow merge | `contactId` is top-level; others may not be | Add a `jsonb_set` variant when something concrete needs it |
| Tier-2 revoke breaks a straggler board device | The board has no build telemetry to prove conversion | Board `sync_clients` equivalent is a hard precondition of any revoke (§4.4) |

## 7. Sequencing

| # | Ship | Depends on | Size |
|---|---|---|---|
| 1 | `coordination_job_patch` migration (Tier 1) | — | ✅ **SHIPPED** (230) |
| 2 | Wire `contact_merge` board repoint + `contactId` backfill through it | 1, migration 229 | ✅ **SHIPPED** (230) — all 15 live cards linked, 0 duplicates |
| 3 | *(CRM step 4 UI proceeds on step 2 alone — needs nothing here)* | CRM step 2 | — |
| — | **Tier 2 parked** until two-device board clobbering is observed | board `merge.js`, board BUILD tag, board telemetry | L |

Steps 1–2 are a single afternoon and close the deferred board `contactId` link (CRM §5 / migration 229's remainder) — merge integrity and the contact page. CRM step 4's UI doesn't wait on them. They touch no board client code and revoke nothing, so nothing a coordinator does can break.

## 8. Open decisions for you

1. **Tier 1 only, for now?** My recommendation: yes — ship `coordination_job_patch` + the wiring, leave Tier 2 documented-but-unbuilt. Blessing this closes the deferred CRM §5 board-link dependency without opening the board sync rework.
2. **Tombstone-vs-rev on delete (Tier 2 only).** Should archiving/deleting a job participate in the rev model, or stay the last-write-wins upsert it is today? Only matters if Tier 2 happens.
3. **Trigger for Tier 2.** What counts as "two-device board clobbering is a real problem" — a coordinator complaint, a measured conflict rate, or a specific data-loss incident? Naming it now keeps Tier 2 from being built on a hunch.
