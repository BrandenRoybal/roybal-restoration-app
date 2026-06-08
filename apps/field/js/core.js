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

/* ---------- IndexedDB store (single "projects" object store) ---------- */
const DB_NAME = "roybal-field";
const STORE = "projects";
let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(mode) { return db().then((d) => d.transaction(STORE, mode).objectStore(STORE)); }

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
  async put(project) {
    project.updatedAt = new Date().toISOString();
    const os = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = os.put(project);
      r.onsuccess = () => res(project);
      r.onerror = () => rej(r.error);
    });
  },
  async del(id) {
    const os = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = os.delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
};

/* ---------- debounced autosave with a visual "Saved" pulse ---------- */
let saveTimer;
export function autosave(project, pill) {
  clearTimeout(saveTimer);
  if (pill) { pill.textContent = "Saving…"; pill.style.color = "var(--muted)"; }
  saveTimer = setTimeout(async () => {
    await Store.put(project);
    if (pill) { pill.textContent = "✓ Saved"; pill.style.color = "var(--green)"; }
  }, 350);
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
   diagram, plus a "number" stamp mode that drops incrementing
   numbered markers at the moisture-reading locations.
   ============================================================ */
export function sketchPad(initial, onChange) {
  const wrap = h("div", { class: "sketch" });
  const canvas = h("canvas");
  wrap.append(canvas);
  const ctx = canvas.getContext("2d");
  let pen = "#10233f", mode = "draw", nextNum = 1, drawing = false, last = null;
  let backing = initial || null;            // last committed image (for stamps/redraw)

  function size() {
    const ratio = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 320;
    canvas.width = w * ratio; canvas.height = 320 * ratio;
    canvas.style.height = "320px";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    redraw();
  }
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (backing) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, wrap.clientWidth, 320);
      img.src = backing;
    }
  }
  requestAnimationFrame(size);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  function commitBacking() { backing = canvas.toDataURL("image/png"); onChange && onChange(backing); }
  function stamp(p) {
    ctx.fillStyle = "#f26a21"; ctx.strokeStyle = "#fff";
    ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(nextNum++), p.x, p.y);
    ctx.lineWidth = 2.6; ctx.strokeStyle = pen;
    commitBacking();
  }
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (mode === "number") return stamp(pos(e));
    drawing = true; last = pos(e); ctx.strokeStyle = pen;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  window.addEventListener("pointerup", () => { if (drawing) { drawing = false; commitBacking(); } });

  const swatches = [];
  const swatch = (color) => {
    const s = h("button", { type: "button", class: "swatch" + (color === pen ? " active" : ""), style: `background:${color}`, dataset: { color } });
    s.addEventListener("click", () => { pen = color; mode = "draw"; refresh(); });
    swatches.push(s);
    return s;
  };
  let toolsEl;
  function refresh() {
    swatches.forEach((s) => s.classList.toggle("active", s.dataset.color === pen && mode === "draw"));
    numBtn.classList.toggle("active", mode === "number");
    numBtn.style.background = mode === "number" ? "var(--orange)" : "#fff";
    numBtn.style.color = mode === "number" ? "#fff" : "var(--navy)";
  }
  const numBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "①  Number");
  numBtn.addEventListener("click", () => { mode = mode === "number" ? "draw" : "number"; refresh(); });
  const undoBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "↺ Clear");
  undoBtn.addEventListener("click", () => { backing = null; nextNum = 1; ctx.clearRect(0, 0, canvas.width, canvas.height); commitBacking(); });

  toolsEl = h("div", { class: "sketch__tools app-only" },
    swatch("#10233f"), swatch("#f26a21"), swatch("#d23b2e"), swatch("#1f9d55"),
    numBtn, undoBtn);

  return { tools: toolsEl, el: wrap, dataURL: () => backing };
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

/* ---------- IICRC S500 dry standards (reference helper) ---------- */
export const DRY_STANDARDS = [
  { material: "Drywall / Gypsum", goal: "≤ 1%" },
  { material: "Framing / Wood / Subfloor", goal: "≤ 19%" },
  { material: "Hardwood Flooring", goal: "≤ 12%" },
  { material: "Concrete / Slab", goal: "≤ 4%" },
  { material: "Plaster", goal: "≤ 1.5%" },
];
