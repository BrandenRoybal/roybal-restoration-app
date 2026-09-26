/* ============================================================
   Roybal Field Forms — Site Visit estimator
   ------------------------------------------------------------
   Branden's estimate process: walk the site, Magicplan LiDAR scan with
   photos pinned per room, record the walk on his phone, jot notes by hand,
   type the scope — then hand ALL of it to Claude. This panel is that
   process inside the estimate editor:

     1. drop in the Magicplan report PDF, extra photos, Magicplan room
        videos (turned into still frames in the browser), photographed note
        pages and the walk recording (uploaded to the private field-media
        bucket under sitevisit/<job>/ — never into the job record, so a
        40 MB report or an hour of audio can't stall sync);
     2. the recording is transcribed server-side (Deepgram);
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
import { h, toast, fileToDataURL, uid } from "./core.js";
import { uploadSiteFile } from "./supa.js";
import { aiAvailable, transcribeSiteAudio, startSiteVisitDraft, checkSiteVisitDraft } from "./officeai.js";
import { subRatesText } from "./pricing.js";
import { dictateBtn } from "./dictate.js";
import { magicplanBanner } from "./magicplan.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const MAX_IMAGES = 90;   // the server's limit (sitevisit.ts MAX_IMAGES): photos, stills and note pages together

/* ---------- pure: packet shape ---------- */
export const KINDS = {
  report: { label: "Reports & drawings (PDF)", accept: "application/pdf,.pdf", multiple: true, hint: "The Magicplan report, plus any layout or customer list. Up to 4." },
  photos: { label: "Extra photos", accept: "image/*", multiple: true, hint: "Anything not already in the report." },
  notes:  { label: "Handwritten notes", accept: "image/*", multiple: true, hint: "A photo of each page." },
  videos: { label: "Magicplan room videos", accept: "video/*,.mp4,.mov", multiple: true, hint: "Still frames are pulled from each clip so the draft can see the room." },
  audio:  { label: "Site walk recording", accept: "audio/*,video/*,.m4a,.mp3,.wav,.aac", multiple: false, hint: "The recording from your phone. It's transcribed for you." },
};

/* Magicplan room videos are short and silent, and the model reads images,
   not video. Each clip becomes a handful of evenly spaced still frames
   (never the first or last instant, which are often blurred). */
export const FRAMES_PER_VIDEO = 8;
export function frameTimes(duration, max = FRAMES_PER_VIDEO) {
  const d = Number(duration);
  if (!(d > 0) || !isFinite(d)) return [];
  const n = Math.max(1, Math.min(max, Math.ceil(d / 2)));   // at most one frame every ~2 s
  return Array.from({ length: n }, (_, i) => Math.round((d * (i + 0.5) / n) * 100) / 100);
}
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export function frameCaption(videoName, t) {
  return `still at ${mmss(t)} from Magicplan video ${videoName || "clip"}`;
}

export function newSiteVisit() {
  return { files: [], transcript: "", transcriptSeconds: 0, typedScope: "", pending: null };
}
export function siteVisitOf(project) {
  if (!project.siteVisit || typeof project.siteVisit !== "object") project.siteVisit = newSiteVisit();
  const sv = project.siteVisit;
  if (!Array.isArray(sv.files)) sv.files = [];
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

/* Pull still frames out of a video in the browser: seek, draw to a canvas,
   JPEG at ≤1568px. Returns [{ t, blob }]. Throws if the browser can't
   decode the clip. */
export async function videoFrames(file, max = FRAMES_PER_VIDEO) {
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
    const times = frameTimes(v.duration, max);
    if (!times.length || !v.videoWidth) throw new Error("the video has no picture");
    const scale = Math.min(1, 1568 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const g = c.getContext("2d");
    const out = [];
    for (const t of times) {
      const seeked = once("seeked");
      v.currentTime = t;
      await seeked;
      g.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
      if (blob) out.push({ t, blob });
    }
    return out;
  } finally {
    v.removeAttribute("src"); v.load();
    URL.revokeObjectURL(url);
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

  async function addFiles(kind, files) {
    if (!aiAvailable()) return;
    let added = 0;
    for (const file of files) {
      const id = uid();
      try {
        let blob = file, mime = file.type || "";
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
        if (kind === "audio") { sv.transcript = ""; sv.transcriptSeconds = 0; ctx.save(); await transcribe(); }
      } catch (e) {
        toast(`Couldn't add ${file.name || "that file"}: ${e && e.message ? e.message : e}`, 4000);
      }
    }
    paint(added ? "" : undefined);
  }

  async function transcribe() {
    const rec = sv.files.find((f) => f.kind === "audio");
    if (!rec || !aiAvailable()) return;
    paint("Transcribing the recording… an hour of audio takes about a minute.");
    try {
      const r = await transcribeSiteAudio(project, rec.path);
      sv.transcript = r.transcript || "";
      sv.transcriptSeconds = Number(r.seconds) || 0;
      ctx.save();
      paint("");
    } catch (e) {
      paint("");
      toast("Transcription failed: " + (e && e.message ? e.message : e), 4000);
    }
  }

  async function start(btn) {
    if (!aiAvailable()) return;
    if (!packetReady(sv)) { toast("Add the report, photos, notes, a recording or a typed scope first."); return; }
    const hasItems = arr(inv.items).some((it) => String(it.desc || "").trim());
    if (hasItems && !window.confirm("When the draft is ready it replaces this estimate's line items. Start it?")) return;
    btn.disabled = true;
    try {
      const r = await startSiteVisitDraft(project, packetForDraft(sv), inv.pricingMode || "piecework", subRatesText());
      sv.pending = { batchId: r.batchId, invId: inv.id, startedAt: new Date().toISOString(), pricingMode: inv.pricingMode || "piecework" };
      ctx.save();
      paint("");
      toast("Drafting from the site visit. This takes a few minutes; you can leave this page.");
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
      const sum = applySiteDraft(target, r.draft || {});
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
      sv.files = sv.files.filter((x) => x.id !== f.id && x.videoId !== f.id);   // a video takes its stills with it
      if (f.kind === "audio") { sv.transcript = ""; sv.transcriptSeconds = 0; }
      // a Magicplan file leaves the packet only: the storage copy stays, and
      // the next ⟳ Pull doesn't bring it back
      if (f.source === "magicplan" && sv.magicplan) sv.magicplan.removed = [...new Set([...(sv.magicplan.removed || []), f.id])];
      ctx.save(); paint("");
    });
    return h("div", { style: "display:flex;gap:8px;align-items:center;font-size:12px;margin-top:4px" },
      h("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, f.name || f.kind),
      f.source === "magicplan" ? h("span", { style: "font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:#e7eef7;color:#1e4a72" }, "Magicplan") : null,
      h("span", { class: "subtle" }, f.kind === "videos" ? `${f.frames || 0} stills` : fmtSize(f.size || 0)), del);
  }

  function slot(kind) {
    const k = KINDS[kind];
    const input = h("input", { type: "file", accept: k.accept, style: "display:none", ...(k.multiple ? { multiple: true } : {}) });
    input.addEventListener("change", () => { const fs = [...input.files]; input.value = ""; if (fs.length) addFiles(kind, fs); });
    const files = sv.files.filter((f) => f.kind === kind);
    const btn = h("button", { type: "button", class: "btn btn--sm", style: "width:auto" }, files.length && kind !== "audio" ? "+ Add more" : files.length ? "Replace" : "+ Add");
    btn.addEventListener("click", () => input.click());
    const many = kind === "photos" || kind === "notes" || kind === "videos";
    const extra = [];
    if (kind === "audio" && files.length) {
      if (sv.transcript) {
        extra.push(h("div", { class: "subtle", style: "font-size:12px;margin-top:4px;color:#2e7d32" },
          `✓ Transcribed, ${fmtMinutes(sv.transcriptSeconds || 0)}`));
      } else {
        const tb = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto;margin-top:4px" }, "Transcribe");
        tb.addEventListener("click", () => transcribe());
        extra.push(tb);
      }
    }
    return h("div", { style: "padding:8px 0;border-top:1px solid #e2e6ed" },
      h("div", { style: "display:flex;gap:8px;align-items:center" },
        h("div", { style: "flex:1;min-width:0" },
          h("div", { style: "font-weight:600;font-size:13px;color:#16395a" }, k.label + (many && files.length ? ` (${files.length})` : "")),
          h("div", { class: "subtle", style: "font-size:11px" }, k.hint)),
        btn, input),
      ...(many && files.length > 3
        ? [h("div", { class: "subtle", style: "font-size:12px;margin-top:4px" }, kind === "videos"
          ? `${files.length} clips, ${files.reduce((t, f) => t + (f.frames || 0), 0)} stills`
          : `${files.length} pages/photos, ${fmtSize(files.reduce((t, f) => t + (f.size || 0), 0))}`)]
        : files.map(fileRow)),
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
            `Started ${ago(job.startedAt)}. It usually takes a few minutes. You can leave this page; open this estimate again to load it.`),
          checkBtn)
      : h("div", { style: "margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, go,
          sv.lastDraftAt ? h("span", { class: "subtle", style: "font-size:12px" }, `Last drafted ${ago(sv.lastDraftAt)}`) : null);

    const questions = arr(inv.siteVisitDraft && inv.siteVisitDraft.questions);
    root.replaceChildren(
      h("div", { style: "font-weight:700;font-size:14px;color:#16395a" }, "📋 Site visit"),
      h("div", { class: "subtle", style: "font-size:12px;margin:2px 0 6px" },
        "Add what you collected on the walk. The draft reads all of it, prices from the Fairbanks list, and fills this estimate room by room."),
      mpBanner,
      slot("report"), slot("photos"), slot("videos"), slot("notes"), slot("audio"),
      imageCount() > MAX_IMAGES
        ? h("div", { style: "font-size:12px;margin-top:4px;color:#b45309" },
            `${imageCount()} pictures in the packet; the draft reads the first ${MAX_IMAGES} (note pages first). Remove clips or photos you don't need.`)
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
        : null);
    if (job && !timer) timer = setInterval(() => check(false), 30000);
    if (!job) stopTimer();
  }

  paint("");
  if (sv.pending) setTimeout(() => check(false), 0);   // came back to it: load it if it's done
  return root;
}
