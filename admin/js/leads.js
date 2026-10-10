/* ============================================================
   Office Admin — 🆕 Leads Inbox (CRM home, docs/CRM_Design.md §13.3)
   ------------------------------------------------------------
   Every open lead across every channel, newest first, with the
   customer's actual message IN THE OPEN — the thing that used to
   live only inside the board chip's notes textarea. One-tap triage
   per row: set a follow-up, book the 📅 site visit (the lead → bid
   step, docs/Lead_Bid_Workflow_Design.md §5.1 — the field app makes the
   bid file once siteVisit.at is set), log what happened when it did
   (✓ Done → data.leadLog), mark contacted, call, mark lost.

   Writes ride coordination_job_patch (migrations 230+246): the
   rev-bumping shallow merge the board's whole-blob guard ADOPTS
   instead of clobbering. Every triage action stamps firstTouchAt
   once — that's the time-to-first-touch metric ("response time IS
   the product").

   unworked = stage lead, no outcome, no follow-up set, never touched.
   That count badges the Leads tab (refreshLeadsBadge) and the same
   definition feeds the morning brief's 🆕 line (roybal-brief).
   ============================================================ */
import { h, clear, toast, uid } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest, currentEmail } from "../../js/supa.js";
import { visitDate, visitTime, visitPeople, scheduleVisitPatch, cancelVisitPatch,
  bidSteps, bidStats, visitChip, visitConfirmText, visitConfirmedPatch } from "../../board/js/leadvisit.js";
import { sendViaCompany, smsHref } from "../../js/sms.js";

/* mirrors apps/board/js/board.js — same ids, same colors, same labels */
const CHANNELS = [
  { id: "web-form", label: "Web form", color: "#5b6b80" },
  { id: "ai-chat",  label: "AI chat",  color: "#1f9d55" },
  { id: "phone",    label: "Phone",    color: "#f26a21" },
  { id: "referral", label: "Referral", color: "#8a6fb0" },
  { id: "repeat",   label: "Repeat",   color: "#1c5fb0" },
  { id: "walk-in",  label: "Walk-in",  color: "#2f8f8f" },
];
const LOST_REASONS = [
  { id: "price",           label: "Price" },
  { id: "went-with-other", label: "Went with another contractor" },
  { id: "no-response",     label: "No response" },
  { id: "not-a-fit",       label: "Not a fit" },
  { id: "other",           label: "Other" },
];
/* mirrors apps/board/js/board.js LEAD_LOG_KINDS — same ids, same labels.
   ✓ Done appends to data.leadLog; the board modal shows the full history. */
const LEAD_LOG_KINDS = [
  { id: "inspected",     icon: "🔍", short: "Inspected",           label: "Inspection / site visit done" },
  { id: "estimate-sent", icon: "📄", short: "Estimate sent",       label: "Estimate sent" },
  { id: "waiting",       icon: "⏳", short: "Waiting on customer", label: "Waiting on customer" },
  { id: "no-answer",     icon: "📵", short: "No answer",           label: "No answer / left message" },
  { id: "note",          icon: "📝", short: "Note",                label: "Other / note" },
];
const leadLogKind = (id) => LEAD_LOG_KINDS.find((k) => k.id === id) || { icon: "📝", short: id || "note", label: id || "note" };
const channelInfo = (d) => CHANNELS.find((c) => c.id === (d.channel || (d.source === "web" ? "web-form" : ""))) || null;

const isOpenLead = (d) => (d.stage || "lead") === "lead" && !d.isMilestone && !d.outcome && !d.archived;
const isUnworked = (d) => isOpenLead(d) && !d.nextActionAt && !d.firstTouchAt;

const digits = (p) => String(p || "").replace(/[^\d+]/g, "");
const localToday = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
function age(iso) {
  const ms = Date.now() - Date.parse(iso || "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/* an open triage form or an in-flight patch must survive the sync repaint —
   the campaignsBusy() rule, same reason */
let busy = false;
export const leadsBusy = () => busy;
/* a route change tears down any open form, so the latch must not outlive it —
   otherwise one abandoned follow-up form silences the sync repaint for good */
export const leadsResetBusy = () => { busy = false; };

/* ---------- the guarded write path (230 + 246) ---------- */
async function patchLead(id, patch) {
  const res = await rest("rpc/coordination_job_patch", {
    method: "POST", body: JSON.stringify({ p_id: id, p_patch: patch }),
  });
  if (!res.ok) throw new Error("save failed (" + res.status + ")");
  const data = await res.json();
  if (!data) throw new Error("refused — office role required, or the lead is gone");
  return data;                       // the merged blob, rev already bumped
}
/* stamp first touch exactly once, riding along on whatever action came first */
const touch = (d) => (d.firstTouchAt ? {} : { firstTouchAt: new Date().toISOString() });

/* every lead-stage blob, open or archived — archived lost leads still carry
   the first-touch stamps the response-time average needs */
async function fetchLeadData() {
  const res = await rest("coordination_jobs?deleted=eq.false&data->>stage=eq.lead&select=data&limit=200", { method: "GET" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).map((r) => r.data || {});
}

/* the crew roster, for the site-visit "who" picker and names on the chips.
   Cached per page load; a failed read just means emails instead of names. */
let crewCache = null;
async function fetchCrew() {
  if (crewCache) return crewCache;
  try {
    const res = await rest("crew_members?select=data&deleted=is.false", { method: "GET" });
    crewCache = res.ok ? (await res.json()).map((r) => r.data).filter(Boolean) : [];
  } catch (_) { crewCache = []; }
  return crewCache;
}

/* ---------- nav badge: the unworked count ---------- */
let badgeCache = { n: 0, at: 0 };
export async function refreshLeadsBadge() {
  const el = document.getElementById("leadsBadge");
  if (!el || !SYNC_ENABLED) return;
  if (Date.now() - badgeCache.at < 20_000) { paintBadge(el, badgeCache.n); return; }
  try {
    badgeCache = { n: (await fetchLeadData()).filter(isUnworked).length, at: Date.now() };
    paintBadge(el, badgeCache.n);
  } catch (_) { /* offline — leave whatever the badge shows */ }
}
const paintBadge = (el, n) => { el.hidden = !n; el.textContent = String(n); };

/* ---------- Today's CRM stat row (doc §13.4) ---------- */
export async function leadStats() {
  let all;
  try { all = await fetchLeadData(); } catch (_) { return null; }
  const open = all.filter(isOpenLead);
  const today = localToday();
  // avg time-to-first-touch over every lead that has both stamps — archived
  // and lost included, they're evidence of how fast the phone got picked up
  const touched = all
    .map((d) => Date.parse(d.firstTouchAt || "") - Date.parse(d.createdAt || ""))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  return {
    open: open.length,
    unworked: open.filter(isUnworked).length,
    overdue: open.filter((d) => d.nextActionAt && d.nextActionAt < today).length,
    pipeline: open.reduce((s, d) => s + (Number(d.estValue) || 0), 0),
    avgTouchMs: touched.length ? touched.reduce((s, x) => s + x, 0) / touched.length : null,
    ...bidStats(open, today),          // visitsThisWeek, estimatesWaiting
  };
}
export function fmtTouch(ms) {
  if (ms == null) return "—";
  const m = Math.round(ms / 60000);
  if (m < 90) return m + "m";
  if (m < 48 * 60) return (m / 60).toFixed(m < 600 ? 1 : 0) + "h";
  return Math.round(m / 1440) + "d";
}

/* ---------- the tab ---------- */
export function leadsTab() {
  const box = h("div");
  box.append(h("div", { class: "atoolbar" }, h("h1", {}, "Leads")));
  if (!SYNC_ENABLED) { box.append(h("p", { class: "muted" }, "Leads need the cloud connection.")); return box; }
  const stats = h("div", { class: "muted", style: "font-size:13px;margin:-6px 0 10px" });
  const host = h("div");
  box.append(stats, host);
  host.append(h("p", { class: "muted" }, "Loading…"));

  (async () => {
    let rows = [];
    let crew = [];
    try {
      crew = await fetchCrew();
      const res = await rest("coordination_jobs?deleted=eq.false&data->>stage=eq.lead&select=id,data&order=created_at.desc&limit=100", { method: "GET" });
      if (!res.ok) throw new Error(String(res.status));
      rows = (await res.json()).map((r) => ({ id: r.id, d: r.data || {} })).filter((r) => isOpenLead(r.d));
    } catch (_) {
      clear(host).append(h("div", { class: "card" },
        h("p", { class: "muted" }, "Couldn't load leads — check your connection and try again.")));
      return;
    }
    const unworked = rows.filter((r) => isUnworked(r.d)).length;
    badgeCache = { n: unworked, at: Date.now() };
    const el = document.getElementById("leadsBadge");
    if (el) paintBadge(el, unworked);
    stats.textContent = rows.length
      ? `${rows.length} open lead${rows.length === 1 ? "" : "s"}` + (unworked ? ` · ${unworked} nobody's touched` : "")
      : "";
    clear(host);
    if (!rows.length) {
      host.append(h("div", { class: "card" }, h("p", { class: "muted" },
        "No open leads. New web-form, AI-chat, and phone leads land here the moment they come in — and on the board's Lead column at the same time.")));
      return;
    }
    for (const r of rows) host.append(leadRow(r.id, r.d, crew));
  })();
  return box;
}

function leadRow(id, d, crew) {
  const row = h("div", { class: "card lrow" + (isUnworked(d) ? " lrow--new" : "") });
  paintRow(row, id, d, crew);
  return row;
}

function paintRow(row, id, d, crew = []) {
  clear(row);
  row.className = "card lrow" + (isUnworked(d) ? " lrow--new" : "");
  const ch = channelInfo(d);

  /* header: who · channel · priority · age */
  row.append(h("div", { class: "lhead" },
    h("strong", { style: "font-size:14.5px" }, d.title || d.customer || "Untitled lead"),
    ch ? h("span", { class: "lchip", style: `border-color:${ch.color};color:${ch.color}` }, ch.label) : null,
    d.priority === "high" ? h("span", { class: "lchip lchip--hot" }, "⚠ emergency") : null,
    isUnworked(d) ? h("span", { class: "lchip lchip--new" }, "new") : null,
    h("span", { class: "muted", style: "margin-left:auto;font-size:12px;white-space:nowrap" }, age(d.createdAt))));

  /* the customer's message, in the open (message field; older cards: notes) */
  const text = String(d.message || d.notes || "").trim();
  if (text) {
    const short = text.length > 420;
    const msg = h("div", { class: "lmsg" }, short ? text.slice(0, 420) + "…" : text);
    row.append(msg);
    if (short) {
      const more = h("a", { href: "#", class: "lmore", onclick: (e) => { e.preventDefault(); msg.textContent = text; more.remove(); } }, "show all");
      row.append(more);
    }
  }

  /* contact facts */
  const facts = [
    d.phone ? h("a", { href: "tel:" + digits(d.phone) }, d.phone) : null,
    d.address || null,
    d.estValue ? "~" + money(d.estValue) : null,
    d.contactId ? h("a", { href: "#/c/" + d.contactId }, "contact page") : null,
  ].filter(Boolean);
  const factLine = h("div", { class: "muted", style: "font-size:12.5px;margin-top:6px" });
  facts.forEach((f, i) => { if (i) factLine.append(" · "); factLine.append(f); });
  if (facts.length) row.append(factLine);

  /* current state chips */
  const state = h("div", { class: "lstate" });
  /* the bid funnel: 📅 visit → 📐 bid started → 🔍 inspected → 📄 sent */
  const vc = visitChip(d, localToday());
  const steps = bidSteps(d, crew);
  for (const st of steps) {
    const late = st.id === "visit" && vc && vc.tone === "late";
    state.append(h("span", { class: "lchip" + (late ? " lchip--late" : ""),
      title: late ? "The visit day has passed and nobody marked it done — log it with ✓ Done, or re-book" : "" },
      st.text + (late ? " (passed)" : "")));
  }
  if (d.nextActionAt && !(d.nextAction === "Site visit" && vc && d.nextActionAt === visitDate(d.siteVisit.at))) {
    const overdue = d.nextActionAt < localToday();
    state.append(h("span", { class: "lchip" + (overdue ? " lchip--late" : "") },
      "⏰ " + d.nextActionAt + (d.nextAction ? " — " + d.nextAction : "") + (overdue ? " (overdue)" : "")));
  }
  const lastLog = (d.leadLog || [])[(d.leadLog || []).length - 1];
  // a funnel chip already says it — don't repeat "Inspected" / "Estimate sent"
  const saidByFunnel = lastLog && ((lastLog.kind === "estimate-sent" && steps.some((st) => st.id === "sent"))
    || (lastLog.kind === "inspected" && steps.some((st) => st.id === "inspected")));
  if (lastLog && !saidByFunnel) {
    const k = leadLogKind(lastLog.kind);
    const note = String(lastLog.note || "");
    state.append(h("span", { class: "lchip lchip--dim", title: note },
      k.icon + " " + k.short + " · " + (lastLog.at || "") + (note ? " — " + (note.length > 60 ? note.slice(0, 60) + "…" : note) : "")));
  }
  if (d.firstTouchAt && !d.nextActionAt && !lastLog) state.append(h("span", { class: "lchip lchip--dim" }, "✓ touched"));
  if (state.childNodes.length) row.append(state);

  /* triage */
  const actions = h("div", { class: "lactions" });
  const formHost = h("div");
  const err = h("div", { class: "warn", hidden: true, style: "margin-top:6px" });

  const apply = async (patch, btn, after) => {
    busy = true;
    if (btn) btn.disabled = true;
    err.hidden = true;
    try {
      const data = await patchLead(id, { ...patch, ...touch(d) });
      busy = false;
      badgeCache.at = 0;                    // force a badge recount next paint
      refreshLeadsBadge();
      (after || ((nd) => paintRow(row, id, nd, crew)))(data);
    } catch (e) {
      busy = false;
      if (btn) btn.disabled = false;
      err.hidden = false;
      err.textContent = "Couldn't save — " + String(e && e.message || e).slice(0, 120);
    }
  };

  const followBtn = h("button", { class: "btn btn--ghost btn--sm" }, "⏰ Follow-up");
  followBtn.addEventListener("click", () => {
    busy = true;                            // an open form must survive the sync repaint
    clear(formHost);
    const date = h("input", { type: "date", value: d.nextActionAt || localToday() });
    const what = h("input", { type: "text", placeholder: "What's the next move? — call back, send estimate…", value: d.nextAction || "", maxlength: "120" });
    const save = h("button", { class: "btn btn--primary btn--sm" }, "Save");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Cancel");
    save.addEventListener("click", () => {
      if (!date.value) { err.hidden = false; err.textContent = "Pick a date for the follow-up."; return; }
      apply({ nextActionAt: date.value, nextAction: what.value.trim() }, save);
    });
    formHost.append(h("div", { class: "lform" }, date, what, save, cancel));
    what.focus();
  });

  /* 📅 Site visit — book who's going and when. Writes data.siteVisit; the
     field app sees siteVisit.at and makes the bid file (site-visit packet +
     estimate) on the next jobs-list load, no retyping. Same patch path as
     every other triage action. */
  const sv = d.siteVisit || {};
  const live = !!sv.at && sv.status !== "cancelled";
  const visitBtn = h("button", { class: "btn btn--ghost btn--sm",
    title: "Book the site visit — the bid file (packet + estimate) appears in Field Forms" }, live ? "📅 Re-book visit" : "📅 Site visit");
  visitBtn.addEventListener("click", () => {
    busy = true;                            // an open form must survive the sync repaint
    clear(formHost);
    const date = h("input", { type: "date", value: visitDate(sv.at) || localToday() });
    const time = h("input", { type: "time", step: "900", value: visitTime(sv.at) || "" });
    const me = currentEmail();
    const people = visitPeople(crew, me);
    const who = h("select", { title: "Who's going" },
      ...people.map((p) => h("option", { value: p.email, selected: (sv.by || me) === p.email }, p.name)));
    const save = h("button", { class: "btn btn--primary btn--sm" }, live ? "Save visit" : "Book visit");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Close");
    save.addEventListener("click", () => {
      if (!date.value) { err.hidden = false; err.textContent = "Pick a date for the site visit."; return; }
      apply(scheduleVisitPatch(d, { date: date.value, time: time.value, by: who.value || me }), save,
        (nd) => {
          paintRow(row, id, nd, crew);
          toast("Site visit booked — the bid file shows up in Field Forms");
          // straight on to the confirmation text — still nothing sends until Send is tapped
          const cb = row.querySelector("[data-confirm-visit]");
          if (cb) cb.click();
        });
    });
    const callOff = live ? h("button", { class: "btn btn--ghost btn--sm", title: "The visit is off. A bid file that already exists stays put." }, "Cancel visit") : null;
    if (callOff) callOff.addEventListener("click", () => apply(cancelVisitPatch(d), callOff));
    formHost.append(h("div", { class: "lform" }, ...[date, time, who, save, callOff, cancel].filter(Boolean)));
  });

  /* 📱 Confirm by text — a plain, editable text to the customer. Reading it
     and tapping Send is the approval; roybal-notify kind "reminder" is a
     customer kind, so it only goes out 7am–8pm Alaska (quiet hours are
     enforced server-side). Sent → siteVisit.confirmedAt + a lead-log line. */
  const confirmBtn = live && d.phone && !sv.doneAt && sv.status !== "done" && visitDate(sv.at) >= localToday()
    ? h("button", { class: "btn btn--ghost btn--sm", "data-confirm-visit": "1",
        title: "Text the customer the visit time from the company number — you see it before it sends" },
        sv.confirmedAt ? "📱 Re-send confirmation" : "📱 Confirm by text")
    : null;
  if (confirmBtn) confirmBtn.addEventListener("click", () => {
    busy = true;                            // an open form must survive the sync repaint
    clear(formHost);
    const ta = h("textarea", { rows: "3", maxlength: "480", style: "width:100%;box-sizing:border-box" });
    ta.value = visitConfirmText(d, crew);
    const send = h("button", { class: "btn btn--primary btn--sm" }, "Send to " + d.phone);
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Not now");
    const note = h("div", { class: "muted", style: "font-size:12px" },
      "From the company number. Customer texts only go out 7 AM–8 PM Alaska time.");
    send.addEventListener("click", async () => {
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true; send.textContent = "Sending…";
      err.hidden = true;
      try {
        await sendViaCompany({ to: d.phone, body, kind: "reminder", by: currentEmail() });
      } catch (e) {
        send.disabled = false; send.textContent = "Send to " + d.phone;
        const m = String((e && e.message) || e);
        err.hidden = false;
        err.textContent = /quiet_hours/.test(m)
          ? "Not sent — it's outside 7 AM–8 PM Alaska time. Send it in the morning."
          : "Not sent — " + m.slice(0, 140);
        if (!/quiet_hours/.test(m)) err.append(" ", h("a", { href: smsHref(d.phone, body) }, "Text it from this device instead"));
        return;
      }
      // the text is out; stamp the lead (a failed stamp doesn't un-send it)
      apply(visitConfirmedPatch(d, new Date().toISOString(), uid()), null,
        (nd) => { paintRow(row, id, nd, crew); toast("Confirmation texted to " + d.phone); });
    });
    formHost.append(h("div", { class: "lform", style: "flex-direction:column;align-items:stretch;gap:6px" },
      ta, note, h("div", { style: "display:flex;gap:8px" }, send, cancel)));
    ta.focus();
  });

  /* ✓ Done — the follow-up happened; log what came of it. Same leadLog the
     board's 🎯 Lead section keeps, so the history reads the same in both apps.
     Clears the completed follow-up and (optionally) books the next one. */
  const doneBtn = h("button", { class: "btn btn--ghost btn--sm",
    title: "The appointment or call happened — log the outcome without calling it won or lost" }, "✓ Done");
  doneBtn.addEventListener("click", () => {
    busy = true;                            // an open form must survive the sync repaint
    clear(formHost);
    const kind = h("select", {}, ...LEAD_LOG_KINDS.map((k) => h("option", { value: k.id }, k.icon + " " + k.label)));
    const note = h("input", { type: "text", maxlength: "200", style: "flex:1;min-width:180px",
      placeholder: "How'd it go? — measured up, numbers by Friday…" });
    const nextAt = h("input", { type: "date" });
    const nextWhat = h("input", { type: "text", maxlength: "120", style: "flex:1;min-width:180px",
      placeholder: "Next move (optional) — send estimate, call back…" });
    const save = h("button", { class: "btn btn--primary btn--sm" }, "Log it");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Cancel");
    save.addEventListener("click", () => {
      const entry = { id: uid(), at: localToday(), kind: kind.value, note: note.value.trim(), action: d.nextAction || "" };
      apply({ leadLog: [...(d.leadLog || []), entry], nextActionAt: nextAt.value || "", nextAction: nextWhat.value.trim() }, save);
    });
    formHost.append(h("div", { class: "lform", style: "flex-direction:column;align-items:stretch;gap:6px" },
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, kind, note),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, nextAt, nextWhat),
      h("div", { style: "display:flex;gap:8px" }, save, cancel)));
    note.focus();
  });

  const touchedBtn = !d.firstTouchAt
    ? h("button", { class: "btn btn--ghost btn--sm", title: "Stamp that someone reached out — the response-time clock stops here" }, "✓ Mark contacted")
    : null;
  if (touchedBtn) touchedBtn.addEventListener("click", () => apply({}, touchedBtn));

  /* 📝 the SAME notes field the board chip shows — edited here, adopted
     there on its next sync (the rev-bumping patch). "Left a voicemail"
     no longer means switching apps. */
  const notesBtn = h("button", { class: "btn btn--ghost btn--sm" }, "📝 Notes");
  notesBtn.addEventListener("click", () => {
    busy = true;                            // an open editor must survive the sync repaint
    clear(formHost);
    const ta = h("textarea", { rows: "5", style: "width:100%;box-sizing:border-box",
      placeholder: "Left a voicemail 9/2, calling back tomorrow…" }, d.notes || "");
    const save = h("button", { class: "btn btn--primary btn--sm" }, "Save notes");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Cancel");
    save.addEventListener("click", () => apply({ notes: ta.value }, save));
    formHost.append(h("div", { class: "lform", style: "flex-direction:column;align-items:stretch" },
      ta, h("div", { style: "display:flex;gap:8px" }, save, cancel)));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);   // cursor at the end, ready to append
  });

  const lostBtn = h("button", { class: "btn btn--ghost btn--sm" }, "✕ Lost / spam");
  lostBtn.addEventListener("click", () => {
    busy = true;
    clear(formHost);
    const sel = h("select", {}, ...LOST_REASONS.map((r) => h("option", { value: r.id }, r.label)));
    const confirmBtn = h("button", { class: "btn btn--primary btn--sm" }, "Mark lost & archive");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", onclick: () => { busy = false; clear(formHost); } }, "Cancel");
    confirmBtn.addEventListener("click", () => {
      // mirror the board's Lost flow exactly (board.js lostConfirm): outcome +
      // reason + cleared follow-up + archived — it lands in 🗄 Archive → Lost
      apply({ outcome: "lost", lostReason: sel.value, outcomeAt: localToday(),
        nextAction: "", nextActionAt: "", archived: true, archivedAt: localToday() },
        confirmBtn,
        () => { row.remove(); toast("Lead marked lost — filed in the board's 🗄 Archive"); });
    });
    formHost.append(h("div", { class: "lform" }, sel, confirmBtn, cancel));
  });

  // DOM append() stringifies null (the campaigns lesson) — filter first
  for (const el of [
    d.phone ? h("a", { class: "btn btn--ghost btn--sm", href: "tel:" + digits(d.phone) }, "📞 Call") : null,
    visitBtn, confirmBtn, followBtn, doneBtn, touchedBtn, notesBtn, lostBtn,
  ].filter(Boolean)) actions.append(el);
  row.append(actions, formHost, err);
}
