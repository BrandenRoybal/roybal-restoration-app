/* ============================================================
   Roybal Field Forms — the 7 form renderers
   Each returns a printable .sheet built from bound inputs.
   ============================================================ */
import { h, sketchPad, gpp, grainDepression, money, DRY_STANDARDS } from "./core.js";
import {
  field, inp, ta, sel, seg, check, sigBlock, signOrUpload, photoUploader,
  lineItems, sheet, commit,
} from "./formkit.js";
import {
  SCOPE_ITEMS, CHANGE_REASONS,
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

/* ============================================================
   1. MOISTURE MAP
   ============================================================ */
export function moistureMap(project, m) {
  const pad = sketchPad(m.sketch, (data) => { m.sketch = data; commit(); });

  /* reading grid */
  const tbody = h("tbody");
  function rowEl(row, i) {
    const tr = h("tr");
    const dateCell = h("td");
    const dateInput = h("input", { type: "date", value: row.date, style: "min-width:120px" });
    dateInput.addEventListener("input", () => { row.date = dateInput.value; commit(); });
    dateCell.append(dateInput);
    tr.append(dateCell);
    for (let n = 0; n < 13; n++) {
      const c = h("td");
      const input = h("input", { value: row.values[n] ?? "", inputmode: "decimal", style: "min-width:42px" });
      input.addEventListener("input", () => { row.values[n] = input.value; commit(); });
      c.append(input); tr.append(c);
    }
    const noteCell = h("td");
    const noteInput = h("input", { value: row.notes ?? "", style: "min-width:120px" });
    noteInput.addEventListener("input", () => { row.notes = noteInput.value; commit(); });
    noteCell.append(noteInput); tr.append(noteCell);
    tr.append(h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { m.readings.splice(i, 1); paintRows(); commit(); } }, "✕")));
    return tr;
  }
  function paintRows() { tbody.replaceChildren(...m.readings.map(rowEl)); }
  paintRows();
  const addRow = h("button", { type: "button", class: "btn btn--ghost btn--sm app-only row-add" }, "+ Add reading date");
  addRow.addEventListener("click", () => { m.readings.push(blankReadingRow()); paintRows(); commit(); });

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

    sectionTitle("Affected Area Sketch"),
    h("p", { class: "subtle app-only" }, "Draw the affected area, then tap “① Number” and place numbered markers at each moisture-reading location."),
    h("div", { class: "grid2" },
      field("Material", inp(m, "material", { placeholder: "Drywall, subfloor…" })),
      field("Dry Goal (MC%)", inp(m, "dryGoal", { placeholder: "≤ 16%" }))),
    field("Meter / Setting", inp(m, "meter", { placeholder: "Pin / non-pin, scale" })),
    pad.tools, pad.el,
    h("details", { class: "app-only", style: "margin-top:10px" },
      h("summary", { class: "linklike" }, "Or attach photos of the area instead"),
      photoUploader(m.photos, "Add area photos")),

    sectionTitle("Moisture Reading Locations (MC% or equivalent)"),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...headCols.map((c) => h("th", {}, c)), h("th", { class: "app-only" }, ""))),
        tbody)),
    addRow);
}

/* ============================================================
   2. DRYING LOG
   ============================================================ */
export function dryingLog(project, d) {
  /* equipment deployment table */
  const eqBody = h("tbody");
  function eqRow(row, i) {
    const tr = h("tr");
    const mk = (key, w, type = "text") => {
      const c = h("td");
      const input = h("input", { type, value: row[key] ?? "", style: `min-width:${w}` });
      input.addEventListener("input", () => { row[key] = input.value; commit(); });
      c.append(input); return c;
    };
    tr.append(mk("asset", "50px"), mk("type", "150px"), mk("location", "110px"),
      mk("placed", "120px"), mk("removed", "120px"), mk("hours", "60px", "number"), mk("notes", "120px"),
      h("td", { class: "app-only" }, h("button", { type: "button", class: "rowdel", onclick: () => { d.equipment.splice(i, 1); paintEq(); commit(); } }, "✕")));
    return tr;
  }
  function paintEq() { eqBody.replaceChildren(...d.equipment.map(eqRow)); }
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
    const tiC = mk("timeIn", "85px", "time");
    const toC = mk("timeOut", "85px", "time");
    const outT = mk("outT", "44px", "number"), outRH = mk("outRH", "44px", "number"), outG = mk("outGPP", "48px", "number");
    const refT = mk("refT", "44px", "number"), refRH = mk("refRH", "44px", "number"), refG = mk("refGPP", "48px", "number");
    const affT = mk("affT", "44px", "number"), affRH = mk("affRH", "44px", "number"), affG = mk("affGPP", "48px", "number");
    const gdC = mk("gd", "44px", "number");
    cells.outGPP.classList.add("calc"); cells.refGPP.classList.add("calc"); cells.affGPP.classList.add("calc"); cells.gd.classList.add("calc");
    recalc(); // fill GPP/GD for any pre-existing T/RH values on load
    tr.append(dateC, tiC, toC, outT, outRH, outG, refT, refRH, refG, affT, affRH, affG, gdC,
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
    h("th", { colspan: 3 }, "Date / Time"),
    h("th", { colspan: 3 }, "Outside / Ambient"),
    h("th", { colspan: 3 }, "Unaffected (Ref.)"),
    h("th", { colspan: 3 }, "Affected"),
    h("th", {}, "GD"),
    h("th", { colspan: 3 }, "Equip Count"),
    h("th", { colspan: 2 }, "Tech / Notes"),
    h("th", { class: "app-only" }, ""));
  const psHeadBot = h("tr", {},
    ...["Date", "In", "Out", "T", "RH", "GPP", "T", "RH", "GPP", "T", "RH", "GPP", "GD", "Dehu", "AM", "Scrb", "Tech", "Notes"].map((c) => h("th", {}, c)),
    h("th", { class: "app-only" }, ""));

  return sheet("DRYING LOG", "Equipment Runtime & Psychrometric Conditions — Per IICRC S500 Protocol", "Drying Log Field Template",
    h("div", { class: "grid2" },
      field("Drying System", seg(project, "dryingSystem", ["Open", "Closed", "Hybrid"])),
      field("Dry Goal (MC%)", inp(d, "dryGoal", { placeholder: "≤ 16%" }))),
    h("div", { class: "grid2" },
      field("Water Category", seg(project, "waterCategory", [{ value: "1", label: "Cat 1" }, { value: "2", label: "Cat 2" }, { value: "3", label: "Cat 3" }])),
      field("Class", seg(project, "waterClass", ["1", "2", "3", "4"]))),

    sectionTitle("Equipment Deployment & Runtime"),
    h("p", { class: "subtle app-only" }, "Log each unit placed on site — placed/removed date & time, total runtime hours."),
    h("div", { class: "tablewrap" },
      h("table", { class: "grid" },
        h("thead", {}, h("tr", {}, ...["Asset #", "Equipment Type / Make / Model", "Room / Location", "Placed", "Removed", "Hrs", "Notes"].map((c) => h("th", {}, c)), h("th", { class: "app-only" }, ""))),
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
    signOrUpload(wa));
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
    sigBlock(c, "sigTech", "sigTechName", "sigTechDate", "IICRC Certified Technician — Roybal Construction, LLC"),
    h("hr", { class: "divider" }),
    sigBlock(c, "sigOwner", "sigOwnerName", "sigOwnerDate", "Property Owner / Insured"),
    h("hr", { class: "divider" }),
    sigBlock(c, "sigAdjuster", "sigAdjusterName", "sigAdjusterDate", "Adjuster / Carrier (if witness required)"));
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

/* ---------- dispatch ---------- */
export const RENDERERS = {
  moistureMaps: moistureMap,
  dryingLogs: dryingLog,
  workAuth,
  constructionLogs: constructionLog,
  certDrying,
  changeOrders: changeOrder,
  invoices: invoice,
};
