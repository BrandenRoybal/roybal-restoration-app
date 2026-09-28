/* ============================================================
   Roybal Admin — Magicplan (LiDAR scans) panel
   ------------------------------------------------------------
   Follows the qboconnect.js recipe (card, status head, load/render)
   but there is nothing to "connect" here: the Magicplan company key
   lives only in edge-function secrets and is attached server-side, so
   this panel never sees it — every call goes through the office-gated
   magicplan-proxy via the field app's wrappers (../../js/magicplan.js).
   The phone is the capture device; the office is where three things
   need eyes:
     1. Is the workspace reachable, and are new projects landing under
        the staging prefix or on production? (getWorkspace)
     2. The last 10 magicplan_exports rows — a scan started by hand in
        the Magicplan app has no external_reference_id, lands as
        `unmatched`, and must never be silently dropped: the Link to job
        picker re-runs the sync into the chosen bid file.
     3. Archive — a staging project that was created at scheduling but
        never scanned has NO export row, so the "linked from this
        device" table (from Store.all()) and Archive-by-id exist to get
        every [STAGING] project off the phone's active list.
   No Register button and no key-rotation date: that is M2.
   ============================================================ */
import { h, toast, Store, fmtDate } from "../../js/core.js";
import { mpGetWorkspace, mpArchiveProject, mpLinkExport, fetchRecentExports } from "../../js/magicplan.js";
import { exportSummary } from "../../js/magicplancalc.js";

// admin.js computes the same thing at :25 but does not export it
const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";

const ARCHIVE_CONFIRM = "Archive this Magicplan project? The scan stays in Magicplan; the project leaves the phone's active list.";
const errText = (e, fallback) => (e && e.message) || fallback;

/* a link/archive in flight, or a Link picker holding a value, must survive the
   sync repaint — the leadsBusy()/campaignsBusy() rule (admin.js onStatus) */
let busy = false;
export function magicplanBusy() { return busy; }

/* job label the way the Bid card and Leads Inbox name a job */
const jobLabel = (p) => p.customer || p.address || p.id;
const jobLink = (p) => h("a", { href: FIELD_ROOT + "#/p/" + p.id }, jobLabel(p));

/** The ⚙ Settings card: workspace status, recent scans, linked projects, archive. */
export function magicplanPanel() {
  const box = h("div", { class: "card qb-panel" });

  async function archive(projectId, btn) {
    const id = String(projectId || "").trim();
    if (!id) { toast("Enter the Magicplan project id first."); return; }
    if (!confirm(ARCHIVE_CONFIRM)) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Archiving…";
    try { await mpArchiveProject(id); toast("Archived in Magicplan."); load(); }
    catch (e) { toast("Archive failed: " + errText(e, "Magicplan unavailable")); btn.disabled = false; btn.textContent = label; }
    finally { busy = false; }
  }

  function archiveBtn(projectId) {
    const b = h("button", { class: "btn btn--ghost btn--sm" }, "Archive project");
    b.addEventListener("click", () => archive(projectId, b));
    return b;
  }

  /* an unmatched row: pick one of this device's live jobs, bid files first —
     the hand-started scan almost always belongs to an open bid */
  function linkCell(row, projects) {
    const live = projects.filter((p) => !p.archivedAt);
    const ordered = [...live.filter((p) => p.bidOf), ...live.filter((p) => !p.bidOf)];
    const select = h("select", { title: "Link this scan to a job" },
      h("option", { value: "" }, "Pick a job…"),
      ...ordered.map((p) => h("option", { value: p.id }, jobLabel(p))));
    const btn = h("button", { class: "btn btn--primary btn--sm" }, "Link to job");
    select.addEventListener("change", () => { busy = !!select.value; });
    btn.addEventListener("click", async () => {
      if (!select.value) { toast("Pick a job to link the scan to."); return; }
      busy = true;
      btn.disabled = true; btn.textContent = "Linking…";
      try { await mpLinkExport(row.id, select.value); toast("Linked — the scan lands on that job on its next open or Pull."); load(); }
      catch (e) { toast("Link failed: " + errText(e, "Magicplan unavailable")); btn.disabled = false; btn.textContent = "Link to job"; }
      finally { busy = false; }
    });
    return h("td", {}, h("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap" }, select, btn));
  }

  function scansTable(rows, projects) {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const tbody = h("tbody");
    if (!rows.length) {
      tbody.append(h("tr", {}, h("td", { colspan: 5, class: "aempty" },
        "No Magicplan scans yet — pull a scan from a bid file's Bid card.")));
    }
    for (const row of rows) {
      const job = row.field_project_id ? byId.get(row.field_project_id) : null;
      tbody.append(h("tr", { style: "cursor:default" },
        h("td", { class: "muted" }, fmtDate(row.received_at)),
        row.status === "unmatched"
          ? linkCell(row, projects)
          : h("td", {}, job ? jobLink(job) : (row.field_project_id || "")),
        h("td", {}, row.status, row.error ? h("span", { class: "subtle", style: "display:block" }, row.error) : null),
        h("td", {}, exportSummary(row).text),
        h("td", {}, archiveBtn(row.mp_project_id))));
    }
    return h("table", { class: "atable", style: "margin:6px 0 14px" },
      h("thead", {}, h("tr", {}, ...["When", "Job", "Status", "Files", ""].map((c) => h("th", {}, c)))),
      tbody);
  }

  function linkedTable(projects) {
    const linked = projects.filter((p) => p.siteVisit && p.siteVisit.magicplan && p.siteVisit.magicplan.projectId);
    const tbody = h("tbody");
    if (!linked.length) {
      tbody.append(h("tr", {}, h("td", { colspan: 4, class: "aempty" },
        "No bid file on this device has a Magicplan project.")));
    }
    for (const p of linked) {
      const mp = p.siteVisit.magicplan;
      tbody.append(h("tr", { style: "cursor:default" },
        h("td", {}, jobLink(p)),
        h("td", { class: "muted" }, fmtDate(mp.createdAt)),
        h("td", { class: "muted" }, mp.syncedAt ? fmtDate(mp.syncedAt) : "—"),
        h("td", {}, archiveBtn(mp.projectId))));
    }
    return h("table", { class: "atable", style: "margin:6px 0 14px" },
      h("thead", {}, h("tr", {}, ...["Job", "Created", "Synced", ""].map((c) => h("th", {}, c)))),
      tbody);
  }

  function render(state) {
    const ws = state.workspace || null;
    const connected = !!(ws && !ws.error);
    box.replaceChildren();
    box.append(h("div", { class: "qb-panel__head" },
      h("strong", {}, "Magicplan (LiDAR scans)"),
      connected ? h("span", { class: "qb-ok" }, "● Connected") : h("span", { class: "qb-off" }, "○ Not connected")));

    if (connected) {
      // the prefix is how staging projects are told apart on the phone — say
      // plainly which world new projects land in
      box.append(h("p", { class: "subtle" },
        "Workspace " + (ws.name || "") +
        (ws.prefix ? " · project names prefixed “" + ws.prefix + "”" : " · no prefix (production)") +
        (ws.projectEmail ? " · projects land on " + ws.projectEmail : "")));
    } else {
      box.append(h("p", { class: "subtle" }, ws ? ws.error : "Checking the Magicplan workspace…"));
    }

    box.append(h("strong", {}, "Recent scans"), scansTable(state.rows, state.projects));
    box.append(h("strong", {}, "Projects linked from this device"), linkedTable(state.projects));

    const idInput = h("input", { type: "text", placeholder: "Magicplan project id", style: "flex:1;min-width:220px" });
    const byId = h("button", { class: "btn btn--ghost btn--sm" }, "Archive by id");
    byId.addEventListener("click", () => archive(idInput.value, byId));
    box.append(h("div", { class: "qb-panel__row" }, idInput, byId));
  }

  async function load() {
    render({ workspace: null, rows: [], projects: [] });
    // three independent reads; one failing must not blank the others
    const [workspace, rows, projects] = await Promise.all([
      mpGetWorkspace().catch((e) => ({ error: errText(e, "Magicplan unavailable") })),
      fetchRecentExports(10).catch(() => []),
      Store.all().catch(() => []),
    ]);
    render({ workspace, rows: Array.isArray(rows) ? rows : [], projects: Array.isArray(projects) ? projects : [] });
  }
  load();
  return box;
}
