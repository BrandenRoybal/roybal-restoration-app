/* ============================================================
   🏷️ Equipment — where every drying unit is, the fleet list and
   its QR labels. The #/equipment tab of the office admin.
   ------------------------------------------------------------
     #/equipment          out now (every job), the fleet list, tags
                          scanned on jobs that aren't on the list
     #/equipment/labels   the label sheet: 10 per US letter page
                          (Avery 5163 / 5523), printed from here

   OUT NOW comes from the job blobs this device already holds (the
   admin runs the field sync): each job's scans are written into a
   COPY of its drying-log rows (scans.js applyScans, the same rows a
   phone or the billing check derives), then every row placed and not
   removed is a unit out. Scanned and typed rows count alike. It needs
   no server table, so it works before the 0022 database update too.

   THE FLEET LIST is public.equipment_units (migration 0022): read
   under RLS, changed only through its two doors, equipment_unit_save
   and equipment_units_add_range (owner, office or crew lead; anyone
   else gets 42501). Until 0022 is applied the table answers 404 and
   the list says it switches on with the update.

   The page never repaints under the office's hands: admin.js leaves
   #/equipment out of the sync repaint and calls equipmentChanged()
   instead, which shows a "New changes — refresh" pill when what this
   page shows moved.

   admin.js loads this file by dynamic import. Its field imports are
   names that existed before it was written, or come from the two
   modules new with it (scans.js, fleet.js), so a stale cached field
   module can't blank the tab (the receiptlibrary.js rule). qr.js's
   error-correction argument is new: a stale qr.js ignores it and
   prints medium correction, which still reads.
   ============================================================ */
import { h, clear, Store, toast, daysSince, onProjectSaved, onProjectDeleted } from "../../js/core.js";
import { SYNC_ENABLED } from "../../js/config.js";
import { rest, currentEmail } from "../../js/supa.js";
import { syncNow } from "../../js/sync.js";
import { qrSvg } from "../../js/qr.js";
import { TAG_PAD, TAG_PREFIXES, TYPE_LABELS, parseTag, tagKey, typeFromTag, liveScans, placements, applyScans, wallTime, rowOutAt, rowRoom } from "../../js/scans.js";
import { loadFleet, saveFleet, unitFor, unitLabel, unitModelText, labelPayload } from "../../js/fleet.js";

const HASH = "#/equipment";
const LABELS = "#/equipment/labels";
const FIELD_ROOT = location.pathname.replace(/\/admin\/?.*$/, "/") || "/";
const STALE_DAYS = 7;                    // the Today KPI's "equipment out 7+ days"
const PER_SHEET = 10;                    // Avery 5163 / 5523: 2 × 5 labels of 4 × 2 in
const RANGE_MAX = 1000;                  // one Add units form; the door takes 200 per call
const UNIT_COLS = "id,tag,type,make,model,serial,rating,owned,status,notes,updated_at";
const TYPE_ORDER = ["air_mover", "dehumidifier", "dehu_lgr", "dehu_desiccant", "air_scrubber", "heater", "other"];
const STATUS = [["active", "Active"], ["repair", "Repair"], ["retired", "Retired"]];
const OWNED = [["owned", "Owned"], ["rented", "Rented"]];
const ACT_WORD = { place: "placed", move: "moved", remove: "removed" };
const HOW_WORD = { camera: "📷 Scanned", photo: "📷 Label photo", typed: "⌨ Tag typed in" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);   // not Object.hasOwn: Safari < 15.4
const clean = (v) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim();
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const badge = (text, tone, title) => h("span", { class: "badge " + tone, title }, text);
const jobHref = (id) => FIELD_ROOT + "#/p/" + id;
const typeText = (code) => (code && has(TYPE_LABELS, code) ? TYPE_LABELS[code] : "");
// a type code's printed prefix (an LGR or desiccant dehu is still a DH)
const prefixFor = (code) => {
  for (const [p, c] of Object.entries(TAG_PREFIXES)) if (c === code) return p;
  return /^dehu_/.test(code || "") ? "DH" : "";
};
// "Air mover" (a scan's type text) → "air_mover"
const codeOfLabel = (label) => {
  const l = clean(label).toLowerCase();
  for (const c of TYPE_ORDER) if (TYPE_LABELS[c].toLowerCase() === l) return c;
  return "";
};

/* "2026-10-08T14:30" (the drying log's Alaska wall time) → "Oct 8, 2:30 PM";
   the year only when it isn't this one. Anything else typed shows as typed. */
function fmtWall(w) {
  const s = clean(w);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12) return s;
  const day = `${MON[+m[2] - 1]} ${+m[3]}${+m[1] !== new Date().getFullYear() ? ", " + m[1] : ""}`;
  if (!m[4]) return day;
  const hh = +m[4];
  return `${day}, ${hh % 12 || 12}:${m[5]} ${hh < 12 ? "AM" : "PM"}`;
}
const scanStamp = (at) => fmtWall(wallTime(at));

/* tags in printed order: AM-002 before AM-010, plain numbers by value */
function tagOrder(a, b) {
  const pa = /^([A-Z]*)-?(\d+)$/.exec(tagKey(a)) || [], pb = /^([A-Z]*)-?(\d+)$/.exec(tagKey(b)) || [];
  if (pa[0] && pb[0]) return (pa[1] || "").localeCompare(pb[1] || "") || Number(pa[2]) - Number(pb[2]);
  return clean(a).localeCompare(clean(b));
}

function jobName(p) {
  return clean(p.customer) || clean(p.address) || "Untitled job";
}

/* ---------- what the jobs say: every unit out, every scan ---------- */
/** From the local job blobs (pure apart from scans.js): { out, scans }.
    out: one entry per drying-log row out now (scans.js rowOutAt: placed,
    not removed yet, so a planned pickup still counts; a run measured in
    typed Hrs doesn't), scanned or typed (and a scanned unit still out whose
    job lost its drying log) —
    { key, tag, type, jobId, job, address, archived, room, placed (wall
    time), days, scanned, how, tech, by }. scans: every live scan event
    — { key, tag, type, act, at, jobId, job }. */
export function equipmentIndex(projects, atMs) {
  const out = [], scans = [];
  const now = Number.isFinite(atMs) ? atMs : Date.now();
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!p || typeof p !== "object" || !p.id) continue;
    const job = jobName(p), jobId = String(p.id), archived = !!clean(p.archivedAt);
    // only what applyScans reads and writes: a copy of the logs, never the photos
    const copy = {
      equipmentScans: Array.isArray(p.equipmentScans) ? p.equipmentScans : [],
      dryingLogs: JSON.parse(JSON.stringify(Array.isArray(p.dryingLogs) ? p.dryingLogs : [])),
      deletedIds: p.deletedIds,          // a deleted scan's row goes here as on the phone
    };
    let ps = [];
    try { applyScans(copy); ps = placements(copy); } catch { /* a malformed scan log: its typed rows still count */ }
    const byPlace = new Map(ps.map((P) => [P.placeId, P]));
    const onLog = new Set();
    const base = { jobId, job, address: clean(p.address), archived };
    for (const log of copy.dryingLogs) {
      for (const row of (log && Array.isArray(log.equipment) ? log.equipment : [])) {
        if (!row || typeof row !== "object") continue;
        if (row.scanId) onLog.add(row.scanId);
        const placed = clean(row.placed);
        if (!rowOutAt(row, now)) continue;
        const P = row.scanId ? byPlace.get(row.scanId) : null;
        // a scanned row this copy holds no scan for keeps what the row says (scans.js leaves it as it was)
        const sc = !P && row.scanId && row.scan && typeof row.scan === "object" ? row.scan : {};
        out.push({
          ...base, key: tagKey(row.asset), tag: clean(row.asset), type: clean(row.type),
          room: P ? P.room : rowRoom(row), placed, days: daysSince(placed),
          scanned: !!(P || row.scanId), how: P ? P.how : clean(sc.how), tech: P ? P.tech : clean(sc.tech), by: P ? P.by : clean(sc.by),
        });
      }
    }
    for (const P of ps) {
      if (P.removeId || P.endedTyped || onLog.has(P.placeId)) continue;
      const placed = wallTime(P.placedAt);
      out.push({ ...base, key: P.tagKey, tag: P.tag, type: P.type, room: P.room, placed, days: daysSince(placed),
        scanned: true, how: P.how, tech: P.tech, by: P.by, noLog: true });
    }
    let live = [];
    try { live = liveScans(copy); } catch { /* as above */ }
    // a place that moved a unit already out reads as a move (scans.js scanRecord says the same)
    const moved = new Set(ps.flatMap((P) => P.moves.map((m) => m.id)));
    const starts = new Set(ps.map((P) => P.placeId));
    // a typed row's move (onRow) and a move another device's remove overtook read as moves too
    const actOf = (e) => (moved.has(e.id) || (e.act === "place" && (e.from || e.onRow) && !starts.has(e.id)) ? "move" : e.act);
    for (const e of live) scans.push({ key: tagKey(e.tag), tag: clean(e.tag), type: clean(e.type), act: actOf(e), at: e.at, jobId, job });
  }
  return { out, scans };
}

/* A unit out on two or more live jobs at once: it was pulled from one of
   them without a scan or a removal date. key → [entries]. */
function conflictsOf(out) {
  const by = new Map();
  for (const e of out) {
    if (!e.key || e.archived) continue;
    if (!by.has(e.key)) by.set(e.key, []);
    by.get(e.key).push(e);
  }
  const res = new Map();
  for (const [k, list] of by) if (new Set(list.map((e) => e.jobId)).size >= 2) res.set(k, list);
  return res;
}

/* the newest live scan of each tag, and the tags scans saw */
function scanFacts(scans) {
  const last = new Map(), seen = new Map();
  for (const e of scans) {
    if (!e.key) continue;
    const t = Date.parse(e.at);
    const cur = last.get(e.key);
    if (!cur || t > cur.t) last.set(e.key, { ...e, t });
    let s = seen.get(e.key);
    if (!s) seen.set(e.key, s = { key: e.key, tag: e.tag, code: "", count: 0, jobs: new Set(), t: 0, at: "" });
    s.count++;
    s.jobs.add(e.jobId);
    if (e.act === "place" && !s.code) s.code = codeOfLabel(e.type);
    if (t > s.t) { s.t = t; s.at = e.at; s.tag = e.tag; }
  }
  for (const s of seen.values()) if (!s.code) s.code = typeFromTag(s.tag) || "";
  return { last, seen };
}

const sigOf = (idx) => JSON.stringify([
  idx.out.map((e) => [e.jobId, e.key, e.tag, e.room, e.placed, e.archived]),
  idx.scans.map((e) => [e.jobId, e.key, e.act, e.at]),
]);

/* ---------- the fleet list (equipment_units, migration 0022) ---------- */
let units = loadFleet();                 // the field cache until the first read answers
let unitsState = "cached";               // ok | missing | offline | error | cached
let unitsStatus = 0;
async function missingTable(res) {
  if (res.status === 404) return true;
  try { const b = await res.clone().json(); return !!(b && b.code === "PGRST205"); } catch { return false; }
}
async function loadUnits() {
  if (!SYNC_ENABLED) { unitsState = "offline"; return units; }
  try {
    const res = await rest(`equipment_units?select=${UNIT_COLS}&order=tag&limit=1000`, { method: "GET" });
    if (res.ok) {
      const rows = await res.json();
      units = (Array.isArray(rows) ? rows : []).filter((u) => u && typeof u === "object" && clean(u.tag));
      unitsState = "ok";
      saveFleet(units);                  // what "the list this device saw last" means when it is next offline
    } else if (await missingTable(res)) unitsState = "missing";
    else { unitsState = "error"; unitsStatus = res.status; }
  } catch { unitsState = "offline"; }
  return units;
}
const sortUnits = (list) => list.slice().sort((a, b) => tagOrder(a.tag, b.tag));

/* Who may change the list: the doors take owner, office and crew lead.
   true / false once role_is answered (kept per login), null when it
   couldn't (never kept: the next paint asks again). null keeps the
   buttons, and the doors stay the gate. */
let editor = { who: "", is: null, asking: null };
function editorCheck() {
  if (!SYNC_ENABLED) return Promise.resolve(null);
  const who = currentEmail();
  if (editor.who !== who) editor = { who, is: null, asking: null };
  if (editor.is !== null) return Promise.resolve(editor.is);
  if (!editor.asking) {
    const mine = editor;
    mine.asking = (async () => {
      const res = await rest("rpc/role_is", { method: "POST", body: JSON.stringify({ p_roles: ["owner", "office", "crew_lead"] }) });
      if (res.status !== 200) return null;
      const yes = await res.json().catch(() => null);
      return yes === true || yes === false ? yes : null;
    })().catch(() => null).then((yes) => { mine.asking = null; if (yes !== null) mine.is = yes; return yes; });
  }
  return editor.asking;
}

const sentence = (s) => { const t = clean(s); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : ""; };
/** A write through one of 0022's doors; throws with a sentence for a toast. */
async function door(fn, args) {
  let res;
  try { res = await rest("rpc/" + fn, { method: "POST", body: JSON.stringify(args) }); }
  catch { throw new Error("No connection. Try again when you're online."); }
  if (res.ok) return res.json().catch(() => null);
  let b = null;
  try { b = await res.json(); } catch { /* not json */ }
  const msg = (b && b.message) || "", code = (b && b.code) || "";
  if (res.status === 404) throw new Error("Equipment switches on after this feature's database update is applied.");
  if (res.status === 403 || code === "42501") throw new Error("Only the office or a crew lead can change the equipment list.");
  if (code === "23505") throw new Error([sentence(msg), sentence(b && b.hint)].filter(Boolean).join(" "));
  throw new Error(sentence(msg) || `Couldn't save (${res.status}).`);
}

/* ---------- a dialog over the page (Add units, Edit, Print) ---------- */
let dlg = null;
const onDlgKey = (e) => { if (e.key === "Escape") closeDialog(); };
function closeDialog() {
  if (!dlg) return;
  dlg.remove();
  dlg = null;
  document.removeEventListener("keydown", onDlgKey);
}
function openDialog(title, ...body) {
  closeDialog();
  const box = h("div", { class: "eq-dlg__box", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "eq-dlg__head" }, h("strong", {}, title),
      h("button", { type: "button", class: "btn btn--ghost btn--sm", "aria-label": "Close", onclick: closeDialog }, "✕")),
    ...body);
  dlg = h("div", { class: "eq-dlg" }, box);
  document.body.append(dlg);
  document.addEventListener("keydown", onDlgKey);
  const first = box.querySelector("input, select, textarea");
  if (first) try { first.focus(); } catch { /* jsdom */ }
  return box;
}
const field = (label, input, hint) => h("div", { class: "field" },
  h("label", {}, label, hint ? h("span", { class: "hint" }, " " + hint) : null), input);
const select = (opts, value, attrs = {}) => {
  const s = h("select", attrs, ...opts.map(([v, t]) => h("option", { value: v }, t)));
  s.value = value;
  return s;
};
const typeOpts = (blank) => [...(blank ? [["", blank]] : []), ...TYPE_ORDER.map((c) => [c, TYPE_LABELS[c]])];

/* ---------- printing: the body class and the page box ---------- */
/* The label sheet prints edge to edge (its own margins are the label
   stock's), so @page has no margin while the label page is open, and
   only then: another tab printed with Ctrl+P keeps the browser's. */
function setPrintMode(on) {
  document.body.classList.toggle("eq-print", !!on);
  let st = document.getElementById("eq-page-style");
  if (on && !st) document.head.append(st = h("style", { id: "eq-page-style" }, "@page { size: letter; margin: 0; }"));
  if (!on && st) st.remove();
}
window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith(LABELS)) setPrintMode(false);
  if (!location.hash.startsWith(HASH)) closeDialog();
});

/* ---------- the page refreshes only when asked ---------- */
let watcher = null;                      // { el, sig }
let checkTimer = null;
/** admin.js onStatus (a sync landed) and local saves: shows the refresh
    pill when what the page shows changed. */
export function equipmentChanged() {
  if (!watcher || !watcher.el.isConnected) { watcher = null; return; }
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const w = watcher;
    if (!w || !w.el.isConnected) return;
    const idx = equipmentIndex(await Store.all());
    if (w === watcher && w.el.isConnected && sigOf(idx) !== w.sig) w.el.hidden = false;
  }, 600);
}
onProjectSaved(() => equipmentChanged());
onProjectDeleted(() => equipmentChanged());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") equipmentChanged(); });

/* ---------- routing ---------- */
let seq = 0;
const filters = { q: "", type: "", status: "active" };
const ticked = new Set();                // unit ids ticked for printing
let printList = null;                    // the units the label page prints (null: all active)
let skip = 0;                            // labels already used on the first sheet

/** admin.js route(): every #/equipment… hash lands here. */
export async function renderEquipment(view) {
  if (!location.hash.startsWith(HASH)) return;   // a late call after the office moved on
  const my = ++seq;
  const live = () => my === seq && location.hash.startsWith(HASH);
  watcher = null;
  closeDialog();
  clear(view).append(h("p", { class: "muted", style: "padding:20px 2px" }, "Loading equipment…"));
  if (location.hash.startsWith(LABELS)) return renderLabels(view, live);
  setPrintMode(false);
  return renderMain(view, live);
}

/* ---------- #/equipment ---------- */
async function renderMain(view, live) {
  const projects = await Store.all();
  if (!live()) return;
  const idx = equipmentIndex(projects);
  const body = clear(view);
  const pill = h("button", { type: "button", class: "rl-pill", hidden: true, onclick: () => renderEquipment(view) }, "New changes — refresh");
  watcher = { el: pill, sig: sigOf(idx) };
  const printBtn = h("button", { type: "button", class: "btn btn--primary btn--sm", onclick: () => choosePrint() }, "🖨 Print labels");
  const registry = h("div"), seenSlot = h("div");
  let role = null;

  body.append(pill,
    h("div", { class: "atoolbar" }, h("h1", {}, "🏷️ Equipment"),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, printBtn,
        h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => { syncNow(); toast("Syncing…"); } }, "↻ Sync"))),
    h("p", { class: "eq-intro" },
      "Where every drying unit is, from the jobs' drying logs and the QR labels crews scan on site, and the fleet list the labels print from."),
    ...outNow(idx).filter(Boolean),
    registry, seenSlot);

  const paint = () => {
    if (!live()) return;
    const facts = scanFacts(idx.scans);
    registry.replaceChildren(fleetCard(idx, facts, role, paint, view));
    seenSlot.replaceChildren(...seenCard(facts, role, view));
    printBtn.disabled = unitsState === "missing" || !units.length;
  };
  paint();
  const [, r] = await Promise.all([loadUnits(), editorCheck()]);
  role = r;
  paint();
}

/* Out now: the conflicts first, then every unit out, by job */
function outNow(idx) {
  const conflicts = conflictsOf(idx.out);
  const liveOut = idx.out.filter((e) => !e.archived), archived = idx.out.filter((e) => e.archived);
  const jobs = new Set(liveOut.map((e) => e.jobId)).size;
  const stale = liveOut.filter((e) => e.days != null && e.days >= STALE_DAYS).length;
  let showArchived = false;

  const flagCard = conflicts.size ? h("div", { class: "card eq-flags" },
    h("strong", {}, `⚠ ${plural(conflicts.size, "unit")} out on two jobs at once`),
    h("p", { class: "muted eq-small", style: "margin:4px 0 2px" },
      "A unit can only be in one place: it was pulled from one of these jobs without a scan or a removal date. Open the job it left and type the date and time it really came off in that row's Removed cell. Don't scan it out there: a Remove scan records now, and bills the days it spent on the other job."),
    ...[...conflicts].sort((a, b) => tagOrder(a[1][0].tag, b[1][0].tag)).map(([, list]) => h("div", { class: "eq-flag" },
      h("strong", {}, list[0].tag), " — ",
      ...list.flatMap((e, i) => {
        const at = [e.room, e.placed ? "since " + fmtWall(e.placed) : ""].filter(Boolean).join(", ");
        return [i ? " · " : "", h("a", { href: jobHref(e.jobId) }, e.job), at ? ` (${at})` : ""];
      })))) : null;

  const tbody = h("tbody");
  const more = h("p", { class: "muted eq-small", style: "margin:8px 2px 0" });
  const paint = () => {
    const rows = (showArchived ? idx.out : liveOut).slice().sort((a, b) =>
      (conflicts.has(b.key) ? 1 : 0) - (conflicts.has(a.key) ? 1 : 0) ||
      a.archived - b.archived || a.job.localeCompare(b.job) || tagOrder(a.tag, b.tag));
    tbody.replaceChildren(...(rows.length ? rows.map((e) => outRow(e, conflicts)) : [h("tr", {}, h("td", { colspan: 7, class: "aempty" },
      "No units out. A unit shows here from the moment it's placed on a job's drying log, scanned or typed, until it's removed."))]));
    more.replaceChildren(...(archived.length ? [
      `${plural(archived.length, "more unit")} ${archived.length === 1 ? "is" : "are"} still open on archived jobs (probably back in the shop with no removal date). `,
      h("a", { href: "#", class: "atoggle", onclick: (ev) => { ev.preventDefault(); showArchived = !showArchived; paint(); } },
        showArchived ? "Hide them" : "Show them")] : []));
  };
  paint();
  return [flagCard,
    h("div", { class: "card eq-card" },
      h("div", { class: "eq-head" }, h("strong", {}, "Out now"),
        h("span", { class: "muted eq-small" }, liveOut.length
          ? [`${plural(liveOut.length, "unit")} on ${plural(jobs, "job")}`, stale ? `${stale} out ${STALE_DAYS}+ days` : ""].filter(Boolean).join(" · ")
          : "")),
      h("div", { class: "eq-wrap" }, h("table", { class: "eq-table" },
        h("thead", {}, h("tr", {}, ...["Tag", "Type", "Job", "Room", "Since", "Days", "Logged"].map((c) => h("th", {}, c)))),
        tbody)),
      more)];
}

function outRow(e, conflicts) {
  const n = conflicts.has(e.key) ? new Set(conflicts.get(e.key).map((x) => x.jobId)).size : 0;
  const how = e.scanned ? (HOW_WORD[e.how] || "📷 Scanned") : "✎ Typed";
  const by = [e.tech, e.by].filter(Boolean).join(", ");
  return h("tr", { class: n ? "eq-row--bad" : "" },
    h("td", {}, h("strong", {}, e.tag || "—"),
      n ? badge(`On ${n} jobs`, "disp-r eq-badge") : null,
      e.days != null && e.days >= STALE_DAYS ? badge(`${STALE_DAYS}+ days`, "cat2 eq-badge") : null),
    h("td", {}, e.type),
    h("td", {}, h("a", { href: jobHref(e.jobId), title: e.address }, e.job),
      e.archived ? badge("Archived", "disp-x eq-badge") : null),
    h("td", {}, e.room),
    h("td", { class: "eq-nowrap" }, fmtWall(e.placed)),
    h("td", {}, e.days == null ? "" : String(e.days)),
    h("td", { class: "eq-nowrap", title: e.scanned ? `Scanned on site${by ? " by " + by : ""}${e.noLog ? ". This job has no drying log for it to show on." : ""}` : "Typed on the drying log" },
      how, e.noLog ? " (no log)" : ""));
}

/* the fleet list card */
function fleetCard(idx, facts, role, repaint, view) {
  const card = h("div", { class: "card eq-card" });
  const head = h("div", { class: "eq-head" }, h("strong", {}, "Fleet list"));
  card.append(head);
  if (unitsState === "missing") {
    card.append(h("div", { class: "warn", style: "margin:8px 0 0" },
      "Equipment switches on after this feature's database update is applied. Out now works already, from the jobs."));
    return card;
  }
  if (unitsState === "cached" && !units.length) {
    card.append(h("p", { class: "muted eq-small" }, "Loading the fleet list…"));
    return card;
  }
  const canEdit = role !== false && SYNC_ENABLED;
  const active = units.filter((u) => (u.status || "active") === "active").length;
  head.append(h("span", { class: "muted eq-small" }, units.length ? `${plural(units.length, "unit")} · ${active} active` : ""));
  if (unitsState === "offline") card.append(h("div", { class: "warn", style: "margin:8px 0 0" }, "Offline: showing the list this device saw last. Changes need a connection."));
  if (unitsState === "error") card.append(h("div", { class: "warn", style: "margin:8px 0 0" },
    `The fleet list didn't load (${unitsStatus}). `,
    h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); loadUnits().then(repaint); } }, "Try again")));

  // where each unit is now: the live jobs it's out on
  const where = new Map();
  for (const e of idx.out) {
    if (!e.key || e.archived) continue;
    if (!where.has(e.key)) where.set(e.key, []);
    where.get(e.key).push(e);
  }

  const search = h("input", { type: "search", class: "eq-search", value: filters.q, placeholder: "Search tag, type, make, model, job",
    "aria-label": "Search the fleet list" });
  const typeSel = select(typeOpts("All types"), filters.type, { "aria-label": "Type" });
  const statusSel = select([["", "Any status"], ...STATUS], filters.status, { "aria-label": "Status" });
  const tickAll = h("input", { type: "checkbox", "aria-label": "Tick every unit shown" });
  const tbody = h("tbody");
  const foot = h("p", { class: "muted eq-small", style: "margin:8px 2px 0" });

  const whereText = (u) => {
    const jobs = [...new Map((where.get(tagKey(u.tag)) || []).map((e) => [e.jobId, e])).values()];
    if (jobs.length >= 2) return h("span", { class: "rl-late", title: jobs.map((e) => e.job).join(" · ") }, `On ${jobs.length} jobs`);
    if (jobs.length === 1) return h("span", {}, h("a", { href: jobHref(jobs[0].jobId) }, jobs[0].job), jobs[0].room ? " · " + jobs[0].room : "");
    return h("span", { class: "muted" }, "Not out on a job");
  };
  const matches = (u) => {
    if (filters.type && u.type !== filters.type) return false;
    if (filters.status && (u.status || "active") !== filters.status) return false;
    const q = clean(filters.q).toLowerCase();
    if (!q) return true;
    const jobs = (where.get(tagKey(u.tag)) || []).map((e) => e.job + " " + e.room).join(" ");
    const hay = [u.tag, unitLabel(u), u.make, u.model, u.serial, u.rating, u.notes, jobs].map(clean).join(" ").toLowerCase();
    return q.split(" ").every((w) => hay.includes(w));
  };
  const shown = () => sortUnits(units.filter(matches));

  const paintRows = () => {
    const list = shown();
    tickAll.checked = list.length > 0 && list.every((u) => ticked.has(u.id));
    tbody.replaceChildren(...(list.length ? list.map((u) => unitRow(u, whereText(u), facts.last.get(tagKey(u.tag)), canEdit, paintRows, repaint))
      : [h("tr", {}, h("td", { colspan: 10, class: "aempty" }, units.length ? "No units match." : "No units on the list yet. Add them with + Add units: a type and a number range makes the whole run at once."))]));
    const n = [...ticked].filter((id) => units.some((u) => u.id === id)).length;
    foot.textContent = n ? `${plural(n, "unit")} ticked for printing.` : "Tick units to print just their labels.";
  };
  search.addEventListener("input", () => { filters.q = search.value; paintRows(); });
  typeSel.addEventListener("change", () => { filters.type = typeSel.value; paintRows(); });
  statusSel.addEventListener("change", () => { filters.status = statusSel.value; paintRows(); });
  tickAll.addEventListener("change", () => {
    for (const u of shown()) { if (tickAll.checked) ticked.add(u.id); else ticked.delete(u.id); }
    paintRows();
  });
  currentShown = shown;

  card.append(...[
    h("div", { class: "eq-filters" }, search, typeSel, statusSel,
      canEdit ? h("button", { type: "button", class: "btn btn--primary btn--sm", onclick: () => addUnits(view) }, "+ Add units") : null),
    role === false ? h("p", { class: "muted eq-small", style: "margin:6px 2px 0" }, "The office or a crew lead keeps this list.") : null,
    h("div", { class: "eq-wrap" }, h("table", { class: "eq-table" },
      h("thead", {}, h("tr", {}, h("th", { class: "eq-tick" }, tickAll),
        ...["Tag", "Type", "Make / model", "Rating", "Owned", "Status", "Where now", "Last scan"].map((c) => h("th", {}, c)),
        h("th", {}, ""))),
      tbody)),
    foot].filter(Boolean));            // DOM append() would write a null out as "null"
  paintRows();
  return card;
}
let currentShown = () => [];             // the fleet list as filtered on screen (for printing)

function unitRow(u, whereEl, last, canEdit, paintRows, repaint) {
  const tick = h("input", { type: "checkbox", checked: ticked.has(u.id), "aria-label": "Print " + u.tag });
  tick.addEventListener("change", () => { if (tick.checked) ticked.add(u.id); else ticked.delete(u.id); paintRows(); });
  const status = u.status || "active";
  let statusCell = STATUS.find(([v]) => v === status) ? STATUS.find(([v]) => v === status)[1] : status;
  if (canEdit) {
    const sel = select(STATUS, status, { class: "eq-status", "aria-label": "Status of " + u.tag });
    sel.addEventListener("change", async () => {
      sel.disabled = true;
      try {
        const row = await door("equipment_unit_save", { p_unit: { id: u.id, status: sel.value } });
        replaceUnit(u, row || { ...u, status: sel.value });
        toast(`${u.tag}: ${sel.options[sel.selectedIndex].text}.`);
        repaint();
      } catch (e) { sel.value = status; sel.disabled = false; toast(e.message, 4000); }
    });
    statusCell = sel;
  }
  return h("tr", { class: status === "active" ? "" : "eq-row--dim" },
    h("td", { class: "eq-tick" }, tick),
    h("td", {}, h("strong", {}, u.tag)),
    h("td", {}, unitLabel(u) || u.type || ""),
    h("td", {}, [clean(u.make), clean(u.model)].filter(Boolean).join(" ")),
    h("td", {}, clean(u.rating)),
    h("td", {}, u.owned === "rented" ? "Rented" : "Owned"),
    h("td", {}, statusCell),
    h("td", {}, whereEl),
    h("td", { class: "eq-nowrap", title: last ? last.job : "" }, last ? `${scanStamp(last.at)} · ${ACT_WORD[last.act] || last.act}` : ""),
    h("td", {}, canEdit ? h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: () => editUnit(u, repaint) }, "Edit") : null));
}

function replaceUnit(old, row) {
  units = units.filter((x) => x.id !== old.id && x !== old);
  if (row && typeof row === "object" && clean(row.tag)) units.push(row);
}

/* Tags scanned on jobs that aren't on the fleet list: one tap adds each */
function seenCard(facts, role, view) {
  if (unitsState !== "ok" && unitsState !== "offline") return [];
  const list = [...facts.seen.values()].filter((s) => !unitFor(units, s.tag)).sort((a, b) => tagOrder(a.tag, b.tag));
  if (!list.length) return [];
  const canEdit = role !== false && SYNC_ENABLED;
  const picks = new Map(list.map((s) => [s.key, s.code]));
  const add = async (s, btn) => {
    const type = picks.get(s.key);
    if (!type) { toast(`Pick what kind of unit ${s.tag} is.`); return false; }
    btn.disabled = true;
    try {
      const row = await door("equipment_unit_save", { p_unit: { tag: s.tag, type } });
      if (row && typeof row === "object") units.push(row);
      return true;
    } catch (e) { btn.disabled = false; toast(e.message, 4000); return false; }
  };
  const rows = list.map((s) => {
    const btn = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Add");
    btn.addEventListener("click", async () => { if (await add(s, btn)) { toast(`${s.tag} added to the fleet list.`); renderEquipment(view); } });
    const typeCell = s.code ? h("span", {}, typeText(s.code)) : (() => {
      const sel = select(typeOpts("Pick type"), "", { class: "eq-status", "aria-label": "Type of " + s.tag });
      sel.addEventListener("change", () => picks.set(s.key, sel.value));
      return sel;
    })();
    return h("div", { class: "eq-seen" },
      h("div", { class: "eq-seen__main" }, h("strong", {}, s.tag), " ", typeCell,
        h("div", { class: "muted eq-small" }, `Scanned ${plural(s.count, "time")} on ${plural(s.jobs.size, "job")} · last ${scanStamp(s.at)}`)),
      canEdit ? btn : null);
  });
  const all = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, `Add all ${list.length}`);
  all.addEventListener("click", async () => {
    all.disabled = true;
    let n = 0;
    for (const s of list) {
      if (!picks.get(s.key)) continue;
      if (await add(s, all)) n++; else break;
    }
    if (n) toast(`${plural(n, "unit")} added to the fleet list.`);
    renderEquipment(view);
  });
  return [h("div", { class: "card eq-card" },
    h("div", { class: "eq-head" }, h("strong", {}, "Tags seen, not in the fleet list"),
      canEdit && list.length > 1 ? all : null),
    h("p", { class: "muted eq-small", style: "margin:4px 0 4px" },
      "Scanned on a job but not on the list. Add them so their labels print and the scanner names them."),
    ...rows)];
}

/* + Add units: a type and a number range, AM-001 … AM-040 in one go */
function addUnits(view) {
  const type = select(typeOpts(), "air_mover", { "aria-label": "Type" });
  const prefix = h("input", { type: "text", maxlength: "2", value: "AM", autocapitalize: "characters", placeholder: "none", "aria-label": "Prefix" });
  const from = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: "1", "aria-label": "From number" });
  const to = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: "", "aria-label": "To number" });
  const pad = h("input", { type: "number", min: "1", max: "6", step: "1", inputmode: "numeric", value: String(TAG_PAD), "aria-label": "Digits" });
  const make = h("input", { type: "text", maxlength: "80", placeholder: "e.g. Dri-Eaz" });
  const model = h("input", { type: "text", maxlength: "80", placeholder: "e.g. Velo Pro" });
  const rating = h("input", { type: "text", maxlength: "80", placeholder: "e.g. 1/4 hp, 2.4 A" });
  const owned = select(OWNED, "owned", { "aria-label": "Owned or rented" });
  const preview = h("p", { class: "eq-small eq-preview" });
  const err = h("div", { class: "warn", hidden: true });
  const save = h("button", { type: "button", class: "btn btn--primary" }, "Add units");
  let prefixTouched = false;
  prefix.addEventListener("input", () => { prefixTouched = true; prefix.value = prefix.value.toUpperCase(); show(); });
  type.addEventListener("change", () => { if (!prefixTouched) prefix.value = prefixFor(type.value); show(); });
  for (const el of [from, to, pad]) el.addEventListener("input", () => show());

  const read = () => {
    const p = clean(prefix.value).toUpperCase(), a = Number(from.value), b = Number(to.value), d = Number(pad.value);
    if (p && !/^[A-Z]{2}$/.test(p)) return { bad: "The prefix is two letters (AM, DH, AF, HT), or blank for plain numbers." };
    if (!(Number.isInteger(a) && a >= 0 && clean(from.value) !== "")) return { bad: "From: a whole number." };
    if (!(Number.isInteger(b) && b >= a && clean(to.value) !== "")) return { bad: "To: a whole number, no lower than From." };
    if (b > 999999) return { bad: "Numbers go up to 999999." };
    if (b - a + 1 > RANGE_MAX) return { bad: `At most ${RANGE_MAX} units at a time.` };
    if (!(Number.isInteger(d) && d >= 1 && d <= 6)) return { bad: "Digits: 1 to 6." };
    const tag = (n) => (p ? p + "-" : "") + String(n).padStart(d, "0");
    return { p, a, b, d, first: tag(a), last: tag(b), n: b - a + 1 };
  };
  const show = () => {
    const r = read();
    preview.textContent = r.bad ? (clean(to.value) ? r.bad : "Fill in the numbers to see the tags.")
      : `Adds ${r.n === 1 ? r.first : r.first + " to " + r.last}: ${plural(r.n, "unit")}. Tags already on the list are skipped.`;
  };
  show();
  save.addEventListener("click", async () => {
    const r = read();
    err.hidden = true;
    if (r.bad) { err.textContent = r.bad; err.hidden = false; return; }
    save.disabled = true; save.textContent = "Adding…";
    let added = 0;
    try {
      for (let a = r.a; a <= r.b; a += 200) {
        const n = await door("equipment_units_add_range", {
          p_prefix: r.p, p_from: a, p_to: Math.min(r.b, a + 199), p_pad: r.d, p_type: type.value,
          p_make: clean(make.value), p_model: clean(model.value), p_rating: clean(rating.value), p_owned: owned.value,
        });
        added += Number(n) || 0;
      }
      closeDialog();
      const skipped = r.n - added;
      toast(`Added ${plural(added, "unit")}${skipped ? ` (${skipped} already on the list)` : ""}.`, 3500);
      renderEquipment(view);
    } catch (e) {
      err.textContent = (added ? `Added ${plural(added, "unit")}, then: ` : "") + e.message;
      err.hidden = false;
      save.disabled = false; save.textContent = "Add units";
    }
  });
  openDialog("Add units",
    field("Type", type),
    h("div", { class: "eq-range" },
      field("Prefix", prefix), field("From #", from), field("To #", to), field("Digits", pad)),
    h("p", { class: "muted eq-small", style: "margin:-4px 0 6px" }, "Leave the prefix blank for plain numbers (101, 102 …)."),
    preview,
    h("div", { class: "grid2" }, field("Make", make, "(optional)"), field("Model", model, "(optional)")),
    h("div", { class: "grid2" }, field("Rating", rating, "(optional)"), field("Owned or rented", owned)),
    err,
    h("div", { class: "rl-actions" }, save, h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: closeDialog }, "Cancel")));
}

/* Edit one unit */
function editUnit(u, repaint) {
  const inp = (v, attrs = {}) => h("input", { type: "text", maxlength: "80", value: clean(v), ...attrs });
  const tag = inp(u.tag, { maxlength: "16", autocapitalize: "characters" });
  const type = select(typeOpts(), has(TYPE_LABELS, u.type) ? u.type : "other", { "aria-label": "Type" });
  const make = inp(u.make), model = inp(u.model), serial = inp(u.serial), rating = inp(u.rating);
  const owned = select(OWNED, u.owned === "rented" ? "rented" : "owned", { "aria-label": "Owned or rented" });
  const status = select(STATUS, u.status || "active", { "aria-label": "Status" });
  const notes = h("textarea", { maxlength: "500", rows: "2" });
  notes.value = u.notes == null ? "" : String(u.notes);   // line breaks kept: clean() is for one-line fields
  const err = h("div", { class: "warn", hidden: true });
  const save = h("button", { type: "button", class: "btn btn--primary" }, "Save");
  save.addEventListener("click", async () => {
    const t = clean(tag.value).toUpperCase();
    err.hidden = true;
    if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(t)) { err.textContent = "A tag is letters, digits and dashes, up to 16 (example AM-014)."; err.hidden = false; return; }
    // the list takes any such tag, but the scanner reads only two letters and a number, or a plain number
    if (!parseTag(t) || tagKey(parseTag(t)) !== tagKey(t)) {
      err.textContent = "The scanner can't read that tag: use two letters and a number (AM-014) or a plain number up to 6 digits (101).";
      err.hidden = false; return;
    }
    save.disabled = true; save.textContent = "Saving…";
    try {
      const unit = { id: u.id, tag: t, type: type.value, make: clean(make.value), model: clean(model.value),
        rating: clean(rating.value), owned: owned.value, status: status.value, notes: notes.value.trim() };
      // a unit from the field's offline copy has no serial read: leave the server's as it is
      if (has(u, "serial") || clean(serial.value)) unit.serial = clean(serial.value);
      const row = await door("equipment_unit_save", { p_unit: unit });
      replaceUnit(u, row);
      closeDialog();
      toast(`${t} saved.`);
      repaint();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      save.disabled = false; save.textContent = "Save";
    }
  });
  openDialog("Edit " + u.tag,
    h("div", { class: "grid2" }, field("Tag", tag, "(as printed)"), field("Type", type)),
    h("div", { class: "grid2" }, field("Make", make), field("Model", model)),
    h("div", { class: "grid2" }, field("Serial #", serial), field("Rating", rating)),
    h("div", { class: "grid2" }, field("Owned or rented", owned), field("Status", status)),
    field("Notes", notes),
    err,
    h("div", { class: "rl-actions" }, save, h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: closeDialog }, "Cancel")),
    h("p", { class: "muted eq-small", style: "margin:8px 0 0" },
      "Changing the tag changes what its label says: print a new label for it. Scans already logged on jobs keep the tag they read."));
}

/* 🖨 Print labels: which units */
function choosePrint() {
  if (!units.length) { toast("Add units to the fleet list first."); return; }
  const active = sortUnits(units.filter((u) => (u.status || "active") === "active"));
  const shown = sortUnits(currentShown());
  const tickedUnits = sortUnits(units.filter((u) => ticked.has(u.id)));
  const opts = [["active", `All active units (${active.length})`, active],
    ["shown", `The list as filtered now (${shown.length})`, shown],
    ["ticked", `Ticked units (${tickedUnits.length})`, tickedUnits]];
  let pick = tickedUnits.length ? "ticked" : "active";
  const radios = opts.map(([v, label, list]) => {
    const r = h("input", { type: "radio", name: "eq-print-set", value: v, checked: v === pick, disabled: !list.length });
    r.addEventListener("change", () => { if (r.checked) pick = v; });
    return h("label", { class: "rl-check eq-choice" }, r, label);
  });
  openDialog("Print labels", ...radios,
    h("div", { class: "rl-actions" },
      h("button", { type: "button", class: "btn btn--primary", onclick: () => {
        const list = opts.find(([v]) => v === pick)[2];
        if (!list.length) { toast("No units in that set."); return; }
        printList = list.map((u) => u.id);
        closeDialog();
        location.hash = LABELS;
      } }, "Open the label sheet"),
      h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: closeDialog }, "Cancel")));
}

/* ---------- #/equipment/labels: the sheet ---------- */
const qrCache = new Map();               // tag → svg text
async function qrFor(tag) {
  if (!qrCache.has(tag)) qrCache.set(tag, await qrSvg(labelPayload(tag), 4, 2, "Q"));
  return qrCache.get(tag);
}
/* the tag as large as fits beside the QR: about 2 in of line for ~0.62 em
   a character, never over 36 pt */
const tagPt = (tag) => Math.max(14, Math.min(36, Math.floor((1.95 * 72) / (0.62 * Math.max(1, clean(tag).length)))));

function labelCell(u, svg) {
  return h("div", { class: "eq-label" },
    h("div", { class: "eq-label__qr", html: svg }),
    h("div", { class: "eq-label__text" },
      h("div", { class: "eq-label__tag", style: `font-size:${tagPt(u.tag)}pt` }, u.tag),
      h("div", { class: "eq-label__type" }, unitLabel(u)),
      unitModelText(u) ? h("div", { class: "eq-label__model" }, unitModelText(u)) : null,
      h("div", { class: "eq-label__co" }, "Roybal Construction")));
}

async function renderLabels(view, live) {
  if (unitsState !== "ok") await loadUnits();
  if (!live()) return;
  const body = clear(view);
  const back = h("a", { class: "btn btn--ghost btn--sm", href: HASH }, "‹ Equipment");
  if (unitsState === "missing") {
    body.append(h("div", { class: "atoolbar" }, h("h1", {}, "Print labels"), back),
      h("div", { class: "warn" }, "Equipment switches on after this feature's database update is applied."));
    return;
  }
  const byId = new Map(units.map((u) => [u.id, u]));
  const list = printList ? printList.map((id) => byId.get(id)).filter(Boolean)
    : sortUnits(units.filter((u) => (u.status || "active") === "active"));
  if (!list.length) {
    body.append(h("div", { class: "atoolbar" }, h("h1", {}, "Print labels"), back),
      h("div", { class: "empty" }, h("p", {}, "No units to print. Add them to the fleet list, or pick another set.")));
    return;
  }
  setPrintMode(true);
  const print = h("button", { type: "button", class: "btn btn--primary btn--sm", disabled: true, onclick: () => window.print() }, "Preparing labels…");
  const skipIn = h("input", { type: "number", min: "0", max: String(PER_SHEET - 1), step: "1", inputmode: "numeric",
    value: String(skip), class: "eq-short", "aria-label": "Labels already used on the first sheet" });
  const count = h("p", { class: "eq-small", style: "margin:6px 0 0" });
  const sheets = h("div", { class: "eq-sheets" });
  body.append(
    h("div", { class: "atoolbar eq-noprint" }, h("h1", {}, "🏷️ Print labels"),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, back, print)),
    h("div", { class: "card eq-noprint eq-tip" },
      h("p", { style: "margin:0" }, "Use weatherproof laser labels (Avery 5523, or polyester laser stock). Stick them on indoors above 50°F on a clean, dry spot on the top or handle side, never a grille or filter door. Try one on an air mover first."),
      h("p", { class: "muted eq-small", style: "margin:6px 0 0" },
        "Print at 100% (Actual size, not Fit to page) with headers and footers off. Each sheet is 10 labels, 2 × 4 in (Avery 5163 / 5523 layout)."),
      h("label", { class: "rl-check", style: "margin-top:8px" }, "Labels already used on the first sheet:", skipIn),
      count),
    sheets);

  const svgs = await Promise.all(list.map((u) => qrFor(u.tag).catch(() => "")));
  if (!live()) return;
  const paint = () => {
    const n = Number(skipIn.value);
    skip = Number.isInteger(n) && n >= 0 && n < PER_SHEET ? n : 0;
    const cells = [...Array.from({ length: skip }, () => h("div", { class: "eq-label eq-label--blank" })),
      ...list.map((u, i) => labelCell(u, svgs[i]))];
    const pages = [];
    for (let i = 0; i < cells.length; i += PER_SHEET) pages.push(h("div", { class: "eq-page" }, ...cells.slice(i, i + PER_SHEET)));
    sheets.replaceChildren(...pages);
    count.textContent = `${plural(list.length, "label")} on ${plural(pages.length, "sheet")}.`;
  };
  skipIn.addEventListener("input", paint);
  paint();
  print.disabled = false;
  print.textContent = "🖨 Print";
}
