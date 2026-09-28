/**
 * Line-item pricing — the pure half of roybal-ai-office's estimating (no
 * Deno, no network, Node-testable: pricing.test.mjs).
 *
 * The model drafts scope and tags each line with the Xactimate
 * category + code + priceBasis it is billing; resolveLines() then stamps the
 * AUTHORITATIVE unit price from public.price_list (the Fairbanks sheet), so
 * prices come from the sheet, never the model. Two pricing modes:
 *   piecework — unit price carries labor+material: replace_price (put-back),
 *               remove_price (demo/tear-out) or detach_reset_price (D&R).
 *   tm        — labor bills hourly at the trade's LAB rate (× hours); materials,
 *               equipment and pass-throughs are estimated.
 *
 * The XACTIMATE REFERENCE tier (owner decision 2026-09-28): the owner's own
 * past Xactimate estimates, summarised per category + code + activity + unit
 * in public.xact_ref_prices (loaded out of band, never committed — the repo
 * is public). It is a FALLBACK only:
 *   - only on a piecework insurance-claim estimate (never T&M, never a
 *     construction job, never an old batch whose kind is unknown);
 *   - only after the catalog missed (no row, or the needed column is empty);
 *   - a line priced from it is stamped priced:'reference' with a refNote the
 *     office reviews — it never passes as a catalog price.
 * Only owner/office callers get rows back (xact_ref_prices_for returns zero
 * rows to anyone else), and dropping the tables turns the tier off.
 */

export type PricingMode = "piecework" | "tm";
export type EstimateKind = "claim" | "construction" | "unknown";

export type CatalogRow = {
  category: string; code: string; description: string; unit: string | null;
  replace_price: number | null; remove_price: number | null; detach_reset_price: number | null;
};

/** One row of public.xact_ref_prices (the columns resolveLines reads). */
export type RefRow = {
  category: string; code: string; activity: string; unit: string;
  description?: string | null;
  n_lines?: number | null; n_estimates?: number | null;
  median?: number | null; min?: number | null; max?: number | null;
  latest_median?: number | null; latest_price_list?: string | null;
};

/** A drafted / suggested line, before and after pricing. */
export type DraftLine = {
  room?: string; desc?: string; qty?: number; unit?: string; price?: number; basis?: string; reason?: string;
  category?: string; code?: string; priceBasis?: string;
  priced?: string; priceFlag?: string; catalogDesc?: string; refNote?: string;
};

export type ResolveOpts = { mode: PricingMode; kind?: EstimateKind };

/* ---------- small helpers ---------- */

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const money = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/* Unit spellings the model and the sheets use for the same thing. */
const UNIT_ALIASES: Record<string, string> = {
  SQFT: "SF", DAY: "DA", DAYS: "DA", EACH: "EA", HRS: "HR", HOUR: "HR", HOURS: "HR",
};
/** Normalise a unit for comparison: case, whitespace and dots out, then aliases
    (SQ FT / SQFT → SF, DAY / DAYS → DA, EACH → EA, HRS / HOUR → HR). */
export function normUnit(u: unknown): string {
  const s = String(u ?? "").toUpperCase().replace(/[\s.]+/g, "");
  return Object.prototype.hasOwnProperty.call(UNIT_ALIASES, s) ? UNIT_ALIASES[s] : s;
}

/** The estimate's kind from the facts the field app sends (job.jobType, set
    by officeai.js from the job record): "construction" → construction, any
    other job type → an insurance claim. Facts with no jobType (a client older
    than v192) read as unknown, so they get neither the reference tier nor the
    claim house patterns — they price exactly as before. */
export function kindOfFacts(facts: unknown): EstimateKind {
  const jt = (facts as { job?: { jobType?: unknown } } | null)?.job?.jobType;
  if (typeof jt !== "string" || !jt.trim()) return "unknown";
  return jt.trim() === "construction" ? "construction" : "claim";
}

/** The reference tier applies to a piecework insurance-claim estimate only. */
export const referenceAllowed = (opts: ResolveOpts | undefined) =>
  !!opts && opts.mode === "piecework" && opts.kind === "claim";

/** A reference row's price: the latest price list's median, else the median. */
export function refPrice(r: RefRow): number | null {
  const latest = num(r.latest_median);
  if (latest != null && latest > 0) return latest;
  const med = num(r.median);
  return med != null && med > 0 ? med : null;
}

/** What the office sees beside a reference-priced line. */
export function refNote(r: RefRow): string {
  const parts = [`${num(r.n_lines) ?? 0} line(s) on ${num(r.n_estimates) ?? 0} estimate(s)`];
  const list = String(r.latest_price_list ?? "").trim();
  if (list) parts.push(list);
  const lo = num(r.min), hi = num(r.max);
  if (lo != null && hi != null) parts.push(`range ${money(lo)}–${money(hi)}`);
  return `Xactimate reference from your past estimates: ${parts.join(", ")} — review`;
}

const laborFlag = (code: string, rate: number | null, unit: unknown) =>
  `${code} is an hourly labor rate${rate != null ? ` (${money(rate)}/HR)` : ""} — bill this as HR × crew-hours, not per ${String(unit ?? "").trim() || "unit"}`;

/* ---------- paging ----------
   PostgREST caps one response at max-rows (Supabase default 1000): a single
   `limit=5000` read comes back cut at 1000 with no error, which is how most of
   the catalog silently never reached the prompts. Read page by page until a
   short page (or a 416, ranged past the end). */
export type Page<T> = { ok: boolean; status: number; rows: T[] };
export async function fetchAllPages<T>(
  getPage: (from: number, to: number) => Promise<Page<T>>,
  pageSize = 1000, maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const r = await getPage(from, from + pageSize - 1);
    if (r.status === 416) break;                          // ranged past the end
    if (!r.ok) throw new Error(`read failed (${r.status})`);
    const rows = Array.isArray(r.rows) ? r.rows : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/* ---------- prompt text ---------- */

/** Compact catalog block for the prompt: CATEGORY CODE | description | unit | prices. */
export function catalogTextFromRows(rows: CatalogRow[], mode: PricingMode): string {
  if (mode === "tm") {
    // T&M uses ONLY these hourly labor rates from the sheet. Materials are estimated
    // by the model (no piecework unit prices), so no material catalog is sent.
    const labor = rows.filter((r) => r.category === "LAB" && r.unit === "HR" && (r.replace_price ?? 0) > 0);
    const laborTxt = labor.map((r) => `LAB ${r.code} | ${r.description} | HR | ${money(r.replace_price)}`).join("\n");
    return `LABOR RATES — category LAB, billed HOURS × rate (the ONLY catalog prices in T&M):\n${laborTxt}`;
  }
  // piecework: drop $0 placeholders (Bid/Agreed) and material-only sheet rows (SH)
  const usable = rows.filter((r) => (r.replace_price ?? 0) > 0 || (r.remove_price ?? 0) > 0);
  return usable.map((r) =>
    `${r.category} ${r.code} | ${r.description} | ${r.unit} | replace ${money(r.replace_price)}`
    + (r.remove_price != null ? ` | tear-out ${money(r.remove_price)}` : "")
    + (r.detach_reset_price != null ? ` | D&R ${money(r.detach_reset_price)}` : "")
  ).join("\n");
}

export const REFERENCE_HEADER =
  "XACTIMATE REFERENCE CODES — from Roybal's own past Xactimate estimates. Use one ONLY when no PRICE CATALOG row fits; " +
  "lines priced from it are stamped 'reference' and flagged for review. Tag category + code + priceBasis exactly as with the catalog.";
// The reference is office-only: the prose fields print on the estimate and
// reach the portal, so the model is told to keep the source out of them (the
// field app's customerText() drops any sentence that still names it).
export const REFERENCE_PRIVATE =
  "(PRIVATE: never mention this reference list, its prices or Roybal's past estimates as a price source in lossSummary, pricingNotes, " +
  "assumptions, exclusions, room summaries, alternates or any other customer- or adjuster-facing text.)";
// the activities the resolver can stamp (R&R and unknown-activity rows can't be
// mapped to one priceBasis, so they are never offered)
const PROMPT_ACTIVITIES = ["Replace", "Remove", "D&R"];

/** The XACTIMATE REFERENCE block: one line per reference code the catalog does
    not carry. '' when there is nothing to offer (no header either). */
export function referenceTextFromRows(refRows: RefRow[], catalogRows: CatalogRow[]): string {
  const inCatalog = new Set((Array.isArray(catalogRows) ? catalogRows : []).map((r) => `${r.category}::${r.code}`));
  const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
  const lines = (Array.isArray(refRows) ? refRows : [])
    .filter((r) => r && oneLine(r.category) && oneLine(r.code) && PROMPT_ACTIVITIES.includes(String(r.activity)) &&
      !inCatalog.has(`${r.category}::${r.code}`) && refPrice(r) != null)
    .slice()
    .sort((a, b) =>
      String(a.category).localeCompare(String(b.category)) || String(a.code).localeCompare(String(b.code)) ||
      PROMPT_ACTIVITIES.indexOf(a.activity) - PROMPT_ACTIVITIES.indexOf(b.activity) || String(a.unit).localeCompare(String(b.unit)))
    .map((r) =>
      `${oneLine(r.category)} ${oneLine(r.code)} | ${oneLine(r.description)} | ${oneLine(r.unit)} | ${r.activity} | ref ${money(refPrice(r))} (${num(r.n_estimates) ?? 0} est)`);
  if (!lines.length) return "";
  return REFERENCE_HEADER + "\n" +
    "(activity → priceBasis: Replace = 'replace', Remove = 'remove', D&R = 'detach_reset')\n" +
    REFERENCE_PRIVATE + "\n" +
    lines.join("\n");
}

/* ---------- pricing ---------- */

const ACTIVITY_FOR_BASIS: Record<string, string> = { replace: "Replace", remove: "Remove", detach_reset: "D&R", labor: "Replace" };

/** Stamp authoritative prices onto drafted / suggested lines.
    Catalog first; on a catalog miss, the reference tier (piecework claim only);
    else the model's own number stands as priced:'estimate'. */
export function resolveLines(items: DraftLine[], catalogRows: CatalogRow[], refRows: RefRow[], opts: ResolveOpts): DraftLine[] {
  const list = Array.isArray(items) ? items : [];
  const byKey = new Map((Array.isArray(catalogRows) ? catalogRows : []).map((r) => [`${r.category}::${r.code}`, r] as const));
  const refByKey = new Map<string, RefRow[]>();
  if (referenceAllowed(opts)) {
    for (const r of Array.isArray(refRows) ? refRows : []) {
      if (!r || !r.category || !r.code) continue;
      const k = `${r.category}::${r.code}`;
      const bucket = refByKey.get(k);
      if (bucket) bucket.push(r); else refByKey.set(k, [r]);
    }
  }

  /* The reference tier: exact category + code + unit, activity from priceBasis.
     null = no reference price for this line. */
  const fromReference = (it: DraftLine, rest: DraftLine, basis: string | undefined): DraftLine | null => {
    if (!refByKey.size) return null;
    const cat = String(it.category ?? "").trim(), code = String(it.code ?? "").trim();
    if (!cat || !code || !basis) return null;
    const activity = Object.prototype.hasOwnProperty.call(ACTIVITY_FOR_BASIS, basis) ? ACTIVITY_FOR_BASIS[basis] : "";
    if (!activity) return null;                         // 'estimate' (or anything unknown) never looks up
    const rows = refByKey.get(`${cat}::${code}`) ?? [];
    if (!rows.length) return null;
    const unit = normUnit(it.unit);
    // GUARDRAIL first, as on the catalog path: an hourly rate never bills an area/count
    if (basis === "labor" && unit !== "HR") {
      const hr = rows.find((r) => r.activity === "Replace" && normUnit(r.unit) === "HR");
      if (!hr) return null;
      return { ...rest, price: undefined, code, priced: "flag", priceFlag: laborFlag(code, refPrice(hr), it.unit) };
    }
    const hit = rows.find((r) => r.activity === activity && normUnit(r.unit) === unit);
    const price = hit ? refPrice(hit) : null;
    if (!hit || price == null) return null;
    return {
      ...rest, price, code: hit.code, catalogDesc: String(hit.description ?? ""),
      unit: it.unit || hit.unit || "", priced: "reference", refNote: refNote(hit),
    };
  };

  return list.map((it) => {
    const { priceBasis: basis, ...rest } = it;
    const miss = () => fromReference(it, rest, basis) ?? { ...rest, priced: "estimate" };
    const row = it.category && it.code ? byKey.get(`${it.category}::${it.code}`) : undefined;
    if (!row) return miss();
    // GUARDRAIL: an hourly LAB rate may ONLY bill an HR line. If the model tags a
    // line priceBasis='labor' but leaves an area/count unit (SF/LF/EA), applying the
    // hourly rate would multiply it by the AREA (e.g. $81.27/hr × 508 SF = $41k for a
    // 3-hour tear-out). Refuse to price it and flag for manual crew-hours instead.
    if (basis === "labor" && normUnit(it.unit) !== "HR") {
      return { ...rest, price: undefined, code: row.code, priced: "flag", priceFlag: laborFlag(row.code, num(row.replace_price), it.unit) };
    }
    const col = num(basis === "remove" ? row.remove_price
      : basis === "detach_reset" ? row.detach_reset_price
      : row.replace_price); // "replace" | "labor" both live in replace_price
    if (col == null || col <= 0) return miss();
    // a per-SF price stamped on a per-LF line (or any other unit mismatch) is
    // wrong by the ratio of the two — flag it rather than stamp it
    const lineUnit = normUnit(it.unit), rowUnit = normUnit(row.unit);
    if (lineUnit && rowUnit && lineUnit !== rowUnit) {
      return { ...rest, price: undefined, code: row.code, priced: "flag",
        priceFlag: `${row.code} is priced per ${String(row.unit).trim()}; this line is per ${String(it.unit).trim()} — fix the unit or quantity` };
    }
    return { ...rest, price: col, code: row.code, catalogDesc: row.description, unit: it.unit || row.unit || "", priced: "catalog" };
  });
}

/* ---------- the company estimating rules ----------
   Shared by every line-item draft: the pricing mode (piecework vs T&M), the
   common line conventions, the Roybal inclusion rules distilled from Branden's
   past estimates (docs/Estimating_Rules_Draft.md), and the house patterns mined
   from his past Xactimate estimates (they sit BELOW his confirmed rules).
   opts.reference: the XACTIMATE REFERENCE block is in the prompt, so the code
   rule names it as the second tier. */
export function estimatingRules(pm: PricingMode, opts: { reference?: boolean } = {}) {
  const codeRule = opts.reference
    ? "- EVERY line MUST be tagged with the catalog line it bills: set `category` + `code` to a real row from the PRICE CATALOG and `priceBasis` to how it is priced. The catalog's authoritative Fairbanks price OVERRIDES your `price`. When NO catalog row fits but an XACTIMATE REFERENCE row does, tag that row's category + code + priceBasis the same way (its price is stamped as a reference and flagged for review). Only when neither fits: category=\"\" code=\"\" priceBasis=\"estimate\", and price it at a fair Fairbanks rate.\n"
    : "- EVERY line MUST be tagged with the catalog line it bills: set `category` + `code` to a real row from the PRICE CATALOG and `priceBasis` to how it is priced. The catalog's authoritative Fairbanks price OVERRIDES your `price`, so your number only stands when NO catalog code fits (then category=\"\" code=\"\" priceBasis=\"estimate\", and price it at a fair Fairbanks rate).\n";
  const pricingRules =
    pm === "piecework"
      ? "PRICING MODE — PIECEWORK (Xactimate unit-priced): each line's unit price carries BOTH labor and material.\n" +
        "- priceBasis: 'replace' for install / put-back, 'remove' for tear-out / demo, 'detach_reset' for detach & reset. The catalog lists replace / tear-out / D&R prices per row.\n" +
        codeRule
      : "PRICING MODE — TIME & MATERIALS: this bills LABOR HOURLY at the sheet's trade rates and MATERIALS at your ESTIMATED cost. It does NOT use Xactimate piecework unit prices — the only catalog prices are the LABOR RATES.\n" +
        "- LABOR lines: category='LAB', code = the trade doing the work (DMO demolition, CLN-R remediation cleaning, CLN cleaning, LBR general laborer, DRY drywall, PNT painter, INS insulation, FLR flooring, CARPFRM framer, CARPFNC finish carpenter, ELE electrician, PLM plumber, EQU equipment operator, SUPERR residential supervision), priceBasis='labor', unit MUST be 'HR', qty = ESTIMATED CREW-HOURS.\n" +
        "  · NEVER put an area/count (SF/LF/EA) on a labor line — convert the task to hours. E.g. tear out ~500 SF drywall ceiling ≈ 3-4 crew-hours (NOT qty 500); hang/finish ~500 SF drywall ≈ 16-20 hrs. A labor line with a non-HR unit is a hard error.\n" +
        "  · The sheet's LAB rate is stamped automatically — put the trade code and the hours; leave price 0.\n" +
        "- MATERIAL lines: category='' code='' priceBasis='estimate'. Estimate a fair MATERIAL-ONLY cost per unit (drywall board, mud/tape, insulation, paint, primer, trim, fasteners, poly) — unit = SF/LF/EA, qty = the material quantity. Materials-only, NO labor baked in (labor is the HR lines). These stay flagged for the office to true-up against receipts.\n" +
        "- Equipment / consumables / pass-through (dehumidifier & air-mover days, dumpster/haul, PPE) also go as priceBasis='estimate' at a fair cost.\n" +
        "- Do NOT emit a single per-SF assembly price that covers labor + material — that double-bills labor. Split every assembly into LABOR (hours) + MATERIAL (estimate).\n";
  const commonRules =
    "- Group every line into its room/area via the room field (Xactimate style); job-wide lines (debris, floor protection, final clean, permits) go under 'Main Level'.\n" +
    "- On Cat 3 jobs, removal/handling lines carry the qualifier (e.g. 'cut/bag - Cat 3 water'); Cat 1/2 jobs omit it.\n" +
    "- Descriptions are plain English as Xactimate reads — never include catalog code abbreviations, never repeat the room name in the description.\n" +
    "- lossSummary: 2-3 sentences. No overhead/profit/tax lines (applied separately). Prices in DOLLARS.\n";
  // Roybal company estimating standards — the "what to include" judgment distilled
  // from Branden's past estimates (see docs/Estimating_Rules_Draft.md).
  const inclusionUniversal =
    "ROYBAL INCLUSION RULES (company estimating standards — apply within the scope above):\n" +
    "- DETACH & RESET vs REMOVE & REPLACE: REPLACE (remove + install new) when an item is DAMAGED by the loss, OR the loss is Category 3 (facts.job.waterCategory = '3') AND the item is a POROUS material (plywood, particleboard, MDF, fiberboard). Otherwise an undamaged item detached only to dry the assembly behind it is DETACH & RESET. Apply to vanities, cabinets, toilets, trim, doors.\n" +
    "- LABOR MINIMUMS: never auto-add a trade labor minimum to pad a small quantity — carriers flag and cut them. At most note in lossSummary that one may apply; do not insert the line.\n";
  const inclusionMitigation =
    "- CATEGORY 3 PACKAGE: when facts.job.waterCategory is '3' (black / contaminated water), ALWAYS bill EVERY one of — containment barrier, negative-air / HEPA air scrubber (per 24 hr × days), floor protection over unaffected paths, HEPA vacuuming of affected surfaces, antimicrobial application, and PPE CONSUMABLES billed as equipment replacement (Tyvek / Type-X suits, HEPA / P100 respirator cartridges, gloves, boot covers). Never omit any of these on a Cat 3 job.\n" +
    "- HEPA FILTER REPLACEMENT: with any HEPA / negative-air scrubber on the job, add a filter-replacement line, qty = (# scrubbers) × (1.0 on Cat 3 or mold — filter contaminated, must be discarded; else 0.5 — proportional filter life). State the reason in the basis.\n" +
    "- DRYING EQUIPMENT — DO NOT GUESS QUANTITIES: bill from facts.equipmentSizing.recommended (IICRC S500 worksheet counts already computed on site: airMoversLow/High, dehumidifiers, dehuType, airScrubbers, auxiliaryHeat) × the DEPLOYED unit-days in facts.equipment (unitDays) — fallback facts.drying.days. Air movers & dehumidifiers bill per-24-hr period × unit-days. Dehumidifiers are LGR RENTALS in 70 / 110 / 130 PPD sizes. If facts.equipmentSizing is null, size conservatively and say so in the basis.\n";
  const inclusionRestoration =
    "- PUT-BACK COMPLETENESS: every tear-out / flood cut / removal in facts.demoNotes and facts.affectedAreas needs its FULL rebuild — removed flooring → floor prep + flooring + transitions; drywall → hang, tape, texture, prime, two coats paint; baseboard / trim / paneling → reinstall; detached fixtures → reset or replace per the rule above. Leave no demo line without its put-back.\n" +
    "- FINISH CHAIN: any new or patched drywall → mask & prep → PVA primer (one coat) → paint (two coats); any flooring install → a floor-prep line first. Always include a final construction cleaning line and floor / surface protection.\n";
  // House patterns mined from Branden's own past Xactimate estimates
  // (docs/Estimating_Rules_Draft.md, "Patterns mined from 40 past Xactimate
  // estimates"). Mechanism only: no prices, codes or job names.
  const houseMitigation =
    "ROYBAL HOUSE PATTERNS — MITIGATION (how Branden's past mitigation estimates are built; include each unless the evidence shows it does not apply here):\n" +
    "- Debris haul-off on every mitigation job: one pickup load for a small or medium tear-out; a dump trailer or dumpster for a large one.\n" +
    "- Whenever air movers are billed, also bill equipment setup / take-down / monitoring hours (about 1 hour per drying day) and equipment decontamination at one per piece of equipment placed (air movers + dehumidifiers + scrubbers + heaters).\n" +
    "- Anti-microbial on the exposed surfaces of every room where material was torn out.\n" +
    "- Contents: when a room must be emptied, bill content manipulation hours (or move-out per room); when contents leave the house, add boxes, moving van, storage container and padlock.\n" +
    "- Cold-weather drying (freeze losses, or heat off): add drying heat (indirect-fired furnace or temporary heaters). On a freeze loss, the plumber's paid bill goes on as a pass-through.\n" +
    "- Tear-out on the mitigation estimate is REMOVE ONLY (drywall / flood cut, baseboard, carpet, pad, hard flooring, insulation). Never remove-and-replace here: the put-back belongs on the restoration estimate.\n" +
    "- Tear-out chain in a room: flooring out means baseboard out; carpet out means pad out at the same SF; a flood cut means baseboard out, flooring out and anti-microbial; hard flooring out means the drywall is flood cut too; wet insulation out means the drywall over it is out; a door slab comes off when the flooring under it comes out.\n" +
    "- Bathrooms: flooring, drywall and baseboard out; the toilet comes out (detach and reset if undamaged, per the D&R rule), and when the toilet and floor come out the vanity and tub/shower usually do too.\n" +
    "- Undamaged items in the way (light fixtures, towel bars, shower doors, mirrors, faucet trim, shelving, hydronic baseboard-heat covers) are DETACH & RESET, never replaced.\n" +
    "- Final cleaning and floor protection usually belong to the restoration estimate, not mitigation.\n";
  const houseRestoration =
    "ROYBAL HOUSE PATTERNS — RESTORATION / PUT-BACK (how Branden's past rebuild estimates are built; include each unless the evidence shows it does not apply here):\n" +
    "- Put back everything the mitigation removed, room by room, at the SAME quantity: flood-cut LF comes back as the same LF of drywall band; removed floor SF comes back as the same SF of new flooring (plus pad or floor prep); baseboard LF, toilets, vanities, doors and appliances come back one for one. Baseboard is the item most often missed: check every room for it.\n" +
    "- New material is REPLACE only when its removal is already on the mitigation estimate. Use remove-and-replace only for items the mitigation never removed (ceilings, crawlspace vapor barrier, heat covers).\n" +
    "- An item DETACHED during mitigation is RESET here; an item REMOVED during mitigation is replaced new.\n" +
    "- Every room with new drywall gets mask-for-paint by the LF, PVA seal and paint. Paint covers the full height of the affected walls, not just the patch (about 8 x the flood-cut LF of wall area). Current method: seal plus two coats on the lower third of the wall, one coat on the upper two-thirds.\n" +
    "- Mask-for-paint LF equals the flood-cut LF; baseboard LF usually equals the flood-cut LF too.\n" +
    "- New baseboard is painted or stained at the same LF. Door casing runs about 17 LF per opening (19 LF for a double bifold).\n" +
    "- New hard or resilient flooring gets floor prep at the net floor SF; sheet vinyl takes 15% waste. New carpet gets pad at the net SF, carpet at the pad SF or plus 15% waste, and tack strip at the baseboard LF.\n" +
    "- Floor protection at the new-floor SF, and a final construction clean over the floor area of the work area.\n" +
    "- Move contents back in when the mitigation packed them out (hours, moving van, another container month).\n" +
    "- In an occupied home, drywall work gets dust containment: a barrier (about 48 SF) with a zipper door, tension posts x days, and an air scrubber for 3 to 5 days.\n" +
    "- Debris haul-off, usually one pickup load.\n";
  return { pricingRules, commonRules, inclusionUniversal, inclusionMitigation, inclusionRestoration, houseMitigation, houseRestoration };
}

/** invoiceAudit's code rule — the same three tiers as the drafter's. */
export function auditCodeRule(reference: boolean): string {
  return reference
    ? "- Tag every suggestion with the catalog line it bills: set category + code from the PRICE CATALOG and priceBasis (replace/remove/detach_reset/labor). The catalog price is authoritative and overrides your price. When no catalog row fits but an XACTIMATE REFERENCE row does, tag that row the same way (it is stamped as a reference and flagged for review). Use category=\"\" code=\"\" priceBasis=\"estimate\" only when neither fits.\n"
    : "- Tag every suggestion with the catalog line it bills: set category + code from the PRICE CATALOG and priceBasis (replace/remove/detach_reset/labor). The catalog price is authoritative and overrides your price; use category=\"\" code=\"\" priceBasis=\"estimate\" only when nothing fits.\n";
}
