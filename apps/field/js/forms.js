/* ============================================================
   Roybal Field Forms — the 7 form renderers
   Each returns a printable .sheet built from bound inputs.
   ============================================================ */
import { h, sketchPad, equipmentPad, EQUIP_TYPES, gpp, grainDepression, money, toast, fmtDate, todayISO, fileToDataURL, DRY_STANDARDS, goalFor, daysSince, daysBetween } from "./core.js";
import { fileToFloorPlan } from "./pdf.js";
import {
  field, inp, ta, sel, seg, check, sigBlock, signOrUpload, photoUploader,
  lineItems, sheet, sheetFooter, commit,
} from "./formkit.js";
import {
  SCOPE_ITEMS, CHANGE_REASONS, newPhoto, dispositionLabel, depreciation,
  blankReadingRow, blankPsychroRow, blankEquipRow, blankWorkRow,
  blankLineItem, blankVerifyRow, COMPANY,
} from "./model.js";
import { narrativeFacts, narrativeInfoRows } from "./narrative.js";
import { pickJobcode, pullDay as qbPullDay, entriesFor as qbEntriesFor, qbConfigured } from "./qbtime.js";

/* ---------- shared job-context fields (bound to the project) ---------- */
function jobInfo(project, fields) {
  const map = {
    customer: ["Customer", { }],
    address: ["Job Address", {}],
    claimNo: ["Claim #", {}],
    dateOfLoss: ["Date of Loss", { type: "date" }],
    carrier: ["Carrier", {}],
    adjuster: ["Adjuster", {}],
    phone: ["Phone", { type: "tel" }],
    email: ["Email", { type: "email" }],
    workOrderNo: ["Work Order #", {}],
  };
  return h("div", { class: "grid2 jobinfo" },
    ...fields.map((f) => field(map[f][0], inp(project, f, map[f][1]))));
}

function sectionTitle(t) { return h("h2", {}, t); }

/* ---------- Moisture drying-trend line graph (pure SVG) ---------- */
const CHART_PALETTE = ["#0f1b2d", "#f26a21", "#1f9d55", "#d23b2e", "#1c5fb0", "#8e44ad",
  "#e0a800", "#16a085", "#c0392b", "#2c3e50", "#d35400", "#27ae60", "#7f8c8d"];
function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return isNaN(d) ? iso : (d.getMonth() + 1) + "/" + d.getDate();
}
function moistureChartSvg(m, goal) {
  const rows = m.readings || [];
  const W = 620, H = 300, padL = 40, padR = 14, padT = 14, padB = 42;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let yMax = 0, any = false;
  rows.forEach((r) => (r.values || []).forEach((v) => { const n = parseFloat(v); if (isFinite(n)) { any = true; if (n > yMax) yMax = n; } }));
  if (goal && goal > yMax) yMax = goal;
  if (!any) return '<div class="chart-empty">Enter MC% readings above to see the drying trend.</div>';
  yMax = Math.max(5, Math.ceil((yMax * 1.1) / 5) * 5);
  const N = rows.length;
  const xOf = (i) => padL + (N <= 1 ? plotW / 2 : (i / (N - 1)) * plotW);
  const yOf = (v) => padT + plotH - (v / yMax) * plotH;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="mchart" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`;
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = (yMax * t) / ticks, y = yOf(val);
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0"/>`;
    s += `<text x="${padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#5b6b80">${Math.round(val)}</text>`;
  }
  s += `<text x="11" y="${padT + plotH / 2}" font-size="9" fill="#5b6b80" transform="rotate(-90 13 ${padT + plotH / 2})">MC%</text>`;
  const step = Math.max(1, Math.ceil(N / 8));
  rows.forEach((r, i) => {
    if (!(N <= 8 || i % step === 0 || i === N - 1)) return;
    s += `<text x="${xOf(i).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle" font-size="9" fill="#5b6b80">${shortDate(r.date) || "#" + (i + 1)}</text>`;
  });
  if (goal) {
    const y = yOf(goal);
    s += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#1f9d55" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    s += `<text x="${W - padR}" y="${(y - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#1f9d55">Dry goal ${goal}%</text>`;
  }
  let legend = "";
  for (let n = 0; n < 13; n++) {
    const pts = [];
    rows.forEach((r, i) => { const v = parseFloat((r.values || [])[n]); if (isFinite(v)) pts.push([xOf(i), yOf(v)]); });
    if (!pts.length) continue;
    const col = CHART_PALETTE[n % CHART_PALETTE.length];
    if (pts.length > 1) s += `<path d="${pts.map((p, k) => (k ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ")}" fill="none" stroke="${col}" stroke-width="2"/>`;
    pts.forEach((p) => (s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6" fill="${col}"/>`));
    legend += `<span class="mchart__leg"><i style="background:${col}"></i>${n + 1}</span>`;
  }
  s += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#9aa7b8"/>`;
  s += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#9aa7b8"/></svg>`;
  return s + `<div class="mchart__legend"><span class="mchart__leglbl">Reading location:</span>${legend}</div>`;
}

/* Crop & zoom an imported floor-plan image/PDF page. Opens a modal where you
   pan (drag / one-finger) and zoom (slider, wheel, or two-finger pinch); on
   Apply it renders the visible region to a new image so it fills the sketch and
   prints clean. Resolves to a JPEG data URL, or null if cancelled. */
function cropZoom(srcUrl, aspect) {
  return new Promise((resolve) => {
    if (!srcUrl) return resolve(null);
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const ar = aspect && aspect > 0 ? aspect : (iw / ih || 1.5);
      let frameW = Math.min(window.innerWidth - 32, 680);
      let frameH = Math.round(frameW / ar);
      const maxH = window.innerHeight - 230;
      if (frameH > maxH) { frameH = maxH; frameW = Math.round(frameH * ar); }

      const dpr = window.devicePixelRatio || 1;
      const cv = h("canvas", { class: "cropcanvas" });
      cv.width = Math.round(frameW * dpr); cv.height = Math.round(frameH * dpr);
      cv.style.width = frameW + "px"; cv.style.height = frameH + "px";
      const cx = cv.getContext("2d");

      const base = Math.min(frameW / iw, frameH / ih);   // zoom 1 = whole image fits (100%)
      let zoom = 1, scale = base;
      let offX = (frameW - iw * scale) / 2, offY = (frameH - ih * scale) / 2;
      function clamp() {
        const w = iw * scale, hh = ih * scale;
        offX = w >= frameW ? Math.min(0, Math.max(frameW - w, offX)) : (frameW - w) / 2;
        offY = hh >= frameH ? Math.min(0, Math.max(frameH - hh, offY)) : (frameH - hh) / 2;
      }
      function draw() {
        cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, frameW, frameH);
        cx.drawImage(img, offX, offY, iw * scale, ih * scale);
      }
      function setZoom(z, px, py) {
        const nz = Math.max(1, Math.min(8, z)), ns = base * nz;
        const ix = (px - offX) / scale, iy = (py - offY) / scale;
        zoom = nz; scale = ns; offX = px - ix * ns; offY = py - iy * ns;
        clamp(); draw(); zslider.value = String(zoom);
      }

      const pts = new Map(); let dragging = false, lx = 0, ly = 0, pinch = null;
      cv.addEventListener("pointerdown", (e) => {
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { cv.setPointerCapture(e.pointerId); } catch {}
        if (pts.size === 1) { dragging = true; lx = e.clientX; ly = e.clientY; } else dragging = false;
      });
      cv.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return; e.preventDefault();
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const a = [...pts.values()];
        if (a.length >= 2) {
          const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
          const r = cv.getBoundingClientRect();
          const mx = (a[0].x + a[1].x) / 2 - r.left, my = (a[0].y + a[1].y) / 2 - r.top;
          if (!pinch) pinch = { dist, zoom };
          else setZoom(pinch.zoom * (dist / pinch.dist), mx, my);
        } else if (dragging) { offX += e.clientX - lx; offY += e.clientY - ly; lx = e.clientX; ly = e.clientY; clamp(); draw(); }
      });
      const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) dragging = false; };
      cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
      cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - r.left, e.clientY - r.top); }, { passive: false });

      const zout = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "－");
      const zin = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "＋");
      const zslider = h("input", { type: "range", min: "1", max: "8", step: "0.05", value: "1", style: "flex:1" });
      zout.addEventListener("click", () => setZoom(zoom / 1.25, frameW / 2, frameH / 2));
      zin.addEventListener("click", () => setZoom(zoom * 1.25, frameW / 2, frameH / 2));
      zslider.addEventListener("input", () => setZoom(Number(zslider.value), frameW / 2, frameH / 2));

      const close = (val) => { ov.remove(); resolve(val); };
      const cancel = h("button", { type: "button", class: "btn btn--ghost" }, "Cancel");
      const apply = h("button", { type: "button", class: "btn btn--primary" }, "Apply");
      cancel.addEventListener("click", () => close(null));
      apply.addEventListener("click", () => {
        const OUT_H = 760, k = OUT_H / frameH;
        const out = document.createElement("canvas");
        out.width = Math.round(frameW * k); out.height = Math.round(frameH * k);
        const o = out.getContext("2d");
        o.fillStyle = "#fff"; o.fillRect(0, 0, out.width, out.height);
        o.drawImage(img, offX * k, offY * k, iw * scale * k, ih * scale * k);
        close(out.toDataURL("image/jpeg", 0.85));
      });

      const ov = h("div", { class: "cropov" },
        h("div", { class: "cropbox" },
          h("div", { class: "crophdr" }, h("strong", {}, "Crop & zoom"), h("span", { class: "subtle" }, "Drag to move · scroll, pinch, or slider to zoom")),
          h("div", { class: "cropframe", style: `width:${frameW}px;height:${frameH}px` }, cv),
          h("div", { class: "cropzoom" }, zout, zslider, zin),
          h("div", { class: "cropfoot" }, cancel, apply)));
      document.body.append(ov);
      draw();
    };
    img.src = srcUrl;
  });
}

/* ============================================================
   1. MOISTURE MAP
   ============================================================ */
export function moistureMap(project, m) {
  const pad = sketchPad({
    strokes: m.strokes, background: m.floorPlan, markerStart: m.markerNext || 1,
    onChange: ({ strokes, background, composite, markerNext }) => {
      m.strokes = strokes; m.floorPlan = background || ""; m.sketch = composite; m.markerNext = markerNext;
      commit();
    },
  });

  /* Equipment-placement diagram — shares the same imported floor plan as the
     moisture sketch; air movers/dehus/scrubbers/heaters you can place + aim. */
  const equipPad = equipmentPad({
    items: m.equipmentPlan || [], background: m.floorPlan,
    onChange: ({ items, composite }) => {
      m.equipmentPlan = items; m.equipmentPlanImg = composite; renderEquipCount(); commit();
    },
  });
  const equipCountEl = h("div", { class: "subtle app-only", style: "margin-top:6px;font-size:13px" });
  function renderEquipCount() {
    const c = equipPad.counts();
    const parts = EQUIP_TYPES.map((t) => (c[t.key] ? `${c[t.key]} ${t.label}${c[t.key] > 1 ? "s" : ""}` : null)).filter(Boolean);
    equipCountEl.textContent = parts.length ? "Placed: " + parts.join(" · ") : "No equipment placed yet.";
  }
  renderEquipCount();

  /* dry goal (numeric) for the trend line + red/green flagging.
     The Dry Goal (MC%) input is the source of truth; the material's
     IICRC standard is only a fallback when that box is empty. */
  const goalNum = () => {
    const p = parseFloat(String(m.dryGoal || "").replace(/[^0-9.]/g, ""));
    if (!isNaN(p)) return p;
    const g = goalFor(m.material);
    return g != null ? g : null;
  };
  function flagCell(input) {
    const goal = goalNum(), v = parseFloat(input.value);
    input.classList.remove("dry", "wet");
    if (goal != null && input.value !== "" && !isNaN(v)) input.classList.add(v <= goal ? "dry" : "wet");
  }
  function reflagAll() { tbody.querySelectorAll("input.mc").forEach(flagCell); }

  /* drying-trend chart */
  const chartBox = h("div", { class: "mchart-wrap" });
  function redrawChart() { chartBox.innerHTML = moistureChartSvg(m, goalNum()); }
  setTimeout(redrawChart, 0);   // initial render once mounted

  /* reading grid */
  const tbody = h("tbody");
  function rowEl(row, i) {
    const tr = h("tr");
    const dateCell = h("td");
    const dateInput = h("input", { type: "date", value: row.date, style: "min-width:120px" });
    dateInput.addEventListener("input", () => { row.date = dateInput.value; redrawChart(); commit(); });
    dateCell.append(dateInput);
    tr.append(dateCell);
    for (let n = 0; n < 13; n++) {
      const c = h("td");
      const input = h("input", { class: "mc", value: row.values[n] ?? "", inputmode: "decimal", style: "min-width:42px" });
      input.addEventListener("input", () => { row.values[n] = input.value; flagCell(input); redrawChart(); commit(); });
      flagCell(input);
      c.append(input); tr.append(c);
    }
    const noteCell = h("td");
    const noteInput = h("input", { value: row.notes ?? "", style: "min-width:120px" });
    noteInput.addEventListener("input", () => { row.notes = noteInput.value; commit(); });
    noteCell.append(noteInput); tr.append(noteCell);
    tr.append(h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { m.readings.splice(i, 1); paintRows(); redrawChart(); commit(); } }, "✕")));
    return tr;
  }
  function paintRows() { tbody.replaceChildren(...m.readings.map(rowEl)); }
  paintRows();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add reading date");
  addRow.addEventListener("click", () => { m.readings.push(blankReadingRow()); paintRows(); redrawChart(); commit(); });

  /* material picker auto-fills the dry goal */
  const dryGoalInput = inp(m, "dryGoal", { placeholder: "≤ 16%", oninput: () => { reflagAll(); redrawChart(); } });
  const materialSel = sel(m, "material",
    DRY_STANDARDS.map((d) => ({ value: d.material, label: `${d.material} (≤ ${d.goal}%)` })),
    { placeholder: "Select material…", onchange: (v) => {
        const g = goalFor(v);
        if (g != null) { m.dryGoal = `≤ ${g}%`; dryGoalInput.value = m.dryGoal; }
        reflagAll(); redrawChart();
      } });

  /* floor-plan import (PDF or image) */
  const fpInput = h("input", { type: "file", accept: "image/*,application/pdf", style: "display:none" });
  fpInput.addEventListener("change", async () => {
    const f = fpInput.files[0]; if (!f) return;
    toast("Importing floor plan…", 6000);
    try {
      const url = await fileToFloorPlan(f);
      const cropped = await cropZoom(url);   // keep the plan's natural aspect; the canvas locks to it
      pad.setBackground(cropped || url);
      equipPad.setBackground(cropped || url);
      toast("Floor plan added — draw on top");
    } catch { toast("Sorry — couldn't read that file"); }
    fpInput.value = ""; renderFp();
  });
  const fpBox = h("div", { class: "app-only", style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px" });
  function renderFp() {
    fpBox.replaceChildren(fpInput);
    const importBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" },
      pad.hasBackground() ? "🔄 Replace floor plan" : "📄 Import floor plan (PDF / image)");
    importBtn.addEventListener("click", () => fpInput.click());
    fpBox.append(importBtn);
    if (pad.hasBackground()) {
      const cropBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "✂️ Crop / zoom");
      cropBtn.addEventListener("click", async () => {
        const c = await cropZoom(m.floorPlan);   // natural aspect; the canvas locks to it
        if (c) { pad.setBackground(c); equipPad.setBackground(c); renderFp(); }
      });
      const rm = h("button", { type: "button", class: "btn btn--danger btn--sm" }, "Remove plan");
      rm.addEventListener("click", () => { pad.setBackground(null); equipPad.setBackground(null); renderFp(); });
      fpBox.append(cropBtn, rm);
    }
  }
  renderFp();

  const headCols = ["Date"];
  for (let n = 1; n <= 13; n++) headCols.push(String(n));
  headCols.push("Notes");

  return sheet("MOISTURE MAP", "Water Mitigation Field Documentation — Per IICRC S500 Protocol", "Moisture Map Field Template",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "grid2" },
      field("Technician", inp(m, "technician")),
      field("Ambient Temp / RH", inp(m, "ambientTemp", { placeholder: "e.g. 72°F / 45%" }))),
    h("div", { class: "grid2" },
      field("Equipment on Site", inp(m, "equipmentOnSite", { placeholder: "e.g. 2 dehu, 6 AM" })),
      field("Page (of)", h("div", { class: "grid2" }, inp(m, "page", { placeholder: "Page" }), inp(m, "pageOf", { placeholder: "of" })))),

    sectionTitle("Affected Area"),
    h("p", { class: "subtle app-only" }, "Import a floor plan (or draw freehand), then tap “① Number” and place a numbered marker at each moisture-reading location."),
    h("div", { class: "grid2" },
      field("Material", materialSel),
      field("Dry Goal (MC%)", dryGoalInput)),
    field("Meter / Setting", inp(m, "meter", { placeholder: "Pin / non-pin, scale" })),
    fpBox,
    pad.tools, pad.el,
    h("details", { class: "app-only", style: "margin-top:10px" },
      h("summary", { class: "linklike" }, "Or attach photos of the area instead"),
      photoUploader(m.photos, "Add area photos")),

    sectionTitle("Equipment Placement"),
    h("p", { class: "subtle app-only" }, "Tap a tool, then tap the floor plan to drop it. Tap a placed unit to move it; use ↺ ↻ to aim it (air-mover direction)."),
    equipPad.tools, equipPad.el, equipCountEl,

    sectionTitle("Moisture Reading Locations (MC% or equivalent)"),
    h("p", { class: "flagnote app-only" }, "Cells flag ", h("span", { class: "dot g" }, "green = at/below dry goal"), " · ", h("span", { class: "dot r" }, "red = still wet"), " automatically."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...headCols.map((c) => h("th", {}, c)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,

    sectionTitle("Drying Trend"),
    h("p", { class: "subtle app-only" }, "MC% over time for each reading location — the line should fall toward the dry goal."),
    chartBox);
}

/* ============================================================
   2. DRYING LOG
   ============================================================ */
export function dryingLog(project, d) {
  /* drying-day counter: start → finish once a finish date is set, else start → today */
  const daysBanner = h("div", { class: "daysbig app-only", style: "margin-bottom:8px" });
  function renderBanner() {
    daysBanner.replaceChildren();
    const start = d.dryoutStart || project.dryStart || "";
    const finish = d.dryoutFinish || "";
    if (!start) return;
    if (finish && finish >= start) {
      const n = (daysBetween(start, finish) ?? 0) + 1;   // inclusive of start + finish day
      daysBanner.append("Drying complete — ", h("b", {}, n + " day" + (n === 1 ? "" : "s")), ` (${fmtDate(start)} → ${fmtDate(finish)})`);
    } else {
      const n = daysSince(start) + 1;
      if (n > 0) daysBanner.append("Drying ", h("b", {}, "Day " + n), " (started " + fmtDate(start) + ")");
    }
  }
  renderBanner();

  const warnBox = h("div", { class: "warn app-only", hidden: true });

  /* equipment deployment table */
  const eqBody = h("tbody");
  function refreshWarn() {
    const flagged = d.equipment.filter((r) => r.placed && !r.removed && (daysSince(r.placed) ?? 0) >= 7);
    if (flagged.length) {
      warnBox.hidden = false;
      warnBox.replaceChildren(h("strong", {}, "⚠ 7-day equipment check: "),
        `${flagged.length} unit(s) on site 7+ days. Confirm continued need / document justification for the carrier.`);
    } else { warnBox.hidden = true; }
  }
  /* increment the trailing number of an asset tag (e.g. "AM-09" → "AM-10"),
     preserving any prefix/suffix and zero-padding; plain copy if no number. */
  function bumpAsset(src, n) {
    const m = String(src).match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return src;
    return m[1] + String(Number(m[2]) + n).padStart(m[2].length, "0") + m[3];
  }
  /* Excel-style fill handle: drag the corner of a cell down to copy its value
     into the rows below (asset # auto-increments). Works with mouse + touch. */
  function attachFill(td, i, key) {
    const handle = h("span", { class: "fillh app-only", title: "Drag down to fill the rows below" });
    let active = false, rowsEls = [];
    const targetOf = (y) => { let t = i; for (let k = i + 1; k < rowsEls.length; k++) { if (y >= rowsEls[k].getBoundingClientRect().top + 4) t = k; } return t; };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      active = true; rowsEls = [...eqBody.children];
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!active) return; e.preventDefault();
      const t = targetOf(e.clientY);
      rowsEls.forEach((tr, idx) => tr.classList.toggle("fill-target", idx > i && idx <= t));
    });
    const finish = () => {
      if (!active) return; active = false;
      const targets = rowsEls.map((_, idx) => idx).filter((idx) => rowsEls[idx].classList.contains("fill-target"));
      rowsEls.forEach((tr) => tr.classList.remove("fill-target"));
      if (!targets.length) return;
      const src = d.equipment[i][key] ?? "";
      targets.forEach((idx, k) => {
        d.equipment[idx][key] = key === "asset" ? bumpAsset(src, k + 1) : src;
        if (key === "hours") d.equipment[idx]._manualHrs = true;
      });
      paintEq(); refreshWarn(); commit();
      toast(`Filled ${targets.length} row${targets.length > 1 ? "s" : ""}`);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    td.append(handle);
  }

  function eqRow(row, i) {
    const tr = h("tr");
    const daysCell = h("td", { class: "calc", style: "min-width:46px" });
    function recalcDays() {
      // auto total hours from placed→removed (unless manually set)
      if (row.placed && row.removed && !row._manualHrs) {
        const ph = (new Date(row.removed) - new Date(row.placed)) / 3600000;
        if (isFinite(ph) && ph >= 0) { row.hours = Math.round(ph); if (hoursInput) hoursInput.value = row.hours; }
      }
      // Days on site: placed→removed once removed, else days since placed.
      let days = null;
      if (row.placed && row.removed) days = Math.max(1, daysBetween(row.placed, row.removed) ?? 0);
      else if (row.placed) days = daysSince(row.placed);
      const ended = !row.removed && days != null && days >= 7;
      daysCell.textContent = days == null ? "" : days + "d";
      tr.classList.toggle("flag7", !!ended);
    }
    let hoursInput;
    const mk = (key, w, type = "text") => {
      const c = h("td", { class: "fillcell" });
      const input = h("input", { type, value: row[key] ?? "", style: `min-width:${w}`, step: type === "datetime-local" ? "60" : null });
      input.addEventListener("input", () => {
        row[key] = input.value;
        if (key === "hours") row._manualHrs = true;
        recalcDays(); refreshWarn(); commit();
      });
      if (key === "hours") hoursInput = input;
      c.append(input);
      attachFill(c, i, key);
      return c;
    };
    const assetC = mk("asset", "50px"), typeC = mk("type", "150px"), locC = mk("location", "110px");
    const placedC = mk("placed", "150px", "datetime-local"), removedC = mk("removed", "150px", "datetime-local");
    const hoursC = mk("hours", "56px", "number"), notesC = mk("notes", "120px");
    tr.append(assetC, typeC, locC, placedC, removedC, daysCell, hoursC, notesC,
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { d.equipment.splice(i, 1); paintEq(); refreshWarn(); commit(); } }, "✕")));
    recalcDays();
    return tr;
  }
  function paintEq() { eqBody.replaceChildren(...d.equipment.map(eqRow)); refreshWarn(); }
  paintEq();
  const addEq = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add equipment");
  addEq.addEventListener("click", () => { d.equipment.push(blankEquipRow()); paintEq(); commit(); });

  /* psychrometric readings table with GPP auto-calc */
  const psBody = h("tbody");
  function psRow(row, i) {
    const tr = h("tr");
    const cells = {};
    const mk = (key, w, type = "text") => {
      const c = h("td");
      const input = h("input", { type, value: row[key] ?? "", style: `min-width:${w}`, inputmode: type === "number" ? "decimal" : null });
      input.addEventListener("input", () => {
        row[key] = input.value;
        // typing a GPP directly marks it manual; editing T/RH re-enables auto-calc
        if (key === "outGPP") row._outManual = true;
        if (key === "refGPP") row._refManual = true;
        if (key === "affGPP") row._affManual = true;
        if (key === "outT" || key === "outRH") row._outManual = false;
        if (key === "refT" || key === "refRH") row._refManual = false;
        if (key === "affT" || key === "affRH") row._affManual = false;
        recalc(); commit();
      });
      cells[key] = input; c.append(input); return c;
    };
    function recalc() {
      const og = gpp(row.outT, row.outRH); if (og != null && !row._outManual) { row.outGPP = og; cells.outGPP.value = og; }
      const rg = gpp(row.refT, row.refRH); if (rg != null && !row._refManual) { row.refGPP = rg; cells.refGPP.value = rg; }
      const ag = gpp(row.affT, row.affRH); if (ag != null && !row._affManual) { row.affGPP = ag; cells.affGPP.value = ag; }
      const gd = grainDepression(Number(row.refGPP), Number(row.affGPP));
      if (gd != null && row.refGPP !== "" && row.affGPP !== "") { row.gd = gd; cells.gd.value = gd; }
    }
    const dateC = mk("date", "110px", "date");
    if (row.time == null && row.timeIn) row.time = row.timeIn;   // migrate old "Time In"
    const timeC = mk("time", "90px", "time");
    const outT = mk("outT", "44px", "number"), outRH = mk("outRH", "44px", "number"), outG = mk("outGPP", "48px", "number");
    const refT = mk("refT", "44px", "number"), refRH = mk("refRH", "44px", "number"), refG = mk("refGPP", "48px", "number");
    const affT = mk("affT", "44px", "number"), affRH = mk("affRH", "44px", "number"), affG = mk("affGPP", "48px", "number");
    const gdC = mk("gd", "44px", "number");
    cells.outGPP.classList.add("calc"); cells.refGPP.classList.add("calc"); cells.affGPP.classList.add("calc"); cells.gd.classList.add("calc");
    recalc(); // fill GPP/GD for any pre-existing T/RH values on load
    tr.append(dateC, timeC, outT, outRH, outG, refT, refRH, refG, affT, affRH, affG, gdC,
      mk("dehu", "40px", "number"), mk("am", "40px", "number"), mk("scrub", "40px", "number"),
      mk("tech", "70px"), mk("notes", "130px"),
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { d.readings.splice(i, 1); paintPs(); commit(); } }, "✕")));
    return tr;
  }
  function paintPs() { psBody.replaceChildren(...d.readings.map(psRow)); }
  paintPs();
  const addPs = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add reading");
  addPs.addEventListener("click", () => { d.readings.push(blankPsychroRow()); paintPs(); commit(); });

  const psHeadTop = h("tr", {},
    h("th", { colspan: 2 }, "Date / Time"),
    h("th", { colspan: 3 }, "Outside / Ambient"),
    h("th", { colspan: 3 }, "Unaffected (Ref.)"),
    h("th", { colspan: 3 }, "Affected"),
    h("th", {}, "GD"),
    h("th", { colspan: 3 }, "Equip Count"),
    h("th", { colspan: 2 }, "Tech / Notes"),
    h("th", { class: "app-only" }, ""));
  const psHeadBot = h("tr", {},
    ...["Date", "Time", "T", "RH", "GPP", "T", "RH", "GPP", "T", "RH", "GPP", "GD", "Dehu", "AM", "Scrb", "Tech", "Notes"].map((c) => h("th", {}, c)),
    h("th", { class: "app-only" }, ""));

  return sheet("DRYING LOG", "Equipment Runtime & Psychrometric Conditions — Per IICRC S500 Protocol", "Drying Log Field Template",
    daysBanner,
    h("div", { class: "grid2" },
      field("Drying System", seg(project, "dryingSystem", ["Open", "Closed", "Hybrid"])),
      field("Dry Goal (MC%)", inp(d, "dryGoal", { placeholder: "≤ 16%" }))),
    h("div", { class: "grid2" },
      field("Water Category", seg(project, "waterCategory", [{ value: "1", label: "Cat 1" }, { value: "2", label: "Cat 2" }, { value: "3", label: "Cat 3" }])),
      field("Class", seg(project, "waterClass", ["1", "2", "3", "4"]))),

    sectionTitle("Equipment Deployment & Runtime"),
    h("p", { class: "subtle app-only" }, "Log each unit placed on site — placed/removed date & time. Days-on-site and total hours calculate automatically; units past 7 days are flagged."),
    warnBox,
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Asset #", "Equipment Type / Make / Model", "Room / Location", "Placed", "Removed", "Days", "Hrs", "Notes"].map((c) => h("th", {}, c)), h("th", { class: "app-only" }, ""))),
        eqBody)),
    addEq,

    sectionTitle("Daily Psychrometric Readings"),
    h("div", { class: "note app-only" }, h("strong", {}, "Auto-calc: "), "Enter temperature (°F) and RH (%) — GPP fills automatically. Grain depression (GD) = Unaffected GPP − Affected GPP. Tap a GPP cell to override."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, psHeadTop, psHeadBot),
        psBody)),
    addPs,

    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "grid2" },
      field("Carrier / Adjuster", inp(project, "adjuster")),
      field("Tech Supervisor", inp(d, "techSupervisor"))),
    h("div", { class: "grid2" },
      field("Dry-out Start Date", inp(d, "dryoutStart", { type: "date", oninput: renderBanner })),
      field("Dry-out Finish Date", inp(d, "dryoutFinish", { type: "date", oninput: renderBanner }))));
}

/* ============================================================
   3. WORK AUTHORIZATION & SERVICE AGREEMENT
   ============================================================ */
export function workAuth(project, wa) {
  const scopeList = h("div");
  SCOPE_ITEMS.forEach((txt, i) => scopeList.append(check(wa.scope, i, `${i + 1}. ${txt}`)));

  const terms = h("div", { class: "terms" },
    termRow("Authorization", "By signing, property owner (“Owner”) authorizes Roybal Construction, LLC (“Contractor”) to perform the mitigation and restoration services described above."),
    termRow("Payment", "Payment is due upon completion or receipt of insurance proceeds. Owner remains responsible for any balance not covered by insurance, including deductibles and depreciation holdbacks."),
    termRow("Insurance", "Owner agrees to cooperate fully with the claims process, including providing adjuster access and signing any supplemental carrier authorization required."),
    termRow("Access", "Owner grants Contractor and crew reasonable access during business hours and emergency access as required to prevent further damage."),
    termRow("Exclusions", "This Work Order covers mitigation only. Reconstruction requires a separate written estimate and authorization. Contractor is not responsible for pre-existing damage unrelated to this loss."),
    termRow("Right to Stop", "Contractor may stop work if site conditions pose a safety risk, access is denied, or payment cannot be confirmed."));

  // The Owner Name field (bound to the job customer) auto-fills the signature
  // block's printed name — one place to type it, always in sync.
  if (project.customer && !wa.ownerName) wa.ownerName = project.customer;
  const ownerNameInput = inp(project, "customer");
  const ownerSig = sigBlock(wa, "ownerSig", "ownerName", "ownerDate", "Property Owner — sign above");
  const ownerSigName = ownerSig.querySelector('input[placeholder="Full name"]');
  ownerNameInput.addEventListener("input", () => {
    wa.ownerName = project.customer;
    if (ownerSigName) ownerSigName.value = project.customer;
    commit();
  });

  return sheet("WORK AUTHORIZATION & SERVICE AGREEMENT", "Water Mitigation / Restoration Services", "Work Authorization & Service Agreement",
    h("div", { class: "grid3" },
      field("Date", inp(wa, "date", { type: "date" })),
      field("Work Order #", inp(project, "workOrderNo")),
      field("Claim #", inp(project, "claimNo"))),
    field("Property Address", inp(project, "address")),
    h("div", { class: "grid2" },
      field("Owner Name", ownerNameInput),
      field("Phone", inp(project, "phone", { type: "tel" }))),
    h("div", { class: "grid2" },
      field("Email", inp(project, "email", { type: "email" })),
      field("Ins. Carrier", inp(project, "carrier"))),
    field("Loss Cause", ta(project, "lossCause", { rows: 2 })),

    sectionTitle("Scope of Authorized Work"),
    scopeList,

    sectionTitle("Terms & Conditions"),
    terms,

    sectionTitle("Authorization & Signatures"),
    h("p", { class: "subtle" }, "By signing below, the Property Owner confirms they have read and agree to the Terms & Conditions above, and authorize Roybal Construction, LLC to commence the described scope of work."),
    signOrUpload(wa, () => [
      ownerSig,
      h("hr", { class: "divider" }),
      sigBlock(wa, "repSig", "repName", "repDate", "Contractor Representative (Roybal Construction, LLC)"),
    ]));
}
function termRow(k, v) {
  return h("div", { class: "termrow" }, h("span", { class: "termrow__k" }, k + ":"), h("span", { class: "termrow__v" }, v));
}

/* QuickBooks Time control bar for the construction log (app-only, never printed).
   Links the job to a QB Time jobcode and pulls that day's crew hours into the
   log's rows. QB-sourced rows are read-only; edit them in QuickBooks + re-pull. */
function qbTimeBar(project, c, paint, calcTotal) {
  if (!qbConfigured()) return h("span", { class: "app-only" });
  const bar = h("div", { class: "app-only qb-bar" });
  const pullBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "⤓ Pull hours for this date");

  function render() {
    const linked = !!project.qbJobcodeId;
    const label = linked
      ? h("span", { class: "qb-linked" }, "🔗 QuickBooks: ", h("strong", {}, project.qbJobcodeName || project.qbJobcodeId))
      : h("span", { class: "subtle" }, "Not linked to a QuickBooks job");
    const linkBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, linked ? "Change" : "Link QuickBooks job");
    linkBtn.addEventListener("click", async () => {
      const picked = await pickJobcode(project);
      if (picked) { commit(); render(); }
    });
    bar.replaceChildren(
      h("div", { class: "qb-bar__row" }, label, linkBtn),
      h("div", { class: "qb-bar__row" }, pullBtn,
        h("span", { class: "subtle qb-hint" }, "Imports crew hours from QuickBooks Time for " + (c.date || "this date") + ".")));
  }

  // Replace the log's QB-sourced rows with `entries` (from time_entries),
  // preserving manual rows. Returns true if anything actually changed.
  const qbSig = (rows) => JSON.stringify(rows.filter((r) => r._qb)
    .map((r) => [r._qbId, r.hours, r.employee, r.start, r.finish]));
  function applyEntries(entries) {
    const manual = c.rows.filter((row) => !row._qb);
    const qbRows = entries.map((e) => ({
      employee: e.employee, task: e.task, start: e.start, finish: e.finish,
      hours: e.hours, _qb: true, _qbId: e.qbTimesheetId,
    }));
    const next = [...qbRows, ...manual];
    const changed = qbSig(next) !== qbSig(c.rows);
    c.rows = next;
    return changed;
  }

  pullBtn.addEventListener("click", async () => {
    if (!project.qbJobcodeId) { const p = await pickJobcode(project); if (!p || !project.qbJobcodeId) return; commit(); render(); }
    pullBtn.disabled = true;
    const prev = pullBtn.textContent;
    pullBtn.textContent = "Pulling…";
    try {
      const r = await qbPullDay(project, c.date);          // live refresh from QuickBooks
      applyEntries(await qbEntriesFor(project, c.date));
      paint(); calcTotal(); commit();
      toast(r.pulled
        ? `Pulled ${r.pulled} entr${r.pulled === 1 ? "y" : "ies"} from QuickBooks.`
        : "No QuickBooks hours logged for this date.");
    } catch (e) { toast(e.message || "QuickBooks pull failed"); }
    finally { pullBtn.disabled = false; pullBtn.textContent = prev; }
  });

  render();

  // Auto-load: when a linked log opens, reflect the latest time_entries (kept
  // fresh by the nightly cron) with no tap. Reads the cache, not a live QB call;
  // silent if offline or not yet synced.
  if (project.qbJobcodeId) {
    qbEntriesFor(project, c.date)
      .then((entries) => { if (applyEntries(entries)) { paint(); calcTotal(); commit(); } })
      .catch(() => {});
  }

  return bar;
}

/* ============================================================
   4. DAILY CONSTRUCTION LOG
   ============================================================ */
export function constructionLog(project, c) {
  const tbody = h("tbody");
  const totalEl = h("strong", {}, "0.00");
  function calcTotal() {
    const t = c.rows.reduce((s, r) => s + (Number(r.hours) || 0), 0);
    totalEl.textContent = t.toFixed(2);
  }
  function hoursFrom(start, finish) {
    if (!start || !finish) return "";
    const [sh, sm] = start.split(":").map(Number), [fh, fm] = finish.split(":").map(Number);
    let mins = (fh * 60 + fm) - (sh * 60 + sm); if (mins < 0) mins += 1440;
    return (mins / 60).toFixed(2);
  }
  // QuickBooks-sourced rows are read-only — edit them in QuickBooks Time and re-pull.
  function qbRow(r) {
    const tr = h("tr", { class: "qb-row" });
    const cell = (v, w) => h("td", { style: `min-width:${w}` }, h("span", { class: "qb-cell" }, v || "—"));
    tr.append(
      h("td", { style: "min-width:110px" },
        h("span", { class: "qb-cell" }, r.employee || "—"),
        h("span", { class: "qb-tag", title: "From QuickBooks Time" }, "QB")),
      cell(r.task, "180px"), cell(r.start, "90px"), cell(r.finish, "90px"),
      h("td", {}, h("strong", {}, r.hours != null && r.hours !== "" ? Number(r.hours).toFixed(2) : "—")),
      h("td", { class: "app-only" }));
    return tr;
  }
  function row(r, i) {
    if (r._qb) return qbRow(r);
    const tr = h("tr");
    const hoursCell = h("td");
    const hoursInput = h("input", { value: r.hours ?? "", style: "min-width:56px", inputmode: "decimal" });
    hoursInput.addEventListener("input", () => { r.hours = hoursInput.value; r._manualHrs = true; calcTotal(); commit(); });
    hoursCell.append(hoursInput);
    const mk = (key, w, type = "text") => {
      const c2 = h("td");
      const input = h("input", { type, value: r[key] ?? "", style: `min-width:${w}` });
      input.addEventListener("input", () => {
        r[key] = input.value;
        if ((key === "start" || key === "finish") && !r._manualHrs) { r.hours = hoursFrom(r.start, r.finish); hoursInput.value = r.hours; calcTotal(); }
        commit();
      });
      c2.append(input); return c2;
    };
    tr.append(mk("employee", "110px"), mk("task", "180px"), mk("start", "90px", "time"), mk("finish", "90px", "time"), hoursCell,
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { c.rows.splice(c.rows.indexOf(r), 1); paint(); calcTotal(); commit(); } }, "✕")));
    return tr;
  }
  function paint() { tbody.replaceChildren(...c.rows.map(row)); }
  paint(); calcTotal();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add crew row");
  addRow.addEventListener("click", () => { c.rows.push(blankWorkRow()); paint(); commit(); });

  return sheet("DAILY CONSTRUCTION LOG", "Job Site Activity & Labor Record", "Daily Construction Log",
    h("div", { class: "grid3" },
      field("Customer", inp(project, "customer")),
      field("Project / Job", inp(project, "workOrderNo")),
      field("Date", inp(c, "date", { type: "date" }))),
    qbTimeBar(project, c, paint, calcTotal),
    sectionTitle("Work Log"),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Employee", "Task Performed", "Start", "Finish", "Hours"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,
    h("div", { class: "totals" }, h("div", { class: "trow grand" }, h("span", {}, "Total Man Hours"), totalEl)),
    sectionTitle("Notes / Issues / Materials Needed"),
    field("Notes", ta(c, "notes")),
    field("Issues", ta(c, "issues")),
    field("Materials Needed", ta(c, "materials")),
    sectionTitle("Completed By"),
    field("Completed By", inp(c, "completedBy")),
    sigBlock(c, "signature", "completedBy", "signDate", "Signature"));
}

/* ============================================================
   5. CERTIFICATE OF DRYING
   ============================================================ */
export function certDrying(project, c) {
  const vbody = h("tbody");
  function vrow(r, i) {
    const tr = h("tr");
    const mk = (key, w, type = "text") => {
      const td = h("td");
      const input = h("input", { type, value: r[key] ?? "", style: `min-width:${w}` });
      input.addEventListener("input", () => { r[key] = input.value; commit(); });
      td.append(input); return td;
    };
    const dryTd = h("td");
    const dryBox = h("input", { type: "checkbox", checked: !!r.dry, style: "width:22px;height:22px" });
    dryBox.addEventListener("change", () => { r.dry = dryBox.checked; commit(); });
    dryTd.append(dryBox);
    tr.append(mk("material", "150px"), mk("meter", "120px"), mk("goal", "60px"), mk("final", "60px"), mk("reference", "70px"), dryTd,
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { c.verification.splice(i, 1); paint(); commit(); } }, "✕")));
    return tr;
  }
  function paint() { vbody.replaceChildren(...c.verification.map(vrow)); }
  paint();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add material");
  addRow.addEventListener("click", () => { c.verification.push(blankVerifyRow()); paint(); commit(); });

  return sheet("CERTIFICATE OF DRYING", "Verification of Dry Standard Achievement — Per IICRC S500 Protocol", "Certificate of Drying",
    h("div", { class: "grid2" },
      field("Certificate #", inp(c, "certNo")),
      field("Issue Date", inp(c, "issueDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Project / Job ID", inp(project, "workOrderNo")),
      field("Drying Duration (days)", inp(c, "dryingDays", { type: "number" }))),
    sectionTitle("Property / Insured & Claim"),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    jobInfo(project, ["carrier", "claimNo", "adjuster", "dateOfLoss"]),
    sectionTitle("Water Loss Classification & Timeline"),
    h("div", { class: "grid2" },
      field("Water Category", seg(project, "waterCategory", [{ value: "1", label: "Cat 1" }, { value: "2", label: "Cat 2" }, { value: "3", label: "Cat 3" }])),
      field("Class", seg(project, "waterClass", ["1", "2", "3", "4"]))),
    h("div", { class: "grid2" },
      field("Drying Start Date", inp(c, "dryStart", { type: "date" })),
      field("Drying Completion Date", inp(c, "dryComplete", { type: "date" }))),
    field("Affected Areas & Materials", ta(c, "affectedAreas")),
    sectionTitle("Dry Standard Verification"),
    h("p", { class: "subtle app-only" }, "All readings in MC%. Compare final to unaffected reference or manufacturer dry standard."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Material / Location", "Meter / Setting", "Goal %", "Final %", "Ref %", "✓ Dry"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        vbody)),
    addRow,
    sectionTitle("Equipment Deployment Summary"),
    h("div", { class: "grid2" },
      field("Dehumidifiers (# × days)", inp(c, "dehuDays")),
      field("Air Movers (# × days)", inp(c, "amDays"))),
    h("div", { class: "grid2" },
      field("Air Scrubbers (# × days)", inp(c, "scrubDays")),
      field("Heaters / Other (# × days)", inp(c, "heaterDays"))),
    h("div", { class: "certstmt" },
      h("p", {}, "The undersigned, an IICRC-certified water restoration technician, hereby certifies that the water damage mitigation and structural drying services described herein were performed at the above property in accordance with the IICRC S500 Standard for Professional Water Damage Restoration. Final moisture-meter readings confirm that affected materials have achieved the documented dry standard by comparison to unaffected reference materials and/or manufacturer specifications. The structure is considered dry per IICRC S500 criteria as of the Drying Completion Date stated above.")),
    sectionTitle("Signatures"),
    signOrUpload(c, () => [
      sigBlock(c, "sigTech", "sigTechName", "sigTechDate", "IICRC Certified Technician — Roybal Construction, LLC"),
      h("hr", { class: "divider" }),
      sigBlock(c, "sigOwner", "sigOwnerName", "sigOwnerDate", "Property Owner / Insured"),
      h("hr", { class: "divider" }),
      sigBlock(c, "sigAdjuster", "sigAdjusterName", "sigAdjusterDate", "Adjuster / Carrier (if witness required)"),
    ]));
}

/* ============================================================
   6. CHANGE ORDER
   ============================================================ */
export function changeOrder(project, co) {
  const reasons = h("div", { class: "grid2" });
  if (!co.reasons) co.reasons = {};
  CHANGE_REASONS.forEach((txt, i) => reasons.append(check(co.reasons, i, txt)));

  const totalsBox = { thisCO: 0 };
  const newTotalEl = h("span", {}, money(0));
  const thisCOEl = h("span", {}, money(0));
  function onTotals(subtotal) {
    totalsBox.thisCO = subtotal;
    thisCOEl.textContent = money(subtotal);
    const nt = (Number(co.origAmount) || 0) + (Number(co.prevCO) || 0) + subtotal;
    newTotalEl.textContent = money(nt);
  }
  const items = lineItems(co.items, blankLineItem, { onTotals: (s) => onTotals(s) });

  const recalcFromFields = () => onTotals(totalsBox.thisCO);

  return sheet("CHANGE ORDER", "Contract Revision / Scope Modification / Supplement Request", "Change Order Form",
    h("div", { class: "grid2" },
      field("Change Order #", inp(co, "coNo")),
      field("CO Date", inp(co, "coDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Original Contract / WO #", inp(project, "workOrderNo")),
      field("Job / Project ID", inp(project, "claimNo"))),
    sectionTitle("Owner / Insured & Claim"),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    jobInfo(project, ["carrier", "claimNo", "adjuster", "dateOfLoss"]),
    sectionTitle("Reason for Change"),
    reasons,
    field("Detailed Description of Change", ta(co, "description", { rows: 4 })),
    sectionTitle("Scope Changes — Line Items"),
    h("p", { class: "subtle app-only" }, "Enter negative amounts for deducted scope."),
    items,
    sectionTitle("Schedule & Financial Impact"),
    h("div", { class: "grid2" },
      field("Days Added to Schedule", inp(co, "daysAdded", { type: "number" })),
      field("Effective Date of Change", inp(co, "effectiveDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Original Completion Date", inp(co, "origCompletion", { type: "date" })),
      field("Revised Completion Date", inp(co, "revisedCompletion", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Original Contract Amount", inp(co, "origAmount", { type: "number", oninput: recalcFromFields })),
      field("Net of Previous Change Orders", inp(co, "prevCO", { type: "number", oninput: recalcFromFields }))),
    h("div", { class: "totals" },
      h("div", { class: "trow" }, h("span", {}, "This Change Order (+/−)"), thisCOEl),
      h("div", { class: "trow grand" }, h("span", {}, "New Contract Total"), newTotalEl)),
    sectionTitle("Authorization & Signatures"),
    sigBlock(co, "sigOwner", "sigOwnerName", "sigOwnerDate", "Owner / Insured"),
    h("hr", { class: "divider" }),
    sigBlock(co, "sigContractor", "sigContractorName", "sigContractorDate", "Contractor (Roybal Construction, LLC)"),
    h("hr", { class: "divider" }),
    sigBlock(co, "sigAdjuster", "sigAdjusterName", "sigAdjusterDate", "Adjuster / Carrier (if applicable)"));
}

/* ============================================================
   7. MITIGATION INVOICE
   ============================================================ */
export function invoice(project, inv) {
  const subEl = h("span", {}, money(0));
  const taxEl = h("span", {}, money(0));
  const totalEl = h("span", {}, money(0));
  let subtotal = 0;
  function recalc(sub) {
    if (sub != null) subtotal = sub;
    subEl.textContent = money(subtotal);
    const tax = subtotal * ((Number(inv.taxRate) || 0) / 100);
    taxEl.textContent = money(tax);
    const total = subtotal - (Number(inv.deductible) || 0) - (Number(inv.previousPayments) || 0) + tax;
    totalEl.textContent = money(total);
  }
  const items = lineItems(inv.items, blankLineItem, { onTotals: (s) => recalc(s) });

  return sheet("MITIGATION INVOICE", "Water Mitigation & Restoration Services | IICRC S500 Compliant", "Mitigation Invoice",
    h("div", { class: "grid2" },
      field("Invoice #", inp(inv, "invoiceNo")),
      field("Invoice Date", inp(inv, "invoiceDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Due Date", inp(inv, "dueDate", { type: "date" })),
      field("Payment Terms", inp(inv, "terms"))),
    sectionTitle("Bill To / Insured & Claim"),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    jobInfo(project, ["carrier", "claimNo", "dateOfLoss", "adjuster"]),
    field("Loss Description / Scope Summary", ta(inv, "lossSummary")),
    sectionTitle("Charges"),
    items,
    h("div", { class: "totals" },
      h("div", { class: "trow" }, h("span", {}, "Subtotal"), subEl),
      h("div", { class: "trow" }, h("span", {}, "Less: Deductible / Non-Recoverable"), inp(inv, "deductible", { type: "number", oninput: () => recalc() })),
      h("div", { class: "trow" }, h("span", {}, "Less: Previous Payments"), inp(inv, "previousPayments", { type: "number", oninput: () => recalc() })),
      h("div", { class: "trow" }, h("span", {}, "Sales Tax %"), inp(inv, "taxRate", { type: "number", oninput: () => recalc() })),
      h("div", { class: "trow" }, h("span", {}, "Sales Tax"), taxEl),
      h("div", { class: "trow grand" }, h("span", {}, "Total Due"), totalEl)),
    field("Notes / Supporting Documentation", ta(inv, "notes")),
    h("div", { class: "remit print-only" },
      h("strong", {}, "Remit to: Roybal Construction, LLC"),
      h("div", {}, "2170 Chateau Court, North Pole, AK 99705"),
      h("div", {}, "Phone: 907-371-9868 · branden@roybalconstruction.com"),
      h("div", {}, "Methods: Check, ACH, or credit card on request")));
}

/* ============================================================
   8. JOB PHOTOS — project-level gallery + printable Photo Report
   ============================================================ */
export function photosForm(project) {
  if (!Array.isArray(project.photos)) project.photos = [];
  const grid = h("div", { class: "photogrid" });

  function card(p, i) {
    const cap = h("input", { value: p.caption || "", placeholder: "Caption" });
    cap.addEventListener("input", () => { p.caption = cap.value; commit(); });
    const room = h("input", { value: p.room || "", placeholder: "Room / location" });
    room.addEventListener("input", () => { p.room = room.value; commit(); });
    const stage = sel(p, "stage", [
      { value: "before", label: "Before" }, { value: "during", label: "During" }, { value: "after", label: "After" }]);
    const del = h("button", { type: "button", class: "btn btn--danger btn--sm", onclick: () => { project.photos.splice(i, 1); paint(); commit(); } }, "Delete");
    return h("div", { class: "photocard" },
      h("img", { src: p.src, alt: p.caption || "" }),
      h("div", { class: "photocap print-only" }, [p.stage ? p.stage.toUpperCase() : "", p.room, p.caption].filter(Boolean).join(" · "), " ", h("span", { class: "photometa" }, fmtDate((p.ts || "").slice(0, 10)))),
      h("div", { class: "app-only photoedit" }, room, stage, cap, del));
  }
  function paint() {
    grid.replaceChildren(...project.photos.map(card));
    if (!project.photos.length) grid.append(h("p", { class: "subtle app-only" }, "No photos yet — tap “Add photos.”"));
  }

  const input = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: "display:none" });
  input.addEventListener("change", async () => {
    for (const f of input.files) { const ph = newPhoto(); ph.src = await fileToDataURL(f); project.photos.push(ph); }
    input.value = ""; commit(); paint();
  });
  const addBtn = h("button", { type: "button", class: "btn btn--primary" }, "📷 Add photos");
  addBtn.addEventListener("click", () => input.click());
  paint();

  return sheet("PHOTO REPORT", "Job Site Documentation", "Photo Report",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "app-only", style: "margin:10px 0" }, addBtn, input),
    grid);
}

/* ============================================================
   9. CONTENTS INVENTORY — printable report (read-only)
   Editing happens in the dedicated Contents manager (app.js).
   ============================================================ */
export function contentsReport(project) {
  const items = project.contents || [];
  const boxes = project.boxes || [];
  const boxLabel = (id) => boxes.find((b) => b.id === id)?.label || "";
  const ext = (it) => (Number(it.value) || 0) * (Number(it.qty) || 1);

  const invRows = items.map((it) =>
    h("tr", {},
      h("td", {}, it.photos && it.photos[0] ? h("img", { src: it.photos[0], class: "cthumb", alt: "" }) : ""),
      h("td", { style: "text-align:left" }, it.name || "—", it.brand || it.model ? h("div", { class: "csub" }, [it.brand, it.model].filter(Boolean).join(" ")) : null),
      h("td", {}, it.qty || ""),
      h("td", {}, it.room || ""),
      h("td", {}, boxLabel(it.boxId)),
      h("td", {}, it.condition || ""),
      h("td", {}, dispositionLabel(it.disposition)),
      h("td", {}, it.value ? money(ext(it)) : "")));

  const loss = items.filter((it) => it.disposition === "non-salvageable");
  const dep = (it) => depreciation(it);
  const totRCV = loss.reduce((s, it) => s + dep(it).rcv, 0);
  const totACV = loss.reduce((s, it) => s + dep(it).acv, 0);
  const lossRows = loss.map((it) => {
    const d = dep(it);
    return h("tr", {},
      h("td", { style: "text-align:left" }, it.name || "—"),
      h("td", {}, it.qty || ""),
      h("td", {}, it.room || ""),
      h("td", {}, it.age || ""),
      h("td", {}, money(d.rcv)),
      h("td", {}, Math.round(d.rate * 100) + "%"),
      h("td", {}, money(d.acv)));
  });

  const totalItems = items.reduce((s, it) => s + (Number(it.qty) || 1), 0);

  return sheet("CONTENTS INVENTORY", "Personal Property Documentation", "Contents Inventory",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "badgeline" },
      h("span", { class: "badge" }, items.length + " line items"),
      h("span", { class: "badge" }, totalItems + " pieces"),
      h("span", { class: "badge" }, boxes.length + " boxes"),
      loss.length ? h("span", { class: "badge cat3" }, loss.length + " non-salvageable") : null),

    sectionTitle("Inventory"),
    items.length
      ? h("div", { class: "tablewrap" },
          h("table", { class: "grid contents-grid" },
            h("thead", {}, h("tr", {}, ...["Photo", "Item", "Qty", "Room", "Box", "Condition", "Disposition", "Value"].map((c) => h("th", {}, c)))),
            h("tbody", {}, ...invRows)))
      : h("p", { class: "subtle" }, "No items recorded."),

    loss.length ? sectionTitle("Non-Salvageable Loss Summary") : null,
    loss.length ? h("p", { class: "subtle app-only" }, "RCV = replacement cost · ACV = actual cash value after age depreciation (IICRC useful-life basis).") : null,
    loss.length
      ? h("div", { class: "tablewrap" },
          h("table", { class: "grid" },
            h("thead", {}, h("tr", {}, ...["Item", "Qty", "Room", "Age", "RCV", "Depr.", "ACV"].map((c) => h("th", {}, c)))),
            h("tbody", {}, ...lossRows,
              h("tr", { class: "calc" },
                h("td", { colspan: 4, style: "text-align:right;font-weight:800" }, "Totals"),
                h("td", { style: "font-weight:800" }, money(totRCV)),
                h("td", {}, ""),
                h("td", { style: "font-weight:800" }, money(totACV))))))
      : null);
}

/* ---------- Contents pack-back receipt (homeowner sign-off) ---------- */
export function packBackReceipt(project) {
  const items = project.contents || [];
  const boxes = project.boxes || [];
  const boxLabel = (id) => boxes.find((b) => b.id === id)?.label || "";
  const tbody = h("tbody");
  items.forEach((it) => {
    const tr = h("tr");
    const box = h("input", { type: "checkbox", checked: !!it.returned, style: "width:20px;height:20px" });
    box.addEventListener("change", () => { it.returned = box.checked; it.returnedDate = box.checked ? todayISO() : ""; commit(); });
    tr.append(
      h("td", { style: "text-align:left" }, it.name || "—"),
      h("td", {}, it.qty || ""),
      h("td", {}, it.room || ""),
      h("td", {}, boxLabel(it.boxId)),
      h("td", {}, box));
    tbody.append(tr);
  });
  return sheet("CONTENTS PACK-BACK RECEIPT", "Acknowledgment of Returned Personal Property", "Contents Pack-Back Receipt",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    sectionTitle("Returned Items"),
    h("p", { class: "subtle app-only" }, "Check off each item as it is returned to the owner."),
    items.length
      ? h("div", { class: "tablewrap" },
          h("table", { class: "grid" },
            h("thead", {}, h("tr", {}, ...["Item", "Qty", "Room", "Box", "Returned ✓"].map((c) => h("th", {}, c)))),
            tbody))
      : h("p", { class: "subtle" }, "No items in inventory."),
    h("div", { class: "certstmt" },
      h("p", {}, "The undersigned homeowner / insured acknowledges receipt of the personal-property items checked above, returned in the condition documented at pack-back by Roybal Construction, LLC.")),
    sectionTitle("Acknowledgment"),
    sigBlock(project, "packbackSig", "packbackName", "packbackDate", "Homeowner / Insured"));
}

/* Printable full-page sheets from an uploaded signed document (each PDF page
   / scan becomes its own printed page). Used by the packet to REPLACE the
   generated Work Authorization or Certificate of Drying when one is uploaded. */
export function uploadedDocSheet(pages, footLabel) {
  return pages.map((src) =>
    h("section", { class: "sheet sheet--doc" },
      h("img", { src, class: "docpage-full", alt: footLabel + " — uploaded copy" }),
      sheetFooter(footLabel)));
}

/* ---------- Construction narrative (packet cover) ---------- */
/* Minimal Markdown -> DOM for the narrative subset (## headings, paragraphs,
   - bullets, > note, **bold**). The model returns this Markdown. */
function mdInline(text) {
  const out = []; const re = /\*\*(.+?)\*\*/g; let i = 0, m;
  while ((m = re.exec(text))) { if (m.index > i) out.push(text.slice(i, m.index)); out.push(h("strong", {}, m[1])); i = m.index + m[0].length; }
  if (i < text.length) out.push(text.slice(i));
  return out.length ? out : [text];
}
function mdToNodes(md) {
  const nodes = []; let para = [], bullets = null;
  const flushP = () => { if (para.length) { nodes.push(h("p", { style: "margin:8px 0;line-height:1.5;font-size:13px" }, ...mdInline(para.join(" ")))); para = []; } };
  const flushB = () => { if (bullets) { nodes.push(h("ul", { style: "margin:6px 0 6px 18px;line-height:1.5;font-size:13px" }, ...bullets)); bullets = null; } };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim(); let m;
    if (!line) { flushP(); flushB(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushP(); flushB(); nodes.push(h("h3", { style: "margin:16px 0 4px;color:var(--navy,#0f1b2d);font-size:14px;border-bottom:2px solid var(--orange,#f26a21);padding-bottom:3px" }, ...mdInline(m[1]))); }
    else if ((m = line.match(/^>\s?(.*)/))) { flushP(); flushB(); nodes.push(h("div", { style: "margin:8px 0;padding:8px 10px;background:#f7f9fc;border-left:3px solid #cdd5df;color:#5b6470;font-style:italic;font-size:12.5px" }, ...mdInline(m[1]))); }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { flushP(); (bullets = bullets || []).push(h("li", { style: "margin:2px 0" }, ...mdInline(m[1]))); }
    else { flushB(); para.push(line); }
  }
  flushP(); flushB();
  return nodes;
}

/* The narrative cover sheet — letterhead + info table + narrative + signature
   + license footer, in the firm's format. Prepended to the packet. */
export function narrativeSheet(project) {
  const facts = narrativeFacts(project);
  const infoRows = [
    ...narrativeInfoRows(facts),
    ["CONTRACTOR", COMPANY.name], ["NARRATIVE DATE", project.narrativeDate || todayISO()],
  ];
  // LOSS TYPE / CAUSE can be a long paragraph — pull it out of the 2-column grid
  // and render it full-width so it isn't scrunched into a narrow column.
  const lossIdx = infoRows.findIndex(([k]) => k === "LOSS TYPE");
  const lossRow = lossIdx >= 0 ? infoRows.splice(lossIdx, 1)[0] : null;
  const cell = (k, v, i, full) => h("div", {
    style: "padding:7px 10px;font-size:12.5px;" + (i >= 2 ? "border-top:1px solid #eef1f5;" : "")
      + (!full && i % 2 ? "border-left:1px solid #eef1f5;" : "") + (full ? "grid-column:1 / -1;" : ""),
  }, h("span", { style: "color:var(--orange,#f26a21);font-weight:700;font-size:11px" }, k + " "), h("span", {}, String(v)));
  const cells = infoRows.map(([k, v], i) => cell(k, v, i, false));
  if (lossRow) cells.push(cell("LOSS TYPE / CAUSE", lossRow[1], infoRows.length, true));
  const table = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;border:1px solid #e2e6ec;border-radius:8px;overflow:hidden;margin:12px 0" },
    ...cells);
  return h("section", { class: "sheet" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--navy,#0f1b2d);padding-bottom:8px" },
      h("div", {},
        h("div", { style: "font-weight:800;font-size:15px" },
          h("span", { style: "color:var(--orange,#f26a21)" }, "ROYBAL"),
          h("span", { style: "color:#0f1b2d" }, " CONSTRUCTION, LLC")),
        h("div", { style: "color:#5b6470;font-size:11px" }, COMPANY.tagline)),
      h("div", { style: "text-align:right;color:#5b6470;font-size:10.5px;line-height:1.5" },
        h("div", {}, COMPANY.address), h("div", {}, COMPANY.phone + " • " + COMPANY.email))),
    h("div", { style: "text-align:center;margin:14px 0 2px" },
      h("h2", { style: "margin:0;color:var(--navy,#0f1b2d);font-size:18px;letter-spacing:.4px" }, "CONSTRUCTION / RECONSTRUCTION NARRATIVE"),
      h("div", { style: "color:#5b6470;font-size:12px;font-style:italic" }, "Scope Justification for Repair to Pre-Loss Condition — Per IICRC S500 & FNSB / IRC"),
      facts.job.carrier ? h("div", { style: "color:#5b6470;font-size:11px;margin-top:2px" }, `Prepared for ${facts.job.carrier} — Submitted with Estimate, Photo Report, Moisture Map & Certificate of Drying`) : null),
    table,
    h("div", { class: "narrative-body" }, ...mdToNodes(project.narrative || "")),
    h("div", { style: "margin-top:18px" },
      h("div", { style: "font-size:13px" }, "Respectfully submitted,"),
      h("div", { style: "font-weight:700;color:var(--navy,#0f1b2d);margin-top:8px" }, COMPANY.signatory),
      h("div", { style: "color:#5b6470;font-size:12px" }, COMPANY.signatoryTitle + " — " + COMPANY.name)),
    h("div", { style: "margin-top:16px;border-top:1px solid #e2e6ec;padding-top:6px;text-align:center;color:#8a93a0;font-size:9.5px;line-height:1.6" },
      h("div", {}, `${COMPANY.name} • ${COMPANY.address} • ${COMPANY.phone} • ${COMPANY.email}`),
      h("div", {}, COMPANY.licenses.join("  •  "))));
}

/* ---------- dispatch ---------- */
export const RENDERERS = {
  moistureMaps: moistureMap,
  dryingLogs: dryingLog,
  workAuth,
  photos: photosForm,
  contents: contentsReport,
  constructionLogs: constructionLog,
  certDrying,
  changeOrders: changeOrder,
  invoices: invoice,
};
