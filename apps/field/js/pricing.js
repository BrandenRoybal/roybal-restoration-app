/* ============================================================
   Roybal Field Forms — Xactimate-style price catalog
   ------------------------------------------------------------
   Default unit prices (DOLLARS) for common water/fire/mold mitigation
   line items, loosely following Xactimate category/selector codes.
   Starting-point pricing for Interior Alaska — every invoice line stays
   fully editable, so adjust per job.

   Used by the invoice "Draft from documentation" + "Find missed items"
   AI actions (the catalog rides along in the request so the model bills
   with consistent codes and prices) — and handy as a manual reference.
   ============================================================ */

export const PRICE_CATALOG = [
  // ---- Water mitigation ----
  { code: "WTR-INSP", description: "Initial loss inspection & documentation", unit: "EA", price: 225 },
  { code: "WTR-MAP", description: "Moisture mapping / monitoring visit", unit: "EA", price: 145 },
  { code: "WTR-EXTC", description: "Water extraction from carpeted floor", unit: "SF", price: 1.25 },
  { code: "WTR-EXTH", description: "Water extraction from hard surface floor", unit: "SF", price: 0.95 },
  { code: "WTR-EXTHV", description: "Heavy water extraction (Cat 2/3)", unit: "SF", price: 1.75 },
  { code: "WTR-PADR", description: "Remove wet carpet pad", unit: "SF", price: 0.65 },
  { code: "WTR-CARL", description: "Lift/detach carpet for drying", unit: "SF", price: 0.55 },
  { code: "WTR-FLR-DRY", description: "Inject-dry hardwood/subfloor system setup", unit: "EA", price: 185 },
  // ---- Equipment rental (per unit per day) ----
  { code: "EQU-DHM-L", description: "LGR dehumidifier (per day)", unit: "Day", price: 125 },
  { code: "EQU-DHM-C", description: "Conventional dehumidifier (per day)", unit: "Day", price: 85 },
  { code: "EQU-AMV", description: "Air mover / axial fan (per day)", unit: "Day", price: 35 },
  { code: "EQU-NAFA", description: "HEPA air scrubber / negative air (per day)", unit: "Day", price: 125 },
  { code: "EQU-HTR", description: "Supplemental drying heater (per day)", unit: "Day", price: 75 },
  { code: "EQU-GEN", description: "Portable generator (per day)", unit: "Day", price: 150 },
  // ---- Demolition / tear-out ----
  { code: "DMO-DRY2", description: "Tear out wet drywall — 2' flood cut, bag & remove", unit: "LF", price: 3.85 },
  { code: "DMO-DRY4", description: "Tear out wet drywall — 4' flood cut, bag & remove", unit: "LF", price: 5.25 },
  { code: "DMO-DRYC", description: "Tear out wet ceiling drywall, bag & remove", unit: "SF", price: 2.15 },
  { code: "DMO-INS", description: "Remove wet insulation, bag & dispose", unit: "SF", price: 1.45 },
  { code: "DMO-CAR", description: "Remove & dispose carpet and pad", unit: "SF", price: 0.95 },
  { code: "DMO-LAM", description: "Remove laminate/engineered flooring", unit: "SF", price: 2.15 },
  { code: "DMO-VNL", description: "Remove sheet vinyl / vinyl plank flooring", unit: "SF", price: 1.65 },
  { code: "DMO-BSB", description: "Remove baseboard / trim", unit: "LF", price: 1.15 },
  { code: "DMO-CAB", description: "Detach base cabinet (for drying access)", unit: "LF", price: 28.5 },
  { code: "DMO-TOE", description: "Drill/remove toe-kick for cavity drying", unit: "LF", price: 4.5 },
  // ---- Cleaning / treatments ----
  { code: "CLN-FIN", description: "Final cleaning of affected area", unit: "SF", price: 0.55 },
  { code: "CLN-HEPA", description: "HEPA vacuuming of affected surfaces", unit: "SF", price: 0.85 },
  { code: "CLN-DEOD", description: "Deodorization treatment (thermal fog/ozone)", unit: "SF", price: 0.45 },
  { code: "TRT-ANTI", description: "Apply EPA-registered antimicrobial to affected surfaces", unit: "SF", price: 0.45 },
  { code: "TRT-SEAL", description: "Seal/encapsulate framing or subfloor", unit: "SF", price: 1.35 },
  // ---- Containment / mold ----
  { code: "HMR-CONT", description: "Containment barrier — poly & tape", unit: "SF", price: 1.25 },
  { code: "HMR-ZIP", description: "Zipper door for containment", unit: "EA", price: 85 },
  { code: "HMR-MOLD", description: "Mold remediation — remove affected material", unit: "SF", price: 4.85 },
  { code: "HMR-PPE", description: "PPE — full protective gear (per person per day)", unit: "EA", price: 65 },
  // ---- Contents ----
  { code: "CON-MAN", description: "Contents manipulation — move & reset (per room)", unit: "EA", price: 125 },
  { code: "CON-BLK", description: "Block & pad furniture in place", unit: "EA", price: 45 },
  { code: "CON-PACK", description: "Pack-out contents (per box, incl. materials)", unit: "EA", price: 35 },
  // ---- Labor / service ----
  { code: "LAB-TECH", description: "Restoration technician labor", unit: "HR", price: 95 },
  { code: "LAB-SUP", description: "Supervisor / project manager labor", unit: "HR", price: 125 },
  { code: "LAB-AFTH", description: "Emergency after-hours service call", unit: "EA", price: 275 },
  // ---- Disposal ----
  { code: "DSP-BAG", description: "Debris bagging & haul to disposal", unit: "EA", price: 9.5 },
  { code: "DSP-LOAD", description: "Transfer station fees & haul-off (per load)", unit: "EA", price: 225 },
];
