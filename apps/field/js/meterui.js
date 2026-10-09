/* ============================================================
   Roybal Field Forms — meter photos on the Moisture Map (screens)
   ------------------------------------------------------------
   The 📷 under a reading cell, the photo sheet it opens, the reader run,
   the printed "Meter photos" appendix and the Certificate of Drying's
   final readings. The data rules are meterphotos.js; this file is DOM,
   device storage and network.

   Switched on only once the server knows the photos (migration 0024):
   until then two phones photographing the same job between syncs could
   lose one phone's photos on the server. checkMeterServer() asks once;
   the answer is kept on the device (fleet.js does the same for scanning).

   Camera: a plain <input type=file capture=environment>, never a live
   stream — it opens the phone's own camera and never touches
   location.hash (a hash change kills an iOS home-screen camera, see
   scanner.js). The photo is saved on this device before anything else
   happens; the reader only ever adds to it.

   The reader: only the install that took a photo asks for its number
   (meterphotos.js `dev`), when the form opens or a sync completes with
   signal. Its answer lands on the job the page is showing when it is the
   same job (app.js registers it, as for Magicplan), else on the saved
   copy — never through the form's autosave, which may be editing another
   job by then.
   ============================================================ */
import { h, toast, fileToDataURL, flushPending, Store, uid, todayISO } from "./core.js";
import { commit } from "./formkit.js";
import { MARKER_RE } from "./media.js";
import { downloadMedia, rest, isSignedIn } from "./supa.js";
import { aiReady, readMeter } from "./officeai.js";
import { wallTime } from "./scans.js";
import { SYNC_ENABLED } from "./config.js";
import {
  METER_MAX_DIM, METER_QUALITY, meterList, addMeterPhoto, photoAt, cellState, needsRead, pendingReads,
  applyMeterRead, noteTyped, confirmMeterPhoto, useMeterRead, removeMeterPhotos, dropsPrefill, mapPhotoEntries,
  finalReadingPhotos, isLocalImage,
} from "./meterphotos.js";

/* swappable for tests (drylog-scan.test.mjs swaps scanDeps the same way) */
export const meterDeps = {
  read: (project, src, hint) => readMeter(project, src, hint),
  ready: () => aiReady(),
  pick: () => pickPhoto(),
  encode: (file) => fileToDataURL(file, METER_MAX_DIM, METER_QUALITY),
  /* 0024's sweep drops a tombstoned meter photo; 0022's leaves it. Crew
     logins may call the sweep (it was never revoked); meter_photos.test.sql
     fails if that ever changes, because this check depends on it. */
  probe: () => rest("rpc/_mf_sweep_tombstones", { method: "POST", body: JSON.stringify({
    blob: { meterPhotos: [{ id: "meter-probe" }], deletedIds: { "meter-probe": "2026-10-09T00:00:00.000Z" } } }) }),
};

/* ---------- small device-side memory (all of it best-effort) ---------- */
const DEV_KEY = "roybal-meter-dev";        // this install's tag on the photos it takes
const READY_KEY = "roybal-meter-ready";    // "1" once the server answered that it knows meter photos
const FILL_KEY = "roybal-meter-fill";      // the reader's last answer said it fills numbers
const JOBS_KEY = "roybal-meter-jobs";      // jobs holding photos this install still has to read
const TRIES_KEY = "roybal-meter-tries";    // photo id → reads refused (no-signal failures don't count)
const GIVE_UP = 5;
const getItem = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const setItem = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const readJson = (k, dflt) => { try { const v = JSON.parse(getItem(k) || ""); return v ?? dflt; } catch { return dflt; } };

let devTag = "";
/** This install's tag (made once, kept on the device). */
export function deviceTag() {
  if (devTag) return devTag;
  devTag = getItem(DEV_KEY) || "";
  if (!devTag) { devTag = uid(); setItem(DEV_KEY, devTag); }
  return devTag;
}
function lastFill() { return getItem(FILL_KEY) === "1"; }
function rememberFill(on) { setItem(FILL_KEY, on ? "1" : "0"); }
function triesMap() { const t = readJson(TRIES_KEY, {}); return t && typeof t === "object" && !Array.isArray(t) ? t : {}; }
const triesOf = (id) => Number(triesMap()[id]) || 0;
function bumpTries(id) {
  const t = triesMap();
  t[id] = (Number(t[id]) || 0) + 1;
  setItem(TRIES_KEY, JSON.stringify(Object.fromEntries(Object.entries(t).slice(-300))));
}
function waitingJobs() { const v = readJson(JOBS_KEY, []); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
function markJob(id, on) {
  const s = new Set(waitingJobs());
  if (on) s.add(id); else s.delete(id);
  setItem(JOBS_KEY, JSON.stringify([...s].slice(-200)));
}

/* ---------- is the server ready for meter photos? ---------- */
/** True once the server has answered that it merges meter photos (or this
    build runs without sync, where there is no server merge to wait for). */
export function meterServerReady() { return !SYNC_ENABLED || getItem(READY_KEY) === "1"; }
let serverCheck = null;
/** Ask the server once. Never throws: { ready } when it answered (the
    answer is kept), { offline:true } with no signal or no login, { status }
    for any other refusal (whatever was kept stands). */
export function checkMeterServer() {
  if (meterServerReady()) return Promise.resolve({ ready: true });
  if (!isSignedIn()) return Promise.resolve({ offline: true });
  if (serverCheck) return serverCheck;
  serverCheck = (async () => {
    try {
      const res = await meterDeps.probe();
      if (!res || !res.ok) return { status: res ? res.status : 0 };
      const body = await res.json().catch(() => null);
      const ready = !!body && Array.isArray(body.meterPhotos) && body.meterPhotos.length === 0;
      setItem(READY_KEY, ready ? "1" : null);
      return { ready };
    } catch {
      return { offline: true };
    } finally {
      serverCheck = null;
    }
  })();
  return serverCheck;
}

const login = (by) => String(by || "").split("@")[0];
function stamp(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(wallTime(ts) || "");
  return m ? `${m[2]}/${m[3]}/${m[1]} ${m[4]}` : "";
}
function dateLabel(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d || "");
}

function pickPhoto() {
  return new Promise((resolve) => {
    document.querySelectorAll("input.mp-pick").forEach((el) => el.remove());   // a cancelled earlier pick
    const input = h("input", { type: "file", accept: "image/*", capture: "environment", class: "mp-pick", style: "display:none" });
    input.addEventListener("change", () => { const f = input.files && input.files[0]; input.remove(); resolve(f || null); });
    input.addEventListener("cancel", () => { input.remove(); resolve(null); });
    document.body.append(input);
    input.click();
  });
}

/* ---------- cells on screen, so a read that lands repaints them ---------- */
const painters = new Map();   // job id → Set of cell repaint functions
function onScreen(projectId, paint) {
  let s = painters.get(projectId);
  if (!s) painters.set(projectId, (s = new Set()));
  s.add(paint);
}
function repaintJob(projectId) {
  const s = painters.get(projectId);
  if (!s) return;
  const states = new Set();
  for (const p of [...s]) if (p(states) === false) s.delete(p);   // a cell that left the page says so
  for (const f of states) f();     // the map's banner and printed photos once, not once per cell
}

/* ---------- the reader run ---------- */
let liveOf = () => null;
/** app.js: the job object the page on screen is bound to, by id (or null). */
export function onMeterLive(fn) { liveOf = typeof fn === "function" ? fn : () => null; }

let halted = "";                 // "off" | "capped" | "missing" | "trouble": asked no more until the app reloads
let trouble = 0;                 // server errors this session (an outage at the AI provider, say)
const running = new Map();       // job id → the run in flight
/* no signal, the 40 s timeout, an expired login: not the photo's fault */
const noSignal = (e) => e instanceof TypeError || (e && e.name === "AbortError") || (e && e.status === 401);
/* The photo's own fault: a picture the AI can't take, or can't make sense
   of. roybal-ai-office answers 400 for every error it throws, an AI
   provider outage (llm_failed (529)) or a missing key included, so only
   these messages count against the photo; anything else is the server's
   trouble. */
const photoFault = (e) => !!e && e.status === 400 &&
  /^(Couldn't read that photo|llm_failed \((400|413)\)|llm_truncated|extraction_failed)/.test(e.message || "");

/** Read every photo on this job that this install took and hasn't had
    read, one at a time. Stops on no signal (the next sync resumes), on a
    reader that is switched off, capped for the month or not deployed yet
    (until the app reloads), and gives a photo up after GIVE_UP refusals.
    Returns how many reads landed. */
export function readPendingMeters(project) {
  const id = project && project.id;
  if (!id) return Promise.resolve(0);
  if (running.has(id)) return running.get(id);
  const run = (async () => {
    const dev = deviceTag();
    const current = async () => liveOf(id) || (await Store.get(id)) || project;
    let n = 0;
    const ids = pendingReads(await current(), dev).map((p) => p.id);
    for (const phId of ids) {
      if (halted || !meterDeps.ready()) break;
      if (triesOf(phId) >= GIVE_UP) continue;
      const p = await current();
      const ph = meterList(p).find((x) => x.id === phId);
      if (!needsRead(ph, dev)) continue;
      const map = (p.moistureMaps || []).find((m) => m && m.id === ph.mapId);
      let reply;
      try {
        reply = await meterDeps.read(p, ph.src, {
          meter: map && map.meter, material: map && map.material,
          photoId: ph.id, mapId: ph.mapId, rowKey: ph.rowKey, loc: ph.loc,
        });
      } catch (e) {
        if (noSignal(e)) break;              // the next sync tries again
        if (photoFault(e)) {                 // refused (a bad image, say): given up after GIVE_UP
          bumpTries(phId);
          continue;
        }
        // the server's trouble, never counted against the photo; the next
        // photo still gets its turn, and after 3 the reader rests until the
        // app reloads (an outage costs 3 calls a session, not one per photo)
        if (++trouble >= 3) { halted = "trouble"; break; }
        continue;
      }
      if (!reply || reply.off || reply.capped || reply.missing) {
        halted = reply && reply.capped ? "capped" : reply && reply.missing ? "missing" : "off";
        break;
      }
      rememberFill(!!reply.fill);
      if (await land(id, phId, reply)) n++;
    }
    const after = await current();
    markJob(id, pendingReads(after, dev).some((p) => triesOf(p.id) < GIVE_UP));
    return n;
  })().catch(() => 0).finally(() => { running.delete(id); });
  running.set(id, run);
  return run;
}

/* the job the page is showing (when it's this one), else the saved copy;
   written straight to the store, like magicplan.js writeJob */
async function land(projectId, phId, reply) {
  const live = liveOf(projectId);
  const cur = live || (await Store.get(projectId));
  if (!cur) return false;
  const ph = meterList(cur).find((x) => x.id === phId);
  if (!ph || ph.read) return false;          // deleted or retaken meanwhile
  const { filled } = applyMeterRead(cur, ph, reply);
  await Store.put(cur);
  if (live) {
    repaintJob(projectId);
    if (filled) toast(`Read ${ph.read.value} from the meter photo (location ${ph.loc + 1}). Check it, then tap ?.`, 3500);
  }
  return true;
}

/** The Moisture Map opened: read this job's waiting photos if we can. */
export function readWaitingMeters(project) {
  if (!project || halted || !meterDeps.ready()) return;
  if (pendingReads(project, deviceTag()).length) readPendingMeters(project);
}

/** A sync completed: read the waiting photos of every job that has some. */
export function readAllWaitingMeters() {
  if (halted || !meterDeps.ready()) return;
  for (const id of waitingJobs()) {
    if (running.has(id)) continue;
    Store.get(id).then((p) => {
      if (!p) { markJob(id, false); return; }
      if (pendingReads(p, deviceTag()).length) readPendingMeters(p); else markJob(id, false);
    }).catch(() => {});
  }
}

/* ---------- the 📷 under one reading cell ---------- */
const BADGE = { none: "📷", pending: "⏳", photo: "📷", check: "?", differs: "≠" };
const BADGE_TITLE = {
  none: "Take a photo of the meter screen for this reading",
  pending: "Meter photo saved — the number is read when there's signal",
  photo: "Meter photo kept with this reading — tap to see it",
  check: "Number read from the meter photo — tap to check it",
  differs: "The meter photo shows a different number — tap to check",
};

/* What the cell shows: "pending" only where it means something to the tech
   — the reader fills numbers, and this install will ask for this one. */
function shownState(ph, value) {
  const s = cellState(ph, value);
  if (s !== "pending") return s;
  return lastFill() && ph.dev === deviceTag() && triesOf(ph.id) < GIVE_UP ? "pending" : "photo";
}

/** Is this row taking new photos? Today's, an undated one, or the newest.
    Older rows show only the photos they have: a meter photo belongs to the
    moment of its reading. */
export const rowOpenForPhotos = (map, row, i) => i === (map.readings || []).length - 1 || !row.date || row.date === todayISO();

/** Wire the meter photo into a Moisture Map value cell. `td` holds `input`.
    open: this row takes new photos (rowOpenForPhotos). onValue() is called
    when the cell's number changes from here (a prefill or "Use"),
    onState() when its photo state changes (the check line, the printed
    photos). */
export function meterCell(project, map, row, loc, td, input, { open = true, onValue, onState } = {}) {
  const badge = h("button", { type: "button", class: "mp-btn app-only" });
  const sup = h("sup", { class: "mp-p", style: "display:none" }, "P");
  td.classList.add("mp-td");
  td.append(badge, sup);
  let painted = false;
  /* the row this cell stands for in the map now: a sync's graft keeps a row
     object by its rk (graft.js), so this is `row` unless the row was replaced */
  const liveRow = () => ((map.readings || []).includes(row) ? row : (row.rk && (map.readings || []).find((r) => r && r.rk === row.rk)) || null);
  function paint() {
    if (painted && !td.isConnected) return false;
    painted = true;
    const r = liveRow() || row;
    const value = String(r.values[loc] ?? "");
    if (document.activeElement !== input && input.value !== value) { input.value = value; if (onValue) onValue(); }
    const ph = photoAt(project, map, r, loc);
    const state = ph ? shownState(ph, value) : "none";
    badge.className = `mp-btn app-only mp-${state}`;
    badge.textContent = BADGE[state];
    badge.title = BADGE_TITLE[state];
    badge.setAttribute("aria-label", `${BADGE_TITLE[state]} (location ${loc + 1})`);
    badge.hidden = state === "none" && !(open && meterServerReady());
    td.classList.toggle("mp-fill", state === "check");
    sup.hidden = !ph;
    sup.textContent = state === "check" ? "P?" : "P";
    return true;
  }
  // repaintJob passes a set to run the map's onState once for all its cells
  const repaint = (states) => {
    const on = paint();
    if (on && onState) { if (states) states.add(onState); else onState(); }
    return on;
  };
  onScreen(project.id, repaint);
  function typed() {
    const ph = photoAt(project, map, liveRow() || row, loc);
    if (!ph) return;
    noteTyped(ph, input.value);              // typing over a prefill confirms it: the typed value is the reading
    repaint();
  }
  function capture() {
    flushPending();                          // not awaited: a camera that reloads the page can't take a typed number with it
    const picking = meterDeps.pick();        // in the tap, or iOS won't open the camera
    return (async () => {
      const file = await picking;
      if (!file) return;
      let src = "";
      try { src = await meterDeps.encode(file); } catch { /* reported below */ }
      if (!isLocalImage(src)) { toast("Couldn't open that photo. Take it with the camera, or type the number."); return; }
      const r = liveRow();
      if (!r || !(project.moistureMaps || []).includes(map)) {
        toast("This reading changed on another device while the camera was open. Take the photo again.");
        return;
      }
      addMeterPhoto(project, map, r, loc, src, deviceTag());
      commit(); await flushPending();        // on this device before anything else
      markJob(project.id, true);
      repaintJob(project.id);
      const reading = meterDeps.ready() && !halted;
      toast(lastFill() && !reading
        ? "Meter photo saved. The number fills in when you're back online."
        : "Meter photo saved with this reading.", 2500);
      if (reading) await readPendingMeters(project);
    })();
  }
  badge.addEventListener("click", (e) => {
    e.preventDefault();
    const r = liveRow() || row;
    const ph = photoAt(project, map, r, loc);
    if (!ph) { if (meterServerReady()) capture(); return; }
    openMeterSheet(project, map, r, loc, { input, retake: capture, after: () => repaintJob(project.id), onValue });
  });
  paint();
  return { badge, paint: repaint, typed };
}

/* ---------- the photo sheet ---------- */
function photoImg(src, cls) {
  if (isLocalImage(src)) return h("img", { class: cls, src, alt: "Meter screen" });
  const box = h("div", { class: cls + " mp-cloud" }, "☁️ This photo loads the next time this device syncs online.");
  const m = MARKER_RE.exec(String(src || ""));
  if (m && navigator.onLine !== false) {
    downloadMedia(m[1]).then((text) => {
      if (text && isLocalImage(text) && box.isConnected) box.replaceWith(h("img", { class: cls, src: text, alt: "Meter screen" }));
    }).catch(() => { /* stays the placeholder */ });
  }
  return box;
}

function sheetStatus(ph, value) {
  const r = ph.read;
  const state = shownState(ph, value);
  if (!r) {
    if (state !== "pending") return "Kept with this reading as proof of the number.";
    return meterDeps.ready() ? "Reading the number…" : "Saved on this device. The number is read when you're back online.";
  }
  if (state === "check" && value === "") return [`The app read `, h("b", {}, ph.filled), ` from this photo, but the cell is empty now (another device's copy of this map was saved over it).`];
  if (state === "check") return [`The app read `, h("b", {}, r.value), ` from this photo. Check it against the meter screen.`];
  if (state === "differs") return [`The photo reads `, h("b", {}, r.value), `; the cell says `, h("b", {}, String(value)), `. Check which is right.`];
  if (r.fill && r.device === "thermo_hygrometer") return "This looks like a thermo-hygrometer, not a moisture meter. The photo is kept with the reading.";
  if (r.fill && !r.readable) return `The app couldn't read the screen${r.note ? ` (${r.note})` : ""}. The photo is kept with the reading.`;
  return "Kept with this reading as proof of the number.";
}

export function openMeterSheet(project, map, row, loc, { input, retake, after, onValue, view = false } = {}) {
  const ph = photoAt(project, map, row, loc);
  if (!ph) return;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  let isOpen = true;
  // closes on Escape, and on any route change (the Android back button), like
  // scanner.js: the sheet must never sit over another page
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", close);
    document.body.style.overflow = prevOverflow;
    ov.remove();
    if (after) after();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  // the page no longer shows this copy of the job (a sync swapped it):
  // a change made to it here would be saved over the newer one
  const stale = () => { const live = liveOf(project.id); return !!live && live !== project; };
  const btn = (label, cls, fn, changes = true) => h("button", {
    type: "button", class: `btn ${cls} btn--sm`,
    onclick: () => { if (changes && stale()) { close(); return; } fn(); },
  }, label);
  const value = String(row.values[loc] ?? "");
  const state = cellState(ph, value);
  const useIt = (label) => btn(label, "btn--primary", () => {
    useMeterRead(project, ph);
    if (input) input.value = String(row.values[loc] ?? "");
    commit(); close(); if (onValue) onValue();
  });
  const typeIt = () => btn("Type it instead", "btn--ghost", () => { close(); if (input) { input.focus(); input.select(); } }, false);
  const acts = [];
  if (view) acts.push(btn("Close", "btn--ghost", () => close(), false));
  else if (state === "check" && value === "") acts.push(useIt(`Use ${ph.filled}`), typeIt());
  else if (state === "check") {
    acts.push(btn(`✓ ${ph.filled} is right`, "btn--primary", () => { confirmMeterPhoto(ph); commit(); close(); }), typeIt());
  } else if (state === "differs") {
    acts.push(useIt(`Use ${ph.read.value}`));
    acts.push(btn(`Keep ${value}`, "btn--ghost", () => { confirmMeterPhoto(ph); commit(); close(); }));
  }
  // the camera is asked for first, inside the tap; the repaint on close can wait
  if (retake && !view) acts.push(btn("📷 Retake", "btn--ghost", () => { retake(); close(); }));
  if (!view) acts.push(btn("Delete photo", "btn--danger", () => {
    const drops = dropsPrefill(project, ph);
    if (!confirm(drops
      ? "Delete this meter photo? The number the app read from it comes out of the cell too."
      : "Delete this meter photo? The number in the cell stays.")) return;
    removeMeterPhotos(project, [ph.id]);
    if (drops && input) { input.value = String(row.values[loc] ?? ""); if (onValue) onValue(); }
    commit(); close();
  }));
  const ov = h("div", { class: "mpsheet app-only", role: "dialog", "aria-label": `Meter photo, location ${loc + 1}` },
    h("div", { class: "mpsheet__panel" },
      h("div", { class: "mpsheet__top" },
        h("div", { class: "mpsheet__title" }, `${map.label ? map.label + " · " : ""}Location ${loc + 1} · ${dateLabel(row.date)}`),
        h("button", { type: "button", class: "mpsheet__close", title: "Close", onclick: close }, "✕")),
      photoImg(ph.src, "mpsheet__img"),
      h("p", { class: "mpsheet__status" }, sheetStatus(ph, value)),
      h("div", { class: "mpsheet__acts" }, ...acts),
      h("p", { class: "mpsheet__meta" }, [stamp(ph.ts), login(ph.by)].filter(Boolean).join(" · "))));
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  window.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", close);
  document.body.append(ov);
  if (!view && !halted && needsRead(ph, deviceTag()) && meterDeps.ready()) readPendingMeters(project);
}

/* ---------- the line over the grid while a prefill waits for a person ---------- */
export function meterCheckBanner(project, map) {
  const el = h("p", { class: "mp-banner app-only", hidden: true });
  function paint() {
    let n = 0;
    for (const e of mapPhotoEntries(project, map)) if (e.unchecked) n++;
    el.hidden = !n;
    el.textContent = n === 1
      ? "1 number was read from a meter photo. Tap the ? under it and check it against the photo."
      : `${n} numbers were read from meter photos. Tap the ? under each one and check it against the photo.`;
  }
  paint();
  return { el, paint };
}

/* ---------- is the 📷 switched on here? (the line under the grid) ---------- */
export function meterGateNote(onReady) {
  const el = h("p", { class: "subtle app-only mp-gate", hidden: true });
  const show = (msg) => { el.textContent = msg; el.hidden = !msg; };
  if (meterServerReady()) return el;
  if (!isSignedIn()) { show("Connect once to switch meter photos on."); return el; }
  show("Checking whether meter photos are switched on…");
  checkMeterServer().then((r) => {
    if (r && r.ready) { show(""); if (onReady) onReady(); }
    else if (r && r.ready === false) show("Meter photos switch on after this feature's database update is applied.");
    else show("Connect once to switch meter photos on.");
  });
  return el;
}

/* ---------- print: the "Meter photos" appendix of one Moisture Map ---------- */
const figure = (src, caption) => h("figure", { class: "mp-print__fig" },
  isLocalImage(src) ? h("img", { src, alt: "" }) : h("div", { class: "mp-print__none" }, "photo not on this device"),
  h("figcaption", {}, caption));

export function meterAppendix(project, map) {
  const el = h("div", { class: "print-only mp-print" });
  function paint() {
    const entries = mapPhotoEntries(project, map);
    el.replaceChildren();
    if (!entries.length) return;
    const unchecked = entries.some((e) => e.unchecked);
    el.append(
      h("div", { class: "mp-print__legend" },
        h("div", {}, h("sup", {}, "P"), " = this reading has a photo of the meter screen, below. Times are the phone's clock when the photo was taken."),
        unchecked ? h("div", {}, h("sup", {}, "P?"), " = the app read this number from the photo and the tech has not checked it yet.") : null),
      h("div", { class: "mp-print__title" }, "Meter photos"),
      h("div", { class: "mp-print__grid" }, ...entries.map((e) => figure(e.ph.src, [
        `Loc ${e.loc + 1}`, dateLabel(e.date), e.value || "", stamp(e.ph.ts),
        e.orphan ? "reading date removed" : "", e.unchecked ? "not checked" : "",
      ].filter(Boolean).join(" · ")))));
  }
  paint();
  return { el, paint };
}

/* ---------- Certificate of Drying: each location's final reading with its photo ---------- */
export function meterCertSection(project) {
  const fin = finalReadingPhotos(project);
  if (!fin.length) return null;
  const unchecked = fin.some((f) => f.unchecked);
  return h("div", { class: "mp-cert" },
    h("h2", {}, "Final Readings with Meter Photos"),
    h("p", { class: "subtle" }, "Each location's last reading on the Moisture Map, with the photo of the meter screen taken for it."),
    unchecked ? h("p", { class: "mp-banner app-only" }, "A final number marked \"not checked\" was read from its photo by the app and hasn't been checked by the tech. Check it on the Moisture Map before this certificate goes out for signature.") : null,
    h("div", { class: "mp-print__grid mp-cert__grid" }, ...fin.map((f) => {
      const fig = figure(f.ph.src, [f.map.label || "Moisture Map", `Loc ${f.loc + 1}`, dateLabel(f.date), f.value, f.unchecked ? "not checked" : ""].filter(Boolean).join(" · "));
      fig.addEventListener("click", () => openMeterSheet(project, f.map, f.row, f.loc, { view: true }));
      return fig;
    })));
}
