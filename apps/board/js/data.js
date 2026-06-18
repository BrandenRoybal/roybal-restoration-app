/* ============================================================
   Roybal Job Board — data layer
   Talks to its OWN Supabase tables (coordination_jobs, crew_members)
   but shares the field app's login session, so signing in anywhere
   (field / admin / board) signs you in everywhere on this origin.

   Strategy (office-first, resilient):
     • localStorage cache → instant load + offline read
     • optimistic writes → UI updates immediately
     • failed writes are queued and flushed on the next online action
     • last-edit-wins on the server (updated_at trigger)
   ============================================================ */
import { SYNC_ENABLED } from "../../js/config.js";
import { rest, isSignedIn, signIn, signOut, currentEmail } from "../../js/supa.js";
import { DEFAULT_SETTINGS } from "./schedule.js";

/* re-export auth so the UI imports everything board-related from here */
export { isSignedIn, signIn, signOut, currentEmail, SYNC_ENABLED };

const JOBS_TABLE = "coordination_jobs";
const CREW_TABLE = "crew_members";
const TIME_TABLE = "time_entries";
const J_KEY = "roybal-board-jobs";
const C_KEY = "roybal-board-crew";
const T_KEY = "roybal-board-time";
const Q_KEY = "roybal-board-queue";
const S_KEY = "roybal-board-settings";
/* schedule settings ride in the jobs table under one reserved id so the work
   calendar syncs across devices with no new table. It's filtered out of jobs. */
const SETTINGS_ID = "__settings__";

/* ---------- local cache ---------- */
function readCache(k) { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } }
function readObj(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function writeCache(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
export function cachedJobs() { return readCache(J_KEY).filter((j) => j && j.id !== SETTINGS_ID); }
export function cachedCrew() { return readCache(C_KEY); }
export function cachedEntries() { return readCache(T_KEY); }
export function cachedSettings() { return { ...DEFAULT_SETTINGS, ...(readObj(S_KEY) || {}) }; }

/* ---------- schedule settings (work calendar) ---------- */
export async function saveSettings(s) {
  writeCache(S_KEY, s);
  const row = { id: SETTINGS_ID, data: s, deleted: false };
  if (!SYNC_ENABLED) return s;
  try { await upsert(JOBS_TABLE, [row]); } catch { enqueue(JOBS_TABLE, row); }
  return s;
}

/* ---------- offline write queue ---------- */
function queue() { return readCache(Q_KEY); }
function setQueue(q) { writeCache(Q_KEY, q); }
function enqueue(table, row) { const q = queue(); q.push({ table, row }); setQueue(q); }
export function pendingCount() { return queue().length; }

async function flushQueue() {
  const q = queue();
  if (!q.length) return;
  const remaining = [];
  for (const item of q) {
    try { await upsert(item.table, [item.row]); }
    catch { remaining.push(item); }
  }
  setQueue(remaining);
}

/* ---------- low-level REST ---------- */
async function upsert(table, rows) {
  const res = await rest(table, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("save " + res.status + " " + (await res.text().catch(() => "")));
  return res.json();
}
async function getAll(table) {
  const res = await rest(`${table}?select=id,data,deleted,updated_at&order=updated_at.asc`, { method: "GET" });
  if (!res.ok) throw new Error("load " + res.status);
  return res.json();
}

/* ---------- pull (refresh from server) ---------- */
/** Flush any queued writes, then load both tables and refresh the cache.
    Returns { jobs, crew }. Throws if offline (caller falls back to cache). */
export async function pull() {
  if (!SYNC_ENABLED) return { jobs: cachedJobs(), crew: cachedCrew(), entries: cachedEntries() };
  await flushQueue();
  const [jrows, crows, trows] = await Promise.all([getAll(JOBS_TABLE), getAll(CREW_TABLE), getAll(TIME_TABLE)]);
  const srow = jrows.find((r) => r.id === SETTINGS_ID && !r.deleted);
  if (srow && srow.data) writeCache(S_KEY, srow.data);
  const jobs = jrows.filter((r) => !r.deleted && r.id !== SETTINGS_ID).map((r) => r.data);
  const crew = crows.filter((r) => !r.deleted).map((r) => r.data);
  const entries = trows.filter((r) => !r.deleted).map((r) => r.data);
  writeCache(J_KEY, jobs);
  writeCache(C_KEY, crew);
  writeCache(T_KEY, entries);
  return { jobs, crew, entries };
}

/* ---------- jobs ---------- */
export async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  if (!job.createdAt) job.createdAt = job.updatedAt;
  writeCache(J_KEY, [...cachedJobs().filter((j) => j.id !== job.id), job]);
  const row = { id: job.id, data: job, deleted: false };
  if (!SYNC_ENABLED) return job;
  try { await upsert(JOBS_TABLE, [row]); } catch { enqueue(JOBS_TABLE, row); }
  return job;
}
export async function deleteJob(id) {
  const job = cachedJobs().find((j) => j.id === id);
  writeCache(J_KEY, cachedJobs().filter((j) => j.id !== id));
  if (!SYNC_ENABLED) return;
  const row = { id, data: job || { id }, deleted: true };
  try { await upsert(JOBS_TABLE, [row]); } catch { enqueue(JOBS_TABLE, row); }
}

/* ---------- crew ---------- */
export async function saveCrewMember(member) {
  member.updatedAt = new Date().toISOString();
  if (!member.createdAt) member.createdAt = member.updatedAt;
  writeCache(C_KEY, [...cachedCrew().filter((c) => c.id !== member.id), member]);
  const row = { id: member.id, data: member, deleted: false };
  if (!SYNC_ENABLED) return member;
  try { await upsert(CREW_TABLE, [row]); } catch { enqueue(CREW_TABLE, row); }
  return member;
}
export async function deleteCrewMember(id) {
  const m = cachedCrew().find((c) => c.id === id);
  writeCache(C_KEY, cachedCrew().filter((c) => c.id !== id));
  if (!SYNC_ENABLED) return;
  const row = { id, data: m || { id }, deleted: true };
  try { await upsert(CREW_TABLE, [row]); } catch { enqueue(CREW_TABLE, row); }
}

/* ---------- time entries ---------- */
export async function saveTimeEntry(entry) {
  entry.updatedAt = new Date().toISOString();
  if (!entry.createdAt) entry.createdAt = entry.updatedAt;
  writeCache(T_KEY, [...cachedEntries().filter((e) => e.id !== entry.id), entry]);
  const row = { id: entry.id, data: entry, deleted: false };
  if (!SYNC_ENABLED) return entry;
  try { await upsert(TIME_TABLE, [row]); } catch { enqueue(TIME_TABLE, row); }
  return entry;
}
export async function deleteTimeEntry(id) {
  const e = cachedEntries().find((x) => x.id === id);
  writeCache(T_KEY, cachedEntries().filter((x) => x.id !== id));
  if (!SYNC_ENABLED) return;
  const row = { id, data: e || { id }, deleted: true };
  try { await upsert(TIME_TABLE, [row]); } catch { enqueue(TIME_TABLE, row); }
}
