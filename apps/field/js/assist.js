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
   ============================================================ */
import { h, toast, fileToDataURL } from "./core.js";
import { narrativeFacts, constructionFacts } from "./narrative.js";
import { jobType } from "./model.js";
import { aiAvailable, fieldAssist } from "./officeai.js";

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

const sessions = new Map();   // provider.key -> [{ role, text, images? }]
let ui = null;                // singleton { fab, drawer, msgs, input, ... }
let provider = null;          // the active app-specific provider
let pendingImages = [];       // photos attached to the next message
let recorder = null, stream = null, chunks = [];

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
  };
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
  try {
    // the server appends the final user turn itself (from text/audio+images),
    // so prior turns exclude the message we just painted for a text ask
    const prior = (audio ? list : list.slice(0, -1)).slice(-12)
      .map((m) => ({ role: m.role, text: m.text || "" }));
    const wantSpeech = speakerOn && (!!audio || handsFree);
    const b = await fieldAssist(provider.project || null, {
      messages: prior,
      text: audio ? "" : text,
      images,
      audio, audioMime,
      speak: wantSpeech,
      app: provider.app,
      // await tolerates sync providers too — admin builds its digest async
      // (IndexedDB + portal/QBO lookups), field/board return plain objects
      context: await provider.buildContext(),
      ...(provider.capturedBy ? { captured_by: provider.capturedBy() } : {}),
    });
    if (audio && b.transcript) list.push({ role: "user", text: b.transcript, images });
    const reply = b.reply || "…I didn't get an answer back. Try again?";
    list.push({ role: "assistant", text: reply });
    paintMessages();
    if (wantSpeech) {
      ui.speaking.hidden = false;
      speak(b.replyAudio, reply, () => {
        ui.speaking.hidden = true;
        // 🎧 hands-free: the mic re-arms once the answer finishes, like a call
        if (handsFree && !ui.drawer.hidden) toggleMic();
      });
    }
  } catch (e) {
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
  const title = h("strong", {}, "💬 Ask the office");
  const sub = h("div", { class: "assist__sub" }, "");
  const drawer = h("div", { class: "assist app-only", hidden: true },
    h("div", { class: "assist__head" },
      h("div", {}, title, sub),
      h("div", { class: "assist__headbtns" }, hf, spk, close)),
    msgs, thinking, speaking, attach,
    h("div", { class: "assist__row" }, cam, mic, input, send),
    file);
  close.addEventListener("click", () => {
    drawer.hidden = true;
    stopSpeaking();
    if (handsFree) setHandsFree(false);
    if (recorder) try { recorder.stop(); } catch (_) {}
  });
  fab.addEventListener("click", () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) { paintMessages(); setTimeout(() => input.focus(), 50); } });

  fab.addEventListener("click", unlockAudio);
  send.addEventListener("click", unlockAudio);
  document.body.append(fab, drawer);
  ui = { fab, drawer, msgs, thinking, attach, input, send, mic, cam, speaking, title, sub, hf };
}

/** Mount the assistant with an app-specific provider (board/admin/field).
    Pass null to hide. Switching providers closes the drawer and keeps each
    conversation under its own session key. */
export function mountAssistProvider(p) {
  if (!p) { if (ui) { ui.fab.hidden = true; ui.drawer.hidden = true; } provider = null; return; }
  if (!ui) buildUi();
  const switched = !provider || provider.key !== p.key;
  provider = p;
  ui.title.textContent = p.title || "💬 Ask the office";
  ui.sub.textContent = p.sub || "";
  ui.fab.hidden = false;
  if (switched) { ui.drawer.hidden = true; pendingImages = []; paintPending(); }
}

/** Called by the field router: show the assistant on job pages, hide elsewhere. */
export function mountAssist(p) {
  mountAssistProvider(p ? fieldProvider(p) : null);
}
