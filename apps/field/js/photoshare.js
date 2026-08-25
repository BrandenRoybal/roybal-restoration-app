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
import { sha256Hex, MARKER_RE, MEDIA_MIN } from "./media.js";
import { newShareToken } from "./portal.js";
import { qrSvg } from "./qr.js";

export const photoShareLink = (token) =>
  token ? `https://portal.roybalconstruction.com/photos/${token}` : "";
export const packetShareLink = (token) =>
  token ? `https://portal.roybalconstruction.com/packet/${token}` : "";
export const shareLinkFor = (kind, token) =>
  kind === "packet" ? packetShareLink(token) : photoShareLink(token);
export const shareLive = (project, kind) => {
  const s = project.photoShares && project.photoShares[kind];
  return s && s.publishedAt && s.enabled !== false ? s : null;
};

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

const requireOnline = () => {
  if (!isSignedIn()) throw new Error("Sign in under Menu → Sync first — the link is served from the cloud");
  if (navigator.onLine === false) throw new Error("Publishing a link needs internet — try again when online");
};

/* Upsert the share row by its stable id and remember the token on the job,
   so every device offers the SAME link. Shared by both share kinds. */
async function upsertShareRow(project, kind, photos, count) {
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
    photos,
    published_at: new Date().toISOString(),
  };
  const res = await rest("photo_shares", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error("Publish failed (" + res.status + "): " + (await res.text().catch(() => "")));
  s.publishedAt = row.published_at;
  s.count = count;
  s.enabled = true;
  project.updatedAt = new Date().toISOString();
  await Store.put(project);
  return s;
}

/* Publish (or re-publish) a photo share: upload what's missing, upsert the
   row. Returns { link, count, skipped }. */
export async function publishPhotoShare(project, kind, onProgress = () => {}) {
  requireOnline();
  const found = collectSharePhotos(project, kind);
  if (!found.length) throw new Error(kind === "contents" ? "No item photos yet — add photos to the items first" : "No photos on this job yet");
  const { rows, skipped } = await buildSharePhotos(found, ensureUploaded, onProgress);
  if (!rows.length) throw new Error("No photo is reachable from this device yet — sync first, then try again");
  const s = await upsertShareRow(project, kind, rows, rows.length);
  return { link: photoShareLink(s.token), count: rows.length, skipped };
}

/* ---------- packet share: the WHOLE job packet as a link ----------
   The packet is rendered HTML, so the share is a SNAPSHOT of it: the live
   sheets are cloned with their state made serializable (typed values →
   attributes, drawn canvases → images, app-only controls removed), every
   embedded image is swapped for its content hash (the sync offload's own
   trick), and the slim skeleton is uploaded to the same bucket. The row is
   photo_shares kind='packet': [{hash, role:'html'|'img'}] — the gateway
   serves the skeleton once and each image by hash, all token-gated. */

const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

/* clone the live sheets into a detached, serializable copy */
export function snapshotSheets(sheets) {
  const wrap = document.createElement("div");
  for (const sheetEl of sheets) {
    const clone = sheetEl.cloneNode(true);
    const orig = [sheetEl, ...sheetEl.querySelectorAll("*")];
    const copy = [clone, ...clone.querySelectorAll("*")];
    for (let i = 0; i < orig.length; i++) {
      const o = orig[i], c = copy[i];
      const tag = o.tagName;
      if (tag === "INPUT") {
        if (o.type === "checkbox" || o.type === "radio") {
          if (o.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked");
        } else c.setAttribute("value", o.value || "");
      } else if (tag === "TEXTAREA") {
        c.textContent = o.value || "";
      } else if (tag === "SELECT") {
        const sel = o.selectedIndex;
        [...c.options].forEach((op, j) => { if (j === sel) op.setAttribute("selected", ""); else op.removeAttribute("selected"); });
      } else if (tag === "CANVAS" && typeof o.toDataURL === "function") {
        // a drawn signature/sketch only exists as pixels — freeze it
        const img = document.createElement("img");
        try { img.src = o.toDataURL("image/png"); } catch { /* tainted/empty — leave blank */ }
        img.setAttribute("class", o.getAttribute("class") || "");
        img.setAttribute("style", o.getAttribute("style") || "");
        c.replaceWith(img);
      }
    }
    clone.querySelectorAll(".app-only").forEach((el) => el.remove());
    wrap.append(clone);
  }
  return wrap;
}

/* swap every big embedded image for its content hash (data-media) — the
   skeleton stays small and each image ships once, content-addressed */
export async function dehydrateImages(root) {
  const media = [];
  const seen = new Map();   // src -> hash (copied photos dedupe)
  for (const img of [...root.querySelectorAll("img")]) {
    const src = img.getAttribute("src") || "";
    if (!src.startsWith("data:") || src.length <= MEDIA_MIN) continue;
    let hash = seen.get(src);
    if (!hash) { hash = await sha256Hex(src); seen.set(src, hash); media.push({ hash, text: src }); }
    img.removeAttribute("src");
    img.setAttribute("data-media", hash);
  }
  return media;
}

/* the self-contained document: snapshot + the app's own stylesheets, so the
   share renders exactly like the printed packet */
export async function buildPacketHtml(project, sheets) {
  const wrap = snapshotSheets(sheets);
  const media = await dehydrateImages(wrap);
  let css = "";
  try {
    const [a, p] = await Promise.all([
      fetch("css/app.css").then((r) => r.text()),
      fetch("css/print.css").then((r) => r.text()),
    ]);
    css = a + "\n" + p;   // print.css unwrapped: the share IS the document look
  } catch { /* offline css fetch — the skeleton still carries the content */ }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Job Packet — ${escHtml(project.customer)}</title>` +
    `<style>${css}</style>` +
    `<style>body{background:#fff;margin:0;padding:16px}.sheet{margin:0 auto 24px;max-width:8.5in;box-shadow:none}</style>` +
    `</head><body>${wrap.innerHTML}</body></html>`;
  return { html, media };
}

/* Publish (or re-publish) the packet link from the packet's rendered,
   non-excluded sheets. Returns { link, count }. */
export async function publishPacketShare(project, sheets, onProgress = () => {}) {
  requireOnline();
  if (!sheets || !sheets.length) throw new Error("Nothing in the packet yet — fill out some forms first");
  const { html, media } = await buildPacketHtml(project, sheets);
  let n = 0;
  for (const m of media) { n++; onProgress(n, media.length + 1); await ensureUploaded(m.hash, m.text); }
  const htmlHash = await sha256Hex(html);
  onProgress(media.length + 1, media.length + 1);
  await ensureUploaded(htmlHash, html);
  const rows = [{ hash: htmlHash, role: "html" }, ...media.map((m) => ({ hash: m.hash, role: "img" }))];
  const s = await upsertShareRow(project, "packet", rows, sheets.length);
  return { link: packetShareLink(s.token), count: sheets.length };
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

/* Print-visible link block for a report sheet — the PDF the adjuster gets
   carries the full-size photo link ON the report, typed or scanned (QR,
   same lazy vendored generator as the box labels). Renders nothing unless
   the share is live, so a dead link never prints. */
export function photoShareSheetLine(project, kind) {
  const s = project.photoShares && project.photoShares[kind];
  if (!s || !s.publishedAt || s.enabled === false) return null;
  const url = photoShareLink(s.token);
  const qr = h("div", { class: "sharelink-print__qr" });
  qrSvg(url, 2, 0).then((svg) => { qr.innerHTML = svg; }).catch(() => {});
  return h("div", { class: "sharelink-print" },
    h("div", { class: "sharelink-print__body" },
      h("div", { class: "sharelink-print__head" },
        (kind === "contents" ? "All item photos" : "All job photos") + " — full resolution, view & download:"),
      h("a", { class: "sharelink-print__url", href: url }, url),
      h("div", { class: "sharelink-print__sub" },
        "Open the link (or scan the code) to view every photo full size and download them individually or as one ZIP.")),
    qr);
}

/* ---------- UI control (photo log / contents manager / packet page) ----------
   One button that publishes / re-publishes, and once live, the link row:
   copy, open, turn off. Photos added after publishing aren't in the link
   until it's updated — the button says so. onChange fires after any state
   change so a host page can repaint its printed link line. The packet page
   passes its own `publish` (the snapshot needs the rendered sheets). */
export function photoShareControl(project, kind, onChange = () => {}, publish = null) {
  const wrap = h("div", { class: "app-only sharelink" });
  const btn = h("button", { type: "button", class: "btn btn--sm" });
  const row = h("div", { class: "sharelink__row" });
  const info = h("div", { class: "subtle", style: "font-size:12px" });
  const noun = kind === "contents" ? "item photos" : kind === "packet" ? "packet pages" : "photos";
  const doPublish = publish || ((onProgress) => publishPhotoShare(project, kind, onProgress));

  const state = () => (project.photoShares && project.photoShares[kind]) || null;

  function paint() {
    const s = state();
    const live = s && s.publishedAt && s.enabled !== false;
    btn.textContent = live
      ? (kind === "packet" ? "🔗 Update packet link" : "🔗 Update insurance link")
      : (kind === "packet" ? "🔗 Insurance packet link" : "🔗 Insurance photo link");
    btn.title = kind === "packet"
      ? "Publish a link the adjuster opens to view and print the whole job packet"
      : `Publish a link the adjuster opens to view and download every ${kind === "contents" ? "contents item photo" : "job photo"} full size`;
    row.replaceChildren();
    info.textContent = "";
    if (!live) return;
    const url = shareLinkFor(kind, s.token);
    const field = h("input", { value: url, readOnly: true, style: "flex:1;font-size:13px;min-height:0" });
    const copy = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "Copy");
    copy.addEventListener("click", async () => {
      const said = kind === "packet" ? "Insurance packet link copied." : "Insurance photo link copied.";
      try { await navigator.clipboard.writeText(url); toast(said); }
      catch { field.select(); document.execCommand && document.execCommand("copy"); toast(said); }
    });
    const open = h("a", { class: "btn btn--ghost btn--sm", style: "width:auto", href: url, target: "_blank", rel: "noopener" }, "Open");
    const off = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "Turn off");
    off.addEventListener("click", async () => {
      if (!confirm("Turn off this link? The adjuster's copy stops working until you publish it again.")) return;
      off.disabled = true;
      try { await setPhotoShareEnabled(project, kind, false); toast("Link turned off."); }
      catch (e) { toast("Couldn't turn the link off: " + (e && e.message || e), 4000); }
      paint();
      onChange();
    });
    row.append(field, copy, open, off);
    info.textContent =
      `${s.count || 0} ${noun} in the link · published ${String(s.publishedAt).slice(0, 10)}` +
      (kind === "packet" ? " — tap Update after changing forms" : " — tap Update after adding photos");
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { count, skipped } = await doPublish((n, total) => {
        btn.textContent = `🔗 Publishing ${n}/${total}…`;
      });
      toast(`Insurance link is live — ${count} ${noun}` + (skipped ? ` (${skipped} unavailable on this device)` : "") + ". Copy it below.", 4500);
    } catch (e) {
      toast("" + (e && e.message || e), 4500);
    }
    btn.disabled = false;
    paint();
    onChange();
  });

  wrap.append(btn, row, info);
  paint();
  return wrap;
}
