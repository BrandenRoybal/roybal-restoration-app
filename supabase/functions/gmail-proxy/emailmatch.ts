/* ============================================================
   Email lane — pure rules (no Deno, no network)
   ------------------------------------------------------------
   The privacy contract of the whole lane lives here: an email
   only enters the app when it MATCHES A JOB. Everything else in
   the owner's mailbox is never stored, never summarized, never
   seen again after the pull that skipped it.

   Match rules, most to least certain:
   • customer-email — the sender address is the job's email on file
   • claim          — the job's claim # appears in the subject or body
                      (normalized: spaces/dashes dropped; 4+ chars so a
                      short fragment can't false-match)
   • customer-name  — the customer's full name (2+ words, all present)
                      appears in the subject

   Ambiguity refuses to file: two matching jobs = no match, skip.
   (Next pull re-evaluates; a claim # resolves it.)

   Also here: the RFC-2822 builder for outbound sends — pure so the
   header escaping and base64url encoding are Node-testable.
   ============================================================ */

// deno-lint-ignore no-explicit-any
export type Blob = Record<string, any>;

const lc = (s: unknown) => String(s || "").trim().toLowerCase();

/** "Jane Doe <jane@x.com>" -> "jane@x.com" */
export function addressOf(fromHeader: string): string {
  const m = String(fromHeader || "").match(/<([^<>\s]+@[^<>\s]+)>/);
  if (m) return lc(m[1]);
  const bare = String(fromHeader || "").match(/([^\s<>",;]+@[^\s<>",;]+)/);
  return bare ? lc(bare[1]) : "";
}

const normClaim = (v: unknown) => String(v || "").replace(/[\s\-_.]/g, "").toUpperCase();

export interface EmailIn { from: string; subject: string; text: string }
export interface Match { projectId: string; matchedBy: "customer-email" | "claim" | "customer-name" }

/** Match one inbound email against the job list. Null = stays private. */
export function matchEmailToJob(email: EmailIn, projects: Blob[]): Match | null {
  const sender = addressOf(email.from);
  const subject = lc(email.subject);
  // claim search space: subject + the first chunk of the body, normalized
  const haystack = normClaim(email.subject + " " + String(email.text || "").slice(0, 4000));

  const hits: Match[] = [];
  const seen = new Set<string>();
  const add = (p: Blob, matchedBy: Match["matchedBy"]) => {
    if (!p?.id || seen.has(p.id)) return;
    seen.add(p.id);
    hits.push({ projectId: p.id, matchedBy });
  };

  for (const p of projects || []) {
    if (p?.archivedAt) continue;
    if (sender && lc(p.email) === sender) { add(p, "customer-email"); continue; }
    const claim = normClaim(p.claimNo);
    if (claim.length >= 4 && haystack.includes(claim)) { add(p, "claim"); continue; }
    const name = lc(p.customer);
    const words = name.split(/\s+/).filter((w) => w.length >= 2);
    if (words.length >= 2 && words.every((w) => subject.includes(w))) add(p, "customer-name");
  }
  return hits.length === 1 ? hits[0] : null;   // ambiguity refuses to file
}

/* ---------- outbound: RFC-2822 raw message ---------- */

/** RFC 2047 encode a header value when it needs it (non-ASCII). */
const encHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64(new TextEncoder().encode(s)) + "?=";

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa exists in Deno + modern Node (test runs under Node 18+)
  return btoa(bin);
}

export interface OutboundEmail {
  to: string; from: string; subject: string; body: string;
  inReplyTo?: string;    // Message-ID header of the mail being answered
  references?: string;
}

/** Build the raw message and its base64url form for gmail.send. */
export function buildRfc822(msg: OutboundEmail): { raw: string; base64url: string } {
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encHeader(String(msg.subject || "").replace(/[\r\n]+/g, " ").slice(0, 400))}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`, `References: ${msg.references || msg.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const bodyB64 = b64(new TextEncoder().encode(String(msg.body || ""))).replace(/(.{76})/g, "$1\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + bodyB64;
  const base64url = b64(new TextEncoder().encode(raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { raw, base64url };
}

/** Best-effort plain-text body out of a Gmail payload (format=full). */
export function extractText(payload: Blob): string {
  if (!payload) return "";
  const decode = (data: string) => {
    try {
      const b64s = String(data).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64s);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch { return ""; }
  };
  const findPart = (part: Blob, mime: string): string => {
    if (!part) return "";
    if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
    for (const sub of part.parts || []) {
      const t = findPart(sub, mime);
      if (t) return t;
    }
    return "";
  };
  // a text/plain part ANYWHERE in the tree beats falling back to HTML
  const plain = findPart(payload, "text/plain");
  if (plain) return plain.slice(0, 20_000);
  const html = findPart(payload, "text/html");
  return html
    ? html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 20_000)
    : "";
}

/** Header lookup on a Gmail payload. */
export const headerOf = (payload: Blob, name: string): string =>
  String((payload?.headers || []).find((h: Blob) => lc(h?.name) === lc(name))?.value || "");
