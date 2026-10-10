import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRfc822, encHeader, validAddresses, addressList } from "../rfc822.mjs";

const lines = (raw) => raw.split("\r\n");

test("a plain message has the headers Gmail expects and a base64 body that decodes", () => {
  const { raw, base64url } = buildRfc822({
    from: "info@roybalconstruction.com", to: "pm@example.com", subject: "Estimate", body: "line1\nline2",
  });
  const h = lines(raw);
  assert.equal(h[0], "From: info@roybalconstruction.com");
  assert.equal(h[1], "To: pm@example.com");
  assert.equal(h[2], "Subject: Estimate");
  assert.ok(h.includes("MIME-Version: 1.0"));
  assert.ok(h.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(h.includes("Content-Transfer-Encoding: base64"));
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "line1\nline2");
  assert.doesNotMatch(base64url, /[+/=]/, "base64url alphabet, unpadded");
  assert.equal(Buffer.from(base64url.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"), raw);
});

test("cc is a header when given and absent when not", () => {
  const withCc = buildRfc822({ from: "a@b.co", to: "c@d.co", cc: ["e@f.co", "g@h.co"], subject: "x", body: "y" });
  assert.ok(lines(withCc.raw).includes("Cc: e@f.co, g@h.co"));
  const without = buildRfc822({ from: "a@b.co", to: "c@d.co", subject: "x", body: "y" });
  assert.ok(!lines(without.raw).some((l) => l.startsWith("Cc:")));
});

test("a reply carries In-Reply-To and References", () => {
  const { raw } = buildRfc822({ from: "a@b.co", to: "c@d.co", subject: "", body: "y", inReplyTo: "<m1@x>" });
  const h = lines(raw);
  assert.ok(h.includes("In-Reply-To: <m1@x>"));
  assert.ok(h.includes("References: <m1@x>"));
});

test("a non-ASCII subject is RFC 2047 encoded; ASCII passes through", () => {
  assert.equal(encHeader("Hello"), "Hello");
  const enc = encHeader("Héllo — 2×4");
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(enc.slice(10, -2), "base64").toString("utf8"), "Héllo — 2×4");
});

test("newlines in header values cannot inject a header", () => {
  const { raw } = buildRfc822({ from: "a@b.co", to: "c@d.co\r\nBcc: evil@x.co", subject: "x\nBcc: evil@x.co", body: "y" });
  const h = lines(raw);
  assert.ok(!h.some((l) => /^Bcc:/i.test(l)), "no Bcc line");
  assert.equal(h[1], "To: c@d.co Bcc: evil@x.co");
});

test("addressList and validAddresses accept one or several addresses", () => {
  assert.equal(addressList("a@b.co"), "a@b.co");
  assert.equal(addressList(["a@b.co", " c@d.co "]), "a@b.co, c@d.co");
  assert.equal(addressList("a@b.co, c@d.co"), "a@b.co, c@d.co");
  assert.equal(validAddresses("a@b.co"), true);
  assert.equal(validAddresses("Pat <a@b.co>"), true);
  assert.equal(validAddresses(["a@b.co", "c@d.co"]), true);
  assert.equal(validAddresses(""), false);
  assert.equal(validAddresses("not an address"), false);
  assert.equal(validAddresses(["a@b.co", "nope"]), false);
});

// The plain message as it was built before packets existed, pinned byte for
// byte (computed from that code): attachments are a separate path, so every
// email the spine already sends must still come out exactly like this.
test("a plain message is byte-for-byte what it was before multipart existed", () => {
  const msg = {
    from: "info@roybalconstruction.com", to: "pm@example.com", cc: "cc@example.com",
    subject: "Estimate for 123 Example St — revised",
    body: "Hello Jane,\n\nThe revised estimate is attached to the job. Thank you for choosing us; call with any questions about the drying schedule.\n",
    inReplyTo: "<m1@example.com>",
  };
  const want = "From: info@roybalconstruction.com\r\nTo: pm@example.com\r\nCc: cc@example.com\r\n" +
    "Subject: =?UTF-8?B?RXN0aW1hdGUgZm9yIDEyMyBFeGFtcGxlIFN0IOKAlCByZXZpc2Vk?=\r\n" +
    "In-Reply-To: <m1@example.com>\r\nReferences: <m1@example.com>\r\nMIME-Version: 1.0\r\n" +
    "Content-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    "SGVsbG8gSmFuZSwKClRoZSByZXZpc2VkIGVzdGltYXRlIGlzIGF0dGFjaGVkIHRvIHRoZSBqb2Iu\r\n" +
    "IFRoYW5rIHlvdSBmb3IgY2hvb3NpbmcgdXM7IGNhbGwgd2l0aCBhbnkgcXVlc3Rpb25zIGFib3V0\r\n" +
    "IHRoZSBkcnlpbmcgc2NoZWR1bGUuCg==";
  const out = buildRfc822(msg);
  assert.deepEqual(Object.keys(out), ["raw", "base64url"]);
  assert.equal(out.raw, want);
  assert.equal(Buffer.from(out.base64url, "base64url").toString("utf8"), want);
  assert.equal(buildRfc822({ ...msg, attachments: [] }).raw, want, "an empty attachment list is a plain message");
  assert.ok(!/Message-ID/i.test(want), "no Message-ID unless one is asked for");
});

// A tiny stand-in for the packet PDF, with every byte value in it so the
// base64 round trip is a real test, and a size that is not a multiple of 57.
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n% demo packet\n"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)), Buffer.from("\n%%EOF\n")]);
const packetMsg = (over = {}) => ({
  from: "info@roybalconstruction.com", to: "adjuster@example.com", cc: "office@example.com",
  subject: "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)",
  body: "Hello,\n\nAttached is the documentation packet for Jane Sample, 123 Example St, Fairbanks, AK 99701.\n",
  messageId: "<outbox-11111111-1111-1111-1111-111111111111@roybalconstruction.com>",
  attachments: [{ filename: "PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf", contentType: "application/pdf", bytes: PDF }],
  ...over,
});

/** A multipart message → its top headers, boundary and parts, the way a mail reader splits it. */
function parseMime(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const headers = head.split("\r\n");
  const ct = headers.find((h) => h.startsWith("Content-Type:"));
  const boundary = /boundary="([^"]+)"/.exec(ct)[1];
  const chunks = body.split(`--${boundary}`);
  assert.equal(chunks[0], "", "nothing before the first delimiter");
  assert.equal(chunks.at(-1), "--\r\n", "the close delimiter ends the message");
  const parts = chunks.slice(1, -1).map((c) => {
    assert.ok(c.startsWith("\r\n") && c.endsWith("\r\n"), "each delimiter sits on its own line");
    const [ph, ...pb] = c.slice(2, -2).split("\r\n\r\n");
    return { headers: ph.split(/\r\n(?![ \t])/), body: pb.join("\r\n\r\n") };
  });
  return { headers, boundary, parts };
}

test("with an attachment: multipart/mixed, the text part as before, the PDF base64 in 76-character lines that decode to the same bytes", () => {
  const out = buildRfc822(packetMsg());
  assert.ok(out.bytes instanceof Uint8Array);
  assert.equal(out.raw, Buffer.from(out.bytes).toString("utf8"));
  assert.deepEqual(Buffer.from(out.base64url, "base64url"), Buffer.from(out.bytes));
  assert.doesNotMatch(out.base64url, /[+/=]/);
  const { headers, boundary, parts } = parseMime(out.raw);
  assert.equal(boundary, out.boundary);
  assert.deepEqual(headers, [
    "From: info@roybalconstruction.com",
    "To: adjuster@example.com",
    "Cc: office@example.com",
    "Subject: Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)",
    "Message-ID: <outbox-11111111-1111-1111-1111-111111111111@roybalconstruction.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]);
  assert.match(boundary, /^=_rrc_[0-9a-f]{40}$/, "starts with =_, which base64 never contains");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].headers, ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"]);
  assert.equal(Buffer.from(parts[0].body.replace(/\r\n/g, ""), "base64").toString("utf8"), packetMsg().body);
  assert.deepEqual(parts[1].headers, [
    'Content-Type: application/pdf; name="PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf"',
    'Content-Disposition: attachment; filename="PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf"',
    "Content-Transfer-Encoding: base64",
  ]);
  const lines = parts[1].body.split("\r\n");
  assert.ok(lines.every((l) => l.length > 0 && l.length <= 76), "wrapped at 76");
  assert.ok(lines.slice(0, -1).every((l) => l.length === 76));
  assert.deepEqual(Buffer.from(lines.join(""), "base64"), PDF, "the PDF round-trips");
  assert.ok(!out.raw.slice(out.raw.indexOf("\r\n\r\n")).replaceAll(`--${boundary}`, "").includes(boundary), "the boundary appears only as delimiters");
});

test("the same input gives the same bytes, and a different PDF a different boundary", () => {
  const a = buildRfc822(packetMsg());
  const b = buildRfc822(packetMsg());
  assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes));
  const other = Buffer.from(PDF); other[100] ^= 1;
  const c = buildRfc822(packetMsg({ attachments: [{ filename: "x.pdf", contentType: "application/pdf", bytes: other }] }));
  assert.notEqual(c.boundary, a.boundary);
  assert.notEqual(buildRfc822(packetMsg({ to: "other@example.com" })).boundary, a.boundary);
});

test("attachment sizes on and around the 57-byte line break all round-trip", () => {
  for (const n of [0, 1, 2, 3, 56, 57, 58, 113, 114, 115, 57 * 40]) {
    const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 101 + 7) % 256));
    const { parts } = parseMime(buildRfc822(packetMsg({ attachments: [{ filename: "a.pdf", contentType: "application/pdf", bytes }] })).raw);
    const lines = parts[1].body === "" ? [] : parts[1].body.split("\r\n");
    assert.ok(lines.every((l) => l.length <= 76), `n=${n}`);
    assert.deepEqual(Buffer.from(lines.join(""), "base64"), bytes, `n=${n}`);
  }
});

test("a file name that is not plain ASCII gets an ASCII stand-in and an RFC 2231 filename*", () => {
  const name = "PKT-2026-0007 v1 - Peña Résumé \"quoted\".pdf";
  const { parts } = parseMime(buildRfc822(packetMsg({ attachments: [{ filename: name, contentType: "application/pdf", bytes: PDF }] })).raw);
  const [type, disp] = parts[1].headers;
  assert.equal(type, 'Content-Type: application/pdf; name="PKT-2026-0007 v1 - Pena Resume _quoted_.pdf"');
  const m = /^Content-Disposition: attachment; filename="([\x20-\x7e]+)";\r\n filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]+)$/.exec(disp);
  assert.ok(m, disp);
  assert.equal(m[1], "PKT-2026-0007 v1 - Pena Resume _quoted_.pdf");
  assert.equal(decodeURIComponent(m[2]), name, "the exact name decodes back");
  assert.doesNotMatch(m[2], /[*'()]/, "RFC 2231 specials are percent-encoded");
  // an all-symbol name still has a usable stand-in
  const { parts: p2 } = parseMime(buildRfc822(packetMsg({ attachments: [{ filename: "受領書.pdf", contentType: "application/pdf", bytes: PDF }] })).raw);
  assert.match(p2[1].headers[1], /filename="___\.pdf";\r\n filename\*=UTF-8''%E5%8F%97/);
  // a broken string or a very long name still makes a legal header: no throw, every line under 998
  for (const odd of ["a\uD800b.pdf", "é".repeat(400) + ".pdf"]) {
    const raw = buildRfc822(packetMsg({ attachments: [{ filename: odd, contentType: "application/pdf", bytes: PDF }] })).raw;
    assert.ok(raw.split("\r\n").every((l) => l.length <= 998), JSON.stringify(odd.slice(0, 10)));
  }
});

test("newlines anywhere in a multipart header, the file name included, cannot inject a header", () => {
  const out = buildRfc822(packetMsg({
    to: "adjuster@example.com\r\nBcc: evil@example.com",
    subject: "Packet\nBcc: evil@example.com",
    messageId: "<outbox-1@roybalconstruction.com>\r\nBcc: evil@example.com",
    attachments: [{ filename: "a.pdf\r\nBcc: evil@example.com\r\nContent-Type: text/html", contentType: "application/pdf\r\nBcc: evil@example.com", bytes: PDF }],
  }));
  const { headers, parts } = parseMime(out.raw);
  const all = [...headers, ...parts.flatMap((p) => p.headers)];
  assert.ok(!all.some((l) => /^\s*Bcc:/im.test(l)), "no Bcc line anywhere");
  assert.ok(!all.some((l) => /\r\n(?![ \t])/.test(l)), "every header is one logical line");
  assert.equal(headers[1], "To: adjuster@example.com Bcc: evil@example.com");
  assert.match(headers.find((h) => h.startsWith("Message-ID:")), /^Message-ID: <[^<>\s]+>$/);
  assert.equal(parts[1].headers[0].split(";")[0], "Content-Type: application/octet-stream", "a content type that is not a bare token is replaced");
  assert.equal(parts[1].headers.filter((h) => h.startsWith("Content-Type:")).length, 1);
});
