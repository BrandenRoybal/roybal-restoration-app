/* ============================================================
   Roybal Field Forms — tap-to-dictate mic for any text input
   ------------------------------------------------------------
   Records audio (iOS-safe: audio/mp4 + 250ms chunks), transcribes it
   through the office assistant's Deepgram STT (transcribeOnly — no LLM
   turn, nothing on the token ledger) and hands the text back. Online-
   only like every AI feature: offline it degrades to a toast and typing
   always works.
   ============================================================ */
import { h, toast } from "./core.js";
import { aiAvailable, fieldAssist } from "./officeai.js";

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** 🎙️ button: tap to record, tap again to stop → onText(transcript). */
export function dictateBtn(project, onText, opts = {}) {
  const btn = h("button", {
    type: "button", class: "btn btn--ghost btn--sm dictate",
    style: "width:auto;flex:0 0 auto", title: opts.title || "Dictate your answer",
  }, "🎙️");
  let recorder = null, stream = null, chunks = [];

  btn.addEventListener("click", async () => {
    if (recorder) { try { recorder.stop(); } catch (_) {} return; }   // stop → transcribe
    if (!aiAvailable()) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      return toast("This device can't record audio — type instead.");
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err) {
      const name = (err && err.name) || "";
      return toast(name === "NotAllowedError"
        ? "Microphone blocked — on iPhone: Settings → Safari → Microphone → Allow, then reopen the app."
        : "Couldn't open the microphone (" + (name || "unknown") + ") — type instead.");
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
      btn.classList.remove("rec"); btn.textContent = "🎙️";
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) return toast("Didn't catch any audio — check the mic permission and try again.");
      if (blob.size < 2000) return toast("That was too quick — hold the mic open a beat longer.");
      btn.disabled = true; btn.textContent = "…";
      try {
        const b = await fieldAssist(project, { audio: await blobToBase64(blob), audioMime: mime, transcribeOnly: true });
        const text = String(b.transcript || "").trim();
        if (text) onText(text);
        else toast("Didn't catch that — try again closer to the mic.");
      } catch (e) {
        toast((e && e.message) || "Transcription failed — try again or type it.");
      }
      btn.disabled = false; btn.textContent = "🎙️";
    };
    // timeslice: iOS Safari can return an empty blob when data is only
    // requested at stop — chunked delivery every 250ms keeps it reliable
    recorder.start(250);
    btn.classList.add("rec"); btn.textContent = "⏹";
  });
  return btn;
}
