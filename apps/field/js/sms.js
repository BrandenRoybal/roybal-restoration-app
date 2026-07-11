/* ============================================================
   Roybal Field Forms — texting via SMS links (Path 1: no gateway)
   ------------------------------------------------------------
   Builds sms: links that open the phone's Messages app pre-filled —
   the tech reviews and taps send, so the text comes from THEIR number
   (crew → office keeps a human sender; customers can reply to a person).
   No provider, no cost, works offline. A future Path 2 (Twilio edge
   function) can automate sends behind the same buttons.
   ============================================================ */
import { COMPANY } from "./model.js";

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
};
