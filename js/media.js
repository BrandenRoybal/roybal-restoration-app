/* ============================================================
   Roybal Field Forms — media offload for cloud sync
   ------------------------------------------------------------
   Jobs sync to field_projects as one JSON row, and rows over the
   ~5MB cap used to be silently skipped — a photo-heavy job would
   quietly stop backing up, and a stale copy from another device
   could then overwrite newer work (whole-row last-edit-wins).

   This module keeps the on-device data exactly as it is (data URLs
   everywhere — no render/print/AI code changes) and slims ONLY the
   sync payload:

   - deflateProject(p): every data: URL longer than MEDIA_MIN chars
     is swapped for a "media:<sha256>:<length>" marker; the original
     strings come back as {hash, text} for upload to the private
     field-media storage bucket. Content-addressed → identical
     photos (e.g. copies on a converted rebuild job) upload once.
   - inflateProject(slim, download): markers are swapped back to the
     original strings on pull. A download that returns null (object
     gone on the server) leaves the marker in place and reports it —
     degraded but never blocks sync or destroys data.

   Pure helpers, no DOM/localStorage — Node-testable.
   ============================================================ */

/* THRESHOLDS — measured, not guessed. The offload was originally gated at
   60,000 chars on the assumption that photos are 200KB–3MB. They are not: the
   app stores display-sized thumbnails, and every inline image in the live data
   measured 7.2–35.9 KB. So NOTHING was ever offloaded, and 85% of every job
   record was images — meaning one photo capture rewrote megabytes.
   Photos, sketches and scanned pages now offload from 8KB up. Signatures keep
   the old threshold: they are small, they are the legal artefact on a work
   authorisation or certificate, and there is no reason to make one depend on a
   second object resolving before its job will store. */
export const MEDIA_MIN = 8_000;        // photos, sketches, plan/scan pages
export const SIGNATURE_MIN = 60_000;   // hand-drawn signatures stay inline
export const MARKER_RE = /^media:([0-9a-f]{64}):(\d+)$/;

export const isMediaMarker = (v) => typeof v === "string" && MARKER_RE.test(v);
/* the field a string sits in decides its threshold (sigTech, sigOwner,
   signature, …) — the walk below carries the owning key down */
const isSignatureField = (key) => /^sig/i.test(String(key || ""));
export const thresholdFor = (key) => (isSignatureField(key) ? SIGNATURE_MIN : MEDIA_MIN);
const isBigMedia = (v, key) =>
  typeof v === "string" && v.startsWith("data:") && v.length > thresholdFor(key);

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* every distinct offloadable string in the tree. `key` is the field the value
   sits under, carried down so a signature can keep its own threshold; array
   elements inherit the array's key (uploadedPages: [str, …]). */
export function findMedia(node, out = new Set(), key = "") {
  if (typeof node === "string") { if (isBigMedia(node, key)) out.add(node); return out; }
  if (Array.isArray(node)) { for (const v of node) findMedia(v, out, key); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) findMedia(v, out, k);
    return out;
  }
  return out;
}

/* every distinct marker string in the tree */
export function findMarkers(node, out = new Set()) {
  if (typeof node === "string") { if (isMediaMarker(node)) out.add(node); return out; }
  if (Array.isArray(node)) { for (const v of node) findMarkers(v, out); return out; }
  if (node && typeof node === "object") { for (const v of Object.values(node)) findMarkers(v, out); return out; }
  return out;
}

/* deep copy with string substitution; the input is never mutated */
export function replaceStrings(node, map) {
  if (typeof node === "string") return map.has(node) ? map.get(node) : node;
  if (Array.isArray(node)) return node.map((v) => replaceStrings(v, map));
  if (node && typeof node === "object") {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = replaceStrings(v, map);
    return o;
  }
  return node;
}

/* project → { slim, media: [{hash, text}] } — returns the project itself
   (same reference) when there is nothing to offload */
export async function deflateProject(project) {
  const media = [];
  const map = new Map();
  for (const text of findMedia(project)) {
    const hash = await sha256Hex(text);
    map.set(text, `media:${hash}:${text.length}`);
    media.push({ hash, text });
  }
  return { slim: map.size ? replaceStrings(project, map) : project, media };
}

/* How many media objects may be in flight at once.

   This used to be 1 — every marker awaited in turn — and that, not bandwidth,
   is what made a fresh device's first sync take fifteen minutes. Measured on
   2026-09-08: 860 objects fetched one at a time, ~1.7 per second, while the
   server answered each in 136-330 ms. Every authorized GET also costs a CORS
   preflight, so each object is two round trips of mostly waiting.

   Raising it is safe because media is CONTENT-ADDRESSED and immutable: the
   object at hash H is the same bytes whenever and in whatever order it
   arrives, results are collected into a map before any substitution, and
   `replaceStrings` is order-independent. Nothing here races anything.

   Six, not sixty. The 2026-09-07 outage was a storage storm exhausting the
   connection pool, and while this changes no REQUEST COUNT — the same objects
   are fetched exactly once either way, only sooner — a device is not the only
   client of that pool. Six is well inside what a browser opens for an ordinary
   page and still turns nine minutes of waiting into about ninety seconds. */
export const MEDIA_CONCURRENCY = 6;

/* slim → full. download(hash) resolves to the original string, or null
   when the object no longer exists on the server (marker stays, counted
   in `missing`). A thrown download (network) propagates so the caller
   can retry the row on the next sync cycle — the FIRST error is thrown and
   the remaining workers stop, so one network blip cannot leave a rejected
   promise unhandled behind it. */
export async function inflateProject(slim, download, concurrency = MEDIA_CONCURRENCY) {
  const markers = [...findMarkers(slim)];
  if (!markers.length) return { project: slim, missing: 0 };
  const map = new Map();
  let missing = 0, next = 0, failure = null;
  const worker = async () => {
    while (failure === null) {
      const i = next++;
      if (i >= markers.length) return;
      const marker = markers[i];
      try {
        const text = await download(MARKER_RE.exec(marker)[1]);
        if (text == null) missing++; else map.set(marker, text);
      } catch (e) { failure = failure || e; return; }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency | 0 || 1, markers.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  if (failure) throw failure;
  return { project: map.size ? replaceStrings(slim, map) : slim, missing };
}
