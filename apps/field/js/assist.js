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
import { narrativeFacts } from "./narrative.js";
import { aiAvailable, fieldAssist } from "./officeai.js";

const sessions = new Map();   // projectId -> [{ role, text, images? }]
let ui = null;                // singleton { fab, drawer, msgs, input, ... }
let project = null;
let pendingImages = [];       // photos attached to the next message
let recorder = null, stream = null, chunks = [];

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
        "Hey — what's the question? I can see this job's readings, category, and equipment. " +
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
    const b = await fieldAssist(project, {
      messages: prior,
      text: audio ? "" : text,
      images,
      audio, audioMime,
      context: narrativeFacts(project),
    });
    if (audio && b.transcript) list.push({ role: "user", text: b.transcript, images });
    list.push({ role: "assistant", text: b.reply || "…I didn't get an answer back. Try again?" });
    paintMessages();
  } catch (e) {
    toast((e && e.message) || "Couldn't reach the assistant — try again.");
    paintMessages();
  }
  busy(false);
}

/* ---------- voice ---------- */
async function toggleMic() {
  if (recorder) {  // stop → send
    try { recorder.stop(); } catch (_) {}
    return;
  }
  if (!aiAvailable()) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return toast("This device can't record audio — type your question.");
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast("Microphone blocked — allow mic access or type your question."); }
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const mime = recorder.mimeType || "audio/webm";
    recorder = null;
    ui.mic.classList.remove("rec"); ui.mic.textContent = "🎙️";
    if (!blob.size) return toast("Didn't catch any audio — try again.");
    ask({ audio: await blobToBase64(blob), audioMime: mime });
  };
  recorder.start();
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
  const file = h("input", { type: "file", accept: "image/*", capture: "environment", multiple: true, style: "display:none" });

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
  const drawer = h("div", { class: "assist app-only", hidden: true },
    h("div", { class: "assist__head" },
      h("div", {},
        h("strong", {}, "💬 Ask the office"),
        h("div", { class: "assist__sub" }, "Job-aware AI colleague · cites IICRC standards · verify anything safety-critical")),
      close),
    msgs, thinking, attach,
    h("div", { class: "assist__row" }, cam, mic, input, send),
    file);
  close.addEventListener("click", () => { drawer.hidden = true; });
  fab.addEventListener("click", () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) { paintMessages(); setTimeout(() => input.focus(), 50); } });

  document.body.append(fab, drawer);
  ui = { fab, drawer, msgs, thinking, attach, input, send, mic, cam };
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
