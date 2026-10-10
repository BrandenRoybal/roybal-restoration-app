import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { emailAdapter, classifyGmailError, classifyPacketError, staleEmailReason } from "../adapters/email.mjs";
import { deliverOne } from "../lanes/outbox.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, outboxRow } from "./helpers.mjs";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN = "https://oauth2.googleapis.com/token";
const HOUR = 3600_000;
const emailRow = (over = {}) => outboxRow({
  channel: "email", operation: "email.send@1",
  payload: { to: "pm@example.com", subject: "Estimate", body: "Hello", cc: "cc@example.com" },
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});
const freshToken = { id: "t1", account: "info@roybalconstruction.com", access_token: "at-1", refresh_token: "rt-1",
  expires_at: new Date(Date.now() + 3600_000).toISOString() };

test("send uses the stored token when fresh, posts the raw message, and writes the adopt record", async () => {
  const cfg = testConfig();
  const fetch = fakeFetch([{ match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-1", threadId: "th-1" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [{ id: "c-1" }] } });
  const log = recordingLog();
  const row = emailRow();
  const out = await emailAdapter({ cfg, supa, log, fetch }).send(row);
  assert.deepEqual(out, { providerId: "gm-1", providerStatus: "sent" });
  assert.equal(fetch.calls.length, 1, "no token refresh");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer at-1");
  const raw = Buffer.from(fetch.calls[0].body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.match(raw, /^From: info@roybalconstruction\.com\r\nTo: pm@example\.com\r\nCc: cc@example\.com\r\nSubject: Estimate/);
  const rec = supa.calls.insert.find((c) => c.table === "email_messages");
  assert.ok(rec, "email_messages row written");
  assert.equal(rec.rows[0].sent_by, `outbox:${row.id}`);
  assert.equal(rec.rows[0].direction, "out");
  assert.equal(rec.rows[0].gmail_id, "gm-1");
  assert.equal(rec.rows[0].thread_id, "th-1");
  assert.equal(rec.rows[0].contact_id, "c-1");
  assert.equal(rec.rows[0].read_by_office, true);
  assert.equal(rec.rows[0].matched_by, "sent");
  assert.equal(rec.rows[0].job_id, row.job_id, "filed under the outbox row's job, as gmail-proxy files its sends");
});

test("the sent record carries the job id as text, and null when the row has no job", async () => {
  const send = async (over) => {
    const fetch = fakeFetch([{ match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-j", threadId: "th-j" } }) }]);
    const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [] } });
    await emailAdapter({ cfg: testConfig(), supa, log: recordingLog(), fetch }).send(emailRow(over));
    return supa.calls.insert.find((c) => c.table === "email_messages").rows[0].job_id;
  };
  assert.equal(await send({ job_id: "9a1b7c3e-0000-4000-8000-00000000abcd" }), "9a1b7c3e-0000-4000-8000-00000000abcd");
  assert.equal(await send({ job_id: null }), null);
  assert.equal(await send({ job_id: undefined }), null);
});

test("an expiring token is refreshed with the Fly-held client secret and written back", async () => {
  const cfg = testConfig();
  const stale = { ...freshToken, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const fetch = fakeFetch([
    { match: (u) => u === TOKEN, reply: () => ({ body: { access_token: "at-2", expires_in: 3599 } }) },
    { match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-2", threadId: "th-2" } }) },
  ]);
  const supa = fakeSupa({ select: { gmail_tokens: [stale], contacts: [] } });
  await emailAdapter({ cfg, supa, log: recordingLog(), fetch }).send(emailRow());
  const refresh = fetch.calls.find((c) => c.url === TOKEN);
  const params = new URLSearchParams(refresh.init.body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "rt-1");
  assert.equal(params.get("client_id"), "gid");
  assert.equal(params.get("client_secret"), "gsecret");
  const send = fetch.calls.find((c) => c.url === GMAIL);
  assert.equal(send.init.headers.Authorization, "Bearer at-2");
  const wb = supa.calls.patch.find((c) => c.table === "gmail_tokens");
  assert.ok(wb && wb.query === "id=eq.t1");
  assert.equal(wb.patch.access_token, "at-2");
});

test("no connected account, a bad address, and Gmail's verdicts are classified", async () => {
  const cfg = testConfig();
  const ctx = { cfg, supa: fakeSupa({ select: { gmail_tokens: [] } }), log: recordingLog(), fetch: fakeFetch([]) };
  await assert.rejects(emailAdapter(ctx).send(emailRow()), (e) => e.permanent === false && /not connected/.test(e.message));

  const ctx2 = { ...ctx, supa: fakeSupa({ select: { gmail_tokens: [freshToken] } }) };
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "nope", subject: "x", body: "y" } })), (e) => e.permanent === true);
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "a@b.co", subject: "x", body: "" } })), (e) => e.permanent === true);
  await assert.rejects(emailAdapter(ctx2).send(emailRow({ payload: { to: "a@b.co", subject: "", body: "y" } })), (e) => e.permanent === true);
  assert.equal(ctx.fetch.calls.length, 0, "nothing sent for a row that can never send");

  assert.equal(classifyGmailError(400, '{"error":{"message":"Invalid to header"}}').permanent, true);
  assert.equal(classifyGmailError(400, '{"error":{"message":"Recipient address required"}}').permanent, true);
  assert.equal(classifyGmailError(401, "unauthorized").permanent, false);
  assert.equal(classifyGmailError(429, "rate").permanent, false);
  assert.equal(classifyGmailError(503, "backend").permanent, false);
});

test("findPrior adopts the email_messages row tagged with the outbox id", async () => {
  const cfg = testConfig();
  const row = emailRow({ attempts: 2 });
  const supa = fakeSupa({ select: { email_messages: [{ id: "e1", gmail_id: "gm-9", thread_id: "th-9" }] } });
  const prior = await emailAdapter({ cfg, supa, log: recordingLog() }).findPrior(row);
  assert.deepEqual(prior, { providerId: "gm-9", providerStatus: "sent" });
  assert.match(supa.calls.select[0].query, /direction=eq\.out&sent_by=eq\.outbox%3A/);
  assert.equal(await emailAdapter({ cfg, supa: fakeSupa(), log: recordingLog() }).findPrior(row), null);
});

test("an email older than EMAIL_MAX_AGE_HOURS is refused as permanent before any Google call, naming its age", async () => {
  const fetch = fakeFetch([{ match: () => true, reply: () => ({ body: { id: "gm-late" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [] } });
  const adapter = emailAdapter({ cfg: testConfig({ emailMaxAgeHours: 48 }), supa, log: recordingLog(), fetch });

  await assert.rejects(adapter.send(emailRow({ created_at: new Date(Date.now() - 50 * HOUR).toISOString() })), (e) => {
    assert.equal(e.permanent, true);
    assert.match(e.message, /waited 50 hours/);
    assert.match(e.message, /48-hour limit \(EMAIL_MAX_AGE_HOURS\)/);
    assert.match(e.message, /not sent/);
    return true;
  });
  await assert.rejects(adapter.send(emailRow({ created_at: new Date(Date.now() - 5 * 24 * HOUR).toISOString() })),
    (e) => e.permanent === true && /waited 5 days/.test(e.message));
  await assert.rejects(adapter.send(emailRow({ created_at: null })),
    (e) => e.permanent === true && /age can't be checked; it was not sent/.test(e.message));
  assert.equal(fetch.calls.length, 0, "no token refresh and no Gmail send for a stale row");
  assert.equal(supa.calls.select.filter((c) => c.table === "gmail_tokens").length, 0, "the token is not even read");

  // Inside the limit it sends; the limit follows the config.
  await adapter.send(emailRow({ created_at: new Date(Date.now() - 47 * HOUR).toISOString() }));
  assert.equal(fetch.calls.filter((c) => c.url === GMAIL).length, 1);
  const tight = emailAdapter({ cfg: testConfig({ emailMaxAgeHours: 2 }), supa, log: recordingLog(), fetch });
  await assert.rejects(tight.send(emailRow({ created_at: new Date(Date.now() - 3 * HOUR).toISOString() })),
    (e) => e.permanent === true && /waited 3 hours in line, past the 2-hour limit/.test(e.message));
  // A config built without the field (an older caller) still gets the 48-hour default, never no limit.
  const bare = testConfig();
  delete bare.emailMaxAgeHours;
  await assert.rejects(emailAdapter({ cfg: bare, supa, log: recordingLog(), fetch })
    .send(emailRow({ created_at: new Date(Date.now() - 49 * HOUR).toISOString() })), (e) => e.permanent === true);

  assert.equal(staleEmailReason({ created_at: "2026-10-01T00:00:00Z" }, 48, Date.parse("2026-10-03T00:00:00Z")), null, "exactly at the limit still sends");
  assert.match(staleEmailReason({ created_at: "2026-10-01T00:00:00Z" }, 1, Date.parse("2026-10-01T01:30:00Z")), /waited 1 hour in line/);
});

test("through the lane: a stale email goes dead with the reason, but an old one an earlier attempt sent is adopted", async () => {
  const cfg = testConfig({ emailMaxAgeHours: 48 });
  const old = new Date(Date.now() - 72 * HOUR).toISOString();

  const fetch = fakeFetch([{ match: () => true, reply: () => ({ body: { id: "gm-late" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], email_messages: [] } });
  const ctx = { cfg, supa, log: recordingLog(), fetch, active: { outbox: new Set() } };
  ctx.adapters = { email: emailAdapter(ctx) };
  await deliverOne(ctx, emailRow({ created_at: old }));
  const [failed] = supa.rpcs("outbox_failed");
  assert.equal(failed.p_permanent, true);
  assert.match(failed.p_error, /waited 3 days in line, past the 48-hour limit/);
  assert.equal(supa.rpcs("outbox_sent").length, 0);
  assert.equal(fetch.calls.length, 0, "nothing reached Google");
  assert.equal(supa.calls.insert.filter((c) => c.table === "email_messages").length, 0);

  const supa2 = fakeSupa({ select: { email_messages: [{ id: "e1", gmail_id: "gm-early", thread_id: "th" }] } });
  const ctx2 = { cfg, supa: supa2, log: recordingLog(), fetch, active: { outbox: new Set() } };
  ctx2.adapters = { email: emailAdapter(ctx2) };
  await deliverOne(ctx2, emailRow({ created_at: old, attempts: 2 }));
  assert.equal(supa2.rpcs("outbox_failed").length, 0, "an old row that did go out is not refused");
  const [sent] = supa2.rpcs("outbox_sent");
  assert.equal(sent.p_adopted, true);
  assert.equal(sent.p_provider_id, "gm-early");
});

// ---- plain email: the request itself, pinned ----------------------------

test("a plain email row is sent with exactly the request it always was", async () => {
  const fetch = fakeFetch([{ match: (u) => u === GMAIL, reply: () => ({ body: { id: "gm-p", threadId: "th-p" } }) }]);
  const supa = fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [] } });
  await emailAdapter({ cfg: testConfig(), supa, log: recordingLog(), fetch }).send(emailRow());
  assert.equal(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.equal(call.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.deepEqual(Object.keys(call.init).sort(), ["body", "headers", "method"], "no signal, no extra options");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, { Authorization: "Bearer at-1", "Content-Type": "application/json" });
  // The raw message as the pre-packet code built it (computed from that code).
  assert.equal(call.init.body, JSON.stringify({ raw: "RnJvbTogaW5mb0Byb3liYWxjb25zdHJ1Y3Rpb24uY29tDQpUbzogcG1AZXhhbXBsZS5jb20NCkNjOiBjY0BleGFtcGxlLmNvbQ0KU3ViamVjdDogRXN0aW1hdGUNCk1JTUUtVmVyc2lvbjogMS4wDQpDb250ZW50LVR5cGU6IHRleHQvcGxhaW47IGNoYXJzZXQ9IlVURi04Ig0KQ29udGVudC1UcmFuc2Zlci1FbmNvZGluZzogYmFzZTY0DQoNClNHVnNiRzg9" }));
  const rec = supa.calls.insert.find((c) => c.table === "email_messages").rows[0];
  assert.equal(rec.message_id_header, "");
  assert.equal(rec.subject, "Estimate");
  const plain = emailAdapter({ cfg: testConfig(), supa, log: recordingLog(), fetch });
  assert.equal(plain.channel, "email");
  assert.equal(plain.connection, "gmail");
});

// ---- packet mode ----------------------------------------------------------

const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const LIST = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const JOB = "9a1b7c3e-0000-4000-8000-00000000abcd";
const PKT_PATH = `${JOB}/PKT-2026-0007-v1-b3.pdf`;
const STORAGE = `https://stub.supabase.co/storage/v1/object/carrier-packets/${JOB}/PKT-2026-0007-v1-b3.pdf`;
// A demo stand-in for the packet PDF: every byte value, not a multiple of 57 long.
const PKT_PDF = Buffer.concat([Buffer.from("%PDF-1.7\n% demo packet\n"),
  Buffer.from(Array.from({ length: 9001 }, (_, i) => (i * 131 + 3) % 256)), Buffer.from("\n%%EOF\n")]);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const packetRow = (over = {}, att = {}) => outboxRow({
  id: "66666666-6666-4666-8666-666666666666",
  channel: "packet", operation: "packet.send@1", job_id: JOB,
  payload: {
    to: "adjuster@example.com", cc: "",
    subject: "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)",
    body: "Hello,\n\nAttached is the documentation packet for Jane Sample, 123 Example St, Fairbanks, AK 99701.\n",
    packet_version_id: "77777777-7777-4777-8777-777777777777", job_id: JOB,
    attachments: [{ bucket: "carrier-packets", path: PKT_PATH, filename: "PKT-2026-0007 v1 - Claim DEMO-12345 - Sample.pdf",
      content_type: "application/pdf", sha256: sha(PKT_PDF), bytes: PKT_PDF.length, ...att }],
  },
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});
const MSGID = "<outbox-66666666-6666-4666-8666-666666666666@roybalconstruction.com>";

/** A fetch stub that can answer with bytes (the storage download), unlike
    helpers' JSON-only one. routes: { url → (init) → Response | Error to throw }. */
function packetFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url) === k || (k.endsWith("*") && String(url).startsWith(k.slice(0, -1))));
    if (!key) return new Response(JSON.stringify({ error: `unrouted ${url}` }), { status: 599 });
    const out = await routes[key](init, calls.filter((c) => c.url === String(url)).length);
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pdfOk = () => () => new Response(PKT_PDF, { status: 200, headers: { "Content-Type": "application/pdf" } });
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const packetCtx = (fetch, over = {}) => ({
  cfg: testConfig({ channels: ["sms", "email", "packet"], ...over.cfg }),
  supa: over.supa ?? fakeSupa({ select: { gmail_tokens: [freshToken], contacts: [{ id: "c-7" }], email_messages: [] } }),
  log: recordingLog(), fetch, active: { outbox: new Set() },
});
const packetAdapter = (ctx) => emailAdapter(ctx, { packet: true });

/** Records the ms of every AbortSignal.timeout the code asks for. */
async function withTimeouts(fn) {
  const real = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return real.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = real; }
  return seen;
}

test("packet mode: channel 'packet' on the gmail connection; downloads the approved PDF, checks it, and uploads one multipart message", async () => {
  const fetch = packetFetch({
    [STORAGE]: pdfOk(),
    [UPLOAD]: () => json({ id: "gm-pkt", threadId: "th-pkt" }),
  });
  const ctx = packetCtx(fetch);
  const adapter = packetAdapter(ctx);
  assert.equal(adapter.channel, "packet");
  assert.equal(adapter.connection, "gmail");
  let out;
  const timeouts = await withTimeouts(async () => { out = await adapter.send(packetRow()); });
  assert.deepEqual(out, { providerId: "gm-pkt", providerStatus: "sent" });
  assert.deepEqual(timeouts, [60_000, 120_000], "the download and the upload are each bounded");

  assert.deepEqual(fetch.calls.map((c) => c.url), [STORAGE, UPLOAD]);
  const dl = fetch.calls[0].init;
  assert.equal(dl.method, "GET");
  assert.equal(dl.headers.apikey, "sb_secret_test");
  assert.equal(dl.headers.Authorization, "Bearer sb_secret_test");
  assert.ok(dl.signal instanceof AbortSignal);

  const up = fetch.calls[1].init;
  assert.equal(up.method, "POST");
  assert.deepEqual(up.headers, { Authorization: "Bearer at-1", "Content-Type": "message/rfc822" });
  assert.ok(up.signal instanceof AbortSignal);
  assert.ok(up.body instanceof Uint8Array, "raw bytes, not a JSON body");
  const raw = Buffer.from(up.body).toString("utf8");
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = head.split("\r\n");
  assert.equal(headers[0], "From: info@roybalconstruction.com");
  assert.equal(headers[1], "To: adjuster@example.com");
  assert.ok(!headers.some((h) => h.startsWith("Cc:")), "a blank cc is no header");
  assert.ok(headers.includes(`Message-ID: ${MSGID}`));
  assert.ok(headers.includes("Subject: Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0007 v1)"));
  const boundary = /^Content-Type: multipart\/mixed; boundary="([^"]+)"$/.exec(headers.find((h) => h.startsWith("Content-Type:")))[1];
  const parts = rest.join("\r\n\r\n").split(`--${boundary}`).slice(1, -1);
  assert.equal(parts.length, 2);
  const [textHead, textBody] = parts[0].slice(2, -2).split("\r\n\r\n");
  assert.match(textHead, /^Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64$/);
  assert.equal(Buffer.from(textBody, "base64").toString("utf8"), packetRow().payload.body.trim());
  const [pdfHead, pdfBody] = parts[1].slice(2, -2).split("\r\n\r\n");
  assert.match(pdfHead, /^Content-Type: application\/pdf; name="PKT-2026-0007 v1 - Claim DEMO-12345 - Sample\.pdf"\r\n/);
  assert.match(pdfHead, /\r\nContent-Disposition: attachment; filename="PKT-2026-0007 v1 - Claim DEMO-12345 - Sample\.pdf"\r\n/);
  assert.deepEqual(Buffer.from(pdfBody.replace(/\r\n/g, ""), "base64"), PKT_PDF, "the PDF bytes round-trip");

  const rec = ctx.supa.calls.insert.find((c) => c.table === "email_messages").rows[0];
  assert.equal(rec.direction, "out");
  assert.equal(rec.gmail_id, "gm-pkt");
  assert.equal(rec.thread_id, "th-pkt");
  assert.equal(rec.sent_by, "outbox:66666666-6666-4666-8666-666666666666");
  assert.equal(rec.message_id_header, MSGID);
  assert.equal(rec.subject, packetRow().payload.subject);
  assert.equal(rec.body_text, packetRow().payload.body.trim());
  assert.equal(rec.to_addr, "adjuster@example.com");
  assert.equal(rec.job_id, JOB, "in the job's email history");
  assert.equal(rec.from_addr, "info@roybalconstruction.com");
  assert.equal(rec.matched_by, "sent");
  assert.equal(rec.contact_id, "c-7");
});

test("packet mode: a cc is carried, and a bad to or cc is refused before anything is fetched", async () => {
  const fetch = packetFetch({ [STORAGE]: pdfOk(), [UPLOAD]: () => json({ id: "gm-cc" }) });
  const ctx = packetCtx(fetch);
  const row = packetRow();
  row.payload.cc = "office@example.com";
  await packetAdapter(ctx).send(row);
  assert.ok(Buffer.from(fetch.calls.at(-1).init.body).toString("utf8").includes("\r\nCc: office@example.com\r\n"));

  const fetch2 = packetFetch({});
  const ctx2 = packetCtx(fetch2);
  for (const p of [{ to: "" }, { to: "not an address" }, { cc: "nope" }, { subject: " " }, { body: "" }]) {
    const r = packetRow();
    Object.assign(r.payload, p);
    await assert.rejects(packetAdapter(ctx2).send(r), (e) => e.permanent === true, JSON.stringify(p));
  }
  assert.equal(fetch2.calls.length, 0);
});

test("packet mode: the attachment must be exactly one carrier-packets object with a size and sha256, else permanent and nothing is fetched", async () => {
  const fetch = packetFetch({});
  const ctx = packetCtx(fetch);
  const send = (mut) => { const r = packetRow(); mut(r.payload); return packetAdapter(ctx).send(r); };
  await assert.rejects(send((p) => { p.attachments[0].bucket = "field-media"; }),
    (e) => e.permanent === true && /carrier-packets bucket/.test(e.message));
  await assert.rejects(send((p) => { p.attachments = []; }), (e) => e.permanent === true && /exactly one attachment/.test(e.message));
  await assert.rejects(send((p) => { delete p.attachments; }), (e) => e.permanent === true);
  await assert.rejects(send((p) => { p.attachments.push({ ...p.attachments[0] }); }), (e) => e.permanent === true && /has 2/.test(e.message));
  await assert.rejects(send((p) => { p.attachments[0].path = `${JOB}/../other/x.pdf`; }), (e) => e.permanent === true && /storage path/.test(e.message));
  await assert.rejects(send((p) => { p.attachments[0].path = ""; }), (e) => e.permanent === true);
  await assert.rejects(send((p) => { p.attachments[0].sha256 = "abc"; }), (e) => e.permanent === true && /sha256/.test(e.message));
  await assert.rejects(send((p) => { p.attachments[0].bytes = 0; }), (e) => e.permanent === true && /size/.test(e.message));
  assert.equal(fetch.calls.length, 0);
});

test("packet mode: a PDF that is not the approved one (sha256 or size) is refused for good, and nothing reaches Gmail", async () => {
  const other = Buffer.from(PKT_PDF); other[50] ^= 0xff;
  const short = PKT_PDF.subarray(0, PKT_PDF.length - 1);
  for (const [what, body, why] of [["sha256", other, /\(its sha256 differs\)/], ["size", short, new RegExp(`\\(${short.length} bytes, expected ${PKT_PDF.length}\\)`)]]) {
    const fetch = packetFetch({ [STORAGE]: () => new Response(body, { status: 200 }), [UPLOAD]: () => json({ id: "nope" }) });
    const ctx = packetCtx(fetch);
    await assert.rejects(packetAdapter(ctx).send(packetRow()), (e) => {
      assert.equal(e.permanent, true, what);
      assert.match(e.message, /does not match the approved one/);
      assert.match(e.message, why);
      return true;
    });
    assert.deepEqual(fetch.calls.map((c) => c.url), [STORAGE], `${what}: never uploaded`);
    assert.equal(ctx.supa.calls.select.filter((c) => c.table === "gmail_tokens").length, 0, "the token is not even read");
  }
});

test("packet mode: a PDF missing from storage is permanent; a storage outage or a stalled download is transient", async () => {
  const cases = [
    [() => json({ statusCode: "404", error: "not_found", message: "Object not found" }, 404), true],
    [() => json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400), true],
    [() => json({ message: "upstream" }, 503), false],
    [() => json({ statusCode: "403", error: "Unauthorized", message: "invalid signature" }, 400), false],
    [() => timeoutError(), false],
    [() => new TypeError("fetch failed"), false],
  ];
  for (const [reply, perm] of cases) {
    const fetch = packetFetch({ [STORAGE]: reply, [UPLOAD]: () => json({ id: "nope" }) });
    await assert.rejects(packetAdapter(packetCtx(fetch)).send(packetRow()), (e) => e.permanent === perm, String(reply));
    assert.ok(!fetch.calls.some((c) => c.url === UPLOAD));
  }
  const fetch = packetFetch({ [STORAGE]: () => json({}, 404) });
  await assert.rejects(packetAdapter(packetCtx(fetch)).send(packetRow()), /missing from storage/);
});

test("packet mode: Gmail's 413 or a too-large refusal is permanent and says 'too large'; 5xx, 429 and a timeout are transient", async () => {
  const sizeRule = /(too[ _-]?large|\b413\b)/i;   // carrier_packet_reserve's test for "its error is about size"
  const cases = [
    [() => json({ error: { code: 413, message: "Request Entity Too Large" } }, 413), true],
    [() => new Response("<html>Request Entity Too Large</html>", { status: 413 }), true],
    [() => json({ error: { code: 400, message: "Message too large" } }, 400), true],
    [() => json({ error: { code: 400, message: "Request payload size exceeds the limit: 36700160 bytes." } }, 400), true],
    [() => json({ error: { code: 503, message: "Backend Error" } }, 503), false],
    [() => json({ error: { code: 500, message: "Internal error" } }, 500), false],
    [() => json({ error: { code: 429, message: "Too many concurrent requests; message too large to queue" } }, 429), false],
    [() => json({ error: { code: 401, message: "Invalid Credentials" } }, 401), false],
    [() => timeoutError(), false],
    [() => new TypeError("fetch failed"), false],
  ];
  for (const [reply, perm] of cases) {
    const fetch = packetFetch({ [STORAGE]: pdfOk(), [UPLOAD]: reply });
    const ctx = packetCtx(fetch);
    await assert.rejects(packetAdapter(ctx).send(packetRow()), (e) => {
      assert.equal(e.permanent, perm, `${String(reply)}: ${e.message}`);
      if (perm) assert.match(e.message, sizeRule);
      return true;
    });
    assert.equal(ctx.supa.calls.insert.filter((c) => c.table === "email_messages").length, 0, "nothing recorded as sent");
  }
  assert.equal(classifyPacketError(413, "").permanent, true);
  assert.equal(classifyPacketError(400, "Invalid To header").permanent, true, "a bad address is still permanent");
  assert.equal(classifyPacketError(403, "Rate Limit Exceeded").permanent, false);
  const fetch = packetFetch({ [STORAGE]: pdfOk(), [UPLOAD]: () => timeoutError() });
  await assert.rejects(packetAdapter(packetCtx(fetch)).send(packetRow()), /Gmail upload timed out/);
});

test("packet mode: the EMAIL_MAX_AGE_HOURS limit applies before any download or Google call", async () => {
  const fetch = packetFetch({ [STORAGE]: pdfOk(), [UPLOAD]: () => json({ id: "late" }) });
  const ctx = packetCtx(fetch, { cfg: { emailMaxAgeHours: 48 } });
  await assert.rejects(packetAdapter(ctx).send(packetRow({ created_at: new Date(Date.now() - 50 * HOUR).toISOString() })),
    (e) => e.permanent === true && /waited 50 hours in line, past the 48-hour limit/.test(e.message));
  await assert.rejects(packetAdapter(ctx).send(packetRow({ created_at: null })), (e) => e.permanent === true);
  assert.equal(fetch.calls.length, 0);
  assert.equal(ctx.supa.calls.select.filter((c) => c.table === "gmail_tokens").length, 0);
  await packetAdapter(ctx).send(packetRow({ created_at: new Date(Date.now() - 47 * HOUR).toISOString() }));
  assert.deepEqual(fetch.calls.map((c) => c.url), [STORAGE, UPLOAD]);
});

test("packet findPrior: the email_messages tag is adopted first, with no Gmail call", async () => {
  const fetch = packetFetch({});
  const supa = fakeSupa({ select: { email_messages: [{ id: "e1", gmail_id: "gm-tag", thread_id: "th" }] } });
  const prior = await packetAdapter(packetCtx(fetch, { supa })).findPrior(packetRow({ attempts: 2 }));
  assert.deepEqual(prior, { providerId: "gm-tag", providerStatus: "sent" });
  assert.match(supa.calls.select[0].query, /direction=eq\.out&sent_by=eq\.outbox%3A66666666/);
  assert.equal(fetch.calls.length, 0);
});

test("packet findPrior: no tag → the mailbox is searched for the Message-ID; a hit is adopted and recorded, a miss is null", async () => {
  const want = `${LIST}?q=${encodeURIComponent(`rfc822msgid:${MSGID}`)}&includeSpamTrash=true`;
  const fetch = packetFetch({ [want]: () => json({ messages: [{ id: "gm-found", threadId: "th-found" }], resultSizeEstimate: 1 }) });
  const ctx = packetCtx(fetch);
  let prior;
  const timeouts = await withTimeouts(async () => { prior = await packetAdapter(ctx).findPrior(packetRow({ attempts: 2 })); });
  assert.deepEqual(prior, { providerId: "gm-found", providerStatus: "sent" });
  assert.deepEqual(timeouts, [30_000]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, want);
  assert.match(fetch.calls[0].url, /\?q=rfc822msgid%3A%3Coutbox-66666666-6666-4666-8666-666666666666%40roybalconstruction\.com%3E&/);
  assert.equal(fetch.calls[0].init.method, "GET");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer at-1");
  const rec = ctx.supa.calls.insert.find((c) => c.table === "email_messages").rows[0];
  assert.equal(rec.gmail_id, "gm-found");
  assert.equal(rec.thread_id, "th-found");
  assert.equal(rec.sent_by, "outbox:66666666-6666-4666-8666-666666666666", "the next retry adopts it from the tag");
  assert.equal(rec.message_id_header, MSGID);
  assert.equal(rec.job_id, JOB);

  const miss = packetFetch({ [want]: () => json({ resultSizeEstimate: 0 }) });
  const ctx2 = packetCtx(miss);
  assert.equal(await packetAdapter(ctx2).findPrior(packetRow()), null);
  assert.equal(ctx2.supa.calls.insert.length, 0);
});

test("packet findPrior: when Gmail cannot be asked the attempt fails transiently (no send); a search Gmail will never answer is skipped", async () => {
  const want = `${LIST}?q=${encodeURIComponent(`rfc822msgid:${MSGID}`)}&includeSpamTrash=true`;
  for (const reply of [() => json({ error: { message: "Backend Error" } }, 503), () => json({ error: { message: "Rate Limit Exceeded" } }, 429),
    () => json({ error: { message: "User-rate limit exceeded" } }, 403), () => json({ error: { message: "Invalid Credentials" } }, 401),
    () => timeoutError(), () => new TypeError("fetch failed"), () => new Response("not json", { status: 200 })]) {
    const fetch = packetFetch({ [want]: reply });
    await assert.rejects(packetAdapter(packetCtx(fetch)).findPrior(packetRow({ attempts: 2 })),
      (e) => e.permanent === false && /cannot go twice/.test(e.message), String(reply));
  }
  // No connection at all: the same transient refusal the send would give.
  await assert.rejects(packetAdapter(packetCtx(packetFetch({}), { supa: fakeSupa({ select: { gmail_tokens: [] } }) })).findPrior(packetRow()),
    (e) => e.permanent === false && /not connected/.test(e.message));
  for (const reply of [() => json({ error: { message: "Invalid query" } }, 400),
    () => json({ error: { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, 403)]) {
    const fetch = packetFetch({ [want]: reply });
    const ctx = packetCtx(fetch);
    assert.equal(await packetAdapter(ctx).findPrior(packetRow({ attempts: 2 })), null, String(reply));
    assert.ok(ctx.log.events().includes("packet.lookup_unusable"));
  }
});

test("through the lane: an upload that timed out after Gmail took it is adopted on the retry, never sent twice", async () => {
  const want = `${LIST}?q=${encodeURIComponent(`rfc822msgid:${MSGID}`)}&includeSpamTrash=true`;
  let accepted = false;
  const fetch = packetFetch({
    [STORAGE]: pdfOk(),
    [UPLOAD]: () => { accepted = true; return timeoutError(); },   // Gmail kept it; the answer never came back
    [want]: () => json(accepted ? { messages: [{ id: "gm-kept", threadId: "th-kept" }] } : { resultSizeEstimate: 0 }),
  });
  const ctx = packetCtx(fetch);
  ctx.adapters = { packet: packetAdapter(ctx) };

  await deliverOne(ctx, packetRow({ attempts: 1 }));
  const [failed] = ctx.supa.rpcs("outbox_failed");
  assert.equal(failed.p_permanent, false);
  assert.match(failed.p_error, /Gmail upload timed out/);
  assert.equal(ctx.supa.rpcs("outbox_sent").length, 0);

  await deliverOne(ctx, packetRow({ attempts: 2 }));
  const [sent] = ctx.supa.rpcs("outbox_sent");
  assert.equal(sent.p_adopted, true);
  assert.equal(sent.p_provider_id, "gm-kept");
  assert.equal(fetch.calls.filter((c) => c.url === UPLOAD).length, 1, "one upload in all");
  const run = ctx.supa.calls.insert.filter((c) => c.table === "integration_runs").map((c) => c.rows[0]);
  assert.deepEqual(run.map((r) => [r.connection, r.ok]), [["gmail", false], ["gmail", true]]);
});

test("through the lane: a Gmail outage on the search fails the attempt transiently and uploads nothing", async () => {
  const want = `${LIST}?q=${encodeURIComponent(`rfc822msgid:${MSGID}`)}&includeSpamTrash=true`;
  const fetch = packetFetch({ [STORAGE]: pdfOk(), [UPLOAD]: () => json({ id: "gm-x" }), [want]: () => json({ error: {} }, 502) });
  const ctx = packetCtx(fetch);
  ctx.adapters = { packet: packetAdapter(ctx) };
  await deliverOne(ctx, packetRow({ attempts: 3 }));
  const [failed] = ctx.supa.rpcs("outbox_failed");
  assert.equal(failed.p_permanent, false);
  assert.match(failed.p_error, /answered 502/);
  assert.ok(!fetch.calls.some((c) => c.url === UPLOAD || c.url === STORAGE));
});
