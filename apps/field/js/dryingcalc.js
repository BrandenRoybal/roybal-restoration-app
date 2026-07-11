/* ============================================================
   Roybal Field Forms — drying equipment sizing
   (IICRC WRT worksheets, US Imperial, rev 7.1.22 / 3.1.22)
   ------------------------------------------------------------
   Deterministic, adjuster-defensible math — the exact worksheet
   method taught in the WRT class:

   AIRMOVER & GALLONS CALCULATION WORKSHEET
     1. ONE airmover per affected room (both ranges)
     2. FLOOR: +1 per 50–70 sq ft of wet floor (÷70 low, ÷50 high)
        — floor only; lower 2 ft of walls included but not measured
     3. WALL & CEILING above 2 ft: +1 per 100–150 sq ft (÷150 low, ÷100 high)
     4. +1 per wall inset/offset greater than 18" (both ranges)
     Fractions round UP. Lower-walls-only losses (<24" migration, limited
     flooring): ONE airmover per 14 affected linear feet of wall —
     independent of the square-foot method, never combined with it.

   INITIAL DEHUMIDIFICATION FACTOR CHART
     Conventional refrigerant:  Class 1: 100 · 2: 40 · 3: 30 · 4: N/A
     Low Grain Refrigerant:     Class 1: 100 · 2: 50 · 3: 40 · 4: 40
     Desiccant (ACH):           Class 1: 1 · 2: 2 · 3: 3 · 4: 3
     Refrigerant: cu ft ÷ factor = PPD ÷ AHAM rating = units
     Desiccant:   cu ft × ACH ÷ 60 = CFM ÷ unit CFM rating = units
     (the desiccant formula also sizes AFDs / air scrubbers)

   Inputs come from the AI floor-plan takeoff (per-room SF + perimeter)
   plus the job's class/category and latest psychrometrics. Pure module,
   node-tested, works offline.
   ============================================================ */

export const DEHU_FACTORS = {
  conv: { "1": 100, "2": 40, "3": 30, "4": null },   // null = N/A per the chart
  lgr: { "1": 100, "2": 50, "3": 40, "4": 40 },
  desiccant: { "1": 1, "2": 2, "3": 3, "4": 3 },      // air changes per hour
};
export const DEHU_TYPE_LABELS = { conv: "Conventional refrigerant", lgr: "LGR", desiccant: "Desiccant" };
export const DEHU_SIZES = [70, 110, 130];             // common AHAM pints/day

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const up = (v) => Math.ceil(v - 1e-9);                // worksheet: fractions round up

/** Airmover worksheet. rooms: [{ name, floorSF, perimLF }] (affected only).
    upperWetSF: wet wall+ceiling area ABOVE 2 ft, all rooms combined.
    insets: wall insets/offsets > 18". lowerWallsOnly: the 14-LF rule. */
export function airmoverCalc({ rooms = [], upperWetSF = 0, insets = 0, lowerWallsOnly = false } = {}) {
  const rs = rooms.filter((r) => r && (num(r.floorSF) > 0 || num(r.perimLF) > 0));
  if (!rs.length) return null;
  const floorSF = Math.round(rs.reduce((t, r) => t + num(r.floorSF), 0));
  const perimLF = Math.round(rs.reduce((t, r) => t + num(r.perimLF), 0));
  if (lowerWallsOnly) {
    const n = Math.max(1, up(perimLF / 14));
    return {
      mode: "lowerWalls", low: n, high: n, floorSF, perimLF,
      basis: `Lower walls only (<24" migration): 1 per 14 affected LF of wall — ${perimLF} LF ÷ 14 (WRT worksheet)`,
    };
  }
  const perRoom = rs.length;                                    // step 1
  const floorLow = up(floorSF / 70), floorHigh = up(floorSF / 50);   // step 2
  const upSF = Math.round(num(upperWetSF));
  const upLow = upSF ? up(upSF / 150) : 0, upHigh = upSF ? up(upSF / 100) : 0;  // step 3
  const ins = Math.max(0, Math.round(num(insets)));             // step 4
  return {
    mode: "sqft",
    low: perRoom + floorLow + upLow + ins,
    high: perRoom + floorHigh + upHigh + ins,
    floorSF, perimLF, upperWetSF: upSF, insets: ins,
    basis: `1/room (${perRoom}) + wet floor ${floorSF} SF ÷70/÷50 (${floorLow}–${floorHigh})` +
      (upSF ? ` + wall/ceiling >2 ft ${upSF} SF ÷150/÷100 (${upLow}–${upHigh})` : "") +
      (ins ? ` + ${ins} inset/offset >18"` : "") + " (WRT worksheet)",
  };
}

/** Initial dehumidification. volume in cu ft. type: conv | lgr | desiccant.
    ahamPints for refrigerant units; cfmRating for desiccant units. */
export function dehuCalc({ volume = 0, waterClass, type = "lgr", ahamPints = 70, cfmRating = 500 } = {}) {
  const vol = Math.round(num(volume));
  if (!vol) return null;
  const cls = String(waterClass || "");
  const factor = (DEHU_FACTORS[type] || DEHU_FACTORS.lgr)[cls];
  const label = DEHU_TYPE_LABELS[type] || "LGR";
  if (factor == null && type === "conv")
    return { type, na: true, basis: `Conventional refrigerant is N/A for Class ${cls} (factor chart) — use LGR or desiccant` };
  if (type === "desiccant") {
    const cfm = up((vol * factor) / 60);
    const rating = num(cfmRating) || 500;
    return {
      type, ach: factor, cfm, units: Math.max(1, up(cfm / rating)), cfmRating: rating,
      basis: `${vol.toLocaleString()} cu ft × ${factor} ACH ÷ 60 = ${cfm} CFM ÷ ${rating}-CFM units (factor chart, Class ${cls})`,
    };
  }
  const ppd = up(vol / (factor || 50));
  const aham = num(ahamPints) || 70;
  return {
    type, pintsPerDay: ppd, units: Math.max(1, up(ppd / aham)), ahamPints: aham,
    basis: `${vol.toLocaleString()} cu ft ÷ ${factor} (${label}, Class ${cls}) = ${ppd} PPD ÷ ${aham}-pint AHAM units (factor chart)`,
  };
}

/** AFD / air scrubber sizing — the worksheet's desiccant formula, applied
    with the category's air-change target (Cat 3: 3–4 ACH practice; we use
    the desiccant chart's Class-style ACH by category). */
export function scrubberCalc({ volume = 0, waterCategory, cfmRating = 500 } = {}) {
  const vol = Math.round(num(volume));
  const cat = String(waterCategory || "");
  const ach = cat === "3" ? 4 : cat === "2" ? 2 : 0;
  if (!vol || !ach) return { count: 0, basis: "Not required for Cat 1 water" };
  const cfm = up((vol * ach) / 60);
  const rating = num(cfmRating) || 500;
  return {
    count: Math.max(1, up(cfm / rating)), ach, cfm,
    basis: `${vol.toLocaleString()} cu ft × ${ach} ACH ÷ 60 = ${cfm} CFM ÷ ${rating}-CFM AFDs (desiccant formula, Cat ${cat})`,
  };
}

/** Full sizing pass — orchestrates the worksheets + aux-heat check. */
export function equipmentCalc({
  rooms, waterClass, waterCategory, affT,
  ceiling = 8, dehuType = "lgr", dehuPints = 70, dehuCFM = 500,
  upperWetSF = 0, insets = 0, lowerWallsOnly = false,
} = {}) {
  const am = airmoverCalc({ rooms, upperWetSF, insets, lowerWallsOnly });
  if (!am) return null;
  const rs = (rooms || []).filter((r) => r && (num(r.floorSF) > 0 || num(r.perimLF) > 0));
  const volume = Math.round(rs.reduce((t, r) => t + num(r.floorSF) * (num(r.ceiling) || ceiling), 0));
  const dehu = dehuCalc({ volume, waterClass, type: dehuType, ahamPints: dehuPints, cfmRating: dehuCFM });
  const scrubbers = scrubberCalc({ volume, waterCategory });
  const t = parseFloat(affT);
  const heatKnown = Number.isFinite(t);
  const heat = heatKnown && t < 70;
  return {
    inputs: {
      rooms: rs.length, sf: am.floorSF, lf: am.perimLF, volume,
      waterClass: String(waterClass || ""), waterCategory: String(waterCategory || ""),
      affT: heatKnown ? t : null, ceiling, dehuType,
    },
    airMovers: am,
    dehu,
    scrubbers,
    heat: {
      needed: heat, known: heatKnown,
      basis: heatKnown
        ? (heat
          ? `Affected air ${t}°F — below the 70–90°F optimal drying range; add auxiliary heat (S500)`
          : `Affected air ${t}°F — inside the 70–90°F optimal drying range; no auxiliary heat needed`)
        : "No affected-air temperature logged yet — enter a psychrometric reading to evaluate heat",
    },
  };
}

/* Count what's actually deployed from the drying log's equipment rows,
   matching on the free-text type — for the recommended-vs-deployed line. */
export function deployedCounts(equipment) {
  const out = { airMovers: 0, dehus: 0, scrubbers: 0, heaters: 0 };
  for (const row of Array.isArray(equipment) ? equipment : []) {
    const t = String((row && row.type) || "").toLowerCase();
    if (!t) continue;
    if (/dehu/.test(t)) out.dehus++;
    else if (/scrub|hepa|negative\s*air|neg\.?\s+air|air\s*filtration|afd/.test(t)) out.scrubbers++;
    else if (/heat/.test(t)) out.heaters++;
    else if (/air\s*mover|mover|axial|centrifugal|velo|fan/.test(t)) out.airMovers++;
  }
  return out;
}
