/* ============================================================
   Roybal Field Forms — My Week (per-tech schedule view)
   ------------------------------------------------------------
   The signed-in tech's next two weeks, sliced from the Job Board's
   live schedule (myweekcalc.js runs the board's own engine). Who
   "me" is: the crew member whose email matches the login — the
   durable link — falling back to the device's tech pick for crew
   whose email isn't on the roster yet.

   Offline: the last computed week is cached on the device and
   renders immediately; a fresh pull replaces it when online.
   ============================================================ */
import { h, clear, toast } from "./core.js";
import { rest, isSignedIn, currentEmail } from "./supa.js";
import { getTech, pickTech } from "./tech.js";
import { crewByEmail, buildMyWeek, entriesCutoff } from "./myweekcalc.js";

const CACHE_KEY = "roybal-myweek-cache";

/* Sign-out must drop the cached week: the next person to sign in on a shared
   tablet would otherwise be shown the last person's jobs. */
export function clearMyWeekCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
}

const akToday = () => new Date().toLocaleDateString("en-CA");  // device-local day, matching the board

const dayLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

/* Apple Maps on iPhones/iPads, Google Maps elsewhere — both accept ?q= */
export function mapsHref(address, ua) {
  const a = String(address || "").trim();
  if (!a) return "";
  const agent = ua != null ? ua : (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const base = /iPhone|iPad|iPod/i.test(agent) ? "https://maps.apple.com/?q=" : "https://maps.google.com/?q=";
  return base + encodeURIComponent(a);
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
}
function writeCache(payload) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch { /* full/private mode */ }
}

/* Logged hours drive the LIVE schedule, and time_entries passed Supabase's
   1000-row page in Aug 2026 — one unbounded read came back an arbitrary
   subset WITHOUT the newest rows, which silently re-dated jobs. So: only the
   entries that can still matter (entriesCutoff), and page until the server
   runs dry rather than trusting one request to hold everything. */
const PAGE = 1000;
async function fetchEntries(cutoff) {
  const out = [];
  for (let page = 0; page < 6; page++) {
    const res = await rest(
      `time_entries?select=id,data&deleted=is.false&data->>date=gte.${cutoff}` +
      `&order=updated_at.desc&limit=${PAGE}&offset=${page * PAGE}`, { method: "GET" });
    if (!res.ok) break;                       // hours are an optimization; the plan still renders
    const rows = await res.json();
    for (const r of rows) if (r && r.data) out.push(r.data);
    if (rows.length < PAGE) break;
  }
  return out;
}

/* board tables: {id, data, deleted} envelope; the reserved __settings__ row
   carries the work calendar (workDays/holidays/hoursPerDay) */
async function fetchBoard(today) {
  const [jobsRes, crewRes] = await Promise.all([
    rest("coordination_jobs?select=id,data&deleted=is.false&limit=500", { method: "GET" }),
    rest("crew_members?select=data&deleted=is.false", { method: "GET" }),
  ]);
  if (!jobsRes.ok || !crewRes.ok) throw new Error("board read failed");
  const jobRows = await jobsRes.json();
  const settings = (jobRows.find((r) => r.id === "__settings__") || {}).data || {};
  const jobs = jobRows.filter((r) => r && r.id !== "__settings__" && r.data).map((r) => r.data);
  const crew = (await crewRes.json()).map((r) => r.data).filter(Boolean);
  // the entries window depends on the jobs, so this read follows them
  const entries = await fetchEntries(entriesCutoff(jobs, today));
  return { jobs, crew, settings, entries };
}

/* Whose week? Login email match wins (durable); else the device tech pick
   when it maps to a real crew id. Returns { crewId, name, via } or null. */
export function resolveIdentity(crew, email, tech) {
  const byEmail = crewByEmail(crew, email);
  if (byEmail) return { crewId: byEmail.id, name: byEmail.name || "", via: "email" };
  const id = tech && tech.id;
  if (id && crew.some((c) => c && c.id === id)) {
    const m = crew.find((c) => c.id === id);
    return { crewId: id, name: m.name || "", via: "tech" };
  }
  return null;
}

/* `today` is passed in, never assumed to be the week's first day: a cached
   week rendered offline tomorrow would otherwise label yesterday "today". */
function paintWeek(box, week, today) {
  clear(box);
  let shown = 0;
  for (const d of week.days) {
    if (d.day < today) continue;              // stale cache: don't show days that already passed
    const isToday = d.day === today;
    const head = h("div", { style: "display:flex;align-items:center;gap:8px;margin:14px 2px 6px" },
      h("span", { style: "font-weight:800;font-size:14px;color:var(--navy,#0f1b2d)" },
        dayLabel(d.day) + (isToday ? " · today" : "")),
      d.out ? h("span", { style: "font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:#fff4e5;color:#8a6d00" }, "🏖 Out") : null,
      !d.isWork && !d.jobs.length && !d.out
        ? h("span", { class: "subtle", style: "font-size:12px" }, "weekend") : null);
    box.append(head);
    if (d.out) continue;
    if (!d.jobs.length) {
      box.append(h("div", { class: "subtle", style: "margin:0 2px;font-size:13px" },
        d.isWork ? "Nothing scheduled" : "—"));
      continue;
    }
    for (const j of d.jobs) {
      shown++;
      const maps = mapsHref(j.address);
      box.append(h("div", { class: "card", style: "margin:6px 0;padding:10px 12px" },
        h("div", { style: "font-weight:700" }, j.title),
        h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:2px" },
          j.address
            ? (maps ? h("a", { href: maps, target: "_blank", rel: "noopener", style: "font-size:13px" }, "📍 " + j.address)
                    : h("span", { class: "subtle", style: "font-size:13px" }, j.address))
            : h("span", { class: "subtle", style: "font-size:13px" }, "No address on the board"),
          j.stage ? h("span", { class: "subtle", style: "font-size:12px" }, j.stage.replace(/_/g, " ")) : null)));
    }
  }
  if (!shown) {
    box.append(h("div", { class: "empty", style: "margin-top:14px" },
      h("div", { class: "big" }, "📅"),
      h("p", {}, "Nothing on your schedule yet."),
      h("p", { class: "subtle" }, "Jobs land here when the office assigns you on the Job Board.")));
  }
}

/* A cached week is only THIS person's: the payload records the email that
   computed it, and a different login (shared tablet) must never see it. */
export function cacheUsable(cached, email) {
  return !!(cached && cached.week && cached.email && cached.email === email);
}

/* The page. `container` is the router's cleared #view element. */
export function myWeekPage(container) {
  const wrap = h("div", { style: "max-width:560px;margin:0 auto" });
  container.append(wrap);
  const head = h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:2px" },
    h("h1", {}, "My Week"));
  const sub = h("div", { class: "subtle", style: "margin:0 0 4px;font-size:13px" }, "");
  const box = h("div");
  wrap.append(head, sub, box);

  const today = akToday();
  const cached = readCache();

  async function load() {
    if (!isSignedIn()) {
      clear(box);
      box.append(h("div", { class: "empty" },
        h("div", { class: "big" }, "🔒"),
        h("p", {}, "Sign in to see your schedule."),
        h("p", { class: "subtle" }, "Your week comes from the live Job Board, which needs your crew login.")));
      return;
    }
    try {
      const { jobs, crew, settings, entries } = await fetchBoard(today);
      const who = resolveIdentity(crew, currentEmail(), getTech());
      if (!who) {
        clear(box);
        box.append(h("div", { class: "empty" },
          h("div", { class: "big" }, "👤"),
          h("p", {}, "Which crew member are you?"),
          h("p", { class: "subtle" },
            "This login isn't linked to the roster yet — ask the office to add your email to your crew card on the Job Board. Until then, pick your name:"),
          h("button", {
            class: "btn btn--primary", style: "max-width:240px;margin:8px auto 0",
            onclick: async () => { const t = await pickTech(); if (t && t.id) load(); },
          }, "Pick my name")));
        return;
      }
      const week = buildMyWeek({ jobs, crew, entries, settings, crewId: who.crewId, today });
      sub.textContent = who.name
        ? who.name + (who.via === "email" ? "" : " (from this device's tech pick)")
        : "";
      writeCache({ at: new Date().toISOString(), email: currentEmail(), who, week });
      paintWeek(box, week, today);
    } catch (e) {
      // same identity guard as the instant paint: never show one tech the
      // week another tech cached on this device
      if (cacheUsable(cached, currentEmail())) {
        sub.textContent = (cached.who && cached.who.name ? cached.who.name + " · " : "") +
          "offline — last updated " + String(cached.at || "").slice(0, 10);
        paintWeek(box, cached.week, today);
      } else {
        clear(box);
        box.append(h("p", { class: "warn" }, "Couldn't load the schedule: " + String((e && e.message) || e)));
      }
    }
  }

  // cached copy paints instantly; the live pull replaces it
  if (cacheUsable(cached, currentEmail())) {
    sub.textContent = (cached.who && cached.who.name) || "";
    paintWeek(box, cached.week, today);
  } else {
    box.append(h("p", { class: "subtle" }, "Loading your schedule…"));
  }
  load();
}
