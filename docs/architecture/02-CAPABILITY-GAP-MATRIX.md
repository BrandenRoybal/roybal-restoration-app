# 02 — Capability-to-Data Gap Matrix (Phase 2b)

**Repo:** `main` @ `1e04694` (2026-09-05) · **Live project:** `djpgvcvhvgrzgaziruze`, read 2026-09-06 · **Companion documents:** [00-SYSTEM-INVENTORY.md](00-SYSTEM-INVENTORY.md) (the map), [01-ARCHITECTURE-REVIEW.md](01-ARCHITECTURE-REVIEW.md) (the assessment and verdict), [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) (what to build), [findings.json](findings.json) (machine-readable findings; the gap findings below carry ids `F-…` there).

**How to read this.** Each of the six target capabilities is decomposed into the data it needs. Every row says whether the current system captures that data at all, captures it in a structured form an agent can query, or captures it only as free text / positional JSON / pixels — with the table, column, or blob path where it lives today and a citation. Section 7 ranks the smallest set of schema and capture changes that unlock the most capabilities at once; section 8 answers the first-automation question directly. This matrix was produced by a dedicated analyst reading the live blob samples and the code, and its claims were cross-checked against the verified Phase 1 inventory.

**Basis:** `main` @ `1e04694`; live project `djpgvcvhvgrzgaziruze` read 2026-09-06. Citations are `path:line` from the repo root; **(live)** = read from production; **INFER** = reasoning, not reading. Code was read over docs throughout.

## 0. The short answer

Nearly everything the six capabilities need is *captured somewhere*; almost none of it is captured in a shape a program can compare. The unit of record is one JSONB blob per job (`field_projects.data`: 15 live jobs, avg 50 kB, 80 top-level keys (live)). Inside it, the four facts that unbilled-item and supplement detection turn on are stored as: moisture readings = positional string arrays whose location exists only as a numbered marker drawn in a PNG (live sample; `apps/field/js/model.js:338-340`); equipment = per-day count strings on psychrometric rows (`dehu:"2", am:"20", scrub:"1"` (live)) plus a free-text-typed unit table (`model.js:350-361`); invoice lines = `{id, room, desc, qty, unit, price}` with the AI's `code` optional and its `basis` (justification) rendered once and discarded (`model.js:420-422`; `apps/field/js/forms.js:1484-1488` vs `:1505`); scope changes = a free-text `description` with a checkbox index for the reason (live sample; `model.js:385-397`). Room is a free-text string in six places (`model.js:173,210,324,421,586,275`). No table or key anywhere names a claim, carrier, policy, submittal, carrier response, or rejection reason — a repo-wide grep for that vocabulary returns an estimate status enum (`apps/field/js/fincalc.js:15`), a change-order `approvalStatus` check (`apps/admin/js/finactions.js:237-239`) and UI copy. The era-0 tables that had the right shapes (`moisture_readings`, `equipment_logs`, `line_items`) hold 6/5/2 March-2026 rows and no live writer (live).

The narrower good news: the pure fact-builders (`apps/field/js/narrative.js:241-282`, `officeai.js:140-179`, `convert.js:169-184`, `completeness.js:205-231`, `dryingcalc.js:152-163`, `supabase/functions/qb-time-proxy/phasematch.ts:207-246`) already digest the blob into the structures a detector wants, and `time_entries` (1,193 rows (live)) is the one row-per-fact table in the operating model. A first automation can stand on those; a second cannot until the blob shapes below change.

**Status key.** *have* = typed rows/fields an agent can query without parsing prose or pixels; *partial* = captured as free text, positional JSON, per-map-not-per-location, or reachable only from a browser; *missing* = no capture path exists. "Where today" omits the `data.` prefix on blob paths.

## 1. Capability 1 — Carrier-ready documentation first time

Needs: a claim (number, carrier, adjuster-as-contact, policy/deductible, date of loss, loss type/cat/class); a per-carrier requirement profile; document identity (number, version, issued/locked); every line item with code, unit, qty, catalogue price and a justification that traces to evidence; equipment per unit; readings per location per date with material and goal; the psychrometric log; photos keyed to room and line; the drying certificate; a narrative; completeness rules; a record of what was submitted; a headless render.

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Claim number, carrier, adjuster | partial | `claimNo/carrier/adjuster` free text on the blob; projected to `unified_jobs.claim_number/insurance_carrier/adjuster_name` text | `model.js:137,142-143`; `apps/field/js/spine.js:23-40`; `supabase/migrations/200_ai_backbone.sql:87-91` |
| Adjuster as a contact linked to the claim | partial | `contacts.role='adjuster'` rows exist (backfilled), but `unified_jobs.contact_id` is the owner; no adjuster FK | `228_contacts.sql:54,549`; `200:84-109` |
| Carrier entity, per-carrier format/requirements | missing | absent | grep; `completeness.js:49-135` has one water-mit matrix, no carrier axis |
| Policy number / coverage / deductible | partial | `deductible` on each invoice instance only; no policy field | `model.js:398-415` |
| Document number / version / issued state | missing | `invoiceNo/coNo/certNo` hand-typed; admin counters `INV-${length+1}`; no version field | `forms.js:1862-1868`; `finactions.js:89,137,250`; `model.js:398-415` |
| Line item: code + unit + qty + catalogue price | partial | `{id,room,desc,qty,unit,price}`; `code/priced/flag` only after an AI draft; live sample has none | `model.js:420-422`; `forms.js:1484-1488`; (live) `invoices[0]` |
| Line item: justification traced to evidence | missing | `basis` rendered in a transient panel, not stored; audit `reason` dropped on "+ Add" | `roybal-ai-office/index.ts:385`; `forms.js:1505,1535` |
| Price catalogue keyed by code | have | `price_list(market,category,code)` 2,959 rows, replace/remove/detach_reset | `109_price_list.sql:10-24`; (live) |
| Equipment per unit: type, asset, location, placed, removed | partial | `dryingLogs[].equipment[]` free-text `type`, regex-classified; live rows carry counts, not units | `model.js:350-352`; `dryingcalc.js:152-163`; (live) |
| Readings per location per date, with material + goal | partial | `moistureMaps[].readings[{date,values[]}]`; location = column index ↔ marker pixels; material/goal per map, goal a string | `model.js:324,338-340`; `forms.js:284-289,306`; (live) |
| Psychrometric daily log (T/RH/GPP, GD) | have | `dryingLogs[].readings[]` structured; GPP computed | `model.js:353-361`; `apps/field/js/core.js:705-720` |
| Photos keyed to room and line item | partial | `photos[] {room,stage,caption,ai{}}`; room free text, often empty; no line/reading link | `model.js:209-211`; (live) `room:""` |
| Certificate of drying (per-material verification) | have | `certDrying.verification[{material,meter,goal,final,reference,dry}]`; material not linked to a map | `model.js:520-535` |
| Narrative | have | `narrative`, generated from `narrativeFacts` | `narrative.js:241-282` |
| Completeness rules | have | 29 pure JS rules; SQL seed diverged, unread | `completeness.js:49-135`; `200:246-318` |
| Equipment sizing justification (S500 worksheet) | have | `dryingLogs[].equipCalc` + `calcDeviation` | `narrative.js:140-163`; `dryingcalc.js:116-148` |
| Record of what was submitted, when, to whom, which version | missing | closest: `email_messages` outbound rows (no attachment list) and `photo_shares` links | `208_email_lane.sql:33-51`; `245_photo_shares.sql:19` |
| Headless render / one document pipeline | missing | `window.print()` on a live DOM; share link = DOM snapshot | `apps/field/js/app.js:1552,1936,2413`; `formkit.js:310-315`; `photoshare.js:154-174` |

**Verdict.** Packet *content* is mostly present and the completeness gate is real and pure. What is missing is what makes a packet defensible and repeatable — justification per line, per-location readings, per-unit equipment, document identity, and any record of submission — and no server can produce it.

## 2. Capability 2 — Unbilled-item detection

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Equipment placement/removal events → unit-days by type | partial | `equipment[] {asset,type,location,placed,removed,hours}` when filled; `unitDays` derived from placed/removed | `model.js:350-352`; `narrative.js:57-79` |
| Per-day equipment counts | have (strings) | `readings[].dehu/am/scrub` per psychro row | `model.js:353-361`; (live) |
| Reading dates per area (monitoring visits) | partial | count of dated rows per map | `narrative.js:42-55` |
| Time entries with service/task, hours, job link | have | `time_entries.data {date,hours,employee,service,task,note,qbJobcodeId,fieldProjectId,phaseId,phaseMatch}`; lane dead since 09-04 | `qb-time-proxy/index.ts:215-239`; (live) |
| Labor by trade / billing code | partial | `service` is a QB item string; phase via synonym match; no trade code | `phasematch.ts:207-246`; (live) sample |
| Materials consumed (item, qty, cost) | missing | `constructionLogs[].materials` free text; board `materials` = ordered/received enum | `model.js:363-371`; `apps/board/js/board.js:39-43` |
| Receipts / pass-throughs | partial | `receipts[] {vendor,amount,category,date}` (0 rows live); attachment AI totals | `model.js:195`; `finactions.js:295-303`; `narrative.js:168-203` |
| Photos as evidence for a line | partial | AI `damage[]/equipment[]/materials[]` tags, unconsumed | (live) `photos[0].ai`; `officeai.js:111-137` |
| Invoice lines with code/unit/qty | partial | as above; qty hand-typed (`"215"` air-mover days vs `am:"20"` per day) | (live) `invoices[0]` |
| Field-event → billable-code mapping | missing (as data) | prompt prose only | `roybal-ai-office/index.ts:540-541,648-652`; `docs/Estimating_Rules_Draft.md` |
| Invoice sent/submitted/paid state | partial | `INVOICE_STATUSES` written only by admin chips; `qboInvoiceId`; QBO push flattens every line to one item | `fincalc.js:16`; `finactions.js:167-227`; `apps/field/js/qbo.js:74-76`; `qbo-proxy/index.ts:316-321` |
| Already-billed dedupe across invoices | missing | none; audit prompt says "do not duplicate" | `index.ts:645` |

**Verdict.** Derivable today by deterministic rule per mitigation job: (a) Σ `dehu/am/scrub` over psychro rows = count-days by class vs invoice lines whose `desc` matches the class; (b) Σ `time_entries.hours` for the jobcode vs Σ `qty` of `unit='HR'` lines; (c) reading dates per map vs a monitoring line; (d) Cat 3 package presence when `waterCategory='3'`. Not derivable: materials/consumables (never captured), per-unit days (unit rows unfilled — INFER from the live sample, which carries counts and no unit rows), pass-throughs (0 receipts live), and whether a line was ever *sent*. `invoiceAudit` already does (a)–(d) non-deterministically (2 live calls (live)).

## 3. Capability 3 — Unforeseen-scope detection

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Original/approved scope, versioned, by room and code | partial | `reconEstimates[]` = invoice shape + `kind:"estimate"`; imported carrier estimate replaces items, `isPricingSource`; no approved snapshot | `model.js:435-440`; `forms.js:1580-1604`; `narrative.js:176` |
| Estimate approval state | partial | `ESTIMATE_STATUSES` incl. `rejected`, no reason/date/who | `fincalc.js:15`; `finactions.js:127-128` |
| Field observations (room, material, condition, date) | partial | photo `ai.damage[]`; map row `notes`; log `issues` free text; `demoNotes` digest | (live) `photos[0].ai`; `convert.js:158-167`; `model.js:363-371` |
| Room identity to join observation ↔ line ↔ photo | missing | six free-text spellings; case-drift comparator | `model.js:173,210,324,421,586,275`; `forms.js:2019-2024,2628` |
| Supplement entity (lines + justification + evidence + sent + response) | missing | change order = free text + blank items + reason checkbox index | `model.js:385-397,548-555`; (live) `changeOrders[0]` |
| Customer approval of a CO | have | `portal_jobs.approvals[] {id,title,description,amountDelta,status,signedName}` | `roybal-portal/index.ts:284-293,363-404`; `forms.js:3616-3640` |
| Carrier response / rejection reason | missing | `approvalStatus` pending/approved/rejected, no reason | `finactions.js:237-239` |
| Scope-diff engine | partial | audit prompt in reconEstimate mode only | `index.ts:646-647` |

**Verdict.** There is no original-scope object to diff against and no observation object to diff with; the only implementation is prose in a prompt.

## 4. Capability 4 — AI-proposed scheduling

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Crew member: skills, certs (with expiry), lead flag, team | missing | `crew_members.data` `role` free text, `bioCerts` one string | `board.js:2850-2857`; (live) Appendix C |
| Per-person capacity / shift | missing | one global `hoursPerDay` | `apps/board/js/schedule.js:14,56-67`; (live) settings row |
| Availability (PTO, out days) | partial | `outDays[]` on 5 of 11 members | (live) |
| Equipment inventory + where each unit is | missing | absent (per-job counts only) | grep; `model.js:350-361` |
| Job phases, dependencies, estimates | have | `subtasks[]`, `deps[] {predId,type:"FS",lagDays}`; phase names free text | (live) Appendix B; `board.js:2062-2067` |
| Required skill per phase | missing | absent | `board.js:2062-2067` |
| Drying-time prediction | missing | flags only (stale/stalled/7-day); portal excludes trend by design | `apps/field/js/dryingwatch.js:48-76`; `231_portal_drying.sql:8-14` |
| Travel / geocoded addresses | missing | address text only; no lat/lng in any DDL read (INFER) | `200:92` |
| Historical actuals for calibration | have | median actual/estimate, n≥5 gate; `phaseActuals` | `apps/field/js/calibration.js:46-63`; `schedule.js:131-157` |
| Schedule assignment entity + proposal/approval | partial | on the job blob (`crewIds`, `dayCrew`, `crewSpans`); dates = last browser's compute; approval only for `addPhase` | `schedule.js:438-441,462-468`; `board.js:226-255`; `roybal-notify/approve.ts:70-81` |
| Work calendar | have | settings row `{workDays,hoursPerDay,holidays}` | `apps/board/js/settingsync.js:25`; (live) |

**Verdict.** The engine is pure and tested but its inputs stop at "bodies × one shift". Skills, certs, equipment, travel and drying prediction have no home; the server has no schedule of its own.

## 5. Capability 5 — Communications

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Contacts with role | have | `contacts` (customer/adjuster/agent/pm/sub) | `228:51-70` |
| Adjuster ↔ claim link | partial | text triple on `unified_jobs`; no FK | `200:89-91` |
| Carrier entity | missing | text | `200:88` |
| Email thread linked to claim | partial | `email_messages {thread_id, direction in/out, job_id text, matched_by}`; matched by customer email / claim # in text / customer name; adjuster mail files only when the claim # appears; no attachments; lane dead since 09-01 | `208:33-51`; `gmail-proxy/emailmatch.ts:51-75`; (live) |
| SMS log | have | `sms_messages` (174/175 outbound frozen `queued`) | `106_sms_messages.sql:11-25`; (live) |
| Portal thread | have | `portal_messages` | `108_portal_messages.sql:22-27` |
| Phone calls (transcript) | partial | `capture_events.transcript`, 76 rows | `200:155`; (live) |
| One thread per claim across channels | partial | `contact_timeline` per contact; three direction enums; job refs uuid vs text | `229_contacts_link.sql:52`; `208:44`; `210:30` |
| Submittal + response + rejection reason (per-carrier learning) | missing | absent | grep |
| Draft → approve → send → audit | partial | `adjusterEmail` draft (9 live calls) → textarea → `gmailSend` chip → `email_messages` + `capture_events`; `pending_actions.emailSend` for brief reminders only | `index.ts:760-782`; `officeai.js:248`; `apps/admin/js/assistctx.js:194-220`; `roybal-brief/index.ts:249-299` |
| Templates / prompt versioning per carrier | missing | inline prompt, no prompt id in `ai_usage` | `201_ai_usage.sql:21-45` |

**Verdict.** Drafting and sending exist; nothing records that a packet was submitted, to whom, which version, or what came back — so learning has no substrate.

## 6. Capability 6 — Other office tasks and the backbone

| Data needed | Status | Where today | Evidence |
|---|---|---|---|
| Intake / scam screening | partial | honeypot, caps, untrusted-fill suggestions; leads with `channel/leadLog/outcome/lostReason` | `roybal-lead/index.ts:68-105,288`; `228:135-155`; (live) Appendix B |
| Collections (AR aging, dunning state) | partial | nightly QBO balance → `payments[]`; brief proposes reminders; no AR entity | `qbo-proxy/payments.ts:37-65`; `roybal-brief/index.ts:249-299` |
| QuickBooks sync | partial | invoice-out (one service item, no idempotency), balance-in, `contacts.qbo_customer_id` | `qbo-proxy/index.ts:316-321,345-356`; `228:62` |
| SOV draws | partial | `drawSchedule.rows[]` in blob; `lender` text | `forms.js:3220-3298` |
| Reporting | partial | client-side ≤500 jobs / ≤5,000 entries; CFO snapshot in engine | `apps/admin/js/analytics.js:51,58-66`; `schedule.js:790-872` |
| Permissions read/propose/approve/execute per role | missing | `using(true)` on every operating table; `user_role` used by `field_photos` + 3 RPC guards | `100_field_projects.sql:44-46`; `101:46-48`; `200:229-240` |
| Proposal → approval → execution record | partial | `pending_actions` (3 kinds, one phone-number approver, no approver column, mutable row); chips execute client-side | `210:24-38`; `roybal-notify/index.ts:400-401`; `apps/field/js/assist.js:179-223` |
| Event log / audit trail | partial | `capture_events` (ingest + audit + rate-limit state), `blob_history` pre-images, `updated_by`; no per-field events | `200:148-164`; `215_blob_history.sql:53-70` |
| Job / queue for background work | missing | pg_cron + pg_net; failures invisible | (live) 288 "succeeded" runs of two dead jobs |
| Typed, validated operations as LLM tools | partial | 11 read/phone tools JSON-schema; 17 write actions prose | `roybal-ai-office/personas.ts:78-146,166-221,246-362` |
| Integration abstraction | missing | `{action}` string per function, four auth conventions | `qbo-proxy/index.ts:252-456` |
| Observability of automation | partial | `ai_usage` cost per call, no prompt id; 0 `console.*` in AI functions; two dead lanes unalerted | `201:21-45`; (live) |

## 7. Smallest unlock set (ranked by capabilities-per-effort)

1. **Persist the line's code and justification (S).** Change `blankLineItem` to `{id, roomId?, room, desc, qty, unit, price, category, code, priceBasis, basis, evidence[]}` and stop dropping `basis`/`reason` at `forms.js:1484-1488,1535`. Unlocks 1, 2, 3 at once; every drafted line already arrives with these fields (`index.ts:378-391`).
2. **Claim + submittal + carrier-response spine (M).** Add `carriers`, `submittals(job, kind, document_id, version_hash, sent_at, to_contact_id, channel, message_ref)`, `carrier_responses(submittal_id, kind, reason_code, amount, at, source_email_id)`; put `carrier_id`, `adjuster_contact_id`, `policy_number`, `deductible` on `unified_jobs` (or promote it to `claims`). Rows get written at moments that already exist in code — `gmailSend`, `pushInvoice`, `publishPacketShare`, `photo_shares`. Unlocks 1, 3, 5, 6.
3. **Equipment identity (S, corrected 2026-09-07 from M).** The events already exist — 116 per-unit rows over 7 jobs, 113 complete (live). What is missing is identity: enum the type, make asset tags **unique per fleet class** (asset `101` is currently three air movers and one dehumidifier, because each job's fill-drag regenerates the same sequence), and bind `location` to a room id so per-unit days can be derived from placements. The fill handle at `forms.js:650-680` already makes the per-unit path fast, and it is also **the source of the collisions**: dragging it down the asset column does not copy the value, it *auto-increments* it (`bumpAsset`, `forms.js:643-647`). So a crew that drags from `101` gets `101`-`110` on every job, independently. Those numbers look like fleet asset tags and are really just row indexes — which is worse than blank, because a carrier auditing them finds the same `101`-`110` on file after file. Fix the tags before showing them to anyone. Unlocks 2, 1, 4.
4. **Room entity (M).** `rooms[] → [{id, name, level, floorSF?, perimLF?}]`, every `room` string → `roomId` (six write sites + `merge.js` union-by-value at `:180-185` + SQL twin at `243:100-125`). Unlocks 1, 2, 3.
5. **Readings per location (M).** `readings[{date, cells:[{loc, value}]}]` plus per-map `locations:[{n, label, material, goal}]`. Unlocks 1, 2, 4.
6. **A read model over the blob (M) — option, not a pick.** (a) *Projection*: server-side tables `job_line_items`, `job_equipment`, `job_readings`, `job_labor` maintained by the `project_field_photos`-style trigger (`224:195-219`) — no capture change, holds while the blob stays the write model; or (b) *Normalize*: move those four collections into real tables and have the blob reference ids — larger, but removes the JS↔SQL merge twin (`merge.js:32-36` ↔ `241:193-280`) for those keys. Either unlocks every "detect" capability; (a) is operable by a solo owner this month, (b) is the 100-person shape.
7. **One approval spine (M).** Add `approver_id`, `unique(code) where status='pending'`, an append-only `pending_action_events`, an in-app approve RPC; route chips through it; add a `kind` per detector (`invoiceLineAdd`, `supplementDraft`, `scheduleChange`). Unlocks all six as *automations* rather than features.
8. **Crew and equipment structure (S/M).** `certs[{code,expires}]`, `skills[]`, `hoursPerDay`, `teamId`, `isLead` on `crew_members`; an `equipment_units` table. Unlocks 4.

## 8. First-automation verdict

The owner's instinct — unbilled-item detection on mitigation jobs — is supported **today for a narrow, rule-based v0** and **not** as the "pure margin from data that already exists" it is hoped to be. What is computable now from the blob plus `time_entries`: equipment count-days by class (psychro rows), labor hours vs `HR` lines, monitoring visits vs a monitoring line, and Cat 3 package presence — matched to invoice lines by regex over `desc` because no line carries a code (live sample). What is not computable: materials and consumables (no capture at all), per-unit equipment days (unit rows unfilled — INFER), pass-throughs (0 receipts), whether the invoice was actually submitted (no submittal), and anything on the seven jobs whose drying logs lack a row per drying day (live sample has 07-31 and 08-03 only). Two prerequisites are dead right now: the QB Time lane (refresh token invalid since 09-04 (live)) and the approval spine (three zombie `pending_actions` rows block every new proposal (live)).

Cheapest path to a trustworthy version: unlock #1 (persist code/basis, one JS change), reconnect QB Time, and write the detector as a pure module in the `completeness.js` style — `unbilled.js(project, entries, invoice) → [{class, documented, billed, delta, evidence[]}]` — run server-side by cron over the 15 blobs and landed as a `pending_actions` row of a new kind. That is one week of work and it exercises propose→approve→execute→record for real. Its ceiling is low until #3–#5 land.

The alternative that proves the backbone faster is **adjuster-email drafting plus the submittal record** (#2): drafting exists (9 live calls), sending exists (`gmailSend` → `email_messages`), `pending_actions.emailSend` exists, and the only new data is the `submittals` row — which is also the datum that capabilities 1, 3 and 5 are blocked on. It touches money later than unbilled detection but creates the first learning substrate. Carrier-packet QA proves nothing new (the gate already runs in-app); scope-change from change-order text is too thin (2 COs live, both free text). Recommendation, with the trade shown: start with the unbilled v0 *if* the owner will accept regex-grade output as a proposal queue; start with adjuster-email + submittals if the goal is to make the next five automations cheaper.

## 9. Findings (data-model gaps that block capabilities)

These are "the most important kind" of finding in the owner's framing: places where the data model lacks a first-class concept or buries it in JSON or free text. Each appears in `findings.json` with a stable id, a recommendation, and the roadmap phase that fixes it.

| # → findings.json id | Severity | Finding | Growth ceiling | Automation | Fix (unlock) |
|---|---|---|---|---|---|
| G-1 → F-002 | Critical | No claim, carrier, submittal, carrier-response or rejection entity exists; carrier and adjuster are strings on the job | yes | blocks | Add carriers, submittals and carrier_responses tables and FK unified_jobs to carrier and adjuster contact (unlock #2); write submittal rows from the four existing send moments. |
| G-2 → F-017 | High | Invoice line item is {room, desc, qty, unit, price}; the AI's code and justification are discarded on apply | no | blocks | Unlock #1: persist category/code/priceBasis/basis/evidence on the line; add a line_items projection or view. |
| G-3 → F-014 | High | Per-unit equipment rows exist and are filled (116 rows / 7 jobs, 113 complete) but the asset number is freehand and collides across fleet classes | no | partial | Unlock #3: equipment events with enum type, asset id, location, placed/removed; derive counts from events. |
| G-4 → F-014 | High | Moisture readings are positional string arrays; the location exists only as pixels; material and dry goal are per map, not per location | yes | blocks | Unlock #5: per-map locations with material/goal and readings keyed by location. |
| G-5 → F-014 | High | Room/area is free text in six independent places with no shared identity | yes | blocks | Unlock #4: room entity with ids; roomId on every child; migration shim mapping legacy strings. |
| G-6 → F-018 | High | Materials consumed are never captured; receipts are empty; QBO sees one service item | no | blocks | Add a materials/consumables capture (voice-friendly: item, qty, unit, receipt ref) on the daily log and map lines to QBO items by category. |
| G-7 → F-044 | Medium | Scope changes are free-text change orders with a checkbox-index reason and no lineage to an original line or a carrier decision | no | blocks | Snapshot the approved estimate as a versioned document; model supplements as coded lines with justification, evidence refs and a carrier_responses link. |
| G-8 → F-015 | Medium | Crew has no skills, certs, capacity or teams; equipment inventory is absent; drying prediction has no inputs; the schedule is browser-computed | yes | blocks | Unlock #8 (structured certs/skills/capacity, equipment_units) and a server-side schedule run with a proposal kind. |
| G-9 → F-043 | Medium | Correspondence is three tables with three direction enums and two job-reference types, filed to jobs by heuristics | no | blocks | One correspondence table (or view) keyed by claim/submittal with a shared direction enum and uuid refs; file adjuster mail by adjuster contact, not claim regex. |
| G-10 → F-006 | Medium | Detector output has no trustworthy landing zone: two disjoint approval systems, no approver identity, and three zombie rows blocking proposals | no | blocks | Unlock #7: extend pending_actions (approver_id, unique pending code, append-only events, in-app approve RPC) and route chips through it; sweep expired rows. |

### G-1 (F-002) — No claim, carrier, submittal, carrier-response or rejection entity exists; carrier and adjuster are strings on the job

**Severity:** Critical · **Growth ceiling:** yes · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:137,142-143 (claimNo/carrier/adjuster free text) · supabase/migrations/200_ai_backbone.sql:87-91 (unified_jobs text columns, no FK) · supabase/migrations/228_contacts.sql:54,549 (contacts.role='adjuster' exists, but unified_jobs.contact_id is the owner) · repo-wide grep submittal|rejection|carrier_response → only apps/field/js/fincalc.js:15 and apps/admin/js/finactions.js:237-239 · supabase/migrations/208_email_lane.sql:33-51 (outbound email is the closest record of a submission; no attachment list, job_id text)

**Why it matters:** Capabilities 1, 3 and 5 all reduce to 'what did we send, to whom, which version, and what came back'; none of that has a row. Per-carrier learning, supplement tracking and first-submission defensibility cannot be built on strings that the email matcher has to rediscover by claim-number regex (gmail-proxy/emailmatch.ts:51-75).

**Recommendation:** Add carriers, submittals and carrier_responses tables and FK unified_jobs to carrier and adjuster contact (unlock #2); write submittal rows from the four existing send moments.

### G-2 (F-017) — Invoice line item is {room, desc, qty, unit, price}; the AI's code and justification are discarded on apply

**Severity:** High · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:420-422 (blankLineItem) · apps/field/js/forms.js:1484-1488 (stores code/priced/flag only) vs :1505 (basis rendered) and :1535 (audit reason dropped) · supabase/functions/roybal-ai-office/index.ts:378-391 (draft schema requires basis, category, code, priceBasis) · (live) invoices[0]: no code, qty 215 typed

**Why it matters:** Unbilled detection needs a coded billed side; supplement defense needs the basis; QBO push flattens every line to one item (qbo-proxy/index.ts:316-321) so the accounting copy cannot recover it either. The model already produces the fields; the app throws them away.

**Recommendation:** Unlock #1: persist category/code/priceBasis/basis/evidence on the line; add a line_items projection or view.

### G-3 (F-014) — Per-unit equipment rows exist and are filled, but the asset number is freehand and collides across fleet classes

**Severity:** High · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:350-361 (blankEquipRow type free text; blankPsychroRow dehu/am/scrub) · apps/field/js/dryingcalc.js:152-163 (type classified by regex) · apps/field/js/model.js:330 (equipmentPlan icons not linked to rows) · (live) dryingLogs[0]: dehu:"2", am:"20", scrub:"1", no unit rows — **but this single sample misled the original finding**

**Why it matters:** Unit-days by type — the largest mitigation billing class — cannot be reconstructed from placements, only estimated from whichever days a crew filled a psychro row; the 7-day justification and equipment availability for scheduling have the same hole.

**CORRECTED 2026-09-07 (whole-table live read).** The sampled job had no unit rows; most jobs do. Across all jobs `dryingLogs[].equipment[]` holds **116 rows over 7 jobs, 113 of them complete** with asset, type, location, placed, removed and hours. Unit-days *can* be reconstructed from placements today — the crew is already recording them. The blocker is narrower: the asset number is freehand and **collides across fleet classes** (asset `101` is an air mover on three jobs and a `Dehumidifier Dry-Eaze Xi7000` on a fourth; assets `102`-`110` each span three jobs under three spellings of one type), `location` is free text with no link to `rooms[]`, and there is no serial number. So this gap is **partial, not missing**, and the unlock is cheaper than stated below: enum the type, make asset tags unique per fleet class, bind `location` to a room id. No new crew behaviour is required. The crew SOP that tightens this is [05-CREW-CAPTURE-SOP.md](05-CREW-CAPTURE-SOP.md).

**Recommendation:** Unlock #3: equipment events with enum type, asset id, location, placed/removed; derive counts from events.

### G-4 (F-014) — Moisture readings are positional string arrays; the location exists only as pixels; material and dry goal are per map, not per location

**Severity:** High · **Growth ceiling:** yes · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:338-340 (values: Array(13).fill("")) · apps/field/js/forms.js:284-289,306 (goal parsed by regex; 13-column blocks) · (live) moistureMaps[0]: 52 positional strings; label 'Drywall' vs material 'Framing / Wood / Subfloor' with one goal

**Why it matters:** A carrier audits dry-standard achievement per material per location; the app cannot state it, the certificate's verification rows are re-typed strings (model.js:520-535), and no drying predictor can be trained on column indexes.

**Recommendation:** Unlock #5: per-map locations with material/goal and readings keyed by location.

### G-5 (F-014) — Room/area is free text in six independent places with no shared identity

**Severity:** High · **Growth ceiling:** yes · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:173,210,324,421,586,275 · apps/field/js/forms.js:2019-2024 (case-drift comparator), 2628 (plan dimensions rooms) · apps/field/js/merge.js:180-185 and supabase/migrations/243_losstypes_merge_union.sql:100-125 (rooms unioned by string value)

**Why it matters:** Photos, readings, line items, scope areas, contents and plan dimensions cannot be joined; 'what was billed for the kitchen' and 'which observation is not in the scope' are unanswerable, which is the join every detection capability needs.

**Recommendation:** Unlock #4: room entity with ids; roomId on every child; migration shim mapping legacy strings.

### G-6 (F-018) — Materials consumed are never captured; receipts are empty; QBO sees one service item

**Severity:** High · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:363-371 (constructionLogs materials free text) and (live) materials:"" · apps/board/js/board.js:39-43 (board 'materials' = ordered/received status only) · apps/field/js/model.js:195 and (live) receipts 0 rows · supabase/functions/qbo-proxy/index.ts:316-321 (every line ItemRef = one item)

**Why it matters:** An entire billing class is invisible to unbilled detection and to QBO category reporting; the only material data in the system is the price catalogue's unit prices.

**Recommendation:** Add a materials/consumables capture (voice-friendly: item, qty, unit, receipt ref) on the daily log and map lines to QBO items by category.

### G-7 (F-044) — Scope changes are free-text change orders with a checkbox-index reason and no lineage to an original line or a carrier decision

**Severity:** Medium · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** apps/field/js/model.js:385-397 (newChangeOrder), 548-555 (CHANGE_REASONS incl. 'Carrier Supplement / Insurance-Approved') · (live) changeOrders[0]: items blank, coNo blank, reasons {"4":true}, five-paragraph description · apps/admin/js/finactions.js:237-239 (approvalStatus without reason/date) · apps/field/js/model.js:435-440 (reconEstimate = invoice shape, no approved snapshot)

**Why it matters:** Unforeseen-scope detection needs an approved scope to diff against and a supplement to write into; today both are prose and the only diff engine is a prompt (roybal-ai-office/index.ts:646-647).

**Recommendation:** Snapshot the approved estimate as a versioned document; model supplements as coded lines with justification, evidence refs and a carrier_responses link.

### G-8 (F-015) — Crew has no skills, certs, capacity or teams; equipment inventory is absent; drying prediction has no inputs; the schedule is browser-computed

**Severity:** Medium · **Growth ceiling:** yes · **Automation impact:** blocks

**Evidence:** apps/board/js/board.js:2850-2857 and (live) crew_members keys (role free text, bioCerts one string) · apps/board/js/schedule.js:14,56-67 (one global hoursPerDay) · apps/field/js/dryingwatch.js:48-76 (flags only); supabase/migrations/231_portal_drying.sql:8-14 (trend excluded by design) · apps/board/js/board.js:226-255 (dates persisted by the client)

**Why it matters:** 'Who is WRT-certified and free Thursday with a dehu available' is unanswerable; the engine's outputs are whatever tab saved last, so an agent cannot ask the server for a schedule or propose against one.

**Recommendation:** Unlock #8 (structured certs/skills/capacity, equipment_units) and a server-side schedule run with a proposal kind.

### G-9 (F-043) — Correspondence is three tables with three direction enums and two job-reference types, filed to jobs by heuristics

**Severity:** Medium · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** supabase/migrations/106_sms_messages.sql:14 ('outbound'/'inbound') vs 208_email_lane.sql:37 and 108_portal_messages.sql:25 ('in'/'out') · supabase/migrations/208_email_lane.sql:44 and 210_pending_actions.sql:30 (job_id text) vs 107_portal_jobs.sql:26 (uuid) · supabase/functions/gmail-proxy/emailmatch.ts:51-75 (adjuster mail files only when the claim # appears in text) · (live) Gmail lane dead since 09-01; 174/175 SMS frozen 'queued'

**Why it matters:** A per-claim thread an agent can read must be assembled by normalizing three enums and two id types, and adjuster mail without the claim number never enters the system at all.

**Recommendation:** One correspondence table (or view) keyed by claim/submittal with a shared direction enum and uuid refs; file adjuster mail by adjuster contact, not claim regex.

### G-10 (F-006) — Detector output has no trustworthy landing zone: two disjoint approval systems, no approver identity, and three zombie rows blocking proposals

**Severity:** Medium · **Growth ceiling:** no · **Automation impact:** blocks

**Evidence:** supabase/migrations/210_pending_actions.sql:24-38 (no approver column; code int without unique) · supabase/functions/roybal-notify/index.ts:400-401 (single OWNER_CELL approver) · apps/field/js/assist.js:179-223 (chips execute client-side, audit best-effort) · (live) 3 boardEdit rows pending since 2026-07-25 vs MAX_LIVE_PROPOSALS=3 at qb-time-proxy/index.ts:285,494-499

**Why it matters:** Every capability above ends in 'propose a line / a supplement / a schedule / an email'; without one spine with an approver on the record, automation output is either executed by whoever holds a browser tab or silently blocked.

**Recommendation:** Unlock #7: extend pending_actions (approver_id, unique pending code, append-only events, in-app approve RPC) and route chips through it; sweep expired rows.

