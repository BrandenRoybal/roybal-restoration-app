/* The RFC 822 message the Gmail API's messages.send takes as `raw`. The same
   shape gmail-proxy's buildRfc822 (supabase/functions/gmail-proxy/emailmatch.ts)
   produces — From, To, Subject, optional In-Reply-To/References, text/plain
   UTF-8 base64 — plus Cc, which the op spine's email.send input allows. Kept
   here rather than imported so the image needs no TypeScript stripping and no
   copy of an edge function's file.

   Header injection: every header value has CR and LF removed, so a `to` or a
   subject carrying a newline cannot add a Bcc. */

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

export function buildRfc822(msg) {
  const to = addressList(msg.to);
  const cc = addressList(msg.cc);
  const headers = [
    `From: ${strip(msg.from)}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encHeader(String(msg.subject || "").slice(0, 400))}`,
    ...(msg.inReplyTo
      ? [`In-Reply-To: ${strip(msg.inReplyTo)}`, `References: ${strip(msg.references || msg.inReplyTo)}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const bodyB64 = b64(new TextEncoder().encode(String(msg.body || ""))).replace(/(.{76})/g, "$1\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + bodyB64;
  const base64url = b64(new TextEncoder().encode(raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { raw, base64url };
}
