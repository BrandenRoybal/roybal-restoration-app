/* ============================================================
   Roybal Field Forms — app shell + hash router
   ============================================================ */
import { h, $, clear, Store, toast, fmtDate, money, fileToDataURL, flushPending, downloadFile, csvRow } from "./core.js";
import {
  formByKey, formCount, newProject, formsFor, jobType,
  CONSTRUCTION_TYPES, constructionTypeLabel,
  newMoistureMap, newDryingLog, newConstructionLog, newChangeOrder,
  newInvoice, newReconEstimate, newPortalShare, newWorkAuth, newCertDrying, newLaborLog, newFloorPlan, newSupportDoc,
  newScopeOfWork, newPreConChecklist, newSelections, newSubSchedule,
  newInspection, newPunchList, newDrawSchedule, newCertCompletion,
  blankScopeArea, blankScopeItem, blankSubRow, blankSelectionRow, TRADES,
  newContentsItem, newBox, CONDITIONS, DISPOSITIONS, CONTENT_CATEGORIES,
  BOX_DESTINATIONS, POROUS_CATEGORIES, dispositionShort, dispositionLabel, depreciation,
} from "./model.js";
import { setCtx, field, inp, ta, sel, seg, photoUploader, uploadedDocPages } from "./formkit.js";
import { RENDERERS, packBackReceipt, uploadedDocSheet, narrativeSheet, progressSheet } from "./forms.js";
import { qrSvg } from "./qr.js";
import { SYNC_ENABLED } from "./config.js";
import { isSignedIn, signIn, signOut, currentEmail, rest } from "./supa.js";
import { startSync, syncNow, resetSync, onSyncMerge, onSyncRowChanged } from "./sync.js";
import { graftProject } from "./graft.js";
import { panelModel, evaluateProject } from "./completeness.js";
import { syncSpine, getUnifiedJobId } from "./spine.js";
import { generateNarrative, constructionFacts } from "./narrative.js";
import { transcribeWidget } from "./voice.js";
import { aiAvailable, aiReady, draftAdjusterEmail, analyzeContentsItem, scanContentsPhoto, justifyContents, draftRebuild, draftProgress, draftTimeline } from "./officeai.js";
import { dryingFlags, isCertified } from "./dryingwatch.js";
import { buildFlags } from "./buildwatch.js";
import { convertToConstruction, rebuildFacts } from "./convert.js";
import { dictateBtn } from "./dictate.js";
import { smsHref, onOurWaySms, logSms, SMS_KIND_LABELS, smartSend, companySendEnabled, setCompanySend } from "./sms.js";
import { planPhases, pushPlanToBoard, pushActuals, findBoardRow, boardRowFor, fetchBoardRowsSafe, fetchHistoryDigest, isoDateOnly, ensureBoardTile, adoptBoardJobs, healBoardDuplicates } from "./boardpush.js";
import { mountAssist } from "./assist.js";
import { AI_FORM_KEYS, rebuildChips, applyRebuildChips } from "./ai.js";
import { pickTech, techName } from "./tech.js";

const view = $("#view");
const topbarSub = $("#topbarSub");
const backBtn = $("#backBtn");
const techChip = $("#techChip");

// Before any print/Save-as-PDF, size every textarea to its content so long text
// (e.g. the Loss Cause) prints in full instead of clipping to its visible rows.
window.addEventListener("beforeprint", () => {
  document.querySelectorAll("textarea").forEach((t) => {
    t.style.height = "auto"; t.style.height = t.scrollHeight + "px";
  });
});

const FACTORY = {
  moistureMaps: newMoistureMap, dryingLogs: newDryingLog,
  constructionLogs: newConstructionLog, changeOrders: newChangeOrder,
  invoices: newInvoice, reconEstimates: newReconEstimate, portalShare: newPortalShare, workAuth: newWorkAuth, certDrying: newCertDrying,
  laborLog: newLaborLog, floorPlan: newFloorPlan, supportDocs: newSupportDoc,
  scopeOfWork: newScopeOfWork, preConChecklist: newPreConChecklist,
  selections: newSelections, subSchedule: newSubSchedule,
  inspections: newInspection, punchList: newPunchList,
  drawSchedule: newDrawSchedule, certCompletion: newCertCompletion,
};

/* ---------- router ---------- */
let backTarget = "#/";
function go(hash) { location.hash = hash; }
backBtn.addEventListener("click", () => go(backTarget));

window.addEventListener("hashchange", route);
window.addEventListener("load", boot);
window.addEventListener("roybal-tech-changed", renderTechChip);  // refresh the header chip when tech is set anywhere

/* ---------- ?diag — on-screen input diagnostic (no DevTools needed) ----------
   Open https://app.roybalconstruction.com/?diag and a readout box appears.
   Shows, live: what a click lands on (full element stack), whether the input
   under the click is disabled/unclickable, where focus went, and where
   keystrokes are delivered. For chasing device-specific input problems. */
if (location.search.includes("diag")) {
  const dbox = document.createElement("div");
  dbox.style.cssText = "position:fixed;top:70px;left:8px;z-index:999999;background:rgba(0,0,0,.92);color:#0f0;font:12px/1.5 monospace;padding:10px;border-radius:8px;max-width:470px;pointer-events:none;white-space:pre-wrap;word-break:break-all";
  document.body.append(dbox);
  const desc = (el) => !el ? "none"
    : el.tagName + (el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : "")
      + (el.placeholder ? "[" + el.placeholder + "]" : "");
  const L = { click: "—", stack: "—", input: "—", focus: "—", key: "—", typed: "—" };
  const paint = () => { dbox.textContent =
    "CLICK  " + L.click + "\nSTACK  " + L.stack + "\nINPUT  " + L.input +
    "\nFOCUS  " + L.focus + "\nKEY    " + L.key + "\nTYPED  " + L.typed; };
  document.addEventListener("pointerdown", (e) => {
    L.click = desc(e.target);
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    L.stack = els.slice(0, 4).map(desc).join("  |  ");
    const inp = els.find((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA");
    L.input = inp
      ? `disabled=${inp.disabled} readonly=${inp.readOnly} pointer-events=${getComputedStyle(inp).pointerEvents} h=${Math.round(inp.getBoundingClientRect().height)}px`
      : "(no input under this click)";
    paint();
  }, true);
  document.addEventListener("focusin", (e) => { L.focus = desc(e.target); paint(); });
  document.addEventListener("keydown", (e) => { L.key = e.key + " -> " + desc(document.activeElement); paint(); }, true);
  document.addEventListener("input", (e) => {
    const t = e.target; L.typed = desc(t) + " = " + JSON.stringify(String((t && t.value) || "").slice(-24)); paint();
  }, true);
  paint();
}

/* ---------- auth gate ---------- */
const OFFLINE_KEY = "roybal-offline";
const isOfflineMode = () => localStorage.getItem(OFFLINE_KEY) === "1";
const needsLogin = () => SYNC_ENABLED && !isSignedIn() && !isOfflineMode();
let syncStarted = false;
function startSyncUI() {
  if (syncStarted) { syncNow(); return; }
  syncStarted = true;
  // two devices edited the same job → the engine merged; tell the human
  onSyncMerge(({ customer, added, filledForms }) => {
    const bits = [];
    if (added) bits.push(`${added} item${added === 1 ? "" : "s"}`);
    if (filledForms) bits.push(`${filledForms} form${filledForms === 1 ? "" : "s"}`);
    toast(`🔀 ${customer}: merged changes from another device${bits.length ? ` (+${bits.join(", ")})` : ""}. Both copies are kept in Backups.`);
  });
  // sync rewrote a stored row (merge or clean apply). If that job is open on
  // screen, graft the fresh copy into the SAME in-memory object the form is
  // bound to — otherwise the next autosave would write the stale on-screen
  // fork back over the merged one and quietly re-erase the other device's work.
  onSyncRowChanged(async (id) => {
    if (!liveProject || liveProject.id !== id) return;
    const fresh = await Store.get(id);
    if (fresh) graftProject(liveProject, fresh);
  });
  startSync(updateSyncStatus);
}
function boot() {
  if (SYNC_ENABLED && isSignedIn()) startSyncUI();
  route();
}

/* the project object the current page's inputs are bound to (null on the
   list/login screens) — sync grafts merged changes into it, see startSyncUI */
let liveProject = null;

async function route() {
  await flushPending();              // persist any in-flight edit before reloading
  renderTechChip();
  liveProject = null;
  if (needsLogin()) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  window.scrollTo(0, 0);
  // parts: [] | ['new'] | ['p', id] | ['p', id, 'edit'] | ['p', id, 'f', key] | ['p', id, 'f', key, instId]
  if (parts[0] === "new") return void (await createProject());
  if (parts[0] === "p" && parts[1]) {
    const project = await Store.get(parts[1]);
    if (!project) return go("#/");
    liveProject = project;
    mountAssist(project);   // 💬 job-aware assistant floats over every job page
    if (parts[2] === "edit") return projectEdit(project);
    if (parts[2] === "narrative") return narrativePage(project);
    if (parts[2] === "progress") return progressPage(project);
    if (parts[2] === "packet") return packetPage(project);
    if (parts[2] === "f" && parts[3]) return formPage(project, parts[3], parts[4]);
    return projectHome(project);
  }
  mountAssist(null);
  return projectList();
}

function setChrome(sub, back) {
  topbarSub.textContent = sub;
  backTarget = back || "#/";
  backBtn.hidden = !back;
}

/* Header chip: who's capturing on this device (Step E). Tap to set/change. */
function renderTechChip() {
  if (!techChip) return;
  if (needsLogin()) { techChip.hidden = true; return; }   // not on the sign-in screen
  techChip.hidden = false;
  const name = techName();
  techChip.textContent = "👤 " + (name || "Set tech");
  techChip.style.cssText =
    "margin-left:auto;margin-right:8px;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
    "border-radius:999px;padding:5px 11px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;" +
    (name ? "border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.14)"
          : "border:1px solid transparent;background:var(--orange,#f26a21)");
  techChip.onclick = async () => { await pickTech(); renderTechChip(); };
}

/* ============================================================
   Login (shared crew account) + sync status
   ============================================================ */
let lastSync = null;
function updateSyncStatus(s) {
  lastSync = s;
  const dot = $("#netStatus");
  if (!dot) return;
  const map = { syncing: ["var(--amber)", "Syncing…"], synced: ["var(--green)", "Synced"],
    offline: ["#ff6b6b", "Offline — saved on device"], error: ["#ff6b6b", "Sync error"] };
  const [color, title] = map[s.state] || ["var(--green)", "Online"];
  dot.style.color = color; dot.title = title;
  // refresh the account row if it's on screen
  const row = $("#acctRow");
  if (row) row.replaceWith(accountRow());
}
function syncLabel() {
  if (!SYNC_ENABLED) return "";
  if (!isSignedIn()) return "Working offline on this device";
  const s = lastSync || {};
  if (s.state === "syncing") return "Syncing…";
  if (s.state === "offline") return "Offline — will sync when back online";
  if (s.state === "error") return "Sync issue: " + (s.message || "retrying");
  if (s.skipped) return `Synced — ⚠ ${s.skipped} job(s) too large to back up`;
  return s.lastSync ? "All changes synced ✓" : "Synced ✓";
}

function renderLogin() {
  setChrome("Sign in", null);
  const body = clear(view);
  const email = h("input", { type: "email", placeholder: "Email", autocomplete: "username", value: "" });
  const pass = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const err = h("div", { class: "warn", hidden: true });
  const btn = h("button", { class: "btn btn--primary", style: "margin-top:6px" }, "Sign in");

  async function submit() {
    err.hidden = true; btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await signIn(email.value, pass.value);
      localStorage.removeItem(OFFLINE_KEY);
      startSyncUI();
      go("#/"); route();
    } catch (e) {
      err.hidden = false; err.textContent = String(e && e.message || e);
      btn.disabled = false; btn.textContent = "Sign in";
    }
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  body.append(
    h("div", { style: "max-width:380px;margin:8vh auto 0;text-align:center" },
      h("img", { src: "assets/emblem-mark.svg", alt: "", style: "width:84px;height:84px;border-radius:18px;background:#fff;padding:12px" }),
      h("h1", { style: "margin:14px 0 2px" }, "Roybal Field Forms"),
      h("p", { class: "subtle" }, "Sign in with your shared crew account to sync jobs across devices."),
      h("div", { class: "card", style: "text-align:left;margin-top:14px" },
        err,
        field("Email", email), field("Password", pass), btn),
      h("button", { class: "linklike", style: "margin-top:16px", onclick: () => { localStorage.setItem(OFFLINE_KEY, "1"); go("#/"); route(); } },
        "Work offline on this device →")));
}

function accountRow() {
  const row = h("div", { id: "acctRow", class: "acctrow" });
  if (!SYNC_ENABLED) return row;
  if (isSignedIn()) {
    row.append(
      h("div", { class: "acctrow__main" },
        h("div", {}, "Signed in · " + currentEmail()),
        h("div", { class: "acctrow__status" }, syncLabel())),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => syncNow() }, "↻ Sync"),
      h("button", { class: "linklike", onclick: doSignOut }, "Sign out"));
  } else {
    row.append(
      h("div", { class: "acctrow__main" }, h("div", {}, "Working offline on this device")),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => { localStorage.removeItem(OFFLINE_KEY); route(); } }, "Sign in to sync"));
  }
  return row;
}
function doSignOut() {
  if (!confirm("Sign out? Jobs stay saved on this device.")) return;
  signOut(); resetSync(); syncStarted = false;
  localStorage.removeItem(OFFLINE_KEY);
  route();
}

/* ============================================================
   Project list (home)
   ============================================================ */
/* Home-screen mode — which job kind the list shows and "+ New Job" creates. */
const MODE_KEY = "roybal-mode";
const activeMode = () => (localStorage.getItem(MODE_KEY) === "construction" ? "construction" : "restoration");
const setMode = (m) => localStorage.setItem(MODE_KEY, m);

/* Small job-kind chip for job cards — keeps mixed contexts unambiguous. */
function modeChip(p) {
  const isConst = jobType(p) === "construction";
  return h("span", {
    style: "font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 7px;border-radius:999px;margin-left:8px;vertical-align:2px;" +
      (isConst ? "background:#fdeadd;color:#c2571b" : "background:#e7eef7;color:#1e4a72"),
  }, isConst ? "🔨 CONSTRUCTION" : "💧 RESTORATION");
}

/* Board stage vocabulary — labels/colors mirror the Job Board's STAGES
   (apps/board/js/board.js). `order` is the home-list grouping order: working
   stages first, pipeline next, Complete last (right above the archive).
   The board OWNS stage (the field app only reads it) — see boardpush.js. */
const BOARD_STAGES = {
  in_progress: { label: "In Progress",   color: "#f26a21", order: 0 },
  final:       { label: "Final / Punch", color: "#8a6fb0", order: 1 },
  on_hold:     { label: "On Hold",       color: "#e0a800", order: 2 },
  scheduled:   { label: "Scheduled",     color: "#1c5fb0", order: 3 },
  lead:        { label: "Leads / Bids",  color: "#7a8aa0", order: 4 },
  done:        { label: "Complete",      color: "#1f9d55", order: 6 },
};
const NO_STAGE = { label: "Not on the board", color: "#98a3b3", order: 5 };

/* Archive = filed away, never deleted: the job keeps syncing and every form,
   photo and log stays on the device and in the cloud. */
async function setArchived(project, on) {
  project.archivedAt = on ? new Date().toISOString() : "";
  await Store.put(project);
  toast(on ? "Archived — it's under 🗂 Archived at the bottom of the jobs list."
           : "Moved back to the active jobs list.");
}

/* One job card for the home list. Archived rows render dimmed with an
   Unarchive button; a Complete-on-the-board row offers one-tap Archive. */
function jobRow(p, { onArchive = null, onUnarchive = null } = {}) {
  const isConst = jobType(p) === "construction";
  const cat = p.waterCategory ? `Cat ${p.waterCategory}` : "";
  const flags = p.archivedAt ? [] : (isConst ? buildFlags(p) : dryingFlags(p));   // rule-based watch flags — no AI, no cost
  const sub = isConst
    ? [p.address && p.customer ? p.address : "", p.claimNo ? "Claim " + p.claimNo : "",
       constructionTypeLabel(p.constructionType),
       p.targetCompletion ? "Target " + fmtDate(p.targetCompletion) : "",
       "Updated " + fmtDate((p.updatedAt || "").slice(0, 10))].filter(Boolean).join(" · ")
    : [p.address && p.customer ? p.address : "", p.claimNo ? "Claim " + p.claimNo : "", cat, "Updated " + fmtDate((p.updatedAt || "").slice(0, 10))].filter(Boolean).join(" · ");
  const sideBtn = (label, fn) => {
    const b = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto;flex:none" }, label);
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  };
  return h("a", { class: "card card--tap jobrow", href: `#/p/${p.id}`, style: p.archivedAt ? "opacity:.65" : "" },
    h("div", { class: "jobrow__main" },
      h("div", { class: "jobrow__title" }, p.customer || p.address || "Untitled job", modeChip(p)),
      h("div", { class: "jobrow__sub" }, sub),
      flags.length ? h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:5px" },
        ...flags.map((f) => h("span", {
          style: "font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;" +
            (f.tone === "bad" ? "background:#fdecea;color:#b3261e" : "background:#fff4e5;color:#8a6d00"),
        }, (f.icon || "💧") + " " + f.label))) : null),
    onUnarchive ? sideBtn("↩ Unarchive", onUnarchive)
      : onArchive ? sideBtn("🗂 Archive", onArchive)
      : h("div", { class: "jobrow__chev" }, "›"));
}

let _boardRows = null;   // session cache of board tiles → stage groups paint instantly next time
let _archOpen = false;   // keep the Archived section open across re-renders
let _listRender = null;  // token identifying the projectList render currently on screen
const stageSig = (rows) => JSON.stringify((rows || []).map((r) => [r.id, r.data && r.data.stage, r.data && r.data.fieldJobId]).sort());

async function projectList() {
  setChrome("Field Forms", null);
  const projects = await Store.all();
  const body = clear(view);
  const mode = activeMode();
  const byMode = { restoration: [], construction: [] };
  projects.forEach((p) => byMode[jobType(p)].push(p));
  const active = byMode[mode].filter((p) => !p.archivedAt);
  const archived = byMode[mode].filter((p) => p.archivedAt);
  const activeCount = (m) => byMode[m].filter((p) => !p.archivedAt).length;

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "Jobs"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => go("#/new") }, "+ New Job")));

  const modeSeg = h("div", { class: "seg", style: "margin:0 0 10px" });
  [["restoration", `💧 Restoration (${activeCount("restoration")})`],
   ["construction", `🔨 Construction (${activeCount("construction")})`]].forEach(([m, label]) => {
    const b = h("button", { type: "button", class: m === mode ? "active" : "" }, label);
    b.addEventListener("click", () => { if (m !== mode) { setMode(m); projectList(); } });
    modeSeg.append(b);
  });
  body.append(modeSeg);

  if (SYNC_ENABLED) body.append(accountRow());

  let paintLive = null;   // set when an active list is on screen

  if (!active.length && !archived.length) {
    body.append(h("div", { class: "empty" },
      h("div", { class: "big" }, mode === "construction" ? "🔨" : "🧰"),
      h("p", {}, mode === "construction" ? "No construction jobs yet." : "No restoration jobs yet."),
      h("p", { class: "subtle" }, mode === "construction"
        ? "Tap “+ New Job” to start a remodel, new build, or reconstruction. Everything works offline and saves to this device."
        : "Tap “+ New Job” to start a water restoration project. Everything works offline and saves to this device."),
      h("button", { class: "btn btn--primary", style: "max-width:260px;margin:10px auto 0", onclick: () => go("#/new") }, "+ New Job")));
  } else if (!active.length) {
    body.append(h("div", { class: "empty" },
      h("div", { class: "big" }, "🗂"),
      h("p", {}, "No active jobs — " + archived.length + " archived below.")));
  } else {
    const listWrap = h("div");
    body.append(listWrap);

    /* Paint the active list: grouped under the board's stage columns when any
       job is linked to a board tile, a plain flat list otherwise (offline, or
       nothing on the board — typical for restoration mode). */
    const paint = (rows) => {
      clear(listWrap);
      const staged = active.map((p) => {
        const row = rows ? boardRowFor(rows, p) : null;
        const sid = row && row.data && BOARD_STAGES[row.data.stage] ? row.data.stage : null;
        return { p, sid };
      });
      if (!staged.some((x) => x.sid)) {
        const list = h("div", { class: "joblist" });
        staged.forEach(({ p }) => list.append(jobRow(p)));
        listWrap.append(list);
        return;
      }
      const groups = new Map();   // order -> { meta, items } — items keep Store.all()'s newest-first order
      staged.forEach((x) => {
        const meta = x.sid ? BOARD_STAGES[x.sid] : NO_STAGE;
        if (!groups.has(meta.order)) groups.set(meta.order, { meta, items: [] });
        groups.get(meta.order).items.push(x);
      });
      [...groups.keys()].sort((a, b) => a - b).forEach((ord) => {
        const g = groups.get(ord);
        listWrap.append(h("div", { style: "display:flex;align-items:center;gap:7px;margin:14px 2px 8px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)" },
          h("span", { style: `width:9px;height:9px;border-radius:50%;flex:none;background:${g.meta.color}` }),
          `${g.meta.label} (${g.items.length})`));
        const list = h("div", { class: "joblist" });
        g.items.forEach(({ p, sid }) => list.append(jobRow(p, {
          // Complete on the board → one-tap archive right on the card
          onArchive: sid === "done" ? async () => { await setArchived(p, true); projectList(); } : null,
        })));
        listWrap.append(list);
      });
    };
    paint(_boardRows);
    paintLive = (rows) => { if (listWrap.isConnected) paint(rows); };
  }

  // The board refresh + tile adoption run even when this mode's active list is
  // EMPTY — a fresh device may have no local jobs until tiles are adopted.
  const render = (_listRender = {});
  fetchBoardRowsSafe().then(async (rows) => {
    if (!rows) return;   // offline / signed out
    const changed = stageSig(rows) !== stageSig(_boardRows);
    _boardRows = rows;
    if (changed && paintLive) paintLive(rows);
    // A field-created tile sitting next to the tile the coordinator already
    // built merges into it (nothing they built is lost, the dupe retires)
    const healed = await healBoardDuplicates(rows);
    if (healed) toast(healed === 1 ? "Merged a duplicate Job Board tile into your existing one."
      : `Merged ${healed} duplicate Job Board tiles into your existing ones.`);
    // Phase 6: board tiles that reached Scheduled / In Progress with no job
    // file get one now (idempotent — deterministic ids, tombstones honored)
    const n = await adoptBoardJobs(rows, projects);
    if (n && _listRender === render) {
      toast(n === 1 ? "Started a job file from the Job Board." : `Started ${n} job files from the Job Board.`);
      projectList();
    }
  });

  if (archived.length) {
    const archList = h("div", { class: "joblist", style: "margin-top:8px" });
    archived.forEach((p) => archList.append(jobRow(p, {
      onUnarchive: async () => { await setArchived(p, false); projectList(); },
    })));
    const det = h("details", { style: "margin-top:18px" },
      h("summary", { style: "cursor:pointer;font-weight:700;color:var(--muted);padding:6px 2px" }, `🗂 Archived (${archived.length})`),
      h("div", { class: "subtle", style: "font-size:12px;margin:4px 2px 0" },
        "Filed away, never deleted — every form, photo and log is still saved and searchable."),
      archList);
    det.open = _archOpen;
    det.addEventListener("toggle", () => { _archOpen = det.open; });
    body.append(det);
  }
  body.append(installHint());
}

const APP_VERSION = "v35";   // fallback only; the label below shows the LIVE service-worker cache version

function installHint() {
  const ver = h("div", { style: "text-align:center;color:var(--muted);font-size:11px;margin-top:14px" },
    "Roybal Field Forms · build " + APP_VERSION);
  // Show the LIVE service-worker cache version so the label always reflects the
  // code actually running on this device (no manual bump to forget / drift stale).
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      caches.keys().then((keys) => {
        const nums = keys.map((k) => (k.match(/^roybal-field-v(\d+)/) || [])[1]).filter(Boolean).map(Number);
        if (nums.length) ver.textContent = "Roybal Field Forms · build v" + Math.max(...nums);
      }).catch(() => {});
    }
  } catch (_) {}
  return h("div", {},
    h("div", { class: "note", style: "margin-top:18px" },
      h("strong", {}, "Tip: "),
      "Add this app to your home screen (Share → “Add to Home Screen”) to launch it like a regular app and use it with no signal in the field."),
    ver);
}

async function createProject() {
  const p = newProject();
  p.jobType = activeMode();   // the home-screen toggle decides what "+ New Job" starts
  await Store.put(p);
  go(`#/p/${p.id}/edit`);
}

/* ============================================================
   Project home — tiles for each form
   ============================================================ */
/* per-device fold memory for the job-home collapsible cards — the summary
   line always stays visible; only the detail body tucks away */
const foldKey = (k) => "roybal-fold-" + k;
function isFolded(k, dflt) {
  try { const v = localStorage.getItem(foldKey(k)); return v === null ? dflt : v === "1"; } catch (_) { return dflt; }
}
function setFolded(k, on) {
  try { localStorage.setItem(foldKey(k), on ? "1" : "0"); } catch (_) { /* ignore */ }
}
/* wire a header row + body into a tap-to-fold pair; k persists the choice */
function foldable(head, body, k, dflt) {
  const chev = h("span", { class: "subtle", style: "font-weight:600;flex:none" });
  head.append(chev);
  head.style.cursor = "pointer";
  const paint = () => {
    const f = isFolded(k, dflt);
    body.style.display = f ? "none" : "";
    chev.textContent = f ? "▸" : "▾";
  };
  head.addEventListener("click", () => { setFolded(k, !isFolded(k, dflt)); paint(); });
  paint();
}

/* Read-only completeness panel — pure checklist logic, no AI, no cost.
   Reads the already-loaded project; re-renders whenever the job home does. */
function completenessPanel(project) {
  const m = panelModel(project);
  const toneColor = m.tone === "blocked" ? "#b3261e" : (m.tone === "warn" ? "#8a6d00" : "#1b7a3d");
  const wrap = h("div", {
    class: "completeness",
    style: "border:1px solid #e2e6ec;border-left:4px solid " + toneColor +
           ";border-radius:12px;padding:12px 14px;margin:4px 0 16px;background:#fff",
  });
  const head = h("div", { style: "display:flex;align-items:center;gap:8px" },
    h("span", { style: "font-size:18px" }, m.icon),
    h("span", { style: "font-weight:700;color:" + toneColor }, m.summary),
    h("span", { class: "subtle", style: "margin-left:auto;font-weight:600" }, m.progress));
  wrap.append(head);
  const body = h("div");
  for (const g of m.groups) {
    const hard = g.tone === "hard";
    body.append(h("div", {
      style: "margin-top:10px;font-weight:600;font-size:13px;color:" + (hard ? "#b3261e" : "#5b6470"),
    }, g.title));
    const ul = h("ul", { style: "margin:4px 0 0;padding-left:20px;font-size:14px" + (hard ? "" : ";color:#5b6470") });
    g.items.forEach((t) => ul.append(h("li", { style: "margin:2px 0" }, t)));
    body.append(ul);
  }
  if (m.groups.length) {
    wrap.append(body);
    foldable(head, body, "completeness", false);   // summary always shows; checklist tucks away
  }
  return wrap;
}

/* ============================================================
   Restoration → construction conversion (Phase 3)
   ============================================================ */
async function startReconstruction(project, btn) {
  if (project.linkedConstructionId) return go(`#/p/${project.linkedConstructionId}`);   // already converted
  if (!isCertified(project) &&
      !confirm("Drying isn't certified yet — start the reconstruction job anyway?")) return;
  if (btn) btn.disabled = true;        // the puts below take a beat on photo-heavy jobs — no double-fire
  const con = convertToConstruction(project);
  project.linkedConstructionId = con.id;
  project.updatedAt = new Date().toISOString();
  await Store.put(con);
  await Store.put(project);
  setMode("construction");             // the new job lives on the construction tab
  toast("Reconstruction job created — same claim, construction forms.");
  go(`#/p/${con.id}`);
}

function startReconCard(project) {
  const btn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "🔨 Start reconstruction");
  btn.addEventListener("click", () => startReconstruction(project, btn));
  return h("div", { class: "card", style: "border-style:dashed" },
    h("div", { style: "font-weight:700" }, "🔨 Reconstruction"),
    h("p", { class: "subtle", style: "margin:6px 0 10px;font-size:14px" },
      isCertified(project)
        ? "Drying is certified — spin up the rebuild as a linked construction job. Header, photos and floor plans carry over; this mitigation job stays untouched."
        : "Creates a linked construction job for the rebuild (header, photos and floor plans carry over). Drying isn't certified yet — you'll be asked to confirm."),
    btn);
}

/* ---------- one-question-at-a-time follow-up box ----------
   Shared by the rebuild draft (questions) and the board timeline
   (assumptions). Each answer is saved on the project under qaKey and
   becomes documented fact on the next AI pass; progression state
   (qIndex) lives on the draft object so a redraft restarts the round.
   Answers can be typed or dictated (office STT — no LLM cost). */
function questionnaire(project, state, questions, qaKey, opts = {}) {
  if (!Array.isArray(project[qaKey])) project[qaKey] = [];
  if (typeof state.qIndex !== "number") state.qIndex = 0;
  const box = h("div", { class: "note", style: "margin-top:8px" });
  const redraftBtn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto;display:none" },
    opts.redraftLabel || "↻ Redraft with answers");
  redraftBtn.addEventListener("click", () => opts.onRedraft && opts.onRedraft(redraftBtn));

  function paint() {
    box.replaceChildren();
    const i = state.qIndex;
    const answered = project[qaKey].length;
    if (i >= questions.length) {
      box.append(h("strong", {}, opts.doneTitle || "Questions — done. "),
        answered ? `${answered} answer${answered === 1 ? "" : "s"} on file — tap "${opts.redraftLabel || "↻ Redraft with answers"}" to fold them into the plan.`
          : "All skipped — the draft stands as-is.");
      redraftBtn.style.display = answered ? "" : "none";
      return;
    }
    const input = h("textarea", { rows: "2",
      placeholder: opts.placeholder || "Type or dictate what you know — measurements, materials, owner decisions…",
      style: "margin-top:6px" });
    const advance = async (answer) => {
      if (answer) project[qaKey].push({ q: questions[i], a: answer, at: new Date().toISOString() });
      state.qIndex = i + 1;
      project.updatedAt = new Date().toISOString();
      await Store.put(project);
      paint();
    };
    const saveBtn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "Save answer");
    saveBtn.addEventListener("click", () => {
      const a = input.value.trim();
      if (!a) { toast("Type or dictate an answer — or Skip if you don't know yet."); input.focus(); return; }
      advance(a);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveBtn.click(); } });
    const mic = dictateBtn(project, (text) => {
      input.value = (input.value.trim() ? input.value.trim() + " " : "") + text;
      input.focus();
    });
    const okBtn = opts.confirmLabel ? h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, opts.confirmLabel) : null;
    if (okBtn) okBtn.addEventListener("click", () => advance("Confirmed correct."));
    const skipBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "Skip");
    skipBtn.addEventListener("click", () => advance(""));
    box.append(
      h("div", {}, h("strong", {}, `${opts.label || "Question"} ${i + 1} of ${questions.length}: `), questions[i]),
      input,
      h("div", { style: "display:flex;gap:8px;margin-top:6px;flex-wrap:wrap" },
        saveBtn, mic, okBtn, skipBtn));
  }
  paint();
  return { box, redraftBtn };
}

/* AI rebuild setup — drafts scope / trades / selections from the linked
   mitigation job, reviewed as chips before anything writes. AI failure or
   the spend cap never blocks: the forms work empty. */
function rebuildPanel(project) {
  const wrap = h("div", { class: "card", style: "border-style:dashed" });
  const status = h("div", { class: "subtle", style: "font-size:13px" });

  async function generate(btn) {
    if (!aiAvailable()) return;
    const rest = await Store.get(project.linkedRestorationId);
    if (!rest) { toast("The linked mitigation job isn't on this device — sync first."); return; }
    btn.disabled = true;
    status.textContent = "Drafting the rebuild plan from the mitigation documentation…";
    try {
      const facts = rebuildFacts(rest);
      // everything the estimator has answered becomes documented fact for
      // this draft — each redraft gets sharper
      const qa = (project.rebuildQA || []).filter((x) => x && String(x.a || "").trim());
      if (qa.length) facts.estimatorAnswers = qa.map((x) => ({ question: x.q, answer: x.a }));
      const draft = await draftRebuild(project, facts);
      // the call can take a while — write onto a FRESH copy (the tech may have
      // kept editing) and only repaint if they're still on this job home
      const fresh = (await Store.get(project.id)) || project;
      fresh.rebuildDraft = { draft, chips: rebuildChips(draft), createdAt: new Date().toISOString(), status: "draft" };
      fresh.updatedAt = new Date().toISOString();
      await Store.put(fresh);
      if (location.hash === `#/p/${project.id}`) projectHome(fresh);
      else toast("Rebuild plan drafted — review it on the job home.");
    } catch (e) {
      status.textContent = "";
      toast("Couldn't draft the rebuild plan — " + (e && e.message ? e.message : "try again") + ". The forms work fine without it.");
      btn.disabled = false;
    }
  }

  const rd = project.rebuildDraft;
  if (!rd || rd.status === "dismissed") {
    const btn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "✨ Draft rebuild plan");
    btn.addEventListener("click", () => generate(btn));
    wrap.append(
      h("div", { style: "font-weight:700" }, "✨ AI rebuild setup"),
      h("p", { class: "subtle", style: "margin:6px 0 10px;font-size:14px" },
        "Draft the Scope of Work, trade sequence and owner selections from the mitigation job's documentation. Everything lands as chips you review before it writes."),
      btn, status);
    return wrap;
  }
  if (rd.status === "applied") return null;   // done — the forms hold the data now

  const chips = Array.isArray(rd.chips) ? rd.chips : [];
  wrap.append(
    h("div", { style: "font-weight:700" }, "✨ Rebuild plan draft — tap to confirm"),
    h("p", { class: "subtle", style: "margin:4px 0 6px;font-size:13px" },
      "Amber = double-check. Uncheck anything wrong, then apply — values land in the forms and stay editable."));
  const GROUPS = [["scopeItems", "📐 Scope of Work"], ["subRows", "👷 Trade sequence"], ["selectionRows", "🎨 Owner selections"]];
  for (const [group, title] of GROUPS) {
    const list = chips.filter((c) => c.target && c.target.group === group);
    if (!list.length) continue;
    wrap.append(h("div", { style: "font-weight:600;font-size:13px;margin-top:8px;color:var(--navy,#16395a)" }, title));
    for (const c of list) {
      if (c.confirmed !== false) c.confirmed = true;
      const box = h("input", { type: "checkbox", checked: c.confirmed });
      box.addEventListener("change", () => { c.confirmed = box.checked; Store.put(project); });
      const amber = c.tone === "amber";
      wrap.append(h("label", {
        style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;margin:4px 0;background:" +
          (amber ? "#fff4e5" : "#eef6ee") + ";border:1px solid " + (amber ? "#f0b463" : "#bfe0bf"),
      },
        box,
        h("span", { style: "min-width:110px;font-size:13px;font-weight:600;color:var(--navy,#0f1b2d)" }, (amber ? "⚠️ " : "") + c.label),
        h("span", { style: "flex:1;font-size:13px" }, String(c.value ?? ""))));
    }
  }
  // Estimator questions — answered ONE AT A TIME (typed or dictated); each
  // answer becomes fact for the next redraft, so the estimate sharpens
  // instead of just nagging.
  const questions = rd.draft && Array.isArray(rd.draft.questions) ? rd.draft.questions.filter(Boolean) : [];
  let qaRedraftBtn = null;
  if (questions.length) {
    const q = questionnaire(project, rd, questions, "rebuildQA", {
      label: "Estimator question", doneTitle: "Estimator questions — done. ",
      redraftLabel: "↻ Redraft with answers",
      onRedraft: (b) => generate(b),
    });
    qaRedraftBtn = q.redraftBtn;
    wrap.append(q.box);
  }

  const applyBtn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "Apply checked items");
  applyBtn.addEventListener("click", async () => {
    const out = applyRebuildChips(project, chips, {
      scope: newScopeOfWork, scopeArea: blankScopeArea, scopeItem: blankScopeItem,
      subSchedule: newSubSchedule, subRow: blankSubRow,
      selections: newSelections, selectionRow: blankSelectionRow,
      trades: TRADES,
    });
    rd.status = "applied";
    project.updatedAt = new Date().toISOString();
    await Store.put(project);
    toast(out.applied ? `Applied ${out.applied} item(s) — review the Scope of Work, Sub Schedule and Selections.` : "Nothing checked.");
    projectHome(project);
  });
  const redoBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "↻ Redraft");
  redoBtn.addEventListener("click", () => generate(redoBtn));
  const dismissBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "Dismiss");
  dismissBtn.addEventListener("click", async () => { rd.status = "dismissed"; await Store.put(project); projectHome(project); });
  wrap.append(h("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" }, applyBtn, qaRedraftBtn, redoBtn, dismissBtn), status);
  return wrap;
}

/* ============================================================
   📅 Board timeline (Phase 5) — the field PROPOSES a phase plan,
   the Job Board SCHEDULES it. AI estimates hours + lag from the
   Scope of Work; the plan is edited here, then pushed rev-safely
   to coordination_jobs (never clobbering the coordinator's dates,
   crew, links or stage).
   ============================================================ */
function timelinePanel(project) {
  const wrap = h("div", { class: "card", style: "border-style:dashed" });
  const status = h("div", { class: "subtle", style: "font-size:13px" });

  async function estimate(btn) {
    if (!aiAvailable()) return;
    btn.disabled = true;
    status.textContent = "Estimating phases from the Scope of Work…";
    try {
      const history = await fetchHistoryDigest();   // est-vs-actual calibration, empty until history exists
      const facts = constructionFacts(project);
      // confirmed / corrected assumptions ride along as documented fact
      const qa = (project.timelineQA || []).filter((x) => x && String(x.a || "").trim());
      if (qa.length) facts.plannerAnswers = qa.map((x) => ({ assumption: x.q, answer: x.a }));
      const draft = await draftTimeline(project, facts, history);
      const fresh = (await Store.get(project.id)) || project;
      fresh.boardPlan = {
        phases: planPhases(draft),
        notBefore: isoDateOnly(draft.notBefore),   // never trust model prose as a date
        notBeforeLabel: isoDateOnly(draft.notBefore) ? (draft.notBeforeLabel || "") : "",
        assumptions: Array.isArray(draft.assumptions) ? draft.assumptions : [],
        generatedAt: new Date().toISOString(),
        status: "draft",
      };
      fresh.updatedAt = new Date().toISOString();
      await Store.put(fresh);
      if (location.hash === `#/p/${project.id}`) projectHome(fresh);
      else toast("Timeline drafted — review it on the job home.");
      return;
    } catch (e) {
      status.textContent = "";
      toast("Couldn't estimate — " + (e && e.message ? e.message : "try again") + ". You can still build phases on the board by hand.");
      btn.disabled = false;
    }
  }

  const bp = project.boardPlan;
  if (!bp || bp.status === "dismissed") {
    const btn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "📅 Estimate timeline");
    btn.addEventListener("click", () => estimate(btn));
    wrap.append(
      h("div", { style: "font-weight:700" }, "📅 Board timeline"),
      h("p", { class: "subtle", style: "margin:6px 0 10px;font-size:14px" },
        "Estimate the build phases (hours + wait days) from the Scope of Work, review them, then send them to the Job Board's calendar and Gantt. The board keeps control of dates and crew."),
      btn, status);
    return wrap;
  }

  const pushed = bp.status === "pushed";
  wrap.append(
    h("div", { style: "font-weight:700" }, pushed ? "📅 Board timeline — sent " + fmtDate((bp.pushedAt || "").slice(0, 10)) : "📅 Board timeline — review before sending"),
    h("p", { class: "subtle", style: "margin:4px 0 6px;font-size:13px" },
      pushed ? "The board schedules the dates and crew. Edit here and re-send if the plan changes."
        : "Amber = the estimate is inferred — double-check the hours. Edit anything, then send."));

  // editable phase rows — name / hours / lag, mirroring the board's phase editor
  const rows = h("div");
  const paintRows = () => {
    rows.replaceChildren(...bp.phases.map((p, i) => {
      const amber = Number(p.confidence) < 0.7;
      const name = h("input", { value: p.name || "", placeholder: "Phase name", style: "flex:2;min-width:110px" });
      name.addEventListener("input", () => { p.name = name.value; Store.put(project); });
      const hrs = h("input", { type: "number", value: p.estimatedHours ?? "", placeholder: "hrs", style: "width:70px", title: "crew hours" });
      hrs.addEventListener("input", () => { p.estimatedHours = hrs.value ? Number(hrs.value) : ""; Store.put(project); });
      const lag = h("input", { type: "number", value: p.lagDays || 0, style: "width:60px", title: "wait days before this phase (cure, inspection, delivery)" });
      lag.addEventListener("input", () => { p.lagDays = Math.max(0, Math.round(Number(lag.value) || 0)); Store.put(project); });
      const del = h("button", { type: "button", class: "rowdel", onclick: () => { bp.phases.splice(i, 1); Store.put(project); paintRows(); } }, "✕");
      return h("div", {
        style: "display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;margin:4px 0;background:" +
          (amber ? "#fff4e5" : "#f3f6fa") + ";border:1px solid " + (amber ? "#f0b463" : "#e2e6ec"),
      },
        h("span", { style: "min-width:16px;font-weight:700;font-size:12px;color:var(--muted)" }, String(i + 1)),
        name, hrs, h("span", { class: "subtle", style: "font-size:11px" }, "h"), lag,
        h("span", { class: "subtle", style: "font-size:11px" }, "d lag"), del);
    }));
  };
  paintRows();
  const addPhase = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "+ Add phase");
  addPhase.addEventListener("click", () => { bp.phases.push({ name: "", estimatedHours: "", lagDays: 0 }); Store.put(project); paintRows(); });
  wrap.append(rows, addPhase);

  if (bp.notBefore) wrap.append(h("div", { class: "subtle", style: "font-size:13px;margin-top:6px" },
    "🔒 Can't start before " + fmtDate(bp.notBefore) + (bp.notBeforeLabel ? ` (${bp.notBeforeLabel})` : "")));
  // each assumption is reviewed one at a time — confirm it or dictate/type a
  // correction; corrections feed the next re-estimate as documented fact
  let tqRedraftBtn = null;
  const assumptions = (bp.assumptions || []).filter(Boolean);
  if (assumptions.length) {
    const tq = questionnaire(project, bp, assumptions, "timelineQA", {
      label: "Assumption", doneTitle: "Assumptions — reviewed. ",
      confirmLabel: "✓ Looks right",
      redraftLabel: "↻ Re-estimate with answers",
      placeholder: "Correct it — crew size, cure times, lead times, dates…",
      onRedraft: (b) => estimate(b),
    });
    tqRedraftBtn = tq.redraftBtn;
    wrap.append(tq.box);
  }

  const sendBtn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, pushed ? "📅 Send again" : "📅 Send to Job Board");
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    status.textContent = "Sending to the board…";
    try {
      const out = await pushPlanToBoard(project);
      bp.status = "pushed";
      bp.pushedAt = new Date().toISOString();
      project.updatedAt = new Date().toISOString();
      await Store.put(project);
      toast(out.mode === "created" ? "Board job created with the phase plan."
        : out.mode === "proposal" ? "Sent — the board already has phases, so this landed as a proposal to review there."
        : "Phases sent to the board.");
      projectHome(project);
    } catch (e) {
      status.textContent = "";
      toast((e && e.message) || "Couldn't reach the board — try again online.");
      sendBtn.disabled = false;
    }
  });
  const reBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "↻ Re-estimate");
  reBtn.addEventListener("click", () => estimate(reBtn));
  const dismissBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "Dismiss");
  dismissBtn.addEventListener("click", async () => { bp.status = "dismissed"; await Store.put(project); projectHome(project); });
  wrap.append(h("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" }, sendBtn, tqRedraftBtn, reBtn, dismissBtn), status);
  return wrap;
}

/* Read-only "on the board" card — what the coordinator has scheduled.
   Renders async when a linked board job is found; hidden otherwise. */
const stageLabel = (id) => (BOARD_STAGES[id] ? BOARD_STAGES[id].label : id);
function boardCard(project) {
  const wrap = h("div", { class: "card", hidden: true });
  (async () => {
    try {
      const row = await findBoardRow(project);
      if (!row || !row.data) return;
      const d = row.data;
      const when = d.startDate && d.targetDate ? `${fmtDate(d.startDate)} → ${fmtDate(d.targetDate)}`
        : d.startDate ? "starts " + fmtDate(d.startDate) : "not scheduled yet";
      wrap.hidden = false;
      // native append() stringifies null — filter, unlike the h() helper
      wrap.append(...[
        h("div", { style: "font-weight:700" }, "🗓 On the Job Board"),
        h("div", { class: "subtle", style: "font-size:13px;margin-top:4px" },
          [stageLabel(d.stage), when,
           d.notBefore ? "🔒 not before " + fmtDate(d.notBefore) : ""].filter(Boolean).join(" · ")),
        (d.subtasks || []).length ? h("div", { style: "margin-top:6px;font-size:13px" },
          ...d.subtasks.map((st, i) => h("div", {},
            `${i + 1}. ${st.name || "Phase"}${st.estimatedHours ? " — " + st.estimatedHours + "h" : ""}${st.lagDays ? ` (+${st.lagDays}d lag)` : ""}`))) : null,
        d.fieldPlanProposal ? h("div", { class: "note", style: "margin-top:6px" },
          "⚠ Your phase proposal is waiting for review on the board.") : null,
      ].filter(Boolean));
      if (d.stage === "done" && !project.archivedAt) {
        const b = h("button", { class: "btn btn--primary btn--sm", style: "width:auto;margin-top:8px" }, "🗂 Archive this job");
        b.addEventListener("click", async () => { await setArchived(project, true); go("#/"); });
        wrap.append(h("div", { class: "note", style: "margin-top:8px" },
          "The board marked this job Complete. Archive it to tidy the jobs list — every form and photo stays saved."), b);
      }
    } catch (_) { /* offline / signed out — the card just stays hidden */ }
  })();
  return wrap;
}

/* 💬 Message log — claim documentation: every text composed from the app,
   newest first. Entries record COMPOSED (Messages opened pre-filled);
   Twilio (Path 2) will upgrade them with real delivery status. */
/* ---------- on-device backups card ----------
   Sync snapshots the local copy of a job right before a pulled version
   overwrites it (Store.backup). If snapshots exist, the job page offers
   one-tap restore — the undo for a stale copy clobbering newer work. */
function backupsCard(project) {
  const box = h("div");
  Store.backups(project.id).then((snaps) => {
    if (!snaps.length) return;
    const rows = snaps.map((s) => {
      const d = s.data || {};
      const when = String(s.takenAt || "").replace("T", " ").slice(0, 16);
      const desc = `${when} — ${(d.photos || []).length} photos, ${(d.moistureMaps || []).length} moisture maps, ` +
        `${(d.dryingLogs || []).length} drying logs, ${(d.constructionLogs || []).length} field reports`;
      const btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto;flex:none" }, "⏪ Restore");
      btn.addEventListener("click", async () => {
        if (!confirm(`Replace the current copy of this job with the backup from ${when}?\n\nThe current copy is saved as a backup first, so you can switch back.`)) return;
        btn.disabled = true;
        const current = await Store.get(project.id);
        if (current) await Store.backup(current);
        // sync tracks this row's rev in its own bookkeeping, so the restore
        // pushes as a normal guarded edit — if another device moved on
        // meanwhile, sync merges instead of letting an old snapshot clobber it
        const restored = { ...s.data };
        delete restored.rev;
        await Store.put(restored);   // fresh updatedAt → re-syncs
        toast("Backup restored.");
        setTimeout(() => location.reload(), 400);
      });
      return h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px" },
        h("span", { class: "subtle", style: "font-size:13px" }, desc), btn);
    });
    const head = h("div", { style: "display:flex;align-items:center;gap:8px" },
      h("div", { style: "font-weight:700" }, "⏪ Backups on this device"),
      h("span", { class: "subtle", style: "margin-left:auto;font-weight:600" },
        `${snaps.length} snapshot${snaps.length === 1 ? "" : "s"}`));
    const bodyBox = h("div", {},
      h("p", { class: "subtle", style: "margin:6px 0 2px;font-size:13px" },
        "Saved automatically right before cloud sync replaced this job with a version from another device. Restore if work went missing."),
      ...rows);
    foldable(head, bodyBox, "backups", true);   // rarely needed — starts tucked away
    box.append(h("div", { class: "card app-only" }, head, bodyBox));
  }).catch(() => {});
  return box;
}

function messageLogCard(project) {
  const log = Array.isArray(project.smsLog) ? project.smsLog : [];

  // per-device toggle: send texts from the company (toll-free) number vs the
  // tech's phone. Off by default; flip on once the number is verified + deployed.
  const toggle = h("input", { type: "checkbox", checked: companySendEnabled() });
  const hint = h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 0" });
  const paintHint = () => {
    hint.textContent = companySendEnabled()
      ? "On — text buttons send from your company number and log delivery status."
      : "Off — text buttons open your phone's Messages app to send.";
  };
  toggle.addEventListener("change", () => { setCompanySend(toggle.checked); paintHint(); });
  paintHint();
  const setting = h("div", {},
    h("label", { class: "check", style: "margin:0" }, toggle,
      h("span", {}, "Send texts from the company number")),
    hint);

  const via = (e) => e.via === "company"
    ? h("span", { style: "color:var(--green);font-weight:700" }, " · sent ✓")
    : e.error ? h("span", { style: "color:var(--red);font-weight:700" }, " · failed")
    : e.via === "device" ? h("span", { class: "subtle" }, " · composed") : null;
  // timestamps are stored UTC (ISO / Postgres timestamptz) — render LOCAL time,
  // or an evening Fairbanks text displays with tomorrow's date at a 00:xx hour
  const localWhen = (iso) => {
    const d = new Date(iso || "");
    if (isNaN(d)) return "";
    const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return fmtDate(day) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };
  const composedRow = (e) =>
    h("div", { style: "padding:6px 0;border-bottom:1px solid var(--line,#e2e6ec);font-size:13px" },
      h("div", {},
        h("strong", {}, SMS_KIND_LABELS[e.kind] || "Text"),
        h("span", { class: "subtle" }, "  " + localWhen(e.at) +
          " · to " + (e.to || []).join(", ") + (e.by ? " · by " + e.by : "")),
        via(e)),
      e.preview ? h("div", { class: "subtle", style: "font-size:12px" }, e.preview) : null);
  // inbound replies live in sms_messages (logged by the Twilio webhook) —
  // merged in below so the office sees the customer's side of the thread
  const inboundRow = (m) =>
    h("div", { style: "padding:6px 8px;border-bottom:1px solid var(--line,#e2e6ec);font-size:13px;background:rgba(242,106,33,.08);border-left:3px solid #f26a21" },
      h("div", {},
        h("strong", {}, "↩ Customer reply"),
        h("span", { class: "subtle" }, "  " + localWhen(m.created_at) +
          " · from " + (m.from_number || ""))),
      m.body ? h("div", { style: "font-size:12px" }, String(m.body).slice(0, 200)) : null);

  const heading = h("div", { style: "font-weight:700" }, "💬 Messaging");
  const divider = h("hr", { class: "divider", style: "margin:10px 0", hidden: true });
  const rowsBox = h("div");
  const more = h("p", { class: "subtle", style: "font-size:12px;margin-top:6px", hidden: true });

  const paintRows = (inbound) => {
    const items = [
      ...log.map((e) => ({ at: e.at || "", node: composedRow(e) })),
      ...inbound.map((m) => ({ at: m.created_at || "", node: inboundRow(m) })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));   // newest first
    rowsBox.replaceChildren(...items.slice(0, 10).map((x) => x.node));
    heading.textContent = items.length
      ? `💬 Messaging — log (${log.length} sent${inbound.length ? ` · ${inbound.length} received` : ""})`
      : "💬 Messaging";
    divider.hidden = !items.length;
    more.hidden = items.length <= 10;
    more.textContent = `+ ${items.length - 10} earlier`;
  };
  paintRows([]);

  // fetch this job's inbound texts (by unified-job link, or the customer's
  // number) — online-only enhancement; offline the card shows sends as before
  (async () => {
    try {
      if (!SYNC_ENABLED || !isSignedIn() || navigator.onLine === false) return;
      const uid = getUnifiedJobId(project.id);
      const digits = String(project.phone || "").replace(/[^\d]/g, "");
      const e164 = digits.length === 10 ? "+1" + digits
        : digits.length === 11 && digits.startsWith("1") ? "+" + digits : "";
      const ors = [];
      if (uid) ors.push(`unified_job_id.eq.${uid}`);
      if (e164) ors.push(`from_number.eq.${encodeURIComponent(e164)}`);
      if (!ors.length) return;
      const res = await rest(
        `sms_messages?select=created_at,from_number,body&direction=eq.inbound&or=(${ors.join(",")})&order=created_at.desc&limit=20`,
        { method: "GET" });
      if (!res.ok) return;
      const inbound = await res.json();
      if (Array.isArray(inbound) && inbound.length) paintRows(inbound);
    } catch (_) { /* offline / signed out — sends-only view is fine */ }
  })();

  return h("div", { class: "card app-only" }, heading, setting, divider, rowsBox, more);
}

function projectHome(project) {
  setChrome(project.customer || "Job", "#/");
  const body = clear(view);
  // keep the unified-job spine in step with this field job (fire-and-forget, never blocks UI)
  syncSpine(project);

  body.append(
    h("h1", {}, project.customer || project.address || "Untitled job"),
    h("p", { class: "subtle" }, [project.address, project.claimNo ? "Claim " + project.claimNo : ""].filter(Boolean).join(" · ") || "Tap Edit to add job details"));

  const badges = h("div", { class: "badgeline" });
  if (jobType(project) === "construction") {
    badges.append(h("span", { class: "badge", style: "background:#fdeadd;color:#c2571b" },
      "🔨 " + (constructionTypeLabel(project.constructionType) || "Construction")));
    if (project.targetCompletion) badges.append(h("span", { class: "badge" }, "Target " + fmtDate(project.targetCompletion)));
  } else {
    if (project.waterCategory) badges.append(h("span", { class: "badge cat" + project.waterCategory }, "Category " + project.waterCategory));
    if (project.waterClass) badges.append(h("span", { class: "badge" }, "Class " + project.waterClass));
    if (project.dryingSystem) badges.append(h("span", { class: "badge" }, project.dryingSystem + " drying"));
  }
  if (project.archivedAt)
    badges.append(h("span", { class: "badge", style: "background:#eceff3;color:#5b6672" },
      "🗂 Archived " + fmtDate(project.archivedAt.slice(0, 10))));
  // conversion cross-links — each side of a converted job links to the other
  if (project.linkedRestorationId)
    badges.append(h("a", { class: "badge", href: `#/p/${project.linkedRestorationId}`, style: "text-decoration:none" }, "💧 Mitigation job →"));
  if (project.linkedConstructionId)
    badges.append(h("a", { class: "badge", href: `#/p/${project.linkedConstructionId}`, style: "text-decoration:none" }, "🔨 Reconstruction job →"));
  if (badges.children.length) body.append(badges);

  const homeActions = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px" },
    h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", onclick: () => go(`#/p/${project.id}/edit`) }, "✎ Edit job details"));
  if (project.phone) {
    const tel = project.phone.replace(/[^\d+]/g, "");
    homeActions.append(
      h("a", { class: "btn btn--ghost btn--sm", style: "width:auto;text-decoration:none", href: "tel:" + tel }, "📞 Call"),
      (() => {
        const btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto",
          title: companySendEnabled() ? "Sends from your company number" : "Opens Messages pre-filled — review and send" },
          "🚗 Text: on our way");
        // Path 1 (Messages) or Path 2 (company number) per the messaging toggle;
        // either way the send is logged as claim documentation.
        btn.addEventListener("click", () => smartSend(project, {
          recipients: project.phone,
          body: onOurWaySms(project, techName()),
          kind: "onOurWay", by: techName(),
          onChange: () => Store.put(project),
        }));
        return btn;
      })());
  }
  const archBtn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" },
    project.archivedAt ? "↩ Unarchive" : "🗂 Archive");
  archBtn.addEventListener("click", async () => {
    await setArchived(project, !project.archivedAt);
    if (project.archivedAt) go("#/"); else projectHome(project);
  });
  homeActions.append(archBtn);
  body.append(homeActions);

  body.append(completenessPanel(project));   // each job kind checks its own required-form matrix
  body.append(messageLogCard(project));
  body.append(backupsCard(project));         // on-device snapshots taken before sync overwrote this job

  // Phase 6: no double entry — a job with real details gets/updates its board
  // tile (Leads until the coordinator stages it); fire-and-forget, offline-safe
  ensureBoardTile(project);

  // Phase 5: keep the board's field-actuals rollup fresh (fire-and-forget)
  if (jobType(project) === "construction") pushActuals(project);

  // Phase 3: conversion entry point + AI rebuild setup
  if (jobType(project) === "restoration" && !project.linkedConstructionId) body.append(startReconCard(project));
  if (jobType(project) === "construction" && project.linkedRestorationId) {
    const panel = rebuildPanel(project);
    if (panel) body.append(panel);
  }

  // Phase 5: propose a phase plan to the Job Board + show what it scheduled
  if (jobType(project) === "construction") {
    body.append(timelinePanel(project));
    body.append(boardCard(project));
  }

  const tiles = h("div", { class: "tiles" });
  formsFor(project).forEach((f) => {
    const count = formCount(project, f.key);
    const isList = f.multi || Array.isArray(project[f.key]); // moisture/drying/photos/contents…
    const noun = f.key === "contents" ? "items" : (f.key === "photos" ? "photos" : "saved");
    const badge = isList
      ? h("span", { class: "tile__count" }, count ? `${count} ${noun}` : "None yet")
      : h("span", { class: "tile__badge " + (count ? "done" : "todo") }, count ? "Started" : "Not started");
    tiles.append(h("a", { class: "tile" + (f.hero ? " tile--hero" : ""), href: `#/p/${project.id}/f/${f.key}` },
      h("div", { class: "tile__icon" }, f.icon),
      h("div", { class: "tile__name" }, f.name),
      h("div", { class: "tile__count" }, f.blurb),
      badge));
  });
  body.append(tiles);

  const actionRow = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px" },
    h("button", { class: "btn btn--primary", onclick: () => go(`#/p/${project.id}/packet`) }, "📄 Full job packet (PDF)"));
  // the narrative unlocks off the water-mitigation completeness rules — restoration only for now
  if (jobType(project) === "restoration") actionRow.append(
    h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/narrative`) },
      project.narrative ? "📝 Construction Narrative ✓" : "📝 Construction Narrative"));
  else actionRow.append(
    h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/progress`) },
      project.progressNarrative ? "📝 Progress Update ✓" : "📝 Progress Update"));
  body.append(actionRow);
}

/* ============================================================
   Full job packet — every started form, stacked for one PDF
   ============================================================ */
function packetPage(project) {
  setChrome("Job packet", `#/p/${project.id}`);
  const body = clear(view);
  setCtx(project, null);

  // Forms where an uploaded signed PDF/scan REPLACES the generated form.
  const UPLOAD_REPLACES = { workAuth: "Work Authorization & Service Agreement", certDrying: "Certificate of Drying" };

  const included = [];
  for (const f of formsFor(project)) {
    // Daily construction logs are internal (crew notes/issues/materials) — the
    // one-page Labor Log from QuickBooks Time represents the labor in the packet.
    if (f.key === "constructionLogs") continue;
    // Client Portal is internal office config for the customer share — never packet material.
    if (f.key === "portalShare") continue;
    const v = project[f.key];
    const render = RENDERERS[f.key];
    if (!render) continue;
    // Supporting docs: each uploaded document prints FULL PAGE (the sheet is
    // management UI + AI digest, not packet material)
    if (f.key === "supportDocs") {
      for (const d of (v || [])) {
        const pages = uploadedDocPages(d);
        if (pages.length) included.push(...uploadedDocSheet(pages,
          "Supporting Document" + (d.title ? " — " + d.title : d.docType ? " — " + d.docType : "")));
      }
      continue;
    }
    if (f.multi) {
      (v || []).forEach((inst) => included.push(render(project, inst)));
    } else {
      // Floor plan: every plan page FULL PAGE. The room-dimensions takeoff
      // table is INTERNAL ONLY — the adjuster reads SF/LF off the full-size
      // dimensioned plan; the table stays editable in the form for our use.
      if (f.key === "floorPlan") {
        const pages = v ? uploadedDocPages(v) : [];
        if (pages.length) included.push(...uploadedDocSheet(pages, "Floor Plan — Dimensions & Square Footages"));
        continue;
      }
      let has = Array.isArray(v) ? v.length > 0 : !!v;   // photos/contents are arrays → one report
      if (f.key === "laborLog") has = !!(v && Array.isArray(v.entries) && v.entries.length);  // only when synced
      if (!has) continue;
      const pages = UPLOAD_REPLACES[f.key] && v.mode === "upload" ? uploadedDocPages(v) : [];
      if (pages.length) included.push(...uploadedDocSheet(pages, UPLOAD_REPLACES[f.key]));
      else included.push(render(project, v));
    }
  }

  // Construction narrative is the opening document of the packet.
  if (project.narrative) included.unshift(narrativeSheet(project));

  body.append(
    h("h1", { class: "app-only" }, "Full job packet"),
    h("p", { class: "subtle app-only" }, included.length
      ? `${included.length} document(s) for ${project.customer || "this job"}. Tap “Save packet as PDF,” then share to the carrier.`
      : "Nothing to include yet — fill out some forms first."));

  included.forEach((s) => body.append(s));

  if (included.length) {
    body.append(h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}`) }, "Back"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save packet as PDF")));
  }
}

/* ============================================================
   Progress update (construction jobs) — weekly owner / carrier /
   lender status summary. AI-drafted from the construction digest,
   edited by the office, printed on letterhead. No completeness gate.
   ============================================================ */
function progressPage(project) {
  setChrome("Progress Update", `#/p/${project.id}`);
  const body = clear(view);
  if (jobType(project) !== "construction") return go(`#/p/${project.id}`);

  const status = h("div", { class: "subtle app-only", style: "font-size:13px;margin:8px 0;min-height:18px" });
  const preview = h("div", { style: "margin-top:14px" });
  const editor = h("textarea", {
    class: "app-only",
    style: "width:100%;min-height:260px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;padding:10px;border:1px solid #cdd5df;border-radius:10px",
    placeholder: "Generate, then review and edit the update here…",
  });
  editor.value = project.progressNarrative || "";
  const renderPreview = () => preview.replaceChildren(progressSheet(project));

  const genBtn = h("button", { class: "btn btn--primary" }, project.progressNarrative ? "↻ Regenerate" : "✨ Generate update");
  genBtn.addEventListener("click", async () => {
    if (!aiAvailable()) return;
    if (project.progressNarrative && !confirm("Regenerate? This replaces the current update, including any edits.")) return;
    genBtn.disabled = true; status.textContent = "Writing this week's update from the job documentation…";
    try {
      const draft = await draftProgress(project, constructionFacts(project));
      // the call can take a while — write onto a FRESH blob (the tech may have
      // kept editing elsewhere) and only repaint if they're still on this page
      const fresh = (await Store.get(project.id)) || project;
      fresh.progressNarrative = draft.narrative || "";
      fresh.progressNarrativeDate = new Date().toISOString().slice(0, 10);
      fresh.updatedAt = new Date().toISOString();
      await Store.put(fresh);
      if (location.hash === `#/p/${project.id}/progress`) progressPage(fresh);
      else toast("Progress update drafted — it's saved on the job.");
      return;
    } catch (e) {
      status.textContent = "";
      toast("Couldn't generate — " + (e && e.message ? e.message : "try again"));
    }
    genBtn.disabled = false;
  });
  const saveBtn = h("button", { class: "btn btn--ghost" }, "Save edits");
  saveBtn.addEventListener("click", async () => {
    project.progressNarrative = editor.value;
    project.progressNarrativeDate = project.progressNarrativeDate || new Date().toISOString().slice(0, 10);
    project.updatedAt = new Date().toISOString();
    await Store.put(project); renderPreview(); toast("Progress update saved.");
  });
  const copyBtn = h("button", { class: "btn btn--ghost" }, "Copy text");
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(editor.value);
    copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy text"), 1500);
  });

  body.append(
    h("h1", { class: "app-only" }, "📝 Progress Update"),
    h("p", { class: "subtle app-only", style: "font-size:14px" },
      "A weekly status summary for the owner" + (project.carrier ? ", adjuster" : "") + (project.lender ? ", lender" : "") +
      " — drafted from the daily logs, inspections, schedule, selections and draws. Review and edit before sending."),
    h("div", { class: "app-only", style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0" },
      genBtn, saveBtn, copyBtn,
      // the printed sheet renders the SAVED narrative — persist the editor first
      h("button", { class: "btn btn--primary", onclick: async () => {
        project.progressNarrative = editor.value;
        project.progressNarrativeDate = project.progressNarrativeDate || new Date().toISOString().slice(0, 10);
        project.updatedAt = new Date().toISOString();
        await Store.put(project); renderPreview();
        window.print();
      } }, "⬇ Save as PDF")),
    status,
    h("div", { class: "app-only", style: "font-weight:600;font-size:13px;margin-top:6px" }, "Update (editable Markdown):"),
    editor,
    preview,
    h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}`) }, "Done")));
  renderPreview();
}

/* ============================================================
   Construction narrative — AI-written packet cover, unlocked once
   every billing-requirement document is complete (isBillable).
   ============================================================ */
function narrativePage(project) {
  setChrome("Construction Narrative", `#/p/${project.id}`);
  const body = clear(view);
  const ev = evaluateProject(project);

  body.append(h("h1", {}, "📝 Construction Narrative"));

  if (!ev.isBillable) {
    body.append(
      h("div", { style: "border:1px solid #f0b463;background:#fff4e5;border-radius:12px;padding:14px;margin:8px 0" },
        h("div", { style: "font-weight:700;color:#8a6d00" }, "Finish the required documents first"),
        h("p", { style: "margin:6px 0;font-size:14px" }, "The construction narrative unlocks once every billing-requirement document is complete. Still missing:"),
        h("ul", { style: "margin:6px 0 0;padding-left:20px;font-size:14px" }, ...ev.hardGaps.map((g) => h("li", { style: "margin:2px 0" }, `${g.formLabel} — ${g.label}`)))),
      h("button", { class: "btn btn--ghost", style: "margin-top:12px", onclick: () => go(`#/p/${project.id}`) }, "Back to job"));
    return;
  }

  const status = h("div", { class: "subtle", style: "font-size:13px;margin:8px 0;min-height:18px" });
  const preview = h("div", { style: "margin-top:14px" });
  const editor = h("textarea", {
    style: "width:100%;min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;padding:10px;border:1px solid #cdd5df;border-radius:10px",
    placeholder: "Generate, then review and edit the narrative here…",
  });
  editor.value = project.narrative || "";
  const renderPreview = () => preview.replaceChildren(
    h("div", { class: "subtle", style: "font-size:12px;margin-bottom:6px" }, "Packet cover preview:"),
    h("div", { class: "packet-preview" }, narrativeSheet(project)));

  const genBtn = h("button", { class: "btn btn--primary" }, project.narrative ? "↻ Regenerate" : "✨ Generate narrative");
  genBtn.addEventListener("click", async () => {
    if (!isSignedIn()) return toast("Sign in to generate the narrative.");
    if (project.narrative && !confirm("Regenerate? This replaces the current narrative, including any edits.")) return;
    genBtn.disabled = true; status.textContent = "Writing the narrative with AI (Sonnet)…";
    try {
      const res = await generateNarrative(project);
      if (res.capped) { status.textContent = ""; toast("Monthly AI limit reached — write it manually or try next month."); genBtn.disabled = false; return; }
      project.narrative = res.narrative; project.narrativeDate = new Date().toISOString().slice(0, 10); project.updatedAt = new Date().toISOString();
      editor.value = project.narrative; await Store.put(project);
      status.textContent = `Draft ready (~$${(res.spend?.this_call_usd ?? 0).toFixed(3)}). Review and edit below — it prints as the packet cover.`;
      genBtn.textContent = "↻ Regenerate"; renderPreview();
    } catch (e) { status.textContent = ""; toast("Couldn't generate — " + (e && e.message ? e.message : "try again")); }
    genBtn.disabled = false;
  });
  const saveBtn = h("button", { class: "btn btn--ghost" }, "Save edits");
  saveBtn.addEventListener("click", async () => {
    project.narrative = editor.value; project.updatedAt = new Date().toISOString();
    await Store.put(project); renderPreview(); toast("Narrative saved.");
  });

  /* Adjuster email — drafts the claim-submission email from the facts + narrative. */
  const emailPanel = h("div", {});
  const emailBtn = h("button", { class: "btn btn--ghost" }, "✉️ Adjuster email");
  emailBtn.addEventListener("click", async () => {
    if (!aiAvailable()) return;
    emailBtn.disabled = true; status.textContent = "Drafting the adjuster email…";
    try {
      const draft = await draftAdjusterEmail(project);
      status.textContent = "";
      const subj = h("input", { value: draft.subject || "", style: "width:100%;padding:8px 10px;border:1px solid #cdd5df;border-radius:10px;font-size:13px" });
      const bodyTa = h("textarea", { style: "width:100%;min-height:200px;font-size:13px;line-height:1.5;padding:10px;border:1px solid #cdd5df;border-radius:10px;margin-top:6px" });
      bodyTa.value = draft.body || "";
      const copyBtn = h("button", { class: "btn btn--sm" }, "Copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(`Subject: ${subj.value}\n\n${bodyTa.value}`);
        copyBtn.textContent = "Copied!"; setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      });
      const mailBtn = h("button", { class: "btn btn--sm" }, "Open in Email");
      mailBtn.addEventListener("click", () => {
        location.href = `mailto:?subject=${encodeURIComponent(subj.value)}&body=${encodeURIComponent(bodyTa.value)}`;
      });
      emailPanel.replaceChildren(
        h("div", { style: "border:1px dashed #b9c4d4;border-radius:12px;padding:12px;margin:10px 0;background:#f7f9fc" },
          h("div", { style: "font-weight:600;font-size:13px;margin-bottom:6px" }, "✉️ Adjuster email draft — review, then copy or open in your mail app and attach the packet PDF:"),
          subj, bodyTa,
          h("div", { style: "display:flex;gap:8px;margin-top:8px" }, copyBtn, mailBtn)));
    } catch (e) {
      status.textContent = ""; toast("Couldn't draft the email — " + (e && e.message ? e.message : "try again"));
    }
    emailBtn.disabled = false;
  });

  body.append(
    h("p", { class: "subtle", style: "font-size:14px" }, "All required documents are complete. Generate the construction narrative, review and edit it, then it becomes the opening page of the job packet. (The reconstruction scope + estimate are added separately.)"),
    h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0" }, genBtn, saveBtn,
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/packet`) }, "📄 Open packet"),
      emailBtn),
    emailPanel,
    status,
    h("div", { style: "font-weight:600;font-size:13px;margin-top:6px" }, "Narrative (editable):"),
    editor,
    preview);
  if (project.narrative) renderPreview();
}


/* ============================================================
   Form page — list for multi forms, editor for single/instance
   ============================================================ */
async function formPage(project, key, instId) {
  const meta = formByKey(key);
  if (!meta) return go(`#/p/${project.id}`);

  // contents has its own manager (list + filters + boxes)
  if (key === "contents") {
    ensureContents(project);
    if (!instId) return contentsManager(project);
    if (instId === "report") return contentsReportPage(project);
    if (instId === "boxes") return boxesManager(project);
    if (instId === "packback") return contentsPackBack(project);
    const item = project.contents.find((x) => x.id === instId);
    if (!item) return go(`#/p/${project.id}/f/contents`);
    return contentsItemEditor(project, item);
  }

  // single-instance forms: open editor directly
  if (!meta.multi) {
    // shape heals must NOT bump updatedAt or trigger a push: merely opening a
    // form on a stale copy would otherwise make that copy "newest" and let it
    // overwrite real work on other devices via last-edit-wins
    if (key === "photos") {
      if (!Array.isArray(project.photos)) { project.photos = []; await Store.put(project, { bump: false, quiet: true }); }
      return formEditor(project, meta, project.photos);
    }
    if (!project[key]) { project[key] = FACTORY[key](); await Store.put(project, { bump: false, quiet: true }); }
    return formEditor(project, meta, project[key]);
  }

  // multi-instance: show instance list unless a specific instance is requested
  // (older projects predate some multi forms — e.g. invoices — so default the array)
  if (!Array.isArray(project[key])) { project[key] = []; await Store.put(project, { bump: false, quiet: true }); }
  if (instId) {
    const inst = project[key].find((x) => x.id === instId);
    if (!inst) return go(`#/p/${project.id}/f/${key}`);
    return formEditor(project, meta, inst);
  }
  return instanceList(project, meta);
}

function instanceList(project, meta) {
  setChrome(meta.name, `#/p/${project.id}`);
  const body = clear(view);
  const arr = project[meta.key];

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, meta.icon + " " + meta.name),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => addInstance(project, meta) }, "+ New")));
  body.append(h("p", { class: "subtle" }, meta.blurb));

  if (!arr.length) {
    body.append(h("div", { class: "empty" }, h("div", { class: "big" }, meta.icon), h("p", {}, "None yet."),
      h("button", { class: "btn btn--primary", style: "max-width:240px;margin:8px auto 0", onclick: () => addInstance(project, meta) }, "+ New " + meta.name)));
    return;
  }
  const list = h("div", { class: "joblist" });
  arr.slice().reverse().forEach((inst) => {
    const title = instanceTitle(meta.key, inst);
    list.append(h("a", { class: "card card--tap jobrow", href: `#/p/${project.id}/f/${meta.key}/${inst.id}` },
      h("div", { class: "jobrow__main" },
        h("div", { class: "jobrow__title" }, title),
        h("div", { class: "jobrow__sub" }, "Created " + fmtDate((inst.createdAt || "").slice(0, 10)))),
      h("div", { class: "jobrow__chev" }, "›")));
  });
  body.append(list);
}

function instanceTitle(key, inst) {
  switch (key) {
    case "moistureMaps": return inst.label || inst.material || ("Moisture map — " + fmtDate(inst.readings?.[0]?.date));
    case "dryingLogs": return "Drying log — " + fmtDate(inst.readings?.[0]?.date);
    case "constructionLogs": return "Field report — " + fmtDate(inst.date);
    case "supportDocs": return inst.title || (inst.docType ? inst.docType + " — " + fmtDate((inst.createdAt || "").slice(0, 10)) : "Supporting document");
    case "changeOrders": return "Change Order " + (inst.coNo || "") + " — " + fmtDate(inst.coDate);
    case "invoices": return "Invoice " + (inst.invoiceNo || "") + " — " + fmtDate(inst.invoiceDate);
    case "reconEstimates": return "Estimate " + (inst.invoiceNo || "") + " — " + fmtDate(inst.invoiceDate);
    case "inspections": return (inst.type || "Inspection") + " — " +
      (inst.result ? inst.result : (inst.scheduled ? "sched " + fmtDate(inst.scheduled) : "scheduled"));
    default: return "Entry";
  }
}

async function addInstance(project, meta) {
  const inst = FACTORY[meta.key]();
  project[meta.key].push(inst);
  await Store.put(project);
  go(`#/p/${project.id}/f/${meta.key}/${inst.id}`);
}

/* ---------- the actual form editor ---------- */
function formEditor(project, meta, instance) {
  const back = meta.multi ? `#/p/${project.id}/f/${meta.key}` : `#/p/${project.id}`;
  setChrome(meta.name, back);
  const body = clear(view);

  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  body.append(
    h("div", { class: "app-only", style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px" },
      h("div", {}, h("strong", { style: "font-size:18px" }, meta.icon + " " + meta.name)),
      pill));

  // 🎙️ Voice capture (Step D) — online-only enhancement above the typed form.
  if (AI_FORM_KEYS.includes(meta.key))
    body.append(transcribeWidget({ project, formKey: meta.key, instance, rerender: () => formEditor(project, meta, instance) }));

  const sheetEl = RENDERERS[meta.key](project, instance);
  body.append(sheetEl);

  // If a signed copy was uploaded for the Work Auth / Cert of Drying, the printed
  // single-form PDF shows the full-size uploaded document instead of the app form
  // (same as the full packet). The screen still shows the form to manage the upload.
  const UPLOAD_REPLACES = { workAuth: "Work Authorization & Service Agreement", certDrying: "Certificate of Drying" };
  // Floor plan: the dimensions-table sheet is INTERNAL ONLY (screen, never
  // paper) — printing this form yields just the uploaded plan pages FULL PAGE.
  if (meta.key === "floorPlan") {
    sheetEl.classList.add("app-only");
    const pages = uploadedDocPages(instance);
    if (pages.length) uploadedDocSheet(pages, "Floor Plan — Dimensions & Square Footages").forEach((sh) => body.append(sh));
    sheetEl.addEventListener("docpageschange", () => formEditor(project, meta, instance));
  }
  if (meta.key === "supportDocs") {
    const pages = uploadedDocPages(instance);
    if (pages.length) {
      sheetEl.classList.add("app-only");   // print the document itself, not the management form
      uploadedDocSheet(pages, "Supporting Document" + (instance.title ? " — " + instance.title : "")).forEach((sh) => body.append(sh));
    }
    sheetEl.addEventListener("docpageschange", () => formEditor(project, meta, instance));
  }
  if (UPLOAD_REPLACES[meta.key] && instance && instance.mode === "upload") {
    const pages = uploadedDocPages(instance);
    if (pages.length) {
      sheetEl.classList.add("app-only");   // hide the generated form on print
      uploadedDocSheet(pages, UPLOAD_REPLACES[meta.key]).forEach((s) => body.append(s));
    }
    // uploading / removing pages re-renders the page so an immediate
    // "Save as PDF" prints the full-size document, not the thumbnails
    sheetEl.addEventListener("docpageschange", () => formEditor(project, meta, instance));
  }

  body.append(h("div", { style: "height:8px" }));

  // sticky actions
  const actions = h("div", { class: "sticky-actions app-only" },
    h("button", { class: "btn btn--ghost", onclick: () => go(back) }, "Done"),
    h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save as PDF"));
  if (meta.multi) {
    actions.insertBefore(
      h("button", { class: "btn btn--danger", onclick: () => deleteInstance(project, meta, instance, back) }, "Delete"),
      actions.firstChild);
  }
  body.append(actions);
}

async function deleteInstance(project, meta, instance, back) {
  if (!confirm(`Delete this ${meta.name}? This cannot be undone.`)) return;
  const arr = project[meta.key];
  const i = arr.findIndex((x) => x.id === instance.id);
  if (i >= 0) arr.splice(i, 1);
  await Store.put(project);
  toast(meta.name + " deleted");
  go(back);
}

/* ============================================================
   CONTENTS — personal property inventory + pack-out boxes
   ============================================================ */
function ensureContents(project) {
  if (!Array.isArray(project.contents)) project.contents = [];
  if (!Array.isArray(project.boxes)) project.boxes = [];
  if (!Array.isArray(project.rooms)) project.rooms = [];
}
const dispClass = (d) =>
  d === "salvageable" ? "g" : d === "non-salvageable" ? "r" : d === "disposed" ? "x" : "b";
const boxLabelOf = (project, id) => (project.boxes.find((b) => b.id === id) || {}).label || "";

/* a <select> with an extra "add new" option that prompts */
function addableSelect(getVal, options, onPick, addLabel, onAdd) {
  const wrap = h("span", { class: "addable" });
  function render() {
    const cur = getVal();
    const s = h("select");
    s.append(h("option", { value: "" }, "—"));
    options().forEach((o) => s.append(h("option", { value: o.value, selected: o.value === cur }, o.label)));
    s.append(h("option", { value: "__new__" }, addLabel));
    s.addEventListener("change", () => {
      if (s.value === "__new__") {
        const added = onAdd();
        if (added != null && added !== "") onPick(added);
        render();
      } else onPick(s.value);
    });
    wrap.replaceChildren(s);
  }
  render();
  return wrap;
}
function roomSelect(project, item) {
  return addableSelect(
    () => item.room,
    () => project.rooms.map((r) => ({ value: r, label: r })),
    (v) => { item.room = v; Store.put(project); },
    "➕ New room…",
    () => {
      const name = (prompt("Room name (e.g. Kitchen, Master Bedroom)") || "").trim();
      if (!name) return null;
      if (!project.rooms.includes(name)) project.rooms.push(name);
      item.room = name; Store.put(project); return name;
    });
}
function boxSelect(project, item, onChange) {
  return addableSelect(
    () => (item.noBox ? "__loose__" : item.boxId),
    () => [
      { value: "__loose__", label: "🛋 Large item — no box" },
      ...project.boxes.map((b) => ({ value: b.id, label: b.label + (b.room ? " · " + b.room : "") })),
    ],
    (v) => {
      if (v === "__loose__") { item.noBox = true; item.boxId = ""; if (!item.destination) item.destination = "Storage"; }
      else { item.noBox = false; item.boxId = v; }
      Store.put(project);
      if (onChange) onChange();
    },
    "➕ New box…",
    () => {
      const b = newBox(project.boxes.length + 1);
      const label = (prompt("Box label", b.label) || "").trim();
      if (!label) return null;
      b.label = label; b.room = item.room || "";
      project.boxes.push(b); item.boxId = b.id; item.noBox = false; Store.put(project);
      if (onChange) onChange();
      return b.id;
    });
}

function contentsSummary(project) {
  const items = project.contents;
  const pieces = items.reduce((s, it) => s + (Number(it.qty) || 1), 0);
  const loss = items.filter((it) => it.disposition === "non-salvageable");
  const lossTotal = loss.reduce((s, it) => s + (Number(it.value) || 0) * (Number(it.qty) || 1), 0);
  const chips = h("div", { class: "badgeline" },
    h("span", { class: "badge" }, items.length + " items · " + pieces + " pcs"),
    h("span", { class: "badge" }, project.boxes.length + " boxes"));
  if (loss.length) chips.append(h("span", { class: "badge cat3" }, loss.length + " loss · " + money(lossTotal)));
  return chips;
}

/* Cat 3 + porous contents still marked salvageable — S500 review flag */
function s500ContentsWarning(project) {
  if (String(project.waterCategory) !== "3") return h("span");
  const risky = project.contents.filter((it) => POROUS_CATEGORIES.includes(it.category) && it.disposition !== "non-salvageable");
  if (!risky.length) return h("span");
  return h("div", { class: "warn app-only", style: "margin:6px 0" },
    h("strong", {}, "⚠ Cat 3 review: "),
    `${risky.length} porous item(s) (${[...new Set(risky.map((i) => i.category))].join(", ")}) not marked non-salvageable — IICRC S500 says porous materials in Category 3 losses usually can't be restored.`);
}

function contentsManager(project) {
  setChrome("Contents", `#/p/${project.id}`);
  const body = clear(view);
  setCtx(project, null);

  let q = "", fRoom = "", fBox = "", fDisp = "";

  /* ✨ Bulk capture: photograph a room/shelf, the AI lists every item it
     sees, the tech checks off what to add. Photos are not attached to the
     created items — take close-ups on the ones that matter for the claim. */
  const scanInput = h("input", { type: "file", accept: "image/*", style: "display:none" });
  const scanBtn = h("button", { class: "btn btn--ghost btn--sm" }, "✨ Scan room photo");
  const scanPanel = h("div", {});
  scanBtn.addEventListener("click", () => { if (aiAvailable()) scanInput.click(); });
  scanInput.addEventListener("change", async () => {
    const f = scanInput.files[0]; scanInput.value = "";
    if (!f) return;
    scanBtn.disabled = true; scanBtn.textContent = "✨ Scanning…";
    try {
      const img = await fileToDataURL(f);
      const found = await scanContentsPhoto(project, img, CONTENT_CATEGORIES, CONDITIONS);
      if (!found.length) { scanPanel.replaceChildren(h("p", { class: "subtle" }, "✨ No personal-property items recognized in that photo.")); }
      else {
        const roomIn = h("input", { placeholder: "Room for these items (e.g. Living Room)", style: "margin:6px 0" });
        const rows = found.map((it) => {
          const cb = h("input", { type: "checkbox", checked: true, style: "width:22px;height:22px;min-height:0;flex:0 0 auto" });
          return { it, cb, row: h("label", { style: "display:flex;align-items:center;gap:10px;padding:5px 0;font-size:14px;cursor:pointer" },
            cb, h("span", { style: "flex:1" }, h("strong", {}, it.name), ` — ${it.category || "?"} · qty ${it.qty || 1}` +
              (it.estimatedValue > 0 ? ` · est. ${money(it.estimatedValue)}` : ""))) };
        });
        const addBtn = h("button", { class: "btn btn--primary btn--sm", style: "margin-top:8px" }, "+ Add checked items");
        addBtn.addEventListener("click", async () => {
          const picked = rows.filter((r) => r.cb.checked);
          if (!picked.length) return toast("Nothing checked.");
          for (const { it } of picked) {
            const n = newContentsItem();
            n.name = it.name || ""; n.qty = String(it.qty || 1);
            if (CONTENT_CATEGORIES.includes(it.category)) n.category = it.category;
            if (CONDITIONS.includes(it.condition)) n.condition = it.condition;
            if (it.estimatedValue > 0) n.value = String(Math.round(it.estimatedValue));
            n.room = roomIn.value.trim();
            project.contents.push(n);
            if (n.room && !project.rooms.includes(n.room)) project.rooms.push(n.room);
          }
          await Store.put(project);
          toast(`Added ${picked.length} item(s) — open each to add photos & details.`);
          contentsManager(project);
        });
        scanPanel.replaceChildren(h("div", { class: "card", style: "border-style:dashed" },
          h("strong", { style: "font-size:13px" }, `✨ ${found.length} item(s) recognized — uncheck any that don't belong, set the room, then add:`),
          roomIn, ...rows.map((r) => r.row), addBtn));
      }
    } catch (e) {
      toast("Scan failed — " + (e && e.message ? e.message : "try again"));
    }
    scanBtn.disabled = false; scanBtn.textContent = "✨ Scan room photo";
  });

  /* ✨ One-line total-loss justifications for the loss schedule (editable per item). */
  const justifyBtn = h("button", { class: "btn btn--ghost btn--sm" }, "✨ Justify losses");
  justifyBtn.addEventListener("click", async () => {
    const need = project.contents.filter((it) => it.disposition === "non-salvageable" && !String(it.lossJust || "").trim());
    if (!need.length) return toast("Every total-loss item already has a justification.");
    if (!aiAvailable()) return;
    justifyBtn.disabled = true; justifyBtn.textContent = "✨ Writing…";
    try {
      const out = await justifyContents(project, need);
      let n = 0;
      for (const j of out) {
        const it = project.contents.find((x) => x.id === j.id);
        if (it && j.text) { it.lossJust = j.text; n++; }
      }
      await Store.put(project);
      toast(`Wrote ${n} justification(s) — they print on the loss schedule and stay editable per item.`);
    } catch (e) {
      toast("Couldn't write justifications — " + (e && e.message ? e.message : "try again"));
    }
    justifyBtn.disabled = false; justifyBtn.textContent = "✨ Justify losses";
  });

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("h1", {}, "📦 Contents"),
      h("button", { class: "btn btn--primary btn--sm", onclick: () => addItem(project) }, "+ Add item")),
    contentsSummary(project),
    s500ContentsWarning(project),
    h("div", { class: "btn-row", style: "margin:6px 0 12px;flex-wrap:wrap" },
      scanBtn,
      justifyBtn,
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/boxes`) }, `📦 Boxes (${project.boxes.length})`),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/packback`) }, "↩︎ Pack-back"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => go(`#/p/${project.id}/f/contents/report`) }, "📄 Inventory PDF"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => exportContentsCSV(project) }, "⬇ CSV")),
    scanInput, scanPanel);

  // filters
  const search = h("input", { type: "search", placeholder: "Search items…" });
  search.addEventListener("input", () => { q = search.value.toLowerCase(); paint(); });
  const roomF = h("select", {}, h("option", { value: "" }, "All rooms"),
    ...project.rooms.map((r) => h("option", { value: r }, r)));
  roomF.addEventListener("change", () => { fRoom = roomF.value; paint(); });
  const boxF = h("select", {}, h("option", { value: "" }, "All boxes"),
    h("option", { value: "__loose__" }, "🛋 Loose / large items"),
    ...project.boxes.map((b) => h("option", { value: b.id }, b.label)));
  boxF.addEventListener("change", () => { fBox = boxF.value; paint(); });
  const dispF = h("select", {}, h("option", { value: "" }, "All"),
    ...DISPOSITIONS.map((d) => h("option", { value: d.value }, d.label)));
  dispF.addEventListener("change", () => { fDisp = dispF.value; paint(); });
  body.append(h("div", { class: "filterbar" }, search, h("div", { class: "grid3" }, roomF, boxF, dispF)));

  const list = h("div", { class: "joblist" });
  body.append(list);

  function paint() {
    const items = project.contents.filter((it) =>
      (!q || (it.name + " " + it.brand + " " + it.model + " " + it.notes).toLowerCase().includes(q)) &&
      (!fRoom || it.room === fRoom) && (!fBox || (fBox === "__loose__" ? it.noBox : it.boxId === fBox)) && (!fDisp || it.disposition === fDisp));
    if (!items.length) {
      list.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, "📦"),
        h("p", {}, project.contents.length ? "No items match." : "No items yet."),
        h("button", { class: "btn btn--primary", style: "max-width:240px;margin:8px auto 0", onclick: () => addItem(project) }, "+ Add item")));
      return;
    }
    list.replaceChildren(...items.map((it) => h("a", { class: "card card--tap citem", href: `#/p/${project.id}/f/contents/${it.id}` },
      it.photos[0] ? h("img", { class: "cthumb", src: it.photos[0], alt: "" }) : h("div", { class: "cthumb cthumb--ph" }, "📦"),
      h("div", { class: "jobrow__main" },
        h("div", { class: "jobrow__title" }, (it.qty && it.qty !== "1" ? it.qty + "× " : "") + (it.name || "Untitled item")),
        h("div", { class: "jobrow__sub" }, [it.room, boxLabelOf(project, it.boxId), it.condition].filter(Boolean).join(" · ")),
        h("div", { class: "badgeline", style: "margin:4px 0 0" },
          it.disposition ? h("span", { class: "badge disp-" + dispClass(it.disposition) }, dispositionShort(it.disposition)) : null,
          it.value ? h("span", { class: "badge" }, money((Number(it.value) || 0) * (Number(it.qty) || 1))) : null)),
      h("div", { class: "jobrow__chev" }, "›"))));
  }
  paint();
}

async function addItem(project) {
  ensureContents(project);
  const it = newContentsItem();
  project.contents.push(it);
  await Store.put(project);
  go(`#/p/${project.id}/f/contents/${it.id}`);
}

function contentsItemEditor(project, item) {
  setChrome(item.name || "Item", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const warn = h("div", { class: "warn app-only", hidden: true });
  function checkWarn() {
    const msgs = [];
    if (item.disposition === "non-salvageable" && (!item.photos || !item.photos.length))
      msgs.push([h("strong", {}, "📷 Tip: "), "Add a photo of this non-salvageable item — carriers require photo proof for the loss claim."]);
    // S500: porous materials in Cat 3 losses generally can't be restored to sanitary condition
    if (String(project.waterCategory) === "3" && POROUS_CATEGORIES.includes(item.category) && item.disposition !== "non-salvageable")
      msgs.push([h("strong", {}, "⚠ Cat 3: "), `${item.category} is porous — IICRC S500 says porous materials in Category 3 losses usually can't be restored. Review the disposition.`]);
    warn.hidden = !msgs.length;
    warn.replaceChildren(...msgs.flatMap((m, i) => (i ? [h("div", { style: "margin-top:6px" }, ...m)] : [h("div", {}, ...m)])));
  }

  // large/loose items track their own destination (boxes carry it for boxed items)
  const destField = field("Where did it go? (no box)", sel(item, "destination", BOX_DESTINATIONS));
  destField.hidden = !item.noBox;

  const acvLine = h("div", { class: "acvline app-only" });
  function updateAcv() {
    const d = depreciation(item);
    if (!d.rcv) { acvLine.hidden = true; return; }
    acvLine.hidden = false;
    acvLine.replaceChildren(
      h("span", {}, "RCV ", h("b", {}, money(d.rcv))),
      h("span", {}, "Depr. ", h("b", {}, Math.round(d.rate * 100) + "%")),
      h("span", {}, "ACV ", h("b", { style: "color:var(--orange-dark)" }, money(d.acv))));
  }

  /* ✨ Identify from photo — vision fills the claim fields from the item's
     photo (blank fields only; everything stays editable). Runs automatically
     when a photo lands on a blank item; the button covers the rest. */
  const idBtn = h("button", { type: "button", class: "btn btn--sm", style: "width:auto" }, "✨ Identify from photo");
  const idLine = h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" });
  async function runIdentify({ silent = false } = {}) {
    if (!item.photos || !item.photos.length) { if (!silent) toast("Add a photo of the item first."); return; }
    if (silent ? !aiReady() : !aiAvailable()) return;
    idBtn.disabled = true; idBtn.textContent = "✨ Identifying…";
    try {
      const r = await analyzeContentsItem(project, item.photos[item.photos.length - 1], CONTENT_CATEGORIES, CONDITIONS);
      const filled = [];
      const fill = (key, v) => { if (v != null && String(v).trim() && !String(item[key] || "").trim()) { item[key] = String(v); filled.push(key); } };
      fill("name", r.name); fill("brand", r.brand); fill("model", r.model);
      if (CONTENT_CATEGORIES.includes(r.category)) fill("category", r.category);
      if (CONDITIONS.includes(r.condition)) fill("condition", r.condition);
      if (r.estimatedValue > 0) fill("value", Math.round(r.estimatedValue));
      if (r.notes) fill("notes", r.notes);
      await Store.put(project);
      idLine.textContent = "✨ " + (r.name || "Identified") +
        (r.estimatedValue > 0 ? ` · est. replacement ${money(r.estimatedValue)} (starting point — verify)` : "") +
        (filled.length ? "" : " — fields already filled, nothing overwritten");
      if (filled.length) { contentsItemEditor(project, item); toast("Filled: " + filled.join(", ") + " — review every field."); }
    } catch (e) {
      if (!silent) toast("Couldn't identify — " + (e && e.message ? e.message : "try again"));
    }
    idBtn.disabled = false; idBtn.textContent = "✨ Identify from photo";
  }
  idBtn.addEventListener("click", () => runIdentify());

  body.append(
    h("div", { class: "app-only", style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px" },
      h("strong", { style: "font-size:18px" }, "📦 Item"), pill),
    h("div", { class: "card" },
      field("Photos", photoUploader(item.photos, "Add item photos", {
        onAdd: () => { if (!String(item.name || "").trim()) runIdentify({ silent: true }); },
      })),
      h("div", { class: "app-only", style: "margin:-4px 0 12px" }, idBtn, idLine),
      warn,
      field("Item name", inp(item, "name", { placeholder: "e.g. 55\" Samsung TV" })),
      h("div", { class: "grid2" },
        field("Quantity", inp(item, "qty", { type: "number", oninput: updateAcv })),
        field("Category", sel(item, "category", CONTENT_CATEGORIES, { placeholder: "Select…", onchange: updateAcv }))),
      h("div", { class: "grid2" },
        field("Room", roomSelect(project, item)),
        field("Box", boxSelect(project, item, () => { destField.hidden = !item.noBox; }))),
      destField,
      field("Condition", seg(item, "condition", CONDITIONS)),
      field("Disposition", seg(item, "disposition", DISPOSITIONS.map((d) => ({ value: d.value, label: d.label })), { onchange: checkWarn })),
      h("div", { class: "grid2" },
        field("Replacement value (each)", inp(item, "value", { type: "number", placeholder: "$ per unit", oninput: updateAcv })),
        field("Age (yrs)", inp(item, "age", { type: "number", oninput: updateAcv }))),
      acvLine,
      h("details", { class: "app-only" },
        h("summary", { class: "linklike" }, "Brand / model (for the claim)"),
        h("div", { class: "grid2", style: "margin-top:8px" },
          field("Brand", inp(item, "brand")),
          field("Model", inp(item, "model")))),
      field("Notes", ta(item, "notes"))));
  checkWarn();
  updateAcv();

  body.append(h("div", { class: "sticky-actions app-only" },
    h("button", { class: "btn btn--danger", onclick: () => deleteItem(project, item) }, "Delete"),
    h("button", { class: "btn btn--primary", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done")));
}

async function deleteItem(project, item) {
  if (!confirm("Delete this item?")) return;
  const i = project.contents.findIndex((x) => x.id === item.id);
  if (i >= 0) project.contents.splice(i, 1);
  await Store.put(project);
  toast("Item deleted");
  go(`#/p/${project.id}/f/contents`);
}

/* ---------- Boxes manager (+ printable labels) ---------- */
function boxesManager(project) {
  setChrome("Boxes", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);
  const countItems = (id) => project.contents.filter((it) => it.boxId === id).length;

  const listWrap = h("div", { class: "app-only" });
  function paint() {
    const cards = project.boxes.map((b) =>
      h("div", { class: "card" },
        h("div", { class: "grid2" },
          field("Box label", inp(b, "label")),
          field("Room", inp(b, "room"))),
        h("div", { class: "grid2" },
          field("Destination", sel(b, "destination", BOX_DESTINATIONS)),
          field("Packed by", inp(b, "packedBy"))),
        h("div", { class: "grid2" },
          field("Packed date", inp(b, "packedDate", { type: "date" })),
          field("Items in box", h("div", { style: "padding-top:12px;font-weight:700" }, String(countItems(b.id))))),
        field("Contents (typed or from an AI snapshot — prints on the box label)", ta(b, "aiContents")),
        h("div", { class: "app-only", style: "display:flex;gap:8px" }, boxSnapBtn(b), h("button", { class: "btn btn--danger btn--sm", style: "width:auto", onclick: () => delBox(b) }, "Delete box"))));
    listWrap.replaceChildren(
      h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px" },
        h("h1", {}, "📦 Boxes"),
        h("button", { class: "btn btn--primary btn--sm", onclick: addBox }, "+ New box")),
      project.boxes.length ? h("div", {}, ...cards)
        : h("div", { class: "empty" }, h("div", { class: "big" }, "📦"), h("p", {}, "No boxes yet."),
            h("button", { class: "btn btn--primary", style: "max-width:200px;margin:8px auto 0", onclick: addBox }, "+ New box")));
    labels.replaceChildren(...buildLabels());
  }
  /* 📷✨ photograph the open box before sealing — the AI lists what it sees */
  function boxSnapBtn(b) {
    const input = h("input", { type: "file", accept: "image/*", style: "display:none" });
    const btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto" }, "📷✨ Snap contents");
    btn.addEventListener("click", () => { if (aiAvailable()) input.click(); });
    input.addEventListener("change", async () => {
      const f = input.files[0]; input.value = "";
      if (!f) return;
      btn.disabled = true; btn.textContent = "✨ Reading…";
      try {
        const img = await fileToDataURL(f);
        const found = await scanContentsPhoto(project, img, CONTENT_CATEGORIES, CONDITIONS);
        const line = found.map((it) => ((Number(it.qty) || 1) > 1 ? it.qty + "× " : "") + it.name).join("; ");
        b.aiContents = [b.aiContents, line].filter((x) => String(x || "").trim()).join("; ");
        await Store.put(project); paint();
        toast(found.length ? `Listed ${found.length} item(s) in ${b.label}.` : "No items recognized in that photo.");
      } catch (e) {
        toast("Couldn't read the box photo — " + (e && e.message ? e.message : "try again"));
      }
      btn.disabled = false; btn.textContent = "📷✨ Snap contents";
    });
    return h("span", {}, btn, input);
  }

  function addBox() { project.boxes.push(newBox(project.boxes.length + 1)); Store.put(project); paint(); }
  function delBox(b) {
    if (!confirm("Delete " + b.label + "? Items stay in inventory but become unassigned.")) return;
    project.contents.forEach((it) => { if (it.boxId === b.id) it.boxId = ""; });
    project.boxes = project.boxes.filter((x) => x.id !== b.id);
    Store.put(project); paint();
  }
  // printable labels (one card per box)
  const labels = h("div", { class: "print-only boxlabels" });
  function buildLabels() {
    return project.boxes.map((b) => {
      const qr = h("div", { class: "boxlabel__qr" });
      const payload = [
        "ROYBAL RESTORATION", "Box: " + b.label,
        "Job: " + (project.customer || ""), "Claim: " + (project.claimNo || ""),
        "Room: " + (b.room || ""), "Dest: " + (b.destination || ""),
        "Items: " + countItems(b.id),
      ].join("\n");
      qrSvg(payload, 3, 1).then((svg) => { qr.innerHTML = svg; }).catch(() => {});
      return h("div", { class: "boxlabel" },
        h("div", { class: "boxlabel__top" },
          h("div", {},
            h("div", { class: "boxlabel__co" }, "ROYBAL RESTORATION"),
            h("div", { class: "boxlabel__no" }, b.label)),
          qr),
        h("table", { class: "boxlabel__meta" },
          h("tr", {}, h("td", {}, "Customer"), h("td", {}, project.customer || "")),
          h("tr", {}, h("td", {}, "Claim #"), h("td", {}, project.claimNo || "")),
          h("tr", {}, h("td", {}, "Room"), h("td", {}, b.room || "")),
          h("tr", {}, h("td", {}, "Destination"), h("td", {}, b.destination || "")),
          h("tr", {}, h("td", {}, "Packed by"), h("td", {}, (b.packedBy || "") + (b.packedDate ? "  " + fmtDate(b.packedDate) : ""))),
          h("tr", {}, h("td", {}, "Items"), h("td", {}, String(countItems(b.id)))),
          b.aiContents ? h("tr", {}, h("td", {}, "Contents"), h("td", {}, b.aiContents)) : null));
    });
  }

  body.append(listWrap, labels);
  paint();
  if (project.boxes.length) {
    body.append(h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "🏷️ Print box labels")));
  }
}

function contentsReportPage(project) {
  setChrome("Contents PDF", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  setCtx(project, null);
  body.append(
    h("p", { class: "subtle app-only" }, "Contents inventory for the carrier. Tap “Save as PDF,” then share."),
    RENDERERS.contents(project),
    h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Back"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Save as PDF")));
}

/* ---------- CSV export ---------- */
function contentsCSV(project) {
  const boxLabel = (id) => boxLabelOf(project, id);
  const header = ["Item", "Qty", "Category", "Room", "Box", "Condition", "Disposition",
    "Unit RCV", "Ext RCV", "Age (yrs)", "Depr %", "ACV", "Brand", "Model", "Returned", "Notes"];
  const rows = (project.contents || []).map((it) => {
    const d = depreciation(it);
    return csvRow([
      it.name, it.qty, it.category, it.room, boxLabel(it.boxId), it.condition, dispositionLabel(it.disposition),
      Number(it.value) || 0, d.rcv, it.age, Math.round(d.rate * 100), d.acv.toFixed(2),
      it.brand, it.model, it.returned ? "Yes" : "No", it.notes,
    ]);
  });
  return [csvRow(header), ...rows].join("\r\n");
}
function exportContentsCSV(project) {
  if (!project.contents || !project.contents.length) return toast("No items to export");
  const safe = (project.customer || "job").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const ok = downloadFile(`contents-${safe}.csv`, contentsCSV(project), "text/csv;charset=utf-8");
  toast(ok ? "CSV exported" : "Export not supported here");
}

/* ---------- Pack-back checklist + receipt ---------- */
function contentsPackBack(project) {
  setChrome("Pack-back", `#/p/${project.id}/f/contents`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const total = project.contents.length;
  const prog = h("div", { class: "warn app-only" });
  const refresh = () => {
    const r = project.contents.filter((i) => i.returned).length;
    prog.replaceChildren(h("strong", {}, `Returned ${r} of ${total}`),
      total ? `  ·  ${Math.round((r / total) * 100)}% complete` : "");
  };

  const receipt = packBackReceipt(project);
  receipt.addEventListener("change", refresh);   // checkboxes live in the sheet
  body.append(prog, receipt,
    h("div", { class: "sticky-actions app-only" },
      h("button", { class: "btn btn--ghost", onclick: () => go(`#/p/${project.id}/f/contents`) }, "Done"),
      h("button", { class: "btn btn--primary", onclick: () => window.print() }, "⬇ Print receipt")));
  refresh();
}

/* ============================================================
   Project edit — shared job header
   ============================================================ */
function projectEdit(project) {
  setChrome("Edit job", `#/p/${project.id}`);
  const body = clear(view);
  const pill = h("span", { class: "saved-pill" }, "✓ Saved");
  setCtx(project, pill);

  const f = (label, key, opts = {}) => {
    const el = h("input", { type: opts.type || "text", value: project[key] ?? "", placeholder: opts.placeholder || "" });
    el.addEventListener("input", () => { project[key] = el.value; Store.put(project); });
    return h("div", { class: "field" }, h("label", {}, label), el);
  };
  const cat = (key, vals) => {
    const wrap = h("div", { class: "seg" });
    vals.forEach((v) => {
      const b = h("button", { type: "button", class: String(project[key]) === String(v.value) ? "active" : "" }, v.label);
      b.addEventListener("click", () => {
        project[key] = String(project[key]) === String(v.value) ? "" : v.value;
        [...wrap.children].forEach((c) => c.classList.remove("active"));
        if (project[key] !== "") b.classList.add("active");
        Store.put(project);
      });
      wrap.append(b);
    });
    return wrap;
  };

  // Job kind — decides which form set the job home shows. Switching never
  // deletes anything; the other kind's forms are hidden, data stays put.
  const typeSeg = h("div", { class: "seg" });
  [["restoration", "💧 Restoration"], ["construction", "🔨 Construction"]].forEach(([v, label]) => {
    const b = h("button", { type: "button", class: jobType(project) === v ? "active" : "" }, label);
    b.addEventListener("click", () => {
      if (jobType(project) === v) return;
      project.jobType = v;
      Store.put(project);
      projectEdit(project);   // re-render to swap the classification card
    });
    typeSeg.append(b);
  });

  body.append(
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px" },
      h("h1", {}, "Job details"), pill),
    h("p", { class: "subtle" }, "Enter this once — it flows into every form."),
    h("div", { class: "card" },
      h("div", { class: "field" }, h("label", {}, "Job type"), typeSeg)),
    h("div", { class: "card" },
      h("div", { class: "grid2" }, f("Customer / Owner", "customer"), f("Phone", "phone", { type: "tel" })),
      f("Property Address", "address"),
      h("div", { class: "grid2" }, f("Email", "email", { type: "email" }), f("Work Order #", "workOrderNo")),
      h("div", { class: "grid2" }, f("Claim #", "claimNo"), f("Date of Loss", "dateOfLoss", { type: "date" })),
      h("div", { class: "grid2" }, f("Insurance Carrier", "carrier"), f("Adjuster", "adjuster")),
      f("Loss Cause", "lossCause")));

  if (jobType(project) === "construction") {
    body.append(
      h("div", { class: "card" },
        h("h2", { style: "margin-top:0" }, "Construction details"),
        h("div", { class: "field" }, h("label", {}, "Project type"), cat("constructionType", CONSTRUCTION_TYPES)),
        h("div", { class: "grid2" },
          f("Contract amount", "contractAmount", { type: "number", placeholder: "$" }),
          f("Lender (optional — draw schedule)", "lender")),
        h("div", { class: "grid2" },
          f("Start date", "startDate", { type: "date" }),
          f("Target completion", "targetCompletion", { type: "date" })),
        f("Permit numbers", "permitNumbers", { placeholder: "e.g. B26-1042, E26-0311" })));
  } else {
    body.append(
      h("div", { class: "card" },
        h("h2", { style: "margin-top:0" }, "Loss classification"),
        h("div", { class: "field" }, h("label", {}, "Water Category (IICRC S500)"),
          cat("waterCategory", [{ value: "1", label: "Cat 1 — Clean" }, { value: "2", label: "Cat 2 — Gray" }, { value: "3", label: "Cat 3 — Black" }])),
        h("div", { class: "field" }, h("label", {}, "Class of Water"),
          cat("waterClass", [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }])),
        h("div", { class: "field" }, h("label", {}, "Drying System"),
          cat("dryingSystem", [{ value: "Open", label: "Open" }, { value: "Closed", label: "Closed" }, { value: "Hybrid", label: "Hybrid" }]))));
  }

  body.append(
    h("button", { class: "btn btn--primary", style: "margin-top:6px", onclick: () => go(`#/p/${project.id}`) }, "Done — go to forms"),
    h("button", { class: "btn btn--danger", style: "margin-top:10px", onclick: () => deleteProject(project) }, "Delete job"));
}

async function deleteProject(project) {
  if (!confirm("Delete this entire job and all its forms? This cannot be undone.")) return;
  await Store.del(project.id);
  toast("Job deleted");
  go("#/");
}

/* ---------- network status + service worker ---------- */
function updateNet() {
  const s = $("#netStatus");
  if (navigator.onLine) { s.classList.remove("off"); s.title = "Online"; }
  else { s.classList.add("off"); s.title = "Offline — your work is saved on this device"; }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);
updateNet();

if ("serviceWorker" in navigator) {
  // Reload once when an updated service worker takes control — but NEVER
  // out from under someone typing (deploys were yanking open desktop tabs
  // mid-edit). If a text field is focused, defer the reload until the user
  // navigates or leaves the tab.
  let hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  };
  const doReload = () => { if (!reloading) { reloading = true; location.reload(); } };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) {
      if (!typing()) doReload();
      else {
        const safe = () => { if (!typing()) doReload(); };
        window.addEventListener("hashchange", safe, { once: true });
        document.addEventListener("visibilitychange", () => { if (document.hidden) doReload(); }, { once: true });
      }
    }
    hadController = true;
  });
  window.addEventListener("load", () => {
    // updateViaCache:none => browser never serves a cached worker script
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      reg.update?.();                                  // check for a new version on open
      setInterval(() => reg.update?.(), 60 * 60 * 1000); // and hourly while open
    }).catch(() => {});
  });
}
