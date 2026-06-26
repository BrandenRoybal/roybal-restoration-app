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

/* The four forms that get a 🎙️ Transcribe button (handoff Step D). */
export const AI_FORM_KEYS = ["moistureMaps", "dryingLogs", "photos", "constructionLogs"];

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
