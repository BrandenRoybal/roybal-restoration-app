/* ============================================================
   Roybal Field Forms — AI capture helpers (shared, pure)
   ------------------------------------------------------------
   Pure logic shared by the voice-capture path. NO DOM, NO network,
   NO secrets — safe to import in the browser (Step D), in Node tests,
   and (conceptually) it mirrors the cost/cap math the roybal-ai-ingest
   Edge Function runs server-side.

   Two jobs:
   1. candidateChips(formKey, candidates) — turn the Edge Function's
      extracted candidates (the JSON it returns) into tap-to-confirm
      CHIPS whose `target` says exactly where each value writes into the
      model.js project blob. Field names match model.js EXACTLY
      (affT/affRH/outT/outRH, equipment type/location/placed/removed,
      photo stage/caption/room, work row employee/task/start/finish/hours).
   2. estimateCost / sumUsd / isOverCap — the spend-cap arithmetic. The
      Edge Function is the source of truth for real spend (it writes the
      ai_usage ledger); this is the same formula so it can be unit-tested
      without a network and reused client-side for display.
   ============================================================ */

/* The forms that get a 🎙️ Transcribe button (handoff Step D + Phase 4
   construction forms — a tech walking a unit dictates rows hands-free). */
export const AI_FORM_KEYS = [
  "moistureMaps", "dryingLogs", "photos", "constructionLogs",
  "punchList", "subSchedule", "inspections", "selections", "changeOrders",
];

/* Below this, a chip renders amber so the tech double-checks the value. */
export const LOW_CONFIDENCE = 0.7;

export function confidenceTone(confidence) {
  const c = Number(confidence);
  return Number.isFinite(c) && c >= LOW_CONFIDENCE ? "green" : "amber";
}

/* ---------- small helpers ---------- */
const arr = (v) => (Array.isArray(v) ? v : []);
const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/* Map a psychrometric location to its model.js temp/RH field pair. */
const PSYCHRO_FIELDS = {
  affected:  { t: "affT", rh: "affRH", label: "Affected area" },
  outside:   { t: "outT", rh: "outRH", label: "Outside" },
  reference: { t: "refT", rh: "refRH", label: "Reference" },
};

/* ============================================================
   candidateChips(formKey, candidates) -> [{ id, formKey, label,
     value, confidence, tone, target }]
   target = { group, field, meta? } where:
     group = null      -> writes on the form instance / project field
     group = 'readings'|'equipment'|'rows' -> writes on a row of that array
   Step D renders these as chips and, on confirm, writes target.field=value
   into the project via the app's normal save path (Store.put).
   ============================================================ */
export function candidateChips(formKey, candidates) {
  const c = candidates || {};
  switch (formKey) {
    case "dryingLogs":      return dryingLogChips(c);
    case "moistureMaps":    return moistureMapChips(c);
    case "photos":          return photoChips(c);
    case "constructionLogs":return constructionLogChips(c);
    case "punchList":       return punchListChips(c);
    case "subSchedule":     return subScheduleChips(c);
    case "inspections":     return inspectionChips(c);
    case "selections":      return selectionsChips(c);
    case "changeOrders":    return changeOrderChips(c);
    default:                return [];
  }
}

let _seq = 0;
const chip = (formKey, label, value, confidence, target) => ({
  id: `${formKey}:${target.group || "_"}:${target.field}:${_seq++}`,
  formKey, label, value,
  confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : undefined,
  tone: confidenceTone(confidence),
  target,
});

/* Drying Log: psychrometric -> readings[] (affT/affRH/outT/outRH/refT/refRH);
   equipment -> equipment[] (type/location/placed/removed). */
function dryingLogChips(c) {
  const chips = [];
  for (const p of arr(c.psychrometric)) {
    const map = PSYCHRO_FIELDS[String(p.location || "").toLowerCase()];
    if (!map) continue;
    if (has(p.temp)) chips.push(chip("dryingLogs", `${map.label} temp`, p.temp, p.confidence, { group: "readings", field: map.t }));
    if (has(p.rh))   chips.push(chip("dryingLogs", `${map.label} RH`,   p.rh,   p.confidence, { group: "readings", field: map.rh }));
  }
  for (const e of arr(c.equipment)) {
    const where = has(e.location) ? ` (${e.location})` : "";
    if (has(e.type))     chips.push(chip("dryingLogs", `Equipment${where}`,      e.type,     e.confidence, { group: "equipment", field: "type", meta: { count: e.count } }));
    if (has(e.location)) chips.push(chip("dryingLogs", `Equipment location`,     e.location, e.confidence, { group: "equipment", field: "location" }));
    if (has(e.placed))   chips.push(chip("dryingLogs", `Equipment placed`,       e.placed,   e.confidence, { group: "equipment", field: "placed" }));
    if (has(e.removed))  chips.push(chip("dryingLogs", `Equipment removed`,      e.removed,  e.confidence, { group: "equipment", field: "removed" }));
  }
  return chips;
}

/* Moisture Map: instance-level material/dryGoal/label + readings[] (MC% per location). */
function moistureMapChips(c) {
  const chips = [];
  if (has(c.label))    chips.push(chip("moistureMaps", "Area / room",  c.label,    c.confidence, { group: null, field: "label" }));
  if (has(c.material)) chips.push(chip("moistureMaps", "Material",     c.material, c.confidence, { group: null, field: "material" }));
  if (has(c.dryGoal))  chips.push(chip("moistureMaps", "Dry goal",     c.dryGoal,  c.confidence, { group: null, field: "dryGoal" }));
  for (const r of arr(c.readings)) {
    if (!has(r.mc_pct)) continue;
    const at = has(r.location) ? ` at ${r.location}` : "";
    chips.push(chip("moistureMaps", `MC%${at}`, r.mc_pct, r.confidence, { group: "readings", field: "values", meta: { location: r.location } }));
  }
  return chips;
}

/* Photos: stage/room/caption per photo. */
function photoChips(c) {
  const chips = [];
  arr(c.photos).forEach((ph, i) => {
    const tag = `Photo ${i + 1}`;
    if (has(ph.stage))   chips.push(chip("photos", `${tag} stage`,   ph.stage,   ph.confidence, { group: null, field: "stage", meta: { index: i } }));
    if (has(ph.room))    chips.push(chip("photos", `${tag} room`,    ph.room,    ph.confidence, { group: null, field: "room", meta: { index: i } }));
    if (has(ph.caption)) chips.push(chip("photos", `${tag} caption`, ph.caption, ph.confidence, { group: null, field: "caption", meta: { index: i } }));
  });
  return chips;
}

/* Punch List: rows[] (area/item/trade/priority). */
function punchListChips(c) {
  const chips = [];
  arr(c.rows).forEach((r, i) => {
    const at = has(r.area) ? r.area : `Item ${i + 1}`;
    if (has(r.area))     chips.push(chip("punchList", "Area",              r.area,     r.confidence, { group: "rows", field: "area", meta: { index: i } }));
    if (has(r.item))     chips.push(chip("punchList", `${at} — item`,      r.item,     r.confidence, { group: "rows", field: "item", meta: { index: i } }));
    if (has(r.trade))    chips.push(chip("punchList", `${at} — trade`,     r.trade,    r.confidence, { group: "rows", field: "trade", meta: { index: i } }));
    if (has(r.priority)) chips.push(chip("punchList", `${at} — priority`,  r.priority, r.confidence, { group: "rows", field: "priority", meta: { index: i } }));
  });
  return chips;
}

/* Sub Schedule: rows[] (trade/company/schedStart/schedEnd/status). */
function subScheduleChips(c) {
  const chips = [];
  arr(c.rows).forEach((r, i) => {
    const who = has(r.trade) ? r.trade : `Trade ${i + 1}`;
    if (has(r.trade))      chips.push(chip("subSchedule", "Trade",               r.trade,      r.confidence, { group: "rows", field: "trade", meta: { index: i } }));
    if (has(r.company))    chips.push(chip("subSchedule", `${who} — company`,    r.company,    r.confidence, { group: "rows", field: "company", meta: { index: i } }));
    if (has(r.schedStart)) chips.push(chip("subSchedule", `${who} — start`,      r.schedStart, r.confidence, { group: "rows", field: "schedStart", meta: { index: i } }));
    if (has(r.schedEnd))   chips.push(chip("subSchedule", `${who} — end`,        r.schedEnd,   r.confidence, { group: "rows", field: "schedEnd", meta: { index: i } }));
    if (has(r.status))     chips.push(chip("subSchedule", `${who} — status`,     r.status,     r.confidence, { group: "rows", field: "status", meta: { index: i } }));
  });
  return chips;
}

/* Inspection record: instance-level fields. */
function inspectionChips(c) {
  const chips = [];
  const f = (key, label, v) => { if (has(v)) chips.push(chip("inspections", label, v, c.confidence, { group: null, field: key })); };
  f("type", "Inspection type", c.type);
  f("scheduled", "Scheduled date", c.scheduled);
  f("inspector", "Inspector", c.inspector);
  f("result", "Result", c.result);
  f("corrections", "Corrections", c.corrections);
  f("reinspection", "Reinspection date", c.reinspection);
  return chips;
}

/* Selections: rows[] (area/item/spec/allowance). */
function selectionsChips(c) {
  const chips = [];
  arr(c.rows).forEach((r, i) => {
    const at = has(r.item) ? r.item : `Selection ${i + 1}`;
    if (has(r.area))      chips.push(chip("selections", "Area",              r.area,      r.confidence, { group: "rows", field: "area", meta: { index: i } }));
    if (has(r.item))      chips.push(chip("selections", "Selection item",    r.item,      r.confidence, { group: "rows", field: "item", meta: { index: i } }));
    if (has(r.spec))      chips.push(chip("selections", `${at} — spec`,      r.spec,      r.confidence, { group: "rows", field: "spec", meta: { index: i } }));
    if (has(r.allowance)) chips.push(chip("selections", `${at} — allowance`, r.allowance, r.confidence, { group: "rows", field: "allowance", meta: { index: i } }));
  });
  return chips;
}

/* Change Order: description + schedule days + priced line items.
   ("found rot behind the tub, sister the joists, roughly $1,800") */
function changeOrderChips(c) {
  const chips = [];
  if (has(c.description)) chips.push(chip("changeOrders", "Description", c.description, c.confidence, { group: null, field: "description" }));
  if (has(c.daysAdded))   chips.push(chip("changeOrders", "Days added",  c.daysAdded,   c.confidence, { group: null, field: "daysAdded" }));
  arr(c.items).forEach((it, i) => {
    const at = has(it.desc) ? String(it.desc).slice(0, 24) : `Line ${i + 1}`;
    if (has(it.desc))  chips.push(chip("changeOrders", "Line item",        it.desc,  it.confidence, { group: "items", field: "desc", meta: { index: i } }));
    if (has(it.qty))   chips.push(chip("changeOrders", `${at} — qty`,      it.qty,   it.confidence, { group: "items", field: "qty", meta: { index: i } }));
    if (has(it.unit))  chips.push(chip("changeOrders", `${at} — unit`,     it.unit,  it.confidence, { group: "items", field: "unit", meta: { index: i } }));
    if (has(it.price)) chips.push(chip("changeOrders", `${at} — price`,    it.price, it.confidence, { group: "items", field: "price", meta: { index: i } }));
  });
  return chips;
}

/* Daily Construction Log: rows[] (employee/task/start/finish/hours) + notes. */
function constructionLogChips(c) {
  const chips = [];
  arr(c.rows).forEach((r, i) => {
    const who = has(r.employee) ? r.employee : `Row ${i + 1}`;
    if (has(r.employee)) chips.push(chip("constructionLogs", `Crew member`,      r.employee, r.confidence, { group: "rows", field: "employee", meta: { index: i } }));
    if (has(r.task))     chips.push(chip("constructionLogs", `${who} — task`,    r.task,     r.confidence, { group: "rows", field: "task", meta: { index: i } }));
    if (has(r.start))    chips.push(chip("constructionLogs", `${who} — start`,   r.start,    r.confidence, { group: "rows", field: "start", meta: { index: i } }));
    if (has(r.finish))   chips.push(chip("constructionLogs", `${who} — finish`,  r.finish,   r.confidence, { group: "rows", field: "finish", meta: { index: i } }));
    if (has(r.hours))    chips.push(chip("constructionLogs", `${who} — hours`,   r.hours,    r.confidence, { group: "rows", field: "hours", meta: { index: i } }));
  });
  if (has(c.notes)) chips.push(chip("constructionLogs", "Notes", c.notes, c.confidence, { group: null, field: "notes" }));
  return chips;
}

/* ============================================================
   Rebuild draft chips (Phase 3: restoration → construction).
   The roybal-ai-office `rebuildDraft` action returns
     { scopeAreas:[{area, items:[{trade,desc,qty,unit,confidence}]}],
       tradeSequence:[{trade, note}], selections:[{area,item,spec,confidence}],
       questions:[...] }
   rebuildChips() flattens that into confirm-chips; applyRebuildChips()
   writes the confirmed ones into scopeOfWork / subSchedule / selections.
   Factories arrive via `mk` (same pattern as applyChips) so this module
   stays free of model.js and Node-testable.
   ============================================================ */
export function rebuildChips(draft) {
  const d = draft || {};
  const chips = [];
  for (const a of arr(d.scopeAreas)) {
    const area = String(a.area || "").trim() || "General";
    for (const it of arr(a.items)) {
      if (!has(it.desc)) continue;
      // the schema uses qty 0 as "unknown" — never let the sentinel reach the form
      const qty = Number(it.qty) > 0 ? it.qty : "";
      const qtyStr = qty === "" ? "" : [qty, it.unit].filter(has).join(" ");
      chips.push(chip("rebuild",
        `${area}${has(it.trade) ? " — " + it.trade : ""}`,
        String(it.desc) + (qtyStr ? ` (${qtyStr})` : ""),
        it.confidence,
        { group: "scopeItems", field: "desc",
          meta: { area, trade: it.trade || "", desc: String(it.desc), qty, unit: qty === "" ? "" : (it.unit || "") } }));
    }
  }
  arr(d.tradeSequence).forEach((t, i) => {
    if (!has(t.trade)) return;
    chips.push(chip("rebuild", `Trade ${i + 1}`, t.trade, t.confidence,
      { group: "subRows", field: "trade", meta: { trade: String(t.trade), notes: t.note || "" } }));
  });
  for (const s of arr(d.selections)) {
    if (!has(s.item)) continue;
    chips.push(chip("rebuild", `Selection${has(s.area) ? " — " + s.area : ""}`, s.item, s.confidence,
      { group: "selectionRows", field: "item", meta: { area: s.area || "", item: String(s.item), spec: s.spec || "" } }));
  }
  return chips;
}

/* Reuse a trailing factory-blank row, else append a fresh one. */
function takeRow(list, isBlank, fresh) {
  const last = list[list.length - 1];
  if (last && isBlank(last)) return last;
  list.push(fresh);
  return fresh;
}

export function applyRebuildChips(project, chips, mk = {}) {
  const list = arr(chips).filter((c) => c && c.confirmed !== false && c.target);
  let applied = 0;
  // an off-list trade would render blank in the form's trade <select> —
  // coerce to "Other" and keep the model's wording in the row notes
  const normTrade = (t) => (!has(t) || !Array.isArray(mk.trades) || mk.trades.includes(t)) ? (t || "") : "Other";
  const tradeNote = (t) => (normTrade(t) === "Other" && has(t) && t !== "Other") ? t : "";
  for (const c of list) {
    const t = c.target, m = t.meta || {};
    if (t.group === "scopeItems") {
      if (!project.scopeOfWork && mk.scope) project.scopeOfWork = mk.scope();
      const scope = project.scopeOfWork;
      if (!scope) continue;
      if (!Array.isArray(scope.areas)) scope.areas = [];
      let area = scope.areas.find((a) => String(a.name || "").trim().toLowerCase() === m.area.toLowerCase());
      if (!area) {
        area = takeRow(scope.areas, (a) => !has(a.name) && !arr(a.items).some((it) => has(it.desc)),
          mk.scopeArea ? mk.scopeArea() : { name: "", items: [] });
        area.name = m.area;
      }
      if (!Array.isArray(area.items)) area.items = [];
      const row = takeRow(area.items, (it) => !has(it.desc) && !has(it.trade),
        mk.scopeItem ? mk.scopeItem() : {});
      row.trade = normTrade(m.trade); row.desc = m.desc; row.qty = String(m.qty ?? ""); row.unit = m.unit;
      const tn = tradeNote(m.trade);
      if (tn) row.notes = tn;
      applied++;
    } else if (t.group === "subRows") {
      if (!project.subSchedule && mk.subSchedule) project.subSchedule = mk.subSchedule();
      const ss = project.subSchedule;
      if (!ss) continue;
      if (!Array.isArray(ss.rows)) ss.rows = [];
      const row = takeRow(ss.rows, (r) => !has(r.trade) && !has(r.company), mk.subRow ? mk.subRow() : {});
      row.trade = normTrade(m.trade);
      const note = [tradeNote(m.trade), has(m.notes) ? m.notes : ""].filter(Boolean).join(" — ");
      if (note) row.notes = note;
      applied++;
    } else if (t.group === "selectionRows") {
      if (!project.selections && mk.selections) project.selections = mk.selections();
      const sl = project.selections;
      if (!sl) continue;
      if (!Array.isArray(sl.rows)) sl.rows = [];
      const row = takeRow(sl.rows, (r) => !has(r.item) && !has(r.area), mk.selectionRow ? mk.selectionRow() : {});
      row.area = m.area; row.item = m.item;
      if (has(m.spec)) row.spec = m.spec;
      row.status = "pending";
      applied++;
    }
  }
  return { applied };
}

/* ============================================================
   Spend-cap arithmetic (mirrors the Edge Function exactly).
   Prices are per-unit; the function passes them from its env so a price
   change is a config edit, not a code edit.
   ============================================================ */
export function estimateCost({
  audioSeconds = 0,
  sttPricePerMin = 0,
  inputTokens = 0,
  outputTokens = 0,
  llmPriceInPerMTok = 0,
  llmPriceOutPerMTok = 0,
} = {}) {
  const stt = (Number(audioSeconds) / 60) * Number(sttPricePerMin);
  const llm =
    (Number(inputTokens) / 1e6) * Number(llmPriceInPerMTok) +
    (Number(outputTokens) / 1e6) * Number(llmPriceOutPerMTok);
  const safe = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
  const sttCost = safe(stt), llmCost = safe(llm);
  return { sttCost, llmCost, total: sttCost + llmCost };
}

/* Sum cost_usd across ai_usage rows (e.g. the current billing month). */
export function sumUsd(rows) {
  return arr(rows).reduce((acc, r) => {
    const n = Number(r && r.cost_usd);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/* Cap is a hard ceiling: at or over the cap, refuse new AI spend. */
export function isOverCap(spentUsd, capUsd) {
  const spent = Number(spentUsd) || 0;
  const cap = Number(capUsd);
  if (!Number.isFinite(cap) || cap <= 0) return false; // cap unset/0 -> never blocks
  return spent >= cap;
}

/* ============================================================
   Write-back (Step D): apply confirmed chips into the project blob,
   matching model.js shapes. Pure — the caller (voice.js) supplies fresh
   blank-row/photo factories via `mk` so this module stays free of
   model.js / core.js (and therefore Node-testable).

   - group 'readings'|'equipment'|'rows' -> a row of instance[group];
     reuse a trailing blank row if present, else append a fresh one.
   - group null -> an instance-level field (material/dryGoal/label/notes).
   - photos -> each meta.index becomes one new project.photos entry.
   Chips with confirmed === false are skipped (the UI sets this).
   ============================================================ */

// Fields that decide whether an existing row is "blank" (and thus reusable).
const ROW_KEYFIELDS = {
  "dryingLogs:readings": ["affT", "affRH", "outT", "outRH", "refT", "refRH"],
  "dryingLogs:equipment": ["type", "location", "placed", "removed"],
  "constructionLogs:rows": ["employee", "task", "start", "finish", "hours"],
  "punchList:rows": ["area", "item", "trade"],
  "subSchedule:rows": ["trade", "company"],
  "selections:rows": ["area", "item", "spec"],
  "changeOrders:items": ["desc", "qty", "price"],
  // moistureMaps:readings is special — emptiness is decided by the values[] grid.
};

function rowIsBlank(formKey, group, row) {
  if (!row) return false;
  if (formKey === "moistureMaps" && group === "readings") return !arr(row.values).some(has);
  const keys = ROW_KEYFIELDS[`${formKey}:${group}`];
  return !!keys && keys.every((k) => !has(row[k]));
}

function getOrCreateRow(instance, formKey, group, mk) {
  if (!Array.isArray(instance[group])) instance[group] = [];
  const list = instance[group];
  const last = list[list.length - 1];
  if (rowIsBlank(formKey, group, last)) return last;
  const fresh = (mk && mk.row) ? mk.row(group) : {};
  list.push(fresh);
  return fresh;
}

function setRowField(formKey, group, row, chip) {
  if (formKey === "moistureMaps" && group === "readings" && chip.target.field === "values") {
    if (!Array.isArray(row.values)) row.values = [];
    const i = row.values.findIndex((v) => !has(v));
    row.values[i >= 0 ? i : row.values.length] = chip.value;
    return;
  }
  row[chip.target.field] = chip.value;
}

export function applyChips(formKey, instance, project, chips, mk = {}) {
  const list = arr(chips).filter((c) => c && c.confirmed !== false && c.target);
  let applied = 0;

  if (formKey === "photos") {
    const byIndex = new Map();
    for (const c of list) {
      const idx = (c.target.meta && c.target.meta.index) ?? 0;
      if (!byIndex.has(idx)) byIndex.set(idx, (mk && mk.photo) ? mk.photo() : { stage: "", room: "", caption: "" });
      byIndex.get(idx)[c.target.field] = c.value;
      applied++;
    }
    if (!Array.isArray(project.photos)) project.photos = [];
    for (const ph of byIndex.values()) project.photos.push(ph);
    return { applied };
  }

  const rows = new Map(); // `${group}#${index}` -> the row object to fill
  for (const c of list) {
    const group = c.target.group;
    if (!group) { instance[c.target.field] = c.value; applied++; continue; }
    const idx = (c.target.meta && c.target.meta.index) ?? 0;
    const key = `${group}#${idx}`;
    if (!rows.has(key)) rows.set(key, getOrCreateRow(instance, formKey, group, mk));
    setRowField(formKey, group, rows.get(key), c);
    applied++;
  }
  return { applied };
}
