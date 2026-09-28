/* Magicplan — the pure half of the scan lane (js/magicplancalc.js), no DOM,
   no network. The fixtures are PLAN §2.12 verbatim (every name and address
   invented); supabase/functions/magicplan-proxy/fixtures.mjs carries the same
   literals, and the server's parity test imports this module's helpers to
   prove both sides build the same ids, paths and quantities.
   Run: node apps/field/test/magicplan.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  cleanSegment, mpFileId, mpFilePath, MP_SAFE_PATH, isMpSitePath, parsePhotoName, parseMpTime, normalizeStatistics,
  MP_KIND_REPORT, MP_KIND_PHOTO, dedupeRoomNames, splitAddress, exportSummary, ensureSiteVisit, ensureFloorPlan,
  filesFromExport, measuredRows, mergeFloorPlanRows, adoptExport, nothingNew, noteRemoved, pendingRows,
  autoAdoptEnabled, hasPendingUpdate, bidMagicplanState, bidMagicplanText, fmtMpStamp, pendingQuery, recentExportsQuery,
} from "../js/magicplancalc.js";
import { siteFilePath, newSiteVisit, packetForDraft } from "../js/sitevisit.js";
import { newFloorPlan } from "../js/model.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Magicplan — pure helpers");

/* ---------- 2.12 fixtures ---------- */
const PROJECT_ID = "c32ea8d1-fee3-4c81-b402-eb3f85772cf8";
const PLAN_ID = "6a45b1435520f";
const JOB = "bj-1f2e3d4c-0000-0000-0000-000000000000";
const HASH = "0123456789abcdef".repeat(4);
const HASH_A = "a".repeat(64), HASH_B = "b".repeat(64), HASH_C = "c".repeat(64);
const NOW = "2026-09-26T20:05:00.000Z";

const STATS_METRIC = {
  id: PLAN_ID, project_id: PROJECT_ID, units: "metric",
  statistics: {
    uid: "5f20068a.8ea40fdd", name: "Plan", floors: [
      { uid: "64ee095e.777983ff", name: "Ground Floor", height: 2.44, rooms: [
        { uid: "3f2006ca.bf7e70fa", name: "Bedroom", area: 13.412, perimeter: 14.72, ground_perimeter: 14.6, area_without_walls: 12.9, height: 2.525, volume: 32.57, walls_surface: 36.87, walls_surface_without_openings: 31.2, door_count: 1, window_count: 2, dimensions: "3.54 m x 3.64 m", furnitures: [], wall_items: [] },
        { uid: "3f2006ca.aaaa0001", name: "Bathroom", area: 5.0, ground_perimeter: 9.0, area_without_walls: 4.6, height: 2.4, volume: 11.04, walls_surface: 21.6, walls_surface_without_openings: 19.9, door_count: 1, window_count: 0, dimensions: "2 m x 2.3 m" } ] },
      { uid: "64ee095e.bbbb0002", name: "Basement", height: 2.2, rooms: [
        { uid: "3f2006ca.cccc0003", name: "Bedroom", area: 20.0, ground_perimeter: 18.0, area_without_walls: 19.5, height: 2.2, volume: 42.9, walls_surface: 39.6, walls_surface_without_openings: 35.0, door_count: 1, window_count: 1, dimensions: "4 m x 5 m" } ] } ] },
};
const STATS_IMPERIAL = { ...STATS_METRIC, units: "imperial" };
const STATS_UNKNOWN = { ...STATS_METRIC, units: "feet" };
const NORMALIZED = {
  units: "metric", floors: [
    { name: "Ground Floor", rooms: [
      { name: "Bedroom", floorSF: 139, perimLF: 48, ceilingFt: 8.5, wallSF: 397, wallSFNet: 336, doors: 1, windows: 2, volumeCF: 1150, dims: "3.54 m x 3.64 m" },
      { name: "Bathroom", floorSF: 50, perimLF: 29.5, ceilingFt: 8, wallSF: 233, wallSFNet: 214, doors: 1, windows: 0, volumeCF: 390, dims: "2 m x 2.3 m" } ] },
    { name: "Basement", rooms: [
      { name: "Bedroom", floorSF: 210, perimLF: 59, ceilingFt: 7, wallSF: 426, wallSFNet: 377, doors: 1, windows: 1, volumeCF: 1515, dims: "4 m x 5 m" } ] } ],
};
const REPORT_NAME = "Report PDF - 123 Test Ave.pdf";
const PHOTO_1 = "1st Floor - Living Room - Window - 2.jpg";
const PHOTO_2 = "Ground Floor - Bedroom - 1.jpg";
const LM = "2026-09-26T19:58:00.000000+00:00";
const ROW = () => ({
  id: "11111111-2222-4333-8444-555555555555",
  mp_project_id: PROJECT_ID, mp_plan_id: PLAN_ID, field_project_id: JOB, status: "ready",
  synced_at: "2026-09-26T20:00:00.000Z", imported_at: null, error: null,
  files: [{ path: mpFilePath(JOB, HASH_A, REPORT_NAME), name: REPORT_NAME, mime: "application/pdf", size: 1234, hash: HASH_A, folder: "Report PDF", mp_last_modified: LM, file_type: "pdf" }],
  photos: [
    { path: mpFilePath(JOB, HASH_B, PHOTO_1), name: PHOTO_1, mime: "image/jpeg", size: 2222, hash: HASH_B, folder: "Captured photos", mp_last_modified: LM, file_type: "jpg", room: "Living Room", floor: "1st Floor", caption: "Window", symbol_instance_id: "sym-1" },
    { path: mpFilePath(JOB, HASH_C, PHOTO_2), name: PHOTO_2, mime: "image/jpeg", size: 3333, hash: HASH_C, folder: "Captured photos", mp_last_modified: LM, file_type: "jpg", room: "Bedroom", floor: "Ground Floor", caption: "", symbol_instance_id: "sym-2" },
  ],
  statistics: JSON.parse(JSON.stringify(NORMALIZED)),
  floors_svg: [],
});
const blankBid = () => ({ id: JOB, bidOf: "tile-1", customer: "Test Customer", address: "123 Test Ave, Fairbanks, AK 99701" });

/* ---------- shared helpers against 2.12 ---------- */
test("normalizeStatistics: metric converts and rounds to 1 ft² / 0.5 ft / 1 ft³, key order fixed", () => {
  assert.deepEqual(normalizeStatistics(STATS_METRIC), NORMALIZED);
  assert.deepEqual(Object.keys(normalizeStatistics(STATS_METRIC).floors[0].rooms[0]),
    ["name", "floorSF", "perimLF", "ceilingFt", "wallSF", "wallSFNet", "doors", "windows", "volumeCF", "dims"]);
});
test("normalizeStatistics: imperial passes through unrounded; an unknown token is imperial; the wrapped body throws", () => {
  const imp = normalizeStatistics(STATS_IMPERIAL);
  assert.equal(imp.units, "imperial");
  const r = imp.floors[0].rooms[0];
  assert.equal(r.floorSF, 12.9); assert.equal(r.perimLF, 14.6); assert.equal(r.ceilingFt, 2.525);
  assert.deepEqual(normalizeStatistics(STATS_UNKNOWN), imp);
  assert.throws(() => normalizeStatistics({ data: STATS_METRIC }), /Unexpected Magicplan statistics shape/);
  assert.throws(() => normalizeStatistics(null));
  assert.deepEqual(normalizeStatistics({ units: "metric", statistics: {} }), { units: "metric", floors: [] });
});
test("dedupeRoomNames: cross-floor names get the floor prefix, same-floor twins get (2)", () => {
  assert.deepEqual(dedupeRoomNames(NORMALIZED.floors), [["Ground Floor — Bedroom", "Bathroom"], ["Basement — Bedroom"]]);
  assert.deepEqual(dedupeRoomNames([{ name: "F", rooms: [{ name: "Closet" }, { name: "Closet" }, { name: "" }] }]), [["Closet", "Closet (2)", ""]]);
  assert.deepEqual(dedupeRoomNames([]), []);
});
test("parsePhotoName: floor / room / caption, never a guess", () => {
  assert.deepEqual(parsePhotoName(PHOTO_1), { floor: "1st Floor", room: "Living Room", caption: "Window" });
  assert.deepEqual(parsePhotoName("1st Floor - Living Room - Dining table with 6 chairs (rectangular) - 2.jpg"),
    { floor: "1st Floor", room: "Living Room", caption: "Dining table with 6 chairs (rectangular)" });
  assert.deepEqual(parsePhotoName(PHOTO_2), { floor: "Ground Floor", room: "Bedroom", caption: "" });
  assert.deepEqual(parsePhotoName("Basement - Bedroom - Window - 12.JPG"), { floor: "Basement", room: "Bedroom", caption: "Window" });
  for (const n of ["Kitchen - sink.jpg", "IMG_4821.jpg", null]) assert.deepEqual(parsePhotoName(n), { floor: "", room: "", caption: "" });
});
test("mpFilePath: siteFilePath's shape, every output safe for the estimator", () => {
  assert.equal(mpFilePath(JOB, HASH, REPORT_NAME), `sitevisit/${JOB}/mp-01234567-Report_PDF_-_123_Test_Ave.pdf`);
  assert.equal(mpFilePath(JOB, HASH, "../../etc/passwd").split("/").pop(), "mp-01234567-etc_passwd");
  assert.equal(mpFilePath(JOB, HASH, "Walk 9·23 ☃.m4a").split("/").pop(), "mp-01234567-Walk_9_23_.m4a");
  assert.equal(mpFilePath("a.b", HASH, "x.pdf").split("/")[1], "a_b");
  assert.equal(mpFilePath("a._b", HASH, "x.pdf").split("/")[1], "a_b");
  assert.equal(mpFilePath(JOB, HASH, "").split("/").pop(), "mp-01234567-file");
  const long = mpFilePath(JOB, HASH, "r".repeat(500) + ".pdf").split("/").pop();
  assert.ok(long.length <= 80 + "mp-01234567-".length && long.endsWith(".pdf"));
  for (const name of [REPORT_NAME, "../../etc/passwd", "Walk 9·23 ☃.m4a", "", "r".repeat(500) + ".pdf"]) assert.ok(isMpSitePath(mpFilePath(JOB, HASH, name)), name);
  assert.equal(isMpSitePath("sitevisit/j/../x"), false);
  assert.equal(isMpSitePath(42), false);
  assert.throws(() => mpFileId("zz"), /bad hash/);
  assert.equal(mpFileId(HASH_A.toUpperCase()), "mp-aaaaaaaa");
  assert.equal(cleanSegment("Walk 9·23 ☃.m4a", 80), "Walk_9_23_.m4a");
});
test("mpFilePath equals siteFilePath(job, mpFileId(hash), name) for every real job id", () => {
  for (const job of [JOB, randomUUID(), "bj-" + randomUUID(), "id-1727380000000-ab12"]) {
    for (const name of [REPORT_NAME, PHOTO_1, PHOTO_2, "../../etc/passwd", "Walk 9·23 ☃.m4a", "", "x".repeat(500) + ".pdf"]) {
      assert.equal(mpFilePath(job, HASH_B, name), siteFilePath(job, mpFileId(HASH_B), name), `${job} / ${name}`);
    }
  }
});
test("MP_SAFE_PATH is textually the office estimator's SAFE_PATH", () => {
  const src = readFileSync(new URL("../../../supabase/functions/roybal-ai-office/sitevisit.ts", import.meta.url), "utf8");
  const m = /const SAFE_PATH = \/(.*)\/;/.exec(src);
  assert.ok(m, "SAFE_PATH not found in roybal-ai-office/sitevisit.ts");
  assert.equal(MP_SAFE_PATH.source, m[1]);
});
test("parseMpTime: six-digit fractions and zoneless stamps", () => {
  assert.equal(parseMpTime("2024-08-08T10:27:10.000000+00:00"), Date.parse("2024-08-08T10:27:10.000+00:00"));
  assert.equal(parseMpTime("2023-11-09 08:40:02"), Date.parse("2023-11-09T08:40:02Z"));
  assert.equal(parseMpTime("garbage"), null);
  assert.equal(parseMpTime(""), null);
});
test("splitAddress: street / city / zip, state never sent", () => {
  assert.deepEqual(splitAddress("123 Test Ave, Fairbanks, AK 99701"), { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701", country: "US" });
  assert.deepEqual(splitAddress("123 Test Ave, Fairbanks AK 99701"), { street: "123 Test Ave", city: "Fairbanks", postal_code: "99701", country: "US" });
  assert.deepEqual(splitAddress("456 Sample Rd Fairbanks AK 99709"), { street: "456 Sample Rd Fairbanks", city: "", postal_code: "99709", country: "US" });
  assert.deepEqual(splitAddress(""), { street: "", city: "", postal_code: "", country: "US" });
});
test("exportSummary: the one sentence about a row", () => {
  assert.equal(exportSummary({ files: [{}], photos: new Array(14).fill({}), statistics: NORMALIZED }).text, "1 report, 14 photos, 3 rooms measured");
  assert.equal(exportSummary({ files: [], photos: [{}, {}], statistics: { units: "imperial", floors: [{ name: "F", rooms: [{}] }] } }).text, "0 reports, 2 photos, 1 room measured");
  assert.deepEqual(exportSummary(ROW()), { reports: 1, photos: 2, rooms: 3, text: "1 report, 2 photos, 3 rooms measured" });
  assert.equal(exportSummary({ status: "unmatched", statistics: null }).text, "0 reports, 0 photos, 0 rooms measured");
});

/* ---------- lockstep with the file's own blanks ---------- */
test("ensureSiteVisit blank === newSiteVisit(); ensureFloorPlan mirrors newFloorPlan()", () => {
  const p = {};
  assert.deepEqual(ensureSiteVisit(p), newSiteVisit());
  assert.deepEqual(Object.keys(ensureSiteVisit({})), Object.keys(newSiteVisit()));
  const q = { siteVisit: { files: "nope", typedScope: "keep" } };
  assert.deepEqual(ensureSiteVisit(q).files, []); assert.equal(q.siteVisit.typedScope, "keep");
  const fp = ensureFloorPlan({}, NOW);
  assert.deepEqual(Object.keys(fp), Object.keys(newFloorPlan()));
  assert.equal(fp.createdAt, NOW);
  const kept = { floorPlan: { createdAt: "x", mode: "upload", uploadedPages: [1] } };
  assert.equal(ensureFloorPlan(kept, NOW), kept.floorPlan);
});

/* ---------- the packet entries ---------- */
test("filesFromExport: exactly the packet's keys, at = the row's synced_at", () => {
  const fs = filesFromExport(ROW(), NOW);
  assert.equal(fs.length, 3);
  for (const f of fs) assert.deepEqual(Object.keys(f), ["id", "kind", "name", "path", "mime", "size", "room", "caption", "source", "at"]);
  assert.equal(fs[0].kind, MP_KIND_REPORT); assert.equal(fs[0].id, "mp-aaaaaaaa"); assert.equal(fs[0].room, ""); assert.equal(fs[0].caption, "");
  assert.equal(fs[1].kind, MP_KIND_PHOTO); assert.equal(fs[1].room, "Living Room"); assert.equal(fs[1].caption, "Window");
  assert.ok(fs.every((f) => f.at === "2026-09-26T20:00:00.000Z" && f.source === "magicplan"));
  assert.equal(filesFromExport({ ...ROW(), synced_at: null }, NOW)[0].at, NOW);
});

/* ---------- adopt ---------- */
test("adoptExport on a blank bid file: files, rooms, accepted Floor Plan rows, the blob", () => {
  const p = blankBid();
  const r = adoptExport(p, ROW(), { now: NOW, by: "owner@example.invalid" });
  assert.equal(r.added, 3); assert.equal(r.replaced, 0); assert.equal(r.unchanged, 0); assert.equal(r.skipped, 0);
  const sv = p.siteVisit;
  assert.equal(sv.files[0].kind, "report");
  assert.equal(sv.files[1].room, "Living Room"); assert.equal(sv.files[1].caption, "Window");
  assert.equal(sv.files[1].source, "magicplan"); assert.equal(sv.files[1].id, "mp-bbbbbbbb");
  assert.deepEqual(p.rooms, ["Ground Floor — Bedroom", "Bathroom", "Basement — Bedroom"]);
  assert.equal(r.roomsAdded, 3);
  const rows = p.floorPlan.dimensions.rooms;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.conf === 1 && x.source === "magicplan" && x.unit === "metric"));
  assert.equal(rows[0].floorSF, "139"); assert.equal(rows[0].perimLF, "48"); assert.equal(rows[0].ceiling, "8.5"); assert.equal(rows[0].name, "Ground Floor — Bedroom");
  assert.deepEqual(Object.keys(rows[0]), ["name", "dims", "floorSF", "perimLF", "ceiling", "notes", "conf", "source", "unit", "mpAt"]);
  assert.deepEqual(r.floorRows, { added: 3, updated: 0, reconfirmed: 0 });
  assert.equal(sv.magicplan.syncedAt, "2026-09-26T20:00:00.000Z"); assert.equal(sv.magicplan.exportId, ROW().id);
  assert.equal(sv.magicplan.units, "metric"); assert.deepEqual(sv.magicplan.statistics, NORMALIZED); assert.deepEqual(sv.magicplan.removed, []);
  assert.equal(sv.magicplan.projectId, PROJECT_ID); assert.equal(sv.magicplan.planId, PLAN_ID); assert.equal(sv.magicplan.by, "owner@example.invalid");
  assert.equal(r.summary.text, "1 report, 2 photos, 3 rooms measured");
  assert.equal(sv.transcript, ""); assert.equal(sv.typedScope, ""); assert.equal(sv.pending, null);
  assert.deepEqual(p.floorPlan.dimensions.notes, []); assert.equal(p.floorPlan.dimensions.at, NOW);
});
test("adoptExport keeps the blob the create wrote (projectId, cloudUrl, createdAt, by)", () => {
  const p = blankBid();
  p.siteVisit = { ...newSiteVisit(), magicplan: { projectId: PROJECT_ID, planId: PLAN_ID, cloudUrl: "https://example.invalid/p", createdAt: "2026-09-25T18:00:00.000000+00:00", by: "o@example.invalid", units: null, removed: [] } };
  adoptExport(p, ROW(), { now: NOW, by: "someone-else@example.invalid" });
  assert.equal(p.siteVisit.magicplan.cloudUrl, "https://example.invalid/p");
  assert.equal(p.siteVisit.magicplan.by, "o@example.invalid");
  assert.equal(p.siteVisit.magicplan.createdAt, "2026-09-25T18:00:00.000000+00:00");
  assert.equal(p.siteVisit.magicplan.units, "metric");
});
test("idempotent: adopting the same row twice adds and replaces nothing", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });
  const before = JSON.stringify([p.siteVisit.files, p.floorPlan.dimensions.rooms, p.rooms]);
  const r = adoptExport(p, ROW(), { now: "2026-09-27T00:00:00.000Z", by: "o" });
  assert.deepEqual({ added: r.added, replaced: r.replaced, unchanged: r.unchanged, roomsAdded: r.roomsAdded, floorRows: r.floorRows },
    { added: 0, replaced: 0, unchanged: 3, roomsAdded: 0, floorRows: { added: 0, updated: 0, reconfirmed: 0 } });
  assert.equal(nothingNew(r), true);
  assert.equal(p.siteVisit.files.length, 3);
  assert.equal(JSON.stringify([p.siteVisit.files, p.floorPlan.dimensions.rooms, p.rooms]), before);
  assert.ok(p.floorPlan.dimensions.rooms.every((x) => x.conf === 1));
});
test("changed content under the same id is replaced in place", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });
  const row = ROW(); row.photos[0].caption = "Window, north wall";
  const r = adoptExport(p, row, { now: NOW, by: "o" });
  assert.equal(r.replaced, 1); assert.equal(r.unchanged, 2); assert.equal(r.added, 0);
  assert.equal(nothingNew(r), false);
  assert.equal(p.siteVisit.files.length, 3);
  assert.equal(p.siteVisit.files.find((f) => f.id === "mp-bbbbbbbb").caption, "Window, north wall");
  assert.equal(p.siteVisit.files.find((f) => f.id === "mp-bbbbbbbb").at, "2026-09-26T20:00:00.000Z");   // the first adopt's stamp survives
});
test("a pre-filled Floor Plan: measured rows append amber, human rows untouched — even a same-named one", () => {
  const p = blankBid();
  const kitchen = { name: "Kitchen", dims: "10 x 12", floorSF: "120", perimLF: "44", ceiling: "8", notes: "typed", conf: 1 };
  const bath = { name: "Bathroom", dims: "5 x 8", floorSF: "40", perimLF: "26", ceiling: "8", notes: "typed", conf: 1 };
  p.floorPlan = { ...newFloorPlan(), dimensions: { rooms: [kitchen, bath], notes: ["plan note"], at: "2026-09-01T00:00:00Z" } };
  const r = adoptExport(p, ROW(), { now: NOW, by: "o" });
  const rows = p.floorPlan.dimensions.rooms;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], kitchen); assert.deepEqual(rows[1], bath);
  assert.ok(rows.slice(2).every((x) => x.conf === 0.5 && x.source === "magicplan"));
  assert.equal(rows.filter((x) => x.name === "Bathroom").length, 2);
  assert.deepEqual(r.floorRows, { added: 3, updated: 0, reconfirmed: 0 });
  assert.deepEqual(p.floorPlan.dimensions.notes, ["plan note"]); assert.equal(p.floorPlan.dimensions.at, "2026-09-01T00:00:00Z");
});
test("re-adopt with a changed measurement drops an accepted row back to amber; an unchanged one stays accepted", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });
  const row = ROW(); row.statistics.floors[0].rooms[0].floorSF = 142;
  const r = adoptExport(p, row, { now: NOW, by: "o" });
  assert.deepEqual(r.floorRows, { added: 0, updated: 1, reconfirmed: 1 });
  const rows = p.floorPlan.dimensions.rooms;
  assert.equal(rows[0].floorSF, "142"); assert.equal(rows[0].conf, 0.5);
  assert.equal(rows[1].conf, 1); assert.equal(rows[2].conf, 1);
  assert.equal(nothingNew(r), false);
  // an amber row that changes again stays amber and is not counted as reconfirmed
  row.statistics.floors[0].rooms[0].floorSF = 150;
  const r2 = adoptExport(p, row, { now: NOW, by: "o" });
  assert.deepEqual(r2.floorRows, { added: 0, updated: 1, reconfirmed: 0 });
});
test("mergeFloorPlanRows is pure and never removes a row", () => {
  const existing = [{ name: "Kitchen", floorSF: "1", conf: 1 }, { name: "Old", floorSF: "9", conf: 1, source: "magicplan", unit: "imperial", mpAt: "t0" }];
  const r = mergeFloorPlanRows(existing, [{ name: "Bath", floorSF: "5", perimLF: "", ceiling: "", dims: "", notes: "", conf: 0.5, source: "magicplan", unit: "imperial", mpAt: "t1" }]);
  assert.notEqual(r.rows, existing); assert.equal(existing.length, 2);
  assert.equal(r.rows.length, 3); assert.equal(r.rows[1].name, "Old");
  assert.deepEqual([r.added, r.updated, r.reconfirmed], [1, 0, 0]);
});
test("noteRemoved: a ✕'d file is skipped on re-pull; the list keeps the last 500", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });
  p.siteVisit.files = p.siteVisit.files.filter((f) => f.id !== "mp-bbbbbbbb");
  noteRemoved(p.siteVisit, "mp-bbbbbbbb");
  noteRemoved(p.siteVisit, "mp-bbbbbbbb");
  assert.deepEqual(p.siteVisit.magicplan.removed, ["mp-bbbbbbbb"]);
  const r = adoptExport(p, ROW(), { now: NOW, by: "o" });
  assert.equal(r.skipped, 1); assert.equal(r.added, 0);
  assert.ok(!p.siteVisit.files.some((f) => f.id === "mp-bbbbbbbb"));
  const sv = { files: [] };
  for (let i = 0; i < 600; i++) noteRemoved(sv, "mp-" + String(i).padStart(8, "0"));
  assert.equal(sv.magicplan.removed.length, 500);
  assert.equal(sv.magicplan.removed[0], "mp-00000100"); assert.equal(sv.magicplan.removed[499], "mp-00000599");
});
test("a person's room list is never overwritten", () => {
  const p = { ...blankBid(), rooms: ["Kitchen"] };
  const r = adoptExport(p, ROW(), { now: NOW, by: "o" });
  assert.deepEqual(p.rooms, ["Kitchen"]); assert.equal(r.roomsAdded, 0);
});
test("packetForDraft carries adopted files with room and caption — no special case", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });
  const pk = packetForDraft(p.siteVisit);
  assert.equal(pk.reports.length, 1); assert.equal(pk.photos.length, 2);
  assert.equal(pk.reports[0].path, mpFilePath(JOB, HASH_A, REPORT_NAME));
  assert.deepEqual(pk.photos.map((f) => [f.room, f.caption]), [["Living Room", "Window"], ["Bedroom", ""]]);
});
test("an export with nothing in it still adopts cleanly (the caller decides not to offer it)", () => {
  const p = blankBid();
  const empty = { ...ROW(), files: [], photos: [], statistics: { units: "imperial", floors: [] } };
  const r = adoptExport(p, empty, { now: NOW, by: "o" });
  assert.equal(nothingNew(r), true);
  assert.deepEqual(exportSummary(empty), { reports: 0, photos: 0, rooms: 0, text: "0 reports, 0 photos, 0 rooms measured" });
});

/* ---------- the Bid card's words ---------- */
const STAMP = /\d{1,2}\/\d{1,2} \d{1,2}:\d{2} (AM|PM)/;
test("bidMagicplanState / bidMagicplanText: the five states, in order", () => {
  const none = blankBid();
  assert.equal(bidMagicplanState(none, {}), "not created");
  assert.equal(bidMagicplanText(none, {}), "not created");
  const created = { ...blankBid(), siteVisit: { ...newSiteVisit(), magicplan: { projectId: PROJECT_ID, planId: PLAN_ID, createdAt: "2026-09-26T22:41:00.000000+00:00", by: "o", units: null, removed: [] } } };
  assert.equal(bidMagicplanState(created, {}), "ready on phone");
  assert.match(bidMagicplanText(created, {}), new RegExp("^ready on phone · created " + STAMP.source + "$"));
  assert.equal(bidMagicplanState(created, { pending: ROW() }), "scan received");
  assert.equal(bidMagicplanText(created, { pending: ROW() }), "scan received · 1 report, 2 photos, 3 rooms measured");
  const imported = blankBid();
  adoptExport(imported, ROW(), { now: NOW, by: "o" });
  assert.equal(bidMagicplanState(imported, {}), "imported");
  assert.match(bidMagicplanText(imported, {}), new RegExp("^imported · synced " + STAMP.source + " · 2 photos · 3 rooms$"));
  const status = { externalReferenceId: JOB, userModified: "2026-09-26T21:41:00.000000+00:00", archivedAt: null, planId: PLAN_ID };
  assert.equal(bidMagicplanState(imported, { status }), "updated since import");
  assert.match(bidMagicplanText(imported, { status }), new RegExp("^updated since import · synced " + STAMP.source + "$"));
  const older = { ...status, userModified: "2026-09-26T19:00:00.000000+00:00" };
  assert.equal(bidMagicplanState(imported, { status: older }), "imported");
  assert.equal(bidMagicplanState(imported, { status, pending: ROW() }), "scan received");   // a waiting row outranks "updated"
  assert.match(bidMagicplanText(imported, { status: { ...older, archivedAt: "2026-09-27T00:00:00.000000+00:00" } }), / · archived$/);
  assert.equal(bidMagicplanText(none, { status: { archivedAt: "x" } }), "not created · archived");
});
test("fmtMpStamp / hasPendingUpdate", () => {
  assert.match(fmtMpStamp("2026-09-26T22:41:00.000000+00:00"), STAMP);
  assert.equal(fmtMpStamp("garbage"), ""); assert.equal(fmtMpStamp(null), "");
  const mp = { syncedAt: "2026-09-26T20:00:00.000Z" };
  assert.equal(hasPendingUpdate(mp, { userModified: "2026-09-26T21:41:00.000000+00:00" }), true);
  assert.equal(hasPendingUpdate(mp, { userModified: "2026-09-26T19:41:00.000000+00:00" }), false);
  assert.equal(hasPendingUpdate(mp, null), false);
  assert.equal(hasPendingUpdate({}, { userModified: "2026-09-26T21:41:00.000000+00:00" }), false);
  assert.equal(hasPendingUpdate(mp, { userModified: "garbage" }), false);
});

/* ---------- which rows to offer ---------- */
test("pendingRows: ready, un-imported, not already adopted; newest first, nulls last", () => {
  const p = blankBid();
  adoptExport(p, ROW(), { now: NOW, by: "o" });   // exportId = ROW().id
  const rows = [
    { ...ROW(), id: "a1", synced_at: "2026-09-26T19:30:00Z" },                       // ready, older
    { ...ROW(), id: "a2", synced_at: "2026-09-26T21:00:00Z" },                       // ready, newer
    { ...ROW(), id: "a3", synced_at: "2026-09-26T22:00:00Z", imported_at: "2026-09-26T22:01:00Z" },
    { ...ROW(), id: "a4", status: "failed" },
    { ...ROW(), id: "a5", status: "unmatched", field_project_id: null },
    { ...ROW(), id: "a6", synced_at: null },
    ROW(),                                                                            // the adopted one
  ];
  assert.deepEqual(pendingRows(rows, p).map((r) => r.id), ["a2", "a1", "a6"]);
  assert.deepEqual(pendingRows(rows, blankBid()).map((r) => r.id), ["a2", ROW().id, "a1", "a6"]);
  assert.deepEqual(pendingRows(null, p), []);
});
test("autoAdoptEnabled: the four combinations", () => {
  assert.equal(autoAdoptEnabled("1", false), true);
  assert.equal(autoAdoptEnabled("0", true), false);
  assert.equal(autoAdoptEnabled(null, true), true);
  assert.equal(autoAdoptEnabled(undefined, false), false);
});
test("PostgREST paths", () => {
  const q = pendingQuery("bj-1");
  assert.ok(q.startsWith("magicplan_exports?select="));
  assert.ok(q.includes("field_project_id=eq.bj-1") && q.includes("status=eq.ready") && q.includes("imported_at=is.null") && q.includes("order=synced_at.desc.nullslast"));
  assert.ok(pendingQuery("a b").includes("field_project_id=eq.a%20b"));
  assert.ok(recentExportsQuery(10).endsWith("limit=10") && recentExportsQuery().endsWith("limit=10") && recentExportsQuery(3).endsWith("limit=3"));
  assert.ok(recentExportsQuery().includes("imported_by") && recentExportsQuery().includes("order=received_at.desc"));
});

console.log(`\n${pass} passed`);
