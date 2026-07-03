# Roybal Restoration — Field Forms (PWA)

A dead-simple app your crew can use **on a phone or tablet, in the field, with no signal**.
It turns the Roybal form packet into fillable digital forms, captures signatures on the
device, and exports clean PDFs for the insurance carrier.

No login. No accounts. No backend to set up. Everything is saved on the device and works
100% offline.

---

## What it does

Enter the job details **once** (customer, address, claim #, carrier, loss category/class) and
that information flows automatically into every form. Then fill out any of the 7 packet forms:

| Form | Notes |
|---|---|
| 🗺️ **Moisture Map** | **Import a PDF or image floor plan** and draw right on top, drop numbered markers at each reading location, log daily MC% readings. Pick a material and the **IICRC dry goal auto-fills**; readings flag **🟢 green (dry) / 🔴 red (wet)** automatically. A **drying-trend line graph** plots each location's MC% over time against the dry-goal line. *(The daily driver.)* |
| 💧 **Drying Log** | Equipment runtime table + daily psychrometric readings. **GPP auto-calculates** from temp + RH and **grain depression** computes itself. Shows the **drying day count** and **flags any unit on site 7+ days** for the carrier. *(The other daily driver.)* |
| 📷 **Job Photos** | Before / during / after pictures with room + caption + auto timestamp; prints as a Photo Report. |
| 📦 **Contents** | Personal-property inventory + pack-out. Each item: photo(s), qty, category, **room**, **box**, **condition**, **disposition**, replacement value, brand/model/age. **Live ACV** (actual cash value after age depreciation). Non-salvageable items roll into a **Loss List** (RCV → depreciation → ACV totals) for the carrier. Pack-out **boxes** print labels with a **scannable QR code** + manifest. **Pack-back checklist** with homeowner sign-off receipt. **CSV export** of the whole inventory. |
| ✍️ **Work Authorization** | Sign right on the screen (owner + Roybal rep) **or** snap a photo / upload a wet-signed paper copy. |
| 📋 **Daily Construction Log** | Crew, tasks, start/finish times → hours total themselves. |
| ✅ **Certificate of Drying** | IICRC S500 dry-standard verification table + 3-way sign-off (tech / owner / adjuster). |
| 🔁 **Change Order** | Scope/supplement line items, schedule + financial impact, new contract total. |
| 🧾 **Mitigation Invoice** | Line items, deductible, previous payments, tax → total due. |

Every form has a **“Save as PDF”** button that produces a branded, letter-size document
matching the paper packet. The job home also has a **“Full job packet (PDF)”** button that
stacks every completed form into one document for carrier submission, and a **Share** button
to send a quick job summary.

---

## Run it locally

From the repo root:

```bash
npm run field        # serves at http://localhost:4173
```

or directly:

```bash
cd apps/field && node serve.mjs
```

It's plain static files (HTML/CSS/JS) — no build step.

### Test

```bash
npm run field:test   # headless DOM smoke test of all 7 forms
```

---

## Put it on your crew's phones

Because it's a PWA, deploy the `apps/field/` folder to any static host and have techs open
the URL once, then **Share → “Add to Home Screen.”** It then launches like a native app and
runs offline.

**Vercel (easiest):** new project → set **Root Directory** to `apps/field`, framework
**“Other,”** no build command, output directory `apps/field`. Done.

> iOS note: Android/Chrome installs the custom app icon automatically. iOS “Add to Home
> Screen” works too; to get a polished icon on iOS, drop a 180×180 PNG at
> `assets/icon-180.png` and point `apple-touch-icon` at it in `index.html`.

---

## How the data lives

- Saved to the device with **IndexedDB** (survives closing the app / losing signal).
- Nothing leaves the phone unless the tech exports a PDF and shares it.
- Each phone holds its own jobs. See "Suggested next steps" for syncing across the team.

---

## Done in this version

- ✅ **Floor-plan import** (PDF or image) as the Moisture Map background — draw markers on top
- ✅ **Auto dry-standard + red/green reading flags** (pick a material → goal auto-fills)
- ✅ **Drying day count + 7-day equipment flag**
- ✅ **Auto GPP + grain-depression** in the Drying Log
- ✅ **Project photos** (before/during/after) + printable Photo Report
- ✅ **Contents inventory + pack-out** (condition, disposition, rooms, boxes, loss list, box labels/manifest)
- ✅ **QR box labels · pack-back checklist + receipt · CSV export · ACV depreciation math**
- ✅ **Full job packet PDF** (every form stacked) + **Share** a job summary
- ✅ **Real Roybal branding** (icons / home-screen icon)

## Suggested next steps

1. **Cloud sync (optional).** This repo already has a Supabase backend in `apps/web`. We can
   add an optional "Sync to office" button so jobs/photos land in the admin dashboard and
   QuickBooks — while the field app keeps working offline-first.
2. **Attach the generated PDF directly to an email/share** (today: Save as PDF, then share
   from the OS; client-side PDF-file generation can be added with a small library).
3. **Scale/measure on the imported floor plan** (set a known dimension → auto area for scope).

---

*Roybal Construction, LLC · Roybal Restoration · North Pole, Alaska · IICRC WRT Certified*


---

## AI office features (photo analysis, invoice draft/audit, adjuster email)

Online-only enhancements layered over the always-available manual forms
(same rules as voice capture -- offline they degrade to a toast and never
block typed entry). All ride the same monthly spend cap + `ai_usage` ledger.

| Feature | Where |
|---|---|
| AI photo captions + damage/materials/safety analysis | Photos form -- auto on new photos, `AI captions (n)` catch-up button |
| Invoice draft from the documented job | Invoice form -- `Draft from documentation` (every line shows its basis) |
| Supplement audit (missed billables) | Invoice form -- `Find missed items`, one-tap add, each suggestion cites its evidence |
| Adjuster email draft | Narrative page -- `Adjuster email` (copy / open in mail app) |
| Drying Watch flags (no AI, rule-based) | Job list -- stale readings, areas not drying down, equipment out 7+ days |

Deploy (reuses the existing `LLM_API_KEY` secret):

```bash
supabase functions deploy roybal-ai-office --no-verify-jwt
```

Optional model overrides: `OFFICE_PHOTO_MODEL` (default `claude-haiku-4-5`),
`OFFICE_DOC_MODEL` (default `claude-sonnet-4-6`). Default prices live in
`js/pricing.js` -- adjust to your real rates.

## QuickBooks Online invoice push

Separate Intuit connection from QuickBooks Time (TSheets tokens can't call
the Accounting API). One-time setup:

1. In your Intuit Developer account, create (or extend) an app with the
   **Accounting** scope; register the office admin URL as a redirect URI.
2. Fill `QBO_CLIENT_ID` in `js/config.js`, then run migration
   `supabase/migrations/104_qbo_tokens.sql` and deploy the proxy:

   ```bash
   supabase functions deploy qbo-proxy
   supabase secrets set QBO_CLIENT_ID=... QBO_CLIENT_SECRET=... QBO_REDIRECT_URI=https://.../admin/
   ```
3. Office admin -> **Connect QuickBooks Online** (one time).

Then **Push to QuickBooks** on any invoice: the customer is matched or
created from the job header, line items carry over, and re-pushing after
edits updates the same QBO invoice (no duplicates).
