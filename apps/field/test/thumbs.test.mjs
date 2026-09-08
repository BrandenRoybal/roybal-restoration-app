/* Thumbnail rules — pure logic, no DOM, no network.
   Run: node apps/field/test/thumbs.test.mjs
   Picked up by the CI glob over *.test.mjs. */
import assert from "node:assert/strict";
import {
  thumbKey, isThumbKey, shouldThumb, makeThumb,
  THUMB_MIN_SOURCE, THUMB_MAX_DIM, THUMB_QUALITY,
  previewPhotos, restorePhotoMarkers, isPreviewEntry,
} from "../js/thumbs.js";
import { MARKER_RE, isMediaMarker } from "../js/media.js";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };

const jpeg = (n) => "data:image/jpeg;base64," + "A".repeat(n);

/* ---------- keys ---------- */
const H = "b".repeat(64);
ok("thumbKey derives from the source hash", thumbKey(H) === "thumb_" + H);
ok("a thumbnail key is recognisable as one", isThumbKey(thumbKey(H)));
ok("a source hash is NOT mistaken for a thumbnail key", !isThumbKey(H));
ok("isThumbKey tolerates rubbish", !isThumbKey(null) && !isThumbKey(undefined) && !isThumbKey(42));
/* The whole compatibility argument rests on this: the bucket learns about
   thumbnails, the job row never does. A key that collided with the 64-hex
   source namespace would break that. */
ok("thumbnail keys cannot collide with the 64-hex source namespace",
  !/^[0-9a-f]{64}$/.test(thumbKey(H)));

/* ---------- what earns a thumbnail ---------- */
ok("a big JPEG earns one", shouldThumb(jpeg(THUMB_MIN_SOURCE)));
ok("a big PNG earns one", shouldThumb("data:image/png;base64," + "A".repeat(THUMB_MIN_SOURCE)));
ok("something already small does not — the full copy is cheap enough",
  !shouldThumb(jpeg(1000)));
ok("a PDF page is not an image this can decode",
  !shouldThumb("data:application/pdf;base64," + "A".repeat(THUMB_MIN_SOURCE)));
ok("a marker string is never a thumbnail source",
  !shouldThumb(`media:${H}:123456`));
ok("non-strings are refused", !shouldThumb(null) && !shouldThumb(undefined) && !shouldThumb({}));

/* ---------- makeThumb ---------- */
const shrinkTo = (len) => async () => jpeg(len);

ok("no shrink function (Node, no canvas) → null, never a throw",
  (await makeThumb(jpeg(50_000), undefined)) === null);
ok("a source that does not qualify → null even with a working shrink",
  (await makeThumb(jpeg(100), shrinkTo(50))) === null);
ok("a normal shrink returns the smaller rendition",
  (await makeThumb(jpeg(50_000), shrinkTo(2_000))) === jpeg(2_000));

/* The guard that matters: a "thumbnail" bigger than its source is not one.
   Re-encoding can do this, and storing it would spend bytes to save none. */
ok("a rendition that grew is rejected",
  (await makeThumb(jpeg(50_000), shrinkTo(80_000))) === null);
ok("a rendition the same size is rejected too",
  (await makeThumb(jpeg(50_000), shrinkTo(50_000))) === null);

ok("a shrink that throws → null, never propagates",
  (await makeThumb(jpeg(50_000), async () => { throw new Error("canvas exploded"); })) === null);
ok("a shrink returning a non-image → null",
  (await makeThumb(jpeg(50_000), async () => "not-a-data-url")) === null);
ok("a shrink returning null → null",
  (await makeThumb(jpeg(50_000), async () => null)) === null);

/* ---------- the settings themselves ---------- */
ok("thumbnails are much smaller than the 1600px capture size",
  THUMB_MAX_DIM > 0 && THUMB_MAX_DIM <= 480);
ok("quality is a sane fraction", THUMB_QUALITY > 0 && THUMB_QUALITY < 1);
ok("the floor sits above media.js's 8 KB offload threshold",
  THUMB_MIN_SOURCE > 8_000);

/* ---------- STAGE 2: previews, and the rules that keep them honest ----------
   Stage 1 asserted here that NO read path ever asked for a thumbnail, and that
   was the whole of its safety argument. Stage 2 reads them, so those three
   assertions are deleted ON PURPOSE — this is the deliberate deletion PR #193
   promised, not an accident — and replaced by the rules that now carry the
   same weight: a stand-in is always labelled, always undone before a push, and
   always loses to the real bytes. */

const H2 = "c".repeat(64);
const marker = (h, len) => `media:${h}:${len}`;
const photoRow = (over = {}) => ({ id: "p1", src: marker(H2, 228_000), caption: "kitchen", ...over });
const preview = "data:image/jpeg;base64," + "P".repeat(400);

/* the marker shape thumbs.js matches must be the one media.js writes */
ok("thumbs.js and media.js agree on the marker format",
  MARKER_RE.test(marker(H2, 228_000)) && (await previewPhotos({ photos: [photoRow()] }, async () => preview)).previewed === 1);

/* ---------- previewPhotos ---------- */
{
  const slim = { id: "j", photos: [photoRow()] };
  const { project, previewed } = await previewPhotos(slim, async () => preview);
  const ph = project.photos[0];
  ok("a marker becomes the preview", previewed === 1 && ph.src === preview);
  ok("the full-res hash is left where the shipped viewer looks for it", ph.cloud === H2);
  ok("the entry records the marker it stands in for", ph.previewOf === `thumb:${H2}:228000`);
  /* REGRESSION (caught by test/sync.mjs, not by unit tests): inflateProject
     resolves every marker-shaped string ANYWHERE in a row. A previewOf holding
     the marker verbatim was therefore inflated too — the 228 KB original came
     down anyway and previewOf ended up holding photo bytes, which silently
     broke the restore and let a preview reach the server. */
  ok("previewOf is NOT marker-shaped — the inflate walk must never resolve it",
    !MARKER_RE.test(ph.previewOf) && !isMediaMarker(ph.previewOf));
  ok("it is recognisable as a stand-in", isPreviewEntry(ph));
  ok("the caption survives", ph.caption === "kitchen");
  ok("the input row is never mutated", slim.photos[0].src === marker(H2, 228_000));
}

/* The guard that protects a deliberate archive. archivePhotos() produces
   {src: <thumbnail>, cloud: <hash>} on purpose, and once that small src
   offloads, its src is a marker too — for the THUMBNAIL's hash. Previewing it
   would overwrite `cloud` with the hash of a thumbnail of a thumbnail and
   break the only link back to the real photo. */
{
  const archived = { id: "p9", src: marker("d".repeat(64), 12_000), cloud: "e".repeat(64) };
  const { project, previewed } = await previewPhotos({ photos: [archived] }, async () => preview);
  ok("an ARCHIVED photo is never previewed — its cloud link is not ours to move",
    previewed === 0 && project.photos[0].cloud === "e".repeat(64));
}

ok("no thumbnail yet → the entry is left for the normal full download",
  (await previewPhotos({ photos: [photoRow()] }, async () => null)).previewed === 0);
ok("a thumbnail fetch that throws → left alone, never propagates",
  (await previewPhotos({ photos: [photoRow()] }, async () => { throw new Error("offline"); })).previewed === 0);
ok("a non-image answer is refused",
  (await previewPhotos({ photos: [photoRow()] }, async () => "media:nope")).previewed === 0);
ok("a 'preview' no smaller than the original is pointless and refused",
  (await previewPhotos({ photos: [photoRow({ src: marker(H2, 100) })] }, async () => preview)).previewed === 0);
ok("inline bytes are not markers and are never touched",
  (await previewPhotos({ photos: [photoRow({ src: preview })] }, async () => preview)).previewed === 0);
ok("a row with no photos is returned unchanged",
  (await previewPhotos({ id: "j" }, async () => preview)).previewed === 0);
ok("rubbish entries do not crash the walk",
  (await previewPhotos({ photos: [null, 42, {}, { src: 7 }] }, async () => preview)).previewed === 0);

/* ---------- restorePhotoMarkers: the undo that makes this safe ---------- */
{
  const slim = { id: "j", photos: [photoRow(), { id: "p2", src: "data:image/jpeg;base64,SMALL" }] };
  const { project: previewed } = await previewPhotos(slim, async () => preview);
  const restored = restorePhotoMarkers(previewed);
  ok("a preview round-trips back to the EXACT row that was pulled",
    JSON.stringify(restored) === JSON.stringify(slim));
  ok("restoring drops the stand-in bookkeeping",
    !("previewOf" in restored.photos[0]) && !("cloud" in restored.photos[0]));
  ok("restore does not mutate its input", previewed.photos[0].src === preview);
}
{
  const archived = { id: "p9", src: "data:image/jpeg;base64,THUMB", cloud: "e".repeat(64) };
  const out = restorePhotoMarkers({ photos: [archived] });
  ok("a deliberate archive is left exactly as the owner left it",
    JSON.stringify(out.photos[0]) === JSON.stringify(archived));
}
ok("restore is a no-op on a row with nothing to restore",
  restorePhotoMarkers({ id: "j", photos: [] }).photos.length === 0);

/* ---------- the source assertion that replaces write-only ----------
   Stage 2's safety now rests on one property: NOTHING on the sync path
   deflates a project without first restoring its markers. If a bare
   deflateProject() ever reappears in sync.js, a device holding previews can
   hash, upload and push a 320px stand-in as though it were the photograph.
   That is a property of the source, so it is asserted against the source. */
import { readFileSync } from "node:fs";
const sync = readFileSync(new URL("../js/sync.js", import.meta.url), "utf8");
const code = sync.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const deflateCalls = [...code.matchAll(/^.*(?<![A-Za-z])deflateProject\(.*$/gm)].map((m) => m[0].trim());
ok("sync.js calls deflateProject exactly once — inside deflateSynced",
  deflateCalls.length === 1 && /function deflateSynced/.test(deflateCalls[0]));
ok("deflateSynced restores markers before deflating",
  /deflateProject\(\s*restorePhotoMarkers\(/.test(code));
ok("the sync path deflates through deflateSynced everywhere else",
  [...code.matchAll(/(?<![A-Za-z])deflateSynced\(/g)].length >= 5);
/* stage 1's writer must still be a writer */
ok("thumbnails are still uploaded, not just read",
  /uploadMedia\(\s*thumbKey\(/.test(code));
ok("thumbnails are now also READ — stage 2's whole point",
  /downloadMedia\(\s*thumbKey\(/.test(code));

console.log(`\nthumbs.test.mjs: ${pass} assertions passed`);
