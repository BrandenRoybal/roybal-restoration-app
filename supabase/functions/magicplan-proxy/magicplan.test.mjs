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
/* the normalizer's input shape (field app lockstep) */
const LEGACY = { id: "6a45b1435520f", project_id: "5d0c3a3e-0000-4000-8000-000000000001", units: "imperial", statistics: {
  uid: "p", name: "plan", room_count: 1, floors: [{ uid: "f1", name: "1st Floor", height: 8, room_count: 1,
    rooms: [room("Living Room", { area_without_walls: 214.4, ground_perimeter: 58, height: 8, volume: 1715, walls_surface: 465, walls_surface_without_openings: 403, door_count: 2, window_count: 3 })] }],
} };
/* GET /plans/statistics/{id}, live 2026-10-01: wrapped, plan totals only */
const STATS = { data: { id: "6a45b1435520f", project_id: "5d0c3a3e-0000-4000-8000-000000000001", units: "imperial",
  project_statistics: { name: "plan", area: 230, perimeter: 60, ground_perimeter: 58, area_without_walls: 214.4, room_count: 1, door_count: 2, window_count: 3 } } };
/* GET /projects/{id}/plan: per-room statistics on each room */
const PLAN = { data: { id: "p", name: "plan", unit: "feet", plan_data: { floors: [{ uid: "f1", name: "1st Floor", image: "https://cloud.magicplan.app/api/v2/images/plan/6a45b1435520f/svg/f1.svg",
  statistics: { height: 8 },
  rooms: [{ uid: "r1", name: "Living Room", formatted_dimensions: "", walls: [], objects: [],
    statistics: { area_without_walls: 214.4, ground_perimeter: 58, height: 8, volume: 1715, walls_surface: 465, walls_surface_without_openings: 403, door_count: 2, window_count: 3 } }] }] } } };
const WORKSPACE = { id: "ws-1", name: "Roybal Construction", owner: { id: "o", email: "owner@example.invalid", firstname: "", lastname: "" },
  created: "2026-01-01", formats: ["pdf"], webhook_url: null, listing_url: null, authorize_url: null, authentication_url: "", access_token_url: null,
  logo: null, notify_user: false, last_modified: "2026-09-24", users: [] };

/* ---------- lockstep with the field app ---------- */
test("server and field app normalize the same statistics identically", () => {
  const metric = { ...LEGACY, units: "metric", statistics: { floors: [{ name: "Ground", height: 2.44, rooms: [room("Kitchen", { area_without_walls: 10, ground_perimeter: 13, volume: 24.4, walls_surface: 31.7, walls_surface_without_openings: 27 })] },
    { name: "Upstairs", rooms: [room("Kitchen"), room("Bath"), room("bath")] }] } };
  for (const s of [LEGACY, metric, {}, null]) {
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
  assert.throws(() => S.planUnitsOf(STATS.data), /statistics: unexpected response shape \{id:string/);  // statistics IS wrapped (live)
  assert.throws(() => S.planUnitsOf({ data: { units: "cubits" } }), /unknown units "cubits"/);
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
  // A secret pasted with stray whitespace must not reach Magicplan (it 400s the email).
  assert.equal(S.createProjectBody({ fieldProjectId: "x" }, " owner@example.invalid \n", "").email, "owner@example.invalid");
});
test("errors read {message, data}; 429 backs off per Retry-After, capped", () => {
  assert.equal(S.mpErrorText(401, { message: "Unauthorized", data: "Invalid key" }, "GET /workspace"), "Magicplan GET /workspace failed (401): Unauthorized — Invalid key");
  assert.equal(S.mpErrorText(400, { message: "Bad Request", data: { errors: "Field 'email' is required." } }, "POST /projects"),
    "Magicplan POST /projects failed (400): Bad Request — Field 'email' is required.");
  assert.equal(S.mpErrorText(400, { data: { errors: { email: ["not a workspace user"] } } }, "POST /projects"),
    'Magicplan POST /projects failed (400): {"email":["not a workspace user"]}');
  assert.equal(S.mpErrorText(400, { error: "invalid country" }, "POST /projects"), "Magicplan POST /projects failed (400): invalid country");
  assert.equal(S.mpErrorText(400, { detail: "x" }, "POST /projects"), 'Magicplan POST /projects failed (400): {"detail":"x"}');
  assert.equal(S.mpErrorText(400, null, "POST /projects"), "Magicplan POST /projects failed (400)");
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
const FORMS = { data: [{ symbol_type: "room", symbol_instance_id: "r1", forms: [{ title: "Site walk", sections: [{ fields: [{ label: "Damage", value: "Wet drywall 2 ft" }] }] }] }] };
function fakes({ project = PROJECT(), prior = [], stats = STATS, plan = PLAN, projectFiles = { data: [] }, timeLeft } = {}) {
  const calls = { mp: [], fetched: [], uploaded: [], warned: [] };
  const deps = {
    mp: async (p) => {
      calls.mp.push(p);
      if (p === `/projects/${project.data.id}`) return project;
      if (p.startsWith("/plans/6a45b1435520f/files")) return FILES;
      if (p === "/plans/statistics/6a45b1435520f") { if (stats instanceof Error) throw stats; return stats; }
      if (p === `/projects/${project.data.id}/plan`) { if (plan instanceof Error) throw plan; return plan; }
      if (p.startsWith(`/projects/${project.data.id}/files`)) {
        const m = p.match(/\?page=(\d+)$/);
        const page = m ? Number(m[1]) : 1;
        const r = typeof projectFiles === "function" ? projectFiles(page) : projectFiles;
        if (r instanceof Error) throw r;
        return r;
      }
      if (p === "/plans/forms/6a45b1435520f") return FORMS;
      if (p === "/plans/get/6a45b1435520f") return { data: { id: "6a45b1435520f", name: "plan" } };
      throw new Error("unexpected call " + p);
    },
    fetchBytes: async (url) => { calls.fetched.push(url); return new TextEncoder().encode(url); },
    sha256: async (bytes) => { const { createHash } = await import("node:crypto"); return createHash("sha256").update(bytes).digest("hex"); },
    upload: async (path, bytes, mime) => { calls.uploaded.push({ path, mime }); },
    priorRows: async () => prior,
    now: () => "2026-09-26T23:00:00Z",
    warn: (m) => calls.warned.push(m),
    ...(timeLeft ? { timeLeft } : {}),
  };
  return { deps, calls };
}

test("sync copies the report, the room-tagged photos and the floor SVG, and builds a ready row", async () => {
  const { deps, calls } = fakes();
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.field_project_id, "bj-lead_42");
  assert.equal(row.mp_plan_id, "6a45b1435520f");
  assert.equal(row.files.filter((f) => f.kind === "report").length, 1);
  assert.deepEqual(row.files.filter((f) => f.kind === "data").map((f) => f.name), ["Magicplan plan.json", "Magicplan statistics.json", "Magicplan forms.json", "Magicplan project.json"]);
  assert.equal(row.files[0].mime, "application/pdf");
  assert.match(row.files[0].path, /^sitevisit\/bj-lead_42\/mp-[0-9a-f]{8}-Report\.pdf$/);
  assert.deepEqual(row.photos.map((p) => [p.room, p.caption, p.symbol_instance_id]), [["Living Room", "Window", "sym-1"], ["Living Room", "Outlet", "sym-2"]]);
  assert.equal(row.statistics.floors[0].rooms[0].floorSF, 214);
  assert.equal(row.floors_svg[0].floor, "1st Floor");
  assert.equal(calls.uploaded.length, 8);   // report, 2 photos, floor SVG + 4 JSON
  assert.ok(calls.uploaded.every((u) => officeIsSitePath(u.path)));
  // one format per call: the live API refuses several format[] in one request
  for (const f of S.ALL_FORMATS) assert.ok(calls.mp.includes(`/plans/6a45b1435520f/files?format[]=${f}&include_photos=true`), f);
  assert.ok(!calls.mp.some((p) => (p.match(/format\[\]=/g) || []).length > 1));
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
  assert.equal(other.calls.uploaded.length, 8);
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
/* ---------- M3: the ESX sketch (POST /plans/{id}/custom-export → {data: ProjectFile[]}) ---------- */
const PFILE = (o = {}) => ({
  id: "18878d4c-e147-427d-bd34-40a151f67150", project_id: "06b03d53-2bb0-4a5a-8db9-656b708fb962",
  filename: "Test Customer - 1 Test St.pdf", filetype: "application/pdf",
  file: { url: "https://cloud.magicplan.app/files/x.pdf", hash: "9037abf3f694cd62b7ea284103c0e7f8", size: 2048576 },
  generated_by: "ExportConfig.Report", metadata: null, ...o,
});
test("esxOf keeps only the ExportConfig.XactimateEsx file; a configuration without ESX is idle (null, nothing else)", () => {
  const esx = PFILE({ filename: "Test Customer - 1 Test St.esx", filetype: "application/octet-stream", generated_by: "ExportConfig.XactimateEsx",
    file: { url: "https://cloud.magicplan.app/files/x.esx", hash: "abcdef0123456789abcdef0123456789", size: 4321 } });
  const r = S.esxOf({ data: [PFILE(), PFILE({ generated_by: "ExportConfig.Sketch" }), esx] });
  assert.equal(r.files, 3);
  assert.deepEqual(r.esx, { filename: "Test Customer - 1 Test St.esx", mime: "application/octet-stream", url: "https://cloud.magicplan.app/files/x.esx", hash: "abcdef0123456789abcdef0123456789", size: 4321 });
  assert.deepEqual(S.esxOf({ data: [PFILE(), PFILE({ generated_by: "ExportConfig.Sketch" })] }), { esx: null, files: 2 });
  assert.deepEqual(S.esxOf({ data: [] }), { esx: null, files: 0 });
  assert.deepEqual(S.esxOf({}), { esx: null, files: 0 });
  assert.deepEqual(S.esxOf({ data: [PFILE({ generated_by: "ExportConfig.XactimateEsx", file: { hash: "", size: 0 } })] }), { esx: null, files: 1 });   // no url → nothing to fetch
  assert.equal(S.esxOf({ data: [PFILE({ generated_by: "ExportConfig.XactimateEsx", filetype: "esx" })] }).esx.mime, "application/octet-stream");   // an extension is not a MIME type
});
test("the stored ESX path is a site-visit path the estimator's signer accepts, with the .esx name kept", () => {
  const path = S.mpFilePath("lead_42", "abcdef0123456789abcdef0123456789", "Test Customer - 1 Test St.esx");
  assert.equal(path, "sitevisit/lead_42/mp-abcdef01-Test_Customer_-_1_Test_St.esx");
  assert.equal(S.isSitePath(path), true);
  assert.equal(officeIsSitePath(path), true);
  assert.equal(C.mpFilePath("lead_42", "abcdef0123456789abcdef0123456789", "Test Customer - 1 Test St.esx"), path);   // lockstep with the field app
});

test("the proxy is pinned verify_jwt = true", () => {
  const toml = readFileSync(join(repo, "supabase", "config.toml"), "utf8");
  assert.match(toml, /\[functions\.magicplan-proxy\]\s*\nverify_jwt = true/);
});

test("statistics in a shape we don't read: the report, photos and floor plan still land, the row says why", async () => {
  const { deps, calls } = fakes({ stats: { id: "6a45b1435520f", statistics: { floors: [] } } });
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.statistics, null);
  assert.equal(row.files.filter((f) => f.kind === "report").length, 1);
  assert.equal(row.photos.length, 2);
  assert.equal(row.floors_svg.length, 1);
  assert.match(row.error, /^Room measurements not imported: Magicplan statistics: unexpected response shape \{id:string,statistics:\{floors:\[\]\}\}/);
  assert.equal(calls.warned.length, 1);
  assert.equal(row.synced_at, "2026-09-26T23:00:00Z");
});
test("a failing statistics or plan call never sinks the pull", async () => {
  const { deps } = fakes({ stats: new Error("Magicplan GET /plans/statistics failed (404)"), plan: new Error("Magicplan GET /plan failed (500)") });
  const r2 = await S.runSync(fakes({ stats: new Error("Magicplan GET /plans/statistics failed (404)") }).deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(r2.floors_svg.length, 1);
  assert.match(r2.error, /^Room measurements not imported: .*\(404\)$/);
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.files.filter((f) => f.kind === "report").length, 1);
  assert.equal(row.floors_svg.length, 0);
  assert.match(row.error, /^Floor plan not read: .*\(500\)$/);
});
test("shapeOutline names keys only, never values", () => {
  const o = S.shapeOutline({ data: { address: "1 Test St", url: "https://x/y?sig=secret", floors: [{ name: "A" }] } });
  assert.equal(o, "{data:{address:string,url:string,floors:[{name}]}}");
  assert.ok(!o.includes("Test St") && !o.includes("secret"));
});

test("room measurements come from the plan's rooms, in the statistics endpoint's units", () => {
  const st = S.statsFromPlan(PLAN, S.planUnitsOf(STATS));
  assert.equal(st.units, "imperial");
  assert.deepEqual(st.floors[0].rooms[0], { name: "Living Room", floorSF: 214, perimLF: 58, ceilingFt: 8, wallSF: 465, wallSFNet: 403, doors: 2, windows: 3, volumeCF: 1715, dims: "" });
  // metric converts once, exactly as the normalizer does
  const m = S.statsFromPlan(PLAN, S.planUnitsOf({ data: { units: "metric" } }));
  assert.equal(m.units, "metric");
  assert.equal(m.floors[0].rooms[0].floorSF, Math.round(214.4 * 10.764));
  // a floor height fills a room with none
  const noH = JSON.parse(JSON.stringify(PLAN)); delete noH.data.plan_data.floors[0].rooms[0].statistics.height;
  assert.equal(S.statsFromPlan(noH, "imperial").floors[0].rooms[0].ceilingFt, 8);
  // rooms with no statistics: say so with the room's keys, never values
  const bare = JSON.parse(JSON.stringify(PLAN)); delete bare.data.plan_data.floors[0].rooms[0].statistics;
  assert.throws(() => S.statsFromPlan(bare, "imperial"), /no statistics on rooms \{uid:string,name:string,formatted_dimensions:string,walls:\[\],objects:\[\]\}/);
  // statistics with names we don't read: say which names, never values
  const odd = JSON.parse(JSON.stringify(PLAN)); odd.data.plan_data.floors[0].rooms[0].statistics = { surface_area: 20, len: 4 };
  assert.throws(() => S.statsFromPlan(odd, "imperial"), /no measurements we read in room statistics \{surface_area:number,len:number,name:string\}/);
  // a plan with no rooms is an empty, valid result
  assert.deepEqual(S.statsFromPlan({ data: { plan_data: { floors: [] } } }, "imperial"), { units: "imperial", floors: [] });
});

/* ---------- everything in the project (Branden 10/1: "download everything") ---------- */
const PLAN_ROOMS = { data: { ...PLAN.data, plan_data: { floors: [{ ...PLAN.data.plan_data.floors[0],
  rooms: [{ ...PLAN.data.plan_data.floors[0].rooms[0], image: "https://cloud.magicplan.app/api/v2/images/plan/6a45b1435520f/svg/r1.svg" }] }] } } };
const FILES_ALL = { data: {
  files: [...FILES.data.files,
    { name: "Scan.usdz", folder: "3D", url: "https://files.example.invalid/s.usdz?sig=1", last_modified: "2026-09-26T22:39:00Z", size: 7, file_type: "usdz" },
    { name: "Plan.dxf", folder: "DXF", url: "https://files.example.invalid/p.dxf?sig=1", last_modified: "2026-09-26T22:39:00Z", size: 7, file_type: "dxf" },
    { name: "Huge.ifc", folder: "IFC", url: "https://files.example.invalid/h.ifc?sig=1", last_modified: "2026-09-26T22:39:00Z", size: S.MAX_FILE_BYTES + 1, file_type: "ifc" }],
  photos: [...FILES.data.photos,
    { symbol_instance_id: "sym-3", name: "1st Floor - Living Room - Ceiling - 3.mov", folder: "Captured photos", url: "https://files.example.invalid/v.mov?sig=1", last_modified: "2026-09-26T22:32:00Z", size: 9, file_type: "mov" }],
} };
test("a pull keeps everything: 3D, drawings, videos, attachments, each room's plan, and the raw data", async () => {
  const { deps } = fakes({ plan: PLAN_ROOMS, projectFiles: { data: [{ name: "Walkthrough.mp4", url: "https://files.example.invalid/w.mp4?sig=1", size: 11 }] } });
  deps.mp = ((mp) => async (p) => (p.startsWith("/plans/6a45b1435520f/files") ? FILES_ALL : mp(p)))(deps.mp);
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  const by = (k) => row.files.filter((f) => f.kind === k).map((f) => f.name);
  assert.deepEqual(by("report"), ["Report.pdf"]);
  assert.deepEqual(by("model3d"), ["Scan.usdz"]);
  assert.deepEqual(by("drawing"), ["Plan.dxf"]);
  assert.deepEqual(by("video"), ["1st Floor - Living Room - Ceiling - 3.mov", "Walkthrough.mp4"]);
  assert.deepEqual(row.files.filter((f) => f.kind === "room").map((f) => [f.floor, f.room]), [["1st Floor", "Living Room"]]);
  assert.equal(row.photos.length, 2);   // the video isn't a photo
  assert.equal(row.files.find((f) => f.name === "Scan.usdz").mime, "model/vnd.usdz+zip");
  assert.ok(row.files.every((f) => officeIsSitePath(f.path)));
  assert.match(row.error, /Too large to copy: Huge\.ifc \(150 MB\)/);
  assert.equal(row.status, "ready");
});
test("a pull that runs low on time stops starting downloads and says to pull again", async () => {
  let left = 200_000;
  const { deps, calls } = fakes({ timeLeft: () => (left -= 50_000) });
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.ok(calls.fetched.length < 4);
  assert.match(row.error, /press ⟳ Pull again for the rest/);
});
test("project files in a shape we don't read are noted, not fatal", async () => {
  const { deps } = fakes({ projectFiles: { files: [] } });
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.match(row.error, /^Project attachments not imported: Magicplan project files: unexpected response shape \{files:\[\]\}/);
});
test("kindOf sorts what a pull brings back", () => {
  assert.deepEqual(["a.pdf", "a.usdz", "a.ifc", "a.MOV", "a.mp4", "a.jpg", "a.svg", "a.dxf", "a.csv", "a.fml", "noext"].map((n) => S.kindOf(n)),
    ["report", "model3d", "model3d", "video", "video", "photo", "drawing", "drawing", "data", "data", "data"]);
});

test("a refused file listing is noted, and the plan, room plans, measurements and data still land", async () => {
  const { deps } = fakes({ plan: PLAN_ROOMS });
  deps.mp = ((mp) => async (p) => { if (p.startsWith("/plans/6a45b1435520f/files")) throw new Error("Magicplan GET /plans/x/files failed (400)"); return mp(p); })(deps.mp);
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.floors_svg.length, 1);
  assert.equal(row.files.filter((f) => f.kind === "room").length, 1);
  assert.equal(row.statistics.floors[0].rooms[0].floorSF, 214);
  assert.match(row.error, /^Exported files and photos not imported: .*\(400\)/);
});

test("a format Magicplan refuses is named; the other formats still come in", async () => {
  const { deps } = fakes({ plan: PLAN_ROOMS });
  deps.mp = ((mp) => async (p) => { if (/format\[\]=(xml|fml)&/.test(p)) throw new Error("Magicplan GET /plans/x/files failed (400)"); return mp(p); })(deps.mp);
  const row = await S.runSync(deps, { projectId: "5d0c3a3e-0000-4000-8000-000000000001", fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.files.filter((f) => f.name === "Report.pdf").length, 1);   // listed by every format, copied once
  assert.equal(row.photos.length, 2);
  assert.match(row.error, /Magicplan refused these formats: fml, xml/);
});

test("room figures in metres on an imperial project are converted to feet", () => {
  // the live 10/1 bedroom: floor 14, perimeter 13.5, walls 37 (net 31), volume 35, no height
  const live = { data: { plan_data: { floors: [{ name: "Ground Floor", rooms: [{ name: "Bedroom",
    statistics: { area_without_walls: 14, ground_perimeter: 13.5, walls_surface: 37, walls_surface_without_openings: 31, volume: 35, door_count: 0, window_count: 0 } }] }] } } };
  const rm = S.statsFromPlan(live, "imperial").floors[0].rooms[0];
  assert.deepEqual(rm, { name: "Bedroom", floorSF: 151, perimLF: 44.5, ceilingFt: 8, wallSF: 398, wallSFNet: 334, doors: 0, windows: 0, volumeCF: 1236, dims: "" });
  // the same verdict from the plan totals, when they are in square feet
  assert.equal(S.roomScale(live.data.plan_data.floors, { area_without_walls: 150.7 }), "metric-in-imperial");
  // feet stay feet (8 ft walls), and a metric project is left to the normalizer
  assert.equal(S.roomScale(PLAN.data.plan_data.floors, STATS.data.project_statistics), "same");
  assert.equal(S.roomScale(live.data.plan_data.floors, null, "metric"), "same");
  assert.equal(S.statsFromPlan(live, "metric").floors[0].rooms[0].floorSF, 151);
  // no height anywhere: ceiling from volume / floor area
  const noH = JSON.parse(JSON.stringify(PLAN)); delete noH.data.plan_data.floors[0].rooms[0].statistics.height; delete noH.data.plan_data.floors[0].statistics;
  assert.equal(S.statsFromPlan(noH, "imperial").floors[0].rooms[0].ceilingFt, 8);
});

/* ---------- project attachments: paging, and exports listed twice ---------- */
const PID = "5d0c3a3e-0000-4000-8000-000000000001";
const att = (name, page = 1, size = 4) => ({ name, url: `https://files.example.invalid/${name}?sig=${page}`, size });
const tenJpgs = (page = 1) => Array.from({ length: 10 }, (_, i) => att(`att${i}.jpg`, page));
test("an export listed by both the plan and the project is copied once, under the plan's folder", async () => {
  const { deps, calls } = fakes({ projectFiles: { data: [att("Report.pdf", 1, 5), att("a.jpg")] } });
  const row = await S.runSync(deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  const reports = row.files.filter((f) => f.name === "Report.pdf");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].folder, "Report PDF");
  assert.ok(!calls.fetched.some((u) => u.includes("Report.pdf?sig=1")));   // the project copy is never downloaded
  assert.equal(row.files.filter((f) => f.name === "a.jpg").length, 1);
});
test("project attachments past the first page are fetched (page_info silent, a full first page)", async () => {
  const { deps, calls } = fakes({ projectFiles: (page) => ({ data: page === 1 ? tenJpgs() : page === 2 ? [att("walk.mp4", 2, 9), att("plan.thumb", 2)] : [] }) });
  const row = await S.runSync(deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  assert.ok(calls.mp.includes(`/projects/${PID}/files`));
  assert.ok(calls.mp.includes(`/projects/${PID}/files?page=2`));
  assert.ok(!calls.mp.includes(`/projects/${PID}/files?page=3`));   // page 2 wasn't full
  assert.deepEqual(row.files.filter((f) => f.kind === "video").map((f) => f.name), ["walk.mp4"]);
  assert.ok(row.files.some((f) => f.name === "plan.thumb"));
  assert.equal(row.files.filter((f) => /^att\d\.jpg$/.test(f.name)).length, 10);
  assert.equal(row.error, null);
});
test("page_info decides when it speaks: no next page, or a total that ends on this page", async () => {
  const a = fakes({ projectFiles: { data: tenJpgs(), page_info: { has_next_page: false } } });
  await S.runSync(a.deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  assert.ok(!a.calls.mp.some((p) => p.includes("?page=")));
  const b = fakes({ projectFiles: (page) => ({ data: page === 1 ? tenJpgs() : [att("late.pdf", 2)], page_info: { current_page: page, per_page: 10, total: 11 } }) });
  const row = await S.runSync(b.deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  assert.ok(b.calls.mp.includes(`/projects/${PID}/files?page=2`));
  assert.ok(!b.calls.mp.includes(`/projects/${PID}/files?page=3`));
  assert.ok(row.files.some((f) => f.name === "late.pdf"));
});
test("a server that ignores ?page= is asked once more, then left; nothing is copied twice", async () => {
  const { deps, calls } = fakes({ projectFiles: (page) => ({ data: tenJpgs(page) }) });   // same files, fresh signatures
  const row = await S.runSync(deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  assert.ok(calls.mp.includes(`/projects/${PID}/files?page=2`));
  assert.ok(!calls.mp.includes(`/projects/${PID}/files?page=3`));
  assert.equal(row.files.filter((f) => /^att\d\.jpg$/.test(f.name)).length, 10);
  assert.equal(calls.fetched.filter((u) => /\/att\d\.jpg\?/.test(u)).length, 10);
});
test("a refused second page keeps the first page and says what was missed", async () => {
  const { deps } = fakes({ projectFiles: (page) => (page === 1 ? { data: tenJpgs() } : new Error("Magicplan GET /projects/x/files failed (400)")) });
  const row = await S.runSync(deps, { projectId: PID, fieldProjectId: "bj-lead_42" });
  assert.equal(row.status, "ready");
  assert.equal(row.files.filter((f) => /^att\d\.jpg$/.test(f.name)).length, 10);
  assert.match(row.error, /^Project attachments after page 1 not imported: .*\(400\)/);
});
test("moreAfter reads the usual page_info spellings, and says null when there is none", () => {
  assert.equal(S.moreAfter({ data: [] }, 1), null);
  assert.equal(S.moreAfter({ page_info: {} }, 1), null);
  assert.equal(S.moreAfter({ page_info: { has_next_page: true } }, 1), true);
  assert.equal(S.moreAfter({ page_info: { hasNextPage: false } }, 1), false);
  assert.equal(S.moreAfter({ page_info: { next_page: null } }, 1), false);
  assert.equal(S.moreAfter({ page_info: { next_page: 3 } }, 2), true);
  assert.equal(S.moreAfter({ page_info: { current_page: 2, last_page: 2 } }, 2), false);
  assert.equal(S.moreAfter({ page_info: { total_pages: 3 } }, 1), true);
  assert.equal(S.moreAfter({ meta: { current_page: 1, per_page: 10, total: 10 } }, 1), false);
  assert.equal(S.moreAfter({ pagination: { page: 1, page_size: 10, total_count: 25 } }, 1), true);
});
