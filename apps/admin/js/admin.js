/* ============================================================
   Roybal Restoration — Office Admin
   Same-origin as the field app, so it shares the same local data
   and Supabase session. Login + dashboard + all-jobs table;
   clicking a job opens it in the field forms.
   ============================================================ */
import { h, $, clear, Store, fmtDate, daysSince } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { isSignedIn, signIn, signOut, currentEmail } from "../../js/supa.js";
import { startSync, syncNow } from "../../js/sync.js";

const view = $("#view");
const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const openJob = (id) => { location.href = FIELD_ROOT + "#/p/" + id; };

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
  if (s.state === "synced" && isSignedIn()) renderDashboard();   // refresh as jobs arrive
}

$("#signOutBtn").addEventListener("click", () => {
  if (!confirm("Sign out of the office admin?")) return;
  signOut(); location.reload();
});

/* ---------- boot ---------- */
function boot() {
  if (!SYNC_ENABLED) return renderDashboard();        // local-only fallback
  if (isSignedIn()) { startSyncUI(); renderDashboard(); }
  else renderLogin();
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
    try { await signIn(email.value, pass.value); startSyncUI(); renderDashboard(); }
    catch (e) { err.hidden = false; err.textContent = String(e && e.message || e); btn.disabled = false; btn.textContent = "Sign in"; }
  }
  btn.addEventListener("click", submit);
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  body.append(h("div", { class: "alogin" },
    h("img", { src: "assets/emblem-mark.svg", alt: "", style: "background:#fff;padding:12px;box-sizing:border-box" }),
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
    tbody.replaceChildren(...list.map((r) => h("tr", { onclick: () => openJob(r.id) },
      h("td", {}, h("strong", {}, r.customer), r.attention ? h("span", { class: "badge cat3", style: "margin-left:8px" }, "⚠ 7-day") : null),
      h("td", { class: "muted" }, r.address),
      h("td", {}, r.claim),
      h("td", {}, r.cat),
      h("td", {}, String(r.moisture || "")),
      h("td", {}, String(r.drying || "")),
      h("td", {}, String(r.photos || "")),
      h("td", {}, String(r.contents || "")),
      h("td", { class: "muted" }, r.updated ? fmtDate(r.updated) : ""))));
  }
  paintTable();
}

function kpi(n, label, attn) {
  return h("div", { class: "kpi" + (attn ? " attn" : "") },
    h("div", { class: "kpi__n" }, String(n)),
    h("div", { class: "kpi__l" }, label));
}

boot();
