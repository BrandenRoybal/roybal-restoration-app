/* Site Visit estimator — the pure half (no Deno, no network).
   Run: node --experimental-strip-types sitevisit.test.mjs */
import assert from "node:assert/strict";
import {
  isSitePath, cleanPacket, packetHasEvidence, formatTranscript, buildContent, buildBatchBody,
  parseBatchResult, SITE_DRAFT_SCHEMA, MAX_IMAGES,
} from "./sitevisit.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

test("only site-visit paths in field-media are signable", () => {
  assert.equal(isSitePath("sitevisit/p_abc123/f1-report.pdf"), true);
  assert.equal(isSitePath("sitevisit/p_abc/../other/x.pdf"), false);
  assert.equal(isSitePath("0f3a" + "a".repeat(60)), false);            // a sync media hash
  assert.equal(isSitePath("sitevisit/p abc/x.pdf"), false);
  assert.equal(isSitePath("/sitevisit/p/x.pdf"), false);
  assert.equal(isSitePath(42), false);
});

test("cleanPacket drops unsafe paths, non-PDF reports and unreadable images", () => {
  const p = cleanPacket({
    reports: [{ path: "sitevisit/j1/a.pdf", mime: "application/pdf", name: "Magicplan" }, { path: "sitevisit/j1/b.docx", mime: "application/msword" }, { path: "../etc/passwd" }],
    photos: [{ path: "sitevisit/j1/p1.jpg", mime: "image/jpeg", room: "Kitchen" }, { path: "sitevisit/j1/p2.heic", mime: "image/heic" }],
    notes: [{ path: "sitevisit/j1/n1.jpg", mime: "image/jpeg; charset=binary" }],
    transcript: "[00:05] hello", typedScope: "Replace the vanity",
  });
  assert.deepEqual(p.reports.map((f) => f.path), ["sitevisit/j1/a.pdf"]);
  assert.deepEqual(p.photos.map((f) => f.path), ["sitevisit/j1/p1.jpg"]);
  assert.deepEqual(p.notes.map((f) => f.mime), ["image/jpeg"]);
  assert.equal(p.photos[0].room, "Kitchen");
});

test("notes pages win the image budget over extra photos", () => {
  const img = (i) => ({ path: `sitevisit/j/i${i}.jpg`, mime: "image/jpeg" });
  const p = cleanPacket({ notes: Array.from({ length: 10 }, (_, i) => img("n" + i)), photos: Array.from({ length: 200 }, (_, i) => img(i)) });
  assert.equal(p.notes.length, 10);
  assert.equal(p.notes.length + p.photos.length, MAX_IMAGES);
});

test("an empty packet has no evidence; any one input is enough", () => {
  assert.equal(packetHasEvidence(cleanPacket({})), false);
  assert.equal(packetHasEvidence(cleanPacket({ typedScope: "  " })), false);
  assert.equal(packetHasEvidence(cleanPacket({ typedScope: "new LVP in the hall" })), true);
  assert.equal(packetHasEvidence(cleanPacket({ reports: [{ path: "sitevisit/j/r.pdf" }] })), true);
});

test("Deepgram utterances become timestamped, speaker-labelled lines", () => {
  const t = formatTranscript({
    metadata: { duration: 3725.4 },
    results: { utterances: [
      { start: 5.2, speaker: 0, transcript: "Kitchen, take it to four feet on the sink wall." },
      { start: 861, speaker: 1, transcript: "What about the dishwasher?" },
      { start: 3700, speaker: 0, transcript: "Reset it." },
      { start: 3710, speaker: 0, transcript: "   " },
    ] },
  });
  assert.equal(t.seconds, 3725.4);
  assert.deepEqual(t.transcript.split("\n"), [
    "[00:05] Speaker 1: Kitchen, take it to four feet on the sink wall.",
    "[14:21] Speaker 2: What about the dishwasher?",
    "[1:01:40] Speaker 1: Reset it.",
  ]);
});

test("one speaker gets no speaker labels; no utterances falls back to the flat transcript", () => {
  const one = formatTranscript({ results: { utterances: [{ start: 65, speaker: 0, transcript: "Hall closet too." }] } });
  assert.equal(one.transcript, "[01:05] Hall closet too.");
  const flat = formatTranscript({ metadata: { duration: 9 }, results: { channels: [{ alternatives: [{ transcript: " just text " }] }] } });
  assert.deepEqual(flat, { transcript: "just text", seconds: 9 });
});

test("the request reads every file by URL, labels each, and ends with the instructions", () => {
  const packet = cleanPacket({
    reports: [{ path: "sitevisit/j/r.pdf", name: "Fuller crawlspace" }],
    photos: [{ path: "sitevisit/j/p.jpg", mime: "image/jpeg", room: "Crawlspace", caption: "north wall" }],
    notes: [{ path: "sitevisit/j/n.jpg", mime: "image/jpeg" }],
    transcript: "[00:10] vapor barrier is shot", typedScope: "Mitigation estimate",
  });
  const signed = { "sitevisit/j/r.pdf": "https://s/r", "sitevisit/j/p.jpg": "https://s/p", "sitevisit/j/n.jpg": "https://s/n" };
  const c = buildContent({ packet, signed, facts: { job: { property: "North Pole" } }, rulesText: "RULES", catalogText: "WTR X | row" });
  const doc = c.find((b) => b.type === "document");
  assert.deepEqual(doc.source, { type: "url", url: "https://s/r" });
  assert.equal(c.filter((b) => b.type === "image").length, 2);
  assert.ok(c.some((b) => b.type === "text" && b.text === "PHOTO 1 (room: Crawlspace · note: north wall):"));
  assert.ok(c.some((b) => b.type === "text" && b.text === "HANDWRITTEN NOTES, PAGE 1:"));
  const last = c[c.length - 1].text;
  for (const s of ["Mitigation estimate", "vapor barrier is shot", "North Pole", "RULES", "WTR X | row"]) assert.ok(last.includes(s), s);
  // nothing is ever inlined as base64
  assert.ok(!JSON.stringify(c).includes("base64"));
});

test("a file whose link could not be signed is left out, not sent blank", () => {
  const packet = cleanPacket({ photos: [{ path: "sitevisit/j/p.jpg", mime: "image/jpeg" }] });
  const c = buildContent({ packet, signed: {}, facts: {}, rulesText: "", catalogText: "" });
  assert.equal(c.filter((b) => b.type === "image").length, 0);
});

test("the batch asks for adaptive thinking and schema-shaped JSON, never forced tool use", () => {
  const b = buildBatchBody({ customId: "sv-1", model: "claude-fable-5-1", effort: "high", content: [{ type: "text", text: "x" }] });
  assert.equal(b.requests.length, 1);
  const p = b.requests[0].params;
  assert.equal(p.model, "claude-fable-5-1");
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.equal(p.output_config.effort, "high");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal(p.tool_choice, undefined);
  assert.equal(p.tools, undefined);
});

test("the output schema is structured-output safe (every object closed and fully required)", () => {
  const walk = (s, at) => {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false, at);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), at);
      for (const [k, v] of Object.entries(s.properties)) walk(v, at + "." + k);
    }
    if (s.type === "array") walk(s.items, at + "[]");
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) assert.equal(s[bad], undefined, at + " " + bad);
  };
  walk(SITE_DRAFT_SCHEMA, "draft");
});

const ok = (msg, extra = {}) => ({ custom_id: "sv-1", result: { type: "succeeded", message: {
  model: "claude-fable-5-1", stop_reason: "end_turn",
  usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 3000 },
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(msg) }], ...extra } } });

test("a finished batch parses into a draft with metered usage", () => {
  const r = parseBatchResult(ok({
    lossSummary: "Crawlspace", items: [{ room: "Crawlspace", desc: "Vapor barrier", qty: 600, unit: "SF", price: 1, basis: "Magicplan p.2", category: "", code: "", priceBasis: "estimate" }],
    rooms: [{ name: "Crawlspace", customerSummary: "Replace the plastic ground cover." }, { name: "", customerSummary: "x" }],
    assumptions: ["Access through the hatch", " "], exclusions: ["Mold testing"], questions: [], pricingNotes: "Remote freight.",
  }));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.usage, { inTok: 1200, outTok: 3000 });
  assert.equal(r.model, "claude-fable-5-1");
  assert.equal(r.draft.items.length, 1);
  assert.deepEqual(r.draft.rooms, [{ name: "Crawlspace", customerSummary: "Replace the plastic ground cover." }]);
  assert.deepEqual(r.draft.assumptions, ["Access through the hatch"]);
});

test("refusal, truncation and garbage are errors that still carry the billed usage", () => {
  for (const stop of ["refusal", "max_tokens"]) {
    const r = parseBatchResult(ok({}, { stop_reason: stop }));
    assert.ok(r.error, stop);
    assert.equal(r.usage.outTok, 3000);
  }
  const g = parseBatchResult({ result: { type: "succeeded", message: { usage: { input_tokens: 5, output_tokens: 6 }, content: [{ type: "text", text: "not json" }] } } });
  assert.ok(g.error);
  assert.deepEqual(g.usage, { inTok: 5, outTok: 6 });
});

test("an errored or expired batch explains itself and bills nothing", () => {
  const e = parseBatchResult({ result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "Unable to download the file" } } } });
  assert.match(e.error, /Unable to download the file/);
  assert.deepEqual(e.usage, { inTok: 0, outTok: 0 });
  assert.match(parseBatchResult({ result: { type: "expired" } }).error, /expired/);
});

test("a construction job is shaped by trade with the company's rates; a claim stays room by room", () => {
  const packet = cleanPacket({ typedScope: "Call center remodel" });
  const build = buildContent({ packet, signed: {}, facts: {}, rulesText: "", catalogText: "", kind: "construction", ratesText: "Plumbing & heating sub | plumbing | $200/HR" });
  const bt = build[build.length - 1].text;
  assert.ok(bt.includes("HOW TO SHAPE A CONSTRUCTION ESTIMATE") && bt.includes("'04 — Framing & carpentry'"));
  assert.ok(bt.includes("COMPANY RATES") && bt.includes("Plumbing & heating sub | plumbing | $200/HR"));
  assert.ok(!bt.includes("HOW TO SHAPE AN INSURANCE"));
  assert.ok(bt.includes("Never name a subcontractor's company"));
  const claim = buildContent({ packet, signed: {}, facts: {}, rulesText: "", catalogText: "" });
  const ct = claim[claim.length - 1].text;
  assert.ok(ct.includes("HOW TO SHAPE AN INSURANCE / RESTORATION ESTIMATE") && !ct.includes("CONSTRUCTION ESTIMATE"));
  assert.ok(ct.includes("(none given"));
});

test("alternates, contingency and accuracy come back clean and bounded", () => {
  const r = parseBatchResult(ok({
    lossSummary: "", items: [], rooms: [], assumptions: [], exclusions: [], questions: [], pricingNotes: "",
    alternates: [{ title: "Keep the tile", description: "Deduct", baseCost: -3708 }, { title: " ", description: "x", baseCost: 5 }],
    contingencyPct: 15, accuracyPct: 400, duration: " 7-9 weeks ",
  }));
  assert.deepEqual(r.draft.alternates, [{ title: "Keep the tile", description: "Deduct", baseCost: -3708 }]);
  assert.equal(r.draft.contingencyPct, 15);
  assert.equal(r.draft.accuracyPct, 50);
  assert.equal(r.draft.duration, "7-9 weeks");
});

console.log(`\n${pass} site-visit tests passed`);
