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

export const MEDIA_MIN = 60_000;   // chars; photos are ~200KB–3MB, signatures ~10–30KB stay inline
export const MARKER_RE = /^media:([0-9a-f]{64}):(\d+)$/;

export const isMediaMarker = (v) => typeof v === "string" && MARKER_RE.test(v);
const isBigMedia = (v) => typeof v === "string" && v.length > MEDIA_MIN && v.startsWith("data:");

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* every distinct offloadable string in the tree */
export function findMedia(node, out = new Set()) {
  if (typeof node === "string") { if (isBigMedia(node)) out.add(node); return out; }
  if (Array.isArray(node)) { for (const v of node) findMedia(v, out); return out; }
  if (node && typeof node === "object") { for (const v of Object.values(node)) findMedia(v, out); return out; }
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

/* slim → full. download(hash) resolves to the original string, or null
   when the object no longer exists on the server (marker stays, counted
   in `missing`). A thrown download (network) propagates so the caller
   can retry the row on the next sync cycle. */
export async function inflateProject(slim, download) {
  const markers = findMarkers(slim);
  if (!markers.size) return { project: slim, missing: 0 };
  const map = new Map();
  let missing = 0;
  for (const marker of markers) {
    const hash = MARKER_RE.exec(marker)[1];
    const text = await download(hash);
    if (text == null) { missing++; continue; }
    map.set(marker, text);
  }
  return { project: map.size ? replaceStrings(slim, map) : slim, missing };
}
