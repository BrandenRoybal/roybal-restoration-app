/* Narrated walk clips — the pure helpers (js/walk.js). Design §3/§4.1/§7.
   Fixtures are hand-written; never a real customer's transcript.
   Run: node apps/field/test/walk.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import {
  FRAMES_PER_VIDEO, frameTimes, mmss, frameCaption,
  stillCount, stillTimes, WALK_MAX_SECONDS, WALK_MAX_BYTES, OVERSIZE_MSG, clipTooBig,
  normalizeSpeech, openingText, roomFromOpening, magicplanRoomNames, ROOM_LEXICON,
  captionForStill, withQuote, stillSecond, captionStills,
  clipHeader, transcriptFromFiles, adoptLegacyTranscript, rebuildTranscript,
  walkRows, clipNumber, walkSummary,
} from "../js/walk.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Narrated walk clips");

const u = (start, end, text, speaker = 0) => ({ start, end, speaker, text });

test("the Magicplan frame helpers moved here unchanged", () => {
  assert.equal(FRAMES_PER_VIDEO, 8);
  assert.equal(frameTimes(28.07).length, 8);
  assert.deepEqual(frameTimes(3), [0.75, 2.25]);
  assert.equal(mmss(134), "2:14");
  assert.equal(mmss(65.4), "1:05");
  assert.equal(frameCaption("Kitchen.mp4", 65.4), "still at 1:05 from Magicplan video Kitchen.mp4");
  assert.equal(frameCaption("Kitchen", 65.4, "walk clip"), "still at 1:05 from walk clip Kitchen");
  assert.equal(frameCaption("", 2), "still at 0:02 from Magicplan video clip");
});

test("a narrated clip yields 8 to 24 stills, one per ten seconds past 80 s", () => {
  for (const [d, n] of [[10, 8], [30, 8], [79.9, 8], [80, 8], [95, 9], [120, 12], [179.9, 17], [240, 24], [900, 24]]) {
    assert.equal(stillCount(d), n, `${d}s → ${n}`);
    const t = stillTimes(d);
    assert.equal(t.length, n);
    assert.ok(t[0] > 0 && t[t.length - 1] < d, "never the first or last instant");
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.05, "even spacing");
  }
  assert.deepEqual(stillTimes(80), [5, 15, 25, 35, 45, 55, 65, 75]);
  for (const bad of [0, -1, NaN, Infinity, undefined, "x"]) { assert.equal(stillCount(bad), 0); assert.deepEqual(stillTimes(bad), []); }
});

test("clips over three minutes or 250 MB are refused until V1; an unknown length is not", () => {
  assert.equal(WALK_MAX_SECONDS, 180);
  assert.equal(WALK_MAX_BYTES, 250e6);
  assert.equal(clipTooBig(180, 1e6), false);
  assert.equal(clipTooBig(180.01, 1e6), true);
  assert.equal(clipTooBig(60, 250e6), false);
  assert.equal(clipTooBig(60, 250e6 + 1), true);
  assert.equal(clipTooBig(NaN, 1e6), false);
  assert.equal(clipTooBig(Infinity, 1e6), false);
  assert.equal(clipTooBig(undefined, undefined), false);
  assert.equal(OVERSIZE_MSG, "Split it by room — under 3 minutes per clip. Bigger clips come in V1.");
});

test("the opening is what was said in the first five seconds, else the first utterance", () => {
  assert.equal(openingText([u(0.4, 2, "Kitchen."), u(2.5, 6, "LVP over OSB."), u(7, 9, "eight foot ceiling")]), "Kitchen. LVP over OSB.");
  assert.equal(openingText([u(6.2, 8, "garage"), u(9, 11, "two cars")]), "garage");
  assert.equal(openingText([u(0, 1, "   "), u(1, 3, "attic")]), "attic");
  assert.equal(openingText([]), "");
  assert.equal(openingText(null), "");
  assert.equal(normalizeSpeech("  Bedroom-2, north WALL! "), "bedroom 2 north wall");
});

test("the room comes from the job's rooms first, then Magicplan, then the lexicon — never a guess", () => {
  const rooms = ["Kitchen", "Bedroom 2", "Bath"];
  assert.equal(roomFromOpening([u(0.4, 3, "Kitchen. LVP over OSB, eight foot ceiling.")], { rooms }), "Kitchen");
  assert.equal(roomFromOpening([u(0.4, 3, "bedroom 2, north wall")], { rooms }), "Bedroom 2");     // the longer name wins the tie
  assert.equal(roomFromOpening([u(0.4, 3, "bathroom, tile floor")], { rooms }), "Bath");            // the job's own string, by contains
  assert.equal(roomFromOpening([u(0.4, 3, "hall to the kitchen")], { rooms }), "Kitchen");          // the job's rooms outrank the lexicon
  assert.equal(roomFromOpening([u(0.4, 3, "basement bedroom, carpet")], { rooms: [], magicplanRooms: ["Basement — Bedroom", "Kitchen"] }), "Basement — Bedroom");
  assert.equal(roomFromOpening([u(0.4, 3, "crawl space, dirt floor")]), "Crawlspace");
  assert.equal(roomFromOpening([u(0.4, 3, "arctic entry, tile")]), "Arctic entry");                 // before the shorter "entry"
  assert.equal(roomFromOpening([u(0.4, 3, "master bath")]), "Bathroom");
  assert.equal(roomFromOpening([u(0.4, 3, "hall to the kitchen")]), "Hallway");                      // first spoken wins within a pass
  assert.equal(roomFromOpening([u(0.5, 2, "ok recording"), u(7, 9, "kitchen")]), null);            // said after five seconds
  assert.equal(roomFromOpening([u(6.2, 8, "garage")]), "Garage");                                    // a late first utterance still counts
  assert.equal(roomFromOpening([u(0.4, 3, "the officer's desk")]), null);                            // whole words in the lexicon
  assert.equal(roomFromOpening([u(0.4, 3, "the room with the sink")]), null);
  assert.equal(roomFromOpening([]), null);
  assert.equal(roomFromOpening(null), null);
  assert.equal(roomFromOpening(undefined, { rooms: [null, 42, ""] }), null);
  assert.ok(ROOM_LEXICON.some((l) => l.room === "Crawlspace" && l.say.includes("crawl space")));
});

test("Magicplan room names come off the adopted scan, deduped by floor", () => {
  assert.deepEqual(magicplanRoomNames({}), []);
  assert.deepEqual(magicplanRoomNames({ magicplan: {} }), []);
  const sv = { magicplan: { statistics: { floors: [
    { name: "Main", rooms: [{ name: "Kitchen" }, { name: "Bedroom" }] },
    { name: "Basement", rooms: [{ name: "Bedroom" }] } ] } } };
  assert.deepEqual(magicplanRoomNames(sv), ["Kitchen", "Main — Bedroom", "Basement — Bedroom"]);
});

test("a still quotes the words spoken within six seconds of it, bounded and idempotent", () => {
  const utts = [u(10, 14, "a"), u(16, 20, "this base \"run\" is swollen"), u(24, 27, "c"), u(26, 30, "d")];
  assert.equal(captionForStill(18, utts), "a this base 'run' is swollen c");
  assert.equal(captionForStill(18, utts, 1), "this base 'run' is swollen");
  assert.equal(captionForStill(50, utts), "");
  assert.equal(captionForStill(18, null), "");
  assert.equal(captionForStill(NaN, utts), "");
  assert.equal(captionForStill(12, [{ start: 12, text: "no end field" }]), "no end field");
  const long = captionForStill(5, [u(4, 6, Array.from({ length: 80 }, (_, i) => "word" + i).join(" "))]);
  assert.ok(long.length <= 201 && long.endsWith("…") && !long.endsWith(" …"), long);
  const base = "still at 0:18 from walk clip Kitchen";
  assert.equal(withQuote(base, "a b"), `${base} · "a b"`);
  assert.equal(withQuote(withQuote(base, "a"), "b"), withQuote(base, "b"));
  assert.equal(withQuote(withQuote(base, "a"), ""), base);
  assert.equal(withQuote("", ""), "");
});

test("captionStills rewrites one clip's stills from its transcript and leaves the rest alone", () => {
  const walk = { id: "w1", kind: "walk", name: "IMG_0042.mov", room: "", transcript: { utterances: [u(10, 14, "sink wall"), u(30, 33, "toe kick")] } };
  const sv = { files: [
    walk,
    { id: "f1", kind: "frames", videoId: "w1", name: "IMG_0042.mov @ 12s", caption: "still at 0:12 from walk clip IMG_0042.mov" },
    { id: "f2", kind: "frames", videoId: "w1", name: "IMG_0042.mov @ 31s", caption: "still at 0:31 from walk clip IMG_0042.mov" },
    { id: "f3", kind: "frames", videoId: "w1", name: "no second here", caption: "keep" },
    { id: "f9", kind: "frames", videoId: "v9", name: "Break room.mp4 @ 3s", caption: "still at 0:03 from Magicplan video Break room.mp4" },
  ] };
  assert.equal(stillSecond(sv.files[1]), 12);
  assert.equal(stillSecond(sv.files[3]), null);
  assert.equal(captionStills(sv, walk), 2);
  assert.equal(sv.files[1].caption, 'still at 0:12 from walk clip IMG_0042.mov · "sink wall"');
  assert.equal(sv.files[2].caption, 'still at 0:31 from walk clip IMG_0042.mov · "toe kick"');
  assert.equal(sv.files[3].caption, "keep");
  assert.equal(sv.files[4].caption, "still at 0:03 from Magicplan video Break room.mp4");
  walk.room = "Kitchen";
  captionStills(sv, walk); captionStills(sv, walk);
  assert.equal(sv.files[1].caption, 'still at 0:12 from walk clip Kitchen · "sink wall"');
  assert.ok(sv.files[1].caption.length <= 300);
  const longName = { id: "w2", kind: "walk", name: "x".repeat(120) + ".mov", transcript: { utterances: [u(0, 3, "y".repeat(500))] } };
  const sv2 = { files: [longName, { kind: "frames", videoId: "w2", name: "z @ 1s" }] };
  captionStills(sv2, longName);
  assert.ok(sv2.files[1].caption.length <= 300, "fits the server's 300-char caption cap");
  longName.room = "r".repeat(120);
  captionStills(sv2, longName);
  assert.ok(sv2.files[1].caption.length <= 300, "a long room name is capped too");
  assert.equal(captionStills(sv, { id: "none", transcript: null }), 0);
  assert.equal(captionStills(null, walk), 0);
});

test("the flat transcript is every clip in capture order under a Clip header", () => {
  assert.equal(clipHeader(2, "Kitchen", 134), "— Clip 2 · Kitchen · 2:14 —");
  assert.equal(clipHeader(1, "", 61), "— Clip 1 · Clip 1 · 1:01 —");
  const files = [
    { id: "A", kind: "walk", room: "Kitchen", at: "2026-09-26T10:05:00Z", transcript: { text: "[00:05] take it to four feet", seconds: 134 } },
    { id: "P", kind: "photos", at: "2026-09-26T10:00:00Z" },
    { id: "B", kind: "walk", room: "", at: "2026-09-26T10:01:00Z", transcript: { text: "[00:02] Hall.\n[00:20] baseboard", seconds: 61 } },
    { id: "F", kind: "frames", videoId: "A", at: "2026-09-26T10:05:00Z" },
    { id: "C", kind: "walk", room: "Bath", at: "2026-09-26T10:09:00Z" },                                   // not transcribed yet
    { id: "D", kind: "audio", at: "2026-09-26T10:20:00Z", transcript: { text: "   ", seconds: 9 } },       // empty text: not a clip
  ];
  const r = transcriptFromFiles(files);
  assert.equal(r.transcript, "— Clip 1 · Clip 1 · 1:01 —\n[00:02] Hall.\n[00:20] baseboard\n\n— Clip 2 · Kitchen · 2:14 —\n[00:05] take it to four feet");
  assert.equal(r.seconds, 195);
  assert.deepEqual(r.clips.map((c) => [c.id, c.n, c.room]), [["B", 1, ""], ["A", 2, "Kitchen"]]);
  assert.deepEqual(transcriptFromFiles([]), { transcript: "", seconds: 0, clips: [] });
  assert.deepEqual(transcriptFromFiles(null), { transcript: "", seconds: 0, clips: [] });
  const sv = { files, transcript: "stale typed text", transcriptSeconds: 1 };
  const out = rebuildTranscript(sv);
  assert.equal(sv.transcript, r.transcript);
  assert.equal(sv.transcriptSeconds, 195);
  assert.equal(out.clips.length, 2);
});

test("a visit transcribed before walk clips keeps its transcript: adopted onto the audio row once", () => {
  const sv = { files: [{ id: "a1", kind: "audio", name: "walk.m4a", path: "sitevisit/j/a1-walk.m4a", at: "2026-09-20T10:00:00Z" }], transcript: "[00:05] start in the kitchen", transcriptSeconds: 600 };
  assert.equal(adoptLegacyTranscript(sv), true);
  assert.deepEqual(sv.files[0].transcript, { utterances: [], text: "[00:05] start in the kitchen", seconds: 600, model: "", at: "2026-09-20T10:00:00Z" });
  assert.equal(adoptLegacyTranscript(sv), false);
  rebuildTranscript(sv);
  assert.equal(sv.transcript, "— Clip 1 · Clip 1 · 10:00 —\n[00:05] start in the kitchen");
  assert.equal(sv.transcriptSeconds, 600);
  assert.equal(adoptLegacyTranscript({ files: [], transcript: "orphan" }), false);
  assert.equal(adoptLegacyTranscript({ files: [{ kind: "photos" }], transcript: "orphan" }), false);
  const walked = { files: [{ id: "w", kind: "walk", transcript: { text: "x", seconds: 1 } }, { id: "a", kind: "audio" }], transcript: "derived already" };
  assert.equal(adoptLegacyTranscript(walked), false);
  assert.equal(walked.files[1].transcript, undefined);
  // once derived, never legacy again: deleting the last transcribed clip
  // beside an untranscribed recording leaves the recording untranscribed
  rebuildTranscript(walked);
  assert.equal(walked.transcriptDerived, true);
  walked.files = walked.files.filter((f) => f.id !== "w");
  rebuildTranscript(walked);
  assert.equal(walked.files[0].transcript, undefined);
  assert.equal(walked.transcript, "");
  // Replace recording on a legacy visit: the old text goes with the old row
  sv.files = [{ id: "a2", kind: "audio", name: "new.m4a", at: "2026-09-27T10:00:00Z" }];
  rebuildTranscript(sv);
  assert.equal(sv.files[0].transcript, undefined);
  assert.equal(sv.transcript, "");
});

test("clips are numbered in capture order whether or not they are transcribed; the summary counts them", () => {
  const files = [
    { id: "w2", kind: "walk", at: "2026-09-26T10:05:00Z", duration: 165, frames: 12 },
    { id: "v", kind: "videos", at: "2026-09-26T10:00:00Z", frames: 8 },
    { id: "w1", kind: "walk", at: "2026-09-26T10:01:00Z", duration: 165, frames: 8 },
    { id: "w3", kind: "walk", at: "2026-09-26T10:09:00Z", duration: 165, frames: 12 },
    { id: "w4", kind: "walk", at: "2026-09-26T10:12:00Z", duration: 165, frames: 8 },
  ];
  assert.deepEqual(walkRows(files).map((f) => f.id), ["w1", "w2", "w3", "w4"]);
  assert.equal(clipNumber(files, files[0]), 2);
  assert.equal(clipNumber(files, { id: "w4" }), 4);
  assert.equal(clipNumber(files, { id: "nope" }), 0);
  assert.deepEqual(walkSummary(files), { clips: 4, seconds: 660, stills: 40 });
  assert.deepEqual(walkSummary([]), { clips: 0, seconds: 0, stills: 0 });
  assert.deepEqual(walkSummary(null), { clips: 0, seconds: 0, stills: 0 });
});

console.log(`\n${pass} walk tests passed`);
