/* Magicplan — the browser half (js/magicplan.js) under jsdom with the network
   gone: nothing signed in, fetch rejected. What this proves is the FAIL-CLOSED
   shape of the lane — the Bid card line paints from the file, the buttons
   leave when the roles cannot be confirmed, the Site Visit section stays
   empty, the auto-adopt switch reads and writes localStorage — and that the
   module boots in a DOM without touching the network at import time (the
   smoke test loads it through bid.js and sitevisit.js).
   Run: node apps/field/test/magicplan-dom.test.mjs   (from repo root) */
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const SHELL = `<!DOCTYPE html><html><body><main id="view"></main><div id="toast" hidden></div></body></html>`;
const dom = new JSDOM(SHELL, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event",
  "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage", "sessionStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-offline", "1");
let fetches = 0;
globalThis.fetch = () => { fetches++; return Promise.reject(new Error("offline")); };

let failures = 0;
const ok = (cond, m) => { console.log((cond ? "  ✓ " : "  ✗ ") + m); if (!cond) failures++; };
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

const mp = await import("../js/magicplan.js");
const calc = await import("../js/magicplancalc.js");
const { h } = await import("../js/core.js");

// the surface bid.js, sitevisit.js and the admin panel import (PLAN §2.14)
for (const name of ["mpGetWorkspace", "mpCreateProject", "mpStatus", "mpSync", "mpMarkImported", "mpArchiveProject", "mpLinkExport",
  "roleFlags", "autoAdoptOn", "setAutoAdopt", "fetchPendingExport", "fetchRecentExports", "ensureMagicplanProject", "adoptIfReady",
  "pullMagicplan", "checkUpdated", "magicplanBidRow", "magicplanSection", "noteMagicplanRemoved"]) {
  ok(typeof mp[name] === "function", `exports ${name}()`);
}

// 1. the Bid card line: paints from the file at once, buttons fail closed
const project = { id: "bj-x", bidOf: "x", customer: "Test Customer" };
const row = mp.magicplanBidRow(project, null, { onChanged() {} });
const holder = h("div", {}, row.value, row.btn);
ok(row.value.textContent === "not created", "value paints 'not created' from the file at once");
ok(row.btn.disabled === true, "button starts disabled until the roles resolve");
ok(row.btn.textContent === "📐 Create Magicplan project", "button offers Create for a file with no project");
await tick(60);
ok(row.btn.parentNode === null && holder.childNodes.length === 1, "roles fail closed → the button leaves the line");
ok(row.value.textContent === "not created", "the value is untouched by the failed refine");
ok(fetches === 0, "nothing was fetched: not signed in means no network at all");

// 1b. a file with an adopted scan paints the imported line with no network
const adopted = { id: "bj-y", bidOf: "y", siteVisit: { files: [{ id: "mp-a", kind: "photos", source: "magicplan" }], magicplan: { projectId: "p1", planId: "pl1", createdAt: "2026-09-26T18:00:00.000000+00:00", syncedAt: "2026-09-26T20:00:00.000Z" } },
  floorPlan: { dimensions: { rooms: [{ name: "A", source: "magicplan" }, { name: "B" }] } } };
const row2 = mp.magicplanBidRow(adopted, { siteVisit: { at: "2026-09-26T14:00" } }, { onChanged() {} });
ok(/^imported · synced \d{1,2}\/\d{1,2} \d{1,2}:\d{2} (AM|PM) · 1 photo · 1 room$/.test(row2.value.textContent), "an adopted file paints 'imported · synced … · 1 photo · 1 room': " + row2.value.textContent);
ok(row2.btn.textContent === "⟳ Pull", "a file with a project offers Pull");
await tick(60);
ok(row2.btn.parentNode === null, "Pull also leaves when the roles cannot be confirmed");
ok(fetches === 0, "no auto-create attempt either");

// 2. the Site Visit section: one stable node, empty when nothing can be confirmed
const sec = mp.magicplanSection({ project, onAdopted() {} });
ok(sec.node instanceof window.HTMLDivElement && sec.node.childNodes.length === 0, "section node is an empty div before refresh");
const before = sec.node;
await sec.refresh();
ok(sec.node === before && sec.node.childNodes.length === 0, "refresh() keeps the same node and leaves it empty (not office / offline)");

// 3. the per-device auto-adopt switch
window.localStorage.removeItem("roybal-mp-autoadopt");
ok(mp.autoAdoptOn({ owner: true }) === true && mp.autoAdoptOn({ owner: false }) === false, "unset follows the owner flag");
mp.setAutoAdopt(true);
ok(window.localStorage.getItem("roybal-mp-autoadopt") === "1" && mp.autoAdoptOn({ owner: false }) === true, "setAutoAdopt(true) wins over a non-owner");
mp.setAutoAdopt(false);
ok(window.localStorage.getItem("roybal-mp-autoadopt") === "0" && mp.autoAdoptOn({ owner: true }) === false, "setAutoAdopt(false) wins over the owner");
window.localStorage.removeItem("roybal-mp-autoadopt");
ok(mp.autoAdoptOn({ owner: true }) === true, "removing the key goes back to the owner default");

// 4. the words come from the pure module
ok(/^imported · synced /.test(calc.bidMagicplanText(adopted, {})), "bidMagicplanText renders the imported line from calc");
ok(calc.bidMagicplanText(project, {}) === "not created", "bidMagicplanText renders 'not created' from calc");

// 5. the reads and wrappers fail the way the admin panel expects
ok((await mp.roleFlags()).office === false, "roleFlags() is fail-closed when not signed in");
ok(Array.isArray(await mp.fetchRecentExports(10)) && (await mp.fetchRecentExports(10)).length === 0, "fetchRecentExports() → [] when nothing is reachable");
ok(Array.isArray(await mp.fetchPendingExport(project)) && (await mp.fetchPendingExport(project)).length === 0, "fetchPendingExport() → [] when nothing is reachable");
let threw = "";
try { await mp.mpGetWorkspace(); } catch (e) { threw = e.message; }
ok(threw === "Sign in first", "a proxy wrapper rejects with 'Sign in first' when not signed in: " + threw);
threw = "";
try { await mp.pullMagicplan(project); } catch (e) { threw = e.message; }
ok(threw === "Create the Magicplan project first", "pullMagicplan refuses a file with no project");
ok((await mp.ensureMagicplanProject({ id: "j", customer: "x" }, null)).reason === "not-bid", "ensureMagicplanProject refuses a non-bid file");
ok((await mp.ensureMagicplanProject(project, null)).reason === "offline", "ensureMagicplanProject reports offline before any role lookup");
ok((await mp.checkUpdated(adopted)).status === null, "checkUpdated → { updated:false, status:null } offline");
const sv = { files: [] };
mp.noteMagicplanRemoved(sv, "mp-aaaaaaaa");
ok(sv.magicplan.removed[0] === "mp-aaaaaaaa", "noteMagicplanRemoved writes the tombstone");
ok(fetches === 0, "the whole file ran without one network call");

console.log("\n" + (failures ? `FAILED: ${failures} check(s)` : "MAGICPLAN DOM OK"));
process.exit(failures ? 1 : 0);
