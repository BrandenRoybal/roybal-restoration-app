/* ============================================================
   Roybal Field Forms — job-photo export (ZIP) + cloud offload

   exportPhotosZip(project, onProgress)
     Packs every gallery photo into one .zip at full resolution,
     plus a photo-index.csv manifest (stage / room / caption /
     date / AI note). Cloud-offloaded photos are fetched from the
     field-media bucket by hash.

   archivePhotos(project, onProgress)
     "Move the files out": for each big inline photo, make sure
     the full-res copy is in the field-media bucket (verified,
     uploading if needed), then swap the inline src for a small
     thumbnail and keep the bucket hash on the entry (ph.cloud).
     A 40MB photo job shrinks to ~KBs per photo on EVERY device;
     viewing/exporting re-fetches full-res on demand. ph.cloud is
     a bare hex hash — deliberately NOT the sync marker format,
     so sync never re-inflates it back into the job.
   ============================================================ */
import { downloadMedia, uploadMedia, mediaExists } from "./supa.js";
import { sha256Hex, MEDIA_MIN } from "./media.js";
import { shrinkDataURL, csvRow } from "./core.js";
import { zipStore, dataURLToBytes } from "./zip.js";

const isInline = (src) => typeof src === "string" && src.startsWith("data:");

/* FULL-RESOLUTION source for a photo, or null when it isn't reachable
   (offloaded + offline, or a sync marker awaiting download). Never silently
   substitutes the inline thumbnail for an offloaded photo — callers that can
   live with a preview must choose that themselves. */
export async function photoFullSrc(ph) {
  if (ph.cloud) {
    try { return await downloadMedia(ph.cloud); } catch { return null; }
  }
  return isInline(ph.src) ? ph.src : null;
}

/* photos that still carry a big inline original (candidates to offload) */
export const archivableCount = (project) =>
  (project.photos || []).filter((p) => isInline(p.src) && p.src.length > MEDIA_MIN && !p.cloud).length;

const slug = (s, n = 48) =>
  String(s || "").replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim().slice(0, n).trim();

const EXT = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export async function exportPhotosZip(project, onProgress = () => {}) {
  const photos = (project.photos || []).filter((p) => p.src || p.cloud);
  if (!photos.length) throw new Error("No photos on this job yet");
  const entries = [];
  const rows = [csvRow(["#", "file", "stage", "room", "caption", "taken", "ai_note", "quality"])];
  let n = 0, missing = 0, previews = 0;
  for (const ph of photos) {
    n++;
    onProgress(n, photos.length);
    const meta = [ph.stage || "", ph.room || "", ph.caption || "", (ph.ts || "").slice(0, 10), ph.aiNote || ""];
    // offloaded photo: fetch the original; if unreachable, fall back to the
    // inline thumbnail but SAY SO — a 480px preview handed to an insurer as
    // "the photo" is worse than an honest gap
    let src = null, preview = false;
    if (ph.cloud) {
      try { src = await downloadMedia(ph.cloud); } catch { src = null; }
      if (!src && isInline(ph.src)) { src = ph.src; preview = true; }
    } else if (isInline(ph.src)) {
      src = ph.src;
    }
    const parsed = src && dataURLToBytes(src);
    if (!parsed) {
      missing++;
      rows.push(csvRow([n, "(unavailable — not on this device or in the cloud)", ...meta, "missing"]));
      continue;
    }
    const ext = EXT[parsed.mime] || "jpg";
    const name = [String(n).padStart(3, "0"), ph.stage, slug(ph.room), slug(ph.caption)]
      .filter(Boolean).join(" ") + (preview ? " (preview-only)" : "") + "." + ext;
    if (preview) previews++;
    entries.push({ name, bytes: parsed.bytes });
    rows.push(csvRow([n, name, ...meta, preview ? "PREVIEW ONLY — retry online for the original" : "full"]));
  }
  entries.push({ name: "photo-index.csv", bytes: new TextEncoder().encode(rows.join("\n") + "\n") });
  return { parts: zipStore(entries), count: entries.length - 1, missing, previews };
}

export async function archivePhotos(project, onProgress = () => {}) {
  const targets = (project.photos || []).filter((p) => isInline(p.src) && p.src.length > MEDIA_MIN && !p.cloud);
  let moved = 0, freed = 0, n = 0;
  for (const ph of targets) {
    n++;
    onProgress(n, targets.length);
    const hash = await sha256Hex(ph.src);
    // NEVER drop the inline original until the bucket copy is verified —
    // most photos are already there (sync offloads them content-addressed),
    // so this is usually just a cheap existence check.
    if (!(await mediaExists(hash))) {
      await uploadMedia(hash, ph.src);
      if (!(await mediaExists(hash))) throw new Error("cloud copy could not be verified");
    }
    const thumb = await shrinkDataURL(ph.src, 480, 0.5);
    if (!isInline(thumb)) continue;        // couldn't re-encode — keep the original inline
    freed += ph.src.length - thumb.length;
    ph.cloud = hash;
    ph.src = thumb;
    moved++;
  }
  return { moved, freed };
}
