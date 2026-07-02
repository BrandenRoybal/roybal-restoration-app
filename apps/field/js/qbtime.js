/* ============================================================
   Roybal — QuickBooks Time client (field + admin apps)
   Thin wrapper over the `qb-time-proxy` Edge Function + a read of
   the synced jobcode cache. No secrets here: the Client Secret and
   OAuth tokens live server-side. Shares the crew login session.

   Used by:
     • forms.js  → constructionLog "Pull today's hours"
     • admin      → connect / status / sync / disconnect
   ============================================================ */
import { h, toast } from "./core.js";
import { rest, callFunction, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";

/** True when the app has a backend to talk to. */
export function qbConfigured() { return SYNC_ENABLED; }

/** Low-level call to the proxy. Returns the `data` payload or throws. */
async function proxy(action, payload = {}) {
  if (!SYNC_ENABLED) throw new Error("Offline — QuickBooks needs a connection");
  if (!isSignedIn()) throw new Error("Sign in first");
  const res = await callFunction("qb-time-proxy", { action, ...payload });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `QuickBooks ${action} failed (${res.status})`);
  return body.data;
}

/* ---------- connection (used by the admin connect panel) ---------- */
export function getStatus()   { return proxy("getStatus"); }
export function syncJobcodes(){ return proxy("syncJobcodes"); }
export function disconnect()  { return proxy("disconnect"); }
export function exchangeCode(code) { return proxy("exchangeCode", { code }); }

/* ---------- jobcodes (read the synced cache, RLS lets the crew read) ---------- */
export async function listJobcodes() {
  if (!SYNC_ENABLED) return [];
  const res = await rest("qb_time_jobcodes?select=qb_id,name&active=eq.true&order=name.asc", { method: "GET" });
  if (!res.ok) throw new Error("Couldn't load QuickBooks job list (" + res.status + ")");
  return res.json();
}

/* ---------- the daily pull ---------- */
/** Pull one day's QB hours for this project's linked jobcode into time_entries. */
export function pullDay(project, date) {
  if (!project.qbJobcodeId) throw new Error("Link a QuickBooks job first");
  return proxy("pullDay", { jobcodeId: project.qbJobcodeId, date, fieldProjectId: project.id });
}

/** Backfill a whole date range of a jobcode's hours (used by the Job Board). */
export function pullRange(jobcodeId, startDate, endDate, projectId) {
  if (!jobcodeId) throw new Error("Link a QuickBooks job first");
  return proxy("pullRange", { jobcodeId, startDate, endDate, fieldProjectId: projectId ?? null });
}

/** Read the QB-sourced time_entries for this project + day (after a pull). */
export async function entriesFor(project, date) {
  if (!SYNC_ENABLED || !project.qbJobcodeId) return [];
  const jc = encodeURIComponent(project.qbJobcodeId);
  const res = await rest(
    `time_entries?select=data&deleted=eq.false&data->>qbJobcodeId=eq.${jc}&data->>date=eq.${date}&data->>source=eq.qbtime`,
    { method: "GET" }
  );
  if (!res.ok) throw new Error("Couldn't read QuickBooks hours (" + res.status + ")");
  const rows = await res.json();
  return rows.map((r) => r.data);
}

/* ============================================================
   Jobcode picker modal — mirrors tech.js pickTech().
   Resolves to the chosen { qb_id, name } (and stamps the project),
   or null if cancelled. Caller persists (commit()/Store.put).
   ============================================================ */
let pickerOpen = false;
export function pickJobcode(project) {
  if (pickerOpen) return Promise.resolve(null);
  pickerOpen = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; pickerOpen = false; overlay.remove(); resolve(val); };
    const choose = (jc) => {
      project.qbJobcodeId = jc.qb_id;
      project.qbJobcodeName = jc.name;
      toast("Linked to " + jc.name);
      finish({ qb_id: jc.qb_id, name: jc.name });
    };

    const search = h("input", {
      type: "text", placeholder: "Search job codes…",
      style: "width:100%;padding:9px 10px;border:1px solid #cdd5df;border-radius:8px;margin-bottom:8px",
    });
    const listBox = h("div", { style: "max-height:46vh;overflow:auto" },
      h("div", { class: "subtle", style: "padding:8px 2px" }, "Loading job codes…"));

    const unlink = project.qbJobcodeId
      ? h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Unlink")
      : null;
    if (unlink) unlink.addEventListener("click", () => {
      project.qbJobcodeId = ""; project.qbJobcodeName = "";
      toast("Unlinked"); finish({ qb_id: "", name: "" });
    });
    const cancel = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Cancel");
    cancel.addEventListener("click", () => finish(null));

    const card = h("div", {
      style: "background:#fff;border-radius:16px;padding:18px;max-width:460px;width:92%;box-shadow:0 16px 50px rgba(0,0,0,.3)",
    },
      h("div", { style: "font-weight:800;font-size:18px;color:var(--navy,#0f1b2d);margin-bottom:2px" }, "Link QuickBooks job"),
      h("div", { class: "subtle", style: "font-size:13px;margin-bottom:10px" }, "Pick the QB Time job code whose hours belong to this job."),
      search, listBox,
      h("div", { style: "display:flex;justify-content:space-between;margin-top:14px" },
        unlink || h("span"), cancel));

    const overlay = h("div", {
      style: "position:fixed;inset:0;background:rgba(15,27,45,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px",
      onclick: (e) => { if (e.target === overlay) finish(null); },
    }, card);
    document.body.appendChild(overlay);

    let all = [];
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const rows = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
      listBox.replaceChildren();
      if (!rows.length) {
        listBox.append(h("div", { class: "subtle", style: "padding:8px 2px;font-size:13px" },
          all.length ? "No match." : "No job codes synced yet — sync them in the admin app first."));
        return;
      }
      rows.forEach((c) => {
        const active = c.qb_id === project.qbJobcodeId;
        const btn = h("button", {
          type: "button",
          style: "display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 10px;margin:3px 0;" +
            "border:1px solid " + (active ? "var(--orange,#f26a21)" : "#e2e6ec") + ";border-radius:10px;background:#fff;cursor:pointer",
        }, h("span", { style: "font-weight:600;color:var(--navy,#0f1b2d)" }, c.name),
          active ? h("span", { class: "subtle", style: "margin-left:auto;font-size:12px" }, "linked") : null);
        btn.addEventListener("click", () => choose(c));
        listBox.append(btn);
      });
    };
    search.addEventListener("input", paint);

    listJobcodes().then((rows) => {
      if (done) return;
      all = rows || [];
      paint();
    }).catch((e) => {
      if (done) return;
      listBox.replaceChildren(h("div", { class: "subtle", style: "padding:8px 2px;font-size:13px" }, e.message));
    });
  });
}
