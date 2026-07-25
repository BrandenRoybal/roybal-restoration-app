# QB Time → Board Phase Matching — Build Plan

**Date:** July 25, 2026 · **Decisions locked:** new phases are *proposed* via approve-by-text (never auto-added) · historical entries get a one-time backfill.

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

### 3. AI fallback (existing Haiku lane)
Entries scoring below threshold batch into one Haiku call per job per pull ("which phase does this note belong to — or none?"). Rides the existing ai_usage ledger + $50 cap. Below-confidence AI answers → leave unstamped.

### 4. New-phase proposals (approve-by-text)
- Unmatched entries that cluster (≥2 entries or ≥3h with a common theme and no matching phase) → a `pending_actions` row with new kind **`boardEdit`** (append phase to `coordination_jobs` job, rev-guarded write like `boardpush.js` guardedWrite).
- Morning brief offers: `💬 Reply YES 14 — add phase "Punch list" to Nate Circle (5.2h logged)`. Executor in `roybal-notify` (alongside `emailSend`/`sendText`).
- Added phase gets `estimatedHours` defaulted from hours logged so far, appended last; next pull stamps the waiting entries.
- ⚠️ `boardEdit` is deliberately generic — it is also the missing execution lane for the CFO doc's email→board workflow (docs/CFO_Board_Integration_Recommendations.md §4).

### 5. One-time backfill
Re-run the matcher over all existing time_entries (~600) for phased jobs; stamp only rows without a manual phaseId. Run as a qb-time-proxy action triggered once.

### 6. Board visibility (small)
Time drawer shows the match source (⚙️ service / 📝 note / 🤖 AI / ✋ manual) on each entry; re-assigning in the drawer sets `by:"manual"` so corrections stick through nightly pulls.

## Guardrails
- Phases move the schedule (`layoutSubtasksLive` uses est−logged to push dates) — hence propose-don't-auto-add.
- Non-phased jobs are untouched; matching only runs when `subtasks.length > 0`.
- Every stamp is auditable and reversible; date-fallback remains the safety net.
