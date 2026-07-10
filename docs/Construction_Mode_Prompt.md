# Claude Code Prompt — Construction / Remodel Mode for the Field Forms App

> Paste everything below the line into Claude Code from the repo root on the field-app branch
> (the line with `apps/field`, `apps/board`, `apps/admin`). Recommended: run it phase by phase —
> tell Claude "do Phase 1, stop, and show me" before continuing.

---

## Context — read this first

You are working in `apps/field/`, a **vanilla-JS, zero-build PWA** (ES modules, no framework, no npm build step) used by Roybal Construction LLC field techs for water-restoration jobs. Before writing any code, read these files to understand the existing patterns — every new thing you build must follow them:

- `apps/field/js/model.js` — the `FORMS` registry (declarative array of `{ key, name, icon, multi, blurb }`), `newProject()` job blob, and per-form factory schemas (`newMoistureMap()`, `newDryingLog()`, `newConstructionLog()`, etc.)
- `apps/field/js/app.js` — hash router (`#/`, `#/new`, `#/p/{id}`, `#/p/{id}/f/{formKey}`), the `FACTORY` map, job list rendering, job-home tiles, completeness panel
- `apps/field/js/forms.js` — one renderer function per form `(project, instance) → DOM node`, registered in the `RENDERERS` object at the bottom; the same DOM prints via `css/print.css`
- `apps/field/js/formkit.js` — bound input helpers (`inp`, `ta`, `sel`, `seg`, `check`, `photoUploader`), autosave via `commit()` → debounced `Store.put()`
- `apps/field/js/completeness.js` — rule-based readiness checklist shown on job home
- `apps/field/js/voice.js` + `apps/field/js/ai.js` — the "🎙️ Transcribe" voice-capture widget and pure chip-mapping logic (`candidateChips`, `applyChips`), currently mounted on moistureMaps, dryingLogs, photos, constructionLogs
- `apps/field/js/assist.js` + `js/officeai.js` + `js/narrative.js` — the conversational job-aware assistant and AI narrative generator
- `supabase/functions/roybal-ai-ingest/index.ts` — Edge Function doing Deepgram STT + Claude Haiku extraction with per-form `FORM_SCHEMAS`, a **$50/month hard spend cap**, and an `ai_usage` ledger
- `supabase/functions/roybal-ai-office/` — the conversational/narrative Edge Function
- `apps/field/js/sync.js` — offline-first sync: IndexedDB is the source of truth, whole-project JSONB blobs upsert into the Supabase `coordination_jobs` table; new fields sync automatically
- `apps/field/css/app.css` — design tokens: `--brand: #f26a21` (orange), `--navy: #16395a`, green/amber/red status colors; mobile-first, 48px tap targets
- `apps/field/test/` — plain Node test files (`node apps/field/test/<file>.mjs` style); pure logic lives outside the DOM so it's testable
- `apps/board/js/board.js` — the Job Board: pipeline `STAGES` (lead → scheduled → in_progress → on_hold → final → done, lines ~18–25), the job-blob shape (`stage`, `type`, `crewIds`, `startDate`, `targetDate`, `estimatedHours`, `durationDays`, `scheduleMode`, `pinnedStart`, `notBefore`, `deps`, `subtasks`, `isMilestone`, `fieldJobId`, `rev`), phase editor, Gantt renderer
- `apps/board/js/schedule.js` — pure scheduling math: `durationOf()`, `durationFracOf()` (hours ÷ crew × hoursPerDay), `addWorkDays()`, `layoutSubtasks()`, `computeSchedule()`, `computeCriticalPath()`
- `apps/board/js/data.js` — board↔Supabase sync of `coordination_jobs` rows with a `rev` optimistic-concurrency counter
- `apps/field/js/spine.js` — the `unified_jobs` crosswalk: field jobs auto-link to board jobs by normalized claim number; board jobs carry an (currently unused) `fieldJobId`

**Hard constraints:**
- No frameworks, no build step, no new npm dependencies in the field app. Vanilla ES modules only.
- Do not break any existing restoration form, the sync engine, or the board app (`apps/board` reads the same `coordination_jobs` blobs — additive fields only, never rename or repurpose existing fields).
- Existing jobs in the field must keep working with zero migration: every new field needs a safe default when absent (treat missing `jobType` as `"restoration"`).
- Every new form must be printer-friendly through `css/print.css` like the existing ones (`.app-only` hidden on print, sheet header/footer).
- Bump the service-worker cache version in `apps/field/sw.js` and add any new files to its precache list.
- Match the existing brand: orange `#f26a21` primary, navy `#16395a` chrome. Suggested accent for construction mode: keep the same palette but use the 🔨/🏗️ iconography and a small "CONSTRUCTION" chip — do not invent a new color scheme.
- Write/extend plain Node tests for all pure logic you add (conversion mapping, form-filtering, completeness rules, chip mapping), following the style in `apps/field/test/`.

---

## Goal

Add a **Construction / Remodel mode** to the Field Forms app so the same PWA handles two job kinds:

1. **Restoration** (existing — water mitigation, drying, everything as-is today)
2. **Construction** (new — remodels, new construction, and post-mitigation reconstruction/rebuild)

Plus a one-tap, AI-assisted flow that **converts a completed restoration job into a linked construction (rebuild) job**, and an integration that pushes **AI-estimated phase timelines onto the Job Board's calendar/Gantt** (`apps/board`).

Build it in five phases.

---

## Phase 1 — Job type + start-screen mode toggle

1. **Job model** (`model.js`): add `jobType: "restoration" | "construction"` to `newProject()`. Everywhere the app reads it, treat `undefined` as `"restoration"` (write a tiny helper `jobType(project)` and use it — never read the raw field).
2. **Form registry**: add a `types` array to each `FORMS` entry, e.g. `types: ["restoration"]`, `["construction"]`, or `["restoration","construction"]`. Shared forms (both types): `photos`, `contents`, `workAuth`, `constructionLogs`, `laborLog`, `changeOrders`, `invoices`. Restoration-only: `moistureMaps`, `dryingLogs`, `certDrying`. Add a helper `formsFor(project)` that filters the registry; job home (`projectHome()` in app.js) renders only the matching tiles. Missing `types` = both (backward-safe).
3. **Start-screen toggle**: on the home screen (`#/` job list), add a segmented control at the top — **💧 Restoration | 🔨 Construction** — styled like the existing `seg()` control. It filters the job list by `jobType`, shows a per-mode job count, and persists the selection in `localStorage['roybal-mode']`. The "+ New job" flow (`#/new`) creates the job with the currently-active mode's `jobType`, and shows which mode it's creating in (with a way to switch before saving).
4. **Job cards**: restoration cards keep their current summary line (category / class / drying flags). Construction cards show: project type (remodel / new construction / reconstruction), phase, and target-completion date. Add a small mode chip on each card so mixed contexts (search, board) stay unambiguous.
5. **Construction header fields** (`#/p/{id}/edit` job details): when `jobType === "construction"`, show construction-relevant header fields instead of the water ones (`waterCategory`, `waterClass`, `dryingSystem` hidden): `constructionType` ("remodel" | "new_construction" | "reconstruction"), `contractAmount`, `startDate`, `targetCompletion`, `permitNumbers`, `lender` (optional, for draw schedules), `linkedRestorationId` (set by the Phase 3 conversion). Keep customer/address/phone/email/carrier/adjuster shared — carrier/adjuster stay relevant for insurance-funded rebuilds.

**Acceptance:** existing restoration jobs appear untouched under the Restoration tab; a new construction job shows only construction/shared tiles; toggling modes survives reload; all existing tests still pass.

## Phase 2 — Construction form set

Model every form on the existing renderer + factory + registry pattern (schema in `model.js`, factory in the app.js `FACTORY` map, renderer in `forms.js`, entry in `RENDERERS`, completeness rules in `completeness.js`, print support in `print.css`). New forms, all `types: ["construction"]`:

1. **Scope of Work** (`scopeOfWork`, single) — 📐 — per-room/area sections; each area has trade-tagged line items (demo, framing, electrical, plumbing, HVAC, insulation, drywall, paint, flooring, trim, cabinets/counters, other), quantity + unit + notes per item, and an allowances table. This is the spine document the AI drafts in Phases 3–4.
2. **Pre-Construction Checklist** (`preConChecklist`, single) — ✅ — contract signed, deposit received, permits pulled (numbers + dates), HOA approval, utilities located, selections finalized, materials lead-times confirmed, pre-construction photos taken. Feeds the completeness panel: a construction job is "blocked" until contract + permit items are checked.
3. **Selections Sheet** (`selections`, single) — 🎨 — owner finish/fixture choices: area, item, spec/model/color, allowance $, actual $, over/under, status (pending / ordered / delivered / installed), decision date, owner initials line. Flag undecided selections whose lead time threatens the schedule (amber, mirroring the drying-watch flag style in `dryingwatch.js` — put the pure flag logic in a new `buildwatch.js` with tests).
4. **Subcontractor Schedule** (`subSchedule`, single) — 👷 — rows: trade, company, contact, scheduled start/end, actual start/end, status (scheduled / on-site / done / no-show), COI-on-file checkbox, notes. Reuse the drag-fill row UX from the drying log's equipment table.
5. **Inspection Log** (`inspections`, multi) — 🏛️ — inspection type (footing, framing, rough electrical/plumbing/mech, insulation, drywall, final…), scheduled date, inspector, result (pass / fail / partial), corrections list, reinspection date.
6. **Punch List** (`punchList`, single) — 🔧 — rows: room/area, item, trade, priority, photo (reuse `photoUploader`), status (open / in-progress / done / verified), completed-by + date. Owner-walkthrough signature block at the bottom.
7. **Draw Schedule / Progress Invoicing** (`drawSchedule`, single) — 💰 — payment milestones: description, % of contract, amount (auto from `contractAmount`), invoiced date, paid date, running balance. Each draw row gets a "Create invoice" action pre-filling a new instance of the existing `invoices` form.
8. **Certificate of Completion** (`certCompletion`, single) — 🏁 — mirror `certDrying`'s structure: final checklist, warranty summary (workmanship term, manufacturer registrations), owner + contractor signatures, completion date. Reuse the signature-pad code from `workAuth`.

Also: reuse `constructionLogs` (Daily Construction Log) as-is for daily crew/task/hours; reuse `changeOrders`, `photos`, `contents`, `laborLog`, `invoices` unchanged. Extend `completeness.js` with a construction rule set (contract signed → permits → inspections passing → punch list cleared → cert of completion) parallel to the water rules, and extend the job-list flags with build-watch chips (⚠️ failed inspection, 🕐 sub no-show today, 🎨 selection overdue).

**Acceptance:** each new form autosaves, syncs, and prints cleanly; completeness panel drives blocked/warn/ready correctly for a construction job; `buildwatch` logic has passing Node tests.

## Phase 3 — Convert a restoration job into a construction job (AI-assisted)

1. **Entry point**: on the job home of a restoration job, show a "🔨 Start reconstruction" card when the job is certified dry (`isCertified()` in `dryingwatch.js`) — and allow it earlier behind a confirm dialog ("Drying isn't certified yet — convert anyway?").
2. **Conversion is a copy, not a mutation**: create a **new** construction project (`jobType: "construction"`, `constructionType: "reconstruction"`) and leave the restoration job untouched. Put the pure mapping in a new `js/convert.js` — `convertToConstruction(restorationProject) → constructionProject` — with thorough Node tests. Carry over:
   - Customer/contact/insurance header: customer, address, phone, email, carrier, adjuster, claimNo, lossCause, dateOfLoss.
   - Photos (tagged so "before" context is preserved in the new job).
   - Moisture-map floor plans/sketches → attach as reference plans for the Scope of Work.
   - Change orders and the AI narrative → carried as read-only reference context.
   - Cross-links both ways: `linkedRestorationId` on the new job, `linkedConstructionId` on the old one; render each as a tappable link chip in the job header. Register the pair in the `unified_jobs` spine (`js/spine.js`).
3. **AI reconstruction setup**: after the copy, call a new Edge Function `roybal-ai-rebuild` (clone the structure, auth, cap, and ledger pattern of `roybal-ai-ingest` — **same $50/month cap and `ai_usage` ledger, no separate budget**). Send it a compact fact pack extracted from the restoration job (reuse/extend `narrativeFacts()` from narrative.js): affected rooms, materials removed (from moisture-map material picks + contents dispositions + change-order scope items), demo extent (e.g., drywall cut heights from readings/notes), flooring types, category of water. Claude (Haiku 4.5, forced tool-call, same as the ingest schemas) returns a structured draft:
   - `scopeOfWork` line items per affected room (e.g., "hang + finish 4' drywall flitch, lower walls, 320 sqft", "replace carpet + pad, 210 sqft")
   - suggested trade sequence for `subSchedule` (demo-complete → rough-in → insulation → drywall → paint → flooring → trim → punch)
   - a starter `selections` list (items the owner must choose: flooring, paint colors, trim profile…)
   - flagged unknowns/questions for the estimator
4. **Review-before-apply**: never silently write AI output. Present the draft using the existing chip pattern (`candidateChips`/`applyChips` in `ai.js` — extend them for the new targets): confident items normal, uncertain ones amber; tech reviews, edits, confirms → chips apply into the new job's forms. If the AI call fails or the cap is hit, the conversion still succeeds with empty forms and a notice — AI is an accelerator, never a dependency.

**Acceptance:** converting a certified restoration job yields a linked construction job with header, photos, and plans carried over; `convert.js` tests cover field mapping and missing-data defaults; AI failure/cap path degrades gracefully; original job unchanged byte-for-byte except the `linkedConstructionId` back-link.

## Phase 4 — AI throughout the construction workflow

Extend the existing AI backbone (don't build a parallel one) — all through the same cap + ledger:

1. **Voice capture on construction forms**: add `FORM_SCHEMAS` extraction entries in `roybal-ai-ingest` for `punchList`, `subSchedule`, `inspections`, and `selections`, and mount the `voice.js` widget on them. A tech walking a unit says "master bath — door casing scratched, painter; kitchen — cabinet handle missing, GC" and gets punch-list row chips to confirm.
2. **Job-aware assistant context** (`assist.js`): extend the fact pack so on construction jobs the assistant knows scope, sub schedule, inspection results, selection status, and draw status — so it can answer "what's blocking drywall?" ("insulation inspection not passed; scheduled Thursday") or "are we over allowance?" from the selections deltas.
3. **AI progress narrative**: extend the narrative generator (`narrative.js` / `roybal-ai-office`) with a construction template — weekly owner/adjuster/lender progress summary from daily logs, inspection results, and draw status; markdown, printable, editable before sending.
4. **Change-order drafting**: from a voice description ("found rot in the subfloor behind the tub, add sister joists and new underlayment, roughly $1,800"), draft a `changeOrders` instance — reason, scope lines, amount — as amber chips for review.
5. **Daily-log → schedule cross-check** (pure logic + optional AI phrasing, in `buildwatch.js`): if daily logs show a trade on-site that isn't on the sub schedule, or a scheduled trade with no log entries for 2+ days, raise a flag chip on the job card.

Keep each of these independently shippable; do them in the order above.

## Phase 5 — Job Board integration: AI timeline → calendar/Gantt

The Board (`apps/board`) already schedules jobs from phases (`subtasks`) with `estimatedHours`, `lagDays`, and crew, computes dates with work-day math, and draws the Gantt/calendar/critical path. Do **not** rebuild any scheduling in the field app — the field proposes a plan, the Board schedules it.

**Ownership rule (follow it strictly to avoid sync fights):** the field app owns *scope, phase hours proposals, and actuals* (daily logs, inspections, punch list); the Board owns *dates, crew assignments, dependencies, and stage*. Neither app overwrites the other's territory.

1. **AI phase-plan estimation** (field side): extend `roybal-ai-rebuild` (Phase 3) — and add a standalone "📅 Estimate timeline" action on any construction job's Scope of Work — so the model returns a phase plan in **exactly the Board's subtask shape**:
   ```javascript
   boardPlan: {
     phases: [ // matches board.js subtasks[]
       { name: "Demo & prep",  estimatedHours: 24, lagDays: 0, crewIds: [] },
       { name: "Rough-in",     estimatedHours: 32, lagDays: 0, crewIds: [] },
       { name: "Insulation + inspection", estimatedHours: 8, lagDays: 1, crewIds: [] }, // lag = inspection wait
       { name: "Drywall",      estimatedHours: 40, lagDays: 1, crewIds: [] },           // lag = mud cure
       ...
     ],
     notBefore: "YYYY-MM-DD" | null, notBeforeLabel: "materials" | "permit" | "",
     assumptions: ["2-man crew", "cabinets are 3-week lead"],   // shown to the reviewer
     generatedAt, status: "draft" | "pushed",
   }
   ```
   Prompt the model to derive hours from the Scope of Work line items (quantities × trade), insert `lagDays` for real-world waits (mud/concrete cure, inspection scheduling, material lead times from the Selections sheet), and surface `notBefore` when permits or long-lead selections gate the start. Store it as `project.boardPlan`; review via the amber-chip pattern before saving (editable phase rows, same UX as the Board's phase editor). Same $50 cap + ledger.
2. **Push to Board**: a "Send to Job Board" button on the field construction job. Using the field app's existing Supabase REST access (`supa.js`), create-or-update the linked board job row in `coordination_jobs`:
   - Match via the `unified_jobs` spine (claim number) or explicit `linkedRestorationId`/`fieldJobId`; if no board job exists, create one with `stage: "scheduled"` (or `"lead"` if no start date), `type` mapped from `constructionType` (`remodel` → `"remodel"`, `new_construction` → `"new_build"`, `reconstruction` → `"restoration"`), `title`/`customer`/`address`/`phone` from the header, `contractValue` from `contractAmount`, `notBefore`/`notBeforeLabel`, and `subtasks` from `boardPlan.phases` (leave `durationDays: null` so the Board computes from hours ÷ crew; leave `crewIds` empty — crew is the coordinator's call).
   - Set `fieldJobId` on the board job and `coordination_job_id` in the spine, so the link is explicit both ways (today claim-number matching is the only coupling).
   - **Respect the Board's `rev` optimistic-concurrency counter** (see `data.js`) — read-modify-write with rev bump, and on conflict re-fetch and retry once. Never clobber `startDate`, `pinnedStart`, `scheduleMode`, `crewIds`, `deps`, or `stage` on an existing board job — only propose `subtasks`/hours, and stage the proposal (see next point) rather than overwriting phases the coordinator has already touched.
   - If the board job already has phases, don't overwrite: write the proposal to `data.fieldPlanProposal` and let the Board surface it (next point).
3. **Board side — receive + reconcile** (changes in `apps/board/js/board.js`, same vanilla patterns):
   - Job modal: an "Import from Field" section that appears when `fieldPlanProposal` exists or a spine-linked field job has a newer `boardPlan` — shows the proposed phases vs current ones, one tap to accept all / per-phase.
   - A small chip on board cards linked to field jobs: "📱 field-linked", turning amber "⚠ field update" when a newer proposal is waiting.
   - After import, `applySchedule()` + `saveJob()` cascade dates exactly like manual phase editing does today.
4. **Continuity back to the field** (read-only): on the field construction job home, show a compact "This week on the board" card — the linked board job's current/next phases with dates and crew names, pulled read-only from `coordination_jobs`. The Subcontractor Schedule form gets a "Prefill from board phases" action. Techs see the coordinator's plan without leaving the field app.
5. **Actuals → Gantt reality check** (pure logic in `buildwatch.js` + small board change): roll up daily-log hours per phase name (fuzzy match phase names against log task text — keep it simple, exact/contains match) into `data.fieldActuals = { phaseName: hoursToDate }` on the linked board job at sync time. Board Gantt already shows actual/estimated hours on bars — feed it. Flag on both apps when a phase's actual hours exceed its estimate (amber at 80%, red at 110%), and when a change order adds scope, prompt "CO adds ~N hrs to <phase> — update the board plan?".
6. **Calibration loop** (cheap, high value): when building the AI estimation prompt, include a compact history digest from completed board jobs (estimated vs actual hours per phase name, last N jobs) so estimates improve over time — e.g. "historically your drywall phases run 1.3× estimate". Compute the digest in pure JS (testable), keep it under ~1k tokens.

**Acceptance:** estimating + pushing a field construction job creates/updates a board job whose Gantt renders the AI phases with correct work-day math; re-pushing after the coordinator edited phases stages a proposal instead of overwriting; `rev` conflicts retry cleanly; field job home shows the board's live schedule; all board behavior for non-field jobs is untouched.

---

## Working method

- Work phase by phase; after each phase run the Node tests (`apps/field/test/`) and add new ones for your pure logic, then pause for review before the next phase.
- Follow existing code style exactly: no semicolon/formatting churn, same helper idioms (`el()`, `field()`, `sheet()`), comments only where the existing code would have them.
- Update `apps/field/README.md` with the new mode and forms, and bump the sw.js cache version once per phase that ships files.
- When you must choose between a clever abstraction and copying the existing pattern one more time — copy the pattern. This codebase optimizes for a solo maintainer reading it cold.
