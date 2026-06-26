# Phase 1 Handoff Outline — for Claude Code

**Project:** Roybal Restoration AI Field Data Backbone
**Scope of this handoff:** Phase 1 — voice capture + completeness validation, built on the additive backbone.
**Read first:** `docs/Roybal_AI_Backbone_Architecture_and_Phase1.md` (the "why") and `docs/Phase1_Voice_Capture_Build_Plan.md` (the "how"). This file is the skeleton/checklist that ties them to real files.

---

## 1. Goal (one paragraph)
Add an AI "backbone" to the existing field app **without rewriting anything**. A tech taps 🎙️, speaks their log, and the app turns it into tap-to-confirm fields, then checks the job against the IICRC required-form matrix and flags what's still missing **before they leave site**. All inputs flow through one pipeline (ingest → normalize → extract → validate → store → distribute) so every later feature plugs into the same layer.

## 2. Architecture in one screen
- **Two front-ends, one database.** `apps/field` (phone, offline-first, vanilla JS) + `apps/board` (office desktop). Same Supabase project, same shared login/origin. **Do not merge the UIs.**
- **Additive only.** New tables + new modules layered on top. Never migrate or break `field_projects`, `coordination_jobs`, or `jobs`.
- **Stack:** vanilla ES modules, **no build step**, no framework. Supabase (Postgres + Auth + Storage + Edge Functions). Match existing style in `apps/field/js/core.js`.

## 3. Status legend
✅ done in this engagement · 🔜 next · ⬜ later

---

## 4. Repo map (what exists — real paths/symbols)
| Path | What it is |
|---|---|
| `apps/field/js/model.js` | Field project data shape — `newProject()`, `FORMS`, form factories. **Source of truth for field names.** |
| `apps/field/js/app.js` | App shell + hash router. `route()` (~L52), **`projectHome(project)` (~L219)** = job home screen. |
| `apps/field/js/forms.js` | Exported form renderers: `moistureMap`, `dryingLog`, `workAuth`, `constructionLog`, `certDrying`, `photosForm`, … `sectionTitle()` helper anchors layout. |
| `apps/field/js/core.js` | `h()` hyperscript, `Store` (IndexedDB), `uid`, date/money helpers. Persist a job with **`Store.put(project)`**. |
| `apps/field/js/supa.js` | Minimal Supabase REST/auth client (`rest()`, `isSignedIn`, `currentEmail`). |
| `apps/field/js/sync.js` | Offline write queue + push of `field_projects`. |
| `supabase/functions/*` | Existing Edge Functions (`magicplan-proxy`, `qb-time-proxy`) — copy this pattern for the AI function. |

## 5. Already built (✅ — verify, don't redo)
- ✅ `supabase/migrations/200_ai_backbone.sql` — 7 backbone tables + **seeded water-mit required matrix**. Additive, parses clean. **Action: run it in Supabase, confirm seed with the verify queries at the file's end.**
- ✅ `apps/field/js/completeness.js` — pure engine. `evaluateProject(project, conditionOverride?)` → `{ requiredCount, presentCount, hardGaps[], softGaps[], isBillable, conditions }`; plus `summaryLine(result)` and `REQUIREMENTS[]`.
- ✅ `apps/field/test/completeness.test.mjs` — 14 passing checks. Wired into `npm run field:test`.

---

## 6. Build backlog (🔜 / ⬜ — for Claude Code)

### 🔜 Step A — "What's missing" panel (read-only, no AI, no cost)
- **Touch:** `apps/field/js/app.js` → `projectHome(project)` (~L219).
- **Do:** `import { evaluateProject, summaryLine } from "./completeness.js"`; render a status line + grouped hard/soft gap list using `h()`. Re-render on `Store.put`.
- **Accept:** open a job → panel shows correct gaps; fill a missing field → gap clears on save. No network calls.

### ⬜ Step B — Job spine / crosswalk
- **Touch:** new `apps/field/js/spine.js` (+ `supa.js`).
- **Do:** on job open, upsert a `unified_jobs` row; set `field_project_id`; match `coordination_jobs` by `claim_number` to set `coordination_job_id`. Store `captured_by` source (see Step E).
- **Accept:** one `unified_jobs` row per field job; crosswalk IDs populated when a Board match exists.

### ⬜ Step C — Edge Function `roybal-ai-ingest` (online-only; AI keys live here)
- **Touch:** `supabase/functions/roybal-ai-ingest/index.ts` (Deno; mirror `magicplan-proxy`).
- **Contract:**
  - `POST` body: `{ unified_job_id, form_key, audio (base64|storage ref), water_category, captured_by }`
  - Pipeline: write `capture_events` (`status='pending'`) → STT → save `transcript` → LLM extract to the form's JSON schema → save `result`, `status='extracted'` → return `{ capture_event_id, candidates, transcript }`.
  - **Secrets** (Supabase): `STT_API_KEY`, `LLM_API_KEY`. **Never** in client.
  - **Spend cap:** monthly $ counter; past cap → return `{ capped:true }`, app falls back to manual entry.
- **Accept:** post a sample audio/transcript → get structured candidates; cap blocks at limit.

### ⬜ Step D — 🎙️ Transcribe button on 4 forms
- **Touch:** `apps/field/js/forms.js` renderers: `moistureMap`, `dryingLog`, `photosForm`, `constructionLog`. Add a shared widget in `formkit.js`.
- **Do:** record audio → call Step C → render **tap-to-confirm chips** (amber if low confidence) → on confirm write into the project object → `Store.put(project)`. Queue offline; process on reconnect.
- **Accept:** speak a drying log → chips appear → confirm → values land in the form and persist.

### ⬜ Step E — Tech identity (`captured_by`)
- **Touch:** `apps/field` (one-time picker; device-stored, e.g. `localStorage`), optionally seeded from Board `crew_members`.
- **Accept:** every `capture_events` row carries the tech.

### ⬜ Step F — Live missing-field prompt
- **Touch:** wherever Step D confirms.
- **Do:** after write, run `evaluateProject`; if `hardGaps`, show "before you leave" prompt listing them.
- **Accept:** confirming a partial log triggers the prompt with the right gaps.

### ⬜ Step G — Distribute to Board
- **Touch:** `apps/board/js/board.js`.
- **Do:** show a completeness badge / `is_billable` on the linked phase via the spine.
- **Accept:** Board phase reflects field completeness.

---

## 7. Key contracts (interfaces to keep stable)
**Completeness (built):**
```
evaluateProject(project, conditionOverride?) ->
  { requiredCount, presentCount, hardGaps:[{id,form,formLabel,label}], softGaps:[…], isBillable, conditions:{cat3,contents,cleaning} }
```
**Extraction schema (per form) — example, Drying Log:**
```json
{ "form_key":"dryingLogs",
  "psychrometric":[{"location":"affected","temp":72,"rh":55,"confidence":0.93}],
  "equipment":[{"type":"air_mover","count":2,"location":"living room","confidence":0.95}],
  "unmapped":["…"] }
```
Field names must match `model.js` (e.g. `affT/affRH/outT/outRH/gd`, equipment `type/location/placed/removed`, photo `stage/caption/room`).

**`capture_events` row:** `{ unified_job_id, phase_instance_id?, source_type:'voice', form_key, raw_payload, transcript, result, captured_by, status }`.

## 8. Guardrails for Claude Code
1. **Additive only** — no edits to `field_projects` / `coordination_jobs` / `jobs` schemas; new tables already in `200_…sql`.
2. **No build step, vanilla ES modules** — match `core.js`. No new frameworks/bundlers.
3. **Offline-first stays true** — manual entry must work with no signal; voice is an online-only enhancement that queues.
4. **No secrets in the client** — STT/LLM keys only in the Edge Function (Supabase secrets).
5. **Keep the field app simple** — it's for a tech on a phone; don't add office/scheduling complexity here.
6. **Tests** — extend `npm run field:test`; keep the completeness suite green.

## 9. Decisions locked / open inputs
**Locked:** Option B (additive) · voice online-only · capture the tech · premium-accuracy AI + monthly cap · Transcribe on Moisture Map, Drying Log, Photos, Daily Construction Log.
**Open (needed before Step C/D):** (a) red-line hard-vs-soft gates in `200_…sql`; (b) AI provider + keys (default: Deepgram STT + a strong LLM); (c) spend-cap number (default $50/mo); (d) tech roster for the picker.

---
*Roybal Construction, LLC · Roybal Restoration · North Pole, AK · IICRC WRT Certified*
