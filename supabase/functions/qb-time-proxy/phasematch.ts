/* ============================================================
   QB Time → board-phase matcher — pure module (no Deno, no network)
   ------------------------------------------------------------
   Attributes a time entry to the closest board phase from what the
   crew actually SAID they did — the QB Time service item and the
   timesheet note — instead of the date-window fallback the board
   uses when an entry carries no phaseId (phaseActuals rule #3,
   apps/board/js/schedule.js). A stamped entry.phaseId always wins
   there (rule #1), so matching here at ingest flows through the
   board / assistant / phone agent with no engine changes.

   Design rules:
   · Service items split into two kinds. Task-like ("Expediting
     Materials") carry phase signal; ROLE-like ("Lead Carpenter /
     Foreman") only say who worked, so they defer to the note.
   · Matching is token overlap between the entry text and each
     phase's name expanded with construction synonyms (demo/tear
     out, drywall/sheetrock/tape/mud, …).
   · Ambiguity loses: a winner must beat the runner-up by a clear
     margin or we return null and the date fallback rides.
   Unit tests: phasematch.test.mjs (node --experimental-strip-types).
   ============================================================ */

export type Subtask = { id: string; name?: string; done?: boolean };
export type EntryText = { service?: string; note?: string; task?: string };
export type PhaseMatch = { phaseId: string; by: "service" | "note"; score: number };

/* ---------- text → tokens ---------- */

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "on", "in", "at", "with",
  "up", "out", "off", "then", "went", "did", "do", "was", "were", "get", "got",
  "labor", "in-house", "inhouse", "house", "construction", "restoration", "work",
]);

/** lowercase, split on non-alphanumerics, drop stopwords, trim simple plurals */
export function tokensOf(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/* ---------- service items: task-like vs role-like ----------
   QB service items arrive as "Labor (In-House):Labor — Lead Carpenter /
   Foreman" — only the leaf after the last ":" describes the entry. A leaf
   naming a ROLE says nothing about which phase the hours belong to. */

const ROLE_WORDS = new Set([
  "carpenter", "foreman", "lead", "laborer", "helper", "apprentice",
  "journeyman", "superintendent", "supervisor", "manager", "pm", "tech",
  "technician", "estimator", "owner", "admin", "office",
]);

/** the leaf segment of a "Parent:Child" service item path */
export function serviceLeaf(service: string): string {
  const parts = String(service || "").split(":");
  return (parts[parts.length - 1] || "").trim();
}

/** true when the service item names a role (who), not a task (what) */
export function isRoleService(service: string): boolean {
  const toks = tokensOf(serviceLeaf(service));
  if (!toks.length) return false;
  return toks.some((t) => ROLE_WORDS.has(t));
}

/* ---------- construction synonym map ----------
   canonical concept → the words crews use for it. A phase name owning any
   word of a concept also owns the concept's whole word set. Seed list built
   from this shop's vocabulary (restoration + remodel, Fairbanks AK). */

const CONCEPTS: Record<string, string[]> = {
  demo: ["demo", "demoed", "demolition", "tear", "tore", "tearout", "teardown", "remove", "removed", "removal", "haul", "hauled", "dumpster", "gut", "gutted", "strip", "stripped"],
  mitigation: ["mitigation", "dry", "drying", "dried", "dehu", "dehumidifier", "fan", "airmover", "extraction", "extract", "extracted", "water", "flood", "moisture", "reading", "containment"],
  framing: ["frame", "framed", "framing", "stud", "wall", "blocking", "furring", "subfloor", "joist", "beam", "header", "sheathing"],
  insulation: ["insulation", "insulate", "insulated", "batt", "foam", "vapor", "barrier", "poly"],
  // NOT "hang"/"hung" — you hang doors and cabinets too, and a phase named
  // "Hang doors" would then own this entire vocabulary (it did: a
  // "Drywall / Mud / Tape" service item landed on Hang doors). Same for the
  // bare word "board", which shows up in cement board, board-up, baseboard.
  drywall: ["drywall", "sheetrock", "rock", "tape", "taped", "taping", "mud", "mudded", "mudding", "texture", "textured", "skim", "gypsum"],
  paint: ["paint", "painted", "painting", "prime", "primed", "primer", "stain", "stained", "spray", "sprayed", "roll", "rolled", "coat"],
  flooring: ["floor", "flooring", "lvp", "vinyl", "carpet", "tile", "tiled", "grout", "grouted", "laminate", "hardwood", "underlayment"],
  trim: ["trim", "trimmed", "casing", "baseboard", "base", "door", "doors", "hardware", "millwork", "shelving", "closet", "sill", "windowsill", "blind", "cover"],
  cabinets: ["cabinet", "cabinets", "countertop", "counter", "vanity"],
  plumbing: ["plumbing", "plumber", "pipe", "toilet", "sink", "faucet", "drain", "valve"],
  electrical: ["electrical", "electrician", "wire", "wired", "wiring", "outlet", "switch", "panel", "light", "lighting", "breaker"],
  hvac: ["hvac", "duct", "furnace", "boiler", "heat", "heater", "vent", "ventilation"],
  roofing: ["roof", "roofing", "shingle", "flashing", "fascia", "soffit", "gutter"],
  // NOT "window" — windows are trim/interior work far more often than siding,
  // and it made "Trim and Window sills" own the siding vocabulary.
  siding: ["siding", "exterior", "wrap", "housewrap"],
  concrete: ["concrete", "slab", "pour", "poured", "form", "formed", "footing", "foundation", "rebar"],
  // NOT "final" — "final coat" is paint and "final clean" is cleanup.
  punch: ["punch", "punchlist", "touchup", "touch", "adjust", "adjusted", "fix", "fixed", "fixing", "walkthrough", "walk", "thru", "walkthru", "detail", "silicone", "caulk", "caulked", "caulking"],
  cleanup: ["clean", "cleaned", "cleanup", "cleaning", "sweep", "swept", "trash", "debris"],
  materials: ["material", "materials", "expediting", "expedite", "pickup", "supplies", "shopping", "order", "ordered", "lumber", "delivery", "delivered"],
  inspection: ["inspection", "inspect", "permit", "walkthrough", "walk", "estimate", "measure", "measured", "scope", "scoped"],
};

/* The phase name to propose when a concept has hours but no phase owns it.
   Keys must exist in CONCEPTS; anything without a label is never proposed
   (too vague to name a phase after — e.g. "inspection"). */
const PHASE_LABELS: Record<string, string> = {
  demo: "Demo & tear-out",
  mitigation: "Dry-out & mitigation",
  framing: "Framing",
  insulation: "Insulation",
  drywall: "Drywall",
  paint: "Paint",
  flooring: "Flooring",
  trim: "Trim & doors",
  cabinets: "Cabinets & countertops",
  plumbing: "Plumbing",
  electrical: "Electrical",
  hvac: "Mechanical / HVAC",
  roofing: "Roofing",
  siding: "Siding & exterior",
  concrete: "Concrete",
  punch: "Punch list",
  cleanup: "Final clean",
  materials: "Materials & expediting",
};

/* word → concepts that own it (built once) */
const CONCEPT_OF: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [concept, words] of Object.entries(CONCEPTS)) {
    for (const w of words) {
      const t = tokensOf(w)[0] || w;
      const list = m.get(t) || [];
      list.push(concept);
      m.set(t, list);
    }
  }
  return m;
})();

const conceptsOf = (tokens: string[]): Set<string> => {
  const out = new Set<string>();
  for (const t of tokens) for (const c of CONCEPT_OF.get(t) || []) out.add(c);
  return out;
};

/** votes per concept across a text's distinct words (the clustering signal) */
export function conceptVotes(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const t of tokensOf(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    for (const c of CONCEPT_OF.get(t) || []) out.set(c, (out.get(c) || 0) + 1);
  }
  return out;
}

/** the single concept a note is most about, or null when it says nothing */
export function dominantConcept(text: string): string | null {
  let best: string | null = null, bestN = 0;
  for (const [c, n] of conceptVotes(text)) if (n > bestN) { bestN = n; best = c; }
  return best;
}

/* ---------- scoring ----------
   Per distinct entry word: a direct phase-name token hit = 2 pts; else a
   word voting for a concept the phase owns = 1 pt (so three punch-y words
   beat one). A match needs ≥2 pts AND a ≥2-pt lead over the runner-up —
   otherwise the entry stays unstamped and the board's date fallback applies. */

export const MIN_SCORE = 2;
export const MIN_LEAD = 2;

function scoreAgainst(entryTokens: string[], phaseTokens: string[], phaseConcepts: Set<string>): number {
  if (!entryTokens.length || !phaseTokens.length) return 0;
  const phaseSet = new Set(phaseTokens);
  let pts = 0;
  const seen = new Set<string>();
  for (const t of entryTokens) {
    if (seen.has(t)) continue;   // count each distinct word once
    seen.add(t);
    if (phaseSet.has(t)) { pts += 2; continue; }
    for (const c of CONCEPT_OF.get(t) || []) {
      if (phaseConcepts.has(c)) { pts += 1; break; }   // one vote per word
    }
  }
  return pts;
}

/** Match one entry's text against a job's phases. Returns null when nothing
    clears the bar or two phases tie — ambiguity must lose to the fallback. */
export function matchPhase(entry: EntryText, subtasks: Subtask[]): PhaseMatch | null {
  const phases = (subtasks || []).filter((st) => st && st.id && String(st.name || "").trim());
  if (!phases.length) return null;

  const noteText = [entry.note, entry.task].filter(Boolean).join(" ");
  const noteTokens = tokensOf(noteText);
  const svcTokens = isRoleService(entry.service || "") ? [] : tokensOf(serviceLeaf(entry.service || ""));

  const scored = phases.map((st) => {
    const pTokens = tokensOf(String(st.name));
    const pConcepts = conceptsOf(pTokens);
    return {
      id: st.id,
      note: scoreAgainst(noteTokens, pTokens, pConcepts),
      service: scoreAgainst(svcTokens, pTokens, pConcepts),
    };
  });

  const pick = (by: "note" | "service") => {
    const ranked = [...scored].sort((a, b) => b[by] - a[by]);
    const best = ranked[0], second = ranked[1];
    return best && best[by] >= MIN_SCORE && (!second || best[by] - second[by] >= MIN_LEAD)
      ? { phaseId: best.id, by, score: best[by] } : null;
  };

  // The note is what the crew actually did, so it goes first.
  const byNote = pick("note");
  if (byNote) return byNote;

  // The service item is a BILLING category, not a statement about the hour —
  // a crew prepping for paint can be booked to "Drywall / Mud / Tape". So it
  // only speaks when the note named no work at all ("misc", "", "on site").
  // Note the test is whether the note described SOMETHING, not whether it
  // matched one of THESE phases: "Fixing kitchen framing" on a job with no
  // framing phase is a reason to abstain, not a reason to believe the billing
  // code. (Observed: that note, and "Prep for paint trim and doors", were both
  // pushed onto the wrong phase by a drywall service item.)
  const noteSpoke = conceptsOf(noteTokens).size > 0 || scored.some((s) => s.note > 0);
  if (noteSpoke) return null;
  return pick("service");
}

/* ============================================================
   Ingest reconcile — pure helper for pullOneDay/pullRange.
   Given freshly-mapped rows and the existing DB rows they collide
   with, decide what actually needs writing:
   · keep the original createdAt (a re-pull is not a creation)
   · a manual phase assignment (phaseMatch.by === "manual") is owner
     truth — never overwritten by matcher or re-pull
   · an attribution the row already earned SURVIVES a pull that
     matched nothing. Without this the nightly re-pull wipes every
     AI stamp (the free matcher failed on those rows by definition)
     and we pay Haiku to re-earn the same answer every night — and
     an AI "looked at this and passed" marker would be lost too.
   · rows whose content is unchanged are SKIPPED entirely (the
     nightly re-pull used to rewrite every row every day)
   ============================================================ */

// deno-lint-ignore no-explicit-any
type Row = { id: string; deleted: boolean; data: Record<string, any> };

/** stable stringify (sorted keys) ignoring the volatile stamp fields */
export function entryFingerprint(data: Record<string, unknown>): string {
  const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: Record<string, unknown>) => rest;
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(strip(data as Record<string, unknown>)));
}

export function reconcileRows(
  rows: Row[],
  existingById: Map<string, Record<string, unknown>>
): { toWrite: Row[]; skipped: number } {
  const toWrite: Row[] = [];
  let skipped = 0;
  for (const row of rows) {
    const prev = existingById.get(row.id) as Record<string, any> | undefined;
    if (prev) {
      if (prev.createdAt) row.data.createdAt = prev.createdAt;   // re-pull ≠ re-creation
      const pm = prev.phaseMatch as { by?: string } | undefined;
      if (pm?.by === "manual") {
        // The owner's call sticks forever — INCLUDING a deliberate unpin
        // (manual with no phaseId, set by the board's "Auto phase"). Without
        // the delete, tonight's matcher would quietly re-pin what they cleared.
        if (prev.phaseId) row.data.phaseId = prev.phaseId;
        else delete row.data.phaseId;
        row.data.phaseMatch = prev.phaseMatch;
      } else if (!row.data.phaseId && (prev.phaseId || pm)) {
        // this pull's matcher found nothing — keep what the row already earned
        if (prev.phaseId) row.data.phaseId = prev.phaseId;
        if (pm) row.data.phaseMatch = prev.phaseMatch;
      }
      if (entryFingerprint(row.data) === entryFingerprint(prev)) { skipped++; continue; }
    }
    toWrite.push(row);
  }
  return { toWrite, skipped };
}

/* ============================================================
   Jobcode → phased board job resolution.
   A jobcode can back multiple board jobs (e.g. a rebuild sharing
   the mitigation job's code); the board scopes hours by the job's
   `hoursFrom` date (scopedEntriesOfJob). Mirror that here: for an
   entry date, the candidate is the job with the LATEST hoursFrom
   at or before the date (no hoursFrom = matches any date).
   ============================================================ */

export type BoardJobLite = {
  id: string; qbJobcodeId?: string; hoursFrom?: string; subtasks?: Subtask[];
  title?: string; customer?: string; rev?: number;
};

/** what to call a board job in an owner-facing line */
export const jobLabel = (j: BoardJobLite): string =>
  String(j?.title || j?.customer || "job").trim() || "job";

/* ============================================================
   Cluster the leftovers — "this crew keeps logging work no phase
   covers". Feeds the approve-by-text proposal (the owner adds the
   phase with one YES; we never touch the board unasked, because a
   phase reshapes the schedule).
   ============================================================ */

export type UnmatchedEntry = { id: string; hours?: number; note?: string; task?: string; date?: string };

/* The owner touched this entry's phase by hand — pinned it to a phase, or
   deliberately unpinned it back to the date fallback. Either way no automated
   pass may touch it again. THE guard every re-match path must honor. */
export const isOwnerPinned = (data: Record<string, unknown> | undefined): boolean =>
  (data?.phaseMatch as { by?: string } | undefined)?.by === "manual";

/** Is this entry still up for automated attribution? */
export const isOpenForMatching = (data: Record<string, unknown> | undefined): boolean =>
  !data?.phaseId && !isOwnerPinned(data);
export type PhaseProposal = { concept: string; name: string; hours: number; entryIds: string[] };

/** Concepts already covered by a phase — never propose one of these again. */
export function coveredConcepts(phases: Subtask[]): Set<string> {
  const out = new Set<string>();
  for (const st of phases || []) {
    if (!st || !st.name) continue;
    for (const c of conceptsOf(tokensOf(String(st.name)))) out.add(c);
  }
  return out;
}

/** Group unstamped entries by what they're about; a group clears the bar at
    2+ entries or 3+ hours. Returns biggest-first; never proposes a concept a
    phase already covers, or one with no sensible phase name. */
export function clusterUnmatched(
  entries: UnmatchedEntry[],
  phases: Subtask[],
  opts: { minEntries?: number; minHours?: number } = {}
): PhaseProposal[] {
  const minEntries = opts.minEntries ?? 2;
  const minHours = opts.minHours ?? 3;
  const covered = coveredConcepts(phases);
  const groups = new Map<string, { hours: number; entryIds: string[] }>();

  for (const e of entries || []) {
    if (!e || !e.id) continue;
    const c = dominantConcept([e.note, e.task].filter(Boolean).join(" "));
    if (!c || covered.has(c) || !PHASE_LABELS[c]) continue;
    const g = groups.get(c) || { hours: 0, entryIds: [] };
    g.hours += Number(e.hours) || 0;
    g.entryIds.push(e.id);
    groups.set(c, g);
  }

  const out: PhaseProposal[] = [];
  for (const [concept, g] of groups) {
    if (g.entryIds.length < minEntries && g.hours < minHours) continue;
    out.push({ concept, name: PHASE_LABELS[concept], hours: Math.round(g.hours * 100) / 100, entryIds: g.entryIds });
  }
  return out.sort((a, b) => b.hours - a.hours || b.entryIds.length - a.entryIds.length);
}

export function phasedJobForDate(candidates: BoardJobLite[], date: string): BoardJobLite | null {
  let best: BoardJobLite | null = null;
  for (const j of candidates || []) {
    if (!j || !(j.subtasks || []).length) continue;
    const from = j.hoursFrom || "";
    if (from && date && date < from) continue;
    if (!best || (j.hoursFrom || "") > (best.hoursFrom || "")) best = j;
  }
  return best;
}
