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
} from "./data.js";

/* ---------- config ---------- */
const STAGES = [
  { id: "lead",        label: "Leads / Bids",   color: "#9a8f78" },
  { id: "scheduled",   label: "Scheduled",      color: "#4a7fb5" },
  { id: "in_progress", label: "In Progress",    color: "#c9a84c" },
  { id: "on_hold",     label: "On Hold",        color: "#d99a2b" },
  { id: "final",       label: "Final / Punch",  color: "#8a6fb0" },
  { id: "done",        label: "Complete",       color: "#4a9e6f" },
];
const TYPES = [
  { id: "remodel",   label: "Remodel",          color: "#4a7fb5" },
  { id: "new_build", label: "New Build",        color: "#8a6fb0" },
  { id: "water",     label: "Water Mitigation", color: "#2f8f8f" },
  { id: "fire",      label: "Fire",             color: "#c0552a" },
  { id: "mold",      label: "Mold",             color: "#4a9e6f" },
  { id: "other",     label: "Other",            color: "#9a8f78" },
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
const CREW_COLORS = ["#c9a84c", "#4a7fb5", "#4a9e6f", "#8a6fb0", "#c0552a", "#2f8f8f", "#b5832b", "#c2487a", "#6b7a55", "#9a8f78"];

/* ---------- state ---------- */
const view = $("#view");
let jobs = [];
let crew = [];
let entries = [];
let filterText = "", filterCrew = "", filterType = "";
let modalOpen = false;
let pollTimer = null;
let draggingId = null;

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
  if (!SYNC_ENABLED) { jobs = cachedJobs(); crew = cachedCrew(); entries = cachedEntries(); renderBoard(); return; }
  if (isSignedIn()) startUI();
  else renderLogin();
}

async function startUI() {
  $("#acctEmail").textContent = currentEmail();
  $("#signOutBtn").hidden = false;
  jobs = cachedJobs(); crew = cachedCrew(); entries = cachedEntries();
  renderBoard();              // instant from cache
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
    setSync(pendingCount() ? "error" : "synced");
    if (!modalOpen) renderBoard();
  } catch {
    setSync("offline");
  }
}

function setSync(state) {
  const dot = $("#syncDot");
  const map = {
    syncing: ["#c9a84c", "Syncing…"], synced: ["#4a9e6f", "Synced"],
    offline: ["#d23b2e", "Offline — changes saved locally"], error: ["#d99a2b", pendingCount() + " change(s) pending"],
  };
  const [c, t] = map[state] || ["#4a9e6f", "Online"];
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
    h("img", { src: "../assets/icon-180.png", alt: "" }),
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

function renderBoard() {
  const body = clear(view);
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

function renderToolbar() {
  const search = h("input", { type: "search", placeholder: "Search job, customer, address…", value: filterText });
  search.addEventListener("input", () => { filterText = search.value.toLowerCase(); paintColumns(); });

  const typeSel = h("select", {}, h("option", { value: "" }, "All types"),
    ...TYPES.map((t) => h("option", { value: t.id, selected: filterType === t.id }, t.label)));
  typeSel.addEventListener("change", () => { filterType = typeSel.value; paintColumns(); });

  const crewSel = h("select", {}, h("option", { value: "" }, "All crew"),
    ...activeCrew().map((c) => h("option", { value: c.id, selected: filterCrew === c.id }, c.name)));
  crewSel.addEventListener("change", () => { filterCrew = crewSel.value; paintColumns(); });

  return h("div", { class: "btoolbar" },
    h("h1", {}, "Job Board"),
    h("div", { class: "btools" },
      search, typeSel, crewSel,
      h("button", { class: "btn btn--ghost btn--sm", onclick: openHoursModal }, "⏱ Hours"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: openCrewModal }, "Crew"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => refresh() }, "↻ Refresh"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => openJobModal(null) }, "+ New Job")));
}

/* repaint only the columns (keeps toolbar inputs focused while filtering) */
function paintColumns() {
  const old = $(".bboard", view);
  if (!old) return renderBoard();
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
  // crew chips
  const ids = (j.crewIds || []).filter(crewById);
  if (ids.length) {
    meta.append(h("span", { class: "crew" },
      ...ids.slice(0, 5).map((id) => { const c = crewById(id); return h("span", { class: "crewchip", style: `background:${c.color || "#9a8f78"}`, title: c.name }, initials(c.name)); })));
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
  renderBoard();
  setSync("syncing");
  await saveJob(j);
  setSync(pendingCount() ? "error" : "synced");
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
  };
  j.crewIds = [...(j.crewIds || [])];

  const f = {};
  const inp = (key, attrs) => (f[key] = h("input", { value: j[key] || "", ...attrs }));
  const sel = (key, options) => (f[key] = h("select", {}, ...options.map((o) => h("option", { value: o.id, selected: (j[key] || options[0].id) === o.id }, o.label))));

  // crew multiselect
  const crewPick = h("div", { class: "crewpick" });
  for (const c of activeCrew()) {
    const on = j.crewIds.includes(c.id);
    const cb = h("input", { type: "checkbox", checked: on });
    const lab = h("label", { class: on ? "on" : "" },
      cb, h("span", { class: "crewchip", style: `background:${c.color || "#9a8f78"}` }, initials(c.name)), c.name);
    cb.addEventListener("change", () => {
      if (cb.checked) { if (!j.crewIds.includes(c.id)) j.crewIds.push(c.id); lab.classList.add("on"); }
      else { j.crewIds = j.crewIds.filter((x) => x !== c.id); lab.classList.remove("on"); }
    });
    crewPick.append(lab);
  }
  if (!activeCrew().length) crewPick.append(h("span", { class: "subtle" }, "No crew yet — add some via the Crew button."));

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
    field("Notes", (f.notes = h("textarea", { placeholder: "Scope, scheduling notes, gate codes…" }, j.notes || ""))),
    isNew ? h("p", { class: "subtle", style: "margin:14px 0 0" }, "💾 Create the job, then reopen it to log time.") : buildJobHoursSection(j),
  );

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
    });
    saveBtn.disabled = true;
    // update local list immediately
    jobs = [...jobs.filter((x) => x.id !== j.id), j];
    closeModal(); renderBoard();
    setSync("syncing"); await saveJob(j); setSync(pendingCount() ? "error" : "synced");
    toast(isNew ? "Job created" : "Saved");
  });

  const foot = h("div", { class: "bmodal__foot" });
  if (!isNew) {
    const del = h("button", { class: "btn btn--danger" }, "Delete");
    del.addEventListener("click", async () => {
      if (!confirm("Delete this job from the board?")) return;
      jobs = jobs.filter((x) => x.id !== j.id);
      closeModal(); renderBoard();
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
      h("span", { class: "crewchip", style: `background:${crewById(e.crewId)?.color || "#9a8f78"}`, title: crewName(e.crewId) }, initials(crewName(e.crewId))),
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
    if (orphanHours > 0) byCrew.push({ name: "(removed crew)", color: "#9a8f78", hours: orphanHours, jobs: 0 });

    const crewTable = h("table", { class: "rtable" },
      h("thead", {}, h("tr", {}, h("th", {}, "Crew"), h("th", { class: "num" }, "Hours"), h("th", { class: "num" }, "Jobs"))),
      h("tbody", {}, ...(byCrew.length ? byCrew.map((r) => h("tr", {},
        h("td", {}, h("span", { class: "crewchip", style: `background:${r.color || "#9a8f78"}` }, initials(r.name)), " ", r.name),
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
        h("span", { class: "crewchip crewchip--lg", style: `background:${c.color || "#9a8f78"}` }, initials(c.name)),
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
  if (modalOpen) { modalOpen = false; renderBoard(); }
}
function escClose(e) { if (e.key === "Escape") closeModal(); }

boot();
