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
import { qbPanel, handleQbCallback } from "./qbconnect.js";
import { qboPanel, handleQboCallback } from "./qboconnect.js";
import { gmailPanel, handleGmailCallback } from "./gmailconnect.js";
import { messagesPanel } from "./messages.js";
import { contactsPanel, renderContactPage } from "./contacts.js";
import { campaignsPanel, campaignsBusy } from "./campaigns.js";
import { mountAssistProvider } from "../../js/assist.js";
import { adminAssistProvider } from "./assistctx.js";

const view = $("#view");
const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const openJob = (id) => { location.href = FIELD_ROOT + "#/p/" + id; };

let started = false;
function startSyncUI() {
  $("#acctEmail").textContent = currentEmail();
  $("#signOutBtn").hidden = false;
  // 💬 office-manager assistant — floats on document.body, survives re-renders
  mountAssistProvider(adminAssistProvider());
  if (!started) { started = true; startSync(onStatus); } else syncNow();
}
function onStatus(s) {
  const dot = $("#syncDot");
  const map = { syncing: ["var(--amber)", "Syncing…"], synced: ["var(--green)", "Synced"],
    offline: ["#ff6b6b", "Offline"], error: ["#ff6b6b", "Sync error"] };
  const [c, t] = map[s.state] || ["var(--green)", "Online"];
  dot.style.color = c; dot.title = t;
  // refresh as jobs arrive — but never clobber an open contact page
  // (its edit form would lose keystrokes to a background sync) or the
  // campaigns composer (curation gone, and a rebuilt panel would hide a
  // send loop still running in a detached node — duplicate-SMS bait)
  if (s.state === "synced" && isSignedIn() && !contactRoute() && !campaignsBusy()) renderDashboard();
}

/* ---------- routes (the admin's first router — field-app hash pattern) ----------
   ''        → dashboard
   #/c/<id>  → a contact's page (CRM step 5)
   #/help    → how the office admin fits together */
const contactRoute = () => (location.hash.match(/^#\/c\/([0-9a-f-]{36})/i) || [])[1] || null;
function route() {
  if (!isSignedIn() && SYNC_ENABLED) return renderLogin();
  if (location.hash.startsWith("#/help")) return renderHelp();
  const cid = contactRoute();
  if (cid) return renderContactPage(view, cid);
  renderDashboard();
}
window.addEventListener("hashchange", route);

/* ---------- help (#/help) ---------- */
function renderHelp() {
  const body = clear(view);
  const sec = (title, ...paras) => h("div", { class: "card", style: "margin-top:14px" },
    h("div", { style: "font-weight:700;margin-bottom:6px" }, title), ...paras);
  const p = (...kids) => h("p", { class: "muted", style: "font-size:13px;margin:4px 0" }, ...kids);
  body.append(
    h("div", { class: "atoolbar" }, h("h1", {}, "How the Office Admin fits together"),
      h("a", { class: "btn btn--ghost btn--sm", href: "#", onclick: (e) => { e.preventDefault(); location.hash = ""; } }, "‹ Back")),
    sec("The dashboard",
      p("The KPI row is the shop at a glance — total jobs, active this week, drying in progress, and jobs needing attention (equipment out 7+ days). Below it, the connection panels: ",
        h("strong", {}, "QuickBooks Time"), " (crew hours), ", h("strong", {}, "QuickBooks Online"), " (invoices + nightly payment sync), ",
        h("strong", {}, "Gmail"), " (job-matched email), ", h("strong", {}, "💬 Company texting"), " (both sides of the toll-free number), ",
        h("strong", {}, "👤 Contacts"), ", and ", h("strong", {}, "📣 Campaigns"), "."),
      p("The Jobs table lists every field job — click a row to open it in the field app. Search covers customer, address, and claim number.")),
    sec("👤 Contacts — the customer directory",
      p("Every customer, adjuster, and lead the business has ever touched, deduplicated automatically across the website, phone line, AI chat, texting, email, and field jobs. Search by name, phone, or email, or click a recent contact."),
      p("A contact's page shows their identity (edit in place; the ", h("strong", {}, "marketing opt-in"), " checkbox lives here), every job on both the field and board sides, and the whole conversation — texts, emails, portal messages, and phone calls — in one timeline."),
      p(h("strong", {}, "Merge review:"), " when the system suspects two entries are the same person (shared email, same name + address) a banner appears — ", h("strong", {}, "Merge"), " combines them and repoints every job, message, and portal link; ", h("strong", {}, "Not a match"), " dismisses it. Exact phone matches merge automatically; anything weaker always asks."),
      p("A merged contact keeps working everywhere: links follow the surviving record, and QuickBooks identity rides along (no more duplicate customers from a renamed job).")),
    sec("The customer portal, from the office side",
      p("Each job's ", h("strong", {}, "🌐 Client Portal"), " form (in the field app) controls what its customer sees: status + photos, drying readings, shared documents, the “who's on the job today” line (sent when the crew's first QuickBooks Time clock-in of the day lands), change-order e-sign, the shared balance with a pay-online link, and — once complete — the warranty, home file, and review ask."),
      p("Customer texts to the company number land on the job's portal thread automatically, and office replies text back when the customer is conversing by SMS. The 📨 unread count on the assistant tracks waiting messages.")),
    sec("📣 Campaigns — texting more than one person",
      p("Pick recipients from the opted-in roster (the ", h("strong", {}, "marketing opt-in"), " on a contact's page is the gate), write the message once — ", h("strong", {}, "{name}"), " personalizes it — and approve the send. Every single text is re-checked on the server before it goes: consent, the campaign's monthly cap, the shared SMS budget, quiet hours, and a refusal to send the same campaign to the same person twice."),
      p("A send that stops partway (budget cap, closed tab) is safe — reopen the same campaign title and it resumes; people who already got it show checked and locked.")),
    sec("💬 Ask the office (the assistant)",
      p("The floating assistant reads the same job records and can draft replies, adjuster emails, portal updates, estimates, invoices, change orders, and receipt logs — every action lands behind a confirm chip; nothing sends or writes without your tap.")));
}

$("#signOutBtn").addEventListener("click", () => {
  if (!confirm("Sign out of the office admin?")) return;
  signOut(); location.reload();
});

/* ---------- boot ---------- */
function boot() {
  if (!SYNC_ENABLED) return renderDashboard();        // local-only fallback
  if (isSignedIn()) {
    startSyncUI();
    route();
    // If an OAuth provider just redirected back with a code, finish the
    // exchange. Google callbacks carry the gm- state prefix; QBO callbacks
    // carry a realmId; TSheets (QB Time) callbacks have neither.
    handleGmailCallback().then((didGmail) => {
      if (didGmail) return renderDashboard();
      handleQboCallback().then((didQbo) => {
        if (didQbo) return renderDashboard();
        handleQbCallback().then((did) => { if (did) renderDashboard(); });
      });
    });
  } else renderLogin();
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

  if (SYNC_ENABLED) body.append(qbPanel(), qboPanel(), gmailPanel(), messagesPanel(), contactsPanel(), campaignsPanel());

  const search = h("input", { type: "search", placeholder: "Search customer, address, claim #…", value: filterText });
  search.addEventListener("input", () => { filterText = search.value.toLowerCase(); paintTable(); });
  body.append(h("div", { class: "atoolbar" },
    h("h1", {}, "Jobs"),
    h("div", { style: "display:flex;gap:10px" }, search,
      h("button", { class: "btn btn--ghost btn--sm", onclick: () => syncNow() }, "↻ Refresh"),
      h("a", { class: "btn btn--ghost btn--sm", href: "#/help", title: "How the Office Admin fits together" }, "❓ Help"))));

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
