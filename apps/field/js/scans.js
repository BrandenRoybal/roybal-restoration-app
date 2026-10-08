/* ============================================================
   Equipment scan in and out — pure module (no DOM, no network,
   no imports)
   ------------------------------------------------------------
   Every drying machine carries a QR label: the asset tag
   ("AM-014") printed as "RC:AM-014". Each read on site is an
   APPEND-ONLY event in the job blob, `project.equipmentScans`:

     { id, tag, act: place|remove|move|void, at (device clock, UTC
       ISO), room, type, model, logId, voids, how, by, tech, build,
       elsewhere?, from?, after?, endedAt?, onRow? }

   A place while the unit is out in another room moves it (`from` names
   the placement it moves). A place that names the unit's last placement
   in `after` says that one came off without a scan (a Removed typed on
   its row, `endedAt`) and the unit is back. A scan of a unit that is on
   the log as a hand-typed row carries `onRow: { placed }` (that row's
   typed Placed): it is never a placement; applyScans fills that row's
   Removed from it, or adds its "moved to" line, and the row stays typed.
   The row keeps what each fill replaced (`row.scanFill`), so a fill whose
   scan is undone comes off again on every device, whichever copy of the
   log wins a merge.

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
/* JSON with every object's keys sorted. A copy that came back from the server
   is jsonb, which stores keys in its own order (length, then bytes); a check
   that read key order would see a change on every server copy, and sync
   would push it back forever (the Jul 2026 push loop). */
const canonStr = (v) => JSON.stringify(v, (k, x) => (isObj(x)
  ? Object.keys(x).sort(byId).reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

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
  const voided = voidedIds(all);
  return all.filter((e) => e.act !== "void" && !voided.has(e.id));
}
const voidedIds = (all) => new Set(all.filter((e) => e.act === "void").map((e) => e.voids));

/* A move recorded on one device while another pulled the unit: a move whose
   placement a remove closed this little before it is taken to have come
   first (that clock was behind), not as the unit going back out. */
const MOVE_SKEW_MS = 10 * 60 * 1000;

/** One entry per time a unit went out on this job, in placedAt order:
    { placeId, tag, tagKey, room (where it is now), placedRoom, type, model,
      logId, placedAt, by, tech, how, moves: [{id, at, room, by, tech}],
      removeId, removedAt, removedBy, removedTech, endedTyped, typedEnd,
      backAt, elsewhere }.
    A place while the unit is out in another room is a move; in the same
    room it is ignored, as is a move or remove of a unit that isn't out. A
    place naming the open placement in `after` ends it (endedTyped, at its
    typed `endedAt`; backAt = when the unit was scanned back in) and starts
    a new one. */
export function placements(project) {
  const open = new Map(), out = [], byPlace = new Map();
  const moveTo = (P, e) => {
    P.moves.push({ id: e.id, at: e.at, room: clean(e.room), by: str(e.by), tech: str(e.tech) });
    P.room = clean(e.room);
  };
  const start = (e, key) => {
    const P = {
      placeId: e.id, tag: clean(e.tag), tagKey: key, room: clean(e.room), placedRoom: clean(e.room),
      type: clean(e.type), model: clean(e.model), logId: str(e.logId), placedAt: e.at,
      by: str(e.by), tech: str(e.tech), how: str(e.how), moves: [],
      removeId: "", removedAt: "", removedBy: "", removedTech: "", endedTyped: false, typedEnd: "", backAt: "",
      elsewhere: isObj(e.elsewhere) ? { ...e.elsewhere } : null,
    };
    open.set(key, P);
    byPlace.set(P.placeId, P);
    out.push(P);
  };
  const all = sortedEvents(project);
  const undone = voidedIds(all);
  const eventOf = new Map(all.map((e) => [e.id, e]));
  /* A move recorded while its placement was out, when that placement has
     since been undone (✕): it goes with it, unless the unit had come off
     well before it (then the move scan put it back out: a placement of its own). */
  const movedUndone = (e) => {
    const from = eventOf.get(str(e.from));
    if (!from || !undone.has(from.id)) return false;
    const key = tagKey(e.tag), t0 = instant(from.at), t = instant(e.at);
    let off = NaN;
    for (const r of all) {
      if (r.act === "remove" && !isObj(r.onRow) && tagKey(r.tag) === key && instant(r.at) > t0 && instant(r.at) <= t) off = instant(r.at);
    }
    return !Number.isFinite(off) || t - off <= MOVE_SKEW_MS;
  };
  for (const e of liveScans(project)) {
    if (isObj(e.onRow)) continue;                      // a hand-typed row's scan (applyScans)
    const key = tagKey(e.tag);
    const cur = open.get(key);
    if (e.act === "place" && cur && e.after && e.after === cur.placeId) {
      cur.endedTyped = true;
      cur.typedEnd = Number.isFinite(instant(e.endedAt)) ? str(e.endedAt).trim() : "";
      cur.backAt = e.at;
      start(e, key);
      continue;
    }
    const newRoom = !!cur && roomKey(e.room) !== "" && roomKey(e.room) !== roomKey(cur.room);
    if (e.act === "place" && !cur) {
      if (e.from && movedUndone(e)) continue;
      const was = e.from ? byPlace.get(str(e.from)) : null;
      if (was && was.removeId && instant(e.at) - instant(was.removedAt) <= MOVE_SKEW_MS) continue;
      start(e, key);
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
  for (const P of placements(project)) if (P.tagKey === key && !P.removeId && !P.endedTyped) return P;
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
// a typed row's move line off its notes; a remark the crew added after it on that line stays
function dropMoveLine(notes, line) {
  const out = dropLine(notes, line);
  if (out !== notes || !line) return out;
  return notes.split("\n").map((l) => (isMoveLine(l, line) ? l.trim().slice(line.length).replace(/^[\s,.;:-]+/, "") : l)).join("\n");
}
// ... or swapped for the line the crew rewrote it as (a remark after it on that line stays)
function swapMoveLine(notes, line, put) {
  if (notes.split("\n").some((l) => isMoveLine(l, put))) return dropMoveLine(notes, line);
  return notes.split("\n").map((l) => (isMoveLine(l, line) ? put + l.trim().slice(line.length) : l)).join("\n");
}

/* Bring one scanned row in line with its placement. Asset, Placed and (when
   a scan removed it) Removed are the scan's; Location and Type are only
   filled when empty; Notes only ever gain a move line (or lose one this
   function wrote for a move since undone). */
function writeRow(row, P) {
  const prev = isObj(row.scan) ? row.scan : {};
  row.asset = P.tag;
  row.placed = wallTime(P.placedAt);
  // a pickup typed ahead of the remove scan, kept so undoing that scan puts it back
  let plan = "";
  if (P.removeId) {
    plan = prev.removeId ? str(prev.plan) : str(row.removed);
    row.removed = wallTime(P.removedAt);
  } else if (prev.removeId) row.removed = str(prev.plan) || (P.typedEnd ? wallTime(P.typedEnd) : "");   // the remove scan was undone
  else if (!clean(row.removed) && P.typedEnd) row.removed = wallTime(P.typedEnd);   // a typed removal a newer copy of the log lost
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
    endedTyped: !!P.endedTyped, backAt: P.backAt, plan,
  };
}

/* ---------- hand-typed rows a scan touched ---------- */
// "moved to Bath 10/08 14:30" → epoch ms; the year is the row's Placed year (the next one for an earlier month)
const MOVE_LINE_RE = /^moved to (.+?) (\d{2})\/(\d{2}) (\d{2}:\d{2})(?!\d)(.*)$/;   // a remark typed after it is fine
// a notes line that still is the move line `line` (a remark after it allowed)
const isMoveLine = (l, line) => !!line && l.trim().startsWith(line) && !/^\d/.test(l.trim().slice(line.length));
// a notes line's move, without a remark after it ("" for any other line)
function movePart(l) {
  const m = MOVE_LINE_RE.exec(str(l).trim());
  return m ? `moved to ${m[1]} ${m[2]}/${m[3]} ${m[4]}` : "";
}
/* The lines scans' move lines were rewritten as (room or time corrected)
   rather than deleted. For each old line (scans that shared one take the
   same), a move line in `lines` no scan on the row wrote (`tracked`): at the
   same time, else the nearest in the same room; and when `before` (the
   notes as the crew found them) says which lines this edit added, the rest
   pair up with the added lines, nearest in time. A line is given once, and a
   line that was already there is never a rewrite. Map old line → new line. */
function rewrites(olds, lines, tracked, placed, before) {
  const out = new Map();
  const parse = (l) => MOVE_LINE_RE.exec(l);
  const had = typeof before === "string" ? new Set(before.split("\n").map(movePart).filter(Boolean)) : null;
  let cands = lines.map(movePart).filter((p) => p && !(had && had.has(p)) && !tracked.some((t) => isMoveLine(p, t)));
  const todo = [...new Set(olds)].filter((l) => parse(l) && !cands.includes(l));
  const take = (old, p) => { out.set(old, p); cands = cands.filter((x) => x !== p); };
  const nearest = (t0, pool, at) => {
    let best = null, gap = Infinity;
    for (const x of pool) {
      const g = Math.abs(moveLineMs(parse(at(x)), placed) - t0);
      if (best === null || g < gap) { best = x; gap = g; }
    }
    return best;
  };
  for (const old of todo) {
    const m = parse(old);
    const p = cands.find((x) => { const n = parse(x); return n[2] === m[2] && n[3] === m[3] && n[4] === m[4]; });
    if (p) take(old, p);
  }
  for (const old of todo) {
    if (out.has(old)) continue;
    const m = parse(old);
    const p = nearest(moveLineMs(m, placed), cands.filter((x) => roomKey(parse(x)[1]) === roomKey(m[1])), (x) => x);
    if (p) take(old, p);
  }
  // pass 3 (an edit's own new lines only): a line moved in room and time, within half a day of the scan's
  if (had) {
    for (const p of [...cands]) {
      const left = todo.filter((old) => !out.has(old));
      if (!left.length) break;
      const t = moveLineMs(parse(p), placed), old = nearest(t, left, (x) => x);
      if (Math.abs(moveLineMs(parse(old), placed) - t) <= 12 * 3600000) take(old, p);
    }
  }
  return out;
}
function moveLineMs(m, placed) {
  const p = /^(\d{4})-(\d{2})/.exec(clean(placed));
  if (!m || !p) return NaN;
  const y = +p[1] + (m[2] < p[2] ? 1 : 0);
  return wallMs(`${y}-${m[2]}-${m[3]}T${m[4]}`);
}

// a "moved to" line into the notes among the others, in time order
function insertMoveLine(notes, line, placed) {
  const t = moveLineMs(MOVE_LINE_RE.exec(line), placed);
  const lines = notes ? notes.split("\n") : [];
  const at = Number.isFinite(t) ? lines.findIndex((l) => moveLineMs(MOVE_LINE_RE.exec(l.trim()), placed) > t) : -1;
  if (at < 0) return notes + (notes && !notes.endsWith("\n") ? "\n" : "") + line;
  lines.splice(at, 0, line);
  return lines.join("\n");
}

const fillOf = (row) => (isObj(row.scanFill) ? row.scanFill : {});
const fillHas = (row, id) => fillOf(row).removeId === id || arr(fillOf(row).moves).some((m) => isObj(m) && m.id === id);

// a remove scan fills a typed Removed that is empty or later (a planned pickup)
function appliesOver(typed, e) {
  if (!clean(typed)) return true;
  const t = wallMs(typed);
  return Number.isFinite(t) && t > instant(e.at);
}
// ... the Removed as the crew left it, under any fill
function fillsRow(row, e) {
  const f = fillOf(row);
  return appliesOver(f.removeId && str(row.removed) === str(f.removed) && isObj(f.was) ? str(f.was.removed) : str(row.removed), e);
}
// whole hours from Placed to Removed on the Alaska clock ("" unless both and in order)
function hoursOf(placed, removed) {
  const ms = wallMs(removed) - wallMs(placed);
  return clean(placed) && clean(removed) && Number.isFinite(ms) && ms >= 0 ? Math.round(ms / HOUR) : "";
}

/* Which hand-typed row each live onRow scan goes on: the row that already
   holds it, else one with the same tag and typed Placed (its own log first),
   for a remove the first no other remove holds that it still applies to.
   Map row → { removes, moves }, each in time order. */
function claimTypedRows(logs, events) {
  const rows = [];
  for (const log of logs) for (const row of arr(log.equipment)) if (isObj(row) && !row.scanId && clean(row.placed)) rows.push({ log, row });
  const claims = new Map();
  const slot = (row) => {
    if (!claims.has(row)) claims.set(row, { removes: [], moves: [] });
    return claims.get(row);
  };
  const add = (row, e) => (e.act === "remove" ? slot(row).removes : slot(row).moves).push(e);
  const later = [];
  for (const e of events) {
    const held = rows.find((x) => fillHas(x.row, e.id));
    if (held) add(held.row, e); else later.push(e);
  }
  for (const e of later) {
    const key = tagKey(e.tag), placed = clean(e.onRow.placed);
    const same = rows.filter((x) => tagKey(x.row.asset) === key && clean(x.row.placed) === placed);
    const cands = same.filter((x) => e.logId && x.log.id === e.logId).concat(same.filter((x) => !(e.logId && x.log.id === e.logId)));
    if (!cands.length) continue;
    const free = (x) => !(claims.get(x.row) || { removes: [] }).removes.length;
    const hit = e.act === "remove"
      ? cands.find((x) => free(x) && fillsRow(x.row, e)) || cands.find(free) || cands[0]
      : cands.find((x) => rowOutAt(x.row, instant(e.at))) || cands[0];
    add(hit.row, e);
  }
  for (const c of claims.values()) c.removes.sort((a, b) => instant(a.at) - instant(b.at) || byId(a.id, b.id));
  return claims;
}

/* Write a typed row's scans onto it, the way writeRow does for a scanned row:
   Removed and Hrs from the earliest remove scan before what the crew typed
   (a later typed time is a planned pickup the scan replaces), one "moved to"
   line per move scan. `row.scanFill` keeps what the remove replaced and the
   lines the moves added, so a scan that is undone comes off again, while a
   line or time the crew changed since stays theirs. A scan the crew's hand
   edit replaced stays listed (`released`, and a move entry marked
   `released`) with the value they left: its latest void carries what they
   typed last, on whichever device, and every copy of the row follows it. */
function fillTypedRow(row, mine, ctx) {
  const f = fillOf(row), next = { removeId: "", removed: "", was: null, moves: [], released: [] };
  let holds = !!f.removeId && str(row.removed) === str(f.removed);
  let base = holds && isObj(f.was) ? f.was : null;
  const typedBase = (removed) => ({ removed, hours: hoursOf(row.placed, removed), manualHrs: null });
  // the fill's scan was undone (back to `was`) or given way to a hand edit made
  // on another device, whose own copy of the log may have lost the merge
  const v = holds ? ctx.voidOf.get(f.removeId) : null;
  const handed = !!(v && v.release === "removed" && isObj(v.set));
  if (v && v.release && !handed) { holds = false; base = null; }   // the row deleted elsewhere: this copy keeps what it shows
  // a Removed retyped since, on any device: the newest of those scans' latest voids
  // (a void is newer by `at`, then id: the order every device walks them)
  // (each register keeps the id of the void it last followed, `v`: a newer one is news even
  // when it says what that scan's last void said, as a restate of every scan does)
  let newest = handed ? { rv: v, now: str(v.set.removed), was: null } : null;
  if (handed) next.released.push({ id: str(f.removeId), removed: newest.now, v: v.id });
  for (const r of arr(f.released)) {
    if (!isObj(r) || !r.id || next.released.some((k) => k.id === str(r.id))) continue;
    const rv = ctx.voidOf.get(str(r.id));
    if (rv && rv.release !== "removed") continue;
    const now = rv && isObj(rv.set) ? str(rv.set.removed) : str(r.removed);
    next.released.push(rv ? { id: str(r.id), removed: now, v: rv.id } : { id: str(r.id), removed: now });
    if (rv && (!newest || instant(rv.at) > instant(newest.rv.at) || (instant(rv.at) === instant(newest.rv.at) && byId(rv.id, newest.rv.id) > 0))) {
      newest = { rv, now, was: str(r.removed), news: r.v != null && str(r.v) !== rv.id };
    }
  }
  if (newest && (handed || newest.now !== newest.was || newest.news)) {
    if (holds) base = typedBase(newest.now);
    else {
      row.removed = newest.now;
      row.hours = hoursOf(row.placed, newest.now);
      delete row._manualHrs;
    }
  }
  const typed = base ? str(base.removed) : str(row.removed);
  const e = mine.removes.find((x) => appliesOver(typed, x));
  if (e && holds && f.removeId === e.id) Object.assign(next, { removeId: f.removeId, removed: f.removed, was: base || f.was });
  else if (e) {
    next.was = base || { removed: str(row.removed), hours: row.hours ?? "", manualHrs: has(row, "_manualHrs") ? row._manualHrs : null };
    row.removed = wallTime(e.at);
    row.hours = hoursOf(row.placed, row.removed);
    delete row._manualHrs;
    Object.assign(next, { removeId: e.id, removed: row.removed });
  } else if (holds && !ctx.known.has(f.removeId)) {
    Object.assign(next, { removeId: f.removeId, removed: f.removed, was: base || f.was });   // a scan this copy doesn't hold: left as it is
  } else if (base) {
    row.removed = str(base.removed);                     // back to what the crew had (or typed since)
    row.hours = base.hours ?? "";
    if (base.manualHrs != null) row._manualHrs = base.manualHrs;
    else delete row._manualHrs;
  }

  let notes = str(row.notes);
  const shows = (line) => notes.split("\n").some((l) => isMoveLine(l, line));
  const live = new Set(mine.moves.map((x) => x.id));
  const entries = [];
  for (const m of arr(f.moves)) if (isObj(m) && m.id && !entries.some((k) => k.id === str(m.id))) entries.push(m);
  const voidOfMove = (m) => ctx.voidOf.get(str(m.id));
  const stays = (m) => {
    const mv = voidOfMove(m);
    return m.released ? !(mv && mv.release === "notes")
      : live.has(str(m.id)) || !ctx.known.has(str(m.id)) || !!(mv && mv.release === "row");   // the row deleted elsewhere: this copy keeps its line
  };
  const kept = new Set(entries.filter(stays).map((m) => str(m.line)));
  for (const m of entries) {                             // in the order the row lists them
    const id = str(m.id), line = str(m.line);
    if (stays(m)) { next.moves.push(m.released ? { id, line, released: true } : { id, line }); continue; }
    // a move since undone takes its line with it; one the crew rewrote or deleted (on any device) takes theirs
    const mv = voidOfMove(m);
    const crew = !!(mv && mv.release === "notes");
    const put = crew && isObj(mv.set) ? movePart(mv.set.line) : "";
    if (crew && put === line) { next.moves.push({ id, line, released: true }); continue; }   // as the crew left it
    const shared = kept.has(line) || next.moves.some((k) => k.line === line);
    if (line && !shared) notes = put ? swapMoveLine(notes, line, put) : dropMoveLine(notes, line);
    else if (!line && put && !shows(put)) notes = insertMoveLine(notes, put, row.placed);   // deleted here, rewritten on the other phone since
    if (crew && (!put || shows(put))) next.moves.push({ id, line: put, released: true });
  }
  for (const x of mine.moves) {                          // each added once: a line the crew deleted stays deleted
    if (next.moves.some((k) => k.id === x.id)) continue;
    const line = moveLine(x);
    if (!shows(line)) notes = insertMoveLine(notes, line, row.placed);
    next.moves.push({ id: x.id, line });
  }
  row.notes = notes;
  if (!next.released.length) delete next.released;
  if (next.removeId || next.moves.length || next.released) row.scanFill = next;
  else delete row.scanFill;
}

/* A typed row's scan that the crew corrected (a Removed retyped or cleared,
   a "moved to" line rewritten) on a phone whose copy of the log then lost
   the merge to one that never had the scan: no row lists it, so it is put
   on the row it was made on (same tag and Placed, its own log first) as the
   crew left it, the way that row would have listed it. A Removed only if
   the scan would have filled it (empty, or a pickup still ahead of it); an
   undo, a deleted line and a deleted row bring nothing. Mutates the rows. */
function claimReleased(logs, project, voidOf) {
  const rows = [];
  for (const log of logs) for (const row of arr(log.equipment)) if (isObj(row) && !row.scanId && clean(row.placed)) rows.push({ log, row });
  const listed = new Set();
  for (const { row } of rows) {
    const f = fillOf(row);
    if (f.removeId) listed.add(str(f.removeId));
    for (const x of arr(f.moves).concat(arr(f.released))) if (isObj(x) && x.id) listed.add(str(x.id));
  }
  for (const e of sortedEvents(project)) {
    if (e.act === "void" || !isObj(e.onRow) || listed.has(e.id)) continue;
    const v = voidOf.get(e.id);
    const removed = e.act === "remove" && v && v.release === "removed" && isObj(v.set);
    const moved = e.act !== "remove" && v && v.release === "notes" && isObj(v.set) && !!movePart(v.set.line);
    if (!removed && !moved) continue;
    const key = tagKey(e.tag), placed = clean(e.onRow.placed);
    const same = rows.filter((x) => tagKey(x.row.asset) === key && clean(x.row.placed) === placed);
    const hit = same.find((x) => e.logId && x.log.id === e.logId) || same[0];
    if (!hit) continue;
    const row = hit.row, f = isObj(row.scanFill) ? row.scanFill : { removeId: "", removed: "", was: null, moves: [] };
    if (removed) {
      const typed = f.removeId && str(row.removed) === str(f.removed) && isObj(f.was) ? str(f.was.removed) : str(row.removed);
      if (!appliesOver(typed, e)) continue;
      f.released = arr(f.released).concat([{ id: e.id, removed: typed }]);
    } else {
      f.moves = arr(f.moves).concat([{ id: e.id, line: "" }]);
    }
    row.scanFill = f;
    listed.add(e.id);
  }
}

// the latest void of each event, by the order every device walks them
function latestVoids(project) {
  const out = new Map();
  for (const e of sortedEvents(project)) if (e.act === "void") out.set(e.voids, e);
  return out;
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
  const touched = (r) => scannedRow(r) || (isObj(r) && isObj(r.scanFill));
  const onRows = liveScans(project).filter((e) => isObj(e.onRow));
  if (!ps.length && !onRows.length && !logs.some((l) => arr(l.equipment).some(touched))
    && !sortedEvents(project).some((e) => isObj(e.onRow))) return { changed: false };   // (a released typed-row scan: claimReleased)
  const before = logs.map((l) => canonStr(l.equipment === undefined ? null : l.equipment));

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
  // hand-typed rows: their scans written on, or taken off again once undone
  const claims = claimTypedRows(logs, onRows);
  const voidOf = latestVoids(project);
  claimReleased(logs, project, voidOf);
  for (const log of logs) {
    for (const row of arr(log.equipment)) {
      if (isObj(row) && !row.scanId && (claims.has(row) || isObj(row.scanFill))) fillTypedRow(row, claims.get(row) || { removes: [], moves: [] }, { known, voidOf });
    }
  }

  const changed = logs.some((l, i) => canonStr(l.equipment === undefined ? null : l.equipment) !== before[i]);
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

// a type label back to its code ("Air mover" → air_mover)
function codeOfLabel(label) {
  const want = clean(label).toLowerCase();
  return want ? Object.keys(TYPE_LABELS).find((c) => TYPE_LABELS[c].toLowerCase() === want) || null : null;
}

// the row a placement wrote, in whichever log holds it
function scannedRow(project, placeId) {
  for (const log of arr(project.dryingLogs)) {
    for (const row of arr(isObj(log) ? log.equipment : null)) if (isObj(row) && row.scanId === placeId) return row;
  }
  return null;
}

// a Removed time typed on a placement's row (no remove scan), epoch ms; NaN if none or unreadable
function typedRemovalMs(project, P) {
  const row = P && !P.removeId ? scannedRow(project, P.placeId) : null;
  return row && clean(row.removed) ? wallMs(row.removed) : NaN;
}

// is a placement the events leave open really still out at `atMs`? Not when
// a Removed typed on its row is at or before then (a later one is a planned pickup)
function outAt(project, P, atMs) {
  if (!P || P.removeId || P.endedTyped) return false;
  const t = typedRemovalMs(project, P);
  return !(Number.isFinite(t) && t <= atMs);
}

/** Is a drying-log equipment row's unit out at `atMs`? Placed, and neither
    removed by then (a later Removed is a planned pickup) nor a run measured
    in TYPED Hrs (_manualHrs, the billing check's rule). Scanned or typed. */
export function rowOutAt(row, atMs) {
  if (!isObj(row) || !clean(row.placed)) return false;
  // a row a scan removed (or the next scan ended) is in, whatever that phone's clock said
  if (row.scanId && isObj(row.scan) && (row.scan.removeId || row.scan.endedTyped)) return false;
  if (!row.scanId && isObj(row.scanFill) && row.scanFill.removeId && str(row.removed) === str(row.scanFill.removed)) return false;
  if (clean(row.removed)) {
    const t = wallMs(row.removed);
    return Number.isFinite(t) && t > atMs;
  }
  return !(row._manualHrs === true && Number(str(row.hours).trim()) > 0);
}

// the hand-typed row on this job for this unit that is out at `atMs` (the latest placed)
function typedRowFor(project, key, atMs) {
  let best = null;
  for (const log of arr(project.dryingLogs)) {
    if (!isObj(log)) continue;
    for (const row of arr(log.equipment)) {
      if (!isObj(row) || row.scanId || tagKey(row.asset) !== key || !rowOutAt(row, atMs)) continue;
      if (!best || wallMs(row.placed) > wallMs(best.row.placed)) best = { log, row };
    }
  }
  return best;
}

/** Where a row's unit is now: the room of its latest "moved to" line (by
    its time; two phones' lines can merge out of order), else its Location. */
export function rowRoom(row) {
  if (!isObj(row)) return "";
  let best = null;
  for (const l of str(row.notes).split("\n")) {
    const m = MOVE_LINE_RE.exec(l.trim());
    if (!m) continue;
    const t = moveLineMs(m, row.placed);
    if (!best || !(t < best.t)) best = { t, room: clean(m[1]) };
  }
  return best ? best.room : clean(row.location);
}

// "10/03 09:00" from a wall time
const shortWall = (w) => (w ? `${w.slice(5, 7)}/${w.slice(8, 10)} ${w.slice(11, 16)}` : "");

// the time a placement last changed (placed or moved), epoch ms
function lastChange(P) {
  let t = instant(P.placedAt);
  for (const m of P.moves) t = Math.max(t, instant(m.at));
  return t;
}

/* A stamp for an event that must land AFTER `floorMs` to count: the device's
   own time, or 1 ms past the floor when that clock is behind the one that
   placed the unit (events are walked in time order; a remove sorted before
   its place would be dropped while the crew saw "removed"). */
function stampAfter(at, floorMs) {
  const t = Number.isFinite(instant(at)) ? instant(at) : Date.now();
  return Number.isFinite(floorMs) && t <= floorMs ? new Date(floorMs + 1).toISOString()
    : Number.isFinite(instant(at)) ? str(at).trim() : new Date(t).toISOString();
}

/** Decide one read and, when it changes something, record it.
    input: { tag, mode: "place"|"remove", room, how, at, id, by, tech, build,
      unit (fleet row or null), typeCode (a pick for a tag with no prefix),
      elsewhere ({jobId, label, since} or null), logId }.
    outcome: placed | moved | removed (an event was pushed and the rows
    rewritten, or a typed row filled in) · already (out in that room, or
    already marked removed) · not_here (remove of a unit not out) ·
    need_room · need_type · invalid (no tag in the text).

    A Removed typed on a scanned row (the unit came off without a scan) is
    the record: once that time has passed, a Remove scan changes nothing
    and a Place starts a new placement that says so (`after`, `endedAt`).

    A unit on this job's log as a hand-typed row (a job started before
    scanning, or a row added because the scanner wouldn't open) stays a
    typed row: the scan is an event naming that row (`onRow`), and
    applyScans fills in its Removed and Hrs (Remove) or adds the "moved to"
    line (Place in another room). `typed` on the outcome says which row,
    for undoTyped. */
export function recordScan(project, input) {
  const inp = isObj(input) ? input : {};
  const unit = isObj(inp.unit) ? inp.unit : null;
  const parsed = parseTag(inp.tag);
  const done = (outcome, event, message, placement, typed) => ({ outcome, event, message, placement, typed: typed || null });
  if (!isObj(project) || !parsed) return done("invalid", null, "That isn't a tag (example AM-014)", null);
  // shown as the fleet list has it when the label and the list agree
  const tag = unit && tagKey(unit.tag) === tagKey(parsed) ? clean(unit.tag).toUpperCase() : parsed;
  const key = tagKey(tag);
  const remove = inp.mode === "remove";
  const room = clean(inp.room);
  const open = openPlacement(project, tag);
  if (!remove && !room) return done("need_room", null, "Pick the room first", open);
  const atIso = Number.isFinite(instant(inp.at)) ? str(inp.at).trim() : new Date().toISOString();
  const atMs = instant(atIso);
  const live = outAt(project, open, atMs) ? open : null;
  const ended = open && !live ? open : null;     // its row has a Removed typed at or before this scan

  if (!live) {
    const typed = typedRowFor(project, key, atMs);
    if (typed) return typedRowScan(project, typed, { inp, tag, remove, room, atIso, done });
  }

  if (remove) {
    if (ended) {
      const row = scannedRow(project, ended.placeId);
      return done("already", null, `${tag} is already marked removed (${shortWall(clean(row && row.removed))})`, ended);
    }
    if (!live) return done("not_here", null, `${tag} isn't out on this job`, null);
    const ev = pushEvent(project, newEvent(project, { ...inp, at: stampAfter(atIso, lastChange(live)) }, tag, "remove", live.room));
    applyScans(project);
    return done("removed", ev, `${tag} removed from ${live.room}`, findPlacement(project, live.placeId));
  }

  if (live) {
    if (roomKey(live.room) === roomKey(room)) return done("already", null, `${tag} is already in ${live.room}`, live);
    // a PLACE in the new room naming the placement it moves: if another device
    // took the unit out meanwhile, it puts it back on the log in this room
    // instead of being dropped (placements(): unless that remove was just before)
    const ev = newEvent(project, { ...inp, at: stampAfter(atIso, lastChange(live)) }, tag, "place", room);
    ev.type = live.type;
    ev.model = live.model;
    ev.logId = live.logId;
    ev.from = live.placeId;
    pushEvent(project, ev);
    applyScans(project);
    return done("moved", ev, `${tag} moved ${live.room} → ${room}`, findPlacement(project, live.placeId));
  }
  // a unit back on this job takes the type it had here
  const before = placements(project).filter((P) => P.tagKey === key).pop();
  const code = [inp.typeCode, unit && unit.type, typeFromTag(tag), before && codeOfLabel(before.type)]
    .find((c) => typeof c === "string" && has(TYPE_LABELS, c));
  if (!code) return done("need_type", null, `What kind of unit is ${tag}?`, null);
  // after every scan of this unit here, so a slow clock can't sort it before the remove it follows
  const ev = newEvent(project, { ...inp, at: stampAfter(atIso, lastScanMs(project, key)) }, tag, "place", room);
  ev.type = TYPE_LABELS[code];
  ev.model = typeof inp.model === "string" ? clean(inp.model) : unitModel(unit);
  ev.logId = str(inp.logId) || str((arr(project.dryingLogs).find(isObj) || {}).id);
  const away = isObj(inp.elsewhere) && inp.elsewhere.jobId ? inp.elsewhere : null;
  if (away) ev.elsewhere = { jobId: str(away.jobId), label: str(away.label), since: str(away.since) };
  if (ended) {
    // the last placement came off when its row says; this one starts now
    ev.after = ended.placeId;
    ev.endedAt = new Date(typedRemovalMs(project, ended)).toISOString();
  }
  pushEvent(project, ev);
  applyScans(project);
  const note = away ? ` (still out on ${clean(away.label) || "another job"})` : "";
  return done("placed", ev, `${tag} ${ev.type} → ${room}${note}`, findPlacement(project, ev.id));
}

// a read of a unit that is on this job's log as a hand-typed row: an event
// naming the row (onRow), written onto it by applyScans
function typedRowScan(project, typed, o) {
  const row = typed.row, where = rowRoom(row);
  if (!o.remove && (!where || roomKey(where) === roomKey(o.room))) {
    return o.done("already", null, `${o.tag} is already on this log${where ? ` in ${where}` : ""} (typed row)`, null);
  }
  const ev = newEvent(project, { ...o.inp, at: o.atIso }, o.tag, o.remove ? "remove" : "place", o.remove ? where : o.room);
  ev.type = clean(row.type);
  ev.logId = str(typed.log.id);
  ev.onRow = { placed: clean(row.placed) };
  pushEvent(project, ev);
  applyScans(project);
  const typedInfo = { key: tagKey(o.tag), placed: clean(row.placed), logId: str(typed.log.id), room: ev.room };
  return o.remove
    ? o.done("removed", ev, `${o.tag} removed${where ? ` from ${where}` : ""} (typed row)`, null, typedInfo)
    : o.done("moved", ev, `${o.tag} moved ${where} → ${o.room} (typed row)`, null, typedInfo);
}

// the live scans written onto one hand-typed row: { removes, moves }
function claimsOf(project, row) {
  const logs = arr(project.dryingLogs).filter(isObj);
  const c = claimTypedRows(logs, liveScans(project).filter((e) => isObj(e.onRow))).get(row);
  return c || { removes: [], moves: [] };
}

/** The live scans on a hand-typed row (an object in this project's logs):
    { removes, moves }. */
export function rowScans(project, row) {
  return isObj(project) && isObj(row) && !row.scanId ? claimsOf(project, row) : { removes: [], moves: [] };
}

/** Undo a scan of a hand-typed row (the outcome recordScan returned): void
    its event; applyScans then takes what it wrote off the row, on every
    device. "restored" (the row showed that scan), "voided" (the row was
    changed since; left as it is) or "" (nothing to undo). */
export function undoTyped(project, outcome, ctx) {
  const t = isObj(outcome) && isObj(outcome.typed) ? outcome.typed : null;
  if (!isObj(project) || !t || !isObj(outcome.event)) return "";
  const id = str(outcome.event.id);
  let showing = false;
  for (const log of arr(project.dryingLogs)) {
    for (const row of arr(isObj(log) ? log.equipment : null)) {
      if (!isObj(row) || row.scanId || !fillHas(row, id)) continue;
      const f = fillOf(row);
      showing = f.removeId === id ? str(row.removed) === str(f.removed)
        : arr(f.moves).some((m) => isObj(m) && m.id === id && str(row.notes).split("\n").some((l) => isMoveLine(l, str(m.line))));
    }
  }
  if (!voidEvent(project, id, ctx)) return "";
  return showing ? "restored" : "voided";
}

// a typed row's scanFill gone once nothing is left on it
function tidyFill(row) {
  const f = row.scanFill;
  if (!isObj(f)) return;
  if (!arr(f.released).length) delete f.released;
  if (!f.removeId && !arr(f.moves).length && !f.released) delete row.scanFill;
}

/** The crew changed a hand-typed row by hand, so its scans give way:
    what = "removed" (Removed typed or cleared: its remove scans), "notes"
    (Notes edited: the move scans whose line is no longer in them) or "row"
    (✕: every scan on it). Those scans are voided, so they never write it
    again, and what the crew typed is the record: each void says why
    (`release`), and carries what they typed (`set`: the Removed, or the
    line a move line was rewritten as), so another phone's newer copy of the
    log ends up with it too. The row keeps those scans listed (scanFill
    `released`, or a move entry marked `released`) for settleTypedRow.
    Returns the voids. */
export function releaseTypedScans(project, row, ctx, what, before) {
  if (!isObj(project) || !isObj(row) || row.scanId) return [];
  const kind = what === "notes" || what === "row" ? what : "removed";
  const c = isObj(ctx) ? ctx : {};
  const mine = claimsOf(project, row);
  const f = fillOf(row);
  const lines = str(row.notes).split("\n");
  const lineOf = (e) => {
    const m = arr(f.moves).find((x) => isObj(x) && x.id === e.id);
    return m ? str(m.line) : moveLine(e);
  };
  const hits = kind === "removed" ? mine.removes
    : kind === "notes" ? mine.moves.filter((e) => !lines.some((l) => isMoveLine(l, lineOf(e))))
      : mine.removes.concat(mine.moves);
  if (!hits.length && kind === "notes") return [];
  // a move line rewritten rather than deleted: the crew's line (never another scan's own line)
  const puts = new Map();
  if (kind === "notes") {
    const gone = hits.map(lineOf);
    const tracked = arr(f.moves).filter(isObj).map((m) => str(m.line)).concat(mine.moves.map(lineOf)).filter((l) => gone.indexOf(l) < 0);
    const to = rewrites(gone, lines, tracked, row.placed, before);
    for (const e of hits) if (to.get(lineOf(e))) puts.set(e.id, to.get(lineOf(e)));
  }
  const hit = (id) => hits.some((e) => e.id === id);
  if (kind !== "row" && (hits.length || isObj(row.scanFill))) {
    if (!isObj(row.scanFill)) row.scanFill = { removeId: "", removed: "", was: null, moves: [] };
    const fill = row.scanFill;
    if (kind === "removed") {
      Object.assign(fill, { removeId: "", removed: "", was: null });
      fill.released = arr(fill.released).filter((r) => isObj(r) && !hit(r.id))
        .concat(hits.map((e) => ({ id: e.id, removed: str(row.removed) })));
    } else {
      fill.moves = arr(fill.moves).map((m) => (isObj(m) && hit(m.id) ? { id: str(m.id), line: puts.get(m.id) || "", released: true } : m))
        .filter(isObj);
      for (const e of hits) if (!fill.moves.some((m) => m.id === e.id)) fill.moves.push({ id: e.id, line: puts.get(e.id) || "", released: true });
    }
    tidyFill(row);
  } else if (isObj(row.scanFill)) {
    Object.assign(row.scanFill, { removeId: "", removed: "", was: null });
    row.scanFill.moves = arr(row.scanFill.moves).filter((m) => isObj(m) && !hit(m.id));
    tidyFill(row);
  }
  const why = (e) => {
    if (kind === "removed") return { release: kind, set: { removed: str(row.removed) } };
    return puts.has(e.id) ? { release: kind, set: { line: puts.get(e.id) } } : { release: kind };
  };
  const voids = hits.map((e, i) => pushVoid(project, e, { ...c, id: i && c.id ? `${c.id}-${i}` : c.id }, why(e)));
  if (kind === "removed" && isObj(row.scanFill)) {
    for (const r of arr(row.scanFill.released)) {
      const k = hits.findIndex((e) => e.id === r.id);
      if (k >= 0) r.v = voids[k].id;
    }
  }
  return voids;
}

/** A hand-typed row as the crew left it: move lines deleted or rewritten
    since give way (releaseTypedScans "notes"), and a scan an earlier edit
    replaced gets one more void wherever the row no longer says what its
    latest void does (a Removed retyped or picked in steps, a rewritten line
    changed again, deleted, or typed back), so every copy of the log ends on
    what the crew typed last, however many edits that took.
    opts.edit = "removed" | "notes": the crew just finished that edit (the
    field's change). Its voids carry this device's time, and after a
    Removed edit every scan it replaced says the new time, so whichever of
    them a copy of the row lists, it follows this edit. opts.before: the
    notes as the crew found them (which lines the edit added).
    No opts (the log opened or repainted): only what disagrees is carried,
    stamped just after the scan's latest void, so it never outranks a newer
    edit made on another device. Returns the voids pushed. */
export function settleTypedRow(project, row, ctx, opts) {
  if (!isObj(project) || !isObj(row) || row.scanId || !isObj(row.scanFill)) return [];
  const o = isObj(opts) ? opts : {};
  const edit = o.edit === "removed" || o.edit === "notes" ? o.edit : "";
  const before = edit === "notes" && typeof o.before === "string" ? o.before : undefined;
  const lines0 = str(row.notes).split("\n");
  const shown = (line) => lines0.some((l) => isMoveLine(l, line));
  const f0 = row.scanFill;
  const typedOf = (f) => (f.removeId && str(row.removed) === str(f.removed) && isObj(f.was) ? str(f.was.removed) : str(row.removed));
  const typed0 = typedOf(f0);
  const events = new Map(sortedEvents(project).map((e) => [e.id, e]));
  // a deleted line typed back: the scan's own line shows more often than the other listed moves' account for
  const backLine = (m) => {
    if (m.line || !events.has(str(m.id))) return false;
    const line = moveLine(events.get(str(m.id)));
    const showing = str(row.notes).split("\n").filter((l) => isMoveLine(l, line)).length;
    return showing > arr(row.scanFill.moves).filter((x) => isObj(x) && x !== m && str(x.line) === line).length;
  };
  // nothing to carry (the common case, on every repaint)
  if (!arr(f0.moves).some((m) => isObj(m) && ((m.line && !shown(str(m.line))) || (m.released && backLine(m))))
    && !arr(f0.released).some((r) => isObj(r) && str(r.removed) !== typed0)
    && !(edit === "removed" && arr(f0.released).length)) return [];
  const c = isObj(ctx) ? ctx : {};
  const out = releaseTypedScans(project, row, c, "notes", before);
  const f = row.scanFill;
  if (!isObj(f)) return out;
  const voidOf = latestVoids(project);
  const later = (a, b) => instant(a.at) > instant(b.at) || (instant(a.at) === instant(b.at) && byId(a.id, b.id) > 0);
  // a crew edit's restate takes the phone's clock; one that only lines a scan up with the row,
  // just after the newest void it follows, so it never beats a later edit made elsewhere
  const restate = (id, why, floor, crew) => {
    const last = voidOf.get(id);
    const at = crew || !Number.isFinite(floor) ? stampAfter(c.at, floor) : new Date(floor + 1).toISOString();
    const ev = pushVoid(project, { id, tag: last.tag }, { ...c, at }, why);
    voidOf.set(id, ev);
    out.push(ev);
  };
  // the Removed the crew left (under a remove scan that filled it since, the one it replaced).
  // A crew edit restates every scan whose latest void is older than the edit (opts.since: when
  // this step of it was made): another device may hold a newer void of any of them, and the
  // time typed now is the last word on all.
  const now = Number.isFinite(instant(c.at)) ? instant(c.at) : Date.now();
  const since = Number.isFinite(instant(o.since)) ? Math.min(instant(o.since), now) : now;
  const typed = typedOf(f);
  const regs = arr(f.released).filter(isObj).map((r) => ({ r, last: voidOf.get(str(r.id)) }))
    .filter((x) => x.last && x.last.release === "removed");
  let newest = null;
  for (const x of regs) if (!newest || later(x.last, newest)) newest = x.last;
  const floor = newest ? instant(newest.at) : NaN;
  for (const x of regs) {
    const says = isObj(x.last.set) ? str(x.last.set.removed) : null;
    if (says !== typed || (edit === "removed" && instant(x.last.at) < since)) restate(str(x.r.id), { release: "removed", set: { removed: typed } }, floor, edit === "removed");
    x.r.removed = typed;
    x.r.v = voidOf.get(str(x.r.id)).id;
  }
  const lines = str(row.notes).split("\n");
  const moved = arr(f.moves).filter((m) => isObj(m) && m.released && voidOf.get(str(m.id)) && voidOf.get(str(m.id)).release === "notes");
  const missing = moved.filter((m) => m.line && !lines.some((l) => isMoveLine(l, str(m.line))));
  const to = rewrites(missing.map((m) => str(m.line)), lines,
    arr(f.moves).filter((x) => isObj(x) && missing.indexOf(x) < 0).map((x) => str(x.line)), row.placed, before);
  for (const m of moved) {
    const last = voidOf.get(str(m.id));
    let put = null;
    if (missing.indexOf(m) >= 0) put = to.get(str(m.line)) || "";
    else if (backLine(m)) put = moveLine(events.get(str(m.id)));          // deleted, then typed back
    if (put === null) continue;
    restate(str(m.id), put ? { release: "notes", set: { line: put } } : { release: "notes" }, instant(last.at), edit === "notes");
    m.line = put;
  }
  tidyFill(row);
  return out;
}

/** Notes written over wholesale (the fill handle): a typed row's live move
    lines go back on at the next applyScans, as they do on a scanned row,
    and so does a line the crew rewrote one as. */
export function restoreMoveLines(row) {
  if (!isObj(row) || row.scanId || !isObj(row.scanFill)) return;
  const kept = arr(row.scanFill.moves).filter((m) => isObj(m) && m.released);
  for (const m of kept) {
    if (m.line && !str(row.notes).split("\n").some((l) => isMoveLine(l, str(m.line)))) row.notes = insertMoveLine(str(row.notes), str(m.line), row.placed);
  }
  row.scanFill.moves = kept;
  tidyFill(row);
}

// the time of this unit's latest scan on this job, epoch ms (NaN if none)
function lastScanMs(project, key) {
  let t = NaN;
  for (const e of liveScans(project)) if (tagKey(e.tag) === key && !(instant(e.at) <= t)) t = instant(e.at);
  return t;
}

function pushVoid(project, target, ctx, why) {
  const ev = newEvent(project, ctx, clean(target.tag), "void", "");
  ev.how = "";
  ev.voids = target.id;
  if (isObj(why)) Object.assign(ev, why);
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
    their typed rows (same tag, placed, not removed by now); skips deleted and
    archived jobs. The most recent wins: { jobId, label, since (UTC ISO),
    room } or null. `atMs`: the time it asks about (default now). */
export function openElsewhere(projects, tag, exceptJobId, atMs) {
  const key = tagKey(parseTag(tag) || tag);
  if (!key) return null;
  const list = Array.isArray(projects) ? projects : isObj(projects) ? Object.values(projects) : [];
  let best = null;
  const now = Number.isFinite(atMs) ? atMs : Date.now();
  const consider = (c) => {
    if (!best || c.since > best.since || (c.since === best.since && c.jobId < best.jobId)) best = c;
  };
  for (const p of list) {
    if (!isObj(p) || p.deleted === true || clean(p.archivedAt)) continue;
    if (exceptJobId && p.id === exceptJobId) continue;
    const label = jobLabel(p), jobId = str(p.id);
    for (const P of placements(p)) {
      // a scanned row whose Removed was typed (and has passed) is in, whatever the events say
      if (P.tagKey === key && outAt(p, P, now)) consider({ jobId, label, since: P.placedAt, room: P.room });
    }
    for (const log of arr(p.dryingLogs)) {
      for (const row of arr(isObj(log) ? log.equipment : null)) {
        if (!isObj(row) || row.scanId || tagKey(row.asset) !== key || !rowOutAt(row, now)) continue;
        const t = wallMs(row.placed);
        consider({ jobId, label, since: Number.isFinite(t) ? new Date(t).toISOString() : clean(row.placed), room: rowRoom(row) });
      }
    }
  }
  return best;
}

/* ---------- printing and picking ---------- */
/** The printed scan record: one row per live event, in time order —
    { at (Alaska wall time), tag, type, act, room, how, tech, by }. A move or
    remove shows the type its unit was placed with; a place that moved a unit
    already out reads "move", as does a scan that moved a hand-typed row.
    `placeIds` (optional) keeps only the events of those placements, and
    `logId` adds the scans of that log's hand-typed rows: one drying log's
    own record. */
export function scanRecord(project, placeIds, logId) {
  const typeOf = new Map(), moved = new Set(), owner = new Map();
  for (const P of placements(project)) {
    owner.set(P.placeId, P.placeId);
    for (const m of P.moves) { moved.add(m.id); owner.set(m.id, P.placeId); }
    if (P.removeId) owner.set(P.removeId, P.placeId);
  }
  const live = liveScans(project);
  // a hand-typed row's scans belong to the log that row is on
  const rowLog = new Map();
  const logs = arr(project && project.dryingLogs).filter(isObj);
  const claims = claimTypedRows(logs, live.filter((e) => isObj(e.onRow)));
  for (const log of logs) {
    for (const row of arr(log.equipment)) {
      const c = claims.get(row);
      if (c) for (const e of c.removes.concat(c.moves)) rowLog.set(e.id, str(log.id));
    }
  }
  const only = placeIds ? new Set(placeIds) : null;
  const out = [];
  for (const e of live) {
    const key = tagKey(e.tag);
    let type = clean(e.type);
    // a move another device's remove overtook (placements() drops it) still reads as a move, of the row it moved
    const dropped = e.act === "place" && !!e.from && !owner.has(e.id) && !isObj(e.onRow);
    const act = moved.has(e.id) || dropped || (isObj(e.onRow) && e.act === "place") ? "move" : e.act;
    if (act === "place" && type) typeOf.set(key, type);
    if (!type) type = typeOf.get(key) || labelOf(typeFromTag(e.tag));
    if (only) {
      const mine = isObj(e.onRow) ? !!logId && rowLog.get(e.id) === str(logId)
        : only.has(owner.get(e.id)) || (dropped && only.has(owner.get(str(e.from))));
      if (!mine) continue;
    }
    out.push({ at: wallTime(e.at), tag: clean(e.tag), type, act, room: clean(e.room), how: str(e.how), tech: str(e.tech), by: str(e.by) });
  }
  return out;
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
