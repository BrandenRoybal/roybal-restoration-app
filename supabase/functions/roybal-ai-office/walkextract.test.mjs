/* Walk scope notes — the pure half of walkExtract (no Deno, no network).
   Run: node --experimental-strip-types walkextract.test.mjs */
import assert from "node:assert/strict";
import {
  cleanExtractInput, buildExtractContent, parseScopeNotes, SCOPE_NOTES_SCHEMA, SCOPE_SYSTEM, SCOPE_BUCKETS, JOB_WIDE, MAX_STILLS,
} from "./walkextract.ts";
import { cleanPacket, buildContent, packetHasEvidence } from "./sitevisit.ts";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("walkExtract (scope notes)");

const clips = [{ n: 1, room: "Kitchen", seconds: 95, text: "[0:00] Kitchen.\n[0:12] Take it to four feet on the sink wall." }, { n: 2, room: "", seconds: 40, text: "[0:03] Hall bath." }];

test("cleanExtractInput keeps clips with words and stills of kept clips on safe paths", () => {
  const i = cleanExtractInput({
    jobKind: "claim", rooms: ["Kitchen", " "],
    clips: [...clips, { n: 3, room: "x", seconds: 9, text: "  " }, { n: 1, text: "dup" }, { n: 0, text: "zero" }],
    stills: [
      { path: "sitevisit/p1/a.jpg", clip: 1, at: 12, caption: "still" },
      { path: "sitevisit/p1/b.jpg", clip: 3, at: 2 },            // its clip had no words
      { path: "../etc/passwd", clip: 1, at: 1 },
      { path: "sitevisit/p1/../c.jpg", clip: 1, at: 1 },
    ],
  });
  assert.deepEqual(i.clips.map((c) => c.n), [1, 2]);
  assert.deepEqual(i.stills.map((s) => s.path), ["sitevisit/p1/a.jpg"]);
  assert.deepEqual(i.rooms, ["Kitchen"]);
  assert.equal(i.jobKind, "claim");
  assert.equal(cleanExtractInput({ jobKind: "nope" }).jobKind, "");
});

test("stills are capped", () => {
  const stills = Array.from({ length: MAX_STILLS + 20 }, (_, k) => ({ path: `sitevisit/p/s${k}.jpg`, clip: 1, at: k }));
  assert.equal(cleanExtractInput({ clips, stills }).stills.length, MAX_STILLS);
});

test("the request puts each signed still beside its caption, then the clips under headers", () => {
  const input = cleanExtractInput({ clips, stills: [{ path: "sitevisit/p/a.jpg", clip: 1, at: 102, caption: "q" }, { path: "sitevisit/p/b.jpg", clip: 1, at: 3 }] });
  const c = buildExtractContent(input, { "sitevisit/p/a.jpg": "https://signed/a" });
  assert.equal(c.filter((b) => b.type === "image").length, 1, "an unsigned still is left out");
  assert.match(c[0].text, /clip 1 at 1:42/);
  const last = c[c.length - 1].text;
  assert.match(last, /— Clip 1 · Kitchen · 1:35 —/);
  assert.match(last, /— Clip 2 · room not named · 0:40 —/);
});

test("the schema and prompt carry every bucket and the citation rule", () => {
  const it = SCOPE_NOTES_SCHEMA.properties.rooms.items.properties.items.items;
  assert.deepEqual(it.properties.bucket.enum, [...SCOPE_BUCKETS]);
  assert.deepEqual(it.required, ["bucket", "text", "clip", "at"]);
  for (const b of SCOPE_BUCKETS) assert.ok(SCOPE_SYSTEM.includes(b + ":"), b);
  assert.match(SCOPE_SYSTEM, /never a company name/);
  assert.match(SCOPE_SYSTEM, /No citation, no item/);
});

test("parseScopeNotes drops uncited items, clamps the second, demotes a number-less quantity to verify", () => {
  const { rooms, dropped } = parseScopeNotes({ rooms: [
    { room: "Kitchen", items: [
      { bucket: "instructions", text: "take it to four feet on the sink wall", clip: 1, at: 12.04 },
      { bucket: "quantities", text: "about twelve feet of base", clip: 1, at: 30, value: 12, unit: "LF" },
      { bucket: "quantities", text: "a lot of base", clip: 1, at: 31 },           // no number spoken
      { bucket: "damage", text: "swollen toe kick", clip: 1, at: 200, cause: "supply line" },   // past the clip's end
      { bucket: "observations", text: "no clip", at: 5 },
      { bucket: "observations", text: "bad clip", clip: 9, at: 5 },
      { bucket: "nonsense", text: "x", clip: 1, at: 1 },
      { bucket: "instructions", text: "Take it to four feet on the sink wall", clip: 1, at: 12.04 },   // duplicate
    ] },
    { room: "", items: [{ bucket: "trades", text: "electrician for the disposal", clip: 2, at: 3, trade: "Electrician" }] },
    { room: "kitchen", items: [{ bucket: "homeownerSaid", text: "Homeowner: it started Tuesday", clip: 1, at: 50 }] },
  ] }, clips);
  assert.equal(dropped, 4);
  assert.deepEqual(rooms.map((r) => r.room), ["Kitchen", JOB_WIDE]);
  const k = rooms[0].items;
  assert.equal(k.length, 5, "the second 'kitchen' entry merges into Kitchen");
  assert.equal(k[0].at, 12);
  assert.deepEqual(k[1], { bucket: "quantities", text: "about twelve feet of base", clip: 1, at: 30, value: 12, unit: "LF" });
  assert.equal(k[2].bucket, "verify");
  assert.equal(k[3].at, 95);
  assert.equal(k[3].cause, "supply line");
  assert.equal(rooms[1].items[0].trade, "Electrician");
});

test("parseScopeNotes survives garbage", () => {
  assert.deepEqual(parseScopeNotes(null, clips), { rooms: [], dropped: 0 });
  assert.deepEqual(parseScopeNotes({ rooms: "x" }, clips).rooms, []);
});

test("the estimate draft reads reviewed WALK SCOPE NOTES and is told to cite their ids", () => {
  const packet = cleanPacket({ scopeNotes: "Kitchen\n[N1] INSTRUCTION: take it to four feet (walk Kitchen 0:12)" });
  assert.equal(packetHasEvidence(packet), true, "scope notes alone are evidence");
  const text = buildContent({ packet, signed: {}, facts: {}, rulesText: "", catalogText: "", kind: "claim" }).map((b) => b.text).join("\n");
  assert.match(text, /WALK SCOPE NOTES/);
  assert.match(text, /\[N1\] INSTRUCTION/);
  assert.match(text, /Every INSTRUCTION note gets a line or a question/);
  const none = buildContent({ packet: cleanPacket({ typedScope: "x" }), signed: {}, facts: {}, rulesText: "", catalogText: "", kind: "claim" }).map((b) => b.text).join("\n");
  assert.ok(!none.includes("WALK SCOPE NOTES"), "no block, no rule, when there are no notes");
});

console.log(`\n${pass} passed`);
