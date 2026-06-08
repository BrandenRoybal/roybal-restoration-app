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
| 🗺️ **Moisture Map** | Finger-draw the affected area, drop numbered markers at each reading location, log daily MC% readings. *(The daily driver.)* |
| 💧 **Drying Log** | Equipment runtime table + daily psychrometric readings. **GPP is auto-calculated** from temp + RH, and **grain depression** computes itself. *(The other daily driver.)* |
| ✍️ **Work Authorization** | Sign right on the screen (owner + Roybal rep) **or** snap a photo / upload a wet-signed paper copy. |
| 📋 **Daily Construction Log** | Crew, tasks, start/finish times → hours total themselves. |
| ✅ **Certificate of Drying** | IICRC S500 dry-standard verification table + 3-way sign-off (tech / owner / adjuster). |
| 🔁 **Change Order** | Scope/supplement line items, schedule + financial impact, new contract total. |
| 🧾 **Mitigation Invoice** | Line items, deductible, previous payments, tax → total due. |

Every form has a **“Save as PDF”** button that produces a branded, letter-size document
matching the paper packet — ready to AirDrop, email, or attach to the claim.

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

## Suggested next steps (ideas that would help the most)

1. **Auto-fill the dry standard.** On the Moisture Map you pick a material — we can
   auto-set the IICRC dry goal (drywall ≤1%, framing ≤19%, etc.) and flag a reading
   red/green against it so a tech instantly sees what's still wet.
2. **"Days drying" + 7-day equipment flag.** Surface dry-out day count and warn when a unit
   has been on site over a week (carrier scrutiny threshold).
3. **One-tap full report.** Bundle Work Auth + Moisture Map + Drying Log + Cert into a single
   PDF packet per job for carrier submission.
4. **Cloud sync (optional).** This repo already has a Supabase backend in `apps/web`. We can
   add an optional "Sync to office" button so jobs/photos land in the admin dashboard and
   QuickBooks — while the field app keeps working offline-first if anyone wants the simple
   version.
5. **Email/share straight to the adjuster** from the job screen.
6. **Photo capture inside Moisture Map / Drying Log** with room + timestamp (camera hooks are
   already wired; we can expand organization).

---

*Roybal Construction, LLC · Roybal Restoration · North Pole, Alaska · IICRC WRT Certified*
