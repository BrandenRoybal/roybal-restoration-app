# Roybal worker — the operations spine's hands (Fly app `roybal-worker`)

The always-on Node process that turns an approved proposal into a sent text
or email, and runs the nightly billing check. The spine (migrations
0013–0017) decides *what* may happen and records that it did; this process is
the only thing that *does* it. It is its own Fly app, never co-hosted with the
phone agent: a stalled send must never touch a live call, and the dead-worker
alarm assumes this app is the only writer of `worker_heartbeats`.

```
owner approves (admin app / YES by text)
  → op_proposal_approve → executor writes an outbox row (email.send, sms.send)
                        → or enqueues a jobs_queue row (worker-runtime ops; none yet)
pg_cron 14:45 UTC → enqueues a billing.reconcile row (the nightly billing check, below)
                                      ↓ polled every 5 s
THIS WORKER (Fly, one machine)
  outbox lane   outbox_claim → Twilio via roybal-notify | Gmail API → outbox_sent / outbox_failed
  queue lane    claim_job → op_execute | billing check → finish_job
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
- **`qbo` and `portal` outbox rows are not touched** (no adapter yet); they
  wait as `pending` until a later phase.
- **Queue kinds**: `proposal.execute` (runs `op_execute` as the approver; a
  proposal whose executor fails is recorded on the proposal, and the job is
  done with that outcome) and `billing.reconcile` (the nightly billing check,
  below). Only the kinds in `QUEUE_KINDS` are claimed; a row of any other
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
     `"kinds":["proposal.execute","billing.reconcile"]`, as does `/healthz`.
  Until the worker is deployed, the nightly rows wait `queued` (the old
  worker does not claim the kind), so no card is filed before roybal-notify
  (step 2) is live; the new worker runs yesterday's and today's, and
  finishes older ones `{"skipped":"stale"}`. To see a first
  result without waiting for the morning, enqueue a manual run (above).

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
  with the reason. Needs `OWNER_CELL` on the Fly app.

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
     `"channels":["sms","email"]` and no `email.disabled` after it;
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
  `OUTBOX_LEASE_S` 120, `OUTBOX_BATCH` 10, `OUTBOX_CHANNELS` `sms,email`,
  `QUEUE_KINDS` `proposal.execute,billing.reconcile` (a value set on the app
  replaces the whole list, so it must name both), `SHUTDOWN_GRACE_MS` 25000,
  `EMAIL_MAX_AGE_HOURS` 48 (1 to 720; a value that is not a number, or a
  blank one, keeps 48, so a typo can neither switch the limit off nor stop
  the worker booting), `BILLING_RECONCILE` (`off` stops the billing check;
  unset, or anything else, leaves it on).

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
project every key the detector reads), that `set-gmail-secret.sh` checks
every path the Dockerfile copies, the heartbeat (which
leases it names, and that the final one names none) and dead-letter text
with its 24 h guard, and the real HTTP server booting, answering `/healthz`
through an outage, and stopping clean. The database
half is `supabase/test/worker_spine.test.sql` (and, for the billing check's
door and executor, `supabase/test/billing_review_gaps.test.sql`), run by the
DB replay workflow against a database rebuilt from the migrations. The
detector's own rules are `apps/field/test/reconcile.test.mjs` (root
`npm run field:test`). The alert function's rules
are `supabase/functions/roybal-webhooks/alert.test.mjs` (root `npm run fn:test`).
