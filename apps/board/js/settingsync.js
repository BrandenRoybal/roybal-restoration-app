/* ============================================================
   Roybal Job Board — settings-row sync (pure helpers)
   ------------------------------------------------------------
   The work calendar (workDays / hoursPerDay / holidays) and the
   Gantt baseline ride ONE reserved row in coordination_jobs so
   they sync across devices with no extra table.

   History: that row was keyed '__settings__' — but the column is
   uuid, so every save 400'd (22P02), parked itself in the offline
   queue, and retried forever. Settings only ever lived in each
   browser's localStorage, and every server consumer silently fell
   back to DEFAULT_SETTINGS. Fixed 2026-09 by reserving a real,
   fixed uuid instead.

   Pure ESM, no imports — testable in Node (test/settingsync.test.mjs),
   same pattern as schedule.js / crewmerge.js.
   ============================================================ */

/* The reserved row id. A fixed uuid: valid for the column, and it can
   never collide with crypto.randomUUID() output (v4 ids always carry
   version/variant bits this one lacks). Consumers hardcode the literal
   the way they hardcoded '__settings__' — grep for it when adding a
   reader: this file + data.js, field myweek.js + boardpush.js,
   roybal-brief, roybal-ai-office, roybal-portal, phone-agent tools.mjs. */
export const SETTINGS_UUID = "00000000-0000-0000-0000-000000000001";

/* The old, impossible id — recognized only to clean up after it. */
export const LEGACY_SETTINGS_ID = "__settings__";

/* The row a settings save writes. data.archived is a compatibility
   shim, NOT a setting: stale cached bundles (the SW staleness trap)
   filter this row out by the OLD id only, so to them it would render
   as a blank job — but all of them already hide archived rows. Fixed
   code never sees it as a job at all (excluded by row id), and every
   settings reader finds it by row id before any archived filter. */
export function settingsRow(s) {
  return { id: SETTINGS_UUID, data: { ...s, archived: true }, deleted: false };
}

/* Queue entries writing the legacy id can never land (uuid column) —
   left alone they retry on every flush forever and inflate the
   pending badge. Drop them wherever the queue is read. */
export function isDoomedSettingsWrite(item) {
  return !!(item && item.row && item.row.id === LEGACY_SETTINGS_ID);
}
export function dropDoomedSettingsWrites(q) {
  return (q || []).filter((it) => !isDoomedSettingsWrite(it));
}

/* What pull() should do about settings, given the server's job rows
   and this device's cached settings:
     • server row present → adopt the server copy (shim key stripped)
     • server row absent, device has real settings → publish them —
       the one-time migration: every pre-fix edit only ever landed
       locally, so the first fixed device to pull seeds the server
     • neither → nothing
   A deleted server row counts as absent (publishing resurrects it),
   and an empty local object is never worth publishing. */
export function reconcileSettings(rows, local) {
  const srow = (rows || []).find(
    (r) => r && r.id === SETTINGS_UUID && !r.deleted && r.data && typeof r.data === "object");
  if (srow) {
    const data = { ...srow.data };
    delete data.archived;
    return { adopt: data, publish: null };
  }
  const real = local && typeof local === "object" && Object.keys(local).length ? local : null;
  return { adopt: null, publish: real };
}
