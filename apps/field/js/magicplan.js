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
     magicplanBidLine / magicplanBanner — the Bid card line and the Site
        Visit panel's 📥 banner

   The server never writes the job (design decision 4): adoptExport() here
   is the only thing that puts a scan into project.siteVisit, and it goes
   through the normal Store.put + sync like any other edit.
   ============================================================ */
import { h, Store, toast, likelyOffline, fmtDate } from "./core.js";
import { SYNC_ENABLED } from "./config.js";
import { callFunction, rest, isSignedIn, currentEmail } from "./supa.js";
import { adoptExport, exportSummary, mpState, splitAddress } from "./magicplancalc.js";

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

/* ---------- create (§6 ruling 8) ---------- */
const creating = new Set();
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
  if (!online() || creating.has(project.id)) return null;
  const role = await callerRole();
  if (role !== "owner" && role !== "office") {
    if (manual) throw new Error("Creating Magicplan projects is office-only");
    return null;
  }
  creating.add(project.id);
  try {
    const r = await mpProxy("createProject", {
      fieldProjectId: project.id,
      customer: project.customer || (tile && tile.customer) || "",
      address: splitAddress(project.address || (tile && tile.address) || ""),
      by: tsv.by || currentEmail(),
    });
    if (!project.siteVisit || typeof project.siteVisit !== "object") project.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
    project.siteVisit.magicplan = {
      ...(project.siteVisit.magicplan || {}),
      projectId: r.projectId, planId: r.planId, cloudUrl: r.cloudUrl, createdAt: r.createdAt || new Date().toISOString(),
      by: tsv.by || currentEmail(), units: null,
    };
    await Store.put(project);
    return project.siteVisit.magicplan;
  } finally {
    creating.delete(project.id);
  }
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
  return rows.length ? { row: rows[0], older: rows.slice(1) } : null;
}

/** Merge one row into the job and stamp it imported (and any older ready
    rows it supersedes). Returns the counts. */
export async function adoptRow(project, pending) {
  const counts = adoptExport(project, pending.row);
  await Store.put(project);
  for (const r of [pending.row, ...arr(pending.older)]) {
    adoptedIds.add(r.id);
    try { await mpProxy("markImported", { exportId: r.id, fieldProjectId: project.id }); } catch (_) { /* re-offered next open; the merge is idempotent */ }
  }
  return counts;
}

/** On the owner's device: adopt now. Elsewhere: return the pending row for
    the banner. → { adopted, pending, counts } */
export async function adoptIfReady(project, { force = false } = {}) {
  const pending = await pendingExport(project);
  if (!pending) return { adopted: false, pending: null };
  if (force || await autoAdopt()) {
    const counts = await adoptRow(project, pending);
    return { adopted: true, pending: null, counts };
  }
  return { adopted: false, pending };
}

/** ⟳ Pull: the server copies the scan in, then this device adopts it (a
    Pull is a tap, so it adopts here whatever the auto setting). */
export async function pullMagicplan(project) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  if (!mp || !mp.projectId) throw new Error("No Magicplan project on this job yet");
  const row = await mpProxy("sync", { projectId: mp.projectId, fieldProjectId: project.id });
  if (row && row.status === "unmatched") throw new Error("That Magicplan project belongs to a different job — link it from ⚙ Settings in the admin.");
  return adoptIfReady(project, { force: true });
}

const adoptedToast = (c) => `Magicplan scan added: ${c.reports} report${c.reports === 1 ? "" : "s"}, ${c.photos} photo${c.photos === 1 ? "" : "s"}` +
  (c.rooms ? `, ${c.rooms} room${c.rooms === 1 ? "" : "s"} measured` + (c.accepted ? "" : " (amber in Floor Plan — check them)") : "") + ".";

/* ============================================================
   UI
   ============================================================ */
const STATE_TEXT = {
  none: "not created",
  ready: "ready on phone",
  received: "scan received",
  imported: "imported",
  updated: "updated since import",
};

/** The 📐 Magicplan line on the Bid card. `line(icon, label, value, btn)` is
    the card's own row builder. The returned element has setTile(d) — the
    card calls it each time it repaints with the board tile. */
export function magicplanBidLine(project, { line, onChanged } = {}) {
  const box = h("div");
  let tile = null, pending = null, userModified = "", checked = false, busy = "";

  const paint = () => {
    const mp = project.siteVisit && project.siteVisit.magicplan;
    const st = mpState(project, { pending: pending && pending.row, userModified });
    const bits = [busy || STATE_TEXT[st.key]];
    if (!busy && mp && mp.projectId) {
      if (st.key === "ready" && mp.createdAt) bits.push("created " + fmtDate(String(mp.createdAt).slice(0, 10)));
      if (pending) bits.push(exportSummary(pending.row));
      else if (mp.importedAt && mp.statistics) bits.push(exportSummaryFromBlob(project));
    }
    let btn = null;
    if (!busy && (!mp || !mp.projectId)) {
      btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", title: "Creates the project on the phone with the customer's name and address" }, "📐 Create Magicplan project");
      btn.addEventListener("click", () => run("Creating…", async () => {
        const r = await ensureMagicplanProject(project, tile, { manual: true });
        toast(r ? "Magicplan project ready — it's on the phone now." : "Couldn't create it right now — check your connection.");
      }));
    } else if (!busy && pending) {
      btn = h("button", { class: "btn btn--primary btn--sm", style: "width:auto" }, "📥 Add to packet");
      btn.addEventListener("click", () => run("Adding…", async () => {
        const c = await adoptRow(project, pending); pending = null; toast(adoptedToast(c), 5000);
      }));
    } else if (!busy) {
      btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", title: "Copy the report, pinned photos and room measurements from Magicplan into this bid" }, "⟳ Pull");
      btn.addEventListener("click", () => run("Pulling from Magicplan…", async () => {
        const r = await pullMagicplan(project);
        userModified = "";
        toast(r.adopted ? adoptedToast(r.counts) : "Nothing new in Magicplan yet — export the report on the phone first.", 5000);
      }));
    }
    box.replaceChildren(line("📐", "Magicplan", bits.filter(Boolean).join(" · "), btn));
  };

  async function run(label, fn) {
    busy = label; paint();
    try { await fn(); } catch (e) { toast(String((e && e.message) || e), 5000); }
    busy = ""; paint();
    if (onChanged) onChanged();
  }

  async function check() {
    if (checked || !online()) return;
    checked = true;
    const role = await callerRole();
    if (role !== "owner" && role !== "office") return;
    try {
      const mp = project.siteVisit && project.siteVisit.magicplan;
      if (!mp || !mp.projectId) {
        const made = await ensureMagicplanProject(project, tile);
        if (made) { toast("Magicplan project created — it's on the phone for the visit."); paint(); }
        return;
      }
      const r = await adoptIfReady(project);
      if (r.adopted) { toast(adoptedToast(r.counts), 5000); if (onChanged) onChanged(); }
      pending = r.pending;
      if (mp.importedAt && !pending) {
        const s = await mpProxy("status", { projectId: mp.projectId });
        userModified = s.userModified || "";
      }
      paint();
    } catch (_) { /* the line stays on what the file knows */ }
  }

  box.setTile = (d) => { tile = d || tile; if (d) check(); paint(); return box; };
  paint();
  return box;
}

function exportSummaryFromBlob(project) {
  const sv = project.siteVisit || {};
  const photos = arr(sv.files).filter((f) => f && f.source === "magicplan" && f.kind === "photos").length;
  const rooms = arr(sv.magicplan && sv.magicplan.statistics && sv.magicplan.statistics.floors).reduce((t, f) => t + arr(f.rooms).length, 0);
  const at = sv.magicplan && sv.magicplan.syncedAt ? fmtDate(String(sv.magicplan.syncedAt).slice(0, 10)) : "";
  return [at ? "scanned " + at : "", `${photos} photo${photos === 1 ? "" : "s"}`, `${rooms} room${rooms === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}

/** The Site Visit panel's 📥 banner. Empty until a ready scan is found for
    this job; on the owner's device it adopts instead of asking. */
export function magicplanBanner(project, { onAdopted } = {}) {
  const box = h("div");
  if (!online()) return box;
  (async () => {
    const role = await callerRole();
    if (role !== "owner" && role !== "office") return;
    let r;
    try { r = await adoptIfReady(project); } catch (_) { return; }
    if (r.adopted) { toast(adoptedToast(r.counts), 5000); if (onAdopted) onAdopted(); return; }
    if (!r.pending) return;
    const add = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto" }, "Add to packet");
    add.addEventListener("click", async () => {
      add.disabled = true;
      try {
        const c = await adoptRow(project, r.pending);
        box.replaceChildren();
        toast(adoptedToast(c), 5000);
        if (onAdopted) onAdopted();
      } catch (e) { add.disabled = false; toast(String((e && e.message) || e), 4000); }
    });
    box.replaceChildren(h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0;padding:8px 10px;border-radius:8px;background:#e7eef7;border:1px solid #9bb5d3;font-size:13px" },
      h("span", { style: "flex:1;min-width:0" }, "📥 ", h("strong", {}, "Magicplan scan ready"), " — " + exportSummary(r.pending.row)), add));
  })();
  return box;
}
