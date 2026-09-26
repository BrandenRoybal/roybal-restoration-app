/* magicplan-proxy — the pure half (magicplan.ts) and the sync algorithm with
   its I/O faked. Run from the repo root:
     node --test --experimental-strip-types supabase/functions/magicplan-proxy/magicplan.test.mjs
   (picked up by `npm run fn:test`).

   Fixtures are hand-written from the live OpenAPI 3.1.1 shapes (API v1.2,
   read 2026-09-25) — never a recorded response, never a key, never a real
   customer's address. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./magicplan.ts";
import * as C from "../../../apps/field/js/magicplancalc.js";
import { isSitePath as officeIsSitePath } from "../roybal-ai-office/sitevisit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

/* ---------- live-shape fixtures ---------- */
const PROJECT = (o = {}) => ({ data: {
  id: "5d0c3a3e-0000-4000-8000-000000000001", plan_id: "6a45b1435520f", external_reference_id: "bj-lead_42",
  name: "[STAGING] Test Customer — 1 Test St", thumbnail_url: "https://example.invalid/t.png", cloud_url: "https://cloud.magicplan.app/projects/x",
  team: null, user: { id: "u", email: "owner@example.invalid", firstname: "", lastname: "" },
  address: { street: "1 Test St", city: "Fairbanks", country: "US", postal_code: "99701", latitude: null, longitude: null },
  user_created: "2026-09-25T18:00:00Z", user_modified: "2026-09-26T22:40:00Z", archived_at: null, ...o,
} });
const FILES = { data: {
  files: [{ name: "Report.pdf", folder: "Report PDF", url: "https://files.example.invalid/r.pdf?sig=1", last_modified: "2026-09-26T22:39:00Z", size: 5, file_type: "pdf" }],
  photos: [
    { symbol_instance_id: "sym-1", name: "1st Floor - Living Room - Window - 1.jpg", folder: "Captured photos", url: "https://files.example.invalid/p1.jpg?sig=1", last_modified: "2026-09-26T22:30:00Z", size: 3, file_type: "jpg" },
    { symbol_instance_id: "sym-2", name: "1st Floor - Living Room - Outlet - 2.jpg", folder: "Captured photos", url: "https://files.example.invalid/p2.jpg?sig=1", last_modified: "2026-09-26T22:31:00Z", size: 3, file_type: "jpg" },
  ],
} };
const room = (name, o = {}) => ({ uid: "r", name, area: 0, perimeter: 0, ground_perimeter: 0, area_without_walls: 0, height: 0, volume: 0,
  walls_surface: 0, walls_surface_without_openings: 0, door_count: 0, window_count: 0, dimensions: "", furnitures: [], wall_items: [], ...o });
const STATS = { id: "6a45b1435520f", project_id: "5d0c3a3e-0000-4000-8000-000000000001", units: "imperial", statistics: {
  uid: "p", name: "plan", room_count: 1, floors: [{ uid: "f1", name: "1st Floor", height: 8, room_count: 1,
    rooms: [room("Living Room", { area_without_walls: 214.4, ground_perimeter: 58, height: 8, volume: 1715, walls_surface: 465, walls_surface_without_openings: 403, door_count: 2, window_count: 3 })] }],
} };
const PLAN = { data: { id: "p", name: "plan", unit: "feet", plan_data: { floors: [{ uid: "f1", name: "1st Floor", image: "https://cloud.magicplan.app/api/v2/images/plan/6a45b1435520f/svg/f1.svg", rooms: [] }] } } };
const WORKSPACE = { id: "ws-1", name: "Roybal Construction", owner: { id: "o", email: "owner@example.invalid", firstname: "", lastname: "" },
  created: "2026-01-01", formats: ["pdf"], webhook_url: null, listing_url: null, authorize_url: null, authentication_url: "", access_token_url: null,
  logo: null, notify_user: false, last_modified: "2026-09-24", users: [] };

/* ---------- lockstep with the field app ---------- */
test("server and field app normalize the same statistics identically", () => {
  const metric = { ...STATS, units: "metric", statistics: { floors: [{ name: "Ground", height: 2.44, rooms: [room("Kitchen", { area_without_walls: 10, ground_perimeter: 13, volume: 24.4, walls_surface: 31.7, walls_surface_without_openings: 27 })] },
    { name: "Upstairs", rooms: [room("Kitchen"), room("Bath"), room("bath")] }] } };
  for (const s of [STATS, metric, {}, null]) {
    assert.deepEqual(S.normalizeStatistics(s), C.normalizeStatistics(s));
    assert.deepEqual(S.dedupeRoomNames(S.normalizeStatistics(s).floors), C.dedupeRoomNames(C.normalizeStatistics(s).floors));
  }
});
test("server and field app parse photo names and build paths identically", () => {
  for (const n of ["1st Floor - Living Room - Window - 2.jpg", "IMG_1.jpg", "a - b - c - d - 9.JPG", "", "Basement - Utility - Water Heater - 1.jpeg"]) {
    assert.deepEqual(S.parsePhotoName(n), C.parsePhotoName(n), n);
  }
  const h = "0123456789abcdef".repeat(4);
  for (const [job, name] of [["bj-lead_42", "Report.pdf"], ["bj-x", "../../etc/passwd"], ["p_1", "1st Floor - Living Room - Window - 2.jpg"]]) {
    assert.equal(S.mpFilePath(job, h, name), C.mpFilePath(job, h, name));
  }
  assert.equal(S.projectName("A", "1 St"), C.projectName("A", "1 St"));
});
test("every server-written path passes the estimator's own isSitePath() (§6 ruling 11)", () => {
  const h = "f".repeat(64);
  for (const name of ["Report.pdf", "1st Floor - Living Room - Window - 2.jpg", "1st Floor.svg", "x".repeat(300) + ".jpg", "résumé (1).pdf", ""]) {
    const p = S.mpFilePath("bj-lead_42", h, name);
    assert.ok(officeIsSitePath(p), p);
    assert.equal(S.isSitePath(p), officeIsSitePath(p));
  }
  assert.equal(S.isSitePath("sitevisit/../x/y.pdf"), officeIsSitePath("sitevisit/../x/y.pdf"));
});

/* ---------- parsers: one live shape each ---------- */
test("projectOf reads {data: Project}; findOurs matches on external_reference_id, live only", () => {
  const p = S.projectOf(PROJECT());
  assert.deepEqual([p.id, p.planId, p.externalReferenceId, p.cloudUrl, p.archivedAt], ["5d0c3a3e-0000-4000-8000-000000000001", "6a45b1435520f", "bj-lead_42", "https://cloud.magicplan.app/projects/x", null]);
  const list = { data: [{ id: "a", external_reference_id: "other", archived_at: null }, { id: "b", external_reference_id: "bj-lead_42", archived_at: "2026-09-01T00:00:00Z" },
    { id: "c", external_reference_id: "bj-lead_42", archived_at: null }], page_info: {} };
  assert.equal(S.findOurs(list, "bj-lead_42"), "c");
  assert.equal(S.findOurs({ data: [] }, "bj-lead_42"), null);
});
test("a response in the wrong shape throws with the call's name — no guessing", () => {
  assert.throws(() => S.projectOf(PROJECT().data), /Magicplan project: unexpected response shape/);
  assert.throws(() => S.filesOf({ files: [] }), /plan files/);
  assert.throws(() => S.statisticsOf({ data: STATS }), /statistics/);   // statistics is NOT wrapped
  assert.throws(() => S.workspaceOf({ data: WORKSPACE }), /workspace/); // nor is workspace
  assert.throws(() => S.findOurs({ projects: [] }, "x"), /project search/);
});
test("filesOf, floorImagesOf, workspaceOf read the live shapes", () => {
  const f = S.filesOf(FILES);
  assert.equal(f.files[0].folder, "Report PDF");
  assert.equal(f.photos[1].symbolInstanceId, "sym-2");
  assert.deepEqual(S.floorImagesOf(PLAN), [{ name: "1st Floor", image: PLAN.data.plan_data.floors[0].image }]);
  assert.equal(S.workspaceOf(WORKSPACE).name, "Roybal Construction");
});
test("createProjectBody: prefix + \"<Customer> — <street>\", our id, the secret's email", () => {
  const b = S.createProjectBody({ fieldProjectId: "bj-lead_42", customer: "Test Customer", address: { street: "1 Test St", city: "Fairbanks", postal_code: "99701", country: "US" } },
    "owner@example.invalid", "[STAGING] ");
  assert.deepEqual(b, { name: "[STAGING] Test Customer — 1 Test St", external_reference_id: "bj-lead_42", email: "owner@example.invalid",
    address: { street: "1 Test St", city: "Fairbanks", postal_code: "99701", country: "US" } });
  assert.equal(S.createProjectBody({ fieldProjectId: "x" }, "e", "").address.country, "US");
});
test("errors read {message, data}; 429 backs off per Retry-After, capped", () => {
  assert.equal(S.mpErrorText(401, { message: "Unauthorized", data: "Invalid key" }, "GET /workspace"), "Magicplan GET /workspace failed (401): Unauthorized — Invalid key");
  assert.equal(S.retryDelayMs("2"), 2000);
  assert.equal(S.retryDelayMs(null), 3000);
  assert.equal(S.retryDelayMs("600"), 30000);
});
test("mime types follow the file name", () => {
  assert.equal(S.mimeOf("Report.pdf"), "application/pdf");
  assert.equal(S.mimeOf("x.JPG"), "image/jpeg");
  assert.equal(S.mimeOf("f.svg"), "image/svg+xml");
  assert.equal(S.mimeOf("noext", "png"), "image/png");
});

/* ---------- the sync, with fakes ---------- */
function fakes({ project = PROJECT(), prior = [] } = {}) {
  const calls = { mp: [], fetched: [], uploaded: [] };
  const deps = {
    mp: async (p) => {
      calls.mp.push(p);
      if (p === `/projects/${project.data.id}`) return project;
      if (p.startsWith("/plans/6a45b1435520f/files")) return FILES;
      if (p === "/plans/statistics/6a45b1435520f") return STATS;
      if (p === `/projects/${project.data.id}/plan`) return PLAN;
      throw new Error("unexpected call " + p);
    },
    fetchBytes: async (url) => { calls.fetched.push(url); return new TextEncoder().encode(url); },
    sha256: async (bytes) => { const { createHash } = await import("node:crypto"); return createHash("sha256").update(bytes).digest("hex"); },
    upload: async (path, bytes, mime) => { calls.uploaded.push({ path, mime }); },
    priorRows: async () => prior,
    now: () => "2026-09-26T23:00:00Z",
  };
  return { deps, calls };
}

test("sync copies the report, the room-tagged photos and the floor SVG, and builds a ready row", async () => {
  const { deps, calls } = fakes();
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.field_project_id, "bj-lead_42");
  assert.equal(row.mp_plan_id, "6a45b1435520f");
  assert.equal(row.files.length, 1);
  assert.equal(row.files[0].mime, "application/pdf");
  assert.match(row.files[0].path, /^sitevisit\/bj-lead_42\/mp-[0-9a-f]{8}-Report\.pdf$/);
  assert.deepEqual(row.photos.map((p) => [p.room, p.caption, p.symbol_instance_id]), [["Living Room", "Window", "sym-1"], ["Living Room", "Outlet", "sym-2"]]);
  assert.equal(row.statistics.floors[0].rooms[0].floorSF, 214);
  assert.equal(row.floors_svg[0].floor, "1st Floor");
  assert.equal(calls.uploaded.length, 4);
  assert.ok(calls.uploaded.every((u) => officeIsSitePath(u.path)));
  assert.ok(calls.mp.includes("/plans/6a45b1435520f/files?format[]=pdf&include_photos=true"));
  assert.equal(row.synced_at, "2026-09-26T23:00:00Z");
});
test("a project that belongs to another job comes back unmatched with nothing downloaded", async () => {
  const { deps, calls } = fakes({ project: PROJECT({ external_reference_id: "bj-someone-else" }) });
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "unmatched");
  assert.equal(row.field_project_id, null);
  assert.equal(calls.fetched.length + calls.uploaded.length, 0);
  assert.deepEqual(calls.mp, ["/projects/5d0c3a3e-0000-4000-8000-000000000001"]);
});
test("…unless the office linked it by hand (Link to job)", async () => {
  const { deps } = fakes({ project: PROJECT({ external_reference_id: "" }) });
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42", trustLink: true });
  assert.equal(row.status, "ready");
  assert.equal(row.field_project_id, "bj-lead_42");
});
test("a second pull downloads nothing it already holds for this job", async () => {
  const first = await S.runSync(fakes().deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  const { deps, calls } = fakes({ prior: [first] });
  const again = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(calls.fetched.length, 0);
  assert.equal(calls.uploaded.length, 0);
  assert.deepEqual(again.photos.map((p) => p.hash), first.photos.map((p) => p.hash));
  assert.deepEqual(again.files.map((p) => p.path), first.files.map((p) => p.path));
  // …but the same scan relinked to ANOTHER job gets its own copies
  const other = fakes({ prior: [first], project: PROJECT({ external_reference_id: "bj-other" }) });
  const moved = await S.runSync(other.deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-other" });
  assert.equal(other.calls.uploaded.length, 4);
  assert.ok(moved.files[0].path.startsWith("sitevisit/bj-other/"));
});
test("a failing Magicplan call propagates (the caller records a failed row and toasts it)", async () => {
  const { deps } = fakes();
  deps.mp = async () => { throw new Error("Magicplan GET /projects/x failed (500)"); };
  await assert.rejects(S.runSync(deps, { projectId: "x", fieldProjectId: "bj-lead_42" }), /failed \(500\)/);
});

/* ---------- the fence (design §8) ---------- */
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(js|mjs|html|json|css)$/.test(n)) out.push(p);
  }
  return out;
}
test("no browser code talks to Magicplan: no cloud.magicplan.app anywhere under apps/", () => {
  const hits = walk(join(repo, "apps")).filter((f) => readFileSync(f, "utf8").includes("cloud.magicplan.app"));
  assert.deepEqual(hits, []);
});
test("the proxy is pinned verify_jwt = true", () => {
  const toml = readFileSync(join(repo, "supabase", "config.toml"), "utf8");
  assert.match(toml, /\[functions\.magicplan-proxy\]\s*\nverify_jwt = true/);
});
