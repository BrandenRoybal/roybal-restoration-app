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

/* ============================================================
   STAGE 2 — reading them.

   A fresh iPad used to download every full photo on every job before it was
   usable: 748 photos × ~228 KB ≈ 170 MB. It now takes the thumbnail instead
   (~9 MB) and stops there. Full resolution is fetched ON DEMAND by machinery
   that already shipped: photoexport.js's photoFullSrc() resolves ph.cloud out
   of the bucket, the lightbox upgrades the image behind the preview and says
   "preview only — full-res not reachable" when it cannot, and the ZIP export
   labels such a file "(preview-only)" rather than passing a 320px stand-in to
   an insurer as the photo.

   So a previewed photo is deliberately shaped like an ARCHIVED one — the state
   archivePhotos() has produced since August — plus one field:

     { src: <preview data URL>, cloud: <hash>, previewOf: "thumb:<hash>:<len>" }

   `previewOf` deliberately does NOT hold the marker verbatim. inflateProject
   walks EVERY string in a row and resolves anything matching the marker shape,
   so a marker parked in a second field is resolved too — which downloaded the
   very 228 KB original this exists to avoid, and left `previewOf` holding photo
   bytes so the restore below silently stopped working. It records the same two
   facts under a shape MARKER_RE cannot match, and restorePhotoMarkers rebuilds
   the marker from them.

   `previewOf` is what keeps this safe, and it does two jobs.

   1. ON PUSH IT IS UNDONE. restorePhotoMarkers() puts the original marker back
      in `src` before anything is deflated, so the row this device sends is
      byte-identical to the row it received. A device holding previews cannot
      publish them: the bucket learns about thumbnails, and the job row still
      never does.

   2. IT MARKS THE COPY AS A STAND-IN, so a merge can tell "holds a preview"
      from "holds the photo" and always keep the photo (merge.js, and its SQL
      twin in merge_project_blobs). Without that flag a preview is just a
      smaller image and the newer copy wins — which is how a device ends up
      pushing a 320px stand-in over the only documentation of the inside of
      someone's flooded house.

   An ARCHIVED photo is not touched by any of this. It already carries `cloud`
   and no `previewOf`: the owner deliberately moved those bytes out, and that
   decision is theirs to keep. The `ph.cloud` guard below is what protects it —
   without it, an archived photo's stand-in would itself be previewed and its
   `cloud` link to the real photo overwritten with the hash of a thumbnail of a
   thumbnail. That is the one path here that could actually lose a photo.
   ============================================================ */

/** Element field naming the marker a preview stands in for. Present ⇒ this
    entry's `src` and `cloud` are sync's to manage, not the owner's. */
export const PREVIEW_OF = "previewOf";

/** Is this photos[] entry holding a stand-in rather than the real bytes?

    Deliberately looser than PREVIEW_RE: the question a merge asks is "are
    these the real bytes?", and a mark of ANY shape answers no. The SQL twin
    asks it the same way — jsonb_exists(el, 'previewOf') — and the two engines
    must give the same answer or merge_project_blobs stops being a twin. A
    strict test here diverged from it on a malformed mark.

    restorePhotoMarkers stays strict, because it has a harder job: it must
    PARSE the mark to rebuild the marker. So a malformed mark loses a merge to
    the real bytes (safe, and it is cleaned up in passing) but cannot be
    restored on its own. Nothing writes one — previewPhotos is the only author
    and always well-formed — which is why the gap is acceptable rather than
    closed with a second format. */
export function isPreviewEntry(ph) {
  return !!(ph && typeof ph === "object" && typeof ph[PREVIEW_OF] === "string" && ph[PREVIEW_OF] !== "");
}

/* `media:<64 hex>:<len>` — the marker format, matched here rather than
   imported so this module keeps no dependency on media.js's internals. It is
   asserted equal to MARKER_RE in thumbs.test.mjs. */
const MARKER = /^media:([0-9a-f]{64}):(\d+)$/;
/* What `previewOf` holds: the same hash and length, shaped so that neither
   MARKER_RE nor anything else walking the row mistakes it for a media
   reference. It never leaves the device — every push restores it away. */
const PREVIEW_RE = /^thumb:([0-9a-f]{64}):(\d+)$/;

/** Swap photo markers for previews. `getPreview(hash)` resolves the thumbnail
    bytes, or null/throws when there isn't one — in which case the entry is
    left alone and the normal inflate downloads the photo in full, exactly as
    before. Photos only: they are 68.6% of blob bytes and the only collection
    whose consumers already know how to fetch full-res on demand. Pure apart
    from `getPreview`; the input is never mutated. */
export async function previewPhotos(slim, getPreview) {
  const photos = slim && Array.isArray(slim.photos) ? slim.photos : null;
  if (!photos || typeof getPreview !== "function") return { project: slim, previewed: 0 };
  let out = null, previewed = 0;
  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    if (!ph || typeof ph !== "object") continue;
    const m = typeof ph.src === "string" ? MARKER.exec(ph.src) : null;
    if (!m) continue;                 // inline bytes, already previewed, or empty
    if (ph.cloud) continue;           // ARCHIVED on purpose — never restyle the owner's copy
    let preview = null;
    try { preview = await getPreview(m[1]); } catch { preview = null; }
    if (typeof preview !== "string" || !preview.startsWith("data:image/")) continue;
    // A stand-in that isn't smaller than the marker it replaces is not worth
    // storing, and one bigger than the photo would defeat the whole point.
    if (preview.length >= Number(m[2])) continue;
    if (!out) out = { ...slim, photos: photos.slice() };
    out.photos[i] = { ...ph, src: preview, cloud: m[1], [PREVIEW_OF]: `thumb:${m[1]}:${m[2]}` };
    previewed++;
  }
  return { project: out || slim, previewed };
}

/** Undo previewPhotos: every stand-in becomes the marker it stands for again.
    MUST run before any deflate that feeds a push — see deflateSynced in
    sync.js, and the assertion in thumbs.test.mjs that no other path exists.
    Pure; the input is never mutated. */
export function restorePhotoMarkers(project) {
  const photos = project && Array.isArray(project.photos) ? project.photos : null;
  if (!photos) return project;
  let out = null;
  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    const mark = isPreviewEntry(ph) ? PREVIEW_RE.exec(ph[PREVIEW_OF]) : null;
    if (!mark) continue;
    if (!out) out = { ...project, photos: photos.slice() };
    // `cloud` goes too: previewPhotos set it, so restoring must unset it, or a
    // device would slowly mark every photo it ever previewed as archived.
    const { [PREVIEW_OF]: _mark, cloud: _hash, ...rest } = ph;
    out.photos[i] = { ...rest, src: `media:${mark[1]}:${mark[2]}` };
  }
  return out || project;
}
