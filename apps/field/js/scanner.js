/* ============================================================
   Roybal Field Forms — 📷 Scan equipment (the Drying Log's scanner)
   ------------------------------------------------------------
   A full-screen camera overlay that stays open for a whole drop-off:
   pick the room once, point at each unit's QR label, and every label
   read logs a placement (or a pull, in Remove mode) through scans.js.
   The crew never taps per unit in the common case.

   - NEVER touches location.hash. In an iOS home-screen app a hash change
     stops the camera and resets its permission (WebKit 215884), so this is
     an overlay over the Drying Log page, not a route. A hash change from
     elsewhere (a back swipe) closes it instead of leaving it stranded.
   - The decoder is the vendored zxing-wasm reader (assets/vendor/zxing/),
     loaded on first open and never from a CDN. It is prepared ONCE per page
     load with one constant overrides object: a second prepare with a new
     object reaches share.js's Object.hasOwn, which iOS Safari < 15.4 lacks.
   - When the live camera won't start (permission, the black-video PWA bug,
     no camera) the fallback is a photo of the label, then typing the tag.
   - Scans are append-only events (project.equipmentScans); the caller's
     onChange(project) commits them. Undo is a new void event, never an edit.
   ============================================================ */
import { h, toast, uid, fileToDataURL, fmtDate, stripCtrl } from "./core.js";
import { newDryingLog, newPhoto, author } from "./model.js";
import { BUILD } from "./config.js";
import { hasTech, pickTech, techName } from "./tech.js";
import { parseTag, tagKey, wallTime, TYPE_LABELS, recordScan, voidEvent, openElsewhere, roomSuggestions } from "./scans.js";
import { loadFleet, refreshFleet, unitFor } from "./fleet.js";

const MODE_KEY = "roybal-scan-mode";                  // localStorage: Place | Remove survives app restarts
const roomKey = (jobId) => "roybal-scan-room:" + jobId; // sessionStorage: the room sticks per job
const READ_OPTS = { formats: ["QRCode"], tryHarder: true, maxNumberOfSymbols: 1 };
const CROP = 720;              // centre-square crop fed to the decoder (px)
const SAME_TAG_MS = 3000;      // the same label in view again within this window is ignored
const CAMERA = { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
const TYPE_PICKS = ["air_mover", "dehumidifier", "air_scrubber", "heater"];
const STILL_TYPES = /^image\/(jpeg|png|gif|bmp)$/i; // what the decoder's own image reader understands

/* the vendored wasm sits next to the reader; resolved from THIS file so it works
   at the site root (production) and under serve.mjs alike */
const ZX_OVERRIDES = {
  locateFile: (p, prefix) => p.endsWith(".wasm")
    ? new URL("../assets/vendor/zxing/zxing_reader.wasm", import.meta.url).href
    : prefix + p,
};

/* ---------- injectable edges (tests swap these) ---------- */
export const deps = {
  loadDecoder: () => import("../assets/vendor/zxing/reader/index.js"),
  refreshFleet: () => refreshFleet(),
  startMs: 2500,               // no "playing" by then → the photo / type fallback
  tickMs: 200,                 // ~5 reads a second
  now: () => Date.now(),
};

let decoderP = null;
function loadDecoder() {
  if (!decoderP) {
    decoderP = (async () => {
      const z = await deps.loadDecoder();
      try { await z.prepareZXingModule({ overrides: ZX_OVERRIDES, fireImmediately: true }); }
      catch (e) { try { z.purgeZXingModule && z.purgeZXingModule(); } catch {} throw e; }
      return z;
    })();
    decoderP.catch(() => { decoderP = null; });   // let the next open try again
  }
  return decoderP;
}

const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const ssGet = (k) => { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };

/* "since" may be a scan's UTC instant or a typed row's Alaska wall time */
function sinceText(since) {
  const s = String(since || "");
  if (!s) return "";
  const wall = /(Z|[+-]\d\d:?\d\d)$/.test(s) ? wallTime(s) : s;
  return wall ? fmtDate(wall.slice(0, 10)) : "";
}

/* bytes of a data: URL, for handing a re-encoded still to the decoder */
function dataUrlBytes(src) {
  const b64 = String(src || "").split(",")[1] || "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let openNow = null;            // a double-tap on the button must not start two cameras

/**
 * Open the scanner over the current page. Resolves when the crew taps Done.
 * opts.onChange(project) — called after every logged scan / undo / photo (the caller commits).
 * opts.otherProjects — the device's other jobs (array, or a function/promise of one), for
 *   "this unit is still open on another job".
 * opts.logId — the drying log the page is showing; new rows land there (else the first log).
 */
export async function openScanner(project, opts = {}) {
  if (!openNow) openNow = runScanner(project, opts).finally(() => { openNow = null; });
  return openNow;
}

async function runScanner(project, opts) {
  const { onChange } = opts || {};
  if (!hasTech()) { try { await pickTech(); } catch {} }

  let units = [];
  try { units = loadFleet() || []; } catch { units = []; }
  Promise.resolve().then(() => deps.refreshFleet())
    .then((r) => { if (r && r.ok && Array.isArray(r.units)) units = r.units; }).catch(() => {});
  let others = [];
  Promise.resolve().then(() => (typeof opts.otherProjects === "function" ? opts.otherProjects() : opts.otherProjects))
    .then((v) => { if (Array.isArray(v)) others = v; }).catch(() => {});

  return new Promise((resolve) => {
    let closed = false;
    let mode = lsGet(MODE_KEY) === "remove" ? "remove" : "place";
    let room = ssGet(roomKey(project.id));
    let decoder = null, decoderFailed = false;
    let stream = null, track = null, live = false, starting = false, camTry = 0, resumeCamera = false;
    let torchOn = false, tickTimer = 0, reading = false, flashTimer = 0;
    let canvas = null, ctx = null;
    let sheetEl = null;
    let lastKey = "", lastAt = 0;
    let audio = null;
    const counts = { placed: 0, moved: 0, removed: 0 };
    const roomTags = {};       // room → tags placed / moved in / removed this session (photo caption)

    /* ---------- chrome ---------- */
    const doneBtn = h("button", { type: "button", class: "sc-btn sc-done", onclick: () => close() }, "Done");
    const placeBtn = h("button", { type: "button", onclick: () => setMode("place") }, "Place");
    const removeBtn = h("button", { type: "button", onclick: () => setMode("remove") }, "Remove");
    const modeBox = h("div", { class: "sc-mode", role: "group", "aria-label": "Scan mode" }, placeBtn, removeBtn);
    const roomBtn = h("button", { type: "button", class: "sc-btn sc-room", onclick: () => openRoomSheet(null) });
    const torchBtn = h("button", { type: "button", class: "sc-btn sc-torch", hidden: true, "aria-label": "Flashlight", onclick: () => toggleTorch() }, "🔦");

    const video = h("video", { class: "sc-video", playsinline: true, muted: true, autoplay: true });
    video.muted = true;        // the attribute alone doesn't satisfy every autoplay policy
    const statusEl = h("div", { class: "sc-status", "aria-live": "polite" }, "Loading scanner…");
    const flash = h("div", { class: "sc-flash" });
    const fbMsg = h("div", { class: "sc-fallback__msg" }, "Camera didn't start.");
    const fbPhoto = h("button", { type: "button", class: "sc-btn sc-btn--big", onclick: () => labelInput.click() }, "📷 Photo of the label");
    const fbType = h("button", { type: "button", class: "sc-btn sc-btn--big", onclick: () => openTypeTagSheet() }, "⌨ Type the tag");
    const fbRetry = h("button", { type: "button", class: "sc-btn sc-btn--ghost", onclick: () => startCamera() }, "Try the camera again");
    const fallback = h("div", { class: "sc-fallback", hidden: true }, fbMsg, fbPhoto, fbType, fbRetry);
    const stage = h("div", { class: "sc-stage" }, video, h("div", { class: "sc-aim" }), statusEl, flash, fallback);

    const card = h("div", { class: "sc-card", hidden: true });
    const countEl = h("div", { class: "sc-count" });
    const typeBtn = h("button", { type: "button", class: "sc-btn", onclick: () => openTypeTagSheet() }, "⌨ Type tag");
    const photoBtn = h("button", { type: "button", class: "sc-btn", onclick: () => roomPhoto() }, "📸 Room photo");

    // the phone's own camera: no getUserMedia permission, no live-stream bugs
    const labelInput = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true,
      onchange: () => { const f = labelInput.files && labelInput.files[0]; labelInput.value = ""; readLabelPhoto(f); } });
    const roomPhotoInput = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true,
      onchange: () => { const f = roomPhotoInput.files && roomPhotoInput.files[0]; roomPhotoInput.value = ""; roomPhotoFile(f); } });

    const overlay = h("div", { class: "sc", role: "dialog", "aria-modal": "true", "aria-label": "Scan equipment" },
      h("div", { class: "sc-top" }, doneBtn, modeBox, roomBtn, torchBtn),
      stage,
      card,
      h("div", { class: "sc-bottom" }, typeBtn, photoBtn, countEl),
      labelInput, roomPhotoInput);

    // iOS only lets audio start inside a tap, so the beep is armed by the first one
    const unlockAudio = () => {
      if (audio) { try { const p = audio.state === "suspended" && audio.resume(); p && p.catch && p.catch(() => {}); } catch {} return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { audio = new AC(); } catch { audio = null; }
    };
    overlay.addEventListener("click", unlockAudio, true);
    overlay.addEventListener("touchend", unlockAudio, true);
    unlockAudio();             // the Scan tap may still count; if not, it waits suspended for the next tap

    paintMode(); paintRoom(); paintCount();
    document.body.appendChild(overlay);

    const onHash = () => close();
    // a camera still starting (permission, first frame) comes back too
    const onPageHide = () => { if (live || starting) resumeCamera = true; stopCamera(); };
    const onVisible = () => {
      if (closed) return;
      if (document.visibilityState === "hidden") { if (live || starting) resumeCamera = true; stopCamera(); }
      else if (resumeCamera) { resumeCamera = false; startCamera(); }
    };
    const onPageShow = () => { if (!closed && resumeCamera) { resumeCamera = false; startCamera(); } };
    const onKey = (e) => { if (e.key === "Escape") { if (sheetEl) closeSheet(); else close(); } };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("keydown", onKey);

    loadDecoder().then((z) => {
      if (closed) return;
      decoder = z;
      if (live) readyStatus();
    }).catch(() => {
      if (closed) return;
      decoderFailed = true;
      stopCamera();
      showFallback("The scanner couldn't load on this device.", false);
    });
    startCamera();
    if (mode === "place" && !room) openRoomSheet(null);

    /* ---------- mode / room / counter ---------- */
    function setMode(m) {
      mode = m === "remove" ? "remove" : "place";
      lsSet(MODE_KEY, mode);
      // a label still in view stays quiet: switching to Remove must not pull
      // the unit just placed. A deliberate re-scan: out of view and back.
      lastAt = deps.now();
      paintMode(); readyStatus();
    }
    function paintMode() {
      placeBtn.setAttribute("aria-pressed", String(mode === "place"));
      removeBtn.setAttribute("aria-pressed", String(mode === "remove"));
      overlay.classList.toggle("sc--remove", mode === "remove");
    }
    function setRoom(name) {
      room = name;
      ssSet(roomKey(project.id), room);
      lastAt = deps.now();     // as setMode: the unit in view isn't moved by picking a room
      paintRoom();
    }
    function paintRoom() { roomBtn.textContent = "Room: " + (room || "pick") + " ▾"; }
    function paintCount() { countEl.textContent = `Placed ${counts.placed} · Moved ${counts.moved} · Removed ${counts.removed}`; }
    function status(text) { statusEl.textContent = text; }
    function readyStatus() {
      if (!live) return;
      if (!decoder) return status("Loading scanner…");
      status(mode === "remove" ? "Remove mode — scan each unit you're pulling" : "Point at a label · hold it 6–10 in. away");
    }

    /* ---------- camera ---------- */
    async function startCamera() {
      if (closed || decoderFailed) return;
      const myTry = ++camTry;
      starting = true;
      try { await startCameraTry(myTry); }
      finally { if (myTry === camTry) starting = false; }
    }
    async function startCameraTry(myTry) {
      fallback.hidden = true;
      status(decoder ? "Starting camera…" : "Loading scanner…");
      const md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== "function") return showFallback("Camera didn't start.", true, false);
      let s;
      try { s = await md.getUserMedia(CAMERA); }
      catch { if (!closed && myTry === camTry) showFallback("Camera didn't start.", true); return; }
      if (closed || myTry !== camTry) { stopStream(s); return; }
      stream = s;
      track = (s.getVideoTracks && s.getVideoTracks()[0]) || null;
      video.srcObject = s;
      const playing = await new Promise((res) => {
        let t = 0;
        const done = (v) => { clearTimeout(t); video.removeEventListener("playing", onPlay); res(v); };
        const onPlay = () => done(true);
        video.addEventListener("playing", onPlay);
        t = setTimeout(() => done(false), deps.startMs);
        try { const p = video.play(); if (p && p.catch) p.catch(() => {}); } catch {}
      });
      if (closed || myTry !== camTry) return;
      if (!playing) { stopCamera(); return showFallback("Camera didn't start.", true); }
      live = true;
      const mine = track;
      if (mine && mine.addEventListener) mine.addEventListener("ended", () => {
        if (closed || track !== mine || document.visibilityState === "hidden") return;
        stopCamera(); showFallback("The camera stopped.", true);
      });
      let caps = null;
      try { caps = track && track.getCapabilities ? track.getCapabilities() : null; } catch { caps = null; }
      torchOn = false;
      torchBtn.hidden = !(caps && caps.torch);
      torchBtn.setAttribute("aria-pressed", "false");
      readyStatus();
      scheduleTick();
    }
    function stopStream(s) {
      try { s.getTracks().forEach((t) => t.stop()); } catch {}
    }
    function stopCamera() {
      camTry++;                // any start still waiting on a permission prompt is now stale
      starting = false;
      live = false;
      clearTimeout(tickTimer);
      if (stream) stopStream(stream);
      stream = null; track = null;
      try { video.pause(); } catch {}
      video.srcObject = null;
      torchBtn.hidden = true; torchOn = false;
    }
    function showFallback(msg, canPhoto, canRetry = canPhoto) {
      fbMsg.textContent = msg;
      fbPhoto.hidden = !canPhoto || decoderFailed;
      fbRetry.hidden = !canRetry || decoderFailed;
      fallback.hidden = false;
      status("");
    }
    async function toggleTorch() {
      if (!track) return;
      const want = !torchOn;   // own state: getSettings().torch reads stale on iOS 18
      try { await track.applyConstraints({ advanced: [{ torch: want }] }); torchOn = want; } catch {}
      torchBtn.setAttribute("aria-pressed", String(torchOn));
      torchBtn.classList.toggle("sc-torch--on", torchOn);
    }

    /* ---------- the read loop ---------- */
    function scheduleTick() {
      clearTimeout(tickTimer);
      if (!closed && live) tickTimer = setTimeout(tick, deps.tickMs);
    }
    async function tick() {
      if (closed || !live) return;
      if (decoder && !sheetEl && !reading) {
        const img = grabCrop();
        if (img) {
          reading = true;
          let text = "";
          try { const res = await decoder.readBarcodes(img, READ_OPTS); text = (res && res[0] && res[0].text) || ""; }
          catch { text = ""; }
          reading = false;
          if (text && !closed && live && !sheetEl) onCameraText(text);
        }
      }
      scheduleTick();
    }
    function grabCrop() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      if (!ctx) {
        canvas = document.createElement("canvas");
        try { ctx = canvas.getContext("2d", { willReadFrequently: true }); } catch { ctx = null; }
        if (!ctx) return null;
      }
      const side = Math.min(vw, vh), out = Math.min(side, CROP);
      if (canvas.width !== out) { canvas.width = out; canvas.height = out; }
      try {
        ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out);
        return ctx.getImageData(0, 0, out, out);
      } catch { return null; }
    }
    // a tag just handled (any way) is ignored by the camera while it stays in view
    function quiet(tag) { lastKey = tagKey(tag); lastAt = deps.now(); }
    function onCameraText(text) {
      const tag = parseTag(text);
      const key = tag ? tagKey(tag) : "raw:" + text;
      const now = deps.now();
      const seen = key === lastKey && now - lastAt < SAME_TAG_MS;
      lastKey = key; lastAt = now;       // stays quiet while the label stays in view
      if (seen) return;
      if (!tag) return feedback("warn", "That QR code isn't an equipment label.", "");
      handleTag(tag, "camera", null);
    }

    /* ---------- one tag → one decision (scans.js) ---------- */
    function targetLogId() {
      const logs = project.dryingLogs || [];
      const want = opts.logId ? logs.find((l) => l && l.id === opts.logId) : null;
      return ((want || logs[0]) || {}).id || "";
    }
    function handleTag(tag, how, typeCode) {
      if (closed) return;
      if (mode === "place" && !room) return openRoomSheet(() => handleTag(tag, how, typeCode));
      // a job with no drying log gets one, EMPTY, so the scanned row has a home
      let made = null;
      if (mode === "place" && !(project.dryingLogs || []).length) {
        made = newDryingLog();
        made.equipment = [];
        (project.dryingLogs = project.dryingLogs || []).push(made);
      }
      const away = mode === "place" ? openElsewhere(others, tag, project.id) : null;
      const r = recordScan(project, {
        tag, mode, room, how,
        at: new Date().toISOString(), id: uid(),
        by: author(), tech: techName(), build: BUILD,
        unit: unitFor(units, tag) || null,
        typeCode: typeCode || null,
        elsewhere: away ? { jobId: away.jobId, label: away.label, since: away.since } : null,
        logId: targetLogId(),
      });
      if (made && r.outcome !== "placed" && r.outcome !== "moved") {
        const i = project.dryingLogs.indexOf(made);
        if (i >= 0) project.dryingLogs.splice(i, 1);
      }
      if (r.outcome !== "need_room" && r.outcome !== "need_type") quiet(tag);
      switch (r.outcome) {
        case "need_room": return openRoomSheet(() => handleTag(tag, how, typeCode));
        case "need_type": return openTypeSheet(tag, (code) => handleTag(tag, how, code));
        case "placed": case "moved": case "removed": {
          counts[r.outcome]++;
          const where = (r.event && r.event.room) || (r.outcome === "removed" ? "" : room);
          if (where) (roomTags[where] = roomTags[where] || []).push(r.event ? r.event.tag : tag);
          paintCount();
          // amber, not a block: the office sorts out a unit listed on two jobs
          const since = away && away.since ? sinceText(away.since) : "";
          const named = away && away.label && String(r.message || "").includes(away.label);
          const awayNote = !away || r.outcome !== "placed" ? ""
            : (named ? "Listed there" : `Still listed on ${away.label || "another job"}`) +
              (since ? " since " + since : "") + " — the office will see both.";
          feedback(awayNote ? "warn" : "ok", r.message || tag, awayNote, r, where);
          changed();
          return;
        }
        default: return feedback("warn", r.message || tag, "");
      }
    }
    function undo(r, where) {
      if (!r || !r.event) return;
      const v = voidEvent(project, r.event.id, { id: uid(), at: new Date().toISOString(), by: author(), tech: techName(), build: BUILD });
      if (!v) return;
      counts[r.outcome] = Math.max(0, counts[r.outcome] - 1);
      const list = where && roomTags[where];
      const i = list ? list.lastIndexOf(r.event.tag) : -1;
      if (i >= 0) list.splice(i, 1);
      paintCount();
      quiet(r.event.tag);      // the label is likely still in view: don't log it straight back
      showCard("undone", "Undone: " + (r.message || r.event.tag), "", null);
      changed();
    }
    function changed() {
      try { const p = onChange && onChange(project); if (p && p.catch) p.catch(() => {}); } catch {}
    }

    /* ---------- feedback ---------- */
    function feedback(tone, msg, sub, r, where) {
      clearTimeout(flashTimer);
      flash.className = "sc-flash sc-flash--" + (tone === "ok" ? "ok" : "warn");
      flashTimer = setTimeout(() => { flash.className = "sc-flash"; }, 260);
      beep(tone === "ok" ? 1320 : 440);
      try { navigator.vibrate && navigator.vibrate(60); } catch {}
      showCard(tone, msg, sub, r ? () => undo(r, where) : null);
    }
    function beep(freq) {
      if (!audio) return;
      try {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = freq; g.gain.value = 0.18;
        o.connect(g); g.connect(audio.destination);
        const t = audio.currentTime;
        o.start(t); o.stop(t + 0.08);
      } catch {}
    }
    function showCard(tone, msg, sub, onUndo) {
      card.className = "sc-card sc-card--" + tone;
      card.replaceChildren(h("div", { class: "sc-card__text" },
        h("div", { class: "sc-card__msg" }, msg), sub ? h("div", { class: "sc-card__sub" }, sub) : null));
      if (onUndo) card.append(h("button", { type: "button", class: "sc-btn sc-btn--undo", onclick: onUndo }, "Undo"));
      card.hidden = false;
    }

    /* ---------- sheets (room, type, typed tag) ---------- */
    function openSheet(...children) {
      closeSheet();
      sheetEl = h("div", { class: "sc-sheet", role: "dialog" }, ...children);
      overlay.appendChild(sheetEl);
      return sheetEl;
    }
    // reads pause under a sheet: a label still in view after Cancel must not reopen it
    function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; lastAt = deps.now(); } }

    function openRoomSheet(then) {
      const err = h("div", { class: "sc-err", hidden: true });
      const input = h("input", { class: "sc-input", type: "text", placeholder: "Type a room", autocomplete: "off", enterkeyhint: "done" });
      const use = (name) => {
        const n = stripCtrl(name).trim();
        if (!n) { err.textContent = "Type a room or tap one above."; err.hidden = false; return; }
        setRoom(n); closeSheet(); readyStatus();
        if (then) then();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") use(input.value); });
      const sugg = roomSuggestions(project) || [];
      openSheet(
        h("div", { class: "sc-sheet__title" }, "Which room?"),
        sugg.length ? h("div", { class: "sc-chips" }, sugg.map((n) =>
          h("button", { type: "button", class: "sc-chip" + (n === room ? " sc-chip--on" : ""), onclick: () => use(n) }, n))) : null,
        h("div", { class: "sc-sheet__row" }, input,
          h("button", { type: "button", class: "sc-btn sc-btn--go", onclick: () => use(input.value) }, "Use")),
        err,
        h("button", { type: "button", class: "sc-btn sc-btn--ghost sc-sheet__cancel", onclick: () => closeSheet() }, "Cancel"));
    }

    function openTypeSheet(tag, then) {
      openSheet(
        h("div", { class: "sc-sheet__title" }, "What is " + tag + "?"),
        h("div", { class: "sc-sheet__sub" }, "Once the office adds it to the fleet list, this isn't asked again."),
        h("div", { class: "sc-chips sc-chips--types" }, TYPE_PICKS.map((code) =>
          h("button", { type: "button", class: "sc-chip sc-chip--big", onclick: () => { closeSheet(); then(code); } }, TYPE_LABELS[code] || code))),
        h("button", { type: "button", class: "sc-btn sc-btn--ghost sc-sheet__cancel", onclick: () => closeSheet() }, "Cancel"));
    }

    function openTypeTagSheet() {
      const err = h("div", { class: "sc-err", hidden: true });
      const input = h("input", { class: "sc-input", type: "text", placeholder: "AM-014", autocomplete: "off",
        autocapitalize: "characters", spellcheck: "false", enterkeyhint: "done" });
      const use = () => {
        const tag = parseTag(input.value);
        if (!tag) { err.textContent = "That isn't a tag (example AM-014)"; err.hidden = false; return; }
        closeSheet();
        handleTag(tag, "typed", null);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") use(); });
      openSheet(
        h("div", { class: "sc-sheet__title" }, "Type the tag"),
        h("div", { class: "sc-sheet__row" }, input, h("button", { type: "button", class: "sc-btn sc-btn--go", onclick: use }, "Use")),
        err,
        h("button", { type: "button", class: "sc-btn sc-btn--ghost sc-sheet__cancel", onclick: () => closeSheet() }, "Cancel"));
      try { input.focus(); } catch {}
    }

    /* ---------- 📷 photo of the label (camera fallback) ---------- */
    async function readLabelPhoto(file) {
      if (!file || closed) return;
      status("Reading the photo…");
      let z;
      try { z = await loadDecoder(); }
      catch { status(""); return feedback("warn", "The scanner couldn't load on this device.", "Type the tag instead."); }
      let text = "";
      try { const res = await z.readBarcodes(file, READ_OPTS); text = (res && res[0] && res[0].text) || ""; } catch { text = ""; }
      if (!text && !STILL_TYPES.test(file.type || "")) {
        // e.g. HEIC: let the browser decode and re-encode it, then try once more
        try {
          const src = await fileToDataURL(file, 1600, 0.9);
          if (/^data:image\/(jpeg|png)/.test(src)) {
            const res = await z.readBarcodes(dataUrlBytes(src), READ_OPTS);
            text = (res && res[0] && res[0].text) || "";
          }
        } catch { text = ""; }
      }
      if (closed) return;
      status("");
      readyStatus();
      if (!text) return feedback("warn", "No label found in that photo.", "Get closer and try again, or type the tag.");
      const tag = parseTag(text);
      if (!tag) return feedback("warn", "That QR code isn't an equipment label.", "");
      handleTag(tag, "photo", null);
    }

    /* ---------- 📸 room photo ---------- */
    function roomPhoto() {
      if (!room) return openRoomSheet(() => roomPhoto());
      if (live) {
        const src = grabFrame();
        if (src) return savePhoto(src);
      }
      roomPhotoInput.click();  // no live camera: the phone's own camera
    }
    function grabFrame() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return "";
      const s = Math.min(1, 1200 / Math.max(vw, vh));
      const c = document.createElement("canvas");
      c.width = Math.round(vw * s); c.height = Math.round(vh * s);
      try {
        const x = c.getContext("2d");
        if (!x) return "";
        x.drawImage(video, 0, 0, c.width, c.height);
        const src = c.toDataURL("image/jpeg", 0.6);
        return /^data:image\//.test(src || "") ? src : "";
      } catch { return ""; }
    }
    async function roomPhotoFile(file) {
      if (!file || closed) return;
      let src = "";
      try { src = await fileToDataURL(file, 1200, 0.6); } catch { src = ""; }
      if (closed) return;
      if (!/^data:image\//.test(src || "")) return feedback("warn", "That photo couldn't be read.", "");
      savePhoto(src);
    }
    function savePhoto(src) {
      const p = newPhoto();
      const tags = [...new Set(roomTags[room] || [])];
      p.src = src; p.room = room; p.stage = "during";
      p.caption = "Equipment - " + room + (tags.length ? " - " + tags.join(", ") : "");
      (project.photos = project.photos || []).push(p);
      changed();
      feedback("ok", "📸 Photo saved — " + room, "", null);
    }

    /* ---------- done ---------- */
    function close() {
      if (closed) return;
      closed = true;
      stopCamera();
      clearTimeout(flashTimer);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      try { const p = audio && audio.close && audio.close(); p && p.catch && p.catch(() => {}); } catch {}
      const n = counts.placed + counts.moved + counts.removed;
      if (n) toast(`Scanned: Placed ${counts.placed} · Moved ${counts.moved} · Removed ${counts.removed}`);
      resolve();
    }
  });
}
