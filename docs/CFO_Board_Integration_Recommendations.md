# Job Board → Daily CFO Report Integration

**Prepared for:** Branden Roybal — Roybal Construction, LLC
**Date:** June 30, 2026
**Scope:** How to feed the new Job Board scheduling app into the daily CFO report, plus a morning email-to-board oversight workflow.

---

## 1. What you built (and why it integrates cleanly)

Your Job Board (`apps/board`) is a real scheduling engine, not a glorified calendar. The good news for integration: it already computes everything the CFO report needs.

- **Jobs** live in Supabase table `coordination_jobs` (JSONB, last-edit-wins, offline-first cache). Each job carries: `stage`, `type`, `priority`, `materials`, `crewIds`, `customer`, `address`, `startDate`, `targetDate`, `estimatedHours`, `deps` (Finish-to-Start links), `subtasks` (phases), `isMilestone`, `notBefore` (materials/permit floor), and `fieldJobId` (the link to your field app job).
- **Crew** lives in `crew_members`; **time** in `time_entries`.
- **The engine** (`schedule.js`) already produces the four signals you asked for as pure, testable functions:
  - `computeSchedule()` → start/finish dates per job
  - `computeCriticalPath()` → which jobs drive the finish date
  - `findOverAllocations()` / `crewDayLoad()` → crew booked hours per day + over-capacity flags
  - Stages (`lead → scheduled → in_progress → on_hold → final → done`) → billing/draw signal

**The one gap:** the board has **no dollars**. Money lives in QuickBooks (your CFO report source) and in the field app's scope/invoice. So integration is really about *bridging schedule events to financial events* — and the bridge already exists: `job.customer` + `job.fieldJobId` → QBO customer → invoice/AR.

That bridge is where the money is. Example: a job hits **Complete** on the board but has **no invoice in QuickBooks** → that's cash sitting on the table, and the report should scream about it.

---

## 2. The four scheduling blocks to add to the CFO report

Each maps to data already in the board. Below is the source logic and how it should read in the report.

### Block A — Jobs Starting / Ending Soon
- **Source:** `coordination_jobs` where `startDate` or `targetDate` falls within the next 7 days; include `isMilestone` markers and phase finishes from `layoutSubtasks()`.
- **Report line:** *"Honeybee — Unit interiors start Mon 7/6 (crew: 3) · Birch Ln water mitigation targets complete Wed 7/8."*
- **Why CFO cares:** starts = labor/material cash going out; completions = draws/invoices coming in.

### Block B — Crew / Labor Allocation (your biggest expense)
- **Source:** `crewDayLoad()` and `findOverAllocations()` — booked hours per crew per day vs. the 10-hr shift cap.
- **Report line:** *"This week: 6 of 9 crew fully booked. ⚠️ Mike double-booked Tue (14 hrs across Honeybee + Birch Ln). 2 crew idle Thu–Fri."*
- **Why CFO cares:** idle crew = burning labor with no billing; over-allocation = a schedule slip about to happen. Tie booked hours × `hourly_rate` for a daily labor-cost run-rate.

### Block C — Schedule Slips / At-Risk Jobs
- **Source:** jobs in `on_hold` stage; jobs where `targetDate < today` but `stage != done` (overdue); critical-path jobs (`computeCriticalPath`); near-term starts blocked by `materials != "received"` or a `notBefore` date.
- **Report line:** *"⚠️ 2 jobs overdue · Shop slab blocked: materials not received, start floored to 7/14 · 1 critical-path job slipped 3 days."*
- **Why CFO cares:** every slip pushes a draw/invoice to the right and stretches A/R.

### Block D — Draw / Billing Triggers
- **Source:** jobs that moved into `final` or `done`, or a completed milestone/phase — **cross-referenced against QuickBooks** (`qbo_sales_get_invoices`, AR aging) by customer.
- **Report line:** *"💵 Birch Ln marked Complete 6/29 — no invoice found in QuickBooks. Honeybee Phase 2 done — SOV draw #3 billable. Est. uninvoiced: \$X."*
- **Why CFO cares:** this is the single highest-value line in the whole report. It converts finished work into cash and shrinks your insurance-claim A/R.

---

## 3. How the morning routine reads the board (ranked options)

The report runs unattended each morning, so it needs a way to read live board data. The board uses Supabase with RLS requiring an authenticated session, so pick one:

1. **Recommended — Supabase read via a stored service path.** Add a small read-only Edge Function (`board-snapshot`) that returns the current `coordination_jobs` + `crew_members` + `time_entries` as one JSON payload, protected by a secret. The morning routine calls it, runs the same `schedule.js` math, and emits the four blocks. Clean, live, no browser, fully automatable. *(Reuses the engine you already wrote and tested.)*
2. **Fastest to ship — board "Export Snapshot" button.** Add one button that writes `board-snapshot.json` to a synced folder. The routine reads that file each morning. Zero backend work; the tradeoff is the snapshot is only as fresh as your last click.
3. **No-code stopgap — I read the live board through Chrome each morning.** Works today with zero code changes, but slower and more brittle than a JSON feed. Good for a 1–2 week trial before committing to option 1.

**Suggested path:** start on **#3** this week to prove the report blocks, then build **#1** as the durable feed.

### One code change worth making
Add a single pure function to the board, e.g. `computeCfoSnapshot(jobs, crew, settings, today)` in `schedule.js`, that returns the four blocks as structured data. It keeps all scheduling logic in one tested place (you already have `test/schedule.test.mjs`) and means the CFO report just renders, never recalculates. Optionally add `contractValue` and `billedToDate` fields to the job model so Block D can carry real dollars instead of cross-referencing QBO every time.

---

## 4. Email → Job Board oversight workflow

You asked me to **flag and draft** updates. Here's the daily loop, run right before/with the CFO report:

1. **Scan** the morning inbox for scheduling-relevant mail: reschedules, adjuster approvals/scope sign-offs, material/delivery dates, subcontractor confirmations, weather delays, and owner/PM messages (e.g., Pollens / Honeybee).
2. **Match** each to a board job by customer name, address, or `fieldJobId`.
3. **Draft the exact board edit** — which job, which field, old → new value. Examples:
   - *"Tundra Supply: cabinets ship 7/9." → Honeybee → set `materials = received` (ETA 7/9); clears the start block."*
   - *"Adjuster approved Birch Ln supplement." → Birch Ln → stage `in_progress`; flag Block D billing once complete."*
   - *"Owner wants Shop pushed a week." → Shop → set `notBefore = 7/21`, re-run schedule, show downstream slip."*
4. **You approve**, then the change is written to `coordination_jobs` (respecting the board's `rev` optimistic-concurrency guard so it never clobbers a field edit).
5. Anything ambiguous or scam-flavored (vague scope, no address, third-party payment) gets held out and surfaced with your standard intake questions, not auto-applied.

Output each morning: a short **"Board updates pending your OK"** list appended to the CFO report — one tap to apply all, or edit individually.

---

## 5. Recommended rollout

| Phase | Work | Outcome |
|---|---|---|
| **Week 1** | I pull the board live via Chrome; add Blocks A–C to the CFO report; start the email flag-and-draft list. | You see scheduling + crew risk in the daily report immediately, no code. |
| **Week 2** | Wire Block D (board completions × QuickBooks invoices/AR). Add `computeCfoSnapshot()` to the board. | The report starts catching uninvoiced finished work — direct A/R impact. |
| **Week 3–4** | Build the `board-snapshot` Edge Function (option #1) for a clean live feed; optional `contractValue`/`billedToDate` fields. | Fully automated, durable, no manual export or browser. |

---

## 6. Open questions for you

1. **Read path:** OK to start with the Chrome/live-read trial (no code) while I spec the Edge Function feed?
2. **Block D dollars:** cross-reference QuickBooks each morning, or add `contractValue`/`billedToDate` to the board so draws carry dollars natively?
3. **Email auto-apply:** approve-each (default), or auto-apply low-risk updates (material ETAs, notes) and only hold stage/date changes for your OK?

---

*Roybal Construction, LLC · Roybal Restoration · Fairbanks, Alaska*
