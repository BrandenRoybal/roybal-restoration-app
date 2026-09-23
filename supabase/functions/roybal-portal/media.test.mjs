/* Portal media gate — a job link reaches only the images its own row shares.
   Run: node supabase/functions/roybal-portal/media.test.mjs */
import assert from "node:assert";
import { mediaLists, mediaAllowed, mediaKeys, PHOTO_MAX } from "./media.mjs";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const H = (c) => c.repeat(64);

const row = {
  photos: [{ mediaHash: H("a"), caption: "Kitchen", stage: "after" }, { mediaHash: "not-a-hash", caption: "bad" }],
  documents: [{ label: "Estimate", type: "estimate", pages: [H("b"), "junk"] }, { label: "Empty", pages: [] }],
};

console.log("Portal media gate");
const lists = mediaLists(row);
ok("photos list hashes, never image data", lists.photos.length === 1 && lists.photos[0].hash === H("a") && !("src" in lists.photos[0]));
ok("caption and stage ride along", lists.photos[0].caption === "Kitchen" && lists.photos[0].stage === "after");
ok("documents keep only valid page hashes", lists.documents.length === 1 && lists.documents[0].pages.join() === H("b"));
ok("a document with no pages is dropped", !lists.documents.some((d) => d.label === "Empty"));
ok("a shared photo is allowed", mediaAllowed(row, H("a")));
ok("a shared document page is allowed", mediaAllowed(row, H("b")));
ok("another job's image is refused", !mediaAllowed(row, H("c")));
ok("a malformed hash is refused", !mediaAllowed(row, "../" + H("a")) && !mediaAllowed(row, ""));
ok("an empty row allows nothing", !mediaAllowed(null, H("a")));
ok("a preview tries the thumbnail, then the full photo", mediaKeys(H("a"), "thumb").join() === `thumb_${H("a")},${H("a")}`);
ok("full size asks for the photo only", mediaKeys(H("a"), "full").join() === H("a"));
ok("no keys for a bad hash", mediaKeys("x", "thumb").length === 0);
const many = { photos: Array.from({ length: PHOTO_MAX + 5 }, (_, i) => ({ mediaHash: i.toString(16).padStart(64, "0") })) };
ok("the photo list is capped", mediaLists(many).photos.length === PHOTO_MAX);
ok("a photo past the cap is not servable", !mediaAllowed(many, (PHOTO_MAX + 1).toString(16).padStart(64, "0")));

console.log(`\n${pass} portal media checks passed.`);
