/* Site Visit estimator — the pure half (no Deno, no network).
   Run: node --experimental-strip-types sitevisit.test.mjs */
import assert from "node:assert/strict";
import {
  isSitePath, cleanPacket, packetHasEvidence, formatTranscript, trimUtterances, buildContent, buildBatchBody,
  parseBatchResult, SITE_DRAFT_SCHEMA, SITE_SYSTEM, MAX_IMAGES, cleanQuantities, quantitiesText, MAX_MEASURED_ROOMS,
  kindFromCustomId, customIdFor,
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

test("the image budget is 150 and drops from the tail: notes, then photos, then the newest stills", () => {
  assert.equal(MAX_IMAGES, 150);
  const img = (n) => ({ path: "sitevisit/j/" + n, mime: "image/jpeg" });
  const notes = Array.from({ length: 10 }, (_, i) => img("n" + (i + 1)));
  // packetForDraft() lists photos before stills, stills in capture order, so
  // the newest stills sit at the end of the array and fall off first
  const photos = Array.from({ length: 20 }, (_, i) => img("p" + (i + 1)));
  const stills = Array.from({ length: 130 }, (_, i) => img("s" + String(i + 1).padStart(3, "0")));
  const p = cleanPacket({ notes, photos: [...photos, ...stills] });
  assert.equal(p.notes.length, 10);
  assert.equal(p.photos.length, 140);
  assert.ok(p.photos[p.photos.length - 1].path.endsWith("s120"));
  const kept = new Set(p.photos.map((f) => f.path));
  for (let i = 121; i <= 130; i++) assert.ok(!kept.has("sitevisit/j/s" + i), "s" + i + " should be dropped");
  for (let i = 1; i <= 20; i++) assert.ok(kept.has("sitevisit/j/p" + i), "p" + i + " should be kept");
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

test("utterances are kept as data, trimmed to four fields", () => {
  const u = trimUtterances({
    metadata: { duration: 131.2 },
    results: { utterances: [
      { start: 0.4, end: 2.1, speaker: 0, transcript: "Kitchen. LVP over OSB.", confidence: 0.98, channel: 0, id: "u1", words: [{ word: "kitchen" }] },
      { start: 60.2, end: 63.9, speaker: 1, transcript: "  Instruction: flood cut to four feet on the sink wall.  ", confidence: 0.91, channel: 0, id: "u2", words: [] },
      { start: 70, end: 71, speaker: 0, transcript: "   ", id: "u3" },
      { start: 131, speaker: 0, transcript: "End kitchen.", id: "u4" },
    ] },
  });
  assert.deepEqual(u, [
    { start: 0.4, end: 2.1, speaker: 0, text: "Kitchen. LVP over OSB." },
    { start: 60.2, end: 63.9, speaker: 1, text: "Instruction: flood cut to four feet on the sink wall." },
    { start: 131, end: 131, speaker: 0, text: "End kitchen." },
  ]);
  assert.equal(u[2].end, u[2].start);                      // a missing end never runs backwards
  assert.deepEqual(trimUtterances({}), []);
  assert.deepEqual(trimUtterances(undefined), []);
  assert.deepEqual(trimUtterances({ results: { channels: [{ alternatives: [{ transcript: "flat only" }] }] } }), []);
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

test("the prompt explains clip headers and cites the clip's room", () => {
  const packet = cleanPacket({
    transcript:
      "— Clip 1 · Kitchen · 2:14 —\n[00:02] Kitchen. LVP over OSB.\n[02:10] Instruction: take it to four feet on the sink wall.\n\n" +
      "— Clip 2 · Hall · 1:05 —\n[00:01] Hall. Same LVP.",
  });
  const c = buildContent({ packet, signed: {}, facts: {}, rulesText: "", catalogText: "" });
  const t = c[c.length - 1].text;
  assert.ok(t.includes("— Clip 1 · Kitchen · 2:14 —") && t.includes("— Clip 2 · Hall · 1:05 —"));
  assert.ok(t.includes("each clip opens with a header line — Clip n · Room · length —"));
  assert.ok(t.includes("minutes:seconds into THAT clip"));
  assert.ok(t.includes("walk clip room and timestamp"));
  assert.ok(t.includes("The room named at the top of a clip is the room every line from that clip belongs to"));
  const schema = JSON.stringify(SITE_DRAFT_SCHEMA);
  assert.ok(schema.includes("walk Kitchen 02:14"));
  assert.ok(!schema.includes("walk 14:20"));
  assert.ok(SITE_SYSTEM.includes("narrated walk clips"));
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

/* ---------- M3: measured quantities (Magicplan design §5, brief §5.1) ---------- */
const ROOM = { name: "Living Room", floorSF: 214, perimLF: 58, ceilingFt: 8, wallSF: 465, wallSFNet: 403, doors: 2, windows: 3, volumeCF: 1715 };
const FACTS = { job: { customer: "x" } };
const ARGS = (packet) => ({ packet, signed: {}, facts: FACTS, rulesText: "RULES", catalogText: "CAT", kind: "claim" });
const textOf = (content) => content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

test("the measured-quantities block renders one cited line per room, ahead of the typed scope, with its rule", () => {
  const packet = cleanPacket({ typedScope: "baseboard", magicplanQuantities: { scannedAt: "2026-09-26T22:41:00Z", units: "imperial", rooms: [ROOM, { ...ROOM, name: "Hall", doors: 1, windows: 0, wallSFNet: 0 }] } });
  assert.equal(packet.magicplanQuantities.rooms.length, 2);
  const t = textOf(buildContent(ARGS(packet)));
  assert.match(t, /MEASURED QUANTITIES \(Magicplan LiDAR, 2026-09-26/);
  assert.match(t, /- Living Room: 214 ft² floor, 58 LF perimeter, 8 ft ceiling, 465 ft² walls \(403 ft² net of openings\), 2 doors, 3 windows, 1,715 ft³/);
  assert.match(t, /- Hall: .*1 door, 1,715 ft³/);
  assert.ok(t.indexOf("MEASURED QUANTITIES") < t.indexOf("OWNER'S TYPED SCOPE"));
  assert.match(t, /Use MEASURED QUANTITIES over anything read off the report PDF/);
  assert.match(t, /Cite them as 'Magicplan: 214 ft² floor, 58 LF perimeter'/);
});

test("an empty or absent block renders nothing — no section, no rule", () => {
  for (const q of [undefined, null, {}, { rooms: [] }, { rooms: [{ name: "", floorSF: 9 }] }, { rooms: [{ name: "Ghost", floorSF: 0, perimLF: 0 }] }]) {
    const packet = cleanPacket({ typedScope: "x", magicplanQuantities: q });
    assert.equal(packet.magicplanQuantities, null);
    assert.equal(quantitiesText(packet.magicplanQuantities), "");
    const t = textOf(buildContent(ARGS(packet)));
    assert.doesNotMatch(t, /MEASURED QUANTITIES/);
    assert.doesNotMatch(t, /read off the report PDF/);
  }
  assert.equal(packetHasEvidence(cleanPacket({ magicplanQuantities: { rooms: [ROOM] } })), false);   // measurements alone are not a packet
});

test("metric input never reaches the prompt un-converted: a block that says metric comes out in feet", () => {
  const q = cleanQuantities({ scannedAt: "2026-09-26", units: "metric", rooms: [{ name: "Salon", floorSF: 19.92, perimLF: 17.74, ceilingFt: 2.44, wallSF: 43.24, wallSFNet: 37.44, doors: 2, windows: 3, volumeCF: 48.57 }] });
  assert.equal(q.units, "imperial");
  assert.deepEqual(q.rooms[0], { name: "Salon", floorSF: 214, perimLF: 58, ceilingFt: 8, wallSF: 465, wallSFNet: 403, doors: 2, windows: 3, volumeCF: 1715 });
  const t = quantitiesText(q);
  assert.match(t, /214 ft² floor, 58 LF perimeter, 8 ft ceiling/);
  assert.doesNotMatch(t, /m²|m³|\bm\b/);
  // imperial passes through untouched, and junk is bounded
  const big = cleanQuantities({ units: "imperial", rooms: Array.from({ length: 200 }, (_, i) => ({ name: "R" + i, floorSF: 10, perimLF: "x", doors: -3, windows: "2" })) });
  assert.equal(big.rooms.length, MAX_MEASURED_ROOMS);
  assert.deepEqual(big.rooms[0], { name: "R0", floorSF: 10, perimLF: 0, ceilingFt: 0, wallSF: 0, wallSFNet: 0, doors: 0, windows: 2, volumeCF: 0 });
});

/* ---------- the XACTIMATE REFERENCE tier (synthetic block; the real data never enters the repo) ---------- */
const REF_BLOCK = "XACTIMATE REFERENCE CODES — from Roybal's own past Xactimate estimates. Use one ONLY when no PRICE CATALOG row fits.\nZZZ TST2 | Test reference row | SF | Replace | ref $4.00 (5 est)";

test("the reference block rides inside the final text block, immediately before PRICE CATALOG", () => {
  const packet = cleanPacket({ typedScope: "Kitchen flood cut" });
  const c = buildContent({ ...ARGS(packet), referenceText: REF_BLOCK });
  const t = c[c.length - 1].text;
  const iRef = t.indexOf("XACTIMATE REFERENCE CODES"), iCat = t.indexOf("PRICE CATALOG (Fairbanks Xactimate");
  assert.ok(iRef > 0, "reference block present");
  assert.ok(iCat > iRef, "reference block before the catalog");
  assert.equal(t.slice(iRef, iCat), REF_BLOCK + "\n\n", "nothing between the reference block and the catalog");
  assert.ok(t.indexOf("COMPANY RATES") < iRef, "after the company rates");
  assert.ok(t.includes("ZZZ TST2 | Test reference row | SF | Replace | ref $4.00 (5 est)"));
  // it stays text in the last block — never its own content block
  assert.equal(c.filter((b) => b.type === "text" && String(b.text).includes("XACTIMATE REFERENCE")).length, 1);
  // a claim with a reference block still never reads as a construction estimate
  assert.ok(!t.includes("CONSTRUCTION ESTIMATE"));
});

test("no reference text, an empty one, or a construction job renders no reference section", () => {
  const packet = cleanPacket({ typedScope: "x" });
  for (const referenceText of [undefined, "", "   "]) {
    const t = textOf(buildContent({ ...ARGS(packet), referenceText }));
    assert.doesNotMatch(t, /XACTIMATE REFERENCE/);
    // the catalog still follows the company rates directly
    assert.match(t, /\(none given: price labor from the LAB rows of the catalog\)\n\nPRICE CATALOG/);
  }
  const build = buildContent({ ...ARGS(packet), kind: "construction", referenceText: REF_BLOCK });
  assert.doesNotMatch(textOf(build), /XACTIMATE REFERENCE/);
});

test("the batch custom_id carries the kind, and old ids read as unknown", () => {
  const u = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(customIdFor("claim", u), "sv-x-" + u);
  assert.equal(customIdFor("construction", u), "sv-c-" + u);
  assert.equal(kindFromCustomId(customIdFor("claim", u)), "claim");
  assert.equal(kindFromCustomId(customIdFor("construction", u)), "construction");
  for (const old of ["sv-" + u, "sv-1", "", undefined, null, 42, "x-sv-x-1", "SV-X-1"]) assert.equal(kindFromCustomId(old), "unknown", String(old));
  // Anthropic's custom_id limit: 1-64 chars of [A-Za-z0-9_-]
  for (const k of ["claim", "construction"]) assert.match(customIdFor(k, u), /^[A-Za-z0-9_-]{1,64}$/);
  const b = buildBatchBody({ customId: customIdFor("claim", u), model: "m", effort: "high", content: [] });
  assert.equal(kindFromCustomId(b.requests[0].custom_id), "claim");
});

console.log(`\n${pass} site-visit tests passed`);
