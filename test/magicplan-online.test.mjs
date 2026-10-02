/* The Floor plan chip's Magicplan card ONLINE — jsdom with fetch faked
   (role check, magicplan_exports, field_projects, the magicplan-proxy
   actions). Covers the review findings of 10/2: a picker that keeps focus,
   a re-pick of the same project, a switch that never brings the old scan
   back, a search typed while the list loads, one action at a time, and no
   automatic create over a link another device made.
   Run: node apps/field/test/magicplan-online.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="toast" hidden></div></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "history", "HTMLElement", "Node", "Event", "CustomEvent", "Image", "FileReader", "getComputedStyle", "DOMParser", "localStorage"]) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
window.localStorage.setItem("roybal-session", JSON.stringify({ access_token: "a.b.c", email: "office@x.com", expires_at: Date.now() + 1e9 }));
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
let confirms = 0;
window.confirm = () => { confirms++; return true; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
const routes = { exports: async () => [], server: async () => [], proxy: {} };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body = {};
  try { body = JSON.parse(opts.body || "{}"); } catch { /* not JSON */ }
  calls.push({ u, body });
  // an office device: owner? no. owner or office? yes.
  if (u.includes("rpc/role_is")) return resp(200, !(body.p_roles.length === 1 && body.p_roles[0] === "owner"));
  if (u.includes("magicplan_exports")) return resp(200, await routes.exports(u));
  if (u.includes("field_projects")) return resp(200, await routes.server(u));
  if (u.includes("functions/v1/magicplan-proxy")) {
    const f = routes.proxy[body.action];
    if (!f) return resp(400, { ok: false, error: "no route " + body.action });
    try { return resp(200, { ok: true, data: await f(body) }); } catch (e) { return resp(500, { ok: false, error: e.message }); }
  }
  return resp(404, {});
};

const { magicplanPanel, magicplanAuto, onMagicplanLive, adoptRow, pendingExport } = await import("../js/magicplan.js");
const { Store } = await import("../js/core.js");

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
console.log("Magicplan card online (DOM, faked network)");
const btn = (el, re) => [...el.querySelectorAll("button")].find((b) => re.test(b.textContent));
const until = async (cond, ms = 2000) => { for (let t = 0; t < ms && !cond(); t += 10) await sleep(10); assert.ok(cond(), "timed out"); };
const proxyCalls = (action) => calls.filter((c) => c.u.includes("magicplan-proxy") && c.body.action === action);
const H = (c) => c.repeat(64);
const readyRow = (pid, id, name) => ({ id, mp_project_id: pid, mp_plan_id: "pl-" + pid, field_project_id: "job1", status: "ready", synced_at: "2026-10-02T20:00:00Z",
  files: [{ path: `sitevisit/job1/mp-${H(id[0])}-r.pdf`.replace(H(id[0]), H(id[0]).slice(0, 8)), name, mime: "application/pdf", size: 9, hash: H(id[0]), kind: "report" }], photos: [], statistics: null, floors_svg: [] });

await test("the picker keeps its search box (and focus) when the card's own check lands", async () => {
  calls.length = 0;
  const project = { id: "job1", customer: "Gina", address: "1 Elm St",
    siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA", createdAt: "2026-09-30T20:00:00Z", importedAt: "2026-10-01T20:00:00Z", syncedAt: "2026-10-01T20:00:00Z" } } };
  routes.proxy.status = async () => { await sleep(150); return { userModified: "" }; };
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pB", name: "Gina scan", address: "1 Elm", createdAt: "2026-09-29T20:00:00Z", modifiedAt: "", externalReferenceId: "" }], complete: true });
  const el = magicplanPanel(project, { onChanged: () => {} });
  document.body.append(el);
  await sleep(5);
  btn(el, /Link a different/).click();
  await sleep(10);
  const input = el.querySelector("input[type=search]");
  input.focus();
  assert.equal(document.activeElement, input);
  await until(() => proxyCalls("status").length === 1);
  await sleep(200);
  assert.ok(el.contains(input), "still in the card");
  assert.equal(document.activeElement, input, "still focused");
  el.remove();
});

await test("a job adopted through the admin's Link to job can pick the same project again, and Pull then sends linked", async () => {
  calls.length = 0; confirms = 0;
  const project = { id: "job1", customer: "Gina", address: "1 Elm St",
    siteVisit: { files: [], magicplan: { projectId: "pP", planId: "plP", importedAt: "2026-10-01T20:00:00Z", syncedAt: "2026-10-01T20:00:00Z" } } };
  routes.proxy.status = async () => ({ userModified: "" });
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pP", name: "Scan P", address: "", createdAt: "", modifiedAt: "", externalReferenceId: "" }], complete: true });
  routes.proxy.linkProject = async (b) => ({ projectId: b.projectId, planId: "plP", cloudUrl: "", createdAt: "2026-09-20T20:00:00Z", name: "Scan P", externalReferenceId: "" });
  routes.proxy.sync = async () => ({ id: "row-P", status: "ready" });
  routes.exports = async () => [];
  const el = magicplanPanel(project, { onChanged: () => {} });
  document.body.append(el);
  await sleep(20);
  btn(el, /Link a different/).click();
  await until(() => btn(el, /Scan P/));
  btn(el, /Scan P/).click();
  await until(() => proxyCalls("sync").length === 1);
  assert.equal(confirms, 1);
  assert.equal(proxyCalls("linkProject").length, 1);
  assert.equal(proxyCalls("sync")[0].body.linked, true);
  assert.equal(project.siteVisit.magicplan.linked, "pP");
  assert.equal(project.siteVisit.magicplan.importedAt, "2026-10-01T20:00:00Z", "the same project keeps its stamps");
  el.remove();
});

// the magicplan_exports table, as PostgREST filters it
const table = (rows) => async (u) => rows.filter((r) => r.status === "ready" &&
  (!/mp_project_id=eq\./.test(u) || u.includes(`mp_project_id=eq.${r.mp_project_id}`)) &&
  (!/mp_project_id=neq\./.test(u) || !u.includes(`mp_project_id=neq.${r.mp_project_id}`)));

await test("after a switch, a ready row left from the old project is stamped done at once, never offered or adopted", async () => {
  calls.length = 0;
  const project = { id: "job1", customer: "Gina", address: "1 Elm St",
    siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA" } } };
  const rows = [readyRow("pA", "a1", "A report.pdf")];
  routes.exports = table(rows);
  routes.proxy.markImported = async (b) => { const r = rows.find((x) => x.id === b.exportId); r.status = "imported"; return { id: r.id }; };
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pB", name: "Scan B", address: "", createdAt: "", modifiedAt: "", externalReferenceId: "" }], complete: true });
  routes.proxy.linkProject = async (b) => ({ projectId: b.projectId, planId: "plB", name: "Scan B", externalReferenceId: "" });
  routes.proxy.sync = async () => { throw new Error("Magicplan GET /projects/pB failed (503)"); };
  const el = magicplanPanel(project, { onChanged: () => {} });
  document.body.append(el);
  await until(() => btn(el, /Add to packet/));   // A's row waits (office device: no auto-adopt)
  btn(el, /Link a different/).click();
  await until(() => btn(el, /Scan B/));
  btn(el, /Scan B/).click();
  await until(() => proxyCalls("sync").length === 1);
  await sleep(50);
  assert.ok(!btn(el, /Add to packet/), "the old row isn't offered under the new link");
  assert.ok(btn(el, /⟳ Pull/), "Pull is there to try again");
  assert.deepEqual(proxyCalls("markImported").map((c) => c.body.exportId), ["a1"], "the old project's scan is done with: no copy can adopt it now");
  rows[0].status = "ready";   // even if that stamp had failed, this job never offers it
  const el2 = magicplanPanel(project, { onChanged: () => {} });   // the re-render after the failed pull
  document.body.append(el2);
  await sleep(60);
  assert.ok(!btn(el2, /Add to packet/));
  assert.deepEqual(project.siteVisit.files, []);
  assert.equal(project.siteVisit.magicplan.planId, "plB");
  el.remove(); el2.remove();
});

await test("a search typed while the first list is still loading goes to Magicplan once that list turns out partial", async () => {
  calls.length = 0;
  const project = { id: "job2", customer: "X", address: "", siteVisit: { files: [] } };
  routes.exports = async () => [];
  routes.proxy.listProjects = async (b) => (b.query
    ? { projects: [{ id: "old", name: "Smith basement", address: "", createdAt: "2024-01-01T00:00:00Z", modifiedAt: "", externalReferenceId: "" }], complete: false }
    : (await sleep(150), { projects: [{ id: "new", name: "Jones", address: "", createdAt: "2026-10-01T00:00:00Z", modifiedAt: "", externalReferenceId: "" }], complete: false }));
  const el = magicplanPanel(project, {});
  document.body.append(el);
  await sleep(20);
  btn(el, /Link existing/).click();
  await sleep(10);
  const input = el.querySelector("input[type=search]");
  input.value = "smith"; input.dispatchEvent(new window.Event("input"));
  await until(() => proxyCalls("listProjects").some((c) => c.body.query === "smith"));
  await until(() => btn(el, /Smith basement/));
  el.remove();
});

await test("one action at a time: starting one closes the picker", async () => {
  calls.length = 0;
  const project = { id: "job3", customer: "X", address: "", siteVisit: { files: [] } };
  routes.server = async () => [{ mp: null }];
  let release;
  routes.proxy.createProject = () => new Promise((r) => { release = () => r({ projectId: "pNew", planId: "plNew", cloudUrl: "", createdAt: "" }); });
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pB", name: "Scan B", address: "", createdAt: "", modifiedAt: "", externalReferenceId: "" }], complete: true });
  const el = magicplanPanel(project, {});
  document.body.append(el);
  await sleep(20);
  btn(el, /Link existing/).click();
  await until(() => btn(el, /Scan B/));
  btn(el, /Create Magicplan project/).click();
  await until(() => proxyCalls("createProject").length === 1);
  assert.equal(el.querySelector("input[type=search]"), null, "the picker closed");
  assert.equal(btn(el, /Scan B/), undefined);
  release();
  await until(() => project.siteVisit.magicplan && project.siteVisit.magicplan.projectId === "pNew");
  el.remove();
});

await test("no automatic create over a link another device made; a failed check creates nothing this pass", async () => {
  calls.length = 0;
  const tile = { siteVisit: { at: "2026-10-03T17:00" }, customer: "Gina" };
  routes.proxy.createProject = async () => ({ projectId: "dup", planId: "pl", cloudUrl: "", createdAt: "" });
  routes.server = async () => [{ mp: "pLinkedElsewhere" }];
  const a = { id: "job4", bidOf: "lead_4", customer: "Gina", address: "", siteVisit: { files: [] } };
  magicplanAuto(a, {}).setTile(tile);
  await sleep(80);
  assert.equal(proxyCalls("createProject").length, 0);
  assert.ok(!a.siteVisit.magicplan);
  routes.server = async () => { throw new Error("offline"); };
  const b = { id: "job5", bidOf: "lead_5", customer: "Gina", address: "", siteVisit: { files: [] } };
  magicplanAuto(b, {}).setTile(tile);
  await sleep(80);
  assert.equal(proxyCalls("createProject").length, 0);
  routes.server = async () => [];   // not on the server yet: a brand-new bid file
  const c = { id: "job6", bidOf: "lead_6", customer: "Gina", address: "", siteVisit: { files: [] } };
  magicplanAuto(c, {}).setTile(tile);
  await until(() => proxyCalls("createProject").length === 1);
  await until(() => c.siteVisit.magicplan && c.siteVisit.magicplan.projectId === "dup");
});

await test("a hand-linked job's adopt takes its own project's scan and stamps the old project's leftovers with it", async () => {
  calls.length = 0;
  const project = { id: "job1", siteVisit: { files: [], magicplan: { projectId: "pB", linked: "pB" } } };
  const rows = [readyRow("pA", "a2", "A.pdf"), readyRow("pB", "b2", "B.pdf")];
  routes.exports = table(rows);
  const pending = await pendingExport(project);
  assert.equal(pending.row.id, "b2");
  assert.deepEqual(pending.older.map((r) => r.id), ["a2"]);
  routes.proxy.markImported = async (b) => ({ id: b.exportId });
  routes.proxy.esxExport = async () => ({ available: false });
  await adoptRow(project, pending);
  assert.deepEqual(proxyCalls("markImported").map((c) => c.body.exportId).sort(), ["a2", "b2"]);
  assert.ok(project.siteVisit.files.every((f) => !/A\.pdf/.test(f.name)));
});

await test("a scan that can't be saved is offered again", async () => {
  calls.length = 0;
  const project = { id: "job7", siteVisit: { files: [], magicplan: { projectId: "pA" } } };
  routes.exports = table([readyRow("pA", "a3", "A.pdf")]);
  const put = Store.put;
  Store.put = async () => { throw new Error("QuotaExceededError"); };
  try { await assert.rejects(adoptRow(project, await pendingExport(project)), /Quota/); }
  finally { Store.put = put; }
  const again = await pendingExport(project);
  assert.equal(again && again.row.id, "a3");
});

await test("the home's auto-adopt after the user moved on lands on the page on screen, with what was typed there", async () => {
  calls.length = 0;
  localStorage.setItem("roybal-mp-autoadopt", "1");
  await Store.put({ id: "job8", bidOf: "lead_8", customer: "Gina", siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA" } } });
  const home = await Store.get("job8"), floor = await Store.get("job8");   // route() gives each page its own copy
  floor.notes = "typed in the Floor plan";   // not saved yet (the autosave waits 350 ms)
  onMagicplanLive((id) => (id === "job8" ? floor : null));   // app.js: the Floor plan is on screen
  routes.exports = async () => [];
  routes.proxy.markImported = async (b) => ({ id: b.exportId });
  routes.proxy.esxExport = async () => ({ available: false });
  routes.proxy.status = async () => ({ userModified: "" });
  let rerendered = 0;
  const el = magicplanPanel(floor, { onChanged: () => { rerendered++; } });   // the Floor plan, open, nothing waiting yet
  document.body.append(el);
  await sleep(30);
  routes.exports = table([readyRow("pA", "a8", "A8.pdf")]);   // the export lands
  magicplanAuto(home, {}).setTile({ siteVisit: { at: "2026-10-03T17:00" } });
  await until(() => proxyCalls("markImported").length === 1);
  const stored = await Store.get("job8");
  assert.equal(stored.notes, "typed in the Floor plan", "what was typed on the Floor plan is kept");
  assert.ok(stored.siteVisit.files.some((f) => f.name === "A8.pdf"), "and the scan is in");
  assert.ok(floor.siteVisit.files.some((f) => f.name === "A8.pdf"), "in the page's own copy too");
  await until(() => rerendered === 1);   // the open Floor plan re-renders onto the new rows
  el.remove();
  onMagicplanLive(null);
  localStorage.removeItem("roybal-mp-autoadopt");
});

await test("an auto-create that finishes after a link was saved leaves the link alone, and Link waits while a create runs", async () => {
  calls.length = 0;
  await Store.put({ id: "job9", bidOf: "lead_9", customer: "Gina", address: "", siteVisit: { files: [] } });
  const home = await Store.get("job9"), floor = await Store.get("job9");
  routes.server = async () => [];
  let release;
  routes.proxy.createProject = () => new Promise((r) => { release = () => r({ projectId: "dup", planId: "pl", cloudUrl: "", createdAt: "" }); });
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pB", name: "Scan B", address: "", createdAt: "", modifiedAt: "", externalReferenceId: "" }], complete: true });
  routes.exports = async () => [];
  magicplanAuto(home, {}).setTile({ siteVisit: { at: "2026-10-03T17:00" } });
  await until(() => proxyCalls("createProject").length === 1);
  const el = magicplanPanel(floor, { onChanged: () => {} });
  document.body.append(el);
  await sleep(20);
  btn(el, /Link existing/).click();
  await until(() => btn(el, /Scan B/));
  btn(el, /Scan B/).click();
  await sleep(30);
  assert.equal(proxyCalls("linkProject").length, 0, "Link waits for the create");
  // a link that reached the page on screen meanwhile (as a sync would graft it) wins
  onMagicplanLive((id) => (id === "job9" ? floor : null));
  floor.siteVisit.magicplan = { projectId: "pB", linked: "pB" };
  release();
  await sleep(60);
  assert.equal(floor.siteVisit.magicplan.projectId, "pB");
  assert.ok(!(await Store.get("job9")).siteVisit.magicplan, "nothing saved over it");
  assert.ok(!home.siteVisit.magicplan, "the home's copy isn't handed the duplicate either");
  onMagicplanLive(null);
  el.remove();
});

await test("a scan landing while the picker is open waits to re-render the form until the picker closes", async () => {
  calls.length = 0;
  localStorage.setItem("roybal-mp-autoadopt", "1");
  const project = { id: "job10", siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA" } } };
  routes.exports = table([readyRow("pA", "a10", "A10.pdf")]);
  routes.proxy.markImported = async (b) => { await sleep(150); return { id: b.exportId }; };
  routes.proxy.esxExport = async () => ({ available: false });
  routes.proxy.status = async () => ({ userModified: "" });
  routes.proxy.listProjects = async () => ({ projects: [], complete: true });
  let rerendered = 0;
  const el = magicplanPanel(project, { onChanged: () => { rerendered++; } });
  document.body.append(el);
  await sleep(5);
  btn(el, /Link a different/).click();
  await sleep(10);
  const input = el.querySelector("input[type=search]");
  input.focus();
  await until(() => proxyCalls("markImported").length === 1);
  await sleep(250);
  assert.ok(project.siteVisit.files.some((f) => f.name === "A10.pdf"), "the scan is in");
  assert.equal(rerendered, 0, "no re-render under the open picker");
  assert.ok(el.contains(input));
  assert.equal(document.activeElement, input);
  btn(el, /^Cancel$/).click();
  assert.equal(rerendered, 1, "closing the picker shows it");
  el.remove();
  localStorage.removeItem("roybal-mp-autoadopt");
});

await test("a sketch exported for the old plan never lands on a job relinked while it ran", async () => {
  calls.length = 0;
  localStorage.setItem("roybal-mp-autoadopt", "1");
  await Store.put({ id: "job11", siteVisit: { files: [], magicplan: { projectId: "pA", planId: "pl-pA" } } });
  const home = await Store.get("job11");
  routes.exports = table([readyRow("pA", "a11", "A11.pdf")]);
  routes.proxy.markImported = async (b) => ({ id: b.exportId });
  let release;
  routes.proxy.esxExport = () => new Promise((r) => { release = () => r({ available: true, esx: { path: "sitevisit/job11/mp-pl-pA.esx", name: "a.esx", hash: "e".repeat(64) } }); });
  magicplanAuto(home, {}).setTile({ siteVisit: { at: "2026-10-03T17:00" } });
  await until(() => proxyCalls("esxExport").length === 1);
  const floor = await Store.get("job11");   // the user opens the Floor plan and links pB
  floor.siteVisit.magicplan = { projectId: "pB", planId: "pl-pB", linked: "pB", switchedFrom: "pA" };
  await Store.put(floor);
  release();
  await sleep(60);
  assert.ok(!((await Store.get("job11")).supportDocs || []).length, "no old sketch on the relinked job");
  localStorage.removeItem("roybal-mp-autoadopt");
});

await test("picking the project that's already linked also shows a scan that landed under the picker", async () => {
  calls.length = 0;
  localStorage.setItem("roybal-mp-autoadopt", "1");
  const project = { id: "job12", siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA", linked: "pA" } } };
  routes.exports = table([readyRow("pA", "a12", "A12.pdf")]);
  routes.proxy.markImported = async (b) => { await sleep(150); return { id: b.exportId }; };
  routes.proxy.esxExport = async () => ({ available: false });
  routes.proxy.status = async () => ({ userModified: "" });
  routes.proxy.listProjects = async () => ({ projects: [{ id: "pA", name: "Scan A", address: "", createdAt: "", modifiedAt: "", externalReferenceId: "" }], complete: true });
  let rerendered = 0;
  const el = magicplanPanel(project, { onChanged: () => { rerendered++; } });
  document.body.append(el);
  await sleep(5);
  btn(el, /Link a different/).click();
  await until(() => proxyCalls("markImported").length === 1);
  await sleep(250);
  assert.equal(rerendered, 0);
  btn(el, /Scan A/).click();
  assert.equal(rerendered, 1);
  el.remove();
  localStorage.removeItem("roybal-mp-autoadopt");
});

await Store.all();   // let IndexedDB writes settle before exit
console.log(`\n${pass} online Floor plan chip checks passed.`);
