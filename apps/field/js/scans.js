/* ============================================================
   Equipment scan in and out — pure module (no DOM, no network,
   no imports)
   ------------------------------------------------------------
   Every drying machine carries a QR label: the asset tag
   ("AM-014") printed as "RC:AM-014". Each read on site is an
   APPEND-ONLY event in the job blob, `project.equipmentScans`:

     { id, tag, act: place|remove|move|void, at (device clock, UTC
       ISO), room, type, model, logId, voids, how, by, tech, build,
       elsewhere? }

   It is an ID collection (merge.js), so two devices' scans union by
   id, and the server copies each one, once, into an insert-only
   audit table (migration 0022). An event is never edited: an undo
   is a new `void` event naming the one it cancels.

   The events are the record; the drying log's `equipment[]` rows
   are DERIVED from them (applyScans). One row per placement, marked
   `scanId`, written the same way on every device and in the worker,
   so every reader of the rows (sizing, narrative, billing check,
   packet, portal, brief, office) keeps working unchanged, and a row
   lost to a newer copy of the log (logs merge newer-wins, whole)
   comes back from the events on the next run.

   Shared by the field app, the office app and the worker's billing
   check, so it imports nothing. Times written into a row are
   Alaska wall time via Intl, never the device's zone: a phone in
   Anchorage and the worker on UTC derive byte-identical rows.
   ============================================================ */

/* Digits a prefixed tag is printed with: AM-014. (2 if the owner picks AM-14.) */
export const TAG_PAD = 3;
export const TAG_PREFIXES = { AM: "air_mover", DH: "dehumidifier", AF: "air_scrubber", HT: "heater" };
/* Type codes (the fleet table's check list) → the row's Type text. Every
   label classifies through dryingcalc.js equipClassOf; "Other" matches none. */
export const TYPE_LABELS = {
  air_mover: "Air mover", dehumidifier: "Dehumidifier", dehu_lgr: "LGR dehumidifier",
  dehu_desiccant: "Desiccant dehumidifier", air_scrubber: "Air scrubber", heater: "Heater", other: "Other",
};
const ACTS = ["place", "remove", "move", "void"];

/* ---------- small helpers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v));
const clean = (v) => str(v).replace(/\s+/g, " ").trim();
const roomKey = (r) => clean(r).toLowerCase();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const labelOf = (code) => (code && has(TYPE_LABELS, code) ? TYPE_LABELS[code] : "");
// ids compare by code unit, never localeCompare: the order must not depend on the device's locale
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------- tags ---------- */
// between prefix and digits: nothing, a hyphen, a space, "_" or "." — or the dash a phone keyboard swaps in
const PREFIXED_RE = /^([A-Z]{2})[\s._\u2010-\u2015\u2212-]*(\d{1,6})$/;
const KEYED_RE = /^([A-Z]{2})[\s._\u2010-\u2015\u2212-]*(\d+)$/;
const NUMERIC_RE = /^\d{1,6}$/;
const stripZeros = (d) => d.replace(/^0+(?=\d)/, "");

/** A tag out of anything a label or a person gives us — "RC:AM-014",
    "AM-014", "am 14", a link with #eq=AM-014 or ?eq=, or plain digits —
    uppercased, a prefixed tag's digits padded to TAG_PAD (never cut).
    null when nothing tag-like is there. */
export function parseTag(text) {
  let s = str(text).trim();
  if (!s) return null;
  const q = /[#?&]eq=([^&#\s]*)/i.exec(s);
  if (q) {
    try { s = decodeURIComponent(q[1].replace(/\+/g, " ")); } catch { s = q[1]; }
  }
  s = s.trim().replace(/^rc\s*:\s*/i, "").trim().toUpperCase();
  const m = PREFIXED_RE.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(TAG_PAD, "0")}`;
  return NUMERIC_RE.test(s) ? s : null;
}

/** The comparison key: "AM-14" for AM-14 / AM-014 / am 014, the digits
    without leading zeros for a numeric tag (007 → 7), otherwise the tag
    uppercased with its spaces collapsed. "" for nothing. Migration 0022's
    equipment_tag_key() is the same rule in SQL. */
export function tagKey(tag) {
  const s = clean(tag).toUpperCase();
  if (!s) return "";
  const m = KEYED_RE.exec(s);
  if (m) return `${m[1]}-${stripZeros(m[2])}`;
  return /^\d+$/.test(s) ? stripZeros(s) : s;
}

/** The type code a tag's prefix names (AM → air_mover), or null. */
export function typeFromTag(tag) {
  const m = /^([A-Z]{2})-\d+$/.exec(tagKey(tag));
  return m && has(TAG_PREFIXES, m[1]) ? TAG_PREFIXES[m[1]] : null;
}

/* ---------- time: Alaska wall clock, whatever zone the device is in ---------- */
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})$/i;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const HOUR = 3600000;

/* An event's `at` → epoch ms, NaN unless it is a full stamp WITH a zone: a
   zone-less stamp would be read in the device's own zone. */
function instant(v) {
  if (v instanceof Date) return v.getTime();
  const m = ISO_RE.exec(str(v).trim());
  if (!m) return NaN;
  const body = m[1].replace(/(\.\d{3})\d+$/, "$1");                 // older Safari reads at most 3 fraction digits
  const zone = /^z$/i.test(m[2]) ? "Z" : m[2].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  return Date.parse(body + zone);
}

/* Without zone data (a stripped-down engine), the US rule Alaska keeps:
   daylight time from 02:00 on the second Sunday in March to 02:00 on the
   first Sunday in November. */
function akOffsetHours(t) {
  const y = new Date(t).getUTCFullYear();
  const sunday = (month, from) => from + (7 - new Date(Date.UTC(y, month, from)).getUTCDay()) % 7;
  const start = Date.UTC(y, 2, sunday(2, 8), 11);    // 02:00 AKST
  const end = Date.UTC(y, 10, sunday(10, 1), 10);    // 02:00 AKDT
  return t >= start && t < end ? -8 : -9;
}

let AK = null;   // the Anchorage formatter, built on first use; false when this engine can't make one
function akWall(t) {
  if (AK === null) {
    try {
      AK = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Anchorage", hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      AK.formatToParts(0);
    } catch { AK = false; }
  }
  if (AK) {
    try {
      const p = {};
      for (const x of AK.formatToParts(new Date(t))) p[x.type] = x.value;
      const out = `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`;
      if (!p.dayPeriod && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(out)) return out;
    } catch { /* fall through to the fixed rule */ }
  }
  return new Date(t + akOffsetHours(t) * HOUR).toISOString().slice(0, 16);
}

/** A UTC stamp → "YYYY-MM-DDTHH:MM" on the Alaska wall clock (the drying
    log's datetime-local format). "" for anything that isn't a zoned stamp. */
export function wallTime(iso) {
  const t = instant(iso);
  return Number.isFinite(t) ? akWall(t) : "";
}

/* An Alaska wall time (a datetime-local value) → epoch ms, the way a device
   in Alaska reads it: the earlier hour when the fall change repeats one,
   standard time in the hour the spring change skips. NaN if unreadable. */
function wallMs(wall) {
  const m = WALL_RE.exec(clean(wall));
  if (!m) return NaN;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!Number.isFinite(naive)) return NaN;
  const want = new Date(naive).toISOString().slice(0, 16);
  for (const off of [8, 9]) if (akWall(naive + off * HOUR) === want) return naive + off * HOUR;
  return naive + 9 * HOUR;
}

// "moved to Bedroom 10/08 14:30" — the SOP's keep-the-row note for a move
function moveLine(m) {
  const w = wallTime(m.at);
  return `moved to ${clean(m.room)} ${w ? `${w.slice(5, 7)}/${w.slice(8, 10)} ${w.slice(11, 16)}` : ""}`.trim();
}

/* ---------- the event log ---------- */
function validEvent(e) {
  if (!isObj(e) || typeof e.id !== "string" || !e.id || ACTS.indexOf(e.act) < 0) return false;
  if (!Number.isFinite(instant(e.at))) return false;
  return e.act === "void" ? typeof e.voids === "string" && e.voids !== "" : tagKey(e.tag) !== "";
}

/* every well-formed event once (first copy of an id), by time then id */
function sortedEvents(project) {
  const seen = new Set(), out = [];
  for (const e of arr(isObj(project) ? project.equipmentScans : null)) {
    if (!validEvent(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ e, t: instant(e.at) });
  }
  return out.sort((a, b) => a.t - b.t || byId(a.e.id, b.e.id)).map((x) => x.e);
}

/** The events that still count: well-formed, not voids, not voided — sorted
    by `at`, then id, so every device walks them in the same order. */
export function liveScans(project) {
  const all = sortedEvents(project);
  const voided = new Set(all.filter((e) => e.act === "void").map((e) => e.voids));
  return all.filter((e) => e.act !== "void" && !voided.has(e.id));
}

/** One entry per time a unit went out on this job, in placedAt order:
    { placeId, tag, tagKey, room (where it is now), placedRoom, type, model,
      logId, placedAt, by, tech, how, moves: [{id, at, room, by, tech}],
      removeId, removedAt, removedBy, removedTech, elsewhere }.
    A place while the unit is out in another room is a move; in the same
    room it is ignored, as is a move or remove of a unit that isn't out. */
export function placements(project) {
  const open = new Map(), out = [];
  const moveTo = (P, e) => {
    P.moves.push({ id: e.id, at: e.at, room: clean(e.room), by: str(e.by), tech: str(e.tech) });
    P.room = clean(e.room);
  };
  for (const e of liveScans(project)) {
    const key = tagKey(e.tag);
    const cur = open.get(key);
    const newRoom = !!cur && roomKey(e.room) !== "" && roomKey(e.room) !== roomKey(cur.room);
    if (e.act === "place" && !cur) {
      const P = {
        placeId: e.id, tag: clean(e.tag), tagKey: key, room: clean(e.room), placedRoom: clean(e.room),
        type: clean(e.type), model: clean(e.model), logId: str(e.logId), placedAt: e.at,
        by: str(e.by), tech: str(e.tech), how: str(e.how), moves: [],
        removeId: "", removedAt: "", removedBy: "", removedTech: "",
        elsewhere: isObj(e.elsewhere) ? { ...e.elsewhere } : null,
      };
      open.set(key, P);
      out.push(P);
    } else if ((e.act === "place" || e.act === "move") && newRoom) {
      moveTo(cur, e);
    } else if (e.act === "remove" && cur) {
      Object.assign(cur, { removeId: e.id, removedAt: e.at, removedBy: str(e.by), removedTech: str(e.tech) });
      open.delete(key);
    }
  }
  return out;
}

/** The placement of this tag that is still out on this job, or null. */
export function openPlacement(project, tag) {
  const key = tagKey(parseTag(tag) || tag);
  if (!key) return null;
  for (const P of placements(project)) if (P.tagKey === key && !P.removeId) return P;
  return null;
}

/* ---------- materializing the drying-log rows ---------- */
const ROW_KEYS = ["asset", "type", "location", "placed", "removed", "hours", "notes"];
// the one empty row every new drying log seeds (model.js newDryingLog)
const isBlankRow = (r) => isObj(r) && !r.scanId && ROW_KEYS.every((k) => clean(r[k]) === "");

function dropLine(notes, line) {
  const lines = notes.split("\n");
  const i = lines.findIndex((l) => l.trim() === line);
  if (i < 0) return notes;
  lines.splice(i, 1);
  return lines.join("\n");
}

/* Bring one scanned row in line with its placement. Asset, Placed and (when
   a scan removed it) Removed are the scan's; Location and Type are only
   filled when empty; Notes only ever gain a move line (or lose one this
   function wrote for a move since undone). */
function writeRow(row, P) {
  const prev = isObj(row.scan) ? row.scan : {};
  row.asset = P.tag;
  row.placed = wallTime(P.placedAt);
  if (P.removeId) row.removed = wallTime(P.removedAt);
  else if (prev.removeId) row.removed = "";            // the remove scan was undone
  else row.removed = str(row.removed);                 // a removal typed on the row stays
  // forms.js recalcDays' figure, read on the Alaska clock wherever this runs
  const ms = wallMs(row.removed) - wallMs(row.placed);
  row.hours = row.placed && row.removed && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / HOUR) : "";
  delete row._manualHrs;
  // the room it was PLACED in: the SOP keeps one row per unit and notes a move,
  // and a row rebuilt after a move must read the same as the one it replaces
  if (!clean(row.location)) row.location = P.placedRoom;
  if (!clean(row.type)) row.type = P.type || labelOf(typeFromTag(P.tag));
  let notes = str(row.notes);
  const want = P.moves.map(moveLine);
  for (const m of arr(prev.moves)) {
    const line = isObj(m) ? moveLine(m) : "";
    if (line && want.indexOf(line) < 0) notes = dropLine(notes, line);
  }
  for (const line of want) if (!notes.includes(line)) notes += (notes && !notes.endsWith("\n") ? "\n" : "") + line;
  row.notes = notes;
  row.scanId = P.placeId;
  row.scan = {
    placeId: P.placeId, removeId: P.removeId, by: P.by, tech: P.tech, how: P.how,
    placedAt: P.placedAt, removedAt: P.removedAt, removedBy: P.removedBy, removedTech: P.removedTech,
    model: P.model, moves: P.moves.map((m) => ({ at: m.at, room: m.room })),
    removedTyped: !P.removeId && clean(row.removed) !== "",
  };
}

/** Write the scans into the drying logs' equipment rows: one row per
    placement (`scanId` = its place event), found in any log or added to the
    log the scan named (else the first; never a new log). The seed blank row
    gives way to the first one. Rows whose placement is gone (voided) are
    removed; a row whose event this copy doesn't hold at all is left alone.
    Idempotent, and the same on every device. Mutates `project`;
    `changed` says whether any log's rows differ. */
export function applyScans(project) {
  if (!isObj(project)) return { changed: false };
  const logs = arr(project.dryingLogs).filter(isObj);
  const ps = placements(project);
  const scannedRow = (r) => isObj(r) && !!r.scanId;
  if (!ps.length && !logs.some((l) => arr(l.equipment).some(scannedRow))) return { changed: false };
  const before = logs.map((l) => JSON.stringify(l.equipment === undefined ? null : l.equipment));

  // where each placement's row lives; a second copy (another log, or the same
  // log twice after a merge) goes, keeping the one in the placement's own log
  const byPlace = new Map(ps.map((P) => [P.placeId, P]));
  const hits = new Map();
  for (const log of logs) {
    for (const row of arr(log.equipment)) {
      if (!scannedRow(row)) continue;
      const id = str(row.scanId);
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push({ log, row });
    }
  }
  // A row whose place event this copy holds but which is no placement now
  // (undone, or another device's scan of the same unit got there first)
  // goes, as does one whose event was deleted (a tombstone). A row whose
  // event is simply NOT on this copy stays as it is: a copy written by an
  // older build can lack the scan log, and the rows are the drying record.
  const known = new Set(sortedEvents(project).map((e) => e.id));
  const marks = isObj(project.deletedIds) ? project.deletedIds : {};
  const rowOf = new Map(), drop = new Set();
  for (const [id, list] of hits) {
    const P = byPlace.get(id);
    const orphan = !P && !known.has(id) && !has(marks, id);
    const keep = P ? list.find((x) => P.logId && x.log.id === P.logId) || list[0] : orphan ? list[0] : null;
    for (const x of list) if (x !== keep) drop.add(x.row);
    if (keep && P) rowOf.set(id, keep.row);
  }
  if (drop.size) {
    for (const log of logs) {
      const eq = arr(log.equipment);
      for (let i = eq.length - 1; i >= 0; i--) if (drop.has(eq[i])) eq.splice(i, 1);
    }
  }

  for (const P of ps) {
    let row = rowOf.get(P.placeId);
    if (!row) {
      const log = logs.find((l) => P.logId && l.id === P.logId) || logs[0];
      if (!log) continue;                                // no drying log yet: the events wait for one
      if (!Array.isArray(log.equipment)) log.equipment = [];
      if (log.equipment.length === 1 && isBlankRow(log.equipment[0])) log.equipment.splice(0, 1);
      row = {
        asset: P.tag, type: P.type || labelOf(typeFromTag(P.tag)), location: P.placedRoom,
        placed: "", removed: "", hours: "", notes: "", scanId: P.placeId, scan: null,
      };
      log.equipment.push(row);
      rowOf.set(P.placeId, row);
    }
    writeRow(row, P);
  }

  const changed = logs.some((l, i) => JSON.stringify(l.equipment === undefined ? null : l.equipment) !== before[i]);
  return { changed };
}

/* ---------- recording a read ---------- */
function newId() {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID() : "scan-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// a new event, every field present (§3 order); the caller sets act-specific ones
function newEvent(project, ctx, tag, act, room) {
  const taken = new Set(arr(project.equipmentScans).map((e) => isObj(e) && e.id));
  const id = typeof ctx.id === "string" && ctx.id && !taken.has(ctx.id) ? ctx.id : newId();
  return {
    id, tag, act,
    at: Number.isFinite(instant(ctx.at)) ? str(ctx.at).trim() : new Date().toISOString(),
    room, type: "", model: "", logId: "", voids: "",
    how: str(ctx.how), by: str(ctx.by), tech: str(ctx.tech), build: str(ctx.build),
  };
}

function pushEvent(project, ev) {
  if (!Array.isArray(project.equipmentScans)) project.equipmentScans = [];
  project.equipmentScans.push(ev);
  return ev;
}

// "make model · rating" from a fleet row (fleet.js unitModelText says the same)
function unitModel(unit) {
  if (!isObj(unit)) return "";
  const mm = [clean(unit.make), clean(unit.model)].filter(Boolean).join(" ");
  return [mm, clean(unit.rating)].filter(Boolean).join(" · ");
}

const findPlacement = (project, placeId) => placements(project).find((P) => P.placeId === placeId) || null;

/** Decide one read and, when it changes something, record it.
    input: { tag, mode: "place"|"remove", room, how, at, id, by, tech, build,
      unit (fleet row or null), typeCode (a pick for a tag with no prefix),
      elsewhere ({jobId, label, since} or null), logId }.
    outcome: placed | moved | removed (an event was pushed and the rows
    rewritten) · already (out in that room) · not_here (remove of a unit not
    out) · need_room · need_type · invalid (no tag in the text). */
export function recordScan(project, input) {
  const inp = isObj(input) ? input : {};
  const unit = isObj(inp.unit) ? inp.unit : null;
  const parsed = parseTag(inp.tag);
  const done = (outcome, event, message, placement) => ({ outcome, event, message, placement });
  if (!isObj(project) || !parsed) return done("invalid", null, "That isn't a tag (example AM-014)", null);
  // shown as the fleet list has it when the label and the list agree
  const tag = unit && tagKey(unit.tag) === tagKey(parsed) ? clean(unit.tag).toUpperCase() : parsed;
  const open = openPlacement(project, tag);

  if (inp.mode === "remove") {
    if (!open) return done("not_here", null, `${tag} isn't out on this job`, null);
    const ev = pushEvent(project, newEvent(project, inp, tag, "remove", open.room));
    applyScans(project);
    return done("removed", ev, `${tag} removed from ${open.room}`, findPlacement(project, open.placeId));
  }

  const room = clean(inp.room);
  if (!room) return done("need_room", null, "Pick the room first", open);
  if (open) {
    if (roomKey(open.room) === roomKey(room)) return done("already", null, `${tag} is already in ${open.room}`, open);
    const ev = pushEvent(project, newEvent(project, inp, tag, "move", room));
    applyScans(project);
    return done("moved", ev, `${tag} moved ${open.room} → ${room}`, findPlacement(project, open.placeId));
  }
  const code = [inp.typeCode, unit && unit.type, typeFromTag(tag)].find((c) => typeof c === "string" && has(TYPE_LABELS, c));
  if (!code) return done("need_type", null, `What kind of unit is ${tag}?`, null);
  const ev = newEvent(project, inp, tag, "place", room);
  ev.type = TYPE_LABELS[code];
  ev.model = typeof inp.model === "string" ? clean(inp.model) : unitModel(unit);
  ev.logId = str(inp.logId) || str((arr(project.dryingLogs).find(isObj) || {}).id);
  const away = isObj(inp.elsewhere) && inp.elsewhere.jobId ? inp.elsewhere : null;
  if (away) ev.elsewhere = { jobId: str(away.jobId), label: str(away.label), since: str(away.since) };
  pushEvent(project, ev);
  applyScans(project);
  const note = away ? ` (still out on ${clean(away.label) || "another job"})` : "";
  return done("placed", ev, `${tag} ${ev.type} → ${room}${note}`, findPlacement(project, ev.id));
}

function pushVoid(project, target, ctx) {
  const ev = newEvent(project, ctx, clean(target.tag), "void", "");
  ev.how = "";
  ev.voids = target.id;
  return pushEvent(project, ev);
}

/** Undo one event: push a void for it (nothing for an unknown id, a void,
    or an event already voided), then rewrite the rows. ctx: {id, at, by,
    tech, build}. Returns the void event or null. */
export function voidEvent(project, eventId, ctx) {
  if (!isObj(project) || !eventId) return null;
  const all = sortedEvents(project);
  const target = all.find((e) => e.id === eventId);
  if (!target || target.act === "void" || all.some((e) => e.act === "void" && e.voids === eventId)) return null;
  const ev = pushVoid(project, target, isObj(ctx) ? ctx : {});
  applyScans(project);
  return ev;
}

/** Undo a whole scanned row: void its place event, its moves and its remove,
    then rewrite the rows (the row goes). The voids after the first take ids
    derived from ctx.id ("<id>-1", "<id>-2", …). Returns the void events. */
export function voidPlacement(project, placeId, ctx) {
  const c = isObj(ctx) ? ctx : {};
  const P = isObj(project) ? findPlacement(project, placeId) : null;
  if (!P) return [];
  const ids = [P.placeId, ...P.moves.map((m) => m.id), P.removeId].filter(Boolean);
  const byEvent = new Map(sortedEvents(project).map((e) => [e.id, e]));
  const out = ids.map((id, i) => pushVoid(project, byEvent.get(id), { ...c, id: i && c.id ? `${c.id}-${i}` : c.id }));
  applyScans(project);
  return out;
}

/* ---------- across jobs ---------- */
// the field job list's name for a job (app.js projectList)
function jobLabel(p) {
  const who = isObj(p.customer) ? clean(p.customer.name) : clean(p.customer);
  return who || clean(p.address) || "another job";
}

/** Is this unit out on another job? Looks at the other jobs' scans and at
    their typed rows (same tag, placed, not removed); skips deleted and
    archived jobs. The most recent wins: { jobId, label, since (UTC ISO),
    room } or null. */
export function openElsewhere(projects, tag, exceptJobId) {
  const key = tagKey(parseTag(tag) || tag);
  if (!key) return null;
  const list = Array.isArray(projects) ? projects : isObj(projects) ? Object.values(projects) : [];
  let best = null;
  const consider = (c) => {
    if (!best || c.since > best.since || (c.since === best.since && c.jobId < best.jobId)) best = c;
  };
  for (const p of list) {
    if (!isObj(p) || p.deleted === true || clean(p.archivedAt)) continue;
    if (exceptJobId && p.id === exceptJobId) continue;
    const label = jobLabel(p), jobId = str(p.id);
    for (const P of placements(p)) {
      if (P.tagKey === key && !P.removeId) consider({ jobId, label, since: P.placedAt, room: P.room });
    }
    for (const log of arr(p.dryingLogs)) {
      for (const row of arr(isObj(log) ? log.equipment : null)) {
        if (!isObj(row) || row.scanId || tagKey(row.asset) !== key || !clean(row.placed) || clean(row.removed)) continue;
        const t = wallMs(row.placed);
        consider({ jobId, label, since: Number.isFinite(t) ? new Date(t).toISOString() : clean(row.placed), room: clean(row.location) });
      }
    }
  }
  return best;
}

/* ---------- printing and picking ---------- */
/** The printed scan record: one row per live event, in time order —
    { at (Alaska wall time), tag, type, act, room, how, tech, by }. A move or
    remove shows the type its unit was placed with. */
export function scanRecord(project) {
  const typeOf = new Map();
  return liveScans(project).map((e) => {
    const key = tagKey(e.tag);
    let type = clean(e.type);
    if (e.act === "place" && type) typeOf.set(key, type);
    if (!type) type = typeOf.get(key) || labelOf(typeFromTag(e.tag));
    return { at: wallTime(e.at), tag: clean(e.tag), type, act: e.act, room: clean(e.room), how: str(e.how), tech: str(e.tech), by: str(e.by) };
  });
}

/** Rooms to offer on the scanner's room sheet, each once (first spelling
    wins): rooms this job's scans used, the equipment rows' locations, the
    job's room list, the Magicplan rooms, then the moisture maps' labels. */
export function roomSuggestions(project) {
  const out = [], seen = new Set();
  const add = (v) => {
    const r = clean(v), k = r.toLowerCase();
    if (r && !seen.has(k)) { seen.add(k); out.push(r); }
  };
  if (!isObj(project)) return out;
  for (const e of liveScans(project)) if (e.act === "place" || e.act === "move") add(e.room);
  for (const log of arr(project.dryingLogs)) {
    for (const row of arr(isObj(log) ? log.equipment : null)) if (isObj(row)) add(row.location);
  }
  for (const r of arr(project.rooms)) add(r);
  const dims = isObj(project.floorPlan) && isObj(project.floorPlan.dimensions) ? project.floorPlan.dimensions : null;
  for (const r of arr(dims && dims.rooms)) if (isObj(r)) add(r.name);
  for (const m of arr(project.moistureMaps)) if (isObj(m)) add(m.label);
  return out;
}
