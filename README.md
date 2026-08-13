# Roybal Construction — App Monorepo

**Built for Roybal Construction, LLC / Roybal Restoration** · Fairbanks / North Pole, Alaska

Field operations, office coordination, and customer-facing web for water damage mitigation,
mold remediation, fire/smoke restoration, and construction/remodel work.

---

## Architecture

```
roybal-restoration-app/
├── apps/
│   ├── field/           # ⭐ Offline-first Field Forms PWA — crew-facing, no login
│   ├── admin/           # Office admin — messages, QuickBooks/Gmail connections
│   ├── board/           # Job Board (digital whiteboard) — pipeline, crew, scheduling
│   ├── portal/          # Read-only customer status page (share link, no login)
│   └── site/            # Astro marketing site — www.roybalconstruction.com
├── services/
│   └── phone-agent/     # Fly-hosted voice/phone agent (Twilio)
├── supabase/
│   ├── migrations/      # Postgres schema + RLS policies
│   └── functions/       # Edge Functions (AI office, proxies, portal gateway, …)
├── design-system/       # Brand tokens + component reference
└── docs/                # Plans, runbooks, prototypes
```

All the crew- and office-facing apps are **plain HTML/CSS/JS served statically** — no build
step, no framework. The marketing site is the one exception (Astro).

### Tech Stack

| Layer | Technology |
|---|---|
| Field / Admin / Board / Portal | Vanilla JS + HTML, served static; IndexedDB for offline state |
| Marketing site | Astro 5 |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) |
| Phone agent | Node on Fly.io + Twilio |
| Floor plans | Magicplan REST API + webhook |

### Brand

Navy (`#0f1b2d`) + safety orange (`#f26a21`). See [`design-system/`](design-system/).

---

## Prerequisites

1. **Node.js** (LTS) — https://nodejs.org
2. **Supabase account** — https://supabase.com
3. **Supabase CLI** (to deploy edge functions) — https://supabase.com/docs/guides/cli

---

## Quick Start

```bash
cd "roybal-restoration-app"
chmod +x setup.sh
./setup.sh
```

Then start whichever app you're working on:

```bash
npm run field    # Field Forms PWA
npm run board    # Job Board
npm run site     # Marketing site (astro dev, port 4330)
```

`apps/admin` and `apps/portal` each have their own `serve.mjs`:

```bash
node apps/admin/serve.mjs
```

---

## Scripts

```bash
npm run field           # Start the field forms PWA
npm run field:test      # Field app test suite (25 test files)
npm run board           # Start the job board
npm run board:test      # Board scheduling engine tests
npm run site            # Start the marketing site dev server
npm run site:build      # Build the marketing site (+ parity checks)
npm run site:check-live # Check the live site against the build
npm run setup           # Install dependencies
```

---

## Deployment

**Field + Admin + Board** deploy together to GitHub Pages on every push to `main` that
touches `apps/field/**`, `apps/admin/**`, or `apps/board/**` — see
[`.github/workflows/deploy-field.yml`](.github/workflows/deploy-field.yml):

| App | URL |
|---|---|
| Field | https://app.roybalconstruction.com/ |
| Admin | https://app.roybalconstruction.com/admin/ |
| Board | https://app.roybalconstruction.com/board/ |

**Portal** — `portal.roybalconstruction.com`, served through the `roybal-portal` edge
function. See [`apps/portal/README.md`](apps/portal/README.md).

**Edge functions** deploy with the Supabase CLI:

```bash
supabase login
supabase link --project-ref your-project-ref
supabase functions deploy magicplan-webhook
```

**Phone agent** deploys to Fly from the repo root (the Dockerfile pulls shared files in at
their repo-relative paths, so the build context must be the root):

```bash
fly deploy --config services/phone-agent/fly.toml --dockerfile services/phone-agent/Dockerfile .
```

---

## Security

- Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code — it belongs only in the Edge
  Function environment, where Supabase injects it automatically.
- Magicplan and QuickBooks credentials live in Supabase secrets, not in the repo:
  ```bash
  supabase secrets set MAGICPLAN_API_KEY=your-key
  ```

---

## Moisture Dry Standards (IICRC S500)

| Material | Dry Standard |
|---|---|
| Drywall / Gypsum | ≤ 1% |
| Wood / Hardwood / Subfloor / OSB | ≤ 19% |
| Concrete / Slab | ≤ 4% |
| Generic | ≤ 16% |

Color coding: 🔴 Wet → 🟡 Monitoring → 🟢 Dry

---

## History

A React + Vite admin (`apps/web`), an Expo mobile app (`apps/mobile`), and a shared
TypeScript package (`packages/shared`) were the original 2026 architecture. All three were
abandoned in favor of the static, offline-first apps above and removed from the tree in
August 2026 — the code remains in git history if you ever need it.

---

## Support

For Supabase issues: https://supabase.com/docs
For Magicplan API: https://app.magicplan.app/api/docs

---

*Roybal Construction, LLC · Fairbanks, Alaska*
