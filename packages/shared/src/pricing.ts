/**
 * Roybal Restoration — Xactimate-style price catalog
 *
 * Default unit prices (in cents) for common water/fire/mold mitigation
 * line items, loosely following Xactimate category/selector conventions.
 * These are starting-point prices for interior Alaska — every invoice
 * line item remains fully editable, so adjust per job as needed.
 *
 * Used by:
 *  - the invoice editor's "Add from catalog" picker (web)
 *  - the AI invoice generator (passed to the ai-proxy edge function
 *    so generated line items use consistent codes and pricing)
 */

export interface CatalogItem {
  /** Xactimate-style code, e.g. "WTR-EXTC" */
  code: string;
  category: string;
  description: string;
  unit: string;
  /** Default unit price in cents */
  unit_price: number;
}

export const INVOICE_CATEGORY_LABELS: Record<string, string> = {
  WTR: "Water Mitigation",
  EQU: "Equipment Rental",
  DMO: "Demolition / Tear-Out",
  CLN: "Cleaning",
  TRT: "Treatments",
  HMR: "Hazardous Material",
  CON: "Contents",
  LAB: "Labor",
  DSP: "Disposal",
  OTH: "Other",
};

export const PRICE_CATALOG: CatalogItem[] = [
  // ---- Water mitigation -------------------------------------------------
  { code: "WTR-EXTC", category: "WTR", description: "Water extraction from carpeted floor", unit: "SF", unit_price: 125 },
  { code: "WTR-EXTH", category: "WTR", description: "Water extraction from hard surface floor", unit: "SF", unit_price: 95 },
  { code: "WTR-EXTHV", category: "WTR", description: "Heavy water extraction (Cat 2/3)", unit: "SF", unit_price: 175 },
  { code: "WTR-PADR", category: "WTR", description: "Remove wet carpet pad", unit: "SF", unit_price: 65 },
  { code: "WTR-CARL", category: "WTR", description: "Lift/detach carpet for drying", unit: "SF", unit_price: 55 },
  { code: "WTR-MAP", category: "WTR", description: "Moisture mapping / monitoring visit", unit: "EA", unit_price: 14500 },
  { code: "WTR-INSP", category: "WTR", description: "Initial loss inspection & documentation", unit: "EA", unit_price: 22500 },
  { code: "WTR-FLR-DRY", category: "WTR", description: "Inject-dry hardwood/subfloor system setup", unit: "EA", unit_price: 18500 },
  // ---- Equipment rental (per unit per day) --------------------------------
  { code: "EQU-DHM-L", category: "EQU", description: "LGR dehumidifier (per day)", unit: "Day", unit_price: 12500 },
  { code: "EQU-DHM-C", category: "EQU", description: "Conventional/refrigerant dehumidifier (per day)", unit: "Day", unit_price: 8500 },
  { code: "EQU-AMV", category: "EQU", description: "Air mover / axial fan (per day)", unit: "Day", unit_price: 3500 },
  { code: "EQU-NAFA", category: "EQU", description: "HEPA air scrubber / negative air machine (per day)", unit: "Day", unit_price: 12500 },
  { code: "EQU-HTR", category: "EQU", description: "Supplemental drying heater (per day)", unit: "Day", unit_price: 7500 },
  { code: "EQU-GEN", category: "EQU", description: "Portable generator (per day)", unit: "Day", unit_price: 15000 },
  // ---- Demolition / tear-out ----------------------------------------------
  { code: "DMO-DRY2", category: "DMO", description: "Tear out wet drywall — 2' flood cut, bag & remove", unit: "LF", unit_price: 385 },
  { code: "DMO-DRY4", category: "DMO", description: "Tear out wet drywall — 4' flood cut, bag & remove", unit: "LF", unit_price: 525 },
  { code: "DMO-DRYC", category: "DMO", description: "Tear out wet ceiling drywall, bag & remove", unit: "SF", unit_price: 215 },
  { code: "DMO-INS", category: "DMO", description: "Remove wet insulation, bag & dispose", unit: "SF", unit_price: 145 },
  { code: "DMO-CAR", category: "DMO", description: "Remove & dispose carpet and pad", unit: "SF", unit_price: 95 },
  { code: "DMO-LAM", category: "DMO", description: "Remove laminate/engineered flooring", unit: "SF", unit_price: 215 },
  { code: "DMO-VNL", category: "DMO", description: "Remove sheet vinyl / vinyl plank flooring", unit: "SF", unit_price: 165 },
  { code: "DMO-BSB", category: "DMO", description: "Remove baseboard / trim", unit: "LF", unit_price: 115 },
  { code: "DMO-CAB", category: "DMO", description: "Detach base cabinet (for drying access)", unit: "LF", unit_price: 2850 },
  { code: "DMO-TOE", category: "DMO", description: "Drill/remove toe-kick for cavity drying", unit: "LF", unit_price: 450 },
  // ---- Cleaning -----------------------------------------------------------
  { code: "CLN-FIN", category: "CLN", description: "Final cleaning of affected area", unit: "SF", unit_price: 55 },
  { code: "CLN-HEPA", category: "CLN", description: "HEPA vacuuming of affected surfaces", unit: "SF", unit_price: 85 },
  { code: "CLN-WIPE", category: "CLN", description: "Damp wipe / detail clean surfaces", unit: "SF", unit_price: 75 },
  { code: "CLN-SOOT", category: "CLN", description: "Soot/smoke residue cleaning (dry sponge)", unit: "SF", unit_price: 115 },
  { code: "CLN-DEOD", category: "CLN", description: "Deodorization treatment (thermal fog/ozone)", unit: "SF", unit_price: 45 },
  // ---- Treatments -----------------------------------------------------------
  { code: "TRT-ANTI", category: "TRT", description: "Apply antimicrobial agent to affected surfaces", unit: "SF", unit_price: 45 },
  { code: "TRT-SEAL", category: "TRT", description: "Seal/encapsulate framing or subfloor", unit: "SF", unit_price: 135 },
  // ---- Hazardous material / mold -------------------------------------------
  { code: "HMR-CONT", category: "HMR", description: "Containment barrier — poly & tape", unit: "SF", unit_price: 125 },
  { code: "HMR-ZIP", category: "HMR", description: "Zipper door for containment", unit: "EA", unit_price: 8500 },
  { code: "HMR-MOLD", category: "HMR", description: "Mold remediation — remove affected material (per SF surface)", unit: "SF", unit_price: 485 },
  { code: "HMR-PPE", category: "HMR", description: "PPE — full protective gear (per person per day)", unit: "EA", unit_price: 6500 },
  // ---- Contents -------------------------------------------------------------
  { code: "CON-MAN", category: "CON", description: "Contents manipulation — move & reset (per room)", unit: "EA", unit_price: 12500 },
  { code: "CON-BLK", category: "CON", description: "Block & pad furniture in place", unit: "EA", unit_price: 4500 },
  { code: "CON-PACK", category: "CON", description: "Pack-out contents (per box, incl. materials)", unit: "EA", unit_price: 3500 },
  // ---- Labor ----------------------------------------------------------------
  { code: "LAB-TECH", category: "LAB", description: "Restoration technician labor", unit: "HR", unit_price: 9500 },
  { code: "LAB-SUP", category: "LAB", description: "Supervisor / project manager labor", unit: "HR", unit_price: 12500 },
  { code: "LAB-AFTH", category: "LAB", description: "Emergency after-hours service call", unit: "EA", unit_price: 27500 },
  // ---- Disposal --------------------------------------------------------------
  { code: "DSP-BAG", category: "DSP", description: "Debris bagging & haul to disposal", unit: "EA", unit_price: 950 },
  { code: "DSP-LOAD", category: "DSP", description: "Dump/transfer station fees & haul-off (per load)", unit: "EA", unit_price: 22500 },
];

/** Find a catalog item by its code */
export function getCatalogItem(code: string): CatalogItem | undefined {
  return PRICE_CATALOG.find((c) => c.code === code);
}
