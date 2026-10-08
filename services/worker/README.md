# Roybal worker — the operations spine's hands (Fly app `roybal-worker`)

The always-on Node process that turns an approved proposal into a sent text,
an email or a QuickBooks change, and runs the nightly billing check and the
nightly QuickBooks match. The spine (migrations
0013–0017) decides *what* may happen and records that it did; this process is
the only thing that *does* it. It is its own Fly app, never co-hosted with the
phone agent: a stalled send must never touch a live call, and the dead-worker
alarm assumes this app is the only writer of `worker_heartbeats`.

```
owner approves (admin app / YES by text)
  → op_proposal_approve → executor writes outbox rows (email.send, sms.send, receipts.qbo_link)
                        → or enqueues a jobs_queue row (worker-runtime ops; none yet)
pg_cron 14:45 UTC → enqueues a billing.reconcile row (the nightly billing check, below)
pg_cron 14:50 UTC → enqueues a receipts.qbo_match row (the nightly QuickBooks match, below)
                                      ↓ polled every 5 s
THIS WORKER (Fly, one machine)
  outbox lane   outbox_claim → Twilio via roybal-notify | Gmail API | qbo-proxy → outbox_sent / outbox_failed
  queue lane    claim_job → op_execute | billing check | QuickBooks match → finish_job
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
- **`portal` outbox rows are not touched** (no adapter yet); they wait as
  `pending` until a later phase.
- **Queue kinds**: `proposal.execute` (runs `op_execute` as the approver; a
  proposal whose executor fails is recorded on the proposal, and the job is
  done with that outcome), `billing.reconcile` (the nightly billing check,
  below) and `receipts.qbo_match` (the nightly QuickBooks match, below).
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
  detector            apps/field/js/reconcile.js (pure; copied into the image)
  → billing_review_gaps_file(job, rev read, input | null, rationale, evidence)
       stamps the invoice fingerprint, files as agent:billing, supersedes the job's older open card
```

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
     the four field modules the check imports, so build from the repo root as
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
  qbo-proxy           listProjects; listPurchases from a day before the oldest receipt to today
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
  day before the receipt to three days after; and a score of at least 2:
  +3 the receipt number in the DocNumber (Sherwin's `8066-9` is DocNumber
  `80669163000926`), +2 the same store (the vendor's name, or the memo a
  bank rule writes), +1 the same day, +1 the card's last four in the payment
  account's name. An expense that says it is not the receipt's is never a
  candidate: another known store, another card (a card account whose name
  carries a different number), a payment (every line on the clearing
  account 1150040008), or, for a receipt charged to a store account, money
  paid from the bank. The surest receipt chooses first, one expense goes to
  one receipt, and two equally good expenses are left to a person. Receipts
  dated in the last 60 days are matched; an older one keeps the row it had.
- **What each receipt gets.** A line on its job's card when the expense needs
  `tag`, `attach` or both (a tag already set is never changed), or a row in
  `receipt_qbo_links`:
  - `in_qbo`: tagged to the job, and a document attached or no photo to add
    (a receipt with no photo yet). Nothing to do.
  - `unmatched`, `detail.reason`: `waiting_feed` (a card charge a week old or
    less; the bank feed lags), `store_not_entered` (a receipt on a store
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
  with the reason. QuickBooks rows are counted apart (qbo-proxy refuses one
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
     GitHub since), local changes in `services/worker`, the four
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
     `"channels":["sms","email","qbo"]` (no `"qbo"` while `RECEIPTS_QBO=off`)
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
bills by the second. To save, change `memory = "1gb"` in `fly.toml` (a PR)
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
- **What is waiting**: `select channel, status, count(*) from public.outbox group by 1, 2`;
  dead rows carry the provider's last word in `error`. To retry a dead row
  after fixing the cause: `update public.outbox set status = 'failed', attempts = 0, next_attempt_at = now() where id = …`
  (the adopt check runs on every attempt, so a text the dead row's last try
  did deliver is adopted, not resent). An email row older than
  `EMAIL_MAX_AGE_HOURS` goes straight back to dead, on purpose; if it
  should still go, send a fresh one from the app instead.
- **Rotate the alert secret** in place, so there is never a moment without one:
  `select vault.update_secret((select id from vault.secrets where name = 'worker_alert_secret'), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))`;
  the edge function reads it live.
- **Env knobs** (fly.toml `[env]` or secrets, restart to apply):
  `WORKER_POLL_MS` 5000, `WORKER_HEARTBEAT_MS` 30000, `QUEUE_LEASE_S` 300,
  `OUTBOX_LEASE_S` 120, `OUTBOX_BATCH` 10, `OUTBOX_CHANNELS` `sms,email,qbo`
  (email drops out without the Gmail pair, qbo with `RECEIPTS_QBO=off`),
  `QUEUE_KINDS` `proposal.execute,billing.reconcile,receipts.qbo_match` (a
  value set on the app replaces the whole list, so it must name all three),
  `SHUTDOWN_GRACE_MS` 25000,
  `EMAIL_MAX_AGE_HOURS` 48 (1 to 720; a value that is not a number, or a
  blank one, keeps 48, so a typo can neither switch the limit off nor stop
  the worker booting), `BILLING_RECONCILE` (`off` stops the billing check;
  unset, or anything else, leaves it on), `RECEIPTS_QBO` (`off` stops the
  QuickBooks match and the `qbo` channel; unset, or anything else, leaves
  them on), `QBO_PROXY_URL` (default `<SUPABASE_URL>/functions/v1/qbo-proxy`).

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
adapter (its verdicts, and the provider id the 0023 trigger parses), that `set-gmail-secret.sh` checks
every path the Dockerfile copies, the heartbeat (which
leases it names, and that the final one names none) and dead-letter text
with its 24 h guard, and the real HTTP server booting, answering `/healthz`
through an outage, and stopping clean. The database
half is `supabase/test/worker_spine.test.sql` (and, for the billing check's
door and executor, `supabase/test/billing_review_gaps.test.sql`; for the
QuickBooks link's, `supabase/test/receipts_qbo_link.test.sql`), run by the
DB replay workflow against a database rebuilt from the migrations. The
detector's own rules are `apps/field/test/reconcile.test.mjs` (root
`npm run field:test`). The alert function's rules
are `supabase/functions/roybal-webhooks/alert.test.mjs` (root `npm run fn:test`).
