/* ============================================================
   Roybal Field Forms — Magicplan (docs/Magicplan_Integration_Design.md)
   ------------------------------------------------------------
   The browser half. Every Magicplan call goes through the magicplan-proxy
   edge function with this user's session — no Magicplan URL or key is ever
   in the app. The pure half (paths, units, rooms, the adopt merge) lives in
   magicplancalc.js and is Node-tested.

     ensureMagicplanProject(project, tile) — a bid file with a scheduled
        visit and no Magicplan project gets one (owner/office, online, once)
     pullMagicplan(project) — the ⟳ Pull: server copies the scan in, then
        adoptIfReady()
     adoptIfReady(project) — a ready magicplan_exports row for this job:
        adopted at once on the owner's device (per-device setting, default
        on for the owner), offered as a banner everywhere else
     magicplanPanel — the 📐 Magicplan card inside the Floor plan chip (10/2):
        the link, Create, 🔗 Link an existing project, ⟳ Pull and the files
     magicplanAuto — the Bid card's silent half: auto-create at scheduling,
        auto-adopt on the owner's device (no line, no buttons since 10/2)
     magicplanBanner — the Site Visit panel's 📥 banner

   The server never writes the job (design decision 4): adoptExport() here
   is the only thing that puts a scan into project.siteVisit, and it goes
   through the normal Store.put + sync like any other edit.
   ============================================================ */
import { h, Store, toast, likelyOffline, fmtDate } from "./core.js";
import { SYNC_ENABLED } from "./config.js";
import { callFunction, rest, isSignedIn, currentEmail, signSiteFile } from "./supa.js";
import { adoptExport, exportSummary, mpState, splitAddress, adoptEsx, projectName, linkMagicplan, linkedByHand, magicplanOnJob,
  mpMatches, mpKindLabel } from "./magicplancalc.js";
import { jobType } from "./model.js";
import { tombstoneItems } from "./merge.js";

const arr = (v) => (Array.isArray(v) ? v : []);
export const online = () => !!(SYNC_ENABLED && isSignedIn() && !likelyOffline());

/* ---------- transport ---------- */
async function mpProxy(action, payload = {}) {
  if (!SYNC_ENABLED) throw new Error("Magicplan needs the cloud backend");
  if (!isSignedIn()) throw new Error("Sign in first");
  const res = await callFunction("magicplan-proxy", { action, ...payload });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `Magicplan ${action} failed (${res.status})`);
  return body.data;
}
export const mpWorkspace = () => mpProxy("getWorkspace");
export const mpArchive = (projectId) => mpProxy("archiveProject", { projectId });
export const mpLinkExport = (exportId, fieldProjectId) => mpProxy("linkExport", { exportId, fieldProjectId });
/** M3: run the workspace's export configuration and keep its ESX sketch (claims). */
export const mpEsx = (planId, fieldProjectId) => mpProxy("esxExport", { planId, fieldProjectId });
/** The workspace's live projects, newest first: {projects:[{id, name, address,
    createdAt, modifiedAt, externalReferenceId}], complete}. */
export const mpListProjects = (query = "") => mpProxy("listProjects", { query });

/* ---------- who is this? ----------
   Owner/office only (the proxy refuses anyone else anyway — this just keeps
   a crew phone from trying). role_is() is the dual-vocabulary check (0006). */
let rolePromise = null;
async function roleIs(roles) {
  const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: roles }) });
  return res.ok ? (await res.json()) === true : false;
}
export function callerRole() {
  if (!rolePromise) {
    rolePromise = (async () => {
      if (await roleIs(["owner"])) return "owner";
      if (await roleIs(["office"])) return "office";
      return "";
    })().catch(() => { rolePromise = null; return ""; });
  }
  return rolePromise;
}
/* Three-state twin for UI that must fail OPEN: true / false when the server
   answered, null when it couldn't (offline, expired token, 5xx) — a phone on
   bad signal keeps its buttons, and the server action stays the gate. */
let officePromise = null;
export function officeRole() {
  if (!officePromise) {
    officePromise = (async () => {
      const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: ["owner", "office"] }) });
      if (!res.ok) { officePromise = null; return null; }
      return (await res.json()) === true;
    })().catch(() => { officePromise = null; return null; });
  }
  return officePromise;
}

/* Auto-adopt is per device: on by default on the owner's, off elsewhere. */
const AUTO_KEY = "roybal-mp-autoadopt";
export async function autoAdopt() {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch (_) { /* private mode: fall through to the default */ }
  return (await callerRole()) === "owner";
}
export function setAutoAdopt(on) { try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch (_) { /* ignore */ } }

/* ---------- writes that land on another page's copy ----------
   Each page holds its own copy of the job (route() reads a fresh one), so a
   write that finishes after the user moved on — the home's auto-create, an
   ESX sketch — goes onto the STORED copy, and the app grafts it into the
   page now on screen (app.js, the same graft sync uses). Open 📐 cards
   repaint. */
let wroteCb = () => {};
const wroteFns = new Set();
/** app.js: (jobId, theObjectWritten) after such a write. */
export function onMagicplanWrote(fn) { wroteCb = fn || (() => {}); }
function jobWritten(id, wrote, scan) {
  Promise.resolve().then(() => wroteCb(id, wrote)).catch(() => {})
    .then(() => { for (const f of [...wroteFns]) { try { f(id, scan); } catch (_) { /* a repaint is a bonus */ } } });
}
/** Apply `apply` to the job's STORED copy and save that (never an old
    page's copy over a newer save), and to `project` as well so whatever
    holds it stays current. `blocked(p)` true on either copy → no write.
    apply returns false for "nothing changed". → apply's answer on the
    stored copy, or null when nothing was written. */
async function writeJob(project, apply, { blocked = null, scan = false } = {}) {
  const cur = (await Store.get(project.id)) || project;
  if (blocked && (blocked(cur) || blocked(project))) return null;
  const out = apply(cur);
  if (out === false) return null;
  if (cur !== project) apply(project);
  await Store.put(cur);
  jobWritten(project.id, project, scan);
  return out;
}

/* ---------- create (§6 ruling 8) ---------- */
const creating = new Set();
/** A create is in flight for this job on this device: 🔗 Link waits, so the
    two can't both land (one would orphan a duplicate project in Magicplan). */
export const creatingFor = (id) => creating.has(id);
/** A bid file with a scheduled visit (on the tile, or on the file) and no
    Magicplan project gets one. Idempotent on the server (name search +
    external_reference_id). Pass manual:true for the Bid card button, which
    doesn't need a scheduled visit. Returns the link, or null. */
export async function ensureMagicplanProject(project, tile, { manual = false } = {}) {
  const sv = project && project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : null;
  if (!project || (sv && sv.magicplan && sv.magicplan.projectId)) return null;
  const tsv = tile && tile.siteVisit && typeof tile.siteVisit === "object" ? tile.siteVisit : {};
  const visitAt = tsv.at || (sv && sv.at) || "";
  if (!manual && (!project.bidOf || !visitAt)) return null;
  if (!online()) return null;
  if (creating.has(project.id)) {
    if (manual) throw new Error("A Magicplan project is already being made for this job. Give it a moment.");
    return null;
  }
  const role = await callerRole();
  if (role !== "owner" && role !== "office") {
    if (manual) throw new Error("Creating Magicplan projects is office-only");
    return null;
  }
  creating.add(project.id);
  try {
    // This copy may predate a link made on another device (a project linked
    // by hand has no external_reference_id, so the server's own name search
    // can't find it): ask the job's server copy first. Can't tell → no
    // automatic create this pass.
    const onServer = await serverMagicplanId(project.id);
    if (onServer === null && !manual) return null;
    if (onServer) {
      if (manual) throw new Error("Another device already linked a Magicplan project to this job. Let this phone sync, then open the Floor plan again.");
      return null;
    }
    const r = await mpProxy("createProject", {
      fieldProjectId: project.id,
      customer: project.customer || (tile && tile.customer) || "",
      address: splitAddress(project.address || (tile && tile.address) || ""),
      by: tsv.by || currentEmail(),
    });
    const link = { projectId: r.projectId, planId: r.planId, cloudUrl: r.cloudUrl, createdAt: r.createdAt || new Date().toISOString(),
      by: tsv.by || currentEmail(), units: null };
    // onto the stored copy: a link saved meanwhile (the Floor plan on this
    // phone, or a sync) wins over this create
    const wrote = await writeJob(project, (p) => {
      if (!p.siteVisit || typeof p.siteVisit !== "object") p.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
      p.siteVisit.magicplan = { ...(p.siteVisit.magicplan || {}), ...link };
      return true;
    }, { blocked: (p) => !!(p.siteVisit && p.siteVisit.magicplan && p.siteVisit.magicplan.projectId) });
    return wrote ? project.siteVisit.magicplan : null;
  } finally {
    creating.delete(project.id);
  }
}

/** The Magicplan project id on the job's server copy: "" when it has none
    (or the job isn't on the server yet), null when the read failed. */
async function serverMagicplanId(id) {
  try {
    const res = await rest(`field_projects?id=eq.${encodeURIComponent(id)}&select=mp:data->siteVisit->magicplan->>projectId`, { method: "GET" });
    if (!res.ok) return null;
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0] && rows[0].mp) ? String(rows[0].mp) : "";
  } catch (_) { return null; }
}

/* ---------- read the queue ----------
   Rows this device already merged are skipped even if their markImported
   stamp failed — otherwise a failed stamp would re-adopt (and re-render the
   home) on every open. The merge is idempotent, so a later retry is safe. */
const adoptedIds = new Set();
/** The newest ready, not-yet-imported scan for this job (owner/office RLS). */
export async function pendingExport(project) {
  if (!online() || !project) return null;
  const q = `magicplan_exports?field_project_id=eq.${encodeURIComponent(project.id)}&status=eq.ready&imported_at=is.null&order=synced_at.desc&limit=5`;
  const res = await rest(q, { method: "GET" });
  if (!res.ok) return null;
  const rows = (await res.json()).filter((r) => r && !adoptedIds.has(r.id));
  // a job linked by hand takes that project's scans only. A ready row left
  // from the project it was switched away from is never offered or adopted;
  // it rides in `older`, so the adopt stamps it imported with the rest
  const mp = project.siteVisit && project.siteVisit.magicplan;
  const own = linkedByHand(mp) ? rows.filter((r) => !r.mp_project_id || r.mp_project_id === mp.projectId) : rows;
  return own.length ? { row: own[0], older: rows.filter((r) => r !== own[0]) } : null;
}

/** Merge one row into the job and stamp it imported (and any older ready
    rows it supersedes). Returns the counts. */
export async function adoptRow(project, pending, { isLive = null } = {}) {
  // the Bid card and the Floor plan card can both find the same row on one
  // open; the first one in adopts it, the other gets null
  if (adoptedIds.has(pending.row.id)) return null;
  adoptedIds.add(pending.row.id);
  const at = new Date().toISOString();
  let counts = null;
  try {
    if (!isLive || isLive()) {
      // the job on screen: merge into this copy and save it, with no await
      // in between, so a page opened from here on reads the copy with the scan
      counts = adoptExport(project, pending.row, at);
      await Store.put(project);
    } else {
      // the user moved on (a slow Pull, the home's auto-adopt): the stored
      // copy, which the page now on screen read, takes the scan, and that
      // page gets it grafted in
      await writeJob(project, (p) => { const c = adoptExport(p, pending.row, at); if (!counts) counts = c; return !c.skipped; }, { scan: true });
    }
  } catch (e) {
    adoptedIds.delete(pending.row.id);   // not saved: offered again
    throw e;
  }
  for (const r of [pending.row, ...arr(pending.older)]) {
    adoptedIds.add(r.id);
    try { await mpProxy("markImported", { exportId: r.id, fieldProjectId: project.id }); } catch (_) { /* re-offered next open; the merge is idempotent */ }
  }
  counts.esx = await esxAfterAdopt(project);
  return counts;
}

/* M3 §5.5: on a claim, ask the proxy for the ESX sketch the workspace's
   export configuration produces. Built and idle until that configuration
   includes ESX — no toast, no error either way; a failure here never
   touches the adopt that just succeeded. Returns 1 when a sketch was added
   or replaced in Supporting Docs. */
async function esxAfterAdopt(project) {
  try {
    if (!project || jobType(project) === "construction") return 0;
    const mp = project.siteVisit && project.siteVisit.magicplan;
    if (!mp || !mp.planId) return 0;
    const r = await mpEsx(mp.planId, project.id);
    if (!r || !r.available || !r.esx) return 0;
    // the export can take a while: the sketch goes onto the stored copy (and
    // into this page's), never this copy saved over an edit made meanwhile
    const at = new Date().toISOString();
    const c = await writeJob(project, (p) => { const x = adoptEsx(p, r.esx, at); return x.added || x.updated ? x : false; });
    return c ? c.added + c.updated : 0;
  } catch (_) { return 0; }
}

/** On the owner's device: adopt now. Elsewhere: return the pending row for
    the banner. → { adopted, pending, counts } */
export async function adoptIfReady(project, { force = false, isLive = null } = {}) {
  const pending = await pendingExport(project);
  if (!pending) return { adopted: false, pending: null };
  if (force || await autoAdopt()) {
    const counts = await adoptRow(project, pending, { isLive });
    return counts ? { adopted: true, pending: null, counts } : { adopted: false, pending: null };
  }
  return { adopted: false, pending };
}

/** ⟳ Pull: the server copies the scan in, then this device adopts it (a
    Pull is a tap, so it adopts here whatever the auto setting). */
export async function pullMagicplan(project, { isLive = null } = {}) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  if (!mp || !mp.projectId) throw new Error("No Magicplan project on this job yet");
  // a project the office linked by hand may carry no job id (scanned before
  // the job existed) or another job's: `linked` tells the server it's meant
  const row = await mpProxy("sync", { projectId: mp.projectId, fieldProjectId: project.id, ...(linkedByHand(mp) ? { linked: true } : {}) });
  if (row && row.status === "unmatched") throw new Error("Magicplan has that project on a different job. In this Floor plan tap 🔗 Link a different project and pick this job's scan (the same one is fine).");
  return adoptIfReady(project, { force: true, isLive });
}

/** 🔗 Link: read the picked project (plan id, archived?) and keep the link on
    the job. Nothing is written to Magicplan. → { switching, dropped, picked } */
export async function linkMagicplanProject(project, projectId, { isLive = null } = {}) {
  const picked = await mpProxy("linkProject", { projectId });
  const opts = { by: currentEmail(), at: new Date().toISOString(), tombstone: tombstoneItems };
  let out;
  if (!isLive || isLive()) {
    out = linkMagicplan(project, picked, opts);
    await Store.put(project);
  } else {
    // left the Floor plan while Magicplan answered: onto the stored copy
    await writeJob(project, (p) => { const o = linkMagicplan(p, picked, opts); if (!out) out = o; return true; }, { scan: true });
  }
  if (out.switching) await supersedeOthers(project);
  return { ...out, picked };
}

/* A switch is final for the old project's scans still waiting on this job:
   stamped imported now, so a phone whose copy missed the switch can never
   find one, adopt it and (its copy then being newer) undo the switch. */
async function supersedeOthers(project) {
  try {
    const pid = project.siteVisit.magicplan.projectId;
    const res = await rest(`magicplan_exports?field_project_id=eq.${encodeURIComponent(project.id)}&mp_project_id=neq.${encodeURIComponent(pid)}` +
      "&status=eq.ready&imported_at=is.null&select=id", { method: "GET" });
    if (!res.ok) return;
    for (const r of arr(await res.json())) {
      if (!r || !r.id) continue;
      adoptedIds.add(r.id);
      try { await mpProxy("markImported", { exportId: r.id, fieldProjectId: project.id }); } catch (_) { /* the hand link still refuses it */ }
    }
  } catch (_) { /* best effort: pendingExport and adoptExport refuse those rows on this device anyway */ }
}

const adoptedToast = (c) => `Magicplan scan added: ${c.reports} report${c.reports === 1 ? "" : "s"}, ${c.photos} photo${c.photos === 1 ? "" : "s"}` +
  (c.rooms ? `, ${c.rooms} room${c.rooms === 1 ? "" : "s"} measured` + (c.accepted ? "" : " (amber in Floor Plan — check them)") : "") +
  (c.others ? `, ${c.others} more file${c.others === 1 ? "" : "s"} under 📐 Magicplan files` : "") +
  (c.esx ? ", ESX sketch in Supporting Docs" : "") + ".";

/* ============================================================
   UI
   ============================================================ */
/** The Bid card's silent half. When the board tile loads, a bid file with a
    scheduled visit gets its Magicplan project (§6 ruling 8), and a ready
    scan is adopted on the owner's device. The visible controls moved to the
    Floor plan chip on 10/2 (Branden: Magicplan in one place). */
export function magicplanAuto(project, { onChanged, isLive = null } = {}) {
  let checked = false;
  const setTile = (tile) => {
    if (!tile || checked || !online()) return;
    checked = true;
    (async () => {
      const role = await callerRole();
      if (role !== "owner" && role !== "office") return;
      try {
        const mp = project.siteVisit && project.siteVisit.magicplan;
        if (!mp || !mp.projectId) {
          const made = await ensureMagicplanProject(project, tile);
          if (made) toast("Magicplan project created — it's on the phone for the visit.");
          return;
        }
        const r = await adoptIfReady(project, { isLive });
        if (r.adopted && !r.counts.skipped) { toast(adoptedToast(r.counts), 5000); if (onChanged) onChanged(); }
      } catch (_) { /* the Floor plan chip shows the state when it's opened */ }
    })();
  };
  return { setTile };
}

/** "3 files, 2 photos, 1 room measured" — what the last pull left on the job. */
function pulledSummary(project) {
  const sv = project.siteVisit || {};
  const mine = arr(sv.files).filter((f) => f && f.source === "magicplan");
  const photos = mine.filter((f) => f.kind === "photos").length, files = mine.length - photos;
  const rooms = arr(sv.magicplan && sv.magicplan.statistics && sv.magicplan.statistics.floors).reduce((t, f) => t + arr(f.rooms).length, 0);
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  return [n(files, "file", "files"), n(photos, "photo", "photos"), n(rooms, "room measured", "rooms measured")].join(", ");
}

const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const newestFirst = (a, b) => (Date.parse(b.modifiedAt || b.createdAt) || 0) - (Date.parse(a.modifiedAt || a.createdAt) || 0);
const PICK_ROWS = 40;

/* ============================================================
   📐 Magicplan inside the Floor plan chip (10/2)
   ------------------------------------------------------------
   One place for Magicplan on a job: which project it's linked to, Create,
   🔗 Link an existing project (a scan started in the Magicplan app before
   the job existed here), ⟳ Pull, and the files the pull brought in. The
   files stay in the estimate's Site Visit panel too — that is what the
   draft reads; "📋 Open in Site Visit" goes there.
   Owner/office only for Create, Link and Pull (the proxy enforces it; a
   crew phone sees the state and the files).
   ============================================================ */
export function magicplanPanel(project, { onChanged, openSiteVisit } = {}) {
  const root = h("div", { class: "card app-only", style: "border-left:4px solid #1e4a72;margin:0 0 12px" });
  // owed: a scan landed while the picker was open or an action ran; the
  // form's re-render (onChanged) waits until the picker closes
  let pending = null, userModified = "", busy = "", office = null, pick = null, owed = false;
  // still the page on screen? (the hash moves the moment the user taps away,
  // before the next page reads its copy of the job)
  const hashAtOpen = location.hash;
  const isLive = () => root.isConnected && location.hash === hashAtOpen;
  const svOf = () => (project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : {});
  const mpOf = () => { const m = svOf().magicplan; return m && typeof m === "object" && m.projectId ? m : null; };
  const btn = (label, cls, title, onclick) => h("button", { type: "button", class: `btn ${cls} btn--sm`, style: "width:auto", title, onclick }, label);

  const linkedName = (mp) => mp.name || projectName(project.customer, splitAddress(project.address || "").street);

  function stateLine(mp, st) {
    if (busy) return busy;
    if (!mp) return pending ? "A Magicplan scan is waiting for this job: " + exportSummary(pending.row) + "."
      : "Not linked yet. Create the project before the visit, or link the one you already scanned.";
    const name = h("strong", {}, linkedName(mp));
    // full timestamps: fmtDate shows the phone's own day (an evening in Alaska is not tomorrow)
    const when = mp.linked === mp.projectId && mp.linkedAt ? "linked " + fmtDate(String(mp.linkedAt))
      : mp.createdAt ? "created " + fmtDate(String(mp.createdAt)) : "";
    const tail = st.key === "received" ? " A scan is ready: " + exportSummary(pending.row) + "."
      : st.key === "updated" ? " Changed in Magicplan since the last pull — ⟳ Pull to bring it in."
      : st.key === "imported" ? ` Pulled ${fmtDate(String(mp.importedAt))}: ${pulledSummary(project)}.`
      : " Scan it, export in the Magicplan app, then ⟳ Pull.";
    return h("span", {}, "Linked to ", name, when ? ` (${when}).` : ".", tail);
  }

  function buttons(mp, st) {
    if (busy) return [];
    if (!online()) return [h("span", { class: "subtle", style: "font-size:12px" }, "Create, Link and Pull need signal.")];
    if (office === false) return [h("span", { class: "subtle", style: "font-size:12px" }, "Create, Link and Pull are for the owner and the office.")];
    const out = [];
    if (pending) out.push(btn("📥 Add to packet", "btn--primary", "Bring this scan into the job", () => run("Adding…", async () => {
      const c = await adoptRow(project, pending, { isLive }); pending = null; if (c && !c.skipped) toast(adoptedToast(c), 5000);
    })));
    if (!mp) {
      if (!pending) out.push(btn("📐 Create Magicplan project", "btn--ghost", "Creates the project on the phone with the customer's name and address", () => run("Creating…", async () => {
        const r = await ensureMagicplanProject(project, null, { manual: true });
        toast(r ? "Magicplan project ready — it's on the phone now." : "Couldn't create it right now — check your connection.");
      })));
      out.push(btn("🔗 Link existing project", pending ? "btn--ghost" : "btn--primary", "For a scan you started in the Magicplan app before this job existed", openPicker));
      return out;
    }
    if (!pending) out.push(btn("⟳ Pull", st.key === "updated" ? "btn--primary" : "btn--ghost",
      "Copy everything in the Magicplan project into this job: report, photos, 3D model, drawings, room measurements", () => run("Pulling from Magicplan…", async () => {
        const r = await pullMagicplan(project, { isLive });
        userModified = "";
        toast(r.adopted ? adoptedToast(r.counts) : "Nothing new in Magicplan yet — export the scan in the Magicplan app first.", 5000);
      })));
    out.push(btn("🔗 Link a different project", "btn--ghost", "Pick another Magicplan project for this job", openPicker));
    return out;
  }

  function fileRow(f) {
    const open = f.path ? btn("⤓", "btn--ghost", "Open this file", async () => {
      // a short-lived signed link: a .usdz opens in the iPhone's 3D viewer
      const w = window.open("", "_blank");
      try { const url = await signSiteFile(f.path); if (w) w.location.href = url; else location.href = url; }
      catch (e) { if (w) w.close(); toast(e && e.message ? e.message.replace(/clip/g, "file") : "Couldn't open the file", 4000); }
    }) : null;
    const kind = f.kind === "report" ? "report" : mpKindLabel(f.mpKind);
    return h("div", { style: "display:flex;gap:8px;align-items:center;font-size:12px;margin-top:4px" },
      h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, f.name || "file",
        h("span", { class: "subtle" }, ` · ${kind}${f.room ? " · " + f.room : ""}`)),
      h("span", { class: "subtle" }, fmtSize(f.size || 0)), open);
  }

  function filesBox() {
    const files = arr(svOf().files).filter((f) => f && f.source === "magicplan");
    const docs = files.filter((f) => f.kind === "report" || f.kind === "mpfiles");
    const photos = files.filter((f) => f.kind === "photos").length;
    const toSv = openSiteVisit ? btn("📋 Open in Site Visit", "btn--ghost", "The estimate's Site Visit panel: what the estimate draft reads", openSiteVisit) : null;
    if (!files.length) return toSv && mpOf() ? h("div", { style: "margin-top:8px" }, toSv) : null;
    const n = (x, one) => `${x} ${one}${x === 1 ? "" : "s"}`;
    return h("details", { style: "margin-top:8px" },
      h("summary", { style: "cursor:pointer;font-size:13px;font-weight:600;color:#16395a" },
        "📁 Files from Magicplan (" + [docs.length ? n(docs.length, "file") : "", photos ? n(photos, "photo") : ""].filter(Boolean).join(", ") + ")"),
      ...docs.map(fileRow),
      photos ? h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" },
        photos === 1 ? "The photo sits in the Site Visit packet with its room caption." : `The ${photos} photos sit in the Site Visit packet with their room captions.`) : null,
      toSv ? h("div", { style: "margin-top:8px" }, toSv) : null);
  }

  /* ---- 🔗 the picker: built once per opening so typing keeps focus ---- */
  function openPicker() {
    const me = { items: null, complete: true, error: "", seq: 0, timer: null };
    const input = h("input", { type: "search", placeholder: "Search by customer or street", autocomplete: "off", style: "flex:1;min-width:0;font-size:14px" });
    const list = h("div");
    me.paintList = () => {
      if (pick !== me) return;
      if (!me.items) { list.replaceChildren(h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" }, me.error || "Loading your Magicplan projects…")); return; }
      const hits = me.items.filter((it) => mpMatches(it, input.value));
      const mp = mpOf();
      list.replaceChildren(
        ...hits.slice(0, PICK_ROWS).map((it) => {
          const tag = it.externalReferenceId === project.id ? "this job" : it.externalReferenceId ? "on another job file" : "";
          const row = h("button", { type: "button", style: "display:block;width:100%;text-align:left;padding:8px 10px;margin-top:6px;border:1px solid #d5dde8;border-radius:8px;background:#fff;color:inherit;font:inherit" },
            h("div", { style: "font-weight:700;font-size:13px" }, (it.name || "(no name)") + (mp && mp.projectId === it.id ? " ✓" : "")),
            h("div", { class: "subtle", style: "font-size:12px" },
              [it.address, it.createdAt ? "created " + fmtDate(String(it.createdAt)) : "", tag].filter(Boolean).join(" · ")));
          row.addEventListener("click", () => choose(it));
          return row;
        }),
        h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" },
          !hits.length ? (input.value.trim() ? "No project matches." : "No projects in Magicplan yet.")
            : hits.length > PICK_ROWS ? `Showing ${PICK_ROWS} of ${hits.length}. Type to narrow it.` : "",
          me.complete ? "" : " Older projects may not be listed: type three letters of the name and Magicplan is searched too."));
    };
    const load = async (q) => {
      const seq = ++me.seq;
      try {
        const r = await mpListProjects(q);
        if (pick !== me) return;
        const byId = new Map(arr(me.items).map((it) => [it.id, it]));
        for (const it of arr(r && r.projects)) if (it && it.id) byId.set(it.id, it);
        me.items = [...byId.values()].sort(newestFirst);
        if (!q) {
          me.complete = !!(r && r.complete);
          // typed while the first list was still loading: search for it now
          const cur = input.value.trim();
          if (!me.complete && cur.length >= 3) { clearTimeout(me.timer); me.timer = setTimeout(() => load(cur), 0); }
        }
      } catch (e) {
        if (pick !== me) return;
        if (!me.items) me.error = "Couldn't load your Magicplan projects: " + String((e && e.message) || e);
        else if (seq === me.seq) toast("Magicplan search failed: " + String((e && e.message) || e), 4000);
      }
      me.paintList();
    };
    input.addEventListener("input", () => {
      me.paintList();
      clearTimeout(me.timer);
      const q = input.value.trim();
      if (!me.complete && q.length >= 3) me.timer = setTimeout(() => load(q), 600);
    });
    me.el = h("div", { style: "margin-top:10px;padding:10px;border:1px solid #b9c4d4;border-radius:10px;background:#f7f9fc" },
      h("div", { style: "font-weight:700;font-size:13px;color:#16395a" }, "🔗 Pick this job's Magicplan project"),
      h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 6px" }, "Your Magicplan projects, newest first. Archived ones aren't listed."),
      h("div", { style: "display:flex;gap:8px;align-items:center" }, input,
        btn("Cancel", "btn--ghost", "", () => { pick = null; if (owed && onChanged) { owed = false; onChanged(); } else paint(); })),
      list);
    pick = me;
    paint();
    me.paintList();
    setTimeout(() => { try { input.focus(); } catch (_) { /* ignore */ } }, 0);
    load("");
  }

  async function choose(it) {
    if (busy) return;
    if (creatingFor(project.id)) { toast("A Magicplan project is being made for this job right now. Try Link again in a moment.", 5000); return; }
    const mp = mpOf();
    const name = it.name || "this project";
    // the same project again is how a job adopted through the admin's Link to
    // job (no `linked` stamp) gets marked as picked by hand, so Pull works
    if (mp && mp.projectId === it.id && linkedByHand(mp)) { toast("That project is already linked to this job."); pick = null; paint(); return; }
    let msg = `Link “${name}” to this job and pull it in?`;
    if (it.externalReferenceId && it.externalReferenceId !== project.id) {
      let other = null;
      try { other = await Store.get(it.externalReferenceId); } catch (_) { /* not on this phone */ }
      msg = `Magicplan has “${name}” on another job file${other && other.customer ? ` (${other.customer})` : ""}. Link it to this job too and pull it in?`;
    }
    if (mp && mp.projectId !== it.id) {
      const had = magicplanOnJob(project);
      const bits = [had.files ? `${had.files} file${had.files === 1 ? "" : "s"} in the packet` : "",
        had.rooms ? `${had.rooms} measured room${had.rooms === 1 ? "" : "s"} in the Floor Plan table` : "",
        had.esx ? "the ESX sketch in Supporting Docs" : ""].filter(Boolean);
      msg += `\n\nThis replaces “${linkedName(mp)}” on this job` +
        (bits.length ? `, and what it brought in comes out: ${bits.join(", ")}. The copies stay in storage.` : ".") +
        " The old project stays in Magicplan.";
    }
    if (!window.confirm(msg) || busy || creatingFor(project.id)) return;
    pick = null;
    await run("Linking…", async () => {
      await linkMagicplanProject(project, it.id, { isLive });
      pending = null; userModified = "";   // whatever waited was the old link's
      busy = "Linked. Pulling from Magicplan…"; paint();
      let r;
      try { r = await pullMagicplan(project, { isLive }); }
      catch (e) { toast("Linked, but the pull didn't finish: " + String((e && e.message) || e) + " Tap ⟳ Pull to try again.", 6000); return; }
      userModified = "";
      toast(r.adopted ? "Linked. " + adoptedToast(r.counts) : "Linked. Nothing to pull yet — export the scan in the Magicplan app, then ⟳ Pull.", 6000);
    });
  }

  async function run(label, fn) {
    if (busy) return;
    busy = label; pick = null; paint();
    try { await fn(); } catch (e) { toast(String((e && e.message) || e), 5000); }
    busy = ""; paint();
    owed = false;
    if (onChanged) onChanged();
  }

  // fixed slots: a repaint (check() landing, a busy label) refills the top and
  // the files but never detaches an open picker, so typing keeps its focus
  const topSlot = h("div"), pickSlot = h("div"), filesSlot = h("div");
  root.append(topSlot, pickSlot, filesSlot);
  function paint() {
    const mp = mpOf();
    const st = mpState(project, { pending: pending && pending.row, userModified });
    topSlot.replaceChildren(
      h("div", { style: "font-weight:800;letter-spacing:.3px;color:#16395a" }, "📐 MAGICPLAN"),
      h("div", { style: "font-size:13px;margin-top:4px" }, stateLine(mp, st)),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px" }, ...buttons(mp, st)));
    if (!pick) pickSlot.replaceChildren();
    else if (pickSlot.firstChild !== pick.el) pickSlot.replaceChildren(pick.el);
    const files = filesBox();
    // keep an expanded files list expanded across repaints
    const wasOpen = !!(filesSlot.firstChild && filesSlot.firstChild.open);
    if (files && wasOpen && files.tagName === "DETAILS") files.open = true;
    filesSlot.replaceChildren(...(files ? [files] : []));
  }

  async function check() {
    if (!online()) return;
    office = await officeRole();
    if (office === false) { paint(); return; }
    try {
      const r = await adoptIfReady(project, { isLive });
      if (r.adopted && !r.counts.skipped) {
        toast(adoptedToast(r.counts), 5000);
        // the form re-renders to show the measured rows, but never under an
        // open picker (it would lose the search) or a running action
        if (onChanged && !pick && !busy) { onChanged(); return; }
        owed = true;
      }
      pending = r.pending;
      const mp = mpOf();
      if (mp && mp.importedAt && !pending) {
        const s = await mpProxy("status", { projectId: mp.projectId });
        userModified = (s && s.userModified) || "";
      }
    } catch (_) { /* the card stays on what the job knows */ }
    if (!busy) paint();
  }

  // a write made on another page's copy of this job (the home's auto-create
  // or auto-adopt) was grafted in: show it; a scan re-renders the form so the
  // table is bound to the new rows (not under an open picker)
  const onWrote = (id, scan) => {
    if (!root.isConnected) { wroteFns.delete(onWrote); return; }
    if (id !== project.id || busy) return;
    if (scan && onChanged && !pick) { onChanged(); return; }
    if (scan) owed = true;
    paint();
  };
  wroteFns.add(onWrote);

  paint();
  check();
  return root;
}

/** The Site Visit panel's 📥 banner. Empty until a ready scan is found for
    this job; on the owner's device it adopts instead of asking. */
export function magicplanBanner(project, { onAdopted } = {}) {
  const box = h("div");
  if (!online()) return box;
  const hashAtOpen = location.hash;
  const isLive = () => box.isConnected && location.hash === hashAtOpen;
  (async () => {
    const role = await callerRole();
    if (role !== "owner" && role !== "office") return;
    let r;
    try { r = await adoptIfReady(project, { isLive }); } catch (_) { return; }
    if (r.adopted) { if (!r.counts.skipped) toast(adoptedToast(r.counts), 5000); if (onAdopted) onAdopted(); return; }
    if (!r.pending) return;
    const add = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto" }, "Add to packet");
    add.addEventListener("click", async () => {
      add.disabled = true;
      try {
        const c = await adoptRow(project, r.pending, { isLive });
        box.replaceChildren();
        if (c && !c.skipped) toast(adoptedToast(c), 5000);
        if (onAdopted) onAdopted();
      } catch (e) { add.disabled = false; toast(String((e && e.message) || e), 4000); }
    });
    box.replaceChildren(h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0;padding:8px 10px;border-radius:8px;background:#e7eef7;border:1px solid #9bb5d3;font-size:13px" },
      h("span", { style: "flex:1;min-width:0" }, "📥 ", h("strong", {}, "Magicplan scan ready"), " — " + exportSummary(r.pending.row)), add));
  })();
  return box;
}
