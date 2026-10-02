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
export function measuredRow(room, units, conf, projectId = "") {
  return {
    name: room.label || room.name, dims: room.dims || "",
    floorSF: cell(room.floorSF), perimLF: cell(room.perimLF),
    ceiling: num(room.ceilingFt) > 0 ? `${room.ceilingFt} ft` : "",
    notes: "", conf, source: "magicplan", unit: units === "metric" ? "m → ft" : "ft",
    volumeCF: num(room.volumeCF) > 0 ? Math.round(num(room.volumeCF)) : 0,   // M3: measured room volume, offered to the dehu sizing
    ...(projectId ? { mpProjectId: String(projectId) } : {}),   // 10/2: which scan measured it (a relink prunes the old one's)
  };
}
export function mergeMeasuredRooms(rows, stats, projectId = "") {
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
    const next = measuredRow(rm, units, conf, projectId);
    const i = out.findIndex((r) => r && r.source === "magicplan" && String(r.name || "").toLowerCase() === next.name.toLowerCase());
    if (i < 0) { out.push(next); added++; continue; }
    const prev = out[i];
    const same = ["dims", "floorSF", "perimLF", "ceiling", "unit", "volumeCF"].every((k) => String(prev[k] || "") === String(next[k] || ""));
    if (same) { if (projectId && prev.mpProjectId !== String(projectId)) out[i] = { ...prev, mpProjectId: String(projectId) }; continue; }
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
  // a job the office linked by hand takes scans of THAT project only: a ready
  // row left over from the project it was switched away from never mixes in
  if (linkedByHand(mp) && row && row.mp_project_id && row.mp_project_id !== mp.projectId)
    return { reports: 0, photos: 0, others: 0, rooms: 0, dimsAdded: 0, dimsUpdated: 0, accepted: false, skipped: true };
  const removed = new Set(arr(mp.removed));
  const put = (f) => {
    if (removed.has(f.id)) return false;
    const i = sv.files.findIndex((x) => x && x.id === f.id);
    if (i >= 0) sv.files[i] = { ...sv.files[i], ...f };
    else sv.files.push(f);
    return true;
  };
  let reports = 0, photos = 0, others = 0;
  for (const f of arr(row && row.files)) {
    if (!f || !f.path || !f.hash) continue;
    if (isMpReport(f)) {
      if (put({ id: mpFileId(f.hash), kind: "report", name: f.name || "Magicplan report.pdf", path: f.path,
        mime: f.mime || "application/pdf", size: num(f.size), room: "", caption: "", source: "magicplan", at })) reports++;
    } else if (put({ id: mpFileId(f.hash), kind: "mpfiles", mpKind: f.kind || "data", name: f.name || "Magicplan file", path: f.path,
      mime: f.mime || "application/octet-stream", size: num(f.size), room: f.room || "", caption: f.folder || "", source: "magicplan", at })) others++;
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
    const pid = mp.projectId || (row && row.mp_project_id) || "";
    // rows another scan measured (a merge from a phone that missed a relink
    // can bring them back) go before this scan's rows are merged in
    const cur = Array.isArray(fp.dimensions.rooms) ? fp.dimensions.rooms : (fp.dimensions.rooms = []);
    if (pid) spliceOut(cur, (r) => r && r.source === "magicplan" && r.mpProjectId && r.mpProjectId !== pid);
    const m = mergeMeasuredRooms(cur, stats, pid);
    cur.splice(0, cur.length, ...m.rows);   // in place: the open Floor Plan table is bound to this array
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
  return { reports, photos, others, rooms: labels.length, dimsAdded: dims.added, dimsUpdated: dims.updated, accepted: dims.accepted };
}

/* A row's files: only a PDF is a report the estimate draft reads. Everything
   else a pull brings back (3D model, drawings, videos, each room's plan, the
   raw data) is kept as kind "mpfiles": listed and openable in the Site Visit
   panel, never sent to the draft. Rows from before 10/1 carry no kind; their
   files were all PDFs. */
export function isMpReport(f) {
  return f && (f.kind ? f.kind === "report" : /pdf/i.test(String(f.mime || "")) || /\.pdf$/i.test(String(f.name || "")));
}
const MP_KIND_LABEL = { model3d: "3D", drawing: "drawing", video: "video", room: "room plan", data: "data", photo: "image", report: "report" };
export const mpKindLabel = (k) => MP_KIND_LABEL[k] || "file";

/** "1 report, 14 photos, 6 rooms measured" — the banner's summary of a row. */
export function exportSummary(row) {
  const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
  const rooms = row && row.statistics ? dedupeRoomNames(row.statistics.floors).length : 0;
  const files = arr(row && row.files).filter((f) => f);
  const reports = files.filter(isMpReport).length, others = files.length - reports;
  return [n(reports, "report", "reports"), n(arr(row && row.photos).length, "photo", "photos"),
    n(rooms, "room measured", "rooms measured"), ...(others ? [n(others, "other file", "other files")] : [])].join(", ");
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

/* ============================================================
   M3 — measured quantities in the draft (design §5, brief §5)
   ============================================================ */

/** Measured rooms as the estimator reads them — the packet's optional
    magicplanQuantities block. Built from the normalized statistics already
    on the blob (feet after adoptExport), so units is always "imperial" here;
    sourceUnits remembers what the scan was in. null when nothing measured. */
export function magicplanQuantities(sv) {
  const mp = sv && sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : null;
  const stats = mp && mp.statistics && typeof mp.statistics === "object" ? mp.statistics : null;
  if (!stats) return null;
  const rooms = dedupeRoomNames(stats.floors).map((r) => ({
    name: r.label || r.name,
    floorSF: num(r.floorSF), perimLF: num(r.perimLF), ceilingFt: num(r.ceilingFt),
    wallSF: num(r.wallSF), wallSFNet: num(r.wallSFNet),
    doors: num(r.doors), windows: num(r.windows), volumeCF: num(r.volumeCF),
  })).filter((r) => r.name && (r.floorSF > 0 || r.perimLF > 0 || r.wallSF > 0 || r.volumeCF > 0));
  if (!rooms.length) return null;
  return { scannedAt: String(mp.syncedAt || mp.importedAt || ""), units: "imperial", sourceUnits: stats.units === "metric" ? "metric" : "imperial", rooms };
}

/** "Sep 26, 2026" from an ISO stamp; the raw string when it isn't one. */
const scanDate = (iso) => {
  const s = String(iso || "");
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
/** The Pricing Basis sentence the estimate carries when the draft had measured quantities. */
export function magicplanBasisSentence(scannedAt) {
  const when = scanDate(scannedAt);
  return `Quantities from Magicplan LiDAR scan${when ? " dated " + when : ""}; wall areas net of openings.`;
}
/** Append that sentence to a draft's pricingNotes once (idempotent: a re-run
    of the draft or a re-apply never doubles it). */
export function withMagicplanBasis(pricingNotes, scannedAt) {
  const notes = String(pricingNotes || "").trim();
  if (/Quantities from Magicplan LiDAR scan/i.test(notes)) return notes;
  const sentence = magicplanBasisSentence(scannedAt);
  return notes ? notes + " " + sentence : sentence;
}

/* ---------- ESX sketch → Supporting Docs (claim jobs only) ----------
   The proxy's esxExport action returns {path, name, size, mime, hash} for
   the ExportConfig.XactimateEsx file the workspace's export configuration
   produced, or nothing when the configuration doesn't include one. Same
   hash → same entry, replaced in place; the sheet offers it as a download. */
export const ESX_DOC_TITLE = "Magicplan ESX sketch (Xactimate)";
export const ESX_DOC_ID = "mp-esx";   // one sketch per job: a new export replaces the file on this one entry
/* The job's Magicplan sketch, whatever id it was given: "mp-esx" (M3),
   "mp-esx-<hash8>" (v188) or "mp-esx-<hash8>-<t>" (10/2). A relink tombstones
   the old one's id so a merge can't bring it back; ids are never reused, so
   a new sketch is never caught by that tombstone. */
export const isMpEsx = (d) => !!d && (d.id === ESX_DOC_ID || String(d.id || "").startsWith(ESX_DOC_ID + "-") || (d.source === "magicplan" && d.mode === "file"));
export function adoptEsx(project, esx, at = new Date().toISOString()) {
  if (!project || !esx || !esx.path || !esx.hash) return { added: 0, updated: 0 };
  if (!Array.isArray(project.supportDocs)) project.supportDocs = [];
  const file = { path: esx.path, name: esx.name || "sketch.esx", size: num(esx.size), mime: esx.mime || "application/octet-stream", hash: String(esx.hash) };
  const i = project.supportDocs.findIndex(isMpEsx);
  if (i >= 0) {
    const prev = project.supportDocs[i];
    if (String((prev.file || {}).hash || "") === file.hash) return { added: 0, updated: 0 };
    project.supportDocs[i] = { ...prev, file, updatedAt: at };
    return { added: 0, updated: 1 };
  }
  project.supportDocs.push({
    id: `${ESX_DOC_ID}-${String(file.hash).slice(0, 8)}-${(Date.parse(at) || 0).toString(36)}`, by: "", createdAt: at, title: ESX_DOC_TITLE, docType: "Other", mode: "file",
    uploadedPages: [], aiDigest: "", source: "magicplan", file,
  });
  return { added: 1, updated: 0 };
}

/* ============================================================
   The Floor plan chip (10/2): link a project scanned before the job existed
   ============================================================ */

/** What the job holds from Magicplan today: packet files, measured Floor
    Plan rows, the ESX sketch. The 🔗 Link confirm names these before a
    switch takes them out. */
export function magicplanOnJob(project) {
  const sv = project && project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : {};
  const fp = project && project.floorPlan && project.floorPlan.dimensions ? project.floorPlan.dimensions : {};
  return {
    files: arr(sv.files).filter((f) => f && f.source === "magicplan").length,
    rooms: arr(fp.rooms).filter((r) => r && r.source === "magicplan").length,
    esx: arr(project && project.supportDocs).filter(isMpEsx).length,
  };
}

/** Link this job to the Magicplan project the office picked (the proxy's
    linkProject answer: {projectId, planId, cloudUrl, createdAt, name}).
    `linked` holds the project id that was picked by hand, so Pull trusts
    exactly that project and nothing a later create puts in its place.
    Switching from another project takes the old one's imports out (files
    from the packet, measured rows from the Floor Plan table, its ESX
    sketch) so two scans never mix in one estimate; the storage copies stay
    and rows anyone typed are never touched. The same project again keeps
    its import stamps. Mutates; returns { switching, dropped }. */
export function linkMagicplan(project, picked, { by = "", at = new Date().toISOString(), tombstone = null } = {}) {
  const p = project;
  if (!p.siteVisit || typeof p.siteVisit !== "object") p.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
  const sv = p.siteVisit;
  if (!Array.isArray(sv.files)) sv.files = [];
  const prev = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : null;
  const switching = !!(prev && prev.projectId && prev.projectId !== picked.projectId);
  const dropped = { files: 0, rooms: 0, esx: 0 };
  if (switching) {
    const had = magicplanOnJob(p);
    // in place: an open form stays bound to the job's own arrays
    spliceOut(sv.files, (f) => f && f.source === "magicplan");
    const dims = p.floorPlan && p.floorPlan.dimensions;
    if (dims && Array.isArray(dims.rooms)) spliceOut(dims.rooms, (r) => r && r.source === "magicplan");
    if (Array.isArray(p.supportDocs)) {
      const gone = spliceOut(p.supportDocs, isMpEsx);
      // Supporting Docs union across devices by id: the delete needs a mark
      // (merge.js tombstoneItems, passed in so this module keeps no imports)
      if (gone.length && tombstone) tombstone(p, gone.map((d) => d.id).filter(Boolean));
    }
    Object.assign(dropped, had);
  }
  const keep = switching || !prev ? {} : prev;
  sv.magicplan = {
    ...keep,
    projectId: String(picked.projectId || ""), planId: String(picked.planId || keep.planId || ""),
    cloudUrl: String(picked.cloudUrl || keep.cloudUrl || ""), createdAt: String(picked.createdAt || keep.createdAt || at),
    name: String(picked.name || ""), by: keep.by || by, units: keep.units || null,
    linked: String(picked.projectId || ""), linkedAt: at, linkedBy: by,
  };
  return { switching, dropped };
}

/* remove every element that matches, in place; returns what was removed */
function spliceOut(list, test) {
  const gone = [];
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) gone.unshift(...list.splice(i, 1));
  return gone;
}

/** Did the office pick this project by hand? Then Pull sends `linked` and
    the server skips its external_reference_id check for it. */
export const linkedByHand = (mp) => !!(mp && mp.projectId && mp.linked === mp.projectId);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso) => {   // the phone's own day: an evening pull in Alaska is still that day
  const d = new Date(String(iso || ""));
  return isNaN(d) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

/** The Floor plan tile's line on the job page, from what the job holds
    (offline). "" when the job has no Magicplan project: the tile keeps its
    own blurb. */
export function mpTileLine(project) {
  const sv = project && project.siteVisit && typeof project.siteVisit === "object" ? project.siteVisit : {};
  const mp = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : null;
  if (!mp || !mp.projectId) return "";
  if (!mp.importedAt) return "📐 Magicplan linked — scan, export, then ⟳ Pull in here";
  const rooms = dedupeRoomNames(mp.statistics && mp.statistics.floors).length;
  const mine = arr(sv.files).filter((f) => f && f.source === "magicplan");
  const photos = mine.filter((f) => f.kind === "photos").length, files = mine.length - photos;
  const n = (x, one) => (x ? `${x} ${one}${x === 1 ? "" : "s"}` : "");
  return ["📐 Magicplan pulled " + shortDay(mp.importedAt || mp.syncedAt), n(rooms, "room"), n(files, "file"), n(photos, "photo")].filter(Boolean).join(" · ");
}

/** The 🔗 Link picker's filter: every word of the search in the name or the
    address, any order, any case — the proxy's matchesQuery, held to the
    same answers by its lockstep test. */
export function mpMatches(item, q) {
  const hay = `${(item && item.name) || ""} ${(item && item.address) || ""}`.toLowerCase();
  return String(q || "").toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
