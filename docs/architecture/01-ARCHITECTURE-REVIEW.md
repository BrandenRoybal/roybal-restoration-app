# 01 — Architecture Review (Phases 2 and 3)

**Repo:** `main` @ `1e04694` (2026-09-05) · **Live project:** `djpgvcvhvgrzgaziruze`, read 2026-09-06 · **Companions:** [00-SYSTEM-INVENTORY.md](00-SYSTEM-INVENTORY.md) · [02-CAPABILITY-GAP-MATRIX.md](02-CAPABILITY-GAP-MATRIX.md) · [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) · [04-OPEN-QUESTIONS.md](04-OPEN-QUESTIONS.md) · [findings.json](findings.json)

**Method.** Twelve dimension assessors each wrote one section of Part II from the verified Phase 1 evidence and the live database; an independent verifier re-opened every cited line in each section and calibrated every finding's severity (ten sections verified in the first pass, the remaining two in a second pass after a usage-limit interruption; every verifier rated its section reliable or mostly reliable, and every correction they raised has been applied to the text below). Three independent judges — a business-owner/CFO lens, a platform-architect lens, and an applied-AI lens — then answered the Phase 3 questions separately. They agreed on the grade and on the path. Part III is the reviewer's synthesis of their verdicts. Citations are `path:line` at `main@1e04694`; "(live)" marks a fact read from production.

---

## Part I — Executive summary (five minutes, for the owner)

**Grade: D+.** This is a collection of features, not an architectural framework. Three judges, three lenses, one grade. The plus sign is earned by two islands of real engineering: the field app's offline sync engine (a server-authoritative merge with tombstones, content-addressed media, and a fake-server test harness that survived four data-loss incidents) and a set of pure, tested calculation engines (scheduling, drying-equipment sizing, the invoice totals ladder, the completeness gate, phase matching). Everything around those islands accreted: each of four eras was added beside the last and nothing was retired.

**The rebuild recommendation, in one sentence:** do a strangler rebuild of the backend, not the app — build a typed Postgres backbone (claims, submittals, documents, proposals, events, a job queue) with one operations door and one headless document pipeline inside the same Supabase project, keep the field app's sync engine and pure engines verbatim, and move the office screens and the documents onto the backbone one module at a time while crews never notice. A clean-sheet rewrite was rejected: the data is small enough to migrate in an afternoon, but the behaviour that matters (offline sync, 22 carrier-facing forms, print rules learned from adjuster pushback) is not, and this repository already carries the scars of one rewrite. Evolve-in-place was rejected as the primary path because the two things that must change — a JSON blob as the system of record and a browser tab as the only place business logic executes — cannot be evolved into a headless backbone without building a parallel structure anyway.

**What the app is today, in plain language.** The field app, the office admin and the job board are one program in three folders that share code by a path trick only the deploy makes work. Every job is one JSON document (the blob) that the crew's phone and the server merge; the normalized tables that carry the insurance vocabulary you asked about exist but are empty leftovers from the deleted React app. The AI features are real and disciplined (every suggestion is a chip a human taps), but the tap runs in the browser, so no agent, cron, or worker can execute anything except three kinds of action approved by a text message from one phone number. Documents are the screen: printing the page is the document pipeline. Any signed-in user, including the AI machine accounts, can read and rewrite about eighteen tables, including the AI cost ledger and the audit log.

**Top risks (ranked).**

1. **Paying twice.** Twelve more months on this shape means twelve months of features built in the blob and in browser executors that all have to be redone when a backbone arrives, while the data the north star needs (line-item justification, per-location readings, equipment placement events, submittal records) is discarded on every job.
2. **Two production exposures, open today.** The publishable key served on the public site reaches ungated proxy actions that create QuickBooks invoices, dump timesheets, and disconnect the OAuth lanes. Any crew login can delete the AI cost ledger, the audit trail, and payroll hours over plain REST.
3. **Silent failure is the default.** Gmail sync has been dead since 2026-09-01 and QuickBooks Time since 2026-09-04; cron reports success, the admin card shows green, three expired proposals have blocked all board-phase proposals since 2026-07-26, and the main branch fails its own test suite while deployed. Nothing alerts anyone.
4. **The org model cannot hold a second office hire.** New accounts default to full crew-level write on everything, there is no `office` profile in production, approval authority is one phone number, crews have no leads, skills, or certifications, and a second division, calendar, mailbox, or QuickBooks company is a code change.
5. **Copy discipline as architecture.** The scheduling engine exists three times, the job merge exists in JavaScript and in SQL and must stay byte-equivalent by hand, and the migration directory cannot rebuild the database — so the first AI-authored change that forgets a copy silently corrupts a merge or a schedule, and no CI catches it.

**Top recommendations (ranked).**

1. **Week one, regardless of anything else:** gate the four proxy actions on a real caller, make the ledgers insert-only, sweep the zombie proposals, reconnect Gmail and QuickBooks Time with an alert on refresh failure, delete the two Magicplan functions, fix the build-tag drift, and add a pull-request workflow that runs every test suite.
2. **Build the backbone as the next feature, not after it:** proposals, events, a job queue, and an operations registry in Postgres; persist the line-item code and justification the AI already produces; add the submittal record. This is the thin first slice of the strangler and it ships in weeks, not months.
3. **Ship unbilled-item detection on mitigation jobs as the first new capability, honestly scoped:** a deterministic, zero-AI reconciliation of per-day equipment counts, logged hours, and monitoring visits against invoice lines, landing as proposals the office approves. It is an internal leak detector, not carrier-grade justification, until equipment placement events exist — and it is the first thing that exercises propose → approve → execute → record end to end.

**Which capability to build first:** unbilled-item detection (your instinct), as the first backbone slice rather than as another chip, with the submittal record bundled in because "was this invoice already sent" is one of its inputs. The alternative — adjuster-email drafting plus the submittal record — proves the backbone slightly faster because its execute leg already exists server-side; the roadmap in 03 uses it as the smoke test in the weeks before the detector ships.

**The one open question that matters most:** whether you are willing to change the crew's capture shape this year (room identity, per-location readings, equipment as placement events). Everything in capabilities 1 through 3 above "internal leak detector" quality depends on it, it is the only change crews will feel, and it decides whether the first automation stays a v0 or becomes carrier-grade. See [04-OPEN-QUESTIONS.md](04-OPEN-QUESTIONS.md), group A.

---

## Part II — Dimension assessments (Phase 2)

Each section below answers the same five questions for one dimension: what the pattern is today, how many patterns coexist (the Frankenstein question), the evidence, the severity and why, and what cohesive would look like — followed by what in that dimension is worth preserving. Findings are consolidated across dimensions in [findings.json](findings.json); the counts here are per-section before de-duplication. "Coexisting patterns" is the assessor's count of distinct ways the same concern is implemented today.

| # | Dimension | Coexisting patterns | Section severity | Findings | Verified |
|---|---|---|---|---|---|
| 1 | System boundaries and module structure | 7 | Critical | 10 | mostly_reliable (9/10 kept as written) |
| 2 | Data model | 7 | Critical | 12 | mostly_reliable (10/12 kept as written) |
| 3, 6 | Data access layer · State management and data fetching | 20 | High | 11 | mostly_reliable (11/11 kept as written) |
| 4 | Auth and authorization | 10 | Critical | 10 | mostly_reliable (9/10 kept as written) |
| 5 | Business logic placement | 10 | High | 10 | mostly_reliable (9/10 kept as written) |
| 7, 8 | UI and component system · Documents and the PDF/print pipeline | 6 | High | 10 | mostly_reliable (6/10 kept as written) |
| 9, 10 | Offline and sync · File and photo storage | 7 | High | 10 | mostly_reliable (8/10 kept as written) |
| 11, 12 | Integrations · Error handling, logging, observability | 11 | Critical | 11 | mostly_reliable (10/11 kept as written) |
| 13, 14 | Type safety, testing, CI · Dependencies and tooling health | 7 | High | 9 | mostly_reliable (5/9 kept as written) |
| 15 | Performance and scalability (two horizons) · organizational scalability | 8 | High | 10 | mostly_reliable (9/10 kept as written) |
| 16 | AI-maintainability | 5 | High | 9 | mostly_reliable (6/9 kept as written) |
| 17 | AI-operability and automation readiness | 6 | Critical | 10 | mostly_reliable (6/10 kept as written) |

---

## 1. System boundaries and module structure

### What the pattern is today

**One product wearing three directories, three real satellites, and a backend of fourteen hand-copied functions.** READ: `apps/field`, `apps/admin` and `apps/board` are not three apps. Admin and board contain 56 static `import … from "../../js/*.js"` lines across 16 files pointing into the field app's `js/` directory (`apps/admin/js/admin.js:8-11`; `apps/board/js/data.js:13-14`; counted over `apps/admin/js apps/board/js`), and the field app imports back the other way (`apps/field/js/myweekcalc.js:17-18` → `../../board/js/schedule.js`). None of those paths exist in the repo tree. They resolve only because the deploy copies the three directories to `/`, `/admin`, `/board` on one origin (`.github/workflows/deploy-field.yml:36-38`), each `serve.mjs` fakes the same layout locally (`apps/admin/serve.mjs:2-5,11-12`; `apps/field/serve.mjs:30-34`), and the field service worker at scope `/` precaches board files (`apps/field/sw.js:27`). The admin boots the field sync engine and reads jobs out of the field app's IndexedDB (`apps/admin/js/admin.js:34,235`); the board signs in through the field's `signIn` (`apps/board/js/data.js:14`). One deploy unit, one auth, one data layer, one service worker, three entry points.

The genuinely separate deployables are `apps/portal` (talks only to the `roybal-portal` gateway, `apps/portal/js/portal.js:31`), `apps/site` (no cross-directory import in `apps/site/src`) and `services/phone-agent`. But the portal is separate by *copy* (`apps/portal/js/zip.js:3-5`: "VERBATIM COPY … keep the two files identical") and the phone agent by *Docker COPY* (`services/phone-agent/Dockerfile:8-9`).

**Is there a shared domain layer? No.** `package.json:5-8` declares workspaces for field, board and site and shares nothing between them; `packages/shared` died with the React line (`4fef103`, 2026-08-13) and its lockfile ghosts remain (`package-lock.json:31,79,7434`). What replaced it is `apps/field/js` acting as an undeclared library. The domain — what an invoice is, what a stage is, how a job merges, which hours count — is not in anything importable headlessly. It is in (a) factory functions (`apps/field/js/model.js:398-415`, `newInvoice`), (b) renderer closures that bind data, push to QuickBooks, run AI and paint print-only nodes in one 525-line function (`apps/field/js/forms.js:1378-1902`), (c) browser executors (`apps/admin/js/finactions.js:121-161`; `apps/board/js/actions.js`), (d) a plpgsql twin of the JS merge (`supabase/migrations/241_merge_delete_tombstones.sql:37-190`), and (e) 14 edge functions with no `_shared/` (`ls supabase/functions` shows none). Each surface re-implements its slice: the two `assistctx.js` files share a provider seam and eight non-blank lines (`apps/admin/js/assistctx.js:295-309` vs `apps/board/js/assistctx.js:103-117`); the admin alone carries two job matchers (`assistctx.js:141-153` vs `finactions.js:27-44`); `board.js:139-152` re-implements the hours join that `schedule.js:159-162` calls "THE one join rule".

**North-star judgment.** An agent can *read* today (any authenticated JWT reads every blob, but must walk JSON) and can *propose* (chips from `roybal-ai-office`; three kinds via `pending_actions`). *Execution lives in browser tabs.* `roybal-ai-office/index.ts:1570-1578` hands proposals back with the note "each runs only if the user taps it"; `apps/field/js/assist.js:179-193` runs `provider.executeAction` synchronously in the page; financial writes land in IndexedDB and ride the sync engine later (`apps/admin/js/finactions.js:109,152,218,271,303`). The server executes only `emailSend`/`sendText`/`boardEdit` through `pending_actions` (`roybal-notify/index.ts:396-525`), and no client shows that queue (`grep pending_actions apps/` → 0, contradicting `210_pending_actions.sql:17-18`) — (live) the table holds 3 rows, all `pending` since 2026-07-25 (expired 07-26), which cap new proposals (`MAX_LIVE_PROPOSALS=3`): the server spine is not just unshown, it is jammed. The schedule has no server authority — dates on disk are whatever the last browser computed (`apps/board/js/board.js:226-255`). Campaigns are a `for` loop behind `confirm()` (`apps/admin/js/campaigns.js:211,217-232`). Documents are `window.print()` over a live DOM (`apps/field/js/app.js:1552,1936,2413`). The logic an agent needs is in screens it cannot reach. The exceptions prove the headless pattern already works here: `schedule.js` is consumed by four runtimes, and `push_project` is the intended single write door (`241:193-280`) — already bypassed by one service-role writer (`qbo-proxy/index.ts:427-441`, stop 10 below); (live) `UPDATE field_projects (PATCH)` shows 8,027 calls, unexplained until it is confirmed whether that is `push_project`'s internal UPDATE or another direct writer.

### How many patterns coexist (the Frankenstein question)

Seven code-sharing mechanisms are live at once; none is a package.

| # | Mechanism | Where (READ) | Guard |
|---|---|---|---|
| 1 | npm workspaces that share no code | `package.json:5-8` (admin, portal have no manifest) | — |
| 2 | Relative URL imports across app dirs, resolved by deploy layout | 56 lines / 16 files admin+board→field; field→board `myweekcalc.js:17-18`; `deploy-field.yml:36-38`; `sw.js:27` | none |
| 3 | Docker `COPY` into a Fly image + Node strip-types import of a Deno `.ts` | `services/phone-agent/Dockerfile:8-9`; `server.mjs:30`; `tools.mjs:17` | none |
| 4 | Byte-identical committed copy with a drift test | `apps/board/js/schedule.js` ≡ `roybal-brief/schedule.js` (md5 `23189e1e…`, verified); `crewdigest.test.mjs:18-23` | test exists; CI never runs it |
| 5 | Functionally identical copy, already textually drifted, no guard | `apps/portal/js/zip.js:3-5` (md5 differs from `apps/field/js/zip.js`; only the header comment diverges); `apps/portal/js/config.js:5-6` = `apps/field/js/config.js:7-8`; portal helper trio (`portal.js:10-39`, `packet.js:13-41`, `photos.js:14-42`) | none |
| 6 | SQL re-implementation of JS logic | `merge.js:32-36` ↔ `217:115`, `241:41,170`, `243:17`; `merge.js:142-214` ↔ `merge_project_blobs` (defined 3×); `completeness.js:49-135` ↔ `200:279-315` | comments; no test reads `.sql` |
| 7 | Hand-mirrored constants with "keep in sync" comments | stage list ×7 files; settings uuid ×7 (`settingsync.js`, `boardpush.js`, `myweek.js`, `tools.mjs`, ai-office, brief, portal); quiet hours ×5; `LLM_PRICES` ×4 in functions + `roybal-web-agent/guards.ts` `PRICES` (which prices claude-sonnet-5/opus-5 at $15/$75 while the others price sonnet-4-6/opus-4-8 — already drifted) + `services/phone-agent/config.mjs:55-58`; totals ladder ×3 (`fincalc.js:27-38`, `digest.ts:16-24`, `formkit.js:240-248`); rev-guard idiom ×4 + shallow RPC (`246:26-34`); CORS ×11; cron-secret ×6 | comments |

Mechanism 3 has already failed as a boundary: `roybal-web-agent/persona.ts:1-30` refuses the shared registry because "a syntax error in it takes the phone line down". Mechanism 7 is already drifting: the phone agent writes `type:"mitigation"` (`services/phone-agent/tools.mjs:131`), absent from `TYPES` (`apps/board/js/board.js:30-38`), so the board relabels it "Other" (`board.js:127`).

### Era seams

| Era | Entered (git) | What it left in production | The seam |
|---|---|---|---|
| 0 React / normalized | `995fe63` 2026-03-12 → deleted `4fef103` 08-13 | ~21 tables with March leftovers ((live) `jobs` 2, `rooms` 6, `moisture_readings` 6, `equipment_logs` 5, `line_items` 2, `invoices` 1; 0 live writers); 18-value `job_status`; two deployed Magicplan functions with 0 callers (`magicplan-proxy/index.ts:46-126`), the proxy deployed with `verify_jwt = false` (`supabase/config.toml:33-34`), no auth check in code, and holding `MAGICPLAN_API_KEY` (`index.ts:19,29`) — an unauthenticated public proxy carrying a paid API key, an exposure as much as a leftover; docs still citing `apps/web` (`docs/QB_Time_Daily_Log_Plan.md:70`; `103_qb_time_field.sql:4`) | The vocabulary the owner wants — `invoices`, `line_items`, `moisture_readings`, `equipment_logs` — exists as **empty era-0 tables beside blobs that hold the real data**. `profiles.role` from era 0 is the only role model and is read only by `field_photos` RLS and the RPC guards (`218:67-72`). |
| 1 Static blob line | `04f9348` 06-08 (field); `d0a97b7` 06-09 (mig 100) | `field_projects`/`coordination_jobs` blobs; the `../../js` coupling; `serve.mjs` remaps | UI still says "Everyone shares one login" (`apps/board/js/board.js:293,3009`; `apps/admin/js/admin.js:206`) after 216 introduced individual logins. |
| 2 AI lanes | `b5a8f39` 06-26 (mig 200) → 07-25 | `unified_jobs` spine, `capture_events`, `ai_usage`, completeness tables, `pending_actions`, `personas.ts`, portal, phone agent | Spine bolted *beside* the blobs with soft ids — (live) all 33 rows still `status='new'`; completeness tables seeded, 0 app references; `field_photos` 748 rows, 0 readers; two approval spines, the server one jammed by 3 zombie `pending_actions` rows from 07-25. |
| 3 Hardening / CRM / web | 08-10 → 09-05 | plpgsql merge twin (217/241/243); `coordination_job_patch` (230/246); contacts (228); `apps/site` + web agent (`84e36c0` 08-12) | The clobber fix created a permanent JS↔SQL parity duty; the fifth concurrency implementation is called only by `apps/admin/js/leads.js:80`, never by the board; the web agent refuses the shared brain. |

Pattern: every era was added *beside* the last, never replacing it. INFER: that is why a 15-live-job company runs 53 tables and why each backbone element the owner asked for (spine, approval, audit, projection) exists somewhere in a partial, unwired form.

### Boundaries to cross: "add a field to the invoice"

| Stop | Runtime | Location (READ) | Why you stop here |
|---|---|---|---|
| 1 | field browser | `apps/field/js/model.js:398-415` | `newInvoice()` is the only schema |
| 2 | field browser | `apps/field/js/forms.js:1378-1902` | binding, QBO push (`pushInvoiceToQbo` at +270), AI flows and `print-only` nodes (+407, +514, +518) in one closure |
| 3-5 | field ×2, Deno | `fincalc.js:27-38`; `formkit.js:240-248`; `roybal-brief/digest.ts:16-24` | three totals ladders if the field touches money |
| 6 | admin browser | `apps/admin/js/finactions.js:121-161` | assistant's `invoiceCreate` calls `newInvoice()` (`:15,136`) but then overwrites `invoiceNo`/`items` itself |
| 7 | Deno | `roybal-ai-office/personas.ts:339-343` | prose parameter contract the model reads |
| 8 | Deno | `roybal-ai-office/index.ts:482,604` | `invoiceDraft`/`invoiceAudit` prompts assume the line shape |
| 9 | Deno | `qbo-proxy/index.ts:316-321` | QBO mapping keeps only qty/desc/price under one service item |
| 10 | Deno, service role | `qbo-proxy/index.ts:427-441` | rewrites `invoices[]` with its own rev guard, bypassing `push_project` and the merge |
| 11 | Deno | `roybal-portal/index.ts:297` | customer billing projection |
| 12 | JS + Postgres | `merge.js:32-36` + `217:115`, `241:41,170`, `243:17` | only for a new collection; item-level fields ride newer-wins per element (`merge.js:155-175`) |
| 13 | field browser | `apps/field/js/completeness.js` | if the field gates billing |
| 14 | field browser | `config.js:25` + `sw.js:6` | BUILD/CACHE lockstep bump — drifted at HEAD (v165/v166), `build.test.mjs:17` red |
| 15 | tests | `fincalc.test.mjs`, `smoke.mjs` | one of three ladders tested |

Fifteen stops in four runtimes and no stop *declares* the invoice; its definition is whatever these places happen to agree on. The era-0 `invoices` table sits beside them, touched by none.

### Evidence

- Coupling: 56 static cross-directory imports, 0 dynamic, 16 files (measured); reverse import `apps/field/js/myweekcalc.js:17-18`; layout `deploy-field.yml:36-38`; `sw.js:27`.
- No shared package: `package.json:5-8`; `packages/shared` deleted in `4fef103`; `supabase/functions/_shared` absent.
- Copies: `schedule.js` md5 identical in two places + Docker COPY (`Dockerfile:8-9`); `zip.js:3-5`; collection list in `merge.js:32-36` and four SQL sites; rev guard in `apps/board/js/data.js:110-118`, `apps/field/js/boardpush.js:302-310`, `roybal-notify/index.ts:501-510`, `qbo-proxy/index.ts:429-441`, plus `246:26-34`.
- Execution in browsers: `assist.js:179-193`; `finactions.js:109-303`; `board.js:226-255`; `campaigns.js:211-232`; `roybal-ai-office/index.ts:1570-1578`.
- `coordination_jobs` referenced by 22 non-test files across field, board, admin, six edge functions and the phone agent (grep), ~14 of them writers (`analytics.js:51`, `calibration.js:74`, `app.js:892`, `myweek.js`, `roybal-brief/digest.ts`, `roybal-portal/crewtoday.mjs` are read-only or comments).
- Era leftovers: (live) row counts above; `magicplan-proxy/index.ts:46-126`; `package-lock.json:31,79,7434`.
- Guards: `deploy-field.yml:10-19` has no test step; `crewdigest.test.mjs:18-23` is the only cross-copy test; `npm test` red at HEAD (`config.js:25` vs `sw.js:6`).

### Severity and why

**Dimension severity: Critical**, because the answer to the north-star question is "the logic lives in UI screens no agent can reach". That is not a smell; it is the wall between today and an AI-operated back office.

Structural (cap growth or block automation): domain executing in browser tabs; the admin as a full replica client of the field app (every office browser pulls every blob with its media references, `admin.js:34`; (live) 15 live blobs total 743 kB); the JS↔SQL merge twin on the intended single write door; `coordination_jobs` written from five apps/services across three runtimes (browser, Deno, Node) under five concurrency implementations, with the tile lifecycle split across two apps (`boardpush.js:730-773` creates, `data.js:208-214` deletes); two approval spines; vocabularies with no home.

Cosmetic (real cost, fixable incrementally): seven sharing mechanisms (the *count* is hygiene; the *lack of a guard* is structural); no `_shared/` in functions; stale "shared login" copy; lockfile ghosts; era-0 decoy tables (dangerous for agents, cheap to drop).

### What cohesive would look like

One declared domain package and one execution door, with the count of sharing mechanisms falling from seven to one.

1. **`packages/domain` (pure ESM, no DOM, no fetch)** holding what already exists as pure code: `model.js` factories, `merge.js`, `fincalc.js`, `dryingcalc.js`, `completeness.js`, `xactimate.js`, `schedule.js`, the vocabularies (stages, types, channels, quiet hours, settings uuid) and the action/tool definitions as JSON schema instead of prose. Two options for how consumers get it — **present, not picked**: (A) keep no-build; serve the package at one URL path (`/lib/`) and have functions and the phone agent import the same checked-in directory, with one CI parity check replacing the seven mechanisms — simplest to operate, still URL-coupled; (B) make it a real workspace package with a small bundle step in CI — a build the owner must operate, but admin/board/field can then version and deploy separately and the Deno/Node consumers import it normally. Either way `personas.ts` moves into it and the web agent's objection dissolves, because the phone line no longer depends on a Docker COPY.
2. **Executors move server-side.** `finactions.js`, `actions.js`, `boardpush.js` tile lifecycle, the campaign loop and the schedule recompute become typed operations (SQL RPCs or one `roybal-ops` function) called by browsers and agents alike; `pending_actions` becomes the single proposal→approval→execution→record spine and the chip lane writes proposals into it instead of running in the tab.
3. **`supabase/functions/_shared/`** for CORS, auth, envelope, DB helper, prices — 14 deploy units, one boundary recipe.
4. **Contract tests on PR**: workspace tests, copy parity, SQL parity, `BUILD`/`CACHE` lockstep — the guards exist; they only need a CI that runs them.
5. **Drop era 0**: the ~20 unused era-0 tables (keeping `profiles`, the only role model, read by `field_photos` RLS and the RPC guards at `218:67-72`), the two Magicplan functions, the lockfile ghosts — so the schema an agent reads contains only tables that are written.

The structure that must hold to 100 people is the domain package plus the single execution door; everything else (build step or not, RPC vs function) is an operating-simplicity choice that can change later without tearing those out.

### Preserve

`apps/board/js/schedule.js` (pure, 88 tests, already consumed by four runtimes — proof the headless pattern works here); `apps/field/js/fincalc.js`, `dryingcalc.js`, `completeness.js`, `xactimate.js`, `merge.js` (pure, Node-tested); `push_project` as the single-write-door pattern (guard, merge, rev, build gate, telemetry); the `pending_actions` row shape (propose → approve → execute → result); `capture_events` + `blob_history` as the audit spine; `personas.ts` PHONE_TOOLS as data-only JSON-schema tool definitions and the `persona.test.mjs` drift-guard pattern; the `mountAssistProvider` seam (`assist.js:756`) with its `{buildContext, executeAction}` contract — the one place "agent proposes, system executes" is already abstracted; `roybal-web-agent`'s split of pure modules under `node:test`; the 100 % file-header convention that carries the rules today.

---

## 2. Data model

### What the pattern is today

Three data models are deployed at once, and the one that carries the business is the least typed of the three.

**Era 0 (March 2026)** is a normalized insurance-restoration schema written for the deleted React app: `jobs` with `claim_number`, `insurance_carrier`, `adjuster_*` and an `RC-YYYY-NNN` sequence; `rooms`; `moisture_readings` with `location_description`, `material_type`, `moisture_pct` and an `is_dry` trigger; `equipment_logs` with an `equipment_type` enum, `asset_number`, `date_placed`/`date_removed`; `line_items` with `room_id`, integer cents and a generated `total_cents` (`supabase/migrations/001_initial_schema.sql:83-247`). It holds single-digit March rows and no live code reads it (live). It is, ironically, the closest thing in the repo to the vocabulary the owner listed.

**Era 1 (June)** is the system of record: one `jsonb` column per job in `field_projects`, whose header states the design — the row “mirrors exactly what the field app keeps on-device” (`supabase/migrations/100_field_projects.sql:11-19`). Three sibling blob tables share the `id uuid, data jsonb, deleted bool` shape: `coordination_jobs` (board tiles, leads, and a settings row), `crew_members`, `time_entries` (`101_coordination.sql:28-34,53-58`; `102_time_entries.sql:14-20`). None of the four has a foreign key, a check constraint, or a typed column beyond timestamps. The “schema” is the JS factory `newProject()` (`apps/field/js/model.js:128-206`), the two merge registries (`apps/field/js/merge.js:32-36,99-103`), and whatever 80 top-level keys production happens to hold (live) — 13 of which are written by code paths outside the factory (`docs/architecture/00-SYSTEM-INVENTORY.md` §9).

**Era 2/3 (July–September)** grafts typed tables around the blob without moving authority: `unified_jobs`, declared “THE SPINE — single source of truth” with “intentionally no hard FK” to either blob (`200_ai_backbone.sql:80-108`); a phase-template/instance/completeness model with zero readers (`200:32-78,123-138`; live: 1 template, 9 `required_forms`, 28 `field_requirements`, 0 instances); `contacts` (`228_contacts.sql:51-72`); a `field_photos` projection maintained by triggers and read by nothing (`221_field_photos_table.sql:42-67`); and per-lane side tables (`portal_jobs`, `sms_messages`, `email_messages`, `pending_actions`, `photo_shares`).

**Designed or accreted?** Accreted. Each era was designed; none replaced its predecessor; the youngest typed design was declared authoritative in a comment and never became so. All 33 `unified_jobs` rows still read `status='new'` (live); the only writer maps eleven header scalars and two link ids (`apps/field/js/spine.js:23-40`); nothing in the repo writes `status`, yet the office assistant and the phone agent both read it (`supabase/functions/roybal-ai-office/index.ts:1350`; `services/phone-agent/tools.mjs:57`).

### The insurance-restoration vocabulary, concept by concept

Legend: **T** typed column/table with constraints · **S** semi-structured (JSON with a stable shape or id) · **F** free text · **A** absent. Every citation is READ from code or marked (live).

| Concept | Where it lives today | Form | Evidence |
|---|---|---|---|
| Job (the record) | four live identities — `field_projects.id`, `coordination_jobs.id`, `unified_jobs.id`, `portal_jobs.id`; the tile→job link is `data.fieldJobId` inside JSON; spine links are uuid columns with no FK | S | `100:13-19`; `101:28-34`; `200:103-105`; `107_portal_jobs.sql:24-27`; (live) 64 of 80 tiles carry `fieldJobId` |
| Claim | `data.claimNo` string, copied to `unified_jobs.claim_number`, `coordination_jobs.data.claimNo`, `photo_shares.claim_no`; job and tile are matched by stripping the string to alphanumerics | F ×4 | `model.js:137`; `200:88`; `245_photo_shares.sql:19-26`; `spine.js:49-58` |
| Carrier | `data.carrier` string; `unified_jobs.insurance_carrier` text; no carrier table, no per-carrier rules or history | F | `model.js:142`; `200:89` |
| Adjuster | `data.adjuster` one string; `unified_jobs.adjuster_name/phone/email`; `contacts.role` admits `'adjuster'` but the spine resolves only the customer | F | `model.js:143`; `200:90-92`; `228:53`; `spine.js:127` |
| Policy / coverage | absent; only `invoice.deductible` per invoice instance | A | `model.js:411`; grep `policy` in model.js/forms.js/200 → 0 |
| Submittal (packet) | absent as a record; a packet is `window.print()` of a DOM, or a DOM snapshot uploaded to storage; `portalShare.sharedDocIds` and `photo_shares.photos` record what is visible, and a `'packet'` share row stamps `published_at`, but nothing records to whom or by what channel it was sent | A | `apps/field/js/app.js:1437-1494`; `apps/field/js/photoshare.js:284-296`; `245:19-30` |
| Supplement | `changeOrders[]` with a `reasons` checkbox map including “Carrier Supplement / Insurance-Approved” and a free-text `description`; the live sample has a blank `coNo` and unpriced items | S/F | `model.js:385-397,548-555`; (live) changeOrders[0] |
| Carrier response + rejection reason | absent | A | grep `rejection|pushback|denied|carrier_response` across apps/functions/migrations → 0 domain hits |
| Correspondence thread linked to claim | linked to a job or a contact, never a claim: `email_messages.job_id text` (a field-project id, matched by customer-email / claim string / customer-name), `sms_messages.unified_job_id`, `portal_messages.portal_job_id`; `contact_timeline` unions them per contact and must normalize two direction enums | S | `208_email_lane.sql:44-45`; `106_sms_messages.sql:13-14`; `108_portal_messages.sql:22-27`; `229_contact_links.sql:49-62` |
| Equipment placement / removal | `dryingLogs[].equipment[{asset,type,location,placed,removed,hours,notes}]` all free text; map icons `moistureMaps[].equipmentPlan[{id,type,x,y,angle}]`; per-day counts `dehu/am/scrub` as strings; type recovered by regex; no asset entity. Era 0 had `equipment_logs` with enum + `asset_number` | S/F | `model.js:330,346-361`; `apps/field/js/dryingcalc.js:152-163`; (live) dryingLogs[0]; `001:201-215` |
| Moisture reading by location and date | `moistureMaps[].readings[{date, values[13], notes}]` — a positional string array; location = the marker number drawn into the strokes PNG; material and `dryGoal` per map, not per location. Era 0 had one row per reading with material, location, pct, `is_dry` | S (positional) | `model.js:321-340`; (live) moistureMaps[0]: 52 values, label “Drywall”, material “Framing / Wood / Subfloor”, goal 19%; `001:166-196` |
| Dry standard / goal | `DRY_STANDARDS` constants; per-map `dryGoal` is a string like “≤ 19%” parsed by regex | T (const) / F | `apps/field/js/core.js:724-734`; `apps/field/js/forms.js:284-289` |
| Daily log | psychrometric rows in `dryingLogs[].readings[]`; Field Report `constructionLogs[]` with `notes/issues/materials` free text and an inline base64 signature | S/F | `model.js:353-371`; (live) constructionLogs[0] |
| Time entry | `time_entries.data` blob; `jobId`/`fieldProjectId` hold a field id **or** a board id depending on which table claimed the QB jobcode first; duplicated as `laborLog.entries[]` inside the job blob; no unique index on `qbTimesheetId` | S | `103_qb_time_field.sql:63-80`; `supabase/functions/qb-time-proxy/index.ts:221-222,1040-1050`; (live) sample `jobId` equals a coordination_jobs id; `model.js:376-383`; `102:27` |
| Material | no entity; `moistureMap.material` free text, `constructionLogs.materials` free text, board `materials` is an ordering status, `photos[].ai.materials[]`, `price_list.category` | A/F | `model.js:324,368`; `apps/board/js/board.js:39-43`; `109_price_list.sql:10-24` |
| Photo → room, line item | `photos[{room:'', stage, caption, ai}]`; room free text, empty in the live sample; no link to any line item or reading; `field_photos` rows exist but nothing reads them | S | `model.js:209-211`; (live) photos[0]; `221:42-59` |
| Line item with justification | `{id, room, desc, qty, unit, price}` + AI provenance `code/priced/flag`; the model is required to emit a `basis` per line, which the UI renders once and discards. Era 0 `line_items` had `room_id`, cents, `billing_type` | S, no justification | `model.js:420-422`; `roybal-ai-office/index.ts:378-385`; `forms.js:1484-1488,1505`; `001:224-247` |
| Room / area | `rooms[]` plain strings; `room` free text on photos, line items, contents, moisture-map `label`, scope `areas[].name`, plan `dimensions.rooms[].name`; a case-insensitive comparator exists because “kitchen”/“Kitchen” split the photo report. Era 0 had a `rooms` table | F ×6 | `model.js:173,210,275,324,421`; `forms.js:2019-2024,2628`; `001:137-146` |
| Crew | `crew_members.data` blob, flat roster; no crew/team entity, no lead | S | `101:53-58`; (live) keys |
| Crew member skills / certs | `bioCerts` one free-text string; `role` free text; `hourlyRate` | F | `board.js:2843,2855` |
| Availability | `outDays[]` per member; one global `workDays/hoursPerDay/holidays` in the settings tile (code default `hoursPerDay: 10`; the live settings row holds 8) | S | `board.js:1718,1874-1876`; `apps/board/js/schedule.js:14`; (live) settings row |
| Schedule assignment | three layered JSON overrides — job/phase `crewIds`, `dayCrew{date:{add,remove}}`, `crewSpans` — resolved only in JS | S | `schedule.js:436-468`; (live) sample `dayCrew` |
| Job phase and dependency | `coordination_jobs.data.subtasks[]` and `deps[{predId,type:'FS',lagDays}]`; the typed `phase_templates/phase_instances` model has 0 app references; `phase_instances` and `completeness_state` hold 0 rows (`phase_templates` holds 1, `required_forms` 9, `field_requirements` 28) | S + dead T | `board.js:2036,2062-2067`; (live) sample; `200:32-78,123-138` |
| Customer / person | `contacts` — typed, generated `phone_norm/email_norm`, merge tombstone, resolve ladder | **T** | `228:51-72` |

The pattern is unmistakable: the one concept modelled properly (`contacts`) is the one added last and outside the blob; every concept the carrier will argue about is free text or a positional array; and the concepts that decide whether a packet gets paid — submittal, response, rejection reason, justification — have no home at all.

### How the two divisions are handled

There is no division. `jobType` is a per-job flag whose only effect is which forms show (`model.js:100-111,162`), plus a `linkedRestorationId`/`mitigationRef` pointer when a mitigation job is converted to a rebuild (`model.js:169`; `apps/field/js/convert.js:125-134`). On the board the same job carries `type` from a list that mixes division and loss type — `remodel, new_build, restoration, water, fire, mold, other` (`board.js:30-38`); the phone agent writes `'mitigation'`, which is not in the list and renders as “Other” (`services/phone-agent/tools.mjs:131`; `board.js:127`). The spine records a construction job as `loss_type='construction'` (`spine.js:36`). One board, one work calendar (`schedule.js:14`), one settings row, one OAuth token row per provider. No table says which office, crew, or business unit owns a row.

### The merge protocol is the write model

A write to `field_projects` does not mean “store this”. It means: sweep the payload against its own tombstones, lock the row, then either apply the client blob wholesale when its base rev matches (`241_merge_delete_tombstones.sql:240-247`) or run `merge_project_blobs` (`241:250`). The merge picks the “newer” side by a C-collation string compare of the device-written `updatedAt` (`243_losstypes_merge_union.sql:37-41`), keeps every top-level key from that side, unions twelve id-keyed collections (newer element wins on id clash), unions `rooms`/`lossTypes` by value, fills form slots filled-beats-empty, and strips ids named in `deletedIds` (`243:16-23,46-62`). The server then rewrites `updatedAt` to be strictly newer than both inputs (`241:270`). The same algorithm exists in JS (`merge.js:142-214`) and must stay byte-equivalent; the registries are copied by hand; parity was proven once, out of band, by a 2,033-case randomized byte-equality run recorded in a comment (`243:30-36`), and no test in `apps/field/test` enforces it (only `merge.test.mjs`'s registry-vs-`FORMS` check exists). `qbo-proxy` bypasses the merge with a service-role PATCH of the whole blob, keeping only a `data->>rev` guard (`supabase/functions/qbo-proxy/index.ts:429-441`).

`coordination_jobs` has a different protocol: whole-blob compare-and-swap on `data->>rev` (`apps/board/js/data.js:110-132`), a tombstone written at the same rev with no guard (`data.js:208-214`), same-rev “annotation” writes from the field app (`apps/field/js/boardpush.js:495-527`), and a server RPC that shallow-merges top-level keys only (`246_lead_triage_grant.sql:28-78`). `crew_members` and `time_entries` are last-write-wins upserts. The rev guard is hand-rolled four times across two languages as a compare-and-swap, plus `coordination_job_patch`, which takes no caller rev and serializes with `FOR UPDATE` + `rev+1` — a lock-based shallow merge, not a CAS. Consequences for the model: no nested element on a tile can be safely written by anyone but the board; `updated_by` attributes an entire merged blob to whoever pushed last (`216_individual_logins.sql:110-138`); and `data.updatedAt` is a merge clock, not an audit stamp — the trigger-stamped `updated_at` column is the other clock (`100:22-34`). History is a pre-image of the whole blob, lz4-compressed and purged nightly (`215_blob_history.sql:53-70,188-200`), so element-level “who changed what” is a diff exercise, not a query.

### How many patterns coexist (the Frankenstein question)

Seven storage patterns: (1) normalized relational with enums and generated columns (era 0); (2) whole-document JSONB with a server three-way merge (`field_projects`); (3) whole-document JSONB with client compare-and-swap (`coordination_jobs`); (4) JSONB rows with last-write-wins (`crew_members`, `time_entries`); (5) typed side tables with soft uuid/text links (`unified_jobs`, `portal_jobs`, `photo_shares`, `sms_messages`, `email_messages`, `pending_actions`); (6) typed tables with real FKs (`contacts`, `capture_events`, `ai_usage`); (7) a trigger-maintained projection nobody reads (`field_photos`).

| Axis | Count | Instances |
|---|---|---|
| Job-record designs | 3 | era-0 `jobs`+children; era-1 blob; era-2 `unified_jobs` spine |
| Live identities per job | 4 (+1 dead) | `field_projects`, `coordination_jobs`, `unified_jobs`, `portal_jobs`; `jobs` |
| Write protocols | 4 | server merge; client CAS + same-rev annotation; LWW upsert; plain PostgREST on typed tables |
| Rev-guard implementations | 4 CAS + 1 lock-based RPC | `data.js:110-132`; `boardpush.js:302-322`; `roybal-notify/index.ts:501-510`; `qbo-proxy/index.ts:429-431`; `coordination_job_patch` (`246:28-78`, `FOR UPDATE` + `rev+1`, no caller rev) |
| Merge engines | 2 (SQL defined 3×) | `merge.js`; `merge_project_blobs` in 217/241/243 |
| Soft-delete idioms | 6 | `deleted bool`; `deleted_at`+`purged_at`; `merged_into`; `revoked_at`; `enabled`; JSON `archived`/`deletedIds` |
| Actor idioms | 4 | `auth.uid()`; email string; free label (`'qb-time'`, `'web-agent'`, `'quickbooks-time'`); `connected_by` uuid in one table, text in two |
| Job-reference types | 3 | uuid column; `text` column (`email_messages.job_id`, `pending_actions.job_id`); uuid string inside JSON |
| Direction enums | 2 | `inbound/outbound` (sms) vs `in/out` (email, portal) |
| Room spellings | 6 | see vocabulary table |
| Case conventions | 2 | snake_case columns, camelCase JSON — mapped by hand in `spine.js:23-40` |
| Element timestamp names | ≥6 | `ts`, `createdAt`, `at`, `date`, `coDate`, `invoiceDate` |
| PK generation | 3 | client-generated uuid with no default (blob tables); `gen_random_uuid()`; bigint identity |

Nullability is not a property of this model but its default: the factory ships `''` for every field, so `isBlankProject`/`emptyDeep`/`lossTypesOf` exist to guess what a job *is* from which strings happen to be filled (`model.js:223-250`); quantities, prices, hours and readings are strings (`model.js:420-422`; live `qty:'215'`, `dehu:'2'`). On the typed side, `status` is unconstrained text on `sms_messages`, `portal_jobs`, `unified_jobs`, `phase_instances`, `capture_events` (`106:21`; `107:32`; `200:100,128,158`). The completeness rules — the closest thing to a schema of “what a billable job contains” — exist in two divergent copies, JS and SQL seed (`apps/field/js/completeness.js:49-135` vs `200:253-315`), and one hard gate reads `cat3Justification`, a field nothing writes (`completeness.js:133-134`).

### Evidence

The tables above carry the citations. The load-bearing ones: blob-as-record `100:11-19`, `model.js:128-206`; 80 live keys, avg 50 kB, max 227 kB (live); write cost `INSERT field_projects` 4,254 calls @ 207 ms mean (live); 75 FK constraints in the database and zero on every era-1/2/3 core table (`00-SYSTEM-INVENTORY.md` §6.1); spine never advanced (live) and only read (`roybal-ai-office/index.ts:1350`; `tools.mjs:57`); merge twins `merge.js:32-36,99-103` ↔ `243:16-23`; second writer `qbo-proxy/index.ts:430-441`; free-text vocabulary `model.js:137-143,173,209-211,321-361,420-422`; positional readings and per-day equipment counts (live samples); basis discarded `forms.js:1484-1505`; no policy/submittal/response concept (greps); division conflation `board.js:30-38,127`, `tools.mjs:131`, `spine.js:36`; crew/schedule JSON layering `schedule.js:14,436-468`, `board.js:2843-2855`; time-entry id ambiguity `qb-time-proxy/index.ts:221-222,1040-1050` plus the live sample; dead designs `001:83-252`, `200:32-78`, `221:42-67` with zero readers.

### Severity and why

Judged against the north star — an agent reads state, proposes, a human approves, the system executes and records — today's model fails at the second step. An agent can *read* a job (one `SELECT`, then parse 50 kB of JSON whose shape is documented only by a JS factory). It cannot *address* the thing it wants to change: there is no id for “the air-mover-days line on invoice 3”, no row for “the reading at location 12 on Aug 2”, no record for “the packet we sent the carrier on Aug 20”. To *execute* it must reproduce the merge protocol or risk clobbering a tablet. To be *audited* it leaves a whole-blob pre-image attributed to one `updated_by`. That is why the absent claim-side vocabulary is Critical: it does not slow the automation backbone, it makes its unit of work unrepresentable. The blob as system of record is High rather than Critical — nothing is actively wrong in production, and Option B below reaches addressability while keeping the blob authoritative — but it is structural and must change.

Structural (cap growth or block automation): the blob as system of record; the absent claim-side vocabulary; identity-less rooms, equipment, readings and materials; four job identities held together by soft links and look-alike heuristics (which already failed at ~80 tiles — the Hebard respawn, 6 spawns in 6 weeks per `memory/board-tile-respawn-fix.md`); per-table write protocols; the missing division dimension; the JSON-only crew/schedule model. Cosmetic: case conventions, plural/singular drift, PK defaults, timestamp names, the six delete idioms — real hours per tool, fixable table by table.

Two things are worse than they look. Unbilled-item detection (capability 2) needs a join that cannot be written: the live invoice carries `qty:'215'` air-mover-days as a typed string, the same job's drying log records `am:'20'` per day, the equipment table is free text, and none shares an id. The per-carrier learning loop (capability 5) has no table to learn into — every rejection today is an email in `email_messages` filed under a job by customer name.

### What cohesive would look like

Where simplicity trades against ceiling, both options are laid out; neither is chosen here.

**Common to either path.** One job identity that every other table references by real FK — `field_projects`, `coordination_jobs`, `portal_jobs`, `photo_shares`, `email_messages`, `pending_actions` all pointing at it as uuid, never text; a `division`/`org_unit` column on jobs, crews and settings so a second crew or office is a row, not a fork; one soft-delete idiom (`deleted_at`, `deleted_by`) and one actor shape (`actor_id uuid` + `actor_kind` ∈ {user, machine, integration}); one direction enum; snake_case at the API boundary with a generated camelCase mapping instead of `spine.js:23-40`; and new tables for the claim side that exist in no design today — `carriers`, `claims` (policy, deductible, adjuster contact), `submittals` (what was sent, to whom, when, which document versions), `carrier_responses` (approved / partial / rejected + structured `rejection_reason` + free text), `supplements` linked to the submittal they answer. These are pure additions that touch no existing row and can ship first.

**Option A — typed core, blob as the device document.** Promote the field-work concepts to tables with ids and FKs: `rooms`; `equipment_assets` + `equipment_placements` (placed/removed events); `moisture_locations` + `moisture_readings` (one row per location per date, material and goal per location); `line_items` with `justification` and `evidence_refs[]`; `photos` (already projected); typed `time_entries`; `crew_members`, `skills`, `certifications`, `availability`; `phases` and `phase_deps`. The offline device keeps its JSON document, but `push_project` grows into the domain service that decomposes it into rows (the `field_photos` trigger is the prototype — it only lacks readers), and the document becomes a projection *of* the rows for offline use. Era 0's DDL is a usable first draft of most of these tables. Cost: the sync engine and the form renderers must learn ids for rooms, assets and locations — the largest single change in this review. Ceiling: none this company will hit.

**Option B — blob stays authoritative, add addressability around it.** Keep `field_projects.data` as the record; validate it against a JSON Schema inside `push_project`; emit an element-addressed change log (`job_events(job_id, path, op, before, after, actor, at)`) from the merge; add expression indexes on the JSON keys that are queried (`fieldJobId`, `contactId`, `qbJobcodeId`, `date`); give rooms, equipment and reading locations stable ids *inside* the JSON. Cost: weeks, no data migration. Ceiling: every agent tool still parses documents instead of joining rows, the client's 5 MB `MAX_ROW` backstop (`apps/field/js/sync.js:48` — a sync-engine constant, not a database limit) and whole-blob write amplification remain, and two merge engines remain a permanent parity tax. This path buys time; it does not buy the north star.

**Stop regardless.** Stop adding lanes that soft-link to a blob id in text; stop adding a seventh delete idiom; stop letting `qbo-proxy` write around the merge; retire era-0 and the unread era-2 completeness tables once their DDL has been mined for the target vocabulary.

### Preserve

- `contacts` and its resolve/merge ladder (`228:51-72`; generated norm columns; `merged_into` tombstone) — the model every new entity should copy.
- `price_list` (`109:10-24`) — typed, keyed, indexed.
- The `deletedIds` tombstone rule — “a delete is a recorded fact that beats a union” (`merge.js:148-153` inside `mergeProjects`; `243:46-62`) — should survive as an event whatever the storage.
- `push_project`'s self-echo guard and strictly-newer stamping (`241:257-274`).
- `blob_history` pre-images and `field_projects_trash` (`215:53-70`; `214`) until an event log exists.
- `pending_actions` shape (`210:24-38`) — code, kind, params, status machine, expiry, result — as the seed of the proposal table.
- `capture_events` as the ingest envelope (`200:148-163`), once separated from rate-limiter state.
- The domain vocabularies — `DRY_STANDARDS`, `CHANGE_REASONS`, `PORTAL_MILESTONES`, `SCOPE_ITEMS`, `TRADES`, `USEFUL_LIFE`, `DISPOSITIONS`, board `STAGES` — to become reference tables or enums.
- The `model.js` factories as the documented element shapes for readings, equipment rows, line items, change orders, contents items — the migration spec for Option A.
- Era-0 DDL for `moisture_readings`, `equipment_logs`, `line_items`, `rooms` (`001:137-247`) as a starting draft, not as live tables.
- `merge.test.mjs`'s registry cross-check against `FORMS` (`merge.js:30-31`) — the one test that stops a new collection from silently going newer-wins.

---

## 3 + 6. Data access layer, state management and data fetching

### What the pattern is today

There is no data-access layer in the sense of a module that knows what a job, an invoice line, or a moisture reading is. What exists is one 294-line HTTP wrapper, `apps/field/js/supa.js`, whose `api()` builds `${SUPABASE_URL}/rest/v1/${path}` from a caller-supplied PostgREST string, attaches the session token, retries once on 401 and returns the raw `Response` (`apps/field/js/supa.js:74-86`, re-exported as `rest()` at `292-294`). Every table read and write in three of the four browser apps is a query string composed at the call site: 50 `rest(` call sites across 13 field files, 25 across 6 admin files, 6 in the board's `data.js` — 81 in total, counting call sites only, not the `export async function rest(` definition at `supa.js:292` (measured by grep; the inventory §5's "50 in 15 files" counts on a different file basis). Two samples: `apps/admin/js/contacts.js:203-207` issues five hand-written PostgREST URLs in parallel to paint one contact page; `apps/field/js/forms.js:3567-3684` reads and PATCHes `portal_jobs` columns from inside a form renderer. No client uses supabase-js (grep for `supabase-js|createClient` under `apps/` and `services/` is empty), no generated types exist, and none of the client files carries `@ts-check` or a JSDoc type tag (`docs/architecture/00-SYSTEM-INVENTORY.md:401`).

Per app, the state model is:

| App | In-memory state | Durable client state | Read path | Write path | Refresh | Offline |
|---|---|---|---|---|---|---|
| field | one mutable `liveProject` bound to the open page (`apps/field/js/app.js:171`); `formkit.commit()` → 350 ms debounced `Store.put` (`formkit.js:12-13`; `core.js:213-226`) | IndexedDB `roybal-field` (`projects`, `backups`) (`core.js:80-93`); sync cursor/revs/pushed/deletes in **localStorage** (`sync.js:43-47`) | pull `field_projects?updated_at=gt.<cursor>` (`supa.js:268-273`); every other table inline | **whole-blob** `push_project` RPC, CAS-or-merge on the server (`supa.js:118-119`; `supabase/migrations/241_merge_delete_tombstones.sql:193-282`); other tables via inline PATCH/POST | 45 s interval + 1.5 s debounced push after any save (`sync.js:606-626`) | `field_projects` only: dirty = `pushed[id] !== updatedAt`, all rows rescanned each cycle (`sync.js:253`) |
| board | module-level `let` globals (`apps/board/js/board.js:90-115`) | localStorage `roybal-board-jobs/crew/time/queue/settings`, re-parsed on every read (`data.js:35-41`) | full-table paged GET of three tables, ≤20 pages × 1,000 (`data.js:150-163`) | client CAS `PATCH …&data->>rev=eq.N` → GET → POST (`data.js:110-132`); LWW `merge-duplicates` upsert for crew/time/settings/tombstones (`data.js:135-143`) | 20 s `setInterval` while visible (`board.js:205-208`) | localStorage queue, per-job dedup, retried on every pull forever (`data.js:56-93`) |
| admin | module lets per tab | **the field app's IndexedDB replica** — admin boots the field sync engine and pulls every job blob into the office browser (`apps/admin/js/admin.js:28-34`) | `Store.all()` for jobs; inline PostgREST for contacts/leads/sms/analytics (`contacts.js:203-207`; `leads.js:94,152`; `analytics.js:51,59`) | finance chips `Store.put()` the blob and let the field engine push it (`finactions.js:109`); CRM PATCHes inline; one RPC (`leads.js:80`) | route repainted on every `synced` callback (`admin.js:36-47`) | inherits the field engine for blobs; nothing else |
| portal | page-local | localStorage session | `POST /functions/v1/roybal-portal` with the publishable key (`apps/portal/js/portal.js:30-38`) | same gateway, service role behind it (`supabase/functions/roybal-portal/index.ts:118`) | none | none |
| phone agent | per-call | in-memory machine session | own `rest()` wrapper, machine JWT under RLS (`services/phone-agent/supa.mjs:47-59`) | `insertRow`/`patchCaptureEvent` (`supa.mjs:61-72`) | — | — |
| edge functions | — | — | supabase-js ×4, raw fetch ×10 (38 sites in roybal-portal); caller-JWT (`roybal-ai-office/index.ts:98-100`), service role (`roybal-portal/index.ts:118`), machine JWT (`roybal-brief`), RPC-only (`roybal-web-agent/index.ts:173-181`) | same | pg_cron | — |

No Realtime subscription exists anywhere (grep `realtime|.channel(|subscribe(` over all client JS is empty). Freshness is three independent pollers — 45 s, 20 s and per-route — and their cost is visible in production: 24,847 `coordination_jobs` selects, 24,846 `crew_members` selects and 111,629 cursor-pull selects of `field_projects` since the last stats reset (live).

### How many patterns coexist (the Frankenstein question)

Counting mechanisms rather than call sites, the system reaches Supabase through **20 distinct patterns** — 15 across the field, board and admin clients together (the inventory §5's "8 mechanisms" is the field app alone), 5 on the server — of which one is dead and one is a diagnostic:

| # | Mechanism | Where | Concurrency semantics |
|---|---|---|---|
| 1 | `rest()`→`api()` inline PostgREST, refresh-retry | field ×50, admin ×25, board ×6 | none (plain PATCH/POST) |
| 2 | `rpc()` carrying `p_build` | `push_project`/`tombstone_project`/`revive_project` (`supa.js:101-129`) | **server CAS-or-merge** |
| 3 | `rest("rpc/…")` **without** `p_build` | `spine.js:122`; `forms.js:3574`; `leads.js:80`; `contacts.js:163,252` | per-RPC |
| 4 | Storage REST, content-addressed | `supa.js:211-265` | idempotent by hash |
| 5 | `callFunction()` with refresh-retry | gmail/qbtime/qbo/notify (`supa.js:278-285`) | per-function |
| 6 | raw `fetch` to the AI functions, **no 401 retry** | `narrative.js:391-393`; `officeai.js:41-47`; `voice.js:58-64` | — |
| 7 | legacy direct table writes (dead; grant revoked) | `supa.js:133-194`; `219_revoke_direct_field_writes.sql:44-46` | client CAS |
| 8 | `/auth/v1/health` probe | `app.js:108` | — |
| 9 | client CAS PATCH→GET→POST on `coordination_jobs` | `data.js:110-132`; **re-implemented** at `boardpush.js:302-322` | rev+1 |
| 10 | same-rev "annotation" PATCH | `boardpush.js:488-527` (`rev: base`) | deliberately no bump |
| 11 | LWW upsert `resolution=merge-duplicates` | board crew/time/settings/tombstones (`data.js:135-143,208-214`); field `portal_jobs`/`photo_shares`; qb-time `time_entries` (`qb-time-proxy/index.ts:625`) | last writer wins; delete not rev-managed |
| 12 | read-merge-write for crew | `data.js:220-245` | app-side merge |
| 13 | IndexedDB `Store.put` as the write API, sync engine as transport | admin `finactions.js:109`, `assistctx.js:269` | inherits #2 |
| 14 | browser OAuth redirects | admin connect panels | — |
| 15 | gateway-only `fetch` with the publishable key | portal | server-side |
| 16 | supabase-js service role | gmail/qb-time/qbo/magicplan-webhook | LWW upsert |
| 17 | raw fetch service role | roybal-portal (38 sites), roybal-lead, notify inbound | none |
| 18 | raw fetch caller JWT (RLS applies) | ai-office/ingest/narrative, notify `sendSms` | none |
| 19 | raw fetch machine JWT via password grant | roybal-brief, phone agent | RLS-fenced |
| 20 | RPC-only service role, reserve-before-spend | roybal-web-agent (`index.ts:173-181`; `227_web_receptionist.sql:165-175`) | atomic |

The count that matters more is the number of **concurrency protocols on the two tables everything links through**. `field_projects` is written by server merge (#2) *and* by a service-role rev-guarded PATCH in `supabase/functions/qbo-proxy/index.ts:429-444` that bypasses `push_project`, `_sync_guard` and the tombstone sweep. `coordination_jobs` is written by client CAS (#9) from two codebases, by same-rev annotation writes (#10), by a service-role rev guard in `roybal-notify/approve.ts:108` (`revGuard()`, called from `index.ts:501-511`), by the shallow role-gated `coordination_job_patch` RPC (`246_lead_triage_grant.sql:28-73`), and by plain inserts from `roybal-lead`, `roybal-portal` and the phone agent. The rev-guard invariant is hand-written five times (`data.js:112`, `boardpush.js:304`, `qbo-proxy/index.ts:431`, `notify/approve.ts:108`, and the dead legacy copy at `supa.js:151` that F11 asks to delete) — four live client/function copies plus `push_project`'s server CAS. The board's own `data.js` header still says "last-edit-wins on the server" (`data.js:11`) while the same file implements the rev guard forty lines later — the one document that would tell a new writer the rules is wrong.

### Evidence

**Repository/service layer.** None. The closest artifacts are `apps/board/js/data.js` (270 lines, respected inside the board — `rest(` appears nowhere else under `apps/board`) and the three sync RPCs. Neither knows an operation name: `push_project` receives an opaque `p_data jsonb` (`241:193-197`) and `coordination_job_patch` a top-level `p_patch jsonb` (`246:28-31`).

**Whole-blob write API.** The only sanctioned door into `field_projects` takes the entire job (`241:193-282`; direct grants revoked at `219:44-46`). Adding one line item means: read the blob, mutate in JS, push with `p_base_rev`, and on `merged` adopt the server union (`sync.js:283-289`). Three separate consumers do this (field sync, admin finance chips via `Store.put`, `qbo-proxy` payment pull), and correctness depends on `apps/field/js/merge.js` and `merge_project_blobs` (redefined in 217, 241, 243) staying byte-equivalent.

**Optimistic updates.** Board `saveJob` writes the cache at the old rev before the server confirms (`data.js:193-201`); on conflict the local edit is discarded, the server copy adopted, and `refresh()` re-entered from inside `recomputeAndPersist`'s sequential save loop (`board.js:186-191, 247-255`). Field writes are optimistic by construction — IndexedDB first, server later — and the sync engine grafts merged rows back into the live object so the open form does not overwrite the union (`app.js:154-159`; `graft.js:21-50`).

**Offline queueing.** Only `field_projects` has a retried write path. Every cross-table side effect the field app performs — board tile creation, spine upsert, contact resolve, portal publish — is online-only and returns `{skipped:true}` or `null` on any failure (`boardpush.js:292-299, 527-529`; `spine.js:141-145`). The board's queue has no dead-letter: a write that can never succeed is retried on every pull forever with no attempt cap (`data.js:90` re-queues every failure), which is how the `'__settings__'` 400 hid for months (`settingsync.js:8-13`); that specific write is now shed on read by `dropDoomedSettingsWrites` (`data.js:58-61`), but the next dead write will loop the same way.

**Paging and caps.** Three readers learned PostgREST's 1,000-row page the hard way and now page (`myweek.js:50-72`; `data.js:144-163`; `roybal-brief/index.ts:148-154`); the assistant's read tools did not (`roybal-ai-office/index.ts:1363-1364, 1372, 1409-1411` — `limit=300`/`1000`, no offset) and `time_entries` holds 1,193 rows (live). The narrative function's spend-cap sum is one unpaged request (`roybal-ai-narrative/index.ts:69-72`) while ai-office and the phone agent page (`ai-office:110-126`; `supa.mjs:78-91`).

**Loading and error handling.** `rest()` returns the raw `Response`, so each of the 81 client call sites decides what a failure means: `myweek.js` throws so "read failed" and "no hours" differ (`myweek.js:55-58`); `boardpush.js` returns `null`; the board maps every thrown error, including 401 and 500, to "offline" (`board.js:216-221`); and `api()` marks the network healthy on any HTTP response including 4xx (`supa.js:81-85`). Empty or comment-only `catch` blocks: 59 in `apps/field/js`, 11 in `apps/board/js`, 9 in `apps/admin/js`, 6 in `apps/portal/js`; `.catch(() => {})`-style swallows: roughly 13–18 in field depending on the regex, 12 admin (measured). There is no client error stream to the server.

**Where an audit layer, a permission check, or an idempotency key would hook in today.**

| Concern | What exists | Where | What it cannot do |
|---|---|---|---|
| Audit | `stamp_updated_by` (`auth.uid()` on two tables) and `capture_blob_history` (whole pre-image, lz4) | `216_individual_logins.sql:110-146`; `215_blob_history.sql:86-184` | say *what* changed or *why*; nothing on `crew_members`, `time_entries`, `portal_jobs`, `contacts` beyond `updated_at`. The AI audit rows in `capture_events`/`ai_usage` are writable by every authenticated user (`200_ai_backbone.sql:235-237`; `201_ai_usage.sql:77-79`); chip execution is a best-effort client PATCH (`assist.js:209-223`) |
| Permission | role checks in `_sync_guard` (tech/admin/office), `coordination_job_patch` and `contact_merge` (admin/office); role-gated policies on `field_photos`, `contacts` delete (admin-only) and `contact_merge_suggestions`, `is_admin`/`is_assigned_to_job` on the era-0 tables; `using(true)` on the rest | `218_sync_rpcs_and_build_gate.sql:60-72`; `246:40-47`; `229_contact_links.sql:96-101`; `221:117-131`; `228_contacts.sql:96-98`; `100_field_projects.sql:41-46`; `102_time_entries.sql:30-35` | distinguish read / propose / approve / execute — there is no operation to attach a rule to |
| Idempotency | `push_project` rev + self-echo guard; content-addressed media | `241:243-251`; `supa.js:210-222` | `sendSms` inserts then sends with no key (`roybal-notify/index.ts:335-368`); `pushInvoice` updates in place only when the blob already carries `qboInvoiceId` — if the first response was lost or merged away before that id was persisted, a retry creates a second QBO invoice (`qbo-proxy/index.ts:345-356`); `coordination_job_patch` bumps rev on every call (`246:56`); `time_entries` dedupe is app-side only (`qb-time-proxy/index.ts:620-625`; no unique index in `102`) |

The two universal choke points — client `api()` and server `push_project` — see URL strings and blobs, never a named operation. An agent that wants to "record a dehumidifier placed on job X on 9/4" has no function to call; it must fetch a 50 kB blob, know the `dryingLogs[].readings[]` shape, and win the merge.

### Severity and why

**High.** Production is not broken by this layer — the server-merge sync is a genuine achievement, and the conflict incidents (Hebard respawn, deleted-photo resurrection, settings row) have each been closed. But the structure caps the north star outright: there is no headless surface through which an agent, a cron, or a second office app can read a domain fact or execute a named write. Business rules sit in UI modules (`forms.js` decides whether to PATCH `portal_jobs.billing`; `finactions.js` decides whether an invoice may be created), and the only server-side operations are three blob RPCs and one shallow patch. Structural findings — they cap growth or block automation — are: no service layer (F1), the whole-blob write API with a service-role bypass (F2), five rev guards and three concurrency models on linked tables (F3), poll-everything refresh plus an office-browser replica (F4), and no hook point for audit, permission or idempotency (F6). Real but fixable incrementally: offline coverage (F5), error semantics (F7), a wrapper shared by URL path and bypassed (F8), copy-pasted server data helpers (F9), localStorage sync bookkeeping (F10). Hygiene: the dead legacy write path (F11).

### What cohesive would look like

One place that knows the domain, callable by everything. Concretely: a `domain` layer of **named, typed, validated, idempotent operations** — `job.setStage`, `invoice.addLine`, `equipment.place`, `reading.record`, `schedule.assign` — each implemented once as a Postgres function (SECURITY DEFINER, role-checked against the caller, taking an `idempotency_key`, appending one row to an `events` table with actor, reason, before/after and the proposal it fulfils) and exposed through a single generated client that the field app, board, admin, phone agent, edge functions and an MCP server all import. Reads become views or paged RPCs (`job.summary`, `hours.byJob`) so no consumer pulls whole tables. One change feed — Realtime on the `events` table, or a single `updated_at` cursor — replaces three pollers, and the office admin stops replicating every blob into its browser. Errors flow through one `Result` shape that distinguishes offline, refused, conflict and failed, and land in a table the owner can see.

Two paths get there; the choice is the owner's.

- **(a) Operations over blobs.** Keep `field_projects.data` and `coordination_jobs.data`; write the operations as `jsonb` path edits inside the existing rev/merge protocol (the `coordination_job_patch` pattern, deepened to collections). Cheap, deployable one operation at a time while the business runs, and the field app's offline story is untouched. Ceiling: every operation stays blob-shaped, cross-job questions (unbilled equipment-days across 200 claims) remain JS scans of blobs, and the merge engine stays the arbiter of every write.
- **(b) Operations over tables.** Normalize the collections the north-star capabilities query — line items, equipment placements, readings, photos, time entries, phases and assignments — into FK-constrained tables; keep the blob only as the form scaffold that renders them. Operations become plain SQL with constraints, the audit trail becomes row-level, and agents query with `WHERE`. Cost: a migration the business must live through, a rewrite of offline sync from "one blob per job" to a per-row outbox, and the two merge engines retired rather than extended.

Either path starts the same way: make `push_project` the *only* writer of `field_projects` (route `qbo-proxy` through it), collapse the five rev guards into `coordination_job_patch`, and give `rest()` a `Result` return so error semantics stop being decided per call site.

### Preserve

- `push_project`'s CAS-or-merge with the self-echo guard and strictly-newer `updatedAt` stamp (`241:193-282`), and `_sync_guard`'s build gate plus `sync_clients` telemetry (`218:60-92`) — the seed of a server-authoritative write path.
- `merge.js` ⇄ `merge_project_blobs` union rules and `deletedIds` tombstones, with the parity test — until replaced, the only correct arbiter of blob writes.
- `Store.putIf`/`delIf` single-transaction conditional writes and the on-device `backups` store (`core.js:148-207`).
- `graft.js` — grafting a merged row into the bound in-memory object without losing the open form (`graft.js:21-50`).
- Content-addressed media offload with the `media:<sha>:<len>` marker and idempotent upload (`supa.js:210-222`).
- `apps/board/js/data.js` as the model of a respected data module, including its per-job deduplicated offline queue.
- `coordination_job_patch` (`246:28-73`) — role-gated, rev-controlled, caller cannot set `rev`/`updatedAt`: the pattern every future operation should copy.
- `roybal-web-agent`'s RPC-only service-role posture and reserve-before-spend (`roybal-web-agent/index.ts:173-181`; `227:165-175`).
- `roybal-notify`'s "RLS-gated insert before the paid call" invariant (`roybal-notify/index.ts:335-346`) and the phone agent's machine-JWT-under-RLS wrapper (`services/phone-agent/supa.mjs:47-59`).
- The fake-Supabase contract test in `apps/field/test/sync.mjs:28-60` — the one place the wire protocol is asserted.
- The paged-read discipline in `myweek.js`, `data.js` and `roybal-brief`, and the comments that explain why it exists.

---

## 4. Auth and authorization

### What the pattern is today

There is one identity system (Supabase Auth, password grant) and one nominal role model (`profiles.role` ∈ admin/tech/viewer/office), but the effective authorization rule for the live product is **"any JWT that belongs to the project may read and write nearly everything."** The role column is consulted in exactly three RLS surfaces and six SECURITY DEFINER functions (`contact_resolve`, `contact_merge`, `coordination_job_patch`, `contact_mark_review_asked`, `restore_photo`, `_sync_guard`); every other table is `for all to authenticated using (true) with check (true)`. Machine actors are not modelled as a kind of principal — they are ordinary auth users whose write rights are subtracted by 26 RESTRICTIVE policies that compare `auth.email()` to two literal strings. Approval authority is a phone number in an environment variable. No client app has a role concept at all.

**Role model, READ.** `user_role` is `('admin','tech','viewer')` (`supabase/migrations/001_initial_schema.sql:42`), default `tech` (`:50`); `office` was added in 216 "for later phases … unused until then" (`216_individual_logins.sql:50`, header). `handle_new_user()` now always assigns `tech` and ignores signup metadata (`216:66-80`), and the `role` column is revoked from `authenticated` so a tech cannot self-promote (`216:104-106`). Live profiles: **admin 2, tech 7, viewer 2 — the viewers are the two machine users; there is no `office` row** (live). So the two RPC gates written as `role in ('admin','office')` — `contact_merge` (`228:446-451`, redefined at `229:97-101` and `230:104-108`) and `coordination_job_patch` (`230:41`, redefined at `246:44-52`) — currently admit only the two admins (`contact_resolve` `228:260-270` and `contact_mark_review_asked` `234:50-55` admit `tech`); the office login copy still says "shared crew account" (`apps/admin/js/admin.js:206`, `apps/board/js/board.js:293,3009`), and a shared login seeded as `tech` (`216:91`) is refused by the Leads write path (`apps/admin/js/leads.js:79-87`).

**Client side, READ.** `isSignedIn()` is "has an access token" (`apps/field/js/supa.js:21`); there is no application-role reference anywhere in `apps/field/js` (grep; the only `role` hits are chat-message roles in `assist.js`); admin and board gate on `isSignedIn()` alone (`admin.js:91`, `board.js:176-180`). "Work offline on this device" bypasses login entirely (`app.js:138,312-313`). The publishable key is committed and served from the public site (`apps/field/js/config.js:8`).

**Does today's structure let an agent read → propose → get approval → execute → leave an audit trail?** Read: yes, over-broadly. Propose: only into `pending_actions` (3 kinds) or as browser chips. Approve: only a Twilio-signed SMS from `OWNER_CELL` (`supabase/functions/roybal-notify/index.ts:400-401`) — no role, no second approver, no approver column in the ledger (`210_pending_actions.sql:24-38`). Execute: chip action types execute in a browser tab — `assist.js:179-193` dispatches to the provider's `executeAction` (INFER: roughly 14 of 17 types; the tally is not derivable from the cited lines). Audit: `capture_events` and `ai_usage` are rewritable and deletable by every authenticated user (`200_ai_backbone.sql:235-237`, `201_ai_usage.sql:78-79`), and the chip audit stamp is a best-effort client PATCH (`assist.js:211-223`). The answer is no on three of five steps.

### How many patterns coexist (the Frankenstein question)

Ten distinct authorization mechanisms are live, in four runtimes, with no shared decision point:

| # | Mechanism | Where | Notes |
|---|---|---|---|
| 1 | Permissive `using(true)` to `authenticated` | 18 tables live (repo DDL: `100:44-46`, `101:46-48,71-73`, `102:32-34`, `107:63-65`, `108:43-45`, `200:229-240`, `201:78-79`, `212:88-90`, `245:55-57`; the count includes five era-0 tables whose DDL is not in the repo) | the default; "single-company account" comment |
| 2 | Inline `exists(select … profiles … role in (…))` | `_sync_guard` (`226:45-49`), `field_photos` (`221:113-137`) | the only role-aware RLS on live tables |
| 3 | `is_admin()` definer helper | hard delete (`216:236-244`), suggestion dismiss (`228:166-168`), `restore_photo` (`242:46-48`), era-0 tables (`001:288-293`) | |
| 4 | In-function `select p.role … if v_uid is not null` with "service role passes untouched" | `contact_resolve` `228:260-270`; `contact_merge` `228:446-451` (redefined `229:97-101`, `230:104-108`); `coordination_job_patch` `230:41`, `246:44-52`; `contact_mark_review_asked` `234:50-55` (admits tech) | fail-closed; `contact_resolve` special-cases one email (`228:267`) |
| 5 | RESTRICTIVE policies keyed on `auth.email()` literals | `204:12-31` (5), `205:11-24` (18), `208:68-72`, `228:105-114` (2) — 26 live | deny-list by identity |
| 6 | Edge-function `callerRole` via `/auth/v1/user` + service-role profiles read | `qbo-proxy/index.ts:197-211`, used at `:311`, `:366` | anon key → `null` → `pushInvoice` still runs (`:309-313`) |
| 7 | Edge-function `callerEmail` + `startsWith("office-brief@")` | `gmail-proxy/index.ts:95-106`, `:328-331` | string prefix, not role |
| 8 | Edge-function `requireUser` = any valid JWT, no role | `qb-time-proxy/index.ts:88-97`, on 5 of 12 actions (`:985`, `:1004`, `:1029`, `:1123`, `:1178`) | 7 actions have no check (`:747-978`) |
| 9 | Gateway `verify_jwt` pin | `supabase/config.toml:1-21` (MCP deploys ignore it), `:59-73` | admits the publishable key (live) |
| 10 | Out-of-band credentials: Twilio HMAC + `OWNER_CELL`; share token; `x-cron-secret`; `PHONE_RELAY_TOKEN` | `roybal-notify:400-401`; `roybal-portal:118-130`; hand-written `x-cron-secret` checks in six edge functions (gmail, qb-time, qbo, brief, portal, notify); `services/phone-agent/server.mjs:73-79` | none consult `profiles` |

Plus one dead pattern: `auth.jwt() ->> 'role' = 'admin'` on the era-0 floor-plan tables (`004_manual_floor_plan.sql:46-64`) — that claim is the Postgres role, never the app role, so those policies can never match (INFER).

### Evidence

#### RLS coverage per table (live: 100 policies on 48 tables; repo: 90 `create policy`, 27 `using (true)` sites by exact grep — 29 with a case-insensitive, whitespace-tolerant grep)

| Class | Tables | What an authenticated tech JWT can do over plain REST |
|---|---|---|
| **Permissive ALL `using(true)`** | coordination_jobs, crew_members, time_entries, portal_jobs, portal_messages, portal_selections, unified_jobs, phase_instances, completeness_state, **capture_events**, **ai_usage**, photo_shares; era-0 leftovers communications, documents, invoices, tasks, reconstruction_items (live) | SELECT / INSERT / PATCH / DELETE any row. Hard DELETE on coordination_jobs is admin-only (`216:242-244`); soft delete is an UPDATE and open to all |
| Permissive, privileges revoked | field_projects (`100:44-46` policy stands; I/U/D revoked `219:44-46`) | SELECT every job blob; writes only via `push_project` (role tech/admin/office) |
| Partial-true | sms_messages S/I/U, no DELETE by design (`106:33-47`); email_messages S/U, no column grants (`208:60-64`); contacts S/I/U on granted columns, DELETE admin-only (`228:83-98,120-124`); pending_actions S + INSERT-if-pending, no client U/D (`210:45-55`) | can INSERT fake SMS rows, rewrite email/SMS bodies, edit any contact's phone/email |
| Read-only true | price_list, qb_time_jobcodes, phase_templates, required_forms, field_requirements, contact_merge_suggestions (UPDATE `is_admin()` `228:166-168`) | |
| **Role-gated** | field_photos (`221:113-137`); era-0 jobs/rooms/… via `is_admin`/`is_assigned_to_job` | |
| Deny-all | qb_time_tokens (`103:53-54`), qbo_tokens (`104:27-28`), gmail_tokens (`208:28-30`) | nothing |
| RLS on, no policies, grants revoked | app_settings (`218:46-47`), blob_history (`215:76-78`), field_projects_trash (`214:27-29`), sync_clients (`226:29-30`), contact_sessions (`232:52-55`) | nothing — service role only |
| Storage | `field_media_rw FOR ALL to authenticated` (`100:55-58`); crew-photos I/U/D (`238:24-41`); job-photos and floor-plans public (live) | delete any of 1,881 objects / 418 MB (live) |

#### What a crew phone (tech JWT) reaches that it should not

Concretely, with the committed key plus any crew login, over `PATCH`/`DELETE /rest/v1/…`: delete or rewrite every `ai_usage` row and lift the $50 monthly cap for every lane — the cap is a sum read under the caller's own JWT (`roybal-ai-office/index.ts:110-123`); delete or edit every `capture_events` row, i.e. the audit log and the web receptionist's rate-limiter state; delete `time_entries` (payroll basis, 1,193 rows); move, re-crew, tombstone or un-tombstone any board job and rewrite the settings row (`apps/board/js/data.js:110-132`, `apps/field/js/boardpush.js:302-322` are the app's own direct-PATCH paths); flip `portal_jobs.enabled`/`share_token`, `billing`, `approvals` shown to customers; rewrite `photo_shares` tokens sent to adjusters; change any crew member's `hourlyRate`, `role`, `phone`, `digestOptOut` (`101:71-73`); write the spine (`unified_jobs`). Migration 216's own header states the exposure plainly: "a stranger as 'tech' still gets full job-data read/write via the legacy USING(true) policies" and public signup was still on when it was written (`216:26-33`; not verified live).

#### The publishable key is a credential on the `verify_jwt=true` proxies

Live cron jobs authenticate with `Authorization: Bearer sb_publishable_…` and get through: the QBO token was refreshed at 2026-09-05 14:30Z and 11 `paymentPull` capture_events exist (live; `cron.job_run_details` is not usable as proof because `net.http_post` is async and reports every job as succeeded), so the gateway admits the key served on the public site. Behind it: `qbo-proxy` `getStatus`/`exchangeCode`/`disconnect` (`:252-294`) and `pushInvoice` (`:296-313`, `callerRole` returns `null` for the anon key at `:198` and the push proceeds with `trustedSb = undefined`); `qb-time-proxy` `exchangeCode`, `getStatus`, `disconnect`, `syncJobcodes`, `getTimesheets`, `getUsers`, `getCurrentTotals` (`:747-978`, no check); `gmail-proxy` `getStatus`/`exchangeCode`/`disconnect` (`:157-203`). The AI functions are not affected: `insertRow` throws when the envelope insert fails under a non-user bearer (`roybal-ai-office/index.ts:100-104`, `:1771-1775`).

#### Where authorization lives

DB (mechanisms 1–5), edge functions (6–9, each hand-rolled), client (none, except that the client decides which RPC to call), and out-of-band secrets (10). Inconsistencies that are visible today: `contact_merge_suggestions` dismiss is admin-only in SQL but the office UI removes the card regardless (`apps/admin/js/contacts.js:151-153,243-244`); `coordination_job_patch` refuses non-office by returning `null` (`246:50-52`) while direct PATCH of the same row is open (`246:19-21` says so); `gmail-proxy` bars `office-brief@` from sending (`:330`) while `roybal-notify` lets any authenticated JWT send SMS under RLS (`:93-99`, `:647-648`; the anon/publishable key fails closed at the `sms_messages` insert, `:335-346`) and the brief proposes texts the notify webhook executes as service role (`:460-468`); `restore_photo` is admin-or-no-JWT (`242:46-48`); financial writes (estimates, invoices, change orders) are browser code writing IndexedDB and pushed as a blob merge with no approver identity (`apps/admin/js/finactions.js:109,152,218,271,303`).

#### Non-human actors

"User" is the only principal concept. The phone agent (`services/phone-agent/config.mjs:18`, `supa.mjs:30-33,47-52`) and the brief (`roybal-brief/index.ts:46-47,62-71`) are auth users with passwords in secrets, profiled as `viewer` by a seed that names them (`216:88-98`). Their narrow authority is expressed only as subtraction: 26 restrictive policies and three in-function string checks (`228:267`, `gmail-proxy:106`). Identity in the ledgers is free text: `capture_events.captured_by text` (`200:157`), `pending_actions.proposed_by text default ''` (`210:31`), `sms_messages.sent_by`, `photos[].by` = email, device "tech pick" that accepts any typed name (`apps/field/js/tech.js:17,53-60,101-106`). The one server-stamped identity is `updated_by := auth.uid()` on the two blob tables (`216:110-137`).

**What a second machine account gets by default:** a new auth user auto-profiles as **`tech`** (`216:71-77`), not viewer. As `tech` it passes `_sync_guard` and can `push_project` any job, write `field_photos`, and holds every `using(true)` right with no email fence. Even after a manual SQL demotion to `viewer`, it keeps full INSERT/UPDATE/DELETE on coordination_jobs, crew_members, time_entries, unified_jobs, portal_jobs/messages/selections, capture_events, ai_usage, photo_shares and column-granted contacts — because the fences name `phone-agent@`/`office-brief@`, not a role. Only `push_project` (`226:45-49`) and `field_photos` writes (`221:121-131`) exclude `viewer` by role.

### Severity and why

**Critical.** Two conditions are actively exposed in production: (1) the public key alone reaches `pushInvoice`, OAuth `disconnect`, and timesheet dumps; (2) every crew login can erase the AI cost ledger, the audit log, payroll hours and customer-facing portal state over REST. Beyond exposure, the structure blocks the north star outright: an audit trail any actor can rewrite is not an audit trail, and "propose but not execute" cannot be expressed for an agent because the model has no capability vocabulary — only `using(true)` minus an email. Structural ceilings (cap company size): the deny-list-by-identity fencing (every new automation must be remembered in every policy), the absence of any principal kind for agents, and the blanket policies that make a subcontractor, a second crew, a read-only office role or a customer login a 14-table redesign. Cosmetic by comparison: the dead 004 policies, the anon-executable live-only `get_portal_data` with no callers (live; grep of apps/services/functions empty), 255 `multiple_permissive_policies` advisor warnings, leaked-password protection off (live).

### What cohesive would look like

One authorization decision, made in the database, consulted by every runtime. A `principals` concept covering humans and agents (kind, role, and for agents a named capability set); a small `capabilities` matrix — action type × {read, propose, approve, execute} × role — that RLS helpers and every definer RPC call through one function (`can(action, verb)`), so policies are written against roles and capabilities, never `auth.email()`. All writes to operational tables go through typed RPCs (the `push_project`/`coordination_job_patch` pattern generalised), with direct table INSERT/UPDATE/DELETE revoked from `authenticated` the way 219 did for `field_projects`. `pending_actions` becomes the only execution door for agents and gains `approved_by`, `approved_at`, an approver capability check, and per-kind authority; approval can arrive by SMS, by admin UI, or by API, all landing in the same row. `capture_events`/`ai_usage` become insert-only for everyone but the service role (the `sms_messages` precedent). Edge functions stop deciding auth themselves: each resolves the caller to a principal once and delegates to the DB gate, making `verify_jwt` irrelevant. Trade-off to present, not pick: **(A)** keep RLS-per-table and add role helpers table by table — simplest to operate, but authorization stays spread across 48 policy sets; **(B)** revoke direct table access entirely and expose only RPCs/views — one choke point and the shape LLM tools need, at the cost of writing an RPC per operation and losing PostgREST convenience for the board's whole-blob writes.

### Preserve

`pending_actions` as designed (inert proposals; state transitions service-role only; executor re-verifies the row) — `210:1-22,45-55`, `roybal-notify:438-443`, `gmail-proxy:317-326`. The single-door definer-RPC pattern with a role guard and explicit EXECUTE revokes — `218:60-72,270-279`, `226:38-80`, `219:44-46`. Server-stamped authorship that cannot be spoofed and records "automation" honestly as NULL — `216:110-137`. `handle_new_user` never trusting signup metadata and the `role` column revoke — `216:66-80,104-106`. Column-level grants as an authorization tool — `228:120-124`. Fail-closed in-function gates where a missing profile refuses — `228:260-270`, `246:44-52`. Deny-all token tables and RLS-on-no-policy guard tables — `103:53-54`, `104:27-28`, `208:28-30`, `214:27-29`, `215:76-78`, `232:52-55`. The web receptionist's RPC-only service-role posture with definer EXECUTE revoked from public/anon — `227:349-359`, `roybal-web-agent:173-181`. The RESTRICTIVE-policy *technique* (keep the mechanism, replace the email predicate with a role/capability predicate) — `204`, `205`, `216:236-244`. Deliberate no-DELETE on `sms_messages` — `106:33-47`. `config.toml` as the written record of gateway pins and its warning — `config.toml:1-21`.

---

## 5. Business logic placement

### What the pattern is today

There is no place where a business rule lives; there are ten, and which one a rule landed in reflects the week the feature was built, not what the rule is.

The dominant pattern is **rule-inside-the-renderer**. The invoice totals ladder is a closure called `recalc` inside the 526-line `invoice()` renderer (`forms.js:1378-1903`) that also autosaves, pushes to QuickBooks and runs four AI flows (`apps/field/js/forms.js:1432-1450`). The 7-day equipment flag is computed twice in the drying-log renderer (`forms.js:634`, `forms.js:695`). The change-order "new contract total" is a DOM update (`forms.js:1200-1204`); the draw-schedule unallocated balance is another (`forms.js:3226-3234`).

The second pattern is the good one: **pure ES modules with Node tests** — `fincalc.js`, `dryingcalc.js`, `completeness.js`, `dryingwatch.js`, `buildwatch.js`, `schedule.js`, `merge.js`, `model.js`'s `depreciation()`. But READ: their only importers are browser code (`grep isBillable|evaluateProject` outside the module → `apps/field/js/app.js:1646-1659` only; `invoiceTotals` → `finactions.js`, `qbo.js`, and the brief's *own copy*). Nothing server-side calls them except the brief's byte-copied `schedule.js`.

The third is **chip executors in the browser**. The office's only write path into job records is `apps/admin/js/finactions.js`, which says so itself (`finactions.js:1-13`), and that file is where rules like "only an approved estimate can be invoiced" (`:127-128`) and "partially_paid needs an amount" (`:194-195`) live. The board's equivalents are `apps/board/js/actions.js:399-414`; the field's is `assist.js:229-256`; the phone agent's is a `switch` (`services/phone-agent/tools.mjs:199-214`).

The fourth is **inline rules in edge functions**: quiet hours, monthly cap and reserve floor in `roybal-notify` (`index.ts:62,208,212,217-232,276-286`); a second totals ladder plus a second `budgetStatus` in `roybal-brief/digest.ts:16-49`; a third ladder in `qbo-proxy/index.ts:316-330`. The fifth is **plpgsql**: the job merge (`merge_project_blobs`, live body `243_losstypes_merge_union.sql:13-144`; the 217 and 241 definitions are superseded), `coordination_job_patch` (`246:28-78`), the receptionist's reserve-before-spend caps (`227:46-316`). Live-era triggers are touch/audit/projection only (`grep "create trigger" supabase/migrations/1*.sql 2*.sql`); no business rule fires in a trigger. The sixth is **inert SQL seed data** that a JS comment calls canonical (`completeness.js:9-12`) but nothing evaluates (`200_ai_backbone.sql:279-315`; zero app references; **(live)** `phase_instances` 0, `completeness_state` 0).

The remaining four: prose contracts in `personas.ts` (`ACTION_DEFS`, `:246-362`; quiet hours restated as prose `:252-253,309`); env-var knobs with a hard-coded default per runtime (`SPEND_CAP_USD` read independently in 7 files, `SMS_QUIET_START/END` in 3); vocabularies as hand-mirrored JS arrays (`board.js:22-77` → `actions.js:34-37` "keep in sync"); and files kept identical by `cp` (`roybal-brief/crewdigest.test.mjs:13-23`).

Against the north-star question — read state, propose, approve, execute, leave a trail — the honest answer for money, drying, completeness, documents and status is: an agent can read (blobs are open), can propose (17 chip types), but **execution of every one of those rules requires a signed-in browser tab, because the rule is the UI.**

### How many patterns coexist (the Frankenstein question)

Ten: (1) recalc closures inside DOM renderers; (2) pure tested ES modules imported by browsers only; (3) three browser chip executors + one phone switch; (4) inline rules in edge functions; (5) `SECURITY DEFINER` plpgsql; (6) inert SQL seed rows; (7) prose contracts in `personas.ts`; (8) env-default knobs per runtime; (9) hand-mirrored vocabulary arrays; (10) byte-copied files. Patterns 2 and 5 are the seeds of a real service layer. The other eight are where rules actually execute today.

The consequence is measurable: **25 rules exist in two or more places** (Table A), parity is asserted by comments (`243:30-36`, `fincalc.test.mjs:1-6`) and one byte-equality test that CI never runs, and two have already diverged silently — the QBO tax base and the selections over/under rule.

### Evidence

#### Where each rule lives

| Rule | Client | Edge fn | DB | Verdict |
|---|---|---|---|---|
| Pricing (price_list resolution) | — | `roybal-ai-office/index.ts:422-480` | `price_list` read-only | server, single |
| Totals / O&P / tax / deductible | `forms.js:1432-1450`, `fincalc.js:27-38` | `digest.ts:16-25`, `qbo-proxy:316-330` | — | **×4, divergent** |
| Depreciation / ACV | `model.js:287-305` (contents only) | — | — | single; **no ACV on line items** |
| Status transitions | `board.js:943-951` (any→any), `finactions.js:167-227` | `payments.ts:37-65` | none (`unified_jobs.status` never written, `spine.js:23-39`) | **no state machine** |
| Document numbering | hand-typed `forms.js:1862-1868`; `EST-/INV-/CO-${length+1}` `finactions.js:89,137,250` | `DocNumber slice(0,21)` `qbo-proxy:336` | only sequence is era-0 (`001:78,111-112`, dead) | **none server-side** |
| GPP / grain depression / dry standards | `core.js:705-734` | — | — | single |
| Equipment sizing (WRT) | `dryingcalc.js:45-148` | — | — | single, pure |
| Completeness / billable gate | `completeness.js:49-135,205-231` | — | `200:279-315` (inert) | **executable only in browser** |
| Scheduling engine | `board/schedule.js` | `brief/schedule.js` (md5 ≡) + Docker `COPY` | — | ×3 copies, dates persisted by browser |
| Merge semantics | `merge.js:142-214` | — | `merge_project_blobs` ×3 defs (only 243 live) | **two engines** |
| Quiet hours | `campaigns.js:36-39` (hard-coded) | notify, qb-time, voice | — | ×4 |
| Spend caps | `ai.js:319-350` mirror | 6 × `monthSpend` | `web_turn_begin` (227) | ×6 + 1 |

#### Table A — every rule that exists in more than one place (all verified at HEAD 1e04694)

| # | Rule | Copies | Locations | Divergence |
|---|---|---|---|---|
| 1 | Totals ladder (base → O&P → RCV; tax on base; − deductible − payments) | 4 | `forms.js:1432-1450`; `fincalc.js:27-38`; `roybal-brief/digest.ts:16-25`; `qbo-proxy/index.ts:316-330` | QBO taxes `subtotal` **including** the O&P line the client appends (`qbo.js:52-54`); app taxes base only. Deductible/prior payments never cross. |
| 2 | Line subtotal Σqty×price | 4 | `formkit.js:240-248`; `forms.js:1255-1259`; `fincalc.js:20-22`; `digest.ts:17` | — |
| 3 | GC O&P 10&10 only with a sub | 2 | trigger predicate (`hasSubcontractor`) `forms.js:1363-1376`; `fincalc.js:51-63`; 10&10 defaults `model.js:406-409`, `forms.js:1425-1429`; spec `docs/Estimating_Rules_Draft.md:29-39` | — |
| 4 | 7-day equipment flag | 3 | `forms.js:634`; `forms.js:695`; `dryingwatch.js:71-75` | days vs hours arithmetic |
| 5 | Budget vs estimate (0.9) + `loggedCosts` + budget base | 2 | `fincalc.js:71-103`; `digest.ts:27-49`; threshold env `brief/index.ts:48` | — |
| 6 | "Open invoice" status set for the overdue chase | 2 | `digest.ts:133`; `brief/index.ts:272` — literal `["sent","viewed","partially_paid"]`, not derived from `fincalc.js:16` | enum restated as prose `personas.ts:347` |
| 7 | Invoice status writers | 2 | `finactions.js:167-227` (sent/viewed/paid/void, browser); `qbo-proxy/payments.ts:37-65` (partially_paid/paid, nightly) | two vocab subsets, no transition rule |
| 8 | Completeness matrix | 1 + 1 inert | `completeness.js:49-135` (29 rules + `CONSTRUCTION_REQUIREMENTS`); `200:279-315` + `105:10-25` (28 rows, no evaluator, no construction matrix) | JS `fp_present` = moisture-map sketch (`:63-64`); SQL says "Magicplan import" (`200:283`) |
| 9 | Merge engine | JS + plpgsql | `merge.js:142-214`; `217:111`, `241:37`, `243:13` | parity by comment `243:30-36` |
| 10 | 12-key collection list | 2 live (+3 superseded) | `merge.js:32-36`; `243:16-19` (live); `217:115-117`, `241:41-43`, `241:169-172` are superseded migration bodies | adding a form key = two edits plus a new migration; miss the SQL side = silent newer-wins |
| 11 | Quiet hours 7–20 AK | 4 + prose | `notify:217-232` (env, `h23`); `qb-time:1186-1196` (env, `hour12:false`); `voice:126-136` (env, `h23`); `campaigns.js:36-39` (**hard-coded 7/20**); `personas.ts:252-253,309` | two `Intl` idioms; three copies read the env, one ignores it |
| 12 | Stage vocabulary | 7 | `board.js:22-29`; `actions.js:35`; `boardpush.js:329`; `app.js:362-370`; `personas.ts:258`; `digest.ts:176`; `crewtoday.mjs:45`; string filters `leads.js:94,152` | — |
| 13 | "Open lead" predicate | 5 | `leads.js:52`; `analytics.js:204`; `board.js:82`; `digest.ts:157,162` | each excludes a different set (`isMilestone`/`outcome`/`archived`) |
| 14 | Lead record factory | 6 | `board.js:1946-1953`; `roybal-lead:395-413`; `roybal-portal:433-446`; `tools.mjs:130-147`; `web-agent:334-350` → `227:249-251`; field adoption `boardpush.js:671-700` | phone + web write `type:"mitigation"`, absent from `TYPE_IDS` (`actions.js:37`) → renders "Other" |
| 15 | Rev-guard write | 5 | `data.js:110-132`; `boardpush.js:302-320`; `notify:501-510`; `qbo-proxy:429-431`; `246:28-78` (RPC, top-level keys only) | field's same-rev "annotation" writes differ from board's bump |
| 16 | LLM price table | 6 + env | `ai-office:83-87`; `ingest:57-61`; `qb-time:294-298`; `portal:79-83`; `phone-agent/config.mjs:55-58`; `web-agent/guards.ts:253-257` (names `claude-sonnet-5`/`opus-5`, used nowhere else); `narrative:31-32` | one table prices against models the ledger never sees |
| 17 | `monthSpend` / cap gate | 6 + 7 env reads | `ai-office:110`; `ingest:342`; `qb-time:303`; `narrative:69` (**unpaged**); `portal:608`; `phone-agent/supa.mjs:78`; client mirror `ai.js:319-350` | narrative under-counts past 1,000 rows (**(live)** 998) |
| 18 | Scheduling engine | 3 runtime + 1 served import | `board/schedule.js` ≡ `brief/schedule.js`; `Dockerfile:9`; `myweekcalc.js:15-18` | guard = `crewdigest.test.mjs:18-23`, not in CI |
| 19 | Hours-join rule | 2 | `schedule.js:163-173` ("THE one join rule"); `board.js:139-152` re-implementation | — |
| 20 | Overload cap default | 2 | `board.js:462,467,1855` (8); `schedule.js:14` (10) | 8 vs 10 |
| 21 | Crew-on-day (roster → spans → dayCrew) | 2 | `schedule.js:413,462-470,575`; `crewtoday.mjs:50-63` re-implementation | — |
| 22 | Selections over/under allowance | 2 | `forms.js:3050-3062` (all rows); `narrative.js:307-314` (decided rows only) | **already diverged** |
| 23 | Settings-row uuid `…-01` | 7 | `settingsync.js`, `myweek.js`, `boardpush.js`, `ai-office`, `brief`, `portal`, `tools.mjs` | — |
| 24 | `normClaim` | 2 | `spine.js:49`; `emailmatch.ts:45` | — |
| 25 | Anchorage-hour helper | 5 | the four #11 gates plus `web-agent:207-212`, whose `alaskaHour()` feeds only an 8–17 open-hours greeting (`persona.ts:106-107`) and never reads `SMS_QUIET_*` — a looser set than #11 | `hourCycle:"h23"` ×3 vs `hour12:false` ×2 |

#### Table B — rules an agent cannot invoke today without driving the UI

| Operation | Where the rule executes | Server door | Blocker |
|---|---|---|---|
| Create/issue an invoice or estimate (number, O&P rule, status) | `finactions.js:74-161` chip → `Store.put` → sync → `push_project` (whole blob) | none | no operation; numbering is array length |
| Set invoice sent/viewed/void | `finactions.js:167-227` | none (`payments.ts` covers paid/partially_paid only) | — |
| Compute RCV / totals | `fincalc.js` in browser; brief's copy | none exposed | pure module, no endpoint |
| Run the billable gate | `completeness.js` via `app.js:1646` | none; SQL rows inert | server cannot answer "is this billable" |
| Mark dry / certify drying | `certDrying.sigTech` (`forms.js:1121-1189`), `isCertified` `dryingwatch.js:30-33` | none | signature PNG in blob is the state |
| Record moisture reading / equipment placement | form editors; voice chips applied client-side (`ai.js:411-442`, `voice.js:220-227`) | `roybal-ai-ingest` extracts only | server never writes the blob |
| WRT equipment sizing | `dryingcalc.js` via `forms.js:500-609` | none | — |
| Move stage / create board job / assign crew / update phase | `actions.js:399-414`; no validation (`board.js:943-951`) | partial: `coordination_job_patch` top-level keys, admin/office; `notify` `boardEdit` = `addPhase` only (`approve.ts:70-81`) | `subtasks`/`dayCrew`/`crewSpans` have no safe server write |
| Compute and persist a schedule | `board.js:226-255` persists N sequential saves | brief computes for texts, cannot persist | dates on disk = last browser's output |
| Generate packet / narrative sheet / PDF | `forms.js` renderers + `window.print` (`app.js:1552,1936,2413`); DOM snapshot `photoshare.js:194-237` | none | browser-only DOM |
| Push invoice to QBO with correct lines | `qbo.js:36-77` builds lines and appends O&P | `pushInvoice` exists, ungated, not in `ACTION_DEFS`, no idempotency key | a direct caller omits O&P |
| Advance claim lifecycle (`unified_jobs.status`) | nothing (`spine.js:23-39` omits `status`) | none | **(live)** all 33 rows `new` |
| Create change order / supplement | `finactions.js:230-283`; `forms.js:1191-1250` | none | — |
| Contents ACV totals | `model.js:287-305` + `forms.js:2510-2513` | none | — |
| Publish portal / set milestone | `forms.js:3336-3908` + `apps/field/js/portal.js:120-181` | `portal_jobs` is RLS-open, but the publish rule is client code | — |
| Apply photo AI / room / caption | `officeai.js:111-137` client apply | analysis only | — |
| Send customer text | `roybal-notify sendSms` | **yes** (gated, audited) | — |
| Send email | `gmail-proxy sendEmail` via `pending_actions` | **yes** (owner SMS only) | — |
| Create a lead | six server/client factories | **yes** | each hand-builds the record |

### Severity and why

**High for the dimension.** Not Critical: no rule is producing wrong money in production today (the QBO tax divergence is real but Alaska tax rates are typically 0 — INFER; `forms.js:1596` "usually 0 in AK"). But every one of the six target capabilities needs a server to *execute* a rule, and today the server can execute exactly three kinds of action (`emailSend`, `sendText`, `boardEdit/addPhase` — the three-branch executor at `roybal-notify/index.ts:448-469`, with `approve.ts:70-72` rejecting any board op but `addPhase`) plus a lead insert. Carrier-ready documentation, unbilled-item detection and supplement detection all require computing totals, completeness and drying state headlessly; the modules exist but are unreachable from any edge function, cron or RPC.

Structural (caps growth or blocks automation): no service layer (Table B); merge semantics split across two live engines (`merge.js` + migration 243) with the 12-key collection list restated in each, plus three superseded migration copies; no lifecycle model for job, claim, invoice or drying; the billable gate only exists in the browser. Cosmetic-but-costly: the 25 duplicated rules, which are a maintenance tax and a drift risk rather than a ceiling — though #14 and #22 show the drift is already happening.

### What cohesive would look like

One **domain package** — `packages/domain` or `supabase/functions/_shared/domain` — holding the pure rules that already exist (`fincalc`, `dryingcalc`, `completeness`, `schedule`, `merge`, `dryingwatch`/`buildwatch`, the vocabularies, quiet-hours and price tables), imported by the browsers, every edge function and the phone agent from one path instead of `cp`, `COPY` and `../../board/js`. Every state change becomes a **named operation** — `issueInvoice`, `setInvoiceStatus`, `markDry`, `moveStage`, `recordReading`, `applySchedule`, `syncInvoiceToQuickBooks` — with a typed input, validation, an idempotency key, a role check, and an audit row, exposed once (RPC or one gateway function) and called by chips, crons and agents alike. `ACTION_DEFS` prose becomes those operations' JSON schemas. Vocabularies and policy constants move to reference rows or a single generated constants module read by all runtimes; `required_forms`/`field_requirements` either get an evaluator or are deleted.

Where simplicity trades against ceiling, two honest options:

- **Merge.** (a) Keep JS as the source of truth; generate the SQL arrays from `merge.js` in a build step and run the 2,033-case parity harness in CI — after recovering it: the harness is not in the repository (only the comment at `243:30` and `docs/Sync_Rearchitecture_Plan.md:113-114` refer to it; `apps/field/test` has `merge.test.mjs` only). Small change, keeps offline-first blobs; the ceiling stays "whole-blob writes". (b) Make the server the only merge engine: clients send operations, not blobs, and the SQL merge shrinks to nothing. Larger change; the one that scales to hundreds of concurrent jobs and lets an agent write one reading without touching 200 kB.
- **Rule execution.** (a) Expose the existing pure modules from one edge function ("domain gateway") — fastest path to headless totals/completeness/schedule. (b) Move the rules into plpgsql so PostgREST, crons and triggers can call them without a Deno hop — more operable at 100 people, but plpgsql is a worse home for the estimating logic and the parity problem returns.

### Preserve

The pure modules are correct and tested; carry them forward unchanged and put them behind a service: `apps/field/js/fincalc.js` (ladder, O&P rule, budget, billing summary); `dryingcalc.js` (WRT worksheet); `completeness.js` (rule set as the spec, including `CONSTRUCTION_REQUIREMENTS`); `core.js:705-734` (GPP, `DRY_STANDARDS`); `model.js:287-305` (`USEFUL_LIFE`, depreciation) and its factories/vocabularies; `dryingwatch.js`/`buildwatch.js`/`schedulewatch.js` flag rules; `apps/board/js/schedule.js` with its 88 tests; `merge.js` semantics with `merge.test.mjs` (and the SQL parity harness, once recovered from PR history — it is not in the repo); `qb-time-proxy/phasematch.ts` + `aiphase.ts` thresholds; `qbo-proxy/payments.ts` adopt-don't-double-count; `roybal-notify` cap/reserve/quiet-hours semantics as the spec; the `pending_actions` propose→approve→execute→record shape; `web_*` reserve-before-spend RPCs; `docs/Estimating_Rules_Draft.md:29-39` as the written O&P rule; `calibration.js:41-63`.

---

## 7 + 8. UI / component system and the document / PDF pipeline

### What the pattern is today

**UI.** There is no shared design system; there is one CSS file that three apps happen to load. `apps/field/css/app.css:6-48` defines 31 custom properties; admin and board link `../css/app.css` and add no tokens of their own (`apps/admin/css/admin.css:1` "reuses app.css tokens"; `apps/board/css/board.css:9` only aliases `--gold→--orange`). The portal carries a hand-copied subset (`apps/portal/css/portal.css:3-10`), the site its own 30-token scale (`apps/site/src/styles/brand.css:7-49`), and the three standalone legal pages each inline a fourth copy (`apps/field/terms.html:12-13`, `privacy.html:12-13`, `sms-consent.html:12-13`). `design-system/` is a 20-page static gallery that nothing imports; its token page states "Defined in `apps/field/css/app.css :root`" while listing `--navy:#0f1b2d` (`design-system/field-office/tokens/index.html:9`) — a value `app.css:29` has not held since the redesign commit `3f367af` (2026-06-18, the same day the gallery was added in `6962a19`). Two navies have therefore been in production since birth: `#16395a` (field/admin/board/portal screens) and `#0f1b2d` (site, `print.css` ×14 hardcoded, six inline fallbacks in field JS such as `forms.js:2870`, and `board.css:5`, which asserts the wrong value). The brand orange literal `#f26a21` appears 52 times across 20 files under `apps/` (excluding SVG assets and build output).

The component layer is `apps/field/js/formkit.js` — 18 exports (`field`, `inp`, `ta`, `sel`, `seg`, `check`, `sigBlock`, `signOrUpload`, `uploadDoc`, `photoUploader`, `taCell`, `lineItems`, `letterhead`, `sheetFooter`, `sheet`, …) built on one DOM helper `h()` (`apps/field/js/core.js:8`). Every input helper takes `(obj, key)` and writes back through a module-level save context (`formkit.js:10-13`): the "component" is a bound editor, not a view. Admin and board import the same `h()` by relative path (`apps/admin/js/admin.js:8`, `apps/board/js/board.js:7`); the portal has no component layer and defines three private arrow copies of `h` (`apps/portal/js/portal.js:10`, `packet.js:13`, `photos.js:14`). Layout lives inline: 257 `style` attributes in `forms.js`, 196 in `app.js`, 118 in `board.js`, 106 across the admin modules, plus 118 `app-only` print markers in `forms.js`.

**Documents.** Every carrier-facing artifact is a live, editable DOM that the browser prints. There is no PDF library — `apps/field/js/pdf.js:12` lazy-loads pdf.js only to *import* PDFs — and the output device is `window.print()` (`apps/field/js/app.js:1552, 1625, 1936, 2400, 2413, 2458`; `apps/board/js/board.js:491`; `apps/portal/js/packet.js:78-81`), with `print.css` attached as `media="print"` (`apps/field/index.html:17`). The registry is `FORMS` (`apps/field/js/model.js:31-98`, 22 entries) → `RENDERERS` (`apps/field/js/forms.js:3910-3933`, 22 keys, 21 functions; `reconEstimates` reuses `invoice`). The packet is assembled by `packetGroups()` (`app.js:1437-1494`): narrative first, `constructionLogs`/`portalShare` excluded, support docs and floor plans as full-page scans, an uploaded signed copy *replacing* the generated Work Auth / Certificate of Drying — a map duplicated verbatim at `app.js:1439` and `app.js:1902`.

### How many patterns coexist (the Frankenstein question)

| # | Rendering path | Where | Output |
|---|---|---|---|
| 1 | `sheet()`-wrapped form renderers (21 `sheet(` calls) | `forms.js` via `formkit.js:310-315` | DOM → print |
| 2 | Raw `h("section",{class:"sheet"})` builds with inline-style info grids | `narrativeSheet` 2839, `progressSheet` 2876, `uploadedDocSheet` 2803 | DOM → print |
| 3 | Box labels | `app.js:2385-2401` | DOM → print |
| 4 | DOM-snapshot share: settle off-screen at 816 px, clone, freeze inputs/canvases, inline `app.css+print.css`, upload content-hashed HTML | `apps/field/js/photoshare.js:154-300`; served by `supabase/functions/roybal-portal/index.ts:199-209`; printed from an iframe `packet.js:76-81` | HTML blob → browser print |
| 5 | Board print (landscape `@page`, `.printhdr`) | `board.js:491`; `board.css:356-390` | DOM → print |
| 6 | Customer portal view of the same facts (drying/billing/closeout) from `portalProjection` | `apps/field/js/portal.js:68`; `apps/portal/js/portal.js:452-571` | screen only |

Six rendering paths, four token tables (+3 inline copies), and the letterhead specification split across **six** locations: the DOM structure (`formkit.js:290-303`, with its own inline `color:var(--orange,#f26a21)`), the company data (`model.js:6-24`), print typography (`print.css:33-55`), a screen re-implementation for the packet preview (`app.css:476-488`), the share's `<style>` overrides (`photoshare.js:277-279`), and the board's separate print block. `COMPANY.licenses` (`model.js:14-21`) is annotated "printed in the document footer" but no file consumes it; `sheetFooter` prints only `Roybal Construction, LLC — label` (`formkit.js:305-307`). Pattern count for this dimension: **6**.

### The document builder: what it is and its status

"Document builder" is a name for `forms.js` (3,933 lines) plus `formkit.js`, `print.css` and `packetGroups()`. Its parts sort into three bins:

**Pure and testable today** — no DOM, real Node assertions (READ): `fincalc.js` (totals ladder, O&P rule), `dryingcalc.js` (WRT sizing), `completeness.js`, `dryingwatch.js`, `buildwatch.js`, `narrative.js` fact builders, `xactimate.js`/`xlsx.js`, `convert.js`, `ai.js`, `calibration.js`, `model.js` constants and factories. Inside `forms.js` itself two private functions are pure string/markup builders: `moistureChartSvg()` (`forms.js:64-110`, returns an SVG string) and `mdToNodes()`/`mdInline()` (`2813-2837`, the narrative Markdown subset).

**Fused with binding, network and AI** — cannot be called headlessly (READ): `invoice()` spans `forms.js:1378` to the next top-level declaration at `1912` (≈530 lines) and inside one closure paints the letterhead sheet (`1862-1872`), computes the totals ladder (`1432-1452`) and Recap by Room (`1390-1416`), pushes to QuickBooks (`1640-1656`), replaces `inv.items` with an AI draft (`1484-1488`), runs estimate import and the scope-interview loop, and autosaves. `portalShareForm()` spans `3336`–`3910` (≈573 lines) and issues PostgREST reads/patches on `portal_jobs` (`3567, 3610, 3636, 3673, 3684`), a `contacts` read (`3570`), an RPC (`3574`), two `roybal-notify` sends (`3576, 3639`), a `qbo-proxy` call (`3670`) and two `publishPortal` pushes (`3355, 3698`). `forms.js` contains 100 `commit()` autosave calls and 20 private helpers (`jobInfo:38`, `sectionTitle:54`, `termRow:892`, `invoiceCharges:1252`, …) that exist nowhere else.

**Carries forward as spec, not code**: the terms text (`forms.js:838-844`, six clauses), the three certification statements (`1176-1177` IICRC S500; `2612-2613` pack-back; `3320-3321` completion), the field lists in every renderer, the packet order and exclusion rules, and the print rules in `print.css`.

### Headless render: possible today?

No. `h()` calls `document.createElement` (`core.js:8-9`); renderers also need canvas, `requestAnimationFrame`, `localStorage` and `window.print`. The smoke test proves the ceiling: it boots the modules under jsdom only by stubbing the 2D context and `toDataURL` (`apps/field/test/smoke.mjs:36-38`), stubbing `window.print` (`:30`) and forcing offline mode (`:25`), and then asserts merely that a `.sheet` exists (`:159, 236`). That yields an HTML skeleton with blank sketches and signatures, not a document. The nearest headless artifact — the packet-share HTML — is built *in the browser* and uploaded (`photoshare.js:257-280`); the server only fetches the stored text (`roybal-portal/index.ts:199-209`). The email lane is `Content-Type: text/plain` (`supabase/functions/gmail-proxy/emailmatch.ts:104`) with a text-only `body` parameter; there is no attachment path. The weekly progress-update prompt (addressed to the owner and, when applicable, the adjuster or lender) even says "the letterhead and sign-off are added by the document" (`supabase/functions/roybal-ai-office/index.ts:814`) — a document no server can produce. INFER: today an agent can draft the update or cover letter but cannot generate, attach, send, or archive the document it refers to.

### Numbering, versions, revisions, issued/locked state

None exist (confirmed). `invoiceNo`, `coNo`, `certNo` are plain text inputs (`forms.js:1867, 1211, 1146`). The only auto-fills are `"DRAW-"+(i+1)` (`forms.js:3258`) and the admin's `EST-/INV-/CO-${array.length+1}` (`apps/admin/js/finactions.js:89, 137, 250`) — counters that repeat after a delete. QuickBooks receives `invoiceNo.slice(0,21)` (`supabase/functions/qbo-proxy/index.ts:336`). The only real sequence, `generate_job_number` RC-YYYY-NNN, belongs to the dead era-0 `jobs` table (`supabase/migrations/001_initial_schema.sql:78, 107-119`; (live) 2 rows, no writers). Factories `newInvoice` (`model.js:398-415`), `newChangeOrder` (`385-397`) and `newCertDrying` (`520-530`) carry no `status`, `version`, `issuedAt` or `locked` field; a grep for issued/locked/revision/finalized across `forms.js`, `model.js`, `finactions.js` hits only label text. Status enums live in `fincalc.js:15-16`; the only writer is the admin AI-action path (`apps/admin/js/finactions.js:106-107`, defaulting to `draft`) — the document editors themselves never set a status. (live) A change order created 2026-09-04 has `coNo: ""` and unpriced blank items. Re-issue means edit in place and print again; nothing records what a carrier actually received.

### Evidence

| Claim | Citation |
|---|---|
| Two navies, born the same day | `app.css:29` (#16395a, commit 3f367af 2026-06-18); `design-system/field-office/tokens/index.html:9` (#0f1b2d, commit 6962a19 2026-06-18); `print.css` 14 hardcoded #0f1b2d; `board.css:5` |
| Token tables | `app.css:6-48`; `portal.css:3-10`; `brand.css:7-49`; `terms.html:12-13` |
| Inline styles / markers | `forms.js` 257 `style`, 118 `app-only`, 100 `commit(`; `app.js` 196; `board.js` 118 |
| One DOM helper, three private copies | `core.js:8`; `portal.js:10`; `packet.js:13`; `photos.js:14` |
| Print call sites (8) | `app.js:1552,1625,1936,2400,2413,2458`; `board.js:491`; `packet.js:78-81` |
| No PDF library | `pdf.js:12` (import only); `index.html:17` |
| Fused renderers | `forms.js:1378→1912`; `1640-1656`; `1484-1488`; `3336→3910`; `3567-3684` |
| Basis discarded | `forms.js:1484-1488` (stored keys) vs `1505` (rendered); (live) `invoices[0].items` have no code or justification; `docs/Estimating_Rules_Draft.md:114` says attach it |
| No numbering/lock | `forms.js:1146,1211,1867,3258`; `finactions.js:89,137,250`; `qbo-proxy/index.ts:336`; `model.js:385-415,520-530`; (live) `coNo:""` |
| Headless impossible | `core.js:8-9`; `smoke.mjs:25,30,36-38,159`; `photoshare.js:257-280`; `roybal-portal/index.ts:199-209`; `emailmatch.ts:104`; `roybal-ai-office/index.ts:814` |
| Letterhead in six places; dead licenses | `formkit.js:290-307`; `model.js:6-24`; `print.css:33-55`; `app.css:476-488`; `photoshare.js:277-279`; `board.css:356-390`; grep `licenses` → 0 consumers |
| Untested documents | only `fincalc.test.mjs` mentions `forms.js` (comment); `smoke.mjs:159,236` |
| Docs codify the pattern | `apps/field/README.md:15,29-30,136` ("7 forms"); `docs/Construction_Mode_Prompt.md:15,34,66` |

### Severity and why

**High for the dimension.** Nothing here is actively broken in production — the packets print and, per the owner, get paid — so this is not Critical. It is structural: capabilities (1), (3) and (5) of the north star all require a machine to produce a document from data, freeze it, know its number and version, and record its submission. Today the document *is* the screen. Every one of those steps has a person and a browser in the loop, the content that was sent is not retained anywhere except as a printed file on someone's device, and the per-line justification that the owner's own rules document says must "survive adjuster review" is rendered once and dropped. The **structural** findings are the missing document model, the missing identity/version/issued state, and the browser-only render path; these cap growth because document throughput scales with people at screens, not with claims. The **cosmetic** findings are the token sprawl, the two navies, the six-way letterhead, and the inline styles: real cost, no ceiling.

### What cohesive would look like

One **document record** (Postgres): `documents(id, job_id, claim_id, kind, number, version, status ∈ draft|issued|superseded|void, issued_at, issued_by, rendered_hash, storage_path, sent_to, submittal_id)` with a per-kind sequence for numbers and immutability after `issued` — a new row for every revision. Line items become rows with `justification`, `code`, `room_id`, and links to the evidence (photo, reading, equipment placement) that support them, so an agent can assemble "Estimate v3 with justification on every flagged line" without touching UI code.

One **render pipeline**: `render(documentKind, data, template) → HTML → PDF`, callable from an edge function, a cron job, an agent tool and the field app alike. The field app keeps editing in the DOM, but the printable output comes from the same templates the server uses. Two ways to get the PDF, presented not chosen: (a) keep HTML+CSS as the template language and add a headless-Chrome render step (Browserless/Cloudflare Browser Rendering, or a small Fly worker) — lowest rewrite, preserves `print.css` nearly verbatim, adds one external service; (b) move to a PDF library (pdf-lib/PDFKit in Deno) — no browser dependency, but every layout rule in `print.css` must be re-expressed by hand. A **template layer** with the letterhead defined once (data in one `company` row, structure in one template, tokens in one file the apps and the templates import) replaces the six copies. Documents get a regression harness: a fixture job rendered to HTML and diffed, and one page-count assertion per kind.

Where simplicity trades against ceiling: a single `documents` table with a `kind` column is simplest to operate; typed per-kind tables (`estimates`, `invoices`, `change_orders`) give stronger validation and cleaner tool schemas at the cost of more migrations. The email lane needs a `multipart/mixed` builder either way, so a document can leave as an attachment.

### Preserve

The carrier-facing conventions are the real asset and they lift cleanly as spec: Recap by Room (`forms.js:1390-1416`), room-sectioned charges in first-appearance "sketch-walk" order (`1261-1268`), the totals ladder base→O&P→RCV→tax-on-base→−deductible−payments (`1432-1452`, tested in `fincalc.js:27-38`), GC 10&10 only with a sub (`1363-1376`; `Estimating_Rules_Draft.md:29-39`), the Work Auth terms (`838-844`), the three certification statements, the narrative cover line "Prepared for {carrier} — Submitted with Estimate, Photo Report, Moisture Map & Certificate of Drying" (`2861-2863`), packet order and upload-replaces rules (`app.js:1437-1494`), 13-column reading blocks (`forms.js:302-307`), the pagination rules that were learned the hard way (`print.css:6, 20, 25-30, 82-87, 111, 238-259`), the filename rule (`app.js:224-234`), and `COMPANY` (`model.js:6-24`) with `licenses` promoted from dead data to a printed footer line. Keep `moistureChartSvg` and `mdToNodes` as-is, keep `formkit.js`'s helper vocabulary as the editor layer, and keep the entire pure-module set (`fincalc`, `dryingcalc`, `completeness`, `dryingwatch`, `buildwatch`, `narrative` facts, `xactimate`, `convert`, `ai`, `calibration`).

---

## 9 + 10. Offline and sync · File and photo storage

### What the pattern is today

There is one real offline engine in the company and it belongs to one table. Everything else is either a localStorage cache with a hope, or nothing.

| App | With no signal | Mechanism | Evidence |
|---|---|---|---|
| **Field** | Full read/write of every job the device holds; edits queue implicitly and sync on reconnect | IndexedDB `roybal-field` v2 (`projects` + `backups`); one JSONB blob per job; `sync.js` runs pull-then-push every 45 s and 1.5 s after any save; "dirty" = `pushed[id] !== updatedAt` (no explicit queue — the whole store is rescanned each cycle); server-authoritative `push_project` does CAS-or-merge under `FOR UPDATE`; per-item delete tombstones (`deletedIds`); big data-URLs deflated to the `field-media` bucket and re-inflated on pull | `apps/field/js/core.js:80-93`; `apps/field/js/sync.js:249-253,435-436,526-541,608,623`; `apps/field/js/supa.js:101-129`; `supabase/migrations/241_merge_delete_tombstones.sql:193-280`; `apps/field/js/merge.js:32-36,64,142-214`; `apps/field/js/media.js:35-37,87-114` |
| **Field — everything that is not the job blob** | **Silently skipped.** Board tile create/adopt/heal, spine upsert, contact resolve, portal publish, photo/packet share, selections, QBO push, Gmail, SMS inbound fetch, AI calls, "move photos to cloud" are all online-only, fire-and-forget from a page render; no queue, no retry, no indicator | `apps/field/js/boardpush.js:204`; `spine.js:83`; `photoshare.js:88-91,128,285`; `portal.js:126-185`; `qbo.js:14-15`; `gmail.js:14-15`; `officeai.js:24,31`; `voice.js:108`; `forms.js:2428`; fired from `app.js:1308,1381,1384,548-557` |
| **Board** | Reads the last localStorage snapshot; writes are optimistic and parked in a localStorage queue | `roybal-board-jobs/crew/time/queue/settings`; guarded job writes dedup per id; **anything that keeps failing is retried on every pull forever** (the `'__settings__'` 400 hid for months); no IndexedDB, no service worker or build tag of its own — it runs under the field SW at scope `/` and needs a 3.5 s timed force-reload to survive a deploy | `apps/board/js/data.js:25-29,56-93,90,110-132`; `apps/board/js/settingsync.js:7-13`; `apps/board/index.html:34-48`; `apps/field/sw.js:27` |
| **Admin** | Whatever the field engine pulled — the admin **runs the field sync engine** and so pulls every `field_projects` blob **and every referenced media object** into the office browser's IndexedDB; its own CRM writes (contacts, leads, campaigns) are online-only REST | `apps/admin/js/admin.js:11,34`; `apps/field/js/sync.js:435-482` (`inflateProject(remote, downloadRemembered)`) |
| **Portal** | Nothing. No service worker, no cache; every request is a POST to `roybal-portal` | `apps/portal/` (index/packet/photos + 5 js, no `sw.js`); `apps/portal/vercel.json:7-11` |

**Conflict handling (field).** Push: `insert/applied` adopt rev and write nothing locally (`sync.js:273-281`); `merged/current` adopt the server union clean (`144-179`); an unrecognised status **fails closed** rather than falling into the tombstone branch (`292-298`); a tombstone with real local work revives guarded (`361`). Pull: local wins ties on `updatedAt` (`475`); a row whose media has not landed freezes the cursor and turns the light red after 3 cycles (`49,492,543`). Escape hatches: `absorb()` self-echo guard (`103-134`), "☁ Take the cloud's copy" wholesale (`582-604`; `app.js:1181-1208`), on-device backups restored by **union** (`app.js:1126-1172`). Sign-out wipes cursor/pushed/revs/media bookkeeping but keeps queued deletes (`631-639`; `app.js:333-340`), which forces a merge from base 0 for every row on the next sign-in — the code itself names this as the resurrection mechanism (`567-580`).

**Photo upload retry.** Uploads are sequential and content-addressed inside the push loop; a failed upload fails the cycle and is retried next cycle with no backoff (`sync.js:240-246,256-257`). A device remembers at most 3,000 hashes it has uploaded (`225`); past that it re-uploads (harmless under `x-upsert`, but paid in bandwidth).

**Service worker.** Cache `roybal-field-v166`; navigations network-first, same-origin assets stale-while-revalidate, everything else cache-first; install refetches CORE with `cache:"reload"` then `skipWaiting`, activate deletes every other cache (`apps/field/sw.js:6,40-57,59-96`). Registered with `updateViaCache:"none"`, `update()` on open and hourly; `controllerchange` reloads unless a text field is focused (`app.js:2662-2677`). **Measured drift at HEAD:** `BUILD="v165"` vs cache `v166` (`config.js:25`; `sw.js:6`), so `build.test.mjs` fails and the field `npm test` chain is red (`build.test.mjs:17`); every push carries `p_build` (`supa.js:102`) so the server gate and `sync_clients` telemetry are fed a wrong number. The precache omits two statically imported modules (`photoshare.js` at `app.js:20`/`forms.js:24`; `calibration.js` at `assist.js:36`) despite its own rule at `sw.js:16-18`, and precaches deprecated `pricing.js` (`sw.js:19`). (live) `min_field_build = 0` — the gate is unarmed; `sync_clients` shows v165 ×4, v155, v153 — two devices are two-plus builds behind and nothing stops them.

**Documented failure modes, all real and all fixed in code:** the Aug 6 stale-device wholesale clobber (`docs/Sync_Rearchitecture_Plan.md:7-12`), the Jul 2026 rev ping-pong / 6 k row rewrites (`sync.js:108-113`; `241:262-266`), the 187-photo job stalling every other job's pull (`sync.js:437-440`), the Fidler 163-photo resurrection (`merge.js:38-58`; `241:9-14`), tombstones restarting `rev` and re-enabling clobbers (`220_tombstone_rev_highwater.sql:1-25`), the `navigator.onLine` false negative that stranded a tablet (`core.js:39-56`), rows over 5 MB silently skipped (now surfaced, `sync.js:48,260`), repeat-tap blank jobs (`app.js:600-604`). One is documented and **not** fixed: an admin `restore_photo` is undone by any device holding unsynced edits because a tombstone wins unconditionally (`242_restore_photo_clears_tombstone.sql:16-25`).

### Storage

| Aspect | Today | Evidence |
|---|---|---|
| Bucket in use | `field-media`, private — **the only one used**: (live) 1,881 objects, 418 MB for 15 live jobs (~28 MB per live job). `crew-photos` (public, 0 objects), `job-photos`/`floor-plans` (public, era 0; 9 and 10 objects, no live writers), `photos`/`reports`/`documents` (empty) | `100_field_projects.sql:50-53`; `238_crew_photos_bucket.sql:14-22`; (live) buckets |
| Object identity | key = sha256 of the **data-URL string**; body is that string; `Content-Type: text/plain`; `x-upsert: true` (overwrite is the normal write) | `apps/field/js/supa.js:208-222` |
| What goes in | any `data:` string over 8,000 chars (photos, sketch/strokes PNGs, plan/scan pages, contents item photos); signatures stay inline under 60,000 chars; packet HTML snapshots + their images; media carried inside job tombstones | `media.js:35-37`; `model.js:326,328`; `photoshare.js:284-296`; `sync.js:398-409`; (live) `constructionLogs[0].signature` inline |
| Access control | `field_media_rw FOR ALL to authenticated` — any login, including the two `viewer` machine accounts, can read, overwrite or delete any object | `100:55-58`; (live) storage policies |
| Deletion / GC | **None exists.** No code path issues a storage DELETE (grep of apps, functions, migrations); two migrations *assume* media is never deleted; a hard-deleted job leaves its objects forever | `214_field_projects_trash.sql:9-10`; `221_field_photos_table.sql:62-64` |
| Resizing | client only: capture at 1200 px / q0.6 (`forms.js:2370`; default 1600/0.72 `core.js:271`); "Move photos to cloud" verifies the bucket copy then swaps the inline src for a 480 px / q0.5 thumb and keeps the bare hash in `ph.cloud` | `photoexport.js:84-106,98` |
| Serving | field: re-fetches full-res by hash when online (`forms.js:2058`); **portal: the gateway downloads each object and inlines the data-URL** — up to 24 photos + 6×8 doc pages per `view`, N+1 sequential fetches, no cache; its header still promises "short-lived signed URLs" | `roybal-portal/index.ts:5-7,61-63,137-143,242-256` |
| Linkage to jobs/rooms/line items | **positional in the blob**: `photos[]` `{id,by,src,caption,room(free text),stage,ts,ai,cloud}`; separate bare photo arrays on moisture maps, field reports, contents items, punch rows; no photo↔line-item, photo↔reading or photo↔equipment link; (live) sample photo has `room: ""` | `model.js:209-211,281,332,368,660`; (live) `photos[0]` |
| Row projection | `field_photos` (748 rows, `(job_id,id)` key, `purged_at`, no FK by design) maintained by an AFTER trigger on every blob save plus a nightly repair — **zero readers** in any app or function | `221:42-67`; `224:195-250`; `docs/Sync_Rearchitecture_Plan.md:310-315` |
| Two reference formats | `media:<sha>:<len>` marker (sync) vs bare `cloud` hash (offload) for the same object — deliberate, so sync never re-inflates offloaded photos | `media.js:37`; `photoexport.js:14-17` |

### How many patterns coexist (the Frankenstein question)

Seven write/sync patterns touch tables that must stay linked (`field_projects` ↔ `coordination_jobs` ↔ `unified_jobs` ↔ `portal_jobs`):

1. Field blob: server CAS-or-merge RPC + client union engine + per-item tombstones + media offload (`241`; `sync.js`; `merge.js`).
2. Board tiles: client-side CAS PATCH on `data->>rev` with insert fallback; delete is a same-rev upsert while every save PATCH forces `deleted:false` (`data.js:110-132,116,208-214`).
3. Board crew/time/settings: last-write-wins `merge-duplicates` upsert, no rev (`data.js:135-143`).
4. Field→board "annotation" writes at the **same** rev (`boardpush.js:302-322,495-527,730-773`) — a third hand-rolled guard.
5. `roybal-notify` and `qbo-proxy` rev guards — a fourth and fifth; qbo's is a **service-role PATCH on `field_projects` that bypasses `merge_project_blobs` and the tombstone sweep** (`qbo-proxy/index.ts:429-444`; `219:17-18`).
6. `coordination_job_patch` RPC, shallow top-level merge (`246:28-78`).
7. Online-only fire-and-forget REST with no queue (spine, portal, shares, selections, campaigns).

Plus the merge itself exists twice — `merge.js` and `merge_project_blobs`, the latter redefined in 217/241/243 with the 12-collection registry copied into each — "proven byte-equal over 2,033 randomized cases" by a comment, not by CI (`243:30-36`; `merge.test.mjs:224-226` guards only the JS side against `FORMS`). Storage has five reference/serve conventions (marker, bare hash, inline base64 under threshold, hash lists in `portal_jobs`/`photo_shares`, base64 re-inlined by the gateway).

### Evidence

- (live) `INSERT field_projects` 4,254 calls @ 207 ms mean (883 s total); `push_project` 2,064 calls @ 190 ms; full-blob selects 2,361 @ 125 ms; `coordination_jobs` selected 24,847 times (the board's 20 s poll); `SELECT time_entries` 31,255 calls @ 22 ms (679 s total) — the #2 query by total time, the same board poll's `getAll` on the time table plus `crewLookup`/My Week. Blob avg 50 kB, max 227 kB; `blob_history` 272 rows / 11 MB.
- Every blob update fires five triggers: touch, `stamp_updated_by`, trash capture, `blob_history_capture` (lz4, rolling 48 versions / 30 days; bound to UPDATE and DELETE only, so an insert fires four), `project_field_photos` → `reconcile_job_photos` (`224:195-219`; `215:212-215`).
- `fetchSince` has **no job or crew filter** — every device pulls every changed job in the company and inflates every marker (`supa.js:268-273`; `sync.js:435-482`).
- Board `getAll` pages 20 × 1,000 and silently stops (`data.js:153-160`); `time_entries` is at 1,193 rows and grows nightly (live).
- Test coverage is genuinely strong for what exists: `test/sync.mjs` (704 lines, 76 checks) drives push/pull/merge against a fake Supabase including the three RPCs and the bucket (`sync.mjs:1-45`); `merge.test.mjs` 23 checks; `media.test.mjs`, `photoshare.test.mjs`, `graft.test.mjs`. None run in CI (`.github/workflows/deploy-field.yml` has no test step).

### Severity and why

**High overall, not Critical.** Nothing is losing data today; the July/August incidents were each root-caused and closed with tests, and the field engine is the best-engineered module in the repo. The severity is structural: the *unit* of sync, the *scope* of sync, and the *addressability* of what is synced are wrong for both stated goals.

Against the north star: an agent cannot read one photo, one reading, one equipment day or one line item without fetching and walking a 50–227 kB blob; it cannot write one without re-implementing deflate + base-rev + `push_project` and racing every crew device's 45 s cycle (the union protects additions; scalars are newer-wins, so an agent's stamp can lose to a phone with a skewed clock). The only per-element table (`field_photos`) is write-only. The only durable trail is whole-blob pre-images on a purge window. The dozen side effects a job edit *should* trigger (tile, spine, portal, shares) have no queue, so an agent that sees the blob cannot tell whether they happened.

**What breaks first at 100 crew / tens of thousands of photos (growth ceilings, in order):**

1. **Whole-company replica per device.** With no scoping, 100 phones and every office tab each download every changed job *and every photo in it*. Today the admin browser already holds all 15 jobs' media. This hits IndexedDB quota, cell data and the 3,000-hash memory long before Postgres hurts. (`supa.js:268-273`; `sync.js:225,435-482`; `admin.js:34`)
2. **Blob write amplification and per-job row lock.** Each edit rewrites the row (207 ms mean live) under `FOR UPDATE` and fires five triggers; every extra crew on a job turns every push into a `merge_project_blobs` call that returns the whole blob for the device to re-inflate. Ten crews on one large loss is a serialised merge storm.
3. **Board full-table poll with a 20,000-row silent cap** — at 100 crew the entries table passes it within a year and the schedule quietly runs on stale hours; N tabs × 3 tables × every 20 s (`data.js:153`; `board.js:207`).
4. **Storage without GC or ACL.** Content addressing means every re-encode (size tier, thumbnail, packet snapshot) is a new object and nothing is ever removed; 28 MB per live job × 1,000 jobs is 28 GB served through the portal function as base64. A single compromised or buggy login can `DELETE` the lot.
5. **Sign-out re-merge** scales with jobs per device (`sync.js:631-639`).

**Merely small, not ceilings:** the 2,000-tombstone cap (`merge.js:64`), the 5 MB row backstop (`sync.js:48`), the 3,000-hash memory, the 10-snapshot backup store shed to 2 on quota (`core.js:186-202`).

### What cohesive would look like

Keep the shape that is right — offline-first IndexedDB on the device, the **server** as merge authority, content-addressed media, tombstones as recorded facts — and change three things:

- **Unit of sync = typed rows, not the job.** Photos, moisture readings, equipment placement/removal events, daily-log entries, line items, contents items become tables with `(job_id, id, created_by, updated_at, deleted_at)`, idempotent per-row upsert, and a per-table `updated_at` cursor **scoped to the crew's assignments**. Whole-document forms (work auth, certs) stay JSON in one column with the existing `_mf_form` merge. This is Phase 3/4 of the plan the team already wrote and stopped at (`docs/Sync_Rearchitecture_Plan.md:320-360`); `field_photos` is the first table, already populated.
- **One outbox for every write.** An IndexedDB `outbox` that queues *all* mutations — blob or row, board tile, spine link, portal publish, share row — and drains through one server `commands` endpoint that is idempotent by client-generated id. UI, agents and jobs call the same endpoint; the audit row is written there, not by a best-effort PATCH after the fact.
- **Storage as a first-class table.** `media(hash, mime, bytes, w, h, job_id, uploaded_by, created_at)` as the join point; objects stored as binary JPEG with a real Content-Type so signed URLs and image transforms replace base64 inlining and client 480 px thumbs; RLS derived from job assignment/role; delete admin-only via a refcount GC job.

Option table, honestly weighed:

| Path | Cost | Holds to 100+? | Agent addressability |
|---|---|---|---|
| **A. Stay blob**; scope `fetchSince` by assignment; flip `field_photos` to be read (portal, packet, AI); add the outbox for side effects; fix storage ACL/GC | days–2 weeks, incremental, no data migration | egress yes; concurrency partially (row lock per job stays) | photos yes; readings/equipment/line items still inside the blob |
| **B. Rows per section + outbox** (the plan's Phase 3/4) | weeks of sync-engine surgery, dual-write then flip per section, one merge engine retired per section | yes | yes — this is what capabilities 1–3 need |

A is the safe floor; B is the shape that lets an agent propose "add air-mover day 5 to line 12 with photo X as justification" and have the server record exactly that.

### Preserve

- `apps/field/js/sync.js` invariants verbatim: pull-then-push, local-wins-ties, fail-closed on unknown status, rev in bookkeeping not the blob, `putIf`/`delIf` CAS against IndexedDB, self-echo guard, refuse-to-store-markers, cursor freeze on missing media, staleness guard on queued deletes, content-carrying tombstones.
- `apps/field/js/merge.js` rules and the registry cross-check in `test/merge.test.mjs:224-226`; unconditional per-item tombstones (`241`); `tombstone_project` high-water rev (`220`); `_sync_guard` + `sync_clients` (`226:38-80`); `field_projects_trash` + `blob_history` (`214`, `215`).
- `media.js` deflate/inflate + content addressing; `photoexport.js:84-106` verify-before-drop; `photo_shares` hash-only rows + token-gated gateway (`245`; `roybal-portal/index.ts:154-220`).
- `field_photos` design (`221`/`224`): `(job_id,id)` identity, `purged_at`, no FK by design, projection that can never block a save, nightly repair — this *is* the first rows-not-blobs table.
- `test/sync.mjs` fake-Supabase harness; `core.js:39-56` evidence-over-flag `likelyOffline()`; `graft.js`; the backups store + union-restore; `build.test.mjs` lockstep rule (make CI run it).

---

## 11 + 12. Integrations · Error handling, logging and observability

*Scope: QuickBooks Online, QuickBooks Time, Gmail, Twilio SMS/voice, Magicplan, Anthropic, Deepgram, the Fly phone agent — and how anything, anywhere, learns that one of them broke. Everything below is READ from the tree at `1e04694` unless marked (live) or INFER.*

### What the pattern is today

There is no integration layer. Each external system has one edge function that dispatches on a `{action: "<verb>"}` string, and each browser wrapper is a 1:1 pass-through of those verbs (`apps/field/js/qbo.js:13-27`, `gmail.js:13-36`, `qbtime.js:19-30`). "Sync invoice to QuickBooks" does not exist as an operation anyone can call by name; what exists is `POST qbo-proxy {action:"pushInvoice", invoice, customer, jobRef}` from one form (`apps/field/js/forms.js:3670`, `qbo.js:36`). The AI assistant never calls a proxy at all — it emits chips, and a browser tab executes them with the signed-in user's JWT (`apps/field/js/assist.js:179-193`; grep of `roybal-ai-office/index.ts` for `qbo-proxy|gmail-proxy|roybal-notify` = 0).

Every provider is a raw `fetch` — Anthropic in seven files across ten call sites, Deepgram in two (`roybal-ai-office/index.ts:139,176,1544` + Deepgram `195,210`; `roybal-ai-ingest/index.ts:398` + Deepgram `374`; `qb-time-proxy/index.ts:317`; `roybal-web-agent/index.ts:380`; `roybal-ai-narrative/index.ts:103`; `roybal-portal/index.ts:635`; `services/phone-agent/brain.mjs:19,114`); Twilio and TSheets and Intuit and Google likewise. There is no `supabase/functions/_shared/` directory (`ls supabase/functions/` → 14 function dirs, nothing else).

Credentials: OAuth access and refresh tokens sit in plaintext columns in three tables (`104_qbo_tokens.sql:10-19`; `208_email_lane.sql:13-24`; `103_qb_time_field.sql:20-28`), fenced from browsers by deny-all policies (`104:27-28`, `208:28-30`, `103:53-54`) and read with the service role by `.order(created_at desc).limit(1).single()` — **one connection per provider, latest row wins** (`gmail-proxy/index.ts:110-111`; `qbo-proxy/index.ts:76-77`; `qb-time-proxy/index.ts:107-112`). The `vault` extension is installed and unused (grep `vault.` in migrations/functions = 0). Provider secrets are 67 distinct `Deno.env.get` names; counting non-test files only, `CRON_SECRET` is read by 6 functions, `OWNER_CELL` by 6, `SPEND_CAP_USD` by 5 (the inventory's ×9/×7 figures include test files). (live) The cron secret and the publishable key are literal text inside the seven HTTP `cron.job.command` strings (the other two jobs, `purge-blob-history` and `repair-field-photos`, are pure SQL; the inventory §6.5 counts six); the repo's cron migrations carry `__CRON_SECRET__`/`__ANON_KEY__` placeholders (`202:36`, `206:35`, `207:37-39`, `209:35-37`, `211:30`), three later migrations scrape the live headers back out of the `morning-brief` row and `raise exception` on a fresh DB (`233_portal_crew_lines.sql:45-51`; `236_clockin_crew_line.sql:38-43`; `244_crew_digest_cron.sql:33-38`), and the migration that rotated them ("237") is absent from `main` (`ls supabase/migrations` goes 236 → 238) — it exists as `237_cron_keys_new_format.sql` only on the unmerged branch `crm/clockin-crew-line` (commit `9b32807`).

Error handling: the clients swallow, the functions return JSON to a caller that toasts. Measured: `console.*` appears **once** in the field app (`apps/field/js/core.js:207`), **zero** times in board, admin, portal, and zero in `roybal-ai-office`, `roybal-ai-ingest`, `roybal-ai-narrative`, `qbo-proxy`, `gmail-proxy`. The field app has **59** empty or comment-only `catch` blocks and 152 `toast(` sites; board/admin/portal add 26 more empty catches; the functions add 21 `.catch(() => {})` / `.then(()=>{},()=>{})` swallow sites. Integration reads are fail-safe: `null`/`[]`/`{skipped:true}` on any error (`apps/field/js/boardpush.js:292-299`, `boardpush.js:497-517`, `spine.js:83`, `tech.js:71-78`). The board maps every thrown error — 401, 500, RLS refusal — to "offline" (`apps/board/js/board.js:210-220`), `supa.js:81-85` counts any HTTP response including 4xx as "network OK", and the board's offline queue retries a permanently failing write on every pull forever with no dead-letter (`apps/board/js/data.js:72-93`) — which is exactly how the `'__settings__'` 22P02 error retried for months unnoticed (`settingsync.js:8-13`).

### How many patterns coexist (the Frankenstein question)

| Concern | Implementations | Where |
|---|---|---|
| Caller identity when crossing a function boundary | **5** | user JWT (`apps/field/js/supa.js:278-285`); service key as Bearer (`roybal-portal/index.ts:118,452-456`; `qb-time-proxy/index.ts:1273-1280` + cron secret); anon key as Bearer + `x-cron-secret` (`roybal-notify/index.ts:448-457`); machine-user JWT via password grant (`services/phone-agent/tools.mjs:159-164`; `roybal-brief/index.ts:62-71`); (live) publishable key + `x-cron-secret` in `cron.job` |
| `x-cron-secret` check | 8 hand copies; qb-time also accepts it in the body | `gmail-proxy:208,319`; `qbo-proxy:377`; `roybal-brief:82`; `qb-time-proxy:1027,1121,1176`; `roybal-portal:1053` |
| Response envelope | 2 | `{ok,data}` (`qb-time-proxy:49-55`) vs flattened `{ok,...result}` (`roybal-notify:74-75,654`) |
| DB client | 2 | supabase-js ×4, raw PostgREST ×10; `qbo-proxy` uses both (`68-72` and `432-442`) |
| CORS block | 11 copies, 9 `*` | grep |
| `std` version | 2 | 0.168.0 ×11, 0.177.0 ×3 |
| Quiet-hours window | 3 | `hourCycle:"h23"` (`roybal-notify:217-221`), `hour12:false` (`qb-time-proxy:1190-1194`), hard-coded 7/20 (`apps/admin/js/campaigns.js:36-39`) |
| LLM price table | 5 copies + 1 divergent | `roybal-ai-office:83-87`, `roybal-ai-ingest:57`, `qb-time-proxy:294`, `roybal-portal:79`, `phone-agent/config.mjs:55`; `roybal-web-agent/guards.ts:253-257` prices `claude-sonnet-5`/`claude-opus-5`, ids used nowhere else |
| Failure surfacing to a human | **6** | toast; colored dot (`app.js:256-270`, `admin.js:36-41`, `board.js:257-265`); silent null; error→"offline"; HTTP 400/500 JSON to a browser nobody reads; `console.error` into a ~24 h log |
| Integration status | 2 | row-exists (`gmail-proxy:157-161`, `qbo-proxy:252-256`) vs prove-by-using (`qb-time-proxy:811-846`) |

Headline count: **11** — five caller-identity conventions plus six ways a failure reaches (or fails to reach) a person. An agent calling into this layer must learn a different envelope, auth recipe, and failure shape per function.

### Evidence

**The lanes are dead and nothing knows.** (live) Gmail: every 15-minute `gmail-inbox-pull` since 2026-09-01 04:15Z returns HTTP 500 `Gmail token refresh failed: invalid_grant`; the throw is `gmail-proxy/index.ts:125`, caught at `387-389`, returned as JSON. QB Time: every `qb-clockin-sweep` since ~2026-09-04 19:38Z returns 400 `Token refresh failed: That refresh_token is invalid` (`qb-time-proxy/index.ts:139-142` → `1283-1285`); the daily pull on 09-05 wrote no `time_entries`. (live) `cron.job_run_details` reports 288 + 288 "succeeded" for those two jobs because `net.http_post` is asynchronous; the only HTTP failure record is `net._http_response`, purged after ~6 h. No function posts an alert on a refresh failure (grep `needsReconnect|reconnect` across functions hits only `qb-time-proxy:838`). The morning brief has no integration-health line (grep `gmail|token|expired|reconnect` in `roybal-brief/index.ts`, `digest.ts` → nothing relevant); its email count is frozen at the last successful pull. The admin Gmail card renders "● Connected" whenever a token row exists (`apps/admin/js/gmailconnect.js:64-68` on `connected: !!data`). QB Time's card is the one honest one — `qbconnect.js:64-68,95-105` shows "▲ Needs reconnect" with the reason — and its own comment records the precedent: "green ● Connected for 19 days while every call that actually needed the token 400'd" (`qb-time-proxy/index.ts:800-808`). The same failure class has now happened three times; two of them are open right now.

**Side effects have no idempotency key.** `sendSms` inserts a row then calls Twilio with no client-supplied key (`roybal-notify/index.ts:334-368`; only kind `campaign` dedupes, `316-324`). `sendEmail` from a browser sends with no key (`gmail-proxy/index.ts:340-349`; only the approval path consumes a row, `376-380`). `pushInvoice` creates a **new** QBO invoice whenever `qboInvoiceId` is absent, with no `DocNumber` lookup (`qbo-proxy/index.ts:345-356`). `time_entries` dedupe is an in-memory map keyed on `qbTimesheetId` (`qb-time-proxy/index.ts:608-611`) with no unique index (`102_time_entries.sql:14-36`). A lost HTTP response or a concurrent pull duplicates a text, an email, a QuickBooks invoice, or a day's hours.

**SMS is never reconciled.** `twilioPost` sends no `StatusCallback` (`roybal-notify/index.ts:247-260`); status is whatever Twilio's immediate response said (`362-365`); the router serves only `/inbound` and `sendSms` (`643-658`). (live) 174 of 175 outbound rows are frozen at `queued`. `supabase/config.toml:53-54` claims the function receives "Twilio webhooks (status callbacks…)" — no such handler exists.

**Money-affecting actions accept the public key.** (live) The live cron commands for the `verify_jwt=true` proxies authenticate with `Bearer sb_publishable_…` and succeed (qbo-payment-pull 2026-09-05 14:30Z), so the gateway admits the key committed at `apps/field/js/config.js:8`. Behind the gateway, `pushInvoice` has no in-code auth — role only decides CRM linkage, and the code explicitly plans for an "anon/machine push" (`qbo-proxy/index.ts:309-313`); `exchangeCode`/`disconnect` are ungated (`259-294`); `qb-time-proxy` leaves `getTimesheets`, `getUsers`, `disconnect` and four more ungated (`747-978`); `gmail-proxy` leaves `getStatus`/`exchangeCode`/`disconnect` ungated (`157-203`). Anyone with the public key can create invoices under any customer name, dump every employee's timesheets, or delete all three token rows.

**Magicplan is dead and still exposed.** `magicplan-proxy` has zero callers (grep of `apps/`, `services/`, `.github/` = 0), `verify_jwt=false` (`config.toml:33-34`), no auth or rate limit (`magicplan-proxy/index.ts:44-70`), and `createProject` writes to the vendor account with the company key (`60-68`). `magicplan-webhook` is `verify_jwt=true` (a vendor webhook can never pass), its signature check accepts any non-empty header (`208-213`), and it writes the era-0 `jobs`/`floor_plans` tables.

### What QBO sync actually does

Six actions (`qbo-proxy/index.ts:252,259,283,297,363,375`): `getStatus` (row exists), `exchangeCode`, `disconnect`, `pushInvoice`, `invoiceLink`, `pullPayments`. Every invoice line is billed to one generic service item — "Restoration Services" or, when the catalog reorg turned that into a category, "Restoration — General" (`52-54`, `ensureServiceItem` `218-237`, `ItemRef` `316-321`); sales tax is a pseudo-line on the same item (`324-330`). The app's line detail (desc/qty/unit/price) is flattened to a description string at the boundary; there is no item, customer, estimate, bill, expense, or category sync in either direction. `pullPayments` reads Balance nightly and applies the pure `payments.ts` rules (adopt-don't-double-count, `payments.ts:1-20`), then writes `field_projects` with a **service-role rev-guarded PATCH** (`429-444`) that bypasses `push_project`/`merge_project_blobs` and the tombstone sweep — the second of two write doors migration 219 was meant to close (`219_revoke_direct_field_writes.sql:17-18`). `pushInvoice` writes no receipt anywhere; `pullPayments` writes a `capture_events` row (`448-453`).

### Is there any way to know when something breaks? — health-signal rating

| Signal | Exists | Durable | Reaches a human unprompted | Note |
|---|---|---|---|---|
| Success receipts (`capture_events` source types `qbo_payments`, `email_pull`, `email_send`, `daily_brief`, `weekly_report`, `crew_digest`, `phone_call`, `office_ai`, `narrative`, `voice`) | yes | yes | Sunday text counts them (`roybal-brief/weekly.ts:25-58`) | receipts for successes only; none for `pushInvoice`, none for a failed pull; the chip line filters `source_type 'assist_action'` (`weekly.ts:46`), which no writer emits, so it can only ever count `email_send` |
| Cost ledger `ai_usage` incl. error-path metering | yes | yes | no | `roybal-ai-office:1817-1838`; deletable by any authenticated user (`201_ai_usage.sql:77-79`) |
| SMS log `sms_messages` | yes | yes (no DELETE, `106:33-47`) | no | status never reconciled |
| Data-mutation history `blob_history` (30/90-day purge, `215:199-217`) | yes | yes | no | whole-blob pre-images |
| Fleet build telemetry `sync_clients` | yes | yes | no | fed `p_build` = `BUILD v165` while `sw.js` is v166 (`config.js:25`, `sw.js:6`) |
| Chip audit `capture_events.result.executed` | yes | best-effort | no | client PATCH, "never blocks the chip" (`assist.js:211-223`); rewritable by any user (`200:235-237`) |
| Cron outcome | **no** | 6 h (`net._http_response`) | no | `job_run_details` says succeeded |
| Integration health / reconnect alert | **no** (QB Time status honest on demand only) | — | no | Gmail card green while dead |
| Client error stream | **no** | — | — | 0 `onerror`/`unhandledrejection` handlers in board/admin/portal; 1 `console.warn` in field |
| Function logs | `console.error` in notify (6), portal (2), brief (3), lead (10), web-agent (16); 0 in the four core AI functions | ~24 h (live) | no | web-agent's header admits "this project's logs show a dead LLM key is a real failure mode" (`roybal-web-agent/index.ts:52-54`) |
| Dead-letter / retry queue | **no** | — | — | board queue retries forever (`data.js:90`); field sync retries per 45 s cycle with no backoff |

**Rating: 2 / 10.** The system keeps good receipts for what *worked* and almost none for what *failed*, and no signal of either kind reaches a person unless they open the right admin card on the right day. Against the north-star: an agent can read the receipts, but it cannot detect that the Gmail lane it depends on has been dead for five days, cannot tell "no email today" from "pull failed", and cannot safely retry a send.

### Severity and why

**Critical (actively wrong in production):** two OAuth lanes silently dead with cron reporting success and one dashboard card lying (F1); invoice creation, timesheet export and credential deletion reachable with the key served on the public website (F2). Both are live now.

**High (structural — must change before the automation backbone):** no integration abstraction or shared kernel — an agent has no named, typed, validated operation to call and no single place to observe a call (F3); no idempotency on the three side effects any retrying automation will hit (F4); SMS delivery never reconciled, so "did the customer get the text" is unanswerable (F5); client failures swallowed by design, so an agent cannot distinguish "nothing to do" from "could not do it" (F8).

**Medium:** QBO flattening and the second write door (F6 — caps QBO reporting fidelity, not company size; categorized reporting and a real catalog require redoing the push contract); one plaintext token row per provider, latest-row-wins, cron auth living only as table literals (F7, growth ceiling — a second entity, mailbox, or QBO company is code, not config); ledgers mutable by any user and triple-purposed, function logging ledger-only with ~24 h retention (F9); Magicplan dead-but-exposed (F10). **Low:** docs and config comments that describe handlers and functions that do not exist (F11).

Structural vs cosmetic: F3, F4, F6, F7, F8, F9 are structural; F1, F2, F5, F10 are fixable in days without touching architecture but are the reason the structural ones matter; F11 is hygiene.

### What cohesive would look like

One **integration kernel** module shared by every function (`_shared/`): one CORS/envelope/`json()`, one `requireCaller()` that returns a typed principal (`user`, `machine:<name>`, `cron`) from exactly one of two conventions (user JWT, or service key + `x-cron-secret`), one `db()`, one price table, one quiet-hours function. Each provider becomes a **connector** exposing named operations with JSON-schema input, a stable output envelope, an `idempotency_key` argument, and a `capabilities()` call. The operation names are the tool names an agent sees: `quickbooks.syncInvoice`, `email.send`, `sms.send`, `time.pullDay`.

Every connector call writes an **`integration_runs`** row (connector, operation, principal, idempotency key, request digest, status, error, latency, external ids) — the receipt `capture_events` already provides for successes, extended to failures and to `pushInvoice`. `getStatus` on every lane proves the credential by using it (the QB Time pattern) and a **`integration_health`** row per connection (last success, last failure, reason) is read by the brief and the admin Today tab; a failed refresh posts one owner text through `roybal-notify` with a 24 h re-send guard. Cron jobs call a thin `runJob(name)` wrapper that records outcome synchronously so `job_run_details` can be trusted, or a nightly `health-sweep` reads `integration_runs` and texts. A Twilio `StatusCallback` route settles `sms_messages.status`.

Side effects become **idempotent at the server**: `sms_messages.idempotency_key unique`, `email_messages` likewise for outbound, `pushInvoice` looks up `DocNumber` before creating, `time_entries` gets a unique expression index on `data->>qbTimesheetId`. Connections move from "latest token row" to a **`connections`** table keyed by `(provider, entity/division)`; token columns are encrypted with `vault` or `pgsodium`; cron auth is generated from `vault.secrets` by a replayable migration rather than scraped from a live row.

Clients get one `report(err, ctx)` that posts to a `client_errors` table (batched, offline-queued) and a global `unhandledrejection` hook; the board's queue gets a dead-letter after N failures. Two options where simplicity trades against ceiling: (a) keep receipts in `capture_events` with a `status` check constraint and a `failed` state (smallest change, keeps one table) versus (b) a dedicated `integration_runs` table (cleaner queries, one more table); (c) owner-text alerting through the existing SMS lane (zero new infra) versus (d) a Supabase log drain to a hosted error tracker (real stack traces, a monthly bill and a second console).

### Preserve

- The approve-by-text execution contract — server re-verifies the `pending_actions` row is `approved` and the right `kind`, executes, consumes `approved→executed`, writes a `capture_events` receipt (`gmail-proxy/index.ts:340-381`; `210_pending_actions.sql:24-60`).
- `qb-time-proxy` `getStatus` proving the credential by using it, and the conditional refresh-token rotation guard (`qb-time-proxy/index.ts:158-166, 811-846`).
- `roybal-notify` `sendSms` invariants: RLS-gated insert before the paid call, settle-never-strand, quiet-hours refusal, reserve floor, campaign dedupe (`roybal-notify/index.ts:262-369`); `sms_messages` deliberately has no DELETE policy (`106_sms_messages.sql:33-47`).
- `ai_usage` per-call metering including the error path (`roybal-ai-office/index.ts:1817-1838`) and the web lane's reserve-before-spend (`227_web_receptionist.sql:147-211`).
- `capture_events` as the universal receipt and `weekly.ts` reading receipts back to the owner (`roybal-brief/weekly.ts:25-58`).
- `qbo-proxy` `payments.ts` pure rules (adopt-don't-double-count, never backward) and update-in-place with `SyncToken` when `qboInvoiceId` is known (`qbo-proxy/index.ts:345-352`).
- `gmail-proxy` `gmail_id` unique index and 10-minute cursor overlap (`208_email_lane.sql:35`; `gmail-proxy/index.ts:263-267`).
- `blob_history` pre-images with regression detection and `sync_clients` fleet telemetry (`215`, `226`).
- `supabase/config.toml` verify_jwt pins with the recorded 2026-08-13 trap (`config.toml:1-21`).
- The phone agent's closeout receipt with the `llmFails` marker (`services/phone-agent/server.mjs:160-180`).
- The pure-helper test discipline: `payments.ts`, `approve.ts`, `campaign.mjs`, `emailmatch.ts`, `crewtoday.mjs`, `weekly.ts` — 75 assertions passing across those six (the full function test set is ~210+), the pattern the kernel should follow.

---

## 13 + 14. Type safety, testing, CI, dependencies and tooling health

### What the pattern is today

There is no verification layer between an edit and production. The repo has one workflow, and it is a deploy: `deploy-field.yml` triggers on pushes to `main` touching `apps/field|admin|board/**` (`.github/workflows/deploy-field.yml:10-19`), copies the three directories wholesale (`:36-38`) and force-pushes `gh-pages` (`:52`). It has no `pull_request` trigger, no `npm test`, no lint, no type-check, still lists a deleted branch (`:13`), and was last edited 2026-06-26 (`git log -- .github/workflows/deploy-field.yml`). The other four surfaces — 14 edge functions, the Cloudflare site, the Vercel portal, the Fly phone agent — deploy by hand from a laptop (`README.md:110-123`, `apps/site/CUTOVER.md:6-7`, `services/phone-agent/Dockerfile:1-3`), and the edge-function path already caused an outage because MCP deploys ignore the `verify_jwt` pins (`supabase/config.toml:3-15`).

Consequence, READ not inferred: **`main` is red and the red state is in production.** `apps/field/js/config.js:25` says `BUILD = "v165"`; `apps/field/sw.js:6` says `roybal-field-v166`; `apps/field/test/build.test.mjs:17` fails on exactly that (`node test/build.test.mjs` → `FAILED: 1`). The drift came from PR #181 (`211abb4`, 2026-09-04, which touched `sw.js` only), the workflow deployed it, and `origin/gh-pages` (fetched 2026-09-05) carries `BUILD = "v165"` at `js/config.js:25` next to `roybal-field-v166` at `sw.js:6`. Because the field suite is a single `&&` chain (`apps/field/package.json:10`) and the root `test` script chains field → board → functions (`package.json:11`), that one failure also silences the remaining 26 field files, all 4 board files and all 13 function files. The build-gate test exists precisely so "a stale device can[not] report a build it isn't running" (`build.test.mjs:1-4`); the gate is unarmed today (`app_settings.min_field_build = 0`, inventory §11), so the damage is latent — but the mechanism that would have caught it has been failing for two days with nobody told.

**Type safety: none is enforced, and the artifacts that suggest otherwise are dead.** `tsconfig.base.json:1-14` declares `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; nothing extends or references it (grep over the tree excluding `node_modules` returns only the inventory doc). `typescript@5.9.3` is installed at the root (`package.json:23`, `package-lock.json:6588-6589`, `node_modules/.bin/tsc` present) and invoked by nothing. The 69 client JS files across field/admin/board/portal carry **0** `@ts-check` directives and **0** JSDoc type tags. The 26 Deno `.ts` files under `supabase/functions` are executed in tests via `node --experimental-strip-types` (`package.json:12`, `services/phone-agent/package.json:7-8`), which strips annotations and checks nothing; `deno` is not installed on the development machine (`which deno` → not found), there is no `deno.json`, and `deno.lock` (last touched 2026-08-13) has no consumer. INFER: the Supabase deploy bundler does not fail on type errors either, so a type error in an edge function has never been able to stop anything. The one type-checker that is wired — `astro check` (`apps/site/package.json:11`) — cannot run: `@astrojs/check` is not installed (`node_modules/@astrojs/` holds compiler, internal-helpers, markdown-remark, prism, sitemap, telemetry) and `build` (`:9`) does not call it. No `supabase gen types` output exists anywhere (inventory §9), so the 53-table schema has no compile-time shape in any runtime.

**Lint/format: none.** No eslint, prettier, biome or `.editorconfig` at any level; no `.nvmrc`; no Dependabot/Renovate (`.github/` contains the one workflow). Conventions travel in file-header comments (100 % of non-test source files have one, inventory §10) — good discipline, unenforceable.

**Tests: 49 files, 8,208 lines, good where they exist, absent where the risk is.** Wired into `npm test`: 28 field + 4 board + 13 function files (`apps/field/package.json:10`, `apps/board/package.json:10`, `package.json:12`); the phone agent's 13 tests run only from its own directory (`services/phone-agent/package.json:8`); three field files are on disk but unwired (`test/dryingcalc.test.mjs`, `test/sms.test.mjs`, and `js/calibration.test.mjs`, which sits in `js/` and is therefore deployed to the public origin). `README.md:84` still says 25.

### How many patterns coexist (the Frankenstein question)

Seven test-harness styles: (1) hand-rolled `ok()`/`failures++` scripts (27 files, e.g. `build.test.mjs:10`); (2) bare `node:assert`; (3) `node:test` (4 files: `guards.test.mjs`, `persona.test.mjs`, `agent.test.mjs`, `js/calibration.test.mjs`); (4) a jsdom + `fake-indexeddb` boot smoke that imports the real `app.js` (`apps/field/test/smoke.mjs:3-5,13,58`, 105 assertions); (5) a fake-server harness that replaces `globalThis.fetch` and re-implements the `push_project` RPC merge in JS (`apps/field/test/sync.mjs:20-25,41-44`, 76 assertions); (6) source-grep invariant tests (`roybal-web-agent/guards.test.mjs:318-321` reads `index.ts` as text and asserts it touches no `/rest/v1` table path); (7) byte-equality drift guards (`roybal-brief/crewdigest.test.mjs:18-24`). Four type postures: untyped browser JS, TS stripped in Deno, TS imported into Node via strip-types, Astro's check (uninstalled). Five code-sharing mechanisms: `../../js` URL-path imports (56 statements across 16 admin/board files, e.g. `apps/board/js/board.js:7-8,17-18`, `apps/admin/js/admin.js:8-11`), byte copies with one drift test (`schedule.js` ×3), Docker `COPY` at build (`services/phone-agent/Dockerfile:8-9`), hand-mirrored JS↔SQL lists (`apps/field/js/merge.js:33` vs `217_push_project_rpc.sql:115`, `241_merge_delete_tombstones.sql:41,170`, `243_losstypes_merge_union.sql:17`), and a Node re-implementation of a TS module (`apps/site/scripts/postbuild.mjs:57-65`). Five deploy mechanisms (CI, `supabase functions deploy`/MCP, `wrangler pages deploy`, Vercel import, `fly deploy`). This is not one system with tests; it is seven small conventions that happen to coexist, held together by an `&&` chain.

### Evidence

**What the tests cover and never touch**

| Layer | Tested | Never touched |
|---|---|---|
| Pure engines | `schedule.js` (705-line test), `merge.js`, `phasematch.ts`, `guards.ts`, `fincalc.js`, `digest.ts`, `payments.ts`, `approve.ts`, `selections.ts`, `xactimate.js`, `boardpush.js` | — |
| Edge-function handlers | **0 of 14 `index.ts` files** are imported by any test; the only reference is the text grep at `guards.test.mjs:319` and a comment at `approve.test.mjs:89` | HTTP routing, auth gates, cron-secret checks, token refresh, PostgREST calls, idempotency — 8,460 LOC across the 14 `index.ts` files |
| Renderers | field `app.js` boot + home/help/project/moisture-map screens via `smoke.mjs` | `forms.js` beyond what smoke reaches (3,933 lines / 227 KB), `board.js` (3,042 lines, 0 tests), all of admin (2,801 lines) and portal (1,084 lines) |
| Field modules with no test import | — | `assist.js` (769), `formkit.js`, `officeai.js`, `voice.js`, `qbtime.js`, `qbo.js`, `gmail.js`, `pdf.js`, `photoexport.js`, `dictate.js`, `help.js`, `pricing.js` |
| Board modules with no test import | — | `board.js`, `actions.js`, `data.js`, `assistctx.js` |
| SQL / RLS | **0 tests read any `.sql` file**; `sync.mjs` tests the client against a JS mirror of the RPC that "Mirrors the SQL exactly" (`sync.mjs:41-44`) | the real `push_project`, `merge_project_blobs`, every RLS policy (100 policies), every trigger, every cron |
| Model output | — | no golden set, no eval (functions-ai reader) |

**How a change in one app silently breaks another — nine mechanisms, all READ**

1. Admin and board import 14 field modules by relative URL (`apps/board/js/board.js:7-8,17-18`; `apps/admin/js/admin.js:8-11`); no package boundary, no contract test; `board.js` has zero tests to notice.
2. Field imports the board's engine the other way (`apps/field/js/myweekcalc.js:17-18`).
3. Admin and board load field's stylesheet (`apps/board/index.html:15`, `apps/admin/index.html:9`).
4. The field service worker is registered at scope `/` (`apps/field/js/app.js:2675`) and serves every same-origin asset — including `/board/*` and `/admin/*` — stale-while-revalidate (`apps/field/sw.js:89-92`) and precaches `board/js/schedule.js` (`sw.js:27`); a board deploy takes effect on the second open, and INFER a session can run field at one build and board at another.
5. `schedule.js` exists three ways (board, `roybal-brief/schedule.js`, the Fly image via `Dockerfile:9`); one copy is drift-tested (`crewdigest.test.mjs:18-24`), never in CI; the Docker copy is unguarded.
6. `zip.js` is a self-declared "VERBATIM COPY" with no guard (`apps/portal/js/zip.js:3-5`); `zip.test.mjs` never reads the portal file.
7. The 12-key collection list lives in JS and four SQL files; the SQL side is the only write path (`apps/field/js/config.js:11-17`, migration 219); no test reads SQL.
8. 26 Deno files and 69 client files share 53 tables with no generated types; a column rename in a migration has no compiler or test to trip.
9. The workflow republishes all three apps on any path change and root `npm test` masks board/function failures whenever field is red (as now).

Two smaller silences: 26 empty `catch {}` blocks in field JS and 5 in board (regex `catch\s*(\([^)]*\))?\s*\{\s*\}`), and 0 `console.*` calls in board/admin/portal.

**Dependencies and vendored code**

| Item | State | Evidence |
|---|---|---|
| Runtime npm deps, four client apps | **zero** — a strength (no supply chain, no build) and a cost (no bundler, no minify, no split) | `apps/field/package.json:12-14` (dev only), no manifest in admin/portal |
| Vendored pdf.js | **4.10.38** (`apps/field/assets/vendor/pdfjs/pdf.min.mjs`, 352,645 + 1,375,838 B); registry latest is **6.3.289** (registry.npmjs.org, 2026-09-05; author-reported, not re-verifiable offline) — two majors behind; the one live high-severity pdf.js advisory, CVE-2026-16633, affects 5.6.83 ≤ v < 6.2.108 (osv.dev, likewise author-reported), so 4.10.38 is outside it; INFER the 2024 font-execution CVE was fixed at 4.2.67, also below | vendor dir listing |
| Vendored qrcode | no version string, 51,907 B | `apps/field/assets/vendor/qrcode/qrcode.mjs` |
| LICENSE files | **none** anywhere under `apps/` or `services/` (Apache-2.0 / MIT headers inline only) | `find . -iname 'LICENSE*'` |
| Deno std | `0.168.0` ×11, `0.177.0` ×3, all importing the deprecated `serve` | grep |
| supabase-js | `esm.sh/@supabase/supabase-js@2` major-only ×4; `deno.lock:4` resolves 2.110.8 but nothing consumes the lock — INFER each deploy may resolve a different minor | `deno.lock:1-30` |
| `ws` | root lock 8.20.0 (`package-lock.json:7287-7288`, jsdom transitive, dev only) is flagged high by `npm audit` (range 8.0.0–8.20.1: uninitialized-memory disclosure, fragment DoS); phone-agent's runtime `ws` 8.21.1 (`services/phone-agent/package-lock.json:15-16`) audits **clean (0)** | `npm audit --package-lock-only`, 2026-09-05 (audit tallies author-reported; lock versions verified) |
| Astro | 5.18.2 (`package-lock.json:2325-2326`); root audit 8 high / 1 low, site audit 6 high / 1 low — astro (`define:vars` XSS: site uses 0 `define:vars`; server islands: static build), vite 8.0.1, sharp 0.34.5, postcss, js-yaml 4.1.1, picomatch 4.0.3, form-data 4.0.5, esbuild 0.27.7. All are build-chain packages; nothing here ships to a browser. The audit's vulnerable range `<=7.0.9` implies (INFER) the current Astro major is ≥7 | same |
| CDN scripts | zero in live apps; of the 20 `design-system/**/index.html` reference pages, 12 load unpinned `cdn.tailwindcss.com` and 6 load `unpkg.com/lucide@latest`, none with `integrity=` (reference pages only) | `design-system/brand/logo/index.html:8` (tailwind), `design-system/components/buttons/index.html:9` (lucide) |
| Lockfile hygiene | root lock still resolves deleted `apps/mobile`, `apps/web`, `packages/shared` as `extraneous` | `package-lock.json:31,79,7434` |
| Expo SDK | **N/A** — no Expo in the tree since PR #117; only the stale lock entries remain | |

**Bundle and mobile load (measured).** `index.html` (1,884 B) loads one module, `js/app.js` (`apps/field/index.html:39`), which has 28 static imports and 0 dynamic ones; the static closure reaches **42 of 44** field modules (only `gmail.js` and `pricing.js` are off the boot path) plus the two board files: 44 files, **923,584 B raw / 275,842 B gzip of the concatenation** (per-file gzip, what HTTP actually transfers: 299,113 B), plus CSS 56,643 B raw / 14,475 B per-file gzip. `forms.js` alone is 227 KB and `app.js` 148 KB. Only pdf.js is lazy at runtime (`apps/field/js/pdf.js:10-14`), but all 1.78 MB of vendor is in the service worker's OPTIONAL install list (`sw.js:34-36`), fetched best-effort at install via `Promise.allSettled` (`sw.js:46`), so the first visit pulls it. Verdict: at ~290 KB gzip over ~45 requests on HTTP/2, first load on job-site LTE is acceptable and every later open is cache-served; this is not a ceiling. The cost is that every new feature loads for every crew member at boot, and stale-while-revalidate means a fix lands on the second open — which is exactly why the build-lockstep test matters.

### Severity and why

**High.** Nothing here caps headcount; everything here caps how safely the system can change, and the owner's stated model is AI-assisted development with no full-time developer. An agent editing an edge-function signature has no compiler, no handler test and no CI to tell it what it broke; it has a red suite that hides 43 other files. The north-star backbone requires "typed, described, validated, idempotent operations exposable as LLM tools" — today the only typed contracts are the 11 JSON-schema read/phone tools in `personas.ts:78-146,166-221`; the 17 write actions are prose `desc` strings (`:246-362`), and there is no type system anywhere to declare them in. The test corpus proves the team can write good tests for pure modules; the service layer agents will call — the `index.ts` handlers, the RPCs, the RLS — is the one layer with zero.

Structural (must change before the backbone): findings 1–4. Incremental: 5 and 8. Hygiene (Low): 6, 7 and 9.

### What cohesive would look like

One green `npm test` that runs field, board, functions and phone-agent without `&&` short-circuiting (a runner, or `node --test` across globs), executed by a `pull_request` workflow alongside `deno check supabase/functions/**/index.ts` and `tsc --noEmit -p tsconfig.json` with `checkJs` + JSDoc over the client apps — no build step required, the zero-dependency posture survives. `supabase gen types typescript` committed and imported by every function (and as `@typedef`s by clients) so a migration rename fails a check instead of a customer. A single `shared/` directory (served by the same `serve.mjs` path mapping) replacing `../../js`, `cp`, and Docker `COPY`; a test that reads the SQL collection lists against `merge.js`. Deploy gated on green, with `test/`, `README.md`, `package.json`, `serve.mjs` excluded from the payload. `biome` (one binary, no config) for lint/format. Dependabot for the three lockfiles; LICENSE files beside vendor; pdf.js on 6.x; std on one version behind `Deno.serve`. Where simplicity trades against ceiling, the options are: (a) JSDoc + `checkJs` (no toolchain, weaker types) vs TypeScript + a bundler (real types and code-splitting, but a build the owner must operate); (b) shared code as a served path (today, zero tooling) vs a real package with a bundle step (independent deploys of admin/board, but the same build cost). Both are real trade-offs for a solo operator; the review presents them and does not pick.

### Preserve

The pure-engine + thin-handler split (`schedule.js`, `merge.js`, `phasematch.ts`, `guards.ts`, `digest.ts`) and its 8,208 lines of tests; the jsdom boot smoke; the fake-server sync harness; the source-invariant and drift-guard tests; `build.test.mjs`; `tsconfig.base.json`'s strict flags (just wire them); the zero-runtime-npm posture of the client apps); the header-comment convention; the site's `postbuild.mjs` endpoint and parity guards; the four zero-dependency `serve.mjs` dev servers; the assembly step of `deploy-field.yml` (add gates in front of it, do not replace it).

---

## 15. Performance and scalability — two horizons, plus organizational scalability

### What the pattern is today

The unit of storage, transfer, refresh, and audit is the whole job document. A field save rewrites a 50–227 kB `field_projects.data` blob through `push_project` (`supabase/migrations/241_merge_delete_tombstones.sql:193-282`), which takes a `FOR UPDATE` lock, runs the plpgsql merge, and then fires the trigger stack: touch (`100_field_projects.sql:32`), `stamp_updated_by` (`216_individual_logins.sql:139`), trash capture (`214_field_projects_trash.sql:46`), a `blob_history` pre-image with lz4 compression and a 60-minute rolling bucket (`215_blob_history.sql:179`; `216:195-215`), the `field_photos` reconcile (`224_photo_projection_trustworthy.sql:216-219`), plus a `sync_clients` upsert inside `_sync_guard` on every RPC call (`226_sync_client_telemetry.sql:69-76`). Readers mirror the writers. The board pulls three entire tables every 20 seconds per open tab and recomputes the full schedule (`apps/board/js/board.js:205-221,226-246`; `apps/board/js/data.js:150-163,168-187`). The admin boots the field sync engine and inflates every referenced photo into the office browser's IndexedDB (`apps/admin/js/admin.js:34,235`; `apps/field/js/sync.js:478-482`; `apps/field/js/media.js:102-114`). The field app reads all `coordination_jobs` to link tiles (`apps/field/js/boardpush.js:206-209`). Every edge function and the phone agent read tables with a bare `limit=N` and filter in JavaScript (`supabase/functions/roybal-ai-office/index.ts:1363-1364`; `services/phone-agent/tools.mjs:38-44`). There is no Realtime subscription anywhere (grep `realtime` across the four client apps: 0 hits) and no server-side job queue; refresh is polling, and background work — schedule reflow, SMS campaigns — runs in whichever browser tab is open (`board.js:247-255`; `apps/admin/js/campaigns.js:217-232`).

Against the north star this is one problem wearing two costumes. An agent that wants one moisture reading, one equipment placement, or one line item must fetch the whole job and walk it. An agent that wants a schedule must run `schedule.js` itself, because the server has no scheduling authority. An agent that executes a board reflow gets N sequential client saves with no transaction. The performance shape and the automation shape are the same shape.

### How many patterns coexist (the Frankenstein question)

Eight refresh/consistency models for one dataset:

1. Field: IndexedDB, 45 s cursor pull, 1.5 s debounced push, server merge (`sync.js:606-623`; `apps/field/js/supa.js:268-273`).
2. Board: localStorage cache re-parsed per call, 20 s full re-read of three tables, client rev CAS (`data.js:35-38,150-187`).
3. Admin: the field engine (full replica with media) plus direct PostgREST reads with hard caps (`apps/admin/js/leads.js:94,152`; `apps/admin/js/analytics.js:51,58-66`).
4. Portal: one service-role gateway POST per view, media inlined as base64 by N+1 storage fetches (`supabase/functions/roybal-portal/index.ts:137-143,242-256`).
5. Edge readers: unpaged `limit=300/500/1000` (`supabase/functions/roybal-brief/index.ts:130-131,218-219`; `roybal-ai-office/index.ts:1372,1410`; `supabase/functions/roybal-notify/index.ts:555`; `supabase/functions/qbo-proxy/index.ts:381-382`).
6. Node phone agent: same read shape plus in-memory per-caller limits that pin it to one machine (`tools.mjs:19-27`).
7. pg_cron → `net.http_post`, asynchronous, so cron cannot see HTTP failure ((live) 288 + 288 "succeeded" runs for two dead jobs).
8. Web receptionist: DB-serialized caps under an advisory lock and reserve-before-spend (`227_web_receptionist.sql:60-110,145-166`) — the one lane whose limits would survive a second process.

Pagination alone has five idioms: bare `limit=N`; 20×1000 (`data.js:150-163`); 6×1000 (`apps/field/js/myweek.js:60-72`); 5×1000 (`analytics.js:58-66`); Range-header paging (`roybal-ai-office/index.ts:110-126`) — while `roybal-ai-narrative/index.ts:69-73` still sums `ai_usage` unpaged. Indexing has one idiom: `updated_at` only, on every blob table (`100:36`; `101:41,66`; `102:27`). The only jsonb expression indexes in the schema are three web-receptionist partials and one channel partial (`227:321-338`).

### Evidence

#### Horizon A — what hurts today (~10 users)

| Symptom | Measured | Cause | Where |
|---|---|---|---|
| Whole-blob writes | (live) `INSERT field_projects` 4,254 calls @ 207 ms mean (883 s); `push_project` 2,064 @ 190 ms; blobs avg 50 kB, max 227 kB | 5 triggers per write (3 on insert) plus the `_sync_guard` upsert, incl. lz4 pre-image + photo reconcile. INFER: the mean is the trigger stack over the row size; the INSERT statement shape is the PostgREST ON CONFLICT upsert (`supa.js:133-142`, `resolution=merge-duplicates`, still used by the non-RPC delete path at `sync.js:412` and historically by the pre-219 push path) — it cannot be `push_project`'s insert branch, since only 42 `field_projects` rows exist. The code itself records the "Jul-2026 disk-IO burn" from no-op rewrites | `241:252-259`; `215:53-71`; `216:195-215`; `224:195-219`; `226:69-76` |
| Board polling fan-out | (live) `coordination_jobs` SELECT 24,847 calls; `crew_members` 24,846; `time_entries` 31,255 @ 22 ms (679 s) | every open tab re-reads three whole tables every 20 s and recomputes the schedule; all 1,193 time entries cached in localStorage and re-parsed per call | `board.js:205-221`; `data.js:150-187,35-38` |
| Office replica | admin pulls every blob and downloads every referenced photo; Today/Jobs cost O(all jobs) per paint | `admin.js:34,235`; `sync.js:478-482` |
| Portal view | ≤24 photos + 6×8 doc pages fetched one by one from storage and returned inline as base64 in one JSON body; header still promises signed URLs | `roybal-portal/index.ts:5-7,137-143,242-256` |
| Read tools already wrong | `hoursLookup` reads `time_entries` with `limit=1000`; (live) the table holds 1,193 rows → ~190 dropped silently | `roybal-ai-office/index.ts:1409-1411` |
| Unindexed JSON filters | nightly pull and 15-minute sweep filter `data->>qbJobcodeId` / `data->>date` on a table whose only index is `updated_at`; Leads filters `data->>stage`; `coordination_job_patch` scans `data->>contactId` | `102:27`; `supabase/functions/qb-time-proxy/index.ts:371-376,601-606`; `leads.js:94`; `230_coordination_job_patch.sql:144-146` |
| Ledger growth, no retention | (live) `capture_events` 4,504 rows, 3,500 of them `emailPull` (one per 15-min tick); `ai_usage` 998; no purge for either (grep: 0) | `200_ai_backbone.sql:166-167`; `201_ai_usage.sql:66-67` |
| Sign-out re-merge | resetting sync bookkeeping forces every job through the merge path from base 0 | `sync.js:631-639` (comment `567-580`) |

#### Horizon B — what breaks at 100+ people, dozens of crews, tens of thousands of jobs

**Silent truncation is the failure mode, not slowness.** Every server-side and office-side reader has a hard cap and no "more" signal:

| Reader | Cap | Effect past the cap |
|---|---|---|
| board `getAll` | 20 pages × 1,000 | newest hours dropped; schedule runs on stale data (`data.js:150-163`) |
| ai-office `boardRows` | 300 jobs / 100 crew / 1,000 entries | assistant answers from a subset (`index.ts:1363,1372,1410,1449`) |
| roybal-brief | 300 field + 300 board blobs; 500/100 for crew digest | morning brief omits jobs (`index.ts:130-131,218-219`) |
| phone agent `availability` | 300 / 100 / 1,000 | receptionist quotes from a subset (`tools.mjs:38,69-70`) |
| field My Week / board link | 500 board rows; unlimited (server default) | `myweek.js:87`; `boardpush.js:206-209` |
| admin leads / analytics | 200 and newest 100 leads; 500 jobs; 5,000 entries | open leads vanish once lost leads pass ~100 (`leads.js:94,152,336-337`; `analytics.js:51,58`) |
| notify inbound | 500 `unified_jobs` scanned in memory | inbound text unmatched (`roybal-notify/index.ts:555`) |
| qbo payments | 500 blobs | invoices past 500 jobs never reconciled (`qbo-proxy/index.ts:381-382`) |
| portal crew | 100 | `roybal-portal/index.ts:321` |
| board assistant context | 50 jobs | `apps/board/js/assistctx.js:19,29` |
| field push | 5 MB row | job silently skipped (`sync.js:48,261`) |
| tombstones | 2,000, oldest dropped | deletes can resurrect (`apps/field/js/merge.js:59-64`; `243_losstypes_merge_union.sql:46-62`) |

Beyond caps: (1) no partitioning or archival story for `field_projects`, `blob_history`, `capture_events`, `ai_usage`, `sms_messages` — every table is one heap with a timestamp index; (2) 26 restrictive policies call `auth.email()` per row (`204_phone_agent_rls.sql:12-31`; `205_brief_machine_rls.sql:16-23`; `228_contacts.sql:105-114`; (live) 36 `auth_rls_initplan`, 255 `multiple_permissive_policies`), so policy cost scales with row count; (3) the storage bucket is a flat sha256 namespace with no per-job prefix, no listing, and no delete path anywhere in code (grep: 0), and one migration states that objects are never deleted while another's no-FK design depends on it (`supa.js:211-222`; `214:9-10`; `221_field_photos_table.sql:62-64`; (live) 1,881 objects / 418 MB) — quota, GC, and per-job export all require a re-key later; (4) no Realtime, so notification cost is tabs × tables ÷ 20 s; (5) scheduling authority is the browser — dates on disk are whatever the last tab computed, reflow is N sequential saves with a conflict re-entering `refresh()` mid-loop (`board.js:187-191,247-255`), and three runtime copies of the engine are synced by `cp` (`apps/board/js/schedule.js`; `roybal-brief/schedule.js`; `services/phone-agent/Dockerfile:9`); (6) one settings row (uuid `…-01`, hard-coded in 7 files, `apps/board/js/settingsync.js:19-25`), one token row per provider selected by `.limit(1).single()` (`qbo-proxy/index.ts:76-77`; `supabase/functions/gmail-proxy/index.ts:110-111`; `qb-time-proxy/index.ts:107-112`), and one phone-agent machine because limits live in a `Map` (`tools.mjs:19-27`; `services/phone-agent/fly.toml:10-12`; `services/phone-agent/README.md:64-65`).

**Cheap now, expensive later** — structural items whose cost is near zero at today's row counts:

- Wrap `auth.email()`/`auth.uid()` in `(select …)` across the 26 restrictive policies: one migration now; per-row function evaluation at 10k rows later.
- Expression indexes on `time_entries((data->>'qbJobcodeId'),(data->>'date'))`, `coordination_jobs((data->>'stage'))`, `((data->>'fieldJobId'))`, `((data->>'contactId'))`, and a unique index on `qbTimesheetId` (`102:14-36` has none; dedupe is app-side at `qb-time-proxy/index.ts:608-611`).
- One paged reader shared by every server consumer, replacing bare `limit=N` — the loop already exists in `myweek.js:60-72` and `roybal-ai-office/index.ts:110-126`.
- Prefix storage keys by job (or add a `media` table mapping hash → job refs) while there are 1,881 objects; re-keying 418 MB later is a migration with a client cutover.
- Retention or month partitions on `capture_events`/`ai_usage` (the purge shape exists at `215:199-218`) before `emailPull` alone writes ~35k rows a year.
- Move phone-agent limits into Postgres via the `227` pattern before a second line or region is wanted.
- A settings table keyed by scope instead of a reserved uuid in `coordination_jobs`.

#### Organizational scalability

Every place the model assumes today's company size, measured:

| Assumption | Where |
|---|---|
| One company: `COMPANY` const with owner email and signatory; address/phone re-typed as literals | `apps/field/js/model.js:6-22`; `apps/field/js/forms.js:1894-1899` |
| One office phone: 19 literal sites (18 in `apps/portal` + the gateway) | `apps/portal/js/portal.js:152,308,349,398,494,502,523,545,569,637-638`; `photos.js:194,209`; `packet.js:111,122`; `index.html:24`; `packet.html:28`; `photos.html:28`; `roybal-portal/index.ts:87` |
| One region/timezone: `America/Anchorage` in 9 files; "Fairbanks / North Pole" in three persona prompts | notify, qb-time, qbo, voice, web-agent, brief, portal, `phone-agent/server.mjs`, `campaigns.js`; `roybal-ai-office/personas.ts:17,32,45`; `roybal-web-agent/persona.ts:44-49` |
| One work calendar and shift for everyone: global `hoursPerDay`, default 10 in the engine and 8 in three UI fallbacks; settings row `{workDays,hoursPerDay,holidays}` | `schedule.js:14,634`; `board.js:462,467,1855`; (live) settings row |
| Flat crew: name/phone/email/free-text role/rate/colour/outDays/bio; no structured skills or certs (only a free-text `bioCerts` blurb, filled on 1 of 11 rows), no team, lead, or per-person capacity; LWW rows with no rev; login link = email string; "9-person crew" | `board.js:2783-2792,2850-2857`; `apps/board/js/crewmerge.js:7-16`; `101_coordination.sql:51`; (live) `crew_members` keys |
| Roles: `user_role` = admin/tech/viewer/office; consulted only by `is_admin`, `_sync_guard`, `coordination_job_patch`, `contact_resolve`, `field_photos` RLS; every other table `using(true)`; signups default to `tech`; public signup on | `001_initial_schema.sql:42,60-67`; `216:27-31,50,53-59`; `218_sync_rpcs_and_build_gate.sql:67-72`; `246_lead_triage_grant.sql:47-52`; `228:265-270`; `221:113-131`; `100:44-46` |
| Machine identities by email string in 26 restrictive policies + in-function checks; a third agent inherits full rights by default | `204:12-31`; `205:16-23`; `228:105-114,267` |
| One approver: `OWNER_CELL` is the sole approve-by-text authority with no role lookup; read in 6 edge functions and the phone agent; `ALERT_CELLS` is consulted only for lead and web-agent alerts | `roybal-notify/index.ts:400-401`; `roybal-web-agent/index.ts:82`; grep |
| One QBO company and one service item for every invoice line; one mailbox; one Twilio number | `qbo-proxy/index.ts:52-54,76-77,316-321`; `gmail-proxy/index.ts:110-111`; `roybal-notify/index.ts:55` |
| No division / cost center / location / tenant column anywhere (grep across migrations and apps: 0); restoration and GC share one `TYPES` list and one board; `jobType` is a two-value blob key; `unified_jobs` carries carrier/adjuster/owner but no org dimension | `board.js:22-38`; `model.js:102`; `200:84-107` |
| "Shared crew account" login copy in two apps; "Everyone shares one login" help text | `admin.js:206`; `board.js:293,3009` |
| Subcontractors: `contacts.role` admits `sub`, but subs have no login class, no crew slot, no RLS scope | `228:54` |
| Phone agent: one Fly machine by design | `fly.toml:10-12`; `tools.mjs:19-27` |

Can the model represent multiple crews with leads, multiple office roles, divisions, subcontractors, multiple locations? Read literally: crews are expressible only as `crewIds[]` on jobs and phases (`board.js:304-305,702-706,1728-1731`) — nothing names a crew as an entity or a lead; office roles collapse to one `office` enum value with no per-action permission; divisions and locations have no column, no settings scope, no calendar, no QBO mapping; subcontractors are a contact role string. None of these are cosmetic. Each is a missing table or column that every reader would have to learn.

### Severity and why

**High.** Nothing is failing under load today — the live means are hundreds of milliseconds, not seconds — so this is not Critical. But the structure caps growth in three independent ways and each blocks the automation backbone. Whole-blob storage makes per-item reads and writes impossible without the merge protocol, which is why the read tools full-scan and the audit trail is a diff of two 50 kB documents. Client-side authority for schedule and campaigns means an agent cannot ask the system to do the work; only a browser can. Every reader's cap fails silently, so the first symptom at scale will be wrong answers — missing hours, vanished leads, a brief that omits jobs — not errors. The organizational singletons carry the same severity: a second crew lead, a second approver, a second QBO company, or a second office is a code change across many files rather than a row.

### What cohesive would look like

Rows for the entities agents must address — readings by location and date, equipment placement/removal, line item, photo ↔ room ↔ line item, crew member with skills, schedule assignment — with the blob kept as a materialized document rather than the source, the direction `docs/Sync_Rearchitecture_Plan.md:209,345` already names as Phases 3–4. Server-authoritative scheduling: `schedule.js` behind one entry point that returns a plan and applies it atomically, with the board as a viewer. One paged, indexed read layer shared by browsers, functions, and agents, with an explicit `hasMore`. Change notification by Postgres Realtime or a lightweight changes feed instead of tabs polling three tables. Retention and partitioning declared per ledger table. Storage keyed per job with a GC path. An org dimension — `division`, `location`, `crew` as entities; settings, calendar, approver, and token rows keyed by them — introduced as columns now while every table has fewer than 100 rows.

Where simplicity trades against ceiling, the options are: (a) keep the blob and add expression indexes, paged readers, and Realtime — cheapest, holds to perhaps 50 users, does not fix per-item addressability; (b) project rows from the blob by trigger (the `field_photos` pattern, `224`) for the entities agents need — moderate, clients unchanged, extra write cost per save; (c) rows as source with the blob generated for the offline client — the full Phase 4, largest change, the only option that removes the JS↔SQL merge-parity requirement.

### Preserve

- `push_project` as the single server-authoritative write door: `FOR UPDATE`, base-rev check, self-echo guard that refuses no-op rewrites (`241:193-282`).
- `merge_project_blobs` deterministic rules and the JS↔SQL parity discipline (`243:13-144`; `merge.js`).
- `schedule.js` as a pure, DOM-free, tested engine (887 LOC, 88 tests) — already the right shape to move server-side.
- DB-serialized caps under an advisory lock and reserve-before-spend (`227:60-110,145-211`).
- `blob_history` lz4 pre-images, 60-minute rolling bucket, regression detection, nightly purge (`215:53-71,199-218`; `216:160-215`).
- Content-addressed, idempotent media upload and the 8 kB offload threshold (`supa.js:211-222`; `media.js:35-37`).
- Paged readers that learned the 1,000-row lesson (`myweek.js:60-72`; `data.js:150-163`; `roybal-ai-office/index.ts:110-126`).
- `_sync_guard` min-build gate and `sync_clients` fleet telemetry (`226:38-80`).
- `contacts` with generated `phone_norm`/`email_norm` and partial indexes (`228:51-74`) — the one properly indexed relational spine.
- `ai_usage` per-call cost ledger with STT/TTS split (`201`; `roybal-ai-office/index.ts:1788-1807`).
- The plans that already name the destination: `docs/Sync_Rearchitecture_Plan.md` Phases 3–4 and `docs/Board_Sync_RPC_Plan.md:111-138` Tier 2.

---

## 16. AI-maintainability

### What the pattern is today

AI is the developer of record. 294 of 489 commits carry a Claude co-author trailer (307 trailer lines; some commits carry two) and 114 are authored directly as "Claude" (`git log`); the last fifteen subjects are all PR merges in the repo's narrative house style. So "can a fresh Claude Code session understand this repo" really means "does the tree tell its next author the truth, and does it push back when that author is wrong". The answer splits by altitude.

At file altitude the repo is unusually well documented. 103 of 103 non-test source files across field, admin, board, portal, the phone agent and the 14 edge functions open with an explanatory comment block (measured), and most are WHY-blocks: `supabase/config.toml:1-21` narrates the 2026-08-13 verify_jwt outage and the exact re-check command; `supabase/migrations/241_merge_delete_tombstones.sql:1-12` narrates the Fidler 187-photo incident that forced tombstones; `supabase/functions/roybal-web-agent/persona.ts:1-30` is a decision record; `apps/field/js/config.js:19-24` explains why BUILD is baked in. TODO/FIXME count across the source is 1 (grep). This is why sessions survive at all.

At system altitude there is nothing. No `CLAUDE.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `.editorconfig` or `.nvmrc` exist (find at root); `.claude/` is gitignored (`.gitignore:18`) and holds only a board launch config. The entry points a fresh session reads first are wrong exactly where it matters: `README.md:15` "crew-facing, no login", `apps/field/README.md:7-8` "No login. No accounts. No backend", `apps/field/package.json:5` "no backend, no login" — while `apps/field/js/supa.js:34` performs a password grant and `apps/field/js/app.js:138` gates the UI on it. `README.md:84` says 25 test files (28 wired in `apps/field/package.json:10`, 30 on disk); `apps/field/README.md:15` and `apps/field/js/forms.js:2` say 7 forms (29 `FORMS` entries, `model.js:31-98`); `apps/field/README.md:147-148` says deploy to Vercel while `.github/workflows/deploy-field.yml:1-8` deploys to GitHub Pages; `README.md:44` names `design-system/` as the brand source and nothing imports it (only `apps/site/src/styles/brand.css:3` claims, in prose, to match its tokens). `docs/Claude_Code_Handoff_Phase1.md:5` — the one document addressed to Claude Code — says "Read first: docs/Roybal_AI_Backbone_Architecture_and_Phase1.md", a file that does not exist. The rules that are not in file headers live in a memory file outside the repository (`~/.claude/projects/…/memory/MEMORY.md`, not in the tree), invisible to a cloud session, a second machine, or a second developer.

And there is no feedback loop. Zero lint, zero format, zero type-check: 0 `@ts-check` and 0 JSDoc tags across the app JS; `tsconfig.base.json` has zero references; the 26 Deno `.ts` files run only under `node --experimental-strip-types` (`package.json:12`), which strips and never checks. The only workflow (`deploy-field.yml:10-52`) has no `pull_request` trigger, no test step, still lists a deleted branch (`:13`), and force-pushes production (`:52`). `npm test` on `main` is red — `node apps/field/test/build.test.mjs` exits 1 because `config.js:25` says v165 and `sw.js:6` says v166 — and because `apps/field/package.json:10` chains 28 files with `&&`, that second failure hides the other 26 field files, the board suite and every function test. The commit that introduced the drift (`211abb4`, PR #181) touched `apps/field/sw.js` and not `config.js` (`git show --stat`) and the workflow deployed it anyway. **(live)** four of the six `sync_clients` rows now report v165 for devices running v166 code.

### How many patterns coexist (the Frankenstein question)

**Sharing code — five mechanisms.** (1) Relative URL-path imports across app directories: 56 `from "../../js/…"` lines in 16 board/admin files (grep), resolving only because each `serve.mjs` remaps `FIELD_ROOT` (`apps/board/serve.mjs:2-5,12`) and the deploy lays the three directories out at `/`, `/admin`, `/board` (`deploy-field.yml:36-38`); the field app imports the board's engine the same way in reverse (`apps/field/js/myweekcalc.js:10-18`). (2) Checked-in byte copies: `supabase/functions/roybal-brief/schedule.js` is md5-identical to `apps/board/js/schedule.js`, guarded by `crewdigest.test.mjs:18-23`; `apps/portal/js/zip.js:3-5` "VERBATIM COPY … keep the two files identical", unguarded — and already drifted from `apps/field/js/zip.js` (md5 fb595f3c vs 4d3b0fc5; nine header-comment lines differ, code still identical). (3) Docker `COPY` at image build: `services/phone-agent/Dockerfile:1-3,7-9` bakes `personas.ts` and `schedule.js` into Fly, unguarded. (4) Re-implementation in another language: `apps/field/js/merge.js:32-36` `ID_COLLECTIONS` vs the same 12 strings in `243_losstypes_merge_union.sql:16-19` (and 217, 241 ×2), parity asserted by comment at `243:30-36`; `apps/site/scripts/postbuild.mjs:57` "Mirrors resolveEndpoint() … keep the two in sync". (5) Prose: roughly two dozen source lines match the literal regex `in sync|lockstep|in step with` (grep; a looser net that also counts "mirrors" finds about 90), e.g. `apps/board/js/actions.js:34`, `241:48`, `persona.ts:28`. The pipeline stage list alone lives at five sites (`apps/board/js/board.js:22-29`, `actions.js:35`, `apps/field/js/boardpush.js:329`, `app.js:362-370`, `personas.ts:258`), with two more subset filters that must agree with it (brief `digest.ts:176`, `supabase/functions/roybal-portal/crewtoday.mjs:45`).

**Verifying a change — three shapes, none in CI.** 27 files hand-roll an `ok()` harness, 4 use `node:test`, 42 import `node:assert` (47 test files; tooling §1); the phone agent's 13 tests are outside root `npm test` (`package.json:11`; `services/phone-agent/package.json:8`); `dryingcalc.test.mjs` and `sms.test.mjs` sit on disk unwired; zero tests import any edge-function `index.ts` (inventory §3; the one exception in spirit is `roybal-web-agent/guards.test.mjs:318-321`, which reads `index.ts` as text for a grep-based guard). Two of 151 merge-commit bodies mention "test" or "verif" (crude grep).

**Deploying — five paths, four hand-bumped constants.** CI on push for field/admin/board; manual `wrangler pages deploy` for the site (`apps/site/CUTOVER.md:5-7`, contradicted at `:255` "Cloudflare builds from GitHub" and by the root `wrangler.jsonc:21` naming the project `roybal-site` where CUTOVER says `roybal-site-pages`); a Vercel import for the portal (not in repo); CLI-or-MCP for functions, where MCP ignores the pins (`supabase/config.toml:12-15`); hand-pasted SQL for migrations (22 headers say "SQL editor", `001:3-4` says `db push`, `20260713231439_price_list_ddl.sql:1` says MCP). Cache/build tags are maintained by hand in four places — `config.js:25` BUILD, `sw.js:6` CACHE, `apps/board/index.html:53` `board.js?v=64`, `:16` `board.css?v=39` — with one guard (`app.js:577` `APP_VERSION="v36"` is a fifth constant but only a fallback display label, not a deploy tag). PR #181's body reads "Cache busts: board.css v39, board.js v64, sw v166": three manual bumps done, the fourth missed. Nine of the last ten `sw.js` bumps carried `config.js`; the tenth is the one on `main`.

### Discoverability, tribal vs written, blast radius

| Rule an agent must know | Where it is written in the tree | Status |
|---|---|---|
| verify_jwt must stay false on six functions; the MCP deploy ignores the pin | `supabase/config.toml:1-21` | written; the guard is "re-run this command after deploying" |
| BUILD and CACHE bump together | `config.js:19-24`; `build.test.mjs:1-5,17` | written + tested; never run in CI; drifted on main |
| `schedule.js` is server-shared: keep pure ESM, `cp` after edit, redeploy Fly | `schedule.js:8-11`; `crewdigest.test.mjs:14-23`; `Dockerfile:1-3` | written; one of three copies guarded |
| A new form needs a merge rule | `merge.js:29-31`; `merge.test.mjs:221-230` | written + tested for JS; SQL twin (`243:16-23`) unguarded |
| Which SQL definition is live | none — `merge_project_blobs` in 217/241/243, `push_project` in 217/218/241 | tribal: find the last file; **(live)** bodies match 241/243/246 |
| How to stand up a copy of the database | none — replay fails at `105:10-14` (needs 200) and `233:45-51` (scrapes `cron.job`) | impossible today |
| Which Vercel project is the live portal; never delete it | 0 hits (grep) | outside repo only |
| Board local-testing recipe (seed session + cache, SW staleness) | `apps/board/serve.mjs:26` (trailing slash only) | mostly outside repo |
| "Sign out/in re-pulls — but not for deleted-item complaints" | `sync.js:567-580` (mechanism) | mechanism written; operating rule outside repo |
| A crew member who must never get automated texts | `digestOptOut` flag (9 hits) | flag written; reason and the rule for new lanes outside repo |
| The SQL behind live migrations 005-012 | never committed (`005_remote_placeholder.sql:1`) | lost |

Of the out-of-repo memory's twelve repo-relevant rules, roughly five are fully written in the tree, four as mechanism only, three nowhere (INFER, my classification). Written-but-wrong is the worse category: a session trusts `README.md` over a stray comment, and the two READMEs are wrong on login, form count, test count and deploy target; five of sixteen docs assert a build state the code contradicts (inventory §12).

**Blast radius.** PR #181 — one feature, "log what happened on a lead" — touched six files across three apps, the service worker among them (`git show --stat 211abb4`); that is the normal shape because admin, board and field are one bundle. Editing `apps/field/js/core.js` (34 exports) changes 15 board/admin importers with zero consumer tests (admin has no tests at all); editing `supa.js` changes the board's auth (`apps/board/js/board.js:8-12`); a syntax slip in `personas.ts` takes the phone line down at the next Fly deploy (`persona.ts:9-12`); a change to `merge.js` collections silently changes server merge semantics; and anything under `apps/**` is live on `app.roybalconstruction.com` minutes after merge with no test between the agent and the crew.

### What an agent would most likely get wrong on its first PR

1. **Add a collection to the job blob** (say, an equipment placement log — capability 2 needs one). The agent adds a factory to `model.js`, registers the key in `merge.js:32-36`, and `merge.test.mjs:221-230` passes because it only checks JS against JS. The server's `merge_project_blobs` (`243_losstypes_merge_union.sql:16-19`) never learns the key, so two devices editing the same job get newer-wins-wholesale for that section — silent loss on the first concurrent edit. No test reads any `.sql` (grep), no CI runs, and the migration that would fix it must be hand-pasted (`243:1-10` header).
2. **Ship a UI change and bump the service worker.** It already happened: `211abb4` bumped `sw.js:6` to v166 and left `config.js:25` at v165; `build.test.mjs:17` fails; `deploy-field.yml` shipped it. The fleet now lies to `_sync_guard` about its build (**(live)** `sync_clients` v165 ×4) — the exact failure `config.js:19-24` says the constant exists to prevent — and every later test in the `&&` chain is skipped.
3. **Change a shared signature.** Returning an envelope from `rest()` or renaming `currentEmail` in `apps/field/js/supa.js:22,292` passes the field suite; 11 board/admin files import those names by `../../js/` (`apps/board/js/board.js:8`, `apps/admin/js/admin.js:10`) and have no tests, no type-check, no CI. The break appears only at `/admin` in production. The mirror trap: an agent "fixing" the odd relative path by moving admin into its own package breaks the field service worker's precache of `board/js/schedule.js` (`sw.js:27`).

Runner-up traps, all with precedent or a comment warning about them: redeploying a function through the MCP tool flips `verify_jwt` (`config.toml:3-15`, happened 2026-08-13); running `supabase db push` against the numbered directory (`105:10-14`; inventory §6.8); editing one stage list of five; following `apps/field/README.md:7-8` and removing the login gate.

### Evidence

| Measurement | Value | Source |
|---|---|---|
| Commits with Claude co-author trailer / authored by Claude / total | 294 / 114 / 489 | `git log` |
| Non-test source files with a header comment block | 103 / 103 | measured |
| Source lines matching `in sync\|lockstep\|in step with` | ~24 | grep |
| `../../js` import lines / files (board+admin) | 56 / 16 | grep |
| Sites for the pipeline stage list (+ subset filters) | 5 (+2) | inventory §8 |
| Copies of the 12-key collection list (JS + SQL) | 5 | `merge.js:32-36`; 217/241/243 |
| Hand-bumped build/cache constants | 4, one guarded | `config.js:25`; `sw.js:6`; `apps/board/index.html:16,53` |
| Lint / typecheck / CI test runs | 0 / 0 / 0 | `package.json`; `deploy-field.yml` |
| `npm test` on main | red at file 2 of 28 | `build.test.mjs:17` (exit 1) |
| Docs in `docs/` last touched before August | 11 of 16 | `git log` per file |
| Root-level guidance files | 0 | find |

### Severity and why

**High.** Nothing here is exposed to a customer today, so it is not Critical; but this dimension is the multiplier on every other one. The north star is agents that read state, propose, execute and leave a trail — and the same agents are the ones writing the backbone. Today an agent gets no signal when it breaks a consumer (no types, no consumer tests, no CI), the guards that exist are not run, the copies that must agree are not checked, and the first documents it reads invert the security model. The structural part is the copy-and-path sharing: it caps how many parallel changes (human or agent) the system can absorb, because correctness depends on one person remembering `cp`, a SQL edit and four version bumps. The missing in-repo map and the wrong READMEs are real traps but non-structural — a Medium on their own — and the cosmetic part — README numbers, dead `tsconfig`, stale branches, the deleted-branch trigger — is an afternoon.

### What cohesive would look like

One in-repo map (`CLAUDE.md` or `docs/ARCHITECTURE.md`) that says what `00-SYSTEM-INVENTORY.md` now says: the three-in-one bundle, the shared-file list and its guards, the five deploy paths, the one command that verifies. One `npm run check` that runs every suite (field, board, functions, phone agent) with `node --test` so one red file does not hide the rest, plus `tsc --checkJs` over the four apps and `deno check` over the functions; a `pull_request` workflow that runs it and blocks the deploy job. Shared code delivered by one mechanism — a `packages/` workspace, or at minimum a `scripts/sync-shared.mjs` with a test that fails on drift for every copy (schedule ×3, zip ×2, ID_COLLECTIONS ×5, stage lists ×5) instead of one. Build and cache tags generated from one constant at deploy time. Migrations replayable on a branch database so an agent can rehearse a schema change; the current SQL function bodies kept in a `supabase/functions-sql/` directory that migrations include, so "which definition is live" is answerable. The two options the owner must weigh: a real workspace with a build step (stronger contracts, loses the no-build simplicity the crew apps rely on) versus keeping no-build JS and enforcing contracts with JSDoc + `checkJs` + drift tests (cheaper, weaker). The memory file's operating rules should be copied into the tree once; the tree should be the memory.

### Preserve

- The 100 % file-header convention and its WHY-block style (`config.toml:1-21`; `241_merge_delete_tombstones.sql:1-12`; `persona.ts:1-30`; `config.js:19-24`; `schedule.js:8-11`).
- The drift guards that exist: `crewdigest.test.mjs:18-23` (byte-equality), `merge.test.mjs:221-230` (registry completeness), `build.test.mjs:17`, `persona.test.mjs` (createLead + SERVICES), `postbuild.mjs:72-102` (build fails unless endpoints are wired).
- `supabase/config.toml` as the verify_jwt pin file, and the habit of recording incidents where the code lives.
- `personas.ts` as a pure-data tool registry in Anthropic JSON-schema form (`personas.ts:1-12,166-221`) and the pure-ESM discipline of `schedule.js` — both already headless and reusable by any runtime.
- `serve.mjs` composing the deployed layout locally, `.cursor/environment.json`, and the root npm scripts as the runnable map.
- The PR-body narrative (mechanism, incident, what changed, cache bumps) and the co-author trailers that make AI provenance visible in history.
- `docs/architecture/00-SYSTEM-INVENTORY.md` as the seed of the in-repo map.

---

## 17. AI-operability and automation readiness

**Verdict: an agent can read state and propose here today; it cannot execute, and the system cannot record what it did.** The only server-side propose→approve→execute loop that exists covers three action kinds, is reachable solely by an SMS from one phone number, and has been silently jammed since 2026-07-26. Every other write the assistant is allowed to propose runs inside a signed-in browser tab. That is the single most important fact in this review.

### What the pattern is today

There is no service layer. Clients hand-build PostgREST URLs (inventory §5: 50 `rest(` sites in 15 field files, `docs/architecture/00-SYSTEM-INVENTORY.md:161-172`), and the 14 edge functions are `{action}`-string dispatchers shaped around a screen, not a domain (`supabase/functions/roybal-ai-office/index.ts:1745-1747` lists 15 actions; the integrations reader found "no named-operation layer" and four function-to-function auth conventions).

The assistant's **read** side is real and well built. Six read tools carry Anthropic JSON-schema `input_schema` (`personas.ts:78-146`), five phone tools likewise (`personas.ts:166-221`), and their executors run under the caller's JWT so RLS applies (`index.ts:1466`, `services/phone-agent/tools.mjs:199-214`). This is MCP-ready vocabulary.

The assistant's **write** side is prose. Seventeen action types are defined as `desc` strings (`personas.ts:248-362`), embedded into a single `proposeActions` tool whose `params` is an untyped `object` (`index.ts:1483-1507`, `:1500`). The server validates only that the type is in the app's allowlist and caps three per turn (`:1510-1524`); it then returns the proposals as chips and tells the model "chips shown" (`:1570-1578`). Execution is a `switch` in each browser: field runs `sendText` only (`apps/field/js/assist.js:229-235`), board runs seven (`apps/board/js/actions.js:399-414`, plus two legacy names that no longer exist in `ACTION_DEFS`, `:409-410`), admin runs eleven `ACTION_DEFS` types plus one app-local follow-up (`portalPost`, `apps/admin/js/assistctx.js:279-292`, `:285`; finance chips in `apps/admin/js/finactions.js:315-325`). Estimates, invoices, change orders and receipts are written into IndexedDB by the tab and later blob-merged by `push_project` (`finactions.js:74-118`, `Store.put` at `:109`); the "only invoice from an approved estimate" rule exists only in client JS (`:127-128`), and only `receiptLog` stamps an author (`:301`). `roybal-ai-office` never calls `roybal-notify`, `gmail-proxy`, `qbo-proxy` or `pending_actions` (grep: 0 hits).

The second, server-side spine is `pending_actions` (`supabase/migrations/210_pending_actions.sql:24-38`): proposals are inert, clients may only SELECT and INSERT-pending (`:46-55`), approval is a Twilio-signed text from `OWNER_CELL` (`supabase/functions/roybal-notify/index.ts:396-403`), the status flip is guarded on still-pending (`:438-443`), and the email executor re-verifies the row before sending and consumes it (`supabase/functions/gmail-proxy/index.ts:317-326`, `:376-381`). Three kinds exist — `emailSend` (proposed by the brief, `roybal-brief/index.ts:286-296`), `boardEdit`/`addPhase` (proposed by qb-time, `qb-time-proxy/index.ts:535-556`), `sendText` (executor at `notify:460-468`, **no proposer anywhere**, grep = 0).

Background work is nine pg_cron jobs firing `net.http_post` (inventory §6.5); three hit the LLM-free brief (`206`, `211`, `244`). No trigger calls `http_post` (grep of migrations: 0), and no cron or trigger invokes any AI function — the only scheduled model call is qb-time's phase stamping; every other model call is request/response from a browser, a public website, or a phone relay. Documents are `window.print()` over a live DOM (six sites: `apps/field/js/app.js:1552,1625,1936,2400,2413,2458`); there is no headless render path.

### How many patterns coexist (the Frankenstein question)

Six propose/approve/execute patterns run side by side, none complete:

| # | Pattern | Approver | Executor | Record | Evidence |
|---|---|---|---|---|---|
| 1 | Chips (fieldAssist) | anyone signed in, tap | browser JS | best-effort PATCH into `capture_events.result.executed` | `assist.js:179-223` |
| 2 | `pending_actions` | one phone number | `roybal-notify` → sub-executor | mutable row + one `capture_events` row | `notify:396-525`; `gmail-proxy:368-381` |
| 3 | Voice-ingest chips | tap "Add N values" | `applyChips` → `Store.put` | envelope stays `extracted`; `confirmed` never written by any function (grep = 0; live: 2 rows, web lane only) | `apps/field/js/voice.js:220-227`; `ai.js:411-442` |
| 4 | Draft-replace-after-confirm | click | replaces `inv.items` | none beyond the blob | `apps/field/js/forms.js:1484-1488` |
| 5 | Deterministic organ side effects, no approval | none | server | `capture_events`/`ai_usage` | qb-time AI phase stamps written directly to `time_entries` (`qb-time-proxy:464-475`); web/phone `createLead` + owner SMS |
| 6 | Campaign loop | `confirm()` dialog | browser loop | `sms_messages.sent_by` tag | `apps/admin/js/campaigns.js:211,217-232` |

Underneath: six AI invocation lanes, ten model-selection env knobs across seven files (`ai-office:63-68`, `ai-ingest:51`, `ai-narrative:28`, `web-agent:129`, `qb-time:292`, `portal:76`, `phone-agent/config.mjs:21`), six `LLM_PRICES` tables (one naming `claude-sonnet-5`/`claude-opus-5`, ids used nowhere else, `roybal-web-agent/guards.ts:253-257`), and six `monthSpend` copies with four distinct behaviours (paged `ai-office:111-126`, `ai-ingest:342-350`, `phone-agent/supa.mjs:78-86`; unpaged `ai-narrative:69-73`; `.limit(5000)` `qb-time:303-311`; fail-open-to-zero `roybal-portal:608-613`, the one copy that runs under the service key).

### Evidence

**Where the north-star payload already exists and is thrown away or never persisted.** `invoiceDraft` requires a `basis` (justification) on every line (`index.ts:369-393`) and `invoiceAudit` is explicitly a supplement auditor whose primary check is "logged hours unbilled = lost revenue" (`index.ts:604-661`, `:629`) — that is capability (2) in prompt form. But the client stores `code/priced/flag` and drops `basis` after rendering it once (`forms.js:1484-1488` vs `:1505`), photo AI tags (damage/workDone/materials) are consumed only inside a client-built digest (`officeai.js:159-172` feeds them into `invoiceFacts`) and never persisted as billing provenance — only the `equipment` tags are consumed by nothing — and both actions run only when a human clicks, on a `facts` digest assembled in the browser (`apps/field/js/officeai.js:173-179`). The intelligence is there; the data model and the call surface make it unschedulable and unlearnable.

**Keys, models, prompts, evals.** `LLM_API_KEY` is read by six edge functions (ai-office, ai-ingest, ai-narrative, portal, web-agent, qb-time) plus the Fly agent, every call a raw `fetch` (no SDK). System prompts are inline template strings (20 `system:` sites) in an 1,842-line file with no tests (`ls supabase/functions/roybal-ai-office/` = `index.ts`, `personas.ts`); `forcedTool` is called at 14 sites; `chatText` is dead (`:172`). Prompt versioning: grep for `prompt_version|promptVersion|persona_version` = 0; the only stamp is client-side `PHOTO_AI_VERSION = 1` (`officeai.js:104`); `ai_usage` records `llm_model` but no prompt id (`201_ai_usage.sql:27-30`). Evaluation: none — the 13 edge-function test files cover pure helpers only (zero touch any `index.ts`, inventory `:115`), never a model output.

**Cost.** Per-call `ai_usage` with LLM/STT/TTS split (`index.ts:1786-1807`), error-path metering (`:1817-1838`), mid-loop cap re-check (`:1587`), and reserve-before-spend on the web lane only (`227_web_receptionist.sql:167-173`, `:204-211`). The ledger is `for all to authenticated using(true)` (`201:78-79`) and, in every lane but the portal's, the cap is summed under the caller's own JWT — any tech can zero the month. Live: 998 rows, $51.09.

**Logging/observability.** `console.*` count: ai-office 0, ai-ingest 0, ai-narrative 0, voice 1 (measured). `capture_events.result` on a fieldAssist call is counts only (`index.ts:1675`) — no tool inputs/outputs, latency or provider status survive. Two integration lanes have been dead for days with cron reporting "succeeded" (live).

**Idempotency.** `sendSms` inserts then sends with no client key (`notify:335-368`); browser `sendEmail` has none (`gmail-proxy:344-349`); `pushInvoice` creates a fresh QBO invoice whenever `qboInvoiceId` is absent (`qbo-proxy:345-356`). The approval path is the exception (row consumed, `gmail-proxy:376-380`).

**Permissions.** `user_role` {admin, tech, viewer, office} is consulted by `_sync_guard` (`226:45-50`), `coordination_job_patch` (`246:47-52`), `is_admin()` and `field_photos`; every other operational table is `using(true)` (`200:229-240`, `201:78-79`). Machine users are fenced by literal email in restrictive policies (`204:12-31`; `205:16-23`; 26 live). The only "propose" right is the `pending_actions` insert policy (`210:49-52`); the only "approve" right is a phone number.

**Live state of the one real spine.** Three `boardEdit` rows have been `pending` since 2026-07-25, expired 07-26, never swept (`expired` is never written — only the CHECK at `210:33`); qb-time counts them against `MAX_LIVE_PROPOSALS = 3` with no expiry filter (`qb-time-proxy:284-285`, `:494-499`), so no board proposal has been made since. Codes are allocated app-side in two places (`qb-time:345-356`; `brief:262-266`). The weekly "what the AI did" report counts `source_type='assist_action'` events (`roybal-brief/weekly.ts:46`) that no code writes.

### Distance from the north star (0 = absent, 10 = done)

| Backbone requirement | Score | What exists | What is missing |
|---|---|---|---|
| Headless service layer | **1** | pure engines (`schedule.js`, `fincalc.js`, `dryingcalc.js`, `merge.js`, `phasematch.ts`) | any callable boundary; writes live in browser executors |
| Permission read/propose/approve/execute | **2** | role enum; `pending_actions` insert policy; email-string fences | per-action-type matrix; approver identity; role-keyed machine policies |
| Proposal mechanism | **3** | `pending_actions` shape is right | coverage (3 kinds), in-app approval, expiry sweep, append-only history |
| Event log / audit | **3** | `capture_events` envelope; `blob_history` + server-stamped `updated_by` (`stamp_updated_by()` trigger, `216:122-139`) | immutability (`200:235-237`), per-state-change events, tool traces |
| Job queue | **1** | pg_cron → async `http_post` | queue table, status, retry, dead-letter, event triggers |
| Headless documents | **0** | — | any server render path |
| Typed/validated/idempotent operations | **2** | 11 JSON-schema read tools | typed write contracts, server validation, idempotency keys |
| Integration abstraction | **1** | proxies with `{action}` | named operations, one auth convention, health |
| Observability of automation | **3** | `ai_usage` cost ledger | logs, traces, alerts, integrity of the ledger |
| Model routing / prompt registry | **2** | env-per-file defaults | one routing policy, versioned prompts, evals |

**Three foundations missing entirely:** (1) a server-side **operation layer** — typed, validated, idempotent domain commands that UI, agents and jobs all call; (2) a **durable job queue with event triggers** — today nothing can enqueue work and no state change can wake an agent; (3) a **headless document pipeline** — every carrier-facing artifact needs a browser and a human's print click.

### Severity and why

**Critical for the dimension.** Nothing here is a live security breach beyond the deletable ledger, but the north star is blocked outright: an agent can execute exactly three kinds of action server-side, all through one phone. The structural ceilings are (a) the write layer living in browser tabs, which cannot enforce per-role rules or serialize a second office worker's edits; (b) a single approver keyed by phone number; (c) machine identity by email string; (d) fire-and-forget cron. Prompt versioning, evals and model routing are Medium — real quality costs, fixable incrementally.

### What cohesive would look like

One `operations` registry in Postgres/edge code where every write is a named, JSON-schema-typed, idempotent command (`invoice.create`, `phase.complete`, `sms.send`, `qbo.sync_invoice`) with a declared actor-role matrix (read / propose / approve / execute). Every command call — from a screen, a chip, a cron, or an MCP tool — inserts an append-only `proposals` row (proposer, approver, params, idempotency key) that transitions through the same states `pending_actions` already models, and emits an immutable `events` row on every state change. A `jobs` table with status/attempts/last_error, drained by one pg_cron tick, replaces per-function `http_post`; row inserts and event rows are what enqueue AI work. One `_shared` module holds the LLM client, the price table, the routing policy (lane → model) and a `prompts` table with versions stamped onto `ai_usage`. Documents render server-side from the same data the screens use. The existing read tools, `pending_actions` semantics, spend caps and envelope-before-spend invariant move into that layer unchanged. **Trade-off to decide, not decided here:** keep chips executing client-side for offline field use while everything office-side goes through the registry (fast, two paths persist), or route all chips through the registry (one path, field chips need connectivity).

### Preserve

- The universal propose→confirm discipline: `ACTION_RULE` "NOTHING executes unless they tap it" (`personas.ts:238-244`), `proposeTool` never executing (`index.ts:1480-1481`), drafts replacing only after confirm.
- Envelope-before-spend: `capture_events` row before any paid call in every lane (`ai-office:1771-1775`; `ai-ingest:488-496`; `phone-agent/server.mjs:88-91`).
- Spend governance: shared monthly cap, per-lane caps, pessimistic reserve-then-settle (`227:147-211`), error-path metering, mid-loop re-check, dearest-model fallback pricing (`guards.ts:262-266`).
- `pending_actions` semantics: inert proposal, signed approval, executor re-verification, guarded transitions, consumed row (`210`; `notify:438-443`; `gmail-proxy:317-326,376-380`).
- The JSON-schema read/phone tool registry (`personas.ts:78-146,166-221`) and RLS-scoped tool execution.
- The web agent's "model is not trusted with anything that costs or binds" design: RPC-only DB access, deterministic escalation, output filter (`roybal-web-agent/index.ts:36-60`).
- Deny-by-restrictive-policy for machine users (`204`, `205`) — right instinct, re-key it to role.
- Server-stamped `updated_by` (`stamp_updated_by()` trigger, `216:122-139`) and `blob_history` pre-images.
- The pure, tested engines and the qb-time "looked and passed" once-per-entry marker (`qb-time-proxy:464-475`).

---

## Part III — Cohesion verdict (Phase 3)

Three judges answered the seven questions below independently, from the verified assessments and the gap matrix. Their full texts are preserved in the review's working files; this part is the reviewer's synthesis, and where a judge dissented it is said so.

### 1. Framework or collection of features? Grade: **D+**

**A collection of features.** There is one designed subsystem — the field app's offline-first blob with a server-authoritative merge, written down in `docs/Sync_Rearchitecture_Plan.md` and deliberately stopped at its Phase 3 — and around it a set of well-built modules that share one origin, one login, and one JSON document per job. Nothing in the tree declares what a job, an invoice, a reading, or an approval *is* in a form more than one runtime can call.

The five pieces of evidence that decide the grade:

1. **The domain executes only inside browser tabs.** The office assistant returns proposals with the note that each runs only if the user taps it (`supabase/functions/roybal-ai-office/index.ts:1570-1578`); the 17 write actions it may propose run as `switch` statements in three apps (`apps/field/js/assist.js:179-193`; `apps/board/js/actions.js:399-414`; `apps/admin/js/assistctx.js:279-292`); financial writes go to IndexedDB and ride the sync engine later (`apps/admin/js/finactions.js:109,152,218,271,303`); schedule dates on disk are whatever the last tab computed (`apps/board/js/board.js:226-255`). The server can execute exactly three kinds — `emailSend`, `sendText`, `boardEdit/addPhase` — after one SMS from one phone number (`supabase/functions/roybal-notify/index.ts:396-525`, `:400-401`).
2. **Three job models are deployed at once and the one that carries the business is untyped.** The record is `field_projects.data`, "mirrors exactly what the field app keeps on-device" (`supabase/migrations/100_field_projects.sql:11-19`): 80 top-level keys, avg 50 kB, no foreign keys (live). The era-0 tables with the owner's vocabulary — `moisture_readings`, `equipment_logs`, `line_items`, `rooms` (`001_initial_schema.sql:137-247`) — hold 6/5/2/6 March rows and no writer. `unified_jobs`, declared "THE SPINE" with "intentionally no hard FK" (`200_ai_backbone.sql:80-108`), has all 33 rows at `status='new'` because nothing writes status (`apps/field/js/spine.js:23-40`).
3. **The claim side of the business has no model.** Claim, carrier, adjuster, policy are free text (`apps/field/js/model.js:137-143`); submittal, carrier response, rejection reason, supplement are absent (repo-wide grep). The justification the drafting prompt requires per line (`roybal-ai-office/index.ts:369-393`) is rendered once and discarded by the client (`apps/field/js/forms.js:1484-1488` vs `:1505`). The most valuable data the business produces is thrown away daily.
4. **Authorization is `using(true)` minus an email string.** Eighteen operational tables are open to any authenticated JWT, including the AI cost ledger and the audit log (`200:229-240`; `201_ai_usage.sql:78-79`), payroll hours and portal state; machine actors are fenced by 26 restrictive policies naming two literal emails (`204_phone_agent_rls.sql`, `205_brief_machine_rls.sql`); the committed publishable key reaches `pushInvoice` and OAuth `disconnect` (`qbo-proxy/index.ts:309-313`; `qb-time-proxy/index.ts:747-978`).
5. **No verification loop exists between an edit and production.** One deploy-only workflow with no test step (`.github/workflows/deploy-field.yml:10-52`); `main` is red (`apps/field/js/config.js:25` v165 vs `apps/field/sw.js:6` v166) and the red state is deployed; zero tests import any edge-function `index.ts`; the JS↔SQL merge twin's parity is a comment (`243_losstypes_merge_union.sql:30-36`); no type-checking runs anywhere.

Why not an F: `push_project` is a real server-authoritative write door (`241_merge_delete_tombstones.sql:193-282`); `sync.js` has a 76-check fake-server harness and every August incident was root-caused and closed in code; `fincalc`, `dryingcalc`, `completeness`, `merge`, `schedule` are pure, DOM-free and tested; `pending_actions` has the right row shape (`210_pending_actions.sql:24-38`); `contacts` is a properly typed relational spine (`228_contacts.sql:51-72`); 100 % of source files open with an explanatory header. Those are the seeds of a backbone. They are not a backbone.

### 2. The biggest seams

1. **Era-0 typed tables ↔ era-1 blob.** The vocabulary the owner asked for exists as empty tables beside the blob that holds the real data. An agent reading the schema sees `line_items` and `invoices` and will write to the wrong place. Cheap to drop, dangerous to leave.
2. **JS merge ↔ plpgsql merge at the only write door.** `apps/field/js/merge.js:32-36,142-214` and `243:13-144` must stay byte-equivalent by hand; parity was proven once, out of band (2,033 randomized cases recorded in a comment; the harness is not in the repo), and `qbo-proxy/index.ts:429-444` already writes around the merge with a service-role, rev-guarded PATCH. Every new blob collection is a two-language edit plus a hand-pasted migration.
3. **Browser chips ↔ server `pending_actions`.** Two approval spines with different approvers, executors and audit guarantees (`assist.js:179-223` vs `210` + `roybal-notify/index.ts:396-525`). The server-side one has been jammed by three expired rows since 2026-07-26 (`MAX_LIVE_PROPOSALS=3`, `qb-time-proxy/index.ts:284-285,494-499`) and nobody noticed.
4. **Field-app-as-library ↔ admin and board as URL-coupled satellites.** 56 `../../js` imports across 16 files resolve only because the deploy lays out `/`, `/admin`, `/board` on one origin (`deploy-field.yml:36-38`); the admin boots the field sync engine and replicates every job blob into the office browser (`apps/admin/js/admin.js:34`); the field service worker at scope `/` precaches board files (`apps/field/sw.js:27`). Three apps, one deploy unit, one cache, no contract tests. The same seam repeats at the runtime boundary: `schedule.js` is byte-copied into an edge function and Docker-copied into the phone agent, and `roybal-web-agent/persona.ts:1-30` refuses the shared registry outright because "a syntax error in it takes the phone line down".
5. **Typed CRM era (228+) and individual logins (216) ↔ the soft-linked, single-account world.** `contacts` has FKs, generated norm columns and a merge tombstone; the job it links to is a text id inside JSON (`data.fieldJobId`), which is how one lead respawned six times (memory: the Hebard incident). Migration 216 introduced per-person logins and an `office` role no live profile holds, while every operational table kept its "single-company account" policies (`100:44-46`; `216:26-33`) and the UI still says "Everyone shares one login" (`apps/board/js/board.js:293,3009`).

### 3. What is sound and carries forward

**As working code, regardless of path (do not rewrite):**
- The sync protocol: `apps/field/js/sync.js` invariants and the `test/sync.mjs` harness; `merge.js` rules plus `deletedIds` tombstones; `push_project` with `_sync_guard`, `blob_history`, `field_projects_trash`, `tombstone_project`'s high-water rev; `media.js` content-addressed offload; `graft.js`; `Store.putIf/delIf`.
- The pure engines: `apps/board/js/schedule.js` (887 lines, 89 tests, already consumed by four runtimes — the proof that the headless pattern works here); `fincalc.js`, `dryingcalc.js`, `completeness.js`, `dryingwatch.js`, `buildwatch.js`, `narrative.js` fact builders, `xactimate.js`/`xlsx.js`, `convert.js`, `calibration.js`, `ai.js` chip write-back, `model.js` factories and vocabularies; `qb-time-proxy/phasematch.ts`, `gmail-proxy/emailmatch.ts`, `qbo-proxy/payments.ts`, `roybal-notify/approve.ts`, `roybal-web-agent/guards.ts`.
- The typed spines: `contacts` with its resolve/merge ladder; `price_list` (as one quarantined price source, see the EULA note in 03); `pending_actions`' row shape and its executor's re-verification of the row (`gmail-proxy/index.ts:317-326,376-380`); `capture_events`, `ai_usage`, `blob_history`, `updated_by` as ledgers.
- The security posture of the web receptionist (`227_web_receptionist.sql:147-211`: RPC-only, reserve-before-spend, DB-enforced caps) — the pattern every AI lane should adopt.
- `personas.ts` JSON-schema read and phone tools; `roybal-notify` `sendSms` invariants; `apps/field/css/print.css` pagination rules; `formkit.js` as the editor vocabulary; `supabase/config.toml` pins; the 100 % file-header convention.

**As specification (rebuild from, do not port):** the carrier conventions — Recap by Room (`forms.js:1390-1416`), sketch-walk room ordering (`:1252-1361`), the totals ladder (`:1432-1452`), GC 10-and-10 only with a subcontractor (`docs/Estimating_Rules_Draft.md:29-39`, `model.js:406-409`), the Work Authorization terms (`forms.js:838-844`), the three certification statements, the narrative cover convention (`:2839-2874`), packet assembly and "uploaded copy replaces the form" rules (`apps/field/js/app.js:1437-1494`), 13-column reading blocks, the filename rule; the 22 `FORMS` entries' field lists and layouts; the 29-rule completeness matrix as the billable gate (reconciled with its diverged SQL seed); the era-0 DDL as the first draft of `rooms`, `moisture_readings`, `equipment_logs`, `line_items`; `ACTION_DEFS` prose rewritten as JSON-schema operation contracts; the sync plan's Phase 3–4 recipe for dual-write and backfill.

**The document builder, specifically.** It is three things wearing one name. The *math* is already headless — `fincalc.js`, `dryingcalc.js`, `completeness.js`, the `narrative.js` fact digest, and two pure builders inside `forms.js` (`moistureChartSvg` `:64-110`, `mdToNodes` `:2813-2837`) lift unchanged. The *conventions* are an asset and are preserved as the specification above. The *renderers* are a liability: all 21 `sheet()` renderers need `document`, canvas, `localStorage` and `window.print`; `invoice()` runs `forms.js:1378-1912` and in one closure computes totals, replaces items with an AI draft, pushes to QuickBooks and paints print-only nodes; `portalShareForm()` (`:3336-3910`) issues eleven network calls from inside a renderer; there are 100 `commit()` autosaves; no test imports `forms.js`, `formkit.js` or `print.css`; the jsdom smoke test only proves a `.sheet` element exists. There is no document record, no number sequence, no version, no issued state; a live change order has `coNo: ""`. **Status: conventions are an asset; renderers are a liability; the pipeline does not exist.** The builder is the correct first strangler target: highest-value capability, pure parts already extracted, fused parts cheap to re-express as templates over a document model because the spec is explicit and the print CSS carries across nearly verbatim.

### 4. The single biggest risk of twelve more months as-is

Not an outage — the sync engine is good, incidents get closed, and the two live security exposures are days to fix. The structural risk is **paying twice while discarding the learning substrate.** Every feature built in the next year lands in the blob shape and the browser-executor shape and must be redone when rows and a service layer arrive, because the north star's unit of work — one line, one reading, one placement, one submittal — is unrepresentable today. Every job closed under this model throws away the justifications, per-location readings, equipment events and submittal records that capabilities 1, 2, 3 and 5 would learn from. The compounding term is the JS↔SQL merge twin plus the `../../js` coupling: each feature widens a parity surface no CI checks, and the first AI-authored PR that adds a blob collection without editing the SQL twin silently makes that section newer-wins-wholesale under concurrent edits. The repository's own history is the argument: four eras, each added beside the last, none retired.

### 5. If headcount triples in eighteen months, what breaks first

**Organizationally, and before the third hire.** A second office person cannot be given *less than everything* or *any approval authority*: there is no `office` profile live (admin 2, tech 7, viewer 2), new accounts default to `tech` with full REST write on payroll hours, the board, the portal and the audit ledgers (`216_individual_logins.sql:66-80`), the only approver is `OWNER_CELL`, and refused office-gated RPC writes report success in the UI. A crew lead cannot exist: crews are `crewIds[]` on jobs with no team, no lead, no structured skills or certifications (one free-text `bioCerts` string on one of eleven rows). A second division, calendar, QuickBooks company, mailbox or Twilio number is code, not a row (one settings uuid in seven files; one token row per provider; `America/Anchorage` and the company phone hard-coded across the apps). Subcontractors are a contact role string with no login class. A third machine agent inherits full rights by default.

**Technically: silent wrong answers arrive before slowness.** Server readers cap without error — `hoursLookup` already drops about 190 of 1,193 time entries at `limit=1000` (`roybal-ai-office/index.ts:1409-1411`), the Leads tab reads only the newest 200 lead rows (`apps/admin/js/leads.js:94`), the brief omits jobs past 300, the board silently stops at 20,000 rows (`apps/board/js/data.js:150-163`). Then the whole-company replica per device: `fetchSince` has no job or crew scope (`apps/field/js/supa.js:268-273`), so every phone and every office tab pulls every changed job; the board polls three whole tables every 20 seconds per tab (31,255 `time_entries` selects in the live statement stats); two office staff editing the same job collide on newer-wins scalars through the blob merge; a schedule reflow across N tabs is N sequential client-side writes with no transaction (`board.js:187-191,247-255`).

### 6. Distance from the north star

Far in structure, near in data. Scored against the backbone the owner described (0–10): callable service layer 1; permission verbs read/propose/approve/execute 2; proposal mechanism 3; event log 3; job queue 1; headless documents 0; typed operations 2; integration abstraction 1; observability 3; model routing 1. "Read" works but over-broadly; "propose" half-works as prose; "approve" is one phone number and jammed; "execute" is a browser; "record" is a whole-blob pre-image any tech can rewrite. Live data is 15 jobs and 743 kB; the distance is the shape of the code, not the size of the data.

**Three foundations are missing entirely:** a typed operation layer any runtime can call; a durable job queue with event triggers (pg_cron fires fire-and-forget HTTP calls whose failures are invisible); a headless document pipeline.

**What must be true before agent-drafted invoices with human approval can be built safely:**
1. A server-side `invoice.draft` / `invoice.issue` operation — idempotent, role-checked, event-emitting — writing through `push_project` or into a line-items table, never a chip and never a merge-bypassing service-role PATCH. Route `qbo-proxy` through the same door.
2. Line items that persist `code`, `basis` and `evidence[]` (gap matrix unlock #1: one JS change at `forms.js:1484-1488` — the model already emits them), and an invoice identity: number sequence, version, issued state, frozen render hash.
3. One approval spine: `pending_actions` unjammed and extended with `approver_id`, an in-app approve RPC, an expiry sweep and append-only history. Approval by one SMS is not an approval record.
4. `capture_events` and `ai_usage` insert-only for everyone but the service role. A "human approved" row any tech can PATCH is not evidence.
5. A queryable read model over the blob so the drafter sees equipment-days and hours without walking 50 kB in an edge isolate.
6. QuickBooks Time reconnected with an integration-health signal, so the detector's labor input is known-fresh rather than silently stale since 09-04.

**Would building it today mean building it wrong? Yes, if built the way the last 17 actions were built** — as chip number 18 in a browser tab it becomes the eighth code-sharing pattern and the fourth browser executor, its basis discarded, its approval a tap with a best-effort audit stamp, and it joins the pile to be torn out. **No, if built as the first slice of the backbone** — a pure `unbilled.js` in the `completeness.js` style, run by a queue, landing a new proposal kind, approved in-app, executed server-side, receipted in an event. That slice is two to three weeks including the prerequisites, and it is exactly the shape every later automation reuses.

### 7. The rebuild decision

**(a) Evolve in place.** Calendar: no dedicated stop; the eight unlock items interleave with revenue features over 4–8 months (one judge said 9–15; another 12–24 without a declared backbone). Disruption: none felt by crews or office. Preserves everything. Makes possible sooner: the security fixes (days), CI (a week), alerting (a week), an unbilled v0 and adjuster-email drafting as chips within weeks. Risks: every step deepens the blob and the browser-executor shape; the merge twin, the URL coupling and `using(true)` remain; nothing forces a division or crew entity into existence; by month twelve the company has more features and the same distance from the north star, and a rebuild then costs more because there is more to port. This *is* the repository's practice for four eras and it has produced accretion, not convergence. It is the default if nobody decides, and it is the "pay twice" path.

**(b) Strangler rebuild.** Calendar: weeks 1–2 stop the bleeding; a thin backbone slice with the first automation live in months 1–2; the document pipeline in months 3–5; capture-shape changes (rooms, per-location readings, equipment events) projected into rows and then normalized section by section in months 4–8; office surfaces, crew/division structure and server-owned scheduling in months 6–12; per-section cutover, never a day. The three judges' ranges were 5–8, 6–12 and 12–14 months to office cutover; the roadmap in 03 is calendar-honest about a solo owner with AI as the team. Disruption: crews feel nothing until the capture-shape changes, which ship behind the existing blob so offline never changes; the office feels a new approvals inbox and documents arriving as attachments instead of print dialogs. Preserves every item in §3 as running code. Makes possible sooner: agent-drafted invoices with a real approval record in months 1–2; submittal tracking and per-carrier learning by month 3–4; server-owned scheduling by month 6. Risks: two write paths coexist for months and the discipline not to add features to the old one is the owner's alone; the merge twin persists until the last blob section is projected; each slice needs a CI gate that does not exist today, so the first slice is the gate itself; the projection-versus-normalize choice per section is a one-way door.

**(c) Clean-sheet rewrite with data migration.** Calendar: 6–14 months to parity for a solo owner (the judges' ranges were 6–10, 9–18 and 8–14), during which the old app must still be maintained. Data migration is genuinely cheap — 15 jobs, 743 kB, 748 photo rows, 1,193 time entries, 40 contacts: an afternoon of SQL. *Behaviour* migration is not: 638 lines of sync invariants learned from four data-loss incidents, 3,933 lines of carrier-facing forms, `print.css` rules learned from adjuster pushback, a service-worker update path that finally works, and a big-bang cutover for iPads on job-site LTE during the busy season. This repository has already done one rewrite — React era 0 to static era 1 — and the residue is 20 dead tables, two dead Magicplan functions and a lockfile full of ghosts. Preserves only the spec. Makes possible sooner: nothing; every capability waits for parity, and the parts a rewrite throws away are the best parts.

**Recommendation: (b), the strangler — strangle the backend, not the app.** All three judges chose it independently. Against (a): the structures that must exist — an operation layer, an approval spine, a document model, the claim vocabulary — are absent from every era and cannot be reached by patching the blob; if you are building those tables and that service layer anyway, the only question is whether new code is allowed to be blob-shaped, and the strangler says no. Against (c): the crews already trust this field app, the sync engine is the best module in the repository, the last rewrite here left a scar, and a solo owner cannot afford six months of no revenue features to re-learn what `print.css:238-259` already knows. The small dataset is precisely what makes the strangler work: each ported section's backfill is a script over 15 blobs verified by a row count, not a project.

**What "new backbone" means with Supabase staying.** Postgres tables, not a bus: `jobs` (the spine, with a compatibility view for `unified_jobs`), `claims`, `carriers`, `submittals`, `carrier_responses`, `documents` and `document_versions` (kind, number, version, status, hash, storage path), `line_items` with `code`, `justification` and `evidence_refs`, `proposals` (`pending_actions` extended: `approver_id`, `idempotency_key`, a kind per detector), `events` (append-only), `jobs_queue` and `outbox` (status, attempts, lease, last error, drained by a worker; pg_cron only enqueues), `integration_health`, a role-permissions matrix, `rooms`, `equipment_units` and `equipment_placements`, `moisture_locations` and `moisture_readings`, crews and assignments, a division column on every money row — added now while every table is under 100 rows. One typed operations registry whose definitions generate the SQL/edge dispatcher, the Anthropic tool schemas, the MCP tools and the permission rows. One headless document pipeline: a document model built from tables (and from the blob during transition), one HTML renderer shared by browser print and a worker's Chromium, output frozen into a numbered, immutable `documents` row. One small worker on Fly, separate from the voice app, for long or heavy work only; short synchronous operations execute in Postgres so the office keeps working if Fly is down. One `packages/domain` holding the pure engines, imported by every runtime, collapsing seven code-sharing mechanisms into one. **Not rewritten:** the pure engines; the sync protocol; the print rules and letterhead conventions (moved into templates); `formkit` editors; `contacts`; `price_list` (as one quarantined source); the web agent's guards; the read-tool registry. The full design, its ADRs and the phased roadmap are in [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md).

**First automation.** Two judges chose unbilled-item detection on mitigation jobs as the first backbone slice; the applied-AI judge chose adjuster-email drafting with a submittal record because its execute leg already exists server-side. The gap matrix supports both and shows the trade: the unbilled detector touches cash and uses data that exists, but at regex grade until equipment placements and coded lines exist; the adjuster-email lane proves the whole loop faster and creates the submittal record that capabilities 1, 3 and 5 are all blocked on. The roadmap resolves it as: migrate the existing overdue-reminder and adjuster-email lanes onto the new proposals spine first as the backbone smoke test (weeks 3–5), then ship the unbilled detector as the first *new* capability (by week 10), with the submittal record bundled because "was this invoice already sent" is one of its inputs.

---

## Appendix — how to read the findings

Every finding in Part II appears in [findings.json](findings.json) with a stable id, a dimension, a severity (Critical / High / Medium / Low), evidence paths, a recommendation, the roadmap phase in [03-TARGET-ARCHITECTURE-AND-ROADMAP.md](03-TARGET-ARCHITECTURE-AND-ROADMAP.md) that resolves it, an `automation_impact` (does fixing it move the system toward the north star: blocks / neutral / enables), and a `growth_ceiling` flag that is true only when the structure itself caps how large the company can get without re-architecture. Duplicates across dimensions were merged; the surviving id lists the dimensions it spans. Severity was calibrated by the verifiers as: Critical = actively wrong or exposed in production, or blocks the north star outright; High = structural, must change before the automation backbone; Medium = real cost, fixable incrementally; Low = hygiene.
