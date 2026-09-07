# 04 — Open Questions

This is everything the plan needs from you. It consolidates the "option left to the owner" entries in the decision record and §1–§8, the questions the three design attempts raised independently, the assessor's gaps, the critic's owner-facing findings, and the two places the review stopped short of deciding for you — the rebuild verdict (01-ARCHITECTURE-REVIEW.md Part III §7) and the first-automation trade (02-CAPABILITY-GAP-MATRIX.md §8). Where three attempts asked one underlying question in three vocabularies, it appears once, in the highest group it belongs to.

**How to answer.** Every item has a default, and the default is what §1–§8 already assume — silence is consent and the roadmap runs as written. Group A changes the recommendation itself and is wanted before E0. Group B changes the order or size of phases and is wanted before the phase it names. Group C is detail we seed either way. Reply inline under any item, or just mark the ones you want to talk through. Bracketed tags — `[A-0.1]`, `[A-7.12]` — are the register at the end; section references are to the decision record ("Decision record §n") and the numbered parts ("§2.4"). **Answered so far:** the owner ruled on 2026-09-06 — the rulings are the next section and every item below carries a one-line status.

---

## Answered — the owner's rulings, 2026-09-06

**Status: binding.** Three rulings, quoted as the owner wrote them, each with the single reading the plan takes from it. Everything not named here is deferred to its default; every item in Groups A, B and C now carries a one-line status directly under its heading. [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) records the two substantive rulings as Decision record §17.

> "we will change how the crew captures reading and equipment placement to facilitate carrier grade reports. We just need a SOP to train the crew."

**Reading — A2 is ANSWERED, YES; option (a), the default.** Room identity, per-location moisture readings and equipment as scanned placement/removal events are authorized as a change crews make on site, in the order rooms → locations → scans at P3, each additive behind the existing blob so offline capture never changes. The consequence is the one the question itself named: capabilities 1–3 are **no longer capped at "internal leak detector" grade** for the horizon — per-unit day counts, per-location dry goals and photo-to-line joins become reachable, and carrier-grade justification is back on the roadmap instead of ruled out of it. The training the ruling asks for exists: **[05-CREW-CAPTURE-SOP.md](05-CREW-CAPTURE-SOP.md)**. B9's paper lane is unchanged and is load-bearing here — the SOP has to produce the same data from the crew member who uses no app, entered by a named person from the office.

> "I currently want to approve all money and transactions until I add more Office help. build in that capability for automation at threshold but toggle off for now."

**Reading — C7 is ANSWERED; option (b), *not* the default.** The owner approves every `money` action type today. The threshold machinery is still built on the P1 schedule exactly as designed — `approval_policies(action_type, division_id, max_amount_usd, approver_role, auto)`, the `approved_by_kind='policy'` / `approved_by_ref` stamp, and `agent_authority` conditions for machine principals — but it **ships seeded owner-only with every row `auto = false`**, so no amount threshold and no policy approves anything until the owner widens it. Widening is then a row and an explicit act, never a migration; that is the whole reason to build it now and leave it off. This confirms B10 (owner's cell only) and B11 (MCP propose-only) as written, and it qualifies assumption **[A-0.3]**: the per-division thresholds exist as a column, and no value is set in them.

> "all other questions defer to defaults."

**Reading.** Every remaining item takes option (a). §0 already said silence is consent and the roadmap runs as written; the per-item marks below make that explicit rather than implicit, so a future reader can tell a decision from an omission.

**Where "the default" is unambiguous, and where it is not.**

1. **Every one of the 28 questions carries exactly one stated default, and in every case it is option (a)** — checked item by item on 2026-09-06. There is no question in this document for which "defer to defaults" is undefined.
2. **Five of those defaults are only half a decision** — they name the option and still need a value from the owner before the phase that consumes them. Deferring did not supply the value: **A5/[A-7.4]** (the three closed mitigation jobs the P2 verify runs over — none named), **A7** (deferring *asserts* that no carrier requires Xactimate-native submission; that is a claim about the world, not a design choice), **C1** (the second admin's mapping is confirmed by an act in the admin UI at P1, not by a document entry), **C2** (the four crew rows with no email are confirmed by name in the admin at P3), and **C3** (the top four or five carriers, named up front — none named, so `carrier_profiles` stays empty and P4's submittal flow has nothing carrier-specific to be). None of the five blocks E0 or P1; each is asked for again by its own phase.
3. **The nine unverifiable facts at the end of this document have no defaults at all**, so "defer to defaults" does not reach them. They are not decisions — they are console settings, live secrets, Twilio configuration and the actual value behind `OWNER_CELL`, things that can only be looked up. Several gate E0, and fact 8 in particular is the live number the owner-only approval allowlist of the money ruling has to be seeded from.

## Group A — answers that change the recommendation

### A1. Is the strangler the path — the backend rebuilt underneath, the field app's capture kept?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** All three judges chose it independently and 01-ARCHITECTURE-REVIEW.md Part III §7 recommends it: an operation layer, an approval spine, a document model and the claim vocabulary are absent from every era and cannot be reached by patching the blob. The review names evolve-in-place as "the default if nobody decides" — the pay-twice path. Everything in §7 assumes this answer.

**Options.** (a) Strangler; the blob stays the crews' write model until each section is moved — *default*. (b) Evolve in place, which keeps the merge twin, `using(true)` and browser executors permanently and has no roadmap here. (c) A parallel `apps/field-next`: a second field bundle and a cutover crews feel on a single day. (d) Clean-sheet rewrite, rejected by all three judges — 15 jobs and 743 kB migrate in an afternoon, 638 lines of sync invariants learned from four data-loss incidents do not.

### A2. Will the crews' capture shape be allowed to change this year — room ids, per-location moisture readings, equipment as scanned placement events?

**Status: ANSWERED — YES (2026-09-06).** Option (a), the default: rooms → locations → scans at P3, each additive behind the blob. Capabilities 1–3 are no longer capped at internal-leak-detector grade, and the SOP that trains the crew is [05-CREW-CAPTURE-SOP.md](05-CREW-CAPTURE-SOP.md). See Answered above.

**Why.** This decides whether capabilities 1–3 stay at "internal leak detector" grade or reach carrier grade. `billing.reconcile` v0 sums typed count strings (`apps/field/js/model.js:353-361`) and matches invoice lines by regex because no line carries a code; the live sample bills 215 air-mover-days against a log of 20 per day (§7.13). Per-unit identity, per-location dry goals and photo-to-line joins arrive only with P3's `roomIds[]`, `moisture_locations`/`moisture_readings` and `equipment_placements` — each a change crews perform on site, and a forced build update.

**Options.** (a) Yes at P3, in the order rooms → locations → scans, each behind the existing blob so offline never changes — *default*. (b) Rooms and locations only: drops the WASM label decoder and the scan screen, leaves the detector on counts. (c) No capture change this year, which caps capabilities 1–3 at internal-leak grade for the whole horizon, makes carrier-grade justification unreachable, and removes P3's largest sub-step.

### A3. Is a second legal entity or franchise plausible within three years?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** The plan puts `org_id uuid not null default '<this-org>'` on the spine and money tables as they are created, and the JWT claim carries it (R12). Added now it is a column nobody notices; added later it is a migration across every policy, unique constraint, materialized view and claim, under load. All three attempts asked this.

**Options.** (a) Defaulted `org_id` from the first migration, divisions doing the day-to-day work — *default*. (b) Divisions only: one fewer column per spine table and one fewer claim field, at the cost that a later split is the migration above. Answer "never" and we take (b).

### A4. Permissions as data (`role_permissions` rows) or as code (a generated matrix)?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** Rows mean changing who may approve is an owner-run `role.grant` op, not a deploy — which matters at 100 people with several office staff and per-person overrides (Decision record §5, ADR-04). Code-as-matrix is versioned and drift-free, and adequate while the office is two people.

**Options.** (a) Rows, with a CI snapshot asserting every catalog operation has a row or an explicit deny — *default*. (b) Code-as-matrix with a generated `PERMISSIONS.md`: one fewer table and operation, permissions reviewable in a diff, every change a deploy. Switching to rows later is a one-time import, so this is the cheapest Group A item to get wrong.

### A5. Is regex-grade proposal output acceptable as a queue you clear every morning?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below. The default still needs an input the owner has not given: the three closed mitigation jobs the P2 verify runs over [A-7.4].

**Why.** 02-CAPABILITY-GAP-MATRIX.md §8 states the trade: the unbilled detector touches cash and uses data that exists, but at regex grade until placements and coded lines exist; adjuster-email drafting proves the loop faster and creates the `submittals` row capabilities 1, 3 and 5 are blocked on. §7.13 ships both — the email lane as P1's smoke test, the detector as P2's first new capability — but the detector is only worth building if you will work its findings, including the honest ones that say the log cannot support the quantity either way.

**Options.** (a) Yes: `invoice.review_gaps` proposals at P2, evidence ids attached, no price where no rate exists, verified retrospectively against three closed jobs you pick [A-7.4] — *default*. (b) Hold the detector until placements exist and make P2 the adjuster-email and submittal lane: the first new capability slips from week 10 to about week 18. (c) Unforeseen scope first, which needs `scope.compare` and the supplement kind before P4 — a phase-scale reorder.

### A6. Is the office UI strangled tab by tab, or rebuilt as one app and cut over once?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** §7.7 rebuilds the tabs of `apps/office` one at a time — Today/Proposals → Leads → Claims → Documents → Board — each beside its old route until two weeks of daily use and 14 days of zero old-route traffic [A-7.9]; the last tab ends the office's dependence on the field sync replica, and the board's 20 s poll (`apps/board/js/board.js:205-208`) and five hand-rolled rev guards come out behind operations one at a time.

**Options.** (a) Strangle per tab against the cutover criteria of §7.11 — *default*. (b) Build `apps/office` whole and switch on one day: 8–10 weeks with no usable intermediate state and a single reversal point. (c) Leave admin and board as they are, which keeps direct client writes on `coordination_jobs`, `crew_members`, `time_entries` and `contacts` permanently — the finding P5 exists to close.

### A7. Do any of your carriers require Xactimate-native (ESX / XactAnalysis) submission, and for which claim types?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below. Note that deferring here asserts no carrier requires Xactimate-native submission; if one does, it changes what ships first at P4.

**Why.** ESX is encrypted, Verisk publishes no export, and the EULA forbids redistributing price data, so this pipeline produces no structured Xactimate output (§6.11, ADR-12). For a native carrier the workflow stays as today — build in Xactimate, upload through XactAnalysis — and `submittal.record` captures what was sent: `channel='carrier_portal'`, the reference in `external_ref`, the PDF as the sent version.

**Options.** (a) PDF-and-packet carriers only; the invoice template first at P4 — *default*. (b) Name the native carriers and their claim types: P4's first template becomes the drying-log packet and certificate instead, because the invoice would ride Xactimate anyway. A data change, not a design change, but it moves what ships first by several weeks.

## Group B — answers that change the roadmap order or scope

### B1. Do E0's two weeks happen before any revenue work, or interleaved?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** E0 is eleven one-PR fixes to facts read from production on 2026-09-06: Gmail dead since 09-01 and QB Time since ~09-04 with `cron.job_run_details` reporting both as succeeded; six proxy actions reachable with the publishable key (`supabase/functions/qb-time-proxy/index.ts:747-979`); three zombie `pending_actions` counting forever against `MAX_LIVE_PROPOSALS = 3`; 174 of 175 outbound SMS rows frozen at `queued`; `min_field_build` seeded 0 (`supabase/migrations/218_sync_rpcs_and_build_gate.sql:55`). Nothing later is trustworthy on top of these.

**Options.** (a) Two clear weeks — *default*. (b) Interleaved over four weeks, which leaves the approval spine jammed while P1 is built on it.

### B2. Is a second Supabase project acceptable as staging, at its plan fee?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** Branching cannot be used: the journal does not replay (105 updates tables created by 200; 233/236/244 scrape `cron.job`), so staging is a second project seeded from a scrubbed `pg_dump` [A-0.6] (ADR-13). Without it, CI's merge path loses its middle step and function tests have no home with real secrets.

**Options.** (a) Second project — *default*. (b) Local `supabase start` in CI only: saves the fee, removes the only rehearsal for a prod migration. (c) Branching, which needs the baseline squash first anyway.

### B3. Worker sizing: its own Fly app at ≥1 GB, or co-hosted with the phone agent?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** `roybal-phone` runs at `shared-cpu-1x`, 256 MB (`services/phone-agent/fly.toml:20-23`) with `min_machines_running = 1`, because a missed call cannot wait for a cold start; Chromium alone needs 300–500 MB. One machine is also the ceiling for queue, outbox and rendering.

**Options.** (a) `roybal-worker`, its own app, `shared-cpu-2x`/1 GB, one machine; staging runs from CI or a laptop [A-1.2] — *default*. (b) `performance-1x`/2 GB, or (d) a second machine — both `fly scale`, worth taking early if a stalled outbox would be felt. (c) Co-hosting lets a render OOM-restart a live call.

### B4. Does the Micro → Small compute upgrade wait for its trigger metric?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** The live tier is a 1 GB Micro with two disk-IO incidents (Jul 24, Aug 17), and the plan adds `events`, queue polling, `outbox`, `integration_runs` and projections to it. §7.12 fires the upgrade on a metric — `events + capture_events` past 1M rows, p95 `push_project` past 400 ms, or a third disk-IO alert.

**Options.** (a) Metric-triggered at P3 — *default*. (b) Upgrade at P1: two phases of tier cost, and it removes the surprise most likely to land during the projection rollout.

### B5. How far does QuickBooks sync go beyond invoices and payments?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** The brief says "QuickBooks sync" generally; the plan specifies invoices out, payments in, QB Time hours in, widening at P6 to receipts as purchases, `materials.cost_usd` into job costing, `qbo.customer.upsert` and `divisions.qbo_class` on pushed lines (§7.8). Bills, vendors and payroll are nowhere in scope.

**Options.** (a) That scope — *default*. (b) Add bills and vendor expenses at P6, the point where QBO stops being a sink and becomes a second source of truth for cost. (c) Invoices and payments only.

### B6. Do admin and board become one `apps/office`, or stay two entries?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** §7.7 and [A-0.10] assume one app. The merge saves a bundle and one auth path; it also changes bookmarked URLs and takes away the board as its own window on a second screen, which is how it is used today.

**Options.** (a) One `apps/office`, board as a route — *default*. (b) Two entry points on the same operations client — one more bundle target, and the right answer if anyone runs the board on a dedicated screen.

### B7. Which blob sections get normalized, and which stay projections?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** §7.10 assigns an owner and a phase to every live blob key, and the review calls this choice per section a one-way door. Capture-owned sections (moisture maps, drying logs, photos, contents, sketches) stay blob-written and projected; office-owned sections (`invoices[]`, `reconEstimates[]`, `changeOrders[]`, `drawSchedule`) become rows at P4 and the field editor goes read-only. The forcing condition for moving a capture section is an office feature that must edit it.

**Options.** (a) The §7.10 split — *default*. (b) Normalize moisture and drying logs fully at P3, which makes crews' offline writes depend on row-level conflict handling `merge.js` does for free. (c) Keep money documents editable offline, which keeps back-projection alive past P5.

### B8. How far should the scheduling engine go, and who approves a proposed week?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** `apps/board/js/schedule.js` (887 lines, pure) takes bodies × one shift today. §7.9 adds four hard constraints — skills/certs, per-person availability, equipment reservations, drying predictions — and a drive-time penalty from distance buckets [A-0.7], filing one proposal per run so `schedule.apply` lands the set atomically; crew leads approve their own crew, office approves cross-crew runs.

**Options.** (a) That pass at P7 — *default*. (b) Certs and availability only: ships weeks earlier, leaves equipment double-booking to humans. (c) Cost-optimal optimization: a solver instead of a deterministic forward pass, and the proposal stops being reproducible from a fixture.

### B9. The crew member on paper — is `digestOptOut` the whole answer?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** One roster member rejects apps and phones; his lane is honored today at `roybal-brief/crewdigest.ts:149`. The plan keeps it as `crew_members.contact_prefs`, checked by every comms op, with `time_entries.source='paper'` entered from the office and shown in the `crew_hours` report so his hours are visible rather than missing.

**Options.** (a) `contact_prefs` plus a paper source — *default*. (b) Also generate a printed weekly schedule (one more document kind at P4). (c) Plan for him to come onto the app, which makes the exemption temporary rather than structural.

### B10. Who may approve by SMS?

**Status: ANSWERED — the default, confirmed (2026-09-06).** Option (a), owner's cell only: the money ruling requires it. The number itself is unverifiable fact 8 below, not something this document can seed.

**Why.** Today `handleApproval` compares the sender to a single `OWNER_CELL` and returns false for anyone else (`supabase/functions/roybal-notify/index.ts:400-401`). The plan replaces that with an allowlist: `roybal-webhooks` resolves the sender through `profiles.phone` to a principal holding `approve` for that action type and calls `op_proposal_approve`/`op_proposal_decline` directly, so approvals record even with the worker down (R11, [A-2.1]).

**Options.** (a) Owner's cell only at P1 — *default*. (b) Add the office phone under an amount threshold. (c) Non-money kinds only. All are seed rows, but settle it before P1's negative tests, which assert who is refused.

### B11. May an MCP token ever hold more than propose?

**Status: ANSWERED — the default, confirmed (2026-09-06).** Option (a), propose-only permanently: the money ruling requires it.

**Why.** The worker serves MCP over streamable HTTP with a minted `api_tokens` bearer; a session acts as the minting human for reads and is capped at propose for every write regardless of that human's role, and the audit row says "proposed via mcp by <person>" (§2.4, §7.9, [A-0.3]).

**Options.** (a) Propose-only permanently, tokens expiring in 30 days [A-2.3] — *default*. (b) Execute on a named low-risk action set, which makes the token rather than the person the approver.

### B12. Do crew-line texts get an exemption from the 7 am–8 pm Alaska window?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** Your brief states the window as a flat constraint and the plan honors it literally: every kind waits in the outbox and is released at 7 am. That is a change from today, where `assertSendWindow` exempts `crewSchedule`/`onOurWay`/`crewLine` (`supabase/functions/roybal-notify/index.ts:225`). If a 6:40 am on-our-way text is necessary the exemption is legitimate — but it becomes a setting you can see, never a constant in code.

**Options.** (a) No exemption — *default*. (b) Exempt the three crew-line kinds as a per-kind row in `notification_policies`/`role_permissions`. (c) A wider window for crew kinds only. (b) and (c) are rows seeded at P1; nothing in the design moves.

## Group C — confirmations and details

### C1. The second admin login — office or owner?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below. The confirmation itself is still an act in the admin UI at P1, not a document entry.

**Why.** Two live profiles hold `admin`. The plan maps `branden@` → `owner` and the second admin → `office`, with the claim armed only after you confirm in the admin UI (R20) — otherwise an office user gets owner-grade approval, or you lock yourself out of a login.

**Options.** (a) Second admin → `office`, confirmed before arming — *default*. (b) Both `owner`. One seed row either way.

### C2. Binding the four crew rows with no email.

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below. The four rows with no email still need confirming by name in the admin at P3.

**Why.** `crew_members.principal_id` is nullable and only 7 of 11 roster rows carry an email (live), so an email match cannot bind the rest; the paper-timesheet member may never have a login [A-5.4]. Every member does get a mandatory `contact_id` (R21).

**Options.** (a) Bind the 7 by email, confirm the other 4 by name in the admin, a member with no login keeps a contact only — *default*. (b) Logins for all 11: four invitations at P3.

### C3. The carrier list and their format profiles.

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below. The default still needs an input the owner has not given: the top four or five carriers, named.

**Why.** `carrier_profiles` starts empty. Each carries the submission format, required attachments, the justification style that has worked, and (from P6) `learned_rules` from recorded rejections. Without a first seed, P4's submittal flow has nothing to be specific about.

**Options.** (a) Seeded from submittal history as it accumulates from P1, with your top four or five named up front — *default*. (b) One generic profile. If per-carrier *layouts* are needed rather than per-carrier text, that is a template dimension (see A7).

### C4. Document numbering — one series per kind per year, or per division?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** `document_sequences(org_id, kind, year, next)` produces `INV-2026-0042`; the number is allocated inside the issuing transaction, a voided number is never reused, and QuickBooks receives it as `DocNumber` (`supabase/functions/qbo-proxy/index.ts:336`). Draws also carry the ordinal lenders read ("Draw 3 of 7").

**Options.** (a) One series per kind per year per org [A-6.3] — *default*. (b) Per-division (`divisions.number_series`): one column and a different unique constraint, decided before the first document is issued at P4.

### C5. Retention — is there a legal or insurance rule we should be honoring?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** The plan purges `outbox` at 90 days, `capture_events` `emailPull` rows at 30, `jobs_queue` done rows daily [A-5.8], and trims `agent_runs.trace` at 90 days on the assertion that it never holds customer text or model output [A-2.4]; `events`, `ai_usage` and `integration_runs` are kept (§7.12, ADR-05).

**Options.** (a) Those windows — *default*. (b) A stated retention period per claim or policy, which changes the document and event windows. Each is a purge schedule, not a structure.

### C6. PITR at P4 — confirm the timing and the bucket window.

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** PITR turns on at P4, when documents and events become the legal record. It covers Postgres, not Storage, and need not: an issued version re-renders from `model_json` + `template_version` + the pinned Chromium build with `pdf_sha256` verified (ADR-07). The same step enables soft-delete on the `documents` and media buckets [A-6.8].

**Options.** (a) PITR plus bucket soft-delete at P4 — *default*. (b) Earlier, at P1: the plan fee starts three phases sooner.

### C7. Who else may approve money, and above what amount does it come to you?

**Status: ANSWERED (2026-09-06) — option (b), not the default.** Owner-only until a second office hire: the owner approves every `money` action. The threshold capability is still built at P1 — `approval_policies` with `max_amount_usd`, `auto` and the `approved_by_kind='policy'` stamp — but seeded owner-only with every row `auto = false`, so nothing auto-approves until the owner widens it. See Answered above.

**Why.** The matrix gives `office` approve on `money` actions under a per-division `max_amount_usd` you set, everything above routed to you [A-0.3]; `agent_authority` carries the same condition for machine principals. These are P1 seed rows and they set the volume of your own inbox.

**Options.** (a) Office approves invoices and change orders under a threshold you name — *default*. (b) Owner-only until a second office hire. One row per action type per division.

### C8. Who gets alerts when you are unreachable?

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** Dead-worker alerts come from a 5-minute pg_cron check over `worker_heartbeats` that posts to `roybal-webhooks /alert` and texts you synchronously (R13); integration-health alerts fire on three consecutive failures or no successful run in twice the expected cadence (R3) [A-2.5]. All reach exactly one number today.

**Options.** (a) Owner's cell at P1; an `on_call(role, phone, from, to)` table replaces it at P5 [A-2.6] — *default*. (b) Name a second recipient now: one row and one predicate.

### C9. The price source — confirm `price_list` stays frozen.

**Status: DEFERRED TO DEFAULT (2026-09-06)** — option (a), the one marked *default* below.

**Why.** The 2,959-row `price_list` was transcribed from Xactimate and the EULA forbids redistributing that data, so every design froze it behind a `price_sources` interface (ADR-12). Drafted and review-gap lines price from `internal_rates` calibrated from paid invoices [A-5.6], then the job's approved estimate; the P2 detector prices a delta only from a rate already on that invoice [A-7.11].

**Options.** (a) `internal_rates` first, approved estimate second, `price_list` frozen and never expanded — *default*. (b) Retire `price_list` now, which moves rate-book seeding into E0/P1. (c) A licensed feed on a timeline you name — a `price_sources` adapter, nothing else changes.

## Assumptions we will proceed on unless you object

| Tag | Assumption | If wrong | Where it lives |
|---|---|---|---|
| A-0.1 | Worker is its own Fly app, ≥1 GB | A render OOM restarts a live call | §1.4, ADR-08 |
| A-0.2 | `pg_jsonschema` is enabled | Validation moves to the dispatcher | §2.1, ADR-01 |
| A-0.3 | MCP is propose-only; you set per-division amount thresholds — qualified 2026-09-06: the thresholds are built but seeded owner-only with `auto = false` (see Answered) | Agents or tokens approve their own work | §2.4, ADR-03 |
| A-0.4 | Offline signatures attach to the current issued version | A signature lands on a superseded version | §6.8 |
| A-0.5 | Seed model routes and effort levels stand until evals | Cost or quality drifts on one task class | §2.7, ADR-09 |
| A-0.6 | Staging is a second Supabase project at its plan fee | No rehearsal for a prod migration | §7.3, ADR-13 |
| A-0.7 | Travel starts as distance buckets | Cross-town splits under-penalized | §7.9 |
| A-0.8 | Demotion revokes sessions via the auth admin API | A demoted claim lives until refresh | §2.4, ADR-04 |
| A-0.9 | Evals live at `packages/ai/evals/<task_class>/` | A directory move | §2.7 |
| A-0.10 | `apps/office` is the home of admin and board | See B6 | §1.1, §7.7 |
| A-1.1 | One navy `#0f1b2d`; the screens' `#16395a` is drift | Darker office header; print unchanged | §1.6, §6.5 |
| A-1.2 | The worker hits staging from CI or a laptop; no second Fly app | Staging worker runs stay manual | §1.4 |
| A-1.3, A-1.5 | The site keeps manual `wrangler pages deploy`; `supa.js` moves into `packages/db` verbatim | A missed site deploy; one PR, not a design | §1.9, §1.1 |
| A-1.4 | The five era-2 completeness tables move to schema `legacy`; the 29 JS rules are the spec | They sit unused in `public` | §1.2, §3.5 |
| A-1.6 | One origin, one service-worker scope through P5 | Version skew of at most one open | §1.6 |
| A-1.7 | `BUILD` is the commit count (489 today); `COMMIT` carries the SHA | A history rewrite makes a device look older than the floor | §1.7, R2 |
| A-1.8 | Node type-stripping lets the worker import `packages/*` at P1 | esbuild moves from P3.0 into P1 | §1.10, §7.3 |
| A-2.1 | SMS approvers resolve via `profiles.phone` to principals holding `approve`; `OWNER_CELL` stops being special | One predicate in the approval path | §2.4, ADR-03 |
| A-2.2, A-2.3, A-2.5, A-4.10 | Operational defaults: poll 5 s, heartbeat 30 s, leases extended on heartbeat; `api_tokens` 30 days; health checks every 15 min with a 24 h resend guard; collections at due + 7 / 21 / 45 | Each is a settings value, not a structure | §2.2, §2.6, §7.8 |
| A-2.4 | `agent_runs.trace` holds no customer text or output; trimmed at 90 days | Retention and privacy posture changes | §2.2 |
| A-2.6 | Alerts text the owner; `on_call` replaces the single number at P5 | Alerts reach nobody when you are away | §2.6, §7.7 |
| A-2.7 | The load rates are planning estimates, replaced by measurements after P3 | Ceilings move | §2.2, §7.12 |
| A-3.1 | Per-map dry goals are coerced onto `moisture_locations` with a `parse_warning` | Goals mis-stated until per-location capture | §3.6 |
| A-3.2 | Free-text rooms resolve via `roomIds.aliases`; unresolved ones create `source='blob'` rooms to merge | Mis-filed until merged, never lost | §3.2 |
| A-3.3 | `drying_predictions` uses per-location trends with an IICRC fallback below 3 readings | The scheduler consumes a weaker signal | §7.9 |
| A-4.1 | `job.mark_dry` auto-approves when `source='cert_signed'` | Mark-dry becomes a per-job tap | §4 |
| A-4.2 | Fan-out is declared on the op; `event_subscriptions` replaces it at P5 | Fan-out changes need a deploy until P5 | §4, §7.7 |
| A-4.3, A-4.5 | Draft `period_start` is the later of mitigation start and the last issued invoice's `period_end`; the `invoice.issue` key carries a content hash and edits supersede | A second draft double-bills a period; you approve one version and issue another | §4 |
| A-4.4, A-4.7 | `agent:billing` executes on drafts only and proposes `invoice.issue`; a human holding execute runs the op directly, which is not an approval | An agent issues an invoice; separation of duties misapplied | §4 |
| A-4.8 | `qbo_item_map(category, qbo_item_id)` replaces the generic "Services" item | Line categories stay collapsed in QBO | §4, §7.6 |
| A-4.9 | Intuit throttling is handled by outbox backoff | Slower pushes, no data lost | §4 |
| A-4.11 | Lenders ride the `carrier_profiles` shape; `draw_requests.expected_funding_days` drives inquiry cadence | Draws need their own profile table | §4, §7.6 |
| A-5.2, A-5.3 | `packages/db` types are generated and committed; `connections` tokens are Vault-encrypted | Types drift; plaintext OAuth tokens persist | ADR-02, ADR-15 |
| A-5.4 | `job_assignments` lands at P3; crew scoping is division-wide until then | Crew reads stay company-wide two phases longer | ADR-04 |
| A-5.5 | The phone agent keeps `PHONE_MODEL` until P7 | One route lives outside the table | ADR-09 |
| A-5.6 | `internal_rates` is calibrated from paid invoices | Drafted lines price from the estimate only | ADR-12 |
| A-5.7 | Pad and portal signatures suffice; a legal e-sign need adds an adapter with `signer_kind='external'` | An envelope provider joins at P4 | ADR-07 |
| A-5.8 | `jobs_queue` purges daily; `job.project` drops at the next purge, other kinds keep 14 days | Less queue history to debug with | ADR-06 |
| A-6.1 | Photo packets cap at 300 images per render, then continuation volumes | Larger packets need a bigger machine | §6.10 |
| A-6.3 | One number series per kind per year per org | See C4 | §6.6 |
| A-6.4 | Meter OCR ships only above a confidence floor and after a ~50-photo eval | The prefill stays off | §6.15 |
| A-6.5, A-6.9 | Safari honors `navigator.storage.persist()`; Tesseract is ~6–8 MB and loads only when OCR is enabled | Eviction risk on low-storage devices; bundle size | §6.14, §6.15 |
| A-6.6, A-6.7 | The `documents` bucket is service-role only; portal e-sign records `ip` and `consent_text_version` | A client writes an artifact of record; weaker evidence on a disputed signature | §6.7, §6.8 |
| A-6.8 | The P4 PITR step also enables bucket soft-delete | A deleted artifact is unrecoverable | §6.7 |
| A-7.1 | Weeks are elapsed calendar weeks at ~1/3 of your working time, Claude Code typing | The calendar stretches proportionally | §7.1 |
| A-7.2, A-7.5 | `min_field_build` is armed at 163 at E0 and raised to the first build writing `roomIds` before any consumer relies on it | Stale devices sync, or omit room ids | §7.2, §7.5 |
| A-7.3 | `time_entries` UPDATE is gated to admin/office at E0; the board's hours editor is an office surface | A tech login editing hours is refused | §7.2 |
| A-7.4 | The P2 verify runs over three closed mitigation jobs you pick | Weaker evidence the findings are real | §7.4 |
| A-7.6, A-7.7 | `sov_schedules`/`sov_lines`/`draw_requests` land at P4 and the 8 construction jobs import; jobs closed before P4 do not | Draws stay blob-shaped; old AR history stays in the blob | §7.6 |
| A-7.8 | The `leads` table lands with the Leads tab at P5 | Lead screening slips with it | §7.7 |
| A-7.9 | Old-route traffic is a counter written to `events` | Cutover becomes a judgment call | §7.7 |
| A-7.10 | `billing.reconcile` reads stage from `coordination_jobs.data.stage` until the spine lands | Jobs selected wrongly if the board stage is stale | §7.13 |
| A-7.11 | A priced delta uses a rate already on the same invoice; never `price_list` | More findings arrive unpriced | §7.13 |
| A-7.12 | The sparse-reading fallback uses an owner-editable `dry_standards.typical_days` seeded from S500 | Predictions default to class ranges | §7.9 |

---

## Facts we could not verify from the repo

These came from live queries, the dashboard or your memory notes — not from files on `main`. Several gate E0.

1. **The Vercel project serving the portal.** `roybal-restoration-app-web` is the live portal at portal.roybalconstruction.com and must never be deleted; its build settings, environment variables and domain bindings live only in the Vercel console.
2. **The Cloudflare project serving the site.** `roybal-site-pages` is deployed by hand after every `apps/site` merge; whether the root `wrangler.jsonc` Worker was ever deployed, and what the apex points at before the Oct 11 registrar transfer, is console-only.
3. **The Supabase plan, compute tier and log retention.** The 1 GB Micro tier, whether branching and PITR are available, the edge wall clock, and how far back logs go all came from the dashboard.
4. **Which function secrets are actually set.** The quiet-hours secrets are recorded as unset, so code defaults rule; which of `GMAIL_*`, `QBO_*`, `QB_TIME_*`, `TWILIO_*`, `LLM_API_KEY`, `STT_API_KEY` are set, and whether any legacy JWT survived the 08-14 sunset, is not in the repo.
5. **Fly secrets and the deployed phone-agent image.** `fly.toml` is in the repo; the running image, its last deploy and the secrets on `roybal-phone` are not.
6. **Twilio console configuration.** No `StatusCallback` URL appears anywhere in the repo — verified by grep — so the 174 rows frozen at `queued` cannot be explained from files; messaging service, number, A2P registration, ConversationRelay and request-signature validation are console-only.
7. **License terms for the vendored libraries.** pdf.js and qrcode are vendored and their terms were not read; the Verisk constraint behind ADR-12 is a memory note, not a license text reviewed here.
8. **The live values behind `OWNER_CELL` and the alert recipients.** The code reads them (`supabase/functions/roybal-notify/index.ts:400`); the numbers are secrets, so the P1 allowlist cannot be confirmed from here.
9. **Whether `min_field_build` was ever armed.** `218_sync_rpcs_and_build_gate.sql:55` seeds it at 0 and a live read agreed on 2026-09-06, but it is app state and may have changed; E0 arms it at 163 [A-7.2].
