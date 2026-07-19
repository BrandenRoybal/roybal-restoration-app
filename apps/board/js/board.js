/* ============================================================
   Roybal Job Board — the digital whiteboard
   Pipeline board (drag cards between stages), job editor, crew
   roster. Layout modeled on the Field app; gold aesthetic.
   Shares the field/admin login + Supabase session.
   ============================================================ */
import { h, $, clear, uid, todayISO, fmtDate, toast } from "../../js/core.js";
import {
  SYNC_ENABLED, isSignedIn, signIn, signOut, currentEmail,
  cachedJobs, cachedCrew, cachedEntries, pull, saveJob, deleteJob,
  saveCrewMember, deleteCrewMember, saveTimeEntry, deleteTimeEntry, pendingCount,
  cachedSettings, saveSettings, setConflictHandler,
} from "./data.js";
import { computeSchedule, durationOf, durationFracOf, wouldCreateCycle, findOverAllocations, crewDayLoad, computeCriticalPath, linkComponents, layoutSubtasks, crewAssignments, workDaysBetween, effCrew, DEFAULT_SETTINGS } from "./schedule.js";
import { pickJobcode, pickQbUser, qbConfigured, pullRange as qbPullRange } from "../../js/qbtime.js";
import { mountAssistProvider } from "../../js/assist.js";
import { boardAssistProvider } from "./assistctx.js";

/* ---------- config ---------- */
const STAGES = [
  { id: "lead",        label: "Leads / Bids",   color: "#7a8aa0" },
  { id: "scheduled",   label: "Scheduled",      color: "#1c5fb0" },
  { id: "in_progress", label: "In Progress",    color: "#f26a21" },
  { id: "on_hold",     label: "On Hold",        color: "#e0a800" },
  { id: "final",       label: "Final / Punch",  color: "#8a6fb0" },
  { id: "done",        label: "Complete",       color: "#1f9d55" },
];
const TYPES = [
  { id: "remodel",     label: "Remodel",          color: "#1c5fb0" },
  { id: "new_build",   label: "New Build",        color: "#8a6fb0" },
  { id: "restoration", label: "Restoration",      color: "#c2487a" },
  { id: "water",       label: "Water Mitigation", color: "#2f8f8f" },
  { id: "fire",        label: "Fire",             color: "#d4520f" },
  { id: "mold",        label: "Mold",             color: "#1f9d55" },
  { id: "other",       label: "Other",            color: "#7a8aa0" },
];
const MATERIALS = [
  { id: "none",     label: "Not ordered" },
  { id: "ordered",  label: "Ordered" },
  { id: "received", label: "Received" },
];
const PRIORITIES = [
  { id: "low",    label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high",   label: "High" },
];
const CREW_COLORS = ["#f26a21", "#1c5fb0", "#1f9d55", "#8a6fb0", "#d4520f", "#2f8f8f", "#4a7fb5", "#c2487a", "#5b6b80", "#7a8aa0"];

/* ---------- state ---------- */
const view = $("#view");
let jobs = [];
let crew = [];
let entries = [];
let settings = DEFAULT_SETTINGS;        // work calendar (loaded from cache/server)
let conflicts = { byJob: new Map(), overloads: [], load: new Map(), byCrew: new Map() };   // capacity over-allocations
let critical = new Set();                          // job ids on the critical path
let ganttCritical = false;                         // Gantt "Critical path" highlight toggle
let ganttFocus = null;                             // job id whose PROJECT is focused in critical mode
let ganttExpanded = new Set();                     // job ids whose phases are expanded on the Gantt
let ganttBaseline = false;                         // Gantt "Baseline" overlay toggle
let filterText = "", filterCrew = "", filterType = "";
let modalOpen = false;
let pollTimer = null;
let draggingId = null;
let currentView = "board";              // "board" | "crew" | "calendar" | "gantt"
const _now = new Date();
let calY = _now.getFullYear(), calM = _now.getMonth();   // calendar month being viewed
let calMode = "month";                                   // "month" | "week" | "day"
let calRef = todayISO();                                  // reference day for week / day modes
let ganttZoom = "day";                  // "day" | "week"

/* ---------- lookups ---------- */
const stageOf = (id) => STAGES.find((s) => s.id === id) || STAGES[0];
const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[TYPES.length - 1];
const crewById = (id) => crew.find((c) => c.id === id);
const initials = (name) => (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const activeCrew = () => crew.filter((c) => c.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
const crewName = (id) => crewById(id)?.name || "—";

/* hours / labor.
   A job's entries = its manual rows (matched by jobId) PLUS any QuickBooks Time
   rows for the QB jobcode it's linked to (matched by qbJobcodeId — the real
   join key the QB pull writes). */
const entriesForJob = (jobId) => {
  const job = jobs.find((j) => j.id === jobId);
  const jc = job && job.qbJobcodeId;
  return entries.filter((e) =>
    e.jobId === jobId || (jc && e.source === "qbtime" && e.qbJobcodeId === jc));
};
/* "Count hours from" — a rebuild job can share its QuickBooks jobcode with the
   mitigation phase of the same loss; hours before this date stay stored but
   don't count toward THIS job (mirrors the field app's Labor Log start date). */
const inHoursScope = (job, e) => !(job && job.hoursFrom) || String(e.date || "") >= job.hoursFrom;
const actualHours = (jobId) => {
  const job = jobs.find((j) => j.id === jobId);
  return entriesForJob(jobId).filter((e) => inHoursScope(job, e)).reduce((s, e) => s + (Number(e.hours) || 0), 0);
};
/* Which crew member an entry belongs to. Manual rows carry crewId; QB rows carry
   qbUserId, resolved to a crew member that's been linked to that QuickBooks user. */
const crewByQbUser = (qbUserId) => qbUserId ? crew.find((c) => c.qbUserId && String(c.qbUserId) === String(qbUserId)) : null;
const entryCrewId = (e) => e.crewId || (e.source === "qbtime" ? (crewByQbUser(e.qbUserId)?.id || null) : null);
const rateOf = (c) => Number(c && (c.hourlyRate ?? c.hourly_rate)) || 0;
const crewHours = (crewId, fromISO) => entries
  .filter((e) => entryCrewId(e) === crewId && (!fromISO || (e.date || "") >= fromISO))
  .reduce((s, e) => s + (Number(e.hours) || 0), 0);
const fmtH = (n) => String(Math.round((Number(n) || 0) * 100) / 100) + "h";
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/* ============================================================
   boot / auth
   ============================================================ */
function boot() {
  if (!SYNC_ENABLED) { jobs = cachedJobs(); crew = cachedCrew(); entries = cachedEntries(); applySchedule(); render(); return; }
  if (isSignedIn()) startUI();
  else renderLogin();
}

async function startUI() {
  $("#acctEmail").textContent = currentEmail();
  $("#signOutBtn").hidden = false;
  // a save that would have clobbered a newer edit from another device is refused;
  // tell the user and reload the latest so no office work is silently lost
  setConflictHandler((serverJob) => {
    toast(`⚠ “${(serverJob && (serverJob.title || serverJob.customer)) || "A job"}” was changed on another device — your edit wasn't saved. Loaded the latest.`, 7000);
    refresh();
  });
  jobs = cachedJobs(); crew = cachedCrew(); entries = cachedEntries();
  applySchedule();
  render();              // instant from cache
  // 💬 dispatcher assistant — floats on document.body, so the wholesale
  // #view re-renders and the 20s poll never touch it; refresh lets an
  // executed confirm chip repaint the board immediately
  mountAssistProvider(boardAssistProvider(refresh));
  await refresh();            // then from server
  startPoll();
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!modalOpen && !document.hidden) refresh(); }, 20000);
}

async function refresh() {
  setSync("syncing");
  try {
    const r = await pull();
    jobs = r.jobs; crew = r.crew; entries = r.entries || [];
    applySchedule();
    setSync(pendingCount() ? "error" : "synced");
    if (!modalOpen) render();
  } catch {
    setSync("offline");
  }
}

/* ---------- scheduling engine glue ----------
   applySchedule recomputes derived start/finish dates in memory (no writes).
   recomputeAndPersist additionally saves every job the engine moved. */
function applySchedule() {
  settings = cachedSettings();
  const res = computeSchedule(jobs, settings);   // { changed, cyclic }; mutates jobs in place
  conflicts = findOverAllocations(jobs, settings);  // refresh crew over-allocations (phase-aware)
  critical = computeCriticalPath(jobs, settings);// refresh critical path
  return res;
}
async function recomputeAndPersist() {
  const { changed } = applySchedule();
  if (changed.length) {
    setSync("syncing");
    for (const j of changed) await saveJob(j);
    setSync(pendingCount() ? "error" : "synced");
  }
  if (!modalOpen) render(); else repaint();
}

function setSync(state) {
  const dot = $("#syncDot");
  const map = {
    syncing: ["#e0a800", "Syncing…"], synced: ["#1f9d55", "Synced"],
    offline: ["#ff6b6b", "Offline — changes saved locally"], error: ["#e0a800", pendingCount() + " change(s) pending"],
  };
  const [c, t] = map[state] || ["#1f9d55", "Online"];
  dot.style.color = c; dot.title = t;
}

$("#signOutBtn").addEventListener("click", () => {
  if (!confirm("Sign out of the Job Board?")) return;
  signOut(); location.reload();
});

/* ============================================================
   login
   ============================================================ */
function renderLogin() {
  $("#acctEmail").textContent = "";
  $("#signOutBtn").hidden = true;
  const body = clear(view);
  const email = h("input", { type: "email", placeholder: "Email", autocomplete: "username" });
  const pass = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const err = h("div", { class: "warn", hidden: true });
  const btn = h("button", { class: "btn btn--primary", style: "margin-top:6px" }, "Sign in");
  async function submit() {
    err.hidden = true; btn.disabled = true; btn.textContent = "Signing in…";
    try { await signIn(email.value, pass.value); startUI(); }
    catch (e) { err.hidden = false; err.textContent = String((e && e.message) || e); btn.disabled = false; btn.textContent = "Sign in"; }
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  body.append(h("div", { class: "blogin" },
    h("img", { src: "../assets/emblem-mark.svg", alt: "", style: "background:#fff;padding:12px;box-sizing:border-box" }),
    h("h1", {}, "Job Board"),
    h("p", { class: "subtle" }, "Sign in with your shared crew account."),
    h("div", { class: "card", style: "text-align:left;margin-top:14px" }, err,
      h("div", { class: "field" }, h("label", {}, "Email"), email),
      h("div", { class: "field" }, h("label", {}, "Password"), pass), btn)));
}

/* ============================================================
   board
   ============================================================ */
function matchesFilter(j) {
  if (filterType && j.type !== filterType) return false;
  if (filterCrew && !(j.crewIds || []).includes(filterCrew)) return false;
  if (filterText) {
    const hay = (j.title + " " + (j.customer || "") + " " + (j.address || "")).toLowerCase();
    if (!hay.includes(filterText)) return false;
  }
  return true;
}

function render() {
  if (currentView === "crew") return renderCrewView();
  if (currentView === "calendar") return renderCalendarView();
  if (currentView === "gantt") return renderGanttView();
  renderBoardView();
}

function renderBoardView() {
  const body = clear(view);
  body.append(h("div", { class: "printhdr" }));
  body.append(renderToolbar());

  if (!crew.length) {
    body.append(h("div", { class: "bempty" },
      h("h2", {}, "Add your crew first"),
      h("p", { class: "subtle" }, "Add your crew members so you can assign them to jobs and tap to call."),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:0 auto", onclick: openCrewModal }, "+ Manage crew")));
    return;
  }

  const visible = jobs.filter(matchesFilter);
  const board = h("div", { class: "bboard" });
  for (const st of STAGES) {
    const colJobs = visible.filter((j) => (j.stage || "lead") === st.id)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    board.append(renderColumn(st, colJobs));
  }
  body.append(board);
}

/* sort: high priority first, then by target date (soonest), then title */
function sortKey(j) {
  const p = j.priority === "high" ? "0" : j.priority === "low" ? "2" : "1";
  return p + "|" + (j.targetDate || "9999-99-99") + "|" + (j.title || "");
}

/* repaint only the inner grid (board / calendar / gantt) — keeps toolbar focus */
function repaint() {
  if (currentView === "crew") return paintCrew();
  if (currentView === "calendar") return paintCalendar();
  if (currentView === "gantt") return paintGantt();
  paintColumns();
}

function viewSwitch() {
  const mk = (id, label) => h("button", {
    class: "vsw__b" + (currentView === id ? " on" : ""),
    onclick: () => { if (currentView !== id) { currentView = id; render(); } },
  }, label);
  return h("div", { class: "vsw" }, mk("board", "Board"), mk("crew", "Crew"), mk("calendar", "Calendar"), mk("gantt", "Gantt"));
}

function filterControls() {
  const search = h("input", { type: "search", placeholder: "Search job, customer, address…", value: filterText });
  search.addEventListener("input", () => { filterText = search.value.toLowerCase(); repaint(); });
  const typeSel = h("select", {}, h("option", { value: "" }, "All types"),
    ...TYPES.map((t) => h("option", { value: t.id, selected: filterType === t.id }, t.label)));
  typeSel.addEventListener("change", () => { filterType = typeSel.value; repaint(); });
  const crewSel = h("select", {}, h("option", { value: "" }, "All crew"),
    ...activeCrew().map((c) => h("option", { value: c.id, selected: filterCrew === c.id }, c.name)));
  crewSel.addEventListener("change", () => { filterCrew = crewSel.value; repaint(); });
  return [search, typeSel, crewSel];
}

function actionButtons() {
  return [
    ...(conflicts.overloads.length ? [h("button", { class: "btn btn--sm confbtn", onclick: openConflicts, title: "Crew booked past their shift on a day" },
      `⚠ ${conflicts.overloads.length} overload${conflicts.overloads.length === 1 ? "" : "s"}`)] : []),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openHelpModal, title: "How to use the Job Board" }, "❓ Help"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openScheduleSettings, title: "Work calendar & hours per day" }, "🗓 Calendar"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openHoursModal }, "⏱ Hours"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openCrewModal, title: "Add or edit crew members" }, "Roster"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => refresh() }, "↻ Refresh"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: exportPDF, title: "Print / save as PDF" }, "🖨 PDF"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => openJobModal(null, true), title: "Add a zero-day milestone" }, "◆ Milestone"),
    h("button", { class: "btn btn--primary btn--sm", onclick: () => openJobModal(null) }, "+ New Job"),
  ];
}

/* ---------- work-calendar settings modal ---------- */
function openScheduleSettings() {
  const s = cachedSettings();
  const DOW = [["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]];
  const dayBoxes = DOW.map(([lbl, idx]) => {
    const cb = h("input", { type: "checkbox", checked: s.workDays.includes(idx) });
    const el = h("label", { class: "dowbox" + (s.workDays.includes(idx) ? " on" : "") }, cb, lbl);
    cb.addEventListener("change", () => el.classList.toggle("on", cb.checked));
    return { idx, cb, el };
  });
  const hpd = h("input", { type: "number", min: "1", max: "24", step: "0.5", value: s.hoursPerDay });

  let holidays = [...(s.holidays || [])].sort();
  const holWrap = h("div", { class: "holwrap" });
  const renderHol = () => {
    clear(holWrap);
    if (!holidays.length) { holWrap.append(h("span", { class: "subtle" }, "None")); return; }
    for (const d of holidays) holWrap.append(h("span", { class: "chip" }, fmtShort(d),
      h("button", { class: "linkx", title: "remove", onclick: () => { holidays = holidays.filter((x) => x !== d); renderHol(); } }, "×")));
  };
  renderHol();
  const holDate = h("input", { type: "date" });
  const holAdd = h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => {
    if (holDate.value && !holidays.includes(holDate.value)) { holidays.push(holDate.value); holidays.sort(); holDate.value = ""; renderHol(); }
  } }, "+ Add");

  const bl = s.baseline;
  const blInfo = h("span", { class: "subtle" }, bl && bl.savedAt ? `Saved ${fmtShort(bl.savedAt.slice(0, 10))} · ${Object.keys(bl.jobs || {}).length} jobs` : "No baseline yet");
  const blSave = h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: async () => { await saveBaselineSnapshot(); closeModal(); } }, "📸 Snapshot now");
  const blClear = bl ? h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: async () => { const c = cachedSettings(); delete c.baseline; settings = c; ganttBaseline = false; await saveSettings(c); closeModal(); toast("Baseline cleared"); } }, "Clear") : null;

  const body = h("div", { class: "bmodal__body" },
    h("p", { class: "subtle", style: "margin-top:0" }, "Drives every auto-scheduled job — durations and the dates jobs land on. Changing this re-flows the whole timeline."),
    field("Working days", h("div", { class: "dowrow" }, ...dayBoxes.map((d) => d.el))),
    field("Hours per work day", h("div", { class: "grid2" }, hpd, h("span", { class: "subtle", style: "align-self:center" }, "e.g. 10 in summer · 8 in winter"))),
    field("Holidays (skipped)", h("div", {}, h("div", { class: "haddrow" }, holDate, holAdd), holWrap)),
    field("Baseline (plan snapshot)", h("div", {}, h("div", { style: "margin-bottom:6px" }, blInfo), h("div", { class: "row-add" }, blSave, blClear))));

  const save = h("button", { class: "btn btn--primary" }, "Save & re-flow");
  save.addEventListener("click", async () => {
    const workDays = dayBoxes.filter((d) => d.cb.checked).map((d) => d.idx).sort((a, b) => a - b);
    if (!workDays.length) { toast("Pick at least one working day"); return; }
    const next = { ...cachedSettings(), workDays, hoursPerDay: Math.max(1, Number(hpd.value) || 10), holidays: holidays.slice() };
    save.disabled = true;
    closeModal();
    await saveSettings(next);
    await recomputeAndPersist();
    toast("Schedule settings saved");
  });
  openModal("Schedule settings", body, h("div", { class: "bmodal__foot" },
    h("button", { class: "btn btn--ghost", onclick: closeModal }, "Cancel"), save));
}

/* ---------- crew overload summary (capacity-based) ---------- */
function freeThatDay(day) {
  const cap = Math.max(1, settings.hoursPerDay || 8);
  return activeCrew().map((c) => ({ c, free: cap - ((conflicts.load.get(c.id) || new Map()).get(day) || 0) }))
    .filter((x) => x.free >= 1).sort((a, b) => b.free - a.free);
}
function openConflicts() {
  const cap = Math.max(1, settings.hoursPerDay || 8);
  const ovs = conflicts.overloads;
  const list = ovs.length ? ovs.map((o) => {
    const free = freeThatDay(o.day).slice(0, 4);
    return h("div", { class: "confrow" },
      h("span", { class: "crewchip is-clash", style: `background:${crewById(o.crewId)?.color || "#7a8aa0"}`, title: crewName(o.crewId) }, initials(crewName(o.crewId))),
      h("div", { class: "confrow__main" },
        h("div", {}, h("strong", {}, crewName(o.crewId)), " — ", h("strong", {}, fmtShort(o.day)), "  ",
          h("span", { class: "ovpct" }, `${Math.round(o.hours)}h · ${o.pct}% of shift`)),
        h("div", { class: "subtle" }, "on ", ...o.jobIds.flatMap((id, i) => {
          const j = jobs.find((x) => x.id === id) || {};
          return [i ? " + " : "", h("button", { class: "linklike", onclick: () => { closeModal(); openJobModal(j); } }, j.title || j.customer || "Job")];
        })),
        free.length ? h("div", { class: "confree" }, "↳ free that day: " + free.map((x) => `${x.c.name} (${Math.round(x.free)}h)`).join(" · ")) : null));
  }) : [h("div", { class: "subtle" }, "No overloads — everyone's within their shift. 🎉")];
  const body = h("div", { class: "bmodal__body" },
    h("p", { class: "subtle", style: "margin-top:0" }, `${ovs.length} day${ovs.length === 1 ? "" : "s"} where a crew member is booked past their ${cap}h shift. Hand a phase to someone free that day, or reschedule it.`),
    h("div", { class: "conflist" }, ...list));
  openModal("Crew overloads", body, h("div", { class: "bmodal__foot" }, h("button", { class: "btn btn--ghost", onclick: closeModal }, "Close")));
}

/* ---------- export / print to PDF ----------
   Uses the browser's print → "Save as PDF". A print stylesheet hides the
   chrome and shows a print header; the Gantt is zoom-fit to the page. */
function exportPDF() { window.print(); }

function printSub() {
  const parts = [];
  if (filterType) parts.push("Type: " + typeOf(filterType).label);
  if (filterCrew) parts.push("Crew: " + crewName(filterCrew));
  if (filterText) parts.push(`Search: “${filterText}”`);
  parts.push("Generated " + fmtDate(todayISO()));
  return parts.join("  ·  ");
}
function updatePrintHeader() {
  const hdr = $(".printhdr", view);
  if (!hdr) return;
  let title = "Job Board";
  if (currentView === "calendar") title = "Calendar — " + monthLabel();
  else if (currentView === "gantt") title = "Timeline" + (ganttZoom !== "day" ? ` (${ganttZoom})` : "");
  hdr.replaceChildren(h("h2", {}, "Roybal Construction — " + title), h("div", { class: "sub" }, printSub()));
}
window.addEventListener("beforeprint", () => {
  updatePrintHeader();
  if (currentView === "gantt") {
    const inner = $(".gantt__inner", view);
    if (inner) {
      inner.style.minWidth = "0";          // collapse to true content width (screen stretches it to 100%)
      const s = Math.min(1, 960 / inner.scrollWidth);
      inner.style.zoom = s < 1 ? s : "";
    }
  }
});
window.addEventListener("afterprint", () => {
  const inner = $(".gantt__inner", view);
  if (inner) { inner.style.zoom = ""; inner.style.minWidth = ""; }
});

/* re-fit the Gantt "Fit" zoom when the window resizes */
let _resizeTimer = null;
window.addEventListener("resize", () => {
  if (currentView !== "gantt" || ganttZoom !== "fit") return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if (currentView === "gantt" && ganttZoom === "fit") paintGantt(); }, 150);
});

function renderToolbar() {
  return h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), h("h1", {}, "Job Board")),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons()));
}

/* repaint only the columns (keeps toolbar inputs focused while filtering) */
function paintColumns() {
  const old = $(".bboard", view);
  if (!old) return render();
  const visible = jobs.filter(matchesFilter);
  const fresh = h("div", { class: "bboard" });
  for (const st of STAGES) {
    const colJobs = visible.filter((j) => (j.stage || "lead") === st.id).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    fresh.append(renderColumn(st, colJobs));
  }
  old.replaceWith(fresh);
}

function renderColumn(st, colJobs) {
  const bodyEl = h("div", { class: "bcol__body" },
    ...(colJobs.length ? colJobs.map(renderCard) : [h("div", { class: "bcol__empty" }, "—")]));

  bodyEl.addEventListener("dragover", (e) => { e.preventDefault(); bodyEl.classList.add("drop-over"); });
  bodyEl.addEventListener("dragleave", () => bodyEl.classList.remove("drop-over"));
  bodyEl.addEventListener("drop", (e) => {
    e.preventDefault(); bodyEl.classList.remove("drop-over");
    const id = draggingId || e.dataTransfer.getData("text/plain");
    moveJob(id, st.id);
  });

  return h("div", { class: "bcol" },
    h("div", { class: "bcol__head" },
      h("span", { class: "bcol__dot", style: `background:${st.color}` }),
      h("span", { class: "bcol__name" }, st.label),
      h("span", { class: "bcol__count" }, String(colJobs.length))),
    bodyEl);
}

function renderCard(j) {
  if (j.isMilestone) {
    const card = h("div", { class: "bcard bcard--ms", draggable: "true", onclick: () => openJobModal(j) },
      h("div", { class: "bcard__top" }, h("span", { class: "ms-diamond" }, "◆"),
        h("span", { class: "bcard__title" }, j.title || "Milestone")),
      j.startDate ? h("div", { class: "bcard__sub" }, "🏁 " + fmtShort(j.startDate)) : h("div", { class: "bcard__sub subtle" }, "No date — pin a date or link it after a job"));
    card.addEventListener("dragstart", (e) => { draggingId = j.id; e.dataTransfer.setData("text/plain", j.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { draggingId = null; card.classList.remove("dragging"); });
    return card;
  }
  const ty = typeOf(j.type);
  const late = j.targetDate && j.targetDate < todayISO() && (j.stage || "lead") !== "done";
  const act = actualHours(j.id);
  const est = Number(j.estimatedHours) || 0;
  const over = est > 0 && act > est;

  const card = h("div", {
    class: "bcard", draggable: "true",
    style: `border-left-color:${stageOf(j.stage).color}`,
    onclick: () => openJobModal(j),
  });
  card.addEventListener("dragstart", (e) => { draggingId = j.id; e.dataTransfer.setData("text/plain", j.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
  card.addEventListener("dragend", () => { draggingId = null; card.classList.remove("dragging"); });

  const top = h("div", { class: "bcard__top" },
    h("span", { class: "btype", style: `background:${ty.color}` }, ty.label),
    j.priority === "high" ? h("span", { class: "prio prio--high", title: "High priority" }) :
      j.priority === "low" ? h("span", { class: "prio prio--low", title: "Low priority" }) : null);

  const meta = h("div", { class: "bcard__meta" });
  // crew over-allocation warning
  const jc = conflicts.byJob.get(j.id) || [];
  const clashCrew = new Set(jc.map((x) => x.crewId));
  if (jc.length) {
    const detail = jc.map((x) => `${crewName(x.crewId)} ${Math.round(x.hours)}h on ${fmtShort(x.day)}`).join("\n");
    meta.append(h("span", { class: "chip is-warn", title: detail },
      `⚠ ${clashCrew.size === 1 ? crewName([...clashCrew][0]) + " overloaded" : clashCrew.size + " crew overloaded"}`));
  }
  // critical path
  if (critical.has(j.id)) meta.append(h("span", { class: "chip is-crit", title: "On the critical path — a slip here pushes your final completion date" }, "⚡ Critical"));
  // crew chips
  const ids = (j.crewIds || []).filter(crewById);
  if (ids.length) {
    meta.append(h("span", { class: "crew" },
      ...ids.slice(0, 5).map((id) => { const c = crewById(id); return h("span", { class: "crewchip" + (clashCrew.has(id) ? " is-clash" : ""), style: `background:${c.color || "#7a8aa0"}`, title: c.name + (clashCrew.has(id) ? " — double-booked (overlapping jobs)" : "") }, initials(c.name)); })));
  }
  // dates
  if (j.startDate || j.targetDate) {
    const txt = j.startDate && j.targetDate ? `${fmtShort(j.startDate)} → ${fmtShort(j.targetDate)}`
      : j.targetDate ? `Due ${fmtShort(j.targetDate)}` : `Start ${fmtShort(j.startDate)}`;
    meta.append(h("span", { class: "chip" + (late ? " is-late" : "") }, "📅 " + txt));
  }
  // hours: actual vs estimated
  if (act || est) {
    const label = est && act ? "⏱ " + (Math.round(act * 100) / 100) + " / " + fmtH(est)
      : est ? "⏱ " + fmtH(est) + " est" : "⏱ " + fmtH(act) + " logged";
    meta.append(h("span", { class: "chip" + (over ? " is-late" : "") }, label));
  }
  // materials
  const mat = j.materials || "none";
  if (mat === "ordered") meta.append(h("span", { class: "chip mat-ordered" }, "🔧 Materials ordered"));
  else if (mat === "received") meta.append(h("span", { class: "chip mat-received" }, "🔧 Materials in"));
  else meta.append(h("span", { class: "chip mat-none" }, "🔧 Materials TBD"));
  // start-no-earlier-than constraint (materials / permit)
  if (j.notBefore) meta.append(h("span", { class: "chip is-lock", title: (j.notBeforeLabel ? j.notBeforeLabel + " — " : "") + "can't start before " + fmtShort(j.notBefore) },
    "🔒 " + (j.notBeforeLabel ? j.notBeforeLabel + " " : "not before ") + fmtShort(j.notBefore)));
  // phases (sub-tasks)
  if ((j.subtasks || []).length) meta.append(h("span", { class: "chip is-phase", title: j.subtasks.map((st, i) => `${i + 1}. ${st.name || "Phase"} — ${st.durationDays || 1}d${st.lagDays ? ` (+${st.lagDays}d lag)` : ""}`).join("\n") },
    "📋 " + j.subtasks.length + " phase" + (j.subtasks.length === 1 ? "" : "s")));
  // field-app link — amber when the field sent a phase plan awaiting review
  if (j.fieldJobId) meta.append(h("span", {
    class: "chip" + (j.fieldPlanProposal ? " is-warn" : ""),
    title: j.fieldPlanProposal ? "The field app sent an updated phase plan — open the job to review it" : "Linked to a field app job",
  }, j.fieldPlanProposal ? "⚠ field update" : "📱 field-linked"));

  const phone = j.phone ? h("a", { class: "bcall", href: "tel:" + j.phone.replace(/[^\d+]/g, ""), onclick: (e) => e.stopPropagation() }, "📞 " + j.phone) : null;

  // hours progress meter (only when an estimate exists)
  const bar = est > 0 ? h("div", { class: "hbar", title: `${Math.round(act * 100) / 100} of ${est}h logged` },
    h("span", { class: "hbar__fill" + (over ? " over" : ""), style: `width:${Math.min(100, est ? (act / est) * 100 : 0)}%` })) : null;

  card.append(...[
    top,
    h("div", { class: "bcard__title" }, j.title || j.customer || "Untitled job"),
    j.address ? h("div", { class: "bcard__sub" }, j.address) : null,
    meta,
    bar,
    phone ? h("div", { style: "margin-top:6px" }, phone) : null,
  ].filter(Boolean));
  return card;
}

const fmtShort = (iso) => { const d = fmtDate(iso); return d.replace(/, \d{4}$/, ""); }; // "Jun 12"

async function moveJob(id, stageId) {
  const j = jobs.find((x) => x.id === id);
  if (!j || (j.stage || "lead") === stageId) return;
  j.stage = stageId;
  render();
  setSync("syncing");
  await saveJob(j);
  setSync(pendingCount() ? "error" : "synced");
}

/* ============================================================
   calendar view (month grid — jobs on their scheduled days)
   ============================================================ */
const toISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function jobActiveOn(j, iso) {
  const s = j.startDate, t = j.targetDate;
  if (s && t) return iso >= s && iso <= t;
  if (s) return iso === s;
  if (t) return iso === t;
  return false;
}
const monthLabel = () => new Date(calY, calM, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

function renderCalendarView() {
  const body = clear(view);
  body.append(h("div", { class: "printhdr" }));
  body.append(renderCalToolbar());
  if (!crew.length) {
    body.append(h("div", { class: "bempty" },
      h("h2", {}, "Add your crew first"),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:0 auto", onclick: openCrewModal }, "+ Manage crew")));
    return;
  }
  body.append(h("div", { class: "calwrap" }));   // filled by paintCalendar
  paintCalendar();
}

const fmtMD = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
function calLabel() {
  if (calMode === "day") return new Date(calRef + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (calMode === "week") { const s = weekStart(calRef); return `${fmtMD(s)} – ${fmtMD(toISO(addDays(new Date(s + "T00:00:00"), 6)))}`; }
  return monthLabel();
}
const weekStart = (iso) => { const d = new Date(iso + "T00:00:00"); return toISO(addDays(d, -d.getDay())); };

function renderCalToolbar() {
  const nav = h("div", { class: "calnav" },
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftCal(-1) }, "‹"),
    h("strong", { class: "calnav__label" }, calLabel()),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftCal(1) }, "›"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: goToday }, "Today"));
  const modeBtn = (id, lbl) => h("button", { class: "vsw__b" + (calMode === id ? " on" : ""), onclick: () => { if (calMode !== id) { calMode = id; renderCalendarView(); } } }, lbl);
  const modes = h("div", { class: "vsw cal-modes" }, modeBtn("day", "Day"), modeBtn("week", "Week"), modeBtn("month", "Month"));
  return h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), nav, modes),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons()));
}

function shiftCal(delta) {
  if (calMode === "month") { calM += delta; if (calM < 0) { calM = 11; calY--; } else if (calM > 11) { calM = 0; calY++; } }
  else calRef = toISO(addDays(new Date(calRef + "T00:00:00"), delta * (calMode === "week" ? 7 : 1)));
  const lbl = $(".calnav__label", view); if (lbl) lbl.textContent = calLabel();
  paintCalendar();
}
function goToday() { calY = _now.getFullYear(); calM = _now.getMonth(); calRef = todayISO(); const lbl = $(".calnav__label", view); if (lbl) lbl.textContent = calLabel(); paintCalendar(); }

/* small colored crew avatars for a job on a given day (effective crew minus
   anyone out) — a quick "who's on this job" glance on the calendar */
function calCrewRow(j, iso, cap) {
  if (j.isMilestone) return null;
  const ids = effectiveCrewOn(j, iso).filter((id) => { const c = crewById(id); return c && !isOut(c, iso); });
  if (!ids.length) return null;
  const row = h("div", { class: "cal__crew" });
  ids.slice(0, cap).forEach((id) => {
    const c = crewById(id);
    row.append(h("span", { class: "cala", style: `background:${c.color || "#7a8aa0"}`, title: c.name }, initials(c.name)));
  });
  if (ids.length > cap) row.append(h("span", { class: "cala cala--more", title: ids.slice(cap).map((id) => crewById(id)?.name).join(", ") }, "+" + (ids.length - cap)));
  return row;
}

function calDayCell(iso, opts = {}) {
  const today = todayISO();
  const d = new Date(iso + "T00:00:00");
  const visible = jobs.filter(matchesFilter);
  const cell = h("div", { class: "cal__cell" + (opts.out ? " out" : "") + (iso === today ? " today" : "") },
    h("div", { class: "cal__day" }, opts.dayLabel != null ? opts.dayLabel : String(d.getDate())));
  const cap = calMode === "month" ? 5 : 8;
  for (const j of visible.filter((x) => jobActiveOn(x, iso))) {
    const marker = j.isMilestone ? "◆ " : j.startDate === iso ? "▶ " : j.targetDate === iso ? "⚑ " : "";
    cell.append(h("div", {
      class: "cal__job" + (j.isMilestone ? " cal__job--ms" : ""), style: `border-left-color:${j.isMilestone ? "#5b4ba8" : stageOf(j.stage).color}`,
      title: (j.title || j.customer || "Job"), onclick: () => openJobModal(j),
    }, marker + (j.title || j.customer || "Job"), calCrewRow(j, iso, cap)));
  }
  return cell;
}

function paintCalendar() {
  const wrap = $(".calwrap", view);
  if (!wrap) return renderCalendarView();
  clear(wrap);
  const visible = jobs.filter(matchesFilter);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (calMode === "day") {
    const iso = calRef;
    wrap.append(h("div", { class: "cal__grid cal--day" }, calDayCell(iso, { dayLabel: "" })));
  } else if (calMode === "week") {
    const start = weekStart(calRef);
    const head = h("div", { class: "cal__head cal--week" }, ...DOW.map((dn, i) => {
      const iso = toISO(addDays(new Date(start + "T00:00:00"), i));
      return h("div", { class: "cal__hd" }, dn + " " + new Date(iso + "T00:00:00").getDate());
    }));
    const grid = h("div", { class: "cal__grid cal--week" });
    for (let i = 0; i < 7; i++) grid.append(calDayCell(toISO(addDays(new Date(start + "T00:00:00"), i)), { dayLabel: "" }));
    wrap.append(head, grid);
  } else {
    const first = new Date(calY, calM, 1);
    const gridStart = addDays(first, -first.getDay());
    const head = h("div", { class: "cal__head" }, ...DOW.map((d) => h("div", { class: "cal__hd" }, d)));
    const grid = h("div", { class: "cal__grid" });
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      grid.append(calDayCell(toISO(d), { out: d.getMonth() !== calM }));
    }
    wrap.append(head, grid);
  }

  const unsched = visible.filter((j) => !j.startDate && !j.targetDate);
  if (unsched.length) {
    wrap.append(h("div", { class: "calunsched" },
      h("div", {}, h("strong", {}, `Unscheduled (${unsched.length}) `),
        h("span", { class: "subtle" }, "— add a start or target date to place these on the calendar")),
      h("div", { class: "calunsched__row" }, ...unsched.map((j) =>
        h("span", { class: "cal__job cal__job--chip", style: `border-left-color:${stageOf(j.stage).color}`, onclick: () => openJobModal(j) },
          j.title || j.customer || "Job")))));
  }
}

/* ============================================================
   gantt timeline (one duration bar per job across a date axis)
   ============================================================ */
const dayDiff = (aISO, bISO) => Math.round((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / 86400000);

function renderGanttView() {
  const body = clear(view);
  body.append(h("div", { class: "printhdr" }));
  body.append(renderGanttToolbar());
  if (!crew.length) {
    body.append(h("div", { class: "bempty" },
      h("h2", {}, "Add your crew first"),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:0 auto", onclick: openCrewModal }, "+ Manage crew")));
    return;
  }
  body.append(h("div", { class: "gwrap" }));   // filled by paintGantt
  paintGantt();
}

function renderGanttToolbar() {
  const zoom = h("div", { class: "vsw" },
    h("button", { class: "vsw__b" + (ganttZoom === "fit" ? " on" : ""), onclick: () => setZoom("fit"), title: "Fit the whole timeline on screen" }, "Fit"),
    h("button", { class: "vsw__b" + (ganttZoom === "day" ? " on" : ""), onclick: () => setZoom("day") }, "Day"),
    h("button", { class: "vsw__b" + (ganttZoom === "week" ? " on" : ""), onclick: () => setZoom("week") }, "Week"),
    h("button", { class: "vsw__b" + (ganttZoom === "month" ? " on" : ""), onclick: () => setZoom("month") }, "Month"));
  const critBtn = h("button", {
    class: "btn btn--ghost btn--sm" + (ganttCritical ? " criton" : ""), onclick: toggleCritical,
    title: "Trace one project's critical path — click it on, then click a job to focus its project",
  }, "⚡ Critical path");
  const focusJob = ganttCritical && ganttFocus ? jobs.find((j) => j.id === ganttFocus) : null;
  const critFocusChip = ganttCritical ? h("span", { class: "critfocus", title: "Click a job's name on the timeline to focus a different project" },
    focusJob ? "▸ " + (focusJob.title || focusJob.customer || "Job") : "click a job to focus") : null;
  const baseBtn = h("button", {
    class: "btn btn--ghost btn--sm" + (ganttBaseline ? " baseon" : ""), onclick: toggleBaseline,
    title: "Compare against a saved snapshot of the schedule (ghost bars + slippage)",
  }, "📸 Baseline");
  const fin = projectFinish();
  const finChip = fin ? h("span", { class: "ganttfin", title: "Projected completion — latest job finish" }, "🏁 Finish " + fmtShort(fin)) : null;
  return h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), h("h1", {}, "Timeline"), zoom, critBtn, critFocusChip, baseBtn, finChip),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons()));
}
function setZoom(z) { if (ganttZoom === z) return; ganttZoom = z; renderGanttView(); }
function toggleCritical() {
  ganttCritical = !ganttCritical;
  if (ganttCritical) ganttFocus = latestDatedJobId();   // default to the project finishing last
  renderGanttView();
}
/* the job that finishes last (its project is the sensible default focus) */
function latestDatedJobId() {
  let id = null, end = null;
  for (const j of jobs.filter(matchesFilter)) if (!j.isMilestone && j.targetDate && (!end || j.targetDate > end)) { end = j.targetDate; id = j.id; }
  return id;
}
function projectFinish() { let end = null; for (const j of jobs) if (j.targetDate && (!end || j.targetDate > end)) end = j.targetDate; return end; }

/* baseline = a saved snapshot of every job's start/finish, to track slippage */
function hasBaseline() { const b = cachedSettings().baseline; return b && b.jobs && Object.keys(b.jobs).length; }
async function saveBaselineSnapshot() {
  const s = cachedSettings();
  const snap = { savedAt: new Date().toISOString(), jobs: {} };
  for (const j of jobs) if (!j.isMilestone && j.startDate && j.targetDate) snap.jobs[j.id] = { start: j.startDate, finish: j.targetDate };
  s.baseline = snap; settings = s;
  await saveSettings(s);
  toast("Baseline saved — " + Object.keys(snap.jobs).length + " jobs");
}
function toggleBaseline() {
  if (!ganttBaseline && !hasBaseline()) { saveBaselineSnapshot().then(() => { ganttBaseline = true; renderGanttView(); }); return; }
  ganttBaseline = !ganttBaseline; renderGanttView();
}

function paintGantt() {
  const wrap = $(".gwrap", view);
  if (!wrap) return renderGanttView();
  clear(wrap);

  const visible = jobs.filter(matchesFilter);
  const dated = visible
    .filter((j) => j.startDate || j.targetDate)
    .map((j) => { const a = j.startDate || j.targetDate, b = j.targetDate || j.startDate; return { j, s: a < b ? a : b, t: b > a ? b : a }; })
    .sort((x, y) => x.s.localeCompare(y.s) || (x.j.title || "").localeCompare(y.j.title || ""));
  const unsched = visible.filter((j) => !j.startDate && !j.targetDate);

  // critical-path FOCUS: in critical mode we light up one project (a linked group)
  // at a time so the whole board doesn't turn into a red tangle.
  const comp = ganttCritical ? linkComponents(jobs) : null;
  if (ganttCritical && (!ganttFocus || !comp.has(ganttFocus))) ganttFocus = latestDatedJobId();
  const focusComp = comp && ganttFocus ? comp.get(ganttFocus) : null;
  const focusSize = focusComp != null ? [...comp.values()].filter((c) => c === focusComp).length : 0;
  const focused = (id) => !ganttCritical ? true : (focusComp != null && comp.get(id) === focusComp);
  const isRed = (id) => ganttCritical && focused(id) && (critical.has(id) || focusSize === 1);

  if (!dated.length) {
    wrap.append(h("div", { class: "bempty" }, h("h2", {}, "Nothing scheduled"),
      h("p", { class: "subtle" }, "Add a start or target date to a job to see it on the timeline.")));
    return;
  }

  // date range (pad 2 days each side)
  let minISO = dated[0].s, maxISO = dated[0].t;
  for (const d of dated) { if (d.s < minISO) minISO = d.s; if (d.t > maxISO) maxISO = d.t; }
  const rangeStart = addDays(new Date(minISO + "T00:00:00"), -2);
  const startISO = toISO(rangeStart);
  const totalDays = dayDiff(startISO, maxISO) + 5;
  let dayW;
  if (ganttZoom === "fit") {
    const avail = Math.max(320, (wrap.clientWidth || 1000) - 180 - 6);   // pane width minus the job-name column
    dayW = Math.max(2, avail / totalDays);                               // scale so the whole range fits
  } else {
    dayW = ganttZoom === "month" ? 7 : ganttZoom === "week" ? 9 : 26;
  }
  const monthMode = ganttZoom === "month" || (ganttZoom === "fit" && dayW < 10);
  const trackW = totalDays * dayW;
  const today = todayISO();
  const todayX = (today >= startISO && dayDiff(startISO, today) <= totalDays) ? dayDiff(startISO, today) * dayW : -1;

  // ----- header: month band (+ week ticks unless in month mode) -----
  const months = h("div", { class: "gantt__months", style: `width:${trackW}px` });
  const monthBounds = [];   // day-index of each internal month boundary (for month-mode gridlines)
  let m = -1, segStart = 0;
  for (let i = 0; i <= totalDays; i++) {
    const mm = i === totalDays ? -999 : addDays(rangeStart, i).getMonth();
    if (mm !== m) {
      if (m !== -1) {
        const seg = addDays(rangeStart, segStart);
        months.append(h("div", { class: "gantt__month", style: `width:${(i - segStart) * dayW}px` },
          seg.toLocaleDateString("en-US", { month: "short", year: "2-digit" })));
        if (i < totalDays) monthBounds.push(i);
      }
      m = mm; segStart = i;
    }
  }
  const scaleChildren = [months];
  if (!monthMode) {
    const weeks = h("div", { class: "gantt__weeks", style: `width:${trackW}px` });
    for (let i = 0; i < totalDays; i += 7) {
      weeks.append(h("div", { class: "gantt__week", style: `width:${Math.min(7, totalDays - i) * dayW}px` },
        fmtShort(toISO(addDays(rangeStart, i)))));
    }
    scaleChildren.push(weeks);
  }
  const header = h("div", { class: "gantt__header" },
    h("div", { class: "gantt__corner" }, "Job"),
    h("div", { class: "gantt__scale", style: `width:${trackW}px` }, ...scaleChildren));

  // ----- rows (collect bar geometry for dependency arrows) -----
  const geo = new Map();
  const phaseLinks = [];   // red connectors between consecutive phases of a critical job
  const rowH = 40, barMid = 20, headerH = monthMode ? 22 : 40;
  const rows = [];
  let vi = 0;   // running visual row index (accounts for expanded phase rows)
  for (const { j, s, t } of dated) {
    const left = dayDiff(startISO, s) * dayW;
    if (j.isMilestone) {
      geo.set(j.id, { ri: vi, left, w: 8 });
      const msDim = ganttCritical && !focused(j.id) ? " dim" : "";
      const track = h("div", { class: "gantt__track" + (monthMode ? " gantt__track--plain" : ""), style: `width:${trackW}px` + (monthMode ? "" : `;--gw:${7 * dayW}px`) },
        h("div", { class: "gantt__ms" + msDim, style: `left:${left}px`, title: `${j.title || "Milestone"}\n${fmtShort(s)}`, onclick: () => openJobModal(j) }, "◆"),
        h("div", { class: "gantt__ms-name", style: `left:${left + 16}px` }, j.title || "Milestone"));
      if (monthMode) for (const b of monthBounds) track.append(h("div", { class: "gantt__mline", style: `left:${b * dayW}px` }));
      if (todayX >= 0) track.append(h("div", { class: "gantt__today", style: `left:${todayX}px` }));
      rows.push(h("div", { class: "gantt__row gantt__row--ms" },
        h("div", { class: "gantt__label", title: j.title || "Milestone" }, "◆ " + (j.title || "Milestone")), track));
      vi++;
      continue;
    }
    const w = Math.max((dayDiff(s, t) + 1) * dayW - 2, 8);
    geo.set(j.id, { ri: vi, left, w });
    const act = actualHours(j.id), est = Number(j.estimatedHours) || 0;
    const pct = est > 0 ? Math.min(100, Math.round((act / est) * 100)) : 0;
    const over = est > 0 && act > est;
    const hrs = est ? `  ·  ${Math.round(act * 100) / 100}/${est}h${pct ? ` (${pct}%)` : ""}` : (act ? `  ·  ${fmtH(act)}` : "");
    // progress fill: tint the done portion of the bar (orange; red when over-hours)
    const fillBg = pct > 0 ? `;background:linear-gradient(to right, ${over ? "rgba(210,59,46,.24)" : "rgba(242,106,33,.24)"} ${pct}%, #fff ${pct}%)` : "";
    const clash = conflicts.byJob.has(j.id);
    const critCls = ganttCritical ? (focused(j.id) ? (isRed(j.id) ? " crit" : "") : " dim") : "";
    const bar = h("div", {
      class: "gantt__bar" + (clash ? " has-clash" : "") + critCls, style: `left:${left}px;width:${w}px;border-left-color:${stageOf(j.stage).color}${fillBg}`,
      title: `${j.title || j.customer || "Job"}\n${fmtShort(s)} – ${fmtShort(t)}${est ? `\n${Math.round(act * 100) / 100} of ${est}h (${pct}%${over ? " — over" : ""})` : ""}${clash ? "\n⚠ crew double-booked" : ""}\n(drag to reschedule)`,
      onclick: () => { if (bar._dragged) { bar._dragged = false; return; } openJobModal(j); },
    }, (clash ? "⚠ " : "") + (j.title || j.customer || "Job") + hrs);
    // drag-to-reschedule: pins the job to a manual start, then cascades dependents
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      drag = { x: e.clientX };
      try { bar.setPointerCapture(e.pointerId); } catch {}
    });
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true; bar.classList.add("dragging");
      bar.style.left = (left + dx) + "px";
    });
    bar.addEventListener("pointerup", async (e) => {
      if (!drag) return;
      const moved = drag.moved, dx = e.clientX - drag.x; drag = null;
      bar.classList.remove("dragging");
      try { bar.releasePointerCapture(e.pointerId); } catch {}
      if (!moved) return;                 // a plain click → onclick opens the editor
      bar._dragged = true;                // swallow the click event that follows
      const daysMoved = Math.round(dx / dayW);
      if (!daysMoved) { paintGantt(); return; }
      j.scheduleMode = "manual";
      j.pinnedStart = toISO(addDays(new Date(s + "T00:00:00"), daysMoved));
      await recomputeAndPersist();
    });
    const track = h("div", {
      class: "gantt__track" + (monthMode ? " gantt__track--plain" : ""),
      style: `width:${trackW}px` + (monthMode ? "" : `;--gw:${7 * dayW}px`),
    }, bar);
    if (monthMode) for (const b of monthBounds) track.append(h("div", { class: "gantt__mline", style: `left:${b * dayW}px` }));
    if (todayX >= 0) track.append(h("div", { class: "gantt__today", style: `left:${todayX}px` }));
    if (j.notBefore && j.notBefore >= startISO) {
      const nbX = dayDiff(startISO, j.notBefore) * dayW;
      if (nbX >= 0 && nbX <= trackW) track.append(h("div", { class: "gantt__nb", style: `left:${nbX}px`,
        title: (j.notBeforeLabel ? j.notBeforeLabel + " — " : "") + "start no earlier than " + fmtShort(j.notBefore) }, "🔒"));
    }
    // baseline: ghost bar at the snapshot span + slippage chip
    const base = ganttBaseline && settings.baseline && settings.baseline.jobs ? settings.baseline.jobs[j.id] : null;
    if (base && base.start && base.finish) {
      const bLeft = dayDiff(startISO, base.start) * dayW;
      const bW = Math.max((dayDiff(base.start, base.finish) + 1) * dayW - 2, 6);
      track.append(h("div", { class: "gantt__base", style: `left:${bLeft}px;width:${bW}px`, title: `Baseline: ${fmtShort(base.start)} – ${fmtShort(base.finish)}` }));
      const cmp = t.localeCompare(base.finish);
      if (cmp !== 0) {
        const mag = workDaysBetween(cmp > 0 ? base.finish : t, cmp > 0 ? t : base.finish, settings) - 1;
        if (mag > 0) track.append(h("div", { class: "gantt__slip " + (cmp > 0 ? "slip-late" : "slip-early"), style: `left:${left + w + 4}px`,
          title: `${cmp > 0 ? mag + " work days behind" : mag + " work days ahead of"} baseline` }, (cmp > 0 ? "+" : "−") + mag + "d"));
      }
    }
    const subs = j.subtasks || [];
    const isCrit = isRed(j.id);
    const manualExpanded = ganttExpanded.has(j.id);
    const expanded = subs.length && (manualExpanded || (ganttCritical && focused(j.id)));   // focusing a project opens its phases
    const toggle = subs.length ? h("span", { class: "gantt__toggle", title: expanded ? "Collapse phases" : "Show phases",
      onclick: (e) => { e.stopPropagation(); if (manualExpanded) ganttExpanded.delete(j.id); else ganttExpanded.add(j.id); paintGantt(); } }, expanded ? "▾ " : "▸ ") : null;
    const labelCls = "gantt__label" + (ganttCritical ? " gantt__label--focusable" + (j.id === ganttFocus ? " is-focus" : "") : "");
    rows.push(h("div", { class: "gantt__row" },
      h("div", { class: labelCls, title: ganttCritical ? "Focus this project's critical path" : (j.title || j.customer || "Job"),
        onclick: ganttCritical ? () => { ganttFocus = j.id; renderGanttView(); } : null }, toggle, (j.title || j.customer || "Job")),
      track));
    vi++;
    if (expanded) {
      const subCls = ganttCritical ? (focused(j.id) ? (isRed(j.id) ? " crit" : "") : " dim") : "";
      let prevPhase = null;
      for (const { sub, start, finish, offFrac, durFrac } of layoutSubtasks(subs, j.startDate, settings)) {
        // fractional sub-day positioning: a 3h tape renders as a short bar partway into its day
        const sLeft = dayDiff(startISO, start) * dayW + (offFrac - Math.floor(offFrac)) * dayW;
        const sW = Math.max(durFrac * dayW - 2, 5);
        const phaseY = headerH + vi * rowH + barMid;
        const hrs = Number(sub.estimatedHours) ? `  ·  ${sub.estimatedHours}h` : "";
        const sBar = h("div", { class: "gantt__bar gantt__bar--sub" + subCls, style: `left:${sLeft}px;width:${sW}px;border-left-color:${stageOf(j.stage).color}`,
          title: `${sub.name || "Phase"}${hrs}\n${fmtShort(start)} – ${fmtShort(finish)}  (${durFrac < 1 ? Math.round(durFrac * 10) / 10 + " day" : Math.round(durFrac * 10) / 10 + " days"})`, onclick: () => openJobModal(j) }, sub.name || "Phase");
        const sTrack = h("div", { class: "gantt__track" + (monthMode ? " gantt__track--plain" : ""), style: `width:${trackW}px` + (monthMode ? "" : `;--gw:${7 * dayW}px`) }, sBar);
        if (monthMode) for (const b of monthBounds) sTrack.append(h("div", { class: "gantt__mline", style: `left:${b * dayW}px` }));
        if (todayX >= 0) sTrack.append(h("div", { class: "gantt__today", style: `left:${todayX}px` }));
        rows.push(h("div", { class: "gantt__row gantt__row--sub" },
          h("div", { class: "gantt__label" }, "↳ " + (sub.name || "Phase")), sTrack));
        if (isCrit) {
          if (prevPhase) phaseLinks.push({ x1: 180 + prevPhase.right, y1: prevPhase.y, x2: 180 + sLeft, y2: phaseY });
          prevPhase = { right: sLeft + sW, y: phaseY };
        }
        vi++;
      }
    }
  }

  const inner = h("div", { class: "gantt__inner", style: `width:${180 + trackW}px;position:relative` }, header, ...rows);

  // ----- dependency arrows (SVG overlay; pointer-events:none so bars stay interactive) -----
  const segs = [];
  for (const { j } of dated) {
    const sg = geo.get(j.id); if (!sg) continue;
    for (const d of (j.deps || [])) {
      const pg = geo.get(d.predId); if (!pg) continue;
      const x1 = 180 + pg.left + pg.w, y1 = headerH + pg.ri * rowH + barMid;
      const x2 = 180 + sg.left, y2 = headerH + sg.ri * rowH + barMid;
      const critLink = isRed(j.id) && isRed(d.predId);
      const cls = "gantt__dep" + (ganttCritical ? (critLink ? " crit" : " dim") : "");
      segs.push(`<path d="M${x1},${y1} H${x1 + 8} V${y2} H${x2}" class="${cls}" marker-end="url(#${critLink ? "garrowcrit" : "garrow"})"/>`);
    }
  }
  // red connectors flowing through a critical job's phases
  for (const p of phaseLinks) {
    segs.push(`<path d="M${p.x1},${p.y1} H${p.x1 + 6} V${p.y2} H${p.x2}" class="gantt__dep crit" marker-end="url(#garrowcrit)"/>`);
  }
  if (segs.length) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "gantt__deps");
    svg.setAttribute("width", 180 + trackW); svg.setAttribute("height", headerH + vi * rowH);
    svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:1";
    svg.innerHTML = '<defs><marker id="garrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9aa6b5"/></marker><marker id="garrowcrit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#c0392b"/></marker></defs>' + segs.join("");
    inner.append(svg);
  }

  wrap.append(inner);

  if (unsched.length) {
    wrap.append(h("div", { class: "calunsched" },
      h("div", {}, h("strong", {}, `Unscheduled (${unsched.length}) `),
        h("span", { class: "subtle" }, "— add a start or target date to place these on the timeline")),
      h("div", { class: "calunsched__row" }, ...unsched.map((j) =>
        h("span", { class: "cal__job cal__job--chip", style: `border-left-color:${stageOf(j.stage).color}`, onclick: () => openJobModal(j) },
          j.title || j.customer || "Job")))));
  }
}

/* ============================================================
   crew board (magnet board — drag the guys between jobs for a day)
   ============================================================ */
let crewDay = todayISO();      // the day the crew board is showing
let crewScope = "day";         // "day" = override just this day | "job" = whole-job roster
let crewDrag = null;           // { cid, src }  — src = jobId | "avail" | "out"
let crewTap = null;            // { cid, src }  — tap-to-move selection (mobile)

const isOut = (c, day) => (c.outDays || []).includes(day);
const crewDayLabel = () => new Date(crewDay + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/* jobs running on a given day (respecting the current filters), soonest first */
function activeJobsOn(day) {
  return jobs.filter(matchesFilter).filter((j) => !j.isMilestone && jobActiveOn(j, day))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || (a.title || "").localeCompare(b.title || ""));
}

/* which crew array a job exposes on `day`: the phase active that day for
   phase-staffed jobs, otherwise the job's own crew. `target` holds the crewIds. */
function jobSlotOn(j, day, s) {
  const subs = j.subtasks || [];
  if (subs.some((st) => (st.crewIds || []).length) && j.startDate) {
    const L = layoutSubtasks(subs, j.startDate, s);
    let act = L.find((x) => day >= x.start && day <= x.finish);
    if (!act) act = [...L].reverse().find((x) => x.start <= day) || L[L.length - 1];
    if (act) return { kind: "phase", target: act.sub, label: act.sub.name || "Phase" };
  }
  return { kind: "job", target: j, label: typeOf(j.type).label };
}
const slotIds = (slot) => (slot.target.crewIds = slot.target.crewIds || []);

/* ---- per-day crew overrides: job.dayCrew[day] = { add:[ids], remove:[ids] } ---- */
const baseCrewOn = (j, day) => slotIds(jobSlotOn(j, day, settings)).slice();
const effectiveCrewOn = (j, day) => effCrew(baseCrewOn(j, day), (j.dayCrew || {})[day]);
const dayOvOf = (j, day) => j.dayCrew && j.dayCrew[day];
const isOverridden = (j, day) => { const d = dayOvOf(j, day); return !!(d && ((d.add || []).length || (d.remove || []).length)); };
function dayDelta(j, day) { j.dayCrew = j.dayCrew || {}; return (j.dayCrew[day] = j.dayCrew[day] || { add: [], remove: [] }); }
function cleanDay(j, day) {
  const m = j.dayCrew; if (!m) return;
  const d = m[day]; if (d && !(d.add || []).length && !(d.remove || []).length) delete m[day];
  if (!Object.keys(m).length) delete j.dayCrew;
}
function dayPull(j, day, cid) {           // remove cid from this job for this day only
  const base = baseCrewOn(j, day), d = dayDelta(j, day);
  d.add = d.add.filter((x) => x !== cid);
  if (base.includes(cid) && !d.remove.includes(cid)) d.remove.push(cid);
  cleanDay(j, day);
}
function dayPush(j, day, cid) {           // add cid to this job for this day only
  const base = baseCrewOn(j, day), d = dayDelta(j, day);
  d.remove = d.remove.filter((x) => x !== cid);
  if (!base.includes(cid) && !d.add.includes(cid)) d.add.push(cid);
  cleanDay(j, day);
}

function renderCrewView() {
  const body = clear(view);
  body.append(h("div", { class: "printhdr" }));
  const nav = h("div", { class: "calnav" },
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftCrewDay(-1) }, "‹"),
    h("strong", { class: "calnav__label" }, crewDayLabel()),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftCrewDay(1) }, "›"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftCrewDay(0, todayISO()) }, "Today"));
  const scopeBtn = (id, label, tip) => h("button", { class: "vsw__b" + (crewScope === id ? " on" : ""), title: tip, onclick: () => { if (crewScope !== id) { crewScope = id; renderCrewView(); } } }, label);
  const scope = h("div", { class: "cb-scope" }, h("span", { class: "cb-scope__l" }, "Move:"),
    h("div", { class: "vsw" },
      scopeBtn("day", "Just this day", "Reassign for the selected day only — the rest of the job keeps its planned crew"),
      scopeBtn("job", "Whole job", "Reassign for the job's entire run")));
  body.append(h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), nav, scope),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons())));
  if (!crew.length) {
    body.append(h("div", { class: "bempty" }, h("h2", {}, "Add your crew first"),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:0 auto", onclick: openCrewModal }, "+ Manage crew")));
    return;
  }
  body.append(h("div", { class: "cbwrap" }));
  paintCrew();
}

function shiftCrewDay(delta, set) {
  crewDay = set || toISO(addDays(new Date(crewDay + "T00:00:00"), delta));
  const lbl = $(".calnav__label", view); if (lbl) lbl.textContent = crewDayLabel();
  paintCrew();
}

function paintCrew() {
  const wrap = $(".cbwrap", view);
  if (!wrap) return renderCrewView();
  clear(wrap);
  const s = settings, day = crewDay;
  const acts = activeJobsOn(day);
  const out = activeCrew().filter((c) => isOut(c, day));
  const outSet = new Set(out.map((c) => c.id));
  const assigned = new Set();
  const cols = acts.map((j) => {
    const ids = effectiveCrewOn(j, day).filter((id) => !outSet.has(id));   // out guys show only on the bench
    ids.forEach((id) => assigned.add(id));
    return { j, ids, label: jobSlotOn(j, day, s).label };
  });
  const avail = activeCrew().filter((c) => !assigned.has(c.id) && !outSet.has(c.id));

  const row = h("div", { class: "cbrow" });
  row.append(crewCol("avail", "Available", avail.map((c) => c.id), { dot: "#1f9d55", kind: "avail" }));
  for (const { j, ids, label } of cols) row.append(crewCol(j.id, j.title || j.customer || "Job", ids, { dot: stageOf(j.stage).color, sub: label, kind: "job", job: j, overridden: isOverridden(j, day) }));
  row.append(crewCol("out", "Out today", out.map((c) => c.id), { kind: "out" }));
  wrap.append(row);

  if (!acts.length) wrap.append(h("p", { class: "subtle", style: "padding:14px 4px" }, "No jobs scheduled for this day — use ‹ › to pick another, or assign start/target dates to your jobs."));
  else wrap.append(h("p", { class: "subtle", style: "padding:10px 4px 0" }, crewScope === "day"
    ? "Moving guys for THIS day only — the rest of each job keeps its planned crew. Drop on “Out today” for a no-show; ↺ resets a day to plan. Switch to “Whole job” to change a job's whole run."
    : "Moving guys for the job's WHOLE run. Drop on “Out today” for a no-show (always just that day). Switch to “Just this day” for single-day cover."));
}

function crewCol(src, title, ids, opts = {}) {
  const empty = opts.kind === "job" ? "Drop a guy here — needs crew"
    : opts.kind === "out" ? "Nobody out" : "Everyone's on a job";
  const bodyEl = h("div", { class: "cbcol__body" + (opts.kind === "avail" ? " is-avail" : opts.kind === "out" ? " is-outzone" : "") },
    ...(ids.length ? ids.map((cid) => crewChip(cid, src)) : [h("div", { class: "cbcol__empty" }, empty)]));

  const col = h("div", { class: "cbcol cb-" + opts.kind + (opts.kind === "job" && !ids.length ? " needs-cover" : "") + (opts.overridden ? " cb-edited" : "") },
    h("div", { class: "cbcol__head" },
      opts.dot ? h("span", { class: "bcol__dot", style: `background:${opts.dot}` }) : null,
      h("div", { style: "min-width:0" },
        h("div", { class: "cbcol__name" }, title, opts.overridden ? h("span", { class: "cb-edittag", title: "Crew changed for this day only" }, "edited") : null),
        opts.sub ? h("div", { class: "cbcol__sub" }, opts.sub) : null),
      opts.overridden ? h("button", { class: "cb-reset", type: "button", title: "Reset this day to the planned crew", onclick: (e) => { e.stopPropagation(); resetDay(opts.job); } }, "↺") : null,
      h("span", { class: "bcol__count" }, String(ids.length))),
    bodyEl);

  col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop-over"); });
  col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop-over"); });
  col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drop-over"); crewDropTo(src); });
  col.addEventListener("click", () => { if (crewTap) crewDropTo(src); });
  return col;
}

function crewChip(cid, src) {
  const c = crewById(cid); if (!c) return h("span");
  const cap = Math.max(1, settings.hoursPerDay || 8);
  const hrs = (conflicts.load.get(cid) || new Map()).get(crewDay) || 0;
  const over = hrs > cap + 1e-6;
  const sel = crewTap && crewTap.cid === cid && crewTap.src === src;
  const chip = h("div", {
    class: "cbchip" + (over ? " is-over" : "") + (src === "out" ? " is-out" : "") + (sel ? " is-sel" : ""),
    draggable: "true", style: `--cc:${c.color || "#7a8aa0"}`,
    title: c.name + (hrs ? ` · ${Math.round(hrs * 10) / 10}h booked` + (over ? ` (over ${cap}h shift)` : "") : "") + (src === "out" ? " · out today" : ""),
  },
    h("span", { class: "cbchip__ini" }, initials(c.name)),
    hrs ? h("span", { class: "cbchip__hrs" }, Math.round(hrs) + "h") : null);
  chip.addEventListener("dragstart", (e) => { crewDrag = { cid, src }; crewTap = null; e.dataTransfer.setData("text/plain", cid); e.dataTransfer.effectAllowed = "move"; chip.classList.add("dragging"); });
  chip.addEventListener("dragend", () => { crewDrag = null; chip.classList.remove("dragging"); });
  chip.addEventListener("click", (e) => { e.stopPropagation(); crewTap = sel ? null : { cid, src }; paintCrew(); });
  return chip;
}

async function setOut(cid, val) {
  const c = crewById(cid); if (!c) return;
  const set = new Set(c.outDays || []);
  val ? set.add(crewDay) : set.delete(crewDay);
  c.outDays = [...set].sort();
  await saveCrewMember(c);
}

async function crewDropTo(dest) {
  const move = crewDrag || crewTap;
  crewDrag = null; crewTap = null;
  if (!move) return;
  const { cid, src } = move;
  if (src === dest) { paintCrew(); return; }
  const day = crewDay, touched = new Set();
  // pull/push respect the scope toggle: "day" edits a per-day override delta,
  // "job" edits the job's (or active phase's) whole-run roster.
  const pull = (jid) => {
    const j = jobs.find((x) => x.id === jid); if (!j) return;
    if (crewScope === "day") { if (effectiveCrewOn(j, day).includes(cid)) { dayPull(j, day, cid); touched.add(j); } }
    else { const slot = jobSlotOn(j, day, settings); const ids = slotIds(slot); if (ids.includes(cid)) { slot.target.crewIds = ids.filter((x) => x !== cid); touched.add(j); } }
  };
  const push = (jid) => {
    const j = jobs.find((x) => x.id === jid); if (!j) return;
    if (crewScope === "day") { if (!effectiveCrewOn(j, day).includes(cid)) { dayPush(j, day, cid); touched.add(j); } }
    else { const slot = jobSlotOn(j, day, settings); const ids = slotIds(slot); if (!ids.includes(cid)) { slot.target.crewIds = [...ids, cid]; touched.add(j); } }
  };

  if (src !== "avail" && src !== "out") pull(src);

  if (dest === "out") {
    // a no-show is always per-day: free their slots today (override) and flag absent
    for (const j of activeJobsOn(day)) { if (effectiveCrewOn(j, day).includes(cid)) { dayPull(j, day, cid); touched.add(j); } }
    await setOut(cid, true);
  } else if (dest === "avail") {
    if (src === "out") {        // back from the bench → undo today's absence everywhere
      await setOut(cid, false);
      for (const j of activeJobsOn(day)) { if ((dayOvOf(j, day)?.remove || []).includes(cid)) { dayPush(j, day, cid); touched.add(j); } }
    }
  } else {
    if (src === "out") await setOut(cid, false);   // showed up after all → assign them
    push(dest);
  }

  if (touched.size) { setSync("syncing"); for (const j of touched) await saveJob(j); setSync(pendingCount() ? "error" : "synced"); }
  await recomputeAndPersist();   // crew change can re-flow durations/dates; repaints too
}

async function resetDay(j) {
  if (j.dayCrew) { delete j.dayCrew[crewDay]; if (!Object.keys(j.dayCrew).length) delete j.dayCrew; }
  setSync("syncing"); await saveJob(j); setSync(pendingCount() ? "error" : "synced");
  await recomputeAndPersist();
}

/* ============================================================
   job modal (new / edit)
   ============================================================ */
function openJobModal(existing, newMilestone) {
  const isNew = !existing;
  const j = existing ? { ...existing } : {
    id: uid(), stage: "lead", type: "remodel", priority: "normal", materials: "none",
    crewIds: [], title: "", customer: "", address: "", phone: "", startDate: "", targetDate: "",
    estimatedHours: "", fieldJobId: "", notes: "",
    contractValue: "", billedToDate: "",
    deps: [], durationDays: null, scheduleMode: "auto", pinnedStart: "",
    notBefore: "", notBeforeLabel: "", subtasks: [], isMilestone: !!newMilestone,
  };
  if (isNew && newMilestone) { j.scheduleMode = "manual"; j.pinnedStart = todayISO(); }
  j.crewIds = [...(j.crewIds || [])];
  j.deps = (j.deps || []).map((d) => ({ ...d }));
  j.subtasks = (j.subtasks || []).map((st) => ({ ...st }));
  if (!j.scheduleMode) j.scheduleMode = "auto";

  const f = {};
  const inp = (key, attrs) => (f[key] = h("input", { value: j[key] || "", ...attrs }));
  const sel = (key, options) => (f[key] = h("select", {}, ...options.map((o) => h("option", { value: o.id, selected: (j[key] || options[0].id) === o.id }, o.label))));
  let refreshDur = () => {};   // assigned by the Schedule section; called when crew/hours change

  // crew multiselect
  const crewPick = h("div", { class: "crewpick" });
  const clashHere = new Set((conflicts.byJob.get(j.id) || []).map((x) => x.crewId));
  for (const c of activeCrew()) {
    const on = j.crewIds.includes(c.id);
    const cb = h("input", { type: "checkbox", checked: on });
    const clashTitle = clashHere.has(c.id)
      ? "Overloaded: " + (conflicts.byJob.get(j.id) || []).filter((x) => x.crewId === c.id).map((x) => `${Math.round(x.hours)}h on ${fmtShort(x.day)}`).join(", ")
      : "";
    const lab = h("label", { class: (on ? "on" : "") + (clashHere.has(c.id) ? " clash" : ""), title: clashTitle },
      cb, h("span", { class: "crewchip", style: `background:${c.color || "#7a8aa0"}` }, initials(c.name)), c.name,
      clashHere.has(c.id) ? h("span", { class: "clashflag", title: clashTitle }, "⚠") : null);
    cb.addEventListener("change", () => {
      if (cb.checked) { if (!j.crewIds.includes(c.id)) j.crewIds.push(c.id); lab.classList.add("on"); }
      else { j.crewIds = j.crewIds.filter((x) => x !== c.id); lab.classList.remove("on"); }
      refreshDur();
    });
    crewPick.append(lab);
  }
  if (!activeCrew().length) crewPick.append(h("span", { class: "subtle" }, "No crew yet — add some via the Crew button."));

  // ----- schedule section (links, mode, duration) -----
  const durOut = h("span", { class: "schedsec__dur" });
  refreshDur = () => {
    if (j.subtasks && j.subtasks.length) { durOut.textContent = `${j.subtasks.length} phase${j.subtasks.length === 1 ? "" : "s"} drive the schedule`; return; }
    const d = durationOf(j, settings);
    durOut.textContent = `${d} work day${d === 1 ? "" : "s"}` + (j.durationDays != null ? " (override)" : (Number(j.estimatedHours) > 0 ? " — from hours" : ""));
  };
  const durInp = h("input", { type: "number", min: "1", step: "1", placeholder: "Auto", value: j.durationDays != null ? j.durationDays : "" });
  durInp.addEventListener("input", () => { j.durationDays = durInp.value ? Math.max(1, Math.round(Number(durInp.value))) : null; refreshDur(); });

  const pinField = h("div", { class: "field", style: j.scheduleMode === "manual" ? "" : "display:none" },
    h("label", {}, "Pinned start date"),
    (f.pinnedStart = h("input", { type: "date", value: j.pinnedStart || j.startDate || "" })));
  let mAuto, mManual;
  const setMode = (m) => {
    j.scheduleMode = m;
    mAuto.classList.toggle("on", m === "auto");
    mManual.classList.toggle("on", m === "manual");
    pinField.style.display = m === "manual" ? "" : "none";
    if (m === "manual" && !f.pinnedStart.value) f.pinnedStart.value = j.startDate || todayISO();
  };
  mAuto = h("button", { class: "vsw__b" + (j.scheduleMode !== "manual" ? " on" : ""), type: "button", onclick: () => setMode("auto") }, "Auto (follow links)");
  mManual = h("button", { class: "vsw__b" + (j.scheduleMode === "manual" ? " on" : ""), type: "button", onclick: () => setMode("manual") }, "Manual (pin start)");

  const predWrap = h("div", { class: "crewpick" });
  const otherJobs = jobs.filter((x) => x.id !== j.id)
    .sort((a, b) => (a.title || a.customer || "").localeCompare(b.title || b.customer || ""));
  for (const o of otherJobs) {
    const linked = j.deps.find((d) => d.predId === o.id);
    const cyc = !linked && wouldCreateCycle(j.id, o.id, jobs);
    const cb = h("input", { type: "checkbox", checked: !!linked, disabled: cyc });
    const lag = h("input", { type: "number", min: "0", step: "1", class: "lagnum", value: linked ? (linked.lagDays || 0) : 0, title: "lag (calendar days)", style: linked ? "" : "display:none" });
    const lagUnit = h("span", { class: "laglbl", style: linked ? "" : "display:none" }, "d lag");
    const lab = h("label", { class: (linked ? "on" : "") + (cyc ? " is-off" : ""), title: cyc ? "Would create a circular link" : "" },
      cb, h("span", { class: "predname" }, o.title || o.customer || "Job"), lag, lagUnit);
    cb.addEventListener("change", () => {
      if (cb.checked) { j.deps.push({ predId: o.id, type: "FS", lagDays: Math.max(0, Math.round(Number(lag.value) || 0)) }); lab.classList.add("on"); lag.style.display = ""; lagUnit.style.display = ""; }
      else { j.deps = j.deps.filter((d) => d.predId !== o.id); lab.classList.remove("on"); lag.style.display = "none"; lagUnit.style.display = "none"; }
    });
    lag.addEventListener("input", () => { const d = j.deps.find((x) => x.predId === o.id); if (d) d.lagDays = Math.max(0, Math.round(Number(lag.value) || 0)); });
    predWrap.append(lab);
  }
  if (!otherJobs.length) predWrap.append(h("span", { class: "subtle" }, "No other jobs to link to yet."));

  const nbDate = (f.notBefore = h("input", { type: "date", value: j.notBefore || "" }));
  const nbLabel = (f.notBeforeLabel = h("input", { type: "text", placeholder: "e.g. materials, permit", maxlength: "24", value: j.notBeforeLabel || "" }));

  // ----- phases (sub-tasks) -----
  const phaseWrap = h("div", { class: "subtasks" });
  const renderPhases = () => {
    clear(phaseWrap);
    if (!j.subtasks.length) {
      phaseWrap.append(h("div", { class: "subtle" }, "No phases. Add phases to break the job into steps (e.g. demo → dry → rebuild → paint) that sequence and roll up to the job's dates."));
    } else {
      j.subtasks.forEach((st, i) => {
        st.crewIds = st.crewIds || [];
        const name = h("input", { type: "text", class: "st-name", placeholder: "Phase name", value: st.name || "" });
        name.addEventListener("input", () => { st.name = name.value; });
        const days = h("input", { type: "number", class: "st-num", min: "1", step: "1", placeholder: "auto", value: st.durationDays != null ? st.durationDays : "", title: "work days (leave blank to compute from hours + crew)" });
        days.addEventListener("input", () => { st.durationDays = days.value ? Math.max(1, Math.round(Number(days.value))) : null; });
        const hrs = h("input", { type: "number", class: "st-num", min: "0", step: "1", placeholder: "—", value: st.estimatedHours || "", title: "phase hours — sets duration with its crew when no days are given" });
        hrs.addEventListener("input", () => { st.estimatedHours = hrs.value ? Number(hrs.value) : ""; });
        const lag = h("input", { type: "number", class: "st-num", min: "0", step: "1", value: st.lagDays || 0, title: "lag (days) before this phase — e.g. cure/dry time" });
        lag.addEventListener("input", () => { st.lagDays = Math.max(0, Math.round(Number(lag.value) || 0)); });
        const crewStrip = h("div", { class: "st-crew" });
        for (const c of activeCrew()) {
          const on = st.crewIds.includes(c.id);
          const chip = h("button", { type: "button", class: "st-crewchip" + (on ? " on" : ""), title: c.name, style: on ? `background:${c.color};border-color:${c.color};color:#fff` : "" }, initials(c.name));
          chip.addEventListener("click", () => {
            if (st.crewIds.includes(c.id)) { st.crewIds = st.crewIds.filter((x) => x !== c.id); chip.className = "st-crewchip"; chip.style.cssText = ""; }
            else { st.crewIds.push(c.id); chip.className = "st-crewchip on"; chip.style.cssText = `background:${c.color};border-color:${c.color};color:#fff`; }
          });
          crewStrip.append(chip);
        }
        const mv = (d) => { const t = j.subtasks[i + d]; j.subtasks[i + d] = j.subtasks[i]; j.subtasks[i] = t; renderPhases(); };
        // hours the field crew has logged against this phase (pushed by the field app)
        const fieldAct = j.fieldActuals && st.name && j.fieldActuals[st.name] != null ? Number(j.fieldActuals[st.name]) : null;
        const est = Number(st.estimatedHours) || 0;
        const fieldChip = fieldAct != null ? h("span", {
          class: "subtle",
          style: "font-size:11px;font-weight:700;" + (est && fieldAct >= est * 1.1 ? "color:#d23b2e" : (est && fieldAct >= est * 0.8 ? "color:#a07800" : "")),
          title: "Hours logged in the field app's daily construction logs",
        }, `📱 ${fieldAct}h logged`) : null;
        phaseWrap.append(h("div", { class: "st-block" },
          h("div", { class: "st-row" }, h("span", { class: "st-i" }, String(i + 1)), name,
            h("button", { class: "st-btn", type: "button", title: "Move up", disabled: i === 0, onclick: () => mv(-1) }, "↑"),
            h("button", { class: "st-btn", type: "button", title: "Move down", disabled: i === j.subtasks.length - 1, onclick: () => mv(1) }, "↓"),
            h("button", { class: "st-btn st-del", type: "button", title: "Remove phase", onclick: () => { j.subtasks.splice(i, 1); renderPhases(); } }, "✕")),
          h("div", { class: "st-row2" },
            h("div", { class: "st-nums" },
              h("label", { class: "st-field" }, h("span", {}, "Days"), days),
              h("label", { class: "st-field" }, h("span", {}, "Hours"), hrs),
              h("label", { class: "st-field" }, h("span", {}, "Lag (days)"), lag),
              fieldChip),
            activeCrew().length ? crewStrip : h("span", { class: "subtle" }, "no crew"))));
      });
    }
    refreshDur();
  };
  renderPhases();
  const addPhase = h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => { j.subtasks.push({ id: uid(), name: "", durationDays: 1, lagDays: 0, estimatedHours: "", crewIds: [] }); renderPhases(); } }, "+ Add phase");

  // ----- field plan proposal (pushed by the field app; import or dismiss) -----
  let fieldPlanSection = null;
  if (j.fieldPlanProposal && !j.isMilestone) {
    const fp = j.fieldPlanProposal;
    const picks = (fp.phases || []).filter((p) => p && p.name).map((p) => ({ p, cb: h("input", { type: "checkbox", checked: true }) }));
    const list = h("div", {}, ...picks.map(({ p, cb }) =>
      h("label", { style: "display:flex;align-items:center;gap:8px;padding:4px 6px;font-size:13px;cursor:pointer" },
        cb, h("span", {}, `${p.name} — ${p.estimatedHours || "?"}h${p.lagDays ? ` (+${p.lagDays}d lag)` : ""}`))));
    const importBtn = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "⤓ Import checked phases");
    importBtn.addEventListener("click", () => {
      const chosen = picks.filter((x) => x.cb.checked).map((x) => x.p);
      if (!chosen.length) { toast("Nothing checked."); return; }
      j.subtasks = [...j.subtasks, ...chosen.map((p) => ({
        id: uid(), name: p.name, durationDays: null,
        estimatedHours: Number(p.estimatedHours) || "", lagDays: Math.max(0, Math.round(Number(p.lagDays) || 0)), crewIds: [],
      }))];
      if (fp.notBefore && !f.notBefore.value) { f.notBefore.value = fp.notBefore; f.notBeforeLabel.value = fp.notBeforeLabel || ""; }
      delete j.fieldPlanProposal;
      fieldPlanSection.remove();
      renderPhases();
      toast("Imported — assign crew per phase, then Save.");
    });
    const dropBtn = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Dismiss");
    dropBtn.addEventListener("click", () => { delete j.fieldPlanProposal; fieldPlanSection.remove(); toast("Proposal dismissed — Save to keep."); });
    fieldPlanSection = h("div", { class: "schedsec", style: "border-color:#e0a800" },
      h("div", { class: "schedsec__h" }, "📱 Phase plan from the field" + (fp.at ? " — " + fmtShort(fp.at.slice(0, 10)) : "")),
      fp.assumptions && fp.assumptions.length ? h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 6px" }, "Assumes: " + fp.assumptions.join(" · ")) : null,
      list,
      h("div", { class: "row-add", style: "display:flex;gap:8px" }, importBtn, dropBtn));
  }

  const durRow = h("div", { class: "grid2 hide-for-ms" },
    field("Duration override (work days)", durInp), field("Computed duration", durOut));
  const nbField = field("Start no earlier than (materials / permit ready)", h("div", { class: "grid2" }, nbDate, nbLabel));
  nbField.classList.add("hide-for-ms");
  const phasesField = field("Phases (optional)", h("div", {}, phaseWrap, h("div", { class: "row-add" }, addPhase)));
  phasesField.classList.add("hide-for-ms");
  const scheduleSection = h("div", { class: "schedsec" },
    h("div", { class: "schedsec__h" }, "🗓 Schedule"),
    field("Scheduling mode", h("div", { class: "vsw" }, mAuto, mManual)),
    pinField,
    field("Start after these jobs / milestones finish (+ lag days)", predWrap),
    durRow, nbField, phasesField);
  refreshDur();

  const msToggle = h("input", { type: "checkbox", checked: !!j.isMilestone });
  const msRow = h("label", { class: "ms-toggle" }, msToggle,
    h("span", {}, "◆ Milestone — a zero-day marker (inspection, permit, walkthrough)"));
  const datesRow = h("div", { class: "grid2 hide-for-ms" },
    field("Start date", inp("startDate", { type: "date" })),
    field("Target / due date", inp("targetDate", { type: "date" })));
  const hoursRow = h("div", { class: "grid2 hide-for-ms" },
    field("Estimated hours", inp("estimatedHours", { type: "number", min: "0", step: "1", placeholder: "e.g. 40" })),
    field("Materials", sel("materials", MATERIALS)));
  // Block D — dollars that drive draw/billing triggers in the daily CFO report
  const moneyRow = h("div", { class: "grid2 hide-for-ms" },
    field("Contract value ($)", inp("contractValue", { type: "number", min: "0", step: "0.01", placeholder: "e.g. 42000" })),
    field("Billed to date ($)", inp("billedToDate", { type: "number", min: "0", step: "0.01", placeholder: "e.g. 15000" })));
  const crewField = field("Assigned crew", crewPick);
  crewField.classList.add("hide-for-ms");

  const body = h("div", { class: "bmodal__body" + (j.isMilestone ? " is-milestone" : "") },
    field(j.isMilestone ? "Milestone name" : "Job / Customer name", inp("title", { type: "text", placeholder: j.isMilestone ? "e.g. City framing inspection" : "e.g. Smith Kitchen Remodel" })),
    msRow,
    field("Customer (if different)", inp("customer", { type: "text", placeholder: "Owner / contact name" })),
    h("div", { class: "grid2" },
      field("Phone", inp("phone", { type: "tel", placeholder: "(505) 555-0123" })),
      field("Job type", sel("type", TYPES))),
    field("Address", inp("address", { type: "text", placeholder: "Job site address" })),
    h("div", { class: "grid2" },
      field("Stage", sel("stage", STAGES)),
      field("Priority", sel("priority", PRIORITIES))),
    datesRow, hoursRow, moneyRow, crewField,
    fieldPlanSection,
    scheduleSection,
    field("Notes", (f.notes = h("textarea", { placeholder: "Scope, scheduling notes, gate codes…" }, j.notes || ""))),
    isNew ? h("p", { class: "subtle", style: "margin:14px 0 0" }, "💾 Create, then reopen to log time.") : (j.isMilestone ? null : buildJobHoursSection(j)),
  );
  msToggle.addEventListener("change", () => { j.isMilestone = msToggle.checked; body.classList.toggle("is-milestone", j.isMilestone); });

  // keep the computed-duration readout live as hours are typed
  f.estimatedHours.addEventListener("input", () => {
    j.estimatedHours = f.estimatedHours.value ? Number(f.estimatedHours.value) : "";
    refreshDur();
  });

  const saveBtn = h("button", { class: "btn btn--primary" }, isNew ? "Create job" : "Save");
  saveBtn.addEventListener("click", async () => {
    const title = f.title.value.trim();
    if (!title) { toast("Add a job / customer name"); f.title.focus(); return; }
    Object.assign(j, {
      title, customer: f.customer.value.trim(), phone: f.phone.value.trim(), address: f.address.value.trim(),
      type: f.type.value, stage: f.stage.value, priority: f.priority.value, materials: f.materials.value,
      startDate: f.startDate.value, targetDate: f.targetDate.value,
      estimatedHours: f.estimatedHours.value ? Number(f.estimatedHours.value) : "",
      contractValue: f.contractValue.value ? Number(f.contractValue.value) : "",
      billedToDate: f.billedToDate.value ? Number(f.billedToDate.value) : "",
      notes: f.notes.value.trim(),
      pinnedStart: j.scheduleMode === "manual" ? (f.pinnedStart.value || "") : (j.pinnedStart || ""),
      notBefore: f.notBefore.value || "",
      notBeforeLabel: f.notBefore.value ? f.notBeforeLabel.value.trim() : "",
    });
    // j.deps / j.scheduleMode / j.durationDays are mutated live by the Schedule section
    saveBtn.disabled = true;
    jobs = [...jobs.filter((x) => x.id !== j.id), j];
    const { changed } = applySchedule();        // resolve j's dates + cascade dependents
    closeModal();                                // re-renders the board with final dates
    setSync("syncing");
    await saveJob(j);
    for (const o of changed) if (o.id !== j.id) await saveJob(o);
    setSync(pendingCount() ? "error" : "synced");
    toast(isNew ? "Job created" : "Saved");
  });

  const foot = h("div", { class: "bmodal__foot" });
  if (!isNew) {
    const del = h("button", { class: "btn btn--danger" }, "Delete");
    del.addEventListener("click", async () => {
      if (!confirm("Delete this job from the board?")) return;
      jobs = jobs.filter((x) => x.id !== j.id);
      closeModal(); render();
      setSync("syncing"); await deleteJob(j.id); setSync(pendingCount() ? "error" : "synced");
      toast("Job deleted");
    });
    foot.append(del);
  }
  foot.append(h("button", { class: "btn btn--ghost", onclick: closeModal }, "Cancel"), saveBtn);

  openModal(isNew ? (j.isMilestone ? "New Milestone" : "New Job") : (j.isMilestone ? "Edit Milestone" : "Edit Job"), body, foot);
  setTimeout(() => f.title.focus(), 30);
}

/* ============================================================
   per-job time logging (inside the job editor)
   ============================================================ */
function buildJobHoursSection(job) {
  const wrap = h("div", { class: "hsec" });

  const QBTAG = "margin-left:6px;font-size:10px;font-weight:800;color:#fff;background:var(--orange,#f26a21);border-radius:5px;padding:1px 5px;vertical-align:middle";

  function render() {
    clear(wrap);
    const all = entriesForJob(job.id);
    // count only from the start date (reconstruction phase) — like the field app
    const list = all.filter((e) => inHoursScope(job, e)).sort((a, b) =>
      (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const excluded = all.length - list.length;
    const act = list.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    const est = Number(job.estimatedHours) || 0;
    const totText = est ? `${fmtH(act)} of ${fmtH(est)}  (${Math.round((act / est) * 100)}%)` : `${fmtH(act)} logged`;

    const rows = list.length ? list.map((e) => {
      const isQb = e.source === "qbtime";
      const who = isQb ? (e.employee || "QuickBooks") : crewName(e.crewId);
      const color = isQb ? "var(--orange,#f26a21)" : (crewById(e.crewId)?.color || "#7a8aa0");
      return h("div", { class: "hrow" },
        h("span", { class: "crewchip", style: `background:${color}`, title: who }, initials(who)),
        h("div", { class: "hrow__main" },
          h("div", {}, h("strong", {}, who),
            isQb ? h("span", { style: QBTAG, title: "From QuickBooks Time" }, "QB") : null,
            " ", h("span", { class: "hrow__h" }, fmtH(e.hours))),
          h("div", { class: "hrow__meta" }, [fmtDate(e.date), e.task || e.note].filter(Boolean).join(" · ") || "—")),
        isQb
          ? h("span", { class: "subtle", title: "Synced from QuickBooks Time", style: "font-size:11px;padding:0 6px" }, "auto")
          : h("button", {
              class: "linkx", title: "Delete entry", onclick: async () => {
                if (!confirm("Delete this time entry?")) return;
                entries = entries.filter((x) => x.id !== e.id);
                await deleteTimeEntry(e.id); render();
              },
            }, "✕"));
    }) : [h("div", { class: "subtle", style: "padding:4px 2px" },
      all.length ? "All logged hours are before the start date below — adjust it or log newer time." : "No time logged yet.")];

    const roster = activeCrew().length ? activeCrew() : crew;
    let addRow;
    if (roster.length) {
      const cSel = h("select", {}, ...roster.map((c) => h("option", { value: c.id }, c.name)));
      const dInp = h("input", { type: "date", value: todayISO() });
      const hInp = h("input", { type: "number", min: "0", step: "0.25", placeholder: "Hrs", class: "hnum" });
      const nInp = h("input", { type: "text", placeholder: "Note (optional)" });
      const addBtn = h("button", { class: "btn btn--primary btn--sm" }, "Log");
      addBtn.addEventListener("click", async () => {
        const hours = Number(hInp.value);
        if (!hours || hours <= 0) { toast("Enter hours"); hInp.focus(); return; }
        const entry = { id: uid(), jobId: job.id, crewId: cSel.value, date: dInp.value || todayISO(), hours, note: nInp.value.trim(), enteredBy: currentEmail() };
        entries = [...entries, entry];
        await saveTimeEntry(entry); render();
      });
      addRow = h("div", { class: "haddrow" }, cSel, dInp, hInp, nInp, addBtn);
    } else {
      addRow = h("div", { class: "subtle" }, "Add crew (Crew button) to log time.");
    }

    // QuickBooks Time: link this board job to a jobcode + backfill its hours.
    if (qbConfigured()) {
      const linked = !!job.qbJobcodeId;
      const linkBtn = h("button", { class: "btn btn--ghost btn--sm" }, linked ? "Change" : "Link QuickBooks job");
      linkBtn.addEventListener("click", async () => {
        const p = await pickJobcode(job);
        if (p) { await saveJob(job); jobs = cachedJobs(); render(); }
      });
      const controls = [
        linked
          ? h("span", { class: "subtle" }, "🔗 QuickBooks: ", h("strong", {}, job.qbJobcodeName || job.qbJobcodeId))
          : h("span", { class: "subtle" }, "Not linked to QuickBooks Time"),
        linkBtn,
      ];
      if (linked) {
        const syncBtn = h("button", { class: "btn btn--ghost btn--sm" }, "⤓ Sync hours");
        syncBtn.addEventListener("click", async () => {
          syncBtn.disabled = true; const t = syncBtn.textContent; syncBtn.textContent = "Syncing…";
          try {
            // Worked hours are historical; a board startDate can be in the future,
            // so look back from a past start (or 180 days) — never an inverted range.
            const start = (job.startDate && job.startDate < todayISO()) ? job.startDate : daysAgoISO(180);
            const r = await qbPullRange(job.qbJobcodeId, start, todayISO(), job.id);
            try { entries = (await pull()).entries; } catch { /* keep cache if offline */ }
            render();
            toast(r.pulled ? `Synced ${r.pulled} QuickBooks entr${r.pulled === 1 ? "y" : "ies"}.` : "No QuickBooks hours found for this job.");
          } catch (e) { toast(e.message || "QuickBooks sync failed"); }
          finally { syncBtn.disabled = false; syncBtn.textContent = t; }
        });
        controls.push(syncBtn);
      }
      wrap.append(h("div", { class: "qbbar", style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px" }, ...controls));
    }

    // "count hours from" — saved with the job on Save, like the other fields
    const fromInp = h("input", { type: "date", value: job.hoursFrom || "" });
    fromInp.addEventListener("change", () => { job.hoursFrom = fromInp.value || ""; render(); });
    const fromRow = h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px" },
      h("span", { class: "subtle" }, "Count hours from"), fromInp,
      h("span", { class: "subtle", style: "font-size:12px" },
        job.hoursFrom
          ? (excluded ? `${excluded} earlier entr${excluded === 1 ? "y" : "ies"} excluded` : "no earlier entries")
          : "reconstruction phase: hours before this date won't count toward this job"));

    wrap.append(
      h("div", { class: "hsec__head" }, h("strong", {}, "Time logged"),
        h("span", { class: "hsec__tot" + (est && act > est ? " over" : "") }, totText)),
      fromRow,
      h("div", { class: "hlist" }, ...rows),
      addRow);
  }

  render();
  return wrap;
}

/* ============================================================
   hours & labor allocation report (toolbar → ⏱ Hours)
   ============================================================ */
function openHoursModal() {
  let range = "all"; // all | 7 | 30
  const body = h("div", { class: "bmodal__body" });

  function render() {
    clear(body);
    const fromISO = range === "all" ? "" : daysAgoISO(Number(range));
    const inRange = (e) => !fromISO || (e.date || "") >= fromISO;
    const scoped = entries.filter(inRange);

    // range selector
    const sel = h("select", { style: "width:auto;min-width:160px" },
      h("option", { value: "all", selected: range === "all" }, "All time"),
      h("option", { value: "7", selected: range === "7" }, "Last 7 days"),
      h("option", { value: "30", selected: range === "30" }, "Last 30 days"));
    sel.addEventListener("change", () => { range = sel.value; render(); });

    const grandHours = scoped.reduce((s, e) => s + (Number(e.hours) || 0), 0);

    // ----- by crew (QB hours attribute to the linked crew member) -----
    const money = (n) => "$" + Math.round(n).toLocaleString();
    const haveRates = crew.some((c) => rateOf(c) > 0);
    const byCrew = crew.map((c) => {
      const es = scoped.filter((e) => entryCrewId(e) === c.id);
      const hours = es.reduce((s, e) => s + (Number(e.hours) || 0), 0);
      const rate = rateOf(c);
      return { name: c.name, color: c.color, hours, jobs: new Set(es.map((e) => e.jobId || e.qbJobcodeId)).size, cost: rate ? hours * rate : null };
    }).filter((r) => r.hours > 0);
    // QuickBooks hours NOT linked to a crew member — group by employee name.
    const qbByEmp = new Map();
    scoped.filter((e) => e.source === "qbtime" && !entryCrewId(e)).forEach((e) => {
      const k = e.employee || "QuickBooks";
      const cur = qbByEmp.get(k) || { name: k + " · QB", color: "#f26a21", hours: 0, jobs: new Set() };
      cur.hours += Number(e.hours) || 0; cur.jobs.add(e.qbJobcodeId || e.jobId);
      qbByEmp.set(k, cur);
    });
    for (const r of qbByEmp.values()) byCrew.push({ name: r.name, color: r.color, hours: r.hours, jobs: r.jobs.size, cost: null });
    // non-QB entries whose crew no longer exists
    const orphanHours = scoped.filter((e) => e.source !== "qbtime" && !entryCrewId(e)).reduce((s, e) => s + (Number(e.hours) || 0), 0);
    if (orphanHours > 0) byCrew.push({ name: "(removed crew)", color: "#7a8aa0", hours: orphanHours, jobs: 0, cost: null });
    byCrew.sort((a, b) => b.hours - a.hours);
    const laborTotal = byCrew.reduce((s, r) => s + (r.cost || 0), 0);

    const crewTable = h("table", { class: "rtable" },
      h("thead", {}, h("tr", {}, h("th", {}, "Crew"), h("th", { class: "num" }, "Hours"), h("th", { class: "num" }, "Jobs"),
        ...(haveRates ? [h("th", { class: "num" }, "Labor $")] : []))),
      h("tbody", {}, ...(byCrew.length ? byCrew.map((r) => h("tr", {},
        h("td", {}, h("span", { class: "crewchip", style: `background:${r.color || "#7a8aa0"}` }, initials(r.name)), " ", r.name),
        h("td", { class: "num" }, fmtH(r.hours)),
        h("td", { class: "num" }, String(r.jobs || "")),
        ...(haveRates ? [h("td", { class: "num" }, r.cost != null ? money(r.cost) : "—")] : []))) :
        [h("tr", {}, h("td", { colspan: haveRates ? 4 : 3, class: "subtle", style: "text-align:center;padding:14px" }, "No hours logged in this range."))])));

    // ----- by job (est vs actual) -----
    const byJob = jobs.map((j) => {
      const actR = scoped.filter((e) => e.jobId === j.id).reduce((s, e) => s + (Number(e.hours) || 0), 0);
      return { title: j.title || j.customer || "Untitled", est: Number(j.estimatedHours) || 0, act: actR };
    }).filter((r) => r.act > 0 || r.est > 0).sort((a, b) => b.act - a.act);

    const jobTable = h("table", { class: "rtable" },
      h("thead", {}, h("tr", {}, h("th", {}, "Job"), h("th", { class: "num" }, "Est"), h("th", { class: "num" }, "Actual"), h("th", { class: "num" }, "Variance"))),
      h("tbody", {}, ...(byJob.length ? byJob.map((r) => {
        const v = r.act - r.est;
        const over = r.est > 0 && v > 0;
        return h("tr", {},
          h("td", {}, r.title),
          h("td", { class: "num" }, r.est ? fmtH(r.est) : "—"),
          h("td", { class: "num" }, fmtH(r.act)),
          h("td", { class: "num" + (over ? " over" : v < 0 && r.est ? " under" : "") }, r.est ? (v > 0 ? "+" : "") + fmtH(v) : "—"));
      }) : [h("tr", {}, h("td", { colspan: 4, class: "subtle", style: "text-align:center;padding:14px" }, "No hours logged in this range."))])));

    body.append(
      h("div", { class: "hrep__top" },
        h("div", { class: "hrep__kpi" }, h("div", { class: "hrep__n" }, fmtH(grandHours)), h("div", { class: "hrep__l" }, "Total hours")),
        ...(haveRates ? [h("div", { class: "hrep__kpi" }, h("div", { class: "hrep__n" }, money(laborTotal)), h("div", { class: "hrep__l" }, "Labor cost"))] : []),
        h("div", {}, h("label", { class: "subtle", style: "margin-right:6px" }, "Range"), sel)),
      h("h2", { style: "margin:16px 0 6px" }, "By crew"),
      h("div", { class: "rtable-wrap" }, crewTable),
      h("h2", { style: "margin:18px 0 6px" }, "By job — estimated vs actual"),
      h("div", { class: "rtable-wrap" }, jobTable));
  }

  render();
  openModal("Hours & Labor", body, h("div", { class: "bmodal__foot" },
    h("button", { class: "btn btn--primary", onclick: closeModal }, "Done")));
}

/* ============================================================
   crew roster modal
   ============================================================ */
function openCrewModal() {
  const body = h("div", { class: "bmodal__body" });
  const list = h("div", { class: "crewlist" });
  body.append(list);

  function paint() {
    clear(list);
    const all = [...crew].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (!all.length) list.append(h("p", { class: "subtle" }, "No crew yet. Add your first crew member below."));
    for (const c of all) {
      list.append(h("div", { class: "crewrow" },
        h("span", { class: "crewchip crewchip--lg", style: `background:${c.color || "#7a8aa0"}` }, initials(c.name)),
        h("div", {},
          h("div", { class: "crewrow__name" }, c.name, c.active === false ? h("span", { class: "subtle" }, "  (inactive)") : null),
          h("div", { class: "crewrow__meta" }, [c.role, c.phone].filter(Boolean).join(" · ") || "—")),
        h("div", { class: "crewrow__act" },
          h("button", { class: "btn btn--ghost btn--sm", onclick: () => editForm(c) }, "Edit"),
          h("button", { class: "btn btn--danger btn--sm", onclick: () => removeMember(c) }, "Remove"))));
    }
  }

  // add/edit inline form
  const formWrap = h("div", { style: "margin-top:16px;border-top:1px solid var(--line);padding-top:14px" });
  function editForm(member) {
    clear(formWrap);
    const isNew = !member;
    const m = member ? { ...member } : { id: uid(), name: "", phone: "", role: "", active: true, color: CREW_COLORS[crew.length % CREW_COLORS.length] };
    const name = h("input", { type: "text", value: m.name || "", placeholder: "Full name" });
    const phone = h("input", { type: "tel", value: m.phone || "", placeholder: "(505) 555-0123" });
    const role = h("input", { type: "text", value: m.role || "", placeholder: "Role (e.g. Lead, Tech, Carpenter)" });
    const rate = h("input", { type: "number", min: "0", step: "1", value: m.hourlyRate || "", placeholder: "e.g. 45" });
    const active = h("input", { type: "checkbox", checked: m.active !== false });

    // QuickBooks Time employee link — so this person's QB hours attribute to them.
    let qbRow = null;
    if (qbConfigured()) {
      qbRow = h("div", { style: "margin:2px 0 12px" });
      const renderQb = () => {
        clear(qbRow);
        const linked = !!m.qbUserId;
        const btn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, linked ? "Change" : "Link QuickBooks employee");
        btn.addEventListener("click", async () => { const p = await pickQbUser(m); if (p) renderQb(); });
        qbRow.append(
          h("div", { class: "subtle", style: "font-size:12px;margin-bottom:4px" }, "QuickBooks Time employee"),
          h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
            linked ? h("span", { class: "subtle" }, "🔗 ", h("strong", {}, m.qbUserName || m.qbUserId)) : h("span", { class: "subtle" }, "Not linked"),
            btn));
      };
      renderQb();
    }

    const save = h("button", { class: "btn btn--primary btn--sm" }, isNew ? "Add member" : "Save");
    save.addEventListener("click", async () => {
      if (!name.value.trim()) { toast("Enter a name"); name.focus(); return; }
      Object.assign(m, {
        name: name.value.trim(), phone: phone.value.trim(), role: role.value.trim(),
        hourlyRate: rate.value ? Number(rate.value) : "", active: active.checked,
      });
      crew = [...crew.filter((x) => x.id !== m.id), m];
      await saveCrewMember(m);
      paint(); clear(formWrap); renderBoardSilently();
      toast(isNew ? "Crew member added" : "Saved");
    });
    formWrap.append(
      h("h2", { style: "margin-top:0" }, isNew ? "Add crew member" : "Edit crew member"),
      h("div", { class: "grid2" }, field("Name", name), field("Phone", phone)),
      h("div", { class: "grid2" }, field("Role", role), field("Hourly rate ($)", rate)),
      qbRow || h("span"),
      h("label", { style: "display:flex;align-items:center;gap:8px;font-size:14px;margin:6px 0 12px" }, active, "Active (show on the board)"),
      h("div", { class: "btn-row" }, save, h("button", { class: "btn btn--ghost btn--sm", onclick: () => clear(formWrap) }, "Cancel")));
    setTimeout(() => name.focus(), 30);
  }
  async function removeMember(c) {
    if (!confirm(`Remove ${c.name} from the crew? Existing job assignments will keep their name but they won't appear in pickers.`)) return;
    crew = crew.filter((x) => x.id !== c.id);
    await deleteCrewMember(c.id);
    paint(); renderBoardSilently();
  }

  paint();
  const foot = h("div", { class: "bmodal__foot" },
    h("button", { class: "btn btn--ghost", onclick: closeModal }, "Close"),
    h("button", { class: "btn btn--primary", onclick: () => editForm(null) }, "+ Add member"));
  openModal("Crew", h("div", {}, body, formWrap), foot);
}

/* re-render the board behind a modal without closing it */
function renderBoardSilently() { /* board re-renders on close; nothing needed live */ }

/* ============================================================
   help / how-to guide (toolbar → ❓ Help)
   ============================================================ */
function openHelpModal() {
  const dot = (color) => h("span", { class: "help__dot", style: `background:${color}` });
  const sec = (title, ...kids) => h("div", { class: "help__sec" }, h("h3", { class: "help__h" }, title), ...kids);
  const li = (...kids) => h("li", {}, ...kids);
  // legend row: a real rendered marker + what it means
  const leg = (marker, desc) => h("div", { class: "help__leg" },
    h("div", { class: "help__legm" }, marker), h("div", { class: "help__legd" }, desc));

  const VIEWS = [
    ["Board", "Your pipeline. Six columns from Leads to Complete — drag a card into another column to change its stage."],
    ["Crew", "A daily magnet board. Drag a guy between job columns to assign him; pick a day with ‹ ›. Drop on “Out today” for a no-show. Changes here apply just to that day (or the whole job — toggle “Move”)."],
    ["Calendar", "Day / Week / Month grid. Each job fills every day between its start and due dates and shows colored crew icons for who's on it. Use ‹ › to change the range, Today to jump back."],
    ["Gantt", "A timeline with one bar per job. Drag a bar sideways to reschedule it. Zoom Fit / Day / Week / Month, and toggle the critical path or a saved baseline."],
  ];

  const body = h("div", { class: "bmodal__body" },
    h("div", { class: "help" },
      h("p", { class: "help__lead" }, "The Job Board is your shop's digital whiteboard. Every job lives on it from first lead to final sign-off, and the whole crew sees the same board in real time."),

      sec("The four views",
        h("div", { class: "help__views" }, ...VIEWS.map(([n, d]) =>
          h("div", { class: "help__view" }, h("strong", {}, n), h("span", {}, d))))),

      sec("Adding & editing a job",
        h("ul", { class: "help__ul" },
          li(h("strong", {}, "+ New Job"), " (top-right) opens the editor. Fill in the name, type, address, phone, dates, crew, and notes, then ", h("strong", {}, "Create"), "."),
          li("Click any card, calendar chip, or Gantt bar to reopen and edit it."),
          li(h("strong", {}, "Drag a card"), " between columns to move it through the pipeline, or drag a Gantt bar to reschedule."),
          li("Set ", h("strong", {}, "Priority"), " to High to float a job to the top of its column; ", h("strong", {}, "Materials"), " tracks whether parts are ordered or in."))),

      sec("Scheduling",
        h("p", { class: "help__p" }, "In the editor's Schedule section each job is either ", h("strong", {}, "Auto"), " or ", h("strong", {}, "Manual"), ":"),
        h("ul", { class: "help__ul" },
          li(h("strong", {}, "Auto"), " — the board picks the dates from the job's links and duration. Link a job to ", h("em", {}, "“start after these jobs finish”"), " (with optional lag days) and it chases its predecessors automatically."),
          li(h("strong", {}, "Manual"), " — pin a fixed start date that won't move."),
          li(h("strong", {}, "Duration"), " comes from estimated hours ÷ assigned crew, or you can override it in work days."),
          li(h("strong", {}, "Phases"), " break a job into steps (demo → dry → rebuild → paint) that run in order and roll up to the job's dates."),
          li(h("strong", {}, "Start no earlier than"), " holds a job until materials or a permit are ready (🔒)."),
          li(h("strong", {}, "◆ Milestone"), " adds a zero-day marker — an inspection, permit, or walkthrough — that other jobs can hang off of."))),

      sec("Crew & assignments",
        h("ul", { class: "help__ul" },
          li("Open ", h("strong", {}, "Crew"), " to add members (name, phone, role, color). Add your crew before assigning jobs."),
          li("Assign crew inside the job editor, or per-phase. Each person shows as a colored initials circle on the card."),
          li("Tap a card's ", h("strong", {}, "📞 phone"), " to call straight from the board."),
          li("Mark someone ", h("em", {}, "inactive"), " to hide them from pickers without losing their logged hours."))),

      sec("Logging hours & labor",
        h("ul", { class: "help__ul" },
          li("Open a job and use ", h("strong", {}, "Time logged"), " to record who worked, the date, and hours."),
          li("Cards show ", h("strong", {}, "actual vs. estimated"), " hours with a progress bar that turns red when you go over."),
          li(h("strong", {}, "⏱ Hours"), " (toolbar) is the labor report — total hours, a by-crew breakdown, and estimated-vs-actual per job, filterable to 7 / 30 days or all time."))),

      sec("Pipeline stages",
        h("div", { class: "help__stages" }, ...STAGES.map((s) =>
          h("span", { class: "help__stage" }, dot(s.color), s.label)))),

      sec("Card symbols",
        h("div", { class: "help__legend" },
          leg(h("span", { class: "prio prio--high", style: "margin:0" }), "High priority (a gray dot means low priority)"),
          leg(h("span", { class: "chip" }, "📅 Due Jun 12"), "Scheduled dates — turns red when a job is past due"),
          leg(h("span", { class: "chip" }, "⏱ 12 / 40h"), "Hours logged vs. estimate — red when over"),
          leg(h("span", { class: "chip is-crit" }, "⚡ Critical"), "On the critical path — a slip moves your finish date"),
          leg(h("span", { class: "chip is-warn" }, "⚠ double-booked"), "A crew member is on two overlapping jobs"),
          leg(h("span", { class: "chip is-lock" }, "🔒 not before"), "Held until materials / permit are ready"),
          leg(h("span", { class: "chip is-phase" }, "📋 3 phases"), "The job is broken into sequenced phases"),
          leg(h("span", { class: "chip mat-ordered" }, "🔧 Materials ordered"), "Materials status (TBD / ordered / in)"),
          leg(h("span", { class: "ms-diamond", style: "font-size:15px" }, "◆"), "A milestone — zero-day marker"))),

      sec("Planning tools",
        h("ul", { class: "help__ul" },
          li(h("strong", {}, "⚡ Critical path"), " (Gantt) highlights the chain of linked jobs that drives your final completion date — protect these from slipping."),
          li(h("strong", {}, "📸 Baseline"), " (Gantt) saves a snapshot of the plan; ghost bars and ± day chips then show how far each job has slipped from it."),
          li(h("strong", {}, "⚠ Conflicts"), " appears in the toolbar when the same person is booked on overlapping jobs — click it to see and fix each clash."),
          li(h("strong", {}, "🗓 Calendar"), " sets your working days, hours per day, and holidays. This drives every auto-scheduled date, so changing it re-flows the whole timeline."))),

      sec("Tips",
        h("ul", { class: "help__ul" },
          li(h("strong", {}, "Search & filters"), " (by job, type, or crew) apply to every view at once."),
          li(h("strong", {}, "🖨 PDF"), " prints the current view — best in Chrome with “Save as PDF.”"),
          li(h("strong", {}, "Works offline."), " Changes save on your device and sync when you're back online — watch the dot next to your email (green = synced)."),
          li("Everyone shares one login, so the board stays in sync across the shop. Use ", h("strong", {}, "↻ Refresh"), " to pull the latest right away."))),
    ));

  openModal("How to use the Job Board", body, h("div", { class: "bmodal__foot" },
    h("button", { class: "btn btn--primary", onclick: closeModal }, "Got it")));
}

/* ============================================================
   modal plumbing + small helpers
   ============================================================ */
function field(label, control) {
  return h("div", { class: "field" }, h("label", {}, label), control);
}

let overlayEl = null;
function openModal(title, bodyEl, footEl) {
  closeModal();
  modalOpen = true;
  const modal = h("div", { class: "bmodal" },
    h("div", { class: "bmodal__head" }, h("h2", {}, title), h("button", { class: "bmodal__x", onclick: closeModal }, "×")),
    bodyEl, footEl);
  overlayEl = h("div", { class: "bmodal-overlay" }, modal);
  overlayEl.addEventListener("mousedown", (e) => { if (e.target === overlayEl) closeModal(); });
  document.addEventListener("keydown", escClose);
  document.body.append(overlayEl);
}
function closeModal() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  document.removeEventListener("keydown", escClose);
  if (modalOpen) { modalOpen = false; render(); }
}
function escClose(e) { if (e.key === "Escape") closeModal(); }

boot();
