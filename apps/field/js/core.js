/* ============================================================
   Roybal Field Forms — core utilities
   DOM helpers, IndexedDB persistence, signature/sketch pads,
   psychrometric (GPP) math. No build step, no dependencies.
   ============================================================ */

/* ---------- tiny DOM helper (hyperscript) ---------- */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/* ---------- ids / dates / money ---------- */
export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const nowLocalISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const money = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

/* ---------- IndexedDB store ("projects" + on-device "backups") ---------- */
const DB_NAME = "roybal-field";
const STORE = "projects";
const BACKUPS = "backups";
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(BACKUPS)) d.createObjectStore(BACKUPS, { keyPath: "id" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, name = STORE) { return db().then((d) => d.transaction(name, mode).objectStore(name)); }
const reqProm = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* save/delete listeners — the sync engine subscribes to push changes up */
const _savedFns = [], _deletedFns = [];
export function onProjectSaved(fn) { _savedFns.push(fn); }
export function onProjectDeleted(fn) { _deletedFns.push(fn); }

export const Store = {
  async all() {
    const os = await tx("readonly");
    return new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")));
      r.onerror = () => rej(r.error);
    });
  },
  async get(id) {
    const os = await tx("readonly");
    return new Promise((res, rej) => {
      const r = os.get(id);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  },
  /* opts.bump:false keeps the existing updatedAt; opts.quiet:true skips
     listeners (used by sync when writing rows pulled from the server). */
  async put(project, opts = {}) {
    if (opts.bump !== false) project.updatedAt = new Date().toISOString();
    const os = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = os.put(project);
      r.onsuccess = () => { if (!opts.quiet) _savedFns.forEach((f) => { try { f(project); } catch {} }); res(project); };
      r.onerror = () => rej(r.error);
    });
  },
  async del(id, opts = {}) {
    const os = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = os.delete(id);
      r.onsuccess = () => { if (!opts.quiet) _deletedFns.forEach((f) => { try { f(id); } catch {} }); res(); };
      r.onerror = () => rej(r.error);
    });
  },

  /* ---------- on-device backups ----------
     Snapshotted automatically right before cloud sync merges or replaces a
     local job with a copy from another device — the safety net under the
     merge engine. Newest first, last 10 per job (blobs are slim — media
     lives in the bucket), this device only (never synced). Restorable from
     the job page. */
  async backup(project) {
    if (!project || !project.id) return;
    const row = (await reqProm((await tx("readonly", BACKUPS)).get(project.id))) || { id: project.id, snaps: [] };
    row.snaps.unshift({ takenAt: new Date().toISOString(), data: project });
    row.snaps = row.snaps.slice(0, 10);
    await reqProm((await tx("readwrite", BACKUPS)).put(row));
  },
  async backups(id) {
    const row = await reqProm((await tx("readonly", BACKUPS)).get(id));
    return (row && row.snaps) || [];
  },
};

/* ---------- debounced autosave with a visual "Saved" pulse ---------- */
let saveTimer, pendingProject = null, pendingPill = null;
async function doSave() {
  if (!pendingProject) return;
  const p = pendingProject, pill = pendingPill;
  pendingProject = null; pendingPill = null;
  await Store.put(p);
  if (pill) { pill.textContent = "✓ Saved"; pill.style.color = "var(--green)"; }
}
export function autosave(project, pill) {
  pendingProject = project; pendingPill = pill;
  clearTimeout(saveTimer);
  if (pill) { pill.textContent = "Saving…"; pill.style.color = "var(--muted)"; }
  saveTimer = setTimeout(doSave, 350);
}
/* write any pending edit immediately (call before navigating / reloading) */
export async function flushPending() {
  clearTimeout(saveTimer);
  await doSave();
}

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- trigger a client-side file download (CSV export, etc.) ---------- */
export function downloadFile(filename, content, mime = "text/plain;charset=utf-8") {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch {
    return false;
  }
}

/* ---------- CSV cell escaping ---------- */
export function csvRow(cells) {
  return cells.map((c) => {
    const s = c == null ? "" : String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",");
}

/* ---------- file → compressed dataURL (for photos / uploaded docs) ---------- */
export function fileToDataURL(file, maxDim = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result); // non-image (e.g. PDF) → keep raw
      img.onload = () => {
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- shrink an existing image dataURL (for emailable reports) ----------
   Re-encodes a stored photo down to maxDim / quality so a photo-heavy PDF stays
   small enough to email. Non-destructive: the caller keeps the original src and
   uses the returned value only for display/print. Non-raster or already-tiny
   inputs come back unchanged. */
export function shrinkDataURL(src, maxDim = 1100, quality = 0.6) {
  return new Promise((resolve) => {
    if (!src || !/^data:image\//.test(src)) return resolve(src);
    const img = new Image();
    img.onerror = () => resolve(src);
    img.onload = () => {
      let { width, height } = img;
      const s = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * s); height = Math.round(height * s);
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      c.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.src = src;
  });
}

/* ============================================================
   Signature pad — draw on canvas, returns PNG dataURL.
   Mounts into a container; supports clear + restore from value.
   ============================================================ */
export function signaturePad(initial, onChange) {
  const wrap = h("div", { class: "sigpad" });
  const canvas = h("canvas");
  const line = h("div", { class: "sigpad__line" });
  const hint = h("div", { class: "sigpad__hint" }, "Sign with finger or stylus");
  wrap.append(canvas, line, hint);

  let drawing = false, dirty = !!initial, last = null;
  const ctx = canvas.getContext("2d");

  function size() {
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 300;
    canvas.width = w * ratio; canvas.height = 180 * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#10233f";
    if (initial) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, 180);
      img.src = initial;
      hint.style.display = "none";
    }
  }
  // size after insertion into DOM
  requestAnimationFrame(size);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = (e) => { e.preventDefault(); drawing = true; dirty = true; hint.style.display = "none"; last = pos(e); };
  const move = (e) => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  };
  const end = () => { if (!drawing) return; drawing = false; onChange && onChange(canvas.toDataURL("image/png")); };

  canvas.addEventListener("pointerdown", start);
  canvas.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);

  return {
    el: wrap,
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; initial = null; hint.style.display = "flex"; onChange && onChange(""); },
    isEmpty: () => !dirty,
    dataURL: () => (dirty ? canvas.toDataURL("image/png") : ""),
  };
}

/* ============================================================
   Sketch pad — freehand drawing for the Moisture Map affected-area
   diagram, over an optional imported floor-plan background. A
   "number" stamp mode drops incrementing markers at the moisture-
   reading locations. Background and strokes are kept on separate
   layers; export flattens them for printing.
   ============================================================ */
export function sketchPad({ strokes = null, background = null, markerStart = 1, onChange } = {}) {
  const wrap = h("div", { class: "sketch" });
  const bgImg = h("img", { class: "sketch__bg", alt: "" });
  const canvas = h("canvas");
  const hint = h("div", { class: "sketch__hint app-only" }, "✋ Scroll mode — tap a color to draw");
  wrap.append(bgImg, canvas, hint);
  const ctx = canvas.getContext("2d");
  // Start in "off" (scroll) mode so a finger scrolling past the map never draws
  // on it — the tech must tap a color (or Number) to arm a tool first.
  let pen = "#10233f", mode = "off", nextNum = markerStart || 1, drawing = false, last = null;

  function showBg() {
    if (background) { bgImg.src = background; bgImg.style.display = "block"; }
    else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; }
  }
  let curH = 320, curW = 320;   // current canvas display size (px); curH tracks the floor-plan aspect
  function size() {
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 320;
    curW = w;
    // Lock the canvas to the floor plan's aspect ratio: the plan then fills it
    // UNDISTORTED and the markers stay aligned in any orientation. No plan -> 320.
    const planAR = (background && bgImg.naturalWidth && bgImg.naturalHeight) ? bgImg.naturalWidth / bgImg.naturalHeight : 0;
    curH = planAR ? Math.max(140, Math.round(w / planAR)) : 320;
    canvas.width = w * ratio; canvas.height = curH * ratio;
    // Size by aspect-ratio, not a fixed px height, so the canvas keeps the
    // plan's proportions at ANY display width — including print (where the page
    // width differs from the screen). A fixed height warped the markers on PDF.
    canvas.style.aspectRatio = w + " / " + curH;
    canvas.style.height = "auto";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (strokes) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, curH);
      img.src = strokes;
    }
  }
  bgImg.addEventListener("load", size);   // re-fit the canvas when the floor plan loads/changes
  showBg();
  requestAnimationFrame(size);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const strokesData = () => canvas.toDataURL("image/png");
  function drawContain(o, img, W, H) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const s = Math.min(W / iw, H / ih);
    const dw = iw * s, dh = ih * s;
    o.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  /* flatten background + strokes into one image for print/thumbnail */
  function composite() {
    const W = canvas.width, H = canvas.height;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const o = out.getContext("2d");
    o.fillStyle = "#ffffff"; o.fillRect(0, 0, W, H);
    // fill (stretch), matching .sketch__bg object-fit:fill, so markers stay aligned
    if (background && bgImg.complete && bgImg.naturalWidth) o.drawImage(bgImg, 0, 0, W, H);
    o.drawImage(canvas, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  }
  const emit = () => onChange && onChange({ strokes: strokesData(), background, composite: composite(), markerNext: nextNum });

  /* Undo: the strokes layer is raster, so snapshot it before each stroke/stamp
     and pop+restore on undo. Snapshots are sparse PNGs (small); cap the depth. */
  const history = [];
  const snapshot = () => { history.push({ url: canvas.toDataURL("image/png"), num: nextNum }); if (history.length > 30) history.shift(); };
  function undo() {
    const prev = history.pop();
    if (!prev) return;                       // nothing to undo this session
    nextNum = prev.num;
    const img = new Image();
    img.onload = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, curW, curH); emit(); };
    img.src = prev.url;
  }

  function stamp(p) {
    snapshot();
    ctx.fillStyle = "#f26a21"; ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(nextNum++), p.x, p.y);
    ctx.lineWidth = 2.6; ctx.strokeStyle = pen;
    emit();
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (mode === "off") return;   // scroll mode: let the page scroll, never draw
    e.preventDefault();
    if (mode === "number") return stamp(pos(e));
    snapshot();
    drawing = true; last = pos(e); ctx.strokeStyle = pen;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  window.addEventListener("pointerup", () => { if (drawing) { drawing = false; emit(); } });

  const swatches = [];
  const swatch = (color) => {
    const s = h("button", { type: "button", class: "swatch" + (color === pen ? " active" : ""), style: `background:${color}`, dataset: { color } });
    s.addEventListener("click", () => { pen = color; mode = "draw"; refresh(); });
    swatches.push(s);
    return s;
  };
  function refresh() {
    swatches.forEach((s) => s.classList.toggle("active", s.dataset.color === pen && mode === "draw"));
    numBtn.classList.toggle("active", mode === "number");
    numBtn.style.background = mode === "number" ? "var(--orange)" : "#fff";
    numBtn.style.color = mode === "number" ? "#fff" : "var(--navy)";
    const off = mode === "off";
    moveBtn.classList.toggle("active", off);
    moveBtn.style.background = off ? "var(--orange)" : "#fff";
    moveBtn.style.color = off ? "#fff" : "var(--navy)";
    // Only capture touch (block page scroll) while a draw/stamp tool is armed.
    wrap.style.touchAction = off ? "pan-y" : "none";
    canvas.style.touchAction = off ? "pan-y" : "none";
    hint.style.display = off ? "block" : "none";
  }
  const moveBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Scroll the page without drawing" }, "✋ Move");
  moveBtn.addEventListener("click", () => { mode = "off"; refresh(); });
  const numBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "①  Number");
  numBtn.addEventListener("click", () => { mode = mode === "number" ? "off" : "number"; refresh(); });
  const clearBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↺ Clear drawing");
  clearBtn.addEventListener("click", () => { history.length = 0; nextNum = 1; ctx.clearRect(0, 0, canvas.width, canvas.height); emit(); });
  const undoBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↩ Undo");
  undoBtn.addEventListener("click", undo);

  const toolsEl = h("div", { class: "sketch__tools app-only" },
    moveBtn, swatch("#10233f"), swatch("#f26a21"), swatch("#d23b2e"), swatch("#1f9d55"), numBtn, undoBtn, clearBtn);
  refresh();   // apply the initial "off" state (scroll enabled, hint shown, no tool active)

  return {
    tools: toolsEl, el: wrap, composite, hasBackground: () => !!background,
    setBackground(url) {
      background = url || null;
      if (background) { bgImg.onload = () => emit(); bgImg.src = background; bgImg.style.display = "block"; }  // 'load' listener also re-fits via size()
      else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; size(); emit(); }
    },
  };
}

/* ============================================================
   Equipment-placement pad — drop directional equipment icons on the
   Moisture Map's floor plan (air mover / dehumidifier / air scrubber /
   heater), then move, rotate, and delete them. Icons are objects
   ({type,x,y,angle}, x/y normalized 0–1) so they stay editable; the
   canvas prints as-is in the packet.
   ============================================================ */
export const EQUIP_TYPES = [
  { key: "air_mover", label: "Air mover" },
  { key: "lgr_dehumidifier", label: "Dehumidifier" },
  { key: "air_scrubber", label: "Air scrubber" },
  { key: "heater", label: "Heater" },
];
const EQUIP_STYLE = {
  air_mover:        { color: "#0f1b2d", label: "AM",   dir: true  },
  lgr_dehumidifier: { color: "#1f6feb", label: "LGR",  dir: false },
  air_scrubber:     { color: "#0f9d8f", label: "HEPA", dir: false },
  heater:           { color: "#e0552b", label: "HT",   dir: false },
};

/* pure helpers (unit-tested) */
export const stepAngle = (a, d) => ((((Number(a) || 0) + d) % 360) + 360) % 360;
export const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
/* nearest placed item to a pixel point, within `radius` px, else null */
export function nearestEquip(items, px, py, W, H, radius = 26) {
  let best = null, bestD = radius * radius;
  for (const it of items || []) {
    const dx = it.x * W - px, dy = it.y * H - py, d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = it; }
  }
  return best;
}

function rrect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawEquip(ctx, type, cx, cy, angleDeg, s, selected) {
  const st = EQUIP_STYLE[type] || EQUIP_STYLE.air_mover;
  ctx.save();
  ctx.translate(cx, cy);
  if (selected) {
    ctx.strokeStyle = "#f26a21"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(0, 0, s + 8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.rotate((angleDeg * Math.PI) / 180);
  // direction arrow points "up" (the way it faces / blows) at angle 0
  ctx.fillStyle = st.dir ? "#f26a21" : "rgba(15,27,45,0.4)";
  ctx.beginPath(); ctx.moveTo(0, -s - 10); ctx.lineTo(-7, -s - 1); ctx.lineTo(7, -s - 1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = st.color; rrect(ctx, -s, -s, s * 2, s * 2, 5); ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#fff"; ctx.font = `bold ${Math.max(9, Math.round(s * 0.78))}px sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(st.label, cx, cy);
}

export function equipmentPad({ items = [], background = null, onChange } = {}) {
  const wrap = h("div", { class: "sketch" });
  const bgImg = h("img", { class: "sketch__bg", alt: "" });
  const canvas = h("canvas");
  wrap.append(bgImg, canvas);
  const ctx = canvas.getContext("2d");
  const ICON = 16;   // icon half-size (px) — sized to stay legible on the enlarged printed map
  let list = (items || []).map((it) => ({ id: it.id || uid(), type: it.type, x: clamp01(it.x), y: clamp01(it.y), angle: Number(it.angle) || 0 }));
  let armed = null, selected = null, dragging = false, W = 320, H = 320;

  function showBg() {
    if (background) { bgImg.src = background; bgImg.style.display = "block"; }
    else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; }
  }
  function size() {
    const ratio = window.devicePixelRatio || 1;
    W = wrap.clientWidth || 320;
    // Match the floor plan's aspect ratio (shared with the moisture sketch) so
    // icons stay aligned + undistorted across orientations. No plan -> 320.
    const planAR = (background && bgImg.naturalWidth && bgImg.naturalHeight) ? bgImg.naturalWidth / bgImg.naturalHeight : 0;
    H = planAR ? Math.max(140, Math.round(W / planAR)) : 320;
    canvas.width = W * ratio; canvas.height = H * ratio;
    // Aspect-ratio sizing (see sketchPad): keeps equipment icons undistorted at
    // any width, so they don't stretch on the printed PDF.
    canvas.style.aspectRatio = W + " / " + H;
    canvas.style.height = "auto";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const it of list) drawEquip(ctx, it.type, it.x * W, it.y * H, it.angle, ICON, it.id === selected);
  }
  bgImg.addEventListener("load", size);   // re-fit when the shared floor plan loads/changes
  showBg();
  requestAnimationFrame(size);

  const pos = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
  function composite() {
    const Wd = canvas.width, Hd = canvas.height;
    const out = document.createElement("canvas"); out.width = Wd; out.height = Hd;
    const o = out.getContext("2d");
    o.fillStyle = "#fff"; o.fillRect(0, 0, Wd, Hd);
    // fill (stretch), matching .sketch__bg object-fit:fill, so icons stay aligned
    if (background && bgImg.complete && bgImg.naturalWidth) o.drawImage(bgImg, 0, 0, Wd, Hd);
    o.drawImage(canvas, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  }
  const stripped = () => list.map(({ id, type, x, y, angle }) => ({ id, type, x, y, angle }));
  const emit = () => onChange && onChange({ items: stripped(), composite: composite() });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = pos(e);
    if (armed) { const it = { id: uid(), type: armed, x: clamp01(p.x / W), y: clamp01(p.y / H), angle: 0 }; list.push(it); selected = it.id; redraw(); emit(); return; }
    const hit = nearestEquip(list, p.x, p.y, W, H, ICON + 10);
    selected = hit ? hit.id : null;
    dragging = !!hit;
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || !selected) return; e.preventDefault();
    const p = pos(e); const it = list.find((x) => x.id === selected);
    if (it) { it.x = clamp01(p.x / W); it.y = clamp01(p.y / H); redraw(); }
  });
  window.addEventListener("pointerup", () => { if (dragging) { dragging = false; emit(); } });

  const selectedItem = () => list.find((x) => x.id === selected);
  function rotate(d) { const it = selectedItem(); if (!it) return; it.angle = stepAngle(it.angle, d); redraw(); emit(); }
  function del() { if (!selected) return; list = list.filter((x) => x.id !== selected); selected = null; redraw(); emit(); }
  function clear() { list = []; selected = null; armed = null; redraw(); emit(); refresh(); }

  const typeBtns = EQUIP_TYPES.map((t) => {
    const b = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, t.label);
    b.dataset.key = t.key;
    b.addEventListener("click", () => { armed = armed === t.key ? null : t.key; selected = null; refresh(); redraw(); });
    return b;
  });
  const rotL = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Rotate left" }, "↺");
  const rotR = h("button", { type: "button", class: "btn btn--ghost btn--sm", title: "Rotate right" }, "↻");
  const delB = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "✕ Remove");
  const clrB = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Clear all");
  rotL.addEventListener("click", () => rotate(-45));
  rotR.addEventListener("click", () => rotate(45));
  delB.addEventListener("click", del);
  clrB.addEventListener("click", clear);
  function refresh() {
    typeBtns.forEach((b) => {
      const on = b.dataset.key === armed;
      b.style.background = on ? "var(--orange,#f26a21)" : "";
      b.style.color = on ? "#fff" : "";
    });
  }
  refresh();
  const toolsEl = h("div", { class: "sketch__tools app-only" }, ...typeBtns, rotL, rotR, delB, clrB);

  return {
    el: wrap, tools: toolsEl, composite,
    counts: () => list.reduce((m, it) => ((m[it.type] = (m[it.type] || 0) + 1), m), {}),
    setBackground(url) {
      background = url || null;
      if (background) { bgImg.onload = () => emit(); bgImg.src = background; bgImg.style.display = "block"; }  // 'load' listener re-fits via size()
      else { bgImg.removeAttribute("src"); bgImg.style.display = "none"; size(); emit(); }
    },
  };
}

/* ============================================================
   Psychrometrics — grains per pound (GPP) of moisture per pound
   of dry air, from dry-bulb temp (°F) and relative humidity (%).
   Uses standard sat-vapor-pressure approximation; field-grade.
   ============================================================ */
export function gpp(tempF, rh) {
  const t = Number(tempF), r = Number(rh);
  if (!isFinite(t) || !isFinite(r) || r < 0) return null;
  const tc = (t - 32) * 5 / 9;                         // °C
  // Saturation vapor pressure (hPa) — Magnus formula
  const es = 6.1078 * Math.pow(10, (7.5 * tc) / (237.3 + tc));
  const e = es * (r / 100);                            // actual vapor pressure (hPa)
  const p = 1013.25;                                   // sea-level atmospheric (hPa)
  const w = 0.62198 * e / (p - e);                     // humidity ratio (lb/lb)
  return Math.round(w * 7000);                         // grains per pound
}
/* grain depression = unaffected GPP − affected GPP */
export function grainDepression(unaffectedGpp, affectedGpp) {
  if (unaffectedGpp == null || affectedGpp == null) return null;
  return unaffectedGpp - affectedGpp;
}

/* ---------- IICRC S500 dry standards ---------- */
/* goal = numeric MC% threshold a reading must be at or below to be "dry" */
export const DRY_STANDARDS = [
  { material: "Drywall / Gypsum", goal: 1 },
  { material: "Plaster", goal: 1.5 },
  { material: "Concrete / Slab", goal: 4 },
  { material: "Hardwood Flooring", goal: 12 },
  { material: "Carpet / Pad", goal: 15 },
  { material: "Framing / Wood / Subfloor", goal: 19 },
  { material: "OSB / Particle Board", goal: 16 },
  { material: "Other / Generic", goal: 16 },
];
export const goalFor = (material) => DRY_STANDARDS.find((d) => d.material === material)?.goal ?? null;

/* ---------- date helpers ---------- */
export function daysSince(iso) {
  if (!iso) return null;
  const start = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(start)) return null;
  return Math.floor((Date.now() - start.getTime()) / 86400000);
}
export function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso), b = new Date(bIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round(Math.abs(b - a) / 86400000);
}
