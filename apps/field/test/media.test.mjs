/* Media offload for cloud sync — pure logic, no DOM/network.
   Run: node apps/field/test/media.test.mjs   (from repo root) */
import assert from "node:assert";
import { MEDIA_MIN, MARKER_RE, isMediaMarker, sha256Hex, findMedia, findMarkers, replaceStrings, deflateProject, inflateProject } from "../js/media.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

console.log("Media offload (sync slimming)");

const big = (tag) => "data:image/jpeg;base64," + tag + "x".repeat(MEDIA_MIN);
const BIG1 = big("ONE");
const BIG2 = big("TWO");

const job = {
  id: "j1", customer: "Lupe Comfort", updatedAt: "2026-07-12T00:00:00Z",
  photos: [
    { id: "p1", src: BIG1, caption: "kitchen" },
    { id: "p2", src: BIG2, caption: "hall" },
    { id: "p3", src: "data:image/png;base64,tiny", caption: "small stays inline" },
  ],
  floorPlan: { uploadedPages: [BIG1] },               // same bytes as p1 — must dedupe
  certDrying: { sigTech: "data:image/png;base64," + "s".repeat(20_000) },   // signature stays
  notes: "n".repeat(MEDIA_MIN + 10),                  // big but not a data URL — stays
  nested: { deep: [{ arr: [BIG2] }] },
  nothing: null,
};

/* ---------- deflate ---------- */
const snapshot = JSON.stringify(job);
const { slim, media } = await deflateProject(job);
ok("original job untouched", JSON.stringify(job) === snapshot);
ok("two distinct blobs offloaded (deduped)", media.length === 2);
ok("markers replace the big data URLs", isMediaMarker(slim.photos[0].src) && isMediaMarker(slim.photos[1].src));
ok("identical strings share one marker", slim.photos[0].src === slim.floorPlan.uploadedPages[0]);
ok("nested arrays/objects handled", slim.nested.deep[0].arr[0] === slim.photos[1].src);
ok("small data URL stays inline", slim.photos[2].src === "data:image/png;base64,tiny");
ok("signature stays inline (under threshold)", slim.certDrying.sigTech === job.certDrying.sigTech);
ok("big non-data string stays inline", slim.notes === job.notes);
ok("null survives the walk", slim.nothing === null);
ok("photo bytes gone from the slim row", !JSON.stringify(slim).includes(BIG1.slice(0, 80)) && !JSON.stringify(slim).includes(BIG2.slice(0, 80)));
ok("slim row sheds the media weight", JSON.stringify(slim).length < snapshot.length - 3 * MEDIA_MIN);
ok("marker carries the hash + length", media.every((m) => {
  const mk = `media:${m.hash}:${m.text.length}`;
  return MARKER_RE.test(mk) && JSON.stringify(slim).includes(m.hash);
}));

/* hashes are real sha256 of the content */
ok("hash matches sha256 of the text", media[0].hash === await sha256Hex(media[0].text));

/* nothing to offload → same reference back (cheap no-op) */
const tiny = { id: "t", photos: [{ src: "data:small" }] };
const noop = await deflateProject(tiny);
ok("no media → project passes through by reference", noop.slim === tiny && noop.media.length === 0);

/* ---------- inflate (round trip) ---------- */
const bucket = new Map(media.map((m) => [m.hash, m.text]));
const download = async (hash) => bucket.has(hash) ? bucket.get(hash) : null;
const { project: full, missing } = await inflateProject(slim, download);
ok("round trip restores the exact job", JSON.stringify(full) === snapshot);
ok("nothing missing on a healthy bucket", missing === 0);
ok("slim input not mutated by inflate", isMediaMarker(slim.photos[0].src));

/* markers with no object on the server: keep the marker, count it, keep going */
const holey = await inflateProject(slim, async () => null);
ok("missing media leaves markers in place", isMediaMarker(holey.project.photos[0].src) && holey.missing === 2);

/* a network-down download propagates so sync can retry the row later */
let threw = false;
try { await inflateProject(slim, async () => { throw new Error("offline"); }); } catch { threw = true; }
ok("download errors propagate (retry next cycle)", threw);

/* no markers → same reference back */
const plain = { id: "x", a: 1 };
ok("marker-free project passes through by reference", (await inflateProject(plain, download)).project === plain);

/* a job that still carries an unresolved marker re-deflates without touching it */
const redeflate = await deflateProject(holey.project);
ok("unresolved markers survive a re-push untouched", redeflate.slim.photos[0].src === holey.project.photos[0].src);

/* findMedia / findMarkers primitives */
ok("findMedia collects only big data URLs", findMedia(job).size === 2);
ok("findMarkers collects only markers", findMarkers(slim).size === 2 && findMarkers(job).size === 0);
ok("replaceStrings deep-copies", replaceStrings(job, new Map()) !== job);

/* ---------- the thresholds that decide what leaves the job record ----------
   The offload was gated at 60,000 chars on the assumption that photos are
   200KB–3MB. Measured on live data they are 7.2–35.9 KB, so NOTHING was ever
   offloaded and 85% of every job record was images — one photo capture
   rewrote megabytes. Photos now leave from 8KB; signatures keep the old bar. */
const dataUrl = (n, tag = "x") => "data:image/jpeg;base64," + tag.repeat(Math.ceil(n / tag.length)).slice(0, n);

{
  const realistic = {
    id: "sizes",
    photos: [
      { id: "a", src: dataUrl(16_342, "a") },   // the measured AVERAGE inline photo
      { id: "b", src: dataUrl(7_199,  "b") },   // the measured SMALLEST — stays inline
      { id: "c", src: dataUrl(35_907, "c") },   // the measured LARGEST
    ],
    moistureMaps: [{ id: "m", sketch: dataUrl(30_000, "s") }],       // drawings leave too
    supportDocs: [{ id: "d", uploadedPages: [dataUrl(40_000, "p")] }],
    certDrying: {
      sigTech:  dataUrl(20_000, "t"),           // a real signature — must STAY
      sigOwner: dataUrl(70_000, "o"),           // absurdly large — still offloads
    },
  };
  const { slim, media } = await deflateProject(realistic);

  ok("a typical 16KB photo now leaves the job record", isMediaMarker(slim.photos[0].src));
  ok("the largest thumbnail leaves too", isMediaMarker(slim.photos[2].src));
  ok("a 7KB thumbnail stays inline (not worth a round trip)", slim.photos[1].src === realistic.photos[1].src);
  ok("moisture-map sketches leave", isMediaMarker(slim.moistureMaps[0].sketch));
  ok("scanned document pages leave", isMediaMarker(slim.supportDocs[0].uploadedPages[0]));
  ok("a 20KB signature STAYS inline (legal artefact, no second object to resolve)",
     slim.certDrying.sigTech === realistic.certDrying.sigTech);
  ok("a signature over the old 60KB bar still offloads", isMediaMarker(slim.certDrying.sigOwner));
  ok("offloaded exactly the five that should go", media.length === 5);

  const before = JSON.stringify(realistic).length, after = JSON.stringify(slim).length;
  ok(`job record shrinks ${Math.round(100 - (after / before) * 100)}% (${before} → ${after} chars)`,
     after < before * 0.25);

  // and it all comes back
  const bucket2 = new Map(media.map((m) => [m.hash, m.text]));
  const round = await inflateProject(slim, async (h) => bucket2.get(h) ?? null);
  ok("every offloaded image round-trips exactly", JSON.stringify(round.project) === JSON.stringify(realistic));
  ok("nothing missing on the round trip", round.missing === 0);
}

console.log(`\n${pass} media-offload checks passed.`);
