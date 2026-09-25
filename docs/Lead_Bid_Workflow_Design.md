# Lead → Bid Workflow — Site Visits and Estimates on a Lead

**Status:** design for approval — nothing built
**Date:** 2026-09-24
**Scope:** the missing step between a lead on the Job Board and the Site Visit / Estimate engine that now lives in Field Forms (#217, #219). Additive to `docs/CRM_Design.md` (lead lifecycle, Leads Inbox) and to the field↔board bridge in `apps/field/js/boardpush.js`. Fits under the P5 `leads` table in `docs/architecture/03` when that lands; nothing here has to be undone for it.

*A lead has a lifecycle on the board and a triage row in the admin. A job has forms, a packet, and an estimate in the field app. Between "we should go look at it" and "here's your number" there is nothing — so the bid happens on the kitchen table, in Photos, in iCloud, and in Word. This is the plan for putting that step inside the app without breaking the rule that keeps dead leads off the crew's phones.*

---

## 1. What's actually missing

Three facts, all verified in `origin/main` (through #219):

1. **Leads are board tiles, not job files.** A lead is a `coordination_jobs` row with `stage: "lead"` (CRM decision 3). It has a source, a follow-up, a lead log, an `estValue` typed by hand, Won/Lost. It has no forms.
2. **The estimate engine lives on a job file.** The Site Visit packet (`project.siteVisit` — Magicplan PDF, photos, note pages, room videos → stills, the walk recording → transcript, typed scope) and the Estimate (`project.reconEstimates[]`, now titled "Estimate" on both job kinds) are fields on a `field_projects` row. `sitevisit.js`, `officeai.js siteVisitStart/Result`, and `roybal-ai-office/sitevisit.ts` all take a project.
3. **The bridge deliberately refuses to make a job file for a lead.** `boardpush.js` `tilesNeedingFieldFile()`:

   > Leads/bids stay board-only (dead leads must not litter crew phones)

   A file is auto-created only when a tile reaches `scheduled` or `in_progress` (`adoptBoardJobs`, `fieldSeedFromBoardJob`, id `bj-<tileId>`). That rule is correct — sixty web leads a season must not become sixty blank job files on eight phones — but it means the only way to bid inside the app is to press **+ New Job** and retype the lead, which nobody does. So the bid happens outside, and the board learns about it only when someone remembers to type `estValue` and log "Estimate sent".

Consequences today:

- The site-visit packet (the thing the estimator reads) is assembled in Finder, not in the app, and the draft has to be re-attached to a job file later — or never.
- `estValue`, "🔍 Inspected", "📄 Estimate sent", and the follow-up date are all hand-typed after the fact, so the pipeline stats and the morning-brief nag run on whatever got remembered.
- When a bid is won, the tile advances to Scheduled and the bridge creates a **fresh blank** file — the estimate that just won the job is not on it.
- Time-to-estimate — the number that actually decides close rate on private-pay work — is unmeasurable.

## 2. Locked decisions (proposed)

1. **Additive only.** No table, no column, no renamed blob field. Every step is independently shippable and leaves the system strictly better (the house rule).
2. **Leads stay on the board.** CRM decision 3 holds. The bid state is blob fields on the lead tile, patched through `coordination_job_patch` (the rev-bumping shallow merge from migrations 230/246) — never a whole-blob write from a second app.
3. **A bid file is an ordinary job file, created on demand, never automatically.** Same `field_projects` row, same sync, same forms, same deterministic id (`bj-<tileId>`), same tombstone rules. The "dead leads stay off phones" rule stands unchanged: the only leads that get a file are the ones a person chose to bid, by one deliberate tap — from the office (scheduling the site visit) or from the field (Start bid).
4. **The bid file *is* the job file.** Won never creates a second file: `fieldJobId` is already stamped at creation, and `tilesNeedingFieldFile` already skips linked tiles. The estimate that won the job is on the job from day one, and (construction) "Estimate timeline → Send to Job Board" works from it exactly as today.
5. **Ownership rule, extended.** Field owns the site-visit packet, the estimate, and the estimate total. Board/admin own stage, outcome, follow-ups, and dates. The field writes exactly three things onto the lead tile — `siteVisit.status`, a `leadLog` entry, and `estValue` (with a source marker) — and reads everything else.
6. **Visibility:** bid files show for everyone, grouped under the existing **Leads / Bids** stage group on the field home (they already sort below every working stage). Role-scoped reads arrive with P5 RLS; no per-device toggle now (owner ruling 2026-09-24).
7. **No automation and no customer sends in this doc.** A site-visit confirmation text and a calendar event are listed as follow-ups that ride `roybal-notify`'s existing human-approved rails. Nothing here sends anything.
8. **P5 absorbs, not replaces.** The blob fields in §4 map one-to-one onto the planned `leads` row (`stage, score, log[], outcome, lost_reason`) plus a `site_visit` shape; the write path is already the RPC the roadmap keeps.

## 3. The flow, end to end

Where each step happens and what it writes. Steps marked **NEW** are this doc; the rest exists.

| # | Step | Where | Writes |
|---|---|---|---|
| 1 | Lead lands (web form / phone agent / AI chat / hand-entered) | board tile `stage:'lead'`; Leads Inbox row | existing |
| 2 | Triage: contacted, follow-up set, notes | Leads Inbox / board editor | existing (`firstTouchAt`, `nextActionAt`) |
| 3 | **NEW — 📅 Schedule site visit.** Date, time, who (defaults to the signed-in owner/office user). | Leads Inbox row action + board editor Lead section | `siteVisit:{at, by, status:'scheduled'}`, `nextAction:'Site visit'`, `nextActionAt:<date>` — via `coordination_job_patch` |
| 4 | **NEW — the job file appears.** `tilesNeedingFieldFile` gains one more clause: a lead tile with `siteVisit.at` set (or `bidStartedAt`) and no `fieldJobId`. The seed carries everything the tile knows (§4.2). Deterministic id, tombstone-respecting, idempotent across devices — the existing path. | field app, next home-list load (every device converges on one row) | `field_projects` row `bj-<tileId>`; `fieldJobId` stamped on the tile |
| 4b | **NEW — or from the field: 📐 Start bid.** The Leads / Bids group on the field home also lists **unlinked lead tiles** as ghost rows (title, address, source chip, age, the customer's message). One tap creates the file (same seed) and stamps `bidStartedAt`/`bidBy`. Covers the walk-in and the "I'm driving past it anyway" case. | field home | same as 4 + `bidStartedAt`, `bidBy` |
| 5 | **NEW — the Bid card** sits at the top of the job home while the linked tile is still `stage:'lead'`: a four-line checklist — Site visit · Packet · Estimate · Sent — each with its date and a button (§5.4). | field job home | reads only |
| 6 | Site visit: Magicplan scan, photos, note pages, room clips, the walk recording → **Site Visit panel** in the estimate form (exists: `sitevisit.js`). **NEW:** "✓ Site visit done" on the Bid card. | field | `siteVisit.status:'done'`, `doneAt`; `leadLog` += `{kind:'inspected'}` |
| 7 | Draft the estimate (exists: `siteVisitStart` → room/section lines, assumptions, exclusions, alternates, contingency, accuracy, duration). **NEW:** estimate number auto-suggested per house convention — `RC-<LAST3>-<MMYY>` (e.g. `RC-KEN-0825`), `-2` suffix on collision; editable. | field, estimate form | `inv.invoiceNo` |
| 8 | **NEW — ✉️ Send estimate.** Save as PDF as today, then the adjuster-email pattern already on the estimate form (`forms.js:1710` draft → mailto / confirmed `gmailSend`) with the customer pre-filled. Stamps the send. | field, estimate form | `inv.sentAt`, `inv.sentTo`; tile: `leadLog` += `{kind:'estimate-sent', note:'<no> · $<total>'}`, `estValue:<total>` + `estValueSource:'field'`, `estimateSentAt`, `nextAction:'Follow up on estimate'`, `nextActionAt: +5 business days` (§9 Q1) |
| 9 | Follow-ups: inbox chips, overdue amber, morning-brief nag | existing | — |
| 10 | **Won** (board editor / inbox): stage → Scheduled as today. **NEW:** `contractValue` = estimate total when blank. The file continues — nothing is re-created. **NEW (offer, not automatic):** "Copy site-visit photos into Job Photos as *before*" — the same carry-over the recon conversion does. | board / admin; field on next open | `contractValue`; project `photos[]` on accept |
| 11 | **Lost** (with reason, archived as today). **NEW:** a bid file whose tile carries `outcome:'lost'` auto-archives on next open — `archivedAt` only, nothing deleted, one toast, ↩ Unarchive still there. Dead leads leave the phones the same week they die. | field, on home-list load | `project.archivedAt` |

Two things fall out for free once 3–8 exist:

- **Time-to-estimate** = `estimateSentAt − siteVisit.doneAt` (and `− createdAt`) joins the Analytics tab beside speed-to-lead. No new capture.
- **Bid accuracy** already exists (`estValue` vs `contractValue`); now `estValue` is the real estimate total instead of a guess typed into the tile.

## 4. Data — blob fields, zero DDL

### 4.1 On the lead tile (`coordination_jobs.data`)

```
siteVisit: {
  at:      "2026-09-26T14:00",   // local ISO datetime — the appointment
  by:      "branden@…",          // who's going (profile email); shown as a name
  status:  "scheduled" | "done" | "cancelled",
  doneAt:  "2026-09-26",
},
bidStartedAt: ISO,   bidBy: email,     // stamped at file creation, whichever end triggered it
estValueSource: "field" | "manual",    // the field only overwrites its own number, never a hand-typed one
estimateSentAt: ISO,  estimateNo: "RC-KEN-0925",  estimateTotal: 18450
```

All optional, all defaulting safely; existing tiles render exactly as today. `leadLog` keeps its shape — `inspected` and `estimate-sent` are kinds it already has; the field just writes them instead of a person.

### 4.2 On the bid file (`field_projects`)

Nothing new that the sync engine has to learn. `fieldSeedFromBoardJob()` grows to carry what a lead tile knows and a hand-built tile didn't: `email`, `contactId`, `channel`, and the customer's verbatim `message` (CRM §13.3) → the project `notes` header, so the estimator prompt sees what the customer asked for. `project.bidOf = tileId` is written at creation so the Bid card knows it's a bid *offline*, before board rows load (the `linkedRestorationId` precedent).

On the estimate itself (`reconEstimates[i]`): `sentAt`, `sentTo`, `sentVia: "mailto" | "gmail"`. The invoice editor already carries the shape.

### 4.3 What P5 does with it

`leads(division_id, contact_id, source, channel, stage, score, scam_flags, log[], outcome, lost_reason)` gains a `site_visit jsonb` (or three columns) and `bid_started_at`; `estValue/estimateNo/estimateTotal` become the `scope_baselines` link once estimates are table rows (P4). The blob fields are the migration's source, same as every other CRM field.

## 5. Where it shows up

### 5.1 Admin — Leads Inbox (`apps/admin/js/leads.js`)

- New row action **📅 Site visit** beside ⏰ Follow-up: date, time, who (select from `profiles` with role owner/office/crew_lead; default = signed-in user). Save → the §3 step-3 patch. Stamps `firstTouchAt` like every other triage action.
- State chips on the row, in this order: `📅 Thu 9/26 2:00 · Branden` → `📐 Bid started` (once `fieldJobId` is set) → `🔍 Inspected 9/26` → `📄 RC-KEN-0925 · $18,450 sent 9/27`. The chips are the funnel; you can read the whole pipeline's state without opening a thing.
- Today stat row (CRM §13.4) gains **"site visits this week"** and **"estimates out, no answer > 5d"** — the two numbers that tell you where bids are stuck.

### 5.2 Board — job editor Lead section (`apps/board/js/board.js:2185-2245`)

- Same Site visit fields (date, time, who) inside the existing 🎯 Lead block, saved with the normal Save (the editor already writes the whole blob under the rev guard — the fields ride along).
- A read-only **Bid status** line under them: file created / inspected / estimate no. + total / sent date, with **Open in Field Forms →** (`apps/field/#/p/bj-<id>` — same login, same session).
- Lead cards get one more chip: `📅 9/26` (site visit; amber the day of, red if `siteVisit.at` passed and `status` is still `scheduled`).

### 5.3 Field home — Leads / Bids group (`apps/field/js/app.js:476-520`)

The group already exists (`BOARD_STAGES.lead`, order 4). It grows two kinds of rows:

1. **Bid files** — normal `jobRow`s, plus a small progress chip: `📅 visit 9/26` → `🔍 inspected` → `📄 $18,450 sent`.
2. **Ghost rows** — lead tiles with no file: dimmed card, title/address/source chip/age/the first line of the customer's message, and one button: **📐 Start bid**. Tap → `fieldSeedFromBoardJob` + `Store.put` + link stamp + `bidStartedAt` (the `adoptBoardJobs` body, made callable for one tile). Requires sign-in and network (it's a board write); offline the button says so and does nothing.

Ghost rows are read-only otherwise and never sync anywhere — they are the board's rows, painted. Sixty web leads show as sixty dim lines at the bottom of the owner's list and cost the crew nothing but scroll; if that ever bothers anyone, the fold memory (`foldable()`) already exists and the group can default folded.

### 5.4 Field job home — the Bid card (`apps/field/js/app.js` ~1370, above `completenessPanel`)

Rendered only while `project.bidOf` is set **and** the linked tile is still `stage:'lead'` (or offline and never seen otherwise). Four lines, each a state + a button:

```
📐 BID — Kennedy · 1465 Noble St · Web form · 3d old
  📅 Site visit    Thu 9/26 2:00 · Branden          [✓ Site visit done]
  📎 Packet        4 files · transcript ✓            [Open site-visit packet]
  📄 Estimate      RC-KEN-0925 · $18,450 · draft      [Open estimate]
  ✉️ Sent          —                                  [Send estimate]
  Customer asked: "…the first 200 chars of data.message…"
```

"Open site-visit packet" deep-links to the estimate form with the Site Visit panel open (creating the first estimate instance if none). "Site visit done" and "Send estimate" do the §3 step-6 and step-8 writes. When the tile advances past `lead`, the card disappears and the normal job home is what's left — the file has become the job.

### 5.5 Estimate form (`apps/field/js/forms.js invoice()`, `isEst`)

- **Number suggestion** on first open when `invoiceNo` is blank: `RC-<LAST3>-<MMYY>` from `project.customer`'s last word and today's month; checked against every estimate on every local project for a collision → `-2`. Editable; never overwritten once typed.
- **✉️ Send estimate** button beside Save as PDF: opens the existing email-draft panel with the customer's email pre-filled (subject `Estimate RC-KEN-0925 — 1465 Noble St · Roybal Construction`), the PDF attached where the lane supports it (`gmailSend` via a confirmed chip) or the mailto fallback with a note to attach the saved PDF. Either path stamps the send (§3 step 8). A second send updates `sentAt` and appends a second `estimate-sent` log entry with "(revised)".

## 6. Write paths — the real engineering

| Write | From | Mechanism | Why |
|---|---|---|---|
| `siteVisit`, `nextAction*`, `firstTouchAt` | admin Leads Inbox | `coordination_job_patch` | exists (230/246); rev-bumping; owner/office gate |
| same fields | board editor | whole-blob save under rev guard | exists; the editor already owns the blob |
| file creation + `fieldJobId` stamp | field (auto on `siteVisit.at`, or Start bid) | `Store.put` + `guardedWrite` same-rev annotation | exists (`adoptBoardJobs`); deterministic id; tombstone-respecting |
| `siteVisit.status/doneAt`, `leadLog` append, `estValue` (+source), `estimateSentAt/No/Total` | field | **`coordination_job_patch`** — not `guardedWrite` | a shallow merge can't clobber the office's concurrent edits to the same tile; the whole-blob path is reserved for the tile's own editor. Owner/office JWTs pass; a crew JWT gets the RPC's null no-op → toast "Bid actions are office-only" and the field-side state still saves locally |
| `contractValue` on Won | board editor | whole-blob save | one line in the `wonBtn` handler |
| `archivedAt` on Lost | field | `Store.put` | local; syncs as any edit |

**`estValue` rule:** the field writes `estValue` only when the tile's `estValueSource` is `'field'` or `estValue` is blank. A number the office typed by hand is never replaced silently; the inbox chip shows both when they differ (`~$15,000 · est. $18,450`).

**Board-device conflicts:** a `coordination_job_patch` bumps `rev`, so an open board tab loses its next queued edit on that one tile — the same price CRM §5 and §13.3 already accepted for the inbox. Bids are low-frequency writes on lead-stage tiles nobody is dragging around a schedule; in practice it never fires.

## 7. Sequencing

| # | Ship | Contents | Effort | Depends on |
|---|---|---|---|---|
| 1 | **Field: bid files** | `tilesNeedingFieldFile` lead clause; `fieldSeedFromBoardJob` carries email/contactId/channel/message + `bidOf`; ghost rows + Start bid in the Leads / Bids group; the Bid card; "Site visit done" write; auto-archive on Lost. Node tests for every pure helper (`test/boardpush.test.mjs` pattern). Build bump. | M | — |
| 2 | **Office: schedule the visit** | Leads Inbox 📅 action + chips; board editor fields + Bid status line + Open in Field Forms; lead-card chip; brief line "2 site visits today". | S | — (ships alone: without 1 it's a follow-up with a time on it) |
| 3 | **Field: estimate → tile** | Number suggestion; ✉️ Send estimate (email panel + stamps); `estValue`/`leadLog`/`nextActionAt` patch through `coordination_job_patch`; Bid card Sent line. | S–M | 1 |
| 4 | **Outcomes** | Won → `contractValue` from the estimate; the photo carry-over offer; Analytics: time-to-estimate tile + "estimates out > 5d" stat. | S | 1, 3 |
| 5 | **Follow-ups (later, each its own small PR)** | Site-visit confirmation text to the customer (human-approved, `roybal-notify` rails, quiet hours, opt-in); a calendar event on the owner's calendar; a "prep sheet" on the Bid card assembled from `contact_timeline` (prior jobs at the address, prior messages) — the assistant's `boardRead` already has the data. | S each | 2 |

**Rollback (all):** the new blob fields are optional; ignoring them restores today exactly. A bid file is an ordinary job file — archive it and it's gone from the list, tombstone it and it never comes back.

**Done when (1+2):** scheduling a site visit from the inbox produces a job file on the owner's phone with the customer's message in it, and Start bid from the phone produces the same file with the tile linked.
**Done when (3):** sending the estimate from the field app puts the total and "📄 Estimate sent" on the lead row in the inbox without anyone typing it, and the follow-up date is set.
**Done when (4):** Won carries the estimate total into `contractValue`, and the job that started as a bid has its estimate on it.

## 8. Fence — what this deliberately does not do

- **No new tables, no `leads` table early.** P5 owns that; this doc feeds it.
- **No automatic file creation for leads.** The only triggers are a person scheduling a site visit or pressing Start bid. Sixty web leads stay sixty tiles.
- **No customer sends, no calendar writes** in PRs 1–4 (§7 row 5 is where they go, behind the existing human-approved rails).
- **No estimate-engine changes.** The Site Visit panel, the batch draft, pricing, the ROM shape — untouched. This doc only gives them a place to run.
- **No `.docx` export.** The app prints PDF on letterhead; an editable Word export for private-pay customers is a separate ask (§9 Q4).
- **No Xactimate/Verisk data on any customer surface** (CRM decision 8 stands; `customerScope` is prose, not prices).
- **No role gating beyond what the RPC already does.** Owner/office pass, crew no-ops; P5 RLS does the rest.

## 9. Open decisions for you

1. **Follow-up lag after an estimate goes out.** Proposed default: `nextActionAt` = 5 business days (board work calendar, holidays excluded), `nextAction` = "Follow up on estimate". Different for insurance vs private-pay?
2. **Estimate number convention.** Proposed `RC-<LAST3>-<MMYY>` (`RC-KEN-0925`) with `-2` on collision, from the customer's last name. Confirm, or give the rule you actually use (company-name customers like AmeriGas → `RC-AME-0926`?).
3. **Who may press Start bid** from the field. Proposed: any signed-in user can *see* ghost rows; Start bid and the three tile writes need owner/office (the RPC gate). Should crew leads be allowed to start a bid file when they do the site visit?
4. **Editable `.docx` for private-pay estimates.** Your standing preference is customer-facing estimates as editable Word. The estimate form prints PDF. Do you want a `.docx` export on the estimate form (a `docx` build of the same print layout) as its own PR after this ships?
5. **Site-visit confirmation to the customer.** "Branden from Roybal Construction will be at 1465 Noble St Thu 9/26 at 2:00" — human-approved send via `roybal-notify`, or leave texting manual for now?

## 10. Suggestions beyond the ask

- **Fold the packet into the job's record on Won.** The site-visit photos live in `field-media/sitevisit/<job>/`, not in `project.photos[]`, so today they never print in a packet. The §3 step-10 offer copies them in as *before* photos with the room from the Magicplan pin — the recon conversion already does this for moisture-map plans.
- **One number, three places.** Once `estValue` is the estimate total, the Pipeline view's Σ pipeline dollars, the inbox stat row, and the analytics bid-vs-contract chart all run on real numbers. Worth a one-line note in the Pipeline view: "Σ from sent estimates (n) + manual (m)".
- **The prep sheet** (§7 row 5) is the highest-leverage cheap thing here: before you walk in, the Bid card shows the customer's verbatim ask, every prior text/email/call with them, and any past job at that address. It is a read of `contact_timeline` and `unified_jobs` by `contactId`, both of which exist.
- **Leads that never get a visit** are the other half of close rate. The inbox already knows "unworked"; once `siteVisit` exists it can also say "contacted, no visit scheduled > 3d" — a chip, not a nag.
