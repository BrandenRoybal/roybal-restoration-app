/* ============================================================
   Roybal — 💬 Ask the office (conversational field assistant)
   ------------------------------------------------------------
   A bottom-sheet chat that floats over every job page, so a tech
   can ask a restoration question mid-form — by voice, text, or
   photo — and slide right back into data entry. Answers come from
   the fieldAssist edge action: short, actionable, IICRC-citing,
   aware of THIS job's category/class/readings/equipment.

   Conversations are per-job and in-memory only (cleared on app
   reload) — they are working chatter, not job documentation.
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

const sessions = new Map();   // projectId -> [{ role, text, images? }]
let ui = null;                // singleton { fab, drawer, msgs, input, ... }
let project = null;
let pendingImages = [];       // photos attached to the next message
let recorder = null, stream = null, chunks = [];

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

const transcript = () => {
  if (!sessions.has(project.id)) sessions.set(project.id, []);
  return sessions.get(project.id);
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
  if (!ui || !project) return;
  const list = transcript();
  ui.msgs.replaceChildren(
    list.length ? h("span") : h("div", { class: "amsg amsg--ai" },
      h("div", { class: "amsg__text" },
        (project && jobType(project) === "construction"
          ? "Hey — what's the question? I can see this job's scope, sub schedule, inspections, selections, and draws. "
          : "Hey — what's the question? I can see this job's readings, category, and equipment. ") +
        "Talk to me with the mic, type, or send a photo of what you're looking at.")),
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
    const b = await fieldAssist(project, {
      messages: prior,
      text: audio ? "" : text,
      images,
      audio, audioMime,
      speak: wantSpeech,
      context: assistContext(project),
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
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
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
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const mime = recorder.mimeType || picked || "audio/mp4";
    recorder = null;
    ui.mic.classList.remove("rec"); ui.mic.textContent = "🎙️";
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) return toast("Didn't catch any audio — check the mic permission and try again.");
    if (blob.size < 2000) return toast("That was too quick — hold the mic open a beat longer.");
    ask({ audio: await blobToBase64(blob), audioMime: mime });
  };
  // timeslice: iOS Safari can return an empty blob when data is only requested
  // at stop — chunked delivery every 250ms makes recordings reliable
  recorder.start(250);
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
  const mic = h("button", { type: "button", class: "assist__btn" }, "🎙️");
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
    handsFree = !handsFree;
    hf.classList.toggle("on", handsFree);
    if (handsFree) {
      unlockAudio();
      if (!speakerOn) spk.click();
      toast("Hands-free on — talk, listen, talk again. Tap 🎧 to stop.");
      if (!recorder) toggleMic();
    } else { stopSpeaking(); if (recorder) try { recorder.stop(); } catch (_) {} }
  });
  const speaking = h("div", { class: "assist__speaking", hidden: true }, "🔊 speaking — tap 🎙️ to jump in");
  const drawer = h("div", { class: "assist app-only", hidden: true },
    h("div", { class: "assist__head" },
      h("div", {},
        h("strong", {}, "💬 Ask the office"),
        h("div", { class: "assist__sub" }, "Job-aware AI colleague · cites IICRC standards · verify anything safety-critical")),
      h("div", { class: "assist__headbtns" }, hf, spk, close)),
    msgs, thinking, speaking, attach,
    h("div", { class: "assist__row" }, cam, mic, input, send),
    file);
  close.addEventListener("click", () => {
    drawer.hidden = true;
    stopSpeaking();
    if (handsFree) { handsFree = false; hf.classList.remove("on"); }
    if (recorder) try { recorder.stop(); } catch (_) {}
  });
  fab.addEventListener("click", () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) { paintMessages(); setTimeout(() => input.focus(), 50); } });

  fab.addEventListener("click", unlockAudio);
  send.addEventListener("click", unlockAudio);
  document.body.append(fab, drawer);
  ui = { fab, drawer, msgs, thinking, attach, input, send, mic, cam, speaking };
}

/** Called by the router: show the assistant on job pages, hide elsewhere. */
export function mountAssist(p) {
  if (!p) { if (ui) { ui.fab.hidden = true; ui.drawer.hidden = true; } project = null; return; }
  if (!ui) buildUi();
  const switched = !project || project.id !== p.id;
  project = p;
  ui.fab.hidden = false;
  if (switched) { ui.drawer.hidden = true; pendingImages = []; paintPending(); }
}
