/* ============================================================
   Office Admin — one lead, on paper (#/leads/<id>)
   ------------------------------------------------------------
   The lead as it came in, laid out like the field forms' paper packet
   (letterhead, section bars, the small license footer), so 🖨 Print or
   Save as PDF gives a page that can sit in a job folder or go to a crew
   lead: who it is, when it landed (Alaska time), every way to reach
   them, and their own words; then where it stands, the follow-up
   history and the office's notes.

   Each lane writes the lead's notes in one known shape: roybal-lead
   (website form), roybal-web-agent (website chat), services/phone-agent
   createLead (phone). splitNotes() reads that shape back, so what the
   lane wrote and what the office typed into the same field later are
   shown apart. A lead whose notes don't start with a lane's shape
   (hand-entered on the board, or edited at the top) is all office notes.

   The pure half (times, the notes split, the file name) is exported for
   apps/field/test/admin-leads.test.mjs; leads.js owns the page around
   the sheet (loading, the toolbar, print mode).
   ============================================================ */
import { h } from "../../js/core.js";
import { COMPANY } from "../../js/model.js";
import { fmtVisitAt, whoLabel } from "../../board/js/leadvisit.js";

const AK = "America/Anchorage";
// newer ICU puts a narrow no-break space before AM/PM; plain spaces print everywhere
const tidy = (s) => s.replace(/[\u202f\u00a0]/g, " ");
const valid = (iso) => !!iso && Number.isFinite(Date.parse(iso));

/** "Wed, Oct 21, 2026, 9:32 AM AKDT": the full received stamp. */
export function akWhen(iso) {
  if (!valid(iso)) return "";
  return tidy(new Intl.DateTimeFormat("en-US", {
    timeZone: AK, weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso)));
}

/** The Alaska calendar day, YYYY-MM-DD. */
export function akDate(iso) {
  if (!valid(iso)) return "";
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: AK, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Oct 21, 9:32 AM AKDT": the card's stamp, with the year only when it isn't this year. */
export function akShort(iso, now = Date.now()) {
  if (!valid(iso)) return "";
  const otherYear = akDate(iso).slice(0, 4) !== akDate(new Date(now).toISOString()).slice(0, 4);
  return tidy(new Intl.DateTimeFormat("en-US", {
    timeZone: AK, month: "short", day: "numeric", ...(otherYear ? { year: "numeric" } : {}),
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso)));
}

/** When the lead landed: the lane's own stamp, else the row's insert time. */
export const receivedAt = (d, rowCreatedAt) =>
  valid(d && d.createdAt) ? d.createdAt : valid(rowCreatedAt) ? rowCreatedAt : "";

/* the same ids as leads.js CHANNELS; older web leads carry only source "web" */
export const laneOf = (d) => (d && d.channel) || (d && d.source === "web" ? "web-form" : "");
const LANE_LABELS = {
  "web-form": "Website form", "ai-chat": "Website chat", phone: "Phone",
  referral: "Referral", repeat: "Repeat customer", "walk-in": "Walk-in",
};
export function laneLabel(d) {
  const ch = laneOf(d);
  const base = LANE_LABELS[ch] || "Entered by the office";
  return (ch === "ai-chat" || ch === "phone") && d.aiBooked ? base + " (AI receptionist)" : base;
}

/** The lane's part of the notes and the office's part, apart.
    lane: null when the notes don't start the way any lane writes them. */
export function splitNotes(d) {
  const notes = String((d && d.notes) || "").replace(/\r\n/g, "\n");
  const msg = String((d && d.message) || "");
  const ch = laneOf(d);
  let rest = notes;
  let lane = null;
  let m;
  if (ch === "web-form" && rest.startsWith("Website form submission.\n")) {
    // roybal-lead: the header line, then Service / Email / emergency lines, then a blank line and the message
    lane = { service: "", email: "", emergency: false };
    rest = rest.slice("Website form submission.\n".length);
    while ((m = /^(?:Service requested: ([^\n]*)|Email: ([^\n]*)|(⚠️ Marked as an ACTIVE EMERGENCY by the customer\.))\n/.exec(rest))) {
      if (m[1] != null) lane.service = m[1].trim();
      if (m[2] != null) lane.email = m[2].trim();
      if (m[3]) lane.emergency = true;
      rest = rest.slice(m[0].length);
    }
    if (msg && rest.startsWith("\n" + msg)) rest = rest.slice(1 + msg.length);
  } else if (ch === "ai-chat" && (m = /^AI web receptionist \(([^\n]*)\)\.\n/.exec(rest))) {
    // roybal-web-agent: header (the page), emergency line, summary, then the transcript to the end
    lane = { page: m[1], emergency: false, transcript: "" };
    rest = rest.slice(m[0].length);
    if (rest.startsWith("⚠️ ACTIVE EMERGENCY per the visitor.\n")) {
      lane.emergency = true;
      rest = rest.slice("⚠️ ACTIVE EMERGENCY per the visitor.\n".length);
    }
    const marker = "\n\n--- what they told the assistant ---\n";
    const at = rest.indexOf(marker);
    if (at >= 0 && rest.slice(0, at) === msg) {
      lane.transcript = rest.slice(at + marker.length).trim();
      rest = "";
    } else if (msg && rest.startsWith(msg)) rest = rest.slice(msg.length);
  } else if (ch === "phone" && (m = /^AI-booked from a phone call \(([^\n]*)\)\.\n/.exec(rest))) {
    // phone-agent createLead: header (the caller's number), summary, optional Urgency line
    lane = { caller: m[1] === "unknown number" ? "" : m[1], urgency: "" };
    rest = rest.slice(m[0].length);
    if (msg && rest.startsWith(msg)) rest = rest.slice(msg.length);
    if ((m = /^\nUrgency: ([^\n]*)/.exec(rest))) { lane.urgency = m[1].trim(); rest = rest.slice(m[0].length); }
  }
  return { lane, office: rest.trim() };
}

/** Everything the card and the sheet show about one lead. contact: the
    linked contacts row ({ email }) when it was read; its email stands in,
    marked on file, when the lead itself has none. */
export function readLead(d, { createdAt = "", contact = null } = {}) {
  d = d || {};
  const { lane, office } = splitNotes(d);
  const own = String(d.email || "").trim();
  const onFile = String((contact && contact.email) || "").trim();
  return {
    title: d.title || d.customer || "Untitled lead",
    name: String(d.customer || "").trim(),
    lane: laneOf(d),
    laneLabel: laneLabel(d),
    fromLane: !!lane,
    received: receivedAt(d, createdAt),
    phone: String(d.phone || "").trim(),
    email: own || onFile,
    emailOnFile: !own && !!onFile,
    address: String(d.address || "").trim(),
    service: (lane && lane.service) || "",
    emergency: d.priority === "high" || !!(lane && lane.emergency),
    // the customer's words: the lane's message field; a hand-entered lead's notes are its only words
    message: String(d.message || (lane ? "" : office) || "").trim(),
    transcript: (lane && lane.transcript) || "",
    caller: (lane && lane.caller) || "",
    urgency: (lane && lane.urgency) || "",
    page: (lane && lane.page) || "",
    officeNotes: lane ? office : "",
  };
}

/** The PDF's file name (document.title while the sheet is open). */
export function pdfName(d, createdAt) {
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const who = clean((d && (d.customer || d.title)) || "") || "Untitled";
  const day = akDate(receivedAt(d, createdAt));
  const full = `Lead — ${who}` + (day ? ` — ${day}` : "");
  return full.length > 90 ? full.slice(0, 90).trim() : full;
}

const LOST = { price: "Price", "went-with-other": "Went with another contractor", "no-response": "No response", "not-a-fit": "Not a fit", other: "Other" };
const LOG = { inspected: "Inspection / site visit done", "estimate-sent": "Estimate sent", waiting: "Waiting on customer", "no-answer": "No answer / left message", note: "Note" };

function standing(d) {
  if (d.outcome === "won") return "Won" + (d.outcomeAt ? " " + d.outcomeAt : "");
  if (d.outcome === "lost") return "Lost" + (d.lostReason ? " (" + (LOST[d.lostReason] || d.lostReason) + ")" : "") + (d.outcomeAt ? " " + d.outcomeAt : "");
  if ((d.stage || "lead") !== "lead") return "Moved to the board as a job";
  return d.archived ? "Archived" : "Open lead";
}

/* ---------- the sheet ---------- */
const row = (label, value) => (value ? h("div", { class: "ls-f" }, h("div", { class: "ls-l" }, label), h("div", { class: "ls-v" }, value)) : null);
const bar = (text) => h("h3", { class: "ls-bar" }, text);
const box = (text, cls = "") => h("div", { class: "ls-box" + (cls ? " " + cls : "") }, text);

/** One lead as a letter page. now: when it is printed (the footer stamp). */
export function leadSheet(d, { createdAt = "", contact = null, crew = [], now = new Date().toISOString() } = {}) {
  d = d || {};
  const L = readLead(d, { createdAt, contact });
  const sv = d.siteVisit || {};
  const visit = sv.at && sv.status !== "cancelled"
    ? fmtVisitAt(sv.at) + (sv.by ? " with " + whoLabel(sv.by, crew) : "") +
      (sv.doneAt || sv.status === "done" ? " (done)" : sv.confirmedAt ? " (confirmed by text)" : "")
    : "";
  const log = Array.isArray(d.leadLog) ? d.leadLog : [];

  const page = h("article", { class: "ls-page" },
    h("header", { class: "ls-head" },
      h("div", { class: "ls-head__co" },
        h("div", { class: "ls-head__name" }, h("span", { class: "ls-orange" }, "ROYBAL"), " CONSTRUCTION, LLC"),
        h("div", { class: "ls-head__tag" }, COMPANY.tagline)),
      h("div", { class: "ls-head__addr" },
        h("div", {}, COMPANY.address),
        h("div", {}, COMPANY.phone + " | " + COMPANY.email),
        h("div", {}, COMPANY.web))),
    h("div", { class: "ls-title" },
      h("h2", {}, "Lead Record"),
      h("div", { class: "ls-sub" }, L.title)),
    L.emergency ? h("div", { class: "ls-alert" },
      L.lane === "web-form" ? "⚠ The customer marked this an ACTIVE EMERGENCY." : "⚠ Marked as an emergency.") : null,

    bar("Customer"),
    h("div", { class: "ls-grid" },
      row("Name", L.name || "—"),
      row("Phone", L.phone || "—"),
      row(L.emailOnFile ? "Email (on file)" : "Email", L.email || "Not given"),
      row("Address", L.address || "Not given"),
      L.caller ? row("Called from", L.caller) : null),

    bar(L.lane === "web-form" ? "What they sent" : L.fromLane ? "What they asked for" : "The lead"),
    h("div", { class: "ls-grid" },
      row("Received", akWhen(L.received) || "Not recorded"),
      row("Came in by", L.laneLabel),
      row("Service requested", L.service),
      row("Urgency", L.urgency),
      row("Page", L.page)),
    L.lane === "web-form" || L.message
      ? h("div", { class: "ls-f ls-f--wide" },
          h("div", { class: "ls-l" }, L.lane === "web-form" ? "Their message" : L.fromLane ? "Summary" : "Notes"),
          L.message ? box(L.message) : box("No message: the form came in with contact details only.", "ls-box--dim"))
      : null,
    L.transcript ? h("div", { class: "ls-f ls-f--wide" },
      h("div", { class: "ls-l" }, "The conversation"), box(L.transcript, "ls-box--small")) : null,

    bar("Where it stands"),
    h("div", { class: "ls-grid" },
      row("Status", standing(d)),
      row("First contact", d.firstTouchAt ? akWhen(d.firstTouchAt) : "Not yet"),
      row("Site visit", visit),
      row("Next follow-up", d.nextActionAt ? d.nextActionAt + (d.nextAction ? " — " + d.nextAction : "") : ""),
      row("Estimated value", d.estValue ? "$" + Math.round(Number(d.estValue) || 0).toLocaleString() : "")),

    log.length ? bar("Follow-up history") : null,
    log.length ? h("table", { class: "ls-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "What happened"), h("th", {}, "Note"))),
      h("tbody", {}, ...log.map((e) => h("tr", {},
        h("td", {}, (e && e.at) || ""),
        h("td", {}, LOG[e && e.kind] || (e && e.kind) || "Note"),
        h("td", {}, (e && e.note) || ""))))) : null,

    L.officeNotes ? bar("Office notes") : null,
    L.officeNotes ? box(L.officeNotes) : null,

    h("footer", { class: "ls-foot" },
      h("span", {}, ...[COMPANY.name, ...(COMPANY.licenses || [])].map((t, i) => [i ? " · " : null, h("span", { class: "ls-nw" }, t)])),
      h("span", {}, "Lead record, printed " + akWhen(now))));
  return page;
}
