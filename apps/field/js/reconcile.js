/* ============================================================
   Roybal Field Forms — billing reconcile (the nightly detector)
   ------------------------------------------------------------
   Pure logic. No DOM, no network, no clock (the caller passes
   `today`), no AI. Given one restoration job's blob and its
   QuickBooks Time rows, it compares what the job DOCUMENTS with
   what its invoices BILL and returns the lines an
   invoice.review_gaps proposal would add, plus hints a person
   should look at.

   Lines come from three sources only: the drying log's equipment
   rows (unit-days), QuickBooks Time hours inside the mitigation
   window (only when the invoices bill labor by the hour), and the
   owner's Cat 3 package (docs/Estimating_Rules_Draft.md §2.6-2.7;
   an item only when the job records that work). Count strings,
   photo tags, monitoring visits and undocumented days are hints,
   never quantities. A price comes only from this job's own invoice
   lines of the same class — never the price list; everything else
   is left unpriced for the office.

   Runs in the worker's billing.reconcile queue kind; the field app
   does not load it. Imports only dryingcalc.js, model.js and
   scans.js.
   ============================================================ */
import { equipClassOf } from "./dryingcalc.js";
import { jobType, lossTypesOf } from "./model.js";
import { applyScans } from "./scans.js";

export const DETECTOR = "billing.reconcile@0.1";

/* Stated on every proposal (plan 03 §7.13 "Its limits"), in plain words. */
export const LIMITS =
  "Limits: an internal leak check, not carrier-grade justification. Equipment days are 24-hour periods " +
  "from placed to removed, partial periods rounded up; one asset tag counts once. Typed counts and photo " +
  "tags are hints, never quantities. Labor is QuickBooks Time hours in the mitigation window, compared " +
  "only on hourly invoices. Cat 3 items become lines only with a record of the work. Materials are never " +
  "counted. Units differ by line (air movers EA, scrubbers DA). Equipment days with no reading are " +
  "flagged, never billed. Prices come only from this job's own invoices; the rest are unpriced.";

/* ---------- small helpers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => v != null && typeof v === "object";
const str = (v) => (v == null ? "" : String(v));
const filled = (v) => str(v).trim() !== "";
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);            // fincalc.js semantics
/* Rounding the way Postgres round(numeric, n) does it: half away from zero on
   the decimal the number prints as, so 1.005 → 1.01 (Math.round(n * 100) / 100
   says 1.00: the double sits just under the half). */
function roundTo(n, dp) {
  if (!Number.isFinite(n)) return 0;
  const [m, e = "0"] = String(Math.abs(n)).split("e");
  const k = Math.round(Number(`${m}e${Number(e) + dp}`));
  if (!Number.isSafeInteger(k)) return n;
  return (n < 0 ? -1 : 1) * Number(`${k}e-${dp}`) || 0;
}
const r2 = (n) => roundTo(n, 2);
/* qty × price for 2-dp figures, exactly: an integer count of ten-thousandths
   (1.5 × 85.05 is 127.575, which the doubles make 127.57499…). cents4 rounds
   such a count to cents once, half away from zero, as the executor's
   round(qty::numeric * price::numeric, 2) does. */
const tenThou = (qty, price) => Math.round(qty * 100) * Math.round(price * 100);
const cents4 = (t) => (t < 0 ? -1 : 1) * Math.floor((Math.abs(t) + 50) / 100) / 100 || 0;
const clip = (v, n) => { const t = str(v).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// a typed count ("2", "", "2 LGR") — tolerant, never negative
const count = (v) => { const n = parseFloat(str(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
// a reading cell holds a number (narrative.js's tolerant read)
const isNum = (v) => filled(v) && Number.isFinite(parseFloat(str(v).replace(/[^0-9.\-]/g, "")));

function money(n) {
  const [whole, cents] = Math.abs(r2(n)).toFixed(2).split(".");
  return (n < 0 ? "-$" : "$") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + cents;
}

/* ---------- dates: everything in Alaska wall-clock time ----------
   Equipment stamps come from datetime-local inputs ("YYYY-MM-DDTHH:MM", no
   zone) or date-only voice/fixture values; both are already Alaska wall time,
   so they are read as naive UTC and the server's zone never shifts them. A
   stamp WITH a zone (a photo's ts) is converted to Anchorage wall time first,
   so every millisecond figure here is on the same footing. */
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
let AK_FMT = null;

function akWall(t) {
  try {
    AK_FMT = AK_FMT || new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Anchorage", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = {};
    for (const x of AK_FMT.formatToParts(new Date(t))) p[x.type] = x.value;
    const ms = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    if (Number.isFinite(ms)) return { ms, date: `${p.year}-${p.month}-${p.day}` };
  } catch { /* no time-zone data: fall through to Alaska standard time */ }
  const ms = t - 9 * 3600000;
  return { ms, date: new Date(ms).toISOString().slice(0, 10) };
}

/** A stamp → { ms (Alaska wall time as naive UTC), date "YYYY-MM-DD" }, or null. */
function parseStamp(v) {
  const s = str(v).trim();
  const m = STAMP_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", zone] = m;
  if (zone) {
    const iso = `${y}-${mo}-${d}T${hh.padStart(2, "0")}:${mi.padStart(2, "0")}:${ss.padStart(2, "0")}` +
      (/^z$/i.test(zone) ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2"));
    const t = Date.parse(iso);
    return Number.isFinite(t) ? akWall(t) : null;
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  const date = `${y}-${mo}-${d}`;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return { ms, date };
}
const validDate = (v) => DATE_RE.test(str(v)) && !!parseStamp(v);
const dateOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => dateOfMs(parseStamp(date).ms + n * DAY_MS);
const daysApart = (a, b) => Math.round((parseStamp(b).ms - parseStamp(a).ms) / DAY_MS);
/* Hours between two wall-clock stamps, less the hour the spring change skips
   (03-07 10:00 → 03-08 10:30 ran 23.5 h, not 24.5). Never plus the fall's
   repeated hour: a 24-hour wall span stays one period, so the count only
   ever shrinks toward what really ran. 1 = the stamp is in daylight time. */
const akDst = (w) => (akWall(w + 9 * 3600000).ms !== w ? 1 : 0);
const wallHours = (a, b) => (b - a) / 3600000 - Math.max(0, akDst(b) - akDst(a));
const mmdd = (date) => str(date).slice(5);
const span = (a, b) => (!a ? "" : !b || a === b ? mmdd(a) : `${mmdd(a)}→${mmdd(b)}`);
const minOf = (xs) => xs.reduce((a, b) => (b < a ? b : a));
const maxOf = (xs) => xs.reduce((a, b) => (b > a ? b : a));

/* ---------- equipment: unit rows → unit-days by class ---------- */
const CLASSES = ["dehu", "airMover", "scrubber", "heater"];
const COUNT_KEY = { dehu: "dehu", airMover: "am", scrubber: "scrub" };     // the psychro row has no heater column
const NOUN = { dehu: "dehu", airMover: "air-mover", scrubber: "scrubber", heater: "heater" };
const TRH = ["outT", "outRH", "refT", "refRH", "affT", "affRH"];
// the SOP's interim billing unit: 24-hour periods, a partial period rounds up, minimum 1
const unitDays = (hours) => Math.max(1, Math.ceil(hours / 24 - 1e-9));
// a type of nothing, "N/A", "na", "none" or "-" is a placeholder row (or the blank row every new log seeds), not a machine
const placeholderType = (t) => /^(n\/?a|none|-)?$/.test(str(t).replace(/\s+/g, "").toLowerCase());

/* Scanned equipment (scans.js): the scan events are the record and a
   drying log's scanned rows are derived from them, so they are derived
   again here, on a copy of the logs, before anything is counted. The blob
   the worker reads may hold rows a newer copy of a log dropped, or an undo
   not yet written into the rows. The job itself is never changed. */
function withScans(p) {
  const rowScanned = (log) => obj(log) && arr(log.equipment).some((e) => obj(e) && filled(e.scanId));
  if (!arr(p.equipmentScans).length && !arr(p.dryingLogs).some(rowScanned)) return p;
  const copy = { ...p, dryingLogs: JSON.parse(JSON.stringify(arr(p.dryingLogs))) };
  try { applyScans(copy); } catch { return p; }
  return copy;
}

function equipmentFacts(job, today = "") {
  const p = withScans(job);
  // a removed or dry-out finish stamp after today has not happened yet (end of today, Alaska)
  const cutoff = validDate(today) ? parseStamp(today).ms + DAY_MS : Infinity;
  const rows = [];          // counted rows
  const open = [];          // classified rows that cannot be measured (left out of the count)
  const unclassified = [];
  const logs = [];          // per log: id, dry-out dates, placed/removed dates
  const placedDates = [], removedDates = [];
  arr(p.dryingLogs).forEach((log, li) => {
    if (!obj(log)) return;
    const logId = clip(log.id, 64) || `log${li + 1}`;
    const finish = parseStamp(log.dryoutFinish);
    const info = { id: logId, start: str(log.dryoutStart), finish: str(log.dryoutFinish), placed: [], removed: [] };
    logs.push(info);
    arr(log.equipment).forEach((e, i) => {
      if (!obj(e)) return;
      // skipped whole and without a hint: its stamps bound no window either
      if (placeholderType(e.type)) return;
      const type = clip(e.type, 80), asset = clip(e.asset, 40);
      // a scanned row keeps its id when rows are added, removed or rebuilt; a typed row has only its place
      const id = filled(e.scanId) ? `${logId}#scan:${clip(e.scanId, 64)}` : `${logId}#eq${i}`;
      const placed = parseStamp(e.placed), removed = parseStamp(e.removed);
      if (placed) { info.placed.push(placed.date); placedDates.push(placed.date); }
      if (removed) { info.removed.push(removed.date); removedDates.push(removed.date); }
      const name = [asset, type, clip(e.location, 40)].filter(Boolean).join(", ");
      const cls = equipClassOf(type);
      if (!cls) { unclassified.push({ kind: "equipment_row", id, label: clip(name, 120) }); return; }
      const hrs = num(e.hours);
      let start = null, end = null, hours = 0, basis = "";
      if (hrs > 0 && (e._manualHrs === true || (!placed && !removed))) {
        hours = hrs; basis = "manual hours";
        // typed hours ran in real time: the end goes on the wall clock (a spring change moves it an hour on)
        if (placed) { start = placed.ms; end = placed.ms + hrs * 3600000; end += 3600000 * Math.max(0, akDst(end) - akDst(start)); }
      } else if (placed && removed && removed.ms >= placed.ms) {
        start = placed.ms; end = removed.ms; hours = wallHours(start, end); basis = "placed to removed";
      } else if (placed && !removed && finish && finish.ms >= placed.ms) {
        start = placed.ms; end = finish.ms; hours = wallHours(start, end); basis = "placed to dry-out finish";
      } else {
        // still running (no removed, no dry-out finish) or stamps that cannot be measured
        open.push({ cls, id, asset: asset.toLowerCase(), name, startDate: placed && !filled(e.removed) ? placed.date : "" });
        return;
      }
      if (end != null && end > cutoff) {
        // an end stamp ahead of today (a planned pickup, a date slip): still running, not measured
        open.push({ cls, id, asset: asset.toLowerCase(), name, startDate: placed ? placed.date : "" });
        return;
      }
      const startDate = start != null ? dateOfMs(start) : "", endDate = end != null ? dateOfMs(end) : "";
      rows.push({
        cls, id, logId, asset: asset.toLowerCase(), start, end, hours, basis, startDate, endDate,
        ref: { kind: "equipment_row", id, label: clip(`${name}: ${span(startDate, endDate) || basis}, ${plural(unitDays(hours), "day")}`, 120), ...(startDate ? { date: startDate } : {}) },
      });
    });
  });

  /* Unit-days per class. Rows pool across every drying log (a second log from
     "+ New" splits the rows, SOP §6.2). The same asset tag in the same class
     with overlapping or touching times is one machine: its intervals union
     before rounding (both packet counters count rows, not machines). A tagged
     row with hours but no placed time counts only where it is larger than the
     tag's other rows. */
  const days = { dehu: 0, airMover: 0, scrubber: 0, heater: 0 };
  const byAsset = new Map();   // cls|asset -> its timed rows and its largest untimed (manual hours, no placed) figure
  for (const r of rows) {
    if (!r.asset) { days[r.cls] += unitDays(r.hours); continue; }
    const k = r.cls + "|" + r.asset;
    if (!byAsset.has(k)) byAsset.set(k, { cls: r.cls, timed: [], untimed: 0 });
    const a = byAsset.get(k);
    if (r.start != null) a.timed.push(r); else a.untimed = Math.max(a.untimed, unitDays(r.hours));
  }
  for (const a of byAsset.values()) {
    a.timed.sort((x, y) => x.start - y.start);
    let g = null, timed = 0;
    for (const r of a.timed) {
      if (g && r.start <= g.end) { g.end = Math.max(g.end, r.end); continue; }
      if (g) timed += unitDays(wallHours(g.start, g.end));
      g = { start: r.start, end: r.end };
    }
    if (g) timed += unitDays(wallHours(g.start, g.end));
    // a row with hours but no placed time has no place on the clock: it never adds to the same tag's other rows
    days[a.cls] += Math.max(timed, a.untimed);
  }

  // distinct machines of a class (asset tags once; an untagged row is its own machine)
  const machines = (cls) => {
    const set = new Set();
    for (const r of [...rows, ...open]) if (r.cls === cls) set.add(r.asset ? "a:" + r.asset : "r:" + r.id);
    return set.size;
  };
  // distinct machines of a class on one date (open rows run on from their placed date)
  const onDate = (cls, date) => {
    const set = new Set();
    for (const r of rows) if (r.cls === cls && r.startDate && r.startDate <= date && date <= r.endDate) set.add(r.asset ? "a:" + r.asset : "r:" + r.id);
    for (const r of open) if (r.cls === cls && r.startDate && r.startDate <= date) set.add(r.asset ? "a:" + r.asset : "r:" + r.id);
    return set.size;
  };

  /* Count strings: one psychro row per chamber per visit (SOP §7), so per
     date take the max per class, and only rows that carry a reading (a new log
     seeds an empty row dated today). */
  const counts = new Map();   // date -> { dehu, airMover, scrubber, logId }
  arr(p.dryingLogs).forEach((log, li) => {
    for (const r of arr(obj(log) ? log.readings : null)) {
      if (!obj(r) || !validDate(r.date) || !TRH.some((k) => isNum(r[k]))) continue;
      const d = counts.get(r.date) || { dehu: 0, airMover: 0, scrubber: 0, logId: clip(log.id, 64) || `log${li + 1}` };
      for (const cls of Object.keys(COUNT_KEY)) d[cls] = Math.max(d[cls], count(r[COUNT_KEY[cls]]));
      counts.set(r.date, d);
    }
  });
  const countOn = (cls, date) => (COUNT_KEY[cls] && counts.has(date) ? counts.get(date)[cls] : 0);

  const hints = [];
  if (open.length) {
    hints.push({ kind: "open_equipment_row",
      label: clip(`${plural(open.length, "equipment row")} left out of the count (no removed time and no dry-out finish, an end after today, or times that cannot be measured): ${open.map((r) => r.name).join("; ")}`, 200),
      refs: open.slice(0, 10).map((r) => ({ kind: "equipment_row", id: r.id, label: clip(r.name, 120) })) });
  }
  if (unclassified.length) {
    hints.push({ kind: "unclassified_equipment",
      label: clip(`${plural(unclassified.length, "equipment row")} with a type no class matches, not counted: ${unclassified.map((r) => r.label).join("; ")}`, 200),
      refs: unclassified.slice(0, 10) });
  }
  /* Cross-check (never a quantity — counts "are not the billing record", SOP
     §6.4): on the dates the log has readings, compare the typed counts with the
     machines the unit rows had on. */
  for (const cls of Object.keys(COUNT_KEY)) {
    let typed = 0, fromRows = 0, n = 0;
    for (const [date, d] of counts) {
      if (!d[cls] && !onDate(cls, date)) continue;
      typed += d[cls]; fromRows += onDate(cls, date); n++;
    }
    if (!typed) continue;
    const refs = [...counts.keys()].filter((d) => counts.get(d)[cls] > 0).sort().slice(0, 10)
      .map((d) => ({ kind: "psych_row", id: `${counts.get(d).logId}@${d}`, label: `${counts.get(d)[cls]} ${NOUN[cls]} typed ${mmdd(d)}`, date: d }));
    if (!machines(cls)) {
      hints.push({ kind: "count_strings_only",
        label: clip(`The readings count ${typed} ${NOUN[cls]}-days over ${plural(n, "date")} but no ${NOUN[cls]} unit row exists; typed counts are not billed`, 200), refs });
    } else if (Math.abs(typed - fromRows) >= Math.max(2, 0.2 * Math.max(typed, fromRows))) {
      hints.push({ kind: "log_disagreement",
        label: clip(`${cap(NOUN[cls])}: the readings count ${typed} unit-days on ${plural(n, "date")}; the unit rows show ${fromRows} on those dates`, 200), refs });
    }
  }

  return { rows, open, days, logs, machines, onDate, countOn, counts, placedDates, removedDates, hints };
}

/** Documented unit-days by equipment class (24-hour periods, partial rounded
    up, minimum 1 per row; same-asset overlaps unioned), with the rows behind
    each figure and the equipment hints. With `today` ("YYYY-MM-DD", Alaska), a
    row whose end is after it is still running: left out, with the hint. */
export function equipmentUnitDays(project, { today = "" } = {}) {
  const eq = equipmentFacts(obj(project) ? project : {}, today);
  const out = {};
  for (const cls of CLASSES) out[cls] = { days: eq.days[cls], rows: eq.rows.filter((r) => r.cls === cls).map((r) => r.ref) };
  out.hints = eq.hints;
  return out;
}

/* ---------- invoice lines → class ----------
   NOT deployedCounts on the description: /hepa/ would send "HEPA Vacuuming"
   and "Add for HEPA filter" to scrubbers, /mover/ "Adhesive remover", /heat/
   "sheathing", /fan/ "Exhaust fan". The Fairbanks WTR selector decides first
   (supabase/migrations-archive/110_price_list_data.sql), then the wording. */
const CODE_CLASS = [
  ["dehu", /^DHM(?!B)/],                     // DHMB is the booster
  ["airMover", /^DRY[+-]{0,2}$/],            // not DRYMA / DRYSA (adapters) or DRYN… (tear-out)
  ["scrubber", /^NAFAN/],
  ["heater", /^(HEAT|HTAM(?!B)|HTIP|HTX|FURN)/],   // not HTAMB (booster), HTBL (blanket), HTSC (controls)
];
const NO_MONITOR = /\bno\s+monit\w*\.?/g;    // "- No monitor." is part of the equipment wording, not a monitoring line
/* After the selector, these words veto a class: the price list's "Water heater
   - Detach" (WHD), its platform and "Sensored control system for electric heat
   drying" (HTSC) would otherwise read as heaters by their "heater" / "heat
   drying", and could become the rate line. Not a bare "control": "Dehumidifier
   w/environmental control" is a dehu. */
const NOT_EQUIPMENT = /decontam|set ?up|take ?down|monitor|filter|vacuum|cartridge|respirator|remover|sheathing|exhaust|adapter|snout|booster|water\s*heater|sensored|control\s*system/;
const DESC_CLASS = [
  ["dehu", /\bdehu|\blgr\b|desiccant/],
  ["scrubber", /air\s*scrub|negative\s*air|neg\.?\s*air|\bafd\b|air\s*filtration\s*device/],
  ["heater", /\bheater|heat\s*drying|drying\s*furnace|thermal\s*(air\s*mover|exchanger)|infrared\s*heat|heat\s*panel/],
  ["airMover", /\bair\s*movers?\b|axial\s*fan|centrifugal|\bvelo\b/],
];
const HR_UNIT = /^(hr|hrs|hour|hours)$/i;
const lineText = (it) => str(obj(it) ? it.desc : "").toLowerCase().replace(NO_MONITOR, " ");
const lineCode = (it) => str(obj(it) ? it.code : "").trim().toUpperCase();

export function invoiceLineClass(item) {
  if (!obj(item)) return null;
  if (/^(hr|hrs|hour|hours|sf|lf)$/i.test(str(item.unit).trim())) return null;
  const code = lineCode(item);
  for (const [cls, re] of CODE_CLASS) if (re.test(code)) return cls;
  const d = lineText(item);
  if (!d.trim() || NOT_EQUIPMENT.test(d)) return null;
  for (const [cls, re] of DESC_CLASS) if (re.test(d)) return cls;
  return null;
}

const SENT = ["sent", "viewed", "partially_paid", "paid"];

function invoiceFacts(p) {
  const all = arr(p.invoices).map((inv, idx) => ({ inv, idx })).filter((x) => obj(x.inv));
  const nonVoid = all.filter(({ inv }) => inv.status !== "void");
  // billed figures come only from non-void T&M invoices (a contract figure is not itemised billing)
  const when = (inv) => (validDate(inv.invoiceDate) ? inv.invoiceDate : (parseStamp(inv.createdAt) || {}).date || "");
  const billable = nonVoid.filter(({ inv }) => inv.billingModel !== "contract").sort((a, b) =>
    when(a.inv) < when(b.inv) ? -1 : when(a.inv) > when(b.inv) ? 1
      : str(a.inv.createdAt) < str(b.inv.createdAt) ? -1 : str(a.inv.createdAt) > str(b.inv.createdAt) ? 1 : a.idx - b.idx);
  const lines = [];
  billable.forEach(({ inv }, rank) => arr(inv.items).forEach((it, i) => {
    if (!obj(it)) return;
    const qty = num(it.qty), price = num(it.price);
    lines.push({ it, inv, i, rank, cls: invoiceLineClass(it), hr: HR_UNIT.test(str(it.unit).trim()),
      qty, price, text: lineText(it), code: lineCode(it),
      // a credit (negative qty or price, the app's convention, or "Credit - …" wording) takes units off
      credit: qty < 0 || price < 0 || /^\s*credit\b/i.test(str(it.desc)) });
  }));
  /* The rate invoice (its terms and O&P ride the new draft): the newest T&M
     invoice holding an equipment line, else simply the newest. A rebuild
     invoice written after the mitigation one is not where the rates are, nor
     is one that holds only a credit. */
  const equipRank = lines.reduce((a, l) => (l.cls && !l.credit ? Math.max(a, l.rank) : a), -1);
  const contracts = nonVoid.filter(({ inv }) => inv.billingModel === "contract");
  return {
    billable: billable.map((x) => x.inv),
    rateInvoice: equipRank >= 0 ? billable[equipRank].inv : billable.length ? billable[billable.length - 1].inv : null,
    lines,
    // what the Cat 3 package counts as billed: any non-void line, a contract's scope lines included
    anyLines: nonVoid.flatMap(({ inv }) => arr(inv.items).filter(obj)
      .map((it) => ({ cls: invoiceLineClass(it), text: lineText(it), code: lineCode(it) }))),
    sent: nonVoid.some(({ inv }) => SENT.includes(inv.status) || filled(inv.qboInvoiceId)),
    /* A contract's scope lines are billed (its set amount covers them), as the
       Cat 3 package already counts them; their prices are never a rate. */
    contracts: contracts.map(({ inv }) => inv),
    contractLines: contracts.flatMap(({ inv }) => arr(inv.items).map((it, i) => ({ it, inv, i })).filter((x) => obj(x.it))
      .map((x) => ({ ...x, cls: invoiceLineClass(x.it), qty: num(x.it.qty) }))),
    // equipment priced inside a drying bid, or a set amount with no itemised scope: unit-days can't be compared
    equipCovered: nonVoid.flatMap(({ inv }) => arr(inv.items).map((it, i) => ({ it, inv, i })).filter((x) => obj(x.it) && dryingBid(x.it)))
      .concat(contracts.filter(({ inv }) => !arr(inv.items).some((it) => obj(it) && filled(it.desc))).map(({ inv }) => ({ inv, i: -1 }))),
  };
}
/* Xactimate prices drying as one item per SF/CF: "Structural drying per SF -
   Class 2 (Bid Item)" (WTR DRY1-4, DRYC, DRYCN, their …CF; APP's DRYC is a
   clothes dryer, EA) or the WTR lump sum. Not every "(Bid Item)": "Thermal
   imaging - (Bid Item)" and "Drywall (Bid Item)" cover no equipment. */
const DRYING_BID_CODE = /^DRY([1-4]|CN?)(CF)?$/;
const dryingBid = (it) => /structural\s*drying/i.test(str(it.desc))
  || (DRYING_BID_CODE.test(lineCode(it)) && /^(sf|cf)$/i.test(str(it.unit).trim()))
  || /water\s*extraction\s*&\s*remediation\s*\((bid\s*item|agreed\s*price)\)/i.test(str(it.desc));

/* Labor is comparable only when the T&M invoices bill work by the hour. A
   line priced per SF/LF/… or per piece of work ("Tear out wet drywall…",
   "Remove Toilet") carries its labor inside the unit price, so documented
   hours would read as unbilled when they are not. */
const WORK_UNIT = /^(sf|lf|sy|cf|sq|cy)$/i;
const WORK_VERB = /\b(remove|tear\s*out|install|replace|apply|clean(ing)?|haul|detach|reset|mask|seal|paint|demo(lition)?|extract(ion)?|muck|cut|bag)\b/i;
const unitPricedWork = (l) => !l.cls && !l.hr &&
  (WORK_UNIT.test(str(l.it.unit).trim().replace(/\.$/, "")) || WORK_VERB.test(str(l.it.desc)));
const invName = (inv) => (filled(inv.invoiceNo) ? `invoice ${clip(inv.invoiceNo, 30)}` : validDate(inv.invoiceDate) ? `the invoice of ${inv.invoiceDate}` : "a draft invoice");
const lineRef = (l) => ({ kind: "invoice_line", id: `${clip(l.inv.id, 64)}#${l.i}`,
  label: clip(`${invName(l.inv)} line ${l.i + 1}: ${r2(l.qty)} ${clip(l.it.unit, 6)} ${clip(l.it.desc, 60)}${l.price > 0 ? " @ " + money(l.price) : ""}`, 120) });

/* The rate: the newest invoice holding a line of the class, its largest-qty
   line (plan 03 §7.13: the rate already on the job's invoice). */
function pickRate(cands) {
  let best = null;
  for (const l of cands) {
    if (l.credit) continue;   // a credit's wording and sign are never the new line's
    if (!best || l.rank > best.rank || (l.rank === best.rank && l.qty > best.qty)) best = l;
  }
  return best;
}
/* A credit takes units off, however it is written; -|qty| can under-count a
   lump credit, which misses a gap rather than inventing one. */
const billedQty = (l) => (l.credit ? -Math.abs(l.qty) : l.qty);
const UNITS = ["EA", "DA", "HR", "SF", "LF", "LS"];
function unitOf(u, fallback) {
  const t = str(u).trim().toUpperCase().replace(/\.$/, "");
  if (UNITS.includes(t)) return t;
  if (/^DAYS?$/.test(t)) return "DA";
  if (/^(HRS|HOURS?)$/.test(t)) return "HR";
  if (t === "EACH") return "EA";
  return fallback;
}
function multipleRates(cands, what) {
  const prices = [...new Set(cands.filter((l) => !l.credit && l.price > 0).map((l) => r2(l.price)))];
  if (prices.length < 2) return null;
  return { kind: "multiple_rates",
    label: clip(`${cap(what)} lines carry ${prices.length} rates (${prices.sort((a, b) => a - b).map(money).join(", ")}); the newest invoice's largest line set the rate`, 200),
    refs: cands.slice(0, 10).map(lineRef) };
}

/* A B3 line from a documented quantity and the job's own rate (if any). */
function buildLine({ finding_id, cls, qty, rate, fallback, basis, refs }) {
  const priced = !!rate && r2(rate.price) > 0 && qty != null;
  const price = priced ? r2(rate.price) : null;
  const allRefs = refs.slice(0, rate ? 9 : 10);
  if (rate) allRefs.push(lineRef(rate));
  return {
    finding_id, class: cls,
    desc: clip(rate && filled(rate.it.desc) ? rate.it.desc : fallback.desc, 300),
    qty: qty == null ? null : r2(qty),
    unit: unitOf(rate ? rate.it.unit : "", fallback.unit),
    price,
    amount: priced ? cents4(tenThou(r2(qty), price)) : null,
    room: clip(rate ? rate.it.room : "", 60),
    code: clip(rate && filled(rate.it.code) ? rate.it.code : fallback.code || "", 20),
    basis: clip(basis, 300),
    refs: allRefs,
  };
}
const rateText = (rate, what) => (!rate ? ` No ${what} line on this job's invoices to take a rate from.`
  : r2(rate.price) > 0 ? ` Rate from ${invName(rate.inv)} line ${rate.i + 1}.` : ` ${invName(rate.inv)} line ${rate.i + 1} has no price.`);

/* Default wording when the job has no line of the class (the price list's own
   words, for the office to price — never its price). */
const EQUIP_DEFAULT = {
  dehu: { desc: "Dehumidifier (per 24 hr period) - 70-109 ppd - No monitor.", unit: "EA", code: "DHM>" },
  airMover: { desc: "Air mover axial fan-up to 1/2 (per 24 hr period)-No monit.", unit: "EA", code: "DRY+" },
  scrubber: { desc: "Negative air fan/Air scrubber (24 hr period) - No monit.", unit: "DA", code: "NAFAN" },
  heater: { desc: "Heat drying - thermal air mover - Electric", unit: "DA", code: "HTAM" },
};
const FINDING = { dehu: "equip:dehu", airMover: "equip:air_mover", scrubber: "equip:scrubber", heater: "equip:heater" };
const LABOR_DEFAULT = { desc: "Water Extraction & Remediation Technician - per hour", unit: "HR", code: "LAB" };

/* The owner's Cat 3 package (Estimating_Rules_Draft.md §2.6, + §2.7 HEPA
   filter, + antimicrobial). An item is billed when its wording or selector is
   on any non-void line; the four PPE items also when the job bills
   Xactimate's PPE kit ("Add for personal protective equipment…", PPE/PPE+).
   A missing item is a line only with a record of the work (see the detector,
   step 4): unpriced, no quantity, except the HEPA filter (one per scrubber).
   `doc` widens the words a record may use; `ppe` items are never read off a
   photo (a tag cannot show a box of gloves was used up); `short` names the
   item in the one-hint list, which must fit all ten in 200 characters. */
const CAT3 = [
  { key: "containment", what: "containment", desc: /containment|barrier|zip(per)?\s*wall|poly\s*wall/, code: /^BARR/,
    rec: /containment|zip(per)?\s*wall|poly\s*wall/,      // a bare "barrier" bills containment on an invoice line, never records it
    doc: /poly(ethylene)?\s*(sheet|sheeting|wall|barrier)|zip\s*wall/,
    fallback: { desc: "Containment Barrier/Airlock/Decon. Chamber", unit: "SF", code: "BARR" } },
  { key: "negative_air", what: "negative air / air scrubber", short: "negative air", scrubber: true,
    fallback: { desc: "Negative air fan/Air scrubber (24 hr period) - No monit.", unit: "DA", code: "NAFAN" } },
  { key: "floor_protection", what: "floor protection", desc: /floor\s*protection|self-adhesive.*(film|plastic)/, code: /^MASKF/,
    fallback: { desc: "Floor protection - self-adhesive plastic film", unit: "SF", code: "MASKFL" } },
  { key: "hepa_vacuum", what: "HEPA vacuuming", desc: /hepa\s*vacuum/, code: /^HEPA(VA|F|W)/,
    fallback: { desc: "HEPA Vacuuming - Detailed - (PER SF)", unit: "SF", code: "HEPAVAS" } },
  { key: "suits", what: "Tyvek suits", short: "suits", desc: /tyvek|coverall|protective\s*suit|disposable\s*suit/, ppe: true,
    fallback: { desc: "Tyvek suit - disposable coverall", unit: "EA" } },
  { key: "cartridges", what: "HEPA/P100 respirator cartridges", short: "cartridges", desc: /cartridge|p100/, code: /^PPERC/, ppe: true,
    fallback: { desc: "Respirator cartridge - HEPA only (per pair)", unit: "EA", code: "PPERC" } },
  { key: "gloves", what: "gloves", desc: /\bgloves?\b(?!\s*bags?)/, code: /^PPEG/, ppe: true,
    fallback: { desc: "Personal protective gloves - Disposable (per pair)", unit: "EA", code: "PPEG6" } },
  { key: "boot_covers", what: "boot covers", desc: /boot\s*cover|shoe\s*cover/, ppe: true,
    fallback: { desc: "Boot covers - disposable (per pair)", unit: "EA" } },
  { key: "hepa_filter", what: "HEPA filter replacement", short: "HEPA filter", desc: /hepa\s*filter/, code: /^FHEPA/, scrubbers: true,
    fallback: { desc: "Add for HEPA filter (for negative air exhaust fan)", unit: "EA", code: "FHEPA" } },
  { key: "antimicrobial", what: "antimicrobial", desc: /anti-?microbial|biocide|disinfect/,
    fallback: { desc: "Apply anti-microbial agent to the affected surfaces", unit: "SF", code: "GRM" } },
];
// the kit, not a single item: "Personal protective gloves" and "…mask (N-95)" are PPEG6 / PPEM lines of their own
const PPE_KIT = { desc: /personal\s+protective\s+equipment|\bppe\b/, code: /^PPE\+?$/ };
const onInvoice = (lines, item) => lines.some((l) => (item.scrubber ? l.cls === "scrubber"
  : item.desc.test(l.text) || (item.code && item.code.test(l.code))
    || (item.ppe && (PPE_KIT.desc.test(l.text) || PPE_KIT.code.test(l.code)))));
/* Building-envelope wording is not containment: a wall opened to the studs
   shows its poly vapor barrier, and a rebuild change order replaces it (or the
   Tyvek house wrap). The phrase goes, with its poly/plastic qualifier, before
   any item reads the text. */
const ENVELOPE = /(?:\b(?:\d+\s*-?\s*mil\s+)?(?:poly(?:ethylene)?|plastic)\s*(?:sheeting|sheet|film)?\s*[\/-]?\s*)?\b(?:vapou?r|moisture|weather|air|radiant)\s*(?:barriers?|retarders?)\b|\b(?:tyvek\s*)?(?:house|home)\s*wrap\b/g;
// a clause that says the work was NOT done ("no containment needed", "floor protection not required") records nothing
const NEGATED = /\b(?:no|not|without|none|never|n\/a)\b|n't\b/;
// does this text (a photo tag, a change order, the Cat 3 justification) record the item's work? (`rec` narrows `desc` for records)
const records = (item, text) => !!item.desc && str(text).toLowerCase().replace(ENVELOPE, " ")
  .split(/[;.!?\n]|,|\s[—–-]\s/).some((c) => !NEGATED.test(c) && ((item.rec || item.desc).test(c) || (!!item.doc && item.doc.test(c))));

/* Photo work tags the office bills (plan 03 §7.13 check b), matched with the
   Cat 3 item's own wording. The tagger puts "containment erected" in workDone
   and building materials in materials: read both. */
const PHOTO_WORK = CAT3.filter((c) => ["containment", "antimicrobial", "hepa_vacuum"].includes(c.key));

/* ---------- scope ---------- */
const STAGES_IN = ["in_progress", "on_hold", "final", "done"];

/** Is this job one the nightly check reconciles? A manual run (payload.job_ids)
    ignores archivedAt, paid and the board stage, but still needs a restoration
    water job with an invoice. */
export function scopeOf(project, { boardStage = null, manual = false } = {}) {
  const p = obj(project) ? project : {};
  const no = (reason) => ({ ok: false, reason });
  if (p.deleted === true) return no("deleted");
  if (jobType(p) !== "restoration") return no("not_restoration");
  if (!lossTypesOf(p).includes("water")) return no("not_water");
  if (!manual && filled(p.archivedAt)) return no("archived");
  const nonVoid = arr(p.invoices).filter((inv) => obj(inv) && inv.status !== "void");
  if (!nonVoid.some((inv) => inv.billingModel !== "contract")) return no(nonVoid.length ? "contract" : "no_invoice");
  if (!manual && nonVoid.every((inv) => inv.status === "paid")) return no("paid");
  if (!manual && filled(boardStage) && !STAGES_IN.includes(str(boardStage))) return no("stage");
  return { ok: true, reason: "in_scope" };
}

/* ---------- labor ---------- */
/* The mitigation window: from the earliest of the date of loss, the first
   equipment placed and the first dry-out start, through the latest of the
   last equipment removed and the last dry-out finish, plus 2 days — closed
   the day before the Labor Log's start date when that falls inside it. */
function mitigationWindow(p, eq) {
  const starts = [...eq.placedDates], ends = [...eq.removedDates];
  const dol = parseStamp(p.dateOfLoss);
  if (dol) starts.push(dol.date);
  for (const log of eq.logs) {
    const s = parseStamp(log.start), f = parseStamp(log.finish);
    if (s) starts.push(s.date);
    if (f) ends.push(f.date);
  }
  if (!starts.length || !ends.length) return null;
  const start = minOf(starts);
  let end = addDays(maxOf(ends), 2);
  // the Labor Log's start date opens reconstruction: the +2-day tail never reaches past it
  const rebuild = obj(p.laborLog) && validDate(p.laborLog.startDate) ? p.laborLog.startDate : "";
  if (rebuild && rebuild > start && rebuild <= end) end = addDays(rebuild, -1);
  return end < start ? null : { start, end };
}

function laborFacts(p, timeEntries, win, today) {
  const hints = [];
  const qb = [], other = [];
  for (const r of arr(timeEntries)) {
    if (!obj(r)) continue;
    (r.source === "qbtime" ? qb : other).push(r);
  }
  if (other.length) {
    const h = r2(other.reduce((a, r) => a + Math.max(0, num(r.hours)), 0));
    hints.push({ kind: "manual_hours_present",
      label: clip(`${plural(other.length, "hour row")} (${h} h) not from QuickBooks Time are not counted`, 200),
      refs: other.slice(0, 10).map((r) => ({ kind: "time_entry", id: clip(r.id, 64), label: clip(`${r2(Math.max(0, num(r.hours)))} h ${mmdd(r.date)}`, 120), ...(validDate(r.date) ? { date: r.date } : {}) })) });
  }
  // one row per QuickBooks timesheet (nothing in the table stops a duplicate): keep the latest write
  const byTs = new Map();
  for (const r of qb) {
    const k = filled(r.qbTimesheetId) ? "ts:" + str(r.qbTimesheetId).trim() : "id:" + str(r.id);
    const prev = byTs.get(k);
    if (!prev || str(r.updated_at) > str(prev.updated_at)) byTs.set(k, r);
  }
  const jc = clip(p.qbJobcodeId, 64);
  let source = "QuickBooks Time", entries = [...byTs.values()].map((r) => ({
    ref: { kind: "time_entry", id: clip(r.id, 64) }, date: str(r.date).trim(), hours: Math.max(0, num(r.hours)), updated: str(r.updated_at),
  }));
  let summaryRef = { kind: "time_entries", id: jc || "time_entries" };
  if (!entries.length) {
    // no jobcode or no rows yet (paper-lane hours live only in the blob until P3): the Labor Log snapshot
    const ll = obj(p.laborLog) ? p.laborLog : {};
    const llId = clip(ll.id, 64) || "laborLog";
    const synced = (parseStamp(ll.syncedAt) || {}).date || "";
    source = `the Labor Log snapshot${synced ? " synced " + synced : ""}`;
    summaryRef = { kind: "labor_log", id: llId };
    entries = arr(ll.entries).filter(obj).map((e, i) => ({
      ref: { kind: "labor_entry", id: clip(e.qbId, 64) || `${llId}#${i}` }, date: str(e.date).trim(), hours: Math.max(0, num(e.hours)), updated: "",
    }));
  }
  /* laborLog.startDate is where reconstruction begins (the Labor Log counts
     from it: forms.js "Count labor from (start date)", and officeai.js's
     invoice draft counts the hours on/after it). This check is the
     mitigation, so it keeps only the hours before it. */
  const until = obj(p.laborLog) && validDate(p.laborLog.startDate) ? p.laborLog.startDate : "";
  entries = entries.filter((e) => e.hours > 0 && (!until || e.date < until))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0));
  const total = r2(entries.reduce((a, e) => a + e.hours, 0));
  const any = entries.length > 0;
  if (!win) {
    if (total > 0) hints.push({ kind: "labor_no_window",
      label: clip(`${total} h of labor not checked: the job has no date of loss, placed or dry-out start, or no removed or dry-out finish date to bound the mitigation`, 200),
      refs: [{ ...summaryRef, label: `${total} h from ${source}` }] });
    return { hints, inWindow: [], documented: 0, source, summaryRef, any };
  }
  const inWindow = entries.filter((e) => validDate(e.date) && e.date >= win.start && e.date <= win.end);
  const outside = entries.filter((e) => !inWindow.includes(e));
  const outsideHours = r2(outside.reduce((a, e) => a + e.hours, 0));
  if (outsideHours > 0) {
    hints.push({ kind: "labor_outside_window",
      label: clip(`${outsideHours} h dated outside the mitigation window ${span(win.start, win.end)} (or undated) not counted`, 200),
      refs: outside.slice(0, 10).map((e) => ({ ...e.ref, label: clip(`${r2(e.hours)} h ${mmdd(e.date) || "undated"}`, 120), ...(validDate(e.date) ? { date: e.date } : {}) })) });
  }
  // a pull that stopped before the window closed may be missing its last days
  if (source === "QuickBooks Time" && validDate(today)) {
    const last = entries.map((e) => (parseStamp(e.updated) || {}).date || "").filter(Boolean);
    const newest = last.length ? maxOf(last) : "";
    if (newest && daysApart(newest, today) > 2 && newest < win.end) {
      hints.push({ kind: "labor_source_stale",
        label: clip(`QuickBooks Time rows for this job were last written ${newest}, before the mitigation window closed ${win.end}; later hours may not be pulled yet`, 200),
        refs: [{ ...summaryRef, label: `last written ${newest}` }] });
    }
  }
  const documented = r2(inWindow.reduce((a, e) => a + e.hours, 0));
  return { hints, inWindow, documented, source, summaryRef, any };
}

/* ---------- the detector ---------- */
const CLASS_LABEL = { dehu: "dehu-days", airMover: "air-mover-days", scrubber: "scrubber-days", heater: "heater-days", labor: "labor hours", cat3: "Cat 3 package" };
const HINT_ORDER = ["billed_exceeds_documented", "equipment_not_comparable", "labor_not_comparable", "labor_no_window", "labor_outside_window",
  "open_equipment_row", "cat3_items_undocumented", "undocumented_days", "photographed_not_logged", "documented_not_billed",
  "monitoring_not_billed", "multiple_rates", "log_disagreement", "count_strings_only", "unclassified_equipment",
  "labor_source_stale", "manual_hours_present"];

/** Reconcile one job. timeEntries: this job's time_entries rows
    ({id, date, hours, qbTimesheetId, updated_at, source}); today: the Alaska
    date "YYYY-MM-DD". Returns the proposal's lines, hints, evidence and the
    two-line rationale. */
export function reconcileJob(project, { timeEntries = [], today, boardStage = null, manual = false } = {}) {
  const p = obj(project) ? project : {};
  const scope = scopeOf(p, { boardStage, manual });
  const inv = invoiceFacts(p);
  const base = {
    job_id: str(p.id), scope, sent: inv.sent,
    rate_invoice_id: inv.rateInvoice ? clip(inv.rateInvoice.id, 64) : "",
    rate_invoice_no: inv.rateInvoice ? clip(inv.rateInvoice.invoiceNo, 60) : "",
  };
  if (!scope.ok) return { ...base, lines: [], hints: [], evidence_refs: [], total_usd: 0, unpriced_count: 0, rationale: "" };
  const day = validDate(today) ? today : "";

  const eq = equipmentFacts(p, day);
  const lines = [], hints = [...eq.hints], evidence = [];

  /* 1. Equipment unit-days vs billed, per class (a contract's scope lines
     count as billed) — unless a drying bid or a contract with no itemised
     scope prices the equipment as one item: then one hint, no line. */
  const covered = inv.equipCovered;
  const logged = CLASSES.filter((cls) => eq.days[cls] > 0);
  if (covered.length && logged.length) {
    const c = covered[0];
    hints.push({ kind: "equipment_not_comparable",
      label: clip(`The drying log documents ${logged.map((cls) => `${eq.days[cls]} ${NOUN[cls]}-days`).join(", ")}; ${invName(c.inv)} ` +
        `${c.i >= 0 ? "prices drying as one item" : "is a set amount with no itemised scope"}, so unit-days can't be compared.`, 200),
      refs: covered.slice(0, 10).map((x) => (x.i >= 0
        ? { kind: "invoice_line", id: `${clip(x.inv.id, 64)}#${x.i}`, label: clip(`${invName(x.inv)} line ${x.i + 1}: ${clip(x.it.desc, 80)}`, 120) }
        : { kind: "invoice", id: clip(x.inv.id, 64) || "invoice", label: clip(`${invName(x.inv)} (contract, no itemised scope)`, 120) })) });
  }
  for (const cls of covered.length ? [] : CLASSES) {
    const cands = inv.lines.filter((l) => l.cls === cls);
    const billedLines = cands.concat(inv.contractLines.filter((l) => l.cls === cls));
    const billed = r2(billedLines.reduce((a, l) => a + billedQty(l), 0));
    const documented = eq.days[cls];
    const rows = eq.rows.filter((r) => r.cls === cls);
    const delta = r2(documented - billed);
    const dates = rows.map((r) => r.startDate).concat(rows.map((r) => r.endDate)).filter(Boolean);
    const range = dates.length ? span(minOf(dates), maxOf(dates)) : "";
    const what = `${documented} ${NOUN[cls]}-days from ${plural(rows.length, "unit row")}${range ? ", " + range : ""}`;
    if (delta >= 1) {
      const rate = pickRate(cands);
      lines.push(buildLine({ finding_id: FINDING[cls], cls, qty: delta, rate, fallback: EQUIP_DEFAULT[cls],
        basis: `Drying log: ${what} (24-hour periods, partial periods rounded up); invoiced ${billed}; ${delta} not billed.${rateText(rate, NOUN[cls])}`,
        refs: rows.map((r) => r.ref) }));
      evidence.push({ kind: "drying_log", id: rows[0].logId, label: clip(what, 120) });
      const mr = multipleRates(cands, NOUN[cls]);
      if (mr) hints.push(mr);
    } else if (delta <= -1) {
      hints.push({ kind: "billed_exceeds_documented",
        label: clip(`Invoiced ${billed} ${NOUN[cls]}-days; the drying log documents ${documented}${rows.length ? " (" + what + ")" : ""}`, 200),
        refs: billedLines.slice(0, 5).map(lineRef).concat(rows.slice(0, 5).map((r) => r.ref)) });
    }
  }

  /* 2. Labor hours inside the mitigation window vs HR lines — only when every
     T&M invoice bills its work by the hour; otherwise one hint says why not. */
  const win = mitigationWindow(p, eq);
  const lab = laborFacts(p, timeEntries, win, day);
  hints.push(...lab.hints);
  if (win) {
    const cands = inv.lines.filter((l) => l.hr);
    const billed = r2(cands.reduce((a, l) => a + billedQty(l), 0));
    const delta = r2(lab.documented - billed);
    const what = `${lab.documented} h from ${plural(lab.inWindow.length, "entry", "entries")} in ${lab.source}, ${span(win.start, win.end)}`;
    const unitPriced = inv.lines.filter(unitPricedWork);
    if (inv.contracts.length) {
      // a contract (the mitigation or the rebuild) prices its labor inside a set amount: its hours would read as unbilled
      if (lab.any) hints.push({ kind: "labor_not_comparable",
        label: clip(`${cap(lab.source)} has ${roundTo(lab.documented, 1)} h in the mitigation window ${span(win.start, win.end)}; ` +
          `HR lines bill ${roundTo(billed, 1)} h; ${invName(inv.contracts[0])} is a contract (a set amount), so hours can't be compared.`, 200),
        refs: [{ ...lab.summaryRef, label: clip(what, 120) }].concat(inv.contracts.slice(0, 9).map((c) =>
          ({ kind: "invoice", id: clip(c.id, 64) || "invoice", label: clip(`${invName(c)} (contract)`, 120) }))) });
    } else if (unitPriced.length) {
      if (lab.any) hints.push({ kind: "labor_not_comparable",
        label: clip(`${cap(lab.source)} has ${roundTo(lab.documented, 1)} h in the mitigation window ${span(win.start, win.end)}; ` +
          `HR lines bill ${roundTo(billed, 1)} h; the rest of the labor is priced inside ${plural(unitPriced.length, "unit-priced line")}, so hours can't be compared.`, 200),
        refs: [{ ...lab.summaryRef, label: clip(what, 120) }].concat(unitPriced.slice(0, 9).map(lineRef)) });
    } else if (delta >= 0.5) {
      const tech = cands.filter((l) => !l.credit && /technician|labor|\blab\b/i.test(`${l.it.desc} ${l.code}`));
      const rate = pickRate(tech.length ? tech : cands);
      const qty = Math.round(delta * 4) / 4;   // quarter hours
      lines.push(buildLine({ finding_id: "labor:hours", cls: "labor", qty, rate, fallback: LABOR_DEFAULT,
        basis: `Labor: ${what} (mitigation window); invoiced ${billed} h on HR lines; ${qty} h not billed.${rateText(rate, "hourly")}`,
        refs: [{ ...lab.summaryRef, label: clip(what, 120) }].concat(lab.inWindow.slice(0, 8).map((e) =>
          ({ ...e.ref, label: clip(`${r2(e.hours)} h ${mmdd(e.date)}`, 120), date: e.date }))) }));
      evidence.push({ ...lab.summaryRef, label: clip(what, 120) });
    } else if (delta <= -0.5 && lab.any) {   // no labor rows at all (no jobcode, no snapshot) says nothing
      hints.push({ kind: "billed_exceeds_documented",
        label: clip(`Invoiced ${billed} h on HR lines; ${lab.source} has ${lab.documented} h in the mitigation window ${span(win.start, win.end)}`, 200),
        refs: cands.slice(0, 10).map(lineRef) });
    }
  }

  /* 3. Photos (never a quantity): tags that name equipment no row or count
     covers that day, and billed-kind work no line carries, are hints; a work
     tag can also be the record a Cat 3 item needs in step 4. */
  const photos = arr(p.photos).filter((ph) => obj(ph) && obj(ph.ai));
  const notLogged = {};
  for (const ph of photos) {
    if ((ph.stage || "during") !== "during") continue;
    const date = (parseStamp(ph.ts) || {}).date;
    if (!date) continue;
    for (const tag of arr(ph.ai.equipment)) {
      const cls = equipClassOf(tag);
      if (!cls || eq.onDate(cls, date) || eq.countOn(cls, date)) continue;
      const n = notLogged[cls] || (notLogged[cls] = { dates: new Set(), refs: [] });
      n.dates.add(date);
      if (!n.refs.some((r) => r.id === str(ph.id)) && n.refs.length < 10) n.refs.push({ kind: "photo", id: clip(ph.id, 64), label: clip(`${tag} (${mmdd(date)})`, 120), date });
    }
  }
  for (const cls of CLASSES) {
    const n = notLogged[cls];
    if (!n) continue;
    const ds = [...n.dates].sort();
    hints.push({ kind: "photographed_not_logged",
      label: clip(`During photos show ${NOUN[cls]} equipment on ${ds.map(mmdd).join(", ")} with no ${NOUN[cls]} row or count that day`, 200), refs: n.refs });
  }
  /* Records of work done: photo work/material tags, change orders and the
     Cat 3 justification, read with the Cat 3 items' words (the photo hint
     below and step 4 share them). */
  const work = [];
  for (const ph of photos) {
    const date = (parseStamp(ph.ts) || {}).date || "";
    for (const tag of arr(ph.ai.workDone).concat(arr(ph.ai.materials)).map((t) => clip(t, 200)).filter(Boolean)) {
      work.push({ photo: true, text: tag, say: `photo${date ? " " + mmdd(date) : ""}: ${tag}`,
        ref: { kind: "photo", id: clip(ph.id, 64) || "photo", label: clip(`${tag}${date ? " (" + mmdd(date) + ")" : ""}`, 120), ...(date ? { date } : {}) } });
    }
  }
  for (const co of arr(p.changeOrders)) {
    if (!obj(co) || !filled(co.description)) continue;
    const no = filled(co.coNo) ? " " + clip(co.coNo, 20) : "";
    work.push({ text: str(co.description), say: `change order${no}: ${clip(co.description, 200)}`,
      ref: { kind: "change_order", id: clip(co.id, 64) || "change_order", label: clip(`Change order${no}: ${str(co.description)}`, 120) } });
  }
  if (filled(p.cat3Justification)) {
    work.push({ text: str(p.cat3Justification), say: `Cat 3 justification: ${clip(p.cat3Justification, 200)}`,
      ref: { kind: "cat3_justification", id: str(p.id) || "job", label: clip(p.cat3Justification, 120) } });
  }
  // the records of one item's work, one per photo / change order (its first matching tag)
  const workOn = (item, photosOnly = false) => {
    const out = [];
    for (const r of work) {
      if ((photosOnly && !r.photo) || (item.ppe && r.photo) || !records(item, r.text)) continue;
      if (!out.some((x) => x.ref.kind === r.ref.kind && x.ref.id === r.ref.id)) out.push(r);
    }
    return out;
  };

  /* 4. The Cat 3 package. A missing item becomes a line only when the job
     records that work: a photo tag, a change order or the Cat 3 justification
     in the item's words, or, for negative air and the HEPA filter, scrubber
     rows in the drying log. The package is the owner's rule, not proof the
     work was done, so items with no record are one hint, never a line. */
  const cat3 = String(p.waterCategory) === "3";
  const ridesLine = new Set();     // PHOTO_WORK items whose photos went onto a line
  if (cat3) {
    const catRef = { kind: "water_category", id: "3", label: "Water category 3 (Cat 3 package applies)" };
    const scrubRefs = eq.rows.filter((r) => r.cls === "scrubber").map((r) => r.ref)
      .concat(eq.open.filter((r) => r.cls === "scrubber").map((r) => ({ kind: "equipment_row", id: r.id, label: clip(r.name, 120) })));
    const scrubbers = eq.machines("scrubber");
    const unrecorded = [];
    let missing = 0;
    for (const item of CAT3) {
      if (onInvoice(inv.anyLines, item)) continue;
      if (item.scrubber && lines.some((l) => l.finding_id === FINDING.scrubber)) continue;   // the unit-day line covers it
      if (item.scrubber && covered.length) continue;      // the drying bid / set amount prices the scrubbers with the rest
      let qty = null, refs, said;
      if (item.scrubber || item.scrubbers) {
        if (!scrubbers) { unrecorded.push(item); continue; }
        refs = scrubRefs;
        if (item.scrubbers) qty = scrubbers;
        said = item.scrubbers ? `One filter per scrubber: ${plural(scrubbers, "scrubber")} in the drying log.` : `The drying log lists ${plural(scrubbers, "scrubber")}.`;
      } else {
        const ev = workOn(item);
        if (!ev.length) { unrecorded.push(item); continue; }
        refs = ev.map((r) => r.ref);
        said = `The job records the work: ${clip(ev[0].say, 80)}${ev.length > 1 ? ` (+${ev.length - 1} more)` : ""}.`;
      }
      lines.push(buildLine({ finding_id: "cat3:" + item.key, cls: "cat3", qty, rate: null, fallback: item.fallback,
        basis: `Cat 3 job (water category 3): the owner's Cat 3 package includes ${item.what} and no invoice line has it. ${said}` +
          (qty != null ? "" : " Quantity and price are the office's call."),
        refs: [catRef].concat(refs) }));
      if (PHOTO_WORK.includes(item)) ridesLine.add(item.key);
      missing++;
    }
    if (missing) evidence.push({ ...catRef, label: `Cat 3: ${plural(missing, "package item")} with a record of the work, not on the invoice` });
    if (unrecorded.length) {
      hints.push({ kind: "cat3_items_undocumented",
        label: clip(`Cat 3 package items with no invoice line and no record of the work: ${unrecorded.map((i) => i.short || i.what).join(", ")}`, 200),
        refs: [catRef] });
    }
  }
  for (const w of PHOTO_WORK) {
    if (ridesLine.has(w.key) || onInvoice(inv.anyLines, w)) continue;
    const refs = workOn(w, true).slice(0, 10).map((r) => r.ref);
    if (!refs.length) continue;
    hints.push({ kind: "documented_not_billed",
      label: clip(`${plural(refs.length, "photo")} tagged ${w.what}; no invoice line bills ${w.what}`, 200), refs });
  }

  /* 5. Monitoring visits and undocumented days (hints only). */
  const visits = new Set();
  const visitRefs = [];
  for (const m of arr(p.moistureMaps)) {
    if (!obj(m)) continue;
    const ds = arr(m.readings).filter((r) => obj(r) && validDate(r.date) && arr(r.values).some(isNum)).map((r) => r.date);
    ds.forEach((d) => visits.add(d));
    if (ds.length) visitRefs.push({ kind: "moisture_map", id: clip(m.id, 64) || "map", label: clip(`${m.label || m.material || "Moisture map"}: ${plural(new Set(ds).size, "reading date")}`, 120) });
  }
  const logVisits = new Map();
  for (const [d, c] of eq.counts) { visits.add(d); logVisits.set(c.logId, (logVisits.get(c.logId) || 0) + 1); }
  for (const [id, n] of logVisits) visitRefs.push({ kind: "drying_log", id, label: `Drying log: ${plural(n, "reading date")}` });
  if (visits.size && !inv.lines.some((l) => /monitor/.test(l.text) || /^EQA?$/.test(l.code))) {
    const vs = [...visits].sort();
    hints.push({ kind: "monitoring_not_billed",
      label: clip(`${plural(vs.length, "monitoring visit")} (${span(vs[0], vs[vs.length - 1])}) and no monitoring line on the invoice`, 200),
      refs: visitRefs.slice(0, 10) });
  }
  const undocumented = new Set(), undocLogs = [];
  for (const log of eq.logs) {
    let a = parseStamp(log.start), b = parseStamp(log.finish);
    if (!(a && b)) { a = log.placed.length ? parseStamp(minOf(log.placed)) : null; b = log.removed.length ? parseStamp(maxOf(log.removed)) : null; }
    if (!a || !b) continue;
    let end = b.date;
    if (day && end > day) end = day;
    let n = 0;
    for (let d = a.date; d <= end && n < 366; d = addDays(d, 1), n++) {
      if (visits.has(d) || !CLASSES.some((cls) => eq.onDate(cls, d))) continue;
      undocumented.add(d);
      if (!undocLogs.some((u) => u.log === log)) undocLogs.push({ log, from: a.date, to: end });
    }
  }
  if (undocumented.size) {
    const ds = [...undocumented].sort();
    hints.push({ kind: "undocumented_days",
      label: clip(`${plural(ds.length, "day")} with equipment running and no reading (unsupported days, not a billing gap): ${ds.map(mmdd).join(", ")}`, 200),
      refs: undocLogs.slice(0, 10).map((u) => ({ kind: "drying_log", id: u.log.id, label: clip(`Drying log, equipment ${span(u.from, u.to)}`, 120) })) });
  }

  /* Totals, evidence and the rationale. */
  const outLines = lines.slice(0, 40);
  const priced = outLines.filter((l) => l.price != null);
  // Σ qty × price rounded once, as the executor and the invoice editor total it (not Σ of the rounded amounts)
  const total = cents4(priced.reduce((a, l) => a + tenThou(l.qty, l.price), 0));
  const unpriced = outLines.length - priced.length;
  if (inv.rateInvoice) evidence.push({ kind: "invoice", id: clip(inv.rateInvoice.id, 64), label: clip(`Compared with ${plural(inv.billable.length, "T&M invoice")}; rates and terms from ${invName(inv.rateInvoice)}`, 120) });
  const outHints = hints.slice().sort((a, b) => HINT_ORDER.indexOf(a.kind) - HINT_ORDER.indexOf(b.kind)).slice(0, 20)
    .map((h) => ({ kind: h.kind, label: clip(h.label, 200), refs: h.refs.slice(0, 10) }));
  for (const h of outHints) if (h.refs[0]) evidence.push(h.refs[0]);
  const evidence_refs = [];
  for (const r of evidence) {
    if (evidence_refs.length >= 10) break;
    if (!evidence_refs.some((x) => x.kind === r.kind && x.id === r.id && x.label === r.label)) evidence_refs.push(r);
  }

  return {
    ...base,
    lines: outLines,
    hints: outHints,
    evidence_refs,
    total_usd: total,
    unpriced_count: unpriced,
    rationale: outLines.length ? rationaleOf(p, outLines, total, unpriced) + "\n" + LIMITS : "",
  };
}

/* Line 1 (<=160 chars, quoted by the text label and the inbox "Why"):
   "Add N lines ($X[, M unpriced]) to <customer>: <classes>". */
function rationaleOf(p, lines, total, unpriced) {
  const head = `Add ${plural(lines.length, "line")} (${money(total)}${unpriced ? `, ${unpriced} unpriced` : ""}) to `;
  const classes = [...new Set(lines.map((l) => CLASS_LABEL[l.class] || l.class))].join(", ");
  const tail = `: ${classes}`;
  const who = clip(p.customer, Math.max(12, 160 - head.length - tail.length)) || "this job";
  return clip(head + who + tail, 160);
}

/** The findings_hash input (K4): the lines' billing identity, order-free.
    Evidence is left out, so a new photo alone never re-files. */
export function findingsKey(lines) {
  return JSON.stringify(arr(lines).filter(obj)
    .map((l) => [str(l.finding_id), str(l.class), l.qty == null ? null : l.qty, str(l.unit), l.price == null ? null : l.price])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
