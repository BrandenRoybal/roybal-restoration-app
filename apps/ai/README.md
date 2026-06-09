# Roybal Restoration — AI function (Vercel)

A tiny serverless function that generates the **construction/mitigation narrative**
and **scope of work** from a job's data, using Claude. The Anthropic API key lives
**only here** (server-side), never in the app.

`POST /api/generate` → `{ kind: "narrative" | "scope", summary: "<job text>" }` → `{ text }`

- Only **signed-in crew** can call it (it verifies the Supabase access token).
- CORS is locked to the office admin's origin.

## Deploy to Vercel (one time)

1. Go to **vercel.com → Add New → Project**, import `brandenroybal/roybal-restoration-app`.
2. **Root Directory:** `apps/ai`
3. **Framework Preset:** Other. No build command needed.
4. **Environment Variables** (Project Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` = your Anthropic API key (from console.anthropic.com)
   - `SUPABASE_URL` = `https://djpgvcvhvgrzgaziruze.supabase.co`
   - `SUPABASE_KEY` = your Supabase **publishable** key (same one the app uses)
5. **Deploy.** You'll get a URL like `https://roybal-ai.vercel.app`.
6. Send me that URL — I'll set `AI_ENDPOINT` in the app to
   `https://roybal-ai.vercel.app/api/generate` and the buttons go live.

## Cost
Each generation is a few cents (Claude Opus 4.8, ~2–4k input + ~1k output tokens).
Only the office uses it, on demand.

## Privacy
The job summary sent here includes customer/claim info (no photos). It goes to
Anthropic's API under your account to produce the text, and is not stored by this
function.
