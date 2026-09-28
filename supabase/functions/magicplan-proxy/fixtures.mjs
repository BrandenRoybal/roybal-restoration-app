/* Magicplan API fixtures — HAND-WRITTEN from the live OpenAPI 3.1.1 document
   (API v1.2, read 2026-09-25), never recorded from a real response: a recorded
   body would carry the company key's traces and a real customer's address
   (brief rule 7). Every name and address here is invented; the customer is
   "Test Customer" at "123 Test Ave, Fairbanks, AK 99701".

   The shapes are the ONE shape per call the parsers in magicplan.ts accept:
   GET /workspace and GET /plans/statistics/{id} are unwrapped; everything
   else is `{ data }`; error bodies are `{ message, data }`. STATS_* and ROW
   are the canonical fixtures shared with apps/field/test/magicplan.test.mjs
   (the field side inlines the same literals) so the parity test compares the
   server's helpers and the field's on identical input. */

/* ---------- ids and hashes ---------- */
export const PROJECT_ID = "c32ea8d1-fee3-4c81-b402-eb3f85772cf8";
export const PLAN_ID = "6a45b1435520f";
export const JOB = "bj-1f2e3d4c-0000-0000-0000-000000000000";
export const HASH = "0123456789abcdef".repeat(4);
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);

/* ---------- GET /workspace (UNWRAPPED) ---------- */
export const WORKSPACE_200 = {
  id: "ws-0001", name: "Test Workspace", description: null,
  owner: { id: "1f0a2b3c-0000-4000-8000-000000000001", email: "owner@example.invalid", firstname: "Test", lastname: "Owner" },
  created: "2024-01-15 09:00:00",
  formats: ["pdf", "jpg", "png", "svg", "statistics:pdf"],
  webhook_url: null, listing_url: null, authorize_url: null, authentication_url: "", access_token_url: null,
  logo: null, notify_user: false, last_modified: "2026-09-20 18:22:10",
};
export const WORKSPACE_401 = { message: "Unauthorized", data: "" };

/* ---------- GET /projects ---------- */
const listItem = (id, ext, name, archived = null) => ({
  id, external_reference_id: ext, name, thumbnail_url: "https://s3.amazonaws.com/example-thumbs/" + id + ".png",
  assignee: { id: "1f0a2b3c-0000-4000-8000-000000000001", email: "owner@example.invalid" },
  user_created: "2026-09-25T18:00:00.000000+00:00", user_modified: "2026-09-25T18:05:00.000000+00:00", archived_at: archived,
});
const pageInfo = (page, total, next) => ({
  current_page: page, page_size: 50, total_pages: total, total_count: 2, from: 1, to: 2,
  first_page: 1, first_page_url: "https://cloud.magicplan.app/api/v2/projects?page=1",
  last_page: total, last_page_url: `https://cloud.magicplan.app/api/v2/projects?page=${total}`,
  next_page: next, next_page_url: next ? `https://cloud.magicplan.app/api/v2/projects?page=${next}` : null,
  prev_page: page > 1 ? page - 1 : null, prev_page_url: null,
});
export const PROJECTS_LIST_HIT = {
  data: [
    listItem("00000000-aaaa-4000-8000-000000000010", "bj-other-job", "Test Customer — 456 Sample Rd"),
    listItem(PROJECT_ID, JOB, "Test Customer — 123 Test Ave"),
  ],
  page_info: pageInfo(1, 1, null),
};
export const PROJECTS_LIST_ARCHIVED_ONLY = {
  data: [listItem(PROJECT_ID, JOB, "Test Customer — 123 Test Ave", "2026-09-24T12:00:00.000000+00:00")],
  page_info: pageInfo(1, 1, null),
};
export const PROJECTS_LIST_PAGE1 = {
  data: [listItem("00000000-aaaa-4000-8000-000000000011", null, "Test Customer — 789 Example St")],
  page_info: pageInfo(1, 2, 2),
};
export const PROJECTS_LIST_PAGE2 = {
  data: [listItem(PROJECT_ID, JOB, "Test Customer — 123 Test Ave")],
  page_info: pageInfo(2, 2, null),
};
export const PROJECTS_LIST_EMPTY = { data: [], page_info: pageInfo(1, 1, null) };

/* ---------- POST /projects, GET /projects/{id}, PUT /projects/{id}/archive ---------- */
const project = (ext, archived = null) => ({
  id: PROJECT_ID, plan_id: PLAN_ID, external_reference_id: ext, name: "Test Customer — 123 Test Ave",
  thumbnail_url: "https://s3.amazonaws.com/example-thumbs/" + PROJECT_ID + ".png",
  cloud_url: "https://cloud.magicplan.app/projects/" + PROJECT_ID,
  team: { id: "2f0a2b3c-0000-4000-8000-000000000002", name: "Test Team" },
  user: { id: "1f0a2b3c-0000-4000-8000-000000000001", email: "owner@example.invalid", firstname: "Test", lastname: "Owner" },
  address: { street: "123 Test Ave", city: "Fairbanks", country: "US", postal_code: "99701", latitude: null, longitude: null },
  user_created: "2026-09-25T18:00:00.000000+00:00", user_modified: "2026-09-25T18:05:00.000000+00:00", archived_at: archived,
});
export const PROJECT_201 = { data: project(JOB) };
export const PROJECT_207 = { data: project(JOB), warnings: [{ message: "Address could not be geocoded", extensions: {} }] };
export const PROJECT_400 = { message: "Bad Request", data: { errors: "Field 'email' is required." } };
export const PROJECT_GET_200 = { data: project(JOB) };
export const PROJECT_GET_200_FOREIGN = { data: project("bj-other-job") };
export const PROJECT_GET_200_UNLINKED = { data: project(null) };
export const PROJECT_GET_404 = { message: "Project not found", data: "" };
export const ARCHIVE_200 = { data: project(JOB, "2026-09-26T21:00:00.000000+00:00") };
export const ARCHIVE_404 = { message: "Project not found", data: "" };

/* ---------- bytes ---------- */
const enc = new TextEncoder();
export const SVG_BYTES = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
export const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
export const JPG_BYTES_2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xd9]);

/* ---------- GET /plans/{id}/files ---------- */
/* Declared sizes equal the byte lengths, as the API's S3 object sizes do: the
   pre-download reuse key includes size, so a fixture that lied here would make
   the "already have it" tests re-download forever. */
export const PHOTO_NAME_1 = "1st Floor - Living Room - Window - 2.jpg";
export const PHOTO_NAME_2 = "Ground Floor - Bedroom - 1.jpg";
export const REPORT_NAME = "Report PDF - 123 Test Ave.pdf";
const S3 = "https://s3.amazonaws.com/example-magicplan-files/";
const mpFile = (name, folder, type, size, url, extra = {}) => ({
  name, folder, url, last_modified: "2026-09-26T19:58:00.000000+00:00", size, file_type: type, ...extra,
});
export const PLAN_FILES_200 = {
  data: {
    files: [mpFile(REPORT_NAME, "Report PDF", "pdf", PDF_BYTES.length, S3 + "report.pdf")],
    photos: [
      mpFile(PHOTO_NAME_1, "Captured photos", "jpg", JPG_BYTES.length, S3 + "photo-1.jpg", { symbol_instance_id: "sym-1" }),
      mpFile(PHOTO_NAME_2, "Captured photos", "jpg", JPG_BYTES_2.length, S3 + "photo-2.jpg", { symbol_instance_id: "sym-2" }),
    ],
  },
};
export const PLAN_FILES_NOPHOTOS = { data: { files: [mpFile(REPORT_NAME, "Report PDF", "pdf", PDF_BYTES.length, S3 + "report.pdf")], photos: [] } };
export const PLAN_FILES_EMPTY = { data: { files: [], photos: [] } };
export const PLAN_FILES_405 = { code: 405, message: "Method Not Allowed" };
/** 121 photos — one over MAX_PHOTOS. */
export const PLAN_FILES_MANY = {
  data: {
    files: [],
    photos: Array.from({ length: 121 }, (_, i) =>
      mpFile(`1st Floor - Living Room - Item ${i} - 1.jpg`, "Captured photos", "jpg", 100 + i, S3 + `many-${i}.jpg`, { symbol_instance_id: `sym-${i}` })),
  },
};

/* ---------- GET /plans/statistics/{id} (UNWRAPPED) — 2.12 verbatim ---------- */
export const STATS_METRIC = {
  id: PLAN_ID, project_id: PROJECT_ID, units: "metric",
  statistics: {
    uid: "5f20068a.8ea40fdd", name: "Plan", floors: [
      { uid: "64ee095e.777983ff", name: "Ground Floor", height: 2.44, rooms: [
        { uid: "3f2006ca.bf7e70fa", name: "Bedroom", area: 13.412, perimeter: 14.72, ground_perimeter: 14.6, area_without_walls: 12.9, height: 2.525, volume: 32.57, walls_surface: 36.87, walls_surface_without_openings: 31.2, door_count: 1, window_count: 2, dimensions: "3.54 m x 3.64 m", furnitures: [], wall_items: [] },
        { uid: "3f2006ca.aaaa0001", name: "Bathroom", area: 5.0, ground_perimeter: 9.0, area_without_walls: 4.6, height: 2.4, volume: 11.04, walls_surface: 21.6, walls_surface_without_openings: 19.9, door_count: 1, window_count: 0, dimensions: "2 m x 2.3 m" } ] },
      { uid: "64ee095e.bbbb0002", name: "Basement", height: 2.2, rooms: [
        { uid: "3f2006ca.cccc0003", name: "Bedroom", area: 20.0, ground_perimeter: 18.0, area_without_walls: 19.5, height: 2.2, volume: 42.9, walls_surface: 39.6, walls_surface_without_openings: 35.0, door_count: 1, window_count: 1, dimensions: "4 m x 5 m" } ] } ] },
};
export const STATS_IMPERIAL = { ...STATS_METRIC, units: "imperial" };
export const STATS_UNKNOWN = { ...STATS_METRIC, units: "feet" };

/** normalizeStatistics(STATS_METRIC), arithmetic verified while judging. */
export const STATS_METRIC_NORMALIZED = {
  units: "metric", floors: [
    { name: "Ground Floor", rooms: [
      { name: "Bedroom", floorSF: 139, perimLF: 48, ceilingFt: 8.5, wallSF: 397, wallSFNet: 336, doors: 1, windows: 2, volumeCF: 1150, dims: "3.54 m x 3.64 m" },
      { name: "Bathroom", floorSF: 50, perimLF: 29.5, ceilingFt: 8, wallSF: 233, wallSFNet: 214, doors: 1, windows: 0, volumeCF: 390, dims: "2 m x 2.3 m" } ] },
    { name: "Basement", rooms: [
      { name: "Bedroom", floorSF: 210, perimLF: 59, ceilingFt: 7, wallSF: 426, wallSFNet: 377, doors: 1, windows: 1, volumeCF: 1515, dims: "4 m x 5 m" } ] } ],
};

/* ---------- GET /projects/{id}/plan ---------- */
export const SVG_NAME = "ad8cd7aa28786678aae03be8e7c3f02964ee095e-777983ff.svg";
export const SVG_URL = `https://cloud.magicplan.app/api/v2/images/plan/${PLAN_ID}/svg/${SVG_NAME}`;
export const PROJECT_PLAN_200 = {
  data: {
    id: PROJECT_ID, name: "Test Customer — 123 Test Ave", team: { id: "2f0a2b3c-0000-4000-8000-000000000002", name: "Test Team" },
    user_created: "2026-09-25T18:00:00.000000+00:00", user_modified: "2026-09-26T19:58:00.000000+00:00", unit: "feet",
    plan_data: {
      living_area: 1, floor_count: 1, room_count: 1, door_count: 1, window_count: 1,
      floors: [{ uid: "64ee095e.777983ff", name: "Ground Floor", values: [], image: SVG_URL, objects: [], image_map: [], rooms: [] }],
    },
    attributes: [],
  },
};
export const PROJECT_PLAN_NOFLOORS = { data: { id: PROJECT_ID, name: "Test Customer — 123 Test Ave", plan_data: {} } };

/* ---------- photo names, addresses ---------- */
export const PHOTO_NAMES = {
  [PHOTO_NAME_1]: { floor: "1st Floor", room: "Living Room", caption: "Window" },
  "1st Floor - Living Room - Dining table with 6 chairs (rectangular) - 2.jpg": { floor: "1st Floor", room: "Living Room", caption: "Dining table with 6 chairs (rectangular)" },
  [PHOTO_NAME_2]: { floor: "Ground Floor", room: "Bedroom", caption: "" },
  "Basement - Bedroom - Window - 12.JPG": { floor: "Basement", room: "Bedroom", caption: "Window" },
  "Kitchen - sink.jpg": { floor: "", room: "", caption: "" },
  "IMG_4821.jpg": { floor: "", room: "", caption: "" },
};
export const ADDRESS_FULL = "123 Test Ave, Fairbanks, AK 99701";
export const ADDRESS_NO_COMMA_STATE = "123 Test Ave, Fairbanks AK 99701";
export const ADDRESS_ONE_PART = "456 Sample Rd Fairbanks AK 99709";

/* ---------- the canonical row (2.12) — built by rowFixture(mpFilePath) so the
   paths come from the helper under test, not a literal that could drift ---------- */
export function rowFixture(mpFilePath) {
  const LM = "2026-09-26T19:58:00.000000+00:00";
  return {
    id: "11111111-2222-4333-8444-555555555555",
    mp_project_id: PROJECT_ID, mp_plan_id: PLAN_ID, field_project_id: JOB, status: "ready",
    synced_at: "2026-09-26T20:00:00.000Z", imported_at: null, error: null,
    files: [{
      path: mpFilePath(JOB, HASH_A, REPORT_NAME), name: REPORT_NAME, mime: "application/pdf", size: 1234, hash: HASH_A,
      folder: "Report PDF", mp_last_modified: LM, file_type: "pdf",
    }],
    photos: [
      { path: mpFilePath(JOB, HASH_B, PHOTO_NAME_1), name: PHOTO_NAME_1, mime: "image/jpeg", size: 2222, hash: HASH_B,
        folder: "Captured photos", mp_last_modified: LM, file_type: "jpg",
        room: "Living Room", floor: "1st Floor", caption: "Window", symbol_instance_id: "sym-1" },
      { path: mpFilePath(JOB, HASH_C, PHOTO_NAME_2), name: PHOTO_NAME_2, mime: "image/jpeg", size: 3333, hash: HASH_C,
        folder: "Captured photos", mp_last_modified: LM, file_type: "jpg",
        room: "Bedroom", floor: "Ground Floor", caption: "", symbol_instance_id: "sym-2" },
    ],
    statistics: STATS_METRIC_NORMALIZED,
    floors_svg: [],
  };
}
