/* ============================================================
   Crew schedule digest — pure logic (unit-tested, no Deno/network)
   ------------------------------------------------------------
   Every workday morning each crew member gets ONE text: where
   they're working today, straight from the Job Board's live
   schedule — the same engine the board, the phone agent, and the
   field app's My Week run (./schedule.js is a committed copy of
   apps/board/js/schedule.js; crewdigest.test.mjs fails the build
   if the two ever drift).

   Index.ts owns fetching and sending; this file only decides WHO
   gets WHAT text. A member with nothing scheduled gets no text
   (silence is the honest signal), and the owner gets one roll-up
   so a quiet morning is visibly "nothing scheduled", never
   "the digest broke".
   ============================================================ */
// deno-lint-ignore-file no-explicit-any
import {
  computeSchedule, crewDayLoad, buildLiveOpts, isWorkDay, DEFAULT_SETTINGS,
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

export function buildCrewDigest(input: {
  jobs: Blob[]; crew: Blob[]; entries: Blob[]; settings: Blob;
  today: string;     // AK "YYYY-MM-DD"
  pretty: string;    // AK "Mon, Aug 17"
}): {
  workday: boolean;
  messages: Array<{ crewId: string; name: string; phone: string; text: string; jobs: string[] }>;
  skipped: Array<{ name: string; reason: "out" | "nothing scheduled" | "no phone" }>;
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

  const messages: Array<{ crewId: string; name: string; phone: string; text: string; jobs: string[] }> = [];
  const skipped: Array<{ name: string; reason: "out" | "nothing scheduled" | "no phone" }> = [];
  const active = (input.crew || []).filter((c) => c && c.active !== false && String(c.name || "").trim());
  for (const c of active) {
    const name = String(c.name).trim();
    if ((c.outDays || []).includes(input.today)) { skipped.push({ name, reason: "out" }); continue; }
    const todays = [...((jobsOn.get(c.id) as Map<string, Set<string>> | undefined)?.get(input.today) || [])]
      .map((id) => byId.get(id)).filter(Boolean) as Blob[];
    todays.sort((a, b) => String(a.title || a.customer || "").localeCompare(String(b.title || b.customer || "")));
    if (!todays.length) { skipped.push({ name, reason: "nothing scheduled" }); continue; }
    const phone = String(c.phone || "").trim();
    if (!phone) { skipped.push({ name, reason: "no phone" }); continue; }
    messages.push({
      crewId: c.id, name, phone,
      text: memberText(input.pretty, todays),
      jobs: todays.map((j) => String(j.title || j.customer || "Job")),
    });
  }

  const first = (n: string) => n.split(/\s+/)[0];
  const parts: string[] = [`📅 Crew digest ${input.pretty} — texting ${messages.length}`];
  if (messages.length) parts.push(messages.map((m) => `${first(m.name)}→${m.jobs.join(" + ")}`).join("; "));
  const by = (r: string) => skipped.filter((x) => x.reason === r).map((x) => first(x.name));
  const idle = by("nothing scheduled"), out = by("out"), nophone = by("no phone");
  if (idle.length) parts.push(`not scheduled: ${idle.join(", ")}`);
  if (out.length) parts.push(`out: ${out.join(", ")}`);
  if (nophone.length) parts.push(`⚠️ no phone on the roster: ${nophone.join(", ")}`);
  return { workday: true, messages, skipped, ownerText: parts.join(" · ") };
}
