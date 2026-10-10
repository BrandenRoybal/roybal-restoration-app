/* The RFC 822 message the Gmail API's messages.send takes as `raw`. The same
   shape gmail-proxy's buildRfc822 (supabase/functions/gmail-proxy/emailmatch.ts)
   produces — From, To, Subject, optional In-Reply-To/References, text/plain
   UTF-8 base64 — plus Cc, which the op spine's email.send input allows. Kept
   here rather than imported so the image needs no TypeScript stripping and no
   copy of an edge function's file.

   With `attachments` (the carrier packet: one PDF) the message is
   multipart/mixed instead: the same text/plain part, then each file as a
   base64 part wrapped at 76 characters with Content-Disposition: attachment.
   A message without attachments takes the original code path untouched, so
   every plain email is built byte-for-byte as it was before packets existed.
   The boundary is derived from a hash of the message, so the same input
   always gives the same bytes (a test can pin them, and a retry rebuilds the
   identical message); it starts "=_", which base64 can never contain, so no
   part body can be mistaken for a delimiter. A multipart message is returned
   as bytes, the form the Gmail upload endpoint takes; `raw` and `base64url`
   are worked out only when read, because a 17 MB PDF would otherwise sit in
   memory three more times on a machine that is also rendering packets.

   Header injection: every header value has CR and LF removed, so a `to` or a
   subject carrying a newline cannot add a Bcc. A file name loses its control
   characters too, and anything that is not plain ASCII goes in an RFC 2231
   `filename*` parameter, which is percent-encoded and so cannot carry a
   quote, a semicolon or a line break into the header. */

import { createHash } from "node:crypto";

const strip = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

/** RFC 2047 B-encoding for a header that is not plain printable ASCII. */
export function encHeader(s) {
  const v = strip(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : "=?UTF-8?B?" + b64(new TextEncoder().encode(v)) + "?=";
}

/** One address or a list → a single header value, blanks dropped. */
export function addressList(v) {
  const parts = (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((a) => strip(a)).filter(Boolean);
  return parts.join(", ");
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** True when every address in v (a string or a list) looks like an address. */
export function validAddresses(v) {
  const parts = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((a) => strip(a)).filter(Boolean);
  return parts.length > 0 && parts.every((a) => EMAIL.test(a.replace(/^.*<([^>]+)>$/, "$1")));
}

/** A Message-ID header value: CR/LF gone, and always inside angle brackets. */
function messageIdValue(id) {
  const v = strip(id).replace(/^<|>$/g, "").replace(/[<>\s]/g, "");
  return v ? `<${v}>` : "";
}

export function buildRfc822(msg) {
  if (Array.isArray(msg.attachments) && msg.attachments.length) return buildMultipart(msg);
  const to = addressList(msg.to);
  const cc = addressList(msg.cc);
  const messageId = messageIdValue(msg.messageId);
  const headers = [
    `From: ${strip(msg.from)}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encHeader(String(msg.subject || "").slice(0, 400))}`,
    ...(msg.inReplyTo
      ? [`In-Reply-To: ${strip(msg.inReplyTo)}`, `References: ${strip(msg.references || msg.inReplyTo)}`]
      : []),
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const bodyB64 = b64(new TextEncoder().encode(String(msg.body || ""))).replace(/(.{76})/g, "$1\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + bodyB64;
  const base64url = b64(new TextEncoder().encode(raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { raw, base64url };
}

/** Bytes → base64 in 76-character lines joined by CRLF (none after the last),
    written straight into one buffer: 57 input bytes make exactly one line. */
export function base64Lines(bytes) {
  const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = Math.ceil(src.length / 57);
  const encLen = Math.ceil(src.length / 3) * 4;
  const out = Buffer.allocUnsafe(encLen + Math.max(0, lines - 1) * 2);
  let at = 0;
  for (let i = 0; i < lines; i++) {
    if (i) at += out.write("\r\n", at, "ascii");
    at += out.write(src.subarray(i * 57, i * 57 + 57).toString("base64"), at, "ascii");
  }
  return out.subarray(0, at);
}

// RFC 2231 attr-char: what may stand unencoded in an extended parameter.
// encodeURIComponent leaves four more (* ' ( )) that are special there.
const enc2231 = (s) => encodeURIComponent(s).replace(/[*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** A file name → its Content-Type `name` and Content-Disposition parameters.
    Plain ASCII without quotes or backslashes goes in as a quoted string;
    anything else gets an ASCII stand-in (accents dropped, the rest "_") plus
    the exact name as filename*=UTF-8''…, for the mail clients that read it. */
export function fileNameParams(name) {
  // toWellFormed: a lone surrogate would make encodeURIComponent throw.
  let v = String(name ?? "").toWellFormed().replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!v) v = "attachment";
  if (v.length > 200) v = [...v].slice(0, 200).join("");
  const plain = /^[\x20-\x7e]*$/.test(v) && !/["\\]/.test(v);
  if (plain) return { name: `name="${v}"`, disposition: `filename="${v}"` };
  const ascii = v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]|["\\]/g, "_");
  // One encoded parameter stays well under the 998-character line limit:
  // shorten the exact name (never the stand-in) until it fits.
  let exact = [...v];
  while (enc2231(exact.join("")).length > 900) exact = exact.slice(0, -1);
  return {
    name: `name="${ascii}"`,
    disposition: `filename="${ascii}";\r\n filename*=UTF-8''${enc2231(exact.join(""))}`,
  };
}

/** A MIME type token, or application/octet-stream for anything else. */
function contentTypeOf(t) {
  const v = strip(t).toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v) ? v : "application/octet-stream";
}

function buildMultipart(msg) {
  const to = addressList(msg.to);
  const cc = addressList(msg.cc);
  const messageId = messageIdValue(msg.messageId);
  const subject = encHeader(String(msg.subject || "").slice(0, 400));
  const body = new TextEncoder().encode(String(msg.body || ""));
  const files = msg.attachments.map((a) => {
    const bytes = a.bytes instanceof Uint8Array ? a.bytes : Buffer.from(a.bytes ?? []);
    return { bytes, type: contentTypeOf(a.contentType), names: fileNameParams(a.filename) };
  });

  // Everything that goes into the message feeds the boundary, so the same
  // input is the same bytes and a different input can never reuse one.
  const h = createHash("sha256");
  for (const part of [strip(msg.from), to, cc, subject, messageId, strip(msg.inReplyTo), strip(msg.references)]) {
    h.update(part).update("\0");
  }
  h.update(body).update("\0");
  for (const f of files) h.update(f.type).update("\0").update(f.names.disposition).update("\0").update(f.bytes).update("\0");
  const boundary = `=_rrc_${h.digest("hex").slice(0, 40)}`;

  const headers = [
    `From: ${strip(msg.from)}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    ...(msg.inReplyTo
      ? [`In-Reply-To: ${strip(msg.inReplyTo)}`, `References: ${strip(msg.references || msg.inReplyTo)}`]
      : []),
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const chunks = [
    headers.join("\r\n") + "\r\n\r\n",
    `--${boundary}\r\n`,
    'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    base64Lines(body),
  ];
  for (const f of files) {
    chunks.push(
      `\r\n--${boundary}\r\n`,
      `Content-Type: ${f.type}; ${f.names.name}\r\n`,
      `Content-Disposition: attachment; ${f.names.disposition}\r\n`,
      "Content-Transfer-Encoding: base64\r\n\r\n",
      base64Lines(f.bytes),
    );
  }
  chunks.push(`\r\n--${boundary}--\r\n`);
  const bytes = Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c, "utf8") : c)));

  let raw = null;
  let base64url = null;
  return {
    bytes,
    boundary,
    get raw() { return (raw ??= bytes.toString("utf8")); },
    get base64url() {
      return (base64url ??= bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    },
  };
}
