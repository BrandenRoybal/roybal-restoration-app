/* ============================================================
   Roybal Field Forms — Magicplan: the browser half
   ------------------------------------------------------------
   Magicplan is the capture device, not the system of record
   (docs/Magicplan_Integration_Design.md §2). This module is everything the
   scan lane does IN the browser:

     1. the thin wrappers over the `magicplan-proxy` edge function (the
        qbo.js idiom) — the company key never comes near this file; the
        proxy holds it and is office-gated, so every call here rides the
        signed-in user's JWT and is refused for crew;
     2. who is calling (roleFlags — the field app had no role concept, so
        the SQL role_is() RPC answers, cached per session and FAIL-CLOSED:
        no answer means no buttons, no auto-create, no auto-adopt);
     3. the writes onto the bid file: create the project when the office
        schedules the visit (ensureMagicplanProject), and adopt a sync row
        into the packet (adoptIfReady / pullMagicplan). Both go through
        Store.put and nothing else — the server writes magicplan_exports
        rows and field-media objects, never field_projects (the Aug-6
        clobber lesson; design decision 4);
     4. the two UI pieces bid.js and sitevisit.js mount: the Bid card's
        📐 Magicplan line and the Site Visit panel's scan banner + the
        per-device auto-adopt checkbox.

   The decisions (ids, paths, state words, what "nothing new" means) live
   in magicplancalc.js so Node can test them; this file only fetches,
   paints and toasts. The Magicplan API host name must never appear under
   apps/ (only the proxy talks to it) — the fence grep in PLAN §4.4 checks.
   ============================================================ */
import { h, Store, toast, likelyOffline } from "./core.js";
import { callFunction, isSignedIn, rest, currentEmail } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";
import {
  ensureSiteVisit, splitAddress, adoptExport, nothingNew, noteRemoved, pendingRows, autoAdoptEnabled,
  hasPendingUpdate, bidMagicplanState, bidMagicplanText, exportSummary, pendingQuery, recentExportsQuery,
} from "./magicplancalc.js";

const msg = (e) => (e && e.message) || String(e);
const online = () => SYNC_ENABLED && isSignedIn() && !likelyOffline();

/* ---------- the proxy (qbo.js idiom) ---------- */
async function proxy(action, payload = {}) {
  if (!SYNC_ENABLED) throw new Error("Offline — Magicplan needs a connection");
  if (!isSignedIn()) throw new Error("Sign in first");
  const res = await callFunction("magicplan-proxy", { action, ...payload });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `Magicplan ${action} failed (${res.status})`);
  return body.data;
}
export const mpGetWorkspace = () => proxy("getWorkspace");
export const mpCreateProject = (p) => proxy("createProject", p);
export const mpStatus = (projectId) => proxy("status", { projectId });
export const mpSync = (projectId, fieldProjectId) => proxy("sync", { projectId, fieldProjectId });
export const mpMarkImported = (exportId, fieldProjectId) => proxy("markImported", { exportId, fieldProjectId });
export const mpArchiveProject = (projectId) => proxy("archiveProject", { projectId });
export const mpLinkExport = (exportId, fieldProjectId) => proxy("linkExport", { exportId, fieldProjectId });

/* ---------- who is calling ----------
   { owner, office } from the role_is() RPC, cached in sessionStorage for
   30 min keyed by the signed-in email (a sign-out / sign-in as someone else
   never inherits the flags). ANY failure — offline, not signed in, a 4xx,
   a parse error — is { owner:false, office:false }: the line still paints
   from the blob, but nothing is created or adopted on this device. */
const ROLES_KEY = "roybal-mp-roles";
const ROLES_TTL = 30 * 60 * 1000;
const CLOSED = () => ({ owner: false, office: false });
let rolesInflight = null;
export async function roleFlags() {
  const email = String(currentEmail() || "").toLowerCase();
  try {
    const c = JSON.parse(sessionStorage.getItem(ROLES_KEY) || "null");
    if (c && c.email === email && Date.now() - Number(c.at) < ROLES_TTL) return { owner: !!c.owner, office: !!c.office };
  } catch (_) { /* no cache */ }
  if (!online()) return CLOSED();
  if (rolesInflight) return rolesInflight;
  rolesInflight = (async () => {
    try {
      const ask = async (roles) => {
        const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: roles }) });
        if (!res.ok) throw new Error("role_is " + res.status);
        return (await res.json()) === true;
      };
      const owner = await ask(["owner"]);
      const office = owner || await ask(["owner", "office"]);
      const flags = { owner, office };
      try { sessionStorage.setItem(ROLES_KEY, JSON.stringify({ email, ...flags, at: Date.now() })); } catch (_) { /* per-tab convenience only */ }
      return flags;
    } catch (_) {
      return CLOSED();
    } finally {
      rolesInflight = null;
    }
  })();
  return rolesInflight;
}

/* ---------- per-device auto-adopt ---------- */
const AUTO_KEY = "roybal-mp-autoadopt";
export function autoAdoptOn(flags) {
  let stored = null;
  try { stored = localStorage.getItem(AUTO_KEY); } catch (_) { stored = null; }
  return autoAdoptEnabled(stored, !!(flags && flags.owner));
}
export function setAutoAdopt(on) {
  try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch (_) { /* the default (owner's device) rules */ }
}

/* ---------- the RLS-gated reads ---------- */
const pendingCache = new Map();   // project.id → { at, rows }; 15 s — two paints of the same card share one read
const PENDING_TTL = 15000;
export async function fetchPendingExport(project) {
  if (!project || !project.id || !online()) return [];
  const c = pendingCache.get(project.id);
  if (c && Date.now() - c.at < PENDING_TTL) return c.rows;
  let rows = [];
  try {
    const res = await rest(pendingQuery(project.id), { method: "GET" });
    rows = res.ok ? await res.json() : [];
  } catch (_) { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  pendingCache.set(project.id, { at: Date.now(), rows });
  return rows;
}
export async function fetchRecentExports(limit = 10) {
  if (!online()) return [];
  try {
    const res = await rest(recentExportsQuery(limit), { method: "GET" });
    const rows = res.ok ? await res.json() : [];
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

/* ---------- create the project (idempotent on the server too) ----------
   Fires from the Bid card when the office has scheduled the visit
   (tile.siteVisit.at) and from the 📐 Create button (manual). The proxy
   looks the job up by external_reference_id first, so two devices opening
   the same bid file link ONE project. */
const createInflight = new Set();
export async function ensureMagicplanProject(project, tile, { manual = false } = {}) {
  if (!project || !project.bidOf) return { created: false, reason: "not-bid" };
  const cur = project.siteVisit && project.siteVisit.magicplan;
  if (cur && cur.projectId) return { created: false, reason: "exists" };
  if (!online()) return { created: false, reason: "offline" };
  if (!(await roleFlags()).office) return { created: false, reason: "role" };
  if (!manual && !(tile && tile.siteVisit && typeof tile.siteVisit === "object" && tile.siteVisit.at)) return { created: false, reason: "unscheduled" };
  if (tile && (tile.outcome || tile.archived)) return { created: false, reason: "lost" };
  if (createInflight.has(project.id)) return { created: false, reason: "busy" };
  createInflight.add(project.id);
  try {
    const payload = {
      fieldProjectId: project.id,
      customer: String(project.customer || (tile && (tile.customer || tile.title)) || "").slice(0, 160),
      address: splitAddress(project.address || (tile && tile.address) || ""),
      by: currentEmail(),
    };
    const data = await mpCreateProject(payload);
    const sv = ensureSiteVisit(project);
    sv.magicplan = { projectId: data.projectId, planId: data.planId, cloudUrl: data.cloudUrl, createdAt: data.createdAt, by: currentEmail(), units: null, removed: [] };
    await Store.put(project);
    return { created: true, existed: !!data.existed, name: data.name || "" };
  } finally {
    createInflight.delete(project.id);
  }
}

/* ---------- adopt a waiting row into the packet ----------
   rows: the pending rows if the caller already has them. force: the person
   tapped Add to packet / ⟳ Pull, so the auto-adopt switch is not consulted.
   An export with nothing in it (Pull before the in-app export) is stamped
   imported at once and reported `empty` — never offered as a banner. */
const adoptInflight = new Set();
export async function adoptIfReady(project, { rows, force = false } = {}) {
  const list = pendingRows(rows ?? await fetchPendingExport(project), project);
  if (!list.length) return { adopted: false, pending: null };
  const top = list[0];
  const sum = exportSummary(top);
  if (!sum.reports && !sum.photos && !sum.rooms) {
    try { await mpMarkImported(top.id, project.id); } catch (_) { /* offered again next open; still never a banner */ }
    pendingCache.delete(project.id);
    return { adopted: false, pending: null, empty: true };
  }
  if (!force && !autoAdoptOn(await roleFlags())) return { adopted: false, pending: top };
  if (adoptInflight.has(project.id)) return { adopted: false, pending: top, busy: true };
  adoptInflight.add(project.id);
  try {
    const r = adoptExport(project, top, { now: new Date().toISOString(), by: currentEmail() });
    await Store.put(project);
    pendingCache.delete(project.id);
    let stamped = true;
    for (const row of list) {
      try { await mpMarkImported(row.id, project.id); } catch (_) { stamped = false; }
    }
    return { adopted: true, row: top, stamped, ...r };
  } finally {
    adoptInflight.delete(project.id);
  }
}

/* ---------- ⟳ Pull: sync on the server, then adopt ---------- */
export async function pullMagicplan(project) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  if (!mp || !mp.projectId) throw new Error("Create the Magicplan project first");
  const row = await mpSync(mp.projectId, project.id);
  pendingCache.delete(project.id);
  statusCache.delete(project.id);
  if (row && row.status === "unmatched") return { unmatched: true, row };
  return adoptIfReady(project, { force: false });
}

/* ---------- has the plan changed since the last adopt? ---------- */
const statusCache = new Map();   // project.id → { at, status }; 5 min
const STATUS_TTL = 5 * 60 * 1000;
export async function checkUpdated(project) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  if (!mp || !mp.projectId || !online()) return { updated: false, status: null };
  const c = statusCache.get(project.id);
  if (c && Date.now() - c.at < STATUS_TTL) return { updated: hasPendingUpdate(mp, c.status), status: c.status };
  try {
    const status = await mpStatus(mp.projectId);
    statusCache.set(project.id, { at: Date.now(), status });
    return { updated: hasPendingUpdate(mp, status), status };
  } catch (_) { return { updated: false, status: null }; }
}

/* the one sentence a Pull / adopt ends with (PLAN §2.11) */
function pullToast(r) {
  if (r.unmatched) return "That Magicplan project is linked to a different job. Link it from Admin ⚙ Settings › Magicplan.";
  if (r.adopted) {
    let t = nothingNew(r) ? "Nothing new from Magicplan — the packet already has this scan." : `📥 Added from Magicplan: ${r.summary.text}.`;
    if (!r.stamped) t += " Couldn't mark it imported on the server — it may be offered again.";
    return t;
  }
  if (r.pending) return "Magicplan scan ready — open the packet and tap Add to packet.";
  return "Magicplan has nothing for this project yet — scan and export the report in the app first.";
}
const OFFLINE_TOAST = "Offline — try again when you're back online.";
const createToast = (r) => (r.existed ? `📐 Linked the existing Magicplan project: ${r.name}` : `📐 Magicplan project ready on your phone: ${r.name}`);

/* ---------- the Bid card's 📐 Magicplan line ----------
   `value` paints from the blob at once (offline-true); `btn` is disabled
   until the roles answer, removed for anyone who is not office, and then
   refined from the pending rows and the project's status. With auto-adopt
   on, a waiting scan is adopted right here — "on the bid file's next open"
   (design §3 step 6). A bid with a scheduled visit and no project yet gets
   one created in the background. */
export function magicplanBidRow(project, tile, { onChanged } = {}) {
  const changed = () => { try { onChanged && onChanged(); } catch (_) { /* the caller repaints; a throw there is not ours */ } };
  const mpOf = () => (project.siteVisit && project.siteVisit.magicplan) || null;
  const value = h("span", {}, bidMagicplanText(project, {}));
  let state = bidMagicplanState(project, {});
  const btn = h("button", { class: "btn btn--ghost btn--sm", style: "width:auto", disabled: true },
    state === "not created" ? "📐 Create Magicplan project" : "⟳ Pull");
  const setState = (st) => {
    state = st;
    if (st === "not created") { btn.textContent = "📐 Create Magicplan project"; btn.className = "btn btn--ghost btn--sm"; return; }
    btn.textContent = "⟳ Pull";
    btn.className = (st === "scan received" || st === "updated since import") ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm";
  };

  btn.addEventListener("click", async () => {
    if (!online()) { toast(OFFLINE_TOAST); return; }
    const label = btn.textContent;
    btn.disabled = true;
    try {
      if (state === "not created") {
        btn.textContent = "Creating…";
        const r = await ensureMagicplanProject(project, tile, { manual: true });
        if (r.created) { toast(createToast(r), 4000); changed(); }
        else if (r.reason === "exists") changed();
        else if (r.reason === "offline") toast(OFFLINE_TOAST);
        else if (r.reason === "role") toast("Couldn't create the Magicplan project: office or owner only");
        else if (r.reason === "lost") toast("Couldn't create the Magicplan project: this lead is marked lost");
        else if (r.reason === "not-bid") toast("Couldn't create the Magicplan project: this file is not a bid");
      } else {
        btn.textContent = "Pulling…";
        const r = await pullMagicplan(project);
        toast(pullToast(r), 4000);
        changed();
      }
    } catch (e) {
      toast((state === "not created" ? "Couldn't create the Magicplan project: " : "Magicplan pull failed: ") + msg(e), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  (async () => {
    try {
      const flags = await roleFlags();
      if (!flags.office) { btn.remove(); return; }
      if (!online()) { btn.disabled = false; return; }
      let rows = pendingRows(await fetchPendingExport(project), project);
      if (rows.length && autoAdoptOn(flags)) {
        const r = await adoptIfReady(project, { rows });
        if (r.adopted) { toast(pullToast(r), 4000); changed(); return; }
        if (r.empty) rows = [];
      }
      const pending = rows[0] || null;
      const mp = mpOf();
      const status = mp && mp.syncedAt ? (await checkUpdated(project)).status : null;
      setState(bidMagicplanState(project, { status, pending }));
      value.textContent = bidMagicplanText(project, { status, pending });
      btn.disabled = false;
      if (!(mp && mp.projectId)) {
        ensureMagicplanProject(project, tile).then((r) => { if (r.created) { toast(createToast(r), 4000); changed(); } }).catch(() => { /* the button is the fallback */ });
      }
    } catch (_) {
      btn.disabled = false;
    }
  })();

  return { value, btn };
}

/* ---------- the Site Visit panel's scan section ----------
   ONE stable node the panel re-parents on every paint; refresh() fills it
   in place. Office + online: a banner for the newest waiting row (Add to
   packet) and the per-device auto-adopt checkbox. Anyone else, or offline:
   empty. */
export function magicplanSection({ project, onAdopted } = {}) {
  const node = h("div", { class: "mp-section" });
  const adopted = () => { try { onAdopted && onAdopted(); } catch (_) { /* the panel repaints; not ours */ } };
  let busy = false;

  async function refresh() {
    try {
      const flags = await roleFlags();
      if (!flags.office || !online()) { node.replaceChildren(); return; }
      let rows = pendingRows(await fetchPendingExport(project), project);
      if (rows.length && autoAdoptOn(flags)) {
        const r = await adoptIfReady(project, { rows });
        if (r.adopted) { toast(pullToast(r), 4000); adopted(); rows = []; }
        else if (r.empty) rows = [];
      }
      const kids = [];
      if (rows[0]) {
        const add = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto;margin-left:8px" }, "Add to packet");
        add.addEventListener("click", async () => {
          if (busy) return;
          busy = true; add.disabled = true; add.textContent = "Adding…";
          try {
            const r = await adoptIfReady(project, { rows, force: true });
            toast(pullToast(r), 4000);
            if (r.adopted) adopted();
          } catch (e) {
            toast("Magicplan pull failed: " + msg(e), 4000);
          } finally {
            busy = false;
            refresh();
          }
        });
        kids.push(h("div", { style: "margin:6px 0;padding:8px 10px;border-radius:8px;background:#e8f1fb;border:1px solid #b9d3f0;font-size:13px" },
          h("strong", {}, "📥 Magicplan scan ready"), ` — ${exportSummary(rows[0]).text}`, add));
      }
      const cb = h("input", { type: "checkbox" });
      cb.checked = autoAdoptOn(flags);
      cb.addEventListener("change", () => setAutoAdopt(cb.checked));
      kids.push(h("label", { style: "display:block;font-size:12px;margin:4px 0" }, cb, " Add Magicplan scans on this device automatically"));
      node.replaceChildren(...kids);
    } catch (_) {
      node.replaceChildren();
    }
  }
  return { node, refresh };
}

/** A ✕'d Magicplan file must not come back on the next pull (sitevisit.js fileRow). */
export function noteMagicplanRemoved(sv, id) { noteRemoved(sv, id); }
