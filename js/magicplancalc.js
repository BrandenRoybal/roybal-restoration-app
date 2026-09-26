/* ============================================================
   Roybal Field Forms — Magicplan, the pure half
   ------------------------------------------------------------
   No imports, no DOM, no network: everything here is Node-tested
   (test/magicplan.test.mjs) and the server's copy in
   supabase/functions/magicplan-proxy/magicplan.ts is held to the same
   outputs by a lockstep test there (magicplan.test.mjs).

   docs/Magicplan_Integration_Design.md §4 is the spec:
     - parsePhotoName   "<Floor> - <Room> - <Object> - <n>.jpg" → floor/room/caption
     - normalizeStatistics  GET /plans/statistics/{id} → feet, rounded (§4.3)
     - dedupeRoomNames  floor prefix only when a name repeats across floors
     - mpFilePath       the client's own site-visit path shape (§6 ruling 11)
     - mergeMeasuredRooms / adoptExport  the field app's side of the import:
       the server never writes the blob (decision 4), this does
   ============================================================ */

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ---------- paths ----------
   Byte-for-byte the cleaning rules of sitevisit.js siteFilePath(), with the
   file id "mp-<hash8>". A test asserts the two agree and that the result
   passes the server's isSitePath(). */
const clean = (s, max) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-max);
export function mpFileId(hash) {
  return "mp-" + String(hash || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
}
export function mpFilePath(projectId, hash, name) {
  const job = clean(projectId, 80) || "job";
  const base = clean(name, 80).replace(/^[._]+/, "") || "file";
  return `sitevisit/${job}/${clean(mpFileId(hash), 60)}-${base}`;
}

/* ---------- photo names ----------
   Magicplan names every pinned photo "<Floor> - <Room> - <Object> - <n>.jpg".
   Anything that doesn't split that way stays uncaptioned with room "" — a
   wrong room on a photo is worse than none (§9: never guess). */
export function parsePhotoName(name) {
  const none = { floor: "", room: "", caption: "" };
  const stem = String(name || "").replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const parts = stem.split(" - ").map((s) => s.trim());
  if (parts.length < 4 || !/^\d+$/.test(parts[parts.length - 1])) return none;
  const [floor, room, ...rest] = parts;
  const caption = rest.slice(0, -1).join(" - ");
  if (!floor || !room || !caption) return none;
  return { floor, room, caption };
}

/* ---------- units (§4.3) ----------
   The statistics response says units: "metric" or not. Metric converts once,
   here; imperial passes through. Everything is rounded the same way either
   way so the table never shows 214.36999. */
const M2_FT2 = 10.764, M_FT = 3.281, M3_FT3 = 35.315;
const r1 = (v) => Math.round(v);
const rHalf = (v) => Math.round(v * 2) / 2;

/** GET /plans/statistics/{planId} (the live, unwrapped shape:
    {id, project_id, units, statistics:{floors:[{name, height, rooms:[…]}]}})
    → {units, floors:[{name, rooms:[{name, floorSF, perimLF, ceilingFt, wallSF,
    wallSFNet, doors, windows, volumeCF, dims}]}]}. Rooms come from rooms[],
    never from room_count (a bathroom is listed but not counted). */
export function normalizeStatistics(resp) {
  const r = resp && typeof resp === "object" ? resp : {};
  const metric = String(r.units || "").toLowerCase() === "metric";
  const area = (v) => r1(num(v) * (metric ? M2_FT2 : 1));
  const len = (v) => rHalf(num(v) * (metric ? M_FT : 1));
  const vol = (v) => r1(num(v) * (metric ? M3_FT3 : 1));
  const floors = arr(r.statistics && r.statistics.floors).map((f, fi) => ({
    name: String((f && f.name) || "").trim() || `Floor ${fi + 1}`,
    rooms: arr(f && f.rooms).map((rm, ri) => {
      const height = num(rm && rm.height) || num(f && f.height);
      return {
        name: String((rm && rm.name) || "").trim() || `Room ${ri + 1}`,
        floorSF: area(rm && rm.area_without_walls),
        perimLF: len(rm && rm.ground_perimeter),
        ceilingFt: len(height),
        wallSF: area(rm && rm.walls_surface),
        wallSFNet: area(rm && rm.walls_surface_without_openings),
        doors: num(rm && rm.door_count),
        windows: num(rm && rm.window_count),
        volumeCF: vol(rm && rm.volume),
        dims: String((rm && rm.dimensions) || ""),
      };
    }),
  }));
  return { units: metric ? "metric" : "imperial", floors };
}

/* ---------- room names ----------
   One flat list, in scan order, each with the label the app will use: the
   bare name, a floor prefix only when the same name appears on two floors
   ("Basement — Bedroom"), and a number only when it repeats on one floor. */
export function dedupeRoomNames(floors) {
  const flat = [];
  for (const f of arr(floors)) for (const rm of arr(f && f.rooms)) flat.push({ floor: String(f.name || ""), room: rm });
  const floorsOf = new Map();
  for (const x of flat) {
    const k = x.room.name.toLowerCase();
    if (!floorsOf.has(k)) floorsOf.set(k, new Set());
    floorsOf.get(k).add(x.floor);
  }
  const seen = new Map();
  return flat.map((x) => {
    const k = x.room.name.toLowerCase();
    let label = floorsOf.get(k).size > 1 ? `${x.floor} — ${x.room.name}` : x.room.name;
    const n = (seen.get(label.toLowerCase()) || 0) + 1;
    seen.set(label.toLowerCase(), n);
    if (n > 1) label = `${label} ${n}`;
    return { ...x.room, floor: x.floor, label };
  });
}

/* ---------- address ----------
   The job file carries one line — "3850 Royal Rd, Fairbanks, AK 99701".
   Magicplan wants it split; a part that isn't there stays empty. */
export function splitAddress(line) {
  const parts = String(line || "").split(",").map((s) => s.trim()).filter(Boolean);
  const zip = (/\b(\d{5})(?:-\d{4})?\b/.exec(parts.slice(1).join(" ")) || [])[1] || "";
  // "Fairbanks" | "Fairbanks AK 99701" | "AK 99701" (no city) → the city, or ""
  const cityOf = (s) => String(s || "").replace(/(^|\s+)[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/, "").replace(/\s*\d{5}(-\d{4})?$/, "").trim();
  return { street: parts[0] || "", city: parts.length > 1 ? cityOf(parts[1]) : "", postal_code: zip, country: "US" };
}

/** "<Customer> — <street>", the name the project carries on the phone. */
export function projectName(customer, street) {
  return [String(customer || "").trim(), String(street || "").trim()].filter(Boolean).join(" — ") || "Site visit";
}

/* ---------- the Floor Plan table (§6 ruling 10) ----------
   Measured rows are amber (conf 0.5) with source "magicplan" and the unit
   they came from. The one exception: a table holding nothing but Magicplan's
   own rows is "empty", and takes them accepted (conf 1). A re-pull updates
   Magicplan's rows in place by name; a row whose numbers did not change
   keeps whatever the user decided. Rows anyone else wrote are never touched. */
export const MEASURED_CONF = 0.5;
const cell = (v) => (num(v) > 0 ? String(v) : "");
export function measuredRow(room, units, conf) {
  return {
    name: room.label || room.name, dims: room.dims || "",
    floorSF: cell(room.floorSF), perimLF: cell(room.perimLF),
    ceiling: num(room.ceilingFt) > 0 ? `${room.ceilingFt} ft` : "",
    notes: "", conf, source: "magicplan", unit: units === "metric" ? "m → ft" : "ft",
  };
}
export function mergeMeasuredRooms(rows, stats) {
  const list = arr(rows);
  const units = (stats && stats.units) || "imperial";
  const rooms = dedupeRoomNames(stats && stats.floors);
  const theirs = list.filter((r) => r && r.source !== "magicplan" &&
    (String(r.name || "").trim() || num(r.floorSF) > 0 || num(r.perimLF) > 0));
  const empty = theirs.length === 0;
  const conf = empty ? 1 : MEASURED_CONF;
  const out = [...list];
  let added = 0, updated = 0;
  for (const rm of rooms) {
    const next = measuredRow(rm, units, conf);
    const i = out.findIndex((r) => r && r.source === "magicplan" && String(r.name || "").toLowerCase() === next.name.toLowerCase());
    if (i < 0) { out.push(next); added++; continue; }
    const prev = out[i];
    const same = ["dims", "floorSF", "perimLF", "ceiling", "unit"].every((k) => String(prev[k] || "") === String(next[k] || ""));
    if (same) continue;
    out[i] = { ...prev, ...next, notes: prev.notes || "" };
    updated++;
  }
  return { rows: out, added, updated, accepted: empty };
}

/* ---------- adopt one magicplan_exports row into the blob ----------
   The field app's half of decision 4: files and photos into the packet
   (same hash → same id → replaced in place, never duplicated; a row the
   user ✕'d stays out), rooms into project.rooms only when that list is
   empty, measured rows into the Floor Plan table, and the link stamps.
   Mutates project; returns counts for the toast. */
export function adoptExport(project, row, at = new Date().toISOString()) {
  const p = project;
  if (!p.siteVisit || typeof p.siteVisit !== "object") p.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
  const sv = p.siteVisit;
  if (!Array.isArray(sv.files)) sv.files = [];
  const mp = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : {};
  const removed = new Set(arr(mp.removed));
  const put = (f) => {
    if (removed.has(f.id)) return false;
    const i = sv.files.findIndex((x) => x && x.id === f.id);
    if (i >= 0) sv.files[i] = { ...sv.files[i], ...f };
    else sv.files.push(f);
    return true;
  };
  let reports = 0, photos = 0;
  for (const f of arr(row && row.files)) {
    if (!f || !f.path || !f.hash) continue;
    if (put({ id: mpFileId(f.hash), kind: "report", name: f.name || "Magicplan report.pdf", path: f.path,
      mime: f.mime || "application/pdf", size: num(f.size), room: "", caption: "", source: "magicplan", at })) reports++;
  }
  for (const f of arr(row && row.photos)) {
    if (!f || !f.path || !f.hash) continue;
    if (put({ id: mpFileId(f.hash), kind: "photos", name: f.name || "photo.jpg", path: f.path,
      mime: f.mime || "image/jpeg", size: num(f.size), room: f.room || "", caption: f.caption || "", source: "magicplan", at })) photos++;
  }
  const stats = row && row.statistics && typeof row.statistics === "object" ? row.statistics : null;
  const labels = stats ? dedupeRoomNames(stats.floors).map((r) => r.label) : [];
  if (labels.length && !arr(p.rooms).length) p.rooms = labels;
  let dims = { added: 0, updated: 0, accepted: false };
  if (stats && labels.length) {
    if (!p.floorPlan || typeof p.floorPlan !== "object") p.floorPlan = { createdAt: at, mode: "upload", uploadedPages: [] };
    const fp = p.floorPlan;
    if (!fp.dimensions || typeof fp.dimensions !== "object") fp.dimensions = { rooms: [], notes: [] };
    const m = mergeMeasuredRooms(fp.dimensions.rooms, stats);
    fp.dimensions.rooms = m.rows;
    dims = m;
  }
  sv.magicplan = {
    ...mp,
    projectId: mp.projectId || (row && row.mp_project_id) || "",
    planId: (row && row.mp_plan_id) || mp.planId || "",
    syncedAt: (row && row.synced_at) || at,
    exportId: (row && row.id) || "",
    importedAt: at,
    units: stats ? stats.units : (mp.units || null),
    statistics: stats,
    floors: arr(row && row.floors_svg).map((f) => ({ floor: f.floor || "", path: f.path || "" })),
  };
  return { reports, photos, rooms: labels.length, dimsAdded: dims.added, dimsUpdated: dims.updated, accepted: dims.accepted };
}

/** "1 report, 14 photos, 6 rooms measured" — the banner's summary of a row. */
export function exportSummary(row) {
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const rooms = row && row.statistics ? dedupeRoomNames(row.statistics.floors).length : 0;
  return [n(arr(row && row.files).length, "report", "reports"), n(arr(row && row.photos).length, "photo", "photos"),
    n(rooms, "room measured", "rooms measured")].join(", ");
}

/* ---------- the Bid card line ----------
   not created · ready on phone · scan received · imported · updated since import */
export function mpState(project, { pending = null, userModified = "" } = {}) {
  const sv = project && project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : {};
  const mp = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : null;
  if (!mp || !mp.projectId) return pending ? { key: "received" } : { key: "none" };
  if (pending) return { key: "received" };
  if (mp.importedAt) {
    const newer = userModified && mp.syncedAt && Date.parse(userModified) > Date.parse(mp.syncedAt);
    return { key: newer ? "updated" : "imported" };
  }
  return { key: "ready" };
}
