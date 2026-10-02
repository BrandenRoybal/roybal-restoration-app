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

const { magicplanPanel, magicplanAuto } = await import("../js/magicplan.js");
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

await test("after a switch, a ready row left from the old project is never asked for, offered or adopted", async () => {
  calls.length = 0;
  const project = { id: "job1", customer: "Gina", address: "1 Elm St",
    siteVisit: { files: [], magicplan: { projectId: "pA", planId: "plA" } } };
  const rows = [readyRow("pA", "a1", "A report.pdf")];
  routes.exports = async (u) => rows.filter((r) => !/mp_project_id=eq\./.test(u) || u.includes(`mp_project_id=eq.${r.mp_project_id}`));
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
  const el2 = magicplanPanel(project, { onChanged: () => {} });   // the re-render after the failed pull
  document.body.append(el2);
  await sleep(60);
  const asked = calls.filter((c) => c.u.includes("magicplan_exports")).pop();
  assert.match(asked.u, /mp_project_id=eq\.pB/);
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

await Store.all();   // let IndexedDB writes settle before exit
console.log(`\n${pass} online Floor plan chip checks passed.`);
