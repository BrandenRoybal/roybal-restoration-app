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
  cachedSettings, saveSettings,
} from "./data.js";
import { computeSchedule, durationOf, wouldCreateCycle, findOverAllocations, DEFAULT_SETTINGS } from "./schedule.js";

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
let conflicts = { byJob: new Map(), pairs: [] };   // crew over-allocations (computed each schedule)
let filterText = "", filterCrew = "", filterType = "";
let modalOpen = false;
let pollTimer = null;
let draggingId = null;
let currentView = "board";              // "board" | "calendar" | "gantt"
const _now = new Date();
let calY = _now.getFullYear(), calM = _now.getMonth();   // calendar month being viewed
let ganttZoom = "day";                  // "day" | "week"

/* ---------- lookups ---------- */
const stageOf = (id) => STAGES.find((s) => s.id === id) || STAGES[0];
const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[TYPES.length - 1];
const crewById = (id) => crew.find((c) => c.id === id);
const initials = (name) => (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const activeCrew = () => crew.filter((c) => c.active !== false).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
const crewName = (id) => crewById(id)?.name || "—";

/* hours / labor */
const entriesForJob = (jobId) => entries.filter((e) => e.jobId === jobId);
const actualHours = (jobId) => entriesForJob(jobId).reduce((s, e) => s + (Number(e.hours) || 0), 0);
const crewHours = (crewId, fromISO) => entries
  .filter((e) => e.crewId === crewId && (!fromISO || (e.date || "") >= fromISO))
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
  jobs = cachedJobs(); crew = cachedCrew(); entries = cachedEntries();
  applySchedule();
  render();              // instant from cache
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
  conflicts = findOverAllocations(jobs);         // refresh crew over-allocations
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
  if (currentView === "calendar") return paintCalendar();
  if (currentView === "gantt") return paintGantt();
  paintColumns();
}

function viewSwitch() {
  const mk = (id, label) => h("button", {
    class: "vsw__b" + (currentView === id ? " on" : ""),
    onclick: () => { if (currentView !== id) { currentView = id; render(); } },
  }, label);
  return h("div", { class: "vsw" }, mk("board", "Board"), mk("calendar", "Calendar"), mk("gantt", "Gantt"));
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
    ...(conflicts.pairs.length ? [h("button", { class: "btn btn--sm confbtn", onclick: openConflicts, title: "Crew double-booked on overlapping jobs" },
      `⚠ ${conflicts.pairs.length} conflict${conflicts.pairs.length === 1 ? "" : "s"}`)] : []),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openScheduleSettings, title: "Work calendar & hours per day" }, "🗓 Calendar"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openHoursModal }, "⏱ Hours"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: openCrewModal }, "Crew"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => refresh() }, "↻ Refresh"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: exportPDF, title: "Print / save as PDF" }, "🖨 PDF"),
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

  const body = h("div", { class: "bmodal__body" },
    h("p", { class: "subtle", style: "margin-top:0" }, "Drives every auto-scheduled job — durations and the dates jobs land on. Changing this re-flows the whole timeline."),
    field("Working days", h("div", { class: "dowrow" }, ...dayBoxes.map((d) => d.el))),
    field("Hours per work day", h("div", { class: "grid2" }, hpd, h("span", { class: "subtle", style: "align-self:center" }, "e.g. 10 in summer · 8 in winter"))),
    field("Holidays (skipped)", h("div", {}, h("div", { class: "haddrow" }, holDate, holAdd), holWrap)));

  const save = h("button", { class: "btn btn--primary" }, "Save & re-flow");
  save.addEventListener("click", async () => {
    const workDays = dayBoxes.filter((d) => d.cb.checked).map((d) => d.idx).sort((a, b) => a - b);
    if (!workDays.length) { toast("Pick at least one working day"); return; }
    const next = { workDays, hoursPerDay: Math.max(1, Number(hpd.value) || 10), holidays: holidays.slice() };
    save.disabled = true;
    closeModal();
    await saveSettings(next);
    await recomputeAndPersist();
    toast("Schedule settings saved");
  });
  openModal("Schedule settings", body, h("div", { class: "bmodal__foot" },
    h("button", { class: "btn btn--ghost", onclick: closeModal }, "Cancel"), save));
}

/* ---------- crew over-allocation summary ---------- */
function openConflicts() {
  const rows = conflicts.pairs.slice().sort((a, b) => (a.from || "").localeCompare(b.from || ""));
  const list = rows.length ? rows.map((p) => {
    const A = jobs.find((j) => j.id === p.aId) || {}, B = jobs.find((j) => j.id === p.bId) || {};
    return h("div", { class: "confrow" },
      h("span", { class: "crewchip is-clash", style: `background:${crewById(p.crewId)?.color || "#7a8aa0"}`, title: crewName(p.crewId) }, initials(crewName(p.crewId))),
      h("div", { class: "confrow__main" },
        h("div", {}, h("strong", {}, crewName(p.crewId)), " — overlap ", h("strong", {}, fmtShort(p.from) + " → " + fmtShort(p.to))),
        h("div", { class: "subtle" },
          h("button", { class: "linklike", onclick: () => { closeModal(); openJobModal(A); } }, A.title || A.customer || "Job A"),
          "  ✕  ",
          h("button", { class: "linklike", onclick: () => { closeModal(); openJobModal(B); } }, B.title || B.customer || "Job B"))));
  }) : [h("div", { class: "subtle" }, "No conflicts 🎉")];
  const body = h("div", { class: "bmodal__body" },
    h("p", { class: "subtle", style: "margin-top:0" }, `${rows.length} crew over-allocation${rows.length === 1 ? "" : "s"} — the same person is booked on two jobs whose dates overlap. Re-crew or reschedule a job to clear it.`),
    h("div", { class: "conflist" }, ...list));
  openModal("Crew conflicts", body, h("div", { class: "bmodal__foot" }, h("button", { class: "btn btn--ghost", onclick: closeModal }, "Close")));
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
    const detail = jc.map((x) => `${crewName(x.crewId)} also on “${(jobs.find((y) => y.id === x.otherId) || {}).title || "another job"}”`).join("\n");
    meta.append(h("span", { class: "chip is-warn", title: detail },
      `⚠ ${clashCrew.size === 1 ? crewName([...clashCrew][0]) + " double-booked" : clashCrew.size + " crew double-booked"}`));
  }
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

function renderCalToolbar() {
  const nav = h("div", { class: "calnav" },
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftMonth(-1) }, "‹"),
    h("strong", { class: "calnav__label" }, monthLabel()),
    h("button", { class: "btn btn--ghost btn--sm", onclick: () => shiftMonth(1) }, "›"),
    h("button", { class: "btn btn--ghost btn--sm", onclick: goToday }, "Today"));
  return h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), nav),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons()));
}

function shiftMonth(delta) {
  calM += delta;
  if (calM < 0) { calM = 11; calY--; } else if (calM > 11) { calM = 0; calY++; }
  const lbl = $(".calnav__label", view);
  if (lbl) lbl.textContent = monthLabel();
  paintCalendar();
}
function goToday() { calY = _now.getFullYear(); calM = _now.getMonth(); shiftMonth(0); }

function paintCalendar() {
  const wrap = $(".calwrap", view);
  if (!wrap) return renderCalendarView();
  clear(wrap);

  const today = todayISO();
  const first = new Date(calY, calM, 1);
  const gridStart = addDays(first, -first.getDay());   // Sunday on/before the 1st
  const visible = jobs.filter(matchesFilter);

  const head = h("div", { class: "cal__head" },
    ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => h("div", { class: "cal__hd" }, d)));

  const grid = h("div", { class: "cal__grid" });
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const iso = toISO(d);
    const inMonth = d.getMonth() === calM;
    const cell = h("div", { class: "cal__cell" + (inMonth ? "" : " out") + (iso === today ? " today" : "") },
      h("div", { class: "cal__day" }, String(d.getDate())));
    for (const j of visible.filter((x) => jobActiveOn(x, iso))) {
      const marker = j.startDate === iso ? "▶ " : j.targetDate === iso ? "⚑ " : "";
      cell.append(h("div", {
        class: "cal__job", style: `border-left-color:${stageOf(j.stage).color}`,
        title: (j.title || j.customer || "Job"), onclick: () => openJobModal(j),
      }, marker + (j.title || j.customer || "Job")));
    }
    grid.append(cell);
  }

  wrap.append(head, grid);

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
  return h("div", { class: "btoolbar" },
    h("div", { class: "btoolbar__left" }, viewSwitch(), h("h1", {}, "Timeline"), zoom),
    h("div", { class: "btools" }, ...filterControls(), ...actionButtons()));
}
function setZoom(z) { if (ganttZoom === z) return; ganttZoom = z; renderGanttView(); }

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
  const rowH = 40, barMid = 20, headerH = monthMode ? 22 : 40;
  const rows = dated.map(({ j, s, t }, ri) => {
    const left = dayDiff(startISO, s) * dayW;
    const w = Math.max((dayDiff(s, t) + 1) * dayW - 2, 8);
    geo.set(j.id, { ri, left, w });
    const act = actualHours(j.id), est = Number(j.estimatedHours) || 0;
    const hrs = est ? `  ·  ${Math.round(act * 100) / 100}/${est}h` : (act ? `  ·  ${fmtH(act)}` : "");
    const clash = conflicts.byJob.has(j.id);
    const bar = h("div", {
      class: "gantt__bar" + (clash ? " has-clash" : ""), style: `left:${left}px;width:${w}px;border-left-color:${stageOf(j.stage).color}`,
      title: `${j.title || j.customer || "Job"}\n${fmtShort(s)} – ${fmtShort(t)}${est ? `\n${Math.round(act * 100) / 100} of ${est}h` : ""}${clash ? "\n⚠ crew double-booked" : ""}\n(drag to reschedule)`,
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
    return h("div", { class: "gantt__row" },
      h("div", { class: "gantt__label", title: j.title || j.customer || "Job" }, j.title || j.customer || "Job"),
      track);
  });

  const inner = h("div", { class: "gantt__inner", style: `width:${180 + trackW}px;position:relative` }, header, ...rows);

  // ----- dependency arrows (SVG overlay; pointer-events:none so bars stay interactive) -----
  const segs = [];
  for (const { j } of dated) {
    const sg = geo.get(j.id); if (!sg) continue;
    for (const d of (j.deps || [])) {
      const pg = geo.get(d.predId); if (!pg) continue;
      const x1 = 180 + pg.left + pg.w, y1 = headerH + pg.ri * rowH + barMid;
      const x2 = 180 + sg.left, y2 = headerH + sg.ri * rowH + barMid;
      segs.push(`<path d="M${x1},${y1} H${x1 + 8} V${y2} H${x2}" class="gantt__dep" marker-end="url(#garrow)"/>`);
    }
  }
  if (segs.length) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "gantt__deps");
    svg.setAttribute("width", 180 + trackW); svg.setAttribute("height", headerH + dated.length * rowH);
    svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible;z-index:1";
    svg.innerHTML = '<defs><marker id="garrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#9aa6b5"/></marker></defs>' + segs.join("");
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
   job modal (new / edit)
   ============================================================ */
function openJobModal(existing) {
  const isNew = !existing;
  const j = existing ? { ...existing } : {
    id: uid(), stage: "lead", type: "remodel", priority: "normal", materials: "none",
    crewIds: [], title: "", customer: "", address: "", phone: "", startDate: "", targetDate: "",
    estimatedHours: "", fieldJobId: "", notes: "",
    deps: [], durationDays: null, scheduleMode: "auto", pinnedStart: "",
  };
  j.crewIds = [...(j.crewIds || [])];
  j.deps = (j.deps || []).map((d) => ({ ...d }));
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
      ? "Double-booked: also on " + (conflicts.byJob.get(j.id) || []).filter((x) => x.crewId === c.id).map((x) => "“" + ((jobs.find((y) => y.id === x.otherId) || {}).title || "another job") + "”").join(", ")
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

  const scheduleSection = h("div", { class: "schedsec" },
    h("div", { class: "schedsec__h" }, "🗓 Schedule"),
    field("Scheduling mode", h("div", { class: "vsw" }, mAuto, mManual)),
    pinField,
    field("Start after these jobs finish (+ lag days)", predWrap),
    h("div", { class: "grid2" },
      field("Duration override (work days)", durInp),
      field("Computed duration", durOut)));
  refreshDur();

  const body = h("div", { class: "bmodal__body" },
    field("Job / Customer name", inp("title", { type: "text", placeholder: "e.g. Smith Kitchen Remodel" })),
    field("Customer (if different)", inp("customer", { type: "text", placeholder: "Owner / contact name" })),
    h("div", { class: "grid2" },
      field("Phone", inp("phone", { type: "tel", placeholder: "(505) 555-0123" })),
      field("Job type", sel("type", TYPES))),
    field("Address", inp("address", { type: "text", placeholder: "Job site address" })),
    h("div", { class: "grid2" },
      field("Stage", sel("stage", STAGES)),
      field("Priority", sel("priority", PRIORITIES))),
    h("div", { class: "grid2" },
      field("Start date", inp("startDate", { type: "date" })),
      field("Target / due date", inp("targetDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Estimated hours", inp("estimatedHours", { type: "number", min: "0", step: "1", placeholder: "e.g. 40" })),
      field("Materials", sel("materials", MATERIALS))),
    field("Assigned crew", crewPick),
    scheduleSection,
    field("Notes", (f.notes = h("textarea", { placeholder: "Scope, scheduling notes, gate codes…" }, j.notes || ""))),
    isNew ? h("p", { class: "subtle", style: "margin:14px 0 0" }, "💾 Create the job, then reopen it to log time.") : buildJobHoursSection(j),
  );

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
      notes: f.notes.value.trim(),
      pinnedStart: j.scheduleMode === "manual" ? (f.pinnedStart.value || "") : (j.pinnedStart || ""),
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

  openModal(isNew ? "New Job" : "Edit Job", body, foot);
  setTimeout(() => f.title.focus(), 30);
}

/* ============================================================
   per-job time logging (inside the job editor)
   ============================================================ */
function buildJobHoursSection(job) {
  const wrap = h("div", { class: "hsec" });

  function render() {
    clear(wrap);
    const list = entriesForJob(job.id).sort((a, b) =>
      (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const act = actualHours(job.id);
    const est = Number(job.estimatedHours) || 0;
    const totText = est ? `${fmtH(act)} of ${fmtH(est)}  (${Math.round((act / est) * 100)}%)` : `${fmtH(act)} logged`;

    const rows = list.length ? list.map((e) => h("div", { class: "hrow" },
      h("span", { class: "crewchip", style: `background:${crewById(e.crewId)?.color || "#7a8aa0"}`, title: crewName(e.crewId) }, initials(crewName(e.crewId))),
      h("div", { class: "hrow__main" },
        h("div", {}, h("strong", {}, crewName(e.crewId)), " ", h("span", { class: "hrow__h" }, fmtH(e.hours))),
        h("div", { class: "hrow__meta" }, [fmtDate(e.date), e.note].filter(Boolean).join(" · ") || "—")),
      h("button", {
        class: "linkx", title: "Delete entry", onclick: async () => {
          if (!confirm("Delete this time entry?")) return;
          entries = entries.filter((x) => x.id !== e.id);
          await deleteTimeEntry(e.id); render();
        },
      }, "✕"))) : [h("div", { class: "subtle", style: "padding:4px 2px" }, "No time logged yet.")];

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

    wrap.append(
      h("div", { class: "hsec__head" }, h("strong", {}, "Time logged"),
        h("span", { class: "hsec__tot" + (est && act > est ? " over" : "") }, totText)),
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

    // ----- by crew -----
    const byCrew = crew.map((c) => {
      const es = scoped.filter((e) => e.crewId === c.id);
      return { name: c.name, color: c.color, hours: es.reduce((s, e) => s + (Number(e.hours) || 0), 0), jobs: new Set(es.map((e) => e.jobId)).size };
    }).filter((r) => r.hours > 0).sort((a, b) => b.hours - a.hours);
    // entries for crew that no longer exist
    const orphanHours = scoped.filter((e) => !crewById(e.crewId)).reduce((s, e) => s + (Number(e.hours) || 0), 0);
    if (orphanHours > 0) byCrew.push({ name: "(removed crew)", color: "#7a8aa0", hours: orphanHours, jobs: 0 });

    const crewTable = h("table", { class: "rtable" },
      h("thead", {}, h("tr", {}, h("th", {}, "Crew"), h("th", { class: "num" }, "Hours"), h("th", { class: "num" }, "Jobs"))),
      h("tbody", {}, ...(byCrew.length ? byCrew.map((r) => h("tr", {},
        h("td", {}, h("span", { class: "crewchip", style: `background:${r.color || "#7a8aa0"}` }, initials(r.name)), " ", r.name),
        h("td", { class: "num" }, fmtH(r.hours)),
        h("td", { class: "num" }, String(r.jobs || "")))) :
        [h("tr", {}, h("td", { colspan: 3, class: "subtle", style: "text-align:center;padding:14px" }, "No hours logged in this range."))])));

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
    const active = h("input", { type: "checkbox", checked: m.active !== false });
    const save = h("button", { class: "btn btn--primary btn--sm" }, isNew ? "Add member" : "Save");
    save.addEventListener("click", async () => {
      if (!name.value.trim()) { toast("Enter a name"); name.focus(); return; }
      Object.assign(m, { name: name.value.trim(), phone: phone.value.trim(), role: role.value.trim(), active: active.checked });
      crew = [...crew.filter((x) => x.id !== m.id), m];
      await saveCrewMember(m);
      paint(); clear(formWrap); renderBoardSilently();
      toast(isNew ? "Crew member added" : "Saved");
    });
    formWrap.append(
      h("h2", { style: "margin-top:0" }, isNew ? "Add crew member" : "Edit crew member"),
      h("div", { class: "grid2" }, field("Name", name), field("Phone", phone)),
      field("Role", role),
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
