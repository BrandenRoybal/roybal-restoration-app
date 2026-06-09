/* ============================================================
   Roybal Restoration — Office Admin
   Same-origin as the field app, so it shares the same local data
   and Supabase session. Reuses the field app's core/model/sync.
   ============================================================ */
import { h, $, clear, Store, fmtDate, daysSince, money } from "../../js/core.js";
import { FORMS, newInvoice, SCOPE_ITEMS } from "../../js/model.js";
import { SYNC_ENABLED, AI_ENDPOINT } from "../../js/config.js";
import { isSignedIn, signIn, signOut, currentEmail, accessToken } from "../../js/supa.js";
import { startSync, syncNow } from "../../js/sync.js";
import { setCtx } from "../../js/formkit.js";
import { RENDERERS } from "../../js/forms.js";

const view = $("#view");
const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const openFieldJob = (id) => { location.href = FIELD_ROOT + "#/p/" + id; };
const openJob = (id) => { location.hash = "#/job/" + id; };

let started = false;
function startSyncUI() {
  $("#acctEmail").textContent = currentEmail();
  $("#signOutBtn").hidden = false;
  if (!started) { started = true; startSync(onStatus); } else syncNow();
}
function onStatus(s) {
  const dot = $("#syncDot");
  const map = { syncing: ["var(--amber)", "Syncing…"], synced: ["var(--green)", "Synced"],
    offline: ["#ff6b6b", "Offline"], error: ["#ff6b6b", "Sync error"] };
  const [c, t] = map[s.state] || ["var(--green)", "Online"];
  dot.style.color = c; dot.title = t;
  // refresh the dashboard when fresh data lands, but don't disrupt a job/invoice screen
  if (s.state === "synced" && isSignedIn() && (!location.hash || location.hash === "#/")) renderDashboard();
}

$("#signOutBtn").addEventListener("click", () => {
  if (!confirm("Sign out of the office admin?")) return;
  signOut(); location.reload();
});

/* ---------- routing ---------- */
const authed = () => !SYNC_ENABLED || isSignedIn();
function route() {
  if (!authed()) return renderLogin();
  const m = location.hash.match(/^#\/job\/([^/]+)(?:\/invoice\/([^/]+))?/);
  if (m) return renderJob(decodeURIComponent(m[1]), m[2] && decodeURIComponent(m[2]));
  renderDashboard();
}
window.addEventListener("hashchange", route);

function boot() {
  if (SYNC_ENABLED && isSignedIn()) startSyncUI();
  route();
}

/* ---------- login ---------- */
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
    try { await signIn(email.value, pass.value); startSyncUI(); route(); }
    catch (e) { err.hidden = false; err.textContent = String(e && e.message || e); btn.disabled = false; btn.textContent = "Sign in"; }
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  body.append(h("div", { class: "alogin" },
    h("img", { src: "../assets/icon-180.png", alt: "" }),
    h("h1", { style: "margin:14px 0 2px" }, "Office Admin"),
    h("p", { class: "subtle" }, "Sign in with your shared crew account."),
    h("div", { class: "card", style: "text-align:left;margin-top:14px" }, err,
      h("div", { class: "field" }, h("label", {}, "Email"), email),
      h("div", { class: "field" }, h("label", {}, "Password"), pass), btn)));
}

/* ---------- dashboard + jobs table ---------- */
let filterText = "";
function jobAttention(p) {
  return (p.dryingLogs || []).some((d) => (d.equipment || []).some((e) =>
    e.placed && !e.removed && (daysSince(e.placed) ?? 0) >= 7));
}
function jobSummary(p) {
  return {
    id: p.id,
    customer: p.customer || "Untitled job",
    address: p.address || "",
    claim: p.claimNo || "",
    cat: p.waterCategory ? "Cat " + p.waterCategory + (p.waterClass ? " / Cl " + p.waterClass : "") : "",
    updated: (p.updatedAt || "").slice(0, 10),
    moisture: (p.moistureMaps || []).length,
    drying: (p.dryingLogs || []).length,
    photos: (p.photos || []).length,
    contents: (p.contents || []).length,
    attention: jobAttention(p),
  };
}

async function renderDashboard() {
  const projects = await Store.all();
  const rows = projects.map(jobSummary);
  const body = clear(view);

  const active = rows.filter((r) => r.updated && daysSince(r.updated) <= 7).length;
  const drying = rows.filter((r) => r.drying > 0).length;
  const attention = rows.filter((r) => r.attention).length;

  body.append(h("div", { class: "kpis" },
    kpi(rows.length, "Total jobs"),
    kpi(active, "Active (last 7 days)"),
    kpi(drying, "Drying in progress"),
    kpi(attention, "Need attention (7-day equip.)", attention > 0)));

  const search = h("input", { type: "search", placeholder: "Search customer, address, claim #…", value: filterText });
  search.addEventListener("input", () => { filterText = search.value.toLowerCase(); paintTable(); });
  body.append(h("div", { class: "atoolbar" },
    h("h1", {}, "Jobs"),
    h("div", { style: "display:flex;gap:10px" }, search,
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => syncNow() }, "↻ Refresh"))));

  const tbody = h("tbody");
  body.append(h("div", { class: "atable-wrap" },
    h("table", { class: "atable" },
      h("thead", {}, h("tr", {},
        ...["Customer", "Address", "Claim #", "Category", "Moisture", "Drying", "Photos", "Contents", "Updated"].map((c) => h("th", {}, c)))),
      tbody)));

  function paintTable() {
    const list = rows.filter((r) =>
      !filterText || (r.customer + " " + r.address + " " + r.claim).toLowerCase().includes(filterText));
    if (!list.length) {
      tbody.replaceChildren(h("tr", {}, h("td", { colspan: 9, class: "aempty" },
        projects.length ? "No jobs match your search." : "No jobs yet. Jobs created in the field app will appear here.")));
      return;
    }
    tbody.replaceChildren(...list.map((r) => {
      const tr = h("tr", { onclick: () => openJob(r.id) },
        h("td", {}, h("strong", {}, r.customer), r.attention ? h("span", { class: "badge cat3", style: "margin-left:8px" }, "⚠ 7-day") : null),
        h("td", { class: "muted" }, r.address),
        h("td", {}, r.claim),
        h("td", {}, r.cat),
        h("td", {}, String(r.moisture || "")),
        h("td", {}, String(r.drying || "")),
        h("td", {}, String(r.photos || "")),
        h("td", {}, String(r.contents || "")),
        h("td", { class: "muted" }, r.updated ? fmtDate(r.updated) : ""));
      return tr;
    }));
  }
  paintTable();
}

function kpi(n, label, attn) {
  return h("div", { class: "kpi" + (attn ? " attn" : "") },
    h("div", { class: "kpi__n" }, String(n)),
    h("div", { class: "kpi__l" }, label));
}

/* ============================================================
   Job detail (office) — invoices + AI narrative/scope
   ============================================================ */
const savePill = () => h("span", { class: "saved-pill", style: "font-size:12px" }, "✓ Saved");

async function renderJob(id, invId) {
  const project = await Store.get(id);
  if (!project) { location.hash = "#/"; return; }
  if (!Array.isArray(project.invoices)) project.invoices = [];

  if (invId) return renderInvoice(project, invId);

  setCtx(project, null);
  const body = clear(view);
  body.append(
    h("div", { class: "atoolbar" },
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => { location.hash = "#/"; } }, "← All jobs"),
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => openFieldJob(id) }, "Open in field forms ↗")));

  const cat = project.waterCategory ? "Cat " + project.waterCategory + (project.waterClass ? " / Class " + project.waterClass : "") : "";
  body.append(
    h("h1", { style: "margin:6px 0 2px" }, project.customer || "Untitled job"),
    h("p", { class: "subtle" }, [project.address, project.claimNo ? "Claim " + project.claimNo : "", project.carrier, cat].filter(Boolean).join(" · ")));

  body.append(invoiceSection(project));
  body.append(aiSection(project));
}

function invoiceSection(project) {
  const wrap = h("div", { class: "card" });
  function paint() {
    const rows = project.invoices.map((inv) => {
      const total = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
      return h("a", { class: "card card--tap jobrow", style: "margin:0", href: `#/job/${project.id}/invoice/${inv.id}` },
        h("div", { class: "jobrow__main" },
          h("div", { class: "jobrow__title" }, "Invoice " + (inv.invoiceNo || "(no #)")),
          h("div", { class: "jobrow__sub" }, fmtDate(inv.invoiceDate) + " · " + money(total))),
        h("div", { class: "jobrow__chev" }, "›"));
    });
    wrap.replaceChildren(
      h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px" },
        h("h2", { style: "margin:0" }, "🧾 Invoices"),
        h("button", { class: "btn btn--primary btn--sm", onclick: addInvoice }, "+ New invoice")),
      rows.length ? h("div", { class: "joblist" }, ...rows) : h("p", { class: "subtle" }, "No invoices yet."));
  }
  async function addInvoice() {
    const inv = newInvoice(); project.invoices.push(inv); await Store.put(project);
    location.hash = `#/job/${project.id}/invoice/${inv.id}`;
  }
  paint();
  return wrap;
}

function renderInvoice(project, invId) {
  const inv = (project.invoices || []).find((x) => x.id === invId);
  if (!inv) { location.hash = "#/job/" + project.id; return; }
  const pill = savePill();
  setCtx(project, pill);
  const body = clear(view);
  body.append(
    h("div", { class: "atoolbar app-only" },
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => { location.hash = "#/job/" + project.id; } }, "← Back to job"),
      h("div", { style: "display:flex;gap:10px;align-items:center" }, pill,
        h("button", { class: "btn btn--danger btn--sm", onclick: () => delInvoice(project, inv) }, "Delete"),
        h("button", { class: "btn btn--primary btn--sm", onclick: () => window.print() }, "⬇ Save as PDF"))));
  body.append(RENDERERS.invoices(project, inv));
}
async function delInvoice(project, inv) {
  if (!confirm("Delete this invoice?")) return;
  project.invoices = project.invoices.filter((x) => x.id !== inv.id);
  await Store.put(project);
  location.hash = "#/job/" + project.id;
}

/* ---------- AI narrative / scope ---------- */
function jobSummaryText(p) {
  const lines = [];
  const add = (k, v) => { if (v) lines.push(k + ": " + v); };
  add("Customer", p.customer); add("Property address", p.address);
  add("Claim #", p.claimNo); add("Insurance carrier", p.carrier); add("Adjuster", p.adjuster);
  add("Date of loss", p.dateOfLoss); add("Loss cause", p.lossCause);
  add("Water category", p.waterCategory && ("Category " + p.waterCategory));
  add("Class of water", p.waterClass); add("Drying system", p.dryingSystem);
  if (p.workAuth && p.workAuth.scope) {
    const items = SCOPE_ITEMS.filter((_, i) => p.workAuth.scope[i]);
    if (items.length) lines.push("Authorized scope:\n - " + items.join("\n - "));
  }
  (p.moistureMaps || []).forEach((m, i) => {
    const days = (m.readings || []).length;
    lines.push(`Moisture map ${i + 1}: material ${m.material || "n/a"}, dry goal ${m.dryGoal || "n/a"}, ${days} reading day(s)` + (m.label ? ` (${m.label})` : ""));
  });
  (p.dryingLogs || []).forEach((d, i) => {
    const eq = (d.equipment || []).map((e) => [e.type, e.location].filter(Boolean).join(" @ ")).filter(Boolean);
    lines.push(`Drying log ${i + 1}: ${eq.length} unit(s) [${eq.join("; ")}], ${(d.readings || []).length} psychrometric reading(s)`);
  });
  if (p.certDrying && p.certDrying.affectedAreas) lines.push("Affected areas/materials: " + p.certDrying.affectedAreas);
  if ((p.contents || []).length) {
    const loss = p.contents.filter((c) => c.disposition === "non-salvageable").length;
    lines.push(`Contents: ${p.contents.length} item(s), ${loss} non-salvageable`);
  }
  return lines.join("\n");
}

function aiSection(project) {
  const card = h("div", { class: "card" });
  card.append(h("h2", { style: "margin-top:0" }, "✨ AI Scope & Narrative"));
  if (!AI_ENDPOINT) {
    card.append(h("p", { class: "subtle" },
      "Not set up yet. Deploy the AI function (apps/ai) to Vercel and add its URL — then these buttons generate a carrier-ready narrative and scope of work from this job's data."));
    return card;
  }
  card.append(h("p", { class: "subtle" }, "Generates from this job's data (no photos). Review and edit before using — saves with the job."));
  card.append(aiBlock(project, "narrative", "Mitigation Narrative"));
  card.append(h("hr", { class: "divider" }));
  card.append(aiBlock(project, "scope", "Scope of Work"));
  return card;
}
function aiBlock(project, kind, label) {
  const key = kind === "scope" ? "aiScope" : "aiNarrative";
  const ta = h("textarea", { rows: 8, placeholder: "Generate or write the " + label.toLowerCase() + "…" });
  ta.value = project[key] || "";
  ta.addEventListener("input", () => { project[key] = ta.value; Store.put(project); });
  const status = h("span", { class: "subtle", style: "font-size:12px" });
  const gen = h("button", { class: "btn btn--ghost btn--sm" }, "✨ Generate");
  const copy = h("button", { class: "btn btn--ghost btn--sm" }, "Copy");
  copy.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(ta.value); status.textContent = "Copied"; });
  gen.addEventListener("click", async () => {
    gen.disabled = true; status.textContent = "Generating… (a few seconds)";
    try {
      const res = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken() },
        body: JSON.stringify({ kind, summary: jobSummaryText(project) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      ta.value = data.text; project[key] = data.text; await Store.put(project);
      status.textContent = "Done — review and edit.";
    } catch (e) { status.textContent = "Error: " + (e.message || e); }
    finally { gen.disabled = false; }
  });
  return h("div", {},
    h("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px" },
      h("strong", {}, label),
      h("div", { style: "display:flex;gap:8px;align-items:center" }, status, copy, gen)),
    ta);
}

boot();
