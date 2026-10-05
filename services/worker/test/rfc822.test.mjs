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
