/* ============================================================
   Roybal Field Forms — job-photo export (ZIP) + cloud offload

   exportPhotosZip(project, onProgress)
     Packs every gallery photo into one .zip at full resolution,
     plus a photo-index.csv manifest (stage / room / caption /
     date / AI note). Cloud-offloaded photos are fetched from the
     field-media bucket by hash.

   exportPhotoLogPdf(project, onProgress)
     The file a carrier reviewer can actually open: every photo at
     full size, two to a page, grouped before/during/after, in PDF
     parts that each stay under the email cap — because carrier and
     TPA intake flattens the insured's upload into a PDF, and the
     portal link on the packet arrives as dead text. Numbering and
     reachability rules are the ZIP's; the writer is photopdf.js.

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
import { buildPhotoLogPdf, jpegInfo, PHOTO_ENCODE, PART_MAX_BYTES } from "./photopdf.js";
import { shareLive, photoShareLink, packetShareLink } from "./photoshare.js";
import { qrModules } from "./qr.js";

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

/* The photo-log PDF. Same photo set, order and numbering as the ZIP (and
   therefore the portal share): a photo's number is its position among the
   photos that exist, and a photo that can't be fetched still keeps its
   number so the two never drift apart. Full-res is re-encoded on a canvas
   to PHOTO_ENCODE (1100 px / q0.62 — ~80 KB a photo) before it goes in;
   an offloaded photo whose original is unreachable falls back to its
   inline preview and is LABELLED preview-only, like the ZIP. The cover
   carries whichever insurance links are live — none prints as nothing.
   `deps` lets the test run this without a canvas or a network. */
export async function exportPhotoLogPdf(project, onProgress = () => {}, deps = {}) {
  const fetchFull = deps.fetchFull || photoFullSrc;
  const shrink = deps.shrink || ((src) => shrinkDataURL(src, PHOTO_ENCODE.maxDim, PHOTO_ENCODE.quality));
  const qr = deps.qr || qrModules;
  const photos = (project.photos || []).filter((p) => p.src || p.cloud);
  if (!photos.length) throw new Error("No photos on this job yet");
  const items = [];
  let n = 0, missing = 0, previews = 0;
  for (const ph of photos) {
    n++;
    onProgress(n, photos.length);
    let src = null, preview = false;
    if (ph.cloud) {
      try { src = await fetchFull(ph); } catch { src = null; }
      if (!src && isInline(ph.src)) { src = ph.src; preview = true; }
    } else if (isInline(ph.src)) {
      src = ph.src;
    }
    let parsed = null;
    if (src) {
      let small = null;
      try { small = await shrink(src); } catch { small = null; }
      parsed = (isInline(small) && dataURLToBytes(small)) || dataURLToBytes(src);
    }
    if (!parsed || parsed.mime !== "image/jpeg" || !jpegInfo(parsed.bytes)) { missing++; continue; }
    if (preview) previews++;
    // unlabeled legacy photos count as "during" everywhere else in the app
    const stage = ph.stage === "before" || ph.stage === "after" ? ph.stage : "during";
    items.push({ num: n, stage, room: ph.room || "", caption: ph.caption || "", jpeg: parsed.bytes, preview });
  }
  if (!items.length) throw new Error("No photo is reachable from this device yet — sync first, then try again");
  const links = [];
  const live = shareLive(project, "photos");
  if (live) {
    const url = photoShareLink(live.token);
    let matrix = null;
    try { matrix = await qr(url); } catch { matrix = null; }   // offline + vendored lib uncached: link prints without the code
    links.push({
      head: "All job photos — full resolution, view & download:", url, qr: matrix,
      sub: "Open the link (or scan the code) to view every photo full size and download them individually or as one ZIP.",
    });
  }
  const packet = shareLive(project, "packet");
  if (packet) links.push({ head: "Complete job packet — every sheet, printable:", url: packetShareLink(packet.token) });
  const out = buildPhotoLogPdf({
    header: { customer: project.customer, address: project.address, claimNo: project.claimNo, dateOfLoss: project.dateOfLoss },
    links, photos: items, maxBytes: deps.maxBytes || PART_MAX_BYTES,
  });
  return { parts: out.parts, count: out.total, missing: missing + out.skipped.length, previews, linked: !!live };
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
