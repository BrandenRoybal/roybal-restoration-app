/* Draft runner tests: POST /draft on the real HTTP server, with
   globalThis.fetch stubbed for Anthropic (SSE + batches) and the
   storage upload the outcome lands in.
   Run: npm test */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.LLM_API_KEY = "key";
process.env.PHONE_RELAY_TOKEN = "sesame";

const { signBody } = await import("../../../supabase/functions/_shared/sitedraft.ts");

/* ---------- fetch stub (local requests pass through) ---------- */
const realFetch = globalThis.fetch;
const LOG = [];
const writes = [];
const batches = [];
let gate = null;          // when set, the Messages stream waits on it before sending
const enc = new TextEncoder();
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const draftText = JSON.stringify({ lossSummary: "Bath", items: [{ desc: "Remove drywall", qty: 8, unit: "SF" }] });
const GOOD = [
  sse({ type: "message_start", message: { model: "claude-fable-5-1", usage: { input_tokens: 900, output_tokens: 1 } } }),
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: draftText } }),
  sse({ type: "content_block_stop", index: 0 }),
  sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 400 } }),
  sse({ type: "message_stop" }),
].join("");

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts);
  LOG.push({ url: u, opts });
  if (u === "https://api.anthropic.com/v1/messages") {
    const held = gate;
    const signal = opts.signal;
    return new Response(new ReadableStream({
      async start(c) {
        signal?.addEventListener("abort", () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
        if (held) await held;
        if (signal?.aborted) return;
        c.enqueue(enc.encode(GOOD));
        c.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  if (u === "https://api.anthropic.com/v1/messages/batches") {
    batches.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ id: "msgbatch_fly" + batches.length }), { status: 200 });
  }
  if (u.startsWith("https://stub.supabase.co/storage/v1/object/upload/sign/field-media/sitevisit/drafts/")) {
    writes.push({ url: u, body: JSON.parse(opts.body), headers: opts.headers });
    return new Response('{"Key":"x"}', { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

const { createAgentServer } = await import("../server.mjs");
const { drainDrafts, liveDraftCount, MAX_LIVE_DRAFTS } = await import("../draft.mjs");
let http, base;
before(() => new Promise((r) => { http = createAgentServer(); http.listen(0, () => { base = `http://127.0.0.1:${http.address().port}`; r(); }); }));
after(() => new Promise((r) => http.close(r)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const keyN = () => (n++).toString(16).padStart(32, "a");
const jobFor = (key, over = {}) => ({
  v: 1, issuedAt: Date.now(), customId: "sv-x-fly-1",
  params: { model: "claude-fable-5-1", max_tokens: 64000, messages: [{ role: "user", content: "packet" }] },
  resultUrl: `/object/upload/sign/field-media/sitevisit/drafts/${key}.json?token=up.tok-1`,
  ...over,
});
async function post(job, { secret = "key", raw } = {}) {
  const body = raw ?? JSON.stringify(job);
  const res = await realFetch(`${base}/draft`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-draft-signature": await signBody(secret, body) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function until(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(10); }
}
const llmCalls = () => LOG.filter((e) => e.url === "https://api.anthropic.com/v1/messages").length;

/* ---------- tests ---------- */
test("only a POST is a draft; the health check is untouched", async () => {
  assert.equal((await realFetch(`${base}/draft`)).status, 405);
  assert.equal(await (await realFetch(`${base}/healthz`)).text(), "ok");
});

test("a job signed with another key is refused before a token is spent", async () => {
  const before = llmCalls();
  const r = await post(jobFor(keyN()), { secret: "some-other-key" });
  assert.equal(r.status, 401);
  assert.equal(llmCalls(), before);
});

test("a stale or malformed job is refused", async () => {
  assert.equal((await post(jobFor(keyN(), { issuedAt: Date.now() - 5 * 60_000 }))).status, 400);
  assert.equal((await post(null, { raw: "not json" })).status, 400);
  assert.equal((await post(jobFor(keyN(), { resultUrl: "https://elsewhere.example/x" }))).status, 400);
});

test("a good job answers 202 at once, streams on this machine, and writes the finished draft", async () => {
  const key = keyN();
  const w0 = writes.length;
  const r = await post(jobFor(key));
  assert.equal(r.status, 202);
  assert.equal(r.body.runner, "fly");
  assert.ok(r.body.budgetSecs >= 1500, "the long budget, not the edge's 340 s");
  await until(() => writes.length > w0);
  const out = writes.at(-1);
  assert.ok(out.url.includes(`/drafts/${key}.json`));
  assert.equal(out.body.type, "message");
  assert.equal(out.body.message.content[0].text, draftText);
  assert.equal(out.headers.apikey, "anon");
  const call = LOG.findLast((e) => e.url === "https://api.anthropic.com/v1/messages");
  assert.equal(JSON.parse(call.opts.body).stream, true);
  assert.equal(call.opts.headers["x-api-key"], "key");
  await until(() => liveDraftCount() === 0);
});

test("a retried start for the same draft doesn't run it twice", async () => {
  let open; gate = new Promise((r) => { open = r; });
  const job = jobFor(keyN());
  const calls0 = llmCalls();
  assert.equal((await post(job)).status, 202);
  const again = await post(job);
  assert.equal(again.status, 202);
  assert.equal(again.body.already, true);
  await sleep(30);
  assert.equal(llmCalls(), calls0 + 1);
  gate = null; open();
  await until(() => liveDraftCount() === 0);
});

test(`past ${MAX_LIVE_DRAFTS} drafts at once it says busy, and the start sends the next one to the edge`, async () => {
  let open; gate = new Promise((r) => { open = r; });
  for (let i = 0; i < MAX_LIVE_DRAFTS; i++) assert.equal((await post(jobFor(keyN()))).status, 202);
  assert.equal((await post(jobFor(keyN()))).status, 503);
  gate = null; open();
  await until(() => liveDraftCount() === 0);
});

test("stopping the machine queues every draft still running, once each", async () => {
  let open; gate = new Promise((r) => { open = r; });
  const keys = [keyN(), keyN()];
  for (const k of keys) assert.equal((await post(jobFor(k))).status, 202);
  await sleep(30);
  const b0 = batches.length, w0 = writes.length;
  await drainDrafts("the draft machine restarted (SIGINT)");
  assert.equal(batches.length, b0 + 2);
  const outs = writes.slice(w0);
  assert.deepEqual(outs.map((o) => o.body.type), ["batch", "batch"]);
  for (const k of keys) assert.ok(outs.some((o) => o.url.includes(`/drafts/${k}.json`)));
  gate = null; open();
  await until(() => liveDraftCount() === 0);
  await sleep(30);
  assert.equal(writes.length, w0 + 2, "the stream finishing afterwards writes nothing more");
});

test("an oversized body is refused", async () => {
  const r = await post(null, { raw: "x".repeat(16 * 1024 * 1024 + 10) });
  assert.equal(r.status, 413);
});
