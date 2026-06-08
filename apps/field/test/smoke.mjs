/* DOM smoke test — drives the real app modules through every form.
   Run: node apps/field/test/smoke.mjs   (from repo root) */
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const SHELL = `<!DOCTYPE html><html><body>
  <header id="topbar"><button id="backBtn" hidden></button>
    <div><span id="topbarSub"></span></div><div id="netStatus">●</div></header>
  <main id="view"></main><div id="toast" hidden></div></body></html>`;

const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;

// ---- globals the app modules expect ----
for (const k of ["document", "window", "navigator", "location", "history",
  "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader",
  "getComputedStyle", "DOMParser"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.devicePixelRatio = 1;
window.print = () => { window.__printed = (window.__printed || 0) + 1; };
window.confirm = () => true;
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

  // 1. empty job list
  await nav("#/");
  ok(/No jobs yet/.test(text()), "empty job list renders");

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

  // 5. Drying Log: add instance, test GPP auto-calc wiring
  await nav(`#/p/${id}/f/dryingLogs`);
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  const tables = view().querySelectorAll("table.grid");
  ok(tables.length >= 2, "drying log has equipment + psychrometric tables");
  // psychro table is the last grid; first data row inputs: [date,timeIn,timeOut,outT,outRH,outGPP,...]
  const psTable = tables[tables.length - 1];
  const row = psTable.querySelector("tbody tr");
  const inputs = row.querySelectorAll("input");
  setInput(inputs[3], "70"); // outT
  setInput(inputs[4], "50"); // outRH
  await tick();
  ok(inputs[5].value === "54", "GPP auto-calculates from T/RH in the grid (got " + inputs[5].value + ")");

  // 6. Work Authorization (single) renders with signature pads
  await nav(`#/p/${id}/f/workAuth`);
  await tick(40);
  ok(/Scope of Authorized Work/.test(text()), "work auth renders scope");
  ok(view().querySelectorAll("canvas").length >= 2, "work auth has owner + rep signature pads");
  ok(/Upload signed copy/.test(text()), "work auth offers upload-signed-copy option");

  // 7. Invoice totals
  await nav(`#/p/${id}/f/invoices`);
  [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
  await tick(40);
  const liTable = view().querySelector("table.grid");
  const liInputs = liTable.querySelectorAll("tbody tr input");
  setInput(liInputs[1], "3");   // qty
  setInput(liInputs[3], "100"); // price
  await tick();
  ok(/\$300\.00/.test(text()), "invoice line extends + subtotals to $300.00");

  // 8. remaining single/multi forms render without throwing
  for (const key of ["constructionLogs", "changeOrders", "certDrying"]) {
    await nav(`#/p/${id}/f/${key}`);
    if (key !== "certDrying") {
      [...view().querySelectorAll("button")].find((b) => /New/.test(b.textContent))?.click();
      await tick(40);
    }
    ok(view().querySelector(".sheet") !== null, `${key} editor renders a printable sheet`);
  }

  // 9. data persisted across reload (fake-indexeddb keeps state in-process)
  await nav("#/");
  ok(/Jane Homeowner/.test(text()), "job persists and shows in list after navigation");

  console.log("\n" + (failures ? `FAILED: ${failures} check(s)` : "ALL CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
