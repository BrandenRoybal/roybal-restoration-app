# E0 Runbook — putting "fix production now" into production

<!-- ============================================================
     WHY THIS FILE EXISTS
     ------------------------------------------------------------
     Every other document in docs/architecture/ describes the system.
     This one is the only operational document: the ordered set of
     commands and browser clicks that move E0 (03-TARGET-ARCHITECTURE
     -AND-ROADMAP.md §7.2) from a branch on disk into the live project
     djpgvcvhvgrzgaziruze.

     It exists because E0 is not one PR. It is ten repairs across four
     surfaces — the repo, the Supabase database, the deployed edge
     functions, and three vendor consoles (Google, Intuit, Twilio) —
     and seven of those steps cannot be done by any agent, script or CI
     job. They need a human holding a browser session, a CLI session or
     a vendor login that only the owner can create; §5 lists exactly
     those seven. An agent that "finished E0" has finished roughly six
     tenths of it; the rest is below, written out so it does not get
     forgotten and so the order that keeps the business running is not
     rediscovered under pressure.

     It also exists to say plainly which E0 item is NOT going to get
     done in E0. See §4. Pretending otherwise is how a checklist starts
     lying, and a lying checklist is the failure mode this whole review
     was called to fix.

     Sources: docs/architecture/03-TARGET-ARCHITECTURE-AND-ROADMAP.md
     §7.2 (the item list); 00-SYSTEM-INVENTORY.md §6.5, §6.7, §11 (the
     live facts); findings.json (the F-ids cited per item).
     ============================================================ -->

**Target project:** `djpgvcvhvgrzgaziruze` · **API base:** `https://djpgvcvhvgrzgaziruze.supabase.co` · **Apps:** `https://app.roybalconstruction.com` (field `/`, admin `/admin`, board `/board`)
**Written against:** `main @ 1e04694` plus the E0 working tree · **Live facts read:** 2026-09-06 ~04:00 UTC (`00-SYSTEM-INVENTORY.md` §11)

---

## 0. Before you start

**Read this whole file once before running anything.** Steps 4 and 5 are browser work in Google's and Intuit's consent screens; if you start them at 4:55pm and get interrupted, the OAuth `code` expires and you start over.

**What you need in hand:**

| Value | Where it comes from | Used in |
|---|---|---|
| `<CRON_SECRET>` | Supabase dashboard → Edge Functions → Secrets → `CRON_SECRET`. It is **not** in the repo, by design. | Steps 6, 10 |
| `<SERVICE_ROLE_KEY>` | Supabase dashboard → Project Settings → API keys → `service_role`. Never paste it into a browser page or a file in this repo. | Step 7 reconcile only |
| `<TWILIO_ACCOUNT_SID>` / `<TWILIO_AUTH_TOKEN>` | Twilio Console → Account Info. Also already stored as Supabase function secrets. | Step 7 |
| Supabase CLI, logged in | `supabase login` once | Steps 6, 7, 8 |
| The SQL editor | Supabase dashboard → SQL Editor | Steps 3, 9, and every verification query |

**The publishable key is public.** `sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4` ships in `apps/field/js/config.js:8` and is served on the open internet. It appears in the curl probes below on purpose — that is the whole point of the probe. It is not a secret and never was; the bug (F-003) is that six proxy actions treated it like one.

**Do NOT run `supabase db push` at any point in E0.** The migration directory is a journal, not a replayable schema (`00-SYSTEM-INVENTORY.md` §6.8): `db push` would re-run non-idempotent `create policy` statements in migrations 204/205 against production. E0 migrations go in through the SQL Editor, one at a time, as every migration since 203 has. Fixing that is P1's baseline-and-repair day, not E0's job.

**One PR per item, and each reverts alone** (roadmap §7 rule 1). If you batch them and something goes wrong at 7am on a Monday, you will be reverting things that were fine.

---

## 1. What is already done, and what this run produced

### 1a. Already on disk in the working tree (done before this run)

| Change | File | What it fixes |
|---|---|---|
| **BUILD/SW lockstep** — `BUILD` bumped `v165` → `v166` to match the service worker's cache name | `apps/field/js/config.js:25` (vs `apps/field/sw.js:6`) | F-048. PR #181 shipped `sw.js` at `v166` without `config.js`, so every deployed device reported a build it was not running — which is exactly the signal the server's `min_field_build` gate compares against (Step 9). It also turned `main` red: `apps/field/test/build.test.mjs` fails on the mismatch, and because the field suite is one `&&` chain, that one failure silenced 26 field files, the board suite and the edge-function suite behind it. |
| **A CI test gate** | `.github/workflows/ci.yml` (new) | F-009. The repo's only workflow was `deploy-field.yml` — a deploy with no test step, on a `paths` filter, still listing a branch that was deleted in PR #117. This adds a `pull_request` + `push: main` workflow that runs every suite as its **own step** (`if: '!cancelled()'`), so one red suite can no longer hide the others, with the build-tag lockstep check running first and on its own. It also runs `services/phone-agent`'s tests, which have never run in CI at all. |

### 1b. Produced by the other agents in this same run

Described by intent. **Read each file's own header block before you deploy it** — that header is the authoritative record of what the change does and which finding it closes; this table is the map, not the spec.

| Item | Files | Intent |
|---|---|---|
| **Proxy auth guards** | `supabase/functions/qb-time-proxy/index.ts`, `supabase/functions/qbo-proxy/index.ts`, `supabase/functions/gmail-proxy/index.ts` | F-003. Thirteen actions across three proxies are reachable today by anyone holding the publishable key: `exchangeCode`, `disconnect`, `syncJobcodes`, `getTimesheets`, `getUsers`, `getCurrentTotals` on qb-time; `getStatus`/`exchangeCode`/`disconnect`/`pushInvoice` on qbo; `getStatus`/`exchangeCode`/`disconnect` on gmail. Each now requires **either** a user JWT that resolves to `admin`/`office` in `profiles`, **or** the `x-cron-secret` header where a cron is the legitimate caller. Both existing caller shapes must keep working: the browsers go through `apps/field/js/supa.js callFunction()` with the signed-in user's JWT, and the crons post with the publishable key plus `x-cron-secret`. Breaking either is worse than the hole. |
| **The SQL half — migration `247_*.sql`** | `supabase/migrations/247_*.sql` | The database-side E0 items: the interim `integration_health_v0` view over the three token tables (`gmail_tokens`, `qb_time_tokens`, `qbo_tokens`) joined to the newest successful row per lane (`capture_events` `emailPull`, `time_entries` `qbtime`, `sms_messages`) and its 15-minute owner-SMS check with a 24h resend guard (F-005); the zombie-proposal sweep and the `expires_at > now()` filter (F-006); the ledger grants that make `ai_usage` and `capture_events` insert-only for `authenticated` and gate `time_entries` UPDATE to `admin`/`office` with DELETE revoked (F-004); the nightly `capture_events` `emailPull` purge past 30 days (F-054), in the shape of the `blob_history` purge at `215_blob_history.sql:199-218`. |
| **Twilio status callback** | `supabase/functions/roybal-notify/status.mjs` (new, pure) + a `/status` route in `supabase/functions/roybal-notify/index.ts` | F-034. `sendSms` stores the status from Twilio's *immediate* API response, which is always `queued`/`accepted` — the answer to "did you take it?", never "did it arrive?" — and `supabase/config.toml:53-54` has claimed a status-callback handler that did not exist. 174 of 175 outbound rows are frozen at `queued` **(live)**. The new pure module ranks stored statuses so an out-of-order or re-delivered callback can never un-deliver a delivered message and a replayed callback is a no-op; the route settles rows by SID. |
| **Magicplan removal** | `supabase/functions/magicplan-proxy/` and `magicplan-webhook/` deleted; two pins removed from `supabase/config.toml` | F-049. `magicplan-proxy` ran `verify_jwt=false` with no auth check of any kind, so anyone with the URL could spend the company's `MAGICPLAN_API_KEY` and create projects in the vendor account. `magicplan-webhook` ran `verify_jwt=true`, which a vendor webhook can never satisfy, so it was unreachable from the day it shipped. Zero callers in `apps/`, `services/` or `.github/`. The code stays in git history. |

**Nothing above is live yet.** Files on disk change nothing in production. Everything in §3 is what makes them real.

---

## 2. The ten E0 items and who does each

| # | E0 item (roadmap §7.2) | Agent | Your hands | Step |
|---|---|---|---|---|
| 1 | CI test gate + BUILD/SW lockstep | ✅ **SHIPPED** — PR #182 merged 2026-09-07 00:53Z; live app + service worker both report `v166` | done | 2 |
| 2 | `integration_health_v0` + owner SMS | ✅ **APPLIED** to prod 2026-09-07 | done. ⚠️ `integration_runs` has 0 rows — nothing writes to it until the P1 adapters, so the view is empty, not green | 3 |
| 3 | **Reconnect Gmail** | ✗ impossible | ✅ **DONE by owner ~00:15Z 9/7.** Was `invalid_grant / Token has been expired or revoked`. ⚠️ every pull since now exceeds pg_net's 5 s timeout (`timed_out=true`) while still finishing its work — real failures are now indistinguishable from normal | 4 |
| 4 | **Reconnect QB Time** | ✗ impossible | ✅ **DONE by owner ~00:03Z 9/7.** Was down ALL of 9/6 — every sweep + the 14:00 pull returned 400 `refresh_token is invalid` while cron reported *succeeded*. ⚠️ **payroll gap: work dates 9/4, 9/5, 9/6 were never pulled** (last captured 9/3). Backfill per job with the board's **⤓ Sync hours** button | 5 |
| 5 | Gate the proxy actions | ✅ three functions | ✅ **DEPLOYED** 00:31Z via CLI. Verified: publishable key 401s, unknown action 404s, and cron still passes (`pullAllLinked`/`clockinSweep` are `["cron","user"]`) | 6 |
| 6 | Sweep the zombie proposals + expiry filter | ✅ sweep = migration 247 §4; filter = `qb-time-proxy/index.ts:615-620` | sweep applied in step 3; the filter ships with the **qb-time-proxy deploy** here — both halves are needed, the sweep alone only clears today's jam | 6 |
| 7 | Twilio status callback + reconcile | ✅ route + pure module | ✅ **DEPLOYED** 9/7 via CLI (config.toml `verify_jwt=false` respected — an unsigned POST returns 403 *signature mismatch*, not 401). **Still yours: set the Twilio StatusCallback URL.** Until then nothing settles; backlog is now **177** queued and still growing | 7 |
| 8 | Delete Magicplan | ✅ files deleted **and merged** | **STILL YOURS** — both remain ACTIVE on the platform (`magicplan-proxy` still `verify_jwt=false`, i.e. publicly reachable with the API key behind it). No MCP delete tool exists; use the CLI in step 8 | 8 |
| 9 | Arm `min_field_build` | ✗ app state | **STILL YOURS** — still `0`. v166 is live as of 9/7, so arm it at 166 from 9/8 once devices have picked it up | 9 |
| 10 | Cron secrets out of `cron.job` | ⚠️ **deferred to P1** | decide: rotate now, or accept | 10 / §4 |
| — | Ledgers insert-only; `capture_events` retention | ✅ migration 247 | applied in step 3 | 3 |

---

## 3. The ordered procedure

Each step is: **What · Why this position in the order · Do · Verify · Roll back.**

---

### Step 1 — Pre-flight (10 minutes)

**Do.**

```bash
cd /Users/brandenroybal/roybal-restoration-app
git status --short              # expect the E0 changes, nothing else surprising
npm ci
node apps/field/test/build.test.mjs   # the lockstep check, on its own
npm test                              # the old && chain — should now run past file 2
npm run fn:test
```

Capture the "before" picture, so every later verification has something to compare against. In the SQL Editor:

```sql
-- the fleet
select user_id, build, last_seen from public.sync_clients order by build;
-- the jam
select id, kind, status, expires_at from public.pending_actions order by created_at;
-- the frozen texts
select status, count(*) from public.sms_messages where direction = 'outbound' group by 1;
-- what the crons literally are
select jobname, schedule, active from cron.job order by jobname;
```

**Verify.** Every suite passes locally. `sync_clients` shows six rows (four `v165`, one `v155`, one `v153`). `pending_actions` shows three `boardEdit` rows `pending` with `expires_at` in July. `sms_messages` shows ~174 `queued`.

**Roll back.** Nothing to roll back; nothing changed.

---

### Step 2 — Merge the CI gate and the BUILD/SW fix

**Why first.** Everything after this point is a change to production. The gate has to exist before the changes it is supposed to catch go through it — and `main` is currently red, so until this merges you cannot tell a real failure from the standing one.

**Do.**

1. Open a PR containing exactly `.github/workflows/ci.yml` and `apps/field/js/config.js`.
2. Let CI run on the PR. It must be green — this is the first honest green `main` has had since 2026-09-04.
3. In GitHub → Settings → Branches → `main` → require status checks: mark the CI job (and specifically the **Build tag lockstep** step's job) **required**.
4. Merge.

`deploy-field.yml` fires on `push: main` with a `paths` filter that includes `apps/field/**`, so merging this publishes the field app at `v166` to `app.roybalconstruction.com`. That is intended and is the precondition for Step 9.

**Verify.**
- The Actions tab shows CI green on `main`.
- Open `https://app.roybalconstruction.com/` on your own phone, hard-reload twice (the service worker installs on the first load and activates on the second), and read the build label at the bottom of the menu: `v166`.
- Push a throwaway branch with a deliberately broken test and confirm the PR cannot be merged. Delete the branch.

**Roll back.** `git revert` the merge. The app redeploys at `v165`; the service worker serves the older cache on the next load. Do this only if the deploy itself broke — a red CI run is not a reason to revert the thing that told you it was red.

---

### Step 3 — Apply migration 247 (the SQL half)

**Why here.** The health view has to exist *before* you reconnect the lanes, so you can watch it flip from red to green and know the view actually works. Applying it after the reconnect proves nothing — everything would already be green.

**Do.**

1. Read the header block of `supabase/migrations/247_*.sql` end to end. It states which of the E0 items it carries and what each grant changes.
2. Supabase dashboard → SQL Editor → paste the file → Run. **Not** `supabase db push` (see §0).
3. Record the run: this is the last E0 migration applied by hand. P1's first act is `0000_baseline.sql` + `supabase migration repair`, after which schema only reaches production through CI.

**Verify.**

```sql
-- 1. the health view exists and is honest: gmail + qbtime should read STALE/DEAD
select * from public.integration_health_v0;

-- 2. the jam is swept
select count(*) from public.pending_actions
 where status = 'pending' and expires_at < now();          -- expect 0

-- 3. the ledgers are insert-only for crews
select relname, polname, polcmd, polroles::regrole[]
  from pg_policy join pg_class on pg_class.oid = polrelid
 where relname in ('ai_usage','capture_events','time_entries')
 order by relname, polname;

-- 4. the purge is scheduled
select jobname, schedule from cron.job where command ilike '%capture_events%';
```

Then the negative test the roadmap asks for, run as a crew member, not as you: sign in to the field app on a tech account, open the browser console and attempt a delete against `ai_usage` over REST. It must affect 0 rows. Then, still in that session, confirm the field app syncs normally — `_sync_guard` is untouched by this migration and a sync failure here means something in the grants overreached.

Finally the office side of the same change: sign in to the board as yourself and edit a manual hours entry. It must save. The board's editor upserts with `merge-duplicates` (`apps/board/js/data.js:255-269`) and is an office surface [A-7.3]; if the UPDATE gate is wrong, this is where it shows.

**Roll back.** The reverse-grant statements are in the migration's own rollback block — this is a repo convention (`219_revoke_direct_field_writes.sql` carries one). Broadly: re-grant UPDATE/DELETE on the two ledgers to `authenticated`, `cron.unschedule` the two new jobs, `drop view public.integration_health_v0`. The swept `pending_actions` rows do not need restoring — they were expired in July 2026 and are the bug.

---

### Step 4 — Reconnect Gmail *(your hands only)*

**Why this cannot be automated.** Google's OAuth consent screen requires an interactive session as `branden@roybalconstruction.com`. There is no service account, no headless path, and no stored credential that could stand in — that is the point of `access_type=offline` + `prompt=consent`. The refresh token issued at the end of this step is the only thing that makes the 15-minute inbox pull work, and it can only be issued to a human who clicked Allow.

**Why now.** The lane has been dead since **2026-09-01 04:15Z** — every 15-minute `gmail-inbox-pull` returns 500 `invalid_grant` and `cron.job_run_details` reports all 288 of them as *succeeded*, because `net.http_post` is asynchronous. Meanwhile the admin's Gmail card renders "● Connected" whenever a token row exists (`apps/admin/js/gmailconnect.js` on `connected: !!data`). Five days of job email have not been matched to jobs. This is the single largest live business loss in E0.

Do it **before** Step 6. `gmail-proxy`'s `exchangeCode` is ungated today and is known to work; the guard in Step 6 changes that path. Reconnecting first separates "did the reconnect work" from "did the guard work," so if Step 6 misbehaves you are debugging one thing, not two.

**Do.**

1. Open `https://app.roybalconstruction.com/admin/` and sign in as `branden@roybalconstruction.com`.
2. Go to **Settings**. The Gmail card is rendered by `gmailPanel()` (`apps/admin/js/admin.js:346`).
3. If it shows "● Connected" (it will, and it is lying), click **Disconnect** first — a stale `gmail_tokens` row with a revoked refresh token will otherwise sit alongside the new one, and the reader is `.order(created_at desc).limit(1)`, latest row wins.
4. Click **Connect**. Google asks for consent on `gmail.readonly` (the job-matched pull) and `gmail.send` (confirm-chip sends from your real address). Approve both.
5. Google redirects back to the admin URL with `?code=…`; `handleGmailCallback()` claims it by its `gm-` state prefix, exchanges it, scrubs the code from the URL, and kicks off one immediate inbox scan.
6. Watch for the toast: `Gmail connected — branden@roybalconstruction.com. Scanning for job email…`

**Verify.**

```sql
select created_at, connected_by from public.gmail_tokens order by created_at desc limit 3;
select count(*), max(created_at) from public.capture_events where kind = 'emailPull';
select * from public.integration_health_v0;   -- the gmail row must now read healthy
```

The `emailPull` count should climb again within 15 minutes without you doing anything. Then the end-to-end check: the next morning brief's 📧 card should report a live count instead of the frozen one.

**Then test the alert, which is the actual deliverable of item 1.** In the Google Account security page, revoke the app's access. Within 15 minutes one text should reach your phone. Revoke again inside the same 24 hours: **no second text** — that is the resend guard. Then repeat this step to reconnect for real. Do this on a weekday afternoon, not before a busy morning.

**Roll back.** There is nothing to roll back — you replaced a dead credential with a live one. If the new token also fails, the old one was already dead; the failure is upstream (Google Cloud project, OAuth client, or a scope change) and belongs in the Google Cloud console, not here.

---

### Step 5 — Reconnect QuickBooks Time *(your hands only)*

**Why this cannot be automated.** Same reason as Step 4: Intuit's consent screen, an interactive session, a refresh token that only a human can cause to be issued.

**Why now.** Dead since roughly **2026-09-04 19:38Z** — every `qb-clockin-sweep` returns 400 `That refresh_token is invalid`, and the 09-05 daily pull wrote no `time_entries` at all. Payroll hours are the input to the crew schedule, the board's burn-down and the phase-matching ledger. Note that QB Time's admin card is the **honest** one — `qbconnect.js` shows "▲ Needs reconnect" with the reason — so unlike Gmail, this failure was at least visible to anyone who opened Settings.

**Do.**

1. Same admin **Settings** page. Find the QuickBooks Time card (`qbPanel()`).
2. Click **Disconnect**, then **Connect**. QB Time uses its own OAuth server (`https://rest.tsheets.com/api/v1/authorize`, not Intuit's appcenter endpoint) and returns a `code` with no `realmId`.
3. Approve. `handleQbCallback()` exchanges the code and then runs `syncJobcodes()` best-effort.
4. Watch for the toast: `QuickBooks Time connected.`

Do **not** confuse this with the QuickBooks **Online** card on the same page (`qboPanel()`, Intuit appcenter). The QBO lane is healthy — its token refreshed 2026-09-05 14:30Z. Leave it alone.

**Verify.**

```sql
select created_at from public.qb_time_tokens order by created_at desc limit 3;
select count(*) from public.qb_time_jobcodes;                       -- ~131, refreshed
select max((data->>'date')::date) from public.time_entries where data->>'source' = 'qbtime';
select * from public.integration_health_v0;   -- the qbtime row must now read healthy
```

Then force a pull rather than waiting for 14:00 UTC:

```bash
curl -s -X POST 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/qb-time-proxy' \
  -H 'apikey: sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4' \
  -H 'Authorization: Bearer sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4' \
  -H 'x-cron-secret: <CRON_SECRET>' \
  -H 'Content-Type: application/json' \
  --data '{"action":"pullAllLinked"}'
```

New `time_entries` rows for 09-04 and 09-05 should appear.

**This is also where item 6 finally pays off.** With the zombie rows swept in Step 3 and the lane alive again, the phase proposer's live-proposal count is back under `MAX_LIVE_PROPOSALS = 3`, so it can propose for the first time since 2026-07-25:

```sql
select id, kind, status, created_at, expires_at
  from public.pending_actions order by created_at desc limit 5;
```

A fresh `boardEdit` row with a future `expires_at` — and the matching text on your phone — is the proof. It may take a pull cycle or two; unmatched hours have to cluster before it proposes.

**Roll back.** As Step 4: nothing to undo.

---

### Step 6 — Deploy the proxy auth guards

**Why here.** After the reconnects, so a broken guard cannot lock you out of the console you need to reconnect with. Before the build gate and before you walk away, so you get a full cron cycle of observation while you are still watching.

**Do.**

```bash
supabase functions deploy qb-time-proxy --project-ref djpgvcvhvgrzgaziruze
supabase functions deploy qbo-proxy     --project-ref djpgvcvhvgrzgaziruze
supabase functions deploy gmail-proxy   --project-ref djpgvcvhvgrzgaziruze
```

All three are `verify_jwt = true` in `supabase/config.toml` and must stay that way. **If you deploy through the Supabase MCP tool or the dashboard instead of the CLI, `config.toml` is ignored** — re-check afterwards and fix any drift:

```bash
supabase functions list --project-ref djpgvcvhvgrzgaziruze -o json | grep -E 'name|verify_jwt'
```

**Verify — the negative test first.** Signed out, holding only the public key, exactly as a stranger on the internet would:

```bash
BASE=https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1
PUB=sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4

# read-only probes — safe whether the guard works or not
curl -s -o /dev/null -w 'qbtime getTimesheets -> %{http_code}\n' -X POST "$BASE/qb-time-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
  -H 'Content-Type: application/json' --data '{"action":"getTimesheets"}'

curl -s -o /dev/null -w 'gmail  getStatus     -> %{http_code}\n' -X POST "$BASE/gmail-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
  -H 'Content-Type: application/json' --data '{"action":"getStatus"}'

# qbo pushInvoice with no line items: returns 400 today (rejected on content),
# must return 401 after the guard (rejected on identity, before any QBO call)
curl -s -o /dev/null -w 'qbo pushInvoice -> %{http_code}\n' -X POST "$BASE/qbo-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
  -H 'Content-Type: application/json' --data '{"action":"pushInvoice"}'
```

All three must print **401**. Before the deploy, `getTimesheets` returned a timesheet dump and `pushInvoice` returned 400 — run the probes *before* deploying too, so you have seen the difference with your own eyes.

Never probe `disconnect` this way. If the guard has a hole, a `disconnect` probe would revoke the token you just spent Steps 4 and 5 restoring.

**Verify — the two legitimate callers still work.** This is the half that matters more than the 401.

1. **Browsers:** in the admin Settings page, all three cards still render live status (that is `getStatus` under your JWT). Click **↻ Scan inbox now** on the Gmail card — it must work. Open the board and confirm QB Time hours still load.
2. **Crons:** wait one `qb-clockin-sweep` cycle (runs at `3-59/15`), then:

```sql
select * from public.integration_health_v0;   -- all three lanes still ok
```

If a lane goes red within 15 minutes of this deploy, the guard rejected the cron. Roll back immediately.

**Roll back.**

```bash
git revert <the guard commit> && git push
supabase functions deploy qb-time-proxy --project-ref djpgvcvhvgrzgaziruze
supabase functions deploy qbo-proxy     --project-ref djpgvcvhvgrzgaziruze
supabase functions deploy gmail-proxy   --project-ref djpgvcvhvgrzgaziruze
```

You are back to the hole, which has been open for months and can stay open one more day. A dead payroll lane cannot.

---

### Step 7 — Twilio status callback, then reconcile the 174 frozen rows *(partly your hands)*

**Why here.** It needs no other step, and it is the one whose verification is instant and unambiguous: you text yourself and watch a row turn `delivered`.

**7a — deploy the route.**

```bash
supabase functions deploy roybal-notify --no-verify-jwt --project-ref djpgvcvhvgrzgaziruze
```

`--no-verify-jwt` is required and is already the documented deploy line in the function's own header: browsers need the CORS preflight and Twilio's webhooks carry no JWT. The function self-protects — `sendSms` runs its DB work under the caller's JWT, `/inbound` demands a valid `X-Twilio-Signature`, and the new `/status` route settles rows by SID under the same signature check.

**7b — point Twilio at it *(your hands)*.** The status callback URL is:

```
https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-notify/status
```

`sendSms` posts directly to the Messages API with a bare `From` number — no Messaging Service — so the primary mechanism is the per-message `StatusCallback` parameter that the deployed code now sends. **Read the deployed `roybal-notify/index.ts` header block**: if it reads the URL from a secret rather than deriving it from `SUPABASE_URL`, set that secret now:

```bash
supabase secrets set TWILIO_STATUS_CALLBACK_URL="https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-notify/status" \
  --project-ref djpgvcvhvgrzgaziruze
```

Then set the same URL in the Twilio Console as a backstop, so a message sent by any path other than `sendSms` still settles: **Twilio Console → Phone Numbers → Manage → the company number → Messaging → Status callback URL**. Leave the existing "A message comes in" webhook pointing at `…/roybal-notify/inbound` — do not overwrite it. Also fix the doc drift while you are here: `supabase/config.toml:53-54` has claimed this handler existed since before it did; that claim is finally true.

**7c — reconcile the 174 historical rows.** Those rows predate the callback and will never receive one; their true status has to be fetched from Twilio once. Run the one-time reconcile the status-callback PR ships — its name and invocation are in the function header. If it is a cron-secret action:

```bash
curl -s -X POST 'https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-notify' \
  -H 'apikey: sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4' \
  -H 'Authorization: Bearer sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4' \
  -H 'x-cron-secret: <CRON_SECRET>' \
  -H 'Content-Type: application/json' \
  --data '{"action":"reconcileStatuses"}'
```

**Verify.**

1. From the board or the field app, send yourself one test text.
2. Within a minute:

```sql
select twilio_sid, status, updated_at
  from public.sms_messages
 where direction = 'outbound'
 order by created_at desc limit 1;                -- expect 'delivered'
```

3. Idempotency — the property the pure module exists for. In the Twilio Console, find that message and re-deliver the webhook (Monitor → Logs → Messaging → the message → the callback attempt). The row must stay `delivered`. If the console makes that awkward, POST the same callback body twice by hand; the second must be a no-op.
4. The backlog:

```sql
select status, count(*) from public.sms_messages
 where direction = 'outbound' group by 1 order by 2 desc;
```

`queued` should collapse toward zero, replaced mostly by `delivered` with a few `undelivered`/`failed`. **Those failures are real information you have never had** — texts you believed went out and did not. Read the `undelivered` rows before moving on.

**Roll back.** Clear the Twilio Console status callback field and revert + redeploy `roybal-notify`. Rows stop settling and freeze at `queued` again — which is exactly where they have been for months. Reconciled rows keep their true statuses; there is nothing to undo about learning the truth.

---

### Step 8 — Delete Magicplan *(your hands only for the delete and the secrets)*

**Why here.** It touches nothing else. Doing it last among the code changes means a mistake here cannot complicate the diagnosis of anything above.

**Why at all.** `magicplan-proxy` is an unauthenticated public relay into the vendor account holding a paid key, with zero callers anywhere in `apps/`, `services/` or `.github/`. It is not a latent risk; it is an open door with a company credit card behind it.

**Do.**

```bash
# 1. the code side is already in the PR (two directories deleted, two config.toml pins removed)
git log --oneline -1        # confirm the magicplan removal commit is on main

# 2. remove the deployed functions — these live in Supabase, not in the repo,
#    and deleting the directory does NOT undeploy them
supabase functions delete magicplan-proxy   --project-ref djpgvcvhvgrzgaziruze
supabase functions delete magicplan-webhook --project-ref djpgvcvhvgrzgaziruze

# 3. unset the secrets — until this runs, the key is still on the platform
supabase secrets unset MAGICPLAN_API_KEY MAGICPLAN_CUSTOMER_ID MAGICPLAN_WEBHOOK_SECRET \
  --project-ref djpgvcvhvgrzgaziruze
```

Then, outside this system: **revoke the API key in the Magicplan account itself.** Unsetting the Supabase secret removes our copy; it does not invalidate the key. If it leaked at any point in the months it sat behind an unauthenticated endpoint, only revocation closes it.

**Verify.**

```bash
supabase functions list --project-ref djpgvcvhvgrzgaziruze
# expect exactly 12: gmail-proxy, qb-time-proxy, qbo-proxy, roybal-ai-ingest,
# roybal-ai-narrative, roybal-ai-office, roybal-brief, roybal-lead,
# roybal-notify, roybal-portal, roybal-voice, roybal-web-agent

supabase secrets list --project-ref djpgvcvhvgrzgaziruze | grep -i magicplan   # expect nothing

curl -s -o /dev/null -w '%{http_code}\n' \
  https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/magicplan-proxy        # expect 404
```

Nothing in any app should change. The era-0 `floor_plans` / `canvas_plans` tables and the two public buckets holding March objects stay where they are — cleaning those up is P1's business, not E0's.

**Roll back.** `git revert` the removal commit restores both directories and both `config.toml` pins; `supabase functions deploy magicplan-proxy` / `magicplan-webhook` redeploys them; re-set the secrets from the Magicplan account. Nothing depends on them, so a rollback here would only ever be because Magicplan is being revived on purpose.

---

### Step 9 — Arm `min_field_build` *(your hands only — and wait a day first)*

**Why last, and why you wait.** The gate compares each device's reported build against a floor and raises `P0002` ("update required") below it. Arming it before the fleet has had a chance to pick up `v166` would refuse writes from devices whose only sin is not having reloaded yet. Give it **a full working day** after Step 2's deploy, then read the telemetry before you touch anything.

**Do — first look:**

```sql
select user_id, build, last_seen from public.sync_clients order by build;
```

**Then set the floor to `165` — one below the current build:**

```sql
update public.app_settings set value = to_jsonb(165) where key = 'min_field_build';
```

**Why 165 and not 166.** The floor is compared against `config.js BUILD`, which is baked into the page a device is *currently running*, not the cache it is about to install. A service worker needs a load to install and a second load to activate, so there is always a window — sometimes a long one on a tablet parked open on a job site — where a device is on the previous build and perfectly healthy. Setting the floor to the build you just shipped closes that window on the whole fleet at once: a tech mid-job with unsynced offline work gets `update required` and cannot push until they have signal, reload twice and let the worker activate. That turns a stale-device catch into a deploy-day outage, every deploy. One below current blocks only devices that have genuinely fallen behind a release, which is what the gate is for.

**Why not lower, either.** The roadmap's [A-7.2] says 163, written before the v166 lockstep fix existed. 163 would let the `v165` devices through — fine — but it would *also* let through anything from 163 up, and the two stale devices at `v155` and `v153` are the actual target: they predate fixes in the merge and tombstone path and are the class of client the gate was built for. 165 catches both of them and inconveniences nobody current.

**Verify.** Within a day:

```sql
select user_id, build, last_seen from public.sync_clients order by build;
-- expect six rows, all v165 or higher
```

The two stale devices should show `v166` after their users see the "update required" message once and reload. If a device stays stale for more than a day, its user is not opening the app — call them; the gate has done its job by telling you.

Also confirm nobody is stuck: no crew complaint about sync failing, and pushes continuing across the fleet (`sync_clients.last_seen` moving, `blob_history` still gaining rows).

**Roll back — instant, one statement:**

```sql
update public.app_settings set value = to_jsonb(0) where key = 'min_field_build';
```

That disarms the gate entirely (`_sync_guard` skips the comparison when the floor is 0). This is the cheapest rollback in E0 — if a crew reports "update required" and cannot get past it, run this first and diagnose afterwards.

---

### Step 10 — Cron secrets: read §4 and decide

This is the item that is **not** getting finished in E0. See §4 for why, what the exposure actually is, and what you may choose to do about it today.

---

## 4. The one E0 item that is safe to defer to P1 — say so plainly

**Item:** "Cron secrets out of `cron.job`" (roadmap §7.2).

**The exposure, stated honestly.** Seven of the nine live pg_cron jobs call `net.http_post`, and each one carries the `x-cron-secret` **and** the publishable key as literal text inside its `cron.job.command` string **(live)**. Anyone who can `select command from cron.job` reads the cron secret in plain text. Three migrations in the repo — `233_portal_crew_lines.sql:45-51`, `236_clockin_crew_line.sql:38-43`, `244_crew_digest_cron.sql:33-38` — scrape those literals back out of the live `morning-brief` row to register new jobs, which is why the pattern has replicated instead of being fixed. The `vault` extension is installed and completely unused (`grep vault. ` across migrations and functions: zero hits).

**Who can actually read it — check this before you decide.** The exposure's size depends entirely on who holds `select` on `cron.job`, and that was **not verified live** during the review. Run this first:

```sql
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema = 'cron' and table_name = 'job';
select has_schema_privilege('anon','cron','usage')          as anon_usage,
       has_schema_privilege('authenticated','cron','usage') as auth_usage,
       has_schema_privilege('service_role','cron','usage')  as service_usage;
```

If `anon` or `authenticated` come back true, **stop reading this section and do the rotation today** — that would make the cron secret reachable from a browser and this stops being a deferrable item. The expected answer is false for both, leaving the readers as `postgres` and whoever has dashboard SQL Editor access: a population that already holds credentials strictly more powerful than the cron secret. **That is the entire argument for deferring** — the secret is exposed to people who could already do everything it authorizes and more. On that answer it is a defence-in-depth failure, not an open door, unlike `magicplan-proxy` (Step 8), which genuinely was one.

**The E0 mitigation, if you want it now.** Rotate `CRON_SECRET` to a new value, store the new value and the publishable key in Vault (`vault.create_secret`), and re-register each of the seven jobs with a SQL wrapper that reads `vault.decrypted_secrets` at call time instead of embedding literals. The rewrite mechanics are already proven: `237_cron_keys_new_format.sql` on the unmerged branch `crm/clockin-crew-line` (commit `9b32807`) walks `cron.job where command like '%net.http_post%'` and rewrites each command in place with `cron.alter_job`. That migration is also the one that rewrote these headers after the 2026-08-14 legacy-JWT-key sunset, so it is the file to read before writing a new one.

**The trade-off.** Doing it in E0 means touching all seven scheduled jobs in one migration, including the two that are currently your only automation heartbeat and the three that text crews and the owner. A mistake there is silent — `cron.job_run_details` reports every `net.http_post` job as "succeeded" regardless, and `net._http_response` is purged after about six hours, so a broken cron job looks exactly like a working one for a day. That is precisely the failure mode that let the Gmail lane die unnoticed for five days. Spending E0's remaining risk budget on rewriting the cron layer, in the same two weeks you are also rotating two OAuth credentials and changing auth on three proxies, buys a defence-in-depth improvement at the cost of the observability you are trying to establish.

**The recommendation.** **Defer to P1, and do the cheap half now.** In P1, pg_cron stops calling HTTP altogether — every job becomes a SQL-only `jobs_queue` insert, with exactly one documented exception (the dead-worker `/alert` check, which keeps a Vault wrapper by design). At that point the cron secret and the publishable-key-as-credential do not move to Vault, they **cease to exist as a caller identity**: the five identity conventions collapse to two. Rewriting seven job commands in E0 is work that P1 deletes.

The cheap half you should do now, in Step 10, is a **rotation without a re-architecture** — run the `9b32807` recipe with a freshly generated `CRON_SECRET`, so that whatever value has been sitting in `cron.job.command` since August is no longer the live one:

```bash
# 1. generate and set the new secret
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)" --project-ref djpgvcvhvgrzgaziruze
```

```sql
-- 2. rewrite the seven job commands in place (the 9b32807 pattern), then:
select jobname, schedule from cron.job order by jobname;
```

**Verify.** Every HTTP lane still runs: within one cycle of each schedule, `integration_health_v0` stays green on all three lanes, a `qb-clockin-sweep` cycle writes, and the next morning brief arrives. **Roll back:** re-set `CRON_SECRET` to the previous value and re-run the rewrite with the old literal — keep the old value until you have watched a full 24-hour cycle including the 14:00 and 15:00 UTC jobs.

**Mark it in the tracker as deferred, not done.** When someone asks in six weeks whether E0 closed the cron-secret finding (F-051), the answer is: *no — the secret was rotated, the structural fix is P1's replacement of the HTTP cron layer.*

---

## 5. Your hands only — the short list

Everything an agent, a script or CI cannot do, in one place. If you read nothing else, read this.

| # | What | Where | Why nobody else can |
|---|---|---|---|
| 1 | **Reconnect Gmail** | admin → Settings → Gmail card → Disconnect, Connect, approve both scopes | Google's consent screen needs an interactive session as you. No service account, no headless path. |
| 2 | **Reconnect QuickBooks Time** | admin → Settings → QB Time card → Disconnect, Connect, approve | Same: Intuit/TSheets consent screen. |
| 3 | **Set the Twilio StatusCallback URL** | Twilio Console → Phone Numbers → the company number → Messaging → Status callback URL = `https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-notify/status` | Twilio Console credentials. Do not overwrite the inbound webhook. |
| 4 | **Delete the two deployed Magicplan functions** | `supabase functions delete magicplan-proxy` / `magicplan-webhook` | Deleting the directory does not undeploy the function. Requires a CLI session logged into the project. |
| 5 | **Unset `MAGICPLAN_*` and revoke the key** | `supabase secrets unset …`, then the Magicplan account itself | The platform secret store and the vendor account are both outside the repo. |
| 6 | **Arm `min_field_build`** | SQL Editor: `update public.app_settings set value = to_jsonb(165) where key = 'min_field_build';` | It is app state, not code. And it needs a day of telemetry judgement first. |
| 7 | **Decide the cron-secret question** | §4 | It is a risk decision, not a technical one. |

---

## 6. What changed for the crews and the office

*One screen. Print it, or paste it into the crew thread.*

> **Nothing you do changes.**
>
> **Crews:** the app works exactly as it did. If your tablet or phone is running an old version, you will see **"update required"** once — close the app, open it again, and you are current. That message means the app is protecting your work, not losing it. Two devices in the fleet are behind; everyone else will never see it. Your photos, forms, moisture maps and drying logs sync the same way, on the same schedule, into the same job.
>
> **Office:** two things get better and neither needs a new habit.
>
> 1. **The Job Board proposes phases again.** It has been silent since late July — not because it had nothing to say, but because three old suggestions from July 25th got stuck "waiting for an answer" and jammed the queue behind them. They are cleared, and the queue now expires suggestions on its own so it cannot jam again. Expect the board to start offering phase matches on unmatched hours within a day or two of the QuickBooks Time reconnect.
>
> 2. **The Gmail and QuickBooks Time cards go green — and mean it.** The Gmail card has been showing "● Connected" since September 1st while the email lane was completely dead; five days of job email went unmatched. Both lanes are reconnected. More importantly, if either one dies again, the owner gets a text within fifteen minutes instead of nobody noticing for five days.
>
> **One thing you can now trust that you could not before:** when the system says a text was sent, it now knows whether it actually arrived. Delivery status used to stop at "we handed it to the phone company." Some texts we believed went out did not. From now on, a text that fails is a text we know failed.
>
> **What does not change:** no new screens, no new logins, no new steps, no change to how jobs, invoices, packets or the portal work.

---

## 7. Close-out — the sweep that says E0 is done

Run all of it in one sitting, a day after Step 9.

```sql
-- 1. every lane alive and honest
select * from public.integration_health_v0;

-- 2. no jam, and it cannot re-jam
select count(*) filter (where status='pending' and expires_at < now()) as zombies,
       count(*) filter (where status='pending' and expires_at > now()) as live
  from public.pending_actions;

-- 3. texts settle
select status, count(*) from public.sms_messages
 where direction='outbound' and created_at > now() - interval '7 days' group by 1;

-- 4. the fleet is current
select build, count(*) from public.sync_clients group by 1 order by 1;

-- 5. the floor is armed
select value from public.app_settings where key = 'min_field_build';   -- 165

-- 6. the ledgers are insert-only for crews
select relname, polname, polcmd from pg_policy join pg_class on pg_class.oid = polrelid
 where relname in ('ai_usage','capture_events','time_entries') order by 1,2;

-- 7. the retention job exists
select jobname, schedule from cron.job order by jobname;
```

```bash
# 8. twelve functions, no Magicplan
supabase functions list --project-ref djpgvcvhvgrzgaziruze

# 9. the public key opens nothing it should not
BASE=https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1
PUB=sb_publishable_67P68AjuAtK5z649liJg1w_ZPhh_Ud4
curl -s -o /dev/null -w 'qbtime  %{http_code}\n' -X POST "$BASE/qb-time-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" -H 'Content-Type: application/json' \
  --data '{"action":"getTimesheets"}'
curl -s -o /dev/null -w 'gmail   %{http_code}\n' -X POST "$BASE/gmail-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" -H 'Content-Type: application/json' \
  --data '{"action":"getStatus"}'
curl -s -o /dev/null -w 'qbo     %{http_code}\n' -X POST "$BASE/qbo-proxy" \
  -H "apikey: $PUB" -H "Authorization: Bearer $PUB" -H 'Content-Type: application/json' \
  --data '{"action":"pushInvoice"}'
```

**Done means:** all three lanes `ok`; zero zombies; last week's texts settled, not `queued`; six devices at `v166`; the floor at 165; the ledgers insert-only; twelve functions; three 401s; `main` green in the Actions tab; and the board has proposed at least one phase since the reconnect.

**And one item honestly open:** the cron secret still lives as literal text inside `cron.job.command` (rotated, if you did §4's cheap half). It closes in P1 when pg_cron stops calling HTTP.

---

## 8. What E0 does *not* do

So the next person — including you in three weeks — does not go looking for it.

No tables change shape. No packages are created. No blob key moves. There is no `proposals` table, no `events` table, no worker, no approvals inbox, no roles beyond the existing four-value enum, no staging database, and no replayable migration history. `integration_health_v0` is a view over what already exists and is **deliberately disposable** — P1 replaces it with the `integration_runs` table that every adapter call writes, and the `integration_health` view over `integration_runs ⋈ connections`, with a real alert rule (three consecutive failures, or no successful run in twice the expected cadence). `connections` carries `division_id` from its first migration, so a second division's lane is a row, not code.

E0 is repairs. P1 is the first structure. Do not let a green checklist here read as "the architecture is fixed."
