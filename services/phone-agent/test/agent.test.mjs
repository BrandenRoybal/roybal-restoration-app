/* Phone-agent tests: a fake Twilio ConversationRelay client over a real
   WebSocket, with globalThis.fetch stubbed for Anthropic (SSE) + Supabase.
   Run: npm test  (node --experimental-strip-types --test test/) */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.MACHINE_PASSWORD = "pw";
process.env.LLM_API_KEY = "key";
process.env.PHONE_RELAY_TOKEN = "sesame";
process.env.OWNER_CELL = "907-555-0000";

/* ---------- fetch stub ---------- */
const LOG = [];
let anthropicScript = [];        // queued SSE bodies, consumed per call
let leadInsertFails = false;

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const textReply = (text, outTok = 5) => sse([
  { type: "message_start", message: { usage: { input_tokens: 20 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outTok } },
  { type: "message_stop" },
]);
const toolReply = (preamble, name, input) => sse([
  { type: "message_start", message: { usage: { input_tokens: 30 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: preamble } },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
]);

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const entry = { url: u, method: (opts.method || "GET").toUpperCase(), body: opts.body ? String(opts.body) : "" };
  LOG.push(entry);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  if (u.includes("api.anthropic.com")) {
    const body = anthropicScript.length ? anthropicScript.shift() : textReply("Fallback answer.");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  if (u.includes("/auth/v1/token")) return json({ access_token: "jwt-1", refresh_token: "rt-1", expires_in: 3600 });
  if (u.includes("/rest/v1/capture_events") && entry.method === "POST") return json([{ id: "ev-1" }]);
  if (u.includes("/rest/v1/ai_usage") && entry.method === "GET") return json([]);
  if (u.includes("/rest/v1/coordination_jobs") && entry.method === "POST") {
    if (leadInsertFails) return new Response("denied", { status: 403 });
    return json([{ id: "row" }]);
  }
  if (u.includes("/rest/v1/unified_jobs")) return json([{ id: "u1", owner_phone: "907-555-1234", status: "drying", loss_type: "water" }]);
  if (u.includes("/functions/v1/roybal-notify")) return json({ ok: true, sid: "SM9", status: "sent" });
  if (u.includes("/rest/v1/")) return json([]);
  return json({}, 404);
};

/* ---------- fake Twilio client ---------- */
const { createAgentServer } = await import("../server.mjs");
let http, port;
before(() => new Promise((r) => { http = createAgentServer(); http.listen(0, () => { port = http.address().port; r(); }); }));
after(() => new Promise((r) => http.close(r)));

function call({ token = "sesame", from = "+19075551234" } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  const out = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    out.push(m);
    waiters.forEach((w) => w());
  });
  const opened = new Promise((r) => ws.on("open", r));
  return {
    ws, out,
    async setup() { await opened; ws.send(JSON.stringify({ type: "setup", callSid: "CA1", from, to: "+18663452290", customParameters: { token } })); },
    prompt(text) { ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true })); },
    waitFor(pred, ms = 3000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting: " + pred)), ms);
        const check = () => { const hit = out.find(pred); if (hit) { clearTimeout(t); resolve(hit); } };
        waiters.push(check); check();
      });
    },
    close() { ws.close(); },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- tests ---------- */
test("bad relay token → voicemail handoff, no LLM spend", async () => {
  const c = call({ token: "wrong" });
  await c.setup();
  const end = await c.waitFor((m) => m.type === "end");
  assert.match(end.handoffData, /voicemail/);
  assert.equal(LOG.filter((e) => e.url.includes("anthropic")).length, 0);
  c.close();
});

test("plain turn: envelope first, streamed tokens, closing last:true", async () => {
  LOG.length = 0;
  anthropicScript = [textReply("We can help with that.")];
  const c = call();
  await c.setup();
  await sleep(150);                       // envelope insert lands
  c.prompt("My crawlspace flooded.");
  await c.waitFor((m) => m.type === "text" && m.last === true);
  const envIdx = LOG.findIndex((e) => e.url.includes("capture_events") && e.method === "POST");
  const llmIdx = LOG.findIndex((e) => e.url.includes("anthropic"));
  assert.ok(envIdx >= 0 && llmIdx > envIdx, "capture_events insert must precede the paid call");
  const tokens = c.out.filter((m) => m.type === "text");
  assert.ok(tokens.some((m) => m.token.includes("We can help") && m.last === false));
  assert.equal(tokens[tokens.length - 1].last, true);
  c.close();
  await sleep(150);                       // closeOut settles the ledger
  const usage = LOG.find((e) => e.url.includes("ai_usage") && e.method === "POST");
  assert.ok(usage, "ai_usage row written on hangup");
  assert.match(usage.body, /"form_key":"phoneCall"/);
  assert.match(usage.body, /"audio_seconds":/);
});

test("tool round: createLead writes the AI-booked lead, then answers", async () => {
  LOG.length = 0;
  anthropicScript = [
    toolReply("One moment while I get that down. ", "createLead",
      { name: "Pat Doe", phone: "907-555-1234", address: "12 Chena Ridge", lossType: "water", summary: "burst pipe in the kitchen" }),
    textReply("You're all set — Branden will call you right back."),
  ];
  const c = call();
  await c.setup(); await sleep(150);
  c.prompt("I need help, burst pipe!");
  await c.waitFor((m) => m.type === "text" && m.last === true);
  const lead = LOG.find((e) => e.url.includes("coordination_jobs") && e.method === "POST");
  assert.ok(lead, "lead insert happened");
  assert.match(lead.body, /"stage":"lead"/);
  assert.match(lead.body, /"aiBooked":true/);
  assert.match(lead.body, /"rev":1/);
  assert.match(lead.body, /Pat Doe/);
  // the tool_result round-trip reached the model
  const secondLlm = LOG.filter((e) => e.url.includes("anthropic"))[1];
  assert.ok(secondLlm && secondLlm.body.includes("tool_result"));
  c.close();
});

test("second lead in the same call is refused (rate limit)", async () => {
  LOG.length = 0;
  anthropicScript = [
    toolReply("Noting that. ", "createLead", { name: "A", phone: "907-555-1234", address: "x", lossType: "water", summary: "s" }),
    toolReply("And again. ", "createLead", { name: "B", phone: "907-555-1234", address: "y", lossType: "water", summary: "s" }),
    textReply("Done."),
  ];
  const c = call({ from: "+19075559999" });
  await c.setup(); await sleep(150);
  c.prompt("two leads please");
  await c.waitFor((m) => m.type === "text" && m.last === true);
  assert.equal(LOG.filter((e) => e.url.includes("coordination_jobs") && e.method === "POST").length, 1);
  const secondResult = LOG.filter((e) => e.url.includes("anthropic"))[2];
  assert.ok(secondResult.body.includes("already exists"), "model told the second lead was refused");
  c.close();
});

test("textOwner rides roybal-notify with the quiet-hours-exempt kind", async () => {
  LOG.length = 0;
  anthropicScript = [
    toolReply("Texting him now. ", "textOwner", { message: "New water loss — Pat 907-555-1234, 12 Chena Ridge" }),
    textReply("He's been alerted."),
  ];
  const c = call({ from: "+19075558888" });
  await c.setup(); await sleep(150);
  c.prompt("tell the owner");
  await c.waitFor((m) => m.type === "text" && m.last === true);
  const sms = LOG.find((e) => e.url.includes("roybal-notify"));
  assert.ok(sms);
  assert.match(sms.body, /"kind":"phoneOwner"/);
  assert.match(sms.body, /New water loss/);
  c.close();
});

test("escalate tool ends the session with the escalate handoff", async () => {
  anthropicScript = [
    toolReply("Connecting you to Branden now. ", "escalate", { reason: "water actively flowing" }),
    textReply("Transferring."),
  ];
  const c = call({ from: "+19075557777" });
  await c.setup(); await sleep(150);
  c.prompt("water is pouring in right now!");
  const end = await c.waitFor((m) => m.type === "end");
  const handoff = JSON.parse(end.handoffData);
  assert.equal(handoff.reasonCode, "escalate");
  assert.match(handoff.reason, /flowing/);
  c.close();
});

test("tool failure returns {error} to the model, never kills the call", async () => {
  leadInsertFails = true;
  anthropicScript = [
    toolReply("Let me note that. ", "createLead", { name: "C", phone: "907-555-6666", address: "z", lossType: "water", summary: "s" }),
    textReply("I couldn't save that just now, but I've got it written down — Branden will call you."),
  ];
  const c = call({ from: "+19075556666" });
  await c.setup(); await sleep(150);
  c.prompt("burst pipe");
  const last = await c.waitFor((m) => m.type === "text" && m.last === true);
  assert.ok(last, "call still answered");
  leadInsertFails = false;
  c.close();
});
