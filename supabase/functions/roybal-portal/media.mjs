/* ============================================================
   Portal media — which images a job link may fetch, one at a time.

   The view used to inline every shared photo and document page, full size,
   in one response: the 38-photo job sent 24 photos (~5 MB of base64) before
   the page could draw, and again on every visit. Now the view lists content
   hashes and the page asks for each image as it scrolls into sight — a small
   preview first (the thumbnail sweep's `thumb_<hash>` object, when it
   exists), then the full photo.

   The gate is the same one photo_shares uses: a hash is served only when it
   is listed on THIS token's portal_jobs row, so a link can never reach
   another job's media by guessing. PURE — shared by the Deno gateway and
   the Node test, no imports.
   ============================================================ */

const HASH = /^[0-9a-f]{64}$/;
const arr = (v) => (Array.isArray(v) ? v : []);

export const PHOTO_MAX = 60;     // listed photos per view (hashes only, so cheap)
export const DOC_MAX = 6;        // shared documents per view
export const DOC_PAGE_MAX = 8;   // pages per document

/* the view's photo + document lists, hashes only, capped and validated */
export function mediaLists(row) {
  const r = row || {};
  const photos = arr(r.photos).slice(0, PHOTO_MAX)
    .filter((p) => p && HASH.test(String(p.mediaHash || "")))
    .map((p) => ({ hash: String(p.mediaHash), caption: String(p.caption || "").slice(0, 500), stage: String(p.stage || "").slice(0, 20) }));
  const documents = arr(r.documents).slice(0, DOC_MAX)
    .map((d) => ({
      label: String((d && d.label) || "Document").slice(0, 120),
      type: String((d && d.type) || "").slice(0, 60),
      pages: arr(d && d.pages).slice(0, DOC_PAGE_MAX).map(String).filter((h) => HASH.test(h)),
    }))
    .filter((d) => d.pages.length);
  return { photos, documents };
}

/* a document sent for signature: its HTML snapshot's hash and the images
   inside it, as the field app stored them on the approval */
export function signDoc(approval) {
  const d = approval && approval.doc;
  if (!d || !HASH.test(String(d.html || ""))) return null;
  return { html: String(d.html), media: arr(d.media).map(String).filter((h) => HASH.test(h)) };
}

/* true only when `hash` is one of the images this row shares — its photos,
   its document pages, or an image inside a document it asks them to sign */
export function mediaAllowed(row, hash) {
  const h = String(hash || "");
  if (!HASH.test(h)) return false;
  const { photos, documents } = mediaLists(row);
  if (photos.some((p) => p.hash === h) || documents.some((d) => d.pages.includes(h))) return true;
  return arr(row && row.approvals).some((a) => { const d = signDoc(a); return !!d && d.media.includes(h); });
}

/* the storage keys to try, in order: a preview asks for the thumbnail and
   falls back to the full object (small photos never get a thumbnail) */
export function mediaKeys(hash, size) {
  const h = String(hash || "");
  if (!HASH.test(h)) return [];
  return size === "thumb" ? ["thumb_" + h, h] : [h];
}
