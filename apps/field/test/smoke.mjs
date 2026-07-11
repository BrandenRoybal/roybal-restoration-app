/* DOM smoke test — drives the real app modules through every form.
   Run: node apps/field/test/smoke.mjs   (from repo root) */
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import { depreciation, FORMS } from "../js/model.js";
import { qrSvg } from "../js/qr.js";

const SHELL = `<!DOCTYPE html><html><body>
  <header id="topbar"><button id="backBtn" hidden></button>
    <div><span id="topbarSub"></span></div><div id="netStatus">●</div></header>
  <main id="view"></main><div id="toast" hidden></div></body></html>`;

const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;

// ---- globals the app modules expect ----
for (const k of ["document", "window", "navigator", "location", "history",
  "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader",
  "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
// run the app in local-only mode for tests (skip the sign-in gate)
window.localStorage.setItem("roybal-offline", "1");
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.devicePixelRatio = 1;
window.print = () => { window.__printed = (window.__printed || 0) + 1; };
window.confirm = () => true;
globalThis.confirm = window.confirm;   // app code calls bare confirm() (a browser global)
window.scrollTo = () => {};

// ---- shim canvas (jsdom has no 2d context without the native canvas pkg) ----
const ctxStub = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,stub";

// ---- test helpers ----
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) failures++; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function nav(hash) {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event("hashchange"));
  await tick();
}
const view = () => window.document.getElementById("view");
const text = () => view().textContent;
function setInput(el, val) {
  el.value = val;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

(async () => {
  // import after globals are in place
  await import("../js/app.js");
  await tick();

  // 1. empty job list (mode-aware copy — fresh devices open in restoration mode)
  await nav("#/");
  ok(/No restoration jobs yet/.test(text()), "empty job list renders");
  ok(/🔨 Construction \(0\)/.test(text()), "home screen shows the construction mode toggle");

  // 2. create a job -> edit screen
  await nav("#/new");
  await tick(40);
  ok(/Job details/.test(text()), "new job opens edit screen");
  const customer = view().querySelector("input");
  setInput(customer, "Jane Homeowner");
  await tick();

  // grab the project id from the hash
  const id = window.location.hash.split("/")[2];
  ok(!!id, "project id present in route: " + id);

  // 3. project home tiles
  await nav(`#/p/${id}`);
  ok(/Moisture Map/.test(text()) && /Drying Log/.test(text()), "project home shows form tiles");
  ok(/Jane Homeowner/.test(text()), "customer name flows to project home");

  // 4. Moisture Map: list -> add instance -> editor
  await nav(`#/p/${id}/f/moistureMaps`);
  ok(/Moisture Map/.test(text()), "moisture map instance list renders");
  // click "+ New"
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  ok(view().querySelector("canvas") !== null, "moisture map editor has sketch canvas");
  ok(view().querySelector("table.grid") !== null, "moisture map has reading grid");
  ok(/Import floor plan/.test(text()), "moisture map offers floor-plan import (PDF/image)");
  // material auto-fills the dry goal
  const matSel = [...view().querySelectorAll("select")].find((s) => /Drywall/.test(s.textContent));
  ok(!!matSel, "moisture map has a material picker");
  matSel.value = "Drywall / Gypsum";
  matSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  await tick();
  ok([...view().querySelectorAll("input")].some((i) => i.value === "≤ 1%"), "selecting a material auto-fills the dry goal (≤ 1%)");
  // readings flag green/red against the goal
  const mc = view().querySelector("input.mc");
  setInput(mc, "0.5"); await tick();
  ok(mc.classList.contains("dry"), "reading at/below goal flags green (dry)");
  setInput(mc, "8"); await tick();
  ok(mc.classList.contains("wet"), "reading above goal flags red (wet)");
  // drying-trend line graph renders from the readings
  setInput(mc, "12"); await tick(30);
  ok(/Drying Trend/.test(text()), "moisture map shows a Drying Trend section");
  ok(view().querySelector(".mchart-wrap svg.mchart") !== null, "drying-trend line graph renders as SVG once readings exist");

  // 5. Drying Log: add instance, test GPP auto-calc wiring
  await nav(`#/p/${id}/f/dryingLogs`);
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  const tables = view().querySelectorAll("table.grid");
  ok(tables.length >= 2, "drying log has equipment + psychrometric tables");
  // psychro table is the last grid; first data row inputs: [date,time,outT,outRH,outGPP,...]
  const psTable = tables[tables.length - 1];
  const row = psTable.querySelector("tbody tr");
  const inputs = row.querySelectorAll("input");
  setInput(inputs[2], "70"); // outT
  setInput(inputs[3], "50"); // outRH
  await tick();
  ok(inputs[4].value === "54", "GPP auto-calculates from T/RH in the grid (got " + inputs[4].value + ")");
  // 7-day equipment flag: place a unit 8 days ago, leave it on site
  const eqTable = tables[0];
  const eqRow = eqTable.querySelector("tbody tr");
  // type/location/notes are auto-growing textareas now — grab "placed" by its input type
  const eightAgo = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 16);
  setInput(eqRow.querySelector('input[type="datetime-local"]'), eightAgo); // placed
  await tick();
  ok(eqRow.classList.contains("flag7"), "equipment on site 7+ days is flagged");
  ok(/7-day equipment check/.test(text()), "drying log shows the 7-day equipment warning");

  // 6. Work Authorization (single) renders with signature pads
  await nav(`#/p/${id}/f/workAuth`);
  await tick(40);
  ok(/Scope of Authorized Work/.test(text()), "work auth renders scope");
  ok(view().querySelectorAll("canvas").length >= 2, "work auth has owner + rep signature pads");
  ok(/Upload signed copy/.test(text()), "work auth offers upload-signed-copy option");

  // Mitigation invoice is back in the field app (AI-drafted or built by hand)
  ok(FORMS.some((f) => f.key === "invoices"), "mitigation invoice form is in the field app");
  ok(!FORMS.some((f) => f.hero), "moisture/drying tiles are standard size (no hero)");

  // 8. remaining single/multi forms render without throwing
  for (const key of ["constructionLogs", "changeOrders", "certDrying"]) {
    await nav(`#/p/${id}/f/${key}`);
    if (key !== "certDrying") {
      [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
      await tick(40);
    }
    ok(view().querySelector(".sheet") !== null, `${key} editor renders a printable sheet`);
  }

  // 8b. Job Photos (project-level gallery -> Photo Report sheet)
  await nav(`#/p/${id}/f/photos`);
  await tick(40);
  ok(/PHOTO REPORT/.test(text()), "job photos renders a Photo Report sheet");
  ok([...view().querySelectorAll("button")].some((b) => /Add photos/.test(b.textContent)), "photos page has an Add photos button");

  // 8b2. Contents inventory: add item -> condition/disposition/value -> report
  await nav(`#/p/${id}/f/contents`);
  ok(/Contents/.test(text()), "contents manager renders");
  [...view().querySelectorAll("button")].find((b) => /Add item/.test(b.textContent))?.click();
  await tick(50);
  ok(/Item name/.test(text()), "contents item editor opens");
  const nameI = [...view().querySelectorAll("input")].find((i) => /Samsung/.test(i.placeholder || ""));
  setInput(nameI, "Sectional Sofa");
  const valI = [...view().querySelectorAll("input")].find((i) => /per unit/.test(i.placeholder || ""));
  setInput(valI, "500");
  [...view().querySelectorAll(".seg button")].find((b) => /Non-Salvageable/.test(b.textContent))?.click();
  await tick();
  ok(view().querySelector(".warn") && !view().querySelector(".warn").hidden, "non-salvageable item prompts for a claim photo");
  await nav(`#/p/${id}/f/contents/report`);
  await tick(40);
  ok(/Sectional Sofa/.test(text()), "item appears in the contents inventory PDF");
  ok(/Non-Salvageable Loss Summary/.test(text()) && /\$500\.00/.test(text()), "loss summary + total compute");
  ok(/ACV/.test(text()), "loss summary shows ACV / depreciation columns");
  await nav(`#/p/${id}/f/contents`);
  ok(/Sectional Sofa/.test(text()), "item shows in the contents list");
  ok([...view().querySelectorAll("button")].some((b) => /CSV/.test(b.textContent)), "contents manager offers CSV export");
  // boxes + QR labels
  await nav(`#/p/${id}/f/contents/boxes`);
  [...view().querySelectorAll("button")].find((b) => /New box/.test(b.textContent))?.click();
  await tick(40);
  ok([...view().querySelectorAll("input")].some((i) => i.value === "Box 1"), "a pack-out box can be created");
  // pack-back
  await nav(`#/p/${id}/f/contents/packback`);
  await tick(40);
  ok(/PACK-BACK RECEIPT/.test(text()), "pack-back receipt renders");

  // ACV / depreciation math + QR generation (unit)
  const d = depreciation({ value: "1000", qty: "1", category: "Electronics", age: "2" });
  ok(Math.round(d.acv) === 600, "ACV depreciation computes (Electronics, age 2 → $600, got " + Math.round(d.acv) + ")");
  const svg = await qrSvg("ROYBAL");
  ok(/<svg/.test(svg), "QR code generates an SVG for box labels");

  // 8c. Full job packet stacks every started form into one printable doc
  await nav(`#/p/${id}/packet`);
  await tick(60);
  ok(view().querySelectorAll(".sheet").length >= 4, "full packet stacks multiple sheets (got " + view().querySelectorAll(".sheet").length + ")");
  ok([...view().querySelectorAll("button")].some((b) => /Save packet as PDF/.test(b.textContent)), "packet offers Save as PDF");

  // 9. data persisted across reload (fake-indexeddb keeps state in-process)
  await nav("#/");
  ok(/Jane Homeowner/.test(text()), "job persists and shows in list after navigation");

  // 10. construction mode — home toggle, new construction job, filtered tiles
  [...view().querySelectorAll(".seg button")].find((b) => /🔨 Construction/.test(b.textContent))?.click();
  await tick(40);
  ok(/No construction jobs yet/.test(text()), "construction tab starts empty");
  await nav("#/new");
  await tick(40);
  ok(/Construction details/.test(text()), "new job in construction mode shows construction details");
  ok(!/Loss classification/.test(text()), "construction edit hides the water loss classification");
  setInput(view().querySelector("input"), "Hansen Kitchen Remodel");
  [...view().querySelectorAll(".seg button")].find((b) => b.textContent === "Remodel")?.click();
  await tick();
  const conId = window.location.hash.split("/")[2];
  await nav(`#/p/${conId}`);
  await tick(40);
  const conTiles = [...view().querySelectorAll(".tile__name")].map((t) => t.textContent);
  ok(!conTiles.includes("Moisture Map") && !conTiles.includes("Drying Log") && !conTiles.includes("Cert. of Drying"),
    "construction job hides the water-only tiles");
  ok(conTiles.includes("Field Report") && conTiles.includes("Job Photos"), "construction job shows the shared tiles");
  ok(conTiles.includes("Scope of Work") && conTiles.includes("Punch List") && conTiles.includes("Draw Schedule"),
    "construction job shows the construction tiles");
  ok(view().querySelector(".completeness") !== null, "construction completeness panel renders");
  ok(/Contract signed/.test(text()), "completeness panel checks the construction matrix");
  ok(/🔨 Remodel/.test(text()), "construction badge shows the project type");

  // every construction form renders a printable sheet; only AI forms get the mic
  for (const key of ["scopeOfWork", "preConChecklist", "selections", "subSchedule", "punchList", "drawSchedule", "certCompletion"]) {
    await nav(`#/p/${conId}/f/${key}`);
    await tick(40);
    ok(view().querySelector(".sheet") !== null, `${key} editor renders a printable sheet`);
    const hasMic = [...view().querySelectorAll("button")].some((b) => /Transcribe/.test(b.textContent));
    const wantsMic = ["selections", "subSchedule", "punchList"].includes(key);
    ok(hasMic === wantsMic, `${key} ${wantsMic ? "mounts" : "stays free of"} the voice widget`);
  }
  await nav(`#/p/${conId}/f/inspections`);
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  ok(view().querySelector(".sheet") !== null, "inspections editor renders a printable sheet");

  // 10c. Phase 4 — voice capture rides the construction forms; progress page renders
  await nav(`#/p/${conId}/f/punchList`);
  await tick(40);
  ok([...view().querySelectorAll("button")].some((b) => /Transcribe/.test(b.textContent)),
    "punch list mounts the voice-capture widget");
  await nav(`#/p/${conId}/f/changeOrders`);
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  ok([...view().querySelectorAll("button")].some((b) => /Transcribe/.test(b.textContent)),
    "change order mounts the voice-capture widget");
  await nav(`#/p/${conId}`);
  await tick(40);
  ok([...view().querySelectorAll("button")].some((b) => /Progress Update/.test(b.textContent)),
    "construction job home offers the Progress Update");
  ok([...view().querySelectorAll("button")].some((b) => /Estimate timeline/.test(b.textContent)),
    "construction job home offers the board timeline estimate");
  ok(/Board timeline/.test(text()), "board timeline panel renders");
  await nav(`#/p/${conId}/progress`);
  await tick(40);
  ok(/CONSTRUCTION PROGRESS UPDATE/.test(text()), "progress page renders the letterhead sheet");
  ok([...view().querySelectorAll("button")].some((b) => /Generate update/.test(b.textContent)),
    "progress page offers AI generation");

  // 10b. switching a documented water job to construction never hides its documents
  await nav(`#/p/${id}/packet`);
  await tick(60);
  const sheetsBefore = view().querySelectorAll(".sheet").length;
  await nav(`#/p/${id}/edit`);
  await tick(40);
  [...view().querySelectorAll(".seg button")].find((b) => /🔨 Construction/.test(b.textContent))?.click();
  await tick(40);
  await nav(`#/p/${id}`);
  await tick(40);
  ok([...view().querySelectorAll(".tile__name")].some((t) => t.textContent === "Moisture Map"),
    "switched job still shows tiles for forms that hold data");
  await nav(`#/p/${id}/packet`);
  await tick(60);
  ok(view().querySelectorAll(".sheet").length === sheetsBefore,
    "switched job's packet keeps every mitigation document (" + sheetsBefore + " sheets)");
  await nav(`#/p/${id}/edit`);
  await tick(40);
  [...view().querySelectorAll(".seg button")].find((b) => /💧 Restoration/.test(b.textContent))?.click();
  await tick(40);
  window.localStorage.setItem("roybal-mode", "restoration");

  // 11. restoration → construction conversion (copy, not mutation)
  const { Store } = await import("../js/core.js");
  await nav(`#/p/${id}`);
  await tick(40);
  const reconBtn = [...view().querySelectorAll("button")].find((b) => /Start reconstruction/.test(b.textContent));
  ok(!!reconBtn, "restoration job home offers Start reconstruction");
  const beforeConvert = JSON.stringify(await Store.get(id));
  // cancel path: declining the not-certified confirm leaves both sides untouched
  globalThis.confirm = window.confirm = () => false;
  reconBtn.click();
  await tick(80);
  ok(window.location.hash === `#/p/${id}`, "cancelled conversion stays on the job");
  ok(JSON.stringify(await Store.get(id)) === beforeConvert, "cancelled conversion changes nothing");
  globalThis.confirm = window.confirm = () => true;
  reconBtn.click();                       // not certified — confirm now accepts
  await tick(80);
  const reconId = window.location.hash.split("/")[2];
  ok(reconId && reconId !== id, "conversion navigates to a new job");
  const reconProj = await Store.get(reconId);
  ok(reconProj.jobType === "construction" && reconProj.constructionType === "reconstruction",
    "converted job is a construction / reconstruction job");
  ok(reconProj.linkedRestorationId === id, "converted job links back to the mitigation job");
  ok(reconProj.customer === "Jane Homeowner" && reconProj.claimNo === (await Store.get(id)).claimNo,
    "header carries over to the rebuild");
  ok(/💧 Mitigation job/.test(text()), "rebuild job home shows the mitigation link chip");
  ok(/Draft rebuild plan/.test(text()), "AI rebuild setup panel offers a draft");
  const afterConvert = await Store.get(id);
  ok(afterConvert.linkedConstructionId === reconId, "original job gains the back-link");
  const expected = JSON.parse(beforeConvert);
  expected.linkedConstructionId = reconId;
  expected.updatedAt = afterConvert.updatedAt;
  ok(JSON.stringify(expected) === JSON.stringify(afterConvert),
    "original job otherwise unchanged by the conversion");
  await nav(`#/p/${id}`);
  await tick(40);
  ok(/🔨 Reconstruction job/.test(text()), "mitigation job home shows the reconstruction link chip");
  ok(![...view().querySelectorAll("button")].some((b) => /Start reconstruction/.test(b.textContent)),
    "Start reconstruction card gone once linked");
  window.localStorage.setItem("roybal-mode", "restoration");

  console.log("\n" + (failures ? `FAILED: ${failures} check(s)` : "ALL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
