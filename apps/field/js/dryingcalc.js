/* ============================================================
   Roybal Field Forms — drying equipment sizing (IICRC S500 math)
   ------------------------------------------------------------
   Deterministic, adjuster-defensible calculations — NOT an LLM guess.
   Inputs come from the AI floor-plan takeoff (room SF / perimeter LF)
   plus the job's water class/category and the latest psychrometrics;
   the math itself is the S500 initial-sizing method. Pure + node-tested.
   ============================================================ */

/* AHAM class factors (cubic feet per AHAM pint) for LGR dehumidifiers —
   IICRC S500 initial dehumidification sizing. */
export const DEHU_CLASS_FACTOR = { "1": 100, "2": 50, "3": 40, "4": 50 };

/* Common LGR sizes (AHAM pints/day) for the unit-size picker. */
export const DEHU_SIZES = [70, 110, 130];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/** Size the drying equipment for the affected rooms.
    rooms: [{ name, floorSF, perimLF, ceiling? }]  (affected rooms only)
    Returns null when there's nothing to size. */
export function equipmentCalc({ rooms, waterClass, waterCategory, affT, ceiling = 8, dehuPints = 70 } = {}) {
  const rs = (Array.isArray(rooms) ? rooms : [])
    .filter((r) => r && (num(r.floorSF) > 0 || num(r.perimLF) > 0));
  if (!rs.length) return null;

  const sf = Math.round(rs.reduce((t, r) => t + num(r.floorSF), 0));
  const lf = Math.round(rs.reduce((t, r) => t + num(r.perimLF), 0));
  const volume = Math.round(rs.reduce((t, r) => t + num(r.floorSF) * (num(r.ceiling) || ceiling), 0));

  // Air movers: one per 10–16 LF of affected wall (we use 13 LF), min 1 per room.
  const airMovers = rs.reduce((t, r) => t + Math.max(1, Math.ceil(num(r.perimLF) / 13)), 0);

  // Dehumidification: volume ÷ AHAM class factor = pints/day, then LGR units.
  const cls = String(waterClass || "");
  const factor = DEHU_CLASS_FACTOR[cls] || 50;
  const pintsPerDay = Math.ceil(volume / factor);
  const unitPints = num(dehuPints) || 70;
  const dehus = Math.max(1, Math.ceil(pintsPerDay / unitPints));

  // Air scrubbers (500 CFM units): Cat 3 = 4 ACH required; Cat 2 = 2 ACH
  // recommended during demo/aerosolizing work; Cat 1 = not required.
  const cat = String(waterCategory || "");
  const ach = cat === "3" ? 4 : cat === "2" ? 2 : 0;
  const scrubbers = ach ? Math.max(1, Math.ceil((volume * ach) / (500 * 60))) : 0;

  // Auxiliary heat: evaporation stalls below ~70°F affected-air temp
  // (S500 optimal drying range 70–90°F) — an Alaska staple.
  const t = parseFloat(affT);
  const heatKnown = Number.isFinite(t);
  const heat = heatKnown && t < 70;

  return {
    inputs: { rooms: rs.length, sf, lf, volume, waterClass: cls, waterCategory: cat, affT: heatKnown ? t : null, ceiling, unitPints },
    airMovers: {
      count: airMovers,
      basis: `1 per 10–16 LF of affected wall (13 LF used), min 1 per room — ${lf} LF across ${rs.length} room${rs.length === 1 ? "" : "s"} (S500)`,
    },
    dehu: {
      pintsPerDay, units: dehus, unitPints,
      basis: `${volume.toLocaleString()} cu ft ÷ ${factor} (Class ${cls || "?"} LGR factor) = ${pintsPerDay} pints/day ÷ ${unitPints}-pint units (S500/AHAM)`,
    },
    scrubbers: {
      count: scrubbers,
      basis: ach
        ? `${ach} ACH for Cat ${cat}: ${volume.toLocaleString()} cu ft × ${ach} ÷ 60 ÷ 500 CFM per unit (S500)`
        : "Not required for Cat 1 water (S500)",
    },
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
