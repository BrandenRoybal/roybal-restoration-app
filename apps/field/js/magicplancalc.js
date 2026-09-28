/* ============================================================
   Roybal Field Forms — Magicplan: the pure half
   ------------------------------------------------------------
   Everything the Magicplan lane decides WITHOUT a browser or a network:
   file ids and storage paths, photo-name parsing, metric→feet
   normalization, the "adopt a sync row into the bid file" merge, the
   Floor Plan measured rows and the Bid card's state words. Zero imports
   on purpose — Node tests load it directly (test/magicplan.test.mjs) and
   so does the edge function's parity test, which imports THIS file and
   asserts byte-identical output against the server's copy.

   SHARED HELPERS — change both copies. cleanSegment, mpFileId,
   mpFilePath, MP_SAFE_PATH, isMpSitePath, parsePhotoName, parseMpTime and
   normalizeStatistics are duplicated, logic for logic, in
   supabase/functions/magicplan-proxy/magicplan.ts. The server names a
   file `sitevisit/<job>/mp-<hash8>-<name>` when it copies it into
   field-media; the phone rebuilds the same id (mp-<hash8>) when it adopts
   the row, and that equality is what lets a re-pull REPLACE a file in the
   packet instead of duplicating it. A drift between the two copies shows
   up as duplicates on the second Pull — or as a path the office
   estimator refuses to sign (MP_SAFE_PATH mirrors its SAFE_PATH).

   LOCKSTEP — ensureSiteVisit's blank is the same literal as
   sitevisit.js newSiteVisit() and boardpush.js's bid-file seed; the test
   deep-equals them. ensureFloorPlan mirrors model.js newFloorPlan().

   Everything here is offered to the file, never applied silently: measured
   rooms land with conf 0.5 (amber, "✓ Use measured") whenever the table
   already had rows, and a re-adopt that changes an accepted number puts it
   back to amber (design §4.3, ruling R27).
   ============================================================ */

const arr = (v) => (Array.isArray(v) ? v : []);

/* ============================================================
   SHARED helpers — identical in magicplan-proxy/magicplan.ts
   ============================================================ */

/** siteFilePath's `clean` (sitevisit.js), byte for byte. */
export function cleanSegment(s, max) {
  return String(s ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-max);
}

/** The stable file id for one Magicplan object: the first 8 hex of its
    sha256. Same bytes → same id on every device and every re-pull. A bad
    hash is a bug, never a default (ruling R10). */
export function mpFileId(hash) {
  if (!/^[0-9a-f]{64}$/i.test(String(hash))) throw new Error("bad hash");
  return "mp-" + String(hash).toLowerCase().slice(0, 8);
}

/** `sitevisit/<job>/mp-<hash8>-<cleanname>` — siteFilePath's shape. The job
    segment maps "." to "_" because the estimator's SAFE_PATH job alphabet
    has no dot; for every real job id (bj-<uuid>, uid()) the result equals
    siteFilePath(job, mpFileId(hash), name) exactly — the test proves it. */
export function mpFilePath(job, hash, name) {
  const jobSeg = String(job ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").slice(-80) || "job";
  const base = cleanSegment(name, 80).replace(/^[._]+/, "") || "file";
  return `sitevisit/${jobSeg}/${mpFileId(hash)}-${base}`;
}

/** Textually identical to SAFE_PATH in roybal-ai-office/sitevisit.ts — the
    only paths the estimator will sign. Asserted by the test. */
export const MP_SAFE_PATH = /^sitevisit\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/;
export function isMpSitePath(p) {
  return typeof p === "string" && MP_SAFE_PATH.test(p) && !p.includes("..");
}

/** "1st Floor - Living Room - Window - 2.jpg" → floor / room / caption.
    Fewer than three " - " parts means we do not know the room — say so
    with "" rather than guess (design §4.3). */
export function parsePhotoName(name) {
  const base = String(name ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const parts = base.split(" - ").map((s) => s.trim());
  if (parts.length < 3) return { floor: "", room: "", caption: "" };
  if (/^\d+$/.test(parts[parts.length - 1])) parts.pop();
  return { floor: parts[0], room: parts[1], caption: parts.slice(2).join(" - ") };
}

/** Magicplan stamps come in two shapes: "2024-08-08T10:27:10.000000+00:00"
    (six fraction digits, which Date.parse rejects) and "2023-11-09 08:40:02"
    (no zone — the API's clock is UTC). */
export function parseMpTime(s) {
  let t = String(s ?? "").trim();
  if (!t) return null;
  t = t.replace(/(\.\d{3})\d+/, "$1");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) t = t.replace(" ", "T") + "Z";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** The UNWRAPPED GET /plans/statistics/{id} body → the quantities block the
    Floor Plan form and the M3 estimate read. Metric converts and rounds to
    1 ft² / 0.5 ft / 1 ft³ (design §4.3); anything that is not "metric" is
    imperial and passes through unrounded. Rooms come from rooms[], never
    from room_count. */
export function normalizeStatistics(raw) {
  if (!raw || typeof raw.statistics !== "object" || raw.statistics === null) {
    throw new Error("Unexpected Magicplan statistics shape");
  }
  const units = String(raw.units ?? "").toLowerCase() === "metric" ? "metric" : "imperial";
  const metric = units === "metric";
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const area = (v) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 10.764) : n; };
  const len = (v) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 3.281 * 2) / 2 : n; };
  const vol = (v) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 35.315) : n; };
  const count = (v) => Number(v) | 0;
  const floorsRaw = Array.isArray(raw.statistics.floors) ? raw.statistics.floors : [];
  const floors = floorsRaw.map((f) => {
    const roomsRaw = Array.isArray(f.rooms) ? f.rooms : [];
    return {
      name: String(f.name ?? "").trim(),
      rooms: roomsRaw.map((room) => ({
        name: String(room.name ?? "").trim(),
        floorSF: area(room.area_without_walls),
        perimLF: len(room.ground_perimeter),
        ceilingFt: len(room.height),
        wallSF: area(room.walls_surface),
        wallSFNet: area(room.walls_surface_without_openings),
        doors: count(room.door_count),
        windows: count(room.window_count),
        volumeCF: vol(room.volume),
        dims: String(room.dimensions ?? ""),
      })),
    };
  });
  return { units, floors };
}

/* ============================================================
   FIELD-ONLY — the packet, the rooms, the Floor Plan, the Bid card
   ============================================================ */

export const MP_KIND_REPORT = "report";
export const MP_KIND_PHOTO = "photos";

/** Room labels, parallel to floors[i].rooms[j]. A name that appears on two
    or more DIFFERENT floors is prefixed with its floor ("Basement — Bedroom")
    on every occurrence; within one floor the 2nd, 3rd… identical label gets
    " (2)", " (3)" — every label stays unique so "replace by name" in the
    Floor Plan table can never eat a measured row (ruling R13). Empty names
    stay "" in position; adoptExport drops them. */
export function dedupeRoomNames(floors) {
  const fl = arr(floors);
  const floorsWith = new Map();   // trimmed room name → Set(floor index)
  fl.forEach((f, i) => arr(f && f.rooms).forEach((r) => {
    const n = String((r && r.name) ?? "").trim();
    if (!n) return;
    if (!floorsWith.has(n)) floorsWith.set(n, new Set());
    floorsWith.get(n).add(i);
  }));
  return fl.map((f) => {
    const seen = new Map();       // label → occurrences so far on this floor
    return arr(f && f.rooms).map((r) => {
      const n = String((r && r.name) ?? "").trim();
      if (!n) return "";
      let label = floorsWith.get(n).size >= 2 ? `${String((f && f.name) ?? "").trim()} — ${n}` : n;
      const k = (seen.get(label) || 0) + 1;
      seen.set(label, k);
      if (k > 1) label += ` (${k})`;
      return label;
    });
  });
}

/** "123 Test Ave, Fairbanks, AK 99701" → the API's address block. The state
    is never sent (the API address has no state field); the zip is read off
    the whole string so "Fairbanks AK 99701" without a comma still yields it. */
export function splitAddress(s) {
  const raw = String(s ?? "");
  const parts = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const zip = (raw.match(/\b\d{5}(?:-\d{4})?\b/) || [""])[0];
  if (parts.length === 0) return { street: "", city: "", postal_code: zip, country: "US" };
  if (parts.length === 1) {
    const street = parts[0].replace(/[\s,]+(?:AK|Alaska)?\s*\d{5}(?:-\d{4})?\s*$/i, "").trim();
    return { street, city: "", postal_code: zip, country: "US" };
  }
  const street = parts[0];
  const city = parts[1].replace(/\b\d{5}(?:-\d{4})?\b/, "").replace(/\b(?:AK|Alaska)\b\.?/i, "").replace(/\s+/g, " ").trim();
  return { street, city, postal_code: zip, country: "US" };
}

/** "1 report, 14 photos, 6 rooms measured" — the one sentence every surface
    (toast, banner, Bid card, admin table) says about a sync row. */
export function exportSummary(row) {
  const r = row || {};
  const reports = arr(r.files).length;
  const photos = arr(r.photos).length;
  const rooms = arr(r.statistics && r.statistics.floors).reduce((t, f) => t + arr(f && f.rooms).length, 0);
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  return { reports, photos, rooms, text: `${n(reports, "report")}, ${n(photos, "photo")}, ${rooms} room${rooms === 1 ? "" : "s"} measured` };
}

/** The packet object, created when missing. The blank is the SAME literal
    as sitevisit.js newSiteVisit() and boardpush.js's bid-file seed — the
    lockstep test deep-equals them. Heals files[] to an array. */
export function ensureSiteVisit(project) {
  if (!project.siteVisit || typeof project.siteVisit !== "object") {
    project.siteVisit = { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
  }
  const sv = project.siteVisit;
  if (!Array.isArray(sv.files)) sv.files = [];
  return sv;
}

/** The Floor Plan form object, created when missing (model.js newFloorPlan
    shape; mode stays "upload" so the packet renders uploaded pages). */
export function ensureFloorPlan(project, now) {
  if (!project.floorPlan || typeof project.floorPlan !== "object") {
    project.floorPlan = { createdAt: now, mode: "upload", uploadedPages: [] };
  }
  return project.floorPlan;
}

/** A sync row's files[] and photos[] as siteVisit.files entries — exactly
    the packet's shape, nothing extra: `{ id, kind, name, path, mime, size,
    room, caption, source, at }`. packetForDraft() reads them unchanged. */
export function filesFromExport(row, now) {
  const r = row || {};
  const at = r.synced_at || now;
  const entry = (f, kind) => ({
    id: mpFileId(f.hash), kind,
    name: String(f.name ?? ""), path: String(f.path ?? ""), mime: String(f.mime ?? ""), size: Number(f.size) || 0,
    room: kind === MP_KIND_PHOTO ? String(f.room ?? "") : "",
    caption: kind === MP_KIND_PHOTO ? String(f.caption ?? "") : "",
    source: "magicplan", at,
  });
  return [...arr(r.files).map((f) => entry(f, MP_KIND_REPORT)), ...arr(r.photos).map((f) => entry(f, MP_KIND_PHOTO))];
}

/** One Floor Plan row per measured room. String numerics and NO id, like
    the hand-typed rows (merge.js unions rows only when every element has an
    id — keep it so). conf is the caller's: 1 when the table was empty,
    0.5 (amber) otherwise. */
export function measuredRows(stats, { syncedAt, conf } = {}) {
  const s = stats || {};
  const floors = arr(s.floors);
  const labels = dedupeRoomNames(floors);
  const unit = s.units === "metric" ? "metric" : "imperial";
  const str = (v) => (v == null ? "" : String(v));
  const rows = [];
  floors.forEach((f, i) => arr(f && f.rooms).forEach((r, j) => {
    const name = (labels[i] || [])[j] || "";
    if (!name) return;
    rows.push({
      name, dims: String((r && r.dims) ?? ""),
      floorSF: str(r && r.floorSF), perimLF: str(r && r.perimLF), ceiling: str(r && r.ceilingFt),
      notes: "", conf, source: "magicplan", unit, mpAt: syncedAt,
    });
  }));
  return rows;
}

/** Merge measured rows into the table. Pure: a NEW array; rows without
    source:"magicplan" (typed by a person, or AI-read from the plan) are
    carried through untouched and never removed. A measured row replaces the
    magicplan row of the same name; when floorSF/perimLF/ceiling all match
    only dims/unit/mpAt refresh (no count); when any differs the numbers are
    replaced (updated++) and an accepted row (conf ≥ 0.7) drops back to 0.5
    (reconfirmed++) — a changed measurement is a new offer (ruling R27). */
export function mergeFloorPlanRows(existing, measured) {
  const rows = arr(existing).slice();
  let added = 0, updated = 0, reconfirmed = 0;
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  for (const m of arr(measured)) {
    const i = rows.findIndex((e) => e && e.source === "magicplan" && e.name === m.name);
    if (i < 0) { rows.push(m); added++; continue; }
    const e = rows[i];
    if (same(e.floorSF, m.floorSF) && same(e.perimLF, m.perimLF) && same(e.ceiling, m.ceiling)) {
      rows[i] = { ...e, dims: m.dims, unit: m.unit, mpAt: m.mpAt };
      continue;
    }
    const next = { ...e, dims: m.dims, floorSF: m.floorSF, perimLF: m.perimLF, ceiling: m.ceiling, unit: m.unit, mpAt: m.mpAt };
    updated++;
    if (Number(e.conf) >= 0.7) { next.conf = 0.5; reconfirmed++; }
    rows[i] = next;
  }
  return { rows, added, updated, reconfirmed };
}

/** Adopt one sync row into the bid file (mutates project). Idempotent by
    mp-<hash8> id: a second adopt of the same row adds nothing and replaces
    nothing. Never touches transcript, typedScope, pending, files the person
    added, or Floor Plan rows a person typed. */
export function adoptExport(project, row, { now, by } = {}) {
  const sv = ensureSiteVisit(project);
  const stats = (row && row.statistics) || { units: "imperial", floors: [] };
  const prev = sv.magicplan && typeof sv.magicplan === "object" ? sv.magicplan : null;
  sv.magicplan = {
    ...(prev || { projectId: row.mp_project_id, planId: row.mp_plan_id, cloudUrl: "", createdAt: now, by }),
    syncedAt: row.synced_at || now, exportId: row.id, units: stats.units, statistics: stats,
    removed: Array.isArray(prev && prev.removed) ? prev.removed : [],
  };

  // files: replace in place by id; compare without `at` (the adopt stamp)
  let added = 0, replaced = 0, unchanged = 0, skipped = 0;
  const strip = (f) => { const { at, ...rest } = f; void at; return JSON.stringify(rest); };
  for (const f of filesFromExport(row, now)) {
    if (sv.magicplan.removed.includes(f.id)) { skipped++; continue; }
    const i = sv.files.findIndex((x) => x && x.id === f.id);
    if (i < 0) { sv.files.push(f); added++; continue; }
    if (strip(sv.files[i]) === strip(f)) { unchanged++; continue; }
    sv.files[i] = { ...f, at: sv.files[i].at || f.at };
    replaced++;
  }

  // rooms: only seed an empty list — a person's room list is theirs
  const labels = [...new Set(dedupeRoomNames(stats.floors).flat().filter(Boolean))];
  let roomsAdded = 0;
  if (!Array.isArray(project.rooms) || !project.rooms.length) { project.rooms = labels; roomsAdded = labels.length; }

  // floor plan: accepted (conf 1) only when the table was empty
  const fp = ensureFloorPlan(project, now);
  const wasEmpty = !(fp.dimensions && Array.isArray(fp.dimensions.rooms) && fp.dimensions.rooms.length);
  const r = mergeFloorPlanRows(wasEmpty ? [] : fp.dimensions.rooms,
    measuredRows(stats, { syncedAt: sv.magicplan.syncedAt, conf: wasEmpty ? 1 : 0.5 }));
  fp.dimensions = {
    ...(fp.dimensions || {}), rooms: r.rows,
    notes: Array.isArray(fp.dimensions && fp.dimensions.notes) ? fp.dimensions.notes : [],
    at: (fp.dimensions && fp.dimensions.at) || now,
  };

  return {
    added, replaced, unchanged, skipped, roomsAdded,
    floorRows: { added: r.added, updated: r.updated, reconfirmed: r.reconfirmed },
    summary: exportSummary(row),
  };
}

/** "Nothing new from Magicplan" — the adopt changed nothing anyone can see. */
export function nothingNew(r) {
  return r.added === 0 && r.replaced === 0 && r.roomsAdded === 0 && r.floorRows.added === 0 && r.floorRows.updated === 0;
}

/** Remember a ✕'d Magicplan file so a re-pull does not resurrect it. Last 500. */
export function noteRemoved(sv, id) {
  sv.magicplan = (sv.magicplan && typeof sv.magicplan === "object") ? sv.magicplan : {};
  const removed = Array.isArray(sv.magicplan.removed) ? sv.magicplan.removed : [];
  if (!removed.includes(id)) removed.push(id);
  sv.magicplan.removed = removed.slice(-500);
}

/** Rows worth offering: ready, not yet imported, and not the one this file
    already adopted (a failed markImported must not re-offer it forever —
    ruling R8). Newest sync first, nulls last. */
export function pendingRows(rows, project) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  const cur = mp ? mp.exportId : undefined;
  return arr(rows)
    .filter((r) => r && r.status === "ready" && r.imported_at == null && r.id !== cur)
    .sort((a, b) => {
      const ta = parseMpTime(a.synced_at), tb = parseMpTime(b.synced_at);
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return tb - ta;
    });
}

/** The per-device auto-adopt switch: an explicit "1"/"0" wins; unset follows
    "is this the owner's device". */
export function autoAdoptEnabled(stored, isOwner) {
  return stored === "1" ? true : stored === "0" ? false : !!isOwner;
}

/** Has the plan been edited in Magicplan since the last adopt? */
export function hasPendingUpdate(mp, status) {
  const a = parseMpTime(status && status.userModified);
  const b = parseMpTime(mp && mp.syncedAt);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/** The Bid card's one word about the scan lane — first match wins. */
export function bidMagicplanState(project, { status, pending } = {}) {
  const mp = project && project.siteVisit && project.siteVisit.magicplan;
  if (!mp || !mp.projectId) return "not created";
  if (pending) return "scan received";
  if (mp.syncedAt && hasPendingUpdate(mp, status)) return "updated since import";
  if (mp.syncedAt) return "imported";
  return "ready on phone";
}

/** "9/26 2:41 PM" in local time; "" when the stamp does not parse. */
export function fmtMpStamp(iso) {
  const ms = parseMpTime(iso);
  if (ms == null) return "";
  const d = new Date(ms);
  const H = d.getHours();
  return `${d.getMonth() + 1}/${d.getDate()} ${((H + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")} ${H < 12 ? "AM" : "PM"}`;
}

/** The Bid card line's text for each state (design §5's shapes). */
export function bidMagicplanText(project, { status, pending } = {}) {
  const state = bidMagicplanState(project, { status, pending });
  const sv = (project && project.siteVisit) || {};
  const mp = sv.magicplan || {};
  let text;
  if (state === "not created") text = "not created";
  else if (state === "ready on phone") text = "ready on phone · created " + fmtMpStamp(mp.createdAt);
  else if (state === "scan received") text = "scan received · " + exportSummary(pending).text;
  else if (state === "imported") {
    const photos = arr(sv.files).filter((f) => f && f.source === "magicplan" && f.kind === MP_KIND_PHOTO).length;
    const fp = project.floorPlan || {};
    const rooms = arr(fp.dimensions && fp.dimensions.rooms).filter((r) => r && r.source === "magicplan").length;
    text = "imported · synced " + fmtMpStamp(mp.syncedAt) + ` · ${photos} photo${photos === 1 ? "" : "s"} · ${rooms} room${rooms === 1 ? "" : "s"}`;
  } else text = "updated since import · synced " + fmtMpStamp(mp.syncedAt);
  return text + (status && status.archivedAt ? " · archived" : "");
}

/* ---------- PostgREST paths (the RLS-gated reads the browser makes) ---------- */
export function pendingQuery(projectId) {
  return `magicplan_exports?select=id,mp_project_id,mp_plan_id,field_project_id,status,files,photos,statistics,floors_svg,error,synced_at,received_at,imported_at&field_project_id=eq.${encodeURIComponent(projectId)}&status=eq.ready&imported_at=is.null&order=synced_at.desc.nullslast&limit=10`;
}
export function recentExportsQuery(limit = 10) {
  return `magicplan_exports?select=id,mp_project_id,mp_plan_id,field_project_id,status,files,photos,statistics,error,received_at,synced_at,imported_at,imported_by&order=received_at.desc&limit=${limit}`;
}
