# Roybal Restoration — Field Documentation App

**Version 1.0** · Built for Roybal Construction, LLC / Roybal Restoration

A full-stack, monorepo field operations app for water damage mitigation, mold remediation, and fire/smoke restoration work in Fairbanks / North Pole, Alaska.

---

## Architecture

```
roybal-restoration-app/
├── apps/
│   ├── mobile/          # Expo (React Native) — iOS + Android field app
│   └── web/             # React + Vite + Tailwind — Admin dashboard
├── packages/
│   └── shared/          # Shared TypeScript types, services, PDF generators
└── supabase/
    ├── migrations/       # Postgres schema + RLS policies
    └── functions/        # Edge Functions (Magicplan webhook)
```

### Tech Stack

| Layer | Technology |
|---|---|
| Mobile | React Native + Expo SDK 51 |
| Web Admin | React 18 + Vite + Tailwind CSS |
| Backend | Supabase (Postgres + Auth + Storage) |
| Shared | TypeScript monorepo (`@roybal/shared`) |
| PDF Reports | @react-pdf/renderer |
| Offline | WatermelonDB + Expo SQLite |
| Floor Plans | Magicplan REST API + webhook |

---

## Prerequisites

1. **Node.js** (LTS) — https://nodejs.org
2. **Supabase account** — https://supabase.com (free tier works)
3. **Expo Go** app on your test device (iOS or Android)
4. **Magicplan account** (optional, for floor plan integration)

---

## Quick Start

```bash
# 1. Clone / navigate to the project
cd "roybal-restoration-app"

# 2. Run the setup script
chmod +x setup.sh
./setup.sh

# 3. Fill in your credentials
nano apps/mobile/.env
nano apps/web/.env

# 4. Run Supabase migrations (in the Supabase SQL Editor)
#    → paste contents of supabase/migrations/001_initial_schema.sql
#    → paste contents of supabase/migrations/002_storage.sql

# 5. Start the web admin
npm run web
# → Opens at http://localhost:5173

# 6. Start the mobile app
npm run mobile
# → Scan QR code with Expo Go app
```

---

## Environment Variables

### `apps/mobile/.env`
```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
EXPO_PUBLIC_MAGICPLAN_API_KEY=your-magicplan-api-key
EXPO_PUBLIC_MAGICPLAN_CUSTOMER_ID=your-magicplan-customer-id
```

### `apps/web/.env`
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_MAGICPLAN_API_KEY=your-magicplan-api-key
VITE_MAGICPLAN_CUSTOMER_ID=your-magicplan-customer-id
```

> **Security:** Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code.
> It's only used in the Supabase Edge Function environment.

---

## Supabase Setup

### 1. Database

Run the migrations in this order in the Supabase SQL Editor:

```
supabase/migrations/001_initial_schema.sql   ← Tables + RLS + triggers
supabase/migrations/002_storage.sql          ← Storage buckets + policies
supabase/migrations/003_qb_time.sql          ← QuickBooks Time integration
supabase/migrations/004_manual_floor_plan.sql ← Manual floor plan editor
supabase/migrations/005_ai_invoices.sql      ← AI photo analysis + narrative + invoices
supabase/migrations/006_photo_bucket_qbo.sql ← Photo bucket delete-policy fix + QBO invoicing columns
```

### 2. Auth

- Enable Email auth in Supabase → Authentication → Providers
- Invite admin (Branden) via Supabase Auth dashboard
- Set `role = 'admin'` in the `profiles` table for admin user

### 3. Magicplan Webhook

Deploy the Edge Function:

```bash
# Install Supabase CLI first: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref your-project-ref
supabase functions deploy magicplan-webhook

# Set secrets
supabase secrets set MAGICPLAN_API_KEY=your-key
supabase secrets set MAGICPLAN_CUSTOMER_ID=your-id
supabase secrets set MAGICPLAN_WEBHOOK_SECRET=your-secret
```

Configure the webhook in Magicplan's developer settings to POST to:
```
https://your-project.supabase.co/functions/v1/magicplan-webhook
```

### 4. AI Assistant (photo analysis, narrative, invoices)

Deploy the AI proxy Edge Function and set your Anthropic API key
(get one at https://platform.claude.com):

```bash
supabase functions deploy ai-proxy
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key
```

This powers three features (all server-side — the key is never exposed to clients):

1. **AI photo analysis** — photos are auto-captioned on upload (web + mobile),
   documenting visible damage, affected materials, equipment, and safety concerns
2. **AI job narrative** — writes an adjuster-ready loss narrative from all job
   documentation (editable, saved on the job, included in invoice PDFs)
3. **AI invoice generation** — drafts a complete Xactimate-style invoice from
   field data: equipment days, monitoring visits, floor-plan square footage,
   photo-documented demolition, and existing scope items
4. **Adjuster email drafting** — one-click claim-submission email from the
   Reports tab, addressed to the adjuster on file
5. **Supplement detection** — audits an invoice against the job documentation
   and flags documented-but-unbilled work

The dashboard also gains a rule-based **Drying Watch** panel (no AI cost):
flags active/drying jobs with stale readings, moisture not trending down,
or equipment on site 7+ days.

### 5. QuickBooks Online invoicing

Deploy the QBO proxy (reuses the QuickBooks Time OAuth app credentials):

```bash
supabase functions deploy qbo-proxy
```

The Settings page's **Connect QuickBooks** flow now requests both the Time and
Accounting scopes — if QuickBooks was connected before this feature existed,
disconnect and reconnect once. Then use **Push to QuickBooks** in any invoice
editor: the customer is matched/created from the property owner, line items
carry over with codes and room labels, and re-pushing updates the same QBO
invoice.

---

## Features

### Mobile App (Field Techs)

| Screen | Feature |
|---|---|
| **Job List** | All assigned jobs, filterable by status, searchable |
| **New Job** | Create jobs with loss type, category, owner, insurance info |
| **Job Detail** | Tabbed: Overview / Photos / Moisture / Equipment / Scope / Floor Plan |
| **Photo Capture** | Camera/gallery, GPS tagging, captions, organized by room + category |
| **Moisture Readings** | Per-room/location readings, IICRC color-coding, trend tracking |
| **Equipment Log** | Place/remove equipment, 7-day flag, days-on-site counter |
| **Scope Builder** | Xactimate-style line items, T&M + scope billing, running totals |
| **Floor Plan** | Synced from Magicplan, manual sync button, version history |
| **Offline** | WatermelonDB caches all data for field use without cell signal |

### Web Admin Dashboard

| Page | Feature |
|---|---|
| **Dashboard** | KPI cards: Active Jobs, Drying, Invoicing, Equipment, Open A/R |
| **Pipeline** | Kanban-style view by job status |
| **Jobs** | Full list with search + filter, click-through to detail |
| **Job Detail** | All modules: Overview, Photos, Moisture, Equipment, Scope, Invoices, Floor Plans, Reports |
| **Invoices** | Xactimate-style invoice builder — AI-drafted or manual, price catalog, editable line items, O&P/tax, PDF export |
| **AI Assistant** | Photo auto-captioning + damage analysis, adjuster-ready job narratives, invoice drafting |
| **Reports** | Generate PDF reports for carrier/adjuster submission |
| **Settings** | User management, company info, security overview |

### PDF Reports (5 types)

1. **Photo Report** — Photos by room + category with timestamps
2. **Moisture/Drying Report** — Daily readings + dry standard comparison + sign-off block
3. **Equipment Log** — Placement dates, locations, days on site
4. **Scope of Work / Invoice** — Line items, markup/overhead, grand total, signature block
5. **Invoice / Estimate** — Xactimate-style: catalog codes, room grouping, category recap, O&P + tax, optional narrative page

All PDFs: dark navy + safety orange branding, job number footer, Alaska time.

---

## User Roles

| Role | Access |
|---|---|
| `admin` | All jobs, all features, all users, reports, settings |
| `tech` | Only assigned jobs, mobile features, no settings |
| `viewer` | Read-only access (for adjusters, owners if needed) |

RLS is enforced at the database level — techs cannot see unassigned jobs even via API.

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

## Scripts

```bash
npm run web           # Start web admin dev server (port 5173)
npm run mobile        # Start Expo mobile dev server (port 8081)
npm run shared:build  # Build shared package
npm run setup         # Install + build everything
```

---

## Adding a New Tech

1. Invite them via Supabase Auth → Authentication → Users → Invite
2. They receive an email and set a password
3. Their profile is auto-created by the database trigger
4. Assign them to jobs via the web admin job detail page (assigned_tech_ids field)
5. They log in via the mobile app with their email/password

---

## File Structure Details

```
packages/shared/src/
├── types/index.ts          ← All TS types, enums, helpers (centsToDisplay, etc.)
├── services/magicplan.ts   ← MagicplanService API client
└── pdf/
    ├── styles.ts           ← PDF brand styles
    ├── components.tsx      ← Shared PDF components (header, footer, etc.)
    └── reports.tsx         ← 4 report documents (PhotoReport, MoistureDryingReport, etc.)

apps/mobile/app/
├── (auth)/login.tsx        ← Login screen
├── (tabs)/index.tsx        ← Job list
├── (tabs)/new-job.tsx      ← Create job
├── (tabs)/settings.tsx     ← Profile + sign out
└── job/[id]/
    ├── [id].tsx            ← Job detail (tabbed)
    ├── photos.tsx          ← Photo capture + gallery
    ├── moisture.tsx        ← Moisture readings
    ├── equipment.tsx       ← Equipment log
    ├── scope.tsx           ← Line item builder
    └── floorplan.tsx       ← Floor plan viewer

apps/web/src/pages/
├── LoginPage.tsx
├── DashboardPage.tsx       ← KPI cards + pipeline
├── JobsPage.tsx            ← Job list table
├── JobNewPage.tsx          ← Create job form
├── JobDetailPage.tsx       ← Full detail + all modules
└── SettingsPage.tsx        ← Users + security

supabase/
├── migrations/
│   ├── 001_initial_schema.sql  ← Tables, enums, RLS, triggers
│   └── 002_storage.sql         ← Storage buckets + policies
└── functions/magicplan-webhook/
    └── index.ts                ← Webhook handler (Deno)
```

---

## Support

For issues with this codebase, contact your developer or create an issue in the project repository.

For Supabase issues: https://supabase.com/docs
For Expo issues: https://docs.expo.dev
For Magicplan API: https://app.magicplan.app/api/docs

---

*Roybal Construction, LLC · Roybal Restoration · Fairbanks, Alaska*
