/* ============================================================
   Roybal Field Forms — Scope Notes (V2), the review surface
   ------------------------------------------------------------
   docs/Narrated_Walkthrough_Design.md §3 steps 7–10, §4.2, §5.

   The narrated clips' transcripts become room-by-room notes the owner
   reviews before anything is priced: ✓ keep · ✎ edit · ✕ drop per item,
   "Accept all in this room", and "Use as typed scope" which carries the
   accepted lines into siteVisit.typedScope under a "## Room" heading.
   Every item plays its clip at the cited second. Nothing here writes a
   quantity, a price, a reading or a customer-facing sentence: the notes are
   a proposal until a person accepts them, and the draft reads only the
   accepted ones (walkScopeNotesText).

   Pure logic lives in walk.js (Node-tested); this file is the DOM.
   ============================================================ */
import { h, toast, likelyOffline } from "./core.js";
import { signedSiteUrl, isSignedIn } from "./supa.js";
import { aiAvailable, extractWalkClip, proposeMissingLines } from "./officeai.js";
import { jobType } from "./model.js";
import {
  NOTE_BUCKETS, BUCKET_LABEL, clipKey, clipsToExtract, extractInputFor, mergeScopeNotes, noteItems, isAccepted, isDropped,
  scopeNotesSummary, cite, typedScopeFromRoom, missingLines, walkRows, mmss,
} from "./walk.js";

const arr = (v) => (Array.isArray(v) ? v : []);
const CONCURRENCY = 3;

/** Run walkExtract for every clip whose notes are missing or stale, then
    merge. Per-clip notes are kept on sv.walkNotes (keyed by clip + transcript
    hash) so a re-run after one new clip reads one clip. Returns the merge. */
export async function extractAll(project, sv, { onProgress, force = false } = {}) {
  // force: read every transcribed clip again; a clip whose call fails keeps its previous notes
  const todo = force ? walkRows(sv.files).filter((f) => f.transcript && String(f.transcript.text || "").trim()) : clipsToExtract(sv);
  if (!sv.walkNotes || typeof sv.walkNotes !== "object") sv.walkNotes = {};
  const jobKind = jobType(project) === "construction" ? "construction" : "claim";
  let done = 0, failed = 0, model = "";
  const queue = [...todo];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const r = await extractWalkClip(project, extractInputFor(sv, row, { rooms: arr(project.rooms), jobKind }));
        sv.walkNotes[clipKey(row)] = r.notes;
        model = r.model || model;
      } catch (e) { failed++; toast(`Couldn't read ${row.room || row.name}: ${(e && e.message) || e}`, 4000); }
      done++;
      if (onProgress) onProgress(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  // keep only the clips that still exist with this transcript
  const live = new Map(walkRows(sv.files).map((f) => [clipKey(f), f]));
  for (const k of Object.keys(sv.walkNotes)) if (!live.has(k)) delete sv.walkNotes[k];
  const perClip = [...live.keys()].filter((k) => sv.walkNotes[k]).map((k) => ({ key: k, notes: sv.walkNotes[k] }));
  sv.scopeNotes = mergeScopeNotes(perClip, { prior: sv.scopeNotes, model: model || (sv.scopeNotes && sv.scopeNotes.model) || "" });
  return { extracted: todo.length - failed, failed, ...scopeNotesSummary(sv.scopeNotes) };
}

/** After a draft lands: the accepted instructions and trades it has no line
    for, filed as proposals (idempotent server-side). Never blocks the draft. */
export async function fileMissingLines(project, sv, inv) {
  const miss = missingLines(sv.scopeNotes, inv && inv.items);
  if (!miss.length) return { missing: [], written: 0 };
  try {
    const r = await proposeMissingLines(project, inv.id, miss.map((it) => ({ key: it.key, room: it.room, bucket: it.bucket, text: it.text, clip: it.clip, at: it.at, trade: it.trade || "" })));
    return { missing: miss, written: r.written || 0, existing: r.existing || 0 };
  } catch (e) { return { missing: miss, written: 0, error: (e && e.message) || String(e) }; }
}

/** The section. ctx: { project, sv, inv, save(), onTypedScope() } → element with refresh(). */
export function scopeNotesSection(ctx) {
  const { project, sv, inv } = ctx;
  const root = h("div", { style: "padding:8px 0;border-top:1px solid #e2e6ed" });
  const player = h("video", { controls: "", playsinline: "", preload: "metadata", style: "display:none;width:100%;max-height:260px;border-radius:8px;background:#000;margin:6px 0" });
  const status = h("span", { class: "subtle", style: "font-size:12px" });   // one element, so progress written mid-extraction is seen
  const urls = new Map();
  let busy = false;
  const canAi = () => aiAvailable() && isSignedIn() && !likelyOffline();

  async function seek(clipId, at) {
    const row = walkRows(sv.files).find((f) => f.id === clipId);
    if (!row || !row.path) { toast("That clip isn't on this job any more."); return; }
    if (likelyOffline()) { toast("No signal — the clip plays when you're back online."); return; }
    try {
      let url = urls.get(clipId);
      if (!url) { url = await signedSiteUrl(row.path); if (!url) throw new Error("gone"); urls.set(clipId, url); }
      player.style.display = "";
      const go = () => { try { player.currentTime = Math.max(0, Number(at) || 0); } catch (_) { /* not seekable yet */ } player.play().catch(() => {}); };
      if (player.dataset.clip !== clipId) {
        player.dataset.clip = clipId;
        player.src = url;
        player.addEventListener("loadedmetadata", go, { once: true });
        player.load();
      } else go();
      player.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (_) { toast("Couldn't open that clip — it may still be uploading.", 4000); }
  }

  function setState(key, value) {
    if (!sv.scopeNotes) return;
    if (!sv.scopeNotes.accepted) sv.scopeNotes.accepted = {};
    if (value == null) delete sv.scopeNotes.accepted[key]; else sv.scopeNotes.accepted[key] = value;
    ctx.save(); paint();
  }
  function edit(it) {
    const cur = it.text;
    const next = window.prompt("Edit this note (it keeps its clip citation):", cur);
    if (next == null) return;
    const t = String(next).trim();
    if (!sv.scopeNotes.edited) sv.scopeNotes.edited = {};
    if (!t || t === cur) delete sv.scopeNotes.edited[it.key]; else sv.scopeNotes.edited[it.key] = t;
    if (t) { if (!sv.scopeNotes.accepted) sv.scopeNotes.accepted = {}; sv.scopeNotes.accepted[it.key] = true; }   // an edit is an acceptance
    ctx.save(); paint();
  }
  function useAsTyped(room) {
    const { text, keys } = typedScopeFromRoom(sv.scopeNotes, room);
    if (!text) { toast("Accept some notes in this room first."); return; }
    const cur = String(sv.typedScope || "").trim();
    sv.typedScope = (cur ? cur + "\n\n" : "") + text;
    if (!sv.scopeNotes.used) sv.scopeNotes.used = {};
    for (const k of keys) sv.scopeNotes.used[k] = true;
    ctx.save();
    if (ctx.onTypedScope) ctx.onTypedScope();
    paint();
    toast(`${keys.length} note${keys.length === 1 ? "" : "s"} added to the typed scope under "${room || "Job-wide"}".`);
  }

  function itemRow(it) {
    const sn = sv.scopeNotes;
    const acc = isAccepted(sn, it.key), drop = isDropped(sn, it.key);
    const bg = acc ? "#e8f5ea" : drop ? "#f1f2f4" : "#fff4e5";
    const border = acc ? "#9ccc9f" : drop ? "#d5d9e0" : "#f0b463";
    const chip = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto;padding:1px 6px;font-size:11px", title: "Play the clip at this second" }, "▶ " + mmss(Number(it.at) || 0));
    chip.addEventListener("click", () => seek(it.clip, it.at));
    const btn = (label, title, on, active) => { const b = h("button", { type: "button", class: "btn btn--sm " + (active ? "btn--primary" : "btn--ghost"), style: "width:auto;padding:1px 7px;font-size:12px", title }, label); b.addEventListener("click", on); return b; };
    const text = [it.bucket === "trades" && it.trade ? h("strong", {}, it.trade + ": ") : null, it.text,
      it.bucket === "damage" && it.cause ? h("span", { class: "subtle" }, ` — cause: ${it.cause}`) : null,
      sn.edited && sn.edited[it.key] ? h("span", { class: "subtle", style: "font-size:11px" }, " (edited)") : null,
      sn.used && sn.used[it.key] ? h("span", { class: "subtle", style: "font-size:11px" }, " · in typed scope") : null].filter(Boolean);
    return h("div", { style: `display:flex;gap:6px;align-items:flex-start;margin:3px 0;padding:5px 8px;border-radius:7px;background:${bg};border:1px solid ${border};font-size:13px${drop ? ";text-decoration:line-through;color:#6b7280" : ""}` },
      h("div", { style: "flex:1;min-width:0" }, ...text),
      chip,
      btn("✓", "Keep", () => setState(it.key, acc ? null : true), acc),
      btn("✎", "Edit", () => edit(it), false),
      btn("✕", "Drop", () => setState(it.key, drop ? null : false), drop));
  }

  function roomBlock(r, items) {
    const sn = sv.scopeNotes;
    const mine = items.filter((it) => (it.room || "") === (r.room || ""));
    if (!mine.length) return null;
    const acc = mine.filter((it) => isAccepted(sn, it.key)).length;
    const open = mine.some((it) => !isAccepted(sn, it.key) && !isDropped(sn, it.key));
    const acceptAll = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "✓ Accept all in this room");
    acceptAll.addEventListener("click", () => { if (!sn.accepted) sn.accepted = {}; for (const it of mine) if (!isDropped(sn, it.key)) sn.accepted[it.key] = true; ctx.save(); paint(); });
    const use = h("button", { type: "button", class: "btn btn--primary btn--sm", style: "width:auto", title: "Append the accepted notes to the typed scope under this room's heading" }, "➜ Use as typed scope");
    use.addEventListener("click", () => useAsTyped(r.room || ""));
    const groups = [];
    for (const b of NOTE_BUCKETS) {
      const xs = mine.filter((it) => it.bucket === b);
      if (!xs.length) continue;
      groups.push(h("div", { style: "margin-top:6px" }, h("div", { class: "subtle", style: "font-size:11px;text-transform:uppercase;letter-spacing:.03em;font-weight:700" }, BUCKET_LABEL[b] || b), ...xs.map(itemRow)));
    }
    const det = h("details", open ? { open: "" } : {}, h("summary", { style: "cursor:pointer;font-weight:700;font-size:13px;color:#16395a" },
      `${r.room || "Job-wide"} · ${mine.length} note${mine.length === 1 ? "" : "s"}${acc ? ` · ${acc} accepted` : ""}`),
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0" }, acceptAll, use), ...groups);
    det.style.margin = "6px 0";
    return det;
  }

  let missing = null;   // {items, written, error} from the last comparison
  async function fileNow(btn) {
    btn.disabled = true;
    const r = await fileMissingLines(project, sv, inv);
    missing = r;
    paint();
    toast(r.error ? "Couldn't file them: " + r.error : r.written ? `${r.written} filed for office review.` : "Already on file for review.", 4000);
  }

  function paint() {
    const sn = sv.scopeNotes;
    const todo = clipsToExtract(sv);
    const transcribed = walkRows(sv.files).filter((f) => f.transcript && String(f.transcript.text || "").trim()).length;
    const sum = scopeNotesSummary(sn);
    const go = h("button", { type: "button", class: "btn " + (sn ? "btn--ghost" : "btn--primary") + " btn--sm", style: "width:auto" },
      busy ? "Reading clips…" : sn ? (todo.length ? `↻ Update scope notes (${todo.length} new)` : "↻ Re-read the clips") : "✨ Draft scope notes");
    go.disabled = busy || !transcribed || (!todo.length && !sn) ;
    go.title = transcribed ? "Reads every narrated clip's transcript and stills into room-by-room notes you review" : "Transcribe a walk clip first";
    go.addEventListener("click", async () => {
      if (!canAi()) { toast("Scope notes need a signal — try again when you're back online."); return; }
      busy = true; paint();
      try {
        const r = await extractAll(project, sv, { force: !todo.length && !!sn, onProgress: (d, n) => { status.textContent = `Reading clip ${d} of ${n}…`; } });
        ctx.save();
        toast(r.failed ? `${r.extracted} clip${r.extracted === 1 ? "" : "s"} read, ${r.failed} failed — tap again to retry.` : `${r.items} note${r.items === 1 ? "" : "s"} across ${r.clips} clip${r.clips === 1 ? "" : "s"} — review them room by room.`, 4500);
      } catch (e) { toast("Couldn't draft the notes: " + ((e && e.message) || e), 4000); }
      busy = false; paint();
    });
    status.textContent = busy ? "Reading clips…"
      : sn ? `${sum.items} notes · ${sum.accepted} accepted${sum.toVerify ? ` · ${sum.toVerify} to verify` : ""}${sum.reviewed ? " · reviewed ✓" : ""}` : transcribed ? "" : "Record and transcribe a walk clip first.";
    const items = sn ? noteItems(sn) : [];
    const blocks = sn ? [...arr(sn.rooms).map((r) => roomBlock(r, items)), roomBlock(sn.jobWide || { room: "" }, items)].filter(Boolean) : [];
    // "Not in estimate": accepted instructions/trades the current estimate has no line for
    let missBlock = null;
    if (sn && arr(inv && inv.items).some((li) => li && String(li.desc || "").trim())) {
      const miss = missingLines(sn, inv.items);
      if (miss.length) {
        const file = h("button", { type: "button", class: "btn btn--ghost btn--sm", style: "width:auto" }, "File for office review");
        file.addEventListener("click", () => fileNow(file));
        missBlock = h("div", { style: "margin-top:8px;padding:8px 10px;border-radius:8px;background:#fdecec;border:1px solid #e8a0a0;font-size:13px" },
          h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, h("strong", {}, `Not in estimate (${miss.length})`),
            h("span", { class: "subtle", style: "font-size:12px;flex:1" }, missing && !missing.error ? "filed for office review" : "accepted on the walk, no matching line in the draft"), file),
          ...miss.map((it) => h("div", { style: "margin-top:3px" }, `• ${it.trade ? it.trade + ": " : ""}${it.text} `, h("span", { class: "subtle" }, `[${cite(it)}]`))));
      }
    }
    root.replaceChildren(...[
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px" },
        h("div", { style: "font-weight:600;font-size:13px;color:#16395a;flex:1" }, "🗒️ Scope notes"), status, go),
      sn ? h("div", { class: "subtle", style: "font-size:12px;margin:0 0 4px" }, "Amber until you keep it. ✓ keep · ✎ edit · ✕ drop · ▶ plays the clip at that second. The draft follows what you keep; the transcript stays evidence.") : null,
      player,
      ...blocks,
      missBlock,
    ].filter(Boolean));
  }

  paint();
  root.refresh = paint;
  return root;
}
