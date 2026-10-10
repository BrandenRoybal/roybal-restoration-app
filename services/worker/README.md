# Roybal worker — the operations spine's hands (Fly app `roybal-worker`)

The always-on Node process that turns an approved proposal into a sent text,
an email or a QuickBooks change, and runs the nightly billing check, the
nightly QuickBooks match and the hourly carrier packet. The spine (migrations
0013–0017) decides *what* may happen and records that it did; this process is
the only thing that *does* it. It is its own Fly app, never co-hosted with the
phone agent: a stalled send must never touch a live call, and the dead-worker
alarm assumes this app is the only writer of `worker_heartbeats`.

```
owner approves (admin app / YES by text)
  → op_proposal_approve → executor writes outbox rows (email.send, sms.send, receipts.qbo_link, packet.send)
                        → or enqueues a jobs_queue row (worker-runtime ops; none yet)
pg_cron 14:45 UTC → enqueues a billing.reconcile row (the nightly billing check, below)
pg_cron 14:50 UTC → enqueues a receipts.qbo_match row (the nightly QuickBooks match, below)
pg_cron :25 every hour → enqueues a packet.build row (the carrier packet, below)
                                      ↓ polled every 5 s
THIS WORKER (Fly, one machine)
  outbox lane   outbox_claim → Twilio via roybal-notify | Gmail API (email, packet) | qbo-proxy → outbox_sent / outbox_failed
  queue lane    claim_job → op_execute | billing check | QuickBooks match | carrier packet → finish_job
  heartbeat     worker_heartbeat every 30 s; dead-letter text to the owner
                                      ↓
pg_cron (in the database, every 5 min)   worker_liveness_check: 10 min of silence
  → roybal-webhooks /alert → text to the owner, once per 24 h
```

## Exactly once

A customer is never texted twice and never silently not texted. That is a
database property, not a promise this process makes:

1. **One holder.** `outbox_claim` / `claim_job` lease a row with
   `FOR UPDATE SKIP LOCKED` and stamp `locked_by` + `lease_until` as columns,
   so the lease outlives the transaction and a second process cannot take it.
2. **Only the holder settles.** `outbox_sent`, `outbox_failed`, `finish_job`
   refuse any other worker id (`object_not_in_prerequisite_state`).
3. **A dead holder's lease expires into a retry**, never a loss:
   `sweep_leases()` runs from pg_cron every minute. The heartbeat renews only
   the leases this process is working at that instant (`p_active_jobs`,
   `p_active_outbox`), never every row stamped with its worker id: a crashed
   predecessor on the same machine, a batch cut short by a deploy, or a row
   whose settle call failed all expire on their own and get retried. The last
   heartbeat before exit renews nothing.
4. **Every attempt adopts before it sends.** Every send is tagged
   `outbox:<outbox id>` in the provider log the lane already writes
   (`sms_messages.sent_by` via roybal-notify's `captured_by`;
   `email_messages.sent_by`). The adapter looks the tag up first — on attempt 1
   too, so a dead row the owner revives is checked — and, when an earlier
   attempt got as far as the provider accepting it, reports that send instead
   of making another. For texts, "accepted" means a Twilio SID on the row:
   roybal-notify writes the row as `pending` before it calls Twilio, so a
   pending row with no SID proves nothing and the text is sent. Campaign
   texts are the one kind the worker refuses (dead on attempt 1, with the
   reason on the row): roybal-notify's own campaign dedupe counts a pending
   row as sent, so a half-sent campaign row would die here unsent. Campaigns
   go out from the campaigns page until that loop is lifted into the spine.
5. **A spent row is dead**, and the owner hears about it (below).

Two narrow windows remain, both on the duplicate side, never the lost side:
between Gmail accepting a message and the `email_messages` row landing, and
between Twilio accepting a text and roybal-notify writing the SID. Both are a
few milliseconds inside one request.

## What it sends, and through what

- **Texts** go through the `roybal-notify` edge function (`action: sendSms`)
  under the service role key — the monthly cap and reserve floor, the
  `sms_messages` log and the Twilio status callback. `sms.send` rows are
  already scheduled into the quiet-hours window by the executor; a failed one
  is rescheduled into it again. Quiet hours therefore exist in two places
  that must agree: `role_permissions` (the database's window) and the
  `SMS_QUIET_START` / `SMS_QUIET_END` function secrets (roybal-notify's).
  roybal-notify answers HTTP 400 for every refusal, its own transient
  database errors included, so the worker treats only the explicitly
  permanent messages (bad number, not a mobile, opted out, empty text) as
  final; everything else retries.
- **Emails** go straight to the Gmail API as the connected office account
  (`gmail_tokens`, newest row), the same send `gmail-proxy` makes. The proxy
  itself cannot be called from here (it takes a signed-in office user), so
  the worker holds the OAuth client (`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`)
  and refreshes the stored token itself, writing it back so the proxy and the
  worker share one connection. Cc is supported; a reply carries In-Reply-To.
  The sent copy lands in `email_messages` under the outbox row's job
  (`job_id`), as gmail-proxy files its sends, so it shows in the job's
  email history.
- **A late email is not sent.** An email row older than
  `EMAIL_MAX_AGE_HOURS` (default 48, from when it was queued, i.e. approved)
  when it is about to go out is marked `dead` instead, with the reason on
  the row ("this email waited 3 days in line, past the 48-hour limit …, so
  it was not sent"), and the dead-letter text counts it. That is what keeps
  an overdue-invoice reminder approved while the email lane was off from
  reaching the customer days later, maybe after they paid. The adopt check
  runs first, so an old row an earlier attempt did send is still recorded
  as sent, never refused.
- **QuickBooks changes** (`qbo` rows: one per receipt of an approved
  `receipts.qbo_link` card) go through the `qbo-proxy` edge function's
  `completePurchase` action under the service role key (`adapters/qbo.mjs`),
  the way texts go through roybal-notify. qbo-proxy stays the only holder of
  the QuickBooks token (it refreshes and rotates it; a second refresher here
  would race it) and the only code that knows Intuit's rules: it tags every
  line of the expense to the job's project, attaches the receipt photo from
  field-media, or enters a store invoice first. There is no adopt lookup in
  the worker: completePurchase adopts its own earlier work (a tag already
  equal to the job's project, an attachment whose name carries
  `[r:<receipt id>]`, an entry with the same DocNumber), so a retry finishes
  what a dead attempt started and never doubles it. qbo-proxy answers HTTP
  409 when retrying cannot help (tagged to another job, changed in
  QuickBooks since the card was filed, the photo gone, Intuit refused the
  write, the job relinked to another project since the approval): the row
  is dead at once, and the receipt shows the reason (the error starts with
  the code, `tagged_other: …`). The photo is read and checked before
  anything is written, so a photo that cannot go refuses the whole change;
  an upload QuickBooks refuses after the tag or the store entry went in
  answers ok with `attach_error`, the row is sent (provider status
  `attach_error=<code>`), and the receipt reads "Tagged in QuickBooks; photo
  not attached". Everything else, QuickBooks down or throttling, a stale
  SyncToken, the function unreachable, retries.
  The provider id `Purchase:<id>:<SyncToken>` is what the 0023 trigger reads
  back into the receipt's row. Served only while `qbo` is in
  `OUTBOX_CHANNELS` (the default); `RECEIPTS_QBO=off` takes it out.
- **Carrier packets** (`packet` rows: one per approved `packet.send` card)
  are an email with one PDF attached, sent by the email adapter in packet
  mode over the same Gmail connection. They are a channel of their own, not
  `email`, so a worker that does not know packets (it claims by channel)
  never takes one and sends the email without the PDF; plain `email` rows
  are built and sent exactly as before. Served only while email is on and
  `CARRIER_PACKET` is not `off` (the carrier packet, below).
- **`portal` outbox rows are not touched** (no adapter yet); they wait as
  `pending` until a later phase.
- **Queue kinds**: `proposal.execute` (runs `op_execute` as the approver; a
  proposal whose executor fails is recorded on the proposal, and the job is
  done with that outcome), `billing.reconcile` (the nightly billing check,
  below), `receipts.qbo_match` (the nightly QuickBooks match, below) and
  `packet.build` (the hourly carrier packet, below; loaded on its first run,
  so a file missing from the image fails that kind only, never the boot).
  Only the kinds in `QUEUE_KINDS` are claimed; a row of any other
  kind waits as `queued` until a worker that knows it is deployed. A kind
  that is listed but has no handler is dead on arrival.

Retry policy for a failed send: `now() + 2^attempts` minutes, capped at an
hour, 6 attempts by default (`outbox.max_attempts`) — about an hour of
trying. A permanent refusal (bad number, bad address) is dead at once.

## The nightly billing check (`billing.reconcile`, migration 0021)

Every morning it compares what each water job DOCUMENTS (drying-log
equipment rows, QuickBooks Time hours inside the mitigation window, the
Cat 3 package) with what its invoices BILL, and files what is missing as ONE
`invoice.review_gaps` card per job in the Approvals inbox, for the owner
only. Approving a card adds those lines to the job as a new draft
supplement invoice; that write happens in the database
(`op_exec_invoice_review_gaps`, runtime `sql`), never here. This lane only
reads and files.

```
pg_cron 14:45 UTC (05:45 AKST / 06:45 AKDT), billing-reconcile-nightly
  → enqueue('billing.reconcile', {run_date: <Alaska date>}, key billing.reconcile:<date>, priority -10, agent:billing)
THIS WORKER  lanes/billing.mjs
  coordination_jobs   board stage of each linked field job (data.fieldJobId)
  field_projects      scope keys for every job, paged by id; then each candidate's detector keys
  time_entries        the job's QuickBooks Time rows by jobcode: id, date, hours, qbTimesheetId, updated_at, source
  detector            apps/field/js/reconcile.js (pure; copied into the image, with scans.js for scanned equipment)
  → billing_review_gaps_file(job, rev read, input | null, rationale, evidence)
       stamps the invoice fingerprint, files as agent:billing, supersedes the job's older open card
```

- **Scanned equipment.** A unit scanned on site (the field app's 📷 Scan
  equipment, migration 0022) is an event in the job's `equipmentScans`, and
  its drying-log row is derived from the events. The detector derives the
  rows again (`apps/field/js/scans.js` `applyScans`, on a copy) before
  counting, so a row a newer copy of the log dropped still counts and an
  undone scan does not. A scanned row's evidence id is
  `<log id>#scan:<scan id>`, stable however the rows move; typed rows keep
  `<log id>#eq<index>`. The per-job read projects `equipmentScans` (and
  `deletedIds`, so a deleted scan's row goes as it does on a phone) for this.
- **Payloads.** Nightly: `{"run_date": "YYYY-MM-DD"}` (the Alaska date).
  Manual: `{"job_ids": ["<field job id>", …]}`, 1 to 100 ids. Anything else
  is dead on arrival with the reason.
- **Which jobs.** Nightly: not deleted, a restoration job with water among its
  loss types, not archived, at least one invoice that is neither void nor a
  contract, not every non-void invoice paid, and, when a board tile links it, a board
  stage of In Progress, On Hold, Final / Punch or Complete (a job no tile
  links goes on its field evidence alone). A manual run takes the jobs it
  names whether archived, paid or at any stage, but still only a restoration
  water job with an invoice.
- **Per job.** Lines → a new card (`filed`). When the same findings against
  the same invoice lines were filed before (a status change, such as the
  QuickBooks payment pull marking one paid, is not a change; voiding one
  is), a card that expired or was superseded
  with nobody answering it is offered again as a new card (`filed`, at most
  50 offers); one still open, declined, failed or executed stands
  (`unchanged`: a declined card stays declined until something changes), and
  the job's other open cards are superseded with reason `findings_changed`
  (counted in `superseded`). No lines → the job's open card, if any, is
  superseded with reason `no_gaps`; a job with only hints (days with
  equipment on and no reading,
  photos showing equipment no row logs, …) files nothing and is listed in
  `hints_only`. A job saved on a phone between the read and the filing
  (`rev_moved`) is read again once. Hours rows reach the detector as the six
  fields above: never an employee's name, a note or a QB user id.
- **The summary** is the job's result, in the `job.done` event:
  `{run_date, jobs_seen, in_scope, filed, unchanged, superseded,
  skipped: {reason: count}, hints_only: [≤50 job ids], errors: [≤20 {job_id, message}]}`.
  `skipped` counts every job that filed nothing, by reason: `not_restoration`,
  `not_water`, `archived`, `no_invoice`, `contract`, `paid`, `stage`,
  `deleted`, `missing`, `rev_moved` (moved twice), `no_gaps`, `hints_only`.
  One job's error (a 42501 when agent:billing's propose grant is missing or
  revoked, a failed read) is recorded in `errors` and the run goes on; a read
  that fails before any job is reached fails the run, and the queue retries
  it (a second filing of the same findings is a no-op). The last runs:
  `select at, data -> 'result' as summary from public.events where kind = 'job.done' and operation = 'billing.reconcile' order by at desc limit 5`.
  `fly logs` shows one `billing.run` line per run (counts only), a
  `billing.filed` per card and a `billing.job_failed` per error.
- **A missed night is not caught up.** A `run_date` older than yesterday in
  Alaska (the worker was down two days) finishes done with
  `{"skipped":"stale"}`; the next night covers it.
- **Run it now** (Supabase SQL editor). One job, or a few: find the id with
  `select id, data ->> 'customer' from public.field_projects where not deleted and data ->> 'customer' ilike '%<customer name>%'`, then
  ```sql
  select public.enqueue('billing.reconcile', '{"job_ids":["<field job id>"]}'::jsonb,
    'billing.reconcile:manual:' || gen_random_uuid(), now(), -10, 'agent',
    '193d7dd0-74f9-407d-9891-8cb7aab22f82'::uuid);
  ```
  The whole nightly pass, now (a fresh key, so it does not collide with
  tonight's row):
  ```sql
  select public.enqueue('billing.reconcile',
    jsonb_build_object('run_date', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')),
    'billing.reconcile:rerun:' || gen_random_uuid(), now(), -10, 'agent',
    '193d7dd0-74f9-407d-9891-8cb7aab22f82'::uuid);
  ```
  The worker picks it up within one poll (5 s) and the summary lands as
  above.
- **Kill switch**: `fly secrets set -a roybal-worker BILLING_RECONCILE=off`
  (Fly restarts the worker with it). The nightly row is still claimed and
  finishes done with `{"skipped":"off"}`; nothing is read or filed. Undo:
  `fly secrets unset -a roybal-worker BILLING_RECONCILE`.
- **Rollback.** Steps 1 and 2 each stop new cards on their own; 3 and 4 deal
  with the cards already filed:
  1. the kill switch above;
  2. stop the schedule: `select cron.unschedule('billing-reconcile-nightly')`
     (to schedule it again, run the `cron.schedule` statement in migration
     0021, section 7);
  3. open cards: decline them in the inbox, or let them expire (14 days).
     Nothing reaches a job until the owner approves a card;
  4. optional: `update public.operation_catalog set deprecated_at = now() where name = 'invoice.review_gaps' and version = 1`
     (open cards can then only be declined; do 1 or 2 first, or every run
     records each job with gaps as an error, "no live operation").
  Taking `billing.reconcile` out of `QUEUE_KINDS` is NOT a rollback: the
  nightly rows would wait `queued` forever.
- **Deploy order**: the database first, then roybal-notify, then the
  worker.
  1. Migration 0021 (the usual words in the thread: "staging", then
     "production"). It adds the catalog row, the filing door, the executor,
     agent:billing's propose grant and the nightly cron row.
  2. roybal-notify ("deploy roybal-notify" in the project, or the **Function
     deploy** workflow; staging, then production), BEFORE the worker. The
     build before this one reads every live proposal that has a number, so
     until this one is live a text "YES n" (and its own "Reply YES n"
     answer to a bare YES) can approve an invoice-gaps card, which is meant
     for the inbox only. No card exists before the new worker runs, so
     deploying the function here is enough. Check: the **Function deploy**
     run for roybal-notify to production, from main with this change in it,
     finished green (its log lists the new version) before you deploy the
     worker. `GET …/roybal-notify/version` answers the same with or without
     this build, so it can't tell you.
  3. The worker, on the Mac, from an up-to-date main (the image now carries
     the five field modules the check imports, so build from the repo root as
     always):
     ```sh
     cd ~/roybal-restoration-app
     git checkout main && git pull
     fly secrets list -a roybal-worker   # a QUEUE_KINDS here overrides the new default: fly secrets unset -a roybal-worker QUEUE_KINDS
     fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
     ```
     (or the **Fly deploy** workflow from main, once `FLY_API_TOKEN` is set).
     Check: `fly logs -a roybal-worker` shows `worker.start` with
     `billing.reconcile` among its `"kinds"`, as does `/healthz`.
  Until the worker is deployed, the nightly rows wait `queued` (the old
  worker does not claim the kind), so no card is filed before roybal-notify
  (step 2) is live; the new worker runs yesterday's and today's, and
  finishes older ones `{"skipped":"stale"}`. To see a first
  result without waiting for the morning, enqueue a manual run (above).

## The nightly QuickBooks match (`receipts.qbo_match`, migration 0023)

Every morning it finds each job receipt's expense in QuickBooks and files,
per job, ONE `receipts.qbo_link` card in the Approvals inbox listing the
expenses that need the job's tag, the receipt photo, or both. Approving the
card queues one `qbo` outbox row per receipt, and the outbox lane delivers
each through qbo-proxy (above). This lane only reads and files; it never
writes QuickBooks.

```
pg_cron 14:50 UTC (05:50 AKST / 06:50 AKDT), receipts-qbo-match-nightly
  → enqueue('receipts.qbo_match', {run_date: <Alaska date>}, key receipts.qbo_match:<date>, priority -10, agent:integrations)
THIS WORKER  lanes/receipts.mjs, matching in lanes/qbomatch.mjs (pure)
  job_receipts        every live receipt, the ten columns the matcher reads, paged by (job_id, id)
  receipt_qbo_links   where each receipt stands; job_qbo_links: each job's QuickBooks project
  field_projects      title, address, customer, qbJobcodeName and deleted of the jobs with receipts
  app_settings        receipts.qbo_store_accounts (store entry, below; unset = off)
  qbo-proxy           listProjects; listPurchases from 14 days before the oldest receipt to today
  → receipt_qbo_links_note(job ids, rows)                         in_qbo / unmatched / conflict, one call
  → receipts_qbo_link_file(job, input | null, rationale, evidence) per job: its card, or none
```

- **Payloads.** Nightly: `{"run_date": "YYYY-MM-DD"}` (the Alaska date).
  Manual: `{"job_ids": ["<field job id>", …]}`, 1 to 100 ids. Anything else
  is dead on arrival with the reason. A manual run still matches every
  receipt, so an expense goes to the same receipt a full run would give it,
  but writes rows and cards for the jobs it names only.
- **What a match is.** QuickBooks is the books: a wrong tag moves a cost to
  someone else's job, so a match is conservative. The same cents; the
  receipt's sign (a return matches only a credit); a QuickBooks date from a
  day before the receipt to three days after (up to 14 days either side for
  the same store's expense whose DocNumber carries the receipt number: the
  bookkeeper dates a store invoice by the invoice); and a score of at least 2:
  +3 the receipt number in the DocNumber (Sherwin's `8066-9` is DocNumber
  `80669163000926`), +2 the same store (the vendor's name, or the memo a
  bank rule writes), +1 the same day, +1 the card's last four in the payment
  account's name. An expense that says it is not the receipt's is never a
  candidate: another known store, another card (a card account whose name
  carries a different number), a payment (every line on the clearing
  account 1150040008), or, for a receipt charged to a store account, money
  paid from the bank, unless the expense carries the receipt number or the
  bank account the receipt names (the slip reader marks any invoice with no
  card on it "account", debit and ACH payments included). A return slip's
  id is `<receipt id>~ret`. The surest receipt chooses first, one expense goes to
  one receipt, and two equally good expenses are left to a person. Receipts
  dated in the last 60 days are matched; an older one keeps the row it had.
- **What each receipt gets.** A line on its job's card when the expense needs
  `tag`, `attach` or both (a tag already set is never changed), or a row in
  `receipt_qbo_links`:
  - `in_qbo`: tagged to the job, and a document attached or no photo to add
    (a receipt with no photo yet). Nothing to do.
  - `unmatched`, `detail.reason`: `waiting_feed` (a card charge two weeks old
    or less; the bank feed lags, up to 11 days on the US Bank card), `store_not_entered` (a receipt on a store
    account, Spenard or Sherwin, whose invoice is not in QuickBooks yet; they
    are entered by hand about nine days late), `bill_not_checked` (a dump
    ticket: the office books those as Bills, which the match does not read),
    `needs_job_link` (found, but the job has no QuickBooks project; nothing
    goes on the card, not even the photo, until the job is linked, because
    an approved attach would leave the receipt done and its tag never
    offered), `not_found`.
  - `conflict`, `detail.reason`: `ambiguous` (the expenses in
    `detail.candidates`), `tagged_other` (tagged to another customer,
    `detail.qbo_customer_name`), `partly_tagged`.
  Receipts the approval path holds (`queued`, `done`, `failed`) are not
  looked at again; re-filing a failed one is not in v1.
- **The job's project.** A job in `job_qbo_links` tags to its project. A job
  with none gets a suggestion on its card, and approving the card links it:
  `suggested_tagged` when tonight's matched expenses for the job are all
  tagged to one customer and it is an active project (never a parent
  customer or a sub-customer that is not a project; store invoices are
  tagged as they are entered), unless the job's QuickBooks Time jobcode names
  another project (then nothing is suggested); else `suggested_qbtime` when
  the jobcode has exactly one project's name.
- **The door, per job.** Items → a new card (`filed`; the job's older open
  card is superseded). The same items on the same receipts as a card still
  open, or one already answered, stand (`unchanged`); one whose approval
  failed a filing-time check (the receipts changed, a receipt left the job,
  the job lost or changed its link) is offered again once they are back as
  filed. Each item carries the receipt's amount, date and `read_photo_ref`
  as the run read them, and a receipt edited since (a photo retaken, a
  total corrected) is not filed (`receipts_moved`); the next night files it
  fresh. No items → the job's open card, if any, is superseded (`empty`). A
  job the run did not reach keeps its card, which expires in 14 days, and an
  approval of a card whose receipts changed is refused with nothing written.
- **The summary** is the job's result, in the `job.done` event:
  `{run_date, receipts, matched, in_qbo, unmatched, conflicts, cards_filed,
  skipped: {reason: count}, errors: [≤20 {job_id, message}]}`. `skipped`
  counts `queued`, `done` and `failed` (receipts the approval path holds),
  then each door answer that filed nothing: `unchanged`, `empty`,
  `qbo_lane_off` (no worker serves the `qbo` channel), `receipts_moved` (a
  receipt left the job or was edited since the run read it),
  `job_missing`, `job_deleted`. One job's error (a 42501 when
  agent:integrations' propose grant is revoked) is recorded in `errors` and
  the run goes on; a read, a qbo-proxy answer or the note write that fails
  fails the run, and the queue retries it (both doors are idempotent). A
  qbo-proxy that answers 404 (a build without these actions) ends the run
  `{"skipped":"qbo_proxy_not_updated"}` before anything is written. The last
  runs:
  `select at, data -> 'result' as summary from public.events where kind = 'job.done' and operation = 'receipts.qbo_match' order by at desc limit 5`.
  `fly logs` shows one `receipts.run` line per run (counts only), a
  `receipts.filed` per card and a `receipts.job_failed` per error.
- **A missed night is not caught up**: a `run_date` older than yesterday in
  Alaska finishes done with `{"skipped":"stale"}`.
- **Run it now** (Supabase SQL editor). One job, or a few:
  ```sql
  select public.enqueue('receipts.qbo_match', '{"job_ids":["<field job id>"]}'::jsonb,
    'receipts.qbo_match:manual:' || gen_random_uuid(), now(), -10, 'agent',
    '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10'::uuid);
  ```
  The whole nightly pass, now:
  ```sql
  select public.enqueue('receipts.qbo_match',
    jsonb_build_object('run_date', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD')),
    'receipts.qbo_match:rerun:' || gen_random_uuid(), now(), -10, 'agent',
    '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10'::uuid);
  ```
- **Store entry is built and OFF.** With `app_settings`
  `receipts.qbo_store_accounts` set, an unentered store-account receipt on a
  job with a project becomes a `create` line instead of `store_not_entered`:
  approving it enters the invoice as an expense (DocNumber = the receipt
  number's digits, at least 5 of them: qbo-proxy finds the bookkeeper's own
  entry by that prefix, so a shorter number stays `store_not_entered`) and
  attaches the photo. qbo-proxy looks for the
  bookkeeper's own entry of the same invoice first and adopts it, so it never
  doubles one; `min_age_days` gives the bookkeeper that many days first.
  Equipment receipts book to expense account 1150040005 instead of the
  store's; dump tickets are never entered (FNSB bills them). Turn it on only on the owner's word:
  ```sql
  insert into public.app_settings (key, value) values ('receipts.qbo_store_accounts',
    '{"spenard": {"account_id":"53","vendor_id":"65","doc":"exact","expense_account_id":"42","class_id":"1000000001","min_age_days":0},
      "sherwin": {"account_id":"52","vendor_id":"9","doc":"prefix","expense_account_id":"42","class_id":"1000000001","min_age_days":0}}'::jsonb)
  on conflict (key) do update set value = excluded.value;
  ```
  Off again: `delete from public.app_settings where key = 'receipts.qbo_store_accounts'`.
  A store entry with an id that is not digits is ignored (that store stays off).
- **Kill switch**: `fly secrets set -a roybal-worker RECEIPTS_QBO=off` (Fly
  restarts the worker with it). The nightly row finishes done with
  `{"skipped":"off"}` and nothing is read or filed, and the worker stops
  serving the `qbo` channel, so an approved change waits as `pending` and is
  not sent. Undo: `fly secrets unset -a roybal-worker RECEIPTS_QBO`.
- **Rollback.** Steps 1 and 2 each stop new cards on their own:
  1. the kill switch above;
  2. stop the schedule: `select cron.unschedule('receipts-qbo-match-nightly')`
     (to schedule it again, run the `cron.schedule` statement in migration
     0023, section 13);
  3. stop filing for good: `update public.agent_authority set revoked_at = now() where agent_id = '5d0c1f3e-8a2b-4c7d-9e61-2f4a8b3c7d10' and operation = 'receipts.qbo_link' and revoked_at is null`
     (do 1 or 2 as well, or every run records each job as a 42501 error);
  4. open cards: decline them in the inbox, or let them expire (14 days);
  5. an approved change nobody should send: mark its outbox row dead
     (`update public.outbox set status = 'dead' where id = …`; the receipt then
     shows failed). A tag or photo already written stays in QuickBooks, where
     the office edits it like any other.
  Taking `receipts.qbo_match` out of `QUEUE_KINDS` is NOT a rollback: the
  nightly rows would wait `queued` forever.
- **Deploy order**: the database, then qbo-proxy, then roybal-notify, then
  the worker.
  1. Migration 0023 ("staging", then "production"): the two tables, the
     doors, the executor, agent:integrations and its propose grant, the
     nightly cron row and `qbo_service_ping`.
     0022 (equipment scan, PR #271) goes to each database first: the DB
     push has no `--include-all`, so a database holding 0023 refuses a
     later 0022.
  2. qbo-proxy ("deploy qbo-proxy", or the **Function deploy** workflow):
     the service-only actions this worker calls (`listProjects`,
     `listPurchases`, `completePurchase`). It proves the worker's key through
     `qbo_service_ping`, so it goes after 0023. Until it is live a run ends
     `qbo_proxy_not_updated` and writes nothing.
  3. roybal-notify ("deploy roybal-notify"): this build keeps
     `receipts.qbo_link` cards out of "YES n" text approvals, so they are
     approved in the inbox only. It must be live before the worker files the
     first card.
  4. The worker, as in the billing check's step 3. `fly secrets list -a roybal-worker`
     first: a `QUEUE_KINDS` set on the app replaces the default and must add
     `receipts.qbo_match`
     (`fly secrets set -a roybal-worker QUEUE_KINDS=proposal.execute,billing.reconcile,receipts.qbo_match`,
     or `fly secrets unset -a roybal-worker QUEUE_KINDS`), and an
     `OUTBOX_CHANNELS` set there must add `qbo`, or approved changes wait
     `pending` and the door answers `qbo_lane_off`. Check: `worker.start` in
     `fly logs -a roybal-worker` (and `/healthz`) shows `receipts.qbo_match`
     among the `"kinds"` and `qbo` among the `"channels"`.
  Until the worker is deployed the nightly rows wait `queued`; the new
  worker runs yesterday's and today's. To see a first result without waiting
  for the morning, enqueue a manual run (above).

## The hourly carrier packet (`packet.build`, migration 0026)

When a water job is dry (its Certificate of Drying is signed) and has a
numbered invoice, this lane draws the job's certificate, work authorization,
floor plan, moisture maps, drying logs, photos, documents and invoices into
ONE numbered PDF (`PKT-2026-0001 v1`), stores it in the private
`carrier-packets` bucket, and files ONE `packet.send` card in the Approvals
inbox: the adjuster email with that PDF attached. Approving the card queues
one `packet` outbox row, which the email adapter sends once from the
connected Gmail, and if what prints changes afterwards the next run builds
version 2 under the same number. The contract is
`docs/Carrier_Packet_Design.md`; the email, the card's Why and the texts are
fixed templates, and no AI is used anywhere.

```
pg_cron minute 25 of every hour, carrier-packet-hourly
  → enqueue('packet.build', {run_hour: <Alaska YYYY-MM-DDTHH>}, key packet.build:<Alaska hour>, priority -10, agent:documents)
THIS WORKER  lanes/packet.mjs; the document in packet/model.mjs (pure), drawn by packet/render.mjs
  carrier_packet_candidates   the jobs to look at, oldest updated_at first
  field_projects              the job blob; portal_jobs: the customer's certificate signature, when one is on its way
  packetGate → buildModel     in scope or not; then what prints, and its hash (which decides a version)
  carrier_packet_media_sizes  the size budget, full or compact photos, before anything is downloaded
  → carrier_packet_reserve(job, hash, …)          skip, offer the stored PDF again, or build
  field-media                 the images, PACKET_DOWNLOADS at a time → render → upload to carrier-packets
  email_messages, gmail_tokens  the suggested To (the connected account's address only, never a token)
  → carrier_packet_file / carrier_packet_reoffer   the card, with no text code; then the "ready" text
owner approves in the inbox → op_exec_packet_send → ONE outbox row, channel packet
THIS WORKER  outbox lane → adapters/email.mjs in packet mode → Gmail, the PDF attached
  → outbox_packet_result: the packet row becomes sent (sent_at, sent_to) or undelivered
```

- **Which jobs get a card** (`packetGate`, design §4). Checked in this
  order, and the first that fails is the reason the summary counts:
  `deleted`; `archived`; `not_water` (a restoration job with water among its
  loss types); `excluded` (Cert. of Drying or Construction Invoice unticked
  on the job's packet page); `not_certified` (no technician signature, or in
  upload mode no signed copy); `no_invoice` (no ready invoice: one that is
  not void, not a held billing-check draft, not a rebuild invoice made from
  an estimate, and has a printed number; a QuickBooks id alone is not a
  number anyone can quote); `unchecked_fills` (a meter reading the app read
  from a photo that nobody has checked); `unread_meter_photos` (a meter
  photo on an empty reading not read yet); `lookback` (a job with no packet
  row yet whose newest date is more than `PACKET_LOOKBACK_DAYS` before today
  in Alaska; the dates are the certificate's dry-complete, technician
  signature, issue and portal-signed dates, each log's dry-out finish, the
  last equipment removal, the last moisture reading row and each ready
  invoice's date, so a job invoiced weeks after drying still gets its
  packet); `settle` (edited
  less than `PACKET_SETTLE_MIN` minutes ago); `cert_sign_pending` (the
  customer's portal signature of the certificate is on its way: pending with
  a document, or approved and not yet copied back into the job, for up to 72
  hours from that approval's last change, so a customer who never signs
  cannot hold the packet forever).
- **What a "no" does.** `deleted` through `unread_meter_photos` withdraw the
  job's open card if it has one (`carrier_packet_withdraw`: the card is
  superseded and its row reads `superseded`, error `withdrawn: <reason>`),
  so a voided invoice or a cleared certificate never leaves an approvable PDF
  behind; a card the owner is approving at that moment is left alone.
  `no_invoice`, `unchecked_fills` and `unread_meter_photos` also hold the job
  (`carrier_packet_holds`) with one text per job and reason. `lookback`,
  `settle` and `cert_sign_pending` do nothing: the next hour looks again.
- **Number and version.** One number per job, `PKT-YYYY-NNNN` from
  `document_sequences` (the Alaska year), allocated with the job's first row
  and never reused. The printed version is 1 + the highest version actually
  sent, so an adjuster never gets version 2 without version 1: a build that
  replaces a card nobody answered, or one declined, keeps that card's
  version. Whether anything changed is decided by a hash of what prints
  (`modelHash`), never by `updatedAt` or `rev`: payments, balances, invoice
  status, archived photos and the passing of time never make a version 2.
  Photo numbers stay as they were across versions (`photo_nums` on the
  row). Version 2 and later say on the cover, the card and the email which
  version they replace and what changed.
- **What the reserve answers** (`carrier_packet_reserve`, under the job's
  lock). A skip, by reason: `lane_off` (no worker heartbeating the `packet`
  channel), `not_permitted` (agent:documents' `packet.send` propose grant is
  revoked, or the operation is deprecated: the owner's switches, so nothing
  is built or texted), `building` (a build of this job is under way; one still building
  after 30 minutes is failed as `abandoned`), `failed_cap` (this same
  document failed 3 times, or once for good; the job is held with the last
  error and the owner texted once, every run re-holding it so a text that
  failed goes on the next run), `in_flight` (a packet email of this job is
  pending, sending or retrying in the outbox: an approved card, or a dead row
  someone revived), `open` (its card is waiting), `declined` (the owner
  declined this same document; it stays declined until the job changes),
  `offer_cap` (the same PDF was offered four times: the first card and three
  re-offers), `too_large` (this same PDF is too large to email, or Gmail
  refused it as too large; the job keeps its too-large hold), `no_build`
  (it needs a build and the worker said there is no room or no builds left
  this run), `sent`
  (this document is what the carrier already has; a card for a change that
  was then undone is withdrawn, so a version 2 identical to version 1 is
  never offered). A re-offer: a card for the same document that
  expired, was superseded or failed, or a send that went undelivered, is
  filed again with the PDF already stored (`carrier_packet_reoffer`, up to
  three times); if that PDF is no longer in the bucket (removed by hand), it
  is built afresh instead. Anything else is a build.
- **The `packet` channel, and why it is not `email`.** A worker that does
  not know packets claims by channel, so on `email` it would take a packet
  row and send the email without the PDF; the outbox `channel` check gains
  `packet` instead. The channel is served only while email is (the Gmail
  pair is set) and `CARRIER_PACKET` is not `off`; the heartbeat reports it,
  and `outbox_channel_ready('packet')` is the first thing every reserve
  reads, so no card is filed while nothing could send it. A packet send
  checks the To and Cc and the same `EMAIL_MAX_AGE_HOURS` limit as an email,
  takes exactly one attachment from `carrier-packets`, downloads it with the
  service key (60 s) and checks its size and sha256 against the card's (a
  mismatch is dead at once), builds `multipart/mixed` with a fixed
  `Message-ID: <packet-<packet version id>@roybalconstruction.com>` (one per
  packet version, whichever outbox row carries it), and uploads it to
  Gmail's media endpoint (120 s). The adopt check is the `email_messages`
  tag, then that Message-ID in `email_messages`, then a Gmail search for it,
  so an upload that timed out after Gmail took it is never sent twice, even
  when the version is re-offered on a fresh card and approved again. Gmail's 413, or an answer saying
  the message is too large, is dead at once. The sent copy lands in
  `email_messages` under the job, so it shows in the job's email history.
- **The To is never filed.** The card carries a suggestion (`suggested_to`:
  the address the last sent version went to, else the newest inbound email
  filed to the job on its claim number, else the newest one that is not the
  customer's, else the job's Adjuster field; bounce and no-reply senders and
  the connected account are skipped). The office app sends the To and Cc the
  owner confirmed with the approval, and `op_exec_packet_send` refuses an approval
  that carries anything else ("Reload Approvals and confirm the
  recipient."), so an old cached page can never send to the suggestion
  unseen. It also refuses, with nothing sent, a deleted or archived job, a
  card that is no longer the packet's, a packet with a newer version, and a
  PDF no longer stored. Then it writes ONE outbox row, key
  `outbox:packet.send:<packet id>:<offer>`.
- **The bucket.** `carrier-packets`, private, created by the worker on first
  use (`POST /storage/v1/bucket`, a 25 MB file limit, PDFs only; a 409 means
  it is there), never in SQL, since db-replay has no storage-api. It has no
  storage policies: only the service role reads or writes it, so a crew
  login (which can write `field-media`) cannot touch a sent PDF. A PDF is
  stored at `<job id>/<number>-v<version>-b<seq>.pdf`, and the card links it
  with a signed URL good for 15 days (the card itself expires in 14). A run
  that can neither create nor find the bucket ends
  `{"skipped":"bucket_missing"}`. Every run ends with the cleanup: the PDFs
  of superseded and failed rows no outbox row points at, and of ready rows
  whose card was declined more than 14 days ago, are deleted
  (`pdf_removed_at`). A sent or undelivered PDF is never deleted.
- **Size.** Before anything is downloaded, the stored sizes give an estimate:
  every image that is not a job photo, plus 60 KB, plus every photo at full
  size. At or under `PACKET_FULL_KB` the packet is `full` (two photos a
  page); over it, `compact` (each photo's small copy where there is one,
  the archived 480 px copy or its thumbnail, four a page), and the email says full-size photos are available on
  request. A rendered PDF over `PACKET_HARD_KB` (about 23 MB once
  base64-encoded, under Gmail's ~25 MB) is failed for good as `too_large`
  and the job is held with a text; the card warns above 10 MB. The reserve
  is told whether this job may build (`p_build`): not when what the bucket
  holds plus its estimate is over `PACKET_STORAGE_MB`, nor past
  `PACKET_MAX_BUILDS`. It still answers skips and re-offers (they need no
  room), and only a job that actually needs a build with no room holds the
  whole lane (`storage_full`, one text, under the nil uuid); nothing more is
  built that run.
- **Knobs** (fly.toml `[env]` or secrets, restart to apply; a number is
  clamped to its range, and a blank or a non-number keeps the default):
  - `CARRIER_PACKET`: `off` is the kill switch (below); unset, or anything
    else, leaves the lane and the `packet` channel on.
  - `PACKET_LOOKBACK_DAYS` 14 (1 to 90): how recent a job's newest drying,
    certificate or invoice date must be for its first packet. A job that
    already has a packet row is looked at whatever its age.
  - `PACKET_SETTLE_MIN` 120 (0 to 1440): minutes a job must go unedited
    before it is built.
  - `PACKET_MAX_BUILDS` 3 (1 to 10): builds per run; re-offers do not count
    and still go out, and the rest wait for the next hour.
  - `PACKET_DOWNLOADS` 4 (1 to 8): media downloads at a time; jobs go one
    after another.
  - `PACKET_FULL_KB` 9500 (1000 to 17000, and never above `PACKET_HARD_KB`):
    the full-size photo budget.
  - `PACKET_HARD_KB` 17000 (2000 to 18000): the largest PDF the lane files.
  - `PACKET_STORAGE_MB` 300 (50 to 900): the `carrier-packets` bucket's cap.
  - `PACKET_TEXTS`: `off` stops the lane's texts and nothing else (cards are
    still filed); unset, or anything else, leaves them on.
- **The texts** go to `OWNER_CELL` through roybal-notify (`sendSms`, kind
  `brief`, as the dead-letter text does, so they are not held to quiet
  hours), never with a YES code, and no reply is read:
  - a card filed or offered again: "Carrier packet PKT-2026-0001 v1 for Jane
    Sample (claim DEMO-12345) is ready. Review and send it from Approvals in
    the office app. No reply needed."
  - a hold, once per job and reason: waiting on a numbered invoice; N meter
    readings to check on the Moisture Map; a meter photo on an empty reading
    not read yet; couldn't be built after 3 tries; too large to email even
    with smaller photos (untick some photos on the job's packet page);
  - once for the lane: packet storage full.
  Without `OWNER_CELL`, or with `PACKET_TEXTS=off`, nothing is texted. A
  text that fails is logged and its hold is not marked texted, so the next
  run tries again.
- **The summary** is the job's result, in the `job.done` event:
  `{seen, in_scope, built, reoffered, withdrawn, held, skipped: {reason: count},
  failed: [job id, …]}`, job ids only: never a name, an address, a claim
  number or an email. `skipped` counts every job that got no new card this
  run, by reason, the gate's and the reserve's above among them. One job's
  error is listed in `failed` and the run goes on; the
  job is looked at again next hour. The last runs:
  `select at, data -> 'result' as summary from public.events where kind = 'job.done' and operation = 'packet.build' order by at desc limit 5`.
  `fly logs` shows one `packet.run` line per run (counts only), a
  `packet.filed` or `packet.reoffered` per card, and `packet.withdrawn`,
  `packet.held`, `packet.too_large`, `packet.job_failed` and
  `packet.text_failed` as they happen.
- **A missed hour is not caught up**: a row claimed more than 2 hours after
  its `run_after` finishes done with `{"skipped":"stale"}`; the next hour
  covers it.
- **Run it now** (Supabase SQL editor; a fresh key, so it does not collide
  with this hour's row). A run always looks at every candidate:
  ```sql
  select public.enqueue('packet.build',
    jsonb_build_object('run_hour', to_char(now() at time zone 'America/Anchorage', 'YYYY-MM-DD"T"HH24')),
    'packet.build:manual:' || gen_random_uuid(), now(), -10, 'agent',
    'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65'::uuid);
  ```
- **A packet that is stuck.** Start from the job's rows, newest first, and
  its hold (the nil uuid is the lane's):
  ```sql
  select seq, number, version, status, error, permanent, offer, mode, pages, bytes,
         proposal_id, outbox_id, sent_at, sent_to, created_at, updated_at
    from public.carrier_packets where job_id = '<field job id>' order by seq desc;
  select job_id, reason, detail, since, texted_reason, texted_at from public.carrier_packet_holds
   where job_id in ('<field job id>', '00000000-0000-0000-0000-000000000000');
  ```
  - `building`: a run is drawing it now. Still building after 30 minutes
    (a deploy mid-build), the next reserve fails it as `abandoned`.
  - `failed`: `error` says why. `relabel` means the version moved while it
    was drawn (not a try; the next run draws it again with the right label);
    `abandoned` is above; `too_large: <size>` is for good. Three failed
    tries of the same document, or one for good, stop it (`failed_cap`) with
    a hold and a text until the job changes ("couldn't be built after 3
    tries", or "something in the job stops it" for one for good).
  - `ready`: its card is in the inbox. The card:
    `select status, expires_at, approved_at, decline_reason, error from public.proposals where id = '<proposal_id>'`.
  - `superseded`: a newer build replaced it, or the job left scope
    (`withdrawn: <reason>`).
  - `sent`: delivered, with `sent_at` and `sent_to`.
  - `undelivered`: its outbox row went dead (`error` is the provider's last
    word; the row itself:
    `select status, attempts, error from public.outbox where id = '<outbox_id>'`).
    The next run offers the same PDF on a fresh card, unless Gmail refused
    it as too large, which needs a smaller packet (untick photos on the
    job's packet page), or the stored PDF was missing or changed, which
    builds it afresh.
  A hold's `reason` is a gate reason, `failed_cap`, `too_large` or
  `storage_full`, and `texted_reason` says whether the owner has heard
  about it. A job's hold is deleted when its next build starts, and so is
  the lane's `storage_full` hold (a build means the bucket had room again),
  so the next time it fills the owner is texted again.
- **First run**: water jobs whose newest date is in the last 14 days get
  cards (at most `PACKET_MAX_BUILDS` an hour). Any the owner already sent by
  hand, he declines; a declined card stays declined until the job changes.
- **Kill switch**: `fly secrets set -a roybal-worker CARRIER_PACKET=off` (Fly
  restarts the worker with it). The hourly row finishes done with
  `{"skipped":"off"}` and nothing is read or built, and the worker stops
  serving the `packet` channel, so no card is filed and an approved packet
  waits as `pending` and is not sent (past `EMAIL_MAX_AGE_HOURS` it goes
  dead instead, as an email does). Undo:
  `fly secrets unset -a roybal-worker CARRIER_PACKET`.
- **Rollback.** Steps 1 and 2 each stop new cards on their own:
  1. the kill switch above;
  2. stop the schedule: `select cron.unschedule('carrier-packet-hourly')`
     (to schedule it again, run the `cron.schedule` statement in migration
     0026, section 15);
  3. stop filing for good: `update public.agent_authority set revoked_at = now() where agent_id = 'b7e4c2d9-6a13-4f58-9c2e-7d1a0f3b8e65' and operation = 'packet.send' and revoked_at is null`
     (from then on every reserve skips as `not_permitted`: nothing is built,
     filed or texted; restoring the grant picks the jobs up again);
  4. open cards: decline them in the inbox, or let them expire (14 days).
     Nothing reaches a carrier until the owner approves a card;
  5. optional: `update public.operation_catalog set deprecated_at = now() where name = 'packet.send' and version = 1`
     (open cards can then only be declined);
  6. an approved packet nobody should send: mark its outbox row dead
     (`update public.outbox set status = 'dead' where id = …`; the packet
     then reads `undelivered`, and the next run offers it again on a fresh
     card, which the owner can decline).
  Taking `packet.build` out of `QUEUE_KINDS` is NOT a rollback: the hourly
  rows would wait `queued` forever.
- **Deploy order** (design §16), each step on the owner's word:
  1. 0025 (PR #276) is on each database before 0026: the DB push has no
     `--include-all`, so a database holding 0026 refuses a later 0025. Merge
     #276 first, then this PR (merging main into it and re-basing the
     census numbers).
  2. Migration 0026 ("staging", then "production"): the tables, the number
     sequence, agent:documents and its propose grant, `packet.send@1` and
     its executor, the doors, the outbox trigger, the `packet` channel and
     the hourly cron row. Until the new worker runs, the hourly rows wait
     `queued` and nothing is filed.
  3. The worker, on the Mac, as in the billing check's step 3 (the image now
     carries the field modules the packet imports, so build from the repo
     root as always). `fly secrets list -a roybal-worker` first: a
     `QUEUE_KINDS` set on the app replaces the default and must add
     `packet.build`
     (`fly secrets set -a roybal-worker QUEUE_KINDS=proposal.execute,billing.reconcile,receipts.qbo_match,packet.build`,
     or `fly secrets unset -a roybal-worker QUEUE_KINDS`), and an
     `OUTBOX_CHANNELS` set there must add `packet`, or every run answers
     `lane_off` and nothing is filed.
  The office card ships with the field build (v213) on merge and stays quiet
  until cards exist. No edge function deploy.
  **Check after the redeploy**: the heartbeat's `meta.kinds` lists
  `packet.build` and its `meta.channels` lists `packet`:
  `select worker_id, at, meta -> 'kinds' as kinds, meta -> 'channels' as channels from public.worker_heartbeats order by at desc limit 1`
  (the same lists are on `worker.start` in `fly logs -a roybal-worker` and on
  `/healthz`). No `packet` there means the Gmail pair is not set,
  `CARRIER_PACKET=off`, or an `OUTBOX_CHANNELS` secret without it; no
  `packet.build` means a `QUEUE_KINDS` secret without it. Until the worker
  is deployed the hourly rows wait `queued`, and the new worker finishes
  those more than 2 hours old `{"skipped":"stale"}`. The first cards come
  with the next run at minute 25; to see one sooner, enqueue a manual run
  (above).

## Two alarms, both to the owner's cell

- **The worker is down** (no heartbeat for 10 minutes): the DATABASE notices
  — `worker_liveness_check()` on pg_cron every 5 minutes POSTs to the
  `roybal-webhooks` edge function's `/alert` with a secret the migration
  minted into the vault, and keeps posting every 15 minutes for as long as
  the worker is stale; the function re-reads `worker_heartbeats` itself,
  texts `OWNER_CELL` through roybal-notify (kind `brief`, quiet-hours exempt),
  and holds the next text for 24 h. So the text arrives within about 15
  minutes of the worker dying (a lost POST costs 15 more, not a day), and
  the process that is down has no part in sending it. The database learns
  where the edge functions live from the worker's own heartbeat
  (`app_settings.edge.base_url`), so staging and production each alert their
  own function with no setup; the text names the project.
- **Something gave up** (an outbox row or job went `dead`): the worker's
  heartbeat tick counts dead rows since the last watermark (a day before boot
  until the first text, so a restart hides nothing) and texts the owner once
  per 24 h, saying where to look: an approved email that gave up shows in
  the admin app's Approvals tab, under Recently decided, as "Couldn't send"
  with the reason, and so does a carrier packet (its row then reads
  `undelivered`, and the next hourly run offers the same PDF again on a
  fresh card). QuickBooks rows are counted apart (qbo-proxy refuses one
  for good on its first try, so it did not give up "after retries"): "N
  QuickBooks receipt changes weren't made", and the receipts card under
  Recently decided says why. Needs `OWNER_CELL` on the Fly app.

Both alarm states live in `app_settings` (`worker.liveness_alert`,
`worker.alert_texted`, `worker.deadletter_alert`), so a restart never
re-texts, and a recovery clears the liveness state (event `worker.recovered`).

## One-time setup (owner steps, after the PRs merge and 0017 is live)

Order matters: the database first, then the edge function, then the app.

1. **Database** — the usual words in the thread: "staging", then "production"
   (DB push workflow, project `djpgvcvhvgrzgaziruze`). Migration 0016 adds the
   lease columns, the functions, the vault secret and the two cron rows; 0017
   scopes the heartbeat's lease renewal and the alarm's re-post.
2. **Edge function** — "deploy roybal-webhooks" (Function deploy workflow,
   production). It uses secrets that already exist (`OWNER_CELL`, the
   service role key). Check: `https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-webhooks/healthz`
   answers `{"ok":true}`.
3. **Fly app** — inside the repo checkout on the Mac (`fly deploy` finds
   `services/worker/fly.toml` nowhere else), on an up-to-date main (the deploy
   builds from this copy; one older than 0017 fails every heartbeat). Swap in
   the real values for `PASTE_HERE` and the X's; type no `< >`:
   ```sh
   cd ~/roybal-restoration-app
   git checkout main && git pull
   fly apps create roybal-worker   # once; "Name has already been taken" means it is done
   fly secrets set -a roybal-worker \
     SUPABASE_URL="https://djpgvcvhvgrzgaziruze.supabase.co" \
     SUPABASE_SERVICE_ROLE_KEY="sb_secret_PASTE_HERE" \
     OWNER_CELL="+1907XXXXXXX"
   fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
   ```
   Email (optional, see the Gmail pair below) comes last, after migration
   0019 is applied and roybal-notify is deployed on the step-5 build, and
   is one more command:
   `cd ~/roybal-restoration-app && git checkout main && git pull && sh services/worker/set-gmail-secret.sh`.
   It deploys again as its last step.
   A value left as a placeholder (`< >`, quotes, spaces, `PASTE_`) stops the
   worker at boot with the variable's name in `fly logs`; fix it with
   `fly secrets set` (or `fly secrets unset` for an optional one) and it
   restarts on its own.
   - **The service key**: Supabase Dashboard → Project Settings → API Keys →
     the **Publishable and secret keys** tab → the **Secret keys** section →
     copy (or create) one; it begins `sb_secret_`. NOT the *publishable* key
     above it (`sb_publishable_`) and NOT the *Legacy* tab's `service_role`
     JWT (begins `eyJ`): either would boot and then fail every call, so the
     worker refuses both at boot.
   - **The Gmail pair** is the OAuth client the office Gmail connection was
     made with. Setting it is the last step of turning email on, in this
     order: migration 0019 applied (production), roybal-notify deployed on
     the step-5 build ("deploy roybal-notify" in the project), then
     `sh services/worker/set-gmail-secret.sh` from the repo root of an
     up-to-date main. Email on is what makes the morning brief file its
     reminders on the spine and text "Reply YES n" for them; a roybal-notify
     from before step 5 reads only the text lane's asks, so it would answer
     that YES "doesn't match" and a bare YES would run whatever text-lane ask
     is live instead. So the script first asks the deployed roybal-notify
     (`GET …/functions/v1/roybal-notify/version`, no key, at the
     `SUPABASE_URL` in `apps/field/js/config.js`) and refuses, saying to
     deploy roybal-notify first, unless it answers HTTP 200 with `"spine"`
     in its `answers` (the build before step 5 answers 405). It refuses to
     run from anything the deploy must not build: not the repo root, not on
     main, not GitHub's latest main (it runs `git fetch origin main` and
     compares: an older checkout would roll back a worker fix deployed from
     GitHub since), local changes in `services/worker`, the
     `apps/field/js` modules the image copies or `.dockerignore` (untracked
     files too: the image would take them), or a worker without
     the 48-hour email limit (`staleEmailReason`). Each time it says to run
     `cd ~/roybal-restoration-app && git checkout main && git pull` first,
     because its last step deploys this checkout. It reads the Client ID
     from `apps/field/js/config.js` (`GMAIL_CLIENT_ID`, public, the same
     client), asks for the client secret with echo off, refuses an empty
     value or one with spaces, quotes, `< >`, `…` or `PASTE_` (anything the
     worker would refuse at boot), and asks again before using one that
     does not start with `GOCSPX-`. Then it stages the pair with
     `fly secrets import --stage -a roybal-worker`, fed on stdin by a shell
     builtin so the secret is never on a command line (nor printed), and
     then runs the deploy above itself (with `-a roybal-worker`). Staged
     means set without a restart: the image already on Fly may be older
     than the 48-hour limit and the job filing of sent copies, and must not
     come up with email on.
     The deploy brings the new code and the pair live together. A staged
     pair goes live with ANY restart of the app, a plain `fly secrets set`
     included, and a restart keeps the image already on Fly; so if the
     deploy fails, or the run is stopped (Ctrl-C, the window closed) once
     fly has the pair, the script takes it back out
     (`fly secrets unset --stage`), so no restart can turn email on in an
     older image, and gives the line to run it again. That never stops a
     worker already running with email (a pair from an earlier run, or a
     deploy that failed after Fly started the new image): it stays on until
     the worker's next restart, then goes off, and the message says so. A
     failed import is taken back out the same way. If that unset fails too,
     it says the pair may still be staged: until a run of the script goes
     through, any `fly secrets set` or restart of roybal-worker turns email
     on in the old image. A fly
     that cannot stage both ways (`secrets import` and `secrets unset`
     without `--stage`) is refused before the secret is asked for
     (`brew upgrade flyctl`). To see it took, `fly logs -a roybal-worker`
     shows a new `worker.start` line with `"email":true` and
     `"channels":["sms","email","qbo","packet"]` (no `"qbo"` while
     `RECEIPTS_QBO=off`, no `"packet"` while `CARRIER_PACKET=off`)
     and no `email.disabled` after it;
     `/healthz` and the heartbeat show the
     same channels, which is how the apps learn email sending is on. A
     wrong secret still boots and shows up later as `outbox.failed` with
     "Gmail token refresh failed"; run the script again with the right one.
     Where the secret comes from: Google Cloud Console → Google Auth
     Platform (or APIs & Services → Credentials) → that OAuth client. The
     client secret is shown in full only when it is created (the console
     masks it to its last four characters afterwards), and Supabase shows
     its own copy as a digest only, so it cannot be read back from the
     gmail-proxy secrets either. If you kept the `client_secret_….json` you
     downloaded when the client was made, use its `client_secret`.
     Otherwise, under **Client secrets**, click **Add secret**: a client
     holds two, both stay valid, and the new one is shown once — paste it
     into the script. Do NOT reset, disable or delete the existing secret:
     gmail-proxy refreshes the office connection with it, and losing it
     breaks the inbox pull within the hour. Optional: without both, the
     email lane stays off (logged at boot) and email rows wait as
     `pending`; texts still flow. When the lane comes on, rows that waited
     longer than `EMAIL_MAX_AGE_HOURS` go dead instead of out (above).
   - `OWNER_CELL` is optional too (no dead-letter text without it; the
     dead-worker text is the database's and needs nothing here).
   - `--ha=false` = ONE machine, on purpose.
4. **Watch it come up**: `fly logs -a roybal-worker` prints one JSON line per
   event — `worker.start`, then `job.claimed` / `outbox.sent` / `outbox.failed`
   as work arrives. Never a message body. `https://roybal-worker.fly.dev/healthz`
   shows the last heartbeat age and both lanes' last run.
5. **Later deploys from GitHub** (optional): `fly tokens create deploy -a roybal-worker`,
   paste the token as the repository secret `FLY_API_TOKEN`, and the thread
   can run the **Fly deploy** workflow from main on your word. Without the
   token, the laptop command in step 3 is the deploy.

### Memory

`fly.toml` asks for 1 GB. The process idles far below that; the number is a
floor against a Node heap spike during a big email with a long body, and Fly
bills by the second. The carrier packet draws its PDF in this process (no
Chromium), holding one job's images and the finished PDF in memory at a
time; the PDF is capped at `PACKET_HARD_KB`, and the packet email carries it
base64-encoded, about a third larger. To save, change `memory = "1gb"` in `fly.toml` (a PR)
and redeploy: a one-off `fly scale memory 512` is undone by the next deploy,
which re-applies `fly.toml`.

## Day-2 ops

- **Kill switch**: `fly scale count 0 -a roybal-worker`. Approvals still
  record, sends wait in line as `pending`, and the owner gets the down text
  within ~15 minutes (that is the alarm working). `fly scale count 1 -a roybal-worker` resumes:
  queued texts go out, each row once, and so do queued emails less than
  `EMAIL_MAX_AGE_HOURS` (48) old. Older emails are marked dead (shown in the
  admin app's Approvals tab, under Recently decided, as "Couldn't send") and
  must be sent fresh.
- **Test the alarm**: scale to 0, wait 15 minutes, expect the text; scale back
  to 1 and `select public.worker_liveness_check(true)` reports `fresh` on the
  next cron tick (event `worker.recovered`). The edge function's 24 h guard
  means a second test the same day is silent by design — clear it with
  `delete from public.app_settings where key = 'worker.alert_texted'`.
- **A project nobody runs a worker on** (staging after a rehearsal, a laptop
  run): its database keeps alarming on the stale heartbeat it was left with.
  Disarm it there: `delete from public.worker_heartbeats; delete from public.app_settings where key in ('edge.base_url', 'worker.liveness_alert', 'worker.alert_texted')`.
- **After every redeploy**: the heartbeat names what this worker claims.
  `select worker_id, at, meta -> 'kinds' as kinds, meta -> 'channels' as channels from public.worker_heartbeats order by at desc limit 1`
  must list `proposal.execute`, `billing.reconcile`, `receipts.qbo_match`
  and `packet.build` among the kinds, and `sms`, `email`, `qbo` and `packet`
  among the channels (less only on purpose: no Gmail pair, `RECEIPTS_QBO=off`,
  `CARRIER_PACKET=off`). One missing: `fly secrets list -a roybal-worker`. A
  `QUEUE_KINDS` or `OUTBOX_CHANNELS` secret replaces the default list
  whole, so a value set before a lane existed hides that lane; unset it
  (`fly secrets unset -a roybal-worker QUEUE_KINDS`) or set the full list.
- **What is waiting**: `select channel, status, count(*) from public.outbox group by 1, 2`;
  dead rows carry the provider's last word in `error`. To retry a dead row
  after fixing the cause: `update public.outbox set status = 'failed', attempts = 0, next_attempt_at = now() where id = …`
  (the adopt check runs on every attempt, so a text the dead row's last try
  did deliver is adopted, not resent). A revived `packet` row holds its job:
  the reserve, a re-offer and the send of any newer card of that job wait
  (`in_flight`) until it settles, and when it goes out the packet reads
  `sent` and any fresh card for the same version is superseded. An email row older than
  `EMAIL_MAX_AGE_HOURS` goes straight back to dead, on purpose; if it
  should still go, send a fresh one from the app instead.
- **Rotate the alert secret** in place, so there is never a moment without one:
  `select vault.update_secret((select id from vault.secrets where name = 'worker_alert_secret'), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))`;
  the edge function reads it live.
- **Env knobs** (fly.toml `[env]` or secrets, restart to apply):
  `WORKER_POLL_MS` 5000, `WORKER_HEARTBEAT_MS` 30000, `QUEUE_LEASE_S` 300,
  `OUTBOX_LEASE_S` 120, `OUTBOX_BATCH` 10, `OUTBOX_CHANNELS`
  `sms,email,qbo,packet` (email drops out without the Gmail pair, qbo with
  `RECEIPTS_QBO=off`, packet with either no Gmail pair or
  `CARRIER_PACKET=off`), `QUEUE_KINDS`
  `proposal.execute,billing.reconcile,receipts.qbo_match,packet.build` (a
  value set on the app replaces the whole list, so it must name all four),
  `SHUTDOWN_GRACE_MS` 25000,
  `EMAIL_MAX_AGE_HOURS` 48 (1 to 720; a value that is not a number, or a
  blank one, keeps 48, so a typo can neither switch the limit off nor stop
  the worker booting), `BILLING_RECONCILE` (`off` stops the billing check;
  unset, or anything else, leaves it on), `RECEIPTS_QBO` (`off` stops the
  QuickBooks match and the `qbo` channel; unset, or anything else, leaves
  them on), `QBO_PROXY_URL` (default `<SUPABASE_URL>/functions/v1/qbo-proxy`),
  and the carrier packet's `CARRIER_PACKET` and `PACKET_*` knobs (its
  section above lists each with its default and range).

## Tests

`npm test` in this directory (no install; zero dependencies): the RFC 822
builder, both adapters against a stubbed fetch (token refresh, adopt lookup,
error verdicts, the email age limit and the job the sent copy files under),
`set-gmail-secret.sh` against a stand-in `fly`, `git fetch` and `curl`, so
nothing leaves the machine (the exact pair it stages on stdin and never on
a command line, the deploy after it, the pair taken back out when the
deploy fails or the run is stopped, the checkouts it refuses before fly is
called, behind GitHub's main or with local changes included, and a
roybal-notify that cannot answer a spine YES, the values it refuses before
anything is staged, the secret never printed; under `sh` and, where it is
installed, `bash --posix`, which is what macOS runs as `/bin/sh`), the
outbox lane's order of operations (adopt → send → report with retries; a
failed report leaves the row to expire; the active set is kept exact on
every path), the queue lane, the billing check against a small in-memory
PostgREST and the real detector (which jobs are in scope, paging past a
server's row cap, the filing door's arguments, the rev_moved re-read, no
lines and hints only, the stale and off skips, one job's error, the summary,
hours rows with no employee in them, and that the scan and the per-job read
project every key the detector reads), the QuickBooks matcher on the real
Oct 7 shapes and on a trimmed copy of that day's books
(`test/qbo-oct7.fixture.mjs`, no email address or phone number in it), with
every card it builds checked against the catalog's `input_schema` read from
migration 0023, the executor's item checks and the note door's row checks,
the nightly match lane against an in-memory PostgREST and a stubbed qbo-proxy
(the `(job_id, id)` keyset past a row cap, the 404 skip, one job's error, a
manual run's scope, the stale and off skips, the summary), the QuickBooks
adapter (its verdicts, and the provider id the 0023 trigger parses), the
carrier packet (the gate, each section the document prints, the hash that
decides a version, photo numbers, Alaska times, the media budget and the
fixed words, over a made-up water job in `test/packet-demo.fixture.mjs`;
the PDF writer and the renderer on every block type; the work
authorization terms checked word for word against `apps/field/js/forms.js`;
the suggested To held to the field app's adjuster-email rules; the lane's
decisions and calls against a stubbed database, Storage and roybal-notify;
the Storage calls and their retries; the knobs and the `packet` channel;
and the packet email in the email adapter and the RFC 822 builder), that
the image holds every file the worker can import (`test/packaging.test.mjs`
walks the imports against the Dockerfile and `.dockerignore`), that `set-gmail-secret.sh` checks
every path the Dockerfile copies, the heartbeat (which
leases it names, and that the final one names none) and dead-letter text
with its 24 h guard, and the real HTTP server booting, answering `/healthz`
through an outage, and stopping clean. The database
half is `supabase/test/worker_spine.test.sql` (and, for the billing check's
door and executor, `supabase/test/billing_review_gaps.test.sql`; for the
QuickBooks link's, `supabase/test/receipts_qbo_link.test.sql`; for the
carrier packet's doors, executor and trigger,
`supabase/test/carrier_packet.test.sql`), run by the
DB replay workflow against a database rebuilt from the migrations. The
detector's own rules are `apps/field/test/reconcile.test.mjs` (root
`npm run field:test`). The alert function's rules
are `supabase/functions/roybal-webhooks/alert.test.mjs` (root `npm run fn:test`).
