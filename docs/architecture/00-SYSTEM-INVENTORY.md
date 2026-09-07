# 00 — System Inventory (Phase 1)

**Repo:** `roybal-restoration-app` · **Branch:** `main` @ `1e04694` (2026-09-05) · **Live project:** Supabase `djpgvcvhvgrzgaziruze` (Postgres 17.6, us-west-2, created 2026-03-12) · **Audit date:** 2026-09-05/06 · **Mode:** read-only. Nothing in the tree was modified; the only files created are the deliverables under `docs/architecture/`.

**How this was produced.** Nine parallel read-only readers covered every area (field runtime, field forms/documents, board, admin+portal, site/docs/phone agent, migrations, AI edge functions, integration edge functions, tooling). Each reader's twenty most important claims were then re-checked by an independent verifier that opened the cited lines: **177 of 180 confirmed, 3 were true claims with an off-by-a-few-lines citation, 0 wrong claims.** Separately, the live database was read through the Supabase MCP (tables, policies, functions, triggers, cron, buckets, row counts, `pg_stat_statements`, edge-function list, advisors, logs). Where the repo and the live system disagree, the live system is reported and the disagreement is flagged.

**Citation style.** `path:line` or `path:start-end`, relative to the repo root. "(live)" marks a fact read from the production database or platform, not from the repo. "INFER" marks the few places reasoning replaced reading.

---

## 0. Corrections to the stated mental model

| You believed | What the tree actually holds | Evidence |
|---|---|---|
| A React Native / Expo mobile app for crew | **Gone.** `apps/mobile` was deleted on 2026-08-13 in commit `4fef103` ("Remove the abandoned React/Expo app line"). It exists only in git history. | `git log --diff-filter=D -- apps/mobile/package.json`; `README.md:150-155` |
| A React + Vite web app for the office | **Gone**, same commit. `apps/web` and `packages/shared` were deleted with it. The root `package-lock.json` still carries `extraneous` entries for all three. | `package-lock.json:31,79,7434` |
| Field Forms app is "closer to vanilla HTML/JS" | Correct, and it is far more than a forms app: 44 ES modules / 16,986 LOC holding the document builder, the offline sync engine, the AI glue, the board bridge, the portal publisher, and the modules the admin and board apps import. | `apps/field/js/*.js`; §1.2 below |
| Separate office app | The **admin** (`apps/admin`) and the **board** (`apps/board`) are not standalone apps. They import 14 field modules by relative path (`../../js/*.js`, 58 import lines) and only resolve because the deploy lays the three directories out at `/`, `/admin`, `/board`. | `apps/admin/js/admin.js:8-11`; `apps/board/js/data.js:13-14`; `.github/workflows/deploy-field.yml:35-38` |
| A Supabase backend with "possibly edge functions" | 53 public tables, 14 deployed edge functions, 9 pg_cron jobs, 7 storage buckets, 43 user-defined SQL functions, plus a Node phone agent on Fly. Roughly 26 k lines of backend code and SQL. | §6 |
| PDF generation for estimates/invoices/reports | No PDF library exists. Every document is a live editable DOM printed with `window.print()` under a print stylesheet. There is no server-side or headless render path. | `apps/field/js/app.js:1552,1936,2413`; `apps/field/css/print.css`; `apps/field/js/pdf.js:12` (pdf.js is used only to *import* PDFs) |
| "Restoration" branding | Company is Roybal Construction LLC; the field app title, admin header, and package descriptions still say "Roybal Restoration". | `apps/admin/js/admin.js:2`; `apps/field/package.json:5` |

---

## 1. Repo layout and boundaries

### 1.1 Tree

```
roybal-restoration-app/
├── apps/
│   ├── field/      ⭐ 99 files · offline-first PWA · 44 js modules · 30 tests · sw.js · print.css
│   ├── admin/      16 files · office/CRM shell · 12 js · no package.json · no tests
│   ├── board/      17 files · job board + scheduling engine · 8 js · 4 tests
│   ├── portal/     15 files · customer status page (Vercel) · 5 js · no tests
│   └── site/       217 files · Astro 5 marketing site (Cloudflare Pages) · 3 build scripts
├── services/phone-agent/   Node 22 on Fly · Twilio ConversationRelay · 5 mjs · 1 test file
├── supabase/
│   ├── functions/  14 edge functions (Deno/TS, 44 files, 14,133 LOC incl. 13 test files) — no _shared/
│   ├── migrations/ 70 SQL files (10,001 LOC; 3,021 are the price-list seed)
│   └── config.toml verify_jwt pins per function
├── design-system/  20 static reference HTML pages (nothing imports them)
├── docs/           16 plan/design docs + 1 prototype
├── .site-archive/  36 raw Madwire pages + content.json (a build INPUT for the site parity check)
├── .github/workflows/deploy-field.yml   the only CI file (deploy only, no tests)
├── package.json    npm workspaces: apps/field, apps/board, apps/site only
├── tsconfig.base.json, deno.lock, wrangler.jsonc, setup.sh
└── .claude/ .cursor/ .agents/ .vercel/   local tooling (two 51 MB stale git worktrees under .claude/)
```

### 1.2 Is it a monorepo?

**Partially — a workspace root over three of five apps, with the other two riding on relative-path imports into `apps/field`.**

| Question | Answer | Evidence |
|---|---|---|
| Workspaces | `apps/field`, `apps/board`, `apps/site` only | `package.json:5-8` |
| Outside the workspace | `apps/admin`, `apps/portal` have no `package.json` and no dependencies | `ls apps/admin apps/portal` |
| Shared packages | None. `packages/` no longer exists. | tree |
| How admin/board share code | **By URL path.** 16 files in `apps/admin/js` + `apps/board/js` import 14 field modules via `../../js/*.js`: `core.js` ×15, `supa.js` ×11, `config.js` ×10, `sms.js` ×3, `gmail.js` ×3, `qbtime/qbo/model/fincalc/assist` ×2 each, `sync/portal/officeai/calibration` ×1 | `apps/admin/js/assistctx.js:13-22`; `apps/board/js/board.js:7-8,17-18` |
| Reverse coupling | The field app imports the **board's** scheduling engine the same way | `apps/field/js/myweekcalc.js:17-18`; precached by `apps/field/sw.js:27` |
| Why it works | Each `serve.mjs` composes the deployed layout locally; the field server maps `/board/*` back to `apps/board`; GitHub Pages lays them out at `/`, `/admin`, `/board`; the field service worker (scope `/`) caches all three | `apps/admin/serve.mjs:2-5,11-12,26-29`; `apps/field/serve.mjs:30-34`; `deploy-field.yml:36-38` |
| Truly independent | `apps/portal` (talks only to the `roybal-portal` gateway; keeps a "VERBATIM COPY" of `zip.js`), `apps/site`, `services/phone-agent` | `apps/portal/js/zip.js:3-5` |
| Lint / format / type tooling | **None.** No eslint/prettier/biome/editorconfig. Root `typescript@5.9.3` is installed but nothing runs `tsc`. `tsconfig.base.json` has zero references. `deno.lock` has zero consumers. | `package.json:22-24`; grep |
| Test runner | Plain `node` scripts chained with `&&`; 41 test files import `node:assert`; only 3 use `node:test`; 27 hand-roll an `ok()` harness | `package.json:11-16`; `apps/field/package.json:10` |
| CI | One workflow, deploy only, no `pull_request` trigger, no test step, still lists the deleted branch `claude/field-restoration-app-s6j2zk` | `.github/workflows/deploy-field.yml:12-19` |

**Verdict:** one product (field + admin + board) that happens to be three directories, plus three genuinely separate deployables (portal, site, phone agent), plus a backend of 14 hand-copied edge functions. The monorepo tooling that would make this coherent (shared package, lint, typecheck, CI tests) is absent.

### 1.3 Era timeline (from git)

| Era | Dates | What appeared | Status today |
|---|---|---|---|
| **0 — React/Expo** | 2026-03-12 → 08-13 | `apps/web`, `apps/mobile`, `packages/shared`, migrations 001-012 (normalized `jobs`/`rooms`/`moisture_readings`/`equipment_logs`/`line_items`/`invoices`/`photos`), `magicplan-webhook` | Apps deleted 08-13. Tables still live with single-digit leftover rows from March. `magicplan-webhook` still deployed, unreachable. |
| **1 — Static field line** | 06-08 → 06-11 | `apps/field`, `apps/admin`, `apps/board`; migrations 100-103 (`field_projects` blob, `coordination_jobs`, `crew_members`, `time_entries`) | The live product. |
| **2 — AI backbone + lanes** | 06-26 → 07-25 | migration 200 (`unified_jobs`, `capture_events`, completeness tables), `roybal-ai-office` (07-03), `roybal-notify` (07-11), `roybal-portal` + `apps/portal` (07-12), phone agent (07-18), `roybal-brief` (07-23), `pending_actions` (07-24), QB Time phase matching | Live. |
| **3 — Hardening + CRM + web** | 08-10 → 09-05 | Sync RPCs + tombstones (217-226, 241-243), individual logins (216), contacts CRM (228-232), `apps/site` + `roybal-web-agent` + `roybal-lead` (08-12), crew bios, lead triage (246), old apps deleted (08-13) | Live. |

Commit cadence: Mar 24 · Jun 67 · Jul 244 · Aug 139 · Sep 15 (489 total, 151 merges, PRs through #181). Per-area commits: field 213, functions 114, board 57, migrations 56, docs 52, admin 30, portal 16, site 11, services 10.

---

## 2. Weight

Raw `wc -l`; vendor, `node_modules`, `dist` excluded.

| Area | Code LOC | of which JS/TS | Test LOC | Test files | Notes |
|---|---|---|---|---|---|
| apps/field | 18,521 | 17,133 | 4,699 | 31 (28 wired into `npm test`) | `forms.js` 3,933 · `app.js` 2,680 · `boardpush.js` 773 · `assist.js` 769 · `core.js` 748 · `model.js` 692 · `sync.js` 638 |
| apps/board | 5,800 | 5,004 | 1,028 | 4 | `board.js` 3,042 · `schedule.js` 887 (pure engine) |
| apps/admin | 3,053 | 2,841 | 0 | 0 | 12 modules, largest `contacts.js` 390 |
| apps/portal | 1,501 | 1,123 | 0 | 0 | 3 pages, each with its own copy of the gateway helper |
| apps/site | 3,810 | 850 | 0 | 0 (3 build scripts, 266 lines) | 14 pages, 28 content files, 140 images (93 unreferenced) |
| services/phone-agent | 721 | 721 | 333 | 1 (13 tests, not in root `npm test`) | |
| supabase/functions | 11,678 | 11,678 | 2,148 | 13 | `roybal-ai-office/index.ts` 1,842 · `qb-time-proxy/index.ts` 1,289 · `roybal-portal/index.ts` 1,093 |
| supabase/migrations | 10,001 | — | 0 | — | 70 files; 43 unique `create table` |
| design-system | 971 | 0 | — | — | reference only |
| vendored (field) | 2,277 lines / 1.78 MB | — | — | — | pdf.js 4.10.38, qrcode |
| **Total application code** | **≈ 56,000** | | **≈ 8,200** | **49** | |

Mass sits in three places: the field app (33 %), the edge functions (21 %), and SQL (18 %). Client and server are the same size.

---

## 3. Tech stack per deployable

| Deployable | Runtime | Language / types | Build | Runtime deps | Dev deps | Tests | Deploy |
|---|---|---|---|---|---|---|---|
| field | browser PWA, IndexedDB, service worker | ES-module JS; 0 `@ts-check`, 0 JSDoc | none | **zero npm**; vendored pdf.js 4.10.38 + qrcode (no LICENSE files) | `fake-indexeddb@6.2.5`, `jsdom@24.1.3` | 30 files, node + jsdom | GitHub Pages on push to `main` |
| admin | browser | JS | none | zero | none | none | same bundle, `/admin` |
| board | browser, localStorage | JS | none | zero | none | 4 files | same bundle, `/board` |
| portal | browser | JS | none | zero | none | none | Vercel static (`vercel.json` rewrites `/j/*`, `/photos/*`, `/packet/*`) |
| site | Astro 5.18.2, `@astrojs/sitemap` 3.7.3 | Astro + 2 `.ts` | `astro build && postbuild.mjs && check-parity.mjs` | astro, sitemap | — (`astro check` script exists but `@astrojs/check` is not installed) | none | **manual** `npx wrangler pages deploy` (Cloudflare Pages `roybal-site-pages`); root `wrangler.jsonc` describes a *different*, unused Workers project |
| phone-agent | Node ≥22.6 on Fly (`roybal-phone`, sjc, 256 MB, 1 machine, HA forbidden) | `.mjs` + imports `personas.ts` via `--experimental-strip-types` | Docker from repo root | `ws@8.21.1` (root lock has 8.20.0 as a jsdom transitive) | — | 13 tests | manual `fly deploy` |
| 14 edge functions | Supabase Deno | TS (26 files), **never type-checked** (tests run under node strip-types; no `deno check`) | none | `std@0.168.0` ×11, `std@0.177.0` ×3; `esm.sh/@supabase/supabase-js@2` (major-only pin) ×4; raw `fetch` ×10 | — | 13 test files (pure helpers only; **zero tests touch any `index.ts`**) | manual `supabase functions deploy` or MCP |
| Postgres | Supabase Postgres 17.6 | plpgsql / SQL | — | extensions: pg_cron 1.6.4, pg_net 0.20 (in `public`), pg_trgm (in `public`), pgcrypto, uuid-ossp, pg_stat_statements, pg_graphql, vault | — | none | hand-applied migrations (SQL editor / MCP) |

**Version conflicts and dead tooling:** two `std` versions across functions; `supabase-js` pinned to a major in 4 functions while 10 others hand-roll PostgREST; `ws` differs between the two lockfiles; `typescript`, `tsconfig.base.json`, `deno.lock` are installed/committed and used by nothing (`tsconfig.base.json` declares `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` that no file extends). No CDN script tags in any live app; the 18 that exist are unpinned tailwind/lucide in `design-system/` reference pages, without SRI.

---

## 4. Entry points: boot, auth, backend

### 4.1 Field (`apps/field`)

- **Boot:** one `<script type="module" src="js/app.js">` (`index.html:39`); `load → boot()` requests persistent storage, sets author, starts sync if signed in, routes (`app.js:80,161-167`). Hash router `#/`, `#/new`, `#/week`, `#/help`, `#/p/:id[/edit|narrative|progress|packet|f/:key[/:inst]]` (`app.js:173-214`).
- **State:** IndexedDB `roybal-field` v2, stores `projects` and `backups` (≤10 snapshots/job) (`core.js:80-93,180-202`); one mutable `liveProject` bound to the open page, autosaved 350 ms after any `formkit.commit()` (`app.js:171`; `formkit.js:12-13`; `core.js:213-226`); 16 `localStorage` keys for session, sync cursors, tech pick, assistant prefs.
- **Auth:** **no supabase-js**. `supa.js` (294 lines) does password grant `POST /auth/v1/token?grant_type=password`, refresh at <60 s, one 401→refresh→retry; session `{access_token, refresh_token, expires_at, email}` in `localStorage["roybal-session"]` (`supa.js:8-19,34-86`). Gate = `SYNC_ENABLED && !isSignedIn() && !isOfflineMode()`; "Work offline on this device" bypasses login entirely (`app.js:138,312-313`). **No role concept client-side** (`grep -rn '\brole\b' apps/field/js` finds only the chat-message role in `assist.js`; there are zero application-role references). Identity is three loose layers: auth email, a free-text device "tech pick" (`tech.js:17,53-60,101-106`), and `author()` = email (`model.js:125-131`).
- **Backend:** Supabase URL + publishable key + three OAuth client IDs committed in `config.js:7-8,33,41,50`; `BUILD = "v165"` (`config.js:25`) vs service-worker cache `v166` (`sw.js:6`) — **drift; `build.test.mjs` fails at HEAD**.
- **Service worker:** cache `roybal-field-v166`, CORE precache + OPTIONAL vendor, navigations network-first, same-origin stale-while-revalidate; precache omits two statically imported modules (`photoshare.js`, `calibration.js`) and includes the deprecated `pricing.js` (`sw.js:8-38`).

### 4.2 Admin (`apps/admin`) — sub-app of field

- Imports `core.js`, `config.js`, `supa.js`, `sync.js`, `assist.js` from `../../js/` (`admin.js:8-11,21`); links `../css/app.css`. Boot: if signed in → start the **field sync engine** (pulls every `field_projects` blob into the office browser's IndexedDB) → hash router (Today, Leads, Jobs, Contacts, Campaigns, Analytics, Settings, `#/c/<uuid>`) → chain of three OAuth callback handlers (Gmail, QBO, QB Time) (`admin.js:166-184`).
- Auth = `isSignedIn()` only; login copy says "Sign in with your shared crew account" (`admin.js:91,206`). No client role check; the Leads write path refuses non-`admin|office` JWTs server-side (`246_lead_triage_grant.sql:47-52`).

### 4.3 Board (`apps/board`) — sub-app of field

- One module `js/board.js?v=64` with hand-bumped cache-busting; no service worker of its own, runs under the field SW; a 3.5 s "stale-module guard" force-reloads if `#view` is empty (`index.html:16,34-48,53`). State = module-level globals + `localStorage` caches `roybal-board-jobs|crew|time|queue|settings` (`board.js:90-115`; `data.js:25-29`). Auth = field `signIn/signOut`; UI still says "Everyone shares one login" (`board.js:293,3009`). Refresh = 20 s polling of three whole tables + full schedule recompute per open tab (`board.js:205-208,226-255`); no Realtime.

### 4.4 Portal (`apps/portal`) — independent

- Three pages (`index`, `packet`, `photos`), each with its own copy of `h()`/`tokenFromUrl()`/`callGateway()` (`portal.js:10-39`; `packet.js:13-41`; `photos.js:14-42`). Credential = 48-hex share token in the URL `/j/<token>`; every request is a POST to the `roybal-portal` edge function with the publishable key as `Authorization` (`portal.js:30-35`; `config.js:5-6`). Optional CF-1 "account": 6-digit SMS code → 180-day bearer session in `localStorage` (`portal.js:293-340`; `roybal-portal/index.ts:776-899`). **(live)** `contact_sessions` = 0 rows ever; the account path has never been used.

### 4.5 Site (`apps/site`) — independent

- Astro 5, `build.format:"file"`, `trailingSlash:"never"` to preserve 36 ranking URLs (`astro.config.mjs:16-25`); `postbuild.mjs` fails the build unless the quote form and receptionist endpoints are wired; `check-parity.mjs` diffs `dist/` against `.site-archive/content.json`. Calls `roybal-lead` and `roybal-web-agent` with **no key header** (`QuoteForm.astro:130-134`; `Receptionist.astro:193-197`), so both must stay `verify_jwt=false`.

### 4.6 Phone agent (`services/phone-agent`) — independent

- Twilio ConversationRelay does STT/TTS; the agent is text-only over a WebSocket `/relay` gated by `PHONE_RELAY_TOKEN` (`server.mjs:2-16,73-79,191`). Signs in as `phone-agent@roybalconstruction.com` by password grant and uses anon key + that JWT for every REST call (`config.mjs:18`; `supa.mjs:30-33,52`). Tools defined in the shared `personas.ts` (`PHONE_TOOLS`: lookupCaller, availability, createLead, textOwner, escalate) as Anthropic JSON-schema tools; executors are a `switch` (`tools.mjs:199-214`). Shares `personas.ts` and `schedule.js` via Docker `COPY` from the repo root (`Dockerfile:8-9`). Per-caller rate limits are an in-memory `Map`, hence one machine (`tools.mjs:19-27`; `README.md:64-65`).

### 4.7 Edge functions (14) — see §6.9 for the full table

Two data-access styles (supabase-js in 4, raw PostgREST `fetch` in 10), two response envelopes, CORS block copy-pasted in 11, `x-cron-secret` check hand-written 8 times (incl. `roybal-portal/index.ts:1053`), no `_shared/` directory.

---

## 5. Data-access census

Nothing in the clients uses supabase-js. Every client call is a hand-built PostgREST/Storage/Auth URL through a per-app wrapper, or a raw `fetch` to an edge function.

| App | Distinct patterns | Sites | Tables touched (string literals) | RPCs |
|---|---|---|---|---|
| field | **8**: (A) `rest()`→`api()` PostgREST with refresh-retry (50 call sites in 13 files); (B) sync `rpc()` adding `p_build`; (C) RPC via `rest("rpc/…")` **bypassing** the build gate; (D) Storage REST (`field-media`, `crew-photos`); (E) edge functions via `callFunction()`; (F) edge functions via raw `fetch` with **no 401 retry** (`narrative.js:391`, `officeai.js:41`, `voice.js:58`); (G) legacy direct-table writes (dead, revoked by migration 219); (H) `?diag` health probe | `supa.js:74-86,101-129,133-194,211-265,278-294` | coordination_jobs(12) portal_jobs(9) unified_jobs(5) time_entries(4) portal_messages(4) portal_selections(3) photo_shares(3) email_messages(3) field_projects(2) crew_members(2) contacts(2) capture_events(2) sms_messages qb_time_jobcodes price_list — **14 tables, 5 RPCs, 7 edge functions, 2 buckets** | push_project, tombstone_project, revive_project, contact_resolve, contact_mark_review_asked |
| board | **5**: client-side rev-guarded PATCH; last-write-wins upsert; full-table paged read (20 pages × 1,000, silent cap); storage; edge fn | all 6 `rest(` sites in `data.js:110-163,220-225` — the data layer is respected | coordination_jobs, crew_members, time_entries | none (never calls `coordination_job_patch`) |
| admin | **6**: PostgREST via `rest()` (25 sites); RPC; edge-fn proxies; local IndexedDB `Store` + field sync engine; raw `fetch` to `roybal-ai-office`; browser OAuth redirects | `leads.js`, `contacts.js`, `campaigns.js`, `analytics.js`, `messages.js`, `assistctx.js`, `finactions.js` | contacts(7) coordination_jobs(4) contact_merge_suggestions(4) sms_messages(3) unified_jobs time_entries portal_messages + `contact_timeline` view | coordination_job_patch, contact_merge |
| portal | **1**: `fetch` to `roybal-portal` | `portal.js:31`; `packet.js:33`; `photos.js:34` | none directly (18 gateway actions) | — |
| phone agent | raw REST via `supa.mjs` | `tools.mjs` | coordination_jobs(3) ai_usage(3) capture_events(2) unified_jobs time_entries crew_members | contact_resolve |
| edge functions | supabase-js ×4 (`gmail-proxy`, `qb-time-proxy`, `qbo-proxy`, `magicplan-webhook`); raw fetch ×10 (`roybal-portal` alone has 38 `rest/v1` sites); `qbo-proxy` mixes both | — | time_entries(8) pending_actions(6) gmail_tokens(6) qbo_tokens(5) qb_time_tokens(5) email_messages(5) field_projects(4) coordination_jobs(4) contacts(3) capture_events(3) ai_usage(3) jobs(2) floor_plans(2) unified_jobs qb_time_jobcodes profiles portal_jobs | contact_resolve, web_* (4), portal_access_* (2) |

**No repository or service layer exists anywhere.** PostgREST query strings are inline in 15 field files; the board's `data.js` is the closest thing to a data layer and is respected within the board only. Writes to `coordination_jobs` are protected by a hand-rolled rev guard implemented **five** times (`apps/board/js/data.js:110-132`; `apps/field/js/boardpush.js:302-320`; `roybal-notify/index.ts:501-510`; `qbo-proxy/index.ts:429-431`; SQL `coordination_job_patch`, top-level keys only).

**Cross-app coupling summary.** The field app writes board tiles (`boardpush.js`: create/adopt/heal/actuals/proposals via same-rev "annotation" PATCHes), the spine (`spine.js` → `unified_jobs` + `contact_resolve`), portal rows, selections, photo shares. The board reads field-written keys (`fieldActuals`, `fieldPlanProposal`, `fieldJobId`). The admin runs the field sync engine to get jobs. The brief, phone agent, portal gateway, qb-time-proxy and web lead all insert into or read `coordination_jobs`. Tile lifecycle is split: creation/respawn is field code, deletion is board code, each side works around the other (`boardpush.js:704-773`; `data.js:208-214`).

---

## 6. Supabase — the live system

### 6.1 Tables (53, all RLS-enabled) by era

Row counts are exact live counts (2026-09-06). "Refs" = application code references outside migrations.

**Era 0 — normalized restoration model (migrations 001-012, for the deleted React app).** No live app reads or writes these; the only code targeting them is the unreachable `magicplan-webhook`. Rows are March-2026 leftovers.

| Table | Rows | FKs | Notes |
|---|---|---|---|
| jobs | 2 | created_by, assigned_pm_id → auth.users | `job_number` sequence trigger `RC-YYYY-NNN`; 18-value `job_status` enum (repo has 6); `assigned_tech_ids uuid[]` |
| rooms, room_openings, room_markers | 6 / 0 / 0 | job, canvas_plan | |
| moisture_readings | 6 | job, room, recorded_by | `is_dry` computed by trigger |
| equipment_logs | 5 | job, room, placed_by | `equipment_type` enum |
| line_items | 2 | job, room | `total_cents` generated column |
| invoices | 1 | job, created_by | `set_invoice_number` trigger |
| photos | 9 | job, room, uploaded_by | `photo_category` enum |
| floor_plans, canvas_plans, manual_floor_plans, floor_plan_rooms, floor_plan_openings | 2 / 0 / 1 / 0 / 0 | job / plan | Magicplan + hand-drawn editors |
| documents, tasks, communications, work_authorizations, tech_checkins, reconstruction_items | 0 each | job, auth.users | **no DDL in the repo** for documents/tasks/communications/work_authorizations/canvas_plans/tech_checkins/reconstruction_items/invoices — created by the empty placeholder migrations 005-012 |
| profiles | **11** | id → auth.users | `role user_role` {admin 2, tech 7, viewer 2}; the two viewers are the machine users |

**Era 1 — JSONB blob tables (100-110).** The system of record.

| Table | Rows | Shape | FKs | Soft delete | Audit |
|---|---|---|---|---|---|
| **field_projects** | 42 (15 live, 27 tombstoned) | `data jsonb` = the whole job (avg 50 kB, max 227 kB, 743 kB total live); 80 distinct top-level keys observed (Appendix A) | **none** | `deleted bool` + `field_projects_trash` copy + per-element `data.deletedIds` (≤2,000) | created/updated_at, `updated_by uuid`, `blob_history` pre-images |
| **coordination_jobs** | 81 (incl. settings row `00000000-…-01`) | `data jsonb`: stage, dates, `subtasks[]` (phases), `crewIds`, `dayCrew`, `deps[]`, CRM keys (`channel`, `leadLog[]`, `outcome`), `rev` (Appendix B) | none | `deleted bool`; `data.archived` | c/u_at, `updated_by`, `blob_history` |
| crew_members | 11 | `data jsonb`: name, phone, email, role (free text), hourlyRate, color, qbUserId, outDays, bio* | none | `deleted` | c/u_at; **last-write-wins, no rev** |
| time_entries | 1,193 (30 deleted) | `data jsonb`: jobId, date, hours, employee, qbTimesheetId, phaseId, phaseMatch (Appendix C) | none | `deleted` | c/u_at; **no unique index on `qbTimesheetId`** |
| qb_time_tokens / qb_time_jobcodes | 1 / 131 | plaintext OAuth tokens; jobcode cache | none | — | — |
| qbo_tokens | 1 | plaintext OAuth tokens | none | — | — |
| sms_messages | 181 (175 out, 6 in) | Twilio log; `unified_job_id`, `contact_id` | contact_id → contacts | none by design | `sent_by text` |
| portal_jobs | 7 | customer-safe projection; 9 JSONB columns (milestones, photos, documents, drying, closeout, approvals, billing, crew_intro_ids, selections_source) | contact_id → contacts | `enabled` | c/u_at |
| portal_messages | 29 | thread | portal_job_id cascade | none | created_at |
| price_list | 2,959 | Xactimate-style Fairbanks prices (see `docs/…` and memory re: Verisk EULA) | none | none | created_at |

**Era 2/3 — AI backbone, CRM, sync (200-246).**

| Table | Rows | Purpose | FKs | Notes |
|---|---|---|---|---|
| unified_jobs | 33 | "the spine" crosswalk (claim_number, carrier, adjuster, owner, loss_type, water_category/class, status, field_project_id, coordination_job_id) | contact_id → contacts; field/coordination/relational ids are **soft** by design (`200:105`) | **all 33 rows have `status='new'`** — the spine's status is never advanced |
| capture_events | 4,504 | ingest envelope + audit log + web-agent rate-limit state (`raw_payload`, `result jsonb`, `status text` unconstrained) | unified_job, phase_instance, contact | 3,500 are `emailPull`; per-organ events: photoAnalysis 249, fieldAssist 245, contentsVision 196, phoneCall 76, invoiceDraft 38, dailyBrief 27 … |
| ai_usage | 998 | cost ledger + live spend-cap gate + reservation state (in the free-text `note` column) | capture_event, unified_job | **$51.09 total spend**; `llm_model`/`stt_model` columns, no prompt id |
| pending_actions | 3 | approve-by-text proposals (`code int`, `kind`, `params jsonb`, `status`, `expires_at`, `executed_at`, `result`) | none | no approver column; all 3 rows `pending` since 2026-07-25, expired 07-26, never swept |
| phase_templates / required_forms / field_requirements | 1 / 9 / 28 | completeness "brain" seeded by 200 | template/form cascade | **zero app-code references** |
| phase_instances / completeness_state | 0 / 0 | per-job phase + gap state | unified_jobs cascade | zero app references |
| gmail_tokens / email_messages | 1 / 64 | Gmail OAuth; job-matched mail (`job_id text`) | contact_id → contacts | |
| portal_selections | 39 | customer put-back decisions | **none** (portal_job_id soft, unlike portal_messages) | |
| field_projects_trash | 9 | pre-delete copy | — | RLS on, no policies (service only) |
| blob_history | 272 (152 coordination, 120 field) | pre-image versions of both blob tables, lz4 | — | 11 MB; purged nightly to a rolling window |
| app_settings | 1 | `min_field_build` gate | — | **(live) value = 0 → gate unarmed** |
| field_photos | 748 | photo rows projected from the blob by triggers | none by design | **zero readers** in any app or function; repaired nightly by cron |
| sync_clients | 6 | build telemetry per user | — | (live) four devices report `v165`, one `v155`, one `v153` |
| contacts / contact_merge_suggestions / contact_sessions | 40 / 14 / 0 | CRM spine; dedupe queue; portal OTP sessions | self-FK `merged_into`; contacts cascade | generated `phone_norm`/`email_norm` |
| photo_shares | 7 | adjuster photo links | none (field_project_id soft) | |

**Structural facts:** 75 FK constraints exist, but **every era-1/2/3 core table (`field_projects`, `coordination_jobs`, `crew_members`, `time_entries`, `pending_actions`, `price_list`, `blob_history`, `photo_shares`, `portal_selections`) has zero FKs**; cross-table links are uuids or text inside JSON. Six soft-delete idioms coexist (`deleted bool`, `deleted_at`+`purged_at`, `merged_into`, `revoked_at`, `enabled`, JSON `archived`/`deletedIds`). Four identity idioms (`auth.uid()`, email string, free label like `'qb-time'`, `connected_by` that is uuid in one table and text in two). Job references are `uuid` in some tables and `text` in `email_messages.job_id` and `pending_actions.job_id`. Direction enums disagree (`inbound/outbound` vs `in/out`). JSON keys are camelCase inside snake_case columns.

### 6.2 Enums (live)

`user_role` {admin, tech, viewer, office} · `job_status` 18 values (repo defines 6; `lead, inspection_scheduled, … payment_pending` were added by placeholder migrations) · `loss_type` {water, fire, mold, **freeze**, other} (repo says `smoke`, no `freeze`) · `loss_category` {cat1-3} · `equipment_type` 7 · `photo_category` 6 · `billing_type` {tm, scope}. Only `user_role` is used by the live product; the rest belong to era 0.

### 6.3 RLS policies (live, 100 policies on 48 tables + 20 on storage.objects)

| Class | Tables | Effect |
|---|---|---|
| **Permissive `to authenticated using(true) with check(true)` on ALL** | field_projects (`field_projects_all`; direct write *privileges* revoked by 219, policy left standing), coordination_jobs, crew_members, time_entries, portal_jobs, portal_messages, portal_selections, unified_jobs, phase_instances, capture_events, completeness_state, ai_usage, photo_shares, communications, documents, invoices, tasks, reconstruction_items | any signed-in user (tech, viewer, machine) can read and write everything, including the AI cost ledger and the audit log |
| Permissive partial-true | sms_messages (select/insert/update, no delete by design), email_messages (select/update), contacts (all four, plus column grants and admin-only delete), pending_actions (select + insert-if-pending, no client update) | |
| Read-only true | price_list, qb_time_jobcodes, phase_templates, required_forms, field_requirements, contact_merge_suggestions (update `is_admin()`) | |
| Role-gated via `profiles.role` | field_photos (tech/admin/office/viewer read; tech/admin/office write; admin delete); jobs/rooms/… era-0 via `is_admin()` + `is_assigned_to_job()` | the `user_role` enum is consulted only here and in the RPC guards |
| Deny-all | qb_time_tokens, qbo_tokens, gmail_tokens (`using(false)`) | service role only |
| RLS on, **no policies** | app_settings, blob_history, contact_sessions, field_projects_trash, sync_clients | service role only |
| **Restrictive machine-user fences by email string** | coordination_jobs (5), field_projects (6), crew_members (3), time_entries (3), unified_jobs (3), portal_messages (3), email_messages (1), contacts (2) — 26 policies naming `phone-agent@…` / `office-brief@…` | deny-list by identity: a third machine account gets full `using(true)` rights until someone adds its email |
| Storage | `field-media`: `field_media_rw FOR ALL to authenticated` (any login can delete any of the 1,881 objects); `job-photos` public read; `crew-photos` authenticated insert/update/delete | |

**Advisors (live):** 255 `multiple_permissive_policies` warnings (era-0 tables carry admin + tech policies per op), 36 `auth_rls_initplan` (per-row `auth.*()` re-evaluation, notably the machine-user fences), 24 unindexed FKs, 31 unused indexes, 20 functions with mutable `search_path`, 6 SECURITY DEFINER functions executable by `anon` (incl. `get_portal_data`, `is_admin`, `rls_auto_enable`), 14 by `authenticated` (incl. `push_project`, `contact_merge`, `coordination_job_patch`), 49 tables visible to `anon` through pg_graphql (SELECT grant present; RLS still filters), `pg_net` and `pg_trgm` installed in `public`, leaked-password protection off.

### 6.4 Functions and triggers (live)

43 user functions (plus pg_trgm's). Key ones:

| Function | Kind | Definer | Purpose / caller |
|---|---|---|---|
| `push_project(p_id, p_base_rev, p_data, p_build)` | RPC | yes | the only door into `field_projects`: guard → tombstone sweep → `FOR UPDATE` → insert / wholesale apply / `merge_project_blobs` → rev+1 (`241:193-280`) |
| `merge_project_blobs(a, b)` | pure | no (IMMUTABLE) | **the job merge in plpgsql**: newer-wins top level, deletedIds union (earliest stamp wins, cap 2,000), 12 id-keyed collections union-by-id, rooms/lossTypes union by value, 12 form slots filled-beats-empty then `_mf_form` recursion. Redefined in 217, 241, 243; comment claims byte-parity with `apps/field/js/merge.js` over 2,033 randomized cases |
| `tombstone_project`, `revive_project` | RPC | yes | delete with high-water rev; revive |
| `_sync_guard(p_build)` | helper | yes | role ∈ {tech, admin, office}, `min_field_build` gate (P0002), upsert `sync_clients` |
| `coordination_job_patch(p_id, p_patch)` | RPC | yes | shallow top-level merge, rev+1, admin/office JWT or service role (`246`); caller `apps/admin/js/leads.js:80` |
| `contact_resolve`, `contact_merge`, `contact_canonical`, `contact_mark_review_asked` | RPC | yes | CRM spine |
| `web_session_begin/turn_begin/turn_end/lead_insert/alert_claim` | RPC | yes | web receptionist caps (reserve-before-spend) |
| `portal_access_begin/verify`, `get_portal_data` | RPC | yes | portal OTP; legacy portal read |
| `project_field_photos`, `reconcile_job_photos`, `repair_field_photos`, `restore_photo` | trigger/RPC | yes | photo projection (unread) |
| `capture_blob_history`, `field_projects_trash_capture`, `stamp_updated_by`, `*_touch` | triggers | | audit |
| `is_admin()`, `is_assigned_to_job()`, `handle_new_user()` (new signups default to `tech`), `rls_auto_enable()` | helpers | yes | |

**Triggers on `field_projects` (5):** touch, stamp_updated_by, trash_capture, blob_history_capture (bound to UPDATE and DELETE), project_field_photos (INSERT and UPDATE). An update fires all five plus the `_sync_guard` upsert into `sync_clients`; an insert fires three. `coordination_jobs` carries 4. Era-0 tables carry `touch_updated_at`, `set_job_number`, `set_invoice_number`, `compute_is_dry`.

**(live) `pg_stat_statements`, top by total time:** `INSERT field_projects` 4,254 calls @ 207 ms mean (882 s); `SELECT time_entries` 31,255 calls @ 22 ms (679 s); `net.http_post` 6,473 calls @ 69 ms; `push_project` RPC 2,064 calls @ 190 ms; full `field_projects` blob select 2,361 @ 125 ms; `capture_events` insert 3,511 @ 48 ms; `coordination_jobs` select 24,847 @ 7 ms; `crew_members` select 24,846 @ 1.4 ms. The board's 20-second poll is visible as the ~25 k coordination/crew selects.

### 6.5 pg_cron (9 live jobs)

| Job | Schedule (UTC) | Target | Defined in | Live health (2026-09-06) |
|---|---|---|---|---|
| qb-time-daily-pull | 0 14 * * * | qb-time-proxy `pullAllLinked` | 202 | **dead since 09-04** (refresh token invalid) |
| qb-clockin-sweep | 3-59/15 * * * * | qb-time-proxy `clockinSweep` | 236 | **dead** (23 consecutive 400s in 6 h) |
| morning-brief | 0 15 * * * | roybal-brief | 206 | running |
| weekly-ai-report | 0 17 * * 0 | roybal-brief `weekly` | 211 | running |
| crew-schedule-digest | 0 16 * * 1-5 | roybal-brief `crewDigest` | 244 | running |
| qbo-payment-pull | 30 14 * * * | qbo-proxy `pullPayments` | 207 | healthy (last 09-05 14:30Z) |
| gmail-inbox-pull | */15 * * * * | gmail-proxy `pullInbox` | 209 | **dead since 09-01** (`invalid_grant`) |
| purge-blob-history | 17 9 * * * | SQL | 215 | running |
| repair-field-photos | 37 9 * * * | SQL `repair_field_photos()` | 224 | running |

All seven HTTP jobs carry `x-cron-secret` **and** the publishable key as literal text inside `cron.job.command` (live); migrations 233/236/244 scrape those literals back out of the live `morning-brief` row and `raise exception` on a fresh database. `cron.job_run_details` reports every HTTP job as "succeeded" because `net.http_post` is asynchronous; HTTP failures are visible only in `net._http_response`, which is purged after ~6 hours.

### 6.6 Storage (7 buckets)

| Bucket | Public | Objects (live) | Size | Defined | Used by |
|---|---|---|---|---|---|
| field-media | no | 1,881 | 418 MB | 100 | field app (photos, sketches, signatures, packet HTML), portal gateway. Object key = sha256 of the data-URL, `Content-Type: text/plain`, marker `media:<sha256>:<len>` in the blob (`media.js:35-37`; `supa.js:208-222`) |
| crew-photos | yes | 0 | — | 238 | board headshots |
| job-photos | yes | 9 | 22 MB | **no repo DDL** | era 0 |
| floor-plans | yes (repo says private) | 10 | 9 MB | 002 | era 0 |
| photos, reports, documents | no | 0 | — | 002 / none | era 0 |

Photos are dual-represented: the blob's `photos[]` is authoritative (729 items across live jobs), `field_photos` rows (748) are a trigger-maintained projection nothing reads. Two era-0 public buckets still hold March objects (`job-photos` 9, `floor-plans` 10); `field-media` is the only bucket with live writers.

### 6.7 Edge functions (14 deployed, all ACTIVE)

| Function | LOC | verify_jwt (toml = live) | Trigger | In-code auth | DB client | External | Tests |
|---|---|---|---|---|---|---|---|
| roybal-ai-office | 1,842 + personas 373 | false | field/board/admin browsers | Bearer required; validated by the RLS-gated `capture_events` insert; CORS `*`; `SPEND_CAP_USD` 50/month | anon + caller JWT (raw fetch) | Anthropic, Deepgram STT/TTS | **0** |
| roybal-ai-ingest | 562 | false | field voice | same shape | anon + JWT | Deepgram, Anthropic | 0 |
| roybal-ai-narrative | 139 | false | field | same; `monthSpend` unpaged | anon + JWT | Anthropic | 0 |
| roybal-voice | 218 | false | Twilio | HMAC `X-Twilio-Signature` | none | Twilio, phone agent | 0 |
| roybal-web-agent | 678 + guards 293 + persona 116 | false | www | kill switch, secret, origin allowlist, honeypot, HMAC session, DB-enforced caps | **service role**, RPC-only | Anthropic, notify | 62 pass |
| roybal-lead | 439 | false | www form | origin allowlist, honeypot, racy caps | service role | notify | 0 |
| roybal-brief | 351 + digest 211 + crewdigest 169 + weekly 68 + schedule.js 887 | true | cron ×3 | `x-cron-secret`; signs in as `office-brief@…` | anon + machine JWT | notify | 37 pass |
| roybal-notify | 658 + approve 120 + campaign 42 | false | browsers, 6 functions, phone agent, Twilio `/inbound` | `sendSms` Bearer + RLS; inbound HMAC then service role | raw fetch | Twilio, gmail-proxy | 26 pass |
| roybal-portal | 1,093 + selections 111 + crewtoday 91 | false | portal browser, qb-time-proxy | share token / session; cron secret | **service role**, 38 REST sites | Anthropic, notify, storage | 69 pass |
| qb-time-proxy | 1,289 + phasematch 396 + aiphase 125 | true | browsers, cron ×2 | `requireUser` on 2 actions; cron-or-user on 3; **7 actions ungated** behind the gateway | supabase-js service role | TSheets, Anthropic, portal | 54 pass |
| qbo-proxy | 462 + payments 72 | true | browsers, cron | `pullPayments` cron secret; `invoiceLink` role; `pushInvoice`/`exchangeCode`/`disconnect` ungated | supabase-js service role + one raw PATCH | Intuit OAuth, QBO v3 | 10 pass |
| gmail-proxy | 390 + emailmatch 144 | true | browsers, cron, notify | cron-or-user; approval path re-verifies `pending_actions`; 3 ungated | supabase-js service role | Google OAuth, Gmail | 14 pass |
| magicplan-proxy | 126 | false | **no callers** | **none** | none | Magicplan v2 | 0 |
| magicplan-webhook | 213 | true (a vendor webhook can never pass it) | none | placeholder signature check | supabase-js service role | Magicplan v1 | 0 |

**Model literals (grep):** `claude-sonnet-4-6` (ai-office ×3, ingest ×2, portal ×2, qb-time, phone-agent ×2), `claude-opus-4-8` (narrative ×3, ai-office ×2, ingest, portal, qb-time, phone-agent), `claude-haiku-4-5` (web-agent ×2, ai-office, ingest, portal, qb-time ×2, phone-agent), `claude-sonnet-5`/`claude-opus-5` (web-agent price table only), `nova-3`, `aura-2-thalia-en`. Ten differently named secrets choose the model per lane (`OFFICE_PHOTO_MODEL`, `OFFICE_DOC_MODEL`, `OFFICE_ASSIST_MODEL`, `OFFICE_ASSIST_VOICE_MODEL`, `LLM_MODEL`, `NARRATIVE_MODEL`, `WEB_MODEL`, `PHASE_LLM_MODEL`, `CONCIERGE_MODEL`, `PHONE_MODEL`), each with a hardcoded default. The `LLM_PRICES` table is copied in six files.

**(live) AI spend by lane (998 calls, $51.09):** photoAnalysis $19.12 (Sonnet), phoneCall $10.56, invoiceDraft $5.58 (Opus+Sonnet), fieldAssist $4.22, estimateImport $2.39, contentsVision $2.21, narrative $0.89, rebuildDraft $0.66, adjusterEmail $0.38, qbtime_phase $0.26 (Haiku, 63 calls), webReceptionist $0.05.

### 6.8 Migrations: repo vs live

| Fact | Evidence |
|---|---|
| Repo: 70 files. Live `schema_migrations`: 71 entries. | `ls supabase/migrations`; MCP `list_migrations` |
| Files 005-012 and `20260713231439_price_list_ddl.sql` are one-line placeholders ("already applied on remote"). The live versions 005-012 are named `phase2_enum_values`, `phase2_expansion`, `phase3_reconstruction`, `canvas_floor_plans`, `opening_enhancements`, `floor_plan_manual`, `floor_plans_public_bucket`, `work_authorizations` — their SQL was never committed. | `005_remote_placeholder.sql:1` |
| Repo files 203-246 were applied live under **timestamp** versions (`20260718030545` … `20260901225151`), so the CLI would treat 44 repo files as unapplied. | `list_migrations` |
| Six live entries have no repo file: five `admin_fix_cron_*` (2026-08-12) and `20260814225433 cron_keys_new_format` (the "237" that rotated cron auth headers; the file exists only on the unmerged branch `crm/clockin-crew-line`, commit `9b32807`). Repo numbering skips 236 → 238. | `git branch --contains 9b32807` |
| `105_labor_log_billing_gate.sql` updates tables created by `200` — a numeric replay fails at 105. | `105:10-14`; `200:47,66` |
| 233 / 236 / 244 scrape auth headers from the live `cron.job` row and raise if absent — unreplayable on a fresh DB. | `233:45-51`; `236:38-44`; `244:33-39` |
| 202/206/207/209/211 embed `__CRON_SECRET__` / `__ANON_KEY__` placeholders. | `206:31-38` |
| 43 unique tables created in the repo vs 53 live; ≥8 live tables and 2 buckets have no DDL anywhere. Live enums differ from repo (`freeze` vs `smoke`; 18 vs 6 job statuses). | §6.1-6.2 |
| `merge_project_blobs` is defined in 217, 241, 243; `push_project` in 217, 218, 241; `contact_merge`, `project_field_photos` three times each — the current definition is only knowable by finding the last file. 21 of 70 files define SECURITY DEFINER functions. | grep |
| No CI applies migrations; 22 file headers say "SQL editor", one says MCP `apply_migration`. | headers |

**Replay verdict:** `supabase db reset` fails (105, then 233/236/244) and even if patched would omit ≥8 tables, the live enum values, two buckets and the cron auth. `supabase db push` against production is unsafe (would re-run non-idempotent `create policy` statements in 204/205). **The migration directory is a journal, not a replayable schema; there is no way to stand up a staging database that matches production.**

---

## 7. Environments, configuration, secrets, deployment

**One environment.** One Supabase project. No staging, no preview database, no local stack in use.

| Deployable | Runs on | Deployed by | Config / notes |
|---|---|---|---|
| field `/`, admin `/admin`, board `/board` | GitHub Pages → `app.roybalconstruction.com` | **CI on push to `main`** touching those paths; copies whole directories (incl. 30 test files, READMEs, `serve.mjs`) and force-pushes `gh-pages`; **no test step** | `deploy-field.yml:10-52` |
| portal | Vercel static + `roybal-portal` | Vercel project import (not in repo; memory says project `roybal-restoration-app-web`; untracked `.vercel/project.json` says `roybal-restoration-app`) | `apps/portal/vercel.json`; `README.md:14-18` |
| site | Cloudflare **Pages** `roybal-site-pages` | **manual** `npx wrangler pages deploy … --branch main` from a laptop | `apps/site/CUTOVER.md:5-7`; root `wrangler.jsonc` describes an unused **Workers** project `roybal-site`; `CUTOVER.md:293` still claims every push publishes |
| 14 edge functions | Supabase | manual CLI or MCP; MCP **ignores** `config.toml` verify_jwt pins (this flipped two functions to `true` on 2026-08-13 and killed the quote form) | `supabase/config.toml:1-21` |
| migrations, crons | Postgres | hand-applied | §6.8 |
| phone agent | Fly `roybal-phone` | manual `fly deploy` from repo root | `services/phone-agent/Dockerfile:1-3`; `fly.toml` |
| local dev | ports 4173 / 4180 / 4190 / 4290 / 4330 | `node apps/*/serve.mjs`, `astro dev` | `.cursor/environment.json`; `.claude/launch.json` (board only) |

**Secrets.** 67 distinct `Deno.env.get` names across functions (occurrence counts including test files: `SUPABASE_URL` ×16, `SUPABASE_SERVICE_ROLE_KEY` ×10, `CRON_SECRET` ×9, `SUPABASE_ANON_KEY` ×8, `OWNER_CELL` ×7, `LLM_API_KEY` ×6, `SPEND_CAP_USD` ×5; plus TWILIO_*, QBO_*, QB_TIME_*, GMAIL_*, MAGICPLAN_*, STT_*, TTS_*, SMS_*, WEB_*, PORTAL_*, BRIEF_*). Phone agent reads 8 from Fly. Site needs none (endpoints are committed defaults, `src/data/site.ts:280-283`).

**In git (all public-by-design):** the publishable key (`apps/field/js/config.js:8`, `apps/portal/js/config.js:6`), three OAuth client IDs (`config.js:33,41,50`), the company Twilio number. **Not in git:** JWTs, `sk-` keys, Twilio SIDs, cron secrets. **But (live):** the cron secret and the publishable key sit as literal text inside nine `cron.job.command` strings, readable by anyone with `cron.job` SELECT, and the publishable key alone is accepted by the gateway for the four `verify_jwt=true` proxies (proven by the successful cron calls), which makes the ungated actions behind them (`pushInvoice`, `exchangeCode`, `disconnect`, `getTimesheets`) reachable with the key served on the public site.

---

## 8. Shared code vs copy-paste

| Concern | Copies | Guard |
|---|---|---|
| Scheduling engine `schedule.js` (887 lines) | `apps/board/js/schedule.js` ≡ `supabase/functions/roybal-brief/schedule.js` (md5 identical) + baked into the Fly image by Docker `COPY` + imported by the field app over the served `/board/` path | one byte-equality test (`crewdigest.test.mjs:18-23`), never run in CI; the Docker copy is unguarded |
| Job merge engine | `apps/field/js/merge.js` (JS) ↔ `merge_project_blobs` (plpgsql, defined in 217, 241, 243; only 243's body is live) | parity was proven once out of band (a 2,033-case randomized run recorded in the `243:30-36` comment; the harness itself is not in the repo) and is enforced by no test; the 12-key collection list must be edited in `merge.js:32-36` and in a new migration each time |
| `personas.ts` (one-brain registry) | imported by ai-office, brief; Docker-copied into the phone agent; the web agent deliberately keeps its own `persona.ts` with a verbatim `createLead` schema | `persona.test.mjs` drift guard |
| `zip.js` | field ↔ portal, "VERBATIM COPY" (9 comment-line diff) | none |
| `assistctx.js` | admin (309 lines) vs board (117) — same provider seam, fully diverged bodies | — |
| `serve.mjs` | ×4; admin↔board differ by 25 lines | — |
| `config.js` | field ↔ portal (same URL + key literal); board/admin import field's | — |
| CSS tokens | field `app.css` 31 vars (canonical for admin/board), portal `portal.css` hand-copies 13 of them with identical values (only `#fff` vs `#ffffff` and whitespace differ), site `brand.css` 30 own; **two navies in production**: `#16395a` (field/board/admin/portal) vs `#0f1b2d` (site, design-system, `print.css` ×14 hardcoded); `board.css:5` claims the wrong one | — |
| Brand emblem / icons | `emblem-mark.svg` ×4, icon PNGs ×2-3 | — |
| CORS block | 11 of 14 functions; 9 use `*`, 2 allowlists | — |
| `json()` helper, response envelope | ≥5 private definitions; two envelope shapes (`{ok,data}` vs flattened) | — |
| `x-cron-secret` check | 8 hand-written copies (qb-time ×3, gmail ×2, qbo, brief, portal); qb-time also accepts it in the body | — |
| LLM price table | 6 files: `LLM_PRICES` in ai-office, ingest, portal, qb-time-proxy and `services/phone-agent/config.mjs`, plus `PRICES` in `roybal-web-agent/guards.ts` (which names models the others do not) | — |
| `monthSpend()` / `db()` / `insertRow()` | ai-office, ingest, narrative (narrative's copy lacks paging), portal, qb-time, phone-agent `supa.mjs` | — |
| Quiet hours 7-20 AK | notify, qb-time, voice (env-driven, two different `Intl` options), **hard-coded** in `apps/admin/js/campaigns.js:39`, prose in personas | — |
| Pipeline stages | `board.js:22-29`, `actions.js:35`, `boardpush.js:329`, `app.js:362-370`, `personas.ts:258`, brief `digest.ts:176`, portal `crewtoday.mjs:45` | comments say "keep in sync" |
| Board vocabularies (types, materials, channels, lead-log kinds) | `board.js:22-77` mirrored in `actions.js` and `admin/js/leads.js`; phone agent writes `type:"mitigation"` which is not in the list | — |
| Rev-guard write | 5 implementations (§5) | — |
| Financial totals ladder / O&P rule / line subtotal | `forms.js`, `fincalc.js`, `formkit.js`, brief `digest.ts` (3 copies each) | `fincalc.test.mjs` tests one copy |
| 7-day equipment flag | `forms.js:634`, `forms.js:695`, `dryingwatch.js:71-75` | — |
| Completeness rules | `completeness.js` (29 rules) vs SQL seed in 200/105 (28 rows, diverged) | — |
| Settings-row uuid `00000000-…-01` | hard-coded in 7 files | — |
| Model-routing knobs | 10 env names, 7 files | — |

**Single-source (good):** dry standards and GPP formula live only in `apps/field/js/core.js:705-734`; crew names are not hard-coded outside test fixtures.

---

## 9. Generated artifacts and types

**None.** No `supabase gen types`, no generated client, no schema file, no OpenAPI. The four client apps have 0 `@ts-check` directives and 0 JSDoc type tags across 69 files. The 26 Deno `.ts` files are executed with types stripped and never checked. Tool contracts for the AI assistant are prose `desc` strings (`personas.ts:246-362`) except the 6 read tools and 5 phone tools, which are real JSON-schema `input_schema` objects (`personas.ts:78-146,166-221`). The domain "schema" is the union of what `model.js` factories produce, what `merge.js`/`merge_project_blobs` know how to merge, and 80 observed top-level keys in live blobs (Appendix A), of which 13 are written by code paths outside the factory.

---

## 10. Dead, orphaned, and drifting

**TODO / FIXME / HACK / XXX comments: 0** (grep across apps, services, supabase). Intent lives in file-header comment blocks (100 % of non-test source files have one) and in `docs/`.

| Item | Evidence |
|---|---|
| Era-0 schema: ~20 unused tables (of the 22 era-0 tables, `profiles` is live and `qb_time_*` were re-created in era 1), 6 enums, 5 buckets, `is_assigned_to_job`, `generate_job_number`, `set_invoice_number`, `compute_is_dry` | §6.1 |
| `magicplan-proxy` (deployed, unauthenticated, no callers) and `magicplan-webhook` (deployed, unreachable, placeholder signature) + `MAGICPLAN_*` secrets | `magicplan-proxy/index.ts:46-126`; `magicplan-webhook/index.ts:208-213` |
| Era-3 completeness tables (`phase_templates`, `required_forms`, `field_requirements`, `phase_instances`, `completeness_state`) — seeded, zero app references | grep |
| `field_photos` projection (748 rows, 5 triggers, nightly repair) — zero readers | grep; `docs/Sync_Rearchitecture_Plan.md:310-315` |
| `apps/field/js/pricing.js` (header says DEPRECATED, no importer, still precached) | `sw.js:19` |
| Legacy direct-write path `upsertRows/guardedUpsertRow/reviveRow` behind `SYNC_VIA_RPC` (grant revoked by 219) | `supa.js:133-194` |
| `chatText()` in ai-office (dead helper); `crewHours`, three unused imports, no-op `renderBoardSilently` in board; unused `Store` import in `contacts.js`; legacy chip names `moveJob`/`logHours` | readers |
| `tsconfig.base.json`, `deno.lock`, root `typescript`, `.site-archive` (tracked), `docs/prototypes/material-selector.html`, stale lock entries for deleted apps | §1.2 |
| `assets/emblem-mark.png`, `assets/logo-orange.svg` (0 references); 93 of 140 site images (5.3 MB) referenced nowhere | grep |
| Three test files on disk but not wired (`test/dryingcalc.test.mjs`, `test/sms.test.mjs`, `js/calibration.test.mjs`); phone-agent tests outside root `npm test` | `apps/field/package.json:10` |
| `.claude/worktrees/` — two detached worktrees (51 MB) on unmerged branches; 34 merged local branches not pruned; 13 unmerged | `git worktree list` |
| `deploy-field.yml:13` triggers on the deleted branch | |
| Docs drift (§12) | |

---

## 11. Live health snapshot (2026-09-06 ~04:00 UTC)

Read from the production project; none of these are visible in any app UI.

| Signal | State |
|---|---|
| `npm test` on `main` | **red** — `BUILD v165` vs SW cache `v166` fails `build.test.mjs` (second link in an `&&` chain), so 26 field files + board + function tests are skipped; the drift shipped in PR #181 (2026-09-04) and deployed anyway |
| Gmail lane | **dead since 2026-09-01 04:15Z** — every 15-minute pull returns 500 `invalid_grant`; last email pulled 09-01; admin "Gmail" card shows connected |
| QB Time lane | **dead since ~2026-09-04 19:38Z** — clock-in sweep 400 `refresh_token is invalid` every 15 min; daily pull produced nothing 09-05; no alert to anyone |
| pg_cron | reports 288 + 288 "succeeded" runs for the two dead jobs (async `net.http_post`) |
| QBO lane | healthy (token refreshed 09-05 14:30Z) |
| SMS delivery | 174 of 175 outbound rows frozen at `queued`; no Twilio status-callback route exists (`config.toml:54` claims one) |
| Approve-by-text proposals | **blocked since 2026-07-26**: 3 `boardEdit` rows `pending` past expiry; qb-time-proxy counts them against `MAX_LIVE_PROPOSALS=3` and never proposes again |
| Build gate | `app_settings.min_field_build = 0` → unarmed; `sync_clients` shows devices at v165 ×4, v155, v153 (six rows) |
| `unified_jobs.status` | all 33 rows `new` — the spine's lifecycle is never advanced |
| Portal accounts / concierge | `contact_sessions` 0 rows ever; concierge used once (07-13) |
| `magicplan-proxy` | reachable by anyone, no auth, writes to the vendor account with the company key |
| Observability | no error reporting, no alerts; 0 `console.*` in the four core AI functions and in board/admin/portal JS; field has 1; 26 empty `catch` blocks in `apps/field/js` (39 counting `.catch(() => {})` swallowers; 31 empty blocks across field, admin and board); Supabase log window ~24 h; the only durable traces are `capture_events`, `ai_usage`, `sms_messages`, `blob_history` |

---

## 12. Docs vs code (drift table)

| Doc | Says | Code |
|---|---|---|
| `apps/field/README.md:7-8`, `apps/field/package.json:5` | "No login. No accounts. No backend." | password sign-in (`supa.js:34`), Supabase sync (`config.js:7`) |
| `apps/field/README.md:15`, `forms.js:2` | 7 packet forms | 22 renderers, 29 `FORMS` entries (`model.js:31-98`) |
| `README.md:84` | 25 test files | 28 wired, 31 on disk (`test/dryingcalc.test.mjs`, `test/sms.test.mjs`, `js/calibration.test.mjs` unwired) |
| `README.md:44`, `board.css:5` | design-system is the brand source; `--navy #0f1b2d` | nothing imports it; field navy is `#16395a` |
| `docs/AI_Assistant_Roadmap.md:32` | only Phase 0 shipped | SMS lane, receptionist, phone agent exist |
| `docs/Material_Selection_Design.md:3` | "nothing built yet" | `roybal-portal/selections.ts`, `selections.test.mjs` |
| `docs/QB_Time_Phase_Matching_Plan.md:5` | "BUILT (not yet deployed)" | deployed; 63 ledger rows, 307 phased entries |
| `docs/QB_Time_Daily_Log_Plan.md:61,87` | a `qb-time-daily` function | never existed; lives in `qb-time-proxy` |
| `docs/Customer_Portal_Roadmap.md:57-58` | Phase B = Supabase Auth | superseded by `contact_sessions` (232) per `CRM_Design.md:311` |
| `docs/Claude_Code_Handoff_Phase1.md:5` | read `docs/Roybal_AI_Backbone_Architecture_and_Phase1.md` first | file does not exist |
| `apps/site/src/data/site.ts:91-98` | port the owner's cell into Twilio | reversed the same day in `CUTOVER.md:122-130`; comment survived a later edit |
| `apps/site/CUTOVER.md:5-7` vs `:293` | no Git CI / every push publishes | contradicts itself |
| `wrangler.jsonc` | Cloudflare Workers project `roybal-site` | live site is Pages `roybal-site-pages` |
| `supabase/config.toml:54` | notify receives Twilio status callbacks | no handler |
| `roybal-portal/index.ts:5-7` | short-lived signed URLs | inlines base64 media |
| `apps/board/js/data.js:11` | "last-edit-wins on the server" | rev guard at `data.js:95-132` |
| `210_pending_actions.sql:17-18` | "the admin shows the queue" | no admin code references `pending_actions` |
| `103_qb_time_field.sql:9-11` | `jobs` "does NOT exist on this line" | it exists (2 rows) |
| `apps/field/README.md:212-213`, `roybal-ai-ingest/README.md:36` | Haiku/Sonnet defaults | Sonnet/Opus in code |
| No `CLAUDE.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md` at root | — | conventions travel in file headers and in a memory file outside the repo |

---

## 13. Gaps and what was not verified

- **No browser run.** Service-worker behaviour, print output, pagination, and the admin sync-repaint behaviour are reasoned from code, not observed. No PDF fixtures exist to compare against.
- **Deploy state outside the repo.** Which Vercel project serves the portal and which Cloudflare project serves the site could not be confirmed from the tree (two candidates each). Fly secrets, the deployed phone-agent image, the Twilio console configuration (inbound URL, status callbacks), and function secrets (`OFFICE_*_MODEL`, `SPEND_CAP_USD`, `MAGICPLAN_*`, `ALERT_CELLS`) are not readable from here; effective model per lane is inferred from code defaults.
- **Live function bodies vs repo.** `merge_project_blobs`, `push_project`, `coordination_job_patch` and `_sync_guard` were read live and match the last repo definition; the other redefined functions were not diffed live.
- **Log retention.** Supabase logs cover ~24 h and `net._http_response` ~6 h, so first-failure timestamps for the dead lanes are inferred from token expiry and last-write times.
- **Parity claims.** JS↔SQL merge parity (2,033 randomized cases) is asserted by comments and a test not run here; the `time_entries` truncation in `hoursLookup` (limit 1000 vs 1,193 rows) is inferred from code.
- **Deno type-correctness** of the 28 edge-function files was not assessed (no `deno check` run).
- **Placeholder migrations.** The SQL for live versions 005-012 was never committed, so the origin of the extra tables, enum values and public buckets is unknown.
- **Unmerged worktrees.** Whether the two `.claude/worktrees` branches hold wanted work was not evaluated.

---

## Appendix A — `field_projects.data` top-level keys (live, 15 non-deleted jobs)

Present in all 15: `id rev address adjuster boxes carrier certDrying changeOrders claimNo constructionLogs contents createdAt customer dateOfLoss dryingLogs dryingSystem email lossCause moistureMaps phone photos rooms updatedAt waterCategory waterClass workAuth workOrderNo`. In 14: `invoices laborLog`. 13: `narrative narrativeDate portalShare`. 11: `photoSize reconEstimates`. 9: `archivedAt`. 8 (construction jobs): `certCompletion constructionType contractAmount drawSchedule inspections jobType lender linkedRestorationId permitNumbers preConChecklist progressNarrative progressNarrativeDate punchList qbJobcodeId qbJobcodeName scopeOfWork selections startDate subSchedule targetCompletion`. 7: `floorPlan`. 5: `photoSort supportDocs`. 4: `deletedIds receipts`. 3: `linkedConstructionId smsLog`. 2: `contentsPhotoSize createdBy fireDamage lossTypes narrativeOverride packetExclude photoShares smokeType`. 1: `boardPlan envelopeBreached mitigationRef moldCondition moldExtent rebuildDraft rebuildQA stormCause timelineQA`.

Collection sizes across live jobs: photos 729 · contents 180 · moistureMaps 14 · constructionLogs 10 · invoices 9 · rooms 9 · dryingLogs 7 · reconEstimates 4 · changeOrders 2 · receipts 0.

Representative element shapes (live):
- `moistureMaps[]`: `{id, label, material, dryGoal:"≤ 19%", meter, page, pageOf, sketch:"media:<sha>:<len>", strokes:"media:…", locCount:52, photos[], readings:[{date, notes, values:["33.7","20",…]}]}` — **readings are positional string arrays; the location↔marker mapping exists only as pixels in the strokes image; material and goal are per map, not per location.**
- `dryingLogs[]`: `{id, dryGoal:"19%", calcLF, readings:[{date, time, tech, outT/outRH/outGPP, refT/refRH/refGPP, affT/affRH/affGPP, gd, dehu:"2", am:"20", scrub:"1", notes}]}` — **equipment is a per-day count of units, not a placement/removal log with asset identity** (the `equipment[]` table on the same form holds free-text type + placed/removed datetimes when filled).
- `invoices[]`: `{id, by:"<email>", items:[{qty, desc, room, unit, price}], …}` — **no line code, no justification field**; AI `basis` is rendered then discarded.
- `changeOrders[]`: `{id, coNo:"", coDate, reasons:{"4":true}, description:<free text>, items:[…], sigOwner, sigAdjuster, sigContractor, …}`.
- `photos[]`: `{id, ts, src:"media:…", cloud:<sha>, room:"", stage:"before", caption, ai:{caption, damage[], safety[], materials[], equipment[], confidence}}` — room is a free-text string, often empty. The AI tags are consumed only inside a client-built digest (`officeai.js:159-179` feeds damage/workDone/materials into the invoice-draft facts; `equipment` is consumed by nothing) and are never persisted as billing provenance.
- `constructionLogs[]`: `{id, by, date, rows[], notes, issues, materials, photos[], signature:"data:image/png;base64,…"}` — signatures under 60,000 chars stay inline in the blob.
- `portalShare`: `{id, status:"final", enabled, shareToken, publishedAt, sharedDocIds[], sharedPhotoIds[], notifyOnStatus, lastNotifiedStatus}`.

## Appendix B — `coordination_jobs.data` keys (live, 80 rows + settings row)

All 80: `id title customer address phone type stage priority crewIds materials notes createdAt updatedAt`. 78: `pinnedStart scheduleMode`. 77: `deps subtasks`. 73: `rev`. 68: `estimatedHours startDate targetDate`. 65: `notBefore notBeforeLabel`. 64: `durationDays fieldJobId`. 58: `billedToDate contractValue`. 45: `isMilestone`. 35: `claimNo`. 32: `channel`. 25: `qbJobcodeId qbJobcodeName`. 24: `nextAction nextActionAt`. 23: `estValue`. 22: `contactId`. 11: `archived`. 10: `archivedAt email firstTouchAt source webLead`. 8: `aiBooked dayCrew ipHash leadLog subnetHash`. 4: `lostReason outcome outcomeAt`. 1: `crewSpans message`. Settings row: `{archived:true, holidays:[], workDays:[1..5], hoursPerDay:8}`.

`subtasks[]` (phases): `{id, name, crewIds[], lagDays, durationDays, estimatedHours, done?, completedOn?}`; `deps[]`: `{predId, type:"FS", lagDays}`; `dayCrew`: `{"<iso-date>":{add[],remove[]}}`.

## Appendix C — `time_entries.data` and `crew_members.data` keys (live)

`time_entries` (1,193): all rows `id date hours jobId note enteredBy createdAt updatedAt`; 1,120 from QB Time add `qbTimesheetId qbJobcodeId qbUserId jobcodeName employee task service start finish source fieldProjectId`; 572 carry `phaseMatch {by:"ai"|"manual"|…, score}`; 307 `phaseId`; 73 `crewId`. Sample: `{"date":"2026-09-03","hours":1.03,"jobId":"9be3…","service":"Restoration Services:Restoration — Moisture Monitoring & Documentation","source":"qbtime","enteredBy":"quickbooks-time","phaseMatch":{"by":"ai","score":0}}`.

`crew_members` (11): all `id name role active color phone createdAt updatedAt`; 8 `qbUserId qbUserName hourlyRate`; 7 `email`; 5 `outDays`; 2 `digestOptOut`; 1 `bioPublic bioYears bioCerts bioBlurb`. No skills, certifications (beyond one free-text bio string), teams, leads, or per-person capacity.
