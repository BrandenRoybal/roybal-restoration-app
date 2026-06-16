/* ============================================================
   Roybal Field Forms — the 7 form renderers
   Each returns a printable .sheet built from bound inputs.
   ============================================================ */
import { h, sketchPad, gpp, grainDepression, money, toast, fmtDate, todayISO, fileToDataURL, DRY_STANDARDS, goalFor, daysSince } from "./core.js";
import { fileToFloorPlan } from "./pdf.js";
import {
  field, inp, ta, sel, seg, check, sigBlock, signOrUpload, photoUploader,
  lineItems, sheet, sheetFooter, commit,
} from "./formkit.js";
import {
  SCOPE_ITEMS, CHANGE_REASONS, newPhoto, dispositionLabel, depreciation,
  blankReadingRow, blankPsychroRow, blankEquipRow, blankWorkRow,
  blankLineItem, blankVerifyRow,
} from "./model.js";

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
    try { const url = await fileToFloorPlan(f); pad.setBackground(url); toast("Floor plan added — draw on top"); }
    catch { toast("Sorry — couldn't read that file"); }
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
      const rm = h("button", { type: "button", class: "btn btn--danger btn--sm" }, "Remove plan");
      rm.addEventListener("click", () => { pad.setBackground(null); renderFp(); });
      fpBox.append(rm);
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
  /* drying-day counter: from dry-out start to today */
  const dryStart = d.dryoutStart || project.dryStart || "";
  const dayCount = dryStart ? (daysSince(dryStart) + 1) : null;
  const daysBanner = h("div", { class: "daysbig app-only", style: "margin-bottom:8px" });
  if (dayCount != null && dayCount > 0) daysBanner.append("Drying ", h("b", {}, "Day " + dayCount), " (started " + dryStart + ")");

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
  function eqRow(row, i) {
    const tr = h("tr");
    const daysCell = h("td", { class: "calc", style: "min-width:46px" });
    function recalcDays() {
      // auto total hours from placed→removed (unless manually set)
      if (row.placed && row.removed && !row._manualHrs) {
        const ph = (new Date(row.removed) - new Date(row.placed)) / 3600000;
        if (isFinite(ph) && ph >= 0) { row.hours = Math.round(ph); if (hoursInput) hoursInput.value = row.hours; }
      }
      const onsite = row.placed ? daysSince(row.placed) : null;
      const ended = row.removed ? false : (onsite != null && onsite >= 7);
      daysCell.textContent = onsite == null ? "" : (row.removed ? "" : onsite + "d");
      tr.classList.toggle("flag7", !!ended);
    }
    let hoursInput;
    const mk = (key, w, type = "text") => {
      const c = h("td");
      const input = h("input", { type, value: row[key] ?? "", style: `min-width:${w}`, step: type === "datetime-local" ? "60" : null });
      input.addEventListener("input", () => {
        row[key] = input.value;
        if (key === "hours") row._manualHrs = true;
        recalcDays(); refreshWarn(); commit();
      });
      if (key === "hours") hoursInput = input;
      c.append(input); return c;
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
    field("Dry-out Start Date", inp(d, "dryoutStart", { type: "date" })));
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

  return sheet("WORK AUTHORIZATION & SERVICE AGREEMENT", "Water Mitigation / Restoration Services", "Work Authorization & Service Agreement",
    h("div", { class: "grid3" },
      field("Date", inp(wa, "date", { type: "date" })),
      field("Work Order #", inp(project, "workOrderNo")),
      field("Claim #", inp(project, "claimNo"))),
    field("Property Address", inp(project, "address")),
    h("div", { class: "grid2" },
      field("Owner Name", inp(project, "customer")),
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
      sigBlock(wa, "ownerSig", "ownerName", "ownerDate", "Property Owner — sign above"),
      h("hr", { class: "divider" }),
      sigBlock(wa, "repSig", "repName", "repDate", "Contractor Representative (Roybal Construction, LLC)"),
    ]));
}
function termRow(k, v) {
  return h("div", { class: "termrow" }, h("span", { class: "termrow__k" }, k + ":"), h("span", { class: "termrow__v" }, v));
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
  function row(r, i) {
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
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { c.rows.splice(i, 1); paint(); calcTotal(); commit(); } }, "✕")));
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
