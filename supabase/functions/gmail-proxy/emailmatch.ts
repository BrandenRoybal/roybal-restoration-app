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
                      (normalized to alphanumerics; 4+ chars so a short
                      fragment can't false-match)
   • customer-name  — the customer's full name (2+ words, all present)
                      appears in the subject

   Ambiguity refuses to file: two matching jobs = no match, skip.
   (Next pull re-evaluates; a claim # resolves it.)

   ONE CLAIM IN TWO PHASES IS NOT AMBIGUITY. When a restoration job is
   converted to a reconstruction job (convert.js), the new job records
   `mitigationRef.fromProjectId` pointing back at the old one. Both carry the
   same customer, email and claim number — by every identifier this matcher
   uses they are indistinguishable — so mail about that claim hit two jobs and
   was refused, silently, forever. They are not two jobs competing for the
   mail: they are one loss, and the reconstruction job is its current phase.
   A converted pair collapses to the successor.

   ARCHIVED JOBS ARE A SECOND TIER, not invisible. They used to be skipped
   outright, which silently threw away final invoices, warranty questions and
   adjuster follow-ups — the mail an archived job actually still receives.
   Matching now runs against active jobs FIRST and falls back to archived ones
   only when no active job matched uniquely.

   Tiering rather than one flat list is deliberate. A customer with both a
   current job and an old one would otherwise match twice and the mail would be
   dropped as ambiguous — so simply un-skipping archived jobs would have traded
   one silent loss for another. Precedence also happens to be the right answer:
   mail from someone you are working for now is about the current job.

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

/* Claim normalization — alphanumerics only, upper. Applied to BOTH the stored
   claim # and the email haystack so the two stay symmetric.
   Anything else is punctuation-or-junk: separators the sender may have typed
   differently (spaces, dashes, slashes, #), and control characters that ride
   in on barcode-scanner output or PDF pastes. At least one live job carries
   "100250382\b \b" in claimNo — the \b survived the old [\s\-_.] strip, so the
   normalized claim was unmatchable by any real email while still clearing the
   4-char floor. Stripping to alphanumerics leaves "100250382" and it matches. */
const normClaim = (v: unknown) => String(v || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export interface EmailIn { from: string; subject: string; text: string }
/* A candidate's `convertedFrom` is the id of the job it was converted FROM,
   projected from mitigationRef.fromProjectId by the caller. */
export interface Match { projectId: string; matchedBy: "customer-email" | "claim" | "customer-name" }

/** Match one inbound email against the job list. Null = stays private.
    Active jobs win; archived jobs are consulted only if no active job matched
    uniquely (see the tiering note above). */
export function matchEmailToJob(email: EmailIn, projects: Blob[]): Match | null {
  const all = projects || [];
  const active = all.filter((p) => !p?.archivedAt);
  const archived = all.filter((p) => p?.archivedAt);
  return matchWithin(email, active) ?? (archived.length ? matchWithin(email, archived) : null);
}

/** One tier's worth of matching. The archived/active split is the caller's. */
function matchWithin(email: EmailIn, projects: Blob[]): Match | null {
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
    if (sender && lc(p.email) === sender) { add(p, "customer-email"); continue; }
    const claim = normClaim(p.claimNo);
    if (claim.length >= 4 && haystack.includes(claim)) { add(p, "claim"); continue; }
    const name = lc(p.customer);
    const words = name.split(/\s+/).filter((w) => w.length >= 2);
    if (words.length >= 2 && words.every((w) => subject.includes(w))) add(p, "customer-name");
  }
  const settled = collapseClaimPhases(hits, projects || []);
  return settled.length === 1 ? settled[0] : null;   // real ambiguity still refuses
}

/* Drop any hit that a DIFFERENT hit was converted from — the earlier phase of
   the same claim. Chains collapse too (A→B→C leaves C). Jobs that merely look
   alike are untouched: with no explicit mitigationRef link this changes
   nothing, and genuine ambiguity between two real jobs is still refused. */
function collapseClaimPhases(hits: Match[], projects: Blob[]): Match[] {
  if (hits.length < 2) return hits;
  const byId = new Map<string, Blob>();
  for (const p of projects) if (p?.id) byId.set(String(p.id), p);
  const hitIds = new Set(hits.map((h) => h.projectId));
  const superseded = new Set<string>();
  for (const h of hits) {
    const from = byId.get(h.projectId)?.convertedFrom;
    if (from && hitIds.has(String(from))) superseded.add(String(from));
  }
  return superseded.size ? hits.filter((h) => !superseded.has(h.projectId)) : hits;
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
