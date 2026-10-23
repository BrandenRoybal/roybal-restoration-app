/* The website lead's email alert: the rows roybal-lead files on the op
   spine's outbox, next to the text it already sends, so a new web lead
   reaches the owner twice.

   The worker's email lane (services/worker/adapters/email.mjs) sends each
   row through the Gmail API as the connected office account, the same path
   the adjuster emails take: plain text, exactly once (email_messages
   sent_by outbox:<id>), refused if it waited past EMAIL_MAX_AGE_HOURS. One
   row per address, so one bad address cannot stop the others (the text
   alert's rule). Nothing here talks to the network; roybal-lead decides
   whether to file and does the insert.

   Recipients come from LEAD_ALERT_EMAILS (comma-separated). Unset or blank:
   the owner's address. "off": no email at all, the text still goes.

   Pure, so supabase/functions/_shared/leadmail.test.mjs runs it in Node:
   node --test --experimental-strip-types supabase/functions/_shared/leadmail.test.mjs */

export const LEAD_ALERT_OPERATION = "lead.alert";
export const DEFAULT_LEAD_ALERT_TO = "branden@roybalconstruction.com";
export const ADMIN_URL = "https://app.roybalconstruction.com/admin/";

const EMAIL = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/;

/** LEAD_ALERT_EMAILS → the addresses to email, lowercased and deduped.
    rejected counts entries that are not an address (a count, never the
    entry: this goes to logs). */
export function alertRecipients(raw: string | null | undefined, fallback: string = DEFAULT_LEAD_ALERT_TO): { to: string[]; rejected: number } {
  const text = String(raw ?? "").trim();
  if (/^(off|none|no)$/i.test(text)) return { to: [], rejected: 0 };
  const to: string[] = [];
  let rejected = 0;
  for (const part of (text || fallback).split(/[,;\s]+/)) {
    const a = part.trim().toLowerCase();
    if (!a) continue;
    if (!EMAIL.test(a)) { rejected++; continue; }
    if (!to.includes(a)) to.push(a);
  }
  return { to, rejected };
}

// newer ICU puts a narrow no-break space before AM/PM; a plain space reads the same everywhere
const tidy = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

/** "Wed, Oct 21, 2026, 9:32 AM AKDT", or "" for a time that won't parse. */
export function akWhen(iso: string): string {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  return tidy(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage", weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(t)));
}

export interface LeadForMail {
  id: string;
  customer: string;
  phone: string;
  email?: string;
  address?: string;
  service?: string;
  message?: string;
  emergency?: boolean;
  createdAt: string;
  /** From ../_shared/leadscreen.ts. Absent = an ordinary lead, email unchanged. */
  screen?: { kind: "scam" | "solicitation"; reasons: string[] };
  /** Same phone or email already came in through the form, and texted, in the last 24h. */
  repeat?: boolean;
  /** false when roybal-lead held the text back (screened or repeat). Default true. */
  texted?: boolean;
}

// one line: no control characters, no line breaks (a subject or a field label line)
const line = (v: unknown) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
// a block: line breaks kept, other control characters dropped
const block = (v: unknown) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, "").trim();

/** The email itself: a subject that says who and what, and a plain-text
    body with every detail the form sent and a link to the lead's page. */
export function leadAlertEmail(l: LeadForMail, adminUrl: string = ADMIN_URL): { subject: string; body: string } {
  const name = line(l.customer) || "Someone";
  const service = line(l.service);
  const tag = l.screen ? (l.screen.kind === "solicitation" ? "[Sales pitch] " : "[Likely spam] ") : l.repeat ? "[Repeat] " : "";
  const subject = (tag + (l.emergency ? "🚨 EMERGENCY web lead: " : "New web lead: ") + name + (service ? " — " + service : "")).slice(0, 180);
  const message = block(l.message);
  const flag = l.screen
    ? [
        (l.screen.kind === "solicitation"
          ? "🚩 Auto-screened as a SALES PITCH, not a customer. Why:"
          : "🚩 Auto-screened as LIKELY SPAM. Why:"),
        ...l.screen.reasons.slice(0, 6).map((r) => "  - " + line(r)),
        "If this is a real customer, just work it like any other lead.",
        "",
      ]
    : l.repeat
      ? ["Repeat: this phone or email already came in through the form, and texted you, in the last 24 hours.", ""]
      : [];
  const parts = [
    ...flag,
    l.emergency ? "New lead from the website form. The customer marked it an ACTIVE EMERGENCY." : "New lead from the website form.",
    "",
    "Received: " + (akWhen(l.createdAt) || "just now"),
    "Name: " + name,
    "Phone: " + (line(l.phone) || "not given"),
    "Email: " + (line(l.email) || "not given"),
    "Address: " + (line(l.address) || "not given"),
    ...(service ? ["Service requested: " + service] : []),
    "",
    "Their message:",
    message || "(none: they sent their contact details only)",
    "",
    "Open the lead (print it or save a PDF from there):",
    adminUrl.replace(/\/?$/, "/") + "#/leads/" + encodeURIComponent(line(l.id)),
    "",
    l.texted === false
      ? "Sent by the Roybal app when the form came in. No text was sent for this one; it is in the office app's Leads tab."
      : "Sent by the Roybal app when the form came in. The same lead went to you by text and is in the office app's Leads tab.",
  ];
  return { subject, body: parts.join("\n") };
}

/** The outbox rows for one lead: one email per address. */
export function leadAlertRows(l: LeadForMail, to: string[], adminUrl: string = ADMIN_URL) {
  const { subject, body } = leadAlertEmail(l, adminUrl);
  return to.map((addr) => ({
    channel: "email",
    operation: LEAD_ALERT_OPERATION,
    payload: { to: addr, subject, body },
    idempotency_key: `lead-alert:${line(l.id)}:${addr}`,
    principal_kind: "system",
  }));
}
