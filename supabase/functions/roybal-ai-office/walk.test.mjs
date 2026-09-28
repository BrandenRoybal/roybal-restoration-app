/* Narrated walk → scope notes: the pure half (walk.ts). No Deno, no network.
   Run: node --experimental-strip-types supabase/functions/roybal-ai-office/walk.test.mjs
   Fixtures are hand-written; never a real customer's transcript. */
import assert from "node:assert/strict";
import {
  cleanWalkInput, buildWalkContent, parseWalkResult, countItems, missingLineProposal,
  WALK_NOTES_SCHEMA, WALK_SYSTEM, WALK_BUCKETS, MAX_STILLS,
} from "./walk.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };

const UTTS = [
  { start: 0.4, end: 2.1, speaker: 0, text: "Okay, kitchen." },
  { start: 12, end: 18, speaker: 0, text: "This base cabinet run is swollen at the toe kick, all of it goes." },
  { start: 134, end: 140, speaker: 0, text: "Take it to four feet on the sink wall." },
  { start: 150, end: 155, speaker: 1, text: "It happened maybe three days ago." },
];
const INPUT = {
  clip: { id: "c1", room: "Kitchen", utterances: UTTS },
  stills: [
    { path: "sitevisit/lead_42/s1.jpg", caption: 'walk clip Kitchen @ 0:12 · "swollen at the toe kick"', t: 12, mime: "image/jpeg" },
    { path: "sitevisit/lead_42/s2.jpg", caption: "", t: 102 },
    { path: "../etc/x.jpg", caption: "", t: 3 },
    { path: "sitevisit/lead_42/s3.heic", caption: "", t: 5, mime: "image/heic" },
    { path: "sitevisit/lead_42/s4.jpg", caption: "", t: "nope" },
  ],
  rooms: ["Kitchen", "Hall", ""], magicplanRooms: ["Kitchen", "Living Room"], jobKind: "claim",
};

test("cleanWalkInput bounds the clip: unsafe, unreadable and untimed stills are dropped, rooms are unique, kinds are pinned", () => {
  const i = cleanWalkInput(INPUT);
  assert.deepEqual(i.stills.map((s) => s.path), ["sitevisit/lead_42/s1.jpg", "sitevisit/lead_42/s2.jpg"]);
  assert.deepEqual(i.rooms, ["Kitchen", "Hall"]);
  assert.deepEqual(i.magicplanRooms, ["Kitchen", "Living Room"]);
  assert.equal(i.jobKind, "claim");
  assert.equal(cleanWalkInput({ ...INPUT, jobKind: "mitigation" }).jobKind, "mitigation");
  assert.equal(cleanWalkInput({ ...INPUT, jobKind: "anything" }).jobKind, "claim");
  assert.equal(i.clip.utterances.length, 4);
  assert.throws(() => cleanWalkInput({ clip: { id: "c1", utterances: [] } }), /no transcript/);
  assert.throws(() => cleanWalkInput({ clip: { utterances: UTTS } }), /clip's id/);
  const many = cleanWalkInput({ ...INPUT, stills: Array.from({ length: 40 }, (_, k) => ({ path: `sitevisit/j/s${k}.jpg`, t: 40 - k })) });
  assert.equal(many.stills.length, MAX_STILLS);
  assert.equal(many.stills[0].t, 1);   // sorted by time, the earliest kept
});

test("the request carries each still labelled with its second and caption, then the transcript with seconds, the allowed rooms and the job", () => {
  const i = cleanWalkInput(INPUT);
  const c = buildWalkContent(i, { "sitevisit/lead_42/s1.jpg": "https://signed/s1" });   // s2 not signed → left out
  assert.equal(c.filter((b) => b.type === "image").length, 1);
  assert.match(c[0].text, /^STILL 1 at 0:12 \(12s\) — walk clip Kitchen @ 0:12/);
  const tail = c[c.length - 1].text;
  assert.match(tail, /CLIP: c1 · recorded as room "Kitchen" · 4 utterances · 1 stills/);
  assert.match(tail, /JOB: an insurance restoration claim\./);
  assert.match(tail, /ALLOWED ROOMS: Kitchen \| Hall \| Living Room/);
  assert.match(tail, /\[0:12 · 12s\] Speaker 1: This base cabinet run/);
  assert.match(tail, /\[2:30 · 150s\] Speaker 2: It happened/);
  assert.match(WALK_SYSTEM, /quote before paraphrase/);
  assert.match(WALK_SYSTEM, /never a subcontractor's company/);
  const m = buildWalkContent(cleanWalkInput({ ...INPUT, jobKind: "mitigation" }), {});
  assert.match(m[m.length - 1].text, /readings and equipment counts you hear go to verify/);
});

test("the schema is structured-output safe: every object closed, all keys required, every item timed", () => {
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === "array") walk(node.items);
  };
  walk(WALK_NOTES_SCHEMA);
  const room = WALK_NOTES_SCHEMA.properties.rooms.items;
  for (const b of WALK_BUCKETS) assert.ok(room.properties[b].items.required.includes("at"), b + " items cite a time");
});

const RESULT = {
  clipRoom: "kitchen",
  rooms: [
    { room: "Kitchen",
      observations: [{ text: "base cabinet run swollen at the toe kick", at: 12 }, { text: "no time on this one" }],
      materials: [{ text: "oak shaker uppers", at: 30.26 }], damage: [{ text: "supply line under the sink", cause: "Cat 1, ~3 days", at: 150 }],
      quantities: [{ text: "about twelve feet of base", value: 12, unit: "LF", at: 40 }], instructions: [{ text: "Take it to four feet on the sink wall.", at: 134 }],
      preExisting: [], homeownerSaid: [{ text: "Homeowner: it happened maybe three days ago", at: 150 }], verify: [{ text: "~12 LF (est. from still 01:42)", at: 102 }],
      safety: [], trades: [{ trade: "Electrical", text: "electrician for the disposal circuit", at: 60 }, { trade: "", text: "someone for something", at: 61 }] },
    { room: "Garage", observations: [{ text: "a room the job never named", at: 200 }], materials: [], damage: [], quantities: [], instructions: [], preExisting: [], homeownerSaid: [], verify: [], safety: [], trades: [] },
    { room: "", observations: [], materials: [], damage: [], quantities: [], instructions: [{ text: "protect the floors on the way in", at: 3 }], preExisting: [], homeownerSaid: [], verify: [], safety: [], trades: [] },
  ],
};

test("parseWalkResult cites every item with {clip, at}, drops the uncited, sends an unnamed room job-wide", () => {
  const n = parseWalkResult(RESULT, { clipId: "c1", allowedRooms: ["Kitchen", "Hall"], jobKind: "claim" });
  assert.equal(n.clip, "c1");
  assert.equal(n.clipRoom, "Kitchen");   // case-insensitive match to the allowed name
  assert.equal(n.rooms.length, 1);
  const k = n.rooms[0];
  assert.equal(k.room, "Kitchen");
  assert.deepEqual(k.observations, [{ text: "base cabinet run swollen at the toe kick", clip: "c1", at: 12 }]);
  assert.deepEqual(k.materials[0], { text: "oak shaker uppers", clip: "c1", at: 30.3 });
  assert.deepEqual(k.damage[0], { text: "supply line under the sink", clip: "c1", at: 150, cause: "Cat 1, ~3 days" });
  assert.deepEqual(k.quantities[0], { text: "about twelve feet of base", clip: "c1", at: 40, value: 12, unit: "LF" });
  assert.deepEqual(k.trades, [{ text: "electrician for the disposal circuit", clip: "c1", at: 60, trade: "Electrical" }]);   // a trade-less trade is dropped
  assert.deepEqual(n.jobWide.observations, [{ text: "a room the job never named", clip: "c1", at: 200 }]);
  assert.deepEqual(n.jobWide.instructions, [{ text: "protect the floors on the way in", clip: "c1", at: 3 }]);
  assert.equal(n.dropped, 2);
  assert.equal(countItems(n), 10);
  assert.deepEqual(parseWalkResult(null, { clipId: "c9", allowedRooms: [], jobKind: "claim" }), { clip: "c9", clipRoom: "", rooms: [], jobWide: parseWalkResult({}, { clipId: "c9", allowedRooms: [], jobKind: "claim" }).jobWide, dropped: 0 });
});

test("on a mitigation clip, quantities become verify items with the spoken value — never a quantity", () => {
  const n = parseWalkResult(RESULT, { clipId: "c1", allowedRooms: ["Kitchen"], jobKind: "mitigation" });
  const k = n.rooms[0];
  assert.deepEqual(k.quantities, []);
  assert.ok(k.verify.some((v) => v.text === "about twelve feet of base (spoken: 12 LF — verify, never apply)" && v.at === 40 && v.clip === "c1"));
  assert.ok(k.verify.every((v) => !("value" in v)));
});

test("a missing-line proposal is 0004's row shape, keyed so a second draft never files the note twice", () => {
  const row = missingLineProposal({ projectId: "0f3aa2d2-1c6a-4c0e-9f2c-0d2f7f6b3c10", estimateId: "e1",
    item: { key: "c1:instructions:134:take-it-to-four", room: "Kitchen", bucket: "instructions", text: "Take it to four feet on the sink wall.", clip: "c1", at: 134 } });
  assert.equal(row.operation, "estimate.missing_line@1");
  assert.equal(row.action_type, "job");
  assert.equal(row.proposed_by_kind, "agent");
  assert.equal(row.proposed_via, "agent");
  assert.equal(row.status, "proposed");
  assert.equal(row.assigned_role, "owner");
  assert.equal(row.job_id, "0f3aa2d2-1c6a-4c0e-9f2c-0d2f7f6b3c10");
  assert.equal(row.idempotency_key, "estimate.missing_line:0f3aa2d2-1c6a-4c0e-9f2c-0d2f7f6b3c10:e1:c1:instructions:134:take-it-to-four");
  assert.deepEqual(row.input.citation, { clip: "c1", at: 134, label: "walk Kitchen 2:14" });
  assert.match(row.rationale, /walk Kitchen 2:14/);
  assert.deepEqual(row.evidence_refs, [{ kind: "walk_clip", clip: "c1", at: 134, room: "Kitchen" }]);
  assert.ok(Date.parse(row.expires_at) > Date.now() + 29 * 86400e3);
  assert.equal(missingLineProposal({ projectId: "bj-legacy", estimateId: "e", item: { key: "k", text: "t", at: 0 } }).job_id, null);   // a non-uuid id never lands in a uuid column
});

console.log(`\n${pass} walk tests passed`);
