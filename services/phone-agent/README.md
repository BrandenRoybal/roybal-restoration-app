# Roybal phone agent — the after-hours receptionist (Phase 6)

The always-on Node service behind the company number's voice line. Twilio
answers the call and does streaming STT/TTS + barge-in (ConversationRelay);
this agent is pure text — the caller's words arrive over a WebSocket, Claude
streams the reply back, and Twilio speaks it. Same brain as the in-app
assistant: it imports the `personas.ts` registry (phone persona + narrow
phone toolset) and the board's pure `schedule.js` for real availability —
run LIVE (jobs + logged hours via `buildLiveOpts`), the same actuals-driven
schedule the board shows, not the pre-delay plan.

**Rollout stance: no-answer forwarding first.** The `roybal-voice` edge
function dials the owner's cell for ~15s on every call; the AI only takes
calls that would otherwise have been missed. If the agent is down or capped,
callers get voicemail — never a dead end.

```
caller → Twilio (+1 866 345-2290)
       → roybal-voice edge fn ─ Dial owner (15s) ─ answered? humans talk
       │                                        └ missed → ConversationRelay
       └ /action on session end ─ escalate → Dial owner ─ failed → voicemail
                     ↕ wss
              THIS AGENT (Fly.io)
              Claude + phone tools, machine JWT (RLS + deny policies)
```

## What it can and cannot do

- Tools: `lookupCaller` (caller-ID only, coarse), `availability` (board load,
  never promises slots), `createLead` (stage `lead`, flagged AI-booked, rev
  initialized), `textOwner` (company number, quiet-hours-exempt kind
  `phoneOwner`), `escalate` (live transfer toward the owner).
- Rate limits: 1 lead + 2 owner texts per call AND per caller-number per day.
- The machine user **cannot** UPDATE/DELETE board jobs or touch
  `field_projects` at all (restrictive RLS, migration 204) — a hijacked call
  is bounded to junk-lead inserts and its own log rows.
- Cost: every call writes `capture_events` (before any paid token) and an
  `ai_usage` row (tokens + call seconds + estimated voice cost) — it rides
  the same $50/mo cap as all AI, plus `VOICE_MINUTES_CAP` (default 300).
  Over either cap → the agent apologizes and hands off to voicemail.
- Retention: transcripts are **not persisted**. What remains after a call:
  the lead, the owner text, the usage row, and the envelope summary
  (turns/seconds/lead id).

## One-time setup (owner steps)

1. **Machine user** — Supabase Dashboard → Authentication → Users → Add user:
   email `phone-agent@roybalconstruction.com`, a strong password you choose,
   "Auto confirm" on. (Its rights are already fenced by migration 204.)
2. **Fly.io** — install flyctl, `fly auth signup` (~$2-5/mo for this VM).
   From the REPO ROOT:
   ```sh
   fly launch --no-deploy --copy-config --config services/phone-agent/fly.toml
   fly secrets set -a roybal-phone \
     SUPABASE_URL="https://djpgvcvhvgrzgaziruze.supabase.co" \
     SUPABASE_ANON_KEY="<the publishable key from apps/field/js/config.js>" \
     MACHINE_PASSWORD="<the password from step 1>" \
     LLM_API_KEY="<the same Anthropic key the edge functions use>" \
     PHONE_RELAY_TOKEN="<any long random string>" \
     OWNER_CELL="<your cell, e.g. 907xxxxxxx>"
   fly deploy --config services/phone-agent/fly.toml \
     --dockerfile services/phone-agent/Dockerfile --ha=false .
   ```
   (`--ha=false` = ONE machine, on purpose: the per-caller rate limits are
   in-memory, and one always-on shared-1x is plenty for a phone line.)
3. **Edge-function secrets** — Supabase Dashboard → Edge Functions → Secrets,
   add: `PHONE_AGENT_WSS` = `wss://roybal-phone.fly.dev/relay`,
   `PHONE_RELAY_TOKEN` = the same random string, `OWNER_CELL` = your cell.
   (`TWILIO_AUTH_TOKEN` already exists from the SMS lane.)
4. **Twilio console** — Phone Numbers → +1 866 345-2290 → Voice Configuration:
   "A call comes in" = Webhook,
   `https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-voice`,
   HTTP POST. (Leave Messaging exactly as it is — the SMS lane lives there.)
5. Call the number from another phone, let it ring past your cell, and talk
   to the receptionist. Watch `fly logs -a roybal-phone` on the first call.

## Day-2 ops

- `fly logs -a roybal-phone` — live call logs (no transcripts, just events).

### Troubleshooting: "it answers but can't hear me"

The greeting and the hearing are both Twilio's job (ConversationRelay does the
STT), so this symptom is almost never about audio — it's the agent's BRAIN
failing. If every Anthropic call errors (bad `LLM_API_KEY` paste, bogus
`PHONE_MODEL`), the agent used to answer each utterance with "could you say
that once more?", which callers experience as deafness. How to confirm and fix:

1. `fly logs -a roybal-phone` right after a deploy/restart — the boot probe
   prints either `LLM ready — <model> reachable with this key` or
   `LLM PROBE FAILED ...` with the HTTP status (401 = bad key, 404 = bad model).
   During a call, each failed turn logs `turn failed llm_failed (...)`.
2. In the database: `ai_usage` rows for the phone lane with `audio_seconds > 0`
   but `input_tokens = 0` mean the calls happened and the LLM never answered;
   the call's `capture_events.result.llmFails` counts the failures.
3. Fix: re-set the secret and restart —
   `fly secrets set -a roybal-phone LLM_API_KEY="<the working key>"`
   (secrets changes restart the machine; watch the probe line come up green).

Callers are protected meanwhile: the first LLM failure gets an honest
apology + retry, a second consecutive failure hands the call to voicemail.
- Kill switch: remove the Twilio voice webhook (calls ring straight through
  as before), or `fly scale count 0 -a roybal-phone` (callers then get
  voicemail via the edge function's failure path).
- Caps: `SPEND_CAP_USD`, `VOICE_MINUTES_CAP`, `VOICE_PRICE_PER_MIN`,
  `PHONE_MODEL` — all Fly secrets/env, restart to apply.

## Tests

`npm test` in this directory — a fake Twilio client drives a real WebSocket
against the server with Anthropic/Supabase stubbed: token gate, envelope
ordering, streaming, lead creation + rate limits, owner texting, escalation,
and tool-failure resilience.
