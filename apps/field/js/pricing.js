/* ============================================================
   Roybal Field Forms — price catalog (T&M in Xactimate format)
   ------------------------------------------------------------
   DEPRECATED as the estimating source (2026-07-13). Estimating now prices
   off the Supabase `price_list` table (Fairbanks Xactimate, 2,959 items),
   resolved server-side in the roybal-ai-office edge function. This small
   hardcoded catalog is no longer sent to the AI; kept only as a manual
   reference. See memory: fairbanks-price-list-db.
   ------------------------------------------------------------
   BILLING MODEL: labor is billed by the HOUR at $125/HR and is NEVER
   baked into unit prices (we use Xactimate's room-by-room line-item
   FORMAT, not its loaded pricing). Every logged QuickBooks Time hour
   must land on the invoice, divided into task-specific hourly lines
   justified by the crew's timesheet notes. Equipment rents per unit
   per day; materials & pass-through fees bill at their own prices.
   Every invoice line stays fully editable, so adjust per job.

   Used by the invoice "Draft from documentation" + "Find missed items"
   AI actions (the catalog rides along in the request) — and handy as
   a manual reference.
   ============================================================ */

export const LABOR_RATE = 125; // $/HR — Roybal Construction labor rate

export const PRICE_CATALOG = [
  // ---- Labor tasks (unit HR @ $125 — divide logged hours across these) ----
  { code: "LAB-INSP", description: "Initial loss inspection & documentation", unit: "HR", price: 125 },
  { code: "LAB-MAP", description: "Moisture mapping / monitoring visit", unit: "HR", price: 125 },
  { code: "LAB-EXT", description: "Water extraction", unit: "HR", price: 125 },
  { code: "LAB-DEMO", description: "Demolition / tear-out (drywall, flooring, trim, cabinets)", unit: "HR", price: 125 },
  { code: "LAB-DETC", description: "Detach & reset fixtures / appliances", unit: "HR", price: 125 },
  { code: "LAB-CLN", description: "Cleaning of affected areas", unit: "HR", price: 125 },
  { code: "LAB-TRT", description: "Antimicrobial / disinfectant application", unit: "HR", price: 125 },
  { code: "LAB-CONT", description: "Containment / dust barrier setup", unit: "HR", price: 125 },
  { code: "LAB-CON", description: "Contents manipulation / pack-out", unit: "HR", price: 125 },
  { code: "LAB-EQP", description: "Equipment setup, take down, and monitoring (hourly charge)", unit: "HR", price: 125 },
  { code: "LAB-GEN", description: "General mitigation labor", unit: "HR", price: 125 },
  { code: "LAB-SUP", description: "Supervisor / project manager", unit: "HR", price: 125 },
  // ---- Service / trip fees ----
  { code: "LAB-SVC", description: "Emergency service call - during business hours", unit: "EA", price: 222.58 },
  { code: "LAB-AFTH", description: "Emergency after-hours service call", unit: "EA", price: 275 },
  // ---- Equipment rental (per unit per day — no labor in these) ----
  { code: "EQU-DHM-L", description: "LGR dehumidifier (per 24 hour period)", unit: "Day", price: 125 },
  { code: "EQU-DHM-C", description: "Conventional dehumidifier (per 24 hour period)", unit: "Day", price: 85 },
  { code: "EQU-AMV", description: "Air mover (per 24 hour period)", unit: "Day", price: 35 },
  { code: "EQU-NAFA", description: "Negative air fan/Air scrubber (24 hr period)", unit: "Day", price: 70.75 },
  { code: "EQU-HTR", description: "Supplemental drying heater (per 24 hour period)", unit: "Day", price: 75 },
  { code: "EQU-GEN", description: "Portable generator (per 24 hour period)", unit: "Day", price: 150 },
  { code: "EQU-INJ", description: "Inject-dry floor drying system (per 24 hour period)", unit: "Day", price: 185 },
  { code: "EQP-DECON", description: "Equipment decontamination charge - per piece of equipment", unit: "EA", price: 46.35 },
  // ---- Materials & consumables (product only — install labor is hourly) ----
  { code: "MAT-CONT", description: "Containment barrier materials - poly & tape", unit: "SF", price: 0.45 },
  { code: "MAT-DCBP", description: "Dust control barrier - tension post (per day)", unit: "Day", price: 3.35 },
  { code: "MAT-ZIP", description: "Zipper door for containment", unit: "EA", price: 85 },
  { code: "MAT-FLRP", description: "Floor protection materials - heavy paper and tape", unit: "SF", price: 0.35 },
  { code: "MAT-ANTI", description: "EPA-registered antimicrobial (product, per SF treated)", unit: "SF", price: 0.2 },
  { code: "MAT-BAG", description: "Debris bags & disposal consumables", unit: "EA", price: 9.5 },
  { code: "MAT-PPE", description: "PPE - full protective gear (per person per day)", unit: "EA", price: 65 },
  { code: "MAT-PACK", description: "Pack-out boxes & packing materials (per box)", unit: "EA", price: 12 },
  // ---- Disposal / haul-off (pass-through fees incl. drive time) ----
  { code: "DSP-LOAD", description: "Haul debris - per pickup truck load - including dump fees", unit: "EA", price: 253.82 },
  { code: "DSP-TRLR", description: "Tandem axle dump trailer - per load - including dump fees", unit: "EA", price: 530.04 },
];
