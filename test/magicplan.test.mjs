/* Magicplan — the client's pure half (js/magicplancalc.js).
   docs/Magicplan_Integration_Design.md §4.3, §6 rulings 10 and 11.
   Fixtures are hand-written from the live OpenAPI shapes (API v1.2) — never a
   recorded response, never a key or a customer's address.
   Run: node apps/field/test/magicplan.test.mjs   (from repo root) */
import assert from "node:assert/strict";
import {
  mpFileId, mpFilePath, parsePhotoName, normalizeStatistics, dedupeRoomNames, splitAddress, projectName,
  mergeMeasuredRooms, adoptExport, exportSummary, mpState, MEASURED_CONF,
} from "../js/magicplancalc.js";
import { siteFilePath, packetForDraft } from "../js/sitevisit.js";

let pass = 0;
const test = (name, fn) => { fn(); console.log("  ✓ " + name); pass++; };
console.log("Magicplan");

/* GET /plans/statistics/{id} — the live response is NOT wrapped in {data} */
const room = (name, o = {}) => ({
  uid: "r-" + name, name, area: 0, perimeter: 0, ground_perimeter: 0, area_without_walls: 0,
  height: 0, volume: 0, walls_surface: 0, walls_surface_without_openings: 0,
  door_count: 0, window_count: 0, dimensions: "", ...o,
});
const IMPERIAL = {
  id: "plan-1", project_id: "proj-1", units: "imperial",
  statistics: {
    floors: [{
      uid: "f1", name: "1st Floor", height: 8,
      rooms: [
        room("Living Room", { area_without_walls: 214.37, ground_perimeter: 58.2, height: 8, volume: 1715.2,
          walls_surface: 465.4, walls_surface_without_openings: 402.9, door_count: 2, window_count: 3, dimensions: "14' 6\" x 14' 9\"" }),
        room("Bathroom", { area_without_walls: 40, ground_perimeter: 26, walls_surface: 208, walls_surface_without_openings: 190, volume: 320 }),
      ],
    }],
  },
};
const METRIC = {
  id: "plan-2", project_id: "proj-2", units: "metric",
  statistics: { floors: [{ uid: "f1", name: "Ground", height: 2.44, rooms: [
    room("Kitchen", { area_without_walls: 10, ground_perimeter: 13, height: 2.44, volume: 24.4, walls_surface: 31.7, walls_surface_without_openings: 27 }),
  ] }] },
};

/* ---------- paths ---------- */
test("mpFilePath is siteFilePath with the mp-<hash8> id — the same cleaning, the same shape", () => {
  const hash = "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08";
  assert.equal(mpFileId(hash), "mp-9f86d081");
  for (const [job, name] of [["bj-lead_42", "Magicplan Report.pdf"], ["p_abc123", "1st Floor - Living Room - Window - 2.jpg"],
    ["bj-x", "../../etc/passwd"], ["bj-y", ""], ["bj-z", "a".repeat(200) + ".pdf"]]) {
    assert.equal(mpFilePath(job, hash, name), siteFilePath(job, mpFileId(hash), name), `${job} / ${name}`);
  }
  assert.equal(mpFilePath("bj-lead_42", hash, "Magicplan Report.pdf"), "sitevisit/bj-lead_42/mp-9f86d081-Magicplan_Report.pdf");
});

/* ---------- photo names ---------- */
test("a pinned photo's name gives its floor, room and caption", () => {
  assert.deepEqual(parsePhotoName("1st Floor - Living Room - Window - 2.jpg"), { floor: "1st Floor", room: "Living Room", caption: "Window" });
  assert.deepEqual(parsePhotoName("Basement - Utility - Water Heater - 1.JPG"), { floor: "Basement", room: "Utility", caption: "Water Heater" });
  assert.deepEqual(parsePhotoName("1st Floor - Kitchen - Sink - Base - 3.jpg"), { floor: "1st Floor", room: "Kitchen", caption: "Sink - Base" });
});
test("a name that doesn't split stays uncaptioned with room \"\" — never a guess", () => {
  for (const n of ["IMG_1234.jpg", "Living Room - 2.jpg", "1st Floor - Living Room - Window.jpg", "", null, "a - b - c - x.jpg"]) {
    assert.deepEqual(parsePhotoName(n), { floor: "", room: "", caption: "" }, String(n));
  }
});

/* ---------- units ---------- */
test("imperial statistics pass through, rounded (1 ft², 0.5 ft, 1 ft³)", () => {
  const s = normalizeStatistics(IMPERIAL);
  assert.equal(s.units, "imperial");
  assert.deepEqual(s.floors[0].rooms[0], {
    name: "Living Room", floorSF: 214, perimLF: 58, ceilingFt: 8, wallSF: 465, wallSFNet: 403,
    doors: 2, windows: 3, volumeCF: 1715, dims: "14' 6\" x 14' 9\"",
  });
});
test("metric statistics convert to feet once (m² × 10.764, m × 3.281, m³ × 35.315)", () => {
  const k = normalizeStatistics(METRIC).floors[0].rooms[0];
  assert.equal(normalizeStatistics(METRIC).units, "metric");
  assert.equal(k.floorSF, 108);        // 10 m² → 107.64 ft²
  assert.equal(k.perimLF, 42.5);       // 13 m → 42.65 ft → nearest half foot
  assert.equal(k.ceilingFt, 8);        // 2.44 m → 8.006 ft
  assert.equal(k.volumeCF, 862);       // 24.4 m³ → 861.7 ft³
  assert.equal(k.wallSF, 341);
  assert.equal(k.wallSFNet, 291);
});
test("a room with no height takes its floor's; a missing name gets a placeholder", () => {
  const s = normalizeStatistics({ units: "imperial", statistics: { floors: [{ name: "", height: 9, rooms: [room("", {})] }] } });
  assert.equal(s.floors[0].name, "Floor 1");
  assert.equal(s.floors[0].rooms[0].name, "Room 1");
  assert.equal(s.floors[0].rooms[0].ceilingFt, 9);
  assert.deepEqual(normalizeStatistics(null), { units: "imperial", floors: [] });
});
test("rooms come from rooms[], so the uncounted bathroom is still imported", () => {
  const s = normalizeStatistics({ ...IMPERIAL, statistics: { ...IMPERIAL.statistics, room_count: 1 } });
  assert.deepEqual(s.floors[0].rooms.map((r) => r.name), ["Living Room", "Bathroom"]);
});

/* ---------- room names ---------- */
test("the floor prefix appears only when the same room name is on two floors", () => {
  const labels = dedupeRoomNames([
    { name: "1st Floor", rooms: [{ name: "Bedroom" }, { name: "Kitchen" }] },
    { name: "Basement", rooms: [{ name: "Bedroom" }, { name: "Utility" }] },
  ]).map((r) => r.label);
  assert.deepEqual(labels, ["1st Floor — Bedroom", "Kitchen", "Basement — Bedroom", "Utility"]);
});
test("a name repeated on one floor is numbered", () => {
  const labels = dedupeRoomNames([{ name: "1st Floor", rooms: [{ name: "Closet" }, { name: "closet" }, { name: "Hall" }] }]).map((r) => r.label);
  assert.deepEqual(labels, ["Closet", "closet 2", "Hall"]);
});

/* ---------- address + name ---------- */
test("the job's one-line address splits for Magicplan", () => {
  assert.deepEqual(splitAddress("3850 Royal Rd, Fairbanks, AK 99701"), { street: "3850 Royal Rd", city: "Fairbanks", postal_code: "99701", country: "US" });
  assert.deepEqual(splitAddress("12 Elm St, North Pole AK 99705"), { street: "12 Elm St", city: "North Pole", postal_code: "99705", country: "US" });
  assert.deepEqual(splitAddress("12 Elm St, AK 99705"), { street: "12 Elm St", city: "", postal_code: "99705", country: "US" });
  assert.deepEqual(splitAddress("Mile 5 Chena Hot Springs"), { street: "Mile 5 Chena Hot Springs", city: "", postal_code: "", country: "US" });
  assert.equal(projectName("Kennedy", "12 Elm St"), "Kennedy — 12 Elm St");
  assert.equal(projectName("", ""), "Site visit");
});

/* ---------- Floor Plan table (ruling 10) ---------- */
const stats = normalizeStatistics(IMPERIAL);
test("an empty Floor Plan table takes measured rows accepted (conf 1) with their unit", () => {
  const m = mergeMeasuredRooms([], stats);
  assert.equal(m.accepted, true);
  assert.equal(m.added, 2);
  assert.deepEqual(m.rows[0], { name: "Living Room", dims: "14' 6\" x 14' 9\"", floorSF: "214", perimLF: "58", ceiling: "8 ft", notes: "", conf: 1, source: "magicplan", unit: "ft" });
  assert.equal(m.rows[1].ceiling, "8 ft");   // the room's own height is 0 → the floor's
});
test("a table someone already filled gets the measured rows amber, and keeps its own rows", () => {
  const mine = { name: "Living Room", dims: "", floorSF: "200", perimLF: "", ceiling: "", notes: "AI read", conf: 0.9 };
  const m = mergeMeasuredRooms([mine], stats);
  assert.equal(m.accepted, false);
  assert.equal(m.rows[0], mine);
  assert.ok(m.rows.slice(1).every((r) => r.conf === MEASURED_CONF && r.source === "magicplan"));
});
test("a blank row the form added doesn't make the table 'filled'", () => {
  const blank = { name: "", dims: "", floorSF: "", perimLF: "", ceiling: "", notes: "", conf: 1 };
  assert.equal(mergeMeasuredRooms([blank], stats).accepted, true);
});
test("a re-pull updates Magicplan's rows in place and keeps an unchanged row's decision", () => {
  const first = mergeMeasuredRooms([{ name: "Den", floorSF: "90", conf: 0.8 }], stats).rows;
  first[1].conf = 1;                      // ✓ Use measured on Living Room
  first[1].notes = "checked";
  const again = mergeMeasuredRooms(first, stats);
  assert.equal(again.added + again.updated, 0);
  assert.equal(again.rows.length, 3);
  assert.equal(again.rows[1].conf, 1);
  const rescan = normalizeStatistics({ ...IMPERIAL, statistics: { floors: [{ ...IMPERIAL.statistics.floors[0],
    rooms: [room("Living Room", { area_without_walls: 220, ground_perimeter: 59 }), IMPERIAL.statistics.floors[0].rooms[1]] }] } });
  const moved = mergeMeasuredRooms(first, rescan);
  assert.equal(moved.updated, 1);
  assert.equal(moved.rows[1].floorSF, "220");
  assert.equal(moved.rows[1].conf, MEASURED_CONF);   // new numbers → amber again
  assert.equal(moved.rows[1].notes, "checked");
});

/* ---------- adopt ---------- */
const H1 = "a".repeat(64), H2 = "b".repeat(64), H3 = "c".repeat(64);
const ROW = {
  id: "exp-1", mp_project_id: "proj-1", mp_plan_id: "plan-1", field_project_id: "bj-lead_42", status: "ready",
  synced_at: "2026-09-26T22:41:00Z",
  files: [{ path: mpFilePath("bj-lead_42", H1, "Report.pdf"), name: "Report.pdf", mime: "application/pdf", size: 900000, hash: H1, folder: "Report PDF" }],
  photos: [
    { path: mpFilePath("bj-lead_42", H2, "p1.jpg"), name: "1st Floor - Living Room - Window - 1.jpg", mime: "image/jpeg", size: 300000, hash: H2, room: "Living Room", floor: "1st Floor", caption: "Window" },
    { path: mpFilePath("bj-lead_42", H3, "p2.jpg"), name: "IMG_9.jpg", mime: "image/jpeg", size: 200000, hash: H3, room: "", floor: "", caption: "" },
  ],
  statistics: stats,
  floors_svg: [{ floor: "1st Floor", path: mpFilePath("bj-lead_42", "d".repeat(64), "1st_Floor.svg"), hash: "d".repeat(64) }],
};
const job = () => ({ id: "bj-lead_42", bidOf: "lead_42", siteVisit: { files: [{ id: "u1", kind: "notes", path: "sitevisit/bj-lead_42/u1-n.jpg", mime: "image/jpeg" }], magicplan: { projectId: "proj-1", planId: "plan-1", createdAt: "2026-09-25T10:00:00Z", by: "office" } } });

test("adopting puts the report and the room-captioned photos in the packet, tagged Magicplan", () => {
  const p = job();
  const n = adoptExport(p, ROW, "2026-09-26T23:00:00Z");
  assert.deepEqual([n.reports, n.photos, n.rooms], [1, 2, 2]);
  const mpFiles = p.siteVisit.files.filter((f) => f.source === "magicplan");
  assert.deepEqual(mpFiles.map((f) => [f.id, f.kind]), [["mp-aaaaaaaa", "report"], ["mp-bbbbbbbb", "photos"], ["mp-cccccccc", "photos"]]);
  assert.equal(mpFiles[1].room, "Living Room");
  assert.equal(mpFiles[1].caption, "Window");
  // the estimator reads them with no special case
  const pk = packetForDraft(p.siteVisit);
  assert.equal(pk.reports[0].path, ROW.files[0].path);
  assert.deepEqual(pk.photos.map((f) => f.room), ["Living Room", ""]);
  assert.equal(pk.notes.length, 1);
});
test("adopting fills rooms (only when empty), the Floor Plan table and the link stamps", () => {
  const p = job();
  adoptExport(p, ROW, "2026-09-26T23:00:00Z");
  assert.deepEqual(p.rooms, ["Living Room", "Bathroom"]);
  assert.equal(p.floorPlan.dimensions.rooms.length, 2);
  assert.equal(p.floorPlan.dimensions.rooms[0].conf, 1);
  const mp = p.siteVisit.magicplan;
  assert.equal(mp.createdAt, "2026-09-25T10:00:00Z");   // kept
  assert.equal(mp.exportId, "exp-1");
  assert.equal(mp.syncedAt, "2026-09-26T22:41:00Z");
  assert.equal(mp.units, "imperial");
  assert.equal(mp.floors[0].floor, "1st Floor");
  assert.equal(mp.statistics.floors[0].rooms[0].floorSF, 214);
  const q = job(); q.rooms = ["Kitchen"];
  adoptExport(q, ROW);
  assert.deepEqual(q.rooms, ["Kitchen"]);
});
test("a second adopt of the same scan adds nothing — same hash, same row", () => {
  const p = job();
  adoptExport(p, ROW);
  const before = JSON.stringify(p.siteVisit.files);
  adoptExport(p, { ...ROW, id: "exp-2" });
  assert.equal(JSON.stringify(p.siteVisit.files.map((f) => f.id)), JSON.stringify(JSON.parse(before).map((f) => f.id)));
  assert.equal(p.floorPlan.dimensions.rooms.length, 2);
});
test("a Magicplan file the user removed stays out on the next pull", () => {
  const p = job();
  adoptExport(p, ROW);
  p.siteVisit.files = p.siteVisit.files.filter((f) => f.id !== "mp-cccccccc");
  p.siteVisit.magicplan.removed = ["mp-cccccccc"];
  const n = adoptExport(p, { ...ROW, id: "exp-2" });
  assert.equal(n.photos, 1);
  assert.ok(!p.siteVisit.files.some((f) => f.id === "mp-cccccccc"));
});
test("a job with no site visit yet gets one", () => {
  const p = { id: "bj-lead_42" };
  adoptExport(p, ROW);
  assert.equal(p.siteVisit.files.length, 3);
  assert.equal(p.siteVisit.magicplan.projectId, "proj-1");
});

/* ---------- summaries and state ---------- */
test("the banner summary counts reports, photos and measured rooms", () => {
  assert.equal(exportSummary(ROW), "1 report, 2 photos, 2 rooms measured");
});
test("the Bid card state walks not created → ready → received → imported → updated", () => {
  assert.equal(mpState({}).key, "none");
  const p = job();
  assert.equal(mpState(p).key, "ready");
  assert.equal(mpState(p, { pending: ROW }).key, "received");
  adoptExport(p, ROW);
  assert.equal(mpState(p).key, "imported");
  assert.equal(mpState(p, { userModified: "2026-09-26T20:00:00Z" }).key, "imported");
  assert.equal(mpState(p, { userModified: "2026-09-27T08:00:00Z" }).key, "updated");
});

console.log(`\n${pass} passed`);
