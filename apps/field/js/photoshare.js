/* ============================================================
   Roybal Field Forms — insurance photo links
   ------------------------------------------------------------
   The emailed packet carries photos at PDF size; an adjuster who
   wants the real files needs the ORIGINALS. This module publishes
   a token-gated share of a job's photos — the whole Photo Log, or
   every Contents item photo — as one row in `photo_shares`:
   content hashes into the private field-media bucket plus the
   claim header, never image data. The adjuster opens
   portal.roybalconstruction.com/photos/<token>, where the
   roybal-portal gateway serves each full-size image by hash,
   token-checked, with per-photo and ZIP download.

   Publishing verifies every photo's full-res copy is in the
   bucket first (uploading any that sync hasn't offloaded yet) —
   the same never-trust-until-verified rule as archivePhotos.
   The pure builders are Node-testable; the UI control is not.
   ============================================================ */
import { h, uid, toast, Store } from "./core.js";
import { rest, isSignedIn, uploadMedia, mediaExists } from "./supa.js";
import { sha256Hex, MARKER_RE } from "./media.js";
import { newShareToken } from "./portal.js";

export const photoShareLink = (token) =>
  token ? `https://portal.roybalconstruction.com/photos/${token}` : "";

const isInline = (s) => typeof s === "string" && s.startsWith("data:");

/* PURE + TESTABLE — the descriptors a share of `kind` covers: which photos,
   with which labels. No hashing, no network. Contents photos carry the item
   name so the gallery reads like the inventory; log photos keep their
   caption / room / stage. */
export function collectSharePhotos(project, kind) {
  const out = [];
  if (kind === "contents") {
    for (const it of (project.contents || [])) {
      const label = [it.qty && String(it.qty) !== "1" ? it.qty + "×" : "", it.name || "Untitled item"]
        .filter(Boolean).join(" ");
      for (const src of (it.photos || []))
        out.push({ src, cloud: "", caption: "", room: it.room || "", stage: "", item: label });
    }
  } else {
    for (const ph of (project.photos || []))
      out.push({ src: ph.src || "", cloud: ph.cloud || "", caption: ph.caption || "", room: ph.room || "", stage: ph.stage || "", item: "" });
  }
  return out;
}

/* TESTABLE with a stubbed `ensure` — resolve each descriptor to its bucket
   hash. A cloud-moved photo's hash IS its full-res object; a sync marker
   (media:<hash>:<len> — the photo text hasn't downloaded to this device)
   carries its hash in the string; an inline data URL is hashed and pushed
   through ensure(hash, src) so the object verifiably exists before the
   link ever points at it. Unusable descriptors are skipped and counted —
   a gap the caller reports, never papers over. */
export async function buildSharePhotos(photos, ensure, onProgress = () => {}) {
  const rows = [];
  let skipped = 0, n = 0;
  for (const p of photos) {
    n++;
    onProgress(n, photos.length);
    let hash = "";
    const m = typeof p.src === "string" ? MARKER_RE.exec(p.src) : null;
    if (p.cloud) hash = p.cloud;
    else if (m) hash = m[1];
    else if (isInline(p.src)) { hash = await sha256Hex(p.src); await ensure(hash, p.src); }
    if (!hash) { skipped++; continue; }
    rows.push({ hash, caption: p.caption || "", room: p.room || "", stage: p.stage || "", item: p.item || "" });
  }
  return { rows, skipped };
}

async function ensureUploaded(hash, src) {
  if (await mediaExists(hash)) return;
  await uploadMedia(hash, src);
  if (!(await mediaExists(hash))) throw new Error("cloud copy could not be verified");
}

/* Publish (or re-publish) the share: upload what's missing, upsert the row
   by its stable id, remember the token on the job so every device offers
   the SAME link. Returns { link, count, skipped }. */
export async function publishPhotoShare(project, kind, onProgress = () => {}) {
  if (!isSignedIn()) throw new Error("Sign in under Menu → Sync first — the link is served from the cloud");
  if (navigator.onLine === false) throw new Error("Publishing a link needs internet — try again when online");
  const found = collectSharePhotos(project, kind);
  if (!found.length) throw new Error(kind === "contents" ? "No item photos yet — add photos to the items first" : "No photos on this job yet");
  const { rows, skipped } = await buildSharePhotos(found, ensureUploaded, onProgress);
  if (!rows.length) throw new Error("No photo is reachable from this device yet — sync first, then try again");
  if (!project.photoShares || typeof project.photoShares !== "object") project.photoShares = {};
  const s = project.photoShares[kind] || (project.photoShares[kind] = { id: uid(), token: newShareToken() });
  const row = {
    id: s.id,
    field_project_id: project.id || null,
    share_token: s.token,
    enabled: true,
    kind,
    customer_name: project.customer || "",
    property_address: project.address || "",
    claim_no: project.claimNo || "",
    date_of_loss: project.dateOfLoss || "",
    photos: rows,
    published_at: new Date().toISOString(),
  };
  const res = await rest("photo_shares", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error("Publish failed (" + res.status + "): " + (await res.text().catch(() => "")));
  s.publishedAt = row.published_at;
  s.count = rows.length;
  s.enabled = true;
  project.updatedAt = new Date().toISOString();
  await Store.put(project);
  return { link: photoShareLink(s.token), count: rows.length, skipped };
}

/* Flip the server row's switch — the link dies (or revives) immediately,
   without changing the token, so re-enabling restores the SAME url. */
export async function setPhotoShareEnabled(project, kind, enabled) {
  const s = project.photoShares && project.photoShares[kind];
  if (!s) return;
  const res = await rest(`photo_shares?id=eq.${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !!enabled }) });
  if (!res.ok) throw new Error("Update failed (" + res.status + ")");
  s.enabled = !!enabled;
  project.updatedAt = new Date().toISOString();
  await Store.put(project);
}

/* ---------- UI control (photo log + contents manager) ----------
   One button that publishes / re-publishes, and once live, the link row:
   copy, open, turn off. Photos added after publishing aren't in the link
   until it's updated — the button says so. */
export function photoShareControl(project, kind) {
  const wrap = h("div", { class: "app-only sharelink" });
  const btn = h("button", { type: "button", class: "btn btn--sm" });
  const row = h("div", { class: "sharelink__row" });
  const info = h("div", { class: "subtle", style: "font-size:12px" });
  const noun = kind === "contents" ? "item photos" : "photos";

  const state = () => (project.photoShares && project.photoShares[kind]) || null;

  function paint() {
    const s = state();
    const live = s && s.publishedAt && s.enabled !== false;
    btn.textContent = live ? "🔗 Update insurance link" : "🔗 Insurance photo link";
    btn.title = `Publish a link the adjuster opens to view and download every ${kind === "contents" ? "contents item photo" : "job photo"} full size`;
    row.replaceChildren();
    info.textContent = "";
    if (!live) return;
    const url = photoShareLink(s.token);
    const field = h("input", { value: url, readOnly: true, style: "flex:1;font-size:13px;min-height:0" });
    const copy = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "Copy");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(url); toast("Insurance photo link copied."); }
      catch { field.select(); document.execCommand && document.execCommand("copy"); toast("Insurance photo link copied."); }
    });
    const open = h("a", { class: "btn btn--ghost btn--sm", style: "width:auto", href: url, target: "_blank", rel: "noopener" }, "Open");
    const off = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "Turn off");
    off.addEventListener("click", async () => {
      if (!confirm("Turn off this link? The adjuster's copy stops working until you publish it again.")) return;
      off.disabled = true;
      try { await setPhotoShareEnabled(project, kind, false); toast("Link turned off."); }
      catch (e) { toast("Couldn't turn the link off: " + (e && e.message || e), 4000); }
      paint();
    });
    row.append(field, copy, open, off);
    info.textContent =
      `${s.count || 0} ${noun} in the link · published ${String(s.publishedAt).slice(0, 10)} — tap Update after adding photos`;
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { count, skipped } = await publishPhotoShare(project, kind, (n, total) => {
        btn.textContent = `🔗 Publishing ${n}/${total}…`;
      });
      toast(`Insurance link is live — ${count} ${noun}` + (skipped ? ` (${skipped} unavailable on this device)` : "") + ". Copy it below.", 4500);
    } catch (e) {
      toast("" + (e && e.message || e), 4500);
    }
    btn.disabled = false;
    paint();
  });

  wrap.append(btn, row, info);
  paint();
  return wrap;
}
