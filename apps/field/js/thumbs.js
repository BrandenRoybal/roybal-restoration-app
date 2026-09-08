/* ============================================================
   thumbs.js — small renditions of stored photos.

   STAGE 1 ONLY: this module CREATES thumbnails and puts them in the bucket.
   Nothing reads them yet. That is deliberate — a thumbnail that reaches a
   device and is mistaken for the real photo can be pushed back over the
   original, and photos are the least replaceable thing the business holds.
   The consuming side (preview-first pull, background upgrade, the merge rule
   that makes a full photo always beat a preview, and its SQL twin) is Stage 2
   and lands with its own tests.

   WHY THUMBNAILS AT ALL
   A device that has never held a job's photos downloads all of them: 748 live
   photos averaging 228 KB is ~170 MB before a new or replacement iPad is
   usable. The same set as thumbnails is ~9 MB. Photos themselves are already
   downscaled at capture (fileToDataURL: 1600px, q0.72) and are NOT the problem
   to solve — 1600px is the documentation record for an insurance file and
   stays exactly as it is.

   WHERE THEY LIVE
   A derived key in the same bucket: `thumb_<sha256>` beside `<sha256>`. The
   marker format in the job row is untouched — deliberately. MARKER_RE is
   strict (`media:<64 hex>:<len>`), and a build that met an unfamiliar marker
   would treat it as a plain string and render the marker text as an image.
   Devices still on v165 must keep working, so the row never learns about
   thumbnails; only the bucket does.

   Content-addressed, like everything else here: the thumbnail of the object at
   hash H is always the same bytes, so it is written once and never invalidated.
   ============================================================ */

/* Small enough that 748 of them are a few megabytes, large enough to be a
   recognisable photo in a grid on a tablet. Not a display decision anyone has
   to live with yet — nothing renders these until Stage 2. */
export const THUMB_MAX_DIM = 320;
export const THUMB_QUALITY = 0.5;

/* Below this, a thumbnail is not worth a second object: the "full" copy is
   already small enough to send. MEDIA_MIN (media.js) offloads from 8 KB, so
   objects between 8 and 20 KB exist and are cheap already. */
export const THUMB_MIN_SOURCE = 20_000;

export const THUMB_PREFIX = "thumb_";

/** Bucket key for a source object's thumbnail. Pure — the unit under test. */
export function thumbKey(hash) { return THUMB_PREFIX + hash; }

/** Is this key one of ours? Guards a thumbnail from being treated as a photo. */
export function isThumbKey(key) { return typeof key === "string" && key.startsWith(THUMB_PREFIX); }

/* Only raster photos get thumbnails. Signatures are excluded on purpose: they
   are the legal artefact on a work authorisation, they are small, and a
   half-resolution signature is worse than no thumbnail. PDFs and scans are not
   images this can decode. */
export function shouldThumb(text) {
  if (typeof text !== "string") return false;
  if (text.length < THUMB_MIN_SOURCE) return false;
  return /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(text);
}

/* Render a thumbnail. Returns null when it cannot — no DOM (Node tests), not an
   image, or a decode failure — and null always means "skip this one", never
   "retry forever". The caller marks it done either way.

   `shrink` is injected so this module stays testable without a canvas; the app
   passes core.js's shrinkDataURL. */
export async function makeThumb(text, shrink) {
  if (!shouldThumb(text)) return null;
  if (typeof shrink !== "function") return null;
  try {
    const out = await shrink(text, THUMB_MAX_DIM, THUMB_QUALITY);
    if (typeof out !== "string" || !out.startsWith("data:image/")) return null;
    // A "thumbnail" that grew is not one. Re-encoding a small or already-tiny
    // source can do this; keeping it would cost bytes to save none.
    if (out.length >= text.length) return null;
    return out;
  } catch { return null; }
}
