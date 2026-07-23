/* ============================================================
   Roybal — 💬 Ask the office (conversational assistant, shared)
   ------------------------------------------------------------
   A bottom-sheet chat that floats over the page — voice, text, or
   photo in; short colleague answers out (fieldAssist edge action).

   Shared across the field app, Job Board, and Office Admin via the
   PROVIDER seam: mountAssistProvider({ key, app, title, sub,
   greeting(), buildContext(), project?, capturedBy?() }) supplies
   everything app-specific — the session key, the persona routing
   key sent to the server, and the context digest. mountAssist(p)
   is the field app's wrapper (unchanged external contract).

   Conversations are per-provider-key and in-memory only (cleared
   on app reload) — working chatter, not job documentation.
   Online-only, same spend cap + ai_usage ledger as all AI.

   Phase 5 — proposed actions (chips, not autonomy): a reply can
   carry proposedActions[]; each renders as a tap-to-confirm chip
   and NOTHING executes without the tap. Execution is delegated to
   the provider's executeAction(action) → { ok, detail, message?,
   followup? } so each app runs its own guarded paths (sms.js /
   guardedJobWrite / portal.js). Executions patch the originating
   capture_event (result.executed — the audit trail) and ride the
   next turn as actionResults so the model knows what really ran.
   ============================================================ */
import { h, toast, fileToDataURL, Store } from "./core.js";
import { narrativeFacts, constructionFacts } from "./narrative.js";
import { jobType } from "./model.js";
import { aiAvailable, fieldAssist } from "./officeai.js";
import { rest } from "./supa.js";
import { normalizePhone, smsHref, logSms, companySendEnabled, sendViaCompany } from "./sms.js";
import { capturedBy } from "./tech.js";
import { getUnifiedJobId } from "./spine.js";

/* Construction jobs get the construction digest (scope, schedule, inspections,
   selections, draws); water jobs keep the mitigation digest. */
const assistFacts = (p) => (jobType(p) === "construction" ? constructionFacts(p) : narrativeFacts(p));

/* Open follow-ups from the AI drafts (rebuild estimator questions, timeline
   assumptions awaiting review) — surfaced to the assistant so the tech can
   talk them through; the answers themselves are recorded on the job home
   questionnaires. */
function openFollowups(p) {
  const out = [];
  const rd = p.rebuildDraft;
  if (rd && rd.status === "draft" && rd.draft && Array.isArray(rd.draft.questions)) {
    const from = typeof rd.qIndex === "number" ? rd.qIndex : 0;
    out.push(...rd.draft.questions.slice(from).filter(Boolean)
      .map((q) => ({ type: "rebuild estimator question (answer it on the job home)", q })));
  }
  const bp = p.boardPlan;
  if (bp && bp.status !== "dismissed" && Array.isArray(bp.assumptions)) {
    const from = typeof bp.qIndex === "number" ? bp.qIndex : 0;
    out.push(...bp.assumptions.slice(from).filter(Boolean)
      .map((q) => ({ type: "timeline assumption awaiting confirmation (review it on the job home)", q })));
  }
  return out.slice(0, 12);
}
function assistContext(p) {
  const ctx = assistFacts(p);
  const open = openFollowups(p);
  return open.length ? { ...ctx, openEstimatorFollowups: open } : ctx;
}

const sessions = new Map();   // provider.key -> [{ role, text, images?, actions?, evId? }]
let ui = null;                // singleton { fab, drawer, msgs, input, ... }
let provider = null;          // the active app-specific provider
let pendingImages = [];       // photos attached to the next message
let recorder = null, stream = null, chunks = [];

/* ---------- proposed-action chips (Phase 5) ----------
   Chip results wait per provider key and ride the NEXT ask as
   actionResults — the model learns what the user actually ran. */
const pendingResults = new Map();  // provider.key -> [{ type, label, ok, detail }]
function queueResult(key, r) {
  if (!pendingResults.has(key)) pendingResults.set(key, []);
  const q = pendingResults.get(key);
  q.push(r);
  if (q.length > 6) q.splice(0, q.length - 6);
}

const ACTION_ICONS = {
  sendText: "💬", moveJob: "📅", logHours: "⏱️", adjusterEmail: "✉️", portalReply: "🧡", portalPost: "📨",
  boardWrite: "📋", jobCreate: "➕", crewAvailabilityWrite: "🏖️", crewSwap: "🔄", hoursWrite: "⏱️",
  estimateWrite: "🧮", invoiceCreate: "🧾", invoiceStatusUpdate: "💵", changeOrderWrite: "🔁", receiptLog: "🛒",
};
function actionPreview(a) {
  const p = a.params || {};
  switch (a.type) {
    case "sendText": return (p.to ? "to " + p.to + " — " : "") + "“" + String(p.message || "") + "”";
    case "moveJob": return String(p.job || "?") + " → starts " + String(p.newStart || "?");
    case "boardWrite": {
      const parts = [];
      if (p.stage) parts.push("stage → " + p.stage);
      if (p.startDate) parts.push("starts " + p.startDate);
      if (p.targetDate) parts.push("target " + p.targetDate);
      if (Array.isArray(p.assignedCrew)) parts.push("crew → " + (p.assignedCrew.join(", ") || "nobody"));
      if (p.materialStatus) parts.push("materials → " + p.materialStatus);
      if (p.notes) parts.push("adds a note");
      return String(p.job || "?") + ": " + (parts.join(", ") || "no changes");
    }
    case "jobCreate":
      return "new " + String(p.lossType || "job") + " — " + String(p.insured || "?") + ", " + String(p.address || "?") +
        (p.startDate ? " (starts " + p.startDate + ")" : "");
    case "crewAvailabilityWrite":
      return String(p.crewMember || p.crew || "?") + (p.available ? " back " : " out ") + String(p.startDate || "?") +
        (p.endDate && p.endDate !== p.startDate ? " → " + p.endDate : "") + (p.reason ? " (" + String(p.reason) + ")" : "");
    case "crewSwap":
      return (Array.isArray(p.crewMembers) ? p.crewMembers.join(", ") : "?") + ": " + String(p.fromJob || "?") +
        " → " + String(p.toJob || "?") + " on " + String(p.date || "?");
    case "hoursWrite":
    case "logHours":
      return (p.hours != null ? p.hours + "h — " : "") + String(p.crewMember || p.crew || "?") + " on " + String(p.job || "?") +
        (p.date ? " (" + p.date + ")" : "") + (p.trade ? " · " + p.trade : "");
    case "estimateWrite":
      return (p.estimateId ? "updates " + p.estimateId : "new estimate") + " on " + String(p.job || "?") +
        (Array.isArray(p.lineItems) ? " — " + p.lineItems.length + " line item" + (p.lineItems.length === 1 ? "" : "s") : "") +
        (p.status ? " (" + p.status + ")" : "");
    case "invoiceCreate":
      return "invoice from " + String(p.estimateId || "?") + " on " + String(p.job || "?") +
        " — billed to " + String(p.billedTo || "?") + (p.dueDate ? ", due " + p.dueDate : "");
    case "invoiceStatusUpdate":
      return String(p.invoiceId || "?") + " → " + String(p.status || "?").replace("_", " ") +
        (p.amountReceived != null && p.amountReceived !== "" ? " ($" + p.amountReceived + " received)" : "");
    case "changeOrderWrite":
      return (p.changeOrderId ? "updates " + p.changeOrderId : "new change order") + " on " + String(p.job || "?") +
        (p.costDelta != null ? " — " + (Number(p.costDelta) >= 0 ? "+$" : "−$") + Math.abs(Number(p.costDelta) || 0) : "") +
        (p.reason ? " (" + String(p.reason).slice(0, 40) + ")" : "");
    case "receiptLog":
      return "$" + String(p.amount ?? "?") + " — " + String(p.vendor || "?") + " on " + String(p.job || "?") +
        (p.category ? " (" + p.category + ")" : "");
    case "adjusterEmail": return "drafts the adjuster email for " + String(p.job || "?");
    case "portalReply": return "drafts a " + (p.mode === "status" ? "status update" : "reply") + " for " + String(p.job || "?") + "’s portal";
    case "portalPost": return "“" + String(p.message || "").slice(0, 160) + "”";
    default: return "";
  }
}
const actionStateText = (a) =>
  a.state === "running" ? "…working" :
  a.state === "done" ? "✓ " + (a.detail || "done") :
  a.state === "failed" ? "✗ " + (a.detail || "didn't run") + " — tap to retry" : "tap to confirm";

function runAction(entry, a) {
  if (a.state === "running" || a.state === "done") return;
  if (!provider || typeof provider.executeAction !== "function")
    return toast("This app can't run that action.");
  const key = provider.key;
  a.state = "running"; paintMessages();
  // call synchronously: the field Path-1 sms: link must fire inside the
  // tap's synchronous window (iOS) — async executors just return a promise
  let out;
  try { out = provider.executeAction(a); }
  catch (e) { out = { ok: false, detail: String((e && e.message) || e).slice(0, 140) }; }
  Promise.resolve(out).then(
    (r) => settleAction(key, entry, a, r && typeof r === "object" ? r : { ok: false, detail: "didn't run" }),
    (e) => settleAction(key, entry, a, { ok: false, detail: String((e && e.message) || e).slice(0, 140) }));
}
function settleAction(key, entry, a, r) {
  a.state = r.ok ? "done" : "failed";
  a.detail = String(r.detail || "").slice(0, 140);
  queueResult(key, { type: a.type, label: a.label, ok: !!r.ok, detail: a.detail });
  auditExecution(entry, a, r);
  // long results (drafted emails / portal messages) land as their own
  // assistant bubble, optionally carrying a follow-up chip (review → post)
  if (r.message && sessions.has(key)) {
    sessions.get(key).push({
      role: "assistant", text: r.message,
      ...(r.followup ? { actions: [{ ...r.followup, state: "" }], evId: entry.evId } : {}),
    });
  }
  if (provider && provider.key === key) { paintMessages(); noteReply(); }
}
/* audit trail: stamp the originating capture_event with what actually ran —
   AI-proposed + human-confirmed stays reconstructable. Best-effort. */
async function auditExecution(entry, a, r) {
  if (!entry.evId) return;
  try {
    const g = await rest(`capture_events?id=eq.${entry.evId}&select=result`, { method: "GET" });
    if (!g.ok) return;
    const cur = ((await g.json())[0] || {}).result || {};
    const executed = Array.isArray(cur.executed) ? cur.executed : [];
    executed.push({ type: a.type, label: a.label, ok: !!r.ok, detail: String(r.detail || "").slice(0, 140), at: new Date().toISOString() });
    await rest(`capture_events?id=eq.${entry.evId}`, {
      method: "PATCH", body: JSON.stringify({ result: { ...cur, executed } }),
    });
  } catch (_) { /* the audit stamp is best-effort — never blocks the chip */ }
}

/* The field app's executor — sendText only (form write-backs stay on the
   voice-capture chip path). Company lane when enabled, Messages fallback;
   quiet_hours failures NEVER fall back to the device link — that would
   sidestep the server's guard the user just hit. */
function runFieldAction(project, a) {
  if (a.type !== "sendText") return { ok: false, detail: "not available in the field app" };
  const p = a.params || {};
  const to = normalizePhone(p.to);
  const message = String(p.message || "").trim();
  if (!to || !message) return { ok: false, detail: "missing a phone number or message" };
  const kind = p.audience === "crew" ? "assistCrew" : "assist";
  const entry = logSms(project, { kind, to, body: message, by: capturedBy() });
  Store.put(project);
  if (!companySendEnabled()) {
    location.href = smsHref(to, message);            // synchronous in the tap window
    return { ok: true, detail: "opened Messages — review and hit send" };
  }
  return sendViaCompany({ to, body: message, kind, by: capturedBy(), unifiedJobId: getUnifiedJobId(project.id) })
    .then((r) => {
      entry.via = "company"; entry.status = r.status || "sent"; entry.sid = r.sid || "";
      Store.put(project);
      return { ok: true, detail: "sent from the company number" };
    })
    .catch((e) => {
      const msg = String((e && e.message) || e).slice(0, 140);
      entry.via = "device"; entry.error = msg;
      Store.put(project);
      if (/quiet_hours/.test(msg)) return { ok: false, detail: msg };
      location.href = smsHref(to, message);          // best-effort fallback
      return { ok: true, detail: "company send failed — opened Messages instead (review and send)" };
    });
}

/* The field app's provider — job-scoped, digest from narrative.js. */
function fieldProvider(p) {
  return {
    key: p.id,
    app: "field",
    project: p,
    title: "💬 Ask the office",
    sub: "Job-aware AI colleague · cites IICRC standards · verify anything safety-critical",
    greeting: () =>
      (jobType(p) === "construction"
        ? "Hey — what's the question? I can see this job's scope, sub schedule, inspections, selections, and draws. "
        : "Hey — what's the question? I can see this job's readings, category, and equipment. ") +
      "Talk to me with the mic, type, or send a photo of what you're looking at.",
    buildContext: () => assistContext(p),
    executeAction: (a) => runFieldAction(p, a),
  };
}

/* ---------- window state: name, float position, minimize ----------
   The panel started life as a phone bottom-sheet; on the board/admin
   desktops it also needs to get OUT of the way — drag the header to
   float it anywhere (drop it back at the bottom edge to re-dock),
   minimize it to a title bar that keeps the conversation (and
   hands-free) alive while you navigate, and tap the title to name
   the assistant. The name rides the context digest, so the model
   actually answers to it. */
const NAME_KEY = "roybal-assist-name";
const POS_KEY = "roybal-assist-pos";
const assistName = () => (localStorage.getItem(NAME_KEY) || "").trim().slice(0, 24);

function applyTitle() {
  if (!ui || !provider) return;
  const name = assistName();
  ui.title.textContent = name ? "💬 " + name : (provider.title || "💬 Ask the office");
  ui.sub.textContent = provider.sub || "";
}

const isMin = () => !!ui && ui.drawer.classList.contains("assist--min");
function setMin(on) {
  if (!ui || on === isMin()) return;
  ui.drawer.classList.toggle("assist--min", on);
  ui.minb.textContent = on ? "❐" : "—";
  ui.minb.title = on ? "Restore the conversation" : "Minimize — keeps the chat going while you use the app";
  if (!on) { ui.dot.hidden = true; paintMessages(); }
  clampFloat();
}
/* a reply that lands while minimized lights a dot on the title bar */
function noteReply() {
  if (ui && !ui.drawer.hidden && isMin()) ui.dot.hidden = false;
}

function placeFloat(l, t) {
  const d = ui.drawer, r = d.getBoundingClientRect();
  l = Math.max(8, Math.min(l, window.innerWidth - r.width - 8));
  t = Math.max(8, Math.min(t, window.innerHeight - 72));   // the header stays reachable
  d.style.left = l + "px";
  d.style.top = t + "px";
  d.style.maxHeight = Math.max(140, window.innerHeight - t - 12) + "px";
}
function clampFloat() {
  if (!ui || ui.drawer.hidden || !ui.drawer.classList.contains("assist--float")) return;
  const r = ui.drawer.getBoundingClientRect();
  placeFloat(r.left, r.top);
}
function dockDrawer() {
  const d = ui.drawer;
  d.classList.remove("assist--float");
  d.style.left = d.style.top = d.style.maxHeight = "";
  try { localStorage.removeItem(POS_KEY); } catch (_) {}
}
function restoreFloat() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch (_) {}
  if (!p || typeof p.l !== "number" || typeof p.t !== "number") return;
  ui.drawer.classList.add("assist--float");
  ui.drawer.style.left = p.l + "px";
  ui.drawer.style.top = p.t + "px";
}

/* ---------- voice agent (spoken replies + hands-free loop) ---------- */
const SPEAK_KEY = "roybal-assist-speak";
let speakerOn = localStorage.getItem(SPEAK_KEY) !== "0";   // default: talk back
let handsFree = false;                                     // 🎧 continuous conversation
let audioEl = null, audioUnlocked = false;

/* iOS only lets audio start from a user gesture — unlock one reusable
   element on the first tap, then later replies can play through it. */
function unlockAudio() {
  if (audioUnlocked) return;
  audioEl = audioEl || new Audio();
  audioEl.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  audioEl.play().then(() => { audioEl.pause(); audioUnlocked = true; }).catch(() => {});
}
function stopSpeaking() {
  if (audioEl) { try { audioEl.pause(); } catch (_) {} }
  if ("speechSynthesis" in window) try { speechSynthesis.cancel(); } catch (_) {}
}
function speak(b64Mp3, fallbackText, onDone) {
  const done = () => { if (onDone) onDone(); };
  if (b64Mp3 && audioEl) {
    audioEl.onended = done;
    audioEl.src = "data:audio/mp3;base64," + b64Mp3;
    audioEl.play().catch(() => { speakFallback(fallbackText, done); });
    return;
  }
  speakFallback(fallbackText, done);
}
function speakFallback(text, done) {
  if (!("speechSynthesis" in window) || !text) return done();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, ""));
  u.rate = 1.04; u.onend = done; u.onerror = done;
  try { speechSynthesis.speak(u); } catch (_) { done(); }
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onloadend = () => res(String(r.result || "").split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/* ---------- earcons — tiny WebAudio cues so hands-free is usable without
   looking at the screen: rising chirp = listening, falling blip = sent. */
let earCtx = null;
function earcon(kind) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    earCtx = earCtx || new Ctx();
    if (earCtx.state === "suspended") earCtx.resume();
    const o = earCtx.createOscillator(), g = earCtx.createGain();
    o.connect(g); g.connect(earCtx.destination);
    const t = earCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.frequency.setValueAtTime(kind === "listen" ? 620 : 520, t);
    o.frequency.exponentialRampToValueAtTime(kind === "listen" ? 880 : 392, t + 0.14);
    o.start(t); o.stop(t + 0.18);
  } catch (_) { /* cues are best-effort */ }
}

/* ---------- VAD auto-endpointing (hands-free only) ----------
   Watches the mic's RMS level; once the tech has spoken and then goes
   ~0.8s quiet, the recording stops itself — no glove-tap needed to send.
   If nothing is said for 8s the mic closes and hands-free pauses instead
   of looping "too quick" errors. Tap-to-stop always still works. */
let vad = null;
function startVad() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !stream) return;
    const ctx = new Ctx();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const t0 = Date.now();
    let spoke = false, lastVoice = 0;
    const timer = setInterval(() => {
      if (!recorder) return stopVad();
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > 0.03) { spoke = true; lastVoice = now; }
      if ((spoke && now - lastVoice > 800) || (!spoke && now - t0 > 8000)) {
        stopVad();
        try { recorder.stop(); } catch (_) {}
      }
    }, 100);
    vad = { ctx, timer };
  } catch (_) { /* VAD is best-effort — tap-to-stop always works */ }
}
function stopVad() {
  if (!vad) return;
  clearInterval(vad.timer);
  try { vad.ctx.close(); } catch (_) {}
  vad = null;
}
function setHandsFree(on) {
  handsFree = on;
  if (ui) ui.hf.classList.toggle("on", on);
}

const transcript = () => {
  if (!sessions.has(provider.key)) sessions.set(provider.key, []);
  return sessions.get(provider.key);
};

/* ---------- rendering ---------- */
function bubble(m) {
  const b = h("div", { class: "amsg amsg--" + (m.role === "user" ? "user" : "ai") });
  if (m.images && m.images.length) {
    b.append(h("div", { class: "amsg__imgs" }, ...m.images.map((src) => h("img", { src, alt: "" }))));
  }
  if (m.text) b.append(h("div", { class: "amsg__text" }, m.text));
  if (m.actions && m.actions.length) {
    b.append(h("div", { class: "amsg__acts" }, ...m.actions.map((a) => {
      const btn = h("button", { type: "button", class: "actchip" + (a.state ? " actchip--" + a.state : "") },
        h("span", { class: "actchip__label" }, (ACTION_ICONS[a.type] || "⚡") + " " + (a.label || a.type)),
        h("span", { class: "actchip__preview" }, actionPreview(a)),
        h("span", { class: "actchip__state" }, actionStateText(a)));
      btn.disabled = a.state === "running" || a.state === "done";
      btn.addEventListener("click", () => runAction(m, a));
      return btn;
    })));
  }
  return b;
}
function paintMessages() {
  if (!ui || !provider) return;
  const list = transcript();
  ui.msgs.replaceChildren(
    list.length ? h("span") : h("div", { class: "amsg amsg--ai" },
      h("div", { class: "amsg__text" }, provider.greeting())),
    ...list.map(bubble));
  ui.msgs.scrollTop = ui.msgs.scrollHeight;
}
function paintPending() {
  ui.attach.replaceChildren(...pendingImages.map((src, i) => {
    const x = h("button", { type: "button", class: "achip__x" }, "✕");
    x.addEventListener("click", () => { pendingImages.splice(i, 1); paintPending(); });
    return h("span", { class: "achip" }, h("img", { src, alt: "" }), x);
  }));
}
function busy(on) {
  ui.send.disabled = on; ui.mic.disabled = on; ui.cam.disabled = on;
  ui.thinking.hidden = !on;
  if (on) ui.msgs.scrollTop = ui.msgs.scrollHeight;
}

/* ---------- asking ---------- */
async function ask({ text = "", audio = null, audioMime = "" }) {
  if (!aiAvailable()) return;
  const images = pendingImages.slice();
  pendingImages = []; paintPending();
  const list = transcript();
  // voice: the user bubble appears once the server returns the transcript
  if (!audio) { list.push({ role: "user", text, images }); paintMessages(); }
  busy(true);
  // chip results queued since the last turn ride out with this one; on a
  // failed ask they re-queue so the feedback isn't lost
  const chipResults = (pendingResults.get(provider.key) || []).splice(0);
  try {
    // the server appends the final user turn itself (from text/audio+images),
    // so prior turns exclude the message we just painted for a text ask
    const prior = (audio ? list : list.slice(0, -1)).slice(-12)
      .map((m) => ({ role: m.role, text: m.text || "" }));
    const wantSpeech = speakerOn && (!!audio || handsFree);
    // the custom name rides the digest so the model answers to it
    const name = assistName();
    const baseCtx = await provider.buildContext();
    const context = name && baseCtx && typeof baseCtx === "object" && !Array.isArray(baseCtx)
      ? { assistantName: name, ...baseCtx } : baseCtx;
    const b = await fieldAssist(provider.project || null, {
      messages: prior,
      text: audio ? "" : text,
      images,
      audio, audioMime,
      speak: wantSpeech,
      app: provider.app,
      // await tolerates sync providers too — admin builds its digest async
      // (IndexedDB + portal/QBO lookups), field/board return plain objects
      context,
      ...(chipResults.length ? { actionResults: chipResults } : {}),
      ...(provider.capturedBy ? { captured_by: provider.capturedBy() } : {}),
    });
    if (audio && b.transcript) list.push({ role: "user", text: b.transcript, images });
    const reply = b.reply || "…I didn't get an answer back. Try again?";
    const entry = { role: "assistant", text: reply };
    // proposed actions → confirm chips (only when this provider can run them)
    if (Array.isArray(b.proposedActions) && b.proposedActions.length &&
        typeof provider.executeAction === "function") {
      entry.actions = b.proposedActions.map((a) => ({ ...a, state: "" }));
      entry.evId = b.capture_event_id || null;
    }
    list.push(entry);
    paintMessages();
    noteReply();
    if (wantSpeech) {
      ui.speaking.hidden = false;
      speak(b.replyAudio, reply, () => {
        ui.speaking.hidden = true;
        // 🎧 hands-free: the mic re-arms once the answer finishes, like a call
        if (handsFree && !ui.drawer.hidden) toggleMic();
      });
    }
  } catch (e) {
    chipResults.forEach((r) => queueResult(provider.key, r));   // feedback survives the retry
    toast((e && e.message) || "Couldn't reach the assistant — try again.");
    paintMessages();
  }
  busy(false);
}

/* ---------- voice ---------- */
async function toggleMic() {
  unlockAudio();
  stopSpeaking();
  if (recorder) {  // stop → send
    try { recorder.stop(); } catch (_) {}
    return;
  }
  if (!aiAvailable()) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return toast("This device can't record audio — type your question.");
  // truck-cab audio: cancel the speaker's own TTS echo, suppress engine/fan
  // noise, and auto-level a voice that's an arm's length from the phone
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  catch (err) {
    const name = (err && err.name) || "";
    return toast(name === "NotAllowedError"
      ? "Microphone blocked — on iPhone: Settings → Safari → Microphone → Allow, then reopen the app."
      : "Couldn't open the microphone (" + (name || "unknown") + ") — type your question instead.");
  }
  chunks = [];
  // iPhones record audio/mp4 (not webm) — pick whatever this device supports
  const preferred = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  const picked = (typeof MediaRecorder.isTypeSupported === "function"
    ? preferred.find((t) => MediaRecorder.isTypeSupported(t)) : "") || "";
  try { recorder = picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream); }
  catch { recorder = new MediaRecorder(stream); }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stopVad();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const mime = recorder.mimeType || picked || "audio/mp4";
    recorder = null;
    ui.mic.classList.remove("rec"); ui.mic.textContent = "🎙️";
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size || blob.size < 2000) {
      // hands-free: a silent open mic (VAD timeout or a stray tap) must not
      // loop error toasts while the phone sits in a pocket — pause instead
      if (handsFree) { setHandsFree(false); return toast("Didn't hear anything — hands-free paused. Tap 🎧 to talk again."); }
      return toast(!blob.size
        ? "Didn't catch any audio — check the mic permission and try again."
        : "That was too quick — hold the mic open a beat longer.");
    }
    earcon("done");
    ask({ audio: await blobToBase64(blob), audioMime: mime });
  };
  // timeslice: iOS Safari can return an empty blob when data is only requested
  // at stop — chunked delivery every 250ms makes recordings reliable
  recorder.start(250);
  earcon("listen");
  // hands-free: the recording ends itself ~0.8s after the tech stops talking
  if (handsFree) startVad();
  ui.mic.classList.add("rec"); ui.mic.textContent = "⏹";
}

/* ---------- UI ---------- */
function buildUi() {
  const fab = h("button", { type: "button", class: "assist-fab app-only", title: "Ask the office (AI)" }, "💬");
  const msgs = h("div", { class: "assist__msgs" });
  const thinking = h("div", { class: "amsg amsg--ai", hidden: true }, h("div", { class: "amsg__text athinking" }, "…"));
  const attach = h("div", { class: "assist__attach" });

  const input = h("input", { class: "assist__input", placeholder: "Ask anything — e.g. “drywall wicked 3 feet, cut 2 or 4?”", enterkeyhint: "send" });
  const send = h("button", { type: "button", class: "assist__btn assist__btn--send" }, "➤");
  // the mic is the one button pressed with wet gloves in a truck cab — 64px
  const mic = h("button", { type: "button", class: "assist__btn assist__btn--mic" }, "🎙️");
  const cam = h("button", { type: "button", class: "assist__btn" }, "📷");
  const file = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" });

  const submit = () => {
    const t = input.value.trim();
    if (!t && !pendingImages.length) return;
    input.value = "";
    ask({ text: t });
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  mic.addEventListener("click", toggleMic);
  cam.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    for (const f of file.files) pendingImages.push(await fileToDataURL(f));
    file.value = ""; paintPending();
  });

  const close = h("button", { type: "button", class: "assist__close" }, "✕");
  const spk = h("button", { type: "button", class: "assist__mini" + (speakerOn ? " on" : "") }, speakerOn ? "🔊" : "🔇");
  spk.title = "Spoken replies on/off";
  spk.addEventListener("click", () => {
    speakerOn = !speakerOn;
    localStorage.setItem(SPEAK_KEY, speakerOn ? "1" : "0");
    spk.textContent = speakerOn ? "🔊" : "🔇";
    spk.classList.toggle("on", speakerOn);
    if (!speakerOn) { stopSpeaking(); if (handsFree) hf.click(); }
  });
  const hf = h("button", { type: "button", class: "assist__mini" }, "🎧");
  hf.title = "Hands-free conversation — it talks back and re-opens the mic";
  hf.addEventListener("click", () => {
    setHandsFree(!handsFree);
    if (handsFree) {
      unlockAudio();
      if (!speakerOn) spk.click();
      toast("Hands-free on — just talk; it sends itself when you pause. Tap 🎧 to stop.");
      if (!recorder) toggleMic();
    } else { stopSpeaking(); if (recorder) try { recorder.stop(); } catch (_) {} }
  });
  const speaking = h("div", { class: "assist__speaking", hidden: true }, "🔊 speaking — tap 🎙️ to jump in");
  const minb = h("button", { type: "button", class: "assist__mini",
    title: "Minimize — keeps the chat going while you use the app" }, "—");
  const title = h("strong", { class: "assist__title", title: "Tap to name your assistant" }, "💬 Ask the office");
  const dot = h("span", { class: "assist__dot", hidden: true });
  const sub = h("div", { class: "assist__sub" }, "");
  const head = h("div", { class: "assist__head", title: "Drag to move — drop at the bottom edge to re-dock" },
    h("div", {}, title, dot, sub),
    h("div", { class: "assist__headbtns" }, hf, spk, minb, close));
  const drawer = h("div", { class: "assist app-only", hidden: true },
    head,
    msgs, thinking, speaking, attach,
    h("div", { class: "assist__row" }, cam, mic, input, send),
    file);
  close.addEventListener("click", () => {
    drawer.hidden = true;
    stopSpeaking();
    if (handsFree) setHandsFree(false);
    if (recorder) try { recorder.stop(); } catch (_) {}
  });
  minb.addEventListener("click", () => setMin(!isMin()));
  fab.addEventListener("click", () => {
    if (drawer.hidden) {
      drawer.hidden = false;
      setMin(false);                       // opening always brings the full window back
      paintMessages();
      requestAnimationFrame(clampFloat);   // a saved float spot may be off a resized screen
      setTimeout(() => input.focus(), 50);
    } else if (isMin()) {
      setMin(false);
      setTimeout(() => input.focus(), 50);
    } else {
      drawer.hidden = true;
    }
  });

  // tap the title to (re)name the assistant — a drag that started on the
  // title must not open the prompt, so drags set a one-shot suppress flag
  let dragged = false;
  title.addEventListener("click", () => {
    if (dragged) return;
    const next = prompt("Name your assistant (leave blank for the default):", assistName());
    if (next === null) return;
    const v = next.trim().slice(0, 24);
    try { v ? localStorage.setItem(NAME_KEY, v) : localStorage.removeItem(NAME_KEY); } catch (_) {}
    applyTitle();
    toast(v ? "Done — say hi to " + v + "." : "Back to the default name.");
  });

  // drag the header to float the window anywhere; drop it near the bottom
  // edge to snap back to the docked bottom-sheet. Buttons still just click.
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || (e.button != null && e.button !== 0)) return;
    dragged = false;
    const r0 = drawer.getBoundingClientRect();
    const ox = e.clientX - r0.left, oy = e.clientY - r0.top;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => {
      if (!dragged && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!dragged) { dragged = true; drawer.classList.add("assist--float", "assist--drag"); }
      placeFloat(ev.clientX - ox, ev.clientY - oy);
      ev.preventDefault();
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      drawer.classList.remove("assist--drag");
      if (!dragged) return;
      if (ev.type === "pointerup" && ev.clientY > window.innerHeight - 48) { dockDrawer(); return; }
      const r = drawer.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top) })); } catch (_) {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  window.addEventListener("resize", clampFloat);

  fab.addEventListener("click", unlockAudio);
  send.addEventListener("click", unlockAudio);
  document.body.append(fab, drawer);
  ui = { fab, drawer, msgs, thinking, attach, input, send, mic, cam, speaking, title, sub, hf, minb, dot };
  restoreFloat();                          // last dragged spot survives reloads
}

/** Mount the assistant with an app-specific provider (board/admin/field).
    Pass null to hide. Switching providers closes the drawer and keeps each
    conversation under its own session key. */
export function mountAssistProvider(p) {
  if (!p) { if (ui) { ui.fab.hidden = true; ui.drawer.hidden = true; } provider = null; return; }
  if (!ui) buildUi();
  const switched = !provider || provider.key !== p.key;
  provider = p;
  applyTitle();                    // the custom name (if set) wins over p.title
  ui.fab.hidden = false;
  if (switched) { ui.drawer.hidden = true; pendingImages = []; paintPending(); }
}

/** Called by the field router: show the assistant on job pages, hide elsewhere. */
export function mountAssist(p) {
  mountAssistProvider(p ? fieldProvider(p) : null);
}
