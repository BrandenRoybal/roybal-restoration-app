# Claude Code build brief — Magicplan LiDAR integration (M1 → M3 → M2)

*Paste into Claude Code from the repo root:* **"Read `docs/Claude_Code_Prompt_Magicplan.md` and start M1."** Everything below is the brief. Nothing in it is open for debate except where it says *stop and ask*.

---

## 0. What you are building, in one paragraph

Roybal Construction's field app (`apps/field`, vanilla JS PWA on Supabase) has a Site Visit packet on every bid file: Magicplan report PDF, photos, note pages, a walk recording, and an estimate engine that drafts from them. Today the Magicplan half of that packet is a PDF the owner exports on his phone, AirDrops to a Mac, and drags into the panel — then the estimator reads dimensions off a picture. Magicplan's Cloud API v2 already knows every room's floor area, perimeter, wall surface net of openings, ceiling height and volume, and has every pinned photo tagged with its floor and room. You are wiring that in, exactly as designed in `docs/Magicplan_Integration_Design.md`, in three PRs: **M1** create-and-pull, **M3** measured quantities into the estimate draft, **M2** the export-button doorbell. **M4 is dropped. M5 is later.** The design doc is approved and every question in it is ruled — read §2 and §6 there and do not re-open them.

## 1. Read these first, in this order

1. `docs/Magicplan_Integration_Design.md` — the spec. §1 is the API (verified against the live OpenAPI 3.1.1 document on 2026-09-24), §2 locked decisions, §3 the flow, §4 data, §5 UI, §6 rulings, §7 sequencing, §8 fence, §9 risks.
2. `docs/Lead_Bid_Workflow_Design.md` — the bid file (`bj-<tileId>`), the Bid card, the Site Visit panel, and the ownership rule (field owns the packet; board/admin own stage and dates). PRs 1–4 of it are merged (#222, #223, #225, #226).
3. `docs/Narrated_Walkthrough_Design.md` — not yours to build; read §2 and §12 so the boundary is clear (scope comes from the walk; quantities come from Magicplan).
4. `docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md` (P1 contract tables, proposals, the "field app owns the blob" rule), `09-ROLE-ENUM-AND-OPERATION-CATALOG.md` (role vocabulary), `E0-RUNBOOK.md` §0 (**never `supabase db push`**; how migrations actually get applied), `00-SYSTEM-INVENTORY.md` §6.8.
5. Code you will extend — read them whole before touching anything:
   - `apps/field/js/sitevisit.js` (`siteVisitOf`, `siteFilePath`, `packetForDraft`, the slots, the `files[]` shape, `uploadSiteFile` usage)
   - `apps/field/js/app.js` — the Bid card (search `bidOf`) and the Leads / Bids group; `apps/field/js/boardpush.js` (`tilesNeedingFieldFile`, `fieldSeedFromBoardJob`, `adoptBoardJobs`)
   - `apps/field/js/supa.js` (`uploadSiteFile`, `downloadSiteFile`, `ensureFresh`, `authHeaders`, how the app calls an edge function) and `apps/field/js/officeai.js` (the client side of `roybal-ai-office` actions — copy its envelope/error handling)
   - `apps/field/js/forms.js` — the Floor Plan form and its `dimensions.rooms[]` rows (search `Read dimensions`), the estimate form's Pricing Basis
   - `supabase/functions/gmail-proxy/index.ts` — the **default-deny `ACTION_AUTH` gate** and `OFFICE_ROLES`; this is the security recipe you copy
   - `supabase/functions/roybal-ai-office/index.ts` — `signMedia`, `isSitePath`, `MEDIA_BUCKET`, how `ai_usage` is metered; `supabase/functions/roybal-ai-office/sitevisit.ts` — the draft prompt and `SiteFile` type (M3 lands here)
   - `apps/admin/js/qboconnect.js` and `gmailconnect.js` — the Settings connection-panel recipe
   - `supabase/migrations/0004_backbone_contract_tables.sql` (`jobs_queue` at :649, `events` at :553, `proposals` at :399, `current_role_name()` at :130) and `0008_baseline_acl_revokes.sql` (the REVOKE posture every new table follows); `supabase/tests/0004_p1_contract.test.sql` (the SQL test pattern)
   - `package.json` scripts (`npm test` = field + board + fn tests; fn tests run `node --test --experimental-strip-types supabase/functions/*/*.test.mjs`), `apps/field/test/*.test.mjs`, `apps/field/js/config.js` (`BUILD`)
6. `git log --oneline -15 origin/main` — PR titles are the convention: `Leads / Bids PR 3: send the estimate from the field (v181) (#225)`. Yours read `Magicplan M1: create the project and pull the scan into the packet (v184)`.

## 2. House rules — every one of these has a scar behind it

1. **Start from `origin/main`, not the checked-out branch.** `git fetch origin`, then `git worktree add .claude/worktrees/magicplan-m1 -b feat/magicplan-m1 origin/main`. Work only in the worktree. The main checkout may be sitting on an unrelated fix branch.
2. **Additive only.** New table, new functions, new module, new optional blob fields. No renamed field, no changed existing table, no touch to era-0 tables (`floor_plans`, `canvas_plans`, …) — they stay dead. Deleting your PR must restore today exactly.
3. **The company key never reaches a browser.** All Magicplan calls run in `magicplan-proxy` with `verify_jwt = true` in `supabase/config.toml`. No `cloud.magicplan.app` string anywhere under `apps/`. No key in `config.js`, tests, fixtures, or PR text.
4. **Default-deny action gate**, copied from `gmail-proxy`: an action not listed in `ACTION_AUTH` is refused before dispatch. Every action here is `office` (roles `owner`, `office`, `admin`, both vocabularies until 0007's cutover is complete — check 09 §1.2).
5. **The field app owns the blob.** The server writes `magicplan_exports` rows and `field-media` objects. It never writes `field_projects`. The field app merges what it reads into `project.siteVisit` through its own `Store.put` + sync. This is the Aug-6 clobber lesson; do not open a second write door.
6. **Migrations:** one file, `supabase/migrations/0009_magicplan_exports.sql`, idempotent (`create table if not exists`, `drop policy if exists` before `create policy`), `revoke all … from anon`, RLS on, service-role write only, owner/office read via `current_role_name()`. Applied to **staging only** (`efbuagiwowcwwsezkgsw`) by the path the repo actually uses (see #210 "the button that puts a merged migration into a database" and E0-RUNBOOK §0) — **never `db push`, never production**. Production is the owner's hand after merge. Add `supabase/tests/0009_magicplan_exports.test.sql` in the 0004 pattern and run it on staging.
7. **Tests or it didn't happen.** Every pure helper (normalization, photo-name parse, path builder, units, room dedupe, adopt-merge) gets Node tests. `npm test` green before every commit. Fixtures are hand-written from the §1 shapes — never a recorded response containing the key or a customer's address.
8. **Trust the live response over the doc.** If a real API response disagrees with §1, fix the module to the live shape, add a fixture for it, and say so in the PR body. Never "handle several known shapes" — that sentence is why era 0's proxy was deleted.
9. **Build bump** in `apps/field/js/config.js` (`v183` on `origin/main` as of this writing — read it fresh) once per PR that changes `apps/field`.
10. **Staging shares the owner's one live Magicplan workspace.** Every project name goes through the `MAGICPLAN_NAME_PREFIX` secret (`"[STAGING] "` on staging, empty on prod). Archive every staging test project you create before you finish.
11. **Stop and ask only for owner-only steps** (§6 below). Everything else is ruled; do not ask about it. When you stop, print the exact command or click path he needs, then wait.
12. **One PR per phase.** Push the branch, open the PR with what / why / how tested / rollback / what the owner must do to deploy, and stop. Do not start the next phase until he says the previous one merged.

## 3. Rulings you must not re-open (from the design doc, §2 and §6)

- Magicplan is a **capture device, not a system of record**: everything is copied into `field-media` and the blob at sync; no Magicplan URL is ever stored for read-time use.
- **Project `email`** = `MAGICPLAN_PROJECT_EMAIL` secret (the owner's login, the only seat). `siteVisit.by` is recorded, not used for `email`.
- **Create at scheduling**, no deferral, no quota logic. Cancelled visit → `PUT /projects/{id}/archive`.
- **Creation fires from the field app only** (owner/office JWT) when a bid file has `siteVisit.at` and no `siteVisit.magicplan` — idempotent (look up by `external_reference_id` first). Manual path: **📐 Create Magicplan project** on the Bid card. Admin-side creation is a follow-up, not M1.
- **The webhook is a doorbell**, never a source: payload URLs are ignored; the sync refetches with our credentials. `key` check + IP rate limit; a forged POST writes a refused `events` row and nothing else.
- **Quantities are offered, never applied silently**: measured rows land amber with `source: "magicplan"`; the one exception is an **empty** Floor Plan table, which accepts them with `conf: 1`. Pricing Basis prints "Quantities from Magicplan LiDAR scan dated …".
- **Adopt-on-open is automatic on the owner's device**, banner-and-tap on every other device (per-device setting, default on for the owner).
- **Server-written paths use the client's shape**: `sitevisit/<job>/mp-<hash8>-<cleanname>` and must pass the server's `isSitePath()` and match `siteFilePath()`'s cleaning rules. Write the test that proves it.
- **M4 (per-room form in Magicplan) is dropped. M5 is later.** Build order **M1 → M3 → M2**.
- Not in scope, anywhere: a Magicplan estimator, Magicplan pricing, Xactimate price data on a customer surface (ESX is a sketch file for the carrier packet only), any automation that changes an estimate without a tap.

## 4. M1 — create the project, pull the scan into the packet

### 4.1 Deliverables

**Migration `0009_magicplan_exports.sql`** — the table in design §4.1 verbatim (`id, mp_project_id, mp_plan_id, field_project_id, status, files, photos, statistics, floors_svg, error, received_at, synced_at, imported_at, imported_by`), plus an index on `(field_project_id, imported_at)`. Comment on the table saying what writes it and what reads it. SQL test: insert as service role succeeds, select as an owner-role JWT succeeds, select as a crew-role JWT returns zero rows, insert as authenticated is refused, anon has nothing.

**Edge function `supabase/functions/magicplan-proxy/`** — `index.ts` (transport, gate, dispatch, metering-free) and `magicplan.ts` (pure: request builders, response normalizers, parsers — importable under `--experimental-strip-types`) with `magicplan.test.mjs`. Secrets: `MAGICPLAN_API_KEY`, `MAGICPLAN_CUSTOMER_ID`, `MAGICPLAN_PROJECT_EMAIL`, `MAGICPLAN_NAME_PREFIX`. Headers on every call: `key`, `customer`. Base `https://cloud.magicplan.app/api/v2`. Respect `429` with one backoff retry, then fail loud. Actions, all `office`:

| Action | Input | Does | Returns |
|---|---|---|---|
| `getWorkspace` | — | `GET /workspace` | `{name, …}` for the Settings panel |
| `createProject` | `{fieldProjectId, customer, address:{street,city,postal_code,country:'US'}, by}` | `GET /projects?name=<prefix+name>` and check `external_reference_id`; if absent `POST /projects` with `name: prefix + "<Customer> — <street>"`, `external_reference_id: fieldProjectId`, `email: MAGICPLAN_PROJECT_EMAIL`, `address` | `{projectId, planId, cloudUrl, createdAt, existed:boolean}` |
| `status` | `{projectId}` | `GET /projects/{id}` | `{externalReferenceId, userModified, archivedAt, planId}` |
| `sync` | `{projectId, fieldProjectId}` | the algorithm in 4.2 | the `magicplan_exports` row |
| `markImported` | `{exportId, fieldProjectId}` | stamps `imported_at`, `imported_by` (service role; verifies the row's `field_project_id` matches) | `{ok:true}` |
| `archiveProject` | `{projectId}` | `PUT /projects/{id}/archive` | `{ok:true}` |

**Field app `apps/field/js/magicplan.js`** (new, ES module, no framework) with `apps/field/test/magicplan.test.mjs`:
- `ensureMagicplanProject(project)` — the creation rule above; called from the Bid card render path when online and the caller is owner/office; writes `siteVisit.magicplan = {projectId, planId, cloudUrl, createdAt, by, units:null}` through the normal `Store.put`.
- `pullMagicplan(project)` — calls `sync`, then `adoptIfReady(project)`.
- `adoptIfReady(project)` — reads `magicplan_exports where field_project_id = … and imported_at is null` (PostgREST, owner/office RLS); on the owner's device adopts at once, elsewhere shows the banner; `adoptExport(project, row)` is the pure merge: files → `siteVisit.files[]` as `{id:'mp-<hash8>', kind:'report'|'photos', name, path, mime, size, room, caption, source:'magicplan', at}` (re-sync replaces same-hash rows in place, never duplicates); `project.rooms` filled from the room names only when empty; Floor Plan `dimensions.rooms[]` rows per ruling (amber, or accepted when the table was empty); `siteVisit.magicplan.syncedAt/exportId/units`; then `markImported`.
- Pure helpers: `parsePhotoName("1st Floor - Living Room - Window - 2.jpg") → {floor, room, caption}` (fails to `room:""` rather than guessing), `normalizeStatistics(stats) → {units, floors:[{name, rooms:[{name, floorSF, perimLF, ceilingFt, wallSF, wallSFNet, doors, windows, volumeCF, dims}]}]}` with the metric conversions and rounding in design §4.3, `dedupeRoomNames` (floor prefix only on collision), `mpFilePath(job, hash, name)`.

**UI** — design §5, nothing more:
- **Bid card** (`app.js`): one line `📐 Magicplan  <state>` with states *not created · ready on phone · scan received · imported · updated since import*, and the two buttons **📐 Create Magicplan project** (when absent) / **⟳ Pull** (when present). "Updated since import" comes from `status().userModified > syncedAt`, checked on open when online.
- **Site Visit panel** (`sitevisit.js`): the 📥 adopt banner — "Magicplan scan ready — 1 report, 14 photos, 6 rooms measured · **Add to packet**"; imported rows carry a small `Magicplan` tag; ✕ on a Magicplan row removes it from the packet but never deletes the storage object.
- **Floor Plan form** (`forms.js`): measured rows show the unit they came from and a `✓ Use measured` that sets `conf: 1`.
- **Admin ⚙ Settings** (`apps/admin/js/magicplanconnect.js`, the `qboconnect.js` recipe): workspace name from `getWorkspace`, staging/production prefix shown, last 10 `magicplan_exports` rows with status and a **Link to job** picker for `unmatched` rows (design §5, listing case). No Register button yet — that is M2.

### 4.2 The sync algorithm (server, `sync` action)

1. `GET /projects/{projectId}` → if `external_reference_id !== fieldProjectId` write a row `status:'unmatched'` with `field_project_id: null` and return it. Never import into the wrong job.
2. `GET /plans/{planId}/files?format[]=pdf&include_photos=true` → for each file and photo: fetch bytes server-side, `sha256`, path `sitevisit/<job>/mp-<hash8>-<cleanname>` (clean with the same rules as `siteFilePath`; assert it passes `isSitePath`), `POST /storage/v1/object/field-media/<path>` with `x-upsert: true` under the **service role**; skip the download when a previous `ready|imported` row for this plan already lists the same `hash`. Photos: `parsePhotoName` → `room`, `floor`, `caption`; keep `symbol_instance_id`.
3. `GET /plans/statistics/{planId}` → `normalizeStatistics`. `GET /projects/{projectId}/plan` → each floor's `image` SVG fetched and stored the same way → `floors_svg[]`.
4. Insert the `magicplan_exports` row `status:'ready'` with `files[]`, `photos[]`, `statistics`, `floors_svg[]`, `synced_at`. Any throw → row `status:'failed'` with `error`, and the error text goes back to the phone as a toast.
5. Nothing here touches `field_projects`.

### 4.3 Done when (M1) — verify on staging with the owner

1. `npm test` green; the SQL test passes on staging; `supabase functions deploy magicplan-proxy --project-ref efbuagiwowcwwsezkgsw` succeeds; the field app on staging loads with the new build.
2. **Owner step:** he opens a bid file on staging that has a scheduled site visit → the Bid card shows *ready on phone* and a project named `[STAGING] <Customer> — <street>` is on his phone in the Magicplan app.
3. **Owner step:** he scans one room at the shop, pins two photos to it, exports the Report PDF inside Magicplan.
4. He taps **⟳ Pull** → the adopt banner (or auto-adopt on his device) → the packet shows the Report PDF and two photos captioned with the room, `project.rooms` has the room, the Floor Plan table shows the measured row with its unit, and `packetForDraft()` returns them without any special case.
5. A second **⟳ Pull** adds nothing (same hashes). Archiving the staging project from the Settings panel works.
6. You archive every `[STAGING]` project you created.

Open the PR. In the body: what a reviewer should click on staging, the exact prod steps (`0009` via the repo's migration path, `supabase secrets set MAGICPLAN_PROJECT_EMAIL=… MAGICPLAN_NAME_PREFIX= --project-ref djpgvcvhvgrzgaziruze`, `supabase functions deploy magicplan-proxy --project-ref djpgvcvhvgrzgaziruze`, field build deploy), and the rollback (drop the table, delete the function, revert the build — today returns).

## 5. M3 — measured quantities in the draft (after M1 is merged)

Branch `feat/magicplan-m3` off the new `origin/main`.

1. `sitevisit.ts`: the packet gains an optional `magicplanQuantities` block — `{scannedAt, units, rooms:[{name, floorSF, perimLF, ceilingFt, wallSF, wallSFNet, doors, windows, volumeCF}]}` — built client-side from `siteVisit.magicplan` + the normalized statistics (already on the blob after adopt). The prompt gets one new evidence section, `MEASURED QUANTITIES (Magicplan LiDAR, <date>)`, and one new rule: *use measured quantities over anything read off the report PDF; cite them as `Magicplan: 214 ft² floor, 58 LF perimeter`*. `MAX_*` caps unchanged. Tests in `sitevisit.test.mjs`: the block renders, an empty block renders nothing, metric input never reaches the prompt un-converted.
2. Estimate form: Pricing Basis sentence "Quantities from Magicplan LiDAR scan dated …; wall areas net of openings." appended when the packet has the block; per-line `basis` already flows.
3. Floor SVG → offered as the Moisture Map base plan and the Scope of Work reference plan (a "Use Magicplan floor plan" chip where those forms take a plan image; find the existing plan-image paths in `forms.js` and reuse them — do not invent a new image field).
4. `dryingcalc.js` (`:73-126` is volume-based already): when a room has `volumeCF` from Magicplan and no typed volume, offer it amber.
5. ESX: add the `custom-export` call behind a feature check (`generated_by: ExportConfig.XactimateEsx` present in the workspace's export configs). If the config does not exist, the code path is built and idle — no error, no toast. Stored as a `supportDocs[]` entry on claim jobs only.

**Done when:** a drafted estimate's baseboard line reads `58 LF (Magicplan)` in its basis, the Pricing Basis carries the sentence, and a metric test plan produces feet in the prompt.

## 6. M2 — the doorbell (after M3 is merged **and** the export config exists)

**Stop and ask first:** *"Is the Roybal export configuration set up in Magicplan Cloud (Report PDF + Sketch PDF; ESX if you want it on claims), and what is its name?"* If not, print the click path (`cloud.magicplan.app` → workspace → export configurations) and wait. Also ask him to generate `MAGICPLAN_EXPORT_KEY` (any long random string) and set it on staging.

Branch `feat/magicplan-m2`.

1. `supabase/functions/magicplan-webhook/` — trust level C: `verify_jwt = false`, self-protecting. Three routes: `authorize` (GET; answers `<status>0</status>` only when `project_id` resolves to a live bid file **or** `listing` is one of ours, else `<status>1</status>`), `listing` (GET; the open bid files as `{title, listing}` for the phone picker), `webhook` (POST, **form-encoded**; check `key === MAGICPLAN_EXPORT_KEY`, rate-limit by IP, **ignore every URL in the payload**, resolve `project_id` → `field_project_id` via `external_reference_id` (or `listing`), insert `jobs_queue` row `magicplan.sync {projectId, planId, fieldProjectId}` and an `events` row `magicplan.export_received`, answer `<status>0</status>`). A bad key writes `events` `magicplan.webhook_refused` with the IP and nothing else.
2. **There is no P1 worker yet.** The webhook runs the same sync module the proxy uses (import it from a shared file under `supabase/functions/_shared/`), in service-role context, right after answering — and marks the `jobs_queue` row done or failed. When the worker exists it takes the row over; nothing here has to change.
3. Push: on `ready`, one owner notification through `roybal-notify`'s existing owner path — "📐 Magicplan scan received — <Customer> · 1 report · 14 photos · 6 rooms". No customer sends.
4. Settings panel: **Register** button → `PUT /workspace {webhook_url, authorize_url, listing_url, logo, notify_user}` via a new proxy action `registerWorkspace`; shows the registered URLs and the date.
5. Tests: form-encoded parse, key refusal, the XML replies, the listing shape, IP limiter — all pure, all Node.

**Done when:** tapping the Roybal export button in Magicplan lands the report, photos and quantities on the bid file with zero taps on our side; a forged POST (`curl` with a wrong key) produces one `events` row and no queue row; the owner's phone gets the notification.

## 7. Stop-and-ask points — the only ones

| When | Ask for | Why you can't do it |
|---|---|---|
| Before the first live call in M1 | `supabase secrets set MAGICPLAN_API_KEY=… MAGICPLAN_CUSTOMER_ID=… MAGICPLAN_PROJECT_EMAIL=branden@roybalconstruction.com MAGICPLAN_NAME_PREFIX="[STAGING] " --project-ref efbuagiwowcwwsezkgsw` | The key exists only in his Magicplan account and in prod secrets |
| M1 §4.3 steps 2–4 | A scheduled bid file on staging, one scan, two pinned photos, one in-app export | Needs a phone with LiDAR and the Magicplan app |
| Before M2 | Export configuration name; `MAGICPLAN_EXPORT_KEY` on staging | Workspace settings live in Magicplan Cloud |
| A live response contradicts design §1 | Nothing — fix to the live shape, add the fixture, note it in the PR | (this is not a stop; it is a rule) |
| Anything that would touch production | Nothing — don't. Put the exact steps in the PR body. | Owner deploys after merge |

## 8. What "finished" looks like for each PR

- Branch pushed, PR open with: **What** (one paragraph), **Why** (one line pointing at the design doc section), **How tested** (the Node tests, the SQL test, the staging click-through with what you saw), **Owner steps to deploy** (exact commands), **Rollback** (exact steps), **Deviations from the design doc** (or "none").
- `npm test` output pasted. Build bumped. No `cloud.magicplan.app` under `apps/`. No secret anywhere in the diff.
- Staging test projects archived.
- Then stop, and say which phase is next and what you need from him to start it.
