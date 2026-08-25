/* Roybal — insurance photo link page (/photos/<token>).
   The field app publishes a job's Photo Log or Contents item photos as a
   photo_shares row; this page asks the roybal-portal gateway for the list
   (hashes + labels only), then pulls each FULL-SIZE image one at a time as
   its tile scrolls into view. Tap a photo for the full-screen viewer;
   every photo downloads individually or all together as one ZIP. No login:
   the unguessable token is the credential, and the gateway serves only the
   images listed in that token's row. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { zipStore, dataURLToBytes } from "./zip.js";

const app = document.getElementById("app");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

function tokenFromUrl() {
  const m = location.pathname.match(/\/photos\/([0-9a-f]{16,})/i);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get("t");
  return q && /^[0-9a-f]{16,}$/i.test(q) ? q : "";
}

async function callGateway(payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-portal`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { const e = new Error(body.error || "load_failed"); e.status = res.status; throw e; }
  return body;
}

const token = tokenFromUrl();

/* one fetch per image, ever — the grid, the viewer, the per-photo download
   and the ZIP all reuse it. In-flight promises are cached too, so a tap on a
   tile that's still loading doesn't start a second fetch. */
const srcCache = new Map();   // hash -> Promise<dataURL>
const fullSrc = (hash) => {
  if (!srcCache.has(hash)) {
    const p = callGateway({ action: "photoMedia", token, hash }).then((r) => r.src);
    p.catch(() => srcCache.delete(hash));    // failed fetch retries on the next ask
    srcCache.set(hash, p);
  }
  return srcCache.get(hash);
};

const EXT = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const slug = (s, n = 48) =>
  String(s || "").replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim().slice(0, n).trim();

function photoFileName(p, i, mime) {
  return [String(i + 1).padStart(3, "0"), p.stage, slug(p.item), slug(p.room), slug(p.caption)]
    .filter(Boolean).join(" ") + "." + (EXT[mime] || "jpg");
}

function saveBlob(name, blob) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function downloadOne(p, i) {
  const src = await fullSrc(p.hash);
  const parsed = dataURLToBytes(src);
  if (!parsed) throw new Error("photo unavailable");
  saveBlob(photoFileName(p, i, parsed.mime), new Blob([parsed.bytes], { type: parsed.mime }));
}

const photoLabel = (p) =>
  [p.item, p.room, p.stage ? p.stage[0].toUpperCase() + p.stage.slice(1) : "", p.caption]
    .filter(Boolean).join(" · ");

/* ---------- full-screen viewer ---------- */
function openViewer(share, start) {
  let i = start;
  const img = h("img", { class: "plight__img", alt: "" });
  const cap = h("div", { class: "plight__cap" });
  const count = h("span", {});
  const show = async (n) => {
    i = (n + share.photos.length) % share.photos.length;
    const p = share.photos[i];
    count.textContent = `${i + 1} of ${share.photos.length}`;
    cap.textContent = photoLabel(p);
    img.src = "";
    img.src = await fullSrc(p.hash).catch(() => "");
  };
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(i + 1);
    else if (e.key === "ArrowLeft") show(i - 1);
  };
  const dl = h("button", { class: "plight__btn", onclick: () => downloadOne(share.photos[i], i).catch(() => {}) }, "⬇ Download");
  const overlay = h("div", { class: "plight", onclick: (e) => { if (e.target === overlay) close(); } },
    h("div", { class: "plight__bar" },
      count,
      h("div", {}, dl, h("button", { class: "plight__btn", onclick: close }, "✕ Close")),
    ),
    h("button", { class: "plight__nav plight__nav--l", onclick: () => show(i - 1) }, "‹"),
    img,
    h("button", { class: "plight__nav plight__nav--r", onclick: () => show(i + 1) }, "›"),
    cap);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  show(i);
}

/* ---------- download all (ZIP) ---------- */
function zipAllButton(share) {
  const btn = h("button", { class: "btn-zip" }, "⬇ Download all (.zip)");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const entries = [];
      for (let i = 0; i < share.photos.length; i++) {
        btn.textContent = `⬇ Fetching ${i + 1}/${share.photos.length}…`;
        const p = share.photos[i];
        const src = await fullSrc(p.hash).catch(() => null);
        const parsed = src && dataURLToBytes(src);
        if (parsed) entries.push({ name: photoFileName(p, i, parsed.mime), bytes: parsed.bytes });
      }
      if (!entries.length) throw new Error("no photos could be fetched");
      const safe = (slug(share.customer_name) || "job") +
        (share.kind === "contents" ? " contents" : "") + " photos.zip";
      saveBlob(safe, new Blob(zipStore(entries), { type: "application/zip" }));
      btn.textContent = `✓ Downloaded ${entries.length} photos`;
    } catch (e) {
      btn.textContent = "Download failed — tap to retry";
    }
    btn.disabled = false;
    setTimeout(() => { btn.textContent = "⬇ Download all (.zip)"; }, 4000);
  });
  return btn;
}

/* ---------- page ---------- */
function render(share) {
  const meta = [
    share.property_address,
    share.claim_no ? `Claim # ${share.claim_no}` : "",
    share.date_of_loss ? `Date of loss ${share.date_of_loss}` : "",
  ].filter(Boolean).join(" · ");

  const grid = h("div", { class: "pgrid" });
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const p = share.photos[Number(en.target.dataset.i)];
      fullSrc(p.hash).then((src) => { en.target.querySelector("img").src = src; })
        .catch(() => { en.target.querySelector(".pcard__ph").textContent = "unavailable"; });
    }
  }, { rootMargin: "600px" });

  share.photos.forEach((p, i) => {
    const tile = h("figure", { class: "pcard", "data-i": String(i) },
      h("div", { class: "pcard__ph" }, h("img", { alt: "", loading: "lazy", onclick: () => openViewer(share, i) })),
      h("figcaption", {},
        h("span", { class: "pcard__cap" }, photoLabel(p) || "—"),
        h("button", { class: "pcard__dl", title: "Download full size", onclick: () => downloadOne(p, i).catch(() => {}) }, "⬇")));
    grid.append(tile);
    io.observe(tile);
  });

  app.replaceChildren(
    h("div", { class: "card hero" },
      h("h1", {}, (share.kind === "contents" ? "Contents Photos — " : "Job Photos — ") + (share.customer_name || "Job")),
      meta ? h("p", { class: "addr" }, meta) : null,
      h("p", { class: "pcount" },
        `${share.photos.length} photo${share.photos.length === 1 ? "" : "s"}, full resolution. ` +
        "Tap any photo to view it; the arrows page through. Download photos individually or all at once."),
      zipAllButton(share)),
    grid);
}

async function main() {
  if (!token) {
    app.replaceChildren(h("div", { class: "msg" }, h("div", { class: "big" }, "🔍"),
      h("h2", {}, "Link not recognized"),
      h("p", {}, "Please use the exact link you were sent, or contact Roybal Construction at 907-371-9868.")));
    return;
  }
  try {
    const share = await callGateway({ action: "photoShare", token });
    if (!share.photos || !share.photos.length) {
      app.replaceChildren(h("div", { class: "msg" }, h("div", { class: "big" }, "📷"),
        h("h2", {}, "No photos yet"),
        h("p", {}, "This link is live but no photos have been published to it yet.")));
      return;
    }
    render(share);
  } catch (e) {
    app.replaceChildren(h("div", { class: "msg" }, h("div", { class: "big" }, "🔒"),
      h("h2", {}, "This link isn't active"),
      h("p", {}, "It may have been turned off or replaced. Contact Roybal Construction at 907-371-9868 for a current link.")));
  }
}

main();
