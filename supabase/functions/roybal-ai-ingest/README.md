# roybal-ai-ingest

Online-only voice-capture brain (handoff **Step C**): audio → text → structured
candidate fields, written to `capture_events`, metered against a monthly spend cap
via the `ai_usage` ledger. **No API keys live in the client** — they are Supabase
function secrets, set with the commands below. Mirrors `magicplan-proxy` /
`qb-time-proxy`.

## Prerequisites (run once)

1. Apply the migrations in Supabase (SQL Editor → paste → Run), in order:
   - `supabase/migrations/200_ai_backbone.sql`  ✅ (already applied)
   - `supabase/migrations/201_ai_usage.sql`     ← the AI spend ledger this function writes
2. Supabase CLI logged in + project linked (CLI is installed locally as v2.75.0):
   ```sh
   supabase login                                  # opens a browser for an access token
   supabase link --project-ref djpgvcvhvgrzgaziruze
   ```

## Set the function secrets (never committed)

Replace each `<...>` placeholder with a real value. `STT_API_KEY` is only needed
for real audio — the function works in **transcript passthrough** mode without it.

```sh
# Anthropic (LLM extraction) — required
supabase secrets set LLM_API_KEY=<your-anthropic-api-key>

# Deepgram (speech-to-text) — get a free key at https://console.deepgram.com
# (new accounts get $200 credit / ~46k min, no card). Omit until you have one;
# transcript passthrough still works.
supabase secrets set STT_API_KEY=<your-deepgram-api-key>

# Optional — these have safe defaults baked into the function:
supabase secrets set SPEND_CAP_USD=50            # monthly hard ceiling (default 50)
supabase secrets set LLM_MODEL=claude-haiku-4-5  # default; cheap + strong for extraction
supabase secrets set STT_MODEL=nova-3            # Deepgram model (default)
# supabase secrets set STT_PRICE_PER_MIN=0.0043  # nova-3 PAYG; override if your rate differs
# supabase secrets set LLM_PRICE_IN=1.0          # $/1M input tokens (auto-set for known models)
# supabase secrets set LLM_PRICE_OUT=5.0         # $/1M output tokens
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically — do not set them.

## Deploy

```sh
supabase functions deploy roybal-ai-ingest --no-verify-jwt
```

`--no-verify-jwt` is REQUIRED: the field app calls this from the browser, and the
CORS preflight (OPTIONS) carries no token, so Supabase's platform JWT gate would
reject it (CORS error). The function does its OWN auth instead — it requires the
`Authorization: Bearer <user token>` header and all DB access runs under RLS with
that forwarded token, so disabling the platform gate does not weaken security.

## Test it

The function URL is `https://<project-ref>.functions.supabase.co/roybal-ai-ingest`
(here: `https://djpgvcvhvgrzgaziruze.functions.supabase.co/roybal-ai-ingest`).
Calls require a signed-in user's bearer token (the field app sends it automatically).
Get a token quickly from the browser console while signed into the field app:
`JSON.parse(localStorage['roybal-session']).access_token`.

**1. Transcript passthrough (no audio, no STT spend) — proves extraction:**
```sh
TOKEN=<paste access_token>
curl -s -X POST \
  https://djpgvcvhvgrzgaziruze.functions.supabase.co/roybal-ai-ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "form_key": "dryingLogs",
    "captured_by": "Branden",
    "water_category": "3",
    "transcript": "Affected area is 72 degrees, 55 percent humidity. Outside 38 and 70. Two air movers and one LGR dehumidifier in the living room, placed today."
  }' | jq
# Expect: { ok:true, capped:false, capture_event_id, transcript, candidates:{ psychrometric:[...], equipment:[...] }, spend:{...} }
```

**2. Real audio (needs STT_API_KEY):** base64-encode a short clip and send as `audio`:
```sh
B64=$(base64 -i sample.webm)
curl -s -X POST https://djpgvcvhvgrzgaziruze.functions.supabase.co/roybal-ai-ingest \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"form_key\":\"dryingLogs\",\"captured_by\":\"Branden\",\"audio_mime\":\"audio/webm\",\"audio\":\"$B64\"}" | jq
```

**3. Cap behavior:** temporarily set `supabase secrets set SPEND_CAP_USD=0.0001`,
redeploy, and repeat test 1 → expect `{ ok:true, capped:true }` and a fallback to
manual entry in the app. Reset the cap afterward.

## Request / response contract

See the header comment in `index.ts`. Candidate shapes mirror
`apps/field/js/ai.js` (`candidateChips`), which maps them onto `model.js` fields
for write-back in Step D.
