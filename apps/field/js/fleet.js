/* ============================================================
   Roybal Field Forms — the equipment fleet list (shared with admin)
   ------------------------------------------------------------
   The office keeps one row per labelled machine in
   public.equipment_units (migration 0022): tag, type, make/model,
   rating, owned/rented, status. The scanner reads it to name what
   it just read (an "AM-014" label already says air mover; a plain
   "101" needs the list or a pick), and the office's Equipment tab
   edits it.

   Field devices work offline for days, so the last good read is
   cached in localStorage and used until the next one answers.
   `fleetReady()` says the server table has answered at least once
   on this device: until the 0022 database update is applied the
   Drying Log keeps its scan button switched off, rather than
   recording scans the server can't take in yet.
   ============================================================ */
import { rest, isSignedIn } from "./supa.js";
import { SYNC_ENABLED } from "./config.js";
import { TYPE_LABELS, tagKey } from "./scans.js";

const FLEET_KEY = "roybal-fleet";
const READY_KEY = "roybal-fleet-ready";
const PATH = "equipment_units?select=id,tag,type,make,model,rating,owned,status,notes&order=tag";

const clean = (v) => (v == null ? "" : String(v)).replace(/\s+/g, " ").trim();

/** The cached fleet list (last good server read), [] when there is none. */
export function loadFleet() {
  try {
    const v = JSON.parse(localStorage.getItem(FLEET_KEY) || "[]");
    return Array.isArray(v) ? v.filter((u) => u && typeof u === "object" && clean(u.tag)) : [];
  } catch { return []; }
}

/** True once the equipment_units table has answered on this device. */
export function fleetReady() {
  try { return localStorage.getItem(READY_KEY) === "1"; } catch { return false; }
}

function setReady(on) {
  try { if (on) localStorage.setItem(READY_KEY, "1"); else localStorage.removeItem(READY_KEY); } catch {}
}

/* PostgREST says a table isn't there with a 404, and PGRST205 ("Could not
   find the table … in the schema cache") on newer servers. */
async function missingTable(res) {
  if (res.status === 404) return true;
  try { const b = await res.clone().json(); return !!(b && b.code === "PGRST205"); } catch { return false; }
}

/** Read the fleet list from the server and cache it. Never throws:
    { ok:true, units } on a good read (and the ready flag goes on);
    { ok:false, missing:true } when the 0022 update isn't applied (the flag
    goes off); { ok:false, offline:true } with no network or no login, and
    { ok:false, status } for any other refusal, both keeping the cache and
    the flag. `units` is always the best list there is. (One read: PostgREST
    caps a read at 1000 rows, far more machines than the fleet has.) */
export async function refreshFleet() {
  const cached = () => loadFleet();
  if (!SYNC_ENABLED || !isSignedIn()) return { ok: false, units: cached(), missing: false, offline: true };
  try {
    const res = await rest(PATH, { method: "GET" });
    if (res.ok) {
      const rows = await res.json();
      const units = Array.isArray(rows) ? rows.filter((u) => u && typeof u === "object" && clean(u.tag)) : [];
      try { localStorage.setItem(FLEET_KEY, JSON.stringify(units)); } catch {}
      setReady(true);
      return { ok: true, units, missing: false };
    }
    if (await missingTable(res)) {
      setReady(false);
      return { ok: false, units: cached(), missing: true };
    }
    return { ok: false, units: cached(), missing: false, offline: false, status: res.status };
  } catch {
    return { ok: false, units: cached(), missing: false, offline: true };
  }
}

/** The fleet row for a tag (AM-14 finds AM-014), or null. */
export function unitFor(units, tag) {
  const key = tagKey(tag);
  if (!key || !Array.isArray(units)) return null;
  return units.find((u) => u && tagKey(u.tag) === key) || null;
}

/** "Air mover" for a fleet row's type code ("" when unknown). */
export function unitLabel(unit) {
  const t = unit && unit.type;
  return t && Object.prototype.hasOwnProperty.call(TYPE_LABELS, t) ? TYPE_LABELS[t] : "";
}

/** "Make Model · rating" (e.g. "Acme X3 · 1/3 hp"), "" for nothing. */
export function unitModelText(unit) {
  if (!unit || typeof unit !== "object") return "";
  const mm = [clean(unit.make), clean(unit.model)].filter(Boolean).join(" ");
  return [mm, clean(unit.rating)].filter(Boolean).join(" · ");
}

/** What a printed label's QR encodes: "RC:AM-014". */
export function labelPayload(tag) {
  return "RC:" + clean(tag);
}
