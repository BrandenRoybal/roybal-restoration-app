/* Site Visit direct run — the pure half (no Deno, no network).
   Run: node --experimental-strip-types sitedraft.test.mjs */
import assert from "node:assert/strict";
import {
  directIdFor, parseDirectId, directPaths, runBudgetMs, fallbackForStatus, readOutcome, asBatchLine, batchBodyFor,
  readJob, signBody, sameSignature, splitSse, StreamAssembler,
  DIRECT_RUN_BUDGET_MS, DIRECT_STALE_MS, DIRECT_LOST_MS, JOB_MAX_AGE_MS,
} from "./sitedraft.ts";
import { isSitePath, buildBatchBody, buildMessageParams, parseBatchResult } from "../roybal-ai-office/sitevisit.ts";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
const KEY = "0123456789abcdef0123456789abcdef";

await test("a direct id round-trips its start time and key, and never looks like a batch", () => {
  const id = directIdFor(1790000000000, KEY);
  assert.match(id, /^svd_[0-9a-z]+_[0-9a-f]{32}$/);
  assert.deepEqual(parseDirectId(id), { startMs: 1790000000000, key: KEY });
  assert.equal(parseDirectId("msgbatch_01abc"), null);
  assert.equal(parseDirectId("svd_zz_" + KEY.slice(1)), null);          // short key
  assert.equal(parseDirectId("svd_abc123_" + KEY + "/../x"), null);
  assert.equal(parseDirectId(undefined), null);
  assert.throws(() => directIdFor(1, "../etc"));
});

await test("every file the run leaves is a site-visit path the bucket rules accept", () => {
  const p = directPaths(KEY);
  for (const path of [p.request, p.result, p.lock]) assert.equal(isSitePath(path), true, path);
  assert.equal(p.result, `sitevisit/drafts/${KEY}.json`);
});

await test("the stream gets the worker's budget from boot, and the timings nest", () => {
  assert.equal(runBudgetMs(1000, 1000), DIRECT_RUN_BUDGET_MS);
  assert.equal(runBudgetMs(1000, 1000 + DIRECT_RUN_BUDGET_MS + 5), 0);
  assert.ok(DIRECT_RUN_BUDGET_MS < 400_000, "inside the 400 s wall clock");
  assert.ok(DIRECT_STALE_MS > 400_000 + 60_000, "a live run is never rescued");
  assert.ok(DIRECT_LOST_MS > DIRECT_STALE_MS);
});

await test("overload, rate limits and server errors queue the draft; a bad request does not", () => {
  for (const s of [429, 500, 502, 503, 529]) assert.equal(fallbackForStatus(s), "batch", String(s));
  for (const s of [400, 401, 403, 404, 413]) assert.equal(fallbackForStatus(s), "error", String(s));
});

await test("readOutcome accepts the three outcomes and nothing else", () => {
  const m = readOutcome({ v: 1, type: "message", customId: "sv-x-1", message: { content: [] }, ms: 5 });
  assert.equal(m.type, "message");
  const b = readOutcome({ v: 1, type: "batch", customId: "sv-x-1", batchId: "msgbatch_01AB", reason: "cut off", lost: { inTok: 80000, outTok: -3 } });
  assert.deepEqual(b.lost, { inTok: 80000, outTok: 0 });
  assert.equal(readOutcome({ v: 1, type: "batch", customId: "sv-x-1", batchId: "https://evil" }), null);
  assert.equal(readOutcome({ v: 1, type: "error", customId: "", error: "nope" }).error, "nope");
  assert.equal(readOutcome({ v: 2, type: "message", message: {} }), null);
  assert.equal(readOutcome(null), null);
  assert.equal(readOutcome("x"), null);
});

await test("the batch fallback carries exactly the params the direct call ran", () => {
  const content = [{ type: "text", text: "packet" }];
  const params = buildMessageParams({ model: "claude-fable-5-1", effort: "high", content });
  assert.deepEqual(batchBodyFor("sv-c-1", params), buildBatchBody({ customId: "sv-c-1", model: "claude-fable-5-1", effort: "high", content }));
  assert.equal(params.max_tokens, 64000);
  assert.equal(params.stream, undefined, "the draft function adds stream, the batch never sees it");
});

await test("a signed job is only accepted fresh, whole and pointed at a drafts result", () => {
  const now = 1790000000000;
  const good = { v: 1, issuedAt: now - 1000, customId: "sv-x-3f2c-11", params: { model: "m", messages: [] },
    resultUrl: `/object/upload/sign/field-media/sitevisit/drafts/${KEY}.json?token=eyJhbGciOi.J9.x-y_z` };
  assert.ok(readJob(good, now));
  assert.equal(readJob({ ...good, issuedAt: now - JOB_MAX_AGE_MS - 1 }, now), null, "replayed");
  assert.equal(readJob({ ...good, resultUrl: "/object/upload/sign/field-media/sitevisit/p1/report.pdf?token=t" }, now), null, "not a drafts file");
  assert.equal(readJob({ ...good, resultUrl: "https://elsewhere.example/x" }, now), null);
  assert.equal(readJob({ ...good, customId: "anything" }, now), null);
  assert.equal(readJob({ ...good, params: { model: "m" } }, now), null);
  assert.equal(readJob(null, now), null);
});

await test("the signature is the body's HMAC and a changed byte breaks it", async () => {
  const body = JSON.stringify({ a: 1 });
  const sig = await signBody("secret", body);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(sameSignature(sig, await signBody("secret", body)), true);
  assert.equal(sameSignature(sig, await signBody("secret", body + " ")), false);
  assert.equal(sameSignature(sig, await signBody("other", body)), false);
  assert.equal(sameSignature("", ""), false);
  await assert.rejects(() => signBody("", body));
});

/* A streamed run as the Messages API sends it: thinking (omitted, so only a
   signature), then the JSON draft split across deltas and chunk borders. */
const draftJson = JSON.stringify({ lossSummary: "Kitchen leak", items: [{ desc: "Remove drywall", qty: 32, unit: "SF" }], rooms: [], assumptions: [], exclusions: [], questions: [], pricingNotes: "", alternates: [], contingencyPct: 10, accuracyPct: 15, duration: "3 days" });
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const streamText = [
  sse({ type: "message_start", message: { id: "msg_1", model: "claude-fable-5-1", content: [], usage: { input_tokens: 81000, cache_read_input_tokens: 500, output_tokens: 1 } } }),
  "event: ping\ndata: {\"type\": \"ping\"}\n\n",
  sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }),
  sse({ type: "content_block_stop", index: 0 }),
  sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: draftJson.slice(0, 40) } }),
  sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: draftJson.slice(40) } }),
  sse({ type: "content_block_stop", index: 1 }),
  sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15000 } }),
  sse({ type: "message_stop" }),
].join("");

const feed = (text, size) => {
  const asm = new StreamAssembler();
  let buf = "";
  for (let i = 0; i < text.length; i += size) {
    const { events, rest } = splitSse(buf + text.slice(i, i + size));
    buf = rest;
    for (const e of events) asm.push(e);
  }
  for (const e of splitSse(buf + "\n\n").events) asm.push(e);
  return asm;
};

await test("a streamed run rebuilds into the message the batch parser already reads", () => {
  for (const size of [7, 64, 100000]) {   // chunk borders anywhere, even mid-event
    const asm = feed(streamText, size);
    assert.equal(asm.done, true);
    assert.equal(asm.error, "");
    const msg = asm.message();
    assert.equal(msg.model, "claude-fable-5-1");
    assert.equal(msg.stop_reason, "end_turn");
    assert.deepEqual(msg.content, [{ type: "text", text: draftJson }], "thinking dropped, text whole");
    const parsed = parseBatchResult(asBatchLine("sv-x-9", msg));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.draft.items.length, 1);
    assert.deepEqual(parsed.usage, { inTok: 81500, outTok: 15000 });
  }
});

await test("CRLF line endings stream the same", () => {
  const asm = feed(streamText.replace(/\n/g, "\r\n"), 33);
  assert.equal(asm.done, true);
  assert.equal(asm.message().content[0].text, draftJson);
});

await test("a run cut off mid-stream is not done and knows what it already cost", () => {
  const cut = streamText.slice(0, streamText.indexOf("content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1"));
  const asm = feed(cut, 50);
  assert.equal(asm.done, false);
  const lost = asm.lost();
  assert.equal(lost.inTok, 81500);
  assert.ok(lost.outTok >= Math.ceil(draftJson.length / 4));
});

await test("an error event mid-stream is caught, and a length cut-off stays the parser's clear error", () => {
  const over = feed(sse({ type: "message_start", message: { model: "m", usage: { input_tokens: 10 } } }) +
    sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), 20);
  assert.match(over.error, /overloaded_error/);
  const long = feed(streamText.replace('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"'), 90);
  assert.match(parseBatchResult(asBatchLine("sv-x-1", long.message())).error, /length limit/);
});

console.log(`sitedraft: ${pass} passed`);
