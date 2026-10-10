# Carrier packet: one numbered, versioned PDF, sent from Approvals

Operations spine phase 5. Started on the owner's "go" in the spine thread,
2026-10-10. This is the first slice of roadmap P4 Documents
(docs/architecture/03 §6, §7.6), cut to what a water job needs today.

## What the owner gets

When a water mitigation job is dry (its Certificate of Drying is signed) and
has a numbered invoice, the worker assembles **one PDF**:

1. Cover: letterhead, packet number and version, job and claim facts, a
   contents list with page numbers.
2. Certificate of Drying (the signed form, or the signed copy he uploaded).
3. Moisture maps: the sketch, the reading grid with dry cells marked, and each
   reading's meter photo.
4. Drying logs: equipment with set and pulled times (scanned rows marked), the
   psychrometric readings, and the equipment scan record.
5. Photo pages: every job photo, numbered as in the photo log.
6. The invoice (or invoices), with their attachment pages.

It appears in the office **Approvals** tab as one card: an email to the
adjuster with the PDF attached, the To address picked from the job's records
(editable on the card), and a link to open the PDF first. He taps **Approve
and send**; the worker sends it once, and the packet's row records it as sent.
If the job changes afterwards, the next run builds **version 2 with the same
number** and files a new card that says what changed. Crews see nothing new.
No AI is used anywhere: the email is a fixed template.

## What it is not (v1)

- No narrative (today's is AI-written), no work authorization, no contents
  inventory, no labor log, no moisture trend chart. Each can be added as a
  section later.
- No QuickBooks call: the invoice page is drawn from the app's invoice, the
  same one the paper packet prints.
- No Chromium. The worker draws the PDF with a hand-written writer, like
  apps/field/js/photopdf.js (JPEG passed through, Helvetica, no deps).
- No text approval ("YES n"): the card is filed without a text code, because
  he should look at the PDF before it goes to a carrier.

## Why the worker, and why not the job blob

- The worker already reads job blobs (the billing check), runs on a schedule,
  holds the service key, and delivers email exactly once. The browser builds
  only while a page is open, so it cannot be the "when dry" trigger.
- The worker has no canvas, so photos go in at their stored size. A size
  budget picks a compact layout when a job has too many photos for one email.
- Number, version and sent state live in a table (`carrier_packets`), never in
  the job blob: the blob merge lets a stale device's newer `updatedAt` win a
  whole top-level value, which would silently revert a version.
- "Version 2" is decided by a hash of the assembled document model, never by
  `updatedAt`/`rev` (the payment pull and autosaves bump those).

## When a job is in scope (the gate)

All of these, checked by `packetGate(project, {today, lookbackDays})`:

1. Not deleted, not archived (`archivedAt` empty).
2. `jobType(p) === "restoration"` and `lossTypesOf(p)` includes `water`.
3. Certified: `certDrying.sigTech` non-empty or `certDrying.uploadedPages`
   non-empty (the `isCertified` rule of dryingwatch.js).
4. At least one ready invoice: not void, not a held billing-check draft
   (`reviewGaps && !invoiceNo && !qboInvoiceId`), and numbered (`invoiceNo`,
   `qboDocNumber` or `qboInvoiceId`).
5. No unchecked meter-photo fills (`uncheckedFills(project)` empty).
6. Recent: the certificate's date (`sigTechDate`, else `issueDate`, else
   `dryComplete`) is within `PACKET_LOOKBACK_DAYS` (default 21) of today, in
   Alaska time. A job that already has a packet row skips this test, so a
   change after the window still produces version 2.

Reasons for a "no" are counted in the run's result, never filed as cards.

## Numbering and versions

- Number: `PKT-YYYY-NNNN` (roadmap §6.3 prefix PKT), one per job, allocated
  from `document_sequences(org_id, kind, year, next)` (roadmap §6.6) inside
  the reserving transaction, year in Alaska time. Never reused.
- Version: the number printed on the PDF. It increases only after a version
  was **committed** (its card approved and not undelivered). A build that
  replaces an unanswered or declined card keeps the same version label, so an
  adjuster never receives "version 2" without having received version 1.
- Each build is its own row with a per-job `seq` (1, 2, 3…). Rows are never
  updated except for their state columns.

### Row states (`carrier_packets.status`)

| status | meaning |
|---|---|
| `building` | reserved; the worker is rendering (a row older than 30 minutes is stale and is reused) |
| `failed` | rendering or upload failed (`error`); retried, at most 3 tries per model hash |
| `ready` | PDF stored, card filed (`proposal_id`) |
| `superseded` | a newer build replaced it before it was approved |
| `sent` | the outbox row for its card was sent (`sent_at`, `outbox_id`); set by trigger |
| `undelivered` | the outbox row went dead (`error`); set by trigger |

The card's own fate (proposed, declined, expired, executed, failed) lives on
its proposal; the reserve function reads both.

### What the reserve function decides (per job, under an advisory lock)

Let L be the job's latest row (highest `seq`) and H the new model hash.

| L | same hash | different hash |
|---|---|---|
| none | — | build v1 (allocate the number) |
| `building`, fresh | skip `building` | skip `building` |
| `building`, stale | reuse L as the build | reuse L as the build |
| `failed` | retry L (tries < 3) else skip `failed_cap` | build a new row |
| `ready`, card proposed and unexpired | skip `open` | build (same version) |
| `ready`, card approved / executing / executed | skip `committed` | build version + 1 |
| `ready`, card declined | skip `declined` | build (same version) |
| `ready`, card expired / superseded / failed | re-offer L (offers < 3) else skip `offer_cap` | build (same version) |
| `sent` | skip `sent` | build version + 1 |
| `undelivered` | re-offer L (offers < 3) else skip `offer_cap` | build (same version) |

"Same version" means 1 + the highest committed version (1 when none).
It refuses everything (`skip email_lane_off`) while `outbox_channel_ready('email')`
is false, so nothing renders when nothing could send.

## The operation: `packet.send@1`

- `action_type` comms, runtime sql, approval owner (the seeded comms policy).
- Input schema (`additionalProperties: false`):
  `packet_version_id` (uuid, required), `offer` (integer, required),
  `subject` (≤300, required), `body` (≤100000, required),
  `filename` (≤200, required), `to` (one bare address, optional at filing),
  `cc` (≤1000, optional).
- Idempotency template: `packet.send:{packet_version_id}:{offer}`.
- Filed by `carrier_packet_file` as `agent:documents` (new agent row, fixed
  id), `proposed_via 'agent'`, expires in 14 days, then its `sms_code` is
  cleared, so no text answers it whatever roybal-notify's filters say.
- The card's To can be typed or changed at approval: the inbox sends
  `p_edited_params {to}` (and `cc`), which op_proposal_approve validates
  against the schema.
- Executor `op_exec_packet_send`: locks the row; refuses unless the row is
  `ready`, its `proposal_id` is this proposal, it is the job's latest row, and
  the merged params carry a valid `to`; writes ONE `email` outbox row
  (`operation 'packet.send@1'`, key `'outbox:'||proposal.idempotency_key`, on
  conflict do nothing) and emits `packet.queued`.

### Outbox payload (what the worker sends)

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

The email adapter accepts attachments from the `carrier-packets` bucket only,
checks size and sha256 before sending (a mismatch is permanent), builds
`multipart/mixed`, and sends through Gmail's upload endpoint
(`POST /upload/gmail/v1/users/me/messages/send?uploadType=media`,
`Content-Type: message/rfc822`). A message without attachments is built and
sent exactly as before.

The trigger `outbox_packet_result` (AFTER UPDATE OF status ON outbox) marks the
row `sent` or `undelivered`.

## Storage

- New private bucket `carrier-packets` (application/pdf, 25 MB limit), created
  by the migration when the storage schema is present; no storage policies, so
  only the service role reads or writes it. Crew logins, which can write
  `field-media`, cannot touch a sent PDF.
- Path `<job_id>/<number>-v<version>-b<seq>.pdf`, uploaded once
  (`x-upsert: false`); the row keeps its sha256, size and page count.
- The card links the PDF through a signed URL the worker makes for the card's
  lifetime plus a day.
- A superseded build that was never committed has its PDF deleted after the
  new card is filed (`pdf_removed_at`), so unsent drafts do not pile up
  against the 1 GB Storage limit. Sent and declined PDFs stay.

## Size

- Budget `PACKET_MAX_KB` (default 9500 KB, the same 10 MB email cap
  photopdf.js uses). The estimate comes from the media markers' lengths
  (`media:<hash>:<len>`), before anything is downloaded.
- Photo pages: **full** mode = 2 photos a page at the stored copy. If the
  estimate is over budget, **compact** mode = 4 a page, each photo at its
  smaller stored copy (an archived photo's 480 px `src`, else `thumb_<hash>`,
  else the full copy). If compact is still over the hard limit (20 MB) the
  build fails with a clear error and no card.
- In compact mode, and whenever the job's photo share link is live, the email
  carries that link for full-size photos.

## The PDF

Letter, 0.5 in margins, the print.css look (navy #0f1b2d, orange #f26a21,
section heads as navy bands with an orange bar, tables with navy headers).

- Every page after the cover: running header "Packet PKT-2026-0007 · v1 ·
  Claim 12345 · Customer" and footer "Roybal Construction, LLC · licenses ·
  Page N of M".
- Bookmarks (PDF outline) for each section; `/Info` carries Title, Subject
  (`PKT-2026-0007 v1`), Creator, Producer, CreationDate and the model hash.
- Deterministic: the same model, media and build time give the same bytes.
- Missing media (an object not in storage) prints a gray box saying so, and
  the card's rationale counts them.
- Signatures (PNG with alpha) are flattened onto white and embedded with
  FlateDecode; JPEGs pass through; other formats print the gray box.

## The email (template, no AI)

Subject: `Claim 12345 - Jane Smith - water mitigation documentation (PKT-2026-0007 v1)`

Body: greeting; one line saying what is attached; insured, property, claim,
carrier, date of loss; the contents as bullets with counts (certificate signed
date and signer, maps / readings / meter photos, logs / equipment, photos,
each invoice number and total); for version 2+, "This version replaces
version N sent <date>. What changed: <sections>."; the photo link when live;
a request to confirm receipt; the signature block from `COMPANY`.

## Recipient

Same rules as the owner's adjuster email panel (adjustersend.js `prefillTo`):
the newest inbound email filed to the job that matched on the claim number,
else the newest inbound email that is not the customer's, else the first
address in the job's Adjuster field, else none (he types it on the card). The
card says where the address came from.

## The lane

Queue kind `packet.build`, enqueued hourly by pg_cron (`carrier-packet-hourly`,
minute 25), key `packet.build:<Alaska date and hour>`; a run more than two
hours old answers `{skipped:"stale"}`. Kill switch: worker env
`CARRIER_PACKET=off`. Per run: read candidate jobs (certified recently, or with
a packet row), and for each: gate, model, hash, reserve, then build (render,
upload, sign, file) or re-offer (sign, file). One job's failure never stops
the others. The result counts jobs seen, in scope, built, re-offered, skipped
by reason, and failures (job ids only, no customer data).

## Modules

| file | what |
|---|---|
| `services/worker/packet/pdfdoc.mjs` | low-level PDF writer: pages, text, lines, rects, JPEG and PNG images (deduplicated), links, outline, /Info |
| `services/worker/packet/flow.mjs` | flow layout on top: cursor, page breaks, running header/footer with "Page N of M", section heads, paragraphs, key-value grids, tables that split across pages, image grids, full-page images |
| `services/worker/packet/model.mjs` | pure: gate, document model from a job blob, hashes, changed sections, recipient, email text, rationale, media list, size estimate |
| `services/worker/packet/render.mjs` | model + images → PDF bytes |
| `services/worker/storage.mjs` | service-role Storage calls: download media text, upload, sign, remove, binary download |
| `services/worker/lanes/packet.mjs` | the `packet.build` handler |
| `services/worker/rfc822.mjs`, `adapters/email.mjs` | attachments |
| `supabase/migrations/0026_carrier_packet.sql` | tables, op, doors, trigger, cron, bucket, agent, grant |
| `apps/field/js/approvals.js`, `apps/admin/js/approvals.js` | the card |

## Deploy order (each on the owner's word)

0025 (PR #276) must be on each database before 0026: `db push` has no
`--include-all`. Then: DB push staging, then production (0026), then the
worker redeploy on his Mac. The office card ships with the field build on
merge. No edge function deploy is needed.
