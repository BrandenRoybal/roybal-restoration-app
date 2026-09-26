/* ============================================================
   Roybal Admin — Magicplan panel (⚙ Settings)
   ------------------------------------------------------------
   docs/Magicplan_Integration_Design.md §5, the qboconnect.js recipe. The
   Magicplan key lives only in the magicplan-proxy edge function's secrets;
   this shows what the proxy can see:
     - the connected workspace (GET /workspace through the proxy) and whether
       this is staging (project names prefixed "[STAGING] ") or production;
     - the jobs carrying a Magicplan project, with Archive (a cancelled
       visit, a staging test project);
     - the last 10 scans pulled (magicplan_exports, owner/office RLS), with a
       Link to job picker for a scan that matched no bid file.
   The webhook Register button is M2, not here.
   ============================================================ */
import { h, toast, Store, fmtDate } from "../../js/core.js";
import { rest } from "../../js/supa.js";
import { mpWorkspace, mpArchive, mpLinkExport } from "../../js/magicplan.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const STATUS_TONE = { ready: "#1e4a72", imported: "#1e6b3a", failed: "#b3261e", unmatched: "#8a6d00", queued: "#555" };

async function recentExports() {
  const res = await rest("magicplan_exports?select=id,mp_project_id,field_project_id,status,error,received_at,synced_at,imported_at,imported_by,files,photos&order=received_at.desc&limit=10", { method: "GET" });
  if (!res.ok) throw new Error("Couldn't read the scan log (" + res.status + ")");
  return res.json();
}

export function magicplanPanel() {
  const box = h("div", { class: "card qb-panel" });

  async function load() {
    box.replaceChildren(h("div", { class: "qb-panel__head" }, h("strong", {}, "Magicplan (LiDAR scans)"), h("span", { class: "subtle" }, "checking…")));
    let ws = null, wsErr = "";
    try { ws = await mpWorkspace(); } catch (e) { wsErr = String((e && e.message) || e); }
    let rows = [], rowsErr = "";
    try { rows = await recentExports(); } catch (e) { rowsErr = String((e && e.message) || e); }
    const jobs = (await Store.all().catch(() => [])).filter((p) => p && !p.archivedAt);
    const jobName = (id) => { const p = jobs.find((j) => j.id === id); return p ? (p.customer || p.address || id) : id; };

    box.replaceChildren(h("div", { class: "qb-panel__head" },
      h("strong", {}, "Magicplan (LiDAR scans)"),
      ws ? h("span", { class: "qb-ok" }, "● Connected") : h("span", { class: "qb-off" }, "○ Not connected")));

    if (ws) {
      box.append(h("p", { class: "subtle" }, `Workspace “${ws.name}”` + (ws.ownerEmail ? ` · ${ws.ownerEmail}` : "")),
        h("p", { class: "subtle" }, ws.prefix
          ? `Staging: projects created from here are named “${ws.prefix}…” on the phone. Archive them when the test is done.`
          : "Production: projects are created with the customer's name and address, no prefix."));
      if (!ws.projectEmailSet) box.append(h("p", { style: "color:#b3261e;font-size:13px" }, "MAGICPLAN_PROJECT_EMAIL isn't set, so new projects can't be created yet."));
    } else {
      box.append(h("p", { class: "subtle" }, wsErr || "The Magicplan key isn't set on this Supabase project."));
    }

    box.append(linkedProjects(jobs));
    box.append(h("div", { style: "font-weight:700;font-size:13px;margin-top:10px" }, "Last 10 scans pulled"));
    if (rowsErr) { box.append(h("p", { class: "subtle" }, rowsErr)); return; }
    if (!rows.length) { box.append(h("p", { class: "subtle" }, "None yet — ⟳ Pull on a bid file's Bid card brings the first one in.")); return; }

    for (const r of rows) {
      const when = fmtDate(String(r.synced_at || r.received_at || "").slice(0, 10));
      const line = h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;padding:6px 0;border-top:1px solid #e2e6ed" },
        h("span", { style: `font-weight:700;color:${STATUS_TONE[r.status] || "#555"};min-width:72px` }, r.status),
        h("span", { class: "subtle" }, when),
        h("span", { style: "flex:1;min-width:140px" },
          r.field_project_id ? jobName(r.field_project_id) : "no job",
          r.status === "ready" || r.status === "imported" ? ` · ${arr(r.files).length} report${arr(r.files).length === 1 ? "" : "s"}, ${arr(r.photos).length} photos` : "",
          r.error ? h("div", { class: "subtle", style: "font-size:11px" }, r.error) : null));

      if (r.status === "unmatched" && !r.field_project_id) {
        const pick = h("select", { style: "max-width:220px" }, h("option", { value: "" }, "Link to job…"),
          ...jobs.filter((p) => p.bidOf).concat(jobs.filter((p) => !p.bidOf))
            .map((p) => h("option", { value: p.id }, (p.bidOf ? "📐 " : "") + (p.customer || p.address || p.id))));
        const go = h("button", { class: "btn btn--primary btn--sm" }, "Link");
        go.addEventListener("click", async () => {
          if (!pick.value) { toast("Pick the job this scan belongs to."); return; }
          go.disabled = true;
          try { await mpLinkExport(r.id, pick.value); toast("Linked — it lands on that job's next open."); load(); }
          catch (e) { go.disabled = false; toast(String((e && e.message) || e), 5000); }
        });
        line.append(pick, go);
      }
      box.append(line);
    }
  }

  /* Jobs on this device that carry a Magicplan project, newest first, each
     with Archive (a cancelled visit, a staging test project). Archiving keeps
     the scan in Magicplan and everything already copied here. */
  function linkedProjects(jobs) {
    const linked = jobs.filter((p) => p.siteVisit && p.siteVisit.magicplan && p.siteVisit.magicplan.projectId)
      .sort((a, b) => String(b.siteVisit.magicplan.createdAt || "").localeCompare(String(a.siteVisit.magicplan.createdAt || "")))
      .slice(0, 10);
    const wrap = h("div");
    wrap.append(h("div", { style: "font-weight:700;font-size:13px;margin-top:10px" }, "Magicplan projects on jobs"));
    if (!linked.length) { wrap.append(h("p", { class: "subtle" }, "None yet — a bid file with a scheduled site visit gets one when it's opened.")); return wrap; }
    for (const p of linked) {
      const mp = p.siteVisit.magicplan;
      const arch = h("button", { class: "btn btn--ghost btn--sm" }, "Archive in Magicplan");
      arch.addEventListener("click", async () => {
        if (!confirm(`Archive the Magicplan project for ${p.customer || p.address || "this job"}? It can't be edited on the phone afterwards; nothing here is deleted.`)) return;
        arch.disabled = true;
        try { await mpArchive(mp.projectId); toast("Archived in Magicplan."); arch.textContent = "Archived"; }
        catch (e) { arch.disabled = false; toast(String((e && e.message) || e), 5000); }
      });
      wrap.append(h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;padding:6px 0;border-top:1px solid #e2e6ed" },
        h("span", { style: "flex:1;min-width:140px" }, p.customer || p.address || p.id,
          h("span", { class: "subtle" }, " · created " + fmtDate(String(mp.createdAt || "").slice(0, 10)) + (mp.importedAt ? " · imported" : ""))),
        arch));
    }
    return wrap;
  }
  load();
  return box;
}
