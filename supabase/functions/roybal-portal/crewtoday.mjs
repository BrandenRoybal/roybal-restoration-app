/* ============================================================
   Who's-coming-today — the PURE core (CF-2, docs/CRM_Design.md §8).
   ------------------------------------------------------------
   crewToday(job, dayISO) → the crew ids scheduled on a board job on a
   given calendar day, mirroring the board's own per-day semantics:

     crewIds                the job's base roster
     crewSpans[cid]         [{from,to}] — the member rides the job only
                            inside a span (blank end = open); set by the
                            Crew board's "This day on" moves
     dayCrew[dayISO]        {add:[], remove:[]} — single-day overrides

   Plus the scheduling window: the day must fall inside
   startDate..targetDate (missing target = start only), and on a
   workday. The board's calendar settings never persist server-side
   (the '__settings__' row can't exist in a uuid-keyed table), so the
   workday check is DEFAULT_SETTINGS' Mon–Fri — documented, not sneaky.
   (Weekend clock-ins still message: the publisher falls back to the
   actual clocked-in names when this returns nobody.)

   Shared by the roybal-portal gateway (Deno) and the Node test —
   plain ESM, no imports.
   ============================================================ */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const isWeekday = (dayISO) => {
  const d = new Date(dayISO + "T12:00:00Z").getUTCDay();   // noon dodges TZ edges
  return d >= 1 && d <= 5;
};

const inSpan = (dayISO, sp) =>
  (!sp.from || dayISO >= sp.from) && (!sp.to || dayISO <= sp.to);

export function crewToday(job, dayISO) {
  const j = job || {};
  if (!ISO.test(String(dayISO || ""))) return [];
  if (j.archived || j.isMilestone) return [];
  const stage = j.stage || "lead";
  if (!["scheduled", "in_progress", "final"].includes(stage)) return [];
  if (!j.startDate || dayISO < j.startDate) return [];
  if (j.targetDate && dayISO > j.targetDate) return [];
  if (!isWeekday(dayISO)) return [];

  // base roster, constrained by each member's assignment spans
  let crew = (Array.isArray(j.crewIds) ? j.crewIds : []).filter((cid) => {
    const spans = j.crewSpans && j.crewSpans[cid];
    if (!Array.isArray(spans) || !spans.length) return true;
    return spans.some((sp) => sp && inSpan(dayISO, sp));
  });

  // single-day override deltas (the board's effCrew rule)
  const ov = j.dayCrew && j.dayCrew[dayISO];
  if (ov) {
    const rem = Array.isArray(ov.remove) ? ov.remove : [];
    const add = Array.isArray(ov.add) ? ov.add : [];
    crew = crew.filter((c) => !rem.includes(c)).concat(add.filter((c) => !crew.includes(c)));
  }
  return crew;
}

/* "Joel Hess", "Joel Hess and Jimmy Soland", "A, B and C" */
export function namesLine(names) {
  const n = (names || []).filter(Boolean);
  if (!n.length) return "";
  if (n.length === 1) return n[0];
  return n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
}

/* the customer-facing line, posted when the crew's first clock-in of the day
   lands (qb-time-proxy clockinSweep → dailyCrewLines); empty = post nothing */
export function crewLine(names) {
  const line = namesLine(names);
  if (!line) return "";
  return `${line} from our crew ${names.length === 1 ? "is" : "are"} on the job at your property today.`;
}
