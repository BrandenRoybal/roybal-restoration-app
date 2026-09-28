/* Magicplan proxy — the pure half, tested with fakes.
   Run: node --experimental-strip-types --test supabase/functions/magicplan-proxy/magicplan.test.mjs
   (picked up by `npm run fn:test`, which globs every function dir's .test.mjs)

   Three things this file guards:
   1. PARITY — the shared helpers here and in apps/field/js/magicplancalc.js
      give byte-identical output on the canonical fixtures (2.12), and
      MP_SAFE_PATH is textually the office function's SAFE_PATH. A drift means
      the phone builds a different id/path than the server wrote → duplicates
      on re-pull, or a file the estimator refuses to sign.
   2. ONE SHAPE PER CALL — every parser accepts exactly the live shape and
      throws on the wrapped/unwrapped twin.
   3. THE SYNC — design §4.2 end to end against an injected Io: ownership,
      downloads, hashes, safe paths, the "already have it" short-circuits, the
      photo cap, the failed row, link mode and its conflict. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import * as ts from "./magicplan.ts";
import * as F from "./fixtures.mjs";

/* Builder C writes the field copy to the same contract. A static import would
   take the whole file down while it is missing; a dynamic one fails only the
   parity tests, with a message that names the gap. */
let calc = null, calcErr = null;
try { calc = await import("../../../apps/field/js/magicplancalc.js"); } catch (e) { calcErr = e; }

const NOW = "2026-09-26T20:00:00.000Z";
const ENV = { key: "k", customer: "c", projectEmail: "owner@example.invalid", prefix: "[STAGING] " };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const j = (v) => JSON.stringify(v);

/* ============================================================
   1. Parity with the field copy
   ============================================================ */
const SHARED = ["cleanSegment", "mpFileId", "mpFilePath", "isMpSitePath", "parsePhotoName", "parseMpTime", "normalizeStatistics"];
const PARITY_INPUTS = {
  cleanSegment: [["Report PDF - 123 Test Ave.pdf", 80], ["Walk 9·23 ☃.m4a", 80], ["", 10], [null, 5], ["a".repeat(200) + ".pdf", 80]],
  mpFileId: [[F.HASH], [F.HASH_A], [F.HASH.toUpperCase()]],
  mpFilePath: [
    [F.JOB, F.HASH, F.REPORT_NAME], [F.JOB, F.HASH, "../../etc/passwd"], [F.JOB, F.HASH, "Walk 9·23 ☃.m4a"],
    ["a.b", F.HASH, "x.pdf"], ["a._b", F.HASH, "x.pdf"], [F.JOB, F.HASH, ""], [F.JOB, F.HASH, "r".repeat(500) + ".pdf"], ["", F.HASH, null],
  ],
  isMpSitePath: [["sitevisit/j/../x"], ["sitevisit/bj-1/mp-01234567-a.pdf"], [42], ["/sitevisit/j/x.pdf"]],
  parsePhotoName: [...Object.keys(F.PHOTO_NAMES).map((n) => [n]), [null], [""]],
  parseMpTime: [["2024-08-08T10:27:10.000000+00:00"], ["2023-11-09 08:40:02"], ["garbage"], [""], [null]],
  normalizeStatistics: [[F.STATS_METRIC], [F.STATS_IMPERIAL], [F.STATS_UNKNOWN], [{ statistics: {} }]],
};
const PARITY_THROWS = { mpFileId: [["zz"], [null]], normalizeStatistics: [[{ data: F.STATS_METRIC }], [null]], mpFilePath: [[F.JOB, "zz", "x"]] };

for (const name of SHARED) {
  test(`parity: ${name} — server and field copies agree`, () => {
    assert.ok(calc, `apps/field/js/magicplancalc.js not importable (builder C): ${calcErr && calcErr.message}`);
    assert.equal(typeof calc[name], "function", `magicplancalc.js exports no ${name}`);
    for (const args of PARITY_INPUTS[name]) assert.equal(j(ts[name](...args)), j(calc[name](...args)), `${name}(${j(args)})`);
    for (const args of PARITY_THROWS[name] || []) {
      assert.throws(() => ts[name](...args), `server ${name}(${j(args)}) should throw`);
      assert.throws(() => calc[name](...args), `field ${name}(${j(args)}) should throw`);
    }
  });
}
test("parity: MP_SAFE_PATH is the same regex on both sides", () => {
  assert.ok(calc, `apps/field/js/magicplancalc.js not importable (builder C): ${calcErr && calcErr.message}`);
  assert.equal(ts.MP_SAFE_PATH.source, calc.MP_SAFE_PATH.source);
});
test("MP_SAFE_PATH is textually the office estimator's SAFE_PATH (roybal-ai-office/sitevisit.ts)", () => {
  const src = readFileSync(new URL("../roybal-ai-office/sitevisit.ts", import.meta.url), "utf8");
  const m = /const SAFE_PATH = \/(.*)\/;/.exec(src);
  assert.ok(m, "SAFE_PATH not found in roybal-ai-office/sitevisit.ts");
  assert.equal(ts.MP_SAFE_PATH.source, m[1]);
});

/* ============================================================
   2. Shared helpers against the 2.12 expectations
   ============================================================ */
test("normalizeStatistics: metric converts and rounds to 1 ft² / 0.5 ft / 1 ft³", () => {
  assert.deepEqual(ts.normalizeStatistics(F.STATS_METRIC), F.STATS_METRIC_NORMALIZED);
  // key order is part of the contract (the row's jsonb is compared byte for byte on the client)
  assert.deepEqual(Object.keys(ts.normalizeStatistics(F.STATS_METRIC).floors[0].rooms[0]),
    ["name", "floorSF", "perimLF", "ceilingFt", "wallSF", "wallSFNet", "doors", "windows", "volumeCF", "dims"]);
});
test("normalizeStatistics: imperial passes through unrounded; an unknown token is imperial", () => {
  const imp = ts.normalizeStatistics(F.STATS_IMPERIAL);
  assert.equal(imp.units, "imperial");
  const r = imp.floors[0].rooms[0];
  assert.equal(r.floorSF, 12.9); assert.equal(r.perimLF, 14.6); assert.equal(r.ceilingFt, 2.525);
  assert.equal(r.wallSF, 36.87); assert.equal(r.volumeCF, 32.57); assert.equal(r.doors, 1); assert.equal(r.windows, 2);
  assert.deepEqual(ts.normalizeStatistics(F.STATS_UNKNOWN), imp);
});
test("normalizeStatistics: one shape — the wrapped body throws; missing numbers are null, missing counts 0", () => {
  assert.throws(() => ts.normalizeStatistics({ data: F.STATS_METRIC }), /Unexpected Magicplan statistics shape/);
  assert.throws(() => ts.normalizeStatistics(null));
  const s = ts.normalizeStatistics({ units: "metric", statistics: { floors: [{ name: " F ", rooms: [{ name: "X" }] }] } });
  assert.deepEqual(s.floors[0], { name: "F", rooms: [{ name: "X", floorSF: null, perimLF: null, ceilingFt: null, wallSF: null, wallSFNet: null, doors: 0, windows: 0, volumeCF: null, dims: "" }] });
  assert.deepEqual(ts.normalizeStatistics({ units: "metric", statistics: {} }), { units: "metric", floors: [] });
});
test("parsePhotoName: floor / room / caption, never a guess", () => {
  for (const [name, want] of Object.entries(F.PHOTO_NAMES)) assert.deepEqual(ts.parsePhotoName(name), want, name);
  assert.deepEqual(ts.parsePhotoName(null), { floor: "", room: "", caption: "" });
});
test("mpFilePath: the client's siteFilePath shape, every output safe", () => {
  const p = ts.mpFilePath(F.JOB, F.HASH, F.REPORT_NAME);
  assert.equal(p, `sitevisit/${F.JOB}/mp-01234567-Report_PDF_-_123_Test_Ave.pdf`);
  assert.equal(ts.mpFilePath(F.JOB, F.HASH, "../../etc/passwd").split("/").pop(), "mp-01234567-etc_passwd");
  assert.equal(ts.mpFilePath(F.JOB, F.HASH, "Walk 9·23 ☃.m4a").split("/").pop(), "mp-01234567-Walk_9_23_.m4a");
  assert.equal(ts.mpFilePath("a.b", F.HASH, "x.pdf").split("/")[1], "a_b");
  assert.equal(ts.mpFilePath("a._b", F.HASH, "x.pdf").split("/")[1], "a_b");
  assert.equal(ts.mpFilePath(F.JOB, F.HASH, "").split("/").pop(), "mp-01234567-file");
  assert.equal(ts.mpFilePath("", F.HASH, "x").split("/")[1], "job");
  const long = ts.mpFilePath(F.JOB, F.HASH, "r".repeat(500) + ".pdf").split("/").pop();
  assert.ok(long.length <= 80 + "mp-01234567-".length && long.endsWith(".pdf"));
  for (const args of PARITY_INPUTS.mpFilePath) assert.ok(ts.isMpSitePath(ts.mpFilePath(...args)), j(args));
  assert.equal(ts.isMpSitePath("sitevisit/j/../x"), false);
  assert.equal(ts.isMpSitePath(42), false);
  assert.throws(() => ts.mpFileId("zz"), /bad hash/);
  assert.equal(ts.mpFileId(F.HASH_A.toUpperCase()), "mp-aaaaaaaa");
});
test("parseMpTime: six-digit fractions and zoneless stamps", () => {
  assert.equal(ts.parseMpTime("2024-08-08T10:27:10.000000+00:00"), Date.parse("2024-08-08T10:27:10.000+00:00"));
  assert.equal(ts.parseMpTime("2023-11-09 08:40:02"), Date.parse("2023-11-09T08:40:02Z"));
  assert.equal(ts.parseMpTime("garbage"), null);
  assert.equal(ts.parseMpTime(""), null);
});

/* ============================================================
   3. Server-only helpers
   ============================================================ */
test("projectName / createProjectBody: prefix, nulls, country default", () => {
  assert.equal(ts.projectName("Test Customer", "123 Test Ave"), "Test Customer — 123 Test Ave");
  assert.equal(ts.projectName("", ""), "Site visit");
  assert.equal(ts.projectName("Test Customer", ""), "Test Customer");
  const body = ts.createProjectBody({ fieldProjectId: F.JOB, customer: "Test Customer", address: { street: "123 Test Ave", city: "", postal_code: "99701" }, by: "x" }, ENV);
  assert.deepEqual(body, {
    name: "[STAGING] Test Customer — 123 Test Ave", external_reference_id: F.JOB, email: ENV.projectEmail,
    address: { street: "123 Test Ave", city: null, postal_code: "99701", country: "US" },
  });
});
test("mimeFor: file_type first, then the response header, then octet-stream", () => {
  assert.equal(ts.mimeFor("pdf"), "application/pdf");
  assert.equal(ts.mimeFor("JPG", "application/octet-stream"), "image/jpeg");
  assert.equal(ts.mimeFor("jpeg"), "image/jpeg");
  assert.equal(ts.mimeFor("png"), "image/png");
  assert.equal(ts.mimeFor("svg"), "image/svg+xml");
  assert.equal(ts.mimeFor("webp"), "image/webp");
  assert.equal(ts.mimeFor("heic", "Image/HEIC; charset=binary"), "image/heic");
  assert.equal(ts.mimeFor("bin", ""), "application/octet-stream");
});
test("reuseKey: folder|name|size|last_modified — API and row spellings alike", () => {
  assert.equal(ts.reuseKey({ folder: "Report PDF", name: "a.pdf", size: 5, last_modified: "t" }), "Report PDF|a.pdf|5|t");
  assert.equal(ts.reuseKey({ folder: "Report PDF", name: "a.pdf", size: 5, mp_last_modified: "t" }), "Report PDF|a.pdf|5|t");
  assert.notEqual(ts.reuseKey({ folder: "A", name: "a.pdf", size: 5, last_modified: "t" }), ts.reuseKey({ folder: "B", name: "a.pdf", size: 5, last_modified: "t" }));
});
test("errorMessage: {message, data} with data of any type; a non-object body", () => {
  assert.equal(ts.errorMessage(401, F.WORKSPACE_401), 'Magicplan 401: Unauthorized — ""');
  assert.equal(ts.errorMessage(400, F.PROJECT_400), `Magicplan 400: Bad Request — {"errors":"Field 'email' is required."}`);
  assert.equal(ts.errorMessage(405, F.PLAN_FILES_405), "Magicplan 405: Method Not Allowed");
  assert.equal(ts.errorMessage(500, null), "Magicplan 500: request failed");
  assert.equal(ts.errorMessage(502, "<html>"), "Magicplan 502: request failed");
});
test("attachAuth: the key goes to the API origin only", () => {
  assert.deepEqual(ts.attachAuth(F.SVG_URL, ENV), { key: "k", customer: "c" });
  assert.deepEqual(ts.attachAuth("https://s3.amazonaws.com/example-magicplan-files/report.pdf", ENV), {});
  assert.deepEqual(ts.attachAuth("http://cloud.magicplan.app/api/v2/x", ENV), {});
  assert.deepEqual(ts.attachAuth("not a url", ENV), {});
});
test("paths: the exact query strings", () => {
  assert.equal(ts.listProjectsPath("[STAGING] A — B", 2), "/projects?name=%5BSTAGING%5D%20A%20%E2%80%94%20B&page_size=50&page=2");
  assert.equal(ts.planFilesPath(F.PLAN_ID), `/plans/${F.PLAN_ID}/files?format[]=pdf&include_photos=true`);
  assert.equal(ts.planStatisticsPath("a/b"), "/plans/statistics/a%2Fb");
  assert.equal(ts.projectPlanPath(F.PROJECT_ID), `/projects/${F.PROJECT_ID}/plan?floor_svg_dimensions=main&floor_svg_show_annotations=false`);
  assert.equal(ts.archivePath(F.PROJECT_ID), `/projects/${F.PROJECT_ID}/archive`);
  assert.equal(ts.svgFileName(F.SVG_URL), F.SVG_NAME);
  assert.equal(ts.svgFileName("https://x.test/a/b.svg?sig=1"), "b.svg");
});
test("shouldRetry / retryDelayMs: one 429 retry, Retry-After honoured and capped", () => {
  assert.equal(ts.shouldRetry(429, 0), true);
  assert.equal(ts.shouldRetry(429, 1), false);
  assert.equal(ts.shouldRetry(500, 0), false);
  assert.equal(ts.retryDelayMs("3"), 3000);
  assert.equal(ts.retryDelayMs("999"), 10000);
  assert.equal(ts.retryDelayMs(null), 2000);
  assert.equal(ts.retryDelayMs("nope"), 2000);
});
test("validation: the 400s before any Magicplan call", () => {
  assert.deepEqual(ts.validateSyncInput({ projectId: F.PROJECT_ID, fieldProjectId: F.JOB }), { projectId: F.PROJECT_ID, fieldProjectId: F.JOB });
  assert.throws(() => ts.validateSyncInput({ projectId: "", fieldProjectId: F.JOB }), /Invalid projectId/);
  assert.throws(() => ts.validateSyncInput({ projectId: "x".repeat(65), fieldProjectId: F.JOB }), /Invalid projectId/);
  assert.throws(() => ts.validateSyncInput({ projectId: "p", fieldProjectId: "a.b" }), /Invalid fieldProjectId/);
  assert.throws(() => ts.validateSyncInput({ projectId: "p", fieldProjectId: "x".repeat(81) }), /Invalid fieldProjectId/);
  assert.throws(() => ts.validateSyncInput({ projectId: "p" }), /Invalid fieldProjectId/);
  assert.equal(ts.validateProjectId("p"), "p");
  assert.throws(() => ts.validateProjectId(7), /Invalid projectId/);
  assert.deepEqual(ts.validateExportInput({ exportId: "11111111-2222-4333-8444-555555555555", fieldProjectId: "bj-1" }),
    { exportId: "11111111-2222-4333-8444-555555555555", fieldProjectId: "bj-1" });
  assert.throws(() => ts.validateExportInput({ exportId: "row-1", fieldProjectId: "bj-1" }), /Invalid exportId/);
  const c = ts.validateCreateInput({ fieldProjectId: F.JOB, customer: "Test Customer", address: { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701" }, by: "o@example.invalid" });
  assert.deepEqual(c, { fieldProjectId: F.JOB, customer: "Test Customer", address: { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701", country: "" }, by: "o@example.invalid" });
  assert.deepEqual(ts.validateCreateInput({ fieldProjectId: F.JOB }).address, { street: "", city: "", postal_code: "", country: "" });
  assert.throws(() => ts.validateCreateInput({ fieldProjectId: F.JOB, customer: "x".repeat(161) }), /Invalid customer/);
  assert.throws(() => ts.validateCreateInput({ fieldProjectId: F.JOB, address: { street: 5 } }), /Invalid address.street/);
  assert.throws(() => ts.validateCreateInput({ fieldProjectId: "bad id" }), /Invalid fieldProjectId/);
});

/* ============================================================
   4. Parsers — one shape each
   ============================================================ */
test("parseWorkspace: unwrapped; the wrapped twin throws", () => {
  assert.deepEqual(ts.parseWorkspace(F.WORKSPACE_200), {
    name: "Test Workspace", ownerEmail: "owner@example.invalid",
    formats: ["pdf", "jpg", "png", "svg", "statistics:pdf"], lastModified: "2026-09-20 18:22:10",
  });
  assert.throws(() => ts.parseWorkspace({ data: F.WORKSPACE_200 }), /GET \/workspace/);
  assert.throws(() => ts.parseWorkspace(F.WORKSPACE_401), /GET \/workspace/);
});
test("parseProject: 201, 207 (warnings ignored), GET; missing data.id throws", () => {
  const want = {
    projectId: F.PROJECT_ID, planId: F.PLAN_ID, cloudUrl: "https://cloud.magicplan.app/projects/" + F.PROJECT_ID,
    externalReferenceId: F.JOB, userModified: "2026-09-25T18:05:00.000000+00:00", archivedAt: null,
    name: "Test Customer — 123 Test Ave", createdAt: "2026-09-25T18:00:00.000000+00:00",
  };
  assert.deepEqual(ts.parseProject(F.PROJECT_201), want);
  assert.deepEqual(ts.parseProject(F.PROJECT_207), want);
  assert.deepEqual(ts.parseProject(F.PROJECT_GET_200), want);
  assert.equal(ts.parseProject(F.PROJECT_GET_200_UNLINKED).externalReferenceId, null);
  assert.equal(ts.parseProject(F.ARCHIVE_200).archivedAt, "2026-09-26T21:00:00.000000+00:00");
  assert.throws(() => ts.parseProject(F.PROJECT_GET_404), /response for project/);
  assert.throws(() => ts.parseProject(F.PROJECT_201.data), /response for project/);   // unwrapped twin
});
test("parseProjectList: items without plan_id, next_page null or a number", () => {
  const hit = ts.parseProjectList(F.PROJECTS_LIST_HIT);
  assert.equal(hit.items.length, 2);
  assert.deepEqual(hit.items[1], { id: F.PROJECT_ID, externalReferenceId: F.JOB, name: "Test Customer — 123 Test Ave", archivedAt: null, userModified: "2026-09-25T18:05:00.000000+00:00" });
  assert.equal(hit.nextPage, null);
  assert.equal(ts.parseProjectList(F.PROJECTS_LIST_PAGE1).nextPage, 2);
  assert.equal(ts.parseProjectList(F.PROJECTS_LIST_PAGE1).items[0].externalReferenceId, null);
  assert.deepEqual(ts.parseProjectList(F.PROJECTS_LIST_EMPTY), { items: [], nextPage: null });
  assert.throws(() => ts.parseProjectList({ items: [] }), /GET \/projects/);
});
test("parsePlanFiles: pdf reports and jpg/png photos only; no photos → []; bad shape throws", () => {
  const got = ts.parsePlanFiles(F.PLAN_FILES_200);
  assert.equal(got.files.length, 1);
  assert.deepEqual(got.files[0], { name: F.REPORT_NAME, folder: "Report PDF", url: "https://s3.amazonaws.com/example-magicplan-files/report.pdf", last_modified: "2026-09-26T19:58:00.000000+00:00", size: F.PDF_BYTES.length, file_type: "pdf" });
  assert.equal(got.photos.length, 2);
  assert.equal(got.photos[0].symbol_instance_id, "sym-1");
  assert.deepEqual(ts.parsePlanFiles(F.PLAN_FILES_NOPHOTOS).photos, []);
  assert.deepEqual(ts.parsePlanFiles({ data: { files: [{ name: "a.dxf", folder: "x", url: "u", size: 1, file_type: "dxf" }] } }), { files: [], photos: [] });
  assert.deepEqual(ts.parsePlanFiles({ data: { files: [], photos: [{}, { name: "p.heic", url: "u", file_type: "heic" }] } }).photos, []);
  assert.throws(() => ts.parsePlanFiles(F.PLAN_FILES_405), /plans\/\{id\}\/files/);
  assert.throws(() => ts.parsePlanFiles({ files: [], photos: [] }), /plans\/\{id\}\/files/);   // unwrapped twin
});
test("parsePlanFloors: data.plan_data.floors[] with name + image; missing → []", () => {
  assert.deepEqual(ts.parsePlanFloors(F.PROJECT_PLAN_200), [{ name: "Ground Floor", image: F.SVG_URL }]);
  assert.deepEqual(ts.parsePlanFloors(F.PROJECT_PLAN_NOFLOORS), []);
  assert.deepEqual(ts.parsePlanFloors({ data: {} }), []);
  assert.deepEqual(ts.parsePlanFloors(null), []);
  assert.deepEqual(ts.parsePlanFloors({ data: { plan_data: { floors: [{ name: "A" }, { image: "u" }, { name: "B", image: "" }] } } }), []);
});
test("indexPrior: keys, svg keys, hashes and paths from ready|imported rows", () => {
  const row = F.rowFixture(ts.mpFilePath);
  const idx = ts.indexPrior([row]);
  assert.equal(idx.byKey.size, 3);
  assert.deepEqual(idx.byKey.get(ts.reuseKey(row.files[0])), { hash: F.HASH_A, path: row.files[0].path, size: 1234, mime: "application/pdf" });
  assert.deepEqual([...idx.hashes].sort(), [F.HASH_A, F.HASH_B, F.HASH_C]);
  assert.equal(idx.paths.size, 3);
  assert.equal(idx.bySvg.size, 0);
  assert.deepEqual(ts.indexPrior([]).byKey.size, 0);
  assert.deepEqual(ts.indexPrior([{ files: null, photos: undefined, floors_svg: [{ floor: "G", name: "g.svg", hash: F.HASH, path: "sitevisit/j/mp-01234567-g.svg", size: 9 }] }]).bySvg.get("G|g.svg"),
    { hash: F.HASH, path: "sitevisit/j/mp-01234567-g.svg", size: 9 });
});

/* ============================================================
   5. The actions, against a fake Io
   ============================================================ */
const S3 = "https://s3.amazonaws.com/example-magicplan-files/";
const BYTES = { [S3 + "report.pdf"]: F.PDF_BYTES, [S3 + "photo-1.jpg"]: F.JPG_BYTES, [S3 + "photo-2.jpg"]: F.JPG_BYTES_2, [F.SVG_URL]: F.SVG_BYTES };

let rowSeq = 0;   // one sequence across fakes — a "new row" must get a new id
function fakeIo({ routes, bytes = BYTES, prior = [], failDownload = null } = {}) {
  const calls = { api: [], downloads: [], uploads: [], inserts: [], updates: [] };
  const io = {
    api: async (path, init) => { calls.api.push({ path, method: (init && init.method) || "GET", body: init && init.body }); return routes(path, init); },
    download: async (url, headers) => {
      calls.downloads.push({ url, headers });
      if (failDownload && failDownload(url)) throw new Error("Magicplan 403: request failed");
      const b = bytes[url] || (url.includes("many-") ? new Uint8Array([Number(url.match(/many-(\d+)/)[1]), 1, 2]) : null);
      if (!b) throw new Error("Magicplan 404: request failed");
      return { bytes: b, contentType: "application/octet-stream" };
    },
    sha256: async (b) => sha(b),
    upload: async (path, b, contentType) => { calls.uploads.push({ path, size: b.length, contentType }); },
    priorRows: async () => prior,
    insertRow: async (row) => { const r = { id: `row-${++rowSeq}`, received_at: NOW, ...row }; calls.inserts.push(r); return r; },
    updateRow: async (id, patch) => { const r = { id, received_at: NOW, ...patch }; calls.updates.push(r); return r; },
    now: () => NOW,
  };
  return { io, calls };
}
const happyRoutes = (over = {}) => (path) => {
  if (path === `/projects/${F.PROJECT_ID}`) return { status: 200, json: over.project || F.PROJECT_GET_200 };
  if (path === ts.planFilesPath(F.PLAN_ID)) return { status: 200, json: over.files || F.PLAN_FILES_200 };
  if (path === ts.planStatisticsPath(F.PLAN_ID)) return { status: 200, json: over.stats || F.STATS_METRIC };
  if (path === ts.projectPlanPath(F.PROJECT_ID)) return { status: 200, json: over.plan || F.PROJECT_PLAN_200 };
  throw new Error("unexpected api path " + path);
};
const listRoutes = (pages, post = F.PROJECT_201, postStatus = 201) => (path, init) => {
  if (path === "/projects" && init && init.method === "POST") return { status: postStatus, json: post };
  if (path === `/projects/${F.PROJECT_ID}`) return { status: 200, json: F.PROJECT_GET_200 };
  const m = /^\/projects\?name=.*&page=(\d+)$/.exec(path);
  if (m) return { status: 200, json: pages[Number(m[1]) - 1] || F.PROJECTS_LIST_EMPTY };
  throw new Error("unexpected api path " + path);
};
const CREATE = { fieldProjectId: F.JOB, customer: "Test Customer", address: { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701" }, by: "o@example.invalid" };

test("createProject: existing project found by external_reference_id → GET, no POST, existed:true", async () => {
  const { io, calls } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_HIT]) });
  const r = await ts.createProject(io, ENV, CREATE);
  assert.equal(r.existed, true);
  assert.equal(r.projectId, F.PROJECT_ID); assert.equal(r.planId, F.PLAN_ID);
  assert.equal(r.name, "Test Customer — 123 Test Ave");
  assert.equal(calls.api.filter((c) => c.method === "POST").length, 0);
  assert.equal(calls.api.filter((c) => c.path === `/projects/${F.PROJECT_ID}`).length, 1);
  assert.match(calls.api[0].path, /^\/projects\?name=%5BSTAGING%5D%20Test%20Customer%20%E2%80%94%20123%20Test%20Ave&page_size=50&page=1$/);
});
test("createProject: an archived twin does not count → POST", async () => {
  const { io, calls } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_ARCHIVED_ONLY]) });
  const r = await ts.createProject(io, ENV, CREATE);
  assert.equal(r.existed, false);
  assert.equal(calls.api.filter((c) => c.method === "POST").length, 1);
  const body = JSON.parse(calls.api.find((c) => c.method === "POST").body);
  assert.equal(body.name, "[STAGING] Test Customer — 123 Test Ave");
  assert.equal(body.external_reference_id, F.JOB);
  assert.equal(body.email, ENV.projectEmail);
  assert.deepEqual(body.address, { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701", country: "US" });
});
test("createProject: two pages are both fetched before the hit", async () => {
  const { io, calls } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_PAGE1, F.PROJECTS_LIST_PAGE2]) });
  const r = await ts.createProject(io, ENV, CREATE);
  assert.equal(r.existed, true);
  assert.deepEqual(calls.api.map((c) => c.path.replace(/^\/projects\?name=[^&]*&page_size=50&/, "list ")), ["list page=1", "list page=2", `/projects/${F.PROJECT_ID}`]);
});
test("createProject: empty list → POST; 207 is a success; name is what landed", async () => {
  const { io } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_EMPTY], F.PROJECT_207, 207) });
  const r = await ts.createProject(io, ENV, CREATE);
  assert.deepEqual(r, { projectId: F.PROJECT_ID, planId: F.PLAN_ID, cloudUrl: "https://cloud.magicplan.app/projects/" + F.PROJECT_ID, createdAt: "2026-09-25T18:00:00.000000+00:00", existed: false, name: "Test Customer — 123 Test Ave" });
});
test("createProject: a 400 from POST surfaces the API's message", async () => {
  const { io } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_EMPTY], F.PROJECT_400, 400) });
  await assert.rejects(ts.createProject(io, ENV, CREATE), /Magicplan 400: Bad Request — .*email/);
});
test("createProject / archiveProject: no MAGICPLAN_PROJECT_EMAIL → throws before any call", async () => {
  const { io, calls } = fakeIo({ routes: listRoutes([F.PROJECTS_LIST_HIT]) });
  await assert.rejects(ts.createProject(io, { ...ENV, projectEmail: "" }, CREATE), /MAGICPLAN_PROJECT_EMAIL is not set on this server/);
  await assert.rejects(ts.archiveProject(io, { ...ENV, projectEmail: "" }, F.PROJECT_ID), /MAGICPLAN_PROJECT_EMAIL is not set on this server/);
  assert.equal(calls.api.length, 0);
});
test("getStatus / archiveProject: the exact data shapes; 404 surfaces", async () => {
  const routes = (path, init) => {
    if (path === `/projects/${F.PROJECT_ID}`) return { status: 200, json: F.PROJECT_GET_200 };
    if (path === ts.archivePath(F.PROJECT_ID) && init.method === "PUT") return { status: 200, json: F.ARCHIVE_200 };
    if (path === ts.archivePath("missing")) return { status: 404, json: F.ARCHIVE_404 };
    return { status: 404, json: F.PROJECT_GET_404 };
  };
  const { io, calls } = fakeIo({ routes });
  assert.deepEqual(await ts.getStatus(io, ENV, F.PROJECT_ID), { externalReferenceId: F.JOB, userModified: "2026-09-25T18:05:00.000000+00:00", archivedAt: null, planId: F.PLAN_ID });
  assert.deepEqual(await ts.archiveProject(io, ENV, F.PROJECT_ID), { archivedAt: "2026-09-26T21:00:00.000000+00:00" });
  assert.deepEqual(JSON.parse(calls.api.at(-1).body), { acting_user: ENV.projectEmail });
  await assert.rejects(ts.archiveProject(io, ENV, "missing"), /Magicplan 404: Project not found/);
  await assert.rejects(ts.getStatus(io, ENV, "missing"), /Magicplan 404: Project not found/);
});
test("a 429 that survived the transport's retry fails loud with the rate-limit message", async () => {
  const { io } = fakeIo({ routes: () => ({ status: 429, json: null }) });
  await assert.rejects(ts.getStatus(io, ENV, F.PROJECT_ID), new RegExp(ts.RATE_LIMIT_MESSAGE.replace(/[()]/g, "\\$&")));
});

/* ---------- syncPlan ---------- */
const SYNC = { projectId: F.PROJECT_ID, fieldProjectId: F.JOB };

test("sync (a): external_reference_id mismatch → one unmatched row, field_project_id null, nothing downloaded", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes({ project: F.PROJECT_GET_200_FOREIGN }) });
  const row = await ts.syncPlan(io, ENV, SYNC);
  assert.equal(calls.inserts.length, 1);
  assert.equal(row.status, "unmatched");
  assert.equal(row.field_project_id, null);
  assert.equal(row.mp_project_id, F.PROJECT_ID); assert.equal(row.mp_plan_id, F.PLAN_ID);
  assert.equal(row.error, `external_reference_id bj-other-job ≠ ${F.JOB}`);
  assert.equal(row.synced_at, NOW);
  assert.equal(calls.downloads.length, 0); assert.equal(calls.uploads.length, 0);
  assert.equal(calls.api.length, 1);
  // a hand-started scan (null ext ref) is unmatched too, spelled "null"
  const u = fakeIo({ routes: happyRoutes({ project: F.PROJECT_GET_200_UNLINKED }) });
  assert.equal((await ts.syncPlan(u.io, ENV, SYNC)).error, `external_reference_id null ≠ ${F.JOB}`);
});

test("sync (b): happy path — 1 pdf + 2 jpg + 1 svg downloaded and uploaded, the row per 2.2", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes() });
  const row = await ts.syncPlan(io, ENV, SYNC);
  assert.equal(calls.downloads.length, 4);
  assert.equal(calls.uploads.length, 4);
  assert.equal(calls.inserts.length, 1); assert.equal(calls.updates.length, 0);
  assert.equal(row.status, "ready");
  assert.equal(row.field_project_id, F.JOB); assert.equal(row.mp_plan_id, F.PLAN_ID); assert.equal(row.mp_project_id, F.PROJECT_ID);
  assert.equal(row.synced_at, NOW); assert.equal(row.error, null);
  assert.equal(row.files.length, 1); assert.equal(row.photos.length, 2); assert.equal(row.floors_svg.length, 1);
  assert.deepEqual(row.statistics, F.STATS_METRIC_NORMALIZED);
  const f = row.files[0];
  assert.deepEqual(Object.keys(f), ["path", "name", "mime", "size", "hash", "folder", "mp_last_modified", "file_type"]);
  assert.equal(f.hash, sha(F.PDF_BYTES)); assert.equal(f.path, ts.mpFilePath(F.JOB, f.hash, F.REPORT_NAME));
  assert.equal(f.mime, "application/pdf"); assert.equal(f.size, F.PDF_BYTES.length);
  assert.equal(f.folder, "Report PDF"); assert.equal(f.mp_last_modified, "2026-09-26T19:58:00.000000+00:00"); assert.equal(f.file_type, "pdf");
  const p = row.photos[0];
  assert.deepEqual(Object.keys(p), ["path", "name", "mime", "size", "hash", "folder", "mp_last_modified", "file_type", "room", "floor", "caption", "symbol_instance_id"]);
  assert.deepEqual([p.room, p.floor, p.caption, p.symbol_instance_id, p.mime], ["Living Room", "1st Floor", "Window", "sym-1", "image/jpeg"]);
  assert.deepEqual([row.photos[1].room, row.photos[1].caption, row.photos[1].symbol_instance_id], ["Bedroom", "", "sym-2"]);
  const s = row.floors_svg[0];
  assert.deepEqual(Object.keys(s), ["floor", "path", "hash", "name", "size"]);
  assert.equal(s.floor, "Ground Floor"); assert.equal(s.name, F.SVG_NAME); assert.equal(s.hash, sha(F.SVG_BYTES)); assert.equal(s.size, F.SVG_BYTES.length);
  for (const e of [...row.files, ...row.photos, ...row.floors_svg]) assert.ok(ts.isMpSitePath(e.path), e.path);
  assert.deepEqual(calls.uploads.map((u) => u.contentType), ["application/pdf", "image/jpeg", "image/jpeg", "image/svg+xml"]);
  assert.deepEqual(calls.uploads.map((u) => u.path), [...row.files, ...row.photos, ...row.floors_svg].map((e) => e.path));
  // the four API calls, in order
  assert.deepEqual(calls.api.map((c) => c.path), [`/projects/${F.PROJECT_ID}`, ts.planFilesPath(F.PLAN_ID), ts.planStatisticsPath(F.PLAN_ID), ts.projectPlanPath(F.PROJECT_ID)]);
});

test("sync (c): second run with the first row as prior → zero downloads, zero uploads, a NEW identical row", async () => {
  const first = await ts.syncPlan(fakeIo({ routes: happyRoutes() }).io, ENV, SYNC);
  const { io, calls } = fakeIo({ routes: happyRoutes(), prior: [first] });
  const second = await ts.syncPlan(io, ENV, SYNC);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.inserts.length, 1);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.files, first.files);
  assert.deepEqual(second.photos, first.photos);
  assert.deepEqual(second.floors_svg, first.floors_svg);
  assert.equal(second.status, "ready");
});

test("sync (d): same bytes, new last_modified → downloaded again, not re-uploaded", async () => {
  const first = await ts.syncPlan(fakeIo({ routes: happyRoutes() }).io, ENV, SYNC);
  const stale = { ...first, files: first.files.map((f) => ({ ...f, mp_last_modified: "2026-09-01T00:00:00.000000+00:00" })) };
  const { io, calls } = fakeIo({ routes: happyRoutes(), prior: [stale] });
  const row = await ts.syncPlan(io, ENV, SYNC);
  assert.deepEqual(calls.downloads.map((d) => d.url), [S3 + "report.pdf"]);
  assert.equal(calls.uploads.length, 0);
  assert.deepEqual(row.files, first.files);
});

test("sync (d′): a prior entry under ANOTHER job's folder is not reused — the file is stored under this job", async () => {
  const other = await ts.syncPlan(fakeIo({ routes: happyRoutes() }).io, ENV, { projectId: F.PROJECT_ID, fieldProjectId: "bj-other-job" });
  const { io, calls } = fakeIo({ routes: happyRoutes({ project: F.PROJECT_GET_200_UNLINKED }), prior: [other] });
  const row = await ts.syncPlan(io, ENV, SYNC, { linkMode: true, updateRowId: "row-unmatched" });
  assert.equal(calls.downloads.length, 4);
  assert.equal(calls.uploads.length, 4);
  for (const e of [...row.files, ...row.photos, ...row.floors_svg]) assert.ok(e.path.startsWith(`sitevisit/${F.JOB}/`), e.path);
});

test("sync (e): a download that throws → one failed row with the message, and the promise rejects", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes(), failDownload: (url) => url.endsWith("photo-2.jpg") });
  await assert.rejects(ts.syncPlan(io, ENV, SYNC), /Magicplan 403/);
  assert.equal(calls.inserts.length, 1);
  const row = calls.inserts[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error, "Magicplan 403: request failed");
  assert.equal(row.field_project_id, F.JOB); assert.equal(row.mp_plan_id, F.PLAN_ID); assert.equal(row.synced_at, NOW);
  assert.equal(row.files, undefined);
});

test("sync (e′): a bad statistics body → failed row naming the shape; a project with no plan → failed row", async () => {
  const a = fakeIo({ routes: happyRoutes({ stats: { data: F.STATS_METRIC } }) });
  await assert.rejects(ts.syncPlan(a.io, ENV, SYNC), /Unexpected Magicplan statistics shape/);
  assert.equal(a.calls.inserts[0].status, "failed");
  const noPlan = { data: { ...F.PROJECT_GET_200.data, plan_id: null } };
  const b = fakeIo({ routes: happyRoutes({ project: noPlan }) });
  await assert.rejects(ts.syncPlan(b.io, ENV, SYNC), /has no plan yet/);
  assert.equal(b.calls.inserts[0].status, "failed"); assert.equal(b.calls.inserts[0].mp_plan_id, "");
  assert.equal(b.calls.downloads.length, 0);
});

test("sync (f): linkMode + updateRowId with an empty ext ref → updateRow, no insert, row ready under the chosen job", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes({ project: F.PROJECT_GET_200_UNLINKED }) });
  const row = await ts.syncPlan(io, ENV, SYNC, { linkMode: true, updateRowId: "row-unmatched" });
  assert.equal(calls.updates.length, 1); assert.equal(calls.inserts.length, 0);
  assert.equal(row.id, "row-unmatched");
  assert.equal(row.status, "ready"); assert.equal(row.field_project_id, F.JOB);
  assert.equal(row.files.length, 1); assert.equal(row.photos.length, 2);
});

test("sync (g): linkMode with a FOREIGN ext ref → MpConflict, nothing written, nothing downloaded", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes({ project: F.PROJECT_GET_200_FOREIGN }) });
  await assert.rejects(ts.syncPlan(io, ENV, SYNC, { linkMode: true, updateRowId: "row-unmatched" }), (e) => {
    assert.ok(e instanceof ts.MpConflict);
    assert.equal(e.message, "This Magicplan project is linked to job bj-other-job — open that job and Pull");
    return true;
  });
  assert.equal(calls.inserts.length, 0); assert.equal(calls.updates.length, 0); assert.equal(calls.downloads.length, 0);
  // linkMode with OUR ext ref is fine (a re-link of a project already ours)
  const ok = fakeIo({ routes: happyRoutes() });
  assert.equal((await ts.syncPlan(ok.io, ENV, SYNC, { linkMode: true, updateRowId: "r" })).status, "ready");
});

test("sync (h): a listed file over MAX_FILE_BYTES → failed row, no download", async () => {
  const big = { data: { ...F.PLAN_FILES_200.data, files: [{ ...F.PLAN_FILES_200.data.files[0], size: ts.MAX_FILE_BYTES + 1 }] } };
  const { io, calls } = fakeIo({ routes: happyRoutes({ files: big }) });
  await assert.rejects(ts.syncPlan(io, ENV, SYNC), /is 80 MB — over the 80 MB limit/);
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.inserts.length, 1); assert.equal(calls.inserts[0].status, "failed");
});

test("sync (i): S3-hosted files are fetched with NO headers; the API-hosted svg with key + customer", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes() });
  await ts.syncPlan(io, ENV, SYNC);
  const byUrl = Object.fromEntries(calls.downloads.map((d) => [d.url, d.headers]));
  assert.deepEqual(byUrl[S3 + "report.pdf"], {});
  assert.deepEqual(byUrl[S3 + "photo-1.jpg"], {});
  assert.deepEqual(byUrl[F.SVG_URL], { key: "k", customer: "c" });
});

test("sync (j): 121 photos → 120 pulled, the cap noted in error, status ready", async () => {
  const { io, calls } = fakeIo({ routes: happyRoutes({ files: F.PLAN_FILES_MANY }) });
  const row = await ts.syncPlan(io, ENV, SYNC);
  assert.equal(row.photos.length, ts.MAX_PHOTOS);
  assert.equal(row.error, "+1 photos not pulled (cap)");
  assert.equal(row.status, "ready");
  assert.equal(calls.downloads.filter((d) => d.url.includes("many-")).length, 120);
  assert.equal(row.photos[0].name, "1st Floor - Living Room - Item 0 - 1.jpg");
  assert.equal(row.photos[0].caption, "Item 0");
});

test("sync (k): an unsafe name still lands on a safe path; a 200-char name clamp", async () => {
  const nasty = { data: { files: [{ ...F.PLAN_FILES_200.data.files[0], name: "../../etc/passwd" }], photos: [] } };
  const a = fakeIo({ routes: happyRoutes({ files: nasty }) });
  const row = await ts.syncPlan(a.io, ENV, SYNC);
  assert.ok(ts.isMpSitePath(row.files[0].path));
  assert.ok(row.files[0].path.endsWith("-etc_passwd"));
  const long = { data: { files: [{ ...F.PLAN_FILES_200.data.files[0], name: "n".repeat(300) + ".pdf" }], photos: [] } };
  const b = fakeIo({ routes: happyRoutes({ files: long }) });
  const r2 = await ts.syncPlan(b.io, ENV, SYNC);
  assert.equal(r2.files[0].name.length, 200);
  assert.ok(ts.isMpSitePath(r2.files[0].path));
});

test("sync: an empty plan (no files, no photos, no floors) still writes a ready row", async () => {
  const { io } = fakeIo({ routes: happyRoutes({ files: F.PLAN_FILES_EMPTY, plan: F.PROJECT_PLAN_NOFLOORS, stats: { ...F.STATS_METRIC, statistics: { floors: [] } } }) });
  const row = await ts.syncPlan(io, ENV, SYNC);
  assert.equal(row.status, "ready");
  assert.deepEqual([row.files, row.photos, row.floors_svg], [[], [], []]);
  assert.deepEqual(row.statistics, { units: "metric", floors: [] });
});
