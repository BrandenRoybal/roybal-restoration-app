/* Thumbnail rules — pure logic, no DOM, no network.
   Run: node apps/field/test/thumbs.test.mjs
   Picked up by the CI glob over *.test.mjs. */
import assert from "node:assert/strict";
import {
  thumbKey, isThumbKey, shouldThumb, makeThumb,
  THUMB_MIN_SOURCE, THUMB_MAX_DIM, THUMB_QUALITY,
} from "../js/thumbs.js";

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

/* ---------- STAGE 1 IS WRITE-ONLY, and this is what enforces it ----------
   The danger in the whole thumbnail design is a device holding a preview it
   believes is the photo and pushing it over the original. Stage 1 is safe from
   that only because no read path ever asks for a thumbnail. That is a property
   of the source, not of a comment, so it is asserted against the source. When
   Stage 2 lands it will delete these three and replace them with tests of the
   preview/upgrade rules — deliberately, not by accident. */
import { readFileSync } from "node:fs";
const sync = readFileSync(new URL("../js/sync.js", import.meta.url), "utf8");

// Comments are prose, not behaviour — sync.js's own header says "No pull path
// consults thumbKey()", which is the claim under test, not a violation of it.
// Whole block comments are stripped rather than filtered line-by-line: this
// file's block comments wrap onto continuation lines that carry no marker.
const code = sync.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const thumbUses = [...code.matchAll(/^.*thumbKey\(.*$/gm)].map((m) => m[0].trim());
ok("sync.js uses thumbKey at least once (the writer exists)", thumbUses.length > 0);
ok("EVERY thumbKey() use in sync.js is an upload — no read path asks for one",
  thumbUses.every((line) => /uploadMedia\(\s*thumbKey\(/.test(line)));
ok("downloadMedia is never handed a thumbnail key",
  !/downloadMedia\(\s*thumbKey\(/.test(sync) && !/download\w*\(\s*["'`]thumb_/.test(sync));

console.log(`\nthumbs.test.mjs: ${pass} assertions passed`);
