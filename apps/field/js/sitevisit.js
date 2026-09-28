/* ============================================================
   Roybal Field Forms — Site Visit estimator
   ------------------------------------------------------------
   Branden's estimate process: walk the site, Magicplan LiDAR scan with
   photos pinned per room, record the walk on his phone, jot notes by hand,
   type the scope — then hand ALL of it to Claude. This panel is that
   process inside the estimate editor:

     1. drop in narrated walk clips (🎥 Record opens the phone's Camera; one
        clip per room, stills pulled in the browser AND a transcript), the
        Magicplan report PDF, extra photos, silent Magicplan room videos
        (stills only), photographed note pages and, still, one walk audio
        recording (all uploaded to the private field-media bucket under
        sitevisit/<job>/ — never into the job record, so a 40 MB report or
        an hour of audio can't stall sync);
     2. each recording is transcribed server-side (Deepgram); every walk
        still is captioned with the words spoken at that second, the clip's
        room is read from its first five seconds, and sv.transcript is
        rebuilt from every clip in order (js/walk.js, the pure half —
        docs/Narrated_Walkthrough_Design.md);
     3. one tap drafts the estimate: the most capable Claude model reads
        the files themselves plus the typed scope, the company estimating
        rules and the Fairbanks price catalog (roybal-ai-office
        siteVisitStart). It runs in the background — a few minutes;
     4. the finished draft lands in this editor: room-by-room lines with
        sheet prices stamped, assumptions / exclusions / pricing basis in
        the printed notes, open questions on screen, and a plain-language
        per-room summary kept on the estimate (inv.customerScope) for the
        customer portal.

   The pure helpers at the top are Node-tested (test/sitevisit.test.mjs).
   ============================================================ */
import { h, toast, fileToDataURL, uid, likelyOffline } from "./core.js";
import { uploadSiteFile, isSignedIn } from "./supa.js";
import { enqueueMedia, queueRows, queueSummary, onMedia, retryMedia, removeMedia, drainMediaQueue, fmtMB } from "./mediaqueue.js";
import { aiAvailable, transcribeSiteAudio, startSiteVisitDraft, checkSiteVisitDraft } from "./officeai.js";
import { subRatesText } from "./pricing.js";
import { dictateBtn } from "./dictate.js";
import { magicplanBanner, officeRole } from "./magicplan.js";
import { magicplanQuantities, withMagicplanBasis } from "./magicplancalc.js";
import {
  FRAMES_PER_VIDEO, frameTimes, mmss, frameCaption, stillTimes, clipTooBig, WALK_MAX_BYTES, OVERSIZE_MSG, LONG_CLIP_SECONDS, LONG_CLIP_NOTE,
  roomFromOpening, magicplanRoomNames, captionStills, rebuildTranscript, adoptLegacyTranscript, clipNumber, clipLabel, walkSummary,
} from "./walk.js";
export { FRAMES_PER_VIDEO, frameTimes, frameCaption };   // moved to walk.js; callers and tests unchanged

const arr = (v) => (Array.isArray(v) ? v : []);
export const MAX_IMAGES = 150;   // the server's limit (sitevisit.ts MAX_IMAGES): photos, stills and note pages together

/* ---------- pure: packet shape ---------- */
export const KINDS = {
  walk:   { label: "🎥 Walk clips", accept: "video/*,.mp4,.mov", multiple: true, hint: "One clip per room, one to three minutes, say the room first. Each clip gives stills and a transcript. Works with no signal — clips upload themselves when the phone can." },
  report: { label: "Reports & drawings (PDF)", accept: "application/pdf,.pdf", multiple: true, hint: "The Magicplan report, plus any layout or customer list. Up to 4." },
  photos: { label: "Extra photos", accept: "image/*", multiple: true, hint: "Anything not already in the report." },
  notes:  { label: "Handwritten notes", accept: "image/*", multiple: true, hint: "A photo of each page." },
  videos: { label: "Silent clips (Magicplan)", accept: "video/*,.mp4,.mov", multiple: true, hint: "Still frames are pulled from each clip so the draft can see the room." },
  audio:  { label: "Site walk recording", accept: "audio/*,video/*,.m4a,.mp3,.wav,.aac", multiple: false, hint: "A voice memo of the whole walk, if you made one instead of clips. It's transcribed for you." },
};

export function newSiteVisit() {
  return { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
}
export function siteVisitOf(project) {
  if (!project.siteVisit || typeof project.siteVisit !== "object") project.siteVisit = newSiteVisit();
  const sv = project.siteVisit;
  if (!Array.isArray(sv.files)) sv.files = [];
  adoptLegacyTranscript(sv);   // a pre-walk-clip visit: its transcript moves onto the recording's row, once
  return sv;
}

/** Storage path for one packet file — must match the server's isSitePath(). */
export function siteFilePath(projectId, fileId, name) {
  const clean = (s, max) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-max);
  const job = clean(projectId, 80) || "job";
  const base = clean(name, 80).replace(/^[._]+/, "") || "file";
  return `sitevisit/${job}/${clean(fileId, 60)}-${base}`;
}

/** The packet the server drafts from (paths + labels, never file bytes). */
export function packetForDraft(sv) {
  const of = (kind) => arr(sv && sv.files).filter((f) => f && f.kind === kind && f.path);
  const pick = (f) => ({ path: f.path, name: f.name || "", mime: f.mime || "", room: f.room || "", caption: f.caption || "" });
  return {
    reports: of("report").map(pick),
    photos: [...of("photos"), ...of("frames")].map(pick),
    notes: of("notes").map(pick),
    transcript: String((sv && sv.transcript) || ""),
    typedScope: String((sv && sv.typedScope) || ""),
    // M3: measured rooms from the Magicplan scan (feet), or absent
    ...(function () { const q = magicplanQuantities(sv); return q ? { magicplanQuantities: q } : {}; })(),
  };
}
export function packetReady(sv) {
  const p = packetForDraft(sv);
  return p.reports.length + p.photos.length + p.notes.length > 0 || !!p.transcript.trim() || !!p.typedScope.trim();
}

/** The printed notes block: assumptions, exclusions and the Fairbanks pricing basis. */
export function draftNotesText(draft) {
  const list = (title, xs) => (arr(xs).length ? title + "\n" + arr(xs).map((x) => "• " + x).join("\n") : "");
  return [
    list("ASSUMPTIONS", draft.assumptions),
    list("EXCLUSIONS", draft.exclusions),
    draft.pricingNotes ? "PRICING BASIS\n" + draft.pricingNotes : "",
  ].filter(Boolean).join("\n\n");
}

/** Write a finished draft onto an estimate. Replaces the line items; the
    notes block from an earlier site-visit draft is replaced, anything the
    user typed there is kept. Returns counts for the summary line. */
export function applySiteDraft(inv, draft, at = new Date().toISOString()) {
  const lines = arr(draft && draft.items);
  inv.items = lines.map((li) => ({
    id: uid(),
    room: li.room || "", desc: li.desc || "", qty: li.qty != null ? String(li.qty) : "",
    unit: li.unit || "", price: li.price != null ? String(li.price) : "",
    code: li.code || "", priced: li.priced || "", flag: li.priceFlag || "",
    ...(li.by ? { by: String(li.by) } : {}),
  }));
  if (draft.lossSummary) inv.lossSummary = draft.lossSummary;
  const block = draftNotesText(draft);
  const prev = String(inv.siteVisitNotes || "");
  const notes = String(inv.notes || "");
  const kept = prev && notes.includes(prev) ? notes.replace(prev, "").trim() : notes.trim();
  inv.notes = [kept, block].filter(Boolean).join("\n\n");
  inv.siteVisitNotes = block;
  inv.customerScope = arr(draft.rooms).map((r) => ({ room: r.name, summary: r.customerSummary }));
  // construction shape: open choices as alternates, contingency, accuracy, duration
  inv.alternates = arr(draft.alternates).map((a) => ({ title: String(a.title || ""), description: String(a.description || ""), baseCost: String(Number(a.baseCost) || 0) }));
  inv.contingencyPct = Number(draft.contingencyPct) > 0 ? String(draft.contingencyPct) : "";
  inv.accuracyPct = Number(draft.accuracyPct) > 0 ? String(draft.accuracyPct) : "";
  inv.duration = String(draft.duration || "");
  // GC O&P rule: 10 & 10 when a subcontractor is on the job; only while the
  // O&P is still on automatic
  const subs = lines.some((li) => { const b = String(li.by || "").trim().toLowerCase(); return b && b !== "roybal" && b !== "allowance"; });
  if (subs && inv.opAuto !== false && (inv.opMode || "pct") === "pct") { inv.overheadPct = "10"; inv.profitPct = "10"; }
  inv.siteVisitDraft = { at, questions: arr(draft.questions), basis: lines.map((li) => ({ desc: li.desc || "", basis: li.basis || "", priced: li.priced || "" })) };
  return {
    lines: lines.length,
    fromCatalog: lines.filter((li) => li.priced === "catalog").length,
    flagged: lines.filter((li) => li.priced === "flag").length,
    questions: arr(draft.questions).length,
    alternates: arr(draft.alternates).length,
  };
}

/* ---------- browser: files ---------- */
function dataUrlToBlob(src) {
  const [head, b64] = String(src).split(",");
  const mime = (head.match(/^data:([^;]+)/) || [])[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
/* Claude reads JPEG/PNG/WebP/GIF. Re-encode every photo to a ≤1568px JPEG
   (the size the model reads at anyway); an iPhone HEIC the browser can't
   decode comes back raw and is refused with a clear message. */
async function prepareImage(file) {
  const src = await fileToDataURL(file, 1568, 0.85);
  if (!String(src).startsWith("data:image/jpeg")) return null;
  return dataUrlToBlob(src);
}
const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const fmtMinutes = (s) => (s >= 60 ? Math.round(s / 60) + " min" : Math.round(s) + " sec");
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m + " minutes ago";
};

/* Load a video into an off-screen <video> element far enough to know its
   duration and picture size. Returns { v, once, release } — release() always. */
async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto";
  v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
  const once = (ev, ms = 15000) => new Promise((ok, bad) => {
    const t = setTimeout(() => { cleanup(); bad(new Error("the video didn't load")); }, ms);
    const done = () => { cleanup(); ok(); };
    const fail = () => { cleanup(); bad(new Error("this browser can't play that video")); };
    const cleanup = () => { clearTimeout(t); v.removeEventListener(ev, done); v.removeEventListener("error", fail); };
    v.addEventListener(ev, done, { once: true });
    v.addEventListener("error", fail, { once: true });
  });
  const release = () => { v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); };
  try {
    const loaded = once("loadeddata");
    v.src = url;
    v.load();
    await loaded;
    if (v.duration === Infinity) {           // recorder-made webm: no duration until the end is found
      const found = once("seeked");
      v.currentTime = 1e9;
      await found;
    }
  } catch (e) { release(); throw e; }
  return { v, once, release };
}

/** The clip's length in seconds (NaN when the browser can't tell). */
export async function videoDuration(file) {
  const { v, release } = await loadVideo(file);
  try { return Number(v.duration); } finally { release(); }
}

/* Pull still frames out of a video in the browser: seek, draw to a canvas,
   JPEG at ≤1568px. `times` is a list of seconds to take, or a count spread
   evenly over the clip (the silent Magicplan default). Returns [{ t, blob }].
   Throws if the browser can't decode the clip. */
export async function videoFrames(file, times = FRAMES_PER_VIDEO) {
  const { v, once, release } = await loadVideo(file);
  try {
    const list = Array.isArray(times) ? times.filter((t) => t > 0 && t < v.duration) : frameTimes(v.duration, times);
    if (!list.length || !v.videoWidth) throw new Error("the video has no picture");
    const scale = Math.min(1, 1568 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const g = c.getContext("2d");
    const out = [];
    for (const t of list) {
      const seeked = once("seeked");
      v.currentTime = t;
      await seeked;
      g.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
      if (blob) out.push({ t, blob });
    }
    return out;
  } finally {
    release();
  }
}

/* ---------- browser: the panel ----------
   ctx: { project, inv, save(), onApplied(summary) } */
export function siteVisitPanel(ctx) {
  const { project, inv } = ctx;
  const sv = siteVisitOf(project);
  const root = h("div", { class: "app-only sitevisit", style: "border:1px solid #b9c4d4;border-radius:10px;padding:12px;margin:0 0 10px;background:#f7f9fc" });
  // 📥 a Magicplan scan waiting for this job (docs/Magicplan_Integration_Design.md §5)
  const mpBanner = magicplanBanner(project, { onAdopted: () => paint("") });
  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  // 🎥 Record renders for the owner and office (design §2 decision 8). One
  // cached read; unknown (offline, a failed read) shows the buttons — the
  // server action is the enforcement, this only keeps a crew phone tidy.
  let office = null;
  officeRole().then((r) => { if (r === false) { office = false; paint(""); } });
  const busy = new Set();   // walk rows with a transcription in flight (one Deepgram call per tap)

  async function addFiles(kind, files) {
    if (kind !== "walk" && !aiAvailable()) return;   // a walk clip is captured offline; only its transcript needs signal
    let added = 0;
    for (const file of files) {
      const id = uid();
      try {
        let blob = file, mime = file.type || "";
        if (kind === "walk") {
          // A narrated clip, captured with or without signal. Order matters:
          // the blob goes to the media queue FIRST (Safari drops the File the
          // moment it reloads), then stills are pulled and queued too, and the
          // queue uploads everything when the phone can. The transcript is
          // asked for when the queue says the clip landed (onMedia below), or
          // on the next open of this panel (reconcileQueue).
          const name = file.name || "walk.mov";
          if (file.size > WALK_MAX_BYTES) { toast(OVERSIZE_MSG, 4000); continue; }
          const at = new Date().toISOString();
          const clipPath = siteFilePath(project.id, id, name);
          const row = { id, kind, name, mime: file.type || "video/mp4", size: file.size || 0, path: clipPath, duration: 0, frames: 0, room: "", at, status: "queued" };
          paint(`Saving ${name} on this phone…`);
          await enqueueMedia({ id, projectId: project.id, kind: "walk", blob: file, mime: row.mime, name, path: clipPath });
          sv.files.push(row);
          ctx.save();
          const alive = () => sv.files.includes(row);   // ✕ mid-flight stops the work; nothing is re-added
          busy.add(id);
          try {
            paint(`Reading ${name}…`);
            const duration = await videoDuration(file);
            row.duration = isFinite(duration) ? duration : 0;
            if (clipTooBig(row.duration, file.size)) {
              await removeMedia(id);
              sv.files = sv.files.filter((x) => x.id !== id);
              ctx.save();
              toast(OVERSIZE_MSG, 5000);
              continue;
            }
            if (row.duration > LONG_CLIP_SECONDS) toast(LONG_CLIP_NOTE, 4000);
            paint(`Pulling stills from ${name}…`);
            // a clip whose length the browser can't report still gets the silent-clip default (8 spread over it)
            const frames = await videoFrames(file, row.duration > 0 ? stillTimes(row.duration) : FRAMES_PER_VIDEO);
            let i = 0;
            for (const fr of frames) {
              if (!alive()) break;
              i++;
              paint(`Saving stills from ${name} (${i} of ${frames.length})…`);
              const fid = uid(), sec = Math.round(fr.t);
              const fpath = siteFilePath(project.id, fid, `${name}-${sec}s.jpg`);
              await enqueueMedia({ id: fid, projectId: project.id, kind: "frames", blob: fr.blob, mime: "image/jpeg", name: `${name} @ ${sec}s`, path: fpath });
              if (!alive()) { await removeMedia(fid); break; }
              sv.files.push({ id: fid, kind: "frames", videoId: id, name: `${name} @ ${sec}s`, path: fpath, mime: "image/jpeg", size: fr.blob.size, caption: frameCaption(clipLabel(row), sec, "walk clip"), at, queued: true });
              row.frames = i;
              ctx.save();
            }
            if (!alive()) continue;
            added++;
          } catch (e) {
            // the browser couldn't decode it for stills — the clip is still
            // queued: Deepgram reads the audio track without them
            if (alive()) toast(`No stills from ${name} (${e && e.message ? e.message : e}). The clip still uploads and transcribes.`, 5000);
          } finally {
            busy.delete(id);
          }
          ctx.save();
          paint("");
          drainMediaQueue().catch(() => {});
          continue;
        }
        if (kind === "videos") {
          paint(`Pulling stills from ${file.name || "the video"}…`);
          const frames = await videoFrames(file);
          if (!frames.length) throw new Error("no frames came out of it");
          const vid = { id, kind, name: file.name || "video", mime: file.type || "video/mp4", size: 0, frames: frames.length, at: new Date().toISOString() };
          let i = 0;
          for (const fr of frames) {
            i++;
            paint(`Uploading stills from ${vid.name} (${i} of ${frames.length})…`);
            const fid = uid();
            const path = siteFilePath(project.id, fid, `${vid.name}-${Math.round(fr.t)}s.jpg`);
            await uploadSiteFile(path, fr.blob, "image/jpeg");
            sv.files.push({ id: fid, kind: "frames", videoId: id, name: `${vid.name} @ ${Math.round(fr.t)}s`, path, mime: "image/jpeg", size: fr.blob.size, caption: frameCaption(vid.name, fr.t), at: vid.at });
            vid.size += fr.blob.size;
          }
          sv.files.push(vid);
          added++;
          ctx.save();
          continue;
        }
        if (kind === "photos" || kind === "notes") {
          blob = await prepareImage(file);
          if (!blob) { toast(`${file.name || "That photo"} is in a format this browser can't read (often HEIC). Export it as JPEG and add it again.`, 4000); continue; }
          mime = "image/jpeg";
        } else if (kind === "report") {
          mime = "application/pdf";
          if (file.size > 32e6) toast(`${file.name} is ${fmtSize(file.size)}. Reports over 32 MB may not read; if the draft fails, export the report without photos.`, 5000);
        } else if (kind === "audio") {
          mime = mime || "audio/mp4";
        }
        const path = siteFilePath(project.id, id, file.name || (kind + (kind === "report" ? ".pdf" : kind === "audio" ? ".m4a" : ".jpg")));
        paint(`Uploading ${file.name || kind}…`);
        await uploadSiteFile(path, blob, mime);
        if (kind === "audio") sv.files = sv.files.filter((f) => f.kind !== "audio");   // one recording per visit
        sv.files.push({ id, kind, name: file.name || "", path, mime, size: blob.size || 0, at: new Date().toISOString() });
        added++;
        ctx.save();
        if (kind === "audio") { rebuildTranscript(sv); ctx.save(); await transcribe(); }   // the walk clips' text stays
      } catch (e) {
        busy.delete(id);
        toast(`Couldn't add ${file.name || "that file"}: ${e && e.message ? e.message : e}`, 4000);
      }
    }
    paint(added ? "" : undefined);
  }

  /* The transcript as data on its row (design §4.1): the utterances feed the
     still captions and the room; the text feeds the flat sv.transcript. */
  const trimUtts = (xs) => arr(xs).map((u) => ({ start: Number(u && u.start) || 0, end: Number(u && u.end) || 0, speaker: Number(u && u.speaker) || 0, text: String((u && u.text) || "") }));
  const transcriptOf = (r) => ({ utterances: trimUtts(r.utterances), text: r.transcript || "", seconds: Number(r.seconds) || 0, model: "deepgram-stt", at: new Date().toISOString() });

  async function transcribe() {
    const rec = sv.files.find((f) => f.kind === "audio");
    if (!rec || busy.has(rec.id) || !aiAvailable()) return;
    busy.add(rec.id);
    paint("Transcribing the recording… an hour of audio takes about a minute.");
    try {
      const r = await transcribeSiteAudio(project, rec.path);
      rec.transcript = transcriptOf(r);
      rec.status = "transcribed";
      rebuildTranscript(sv);
      ctx.save();
      busy.delete(rec.id);
      paint("");
    } catch (e) {
      busy.delete(rec.id);
      paint("");
      toast("Transcription failed: " + (e && e.message ? e.message : e), 4000);
    }
  }

  /* One narrated clip: transcript → room from the opening words (never
     guessed) → quotes on its stills → the flat transcript rebuilt. A failure
     leaves the row 'uploaded' with its Transcribe button as the retry. */
  const canTalkToAi = () => isSignedIn() && !likelyOffline();   // the silent pre-check; aiAvailable() toasts
  async function transcribeWalk(row) {
    if (!row || row.status !== "uploaded" || !row.path || busy.has(row.id) || !canTalkToAi() || !aiAvailable()) return;
    busy.add(row.id);
    paint(`Transcribing ${row.name}…`);
    try {
      const r = await transcribeSiteAudio(project, row.path);
      row.transcript = transcriptOf(r);
      row.status = "transcribed";
      if (!row.room) row.room = roomFromOpening(row.transcript.utterances, { rooms: arr(project.rooms), magicplanRooms: magicplanRoomNames(sv) }) || "";
      captionStills(sv, row);
      rebuildTranscript(sv);
      ctx.save();
      busy.delete(row.id);   // before the repaint, or the row shows "working…" with no retry
      paint("");
    } catch (e) {
      busy.delete(row.id);
      paint("");
      toast("Transcription failed: " + (e && e.message ? e.message : e), 4000);
    }
  }

  async function start(btn) {
    if (!aiAvailable()) return;
    if (!packetReady(sv)) { toast("Add the report, photos, notes, a recording or a typed scope first."); return; }
    const waiting = await queueRows(project.id).catch(() => []);
    if (waiting.length) { toast(`${waiting.length} file${waiting.length === 1 ? " is" : "s are"} still uploading — draft when the packet is complete.`, 4000); drainMediaQueue().catch(() => {}); return; }
    const hasItems = arr(inv.items).some((it) => String(it.desc || "").trim());
    if (hasItems && !window.confirm("When the draft is ready it replaces this estimate's line items. Start it?")) return;
    btn.disabled = true;
    try {
      const r = await startSiteVisitDraft(project, packetForDraft(sv), inv.pricingMode || "piecework", subRatesText());
      sv.pending = { batchId: r.batchId, invId: inv.id, startedAt: new Date().toISOString(), pricingMode: inv.pricingMode || "piecework" };
      ctx.save();
      paint("");
      toast("Drafting from the site visit. Usually 5–30 minutes, up to an hour on a busy day; you can leave this page.");
    } catch (e) {
      btn.disabled = false;
      toast("Couldn't start the draft: " + (e && e.message ? e.message : e), 4000);
    }
  }

  async function check(manual) {
    const job = sv.pending;
    if (!job || !job.batchId) return;
    if (!root.isConnected && !manual) { stopTimer(); return; }
    try {
      const r = await checkSiteVisitDraft(project, job.batchId, job.pricingMode);
      if (r.status !== "done") { if (manual) toast("Still drafting."); paint(""); return; }
      const target = job.invId === inv.id ? inv : arr(project.reconEstimates).find((e) => e && e.id === job.invId) || inv;
      const draft = r.draft || {};
      // M3: the estimate's Pricing Basis says where measured quantities came from
      const mq = magicplanQuantities(sv);
      if (mq) draft.pricingNotes = withMagicplanBasis(draft.pricingNotes, mq.scannedAt);
      const sum = applySiteDraft(target, draft);
      sv.pending = null;
      sv.lastDraftAt = new Date().toISOString();
      ctx.save();
      stopTimer();
      paint("");
      if (target === inv) ctx.onApplied(sum);
    } catch (e) {
      // no signal: keep waiting; the draft is safe on the server
      if (e instanceof TypeError) { if (manual) toast("No connection. The draft keeps running; check again when you're back online."); return; }
      // a failed draft is final: clear it so a new one can start
      sv.pending = null;
      ctx.save();
      stopTimer();
      paint("");
      toast("The draft didn't finish: " + (e && e.message ? e.message : e), 5000);
    }
  }

  function fileRow(f) {
    const del = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto", title: "Remove from the packet" }, "✕");
    del.addEventListener("click", () => {
      const gone = sv.files.filter((x) => x.id === f.id || x.videoId === f.id);
      sv.files = sv.files.filter((x) => x.id !== f.id && x.videoId !== f.id);   // a video takes its stills with it
      for (const x of gone) if (x.kind === "walk" || x.queued) removeMedia(x.id).catch(() => {});   // never upload what was taken out
      // the flat transcript is derived from the rows; the storage object
      // stays — retention (design §2 decision 10) owns deletes, never a tap
      if (f.kind === "audio" || f.kind === "walk" || f.kind === "meeting") rebuildTranscript(sv);
      // a Magicplan file leaves the packet only: the storage copy stays, and
      // the next ⟳ Pull doesn't bring it back
      if (f.source === "magicplan" && sv.magicplan) sv.magicplan.removed = [...new Set([...(sv.magicplan.removed || []), f.id])];
      ctx.save(); paint("");
    });
    if (f.kind === "walk") return walkRow(f, del);
    return h("div", { style: "display:flex;gap:8px;align-items:center;font-size:12px;margin-top:4px" },
      h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, f.name || f.kind),
      f.source === "magicplan" ? h("span", { style: "font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:#e7eef7;color:#1e4a72" }, "Magicplan") : null,
      h("span", { class: "subtle" }, f.kind === "videos" ? `${f.frames || 0} stills` : fmtSize(f.size || 0)), del);
  }

  /* ---------- the media queue ↔ this packet ----------
     The queue never writes to the job record; the panel reads the queue.
     Live: onMedia events move a clip queued → uploading → uploaded (then
     transcribe) or → failed. On open: reconcileQueue() settles what happened
     while the panel was closed (a clip that is no longer queued has landed). */
  const progress = new Map();   // clip id → % (chips update in place; a full repaint would eat the scope textarea's focus)
  let qsum = null;              // this job's queue summary for the line under the walk slot
  const refreshQueueSummary = async () => { try { qsum = await queueSummary(project.id); } catch { qsum = null; } };
  const offMedia = onMedia(async ({ type, row: q }) => {
    if (!q || q.projectId !== project.id) return;
    if (!root.isConnected) { offMedia(); return; }
    const f = sv.files.find((x) => x.id === q.id);
    if (type === "progress") {
      progress.set(q.id, q.pct);
      if (f && f.kind === "walk") { f.status = "uploading"; paintChip(f); }
      return;
    }
    await refreshQueueSummary();
    if (type === "uploaded") {
      progress.delete(q.id);
      if (f && f.kind === "walk") { f.status = "uploaded"; ctx.save(); paint(""); await transcribeWalk(f); return; }
      if (f && f.kind === "frames") { delete f.queued; ctx.save(); }
      if (!qsum || !qsum.count) paint("");   // a still landing is not worth a repaint; the last one is
      return;
    }
    if (type === "failed" || type === "error" || type === "paused" || type === "queued" || type === "removed") {
      if (f && f.kind === "walk") { f.status = type === "failed" ? "failed" : "queued"; if (q.lastError) f.lastError = q.lastError; ctx.save(); }
      paint("");
    }
  });
  async function reconcileQueue() {
    let rows = [];
    try { rows = await queueRows(project.id); } catch { return; }
    const q = new Map(rows.map((r) => [r.id, r]));
    let changed = false;
    for (const f of sv.files) {
      if (!f) continue;
      if (f.kind === "walk") {
        const r = q.get(f.id);
        if (r) { const st = r.status === "failed" ? "failed" : r.status === "uploading" ? "uploading" : "queued"; if (r.pct) progress.set(f.id, r.pct); if (f.status !== st) { f.status = st; changed = true; } }
        else if (f.status === "queued" || f.status === "uploading" || f.status === "failed") { f.status = "uploaded"; changed = true; }   // landed while the panel was closed
      } else if (f.kind === "frames" && f.queued && !q.has(f.id)) { delete f.queued; changed = true; }
    }
    await refreshQueueSummary();
    if (changed) ctx.save();
    paint("");
    drainMediaQueue().catch(() => {});
    // clips that landed but were never transcribed (the panel was closed, or it failed): one at a time
    if (canTalkToAi()) for (const f of sv.files) if (f && f.kind === "walk" && f.status === "uploaded" && !(f.transcript && f.transcript.text)) await transcribeWalk(f);
  }
  function paintChip(f) {
    const el = root.querySelector(`[data-clip="${f.id}"] .clipchip`);
    if (el) el.textContent = chipText(f);
  }
  function chipText(f) {
    if (busy.has(f.id)) return "working…";
    if (f.status === "transcribed") return "transcribed ✓";
    if (f.status === "uploaded") return "uploaded";
    if (f.status === "failed") return "upload failed — tap retry";
    const pct = progress.get(f.id);
    if (f.status === "uploading" || pct) return `uploading ${pct || 0}%`;
    return "queued — uploads when the phone has signal";
  }

  /* A walk clip: "Kitchen · 2:14 · 12 stills · transcribed ✓", a Room field
     the owner can correct (the stills' quotes and the flat transcript follow),
     a Transcribe button while the transcript is missing, and a retry when
     the upload gave up. */
  function walkRow(f, del) {
    const n = clipNumber(sv.files, f);
    const chip = (text, color) => h("span", { style: `font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:${color};white-space:nowrap` }, text);
    const color = busy.has(f.id) ? "#fff4e5;color:#b45309"
      : f.status === "transcribed" ? "#e3f3e6;color:#2e7d32"
      : f.status === "uploaded" ? "#e7eef7;color:#1e4a72"
      : f.status === "failed" ? "#fde8e8;color:#b42318"
      : "#f1f3f6;color:#44556b";
    const status = chip(chipText(f), color);
    status.classList.add("clipchip");
    if (f.status === "failed") status.title = f.lastError || "";
    const retry = f.status === "failed"
      ? h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto", onclick: async () => { await retryMedia(f.id); f.status = "queued"; ctx.save(); paint(""); drainMediaQueue().catch(() => {}); } }, "Retry")
      : null;
    const room = h("input", { type: "text", placeholder: `Clip ${n} — room?`, value: f.room || "", title: "The room this clip is about", style: "width:9em;font-size:12px;padding:2px 6px" });
    room.addEventListener("change", () => {   // change, not input: every save repaints the panel
      f.room = room.value.trim();
      captionStills(sv, f); rebuildTranscript(sv);
      ctx.save(); paint("");
    });
    const tb = f.status === "uploaded" && !busy.has(f.id)
      ? h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto", onclick: () => transcribeWalk(f) }, "Transcribe")
      : null;
    return h("div", { "data-clip": f.id, style: "display:flex;gap:8px;align-items:center;font-size:12px;margin-top:4px;flex-wrap:wrap" },
      h("span", { style: "flex:1;min-width:8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, f.room ? f.room : `Clip ${n}`,
        h("span", { class: "subtle" }, ` · ${mmss(f.duration || 0)} · ${f.frames || 0} stills`)),
      room, status, retry, tb, del);
  }

  function slot(kind) {
    const k = KINDS[kind];
    const input = h("input", { type: "file", accept: k.accept, style: "display:none", ...(k.multiple ? { multiple: true } : {}) });
    input.addEventListener("change", () => { const fs = [...input.files]; input.value = ""; if (fs.length) addFiles(kind, fs); });
    const files = sv.files.filter((f) => f.kind === kind);
    const btn = h("button", { type: "button", class: "btn btn--sm", style: "width:auto" }, files.length && kind !== "audio" ? "+ Add more" : files.length ? "Replace" : "+ Add");
    btn.addEventListener("click", () => input.click());
    const many = kind === "photos" || kind === "notes" || kind === "videos" || kind === "walk";
    const extra = [];
    let buttons = [btn, input];
    if (kind === "walk") {
      // 🎥 Record opens the phone's Camera (capture=environment); Add from
      // Photos is the same input without it. Both land in addFiles("walk").
      const cam = h("input", { type: "file", accept: "video/*", capture: "environment", style: "display:none" });
      cam.addEventListener("change", () => { const fs = [...cam.files]; cam.value = ""; if (fs.length) addFiles(kind, fs); });
      const rec = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto", onclick: () => cam.click() }, "🎥 Record");
      const lib = h("button", { type: "button", class: "btn btn--sm", style: "width:auto", onclick: () => input.click() }, "Add from Photos");
      buttons = office === false
        ? [h("span", { class: "subtle", style: "font-size:11px" }, "Recording walks is for the owner and office."), input, cam]
        : [rec, lib, input, cam];
    }
    if (kind === "audio" && files.length) {
      const rec = files[0];
      if (rec.transcript && rec.transcript.text) {
        extra.push(h("div", { class: "subtle", style: "font-size:12px;margin-top:4px;color:#2e7d32" },
          `✓ Transcribed, ${fmtMinutes(rec.transcript.seconds || 0)}`));
      } else {
        const tb = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto;margin-top:4px" }, "Transcribe");
        tb.addEventListener("click", () => transcribe());
        extra.push(tb);
      }
    }
    return h("div", { style: "padding:8px 0;border-top:1px solid #e2e6ed" },
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        h("div", { style: "flex:1;min-width:0" },
          h("div", { style: "font-weight:600;font-size:13px;color:#16395a" }, k.label + (many && files.length ? ` (${files.length})` : "")),
          h("div", { class: "subtle", style: "font-size:11px" }, k.hint)),
        ...buttons),
      ...(many && kind !== "walk" && files.length > 3   // walk rows always list: each carries its room, status and retry
        ? [h("div", { class: "subtle", style: "font-size:12px;margin-top:4px" }, kind === "videos"
          ? `${files.length} clips, ${files.reduce((t, f) => t + (f.frames || 0), 0)} stills`
          : `${files.length} pages/photos, ${fmtSize(files.reduce((t, f) => t + (f.size || 0), 0))}`)]
        : files.map(fileRow)),
      ...(kind === "walk" && files.length > 1
        ? [h("div", { class: "subtle", style: "font-size:12px;margin-top:4px" }, (() => { const w = walkSummary(sv.files); return `${w.clips} clips · ${fmtMinutes(w.seconds)} · ${w.stills} stills`; })())]
        : []),
      ...(kind === "walk" && qsum && qsum.count
        ? [h("div", { style: "font-size:12px;margin-top:4px;color:#b45309" },
            `📤 ${qsum.clips ? `${qsum.clips} clip${qsum.clips === 1 ? "" : "s"}` : `${qsum.count} file${qsum.count === 1 ? "" : "s"}`} waiting to upload · ${fmtMB(Math.max(0, qsum.bytes - qsum.bytesSent))}` +
            (qsum.failed ? ` · ${qsum.failed} failed` : "") + (likelyOffline() ? " — no signal; it goes when you have it" : ""))]
        : []),
      ...extra);
  }

  const imageCount = () => sv.files.filter((f) => f.path && (f.kind === "photos" || f.kind === "frames" || f.kind === "notes")).length;

  function paint(status) {
    const job = sv.pending;
    const scope = h("textarea", { rows: "4", placeholder: "Type the scope the way you would in Claude: what's in, what's out, materials, anything the photos won't show.", style: "flex:1;min-width:0;font-size:13px" });
    scope.value = sv.typedScope || "";
    scope.addEventListener("input", () => { sv.typedScope = scope.value; ctx.save(); });
    const mic = dictateBtn(project, (t) => { scope.value = (scope.value.trim() ? scope.value.trim() + " " : "") + t; sv.typedScope = scope.value; ctx.save(); }, { title: "Dictate the scope" });

    const go = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto" }, "✨ Draft estimate from site visit");
    go.addEventListener("click", () => start(go));
    const checkBtn = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "Check now");
    checkBtn.addEventListener("click", () => check(true));

    const footer = job
      ? h("div", { style: "margin-top:10px;padding:8px 10px;border-radius:8px;background:#fff4e5;border:1px solid #f0b463;font-size:13px" },
          h("strong", {}, "Drafting from the site visit"),
          h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 6px" },
            `Started ${ago(job.startedAt)}. It usually takes 5–30 minutes, up to an hour on a busy day. You can leave this page; open this estimate again to load it.`),
          checkBtn)
      : h("div", { style: "margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, go,
          sv.lastDraftAt ? h("span", { class: "subtle", style: "font-size:12px" }, `Last drafted ${ago(sv.lastDraftAt)}`) : null);

    const questions = arr(inv.siteVisitDraft && inv.siteVisitDraft.questions);
    root.replaceChildren(...[   // a null slot must not become a "null" text node
      h("div", { style: "font-weight:700;font-size:14px;color:#16395a" }, "📋 Site visit"),
      h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 6px" },
        "Add what you collected on the walk. The draft reads all of it, prices from the Fairbanks list, and fills this estimate room by room."),
      mpBanner,
      slot("walk"), slot("report"), slot("photos"), slot("videos"), slot("notes"), slot("audio"),
      imageCount() > MAX_IMAGES
        ? h("div", { style: "font-size:12px;margin-top:4px;color:#b45309" },
            `${imageCount()} pictures in the packet; the draft reads the first ${MAX_IMAGES} (note pages first, then photos, then the newest stills are dropped). Remove clips or photos you don't need.`)
        : null,
      h("div", { style: "padding:8px 0;border-top:1px solid #e2e6ed" },
        h("div", { style: "font-weight:600;font-size:13px;color:#16395a;margin-bottom:4px" }, "Typed scope"),
        h("div", { style: "display:flex;gap:8px;align-items:flex-start" }, scope, mic)),
      status ? h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" }, status) : null,
      footer,
      questions.length && !job
        ? h("div", { style: "margin-top:10px;font-size:12px" },
            h("strong", {}, "Open questions from the last draft"),
            h("div", { class: "subtle", style: "font-size:11px" }, "Answer them in the typed scope and draft again."),
            ...questions.map((q) => h("div", { style: "margin-top:3px" }, "• " + q)))
        : null].filter(Boolean));
    if (job && !timer) timer = setInterval(() => check(false), 30000);
    if (!job) stopTimer();
  }

  paint("");
  if (sv.pending) setTimeout(() => check(false), 0);   // came back to it: load it if it's done
  setTimeout(() => { reconcileQueue().catch(() => {}); }, 0);   // what the queue did while this panel was closed
  return root;
}
