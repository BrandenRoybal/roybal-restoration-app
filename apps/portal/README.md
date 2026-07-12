# Roybal Customer Portal (`portal.roybalconstruction.com`)

Read-only customer status page. A share link (`/j/<token>`) opens the job's
status, milestone timeline, and shared photos — no login. Served by the
`roybal-portal` edge function, which returns only the curated `portal_jobs`
slice for a valid token.

## Go-live (one-time)

1. **Deploy the gateway** (on the Mac):
   `supabase functions deploy roybal-portal --no-verify-jwt`
   (Uses the auto-injected `SUPABASE_SERVICE_ROLE_KEY` — no secrets to set.
   Requires migration `107_portal_jobs.sql` applied.)
2. **Vercel project** rooted at `apps/portal`:
   - New Vercel project → import this repo → **Root Directory: `apps/portal`**,
     Framework preset: **Other** (static; no build). `vercel.json` here handles
     the `/j/*` rewrite.
   - Add custom domain **`portal.roybalconstruction.com`**.
3. **DNS** at the registrar: add `CNAME portal → cname.vercel-dns.com`
   (Vercel shows the exact target when you add the domain).

Internal apps stay on GitHub Pages at `app.roybalconstruction.com` — untouched.
