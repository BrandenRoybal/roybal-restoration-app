/* ============================================================
   Roybal Field Forms — texting
   ------------------------------------------------------------
   Every text button sends from the company number (Path 2, below:
   Twilio through the roybal-notify edge function). The sms: links
   built here (Path 1) are the fallback: when a company send can't go
   through, the phone's Messages app opens pre-filled — the tech
   reviews and taps send, so the text still goes out, from THEIR number.
   ============================================================ */
import { COMPANY } from "./model.js";
import { toast } from "./core.js";

/* keep digits and a leading + — "907-371-9868" -> "9073719868" */
export function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/[^\d]/g, "");
  return digits ? plus + digits : "";
}

/* sms: URL for one or more recipients. iOS wants the historical "?&body="
   quirk; everything else takes the standard "?body=". */
export function smsHref(numbers, body, ua) {
  const list = (Array.isArray(numbers) ? numbers : [numbers])
    .map(normalizePhone).filter(Boolean);
  if (!list.length) return "";
  const agent = ua != null ? ua : (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const sep = /iPhone|iPad|iPod/i.test(agent) ? "?&" : "?";
  return "sms:" + list.join(",") + (body ? sep + "body=" + encodeURIComponent(body) : "");
}

/* ---------- assigned office numbers (per device, office # by default) ---------- */
const OFFICE_KEY = "roybal-office-sms";
export function officeNumbers() {
  try {
    const v = localStorage.getItem(OFFICE_KEY);
    if (v != null && v.trim()) return v.split(",").map(normalizePhone).filter(Boolean);
  } catch (_) { /* fall through */ }
  return [normalizePhone(COMPANY.phone)].filter(Boolean);
}
export function setOfficeNumbers(raw) {
  try { localStorage.setItem(OFFICE_KEY, String(raw || "")); } catch (_) { /* ignore */ }
}
export function officeNumbersRaw() {
  try { return localStorage.getItem(OFFICE_KEY) || COMPANY.phone; } catch (_) { return COMPANY.phone; }
}

/* ---------- message builders (pure) ---------- */
/** Field Report -> office text: only the sections the crew filled in. */
export function fieldReportSms(project, c, techName) {
  const head = ["FIELD REPORT", project.customer || project.address || "job",
    c.date || ""].filter(Boolean).join(" — ");
  const lines = [head];
  if (String(c.notes || "").trim()) lines.push("Notes: " + c.notes.trim());
  if (String(c.issues || "").trim()) lines.push("ISSUES: " + c.issues.trim());
  if (String(c.materials || "").trim()) lines.push("Materials needed: " + c.materials.trim());
  const nPhotos = Array.isArray(c.photos) ? c.photos.length : 0;
  if (nPhotos) lines.push(`(${nPhotos} photo${nPhotos === 1 ? "" : "s"} on the Field Report in the app)`);
  const who = String(c.completedBy || techName || "").trim();
  if (who) lines.push("— " + who);
  return lines.join("\n");
}

/** "On our way" customer text. */
export function onOurWaySms(project, techName) {
  const first = String(project.customer || "").trim().split(/\s+/)[0] || "";
  const who = String(techName || "").trim();
  return `Hi${first ? " " + first : ""}, this is ${who ? who + " with " : ""}${COMPANY.name} — ` +
    `we're on our way to ${project.address || "your property"}. ` +
    `Reply here or call ${COMPANY.phone} if anything changes.`;
}

/* ---------- message log (claim documentation) ----------
   Every text button stamps the job: who composed what, to whom, when.
   Honest wording: with SMS links we can only prove the message was
   COMPOSED (Messages opened pre-filled) — Path 2 (Twilio) upgrades these
   entries with real delivery status. */
export function logSms(project, { kind, to, body, by }) {
  if (!Array.isArray(project.smsLog)) project.smsLog = [];
  project.smsLog.push({
    at: new Date().toISOString(),
    kind: kind || "text",
    to: (Array.isArray(to) ? to : [to]).map(normalizePhone).filter(Boolean),
    preview: String(body || "").replace(/\s+/g, " ").slice(0, 120),
    by: String(by || "").trim(),
  });
  if (project.smsLog.length > 200) project.smsLog = project.smsLog.slice(-200);
  return project.smsLog[project.smsLog.length - 1];
}
export const SMS_KIND_LABELS = {
  fieldReport: "Field Report → office",
  onOurWay: "On our way → customer",
  text: "Text",
  portalLink: "Portal link → customer",
  assist: "Assistant → customer (confirmed)",
  assistCrew: "Assistant → crew (confirmed)",
};

/* ============================================================
   Path 2 — company-number texting (Twilio via roybal-notify)
   ------------------------------------------------------------
   Always on. Every text button sends from the company number and
   records the real Twilio sid/status on the message log; where a
   refusal allows it (each sender below says when), a send that can't
   go through falls back to the sms: link. Until field v210 this was a
   per-device checkbox, "Send texts from the company number", off by
   default; the checkbox is gone, and its old roybal-company-sms
   setting is simply never read.
   ============================================================ */

/* Send ONE text through the company number. Resolves to { sid, status };
   throws with a readable message on any failure. supa.js is imported lazily
   so this module still loads in Node (its localStorage read runs at import). */
export async function sendViaCompany({ to, body, kind, by, unifiedJobId }) {
  const { callFunction } = await import("./supa.js");
  const res = await callFunction("roybal-notify", {
    action: "sendSms",
    to: Array.isArray(to) ? to[0] : to,
    body, kind: kind || "text",
    captured_by: by || "",
    unified_job_id: unifiedJobId || null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ("send failed (" + res.status + ")"));
  return { sid: data.sid || "", status: data.status || "sent" };
}

/* Assistant confirm-chip send WITHOUT a field project (board / admin mounts —
   the server's sms_messages row is the log there). Same lane rules as
   smartSend, except a quiet_hours refusal NEVER falls back to the device
   link — that would sidestep the guard the user just hit. */
export function assistSend({ to, message, audience, by }) {
  const num = normalizePhone(to);
  const msg = String(message || "").trim();
  if (!num || !msg) return { ok: false, detail: "missing a phone number or message" };
  const kind = audience === "crew" ? "assistCrew" : "assist";
  return sendViaCompany({ to: num, body: msg, kind, by: by || "", unifiedJobId: null })
    .then(() => ({ ok: true, detail: "sent from the company number" }))
    .catch((e) => {
      const m = String((e && e.message) || e).slice(0, 140);
      if (/quiet_hours/.test(m)) return { ok: false, detail: m };
      location.href = smsHref(num, msg);          // best-effort fallback
      return { ok: true, detail: "company send failed — opened Messages instead (review and send)" };
    });
}

/* Shared handler behind the job's text buttons (on our way, Field Report →
   office): sends from the company number, one message per recipient,
   upgrading the just-logged entry with the real sid/status, and falling back
   to the sms: link if the company send fails. A tap on the same text while it
   is still sending is ignored: on a weak signal nothing shows for a few
   seconds, and a second tap would text the customer twice. onChange persists
   the project after each state change. */
const sending = new Set();
export async function smartSend(project, { recipients, body, kind, by, onChange }) {
  const to = (Array.isArray(recipients) ? recipients : [recipients]).map(normalizePhone).filter(Boolean);
  if (!to.length) { toast("No phone number to text."); return; }
  const key = [kind, to.join(","), body].join("|");
  if (sending.has(key)) { toast("Still sending that text…"); return; }
  sending.add(key);
  const entry = logSms(project, { kind, to, body, by });
  onChange && onChange();
  toast("Sending from the company number…", 30000);   // the result toast replaces it
  try {
    const results = [];
    for (const num of to) results.push(await sendViaCompany({ to: num, body, kind, by }));
    entry.via = "company";
    entry.status = (results[0] && results[0].status) || "sent";
    entry.sid = results.map((r) => r.sid).filter(Boolean).join(",");
    onChange && onChange();
    toast("Sent from your company number ✓");
  } catch (e) {
    entry.via = "device";
    entry.error = String((e && e.message) || e).slice(0, 140);
    onChange && onChange();
    toast("Company send failed — opening Messages instead");
    location.href = smsHref(to, body);          // best-effort fallback
  } finally {
    sending.delete(key);
  }
}
