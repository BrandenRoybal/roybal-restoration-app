import { test } from "node:test";
import assert from "node:assert/strict";
import { emailAdapter, classifyGmailError } from "../adapters/email.mjs";
import { fakeSupa, testConfig, recordingLog, fakeFetch, outboxRow } from "./helpers.mjs";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN = "https://oauth2.googleapis.com/token";
const emailRow = (over = {}) => outboxRow({
  channel: "email", operation: "email.send@1",
  payload: { to: "pm@example.com", subject: "Estimate", body: "Hello", cc: "cc@example.com" },
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
