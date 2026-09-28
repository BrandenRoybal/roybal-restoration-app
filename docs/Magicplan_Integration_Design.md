# Magicplan Integration — the scan lands on the bid file by itself

**Status:** approved 2026-09-25 — every §6 question is ruled (Q1/Q2/Q5 by the owner on 2026-09-24, Q3/Q4 and the build order on 2026-09-25 taking the recommendations); nothing built. Build brief for Claude Code: `docs/Claude_Code_Prompt_Magicplan.md`.
**Date:** 2026-09-24
**Companion to:** `docs/Lead_Bid_Workflow_Design.md` (the bid file, the Bid card, the Site Visit packet). This doc is the Magicplan half: the app creates the Magicplan project before the visit, and after the scan the report, the photos and the measured quantities land on the bid file without a single upload.
**Supersedes:** the era-0 `magicplan-proxy` / `magicplan-webhook` (deleted in E0, F-049). Those were written against guessed endpoints ("response can vary — handle several known shapes"), ran unauthenticated with the company key behind them, and wrote era-0 tables no app reads. Nothing here reuses a line of them.

*Today the Magicplan report is a PDF you export on the phone, AirDrop to the Mac, and drag into the Site Visit panel — and the estimator then reads dimensions off a picture of a plan. Magicplan already knows every room's floor area, perimeter, wall surface and ceiling height to the inch. This is the plan for asking it.*

---

## 1. What the API actually offers (verified 2026-09-24 against the live OpenAPI 3.1.1 document, API v1.2)

Base URL `https://cloud.magicplan.app/api/v2`. Two headers on every call: `key: <API Key>` and `customer: <Customer ID>`, generated at `cloud.magicplan.app/integrations` (rotatable). Rate limit 500 requests / 5 min (2,000 on high-throughput endpoints), `429` past it. API access is included on every current Magicplan plan ("API access for custom integrations", pricing page) — no tier gate, but plans are metered by **new projects per month**, which matters in §6.

| Capability | Endpoint | What comes back | Why we care |
|---|---|---|---|
| Create the project before the visit | `POST /projects` | project `id`, `plan_id`; body takes `name`, `external_reference_id` (**our** field project id), `email` (the workspace user it lands on), `address {street, city, postal_code, country}`, optional `team_id`, `custom_forms[]`, `custom_fields[]` | The project is already on Branden's phone with the customer's name and address when he pulls up. Zero typing on site. |
| Find ours later | `GET /projects?name=` · `GET /projects/{id}` | `external_reference_id`, `plan_id`, `user_modified`, `archived_at`, `cloud_url` | Match a scan to a bid file by our own id; detect "scan updated since last sync". |
| The report and drawings | `GET /plans/{id}/files?format[]=pdf&include_photos=true` | `files[] {name, folder ("Report PDF"), url, file_type, size, last_modified}` | The Report PDF the Site Visit panel wants, fetched by URL server-side. Formats: pdf, jpg, png, svg, dxf, usdz, xls, csv, ifc, fml, xml, mp. |
| The photos, room-tagged | same call, `include_photos=true` | `photos[] {name: "1st Floor - Living Room - <object> - 2.jpg", symbol_instance_id, folder: "Captured photos", url}` | Every photo pinned in the scan, **with its floor and room in the name**. Becomes a captioned packet photo (`room` set) — the thing he pins them for. |
| Measured quantities | `GET /plans/statistics/{id}` | `units` (metric/imperial) + per **floor** and per **room**: `area`, `area_without_walls`, `perimeter`, `ground_perimeter`, `height`, `volume`, `walls_surface`, `walls_surface_without_openings`, `doors_surface`, `windows_surface`, `door_count`, `window_count`, `dimensions` (formatted), `wall_items[] {name, width, height, distance_to_floor}`, `furnitures[]` | Floor SF, ceiling SF, wall SF net of openings, baseboard LF, room volume for dehu sizing — **measured, not read off a PDF**. |
| Plan geometry + room SVGs | `GET /projects/{id}/plan` | `floors[] {name, image (SVG url), rooms[] {name, formatted_dimensions, statistics, walls[], objects[], image (room SVG)}}` | A clean floor SVG for the Moisture Map base and Scope of Work reference plan; per-room SVGs for room pages. |
| Generate exports server-side | `POST /plans/{id}/custom-export` | `ProjectFile[] {filename, filetype, file.url, file.hash, generated_by: ExportConfig.Report / Sketch / Statistics / XactimateEsx / …}` | Pull the Report PDF (and, on a claim, the **ESX** sketch for the adjuster) without anyone tapping Export in the app. |
| Per-room forms | `GET /forms` · `POST /forms` · `GET /plans/forms/{id}` | form definitions; per-symbol `FormData {symbol_type: plan/floor/room/…, forms[]}` | A "Roybal site walk" form on each room — damage observed, materials, notes — typed in Magicplan during the walk, read back as scope. (Phase M4.) |
| Push-on-export | `PUT /workspace {webhook_url, authorize_url, listing_url, logo, notify_user}` | Magicplan calls `authorize_url` (GET, expects XML `<status>0</status>`) then `webhook_url` (POST, **form-encoded**: `key, email, title, planid, project_id, pdf, jpg0…, dxf0…, png0…, svg0…, xml, …`) when a user presses the custom export button. **No retry, no signature** — "an error message will be displayed to the user in the app." | The doorbell. A branded "Send to Roybal" button in the app. |
| Project files (uploads) | `POST /projects/{id}/files/temporary-presigned-url` → `POST /projects/{id}/files` | pre-signed upload | Not needed for bids; noted for a later "push the estimate PDF back to the Magicplan project" nicety. |

**Not offered:** a real webhook secret or retry; the walk recording (that stays phone → packet); Magicplan's own estimate line items (`GET /projects/{id}/estimates` is metadata only — and we have a better estimator).

## 2. Locked decisions (proposed)

1. **Magicplan is a capture device, not a system of record.** Everything it returns is copied into our storage and our blob at sync time; nothing in the app ever links to a Magicplan URL at read time. The bid file stays complete offline and stays complete if the Magicplan subscription lapses.
2. **The company key never reaches a browser.** All API calls run in one office-gated edge function (`magicplan-proxy`, `verify_jwt=true`, `OFFICE_ROLES` gate like `gmail-proxy/index.ts:131`), secrets `MAGICPLAN_API_KEY` / `MAGICPLAN_CUSTOMER_ID` / `MAGICPLAN_EXPORT_KEY`. The old proxy's `verify_jwt=false` + no auth check is the failure this doc exists not to repeat.
3. **The webhook is a doorbell, never a source.** `magicplan-webhook` (trust level C: `verify_jwt=false`, self-protecting) checks the form-encoded `key` against `MAGICPLAN_EXPORT_KEY`, rate-limits by IP, and then **ignores every URL in the payload**: it enqueues a sync that fetches the project and files from the API with our own credentials. A forged webhook can at worst trigger a re-sync of a project we already own.
4. **The field app owns the blob** (CRM decision 2, 03 §6). The server writes files to `field-media/sitevisit/<job>/` and one `magicplan_exports` row; the **owner's field app** merges them into `project.siteVisit` on next open (or on tap) through its own `Store.put` + sync. No server-side `field_projects` write, no second write door.
5. **One Magicplan project per bid file**, created at site-visit scheduling (or Start bid) with `external_reference_id = <field project id>`. The link is stored both ways: `project.siteVisit.magicplan.projectId` on ours, `external_reference_id` on theirs. Matching by name/address is a fallback for scans that started in the app by hand, never the primary key.
6. **Quantities are offered, never applied silently.** Statistics land as a proposal in the Floor Plan dimensions table and the estimate prompt — the same amber-chip discipline as every AI draft. Units are converted to feet at import; the source and scan date print in the estimate's Pricing Basis ("Quantities from Magicplan LiDAR scan, 2026-09-26").
7. **Additive.** One new table, two edge functions, a few blob fields. Deleting all of it restores today.

## 3. The flow, on top of the bid workflow

| # | Step | Where | Magicplan call | Writes |
|---|---|---|---|---|
| 1 | Site visit scheduled / Start bid (bid doc §3 steps 3–4b) | admin / board / field | — | bid file `bj-<tileId>` exists |
| 2 | **NEW — project created in Magicplan.** Fires when the bid file is created **and** the visit is scheduled (both true), from the owner's app or the office, via `magicplan-proxy createProject`. Name `"<Customer> — <address>"`, address split from the tile, `email` = the visiting user's Magicplan login (`siteVisit.by`, default owner). | proxy | `POST /projects` | `siteVisit.magicplan = {projectId, planId, createdAt, by}`; Bid card line "📐 Magicplan project ready" |
| 3 | The walk: scan, pin photos per room, (optionally) fill the room form. Tap the **Roybal** export button when done. | Magicplan app | — | — |
| 4 | **NEW — doorbell.** Magicplan GETs `authorize_url` (we answer `<status>0</status>` if `project_id` resolves to a live bid file or the `listing` id is one of ours), then POSTs `webhook_url`. We validate `key`, insert a `jobs_queue` row `magicplan.sync {projectId, planId}` (P1's queue, `0004_backbone_contract_tables.sql:649`), answer `<status>0</status>`. | `magicplan-webhook` | — | `jobs_queue` row; `events` row `magicplan.export_received` |
| 5 | **NEW — sync.** The worker (or, until the P1 worker runs, the proxy's `sync` action called by the field app's "⟳ Pull from Magicplan" button): `GET /projects/{id}` → confirm `external_reference_id`; `GET /plans/{planId}/files?include_photos=true&format[]=pdf` → download each to `field-media/sitevisit/<job>/mp-<hash>-<name>` (skip by `hash`/`last_modified` on re-sync); `GET /plans/statistics/{planId}` and `GET /projects/{id}/plan` → normalized quantities + floor SVGs. | proxy / worker | 3–4 calls | `magicplan_exports` row: `{plan_id, project_id, field_project_id, files[], photos[], statistics, floors_svg[], status:'ready'}` |
| 6 | **NEW — the field app adopts it.** On the bid file's next open (owner's device; any office device), the Site Visit panel reads `magicplan_exports where field_project_id = … and imported_at is null` and shows **"📥 Magicplan scan ready — 1 report, 14 photos, 6 rooms measured · Add to packet"**. Tap → files appended to `siteVisit.files` (`kind: report | photos`, `room` and `caption` parsed from the photo name, `source:'magicplan'`), `project.rooms` filled from the room names (if empty), Floor Plan dimensions table offered as amber rows, `imported_at` stamped. Auto-adopt (no tap) is a per-device setting, on for the owner. | field | — | blob: `siteVisit.files[]`, `siteVisit.magicplan.syncedAt`, `floorPlan.dimensions.rooms[]` (proposed), `rooms[]` |
| 7 | Draft the estimate (bid doc §3 step 7). The draft prompt gets a `magicplanQuantities` block per room (ft², LF, wall ft² net of openings, ceiling ft, doors/windows) and is told to **use measured quantities over anything it reads off the PDF**. | existing `sitevisit.ts` | — | estimate lines with `basis: "Magicplan: 214 ft² floor, 58 LF perimeter"` |
| 8 | Restoration jobs: the floor SVG is offered as the Moisture Map base plan and the room volumes feed `dryingcalc` dehu/scrubber sizing (already volume-based, `dryingcalc.js:73-126`). Claims: **ESX** (`generated_by: ExportConfig.XactimateEsx`) pulled as a Supporting Doc for the carrier packet. | field | `POST /plans/{id}/custom-export` when the config exists | `moistureMaps[].plan`, `supportDocs[]` |
| 9 | Re-scan / edits: `user_modified` newer than `syncedAt` → the Bid card shows "⟳ Scan updated in Magicplan" → re-sync adds only new/changed files (by `hash`), never duplicates. | field / proxy | `GET /projects/{id}` | — |
| 10 | Won: the Magicplan project stays linked to the job for the rebuild (Scope of Work reference plans, moisture map). Lost: `PUT /projects/{id}/archive` (keeps the scan; frees nothing — §6 Q2). | field | archive | — |

## 4. Data

### 4.1 `magicplan_exports` — one small table, service-role written, office/owner readable

```sql
create table public.magicplan_exports (
  id                uuid primary key default gen_random_uuid(),
  mp_project_id     text not null,
  mp_plan_id        text not null,
  field_project_id  text,                       -- resolved from external_reference_id; null = unmatched (§5 listing case)
  status            text not null default 'queued' check (status in ('queued','ready','imported','failed','unmatched')),
  files             jsonb not null default '[]', -- [{path, name, mime, size, hash, folder, mp_last_modified}]
  photos            jsonb not null default '[]', -- [{path, name, room, floor, symbol_instance_id, hash}]
  statistics        jsonb,                       -- normalized: {units, floors:[{name, rooms:[{name, floorSF, perimLF, ceilingFt, wallSF, wallSFNet, doors, windows, volumeCF, dims}]}]}
  floors_svg        jsonb not null default '[]', -- [{floor, path}]
  error             text,
  received_at       timestamptz not null default now(),
  synced_at         timestamptz,
  imported_at       timestamptz,
  imported_by       text
);
alter table public.magicplan_exports enable row level security;
-- read: owner/office (role_is); write: service role only. No delete policy; the 216/227 posture.
revoke all on public.magicplan_exports from anon;
```

Files live in the **existing** `field-media` bucket under `sitevisit/<job>/`, the path the Site Visit panel already uses (`siteFilePath()`, `sitevisit.js`), so the estimator's `packetForDraft()` needs no change — a Magicplan report is just a `report` file with `source:'magicplan'`.

### 4.2 On the bid file (blob, no DDL)

```
siteVisit.magicplan: {
  projectId, planId, cloudUrl,
  createdAt, by,               // who it was created for (the scanning user's Magicplan email)
  syncedAt, exportId,          // last magicplan_exports row adopted
  units: "imperial" | "metric"
}
siteVisit.files[i].source: "magicplan"   // alongside kind/room/caption — so a re-sync can replace, not duplicate
floorPlan.dimensions.rooms[i].source: "magicplan", conf: 1   // measured rows are conf 1; AI-read rows stay what they are
```

### 4.3 Normalization rules (pure, Node-tested)

- `units === "metric"` → m² × 10.764 → ft², m × 3.281 → ft, m³ × 35.315 → ft³; round to 1 ft² / 0.5 ft / 1 ft³. Imperial passes through.
- `floorSF = area_without_walls` (the finished floor), `perimLF = ground_perimeter`, `ceilingFt = height`, `wallSF = walls_surface`, `wallSFNet = walls_surface_without_openings`, `volumeCF = volume`.
- Photo name `"<Floor> - <Room> - <Object> - <n>.jpg"` → `floor`, `room`, `caption = "<Object>"`; a name that doesn't split stays uncaptioned with `room: ""` (never guess).
- Rooms: Magicplan counts a bathroom outside `room_count` but lists it under `rooms[]` — import from `rooms[]`, ignore the counts.
- Duplicate rooms across floors keep the floor prefix (`"Basement — Bedroom"`) only when the same room name appears on two floors.

## 5. Where it shows up

- **Bid card** (bid doc §5.4) gains one line: `📐 Magicplan   project ready · scanned 9/26 2:41 · 14 photos · 6 rooms   [⟳ Pull]` — states: not created / ready on phone / scan received / imported / updated since import.
- **Site Visit panel** (`sitevisit.js`): the 📥 adopt banner (§3 step 6); imported files carry a small `Magicplan` tag; a "Re-pull" replaces same-hash files in place.
- **Floor Plan form**: measured rows land amber with `source: magicplan` and a "✓ Use measured" that sets `conf: 1` — or auto-accepted when the table was empty.
- **Estimate form**: Pricing Basis gets the sentence "Quantities from Magicplan LiDAR scan dated …; wall areas net of openings." Per-line `basis` cites the room's measured figures.
- **Admin ⚙ Settings**: a Magicplan panel in the shape of the QBO/Gmail connection panels (`qboconnect.js` recipe): connected workspace name (from `GET /workspace`), key rotated date, the webhook/authorize URLs with a **Register** button that PUTs them onto the workspace, a test-export log (last 10 `magicplan_exports` rows).
- **Leads Inbox / board**: nothing new — the Bid status line (bid doc §5.2) reads the same `siteVisit.magicplan` fields.

**The `listing_url` case.** When a scan was started in the Magicplan app by hand (no `external_reference_id`), the export button asks Magicplan for our listing: `listing_url` returns the open bid files (`title`, `listing` id) so he picks the job on the phone; the webhook then carries `listing=<field project id>`. Unmatched exports land as `status:'unmatched'` and show in the Settings panel with a "Link to job" picker — never silently dropped.

## 6. Rulings (the questions, kept for the record)

| # | Question | Ruling |
|---|---|---|
| 1 | Which user is the Magicplan project created for? | **The owner's login** (`branden@roybalconstruction.com`) — the only account in the workspace. Held in the `MAGICPLAN_PROJECT_EMAIL` secret, not hard-coded; `siteVisit.by` is recorded but not used for `email` until a second seat exists. (owner, 2026-09-24) |
| 2 | Project quota | No known limit, never hit one — **create at scheduling**, no morning-of deferral. A cancelled visit archives its project (`PUT /projects/{id}/archive`). (owner, 2026-09-24) |
| 3 | Custom export config | **Not needed for M1.** `GET /plans/{id}/files` returns whatever the app has already exported (Report PDF + pinned photos) and `GET /plans/statistics/{id}` needs no export at all. The export config (Report PDF + Sketch PDF; ESX added on claims) is a one-time setup in Magicplan Cloud done together and is the **prerequisite for M2** — which is why M2 moves behind M3 in §7. (2026-09-25) |
| 4 | Per-room scope form in Magicplan (M4) | **No.** Scope is spoken on the narrated walk (`docs/Narrated_Walkthrough_Design.md` §7) and typed on our side; typing into Magicplan mid-walk is slower than talking and splits the scope across two systems. **M4 is dropped** from the build order; revisit only if the walk protocol fails in practice. (2026-09-25) |
| 5 | Key custody | Key **rotated**; `MAGICPLAN_API_KEY` + `MAGICPLAN_CUSTOMER_ID` set as Supabase secrets on **production**. Staging still needs them (and `MAGICPLAN_PROJECT_EMAIL`, `MAGICPLAN_NAME_PREFIX`) — the owner pastes them; they never appear in a repo, a chat, or a browser. (owner, 2026-09-24) |

**Rulings that fell out of building it (2026-09-25, recommendations taken):**

6. **Build order M1 → M3 → M2.** M3 (quantities in the draft) depends only on M1 and on nothing outside the repo; M2 needs the export config and a webhook registration, both owner steps. M4 dropped; M5 stays "later."
7. **One Magicplan workspace, two Supabase projects.** Staging and production both talk to the same live Magicplan account, so projects created from staging appear on the owner's phone. The proxy prefixes project names with the `MAGICPLAN_NAME_PREFIX` secret — `"[STAGING] "` on staging, empty on production — and staging test projects are archived when the test is done.
8. **Project creation fires from the field app only in M1.** When a bid file exists with `siteVisit.at` set and no `siteVisit.magicplan`, the owner's/office's field app calls `createProject` (idempotent: `GET /projects?name=` + `external_reference_id` check first). A **📐 Create Magicplan project** button on the Bid card is the manual path. Creation from the admin Leads Inbox is a follow-up, not M1.
9. **Adopt-on-open is automatic on the owner's device**, a banner-and-tap everywhere else (decision 4 stands; the per-device setting defaults on for the owner).
10. **Measured rows are amber unless the Floor Plan table was empty**, in which case they are accepted with `conf: 1` and `source: "magicplan"` (decision 6, made concrete).
11. **Server-written files use the client's own path shape** — `sitevisit/<job>/mp-<hash>-<name>` must pass `isSitePath()` unchanged — so `packetForDraft()` and every signed-URL read work without a special case.

## 7. Sequencing

| # | Ship | Contents | Effort | Depends on |
|---|---|---|---|---|
| M1 | **Create + pull** | `magicplan-proxy` (office-gated; actions `getWorkspace`, `createProject`, `sync`); `magicplan_exports` migration; Settings panel; Bid card line; project creation at scheduling; **⟳ Pull** button → files + photos + statistics into the packet via the adopt banner; normalization module with Node tests; Floor Plan measured rows. *This alone ends the AirDrop-and-drag step.* | M | bid doc PR 1 (the bid file) |
| M3 | **Quantities in the draft** (built second) | `magicplanQuantities` block in `sitevisit.ts` prompt + Pricing Basis sentence + per-line `basis`; floor SVG → Moisture Map base + Scope of Work reference plan; room volumes → `dryingcalc`; ESX → Supporting Doc on claims (ESX only once the export config exists — otherwise the hook is built and idle). | S–M | M1 |
| M2 | **Doorbell** (built third) | `magicplan-webhook` (level C) + `authorize_url` + `listing_url`; Register button; `jobs_queue` row → sync; "scan received" toast on the owner's phone via the existing push path (`roybal-notify` owner kind). **Prerequisite (owner):** custom export config in the workspace (§6 ruling 3). | S–M | M1, export config |
| ~~M4~~ | ~~Per-room form~~ | **Dropped** (§6 ruling 4) — scope comes from the narrated walk. | — | — |
| M5 | **Later** | Push the sent estimate PDF back to the Magicplan project (`/projects/{id}/files`); `custom_fields` on creation (claim #, carrier) so the Magicplan report cover carries them; team routing (`team_id`) if a second estimator ever exists. | S each | M1 |

**Done when (M1):** scheduling a site visit puts a project with the right name and address on your phone; after the scan, one tap on the Bid card puts the Report PDF and every pinned photo — room-captioned — into the Site Visit packet, and the Floor Plan table shows six measured rooms.
**Done when (M3):** a drafted estimate's baseboard line reads "58 LF (Magicplan)" and the dehu count comes from measured volume.
**Done when (M2):** tapping the Roybal button in Magicplan does the same with zero taps on our side, and a forged POST to the webhook does nothing but write a refused-event row.

## 8. Fence

- No Magicplan URLs stored for read-time use; no client-side calls to `cloud.magicplan.app`; no company key in any browser bundle or `config.js`.
- No writes to `field_projects` from the server for this feature (decision 4). The adopt step is the field app's.
- No Magicplan estimator, no Magicplan pricing, no Xactimate price data on any customer surface (CRM decision 8 stands; ESX is a sketch file for the carrier packet only).
- No automation that changes an estimate without a tap; quantities are amber until accepted (decision 6).
- Era-0 tables (`floor_plans`, `canvas_plans`, …) stay untouched and stay dead.

## 9. Risks — honest version

| Risk | Reality | Mitigation |
|---|---|---|
| Webhook has no signature and no retry | Anyone who learns the URL can POST to it; a down function loses the doorbell | `key` check + IP rate limit; payload never trusted (doorbell-only); the **⟳ Pull** button and the `user_modified` check on open make the webhook a convenience, not a dependency |
| File URLs from Magicplan expire / are pre-signed | A stored URL is dead in hours | Copied into `field-media` at sync; URLs never stored |
| Units mismatch | A metric plan imports as ft² and the estimate is 10× off | `units` read from the statistics response, converted once, asserted in tests; the Floor Plan row shows the unit it came from |
| Photo names change format | Room captions go blank | Parser fails to `room: ""`, never guesses; `symbol_instance_id` kept for a later map through `/projects/{id}/plan` objects |
| Project quota burn on cancelled visits | Money | §6 Q2 — defer creation to the morning-of if the allowance is tight |
| Second write door into the blob | The Aug 6 clobber class | Decision 4: server writes a table and a bucket, the field app writes the blob |
| Key leaks again | The era-0 failure | Secrets only in edge functions; rotate at `cloud.magicplan.app/integrations`; Settings panel shows the rotation date so it's visible when it's stale |
