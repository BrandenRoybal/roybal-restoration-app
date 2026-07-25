# QB Time → Board Phase Matching — Build Plan

**Date:** July 25, 2026 · **Decisions locked:** new phases are *proposed* via approve-by-text (never auto-added) · historical entries get a one-time backfill.

> **Status: all six steps BUILT (not yet deployed).** Deploy with
> `supabase functions deploy qb-time-proxy roybal-notify roybal-brief`, then run the
> one-time backfill (step 5). Board changes ship with the normal front-end deploy.
> Attribution precedence everywhere: **manual > this pull's matcher > previously earned (AI) > date fallback.**

## Problem

The board attributes QB Time hours to phases **by date only** (`phaseActuals()`, `apps/board/js/schedule.js:131`): an entry lands on whichever phase the schedule says is active that day. The entry's `service` item and free-text `note` — both present on every ingested row — are ignored, so hours misattribute exactly when crews deviate from the plan. An explicit `entry.phaseId` already wins over date-matching everywhere (rule #1), which is the integration seam this plan exploits.

## Design

Stamp `phaseId` at **ingest** in `supabase/functions/qb-time-proxy` (nightly pull + backfill paths, `index.ts:273/350`). Stamped entries flow through board / assistant / phone agent / CFO snapshot with zero engine changes. Unmatched entries stay unstamped → today's date-fallback applies (no regression).

Each stamped entry carries provenance: `phaseMatch: { by: "service" | "note" | "ai" | "manual", score }`. Manual (`by:"manual"`, set in the board's time drawer) is never overwritten.

## Build order

### 1. Pure matcher module + tests
`qb-time-proxy/phasematch.ts` — `matchPhase(entry, subtasks) → { phaseId, by, score } | null`.
- Token-score `service` + `note` against phase names + a construction synonym map (demo/tear-out/haul; drywall/sheetrock/hang/tape/mud; trim/casing/base; punch/touch-up/walk-thru; paint; flooring/LVP/carpet; cabinets; …seeded from the board's phase-template presets).
- Service items are two kinds: task-like ("Expediting Materials") → matchable; role-like ("Lead Carpenter / Foreman") → carry no phase signal, defer to the note.
- Tests: `phasematch.test.mjs` (node --experimental-strip-types, same pattern as roybal-brief/digest.test.mjs), seeded with real entry samples.

### 2. Ingest changes (`qb-time-proxy/index.ts`)
- Fetch the linked board job's `subtasks` (join: `coordination_jobs` data where `qbJobcodeId` matches — the proxy already reads that table).
- Stamp `phaseId`/`phaseMatch` on mapped rows before upsert.
- **Stop the clobber:** the nightly re-upsert of yesterday+today must (a) preserve existing `phaseId` where `phaseMatch.by === "manual"`, (b) skip rows whose content is unchanged (also a disk-IO cleanup item — 1,773 no-op updates on 602 rows to date).

### 3. AI fallback (existing Haiku lane) — ✅ BUILT
`aiphase.ts` (pure prompt/validation) + `enrichJobcode()` in index.ts. One batched forced-tool call per job
per night over unstamped entries that actually said something. Rides the `ai_usage` ledger + `SPEND_CAP_USD`
(service-role `monthSpend`, same as roybal-portal). Validation drops hallucinated phase ids, out-of-range
entry numbers, double-assignments, and anything under `MIN_CONFIDENCE` (0.7) — abstention is always safe
because the date fallback still applies.

**Cost control that matters:** every entry is sent to Haiku *at most once, ever*. Matches get
`phaseMatch {by:"ai", score}`; abstentions get a scoreless `{by:"ai", score:0}` marker, and both are
preserved by `reconcileRows` when a later pull's matcher finds nothing. Without that preservation the
nightly re-pull wiped every AI stamp (the free matcher fails on exactly those rows by definition) and we
would have re-paid for the same answer every single night. Regression-tested.

### 4. New-phase proposals (approve-by-text) — ✅ BUILT
- `clusterUnmatched()` groups leftover entries by construction concept; a group qualifies at **≥2 entries or ≥3h**.
  Concepts an existing phase already covers are never proposed, and vague notes ("worked on site") never qualify.
- Creates a `pending_actions` row, kind **`boardEdit`**, `proposed_by:"qb-time"`, params
  `{op:"addPhase", rowId, phase:{id,name,estimatedHours,…}, entryIds}`. Codes are taken from the live
  pending set **across all kinds** (the brief hands out 11+ for its own). Re-proposal is suppressed for 30
  days per job+phase name, whatever the owner did with the last one.
- **The brief now lists proposals it did not create** (`proposed_by=neq.morning-brief`) — without that fix a
  qb-time proposal would sit invisible and expire in 24h. Ordering: money (invoice reminders) first.
  Timing works out: the QB pull runs 14:00 UTC, the brief 15:00 UTC.
- Executor: `roybal-notify` `boardEdit` branch — rev-guarded append to `coordination_jobs.data.subtasks`,
  idempotent on duplicate phase name, self-stamps `executed`. Next pull stamps the waiting entries.
- ⚠️ `boardEdit` is deliberately generic — it is also the missing execution lane for the CFO doc's
  email→board workflow (docs/CFO_Board_Integration_Recommendations.md §4).

### 5. One-time backfill — ✅ BUILT
`{action:"rematchAll"}` (cron-secret or signed-in user). Deterministic pass over every unstamped entry of
every phased job; `{ai:true}` opts into the paid pass, `{jobcodeId}` scopes to one job. Manual stamps never
touched; safe to re-run. **Run once after deploy:**
```
curl -X POST "$SUPABASE_URL/functions/v1/qb-time-proxy" \
  -H "x-cron-secret: $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"action":"rematchAll","ai":true}'
```

### 6. Board visibility — ✅ BUILT
Time drawer shows each entry's phase + how it was decided (✋ manual / ⚙️ service / 📝 note / 🤖 AI), and QB
rows gain a phase re-assign select. Choosing a phase writes `phaseMatch {by:"manual"}` (permanent —
`reconcileRows` never overwrites it); choosing "Auto phase" deletes both keys and returns the entry to the
date fallback. Rows with no stamp show nothing, so the UI never implies an attribution that doesn't exist.

## Known limitations (found by adversarial review, deliberately deferred)

- **Shared jobcode across two phased jobs.** The same QB entry renders in both jobs' drawers, and each offers
  a re-assign select over its *own* phases — picking in the "wrong" drawer stores a foreign subtask id that
  the other job can never use, and manual is permanent. **Not reachable today** (verified: zero jobcodes back
  more than one phased job). If that pattern appears, gate the select on the same `hoursFrom` resolution the
  server uses (`phasedJobForDate`).
- **Re-assign writes the whole entry blob** from the drawer's cached copy (`saveTimeEntry` is a plain
  upsert-by-id). A job editor left open across a nightly sync could write back pre-sync field values. Same
  optimistic pattern as the existing ✕ handlers; bounded by how long the modal stays open.
- **Re-assign doesn't recompute the schedule** — Gantt bars and target dates refresh on the next 20 s poll.
  Consistent with the existing add/delete handlers, but moving hours between phases is the edit most likely
  to shift a finish date.
- **Manual (non-QB) rows** show the provenance chip but have no re-assign control, and the add-row path
  doesn't stamp `phaseMatch:{by:"manual"}` — so an owner-picked phase on a hand-logged row reads as
  unattributed. Cheap to unify later.
- **`boardEdit` writes no `capture_events` envelope**, so the Sunday "what the AI did" report won't mention
  board edits made by text. Worth adding when that report next gets attention.
- **The "failed" SMS ends in "Nothing was sent."** for every kind, which reads oddly for a board edit
  ("…nothing was added. Nothing was sent."). Cosmetic; fix when `replyText` next changes.
- **No integration harness** for the executor's HTTP path (GET → guard → PATCH) or for `board.js` — both are
  verified by reading plus unit tests on the extracted pure logic.

## Guardrails
- Phases move the schedule (`layoutSubtasksLive` uses est−logged to push dates) — hence propose-don't-auto-add.
- Non-phased jobs are untouched; matching only runs when `subtasks.length > 0`. The executor **refuses to give
  an unphased job its first phase by text**: `participates()` treats any job with subtasks as engine-managed,
  so one YES would re-derive a hand-dated job's whole timeline and cascade it downstream.
- `phaseMatch.by === "manual"` is a lock in BOTH directions — a pin and a deliberate unpin. Every automated
  path (`reconcileRows`, the free re-match, the AI pass) checks `isOpenForMatching` and leaves those rows alone.
- Every entry costs at most one Haiku call, ever: matches and abstentions are both recorded, and both survive
  the nightly re-pull.
- Proposal codes are unique across every live proposal, and a duplicated code makes `matchProposal` return
  `ambiguous` rather than firing the newest row — a collision must never send a customer email meant as a
  board edit.
- Every stamp is auditable and reversible; date-fallback remains the safety net.
