/* ============================================================
   Roybal Field Forms — the 7 form renderers
   Each returns a printable .sheet built from bound inputs.
   ============================================================ */
import { h, sketchPad, equipmentPad, EQUIP_TYPES, gpp, grainDepression, money, toast, fmtDate, todayISO, fileToDataURL, DRY_STANDARDS, goalFor, daysSince, daysBetween } from "./core.js";
import { fileToFloorPlan, fileToDocPages } from "./pdf.js";
import {
  field, inp, ta, sel, seg, check, sigBlock, signOrUpload, photoUploader,
  lineItems, taCell, sheet, sheetFooter, letterhead, commit, uploadDoc, uploadedDocPages,
} from "./formkit.js";
import {
  SCOPE_ITEMS, CHANGE_REASONS, newPhoto, dispositionLabel, depreciation,
  blankReadingRow, blankPsychroRow, blankEquipRow,
  blankLineItem, blankVerifyRow, COMPANY,
  TRADES, SELECTION_STATUSES, SUB_STATUSES, PUNCH_STATUSES, PUNCH_PRIORITIES,
  INSPECTION_TYPES, INSPECTION_RESULTS, PRECON_ITEMS, COMPLETION_ITEMS,
  blankScopeArea, blankScopeItem, blankAllowanceRow, blankPermitRow,
  blankSelectionRow, blankSubRow, blankPunchRow, blankDrawRow, newInvoice,
} from "./model.js";
import { narrativeFacts, narrativeInfoRows } from "./narrative.js";
import { findBoardRow, phasesToSubRows } from "./boardpush.js";
import { pickJobcode, pullRange as qbPullRange, allEntriesFor as qbAllEntriesFor, qbConfigured } from "./qbtime.js";
import { aiAvailable, aiReady, analyzePhotos, applyPhotoAnalysis, draftInvoice, auditInvoice, extractPlanDimensions } from "./officeai.js";
import { pushInvoiceToQbo } from "./qbo.js";
import { smsHref, officeNumbers, officeNumbersRaw, setOfficeNumbers, fieldReportSms, logSms } from "./sms.js";
import { techName } from "./tech.js";

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
/* Meter presets — saved once per device, picked from a dropdown after that. */
const METERS_KEY = "roybal-meters";
function meterPresets() { try { return JSON.parse(localStorage.getItem(METERS_KEY)) || []; } catch { return []; } }
function meterSelect(m) {
  const wrap = h("span", { class: "addable" });
  function render() {
    const s = h("select");
    const cur = m.meter || "";
    const opts = meterPresets();
    s.append(h("option", { value: "" }, "—"));
    if (cur && !opts.includes(cur)) s.append(h("option", { value: cur, selected: true }, cur));
    opts.forEach((o) => s.append(h("option", { value: o, selected: o === cur }, o)));
    s.append(h("option", { value: "__new__" }, "➕ New meter / setting…"));
    s.addEventListener("change", () => {
      if (s.value === "__new__") {
        const v = (prompt("Meter & setting (e.g. Protimeter Surveymaster — pin, WME scale)") || "").trim();
        if (v) {
          const list = meterPresets();
          if (!list.includes(v)) { list.push(v); try { localStorage.setItem(METERS_KEY, JSON.stringify(list)); } catch (_) {} }
          m.meter = v; commit();
        }
        render();
      } else { m.meter = s.value; commit(); }
    });
    wrap.replaceChildren(s);
  }
  render();
  return wrap;
}

/* Most recent drying-log psychrometric reading — the room's ambient conditions. */
function latestPsychReading(project) {
  let best = null;
  for (const d of project.dryingLogs || []) {
    for (const r of d.readings || []) {
      if (!(String(r.affT || "").trim() || String(r.affRH || "").trim())) continue;
      if (!best || String(r.date || "") >= String(best.date || "")) best = r;
    }
  }
  return best;
}

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
    tr.append(taCell(row, "notes", { minWidth: "120px" }));
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

  /* Room / Area name — titles both maps so multi-room jobs stay readable */
  const areaTitle = h("div", { class: "maptitle" });
  const eqTitle = h("div", { class: "maptitle" });
  function paintTitles() {
    const name = String(m.label || "").trim();
    areaTitle.textContent = name;
    areaTitle.hidden = !name;
    eqTitle.textContent = name ? name + " — Equipment" : "";
    eqTitle.hidden = !name;
  }
  const roomInp = inp(m, "label", { placeholder: "e.g. Living Room", oninput: paintTitles });
  paintTitles();

  /* Ambient temp/RH — auto-pulled from the latest drying-log psychrometric
     reading (that IS the room's ambient), still fully editable. */
  const ambInp = inp(m, "ambientTemp", { placeholder: "e.g. 72°F / 45%" });
  const ambBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only", style: "width:auto;flex:0 0 auto" }, "↻");
  function pullAmbient({ silent = false } = {}) {
    const r = latestPsychReading(project);
    if (!r) { if (!silent) toast("No drying-log readings yet — enter today's psychrometrics in a Drying Log first."); return; }
    m.ambientTemp = [r.affT && r.affT + "°F", r.affRH && r.affRH + "%"].filter(Boolean).join(" / ") +
      (r.date ? " (" + r.date + ")" : "");
    ambInp.value = m.ambientTemp;
    commit();
    if (!silent) toast("Pulled from the drying log.");
  }
  ambBtn.title = "Pull from the latest drying-log reading";
  ambBtn.addEventListener("click", () => pullAmbient());
  if (!String(m.ambientTemp || "").trim()) pullAmbient({ silent: true });

  return sheet("MOISTURE MAP", "Water Mitigation Field Documentation — Per IICRC S500 Protocol", "Moisture Map Field Template",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "grid2" },
      field("Technician", inp(m, "technician")),
      field("Ambient Temp / RH", h("div", { style: "display:flex;gap:6px" }, ambInp, ambBtn))),
    h("div", { class: "grid2" },
      field("Equipment on Site", inp(m, "equipmentOnSite", { placeholder: "e.g. 2 dehu, 6 AM" })),
      field("Page (of)", h("div", { class: "grid2" }, inp(m, "page", { placeholder: "Page" }), inp(m, "pageOf", { placeholder: "of" })))),

    sectionTitle("Affected Area"),
    h("p", { class: "subtle app-only" }, "Import a floor plan (or draw freehand), then tap “① Number” and place a numbered marker at each moisture-reading location."),
    h("div", { class: "grid2" },
      field("Room / Area (titles this map)", roomInp),
      field("Meter / Setting", meterSelect(m))),
    h("div", { class: "grid2" },
      field("Material", materialSel),
      field("Dry Goal (MC%)", dryGoalInput)),
    fpBox,
    pad.tools, areaTitle, pad.el,
    h("details", { class: "app-only", style: "margin-top:10px" },
      h("summary", { class: "linklike" }, "Or attach photos of the area instead"),
      photoUploader(m.photos, "Add area photos")),

    sectionTitle("Equipment Placement"),
    h("p", { class: "subtle app-only" }, "Tap a tool, then tap the floor plan to drop it. Tap a placed unit to move it; use ↺ ↻ to aim it (air-mover direction)."),
    equipPad.tools, eqTitle, equipPad.el, equipCountEl,

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
    // free-text columns grow with their text; the fill handle still works
    const mkTa = (key, w) => {
      const c = taCell(row, key, { minWidth: w });
      c.classList.add("fillcell");
      attachFill(c, i, key);
      return c;
    };
    const assetC = mk("asset", "50px"), typeC = mkTa("type", "150px"), locC = mkTa("location", "110px");
    const placedC = mk("placed", "150px", "datetime-local"), removedC = mk("removed", "150px", "datetime-local");
    const hoursC = mk("hours", "56px", "number"), notesC = mkTa("notes", "120px");
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
      mk("tech", "70px"), taCell(row, "notes", { minWidth: "130px" }),
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

/* ============================================================
   4. FIELD REPORT (key constructionLogs, kept for data compatibility)
   Crew -> office channel: notes, issues and materials needed on site,
   with photos of anything worth showing. Internal — never in the packet.
   Hours live in the Labor Log (QuickBooks Time); the old per-day work
   log + QB pull are gone (legacy rows stay stored, just not shown).
   ============================================================ */
/* app-only: open Messages pre-filled with this report, addressed to the
   assigned office numbers — sent from the tech's own phone so the office
   can text straight back. Numbers are per-device (⚙), office # by default. */
function textToOfficeBar(project, c) {
  const bar = h("div", { class: "app-only", style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0" });
  const send = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto" }, "📱 Text to office");
  send.addEventListener("click", () => {
    const nums = officeNumbers();
    if (!nums.length) { toast("Add an office number first (⚙)."); return; }
    const body = fieldReportSms(project, c, techName());
    if (body.split("\n").length < 2) { toast("Nothing to send yet — add a note, issue or materials."); return; }
    logSms(project, { kind: "fieldReport", to: nums, body, by: techName() });   // claim documentation
    commit();
    location.href = smsHref(nums, body);
  });
  const cfg = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto", title: "Office numbers this report texts to" }, "⚙");
  const label = h("span", { class: "subtle", style: "font-size:12px" });
  const paintLabel = () => { label.textContent = "to " + officeNumbers().join(", "); };
  cfg.addEventListener("click", () => {
    const v = prompt("Office numbers to text (comma-separated):", officeNumbersRaw());
    if (v != null) { setOfficeNumbers(v); paintLabel(); }
  });
  paintLabel();
  bar.append(send, cfg, label);
  return bar;
}

export function constructionLog(project, c) {
  if (!Array.isArray(c.photos)) c.photos = [];
  return sheet("FIELD REPORT", "Crew → Office — Notes, Issues & Materials Needed", "Field Report",
    h("div", { class: "grid3" },
      field("Customer", inp(project, "customer")),
      field("Project / Job", inp(project, "workOrderNo")),
      field("Date", inp(c, "date", { type: "date" }))),
    sectionTitle("Notes for the Office"),
    field("Notes", ta(c, "notes", { placeholder: "Anything the office should know — progress, access, schedule…" })),
    sectionTitle("Issues"),
    field("Issues", ta(c, "issues", { placeholder: "Problems found on site — hidden damage, safety, delays…" })),
    sectionTitle("Materials Needed"),
    field("Materials Needed", ta(c, "materials", { placeholder: "What to order or bring out on the next trip…" })),
    sectionTitle("Photos"),
    h("p", { class: "subtle app-only" }, "Attach photos of any issue so the office sees exactly what you see."),
    photoUploader(c.photos, "Add photos"),
    textToOfficeBar(project, c),
    sectionTitle("Reported By"),
    field("Reported By", inp(c, "completedBy")),
    sigBlock(c, "signature", "completedBy", "signDate", "Signature"));
}

/* App-only bar to link a QB job + pull the whole job's hours into the Labor Log. */
function laborSyncBar(project, l, paint) {
  if (!qbConfigured()) return h("span", { class: "app-only" });
  const bar = h("div", { class: "app-only qb-bar" });
  const pullBtn = h("button", { type: "button", class: "btn btn--primary btn--sm" }, "⤓ Sync labor from QuickBooks");

  function render() {
    const linked = !!project.qbJobcodeId;
    const label = linked
      ? h("span", { class: "qb-linked" }, "🔗 QuickBooks: ", h("strong", {}, project.qbJobcodeName || project.qbJobcodeId))
      : h("span", { class: "subtle" }, "Not linked to a QuickBooks job");
    const linkBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, linked ? "Change" : "Link QuickBooks job");
    linkBtn.addEventListener("click", async () => { const p = await pickJobcode(project); if (p) { commit(); render(); } });
    bar.replaceChildren(
      h("div", { class: "qb-bar__row" }, label, linkBtn),
      h("div", { class: "qb-bar__row" }, pullBtn,
        h("span", { class: "subtle qb-hint" }, "Pulls every hour logged to this job, up to today.")));
  }

  pullBtn.addEventListener("click", async () => {
    if (!project.qbJobcodeId) { const p = await pickJobcode(project); if (!p || !project.qbJobcodeId) return; commit(); render(); }
    pullBtn.disabled = true;
    const prev = pullBtn.textContent;
    pullBtn.textContent = "Syncing…";
    try {
      const start = project.dateOfLoss || new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      await qbPullRange(project.qbJobcodeId, start, todayISO(), project.id);   // backfill time_entries
      const entries = await qbAllEntriesFor(project);
      l.entries = entries.map((e) => ({ date: e.date, employee: e.employee, start: e.start, finish: e.finish, hours: e.hours, service: e.service || "", note: e.note || "", task: e.task, qbId: e.qbTimesheetId }));
      l.syncedAt = new Date().toISOString();
      paint(); commit();
      toast(l.entries.length ? `Synced ${l.entries.length} labor entr${l.entries.length === 1 ? "y" : "ies"}.` : "No QuickBooks hours found for this job.");
    } catch (e) { toast(e.message || "QuickBooks sync failed"); }
    finally { pullBtn.disabled = false; pullBtn.textContent = prev; }
  });

  render();
  return bar;
}

/* Tidy the QB Time "Service Item" for display: keep the most specific part and
   drop the redundant "Labor (In-House):" / "Labor -" prefix + trailing class tag.
   e.g. "Labor (In-House):Labor - Cabinetry / Millwork" -> "Cabinetry / Millwork". */
function cleanService(s) {
  if (!s) return "";
  let out = String(s);
  if (out.includes(":")) out = out.slice(out.lastIndexOf(":") + 1);   // most specific part
  out = out.replace(/^\s*labor\s*[-—:]\s*/i, "");                     // drop leading "Labor - "
  out = out.replace(/\s*[-—]\s*\([^)]*\)\s*$/, "");                   // drop trailing " - (Construction)"
  return out.trim() || String(s);                                    // never blank
}

/* ============================================================
   LABOR LOG — one-page whole-job time & labor detail from QuickBooks Time.
   Replaces the daily construction logs in the insurance packet.
   ============================================================ */
export function laborLog(project, l) {
  if (!Array.isArray(l.entries)) l.entries = [];
  let editing = false;
  // reconstruction phase: only count hours on/after the start date (mitigation
  // hours before it stay stored, just excluded from this log's totals + print)
  const inScope = (e) => !l.startDate || String(e.date || "") >= l.startDate;
  const ro = (v) => h("div", { style: "font-weight:600;padding:2px 0" }, v);
  const tbody = h("tbody");
  const totalEl = h("strong", {}, "0.00");
  const summaryEl = h("div", { class: "grid3" });
  const empEl = h("div", { class: "subtle", style: "font-size:12px;margin-top:4px;line-height:1.9" });

  // Summary + totals only (no table rebuild) — safe to call while typing in an edit cell.
  function paintSummary() {
    const entries = l.entries.filter(inScope);
    const excluded = l.entries.length - entries.length;
    const total = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
    totalEl.textContent = total.toFixed(2);
    const dates = entries.map((e) => e.date).filter(Boolean).sort();
    const range = dates.length ? fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length - 1]) : "—";
    const byEmp = {};
    entries.forEach((e) => { const k = e.employee || "—"; byEmp[k] = (byEmp[k] || 0) + (Number(e.hours) || 0); });
    summaryEl.replaceChildren(
      field("Total Man-Hours", ro(total.toFixed(2))),
      field("Date Range", ro(range)),
      field("Crew on Job", ro(String(Object.keys(byEmp).length || "—"))),
      ...(l.startDate ? [field("Counting From", ro(fmtDate(l.startDate) + (excluded ? ` (${excluded} earlier entr${excluded === 1 ? "y" : "ies"} excluded)` : "")))] : []));
    empEl.replaceChildren(...Object.entries(byEmp).sort((a, b) => b[1] - a[1]).map(([n, hh]) =>
      h("span", { style: "margin-right:16px;white-space:nowrap" }, h("strong", {}, n), " " + hh.toFixed(2) + "h")));
  }

  const readRow = (e) => h("tr", {},
    h("td", {}, fmtDate(e.date)),
    h("td", {}, e.employee || "—"),
    h("td", {}, e.start || "—"),
    h("td", {}, e.finish || "—"),
    h("td", { style: "text-align:right" }, (Number(e.hours) || 0).toFixed(2)),
    h("td", {}, cleanService(e.service) || e.task || ""),
    h("td", {}, e.note || ""));

  function editRow(e, i) {
    const cell = (key, w, type, display) => {
      const td = h("td");
      const input = h("input", { type: type || "text", value: display != null ? display : (e[key] ?? ""), style: "width:100%;min-width:" + w });
      input.addEventListener("input", () => { e[key] = input.value; paintSummary(); commit(); });
      td.append(input); return td;
    };
    return h("tr", {},
      cell("date", "118px", "date"),
      cell("employee", "104px"),
      cell("start", "60px"),
      cell("finish", "60px"),
      cell("hours", "52px", "number"),
      cell("service", "130px", "text", cleanService(e.service) || e.task || ""),
      taCell(e, "note", { minWidth: "140px" }),
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { l.entries.splice(i, 1); paintRows(); paintSummary(); commit(); } }, "✕")));
  }

  function paintRows() {
    // read mode shows only in-scope hours (that's what prints); edit mode
    // shows everything so dates can be corrected
    const entries = editing ? l.entries : l.entries.filter(inScope);
    if (!entries.length && !editing) {
      tbody.replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "subtle", style: "text-align:center;padding:8px" },
        "No hours synced yet — link the QuickBooks job and tap Sync.")));
      return;
    }
    tbody.replaceChildren(...entries.map((e, i) => editing ? editRow(e, i) : readRow(e)));
    if (!editing && !entries.length && l.entries.length)
      tbody.replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "subtle", style: "text-align:center;padding:8px" },
        "All synced hours are before the start date — adjust “Count labor from” or sync newer days.")));
  }
  const paint = () => { paintSummary(); paintRows(); };
  paint();

  const editBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only" }, "✎ Edit");
  const addBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add", style: "display:none" }, "+ Add labor row");
  editBtn.addEventListener("click", () => {
    editing = !editing;
    editBtn.textContent = editing ? "✓ Done" : "✎ Edit";
    editBtn.classList.toggle("active", editing);
    addBtn.style.display = editing ? "" : "none";
    paintRows();
  });
  addBtn.addEventListener("click", () => {
    l.entries.push({ date: todayISO(), employee: "", start: "", finish: "", hours: 0, service: "", note: "", manual: true });
    paintRows(); paintSummary(); commit();
  });
  const detailBar = h("div", { class: "app-only", style: "display:flex;gap:8px;align-items:center;margin-bottom:8px" },
    editBtn, h("span", { class: "subtle", style: "font-size:12px" }, "Adjust a synced entry or add one by hand."));

  return sheet("LABOR LOG", "Time & Labor Detail — per QuickBooks Time", "Labor Log",
    jobInfo(project, ["customer", "address", "claimNo", "workOrderNo"]),
    laborSyncBar(project, l, paint),
    l.syncedAt ? h("p", { class: "subtle app-only", style: "font-size:12px" }, "Last synced " + fmtDate(l.syncedAt.slice(0, 10))) : null,
    h("div", { class: "app-only" },
      field("Count labor from (start date)", inp(l, "startDate", { type: "date", oninput: paint }),
        "Reconstruction phase: hours before this date (the mitigation work) are excluded from this log")),
    sectionTitle("Summary"),
    summaryEl,
    empEl,
    sectionTitle("Labor Detail"),
    detailBar,
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Date", "Employee", "In", "Out", "Hrs", "Service", "Note"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addBtn,
    h("div", { class: "totals" }, h("div", { class: "trow grand" }, h("span", {}, "Total Man-Hours"), totalEl)));
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
    tr.append(taCell(r, "material", { minWidth: "150px" }), taCell(r, "meter", { minWidth: "120px" }), mk("goal", "60px"), mk("final", "60px"), mk("reference", "70px"), dryTd,
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
/* Xactimate-style charges editor: line items grouped into room / section
   blocks with continuous line numbering, a wide description column and
   compact qty / unit / price columns — the way adjusters read estimates. */
function invoiceCharges(inv, onTotals) {
  const tbody = h("tbody");

  function recalc() {
    let subtotal = 0;
    for (const it of inv.items) subtotal += (Number(it.qty) || 0) * (Number(it.price) || 0);
    onTotals(subtotal);
  }

  // items stay one flat array; blocks are derived from each line's room,
  // in first-appearance order (matches how Xactimate walks the sketch)
  function sections() {
    const order = [], by = new Map();
    for (const it of inv.items) {
      const key = (it.room || "").trim();
      if (!by.has(key)) { by.set(key, []); order.push(key); }
      by.get(key).push(it);
    }
    return order.map((key) => ({ key, items: by.get(key) }));
  }

  function itemRow(it, no) {
    const tr = h("tr");
    const cell = (key, cls, type = "text") => {
      const input = h("input", { type, value: it[key] ?? "" });
      input.addEventListener("input", () => { it[key] = input.value; extEl.textContent = money((Number(it.qty) || 0) * (Number(it.price) || 0)); recalc(); commit(); });
      return h("td", { class: cls || "" }, input);
    };
    // Description: an auto-growing textarea on screen (never clips what you
    // type) + a print-only div that wraps the full text on paper.
    const dTa = h("textarea", { class: "invdesc-ta app-only", rows: "1" });
    dTa.value = it.desc ?? "";
    const dPrint = h("div", { class: "invdesc-print print-only" }, it.desc ?? "");
    const grow = () => { dTa.style.height = "auto"; dTa.style.height = Math.max(38, dTa.scrollHeight) + "px"; };
    dTa.addEventListener("input", () => { it.desc = dTa.value; dPrint.textContent = dTa.value; grow(); commit(); });
    requestAnimationFrame(grow);
    const extEl = h("td", { class: "ext calc" }, money((Number(it.qty) || 0) * (Number(it.price) || 0)));
    tr.append(
      h("td", { class: "lineno" }, String(no) + "."),
      h("td", { class: "invdesc" }, dTa, dPrint),
      cell("qty", "", "number"),
      cell("unit"),
      cell("price", "", "number"),
      extEl,
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { inv.items.splice(inv.items.indexOf(it), 1); paint(); recalc(); commit(); } }, "✕")));
    return tr;
  }

  function paint() {
    tbody.replaceChildren();
    let no = 0;
    for (const sec of sections()) {
      const name = h("input", { value: sec.key, placeholder: "Room / section (e.g. Living Room)" });
      // defer the repaint: 'change' fires during blur, and rebuilding the tbody
      // while the browser is mid-blur on this input throws
      name.addEventListener("change", () => { const v = name.value; sec.items.forEach((x) => { x.room = v; }); commit(); setTimeout(paint, 0); });
      const addLine = h("button", { type: "button", class: "btn btn--sm app-only", style: "width:auto;min-height:32px;padding:0 10px" }, "+ line");
      addLine.addEventListener("click", () => {
        const at = inv.items.indexOf(sec.items[sec.items.length - 1]) + 1;
        inv.items.splice(at, 0, { ...blankLineItem(), room: sec.key });
        commit(); paint();
      });
      // move the whole room/phase block up or down in the scope of work
      const moveSec = (dir) => {
        const secs = sections();
        const idx = secs.findIndex((x) => x.key === sec.key);
        const j = idx + dir;
        if (j < 0 || j >= secs.length) return;
        const blocks = secs.map((x) => x.items);
        [blocks[idx], blocks[j]] = [blocks[j], blocks[idx]];
        inv.items = blocks.flat();
        commit(); paint(); recalc();
      };
      const mkMove = (glyph, dir, title) => {
        const b = h("button", { type: "button", class: "btn btn--sm app-only", style: "width:auto;min-height:32px;padding:0 9px", title }, glyph);
        b.addEventListener("click", () => moveSec(dir));
        return b;
      };
      tbody.append(h("tr", { class: "invsec" },
        h("td", { colspan: "7" }, h("div", { class: "invsec__row" }, name,
          mkMove("▲", -1, "Move this section up"), mkMove("▼", 1, "Move this section down"), addLine))));
      for (const it of sec.items) tbody.append(itemRow(it, ++no));
    }
  }
  paint();
  recalc();

  const addSection = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only", style: "width:auto;margin-top:6px" }, "+ Add room / section");
  addSection.addEventListener("click", () => {
    inv.items.push({ ...blankLineItem(), room: "New room" });
    commit(); paint(); recalc();
  });

  return h("div", {},
    h("div", { class: "tablewrap" },
      h("table", { class: "grid grid--inv" },
        h("colgroup", {},
          h("col", { style: "width:30px" }), h("col", {}), h("col", { style: "width:52px" }),
          h("col", { style: "width:46px" }), h("col", { style: "width:72px" }),
          h("col", { style: "width:84px" }), h("col", { class: "app-only", style: "width:32px" })),
        h("thead", {}, h("tr", {},
          h("th", {}, "#"), h("th", { class: "invdesc" }, "Description"), h("th", {}, "Qty"),
          h("th", {}, "Unit"), h("th", {}, "Unit Price"), h("th", {}, "Total"), h("th", { class: "app-only" }, ""))),
        tbody)),
    addSection);
}

export function invoice(project, inv) {
  const subEl = h("span", {}, money(0));
  const ohEl = h("span", {}, money(0));
  const pfEl = h("span", {}, money(0));
  const rcvEl = h("span", {}, money(0));
  const taxEl = h("span", {}, money(0));
  const totalEl = h("span", {}, money(0));
  const recapEl = h("div", { class: "invrecap" });
  let subtotal = 0;
  function paintRecap() {
    // Xactimate's "Recap by Room": each area's share of the line item total
    const order = [], by = new Map();
    for (const it of inv.items || []) {
      const ext = (Number(it.qty) || 0) * (Number(it.price) || 0);
      if (!ext) continue;
      const key = (it.room || "").trim() || "Main Level";
      if (!by.has(key)) { by.set(key, 0); order.push(key); }
      by.set(key, by.get(key) + ext);
    }
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    if (order.length < 2 || !total) { recapEl.replaceChildren(); recapEl.hidden = true; return; }
    recapEl.hidden = false;
    recapEl.replaceChildren(
      h("div", { class: "invrecap__title" }, "Recap by Room"),
      ...order.map((key) => h("div", { class: "invrecap__row" },
        h("span", {}, key),
        h("span", { class: "invrecap__amt" }, money(by.get(key))),
        h("span", { class: "invrecap__pct" }, ((by.get(key) / total) * 100).toFixed(2) + "%"))),
      h("div", { class: "invrecap__row invrecap__row--total" },
        h("span", {}, "Total"),
        h("span", { class: "invrecap__amt" }, money(total)),
        h("span", { class: "invrecap__pct" }, "100.00%")));
  }
  if (!inv.billingModel) inv.billingModel = "tm";
  const isContract = () => inv.billingModel === "contract";
  function recalc(sub) {
    if (sub != null) subtotal = sub;
    subEl.textContent = money(subtotal);
    // T&M: Line Item Total + O&P = RCV.  Contract: the agreed amount IS the
    // total (O&P is inside the contract figure), items are the scope of work.
    const contract = isContract();
    const base = contract ? (Number(inv.contractAmount) || 0) : subtotal;
    const oh = contract ? 0 : subtotal * ((Number(inv.overheadPct) || 0) / 100);
    const pf = contract ? 0 : subtotal * ((Number(inv.profitPct) || 0) / 100);
    ohEl.textContent = money(oh);
    pfEl.textContent = money(pf);
    const rcv = base + oh + pf;
    rcvEl.textContent = money(rcv);
    const tax = base * ((Number(inv.taxRate) || 0) / 100);
    taxEl.textContent = money(tax);
    const total = rcv - (Number(inv.deductible) || 0) - (Number(inv.previousPayments) || 0) + tax;
    totalEl.textContent = money(total);
    paintRecap();
  }
  const lossTa = ta(inv, "lossSummary");
  const itemsWrap = h("div", {});
  function paintItems() {
    itemsWrap.replaceChildren(invoiceCharges(inv, (s) => recalc(s)));
  }
  paintItems();

  /* ---- AI: draft the invoice from the documented job / audit for missed items.
     Online-only enhancements (same rules as voice) — the typed invoice always works. ---- */
  const aiPanel = h("div", { class: "app-only" });
  const busyBtn = (btn, on, label) => { btn.disabled = on; btn.textContent = label; };

  const draftBtn = h("button", { type: "button", class: "btn btn--sm" }, "\u2728 Draft from documentation");
  draftBtn.addEventListener("click", async () => {
    if (!aiAvailable()) return;
    const hasItems = (inv.items || []).some((it) => String(it.desc || "").trim());
    if (hasItems && !window.confirm("Replace the current line items with an AI draft built from the job documentation?")) return;
    busyBtn(draftBtn, true, "\u2728 Drafting\u2026");
    try {
      const draft = await draftInvoice(project);
      const lines = Array.isArray(draft.items) ? draft.items : [];
      if (draft.lossSummary) { inv.lossSummary = draft.lossSummary; lossTa.value = inv.lossSummary; }
      inv.items = lines.map((li) => ({
        room: li.room || "", desc: li.desc || "", qty: li.qty != null ? String(li.qty) : "",
        unit: li.unit || "", price: li.price != null ? String(li.price) : "",
      }));
      if (!inv.items.length) inv.items = [blankLineItem()];
      commit(); paintItems();
      aiPanel.replaceChildren(
        h("div", { style: "border:1px dashed #b9c4d4;border-radius:10px;padding:8px 12px;margin:0 0 10px;background:#f7f9fc;font-size:12px" },
          h("strong", {}, "\u2728 Draft basis \u2014 review every line before sending:"),
          ...lines.map((li) => h("div", { style: "margin-top:4px;color:#5a6b7f" },
            h("strong", { style: "color:#2b3a4d" }, li.desc || ""), li.basis ? " \u2014 " + li.basis : ""))));
      toast("Invoice draft ready \u2014 every line is editable.");
    } catch (e) {
      toast("AI draft failed: " + (e && e.message ? e.message : e));
    }
    busyBtn(draftBtn, false, "\u2728 Draft from documentation");
  });

  const auditBtn = h("button", { type: "button", class: "btn btn--sm" }, "\ud83d\udd0e Find missed items");
  auditBtn.addEventListener("click", async () => {
    if (!aiAvailable()) return;
    busyBtn(auditBtn, true, "\ud83d\udd0e Auditing\u2026");
    try {
      const suggestions = await auditInvoice(project, inv);
      if (!suggestions.length) {
        aiPanel.replaceChildren(h("p", { class: "subtle", style: "font-size:12px" },
          "\u2728 No missed items found \u2014 everything documented appears to be billed."));
      } else {
        const rows = suggestions.map((sug) => {
          const add = h("button", { type: "button", class: "btn btn--sm" }, "+ Add");
          const row = h("div", { style: "display:flex;gap:8px;align-items:flex-start;margin-top:6px" },
            h("div", { style: "flex:1;font-size:12px" },
              h("strong", { style: "color:#2b3a4d" }, sug.desc || ""),
              ` \u2014 ${sug.qty} ${sug.unit} @ $${Number(sug.price || 0).toFixed(2)}`,
              h("div", { style: "color:#5a6b7f" }, sug.reason || "")),
            add);
          add.addEventListener("click", () => {
            inv.items.push({ room: sug.room || "", desc: sug.desc || "", qty: String(sug.qty ?? ""), unit: sug.unit || "", price: sug.price != null ? String(sug.price) : "" });
            commit(); paintItems(); row.remove();
          });
          return row;
        });
        aiPanel.replaceChildren(
          h("div", { style: "border:1px dashed #b9c4d4;border-radius:10px;padding:8px 12px;margin:0 0 10px;background:#f7f9fc" },
            h("strong", { style: "font-size:12px" }, `\u2728 ${suggestions.length} potentially missed item${suggestions.length !== 1 ? "s" : ""} \u2014 each cites its documentation:`),
            ...rows));
      }
    } catch (e) {
      toast("AI audit failed: " + (e && e.message ? e.message : e));
    }
    busyBtn(auditBtn, false, "\ud83d\udd0e Find missed items");
  });

  /* ---- Push to QuickBooks Online (separate office connection; see admin) ---- */
  const qboStatusEl = h("span", { class: "subtle", style: "font-size:12px;align-self:center" },
    inv.qboSyncedAt ? `In QuickBooks as ${inv.qboDocNumber || "invoice"} \u00b7 ${fmtDate(inv.qboSyncedAt.slice(0, 10))}` : "");
  const qboBtn = h("button", { type: "button", class: "btn btn--sm" },
    inv.qboInvoiceId ? "\u2b06\ufe0f Update in QuickBooks" : "\u2b06\ufe0f Push to QuickBooks");
  qboBtn.addEventListener("click", async () => {
    if (!(inv.items || []).some((it) => String(it.desc || "").trim())) return toast("Add line items first.");
    busyBtn(qboBtn, true, "\u2b06\ufe0f Pushing\u2026");
    try {
      const r = await pushInvoiceToQbo(project, inv);
      commit();
      qboStatusEl.textContent = `In QuickBooks as ${r.docNumber} \u00b7 $${Number(r.total || 0).toFixed(2)}`;
      toast((r.updated ? "Updated" : "Created") + " QuickBooks invoice " + r.docNumber + ".");
    } catch (e) {
      toast("QuickBooks push failed: " + (e && e.message ? e.message : e));
    }
    busyBtn(qboBtn, false, inv.qboInvoiceId ? "\u2b06\ufe0f Update in QuickBooks" : "\u2b06\ufe0f Push to QuickBooks");
  });

  const aiBar = h("div", { class: "app-only", style: "display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px" }, draftBtn, auditBtn, qboBtn, qboStatusEl);

  /* ---- supporting documents: receipts, sub invoices, dump tickets…
     Attached PDFs/photos become full pages after the invoice when printed. ---- */
  if (!Array.isArray(inv.attachments)) inv.attachments = [];
  const attachSheets = h("div");
  const attachList = h("div");
  function paintAttachSheets() {
    attachSheets.replaceChildren(...inv.attachments.flatMap((att) =>
      uploadedDocSheet(att.pages || [], "Supporting Documentation" + (att.label ? " — " + att.label : ""))));
  }
  function paintAttachList() {
    attachNote.hidden = !inv.attachments.length;
    attachList.replaceChildren(...inv.attachments.map((att, i) => {
      const label = h("input", { value: att.label || "", placeholder: "Label (e.g. Dump receipt 6/21)", style: "flex:1" });
      label.addEventListener("input", () => { att.label = label.value; commit(); });
      label.addEventListener("change", () => paintAttachSheets());
      const del = h("button", { type: "button", class: "btn btn--danger btn--sm", style: "width:auto" }, "Remove");
      del.addEventListener("click", () => {
        if (!confirm("Remove this attachment from the invoice?")) return;
        inv.attachments.splice(i, 1); commit(); paintAttachList(); paintAttachSheets();
      });
      return h("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" },
        h("span", {}, "📎"), label,
        h("span", { class: "subtle", style: "font-size:12px;white-space:nowrap" }, (att.pages || []).length + " pg"),
        del);
    }));
  }
  const attachNote = h("div", { class: "print-only", style: "font-size:9pt;margin:2px 0" },
    "Supporting documentation attached: see following page(s).");
  const attachInput = h("input", { type: "file", accept: "image/*,application/pdf", multiple: true, style: "display:none" });
  const attachBtn = h("button", { type: "button", class: "btn btn--sm", style: "width:auto;margin-top:8px" }, "📎 Attach PDF / photo");
  attachInput.addEventListener("change", async () => {
    attachBtn.disabled = true; const t = attachBtn.textContent; attachBtn.textContent = "📎 Reading…";
    for (const f of attachInput.files) {
      try {
        const pages = await fileToDocPages(f);
        inv.attachments.push({ label: (f.name || "").replace(/\.[^.]+$/, ""), pages });
      } catch { toast("Couldn't read " + (f.name || "that file") + " — try a PDF or photo."); }
    }
    attachInput.value = ""; attachBtn.disabled = false; attachBtn.textContent = t;
    commit(); paintAttachList(); paintAttachSheets();
  });
  attachBtn.addEventListener("click", () => attachInput.click());
  paintAttachList(); paintAttachSheets();

  /* ---- totals: rows switch with the billing model ---- */
  const trow = (label, right, cls) => h("div", { class: "trow" + (cls ? " " + cls : "") }, h("span", {}, label), right);
  const subRow = trow("Line Item Total", subEl);
  const contractRow = trow("Contract Amount", inp(inv, "contractAmount", { type: "number", oninput: () => recalc() }));
  const ohPctRow = trow("Overhead %", inp(inv, "overheadPct", { type: "number", oninput: () => recalc() }));
  const ohRow = trow("Overhead", ohEl);
  const pfPctRow = trow("Profit %", inp(inv, "profitPct", { type: "number", oninput: () => recalc() }));
  const pfRow = trow("Profit", pfEl);
  const rcvLabel = h("span", {}, "Replacement Cost Value");
  const rcvRow = h("div", { class: "trow rcv" }, rcvLabel, rcvEl);
  const totalsBox = h("div", { class: "totals" },
    subRow, contractRow, ohPctRow, ohRow, pfPctRow, pfRow, rcvRow,
    trow("Less: Deductible / Non-Recoverable", inp(inv, "deductible", { type: "number", oninput: () => recalc() })),
    trow("Less: Previous Payments", inp(inv, "previousPayments", { type: "number", oninput: () => recalc() })),
    trow("Sales Tax %", inp(inv, "taxRate", { type: "number", oninput: () => recalc() })),
    trow("Sales Tax", taxEl),
    trow("Total Due", totalEl, "grand"));
  function paintMode() {
    const c = isContract();
    contractRow.hidden = !c;
    ohPctRow.hidden = ohRow.hidden = pfPctRow.hidden = pfRow.hidden = c;
    subRow.hidden = c && !(inv.items || []).some((it) => (Number(it.qty) || 0) * (Number(it.price) || 0) > 0);
    rcvLabel.textContent = c ? "Contract Total" : "Replacement Cost Value";
  }
  const modeSeg = seg(inv, "billingModel", [
    { value: "tm", label: "Time & Materials" },
    { value: "contract", label: "Contract (set amount)" },
  ], { onchange: () => { paintMode(); recalc(); } });
  paintMode();

  const invoiceSheet = sheet("CONSTRUCTION INVOICE", "Mitigation & Reconstruction Services | IICRC S500 Compliant", "Construction Invoice",
    h("div", { class: "grid2" },
      field("Invoice #", inp(inv, "invoiceNo")),
      field("Invoice Date", inp(inv, "invoiceDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Due Date", inp(inv, "dueDate", { type: "date" })),
      field("Payment Terms", inp(inv, "terms"))),
    sectionTitle("Bill To / Insured & Claim"),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    jobInfo(project, ["carrier", "claimNo", "dateOfLoss", "adjuster"]),
    field("Loss Description / Scope Summary", lossTa),
    sectionTitle("Charges"),
    h("div", { class: "app-only" }, field("Billing model", modeSeg)),
    aiBar,
    aiPanel,
    itemsWrap,
    totalsBox,
    recapEl,
    field("Notes / Supporting Documentation", ta(inv, "notes")),
    h("div", { class: "app-only", style: "margin:4px 0 10px" },
      h("div", { class: "subtle", style: "font-size:12px" },
        "Attach receipts, subcontractor invoices or other supporting documents — each prints as its own page after the invoice."),
      attachList, attachBtn, attachInput),
    attachNote,
    h("div", { class: "remit print-only" },
      h("strong", {}, "Remit to: Roybal Construction, LLC"),
      h("div", {}, "2170 Chateau Court, North Pole, AK 99705"),
      h("div", {}, "Phone: 907-371-9868 · branden@roybalconstruction.com"),
      h("div", {}, "Methods: Check, ACH, or credit card on request")));

  return h("div", {}, invoiceSheet, attachSheets);
}

/* ============================================================
   8. JOB PHOTOS — project-level gallery + printable Photo Report
   ============================================================ */
export function photosForm(project) {
  if (!Array.isArray(project.photos)) project.photos = [];
  const grid = h("div", { class: "photogrid" });

  const refreshers = new Map();               // photo.id -> refresh that card in place

  function card(p, i) {
    const cap = h("input", { value: p.caption || "", placeholder: "Caption" });
    cap.addEventListener("input", () => { p.caption = cap.value; refresh(); commit(); });
    const room = h("input", { value: p.room || "", placeholder: "Room / location" });
    room.addEventListener("input", () => { p.room = room.value; refresh(); commit(); });
    const stage = sel(p, "stage", [
      { value: "before", label: "Before" }, { value: "during", label: "During" }, { value: "after", label: "After" }]);
    stage.addEventListener("change", () => refresh());
    const del = h("button", { type: "button", class: "btn btn--danger btn--sm", onclick: () => { refreshers.delete(p.id); project.photos.splice(i, 1); paint(); commit(); } }, "Delete");
    const printCap = h("div", { class: "photocap print-only" });
    /* The AI findings under the photo are EDITABLE — reword or delete
       anything the analysis got wrong (stored as p.aiNote; an emptied note
       stays empty). Edits also flow into the AI narrative/invoice facts. */
    const aiLine = h("textarea", { class: "app-only ainote", rows: "2" });
    aiLine.addEventListener("input", () => { p.aiNote = aiLine.value; commit(); });

    /* Refresh this card in place. The inputs are never replaced, so AI
       results landing in the background can't steal focus (or the phone
       keyboard) mid-edit, and fields only sync from the model while they
       aren't the field being typed in. */
    function refresh() {
      if (document.activeElement !== cap) cap.value = p.caption || "";
      printCap.replaceChildren(
        [p.stage ? p.stage.toUpperCase() : "", p.room, p.caption].filter(Boolean).join(" \u00b7 "), " ",
        h("span", { class: "photometa" }, fmtDate((p.ts || "").slice(0, 10))));
      const bits = p.ai ? [
        p.ai.damage && p.ai.damage.length ? "Damage: " + p.ai.damage.join("; ") : "",
        p.ai.safety && p.ai.safety.length ? "\u26a0 " + p.ai.safety.join("; ") : "",
      ].filter(Boolean).join(" \u00b7 ") : "";
      const shown = p.aiNote != null ? p.aiNote : (bits ? "\u2728 " + bits : "");
      if (document.activeElement !== aiLine) aiLine.value = shown;
      aiLine.hidden = !p.ai && p.aiNote == null;
    }
    refreshers.set(p.id, refresh);
    refresh();
    return h("div", { class: "photocard" },
      h("img", { src: p.src, alt: p.caption || "" }),
      printCap,
      h("div", { class: "app-only photoedit" }, room, stage, cap, del),
      aiLine);
  }
  function paint() {
    refreshers.clear();
    grid.replaceChildren(...project.photos.map(card));
    if (!project.photos.length) grid.append(h("p", { class: "subtle app-only" }, "No photos yet \u2014 tap \u201cAdd photos.\u201d"));
  }

  /* AI photo analysis — captions + visible damage/materials/safety. Online-only
     enhancement: auto-runs on newly added photos when signed in + online, and the
     catch-up button covers anything captured offline. Never blocks manual entry. */
  const aiBtn = h("button", { type: "button", class: "btn btn--sm", style: "margin-left:8px" }, "");
  const pendingAi = () => project.photos.filter((p) => p.src && !p.ai);
  let aiBusy = false;
  function paintAiBtn() {
    const n = pendingAi().length;
    aiBtn.hidden = !n || aiBusy;
    if (!aiBusy) aiBtn.textContent = `\u2728 AI captions (${n})`;
  }
  async function runAi(targets, { silent = false } = {}) {
    if (aiBusy || !targets.length) return;
    if (silent ? !aiReady() : !aiAvailable()) return;
    aiBusy = true;
    aiBtn.hidden = false; aiBtn.disabled = true; aiBtn.textContent = "\u2728 Analyzing\u2026";
    try {
      for (let i = 0; i < targets.length; i += 10) {
        const results = await analyzePhotos(project, targets.slice(i, i + 10));
        for (const r of results) {
          if (!r.ok || !r.analysis) continue;
          const ph = project.photos.find((x) => x.id === r.id);
          if (!ph) continue;
          applyPhotoAnalysis(ph, r.analysis);
          const refresh = refreshers.get(ph.id);
          if (refresh) refresh();               // update that card in place — no grid repaint
        }
        commit();
      }
    } catch (e) {
      if (!silent) toast("AI photo analysis failed: " + (e && e.message ? e.message : e));
    }
    aiBusy = false; aiBtn.disabled = false;
    paintAiBtn();
  }
  aiBtn.addEventListener("click", () => runAi(pendingAi()));

  const input = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: "display:none" });
  input.addEventListener("change", async () => {
    const added = [];
    for (const f of input.files) { const ph = newPhoto(); ph.src = await fileToDataURL(f); project.photos.push(ph); added.push(ph); }
    input.value = ""; commit(); paint(); paintAiBtn();
    runAi(added, { silent: true });          // fire-and-forget; typed captions still work offline
  });
  const addBtn = h("button", { type: "button", class: "btn btn--primary" }, "📷 Add photos");
  addBtn.addEventListener("click", () => input.click());
  paint();
  paintAiBtn();

  return sheet("PHOTO REPORT", "Job Site Documentation", "Photo Report",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    h("div", { class: "app-only", style: "margin:10px 0" }, addBtn, aiBtn, input),
    grid);
}

/* ============================================================
   9. CONTENTS INVENTORY — printable report (read-only)
   Editing happens in the dedicated Contents manager (app.js).
   ============================================================ */
export function contentsReport(project) {
  const items = project.contents || [];
  const boxes = project.boxes || [];
  const boxLabel = (it) => it.noBox ? ("Loose" + (it.destination ? " — " + it.destination : "")) : (boxes.find((b) => b.id === it.boxId)?.label || "");
  const ext = (it) => (Number(it.value) || 0) * (Number(it.qty) || 1);

  const invRows = items.map((it) =>
    h("tr", {},
      h("td", {}, it.photos && it.photos[0] ? h("img", { src: it.photos[0], class: "cthumb", alt: "" }) : ""),
      h("td", { style: "text-align:left" }, it.name || "—", it.brand || it.model ? h("div", { class: "csub" }, [it.brand, it.model].filter(Boolean).join(" ")) : null),
      h("td", {}, it.qty || ""),
      h("td", {}, it.room || ""),
      h("td", {}, boxLabel(it)),
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
      h("td", { style: "text-align:left" }, it.name || "—",
        it.lossJust ? h("div", { class: "csub" }, it.lossJust) : null),
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
  const boxLabel = (it) => it.noBox ? ("Loose" + (it.destination ? " — " + it.destination : "")) : (boxes.find((b) => b.id === it.boxId)?.label || "");
  const tbody = h("tbody");
  items.forEach((it) => {
    const tr = h("tr");
    const box = h("input", { type: "checkbox", checked: !!it.returned, style: "width:20px;height:20px" });
    box.addEventListener("change", () => { it.returned = box.checked; it.returnedDate = box.checked ? todayISO() : ""; commit(); });
    tr.append(
      h("td", { style: "text-align:left" }, it.name || "—"),
      h("td", {}, it.qty || ""),
      h("td", {}, it.room || ""),
      h("td", {}, boxLabel(it)),
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

/* ---------- FLOOR PLAN — uploaded dimensioned plan, printed FULL PAGE ----------
   The moisture map shrinks the plan to sketch size, which makes the printed
   dimensions unreadable. This form holds the ORIGINAL dimensioned plan
   (Xactimate / magicplan PDF or a photo); every page prints as its own full
   letter page in the single-form PDF and the job packet, so the adjuster can
   read each measurement and square footage. */
export function floorPlanSheet(project, fp) {
  /* ---- AI dimension takeoff: rooms / SF / LF read off the plan, reviewed
     and edited here, then available as quantities to every AI draft ---- */
  const dimsBox = h("div");
  const blankRoom = () => ({ name: "", dims: "", floorSF: "", perimLF: "", ceiling: "", notes: "", conf: 1 });
  function rooms() { return (fp.dimensions && Array.isArray(fp.dimensions.rooms)) ? fp.dimensions.rooms : []; }
  function paintDims() {
    dimsBox.replaceChildren();
    const list = rooms();
    if (!list.length) return;
    const totalEl = h("strong", {}, "");
    const totalLfEl = h("strong", {}, "");
    const recalc = () => {
      totalEl.textContent = Math.round(list.reduce((t, r) => t + (parseFloat(r.floorSF) || 0), 0)) + " SF";
      totalLfEl.textContent = Math.round(list.reduce((t, r) => t + (parseFloat(r.perimLF) || 0), 0)) + " LF";
    };
    const tbody = h("tbody");
    const paintRows = () => {
      tbody.replaceChildren(...list.map((r) => {
        const tr = h("tr", { class: Number(r.conf) < 0.7 ? "flag7" : "" });
        const actions = h("td", { class: "app-only", style: "white-space:nowrap" });
        if (Number(r.conf) < 0.7) {
          const ok = h("button", { type: "button", class: "rowdel", style: "color:var(--green)",
            title: "Confirm — I verified this room against the plan" }, "\u2713");
          ok.addEventListener("click", () => { r.conf = 1; commit(); paintRows(); });
          actions.append(ok);
        }
        actions.append(h("button", { type: "button", class: "rowdel",
          onclick: () => { list.splice(list.indexOf(r), 1); paintRows(); recalc(); commit(); } }, "\u2715"));
        tr.append(
          taCell(r, "name", { minWidth: "110px" }),
          boundCell(r, "dims", "100px"),
          boundCell(r, "floorSF", "56px", "text", recalc),
          boundCell(r, "perimLF", "56px", "text", recalc),
          boundCell(r, "ceiling", "48px"),
          taCell(r, "notes", { minWidth: "120px" }),
          actions);
        return tr;
      }));
    };
    paintRows(); recalc();
    const addRoom = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add room");
    addRoom.addEventListener("click", () => { list.push(blankRoom()); paintRows(); commit(); });
    dimsBox.append(
      sectionTitle("Room Dimensions (from the plan)"),
      h("p", { class: "subtle app-only" }, "AI-read from the uploaded plan — verify each line against the plan and edit anything off. Amber rows were computed rather than printed: tap \u2713 once you have checked them. These quantities feed the AI invoice, rebuild scope and the assistant."),
      h("div", { class: "tablewrap" },
        h("table", { class: "grid" },
          h("colgroup", {},
            h("col", {}), h("col", { style: "width:110px" }), h("col", { style: "width:64px" }),
            h("col", { style: "width:64px" }), h("col", { style: "width:56px" }), h("col", { style: "width:24%" }),
            h("col", { class: "app-only", style: "width:64px" })),
          h("thead", {}, h("tr", {},
            h("th", { class: "thleft" }, "Room / Area"), h("th", {}, "Dimensions"), h("th", {}, "Floor SF"),
            h("th", {}, "Perim. LF"), h("th", {}, "Ceiling"), h("th", { class: "thleft" }, "Notes"), h("th", { class: "app-only" }, ""))),
          tbody)),
      addRoom,
      h("div", { class: "totals" },
        h("div", { class: "trow" }, h("span", {}, "Total Floor Area"), totalEl),
        h("div", { class: "trow grand" }, h("span", {}, "Total Wall Perimeter"), totalLfEl)),
      fp.dimensions && Array.isArray(fp.dimensions.notes) && fp.dimensions.notes.length
        ? h("p", { class: "subtle app-only", style: "font-size:12px" }, "Plan notes: " + fp.dimensions.notes.join(" · ")) : null);
  }
  paintDims();

  const aiBar = h("div", { class: "app-only", style: "margin:10px 0" });
  function paintAi() {
    aiBar.replaceChildren();
    if (!uploadedDocPages(fp).length) return;
    const btn = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto" },
      rooms().length ? "↻ Re-read dimensions (AI)" : "✨ Read dimensions from the plan (AI)");
    const status = h("span", { class: "subtle", style: "font-size:12px;margin-left:8px" });
    btn.addEventListener("click", async () => {
      if (!aiAvailable()) return;
      btn.disabled = true; status.textContent = "Reading the plan…";
      try {
        const d = await extractPlanDimensions(project, uploadedDocPages(fp));
        fp.dimensions = {
          rooms: (d.rooms || []).map((r) => ({
            name: r.name || "", dims: r.dims || "",
            floorSF: r.floorSF ? String(r.floorSF) : "", perimLF: r.perimLF ? String(r.perimLF) : "",
            ceiling: r.ceiling || "", notes: r.notes || "", conf: Number(r.confidence) || 0,
          })),
          notes: Array.isArray(d.notes) ? d.notes : [],
          at: new Date().toISOString(),
        };
        commit();
        status.textContent = "";
        paintDims(); paintAi();
        toast(fp.dimensions.rooms.length ? `Read ${fp.dimensions.rooms.length} room(s) — verify against the plan.` : "Couldn't find printed dimensions on the plan.");
      } catch (e) {
        status.textContent = "";
        toast((e && e.message) || "Couldn't read the plan — try again.");
      }
      btn.disabled = false;
    });
    aiBar.append(btn, status);
  }
  paintAi();

  const upload = uploadDoc(fp, {
    blurb: "Upload the dimensioned plan — a PDF (every page comes in) or a photo. It prints FULL PAGE in the packet so the adjuster can read the room dimensions and square footages.",
    attachedNote: "each prints as its own full page in the packet.",
  });
  upload.addEventListener("docpageschange", paintAi);

  return sheet("FLOOR PLAN", "Dimensioned Plan — Room Sizes & Square Footages", "Floor Plan",
    sectionTitle("Job Information"),
    jobInfo(project, ["customer", "address", "claimNo", "dateOfLoss"]),
    sectionTitle("Dimensioned Floor Plan"),
    // management UI only — the plan itself prints as full pages after this sheet
    h("div", { class: "app-only" }, upload, aiBar),
    dimsBox);
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
  // classes (nb-*) instead of inline sizes so app.css / print.css keep the
  // narrative's type at the same size as every other form
  const nodes = []; let para = [], bullets = null;
  const flushP = () => { if (para.length) { nodes.push(h("p", { class: "nb-p" }, ...mdInline(para.join(" ")))); para = []; } };
  const flushB = () => { if (bullets) { nodes.push(h("ul", { class: "nb-ul" }, ...bullets)); bullets = null; } };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim(); let m;
    if (!line) { flushP(); flushB(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushP(); flushB(); nodes.push(h("h3", { class: "nb-h3" }, ...mdInline(m[1]))); }
    else if ((m = line.match(/^>\s?(.*)/))) { flushP(); flushB(); nodes.push(h("div", { class: "nb-note" }, ...mdInline(m[1]))); }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { flushP(); (bullets = bullets || []).push(h("li", {}, ...mdInline(m[1]))); }
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
    style: "padding:7px 10px;font-size:14px;" + (i >= 2 ? "border-top:1px solid #eef1f5;" : "")
      + (!full && i % 2 ? "border-left:1px solid #eef1f5;" : "") + (full ? "grid-column:1 / -1;" : ""),
  }, h("span", { style: "color:var(--orange,#f26a21);font-weight:700;font-size:12px" }, k + " "), h("span", {}, String(v)));
  const cells = infoRows.map(([k, v], i) => cell(k, v, i, false));
  if (lossRow) cells.push(cell("LOSS TYPE / CAUSE", lossRow[1], infoRows.length, true));
  const table = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;border:1px solid #e2e6ec;border-radius:8px;overflow:hidden;margin:12px 0" },
    ...cells);
  return h("section", { class: "sheet" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--navy,#0f1b2d);padding-bottom:8px" },
      h("div", {},
        h("div", { style: "font-weight:800;font-size:16px" },
          h("span", { style: "color:var(--orange,#f26a21)" }, "ROYBAL"),
          h("span", { style: "color:#000" }, " CONSTRUCTION, LLC")),
        h("div", { style: "color:#5b6470;font-size:12px" }, COMPANY.tagline)),
      h("div", { style: "text-align:right;color:#5b6470;font-size:11.5px;line-height:1.5" },
        h("div", {}, COMPANY.address), h("div", {}, COMPANY.phone + " • " + COMPANY.email))),
    h("div", { style: "text-align:center;margin:14px 0 2px" },
      h("h2", { style: "margin:0;color:var(--navy,#0f1b2d);font-size:20px;letter-spacing:.4px" }, "CONSTRUCTION / RECONSTRUCTION NARRATIVE"),
      h("div", { style: "color:#5b6470;font-size:13px;font-style:italic" }, "Scope Justification for Repair to Pre-Loss Condition — Per IICRC S500 & FNSB / IRC"),
      facts.job.carrier ? h("div", { style: "color:#5b6470;font-size:12px;margin-top:2px" }, `Prepared for ${facts.job.carrier} — Submitted with Estimate, Photo Report, Moisture Map & Certificate of Drying`) : null),
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

/* Progress update sheet (construction jobs) — letterhead + info + markdown body. */
export function progressSheet(project) {
  const infoRows = [
    ["OWNER", project.customer], ["PROPERTY", project.address],
    ["PROJECT TYPE", project.constructionType === "new_construction" ? "New Construction"
      : project.constructionType === "reconstruction" ? "Reconstruction" : "Remodel"],
    ["PROJECT / JOB ID", project.workOrderNo],
    project.carrier ? ["CARRIER / CLAIM", [project.carrier, project.claimNo].filter(Boolean).join(" — ")] : null,
    project.lender ? ["LENDER", project.lender] : null,
    ["TARGET COMPLETION", project.targetCompletion ? fmtDate(project.targetCompletion) : ""],
    ["UPDATE DATE", project.progressNarrativeDate || todayISO()],
  ].filter((r) => r && r[1] && String(r[1]).trim());
  const cell = (k, v, i) => h("div", {
    style: "padding:7px 10px;font-size:14px;" + (i >= 2 ? "border-top:1px solid #eef1f5;" : "") + (i % 2 ? "border-left:1px solid #eef1f5;" : ""),
  }, h("span", { style: "color:var(--orange,#f26a21);font-weight:700;font-size:12px" }, k + " "), h("span", {}, String(v)));
  return h("section", { class: "sheet" },
    letterhead("CONSTRUCTION PROGRESS UPDATE", "Owner / Carrier / Lender Status Summary"),
    h("div", { style: "display:grid;grid-template-columns:1fr 1fr;border:1px solid #e2e6ec;border-radius:8px;overflow:hidden;margin:12px 0" },
      ...infoRows.map(([k, v], i) => cell(k, v, i))),
    h("div", { class: "narrative-body" }, ...mdToNodes(project.progressNarrative || "")),
    h("div", { style: "margin-top:18px" },
      h("div", { style: "font-size:13px" }, "Respectfully submitted,"),
      h("div", { style: "font-weight:700;color:var(--navy,#0f1b2d);margin-top:8px" }, COMPANY.signatory),
      h("div", { style: "color:#5b6470;font-size:12px" }, COMPANY.signatoryTitle + " — " + COMPANY.name)),
    sheetFooter("Construction Progress Update"));
}

/* ---------- dispatch ---------- */
/* ============================================================
   CONSTRUCTION / REMODEL FORMS (jobType "construction")
   ============================================================ */

/* small cell builder shared by the construction tables */
function boundCell(r, key, w, type = "text", oninput) {
  const td = h("td");
  const input = h("input", { type, value: r[key] ?? "", style: w ? `min-width:${w}` : "" });
  input.addEventListener("input", () => { r[key] = input.value; oninput && oninput(input.value); commit(); });
  td.append(input);
  return td;
}
function delCell(arr, r, repaint) {
  return h("td", { class: "app-only" },
    h("button", { type: "button", class: "rowdel", onclick: () => { arr.splice(arr.indexOf(r), 1); repaint(); commit(); } }, "✕"));
}

/* ---------- 8a. SCOPE OF WORK ---------- */
export function scopeOfWork(project, s) {
  const areasWrap = h("div");
  function areaBlock(area) {
    const tbody = h("tbody");
    function row(it) {
      const tr = h("tr");
      const tradeTd = h("td");
      tradeTd.append(sel(it, "trade", TRADES, { placeholder: "Trade…" }));
      tr.append(tradeTd,
        taCell(it, "desc", { minWidth: "200px" }),
        boundCell(it, "qty", "44px"),
        boundCell(it, "unit", "40px"),
        taCell(it, "notes", { minWidth: "120px" }),
        delCell(area.items, it, paintRows));
      return tr;
    }
    function paintRows() { tbody.replaceChildren(...area.items.map(row)); }
    paintRows();
    const addItem = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add line item");
    addItem.addEventListener("click", () => { area.items.push(blankScopeItem()); paintRows(); commit(); });
    const delArea = h("button", { type: "button", class: "btn btn--danger btn--sm app-only", style: "width:auto" }, "Delete area");
    delArea.addEventListener("click", () => {
      if (!confirm("Delete this area and its line items?")) return;
      s.areas.splice(s.areas.indexOf(area), 1); paintAreas(); commit();
    });
    return h("div", { class: "scopearea", style: "margin:10px 0 16px" },
      h("div", { class: "grid2" },
        field("Room / Area", inp(area, "name", { placeholder: "e.g. Kitchen, Master Bath" })),
        h("div", { class: "field app-only", style: "align-self:end" }, delArea)),
      h("div", { class: "tablewrap" },
        h("table", { class: "grid" },
          h("colgroup", {},
            h("col", { style: "width:118px" }), h("col", {}), h("col", { style: "width:52px" }),
            h("col", { style: "width:48px" }), h("col", { style: "width:26%" }),
            h("col", { class: "app-only", style: "width:32px" })),
          h("thead", {}, h("tr", {},
            h("th", {}, "Trade"), h("th", { class: "thleft" }, "Description"), h("th", {}, "Qty"),
            h("th", {}, "Unit"), h("th", { class: "thleft" }, "Notes"), h("th", { class: "app-only" }, ""))),
          tbody)),
      addItem);
  }
  function paintAreas() { areasWrap.replaceChildren(...s.areas.map(areaBlock)); }
  paintAreas();
  const addArea = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only" }, "+ Add room / area");
  addArea.addEventListener("click", () => { s.areas.push(blankScopeArea()); paintAreas(); commit(); });

  const abody = h("tbody");
  const allowTotal = h("strong", {}, money(0));
  function calcAllow() {
    allowTotal.textContent = money(s.allowances.reduce((t, a) => t + (Number(a.amount) || 0), 0));
  }
  function arow(a) {
    const tr = h("tr");
    tr.append(taCell(a, "item", { minWidth: "180px" }), boundCell(a, "amount", "90px", "number", calcAllow),
      taCell(a, "notes", { minWidth: "160px" }), delCell(s.allowances, a, paintAllow));
    return tr;
  }
  function paintAllow() { abody.replaceChildren(...s.allowances.map(arow)); calcAllow(); }
  paintAllow();
  const addAllow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add allowance");
  addAllow.addEventListener("click", () => { s.allowances.push(blankAllowanceRow()); paintAllow(); commit(); });

  return sheet("SCOPE OF WORK", "Construction / Remodel Work Description", "Scope of Work",
    h("div", { class: "grid3" },
      field("Date", inp(s, "date", { type: "date" })),
      field("Work Order #", inp(project, "workOrderNo")),
      field("Contract Amount", inp(project, "contractAmount", { type: "number", placeholder: "$" }))),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    field("Project Summary", ta(s, "summary", { rows: 3 })),
    s.referencePlans && s.referencePlans.length ? h("div", {},
      sectionTitle("Reference Plans"),
      ...s.referencePlans.map((src) => h("img", { src, alt: "Reference plan", class: "docpage" }))) : null,
    sectionTitle("Work by Room / Area"),
    areasWrap, addArea,
    sectionTitle("Allowances"),
    h("p", { class: "subtle app-only" }, "Owner-selected items carried in the contract at an allowance amount — actuals land on the Selections sheet."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("colgroup", {},
          h("col", {}), h("col", { style: "width:96px" }), h("col", { style: "width:36%" }),
          h("col", { class: "app-only", style: "width:32px" })),
        h("thead", {}, h("tr", {},
          h("th", { class: "thleft" }, "Allowance Item"), h("th", {}, "Amount"),
          h("th", { class: "thleft" }, "Notes"), h("th", { class: "app-only" }, ""))),
        abody)),
    addAllow,
    h("div", { class: "totals" }, h("div", { class: "trow grand" }, h("span", {}, "Total Allowances"), allowTotal)),
    sectionTitle("Exclusions / Clarifications"),
    field("Exclusions", ta(s, "exclusions", { rows: 2 })));
}

/* ---------- 8b. PRE-CONSTRUCTION CHECKLIST ---------- */
export function preConChecklist(project, c) {
  const list = h("div");
  PRECON_ITEMS.forEach((txt, i) => list.append(check(c.items, i, `${i + 1}. ${txt}`)));

  const pbody = h("tbody");
  function prow(r) {
    const tr = h("tr");
    tr.append(taCell(r, "type", { minWidth: "130px" }), boundCell(r, "number", "110px"),
      boundCell(r, "pulled", "120px", "date"), taCell(r, "notes", { minWidth: "150px" }),
      delCell(c.permits, r, paintPermits));
    return tr;
  }
  function paintPermits() { pbody.replaceChildren(...c.permits.map(prow)); }
  paintPermits();
  const addPermit = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add permit");
  addPermit.addEventListener("click", () => { c.permits.push(blankPermitRow()); paintPermits(); commit(); });

  return sheet("PRE-CONSTRUCTION CHECKLIST", "Ready-to-Build Verification", "Pre-Construction Checklist",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    sectionTitle("Checklist"),
    list,
    sectionTitle("Permits"),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Permit Type", "Number", "Pulled", "Notes"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        pbody)),
    addPermit,
    field("Notes", ta(c, "notes")));
}

/* ---------- 8c. SELECTIONS SHEET ---------- */
export function selectionsSheet(project, sl) {
  const tbody = h("tbody");
  const allowEl = h("span", {}, money(0));
  const actualEl = h("span", {}, money(0));
  const netEl = h("span", {}, money(0));
  function calc() {
    const allow = sl.rows.reduce((t, r) => t + (Number(r.allowance) || 0), 0);
    const act = sl.rows.reduce((t, r) => t + (Number(r.actual) || 0), 0);
    allowEl.textContent = money(allow);
    actualEl.textContent = money(act);
    const net = act - allow;
    netEl.textContent = (net > 0 ? "+" : "") + money(net);
    netEl.style.color = net > 0 ? "var(--red,#d23b2e)" : "var(--green,#1f9d55)";
    sl.rows.forEach((r, i) => {
      const cell = tbody.children[i]?.querySelector(".ext");
      if (!cell) return;
      const d = (Number(r.actual) || 0) - (Number(r.allowance) || 0);
      cell.textContent = r.actual === "" ? "—" : (d > 0 ? "+" : "") + money(d);
      cell.style.color = d > 0 ? "var(--red,#d23b2e)" : "";
    });
  }
  function row(r) {
    const tr = h("tr");
    const statusTd = h("td");
    statusTd.append(sel(r, "status", SELECTION_STATUSES));
    tr.append(
      taCell(r, "area", { minWidth: "90px" }),
      taCell(r, "item", { minWidth: "130px" }),
      taCell(r, "spec", { minWidth: "150px" }),
      boundCell(r, "allowance", "80px", "number", calc),
      boundCell(r, "actual", "80px", "number", calc),
      h("td", { class: "ext calc" }, "—"),
      statusTd,
      boundCell(r, "leadWeeks", "50px", "number"),
      boundCell(r, "neededBy", "120px", "date"),
      boundCell(r, "decidedDate", "120px", "date"),
      boundCell(r, "ownerInit", "44px"),
      delCell(sl.rows, r, paint));
    return tr;
  }
  function paint() { tbody.replaceChildren(...sl.rows.map(row)); calc(); }
  paint();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add selection");
  addRow.addEventListener("click", () => { sl.rows.push(blankSelectionRow()); paint(); commit(); });

  return sheet("SELECTIONS SHEET", "Owner Finish & Fixture Choices vs. Contract Allowances", "Selections Sheet",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    h("p", { class: "subtle app-only" }, "Lead wks + Needed-by drive the ordering-deadline watch on the job list."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Area", "Item", "Spec / Model / Color", "Allow $", "Actual $", "+/−", "Status", "Lead wks", "Needed by", "Decided", "Init"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,
    h("div", { class: "totals" },
      h("div", { class: "trow" }, h("span", {}, "Total Allowances"), allowEl),
      h("div", { class: "trow" }, h("span", {}, "Total Actual"), actualEl),
      h("div", { class: "trow grand" }, h("span", {}, "Net Over / (Under)"), netEl)),
    field("Notes", ta(sl, "notes")));
}

/* ---------- 8d. SUBCONTRACTOR SCHEDULE ---------- */
export function subSchedule(project, ss) {
  const tbody = h("tbody");
  function row(r) {
    const tr = h("tr");
    const tradeTd = h("td"); tradeTd.append(sel(r, "trade", TRADES, { placeholder: "Trade…" }));
    const statusTd = h("td"); statusTd.append(sel(r, "status", SUB_STATUSES));
    const coiTd = h("td");
    const coiBox = h("input", { type: "checkbox", checked: !!r.coi, style: "width:22px;height:22px" });
    coiBox.addEventListener("change", () => { r.coi = coiBox.checked; commit(); });
    coiTd.append(coiBox);
    tr.append(tradeTd,
      taCell(r, "company", { minWidth: "120px" }),
      taCell(r, "contact", { minWidth: "110px" }),
      boundCell(r, "schedStart", "120px", "date"),
      boundCell(r, "schedEnd", "120px", "date"),
      boundCell(r, "actStart", "120px", "date"),
      boundCell(r, "actEnd", "120px", "date"),
      statusTd, coiTd,
      taCell(r, "notes", { minWidth: "120px" }),
      delCell(ss.rows, r, paint));
    return tr;
  }
  function paint() { tbody.replaceChildren(...ss.rows.map(row)); }
  paint();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add trade");
  addRow.addEventListener("click", () => { ss.rows.push(blankSubRow()); paint(); commit(); });

  // pull the board's phase plan in as starter trade rows (Phase 5)
  const prefill = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only", style: "width:auto" }, "⤓ Prefill from board phases");
  prefill.addEventListener("click", async () => {
    prefill.disabled = true;
    try {
      const boardRow = await findBoardRow(project);
      const subs = boardRow && boardRow.data && boardRow.data.subtasks;
      if (!subs || !subs.length) { toast("No phases on the board for this job yet."); prefill.disabled = false; return; }
      const rows = phasesToSubRows(subs, blankSubRow);
      if (ss.rows.length === 1 && !ss.rows[0].trade && !ss.rows[0].company) ss.rows.length = 0;   // drop the starter blank
      ss.rows.push(...rows);
      paint(); commit();
      toast(`Added ${rows.length} trade row(s) from the board phases — set the dates and companies.`);
    } catch (_) {
      toast("Couldn't read the board — try again online.");
    }
    prefill.disabled = false;
  });

  return sheet("SUBCONTRACTOR SCHEDULE", "Trade Sequence, Dates & Insurance Tracking", "Subcontractor Schedule",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    h("div", { class: "app-only", style: "margin-bottom:8px" }, prefill),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Trade", "Company", "Contact", "Sched Start", "Sched End", "Act Start", "Act End", "Status", "COI", "Notes"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,
    field("Notes", ta(ss, "notes")));
}

/* ---------- 8e. INSPECTION LOG (multi) ---------- */
export function inspectionLog(project, ins) {
  return sheet("INSPECTION RECORD", "Permit Inspection Result & Corrections", "Inspection Record",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    h("div", { class: "grid2" },
      field("Inspection Type", sel(ins, "type", INSPECTION_TYPES, { placeholder: "Select…" })),
      field("Scheduled Date", inp(ins, "scheduled", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Inspector", inp(ins, "inspector")),
      field("Result", seg(ins, "result", INSPECTION_RESULTS.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))))),
    field("Corrections Required", ta(ins, "corrections", { rows: 3 })),
    field("Reinspection Date", inp(ins, "reinspection", { type: "date" })),
    field("Notes", ta(ins, "notes")));
}

/* ---------- 8f. PUNCH LIST ---------- */
export function punchList(project, pl) {
  const tbody = h("tbody");
  const openLine = h("p", { class: "subtle app-only" });
  function calcOpen() {
    const open = pl.rows.filter((r) => r.status === "open" || r.status === "in-progress").length;
    openLine.textContent = open ? `${open} of ${pl.rows.length} item(s) still open.` : (pl.rows.length ? "All items closed." : "");
  }
  function row(r) {
    const tr = h("tr");
    const tradeTd = h("td"); tradeTd.append(sel(r, "trade", TRADES, { placeholder: "Trade…" }));
    const priTd = h("td"); priTd.append(sel(r, "priority", PUNCH_PRIORITIES));
    const statusTd = h("td"); statusTd.append(sel(r, "status", PUNCH_STATUSES, { onchange: calcOpen }));
    tr.append(
      taCell(r, "area", { minWidth: "90px" }),
      taCell(r, "item", { minWidth: "180px" }),
      tradeTd, priTd, statusTd,
      boundCell(r, "completedBy", "100px"),
      boundCell(r, "completedDate", "120px", "date"),
      delCell(pl.rows, r, paint));
    const photoTr = h("tr", { class: "punchphotos" },
      h("td", { colspan: "8" }, photoUploader(r.photos, "Photo")));
    return [tr, photoTr];
  }
  function paint() { tbody.replaceChildren(...pl.rows.flatMap(row)); calcOpen(); }
  paint();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add punch item");
  addRow.addEventListener("click", () => { pl.rows.push(blankPunchRow()); paint(); commit(); });

  return sheet("PUNCH LIST", "Walkthrough Items to Closeout", "Punch List",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    openLine,
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Area", "Item", "Trade", "Priority", "Status", "By", "Done"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,
    sectionTitle("Owner Walkthrough"),
    field("Walkthrough Date", inp(pl, "walkthroughDate", { type: "date" })),
    sigBlock(pl, "sigOwner", "sigOwnerName", "sigOwnerDate", "Owner — punch list reviewed & accepted"));
}

/* ---------- 8g. DRAW SCHEDULE / PROGRESS INVOICING ---------- */
export function drawSchedule(project, ds) {
  const tbody = h("tbody");
  const pctEl = h("span", {}, "0%");
  const totalEl = h("span", {}, money(0));
  const contractEl = h("span", {}, money(Number(project.contractAmount) || 0));
  const unallocEl = h("span", {}, money(0));
  function calc() {
    const contract = Number(project.contractAmount) || 0;
    const pct = ds.rows.reduce((t, r) => t + (Number(r.pct) || 0), 0);
    const amt = ds.rows.reduce((t, r) => t + (Number(r.amount) || 0), 0);
    pctEl.textContent = pct + "%";
    totalEl.textContent = money(amt);
    contractEl.textContent = money(contract);
    unallocEl.textContent = money(contract - amt);
  }
  function row(r, i) {
    const tr = h("tr");
    const amtTd = h("td");
    const amtInput = h("input", { type: "number", value: r.amount ?? "", style: "min-width:90px" });
    amtInput.addEventListener("input", () => { r.amount = amtInput.value; r._manualAmt = true; calc(); commit(); });
    amtTd.append(amtInput);
    const pctTd = h("td");
    const pctInput = h("input", { type: "number", value: r.pct ?? "", style: "min-width:50px" });
    pctInput.addEventListener("input", () => {
      r.pct = pctInput.value;
      const contract = Number(project.contractAmount) || 0;
      if (!r._manualAmt && contract) { r.amount = ((Number(r.pct) || 0) / 100 * contract).toFixed(2); amtInput.value = r.amount; }
      calc(); commit();
    });
    pctTd.append(pctInput);
    const invBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" },
      r.invoiceId ? "Open invoice" : "→ Invoice");
    invBtn.addEventListener("click", () => {
      if (r.invoiceId && (project.invoices || []).some((x) => x.id === r.invoiceId)) {
        location.hash = `#/p/${project.id}/f/invoices/${r.invoiceId}`;
        return;
      }
      const inv = newInvoice();
      inv.invoiceNo = "DRAW-" + (i + 1);
      inv.lossSummary = "Progress draw: " + (r.desc || `milestone ${i + 1}`);
      inv.items = [{ room: "", desc: r.desc || `Draw ${i + 1}`, qty: "1", unit: "ea", price: String(r.amount || "") }];
      if (!Array.isArray(project.invoices)) project.invoices = [];
      project.invoices.push(inv);
      r.invoiceId = inv.id;
      if (!r.invoicedDate) r.invoicedDate = todayISO();
      commit();
      location.hash = `#/p/${project.id}/f/invoices/${inv.id}`;
    });
    tr.append(
      h("td", { class: "calc" }, String(i + 1)),
      taCell(r, "desc", { minWidth: "170px" }),
      pctTd, amtTd,
      boundCell(r, "invoicedDate", "120px", "date"),
      boundCell(r, "paidDate", "120px", "date"),
      h("td", { class: "app-only" }, invBtn),
      delCell(ds.rows, r, paint));
    return tr;
  }
  function paint() { tbody.replaceChildren(...ds.rows.map(row)); calc(); }
  paint();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add draw");
  addRow.addEventListener("click", () => { ds.rows.push(blankDrawRow()); paint(); commit(); });

  return sheet("DRAW SCHEDULE", "Payment Milestones & Progress Invoicing", "Draw Schedule",
    jobInfo(project, ["customer", "address", "workOrderNo", "phone"]),
    h("p", { class: "subtle app-only" }, "“→ Invoice” pre-fills a Mitigation Invoice for the draw — review it before sending."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["#", "Milestone", "% of Contract", "Amount", "Invoiced", "Paid"].map((x) => h("th", {}, x)), h("th", { class: "app-only" }, ""), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow,
    h("div", { class: "totals" },
      h("div", { class: "trow" }, h("span", {}, "Scheduled % of Contract"), pctEl),
      h("div", { class: "trow" }, h("span", {}, "Scheduled Draw Total"), totalEl),
      h("div", { class: "trow" }, h("span", {}, "Contract Amount"), contractEl),
      h("div", { class: "trow grand" }, h("span", {}, "Unallocated"), unallocEl)),
    field("Notes", ta(ds, "notes")));
}

/* ---------- 8h. CERTIFICATE OF COMPLETION ---------- */
export function certCompletion(project, c) {
  const list = h("div");
  COMPLETION_ITEMS.forEach((txt, i) => list.append(check(c.checklist, i, `${i + 1}. ${txt}`)));

  return sheet("CERTIFICATE OF COMPLETION", "Final Acceptance & Workmanship Warranty", "Certificate of Completion",
    h("div", { class: "grid2" },
      field("Certificate #", inp(c, "certNo")),
      field("Issue Date", inp(c, "issueDate", { type: "date" }))),
    h("div", { class: "grid2" },
      field("Project / Job ID", inp(project, "workOrderNo")),
      field("Completion Date", inp(c, "completionDate", { type: "date" }))),
    sectionTitle("Property / Owner"),
    jobInfo(project, ["customer", "address", "phone", "email"]),
    field("Scope Completed", ta(c, "scopeSummary", { rows: 3 })),
    sectionTitle("Completion Checklist"),
    list,
    sectionTitle("Warranty"),
    h("div", { class: "grid2" },
      field("Workmanship Warranty", inp(c, "warrantyWorkmanship")),
      field("Manufacturer Registrations / Notes", inp(c, "warrantyNotes"))),
    h("div", { class: "certstmt" },
      h("p", {}, "The undersigned contractor certifies that the work described above has been completed in a good and workmanlike manner in accordance with the contract documents and applicable codes. The Owner's signature below confirms acceptance of the completed work, subject to the workmanship warranty stated above.")),
    sectionTitle("Signatures"),
    signOrUpload(c, () => [
      sigBlock(c, "sigContractor", "sigContractorName", "sigContractorDate", "Contractor (Roybal Construction, LLC)"),
      h("hr", { class: "divider" }),
      sigBlock(c, "sigOwner", "sigOwnerName", "sigOwnerDate", "Property Owner — acceptance of completed work"),
    ]));
}

export const RENDERERS = {
  floorPlan: floorPlanSheet,
  moistureMaps: moistureMap,
  dryingLogs: dryingLog,
  workAuth,
  photos: photosForm,
  contents: contentsReport,
  constructionLogs: constructionLog,
  laborLog,
  certDrying,
  changeOrders: changeOrder,
  invoices: invoice,
  scopeOfWork,
  preConChecklist,
  selections: selectionsSheet,
  subSchedule,
  inspections: inspectionLog,
  punchList,
  drawSchedule,
  certCompletion,
};
