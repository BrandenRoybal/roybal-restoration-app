/* ============================================================
   Job Board — 📅 Site visit on a lead (pure helpers)
   ------------------------------------------------------------
   The office half of docs/Lead_Bid_Workflow_Design.md (§5.1–5.2).
   Scheduling a site visit writes data.siteVisit on the lead tile;
   the field app (boardpush.js isBidLead) sees siteVisit.at and makes
   the bid file on its next jobs-list load. Everything here is pure —
   Node-tested in test/leadvisit.test.mjs — and the Office Admin's
   Leads Inbox mirrors the same shapes (apps/admin/js/leads.js).

   Shape (all optional; a tile without it renders exactly as before):
     siteVisit: { at: "2026-09-26T14:00" | "2026-09-26",   // local ISO
                  by: "<email>", status: "scheduled"|"done"|"cancelled",
                  doneAt: "2026-09-26" }
   Ownership (design §2.5): office sets at/by/status; the field
   stamps done/doneAt.
   ============================================================ */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const obj = (v) => (v && typeof v === "object" ? v : {});

/* "2026-09-26T14:00" → "Thu 9/26 2:00 PM"; "2026-09-26" → "Thu 9/26".
   Parsed by hand so the appointment prints as typed, in any zone. */
export function fmtVisitAt(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(at || ""));
  if (!m) return "";
  const [, y, mo, da, hh, mm] = m;
  const dow = DAYS[new Date(Number(y), Number(mo) - 1, Number(da)).getDay()];
  let s = `${dow} ${Number(mo)}/${Number(da)}`;
  if (hh != null) {
    const H = Number(hh);
    s += ` ${((H + 11) % 12) + 1}:${mm} ${H < 12 ? "AM" : "PM"}`;
  }
  return s;
}

/* the date / time halves of siteVisit.at, for the editor's inputs */
export const visitDate = (at) => (/^\d{4}-\d{2}-\d{2}/.exec(String(at || "")) || [""])[0];
export const visitTime = (at) => (/[T ](\d{2}:\d{2})/.exec(String(at || "")) || ["", ""])[1];

/* who's going, as a name: the crew roster's name for that login email,
   else the email's first part capitalized ("branden@…" → "Branden") */
export function whoLabel(by, crew = []) {
  const s = String(by || "").trim();
  if (!s) return "";
  const m = (crew || []).find((c) => c && String(c.email || "").trim().toLowerCase() === s.toLowerCase());
  if (m && m.name) return m.name;
  const local = s.includes("@") ? s.split("@")[0] : s;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/* the people a visit can be assigned to: active roster members with a
   login email, plus the signed-in user (always first, even if they are
   not on the roster — the owner often isn't) */
export function visitPeople(crew, me) {
  const out = [];
  const seen = new Set();
  const add = (email, name) => {
    const e = String(email || "").trim();
    if (!e || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    out.push({ email: e, name: name || whoLabel(e) });
  };
  if (me) add(me, whoLabel(me, crew));
  for (const c of [...(crew || [])].filter((c) => c && c.active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))) add(c.email, c.name);
  return out;
}

/* the patch that books (or re-books) a visit. A new time starts a fresh
   visit — any old done stamp belonged to the previous one. The follow-up
   becomes the visit unless the office already typed a different one for
   an earlier date. */
export function scheduleVisitPatch(d, { date, time, by }) {
  const at = time ? `${date}T${time}` : date;
  const sv = obj(d && d.siteVisit);
  const same = sv.at === at && sv.status !== "cancelled";
  const siteVisit = same ? { ...sv, by } : { at, by, status: "scheduled" };
  const patch = { siteVisit };
  const na = d && d.nextActionAt;
  const keepFollowUp = na && d.nextAction && d.nextAction !== "Site visit" && na < date;
  if (!keepFollowUp) Object.assign(patch, { nextAction: "Site visit", nextActionAt: date });
  return patch;
}

/* the patch that calls a visit off. Clears siteVisit.at so a tile with no
   file yet stops qualifying as a bid (a file that already exists stays —
   it's an ordinary job file), and drops the follow-up if it was the visit. */
export function cancelVisitPatch(d) {
  const sv = obj(d && d.siteVisit);
  const patch = { siteVisit: { status: "cancelled", at: "", by: sv.by || "", was: sv.at || "" } };
  if (d && d.nextAction === "Site visit") Object.assign(patch, { nextAction: "", nextActionAt: "" });
  return patch;
}

/* the card chip: "📅 9/26", amber the day of, red once the day has passed
   and nobody marked it done. null when there's no live visit. */
export function visitChip(d, today) {
  const sv = obj(d && d.siteVisit);
  const date = visitDate(sv.at);
  if (!date || sv.status === "cancelled") return null;
  const done = sv.status === "done" || !!sv.doneAt;
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  const text = (done ? "🔍 " : "📅 ") + `${Number(m[1])}/${Number(m[2])}`;
  const tone = done ? "" : date < today ? "late" : date === today ? "due" : "";
  return { text, tone, title: (done ? "Site visit done " : "Site visit ") + fmtVisitAt(sv.at) };
}

const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const shortDate = (iso) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
};

/* the latest "📄 Estimate sent" moment: the field's stamp (PR 3) or, until
   then, the newest hand-logged estimate-sent entry */
export function estimateSentOn(d) {
  if (d && d.estimateSentAt) return String(d.estimateSentAt).slice(0, 10);
  const log = (d && Array.isArray(d.leadLog) ? d.leadLog : []).filter((e) => e && e.kind === "estimate-sent");
  return log.length ? String(log[log.length - 1].at || "").slice(0, 10) : "";
}

/* the funnel, in order — each step that has happened, as chip text:
   📅 visit → 📐 bid started → 🔍 inspected → 📄 estimate sent */
export function bidSteps(d, crew = []) {
  const x = d || {};
  const sv = obj(x.siteVisit);
  const steps = [];
  if (sv.at && sv.status !== "cancelled" && !sv.doneAt && sv.status !== "done") {
    const who = whoLabel(sv.by, crew);
    steps.push({ id: "visit", text: "📅 " + fmtVisitAt(sv.at) + (who ? " · " + who : "") + (sv.confirmedAt ? " · 📱 confirmed" : "") });
  }
  if (x.fieldJobId || x.bidStartedAt) steps.push({ id: "bid", text: "📐 Bid started" });
  if (sv.doneAt || sv.status === "done") steps.push({ id: "inspected", text: "🔍 Inspected " + shortDate(sv.doneAt) });
  const sent = estimateSentOn(x);
  if (sent) {
    const bits = [x.estimateNo, x.estimateTotal ? money(x.estimateTotal) : ""].filter(Boolean).join(" · ");
    steps.push({ id: "sent", text: "📄 " + (bits ? bits + " " : "Estimate ") + "sent " + shortDate(sent) });
  }
  return steps;
}

const addDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
};

/* the two Today numbers that say where bids are stuck (design §5.1):
   visits booked today through the next six days, and estimates that went
   out more than 5 days ago with no answer (lead still open) */
export function bidStats(leads, today) {
  const weekEnd = addDays(today, 6);
  const stale = addDays(today, -5);
  let visitsThisWeek = 0, estimatesWaiting = 0;
  for (const d of leads || []) {
    const sv = obj(d && d.siteVisit);
    const date = visitDate(sv.at);
    if (date && sv.status !== "cancelled" && !sv.doneAt && sv.status !== "done" && date >= today && date <= weekEnd) visitsThisWeek++;
    const sent = estimateSentOn(d);
    const heardBack = sent && (Array.isArray(d.leadLog) ? d.leadLog : [])
      .some((e) => e && e.kind !== "estimate-sent" && String(e.at || "") > sent);
    if (sent && sent < stale && !heardBack) estimatesWaiting++;
  }
  return { visitsThisWeek, estimatesWaiting };
}

/* ---------- ✓ Won → contract value (design §3 step 10, §7 row 4) ----------
   A lead won with no contract value typed gets the estimate the field
   sent (estimateTotal, PR 3), or failing that the field's own estValue.
   It is stamped contractValueSource "estimate" so the bid-accuracy chart
   (admin analytics) and the field's dollar calibration skip it: comparing
   an estimate against itself would read as a perfect bid. Typing the real
   signed figure in the editor clears the stamp. null = nothing to fill. */
export function wonContractFill(d) {
  const x = d || {};
  if (Number(x.contractValue) > 0) return null;
  const est = Number(x.estimateTotal) > 0 ? Number(x.estimateTotal)
    : x.estValueSource === "field" && Number(x.estValue) > 0 ? Number(x.estValue) : 0;
  return est ? { contractValue: Math.round(est * 100) / 100, contractValueSource: "estimate" } : null;
}

/* ---------- time to estimate (design §3, "falls out for free") ----------
   Calendar days from the site visit to the estimate going out. Visit day:
   siteVisit.doneAt, else the first hand-logged "inspected" entry. Sent
   day: the first estimate-sent entry on or after that visit (hand-logged
   or the field's own, PR 3), else estimateSentAt. null when either side is
   missing, so the tile only averages leads that have both. */
export function daysToEstimate(d) {
  const x = d || {};
  const log = Array.isArray(x.leadLog) ? x.leadLog.filter(Boolean) : [];
  const day = (s) => String(s || "").slice(0, 10);
  const firstOf = (kind, from = "") => log.filter((e) => e.kind === kind && day(e.at) && day(e.at) >= from)
    .map((e) => day(e.at)).sort()[0] || "";
  const visit = day(obj(x.siteVisit).doneAt) || firstOf("inspected");
  if (!visit) return null;
  const sent = firstOf("estimate-sent", visit) || (day(x.estimateSentAt) >= visit ? day(x.estimateSentAt) : "");
  if (!sent) return null;
  const [a, b] = [visit, sent].map((s) => { const [y, m, dd] = s.split("-").map(Number); return Date.UTC(y, m - 1, dd); });
  return Math.round((b - a) / 86400000);
}

/* ---------- 📱 visit confirmation text (design §7 row 5) ----------
   The office reads and edits it, then taps Send — that tap IS the
   approval. Sent through roybal-notify kind "reminder": a customer kind,
   so the 7am–8pm Alaska quiet-hours guard applies server-side. */
export function visitConfirmText(d, crew = []) {
  const x = d || {};
  const sv = obj(x.siteVisit);
  const first = String(x.customer || x.title || "").trim().split(/[\s—-]+/)[0] || "";
  const when = fmtVisitAt(sv.at);
  const m = /^(\w+) (\d+\/\d+)(?: (.+))?$/.exec(when);
  const whenText = m ? `${m[1]} ${m[2]}` + (m[3] ? ` at ${m[3]}` : "") : when;
  const who = whoLabel(sv.by, crew).split(" ")[0];
  const where = String(x.address || "").trim();
  return `Hi${first ? " " + first : ""}, this is Roybal Construction confirming your site visit`
    + (where ? ` at ${where}` : "") + (whenText ? ` on ${whenText}` : "") + "."
    + (who ? ` ${who} will be there.` : "")
    + " Reply here or call 907-371-9868 if that time doesn't work.";
}

/* after a confirmation goes out: stamp the visit + a line in the lead log */
export function visitConfirmedPatch(d, at, entryId) {
  const x = d || {};
  const sv = obj(x.siteVisit);
  return {
    siteVisit: { ...sv, confirmedAt: at },
    leadLog: [...(Array.isArray(x.leadLog) ? x.leadLog : []), {
      id: entryId, at: String(at).slice(0, 10), kind: "note",
      note: "Site visit confirmation texted" + (sv.at ? " (" + fmtVisitAt(sv.at) + ")" : ""), action: "",
    }],
  };
}
