/* ============================================================
   Crew schedule digest — pure logic (unit-tested, no Deno/network)
   ------------------------------------------------------------
   Every workday morning each crew member gets ONE text: where
   they're working today. The engine is the same one the board, the
   phone agent, and the field app's My Week run (./schedule.js is a
   committed copy of apps/board/js/schedule.js; crewdigest.test.mjs
   fails the build if the two ever drift) — but its LIVE mode slides
   a phase's unfinished hours onto this morning until someone marks
   it done. Right for the Gantt; wrong for a dispatch text. So a job
   only makes someone's text when the PLAN puts them on it today, or
   fresh evidence says they're really there (hours on the job
   today/yesterday, or a dayCrew add for today).

   Index.ts owns fetching and sending; this file only decides WHO
   gets WHAT text. A member with nothing scheduled — or with only
   leftover estimate that slid onto today — gets no text (silence is
   the honest signal), and the owner gets one roll-up so a quiet
   morning is visibly "nothing to dispatch", never "the digest
   broke".
   ============================================================ */
// deno-lint-ignore-file no-explicit-any
import {
  computeSchedule, crewDayLoad, buildLiveOpts, entriesOfJob, isWorkDay, DEFAULT_SETTINGS,
} from "./schedule.js";

export type Blob = Record<string, any>;

export const APP_URL = "https://app.roybalconstruction.com/#/week";

/* Board jobs that belong on a schedule — mirrors the field app's
   myweekcalc.js schedulableJobs (lead = pipeline, done/archived = history). */
export function schedulableJobs(jobs: Blob[]): Blob[] {
  return (jobs || []).filter((j) =>
    j && !j.archived && !j.isMilestone && j.stage !== "lead" && j.stage !== "done");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function shiftDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* The oldest time entry that can still change a live schedule — hours only
   attribute to jobs that are still live, and time_entries passed Supabase's
   1000-row page in Aug 2026 (an unbounded read came back missing the NEWEST
   rows and silently re-dated jobs).
   ⚠️ Mirrors apps/field/js/myweekcalc.js entriesCutoff — the two feed the same
   schedule from different runtimes, so change them together; both are tested
   on the same cases. */
export function entriesCutoff(jobs: Blob[], today: string, buffer = 30, maxDays = 365): string {
  const dates: string[] = [];
  for (const j of schedulableJobs(jobs)) {
    for (const v of [j.startDate, j.hoursFrom]) {
      const s = String(v || "").trim();
      if (ISO_DATE.test(s)) dates.push(s);
    }
  }
  const floor = shiftDays(today, -maxDays);
  if (!dates.length) return shiftDays(today, -90);
  const oldest = dates.sort()[0];
  const withBuffer = shiftDays(oldest, -buffer);
  return withBuffer < floor ? floor : withBuffer;
}

/* One member's text. Exported for tests; index.ts never builds text itself. */
export function memberText(pretty: string, jobs: Blob[]): string {
  const lines = jobs.map((j) => {
    const title = j.title || j.customer || "Job";
    const addr = String(j.address || "").trim();
    const stage = j.stage === "on_hold" ? " (on hold)" : "";
    return `• ${title}${addr ? " — " + addr : ""}${stage}`;
  });
  return `Roybal schedule ${pretty}:\n${lines.join("\n")}\nFull week: ${APP_URL}`;
}

type SkipReason = "out" | "nothing scheduled" | "leftover only" | "no phone" | "off-app";

export function buildCrewDigest(input: {
  jobs: Blob[]; crew: Blob[]; entries: Blob[]; settings: Blob;
  today: string;     // AK "YYYY-MM-DD"
  pretty: string;    // AK "Mon, Aug 17"
}): {
  workday: boolean;
  messages: Array<{ crewId: string; name: string; phone: string; text: string; jobs: string[] }>;
  skipped: Array<{ name: string; reason: SkipReason; jobs?: string[] }>;
  ownerText: string;
} {
  const s = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
  if (!isWorkDay(input.today, s)) return { workday: false, messages: [], skipped: [], ownerText: "" };

  // clone before the engine writes computed dates back onto the jobs
  const jobs = schedulableJobs(input.jobs).map((j) => ({ ...j }));
  let opts: any;
  try { opts = buildLiveOpts(jobs, input.entries || [], s, input.today); } catch { /* plan fallback */ }
  try { computeSchedule(jobs, s, opts); } catch { /* saved dates still work */ }
  // opts must ride into the load or delayed jobs silently un-push (see
  // services/phone-agent/tools.mjs availability)
  const { jobsOn } = crewDayLoad(jobs, s, opts);
  const byId = new Map(jobs.map((j) => [j.id, j]));

  /* Dispatch filter. The live load above books remaining hours from TODAY
     forward, so an unfinished phase whose window ended last week still lands
     on this morning — a Gantt signal, not a "go here today". A (member, job)
     pair on the live load texts only when one of these also holds:
       · the PLAN itself has them on the job today (own clone + own load, so
         the live pass's re-dated starts and slid windows can't bleed in;
         plan-mode crewDayLoad already resolves dayCrew/crewSpans)
       · the job has hours today or yesterday (entriesOfJob's join — THE rule)
       · a dayCrew add pulls them onto the job today (a slid job's plan window
         doesn't reach today, so the plan load never sees that override) */
  const planJobs = schedulableJobs(input.jobs).map((j) => ({ ...j }));
  try { computeSchedule(planJobs, s); } catch { /* saved dates still work */ }
  const { jobsOn: planOn } = crewDayLoad(planJobs, s);
  const yesterday = shiftDays(input.today, -1);
  const freshJobs = new Set(jobs.filter((j) =>
    entriesOfJob(j, input.entries || []).some((e) => {
      const d = String(e.date || "");
      return d === input.today || d === yesterday;
    })).map((j) => j.id));
  const dispatchable = (j: Blob, cid: string) =>
    ((planOn.get(cid) as Map<string, Set<string>> | undefined)?.get(input.today)?.has(j.id) ?? false) ||
    freshJobs.has(j.id) ||
    ((((j.dayCrew || {})[input.today] || {}).add || []) as string[]).includes(cid);

  const messages: Array<{ crewId: string; name: string; phone: string; text: string; jobs: string[] }> = [];
  const skipped: Array<{ name: string; reason: SkipReason; jobs?: string[] }> = [];
  const active = (input.crew || []).filter((c) => c && c.active !== false && String(c.name || "").trim());
  for (const c of active) {
    const name = String(c.name).trim();
    if ((c.outDays || []).includes(input.today)) { skipped.push({ name, reason: "out" }); continue; }
    const onLive = [...((jobsOn.get(c.id) as Map<string, Set<string>> | undefined)?.get(input.today) || [])]
      .map((id) => byId.get(id)).filter(Boolean) as Blob[];
    onLive.sort((a, b) => String(a.title || a.customer || "").localeCompare(String(b.title || b.customer || "")));
    if (!onLive.length) { skipped.push({ name, reason: "nothing scheduled" }); continue; }
    const todays = onLive.filter((j) => dispatchable(j, c.id));
    if (!todays.length) {
      // the board has leftover estimate on them, but nothing says "go" —
      // no text, and the roll-up says why so silence never reads as broken
      skipped.push({ name, reason: "leftover only", jobs: onLive.map((j) => String(j.title || j.customer || "Job")) });
      continue;
    }
    const titles = todays.map((j) => String(j.title || j.customer || "Job"));
    /* Not everyone works through the app. Someone marked off-app is scheduled
       on the board like anyone else but is never texted by an automated lane —
       the owner reaches them himself. The roll-up carries their jobs so the
       owner knows what to relay, instead of them vanishing from the morning. */
    if (c.digestOptOut === true) { skipped.push({ name, reason: "off-app", jobs: titles }); continue; }
    const phone = String(c.phone || "").trim();
    if (!phone) { skipped.push({ name, reason: "no phone", jobs: titles }); continue; }
    messages.push({ crewId: c.id, name, phone, text: memberText(input.pretty, todays), jobs: titles });
  }

  const first = (n: string) => n.split(/\s+/)[0];
  const parts: string[] = [`📅 Crew digest ${input.pretty} — texting ${messages.length}`];
  if (messages.length) parts.push(messages.map((m) => `${first(m.name)}→${m.jobs.join(" + ")}`).join("; "));
  const by = (r: string) => skipped.filter((x) => x.reason === r).map((x) => first(x.name));
  const withJobs = (r: string) => skipped.filter((x) => x.reason === r)
    .map((x) => `${first(x.name)}→${(x.jobs || []).join(" + ")}`);
  const idle = by("nothing scheduled"), out = by("out"), nophone = withJobs("no phone"), offApp = withJobs("off-app");
  const held = withJobs("leftover only");
  if (offApp.length) parts.push(`📞 you tell: ${offApp.join("; ")}`);
  if (held.length) parts.push(`⏳ leftover only (no text): ${held.join("; ")}`);
  if (idle.length) parts.push(`not scheduled: ${idle.join(", ")}`);
  if (out.length) parts.push(`out: ${out.join(", ")}`);
  if (nophone.length) parts.push(`⚠️ no phone on the roster: ${nophone.join(", ")}`);
  return { workday: true, messages, skipped, ownerText: parts.join(" · ") };
}
