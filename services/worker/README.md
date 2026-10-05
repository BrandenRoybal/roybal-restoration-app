# Roybal worker — the operations spine's hands (Fly app `roybal-worker`)

The always-on Node process that turns an approved proposal into a sent text
or email. The spine (migrations 0013–0017) decides *what* may happen and
records that it did; this process is the only thing that *does* it. It is its
own Fly app, never co-hosted with the phone agent: a stalled send must never
touch a live call, and the dead-worker alarm assumes this app is the only
writer of `worker_heartbeats`.

```
owner approves (admin app / YES by text)
  → op_proposal_approve → executor writes an outbox row (email.send, sms.send)
                        → or enqueues a jobs_queue row (worker-runtime ops; none yet)
                                      ↓ polled every 5 s
THIS WORKER (Fly, one machine)
  outbox lane   outbox_claim → Twilio via roybal-notify | Gmail API → outbox_sent / outbox_failed
  queue lane    claim_job → op_execute → finish_job
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
   pending row with no SID proves nothing and the text is sent.
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
- **`qbo` and `portal` outbox rows are not touched** (no adapter yet); they
  wait as `pending` until a later phase.
- **Queue kinds**: `proposal.execute` only (runs `op_execute` as the approver;
  a proposal whose executor fails is recorded on the proposal, and the job is
  done with that outcome). Only the kinds in `QUEUE_KINDS` are claimed; a row
  of any other kind waits as `queued` until a worker that knows it is
  deployed. A kind that is listed but has no handler is dead on arrival.

Retry policy for a failed send: `now() + 2^attempts` minutes, capped at an
hour, 6 attempts by default (`outbox.max_attempts`) — about an hour of
trying. A permanent refusal (bad number, bad address) is dead at once.

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
  per 24 h. Needs `OWNER_CELL` on the Fly app.

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
3. **Fly app** — from the REPO ROOT on the Mac:
   ```sh
   fly apps create roybal-worker
   fly secrets set -a roybal-worker \
     SUPABASE_URL="https://djpgvcvhvgrzgaziruze.supabase.co" \
     SUPABASE_SERVICE_ROLE_KEY="<a SECRET key, sb_secret_…, see below>" \
     GMAIL_CLIENT_ID="<Google Cloud Console OAuth client id, see below>" \
     GMAIL_CLIENT_SECRET="<its client secret>" \
     OWNER_CELL="<your cell, e.g. 907xxxxxxx>"
   fly deploy --config services/worker/fly.toml --dockerfile services/worker/Dockerfile --ha=false .
   ```
   - **The service key**: Supabase Dashboard → Project Settings → API Keys →
     the **Publishable and secret keys** tab → copy (or create) a *Secret key*;
     it begins `sb_secret_`. NOT the *Legacy* tab's `service_role` JWT (begins
     `eyJ`): this project's legacy keys are disabled, and the worker refuses
     one at boot rather than run with every call failing.
   - **The Gmail pair** is the OAuth client the office Gmail connection was
     made with: Google Cloud Console → APIs & Services → Credentials → that
     OAuth 2.0 Client → Client ID and Client secret. (Supabase shows its own
     copy of these as digests only, so they cannot be read back from the
     gmail-proxy secrets.) Optional: without both, the email lane stays off
     (logged at boot) and email rows wait as `pending`; texts still flow.
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
  within ~15 minutes (that is the alarm working). `fly scale count 1` resumes;
  everything queued goes out, each row once.
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
  did deliver is adopted, not resent).
- **Rotate the alert secret** in place, so there is never a moment without one:
  `select vault.update_secret((select id from vault.secrets where name = 'worker_alert_secret'), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))`;
  the edge function reads it live.
- **Env knobs** (fly.toml `[env]` or secrets, restart to apply):
  `WORKER_POLL_MS` 5000, `WORKER_HEARTBEAT_MS` 30000, `QUEUE_LEASE_S` 300,
  `OUTBOX_LEASE_S` 120, `OUTBOX_BATCH` 10, `OUTBOX_CHANNELS` `sms,email`,
  `QUEUE_KINDS` `proposal.execute`, `SHUTDOWN_GRACE_MS` 25000.

## Tests

`npm test` in this directory (no install; zero dependencies): the RFC 822
builder, both adapters against a stubbed fetch (token refresh, adopt lookup,
error verdicts), the outbox lane's order of operations (adopt → send →
report with retries; a failed report leaves the row to expire; the active
set is kept exact on every path), the queue lane, the heartbeat (which
leases it names, and that the final one names none) and dead-letter text
with its 24 h guard, and the real HTTP server booting, answering `/healthz`
through an outage, and stopping clean. The database
half is `supabase/test/worker_spine.test.sql`, run by the DB replay workflow
against a database rebuilt from the migrations. The alert function's rules
are `supabase/functions/roybal-webhooks/alert.test.mjs` (root `npm run fn:test`).
