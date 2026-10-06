/* ============================================================
   Roybal Restoration — Office Admin
   Same-origin as the field app, so it shares the same local data
   and Supabase session. The CRM home (docs/CRM_Design.md §13):
   tabbed sections over one hash router — Today, Approvals, Jobs,
   Contacts, Campaigns, ⚙ Settings — plus per-contact pages and help.
   ============================================================ */
import { h, $, clear, Store, fmtDate, daysSince } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { isSignedIn, signIn, signOut, currentEmail } from "../../js/supa.js";
import { startSync, syncNow } from "../../js/sync.js";
import { qbPanel, handleQbCallback } from "./qbconnect.js";
import { qboPanel, handleQboCallback } from "./qboconnect.js";
import { gmailPanel, handleGmailCallback } from "./gmailconnect.js";
import { magicplanPanel } from "./magicplanconnect.js";
import { messagesPanel } from "./messages.js";
import { emailsPanel } from "./emailpanel.js";
import { contactsTab, renderContactPage } from "./contacts.js";
import { campaignsPanel, campaignsBusy } from "./campaigns.js";
import { leadsTab, leadsBusy, leadsResetBusy, refreshLeadsBadge, leadStats, fmtTouch } from "./leads.js";
import { analyticsTab } from "./analytics.js";
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
  // refresh the current section as data arrives — but never clobber an open
  // contact page (its edit form would lose keystrokes to a background sync),
  // the campaigns composer (curation gone, and a rebuilt panel would hide a
  // send loop still running in a detached node — duplicate-SMS bait), an
  // open lead-triage form; the Receipts tab (a return form mid-typing,
  // or a receipt up full screen at a returns counter); or Approvals (an
  // answer in flight — it refreshes itself, approvals.js)
  if (s.state === "synced" && isSignedIn() && !contactRoute() && !campaignsBusy() && !leadsBusy() &&
      !location.hash.startsWith("#/receipts") && !location.hash.startsWith("#/approvals")) route();
}

/* ---------- routes (the CRM home's hash router — doc §13.1) ----------
   ''            → Today: KPIs + company texting
   #/approvals   → everything waiting on the owner's yes, both queues
                   (approvals.js, loaded on first visit)
   #/jobs        → the all-jobs table
   #/receipts    → every job's receipts: search, returns, return windows
                   (receiptlibrary.js, loaded on first visit)
   #/contacts    → the contact directory
   #/campaigns   → CF-5 campaigns
   #/settings    → QB Time / QBO / Gmail / Magicplan connections
   #/c/<id>      → a contact's page (CRM step 5)
   #/help        → how the office admin fits together */
const contactRoute = () => (location.hash.match(/^#\/c\/([0-9a-f-]{36})/i) || [])[1] || null;
const TABS = [
  ["", "Today"], ["#/approvals", "Approvals"], ["#/leads", "Leads"], ["#/jobs", "Jobs"], ["#/receipts", "Receipts"],
  ["#/contacts", "Contacts"], ["#/campaigns", "Campaigns"], ["#/analytics", "Analytics"], ["#/settings", "⚙ Settings"],
];
function sectionOf() {
  const hs = location.hash;
  if (contactRoute()) return "#/contacts";           // a person lives under Contacts
  for (const [href] of TABS) if (href && hs.startsWith(href)) return href;
  return hs.startsWith("#/help") ? "#/help" : "";
}
/* An old cached index.html has no #anav — the app must keep working
   tabless rather than crash (the board's SW-staleness lesson). */
function paintNav() {
  const nav = $("#anav");
  if (!nav) return;
  const show = isSignedIn() || !SYNC_ENABLED;
  nav.hidden = !show;
  if (!show) return;
  const cur = sectionOf();
  clear(nav);
  nav.append(
    ...TABS.map(([href, label]) => {
      const a = h("a", { href: href || "#", class: cur === href ? "is-active" : "" }, label);
      // the unworked-lead count rides the Leads tab (filled by refreshLeadsBadge),
      // what's waiting on the owner rides Approvals (refreshApprovalsBadge)
      if (href === "#/leads") a.append(h("span", { id: "leadsBadge", class: "navbadge", hidden: true }));
      if (href === "#/approvals") a.append(h("span", { id: "approvalsBadge", class: "navbadge", hidden: true }));
      return a;
    }),
    h("a", { href: "#/help", class: "anav__help" + (cur === "#/help" ? " is-active" : ""),
      title: "How the Office Admin fits together" }, "❓ Help"));
  refreshLeadsBadge();
  if (SYNC_ENABLED) approvalsModule().then((m) => m.refreshApprovalsBadge()).catch(() => {});
}
let routeSeq = 0;       // a render that awaited past a newer route() drops its paint
function route() {
  routeSeq++;
  if (!isSignedIn() && SYNC_ENABLED) return renderLogin();
  leadsResetBusy();      // a route change tears down any open triage form
  paintNav();
  const hs = location.hash;
  if (hs.startsWith("#/help")) return renderHelp();
  const cid = contactRoute();
  if (cid) return renderContactPage(view, cid);
  if (hs.startsWith("#/approvals")) return renderApprovalsTab();
  if (hs.startsWith("#/leads")) return renderLeadsTab();
  if (hs.startsWith("#/jobs")) return renderJobs();
  if (hs.startsWith("#/receipts")) return renderReceiptsTab();
  if (hs.startsWith("#/contacts")) return renderContactsTab();
  if (hs.startsWith("#/campaigns")) return renderCampaignsTab();
  if (hs.startsWith("#/analytics")) { clear(view).append(analyticsTab()); return; }
  if (hs.startsWith("#/settings")) return renderSettings();
  renderToday();
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
    sec("The tabs",
      p("The office admin is organized into sections: ", h("strong", {}, "Today"), " — the shop at a glance plus ",
        h("strong", {}, "💬 Company texting"), " (both sides of the toll-free number) and ",
        h("strong", {}, "📧 Job email waiting"), " (the brief's number, now visible — mail handled in Gmail clears itself within 15 minutes); ",
        h("strong", {}, "✅ Approvals"), " — everything waiting on the owner's yes; ", h("strong", {}, "🆕 Leads"),
        " — the inbox for new business; ", h("strong", {}, "Jobs"),
        " — every field job; ", h("strong", {}, "🧾 Receipts"), " — every job's receipts, searchable down to the item, with returns and store return windows; ",
        h("strong", {}, "👤 Contacts"), "; ", h("strong", {}, "📣 Campaigns"), "; ",
        h("strong", {}, "📊 Analytics"), "; and ",
        h("strong", {}, "⚙ Settings"), " — the ", h("strong", {}, "QuickBooks Time"), " (crew hours), ",
        h("strong", {}, "QuickBooks Online"), " (invoices + nightly payment sync), and ", h("strong", {}, "Gmail"),
        " (job-matched email) connections, set once and out of the way."),
      p("Today opens with two stat rows. The lead row: ", h("strong", {}, "unworked leads"), " and ", h("strong", {}, "overdue follow-ups"), " (click either to jump to the inbox), the open ", h("strong", {}, "pipeline value"), " (estimated dollars across open leads), the ", h("strong", {}, "average first touch"), " — how fast someone reaches a new lead, measured from the moment it lands to the first action taken on it — then ", h("strong", {}, "site visits this week"), " and ", h("strong", {}, "estimates out with no answer for 5+ days"), ", the two places bids get stuck. Below it, the ops row: total jobs, active this week, drying in progress, and jobs needing attention (equipment out 7+ days). The Jobs tab lists every field job — click a row to open it in the field app. Search covers customer, address, and claim number.")),
    sec("✅ Approvals — everything waiting on your yes",
      p("Every ask the system is holding for the owner, soonest to expire first: the overdue-invoice reminder emails the morning brief drafts (on the new operations queue when the worker is sending email, otherwise on the text queue as before; a reminder is only ever on one of them), the adjuster emails sent for approval from a job's narrative page, the phases QuickBooks Time wants added to a board job, the texts the text assistant writes, and the new queue's other texts and job-stage moves. Each card shows exactly what would happen (the whole email, every line of it, the text, the phase and its hours), the job, who asked, and when it expires, in Alaska time. An evidence link starts with the site it really opens (“opens mail.google.com — …”), ahead of the name whoever filed it gave it; check that before you click. If an ask is waiting but couldn't be shown, a line under Waiting on you says so: answer it by text, or tell Claude."),
      p(h("strong", {}, "Approve"), " does it after one confirm (the button says what: ", h("strong", {}, "Approve and send"), ", ", h("strong", {}, "Approve and add phase"), "…); ",
        h("strong", {}, "Decline"), " drops it, and on the new queue you can say why. While one answer is on its way its card reads ", h("strong", {}, "Working…"),
        "; the other cards can be answered meanwhile. This sits beside ", h("strong", {}, "text YES 12"),
        ", not instead of it: a card that says “or text YES 12” can be answered either way, and only the first answer counts. That goes for both queues: an ask on the new queue has its own number (the one in the brief's text, or on the job page), and its card offers it the same way. If one number is ever on a waiting ask in each queue at once, neither card offers it, since a text with that number would only say to answer it here."),
      p("Answered asks move to ", h("strong", {}, "Recently decided"), " (the last 48 hours) with what came of them: Sent, Phase added, Phase was already on the board, Queued to send (the new queue hands its emails and texts to the worker: then Sending, Sent, or Couldn't send and why), Declined, or Failed and why. ",
        h("strong", {}, "Approved — waiting to hear how it went"), " (", h("strong", {}, "adding the phase"), " for a board phase) is one still running: a YES text being handled, a tap on another phone, or yours still on its way. Still that way a few minutes later, it reads ",
        h("strong", {}, "Approved, but it never reported back"), ": the answer went in but the send didn't say how it went, so check whether it went out (for a phase, check the board) before approving it again. A line under the list counts asks that expired with no answer in the last week. The number on the tab is what's waiting now. Only the owner's login sees the tab's contents and its count; if the app couldn't check your login just then, the tab says so and offers ", h("strong", {}, "Retry"), "."),
      p("Customer texts go out only during texting hours, Alaska time. Approving one from the text queue outside them leaves it waiting, and the card says when it can go (or that it expires before then, so it won't); a text from the new queue is queued and goes out when they open. An email from the new queue goes out through the worker, which sends email only while it is running with Gmail set up. While it isn't sending, a waiting email's card says approving only queues it, and an approved one reads ", h("strong", {}, "Queued, but email sending is off on the worker"),
        "; it goes out when sending is back. One still waiting 48 hours after it was approved (the worker's limit, unless it was changed) isn't sent late: it reads Couldn't send, with why. If the board can't be reached, nothing is added and the card says to try again in a minute; an ask whose kind was retired before you answered it can only be declined.")),
    sec("🆕 Leads — the inbox for new business",
      p("Every open lead from every lane — website form, AI chat, phone line — newest first, with what the customer actually wrote or said shown in full (no more digging it out of a board chip's notes). The count on the tab is leads ", h("strong", {}, "nobody has touched yet"), "; the morning brief nags about them too."),
      p("Work a lead right from the row: ", h("strong", {}, "📞 Call"), ", ", h("strong", {}, "📅 Site visit"),
        " (date, time, who's going — this makes the visit the follow-up and puts the bid file, with the site-visit packet and estimate, in Field Forms; the row then reads the bid as it moves: 📅 booked → 📐 bid started → 🔍 inspected → 📄 estimate sent; booking opens a ", h("strong", {}, "📱 Confirm by text"), " draft to the customer — edit it, and nothing sends until you tap Send, only between 7 AM and 8 PM Alaska time), ", h("strong", {}, "⏰ Follow-up"),
        " (what + when — it shows on the board card and turns red when overdue), ", h("strong", {}, "✓ Done"),
        " (the appointment or call happened — log what came of it: inspection done, estimate sent, waiting on customer, no answer — with a note and an optional next follow-up; the date-stamped history lives on the lead in both apps), ", h("strong", {}, "✓ Mark contacted"),
        " (stops the response-time clock), ", h("strong", {}, "📝 Notes"),
        " (the same notes the board chip shows — jot “left a voicemail” here and the board picks it up), or ", h("strong", {}, "✕ Lost / spam"),
        " (picks a reason and files it in the board's 🗄 Archive). The first action on a lead stamps its response time. Every change lands on the same board card the crew sees — the board picks it up on its next sync instead of overwriting it."),
      p("Won stays on the board: open the job there and use the 🎯 Lead section to mark it Won when the work is booked.")),
    sec("🧾 Receipts — every receipt, every job",
      p("Every receipt a crew snaps from a job's 🧾 Receipts tile lands here once their phone syncs. Search finds any word on any receipt: an item (",
        h("strong", {}, "3/4 plywood"), ", ", h("strong", {}, "Kilz"), "), a store, a job's address or claim number, a receipt or card number, or a dollar amount. Filter by store, job and date, or show only returns, or receipts that still need a total. Click 🧾 on a row, or ",
        h("strong", {}, "Show at the counter"), " on a receipt, to put the photo full screen; click the photo to zoom."),
      p(h("strong", {}, "Returns: "), "open the receipt and click ", h("strong", {}, "↩ Log a return"),
        ". Enter how many of each item went back (items from another receipt from the same store on the same job can go on the same return), the refund from the slip, and snap or upload the slip, or pick a slip a crew member already snapped as a receipt. The refund comes off the job's receipts total everywhere: the job tile, its costs, the morning brief. The original receipt is never changed. ",
        h("strong", {}, "Change"), " or ", h("strong", {}, "Delete"), " a return from the receipt's page; crews see returns in Field Forms but can't change them. Logging a return switches on once the server requires Field Forms v202 or later on every phone (an older phone would treat a return as an ordinary receipt). That is a one-time setting: once it is on, an older phone stops saving until it updates, which opening Field Forms with signal does."),
      p(h("strong", {}, "Return windows: "), "set each store's window once under ", h("strong", {}, "Return windows"),
        " (Home Depot 90 days, and so on; a store's name covers its branches). When materials from a store ($50 or more on the receipt) reach the last two weeks of the window (the last half of a window under four weeks) with nothing returned, Receipts and Today show ",
        h("strong", {}, "↩ Return windows closing"), " for that job and store. The app can't know what got used, so it asks: take anything left over back and log the return, or click ",
        h("strong", {}, "Nothing left over"), " and that reminder goes away for good."),
      p("At a returns counter with only a phone, the job's 🧾 Receipts tile in Field Forms shows the same photos.")),
    sec("👤 Contacts — the customer directory",
      p("Every customer, adjuster, and lead the business has ever touched, deduplicated automatically across the website, phone line, AI chat, texting, email, and field jobs. Search by name, phone, or email, filter by role with the chips (customers, adjusters, subs…), or click a recent contact — a green ", h("strong", {}, "marketing ✓"), " shows who's opted in to outreach."),
      p("A contact's page shows their identity (edit in place; the ", h("strong", {}, "marketing opt-in"), " checkbox lives here), every job on both the field and board sides, and the whole conversation — texts, emails, portal messages, and phone calls — in one timeline."),
      p(h("strong", {}, "Merge review:"), " every open duplicate suspicion (shared email, same name + address) queues at the top of the Contacts tab — pick ", h("strong", {}, "Keep this one"), " on the entry that should survive, and everything linked to the other — jobs, messages, portal links — moves over; ", h("strong", {}, "Not a match"), " dismisses it. The same review appears on the contact's own page. Exact phone matches merge automatically; anything weaker always asks."),
      p(h("strong", {}, "Value reviews:"), " some entries in that queue are not about two people at all — the person is already known and two spellings of one value came in (a phone typed a different way, an address with the city on it). Those show both values side by side: click the one that is right and ",
        h("strong", {}, "Save"), " — or leave it on the value you already have. Differences that are only formatting no longer reach the queue at all."),
      p("A merged contact keeps working everywhere: links follow the surviving record, and QuickBooks identity rides along (no more duplicate customers from a renamed job).")),
    sec("The customer portal, from the office side",
      p("Each job's ", h("strong", {}, "🌐 Client Portal"), " form (in the field app) controls what its customer sees: status + photos, drying readings, shared documents, the “who's on the job today” line (sent when the crew's first QuickBooks Time clock-in of the day lands), change-order e-sign, the shared balance with a pay-online link, and — once complete — the warranty, home file, and review ask."),
      p("Customer texts to the company number land on the job's portal thread automatically, and office replies text back when the customer is conversing by SMS. The 📨 unread count on the assistant tracks waiting messages.")),
    sec("📣 Campaigns — texting more than one person",
      p("Pick recipients from the opted-in roster (the ", h("strong", {}, "marketing opt-in"), " on a contact's page is the gate), write the message once — ", h("strong", {}, "{name}"), " personalizes it — and approve the send. Every single text is re-checked on the server before it goes: consent, the campaign's monthly cap, the shared SMS budget, quiet hours, and a refusal to send the same campaign to the same person twice."),
      p("A send that stops partway (budget cap, closed tab) is safe — the ", h("strong", {}, "campaign history"), " lists every past send with its counts, and ", h("strong", {}, "Reopen"), " resumes one by name; people who already got it show unchecked and locked.")),
    sec("📊 Analytics — how the business is actually doing",
      p("Pick a time range up top and every card follows it. ", h("strong", {}, "Conversion by channel"),
        " shows the win rate where it can be known (only leads marked Won or Lost count); ", h("strong", {}, "Why we lose"),
        " tallies the lost reasons; ", h("strong", {}, "Speed to lead"), " averages how fast someone touches a new lead. ",
        h("strong", {}, "Estimate vs actual"), " compares each completed job's estimated hours (board editor) against clocked QuickBooks Time hours — red ran over, teal came in under — and ",
        h("strong", {}, "Bid vs contract"), " does the same in dollars for won work (a contract value Won copied from the estimate is left out until someone types the signed figure). ",
        h("strong", {}, "Site visit → estimate out"), " is the median number of days between marking the visit done and the estimate going to the customer."),
      p("Every chart has a ", h("strong", {}, "table"), " toggle with the exact numbers. The ×factors up top (actual ÷ estimate) are the honest correction on your estimating — job-cost profitability itself stays in QuickBooks, where it already lives for QBO projects.")),
    sec("💬 Ask the office (the assistant)",
      p("The floating assistant reads the same job records and can draft replies, adjuster emails, portal updates, estimates, invoices, change orders, and receipt logs — every action lands behind a confirm chip; nothing sends or writes without your tap."),
      p("When it drafts or reviews an estimate, it also knows your historical accuracy (the Analytics ×factors, once 5+ completed jobs back them) and will ", h("strong", {}, "suggest"), " an adjustment with the sample size — it never silently changes your numbers.")));
}

$("#signOutBtn").addEventListener("click", () => {
  if (!confirm("Sign out of the office admin?")) return;
  signOut(); location.reload();
});

/* ---------- boot ---------- */
function boot() {
  if (!SYNC_ENABLED) return route();                  // local-only fallback still gets tabs
  if (isSignedIn()) {
    startSyncUI();
    route();
    // If an OAuth provider just redirected back with a code, finish the
    // exchange and land on ⚙ Settings so the freshly connected panel is the
    // thing on screen. Google callbacks carry the gm- state prefix; QBO
    // callbacks carry a realmId; TSheets (QB Time) callbacks have neither.
    const toSettings = () => { if (sectionOf() === "#/settings") route(); else location.hash = "#/settings"; };
    handleGmailCallback().then((didGmail) => {
      if (didGmail) return toSettings();
      handleQboCallback().then((didQbo) => {
        if (didQbo) return toSettings();
        handleQbCallback().then((did) => { if (did) toSettings(); });
      });
    });
  } else renderLogin();
}

/* ---------- login ---------- */
function renderLogin() {
  $("#acctEmail").textContent = "";
  $("#signOutBtn").hidden = true;
  const nav = $("#anav"); if (nav) nav.hidden = true;
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

/* ---------- shared job summaries ---------- */
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

/* ---------- Today ('') — KPIs + company texting; CRM stats join in step 15 ---------- */
async function renderToday() {
  const my = routeSeq;
  const projects = await Store.all();
  if (my !== routeSeq) return;
  const rows = projects.map(jobSummary);
  const body = clear(view);

  const active = rows.filter((r) => r.updated && daysSince(r.updated) <= 7).length;
  const drying = rows.filter((r) => r.drying > 0).length;
  const attention = rows.filter((r) => r.attention).length;

  // the CRM row (doc §13.4) leads; the ops KPIs stay right below it.
  // Placeholder first, filled when the lead fetch lands — Today must not
  // wait on the network to paint (the messagesPanel rule).
  const crmRow = h("div", { class: "kpis", hidden: true });
  body.append(crmRow, h("div", { class: "kpis" },
    kpi(rows.length, "Total jobs"),
    kpi(active, "Active (last 7 days)"),
    kpi(drying, "Drying in progress"),
    kpi(attention, "Need attention (7-day equip.)", attention > 0)));

  if (SYNC_ENABLED) {
    leadStats().then((s) => {
      if (!s || !crmRow.isConnected) return;      // fetch failed, or Today re-rendered
      const toLeads = () => { location.hash = "#/leads"; };
      crmRow.append(
        kpi(s.unworked, "Unworked leads", s.unworked > 0, toLeads),
        kpi(s.overdue, "Overdue follow-ups", s.overdue > 0, toLeads),
        kpi(s.pipeline ? "$" + Math.round(s.pipeline).toLocaleString() : "—", "Pipeline value", false, toLeads),
        kpi(fmtTouch(s.avgTouchMs), "Avg first touch"),
        // where bids get stuck (docs/Lead_Bid_Workflow_Design.md §5.1)
        kpi(s.visitsThisWeek, "Site visits this week", false, toLeads),
        kpi(s.estimatesWaiting, "Estimates out, no answer > 5d", s.estimatesWaiting > 0, toLeads));
      crmRow.hidden = false;
    });
    // ↩ "Home Depot on 1192 Bemis Ct — return window closes in 10 days"
    // (receipts library; only shows when a window is closing)
    const returnsSlot = h("div");
    body.append(returnsSlot, messagesPanel(), emailsPanel());
    receiptsModule().then((m) => m.fillReturnsToday(returnsSlot, projects)).catch(() => {});
  }
}

function kpi(n, label, attn, onclick) {
  return h("div", { class: "kpi" + (attn ? " attn" : ""), ...(onclick ? { onclick, style: "cursor:pointer" } : {}) },
    h("div", { class: "kpi__n" }, String(n)),
    h("div", { class: "kpi__l" }, label));
}

/* ---------- Jobs (#/jobs) — the all-jobs table ---------- */
let filterText = "";
async function renderJobs() {
  const my = routeSeq;
  const projects = await Store.all();
  if (my !== routeSeq) return;
  const rows = projects.map(jobSummary);
  const body = clear(view);

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

/* ---------- tabs loaded on first visit (a failed load is a fresh deploy
   meeting a stale cached page) ---------- */
function lazyTab(prefix, name, load, open) {
  load().then((m) => {
    if (!location.hash.startsWith(prefix)) return;
    open(m).catch((e) => {
      clear(view).append(h("div", { class: "empty" }, h("p", {}, `Couldn't open ${name}: ` + String(e && e.message || e))));
    });
  }).catch(() => {
    if (!location.hash.startsWith(prefix)) return;
    clear(view).append(h("div", { class: "empty" },
      h("p", {}, `The office app just updated. Reload to open ${name}.`),
      h("button", { class: "btn btn--primary btn--sm", style: "margin:8px auto 0", onclick: () => location.reload() }, "Reload")));
  });
}

/* ---------- ✅ Approvals (#/approvals) — approvals.js ---------- */
function approvalsModule() { return import("./approvals.js"); }
function renderApprovalsTab() {
  lazyTab("#/approvals", "Approvals", approvalsModule, (m) => m.renderApprovals(view));
}

/* ---------- 🧾 Receipts (#/receipts) — receiptlibrary.js ---------- */
function receiptsModule() { return import("./receiptlibrary.js"); }
function renderReceiptsTab() {
  lazyTab("#/receipts", "Receipts", receiptsModule, (m) => m.renderReceipts(view));
}

/* ---------- Leads (#/leads) — the inbox lives in leads.js ---------- */
function renderLeadsTab() {
  clear(view).append(leadsTab());
}

/* ---------- Contacts (#/contacts) — full tab lives in contacts.js ---------- */
function renderContactsTab() {
  clear(view).append(contactsTab());
}

/* ---------- Campaigns (#/campaigns) ---------- */
function renderCampaignsTab() {
  const body = clear(view);
  body.append(h("div", { class: "atoolbar" }, h("h1", {}, "Campaigns")));
  if (!SYNC_ENABLED) { body.append(h("p", { class: "muted" }, "Campaigns need the cloud connection.")); return; }
  const panel = campaignsPanel();
  const head = panel.querySelector("h2");   // the card's own 📣 heading is the page h1 now
  if (head) head.remove();
  body.append(panel);
}

/* ---------- ⚙ Settings (#/settings) — the set-once connections ---------- */
function renderSettings() {
  const body = clear(view);
  body.append(h("div", { class: "atoolbar" }, h("h1", {}, "Settings & connections")));
  if (!SYNC_ENABLED) { body.append(h("p", { class: "muted" }, "Cloud sync is disabled in this build — nothing to connect.")); return; }
  body.append(
    h("p", { class: "muted", style: "font-size:13px;margin:0 0 4px" },
      "Set-once connections. Each panel shows its status; reconnect from here if a password change breaks one."),
    qbPanel(), qboPanel(), gmailPanel(), magicplanPanel());
  const returnsSlot = h("div");
  body.append(returnsSlot);
  receiptsModule().then((m) => m.fillSettingsCard(returnsSlot)).catch(() => {});
}

boot();
