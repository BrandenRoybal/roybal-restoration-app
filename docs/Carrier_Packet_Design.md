# Carrier packet: one numbered, versioned PDF, sent from Approvals

Operations spine phase 5. Started on the owner's "go" in the spine thread,
2026-10-10. This is the first slice of roadmap P4 Documents
(docs/architecture/03 §6, §7.6), cut to what a water job needs today.
Revision 2: rewritten after three design reviews (state machine, data
fidelity, operations); every finding is folded in below.

## 1. What the owner gets

When a water mitigation job is dry (its Certificate of Drying is signed) and
has a numbered invoice, the worker assembles **one PDF**, in this order:

1. **Cover**: letterhead and licenses, packet number and version, the job and
   claim facts an adjuster checks first (insured, property, claim, carrier,
   adjuster, date of loss, cause, water category and class, mitigation start
   and finish, drying days, equipment-days), and a contents list with page
   numbers. Version 2 and later say which version they replace and what
   changed.
2. **Certificate of Drying**: the signed form drawn from its fields (with its
   "Final readings with meter photos"), or the signed copy he uploaded.
3. **Work authorization**: the form with its terms (signed by the owner, or
   awaiting the owner's signature, which the email and contents then do not
   call signed), or the uploaded signed copy.
4. **Floor plan**: every uploaded plan page, full page.
5. **Moisture maps**, one per map: header (material, meter, dry goal,
   technician, ambient), the sketch, the reading grid with dry cells marked
   and a P beside readings that have a meter photo, the equipment placement
   diagram, and the meter photos with their captions.
6. **Drying logs**, one per log: dry-out dates, the equipment sizing
   worksheet with any "deviation from worksheet" notes, equipment with set and
   pulled times (scanned times marked S), the psychrometric readings, and the
   equipment scan record.
7. **Photos**: every job photo, numbered, two to a page (four in compact
   mode).
8. **Supporting documents**: each uploaded document, full page.
9. **Invoices**: each ready invoice drawn as billed, then its attachment
   pages.

The packet honors the job's existing "Include in this packet" checklist
(`project.packetExclude`, the packet page in the field app): any section he
unticked there is left out here too.

It appears in the office **Approvals** tab as one card: an email to the
adjuster with the PDF attached, a To field filled from the job's records (he
can change it), and a link to open the PDF first. He taps **Approve and
send**; the worker sends it once and the packet row records it as sent, with
the address it went to. If the job changes afterwards, the next run builds
**version 2 with the same number** and files a new card that says what
changed. A text tells him when a card is waiting (no reply needed; the card
can only be approved in the office app). Crews see nothing new. No AI is used
anywhere: the email is a fixed template.

## 2. What it is not (v1)

- Not included: the narrative, contents inventory, labor log, change orders,
  reconstruction estimates, and the moisture trend chart. Each can be added
  as a section later.
- No QuickBooks call: invoices are drawn from the app's own invoice records.
- No Chromium and no canvas. The worker draws the PDF with its own writer
  (`packet/pdfdoc.mjs` + `packet/flow.mjs`): Helvetica, JPEG passed through,
  PNG decoded and re-deflated, no dependencies. Photos go in at their stored
  size, so a size budget picks the layout.
- No text approval: the card is filed without a text code. He should look at
  the PDF before it goes to a carrier.
- No customer-facing change: the portal and the field packet page are
  untouched.

## 3. Why the worker, and why a table

- The worker already reads job blobs (the billing check), runs on a schedule,
  holds the service key, and delivers email exactly once. A browser builds
  only while a page is open, so it cannot be the "when dry" trigger.
- Number, version and sent state live in `carrier_packets`, never in the job
  blob: the blob merge lets a stale device's newer `updatedAt` win a whole
  top-level value, which would silently revert a version.
- Versions are decided by a hash of the document model (what prints), never
  by `updatedAt`/`rev`: the payment pull, autosaves and drying-log opens bump
  those without changing the document.

## 4. The gate (`packetGate`)

`packetGate(project, opts)` in `packet/model.mjs` returns
`{ ok: true, anchor }` or `{ ok: false, reason, detail }`. `opts`:
`{ today: "YYYY-MM-DD" (Alaska), now: Date, lookbackDays, settleMin,
updatedAt: ISO (field_projects.updated_at), deleted: bool, hasRow: bool,
certSignPending: bool }`. Checks, in order (the first failure is the reason):

| # | reason | rule |
|---|---|---|
| 1 | `deleted` | `deleted` true |
| 2 | `archived` | `project.archivedAt` non-empty |
| 3 | `not_water` | `jobType(p) !== "restoration"` or `!lossTypesOf(p).includes("water")` |
| 4 | `excluded` | `packetExclude` contains `certDrying` or `invoices` |
| 5 | `not_certified` | mode-aware: `c.mode === "upload" ? uploadedDocPages(c).length > 0 : !!c.sigTech` (formkit's `uploadedDocPages`: `uploadedPages`, else `[uploadedDoc]`) |
| 6 | `no_invoice` | no ready invoice (below) |
| 7 | `unchecked_fills` | `uncheckedFills(p)` non-empty |
| 8 | `unread_meter_photos` | `unreadOnEmpty(p)` non-empty |
| 9 | `lookback` | skipped when `hasRow` (the job has a packet row, or a hold from an earlier run, so a job held with a text is built once it qualifies whatever its age); else the anchor date is more than `lookbackDays` before `today` |
| 10 | `settle` | `updatedAt` is less than `settleMin` minutes before `now` |
| 11 | `cert_sign_pending` | `certSignPending` (the lane's portal check, below) |

**Ready invoice**: an element of `invoices[]` that is not `status === "void"`,
is not a held billing-check draft (`reviewGaps && !invoiceNo && !qboInvoiceId`),
has no `estimateId` (a rebuild invoice made from an approved estimate), and
has a printed number `String(invoiceNo || qboDocNumber || "").trim()`
non-empty. A `qboInvoiceId` alone does not count: it is QuickBooks' internal
id, not a number anyone can quote.

**Anchor** (Alaska dates, the latest present): `certDrying.dryComplete`, each
log's `dryoutFinish`, the date part of the latest equipment `removed`, the
latest moisture reading row `date`, `certDrying.sigTechDate`,
`certDrying.issueDate`, the Alaska date of `certDrying.portalSignedAt`, and
each ready invoice's `invoiceDate`. (`sigTechDate` and `issueDate` are
prefilled when the form is opened, so they are never the only evidence of
recency; the invoice date is there so a job invoiced weeks after drying still
gets its packet.)

**Portal signature pending**: the lane reads `portal_jobs?id=eq.<portalShare.id>&select=approvals`
when the job has `portalShare.id`. `certSignPending` is true when the
approval with `id === "certDrying"` is `pending` with a document, or
`approved` while the blob's certificate has neither `sigOwner` nor
`portalSignedAt` (the office app has not copied it back yet), and in both
cases only while that approval's `updatedAt` is less than 72 hours old, so a
customer who never signs cannot hold the packet forever.

What a "no" does (the lane, §11):

- `deleted`, `archived`, `not_water`, `excluded`, `not_certified`,
  `no_invoice`, `unchecked_fills`, `unread_meter_photos`: when the job has an
  open card, **withdraw** it (`carrier_packet_withdraw`), so a voided invoice
  or a cleared certificate never leaves an approvable PDF behind.
- `no_invoice`, `unchecked_fills`, `unread_meter_photos` also record a
  **hold** with one heads-up text per job and reason (§13).
- `lookback`, `settle`, `cert_sign_pending`: nothing; the job is looked at
  again next hour.

## 5. The document model

`buildModel(project, opts)` in `packet/model.mjs` is pure: it reads nothing
but its arguments, never the clock, and never mutates `project` (it works on
`structuredClone(project)`, runs `applyScans(copy)` on it as reconcile.js
does, and never runs `settleTypedRow`). `opts`:

```js
{
  today: "2026-10-10",          // Alaska date
  now: Date,                    // only for "as of" text that is NOT hashed
  prevPhotoNums: { "<photo id>": 7, ... } | null,   // from the job's latest row
}
```

It returns:

```js
{
  v: 1,                                   // model format; bump on any layout-visible change
  jobId: "<uuid>",
  cover: {
    customer, address, claimNo, carrier, adjuster, dateOfLoss, lossCause,
    workOrderNo, waterCategory, waterClass,
    facts: [["Mitigation start", "10/01/2026"], ["Mitigation finish", "10/06/2026"],
            ["Drying days", "6"], ["Certificate dated", "10/06/2026"],
            ["Dehumidifier days", "2 × 5"], ["Air mover days", "8 × 5"], ...],
  },
  sections: [Section, ...],               // print order, included sections only
  media: { "<key>": MediaRef, ... },      // every image the sections reference
  photoNums: { "<photo id>": 7, "m:<image hash>": 8, ... },  // the numbering this model used (stored on the row);
                                          // "m:" keys a photo with no id, or a second photo with the same id
  counts: { maps, readings, meterPhotos, logs, equipment, scans, photos,
            invoices, invoiceTotal },
  unitsOut: ["AM-014 (Kitchen)", ...],    // equipment with no pull time, for the card
  hardGaps: ["Before photos", ...],       // completeness.js evaluateProject(p).hardGaps labels
  missing: 0,                             // media refs with no source at all
}
```

**Section**

```js
{ key: "cert" | "workAuth" | "floorPlan" | "maps" | "logs" | "photos" | "docs" | "invoices",
  title: "Certificate of Drying",          // section band and bookmark
  parts: [Part, ...] }
Part = { title: "Moisture Map — Kitchen" | null,   // child bookmark; null for single-part sections
         newPage: true | false,
         blocks: [Block, ...] }
```

**Blocks** (the whole contract between model and renderer; the renderer
decides geometry only):

| block | fields |
|---|---|
| `{t:"fields", pairs:[[label, value]], cols}` | key-value grid, `cols` 2 or 3; blank values print as a line |
| `{t:"subhead", text, right}` | small heading, optional right-aligned note |
| `{t:"para", text, size, font, color}` | `font` `reg`/`bold`/`ital`, `color` `black`/`sub` |
| `{t:"bullets", items:[text]}` | |
| `{t:"table", columns:[{head, w, align}], rows:[[Cell]], size, zebra}` | `w` in points, or a fraction ≤ 1 of the content width; header repeats across pages; no rows prints "None recorded." |
| `{t:"image", media, maxH, caption}` | one image fit to the content width and `maxH` |
| `{t:"grid", items:[{media, caption}], perRow, boxH}` | image grid; `caption` is a string or `[boldPrefix, rest]` |
| `{t:"photos", items:[{media, caption:[prefix, rest]}]}` | photo pages; layout from the render mode (full: one per row, two per page; compact: two by two) |
| `{t:"pages", items:[{media, caption}]}` | each item a full page (uploaded documents) |
| `{t:"signatures", items:[{label, name, date, media, electronic}]}` | `media` null prints a blank line; `electronic` prints "Signed electronically by NAME, MM/DD/YYYY" in place of an image |
| `{t:"note", text}` | gray boxed note |

`Cell` is a string or `{text, font, color, fill, mark, align}` where `fill`
is `dry`, `wet` or `band`, and `mark` is a short superscript (`"S"`, `"P"`).
Colors and fills are palette names only; the renderer maps them to
`pdfdoc.C`.

**MediaRef**: `{ kind: "photo" | "meter" | "sig" | "sketch" | "page",
full: Source, small: Source | null }` where `Source` is
`{ hash: "<64 hex>" }` (an object in `field-media`) or
`{ inline: "data:image/...;base64,..." }`. The key is the full source's hash,
or `inline:<sha256 of the data URL>` for an inline image. `small` exists only
for job photos: the archived 480 px copy when the photo is archived
(`cloud` set and `src` is a marker), else `thumb_<full hash>`.

**Section contents and sources**

- `cert`: `mode === "upload"` → one `pages` block of `uploadedDocPages(c)`.
  Otherwise fields (certificate no., dated, drying days, start, complete,
  affected areas), the verification table (material, meter, goal, final,
  reference, dry Yes/No), the equipment summary (`dehuDays`, `amDays`,
  `scrubDays`, `heaterDays`), signatures (technician, owner, adjuster), then
  "Final readings with meter photos" from `finalReadingPhotos(p)` as a grid.
  A signature's date prints only when its signature exists (the dates are
  prefilled); an owner signature from the portal prints as electronic, dated
  from `portalSignedAt` in Alaska time.
- `workAuth`: `mode === "upload"` → `pages`. Otherwise the form as it prints:
  the date, the checked `SCOPE_ITEMS` as bullets, the terms paragraphs
  (Authorization, Payment, Insurance, Access, Exclusions, Right to Stop), the
  SMS consent line, and the owner and representative signatures. The terms
  text is copied into `packet/workauth.mjs`; a test reads
  `apps/field/js/forms.js` as text and fails if any copied paragraph is not
  found there verbatim.
- `floorPlan`: `pages` of `uploadedDocPages(project.floorPlan)`.
- `maps`: one part per map (`newPage`), titled by its label: header fields,
  the sketch (`m.sketch`, else `m.floorPlan`) as an `image`, the reading
  grid in blocks of 13 locations (Date + Loc 1..13; a cell is `dry` when its
  value is at or under the map's goal, using the form's rule: strip non-number
  characters from `dryGoal`, else `goalFor(material)`; mark `P` when
  `photoAt` finds a meter photo), notes, the equipment placement diagram
  (`equipmentPlanImg`) when present, then the meter photos from
  `mapPhotoEntries` (orphans and older photos included) as a grid, captioned
  `Loc N · MM/DD · value%`.
- `logs`: one part per log: dry-out start and finish, supervisor, the sizing
  worksheet (`equipCalc` figures against what was placed, and each
  `calcDeviation` note) when present, the equipment table (tag/asset, type,
  location, set, pulled, hours, notes; scanned times marked `S`; a unit with
  a set time and no pull time prints "still out" and no hours), the psychrometric table, and
  the scan record from `scanRecord(copy, placeIds, log.id)` (time, tag, type,
  action, room, read by, tech). Times are Alaska wall time `MM/DD HH:MM`. A
  typed row prints its stored `hours`. "Read by" and "Tech" show the scan's
  tech or login name, never an email address.
- `photos`: every photo with `src` or `cloud`, in stage order (before, during,
  after; anything else counts as during), then by number. Caption
  `["#007", " · BEFORE · Kitchen · caption"]`. No dates (a photo's `ts` is
  when it was added, not taken).
- `docs`: one part per `supportDocs` element with pages, unless
  `supportDocs:<id>` is excluded.
- `invoices`: one part per ready invoice: number, date, due date, terms, bill
  to and claim facts, loss summary, the lines grouped by room, then the totals
  ladder as billed. Before totals are computed, a copy applies the editor's
  O&P rule: when `opAuto` is set and `opMode === "pct"`, overhead and profit
  are `hasSubcontractorDocs(p) ? 10 : 0` (fincalc.js); then
  `invoiceTotals(copy)`. Then each attachment's pages as `pages`.
  Payments are printed as of the build ("Payments received", "Balance due")
  but sit under keys that start with `_`, which the hash ignores (§6).

**Photo numbers** stay fixed across versions. v1 numbers each photo by its
1-based position among photos with `src` or `cloud` (the photo log, ZIP and
portal numbering). Later builds keep every number in `prevPhotoNums`, give
new photos the next numbers in photo-log order, and leave a deleted photo's
number unused. `photoNums` is stored on the packet row.

**Dates and times** go through `scans.wallTime` (Alaska time) for any UTC
timestamp; `YYYY-MM-DD` strings print as `MM/DD/YYYY`. Nothing reads the
container clock (UTC).

## 6. Hash and versions

- `modelHash(model)` = sha256 hex of a canonical JSON (sorted keys) of
  `{ v, cover, sections }`, dropping every key that starts with `_`, with
  media referenced by key only. `model.media`, `counts`, `unitsOut`,
  `hardGaps` and everything the lane passes at render time (number, version,
  build time, mode, links) are outside the hash.
- `sectionHashes(model)` = the same per section key plus `cover`.
  `changedSections(prev, cur, model)` lists the titles whose hash differs,
  plus added and removed sections, in print order.
- So payments, balances, invoice status, `rowId`s, archive rewrites of
  `src` (the media key is the full-resolution hash either way), and the
  passing of time never make a version 2.
- **Number**: `PKT-YYYY-NNNN`, one per job, from `document_sequences` inside
  the reserving transaction (year in Alaska time). Never reused.
- **Version**: the printed label. A build's version is 1 + the highest
  version that was actually **sent** (status `sent`), 1 when none. A build
  that replaces an unanswered or declined card keeps that card's version, so
  an adjuster never receives version 2 without having received version 1.

## 7. Rows and states

`carrier_packets` (one row per build; rows are never reused):

| column | |
|---|---|
| `id` uuid pk, `org_id` | |
| `job_id` uuid not null | `field_projects.id` |
| `number` text, `version` int, `seq` int | `unique (job_id, seq)`; every row of a job carries the job's one number |
| `model_hash` text, `section_hashes` jsonb, `photo_nums` jsonb, `meta` jsonb | `meta` = counts and notes for the card |
| `status` | `building`, `failed`, `ready`, `superseded`, `sent`, `undelivered` |
| `build_token` uuid | set at reserve; finalize is compare-and-set on it |
| `error` text, `permanent` bool | a failure's reason; `relabel` failures do not count as tries |
| `bucket`, `path`, `sha256`, `bytes`, `pages`, `mode` | the stored PDF (`mode` `full`/`compact`) |
| `proposal_id` uuid, `offer` int | the current card and how many re-offers it took |
| `outbox_id` uuid, `sent_at`, `sent_to` | set by the executor and the outbox trigger |
| `pdf_removed_at` | the PDF was deleted (never for an undelivered row, nor one an outbox row could still send); a sent row keeps its status, `sent_at` and `sent_to` |
| `created_at`, `updated_at` | |

Partial unique indexes: one `building` row per job, one `ready` row per job,
and `(job_id, version)` unique where `status = 'sent'`.

`document_sequences (org_id, kind, year, next_value)`, primary key
`(org_id, kind, year)`; `document_next_number('PKT', year)` returns
`PKT-2026-0001` and increments.

`carrier_packet_holds (job_id pk, org_id, reason, detail, since, texted_at,
texted_reason, updated_at)`: why an in-scope job is not getting a card. A
hold for the whole lane (storage full) uses the nil uuid as `job_id`.

### The lock protocol

Every function that touches a job's packet rows (reserve, file, reoffer,
fail, withdraw, and the executor) first takes
`pg_advisory_xact_lock(hashtextextended('carrier_packet:' || job_id, 0))`,
then row locks. A proposal row is never waited on while holding that lock:
superseding a card uses `FOR UPDATE SKIP LOCKED`, and a card that cannot be
locked means the owner is approving it right now.

### `carrier_packet_reserve(p_job_id, p_model_hash, p_section_hashes, p_photo_nums, p_meta, p_year, p_build default true)` → jsonb

Under the lock, after `op_expire_proposals()`:

1. `outbox_channel_ready('packet')` false → `{action:"skip", reason:"lane_off"}`.
   The owner's switches: `packet.send@1` deprecated in `operation_catalog`,
   or `op_agent_permits(agent:documents, 'packet.send', 'comms', 'propose')`
   false (the grant revoked, or agent:documents disabled in `agents`) → skip
   `not_permitted`, so revoking the grant stops builds and texts at once and
   restoring it picks the jobs up again.
2. A `building` row older than 30 minutes becomes `failed` with error
   `abandoned` (not permanent; it keeps its planned `bucket`/`path`, so the
   cleanup removes anything it uploaded); a fresh one → skip `building`.
3. Tries: the job's `failed` rows with this hash, excluding `relabel`. Any
   `permanent`, or 3 or more → skip `failed_cap` with `error` = the last
   counted failure's error (300 characters) and `permanent` (it stopped
   short of 3 tries); when that error is `too_large…`, skip `too_large`
   instead. The lane holds the job on either, every run (so a text that
   failed goes next run), and texts once per reason: "after 3 tries", or
   "something in the job stops it" when permanent.
   Then: any outbox row of channel `packet` for this job that is `pending`,
   `sending` or `failed` → skip `in_flight`. That covers an approved card
   and a dead row someone revived after its version was offered afresh; a
   card or a build now could send the carrier two.
4. S = the highest-seq `sent` row. R = the `ready` row, locked. Its card
   status is read from `proposals`.
5. R exists and its card is `approved`, `executing` or `executed` → skip
   `in_flight` (the outbox trigger settles R soon).
6. R exists with this hash: card `proposed` → skip `open`; `declined` → skip
   `declined`; `expired`, `superseded` or `failed` → **reoffer R** when
   `R.offer < 3`, else skip `offer_cap`.
7. No R; U = the highest-seq `undelivered` row with seq above S. U has this
   hash: its error is about size → skip `too_large` (with the error); its
   PDF is missing or does not match → build; else **reoffer U** when
   `U.offer < 3`, else skip `offer_cap`.
   A reoffer (R or U) whose PDF is no longer stored (`pdf_removed_at`, or no
   object in `storage.objects`: removed by hand) is built instead.
8. S has this hash (a change was undone) → skip `sent`. What is on offer
   above S is withdrawn first: R's card is locked `SKIP LOCKED`; not
   lockable, or approved/executing/executed → skip `in_flight`; `proposed` →
   superseded (`superseded_reason: withdrawn`, `reason: already_sent`, with a
   `proposal.superseded` event as agent:documents; the card reads "Withdrawn:
   the carrier already has this version"); R → `superseded` with error
   `withdrawn: already_sent`; `undelivered` rows above S → `superseded`.
9. Otherwise, with `p_build` false → skip `no_build`; else **build**: insert a `building` row with seq = max + 1, version =
   (S.version or 0) + 1, the job's number (allocated on the first row),
   a new `build_token`; delete the job's hold.

Returns `{action, reason}` for a skip, or
`{action:"build"|"reoffer", packet_id, number, version, seq, build_token,
path, sha256, bytes, pages, mode, replaces}` where `replaces` is S as
`{version, sent_at, sent_to, section_hashes}` or null.

### `carrier_packet_file(p_packet_id, p_build_token, p_pdf, p_input, p_rationale, p_evidence_refs)` → jsonb

`p_pdf` = `{bucket, path, sha256, bytes, pages, mode}`; `p_input` =
`{subject, body, filename, suggested_to, suggested_from}`. Under the lock:

- The row must be `building` with this token, else `{status:"lost"}`.
- Re-check: its version must still be 1 + the highest sent version, and if a
  `ready` row R exists its card must be lockable (`SKIP LOCKED`) and in
  `proposed`, `declined`, `expired`, `superseded` or `failed`. Otherwise the
  row fails with error `relabel` (not counted as a try) →
  `{status:"relabel"}`; the next run rebuilds with the right label.
- Supersede R's card if it is `proposed` (as 0021/0023 do) and set R
  `superseded`; set any `undelivered` row above S `superseded` too.
- `op_expire_proposals()`, then `op_propose` as agent:documents with
  operation `packet.send`, input `p_input + {packet_version_id, offer}`,
  `proposed_via 'agent'`, expiry 14 days, trying offer 0, 1, 2 … (the 0021
  pattern) until it gets back a row that is `proposed` and was proposed by
  agent:documents. Then `update proposals set sms_code = null where id = …
  and sms_code is not null`.
- The row becomes `ready` with the PDF fields, `proposal_id` and `offer`.

Returns `{status:"filed", proposal_id, superseded:[{bucket, path}]}` (PDFs
the worker may now delete: superseded rows never sent and with no outbox
row).

### Other doors

- `carrier_packet_reoffer(p_packet_id, p_input, p_rationale, p_evidence_refs)`:
  the row is `ready` with a dead card or `undelivered`, is still the job's
  latest live row, `offer < 3`, and no `packet` outbox row of the job is
  `pending`, `sending` or `failed` (else `{status:"lost", reason:"in_flight"}`). Files a new card (offer + 1) exactly as
  above, sets the row `ready` with the new `proposal_id`, clears `outbox_id`
  and `error`.
- `carrier_packet_fail(p_packet_id, p_build_token, p_error, p_permanent)` →
  `{status, capped}`: compare-and-set `building` → `failed`, keeping the
  planned `bucket`/`path` so the cleanup can remove an upload.
- `carrier_packet_withdraw(p_job_id, p_reason)` → `{withdrawn, pdf}`:
  supersedes the open card (skip locked; a locked card is left alone) and
  sets its row `superseded` with error `withdrawn: <reason>`.
- `carrier_packet_hold(p_job_id, p_reason, p_detail)` → `{text_due}`:
  upserts the hold; `text_due` when this reason has not been texted for this
  job. `carrier_packet_hold_texted(p_job_id, p_reason)` records the text.
- `carrier_packet_candidates(p_lookback_days, p_limit)` → `setof (job_id,
  updated_at, has_row, open_row)`: jobs not deleted, with a certificate
  (`sigTech`, `uploadedPages` or `uploadedDoc` non-empty) and
  `updated_at > now() - (lookback + 2 days)`; plus jobs with packet rows whose
  `updated_at` is later than their newest row's `created_at`; plus jobs with
  a `ready` row (to withdraw when they leave scope); plus live jobs with an
  `undelivered` row above their newest `sent` one and `offer < 3` (to offer
  it again, however old the job's last change). Oldest `updated_at` first;
  `has_row` counts a hold as a row.
- `carrier_packet_state(p_job_id)` → `{photo_nums, last_sent}`: the latest
  row's `photo_nums` and S's `{version, sent_at, sent_to, section_hashes}`.
- `carrier_packet_pdfs_to_remove(p_limit)` → `setof (id, bucket, path)`:
  rows with a path and no `pdf_removed_at`: `superseded` and `failed` rows
  no outbox row references; `ready` rows whose card was declined more than
  14 days ago, or that stopped at `offer_cap` and whose last card ended more
  than 14 days ago; and `sent` rows more than 90 days after `sent_at`
  (Gmail's Sent folder keeps every copy that went out). Never an
  `undelivered` row, nor one an outbox row could still send.
  `carrier_packet_pdfs_removed(p_ids uuid[])` re-checks the same rules and
  stamps `pdf_removed_at`; a sent row keeps its status and record.
- `carrier_packet_storage_bytes()` → bigint, and
  `carrier_packet_media_sizes(p_names text[])` → `setof (name, bytes)`:
  sizes from `storage.objects.metadata->>'size'` for the `carrier-packets`
  and `field-media` buckets, with dynamic SQL behind
  `to_regclass('storage.objects')` so db-replay (no storage-api) still
  creates them; there they return 0 and no rows.

All doors: `security definer`, `set search_path = public, pg_temp`, owner
postgres, `revoke all … from public, anon, authenticated`, `grant execute …
to service_role`.

## 8. The operation: `packet.send@1`

- Catalog row: `action_type` comms, runtime `sql`, owner approval (the
  seeded comms policy), executor `op_exec_packet_send`.
- Input schema (`additionalProperties: false`): required
  `packet_version_id` (uuid), `offer` (integer), `subject` (≤ 300), `body`
  (≤ 100000), `filename` (≤ 200); optional `suggested_to` (≤ 320),
  `suggested_from` (≤ 200), `to` (one bare address, the `email.send` pattern,
  ≤ 320), `cc` (≤ 1000).
- Idempotency template `packet.send:{packet_version_id}:{offer}`.
- Proposer: a new agent `agent:documents` (fixed uuid), kind `automation`,
  with a `propose` grant for `packet.send` and the events its siblings got.
- Nobody else proposes it: explicit deny rows in `role_permissions` for
  `packet.send` / `propose` for owner, office, crew_lead, crew and viewer
  (an exact-operation deny beats the `comms:*` wildcard), so a hand-made
  card from the app can never point a send at a packet row.
- **The To is never filed.** The card shows `suggested_to` in a To field; the
  office app sends `p_edited_params: {to, cc}` with the approval, and
  op_proposal_approve validates `input || edited_params` against the schema.

`op_exec_packet_send` (the 0023 executor shape), under the job lock:

- `packet_version_id` comes from `p_proposal.input`, never from edited
  params.
- `p_proposal.edited_params` must contain `to` and only the keys `to` and
  `cc`, else it raises "Reload Approvals and confirm the recipient." (an old
  cached card that cannot send a To can never send the suggested one). It
  checks the `cc` addresses as well as the `to`.
- The job exists, is not deleted and not archived.
- The row is `ready`, its `proposal_id` is this proposal, no `ready`, `sent`
  or `undelivered` row of the job has a higher seq, and its PDF is present
  (`path` set, `pdf_removed_at` null).
- No other `packet` outbox row of the job is `pending`, `sending` or
  `failed`; else it raises "an earlier send of this packet is still going
  out, so nothing was sent".
- Inserts ONE outbox row: channel `packet`, operation `packet.send@1`, key
  `'outbox:' || p_proposal.idempotency_key` (on conflict do nothing),
  `proposal_id`, `job_id`, and the payload below; stores `outbox_id` on the
  row; emits `packet.queued`.

### Outbox payload

```json
{
  "to": "adjuster@carrier.com", "cc": "",
  "subject": "...", "body": "...",
  "packet_version_id": "<uuid>", "job_id": "<uuid>",
  "attachments": [{
    "bucket": "carrier-packets", "path": "<job_id>/PKT-2026-0007-v1-b3.pdf",
    "filename": "PKT-2026-0007 v1 - Claim 12345 - Smith.pdf",
    "content_type": "application/pdf", "sha256": "<hex>", "bytes": 6123456
  }]
}
```

`outbox_packet_result`: AFTER UPDATE OF status ON outbox, for rows with
`channel = 'packet'` whose status changed to `sent`, `delivered` or `dead`.
`sent`/`delivered` updates the packet row with `outbox_id = new.id` or
`id = payload->>'packet_version_id'` (a revived row whose version was
re-offered meanwhile, so `outbox_id` was cleared) → status `sent`,
`sent_at`, `sent_to = new.payload->>'to'`, `outbox_id = new.id`; that row's
fresh card, if still `proposed` and not this row's proposal, is superseded
(`superseded_reason: sent`). `dead` updates only the row with
`outbox_id = new.id` → status `undelivered`, `error = new.error`. Wrapped in `begin … exception when
others then raise warning … end` so it can never fail `outbox_sent`,
`outbox_failed` or the lease sweep.

The outbox `channel` check constraint gains `packet`, so a worker that does
not know packets never claims one (it would send the email without the PDF).

## 9. Delivery: the packet channel

- `cfg.channels` gains `packet` when email is enabled and
  `CARRIER_PACKET` is not `off`; the heartbeat reports it, which is what
  `outbox_channel_ready('packet')` reads.
- `ctx.adapters.packet` is the email adapter in packet mode (same Gmail
  connection, `connection: "gmail"`). Plain `email` rows are built and sent
  byte-for-byte as before.
- Packet send: validate `to`/`cc`, the age limit as for email, exactly one
  attachment from bucket `carrier-packets`; download it with the service key
  (`AbortSignal.timeout(60s)`), check its size and sha256 (a mismatch is
  permanent); build `multipart/mixed` (text/plain body + base64
  application/pdf part with the filename, RFC 2231 encoded when not ASCII)
  with a fixed `Message-ID: <packet-<packet version id>@roybalconstruction.com>`
  (one per packet version, so a re-offered version approved again on a new
  outbox row carries the same id; a payload without a uuid falls back to
  `<outbox-<outbox id>@…>`);
  POST it to `https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media`
  with `Content-Type: message/rfc822` and `AbortSignal.timeout(120s)`.
- `findPrior` for packet rows: the `email_messages` tag as today, then an
  outbound `email_messages` row with that `message_id_header`, then Gmail
  `GET /gmail/v1/users/me/messages?q=rfc822msgid:<that id>`; a hit is
  adopted, so a timeout after Gmail accepted never sends twice, on this row
  or a later one for the same version.
- Gmail 413, or an error saying the message is too large, is permanent.
- The `email_messages` row is written as for email (so it shows in the job's
  email history), with `body_text` the body and the subject as sent.

## 10. Storage and size

- Private bucket `carrier-packets`, created by the worker on first use
  (`POST /storage/v1/bucket` `{id, name, public:false,
  file_size_limit: 26214400, allowed_mime_types:["application/pdf"]}`; a 409
  means it exists). Not created in SQL: db-replay has no storage-api. No
  storage policies, so only the service role reads or writes it; crew logins
  (which can write `field-media`) cannot touch a sent PDF.
- Path `<job_id>/<number>-v<version>-b<seq>.pdf`, uploaded with
  `x-upsert: false`. A 409 there means an earlier attempt of this same row
  uploaded it: download, and reuse it if its sha256 matches, else delete and
  upload again (that row was never filed).
- The card links the PDF with a signed URL valid 15 days.
- `services/worker/storage.mjs` (service role):
  `ensureBucket(id, opts)`, `getText(bucket, name)` (a media object: its
  data-URL text), `getBytes(bucket, name)`, `put(bucket, name, bytes,
  contentType)`, `sign(bucket, name, seconds)` → absolute URL,
  `remove(bucket, names[])`. Each call has a timeout; 429 and 5xx are retried
  with backoff (3 tries); a 404 returns null.
- Media text → bytes: strip `data:<mime>;base64,` and base64-decode; a
  non-image prefix counts as missing.
- **Downloads are throttled**: at most `PACKET_DOWNLOADS` (4) at a time,
  jobs one after another, at most `PACKET_MAX_BUILDS` (3) builds per run.
- **Budget**, from `carrier_packet_media_sizes` before anything is
  downloaded (bytes ≈ (text size − prefix) × 3 / 4):
  - fixed bytes = every non-photo image (certificate and invoice pages,
    plans, sketches, meter photos, signatures) + 60 KB;
  - full = fixed + every photo's full copy; if ≤ `PACKET_FULL_KB` (9500)
    → mode `full`;
  - else compact = fixed + each photo's small copy when it exists (else its
    full copy) → mode `compact`;
  - after rendering, a PDF over `PACKET_HARD_KB` (17000; about 23 MB once
    base64-encoded, under Gmail's ~25 MB limit) fails permanent
    `too_large` and holds the job with a text.
- Storage cap: `carrier_packet_storage_bytes()` + the job's estimate over
  `PACKET_STORAGE_MB` (300), or `PACKET_MAX_BUILDS` reached, → the reserve
  is called with `p_build = false`, so skips and re-offers (which need no
  room) still happen; only a `no_build` answer for lack of room holds the
  lane (`storage_full`, one text), and nothing more is built that run.
- Cleanup each run: `carrier_packet_pdfs_to_remove(20)` → remove →
  `carrier_packet_pdfs_removed` (the rules in §7: dead superseded and
  failed rows, ready rows declined or stopped at `offer_cap` more than 14
  days ago, and sent versions 90 days after they went out). So the bucket
  holds about the last 90 days of sends plus what is on offer or
  undelivered, and a full bucket clears on its own as sent copies pass 90
  days; the first build with room deletes the lane's hold. The
  `storage_full` text says so, and that raising `PACKET_STORAGE_MB` makes
  room sooner (the worker README's "Packet storage full").

## 11. The lane: `packet.build`

- Cron `carrier-packet-hourly` at minute 25, enqueuing `packet.build` with
  key `packet.build:<Alaska YYYY-MM-DDTHH>` (the 0021 pattern, guarded when
  pg_cron is absent).
- `packet.build` is added to the `QUEUE_KINDS` default and to `handlers`,
  loaded with a lazy `import("./packet.mjs")` so a packaging miss fails only
  this kind, never worker boot.
- Kill switch `CARRIER_PACKET=off`: the job finishes `{skipped:"off"}` and
  the `packet` channel is not served (so no card is filed either).
- A run more than 2 hours after its `run_after` → `{skipped:"stale"}`.
- Per run: ensure the bucket (else `{skipped:"bucket_missing"}`), list
  candidates, then for each job, sequentially and each in its own try/catch:
  fetch the blob, read the portal approval when needed, gate; on a no,
  withdraw and/or hold (§4); on a yes, `carrier_packet_state`, `buildModel`,
  hash, reserve; then build or reoffer:
  - **build**: budget, storage cap, download media, render, upload, read the
    job's inbound emails and the connected account for the recipient, sign,
    `carrier_packet_file`; on `filed` send the "ready" text and remove the
    superseded PDFs; on `relabel`/`lost` remove the upload. Any error →
    `carrier_packet_fail` (permanent for too-large and bad data), and at the
    cap a hold with a text.
  - **reoffer**: recipient, sign, `carrier_packet_reoffer`, text.
  - then the PDF cleanup.
- Result: `{seen, in_scope, built, reoffered, withdrawn, held, skipped:{reason:n},
  failed:[job_id…]}`. Job ids only, no customer data.

Knobs (Fly env): `CARRIER_PACKET`, `PACKET_LOOKBACK_DAYS` (14),
`PACKET_SETTLE_MIN` (120), `PACKET_MAX_BUILDS` (3), `PACKET_DOWNLOADS` (4),
`PACKET_FULL_KB` (9500), `PACKET_HARD_KB` (17000), `PACKET_STORAGE_MB` (300),
`PACKET_TEXTS` (`off` stops the texts only). All clamped like the other
knobs.

First run: water jobs whose anchor is in the last 14 days get cards. Any he
already sent by hand he declines; a declined card stays declined until the
job changes.

## 12. Recipient

`pickRecipient({project, emails, account, lastSentTo})` in
`packet/recipient.mjs` → `{to, source}`:

1. `lastSentTo` (the address the last sent version went to) → source
   `last_sent`.
2. Otherwise adjustersend.js `prefillTo` rules, mirrored: the newest inbound
   email filed to the job matched on the claim number, else the newest inbound
   email that is not the customer's, else the first address in the Adjuster
   field. Both email rules skip mailer-daemon, postmaster, no-reply,
   noreply, donotreply and do-not-reply senders and the connected account.
3. Otherwise empty: he types it on the card.

`emails` are the job's `email_messages` rows (`direction=in`,
`from_addr, matched_by, received_at`, newest 50). A test imports
adjustersend.js and checks the mirror gives the same answer on cases without
junk senders.

## 13. Words: email, card, texts (templates, no AI)

- `emailText(model, label)` → `{subject, body, filename}`.
  - Subject: `Claim 12345 - Jane Smith - water mitigation documentation (PKT-2026-0007 v1)`
    (claim part omitted when there is no claim number).
  - Body: greeting; what is attached; insured, property, claim, carrier, date
    of loss; the contents with counts (certificate dated, maps / readings /
    meter photos, logs / equipment, photos, each invoice number and total);
    for version 2 and later "This version replaces version N sent MM/DD/YYYY.
    What changed: …"; in compact mode "Photos are reduced in size to keep this
    email under carrier size limits; full-size photos are available on
    request."; a request to confirm receipt; the signature block from
    `COMPANY` (signatory, title, company, phone, email, licenses).
  - Filename: `PKT-2026-0007 v1 - Claim 12345 - Smith.pdf`, characters
    outside `[A-Za-z0-9 #._-]` dropped.
- `rationaleText(model, label, facts)` → the card's Why: one line naming the
  packet and job, then lines for the suggested To and where it came from,
  pages and size (a warning above 10 MB), compact mode, units still out, hard
  gaps from completeness, missing images, and for version 2 what changed.
- Texts (roybal-notify `sendSms`, kind `brief`, the heartbeat.mjs pattern;
  never with a YES code):
  - card filed or re-offered: "Carrier packet PKT-2026-0007 v1 for Jane
    Smith (claim 12345) is ready. Review and send it from Approvals in the
    office app. No reply needed."
  - holds, once per job and reason: waiting on a numbered invoice; N meter
    readings to check; couldn't be built after 3 tries (or "something in the
    job stops it", for one failed for good); too large to email even with
    smaller photos (untick some photos on the job's packet page); packet
    storage full (once for the lane: nothing new is built until there is
    room, sent copies older than 90 days clear on their own, or raise
    `PACKET_STORAGE_MB`).

## 14. The card (Approvals)

- `apps/field/js/approvals.js`: `SPINE_KIND["packet.send"] = "packet"`;
  `KINDS.packet = {chip: "Carrier packet", approve: "Approve and send"}`;
  `packet` in `INBOX_ONLY` and `SENDS`, so `needs()` reads its outbox row and
  the card shows "Sent from Gmail" or the failure afterwards.
- `apps/admin/js/approvals.js`: `TONE.packet`; an `evidence()` branch with
  editable To (prefilled from `input.suggested_to`, "from: <source>" beside
  it) and Cc, the subject and body (read-only, the body collapsed), and the
  "Open PDF" link from `evidence_refs`. Approve posts `op_proposal_approve`
  with `p_edited_params: {to, cc}` built in this file (never through the
  field module's `decisionRequest`, so a stale cached field module cannot
  drop the To). A card whose operation starts with `packet.send@` is treated
  as a packet card even when the field module maps it to `other`.
- Approve stays disabled until the To is one valid address and the Cc holds
  only valid ones; an angle bracket anywhere in either keeps it disabled.
- Recently decided says why a card closed on its own: "Withdrawn: " and the
  gate's reason (§4); "Withdrawn: the carrier already has this version"
  (§7 step 8); "No longer needed: this packet was sent" (an earlier send of
  the same packet went out, §8 `outbox_packet_result`).
- Field build v213 (`config.js` BUILD and `sw.js` CACHE together).

## 15. Modules

| file | what |
|---|---|
| `services/worker/packet/pdfdoc.mjs` | PDF writer: pages, text, lines, rects, JPEG and PNG images (deduplicated), links, outline, /Info, /ID |
| `services/worker/packet/flow.mjs` | flow layout: cursor, page breaks, running header/footer "Page N of M", section bands, paragraphs, fields, tables split across pages, image grids, full pages |
| `services/worker/packet/model.mjs` | pure: gate, model, hashes, changed sections, email text, rationale, texts, media budget |
| `services/worker/packet/recipient.mjs` | pure: the To pick (§12) |
| `services/worker/packet/workauth.mjs` | the work authorization terms, copied from forms.js |
| `services/worker/packet/render.mjs` | `renderPacket(model, {label, mode, images, now})` → `{bytes, pages, sha256}` |
| `services/worker/storage.mjs` | Storage calls (§10) |
| `services/worker/lanes/packet.mjs` | the `packet.build` handler |
| `services/worker/rfc822.mjs`, `adapters/email.mjs` | multipart with one PDF, upload endpoint, Message-ID adopt |
| `services/worker/config.mjs`, `lanes/queue.mjs`, `server.mjs` | knobs, the kind, the channel and adapter |
| `services/worker/Dockerfile`, `/.dockerignore` | copy every field module the packet imports (photopdf, dryingwatch, meterphotos, merge, thumbs, media, fincalc, completeness and what they import); a test walks the worker's import graph and fails on any file the image would not contain |
| `supabase/migrations/0026_carrier_packet.sql` | tables, sequence, agent, grant, op, doors, executor, trigger, channel, cron |
| `apps/field/js/approvals.js`, `apps/admin/js/approvals.js` | the card |

`render` gets `label = {number, version, replaces: {version, sentAt} | null,
changed: [titles], built: Date, mode}`. The header on every page after the
cover: `PKT-2026-0007 · v1 · Claim 12345 · Jane Smith`; the footer: company,
licenses, `Page N of M`. `/Info`: Title, Subject `PKT-2026-0007 v1`,
Author, Creator, Producer, CreationDate (Alaska offset), Keywords, and custom
`PacketNumber`, `PacketVersion`, `ModelHash`. Bookmarks for every section and
part. The same model, images, label and build time give the same bytes.
Missing media prints a gray box saying "Image not available"; the card counts
them.

## 16. Deploy order (each on the owner's word)

0025 (PR #276) must be on each database before 0026: `db push` has no
`--include-all`. Merge #276 first, then this PR (merging main into it and
re-basing the census numbers). Then: DB push staging, then production (0026),
then the worker redeploy on his Mac. The office card ships with the field
build on merge and stays quiet until cards exist. No edge function deploy.
After the redeploy, the heartbeat's `kinds` must list `packet.build` and its
`channels` must list `packet` (a `QUEUE_KINDS` Fly secret would override the
default; stage a change to it, `fly secrets set --stage`, so it goes live
with the new image, or make it after the deploy: a plain set before it
restarts the old image).
