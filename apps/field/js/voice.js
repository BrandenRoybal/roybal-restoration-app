/* ============================================================
   Roybal Field Forms — Voice capture widget (Step D)
   ------------------------------------------------------------
   The 🎙️ Transcribe button on the four AI forms. Records audio, sends
   it to the roybal-ai-ingest Edge Function (online-only; keys live
   server-side), shows the extracted values as tap-to-confirm CHIPS
   (amber = low confidence), and writes confirmed values into the
   project blob via the same save path the typed forms use.

   OFFLINE-FIRST: this is an enhancement on top of the always-available
   typed form. With no signal it degrades clearly (a toast) — it never
   blocks manual entry. The audio + AI keys never touch the client.
   ============================================================ */
import { h, Store, toast } from "./core.js";
import { SUPABASE_URL, SUPABASE_KEY, SYNC_ENABLED } from "./config.js";
import { isSignedIn, accessToken } from "./supa.js";
import { getUnifiedJobId } from "./spine.js";
import { candidateChips, applyChips, AI_FORM_KEYS } from "./ai.js";
import { capturedBy, hasTech, pickTech } from "./tech.js";
import {
  blankPsychroRow, blankEquipRow, blankReadingRow, blankWorkRow, newPhoto,
} from "./model.js";

const FN_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/roybal-ai-ingest` : "";

/* Fresh blank row/photo factories for the write-back, per form. */
function makeFactories(formKey) {
  return {
    row: (group) => {
      if (formKey === "dryingLogs") return group === "equipment" ? blankEquipRow() : blankPsychroRow();
      if (formKey === "moistureMaps") return blankReadingRow();
      if (formKey === "constructionLogs") return blankWorkRow();
      return {};
    },
    photo: () => newPhoto(),
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("read_failed"));
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
    };
    r.readAsDataURL(blob);
  });
}

/* POST to the Edge Function. Throws on transport/HTTP error; returns parsed body. */
async function ingest({ formKey, project, audioBase64, mime, transcript }) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + accessToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      unified_job_id: getUnifiedJobId(project.id),
      form_key: formKey,
      captured_by: capturedBy(),
      water_category: project.waterCategory || null,
      ...(transcript ? { transcript } : { audio: audioBase64, audio_mime: mime }),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `ingest failed (${res.status})`);
  return body;
}

/* ============================================================
   transcribeWidget({ project, formKey, instance, rerender }) -> DOM node
   Mounted by formEditor for the four AI_FORM_KEYS forms.
   ============================================================ */
export function transcribeWidget({ project, formKey, instance, rerender }) {
  if (!AI_FORM_KEYS.includes(formKey)) return h("div");
  const wrap = h("div", {
    class: "app-only voicecap",
    style: "border:1px dashed var(--navy,#0f1b2d);border-radius:12px;padding:10px 12px;margin:0 0 14px;background:#f7f9fc",
  });
  let recorder = null, chunks = [], stream = null, timer = null, t0 = 0, onLeave = null, busy = false;

  const setBody = (...nodes) => wrap.replaceChildren(...nodes.filter(Boolean));

  /* ---- idle ---- */
  function idle(hint) {
    busy = false;                           // back to a resting state — recording may start again
    const btn = h("button", { type: "button", class: "btn btn--primary btn--sm" }, "🎙️ Transcribe");
    btn.addEventListener("click", start);
    setBody(
      h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
        btn,
        h("span", { class: "subtle", style: "font-size:13px" }, hint || "Speak your log — tap to confirm the values.")));
  }

  /* ---- recording ---- */
  async function start() {
    if (busy) return;                       // re-entrancy guard: ignore a second tap mid-cycle
    if (!SYNC_ENABLED || !FN_URL) return toast("Voice needs the cloud backend configured.");
    if (!isSignedIn()) return toast("Sign in to use voice transcription.");
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      return toast("No connection — voice needs internet. Your typed entries are saved.");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      return toast("This device can't record audio — type your entries.");
    busy = true;                            // set BEFORE the await so a double-tap can't open a 2nd mic
    // First-capture gate: every capture must be attributed to a tech (captured_by).
    if (!hasTech()) {
      const who = await pickTech();
      if (!who) { busy = false; return; }   // cancelled — don't record unattributed
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      busy = false;
      return toast("Microphone blocked — allow mic access or type your entries.");
    }
    try {
      chunks = [];
      // iPhones record audio/mp4 (not webm); chunked delivery (250ms) keeps
      // iOS Safari from returning an empty blob on stop
      const preferred = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
      const picked = (typeof MediaRecorder.isTypeSupported === "function"
        ? preferred.find((t) => MediaRecorder.isTypeSupported(t)) : "") || "";
      recorder = picked ? new MediaRecorder(stream, { mimeType: picked }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = upload;
      recorder.start(250);
    } catch (e) {
      // setup failed after the mic opened — release it rather than leak the track
      teardown(); recorder = null; busy = false;
      return toast("Couldn't start recording — type your entries.");
    }
    t0 = Date.now();

    // If the tech leaves the form mid-recording, release the mic immediately
    // (don't upload — they navigated away). Cleared on normal stop.
    onLeave = () => abortRecording();
    window.addEventListener("hashchange", onLeave, { once: true });

    const time = h("span", { style: "font-variant-numeric:tabular-nums;font-weight:700;color:var(--orange,#f26a21)" }, "0:00");
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 250);
    const stop = h("button", { type: "button", class: "btn btn--danger btn--sm" }, "⏹ Stop");
    stop.addEventListener("click", () => { try { recorder.stop(); } catch (_) {} });
    setBody(
      h("div", { style: "display:flex;align-items:center;gap:10px" },
        h("span", { style: "font-size:18px" }, "🔴"),
        h("span", { style: "font-weight:600" }, "Recording"), time, stop));
  }

  function teardown() {
    clearInterval(timer); timer = null;
    if (onLeave) { window.removeEventListener("hashchange", onLeave); onLeave = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  /* Navigated away mid-recording: release the mic, drop the audio, no upload. */
  function abortRecording() {
    onLeave = null; // the {once:true} listener already fired
    if (recorder) { recorder.onstop = null; try { if (recorder.state !== "inactive") recorder.stop(); } catch (_) {} }
    teardown();
  }

  /* ---- upload + extract ---- */
  async function upload() {
    teardown();
    setBody(h("div", { style: "display:flex;align-items:center;gap:8px;color:var(--muted)" },
      h("span", { class: "spinner" }, "⏳"), h("span", {}, "Transcribing…")));
    try {
      const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || "audio/webm" });
      if (!blob.size) { idle("Didn't catch any audio — try again."); return; }
      const audioBase64 = await blobToBase64(blob);
      const res = await ingest({ formKey, project, audioBase64, mime: blob.type || "audio/webm" });
      if (res.capped) { toast("Monthly AI limit reached — enter values manually."); idle("AI limit reached this month — type your entries."); return; }
      review(res);
    } catch (e) {
      toast("Couldn't transcribe — your typed entries are safe. Try again when you have signal.");
      idle("Transcription failed — tap to retry, or type your entries.");
    }
  }

  /* ---- chip review ---- */
  function review(res) {
    busy = false;                           // chips are up; a re-record is allowed (Discard -> idle)
    const chips = candidateChips(formKey, res.candidates || {});
    if (!chips.length) {
      idle(res.transcript ? "Heard you, but found no fields to fill — try again or type them." : "Nothing to fill — try again.");
      if (res.transcript) toast("Heard: " + res.transcript.slice(0, 80));
      return;
    }
    const rows = chips.map((c) => {
      const box = h("input", { type: "checkbox", checked: true });
      const val = h("input", {
        value: c.value == null ? "" : String(c.value),
        style: "flex:1;min-width:80px;padding:4px 6px;border:1px solid #cdd5df;border-radius:6px",
      });
      box.addEventListener("change", () => { c.confirmed = box.checked; });
      val.addEventListener("input", () => { c.value = val.value; });
      c.confirmed = true;
      const amber = c.tone === "amber";
      return h("label", {
        style: "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;margin:4px 0;background:" +
          (amber ? "#fff4e5" : "#eef6ee") + ";border:1px solid " + (amber ? "#f0b463" : "#bfe0bf"),
      },
        box,
        h("span", { style: "min-width:120px;font-size:13px;font-weight:600;color:var(--navy,#0f1b2d)" },
          (amber ? "⚠️ " : "") + c.label),
        val);
    });

    const apply = h("button", { type: "button", class: "btn btn--primary btn--sm" }, `Add ${chips.length} value${chips.length === 1 ? "" : "s"}`);
    apply.addEventListener("click", async () => {
      const out = applyChips(formKey, instance, project, chips, makeFactories(formKey));
      project.updatedAt = new Date().toISOString();
      await Store.put(project);
      toast(out.applied ? `Added ${out.applied} value${out.applied === 1 ? "" : "s"} — review and save.` : "Nothing selected.");
      if (typeof rerender === "function") rerender();
    });
    const discard = h("button", { type: "button", class: "btn btn--ghost btn--sm" }, "Discard");
    discard.addEventListener("click", () => idle());

    setBody(
      h("div", { style: "font-weight:700;margin-bottom:2px;color:var(--navy,#0f1b2d)" }, "🎙️ Tap to confirm"),
      h("div", { class: "subtle", style: "font-size:12px;margin-bottom:6px" }, "Amber = double-check. Uncheck anything wrong, edit a value, then add."),
      ...rows,
      Array.isArray(res.candidates?.unmapped) && res.candidates.unmapped.length
        ? h("div", { class: "subtle", style: "font-size:12px;margin-top:6px" }, "Also heard: " + res.candidates.unmapped.join("; "))
        : null,
      h("div", { style: "display:flex;gap:8px;margin-top:8px" }, apply, discard));
  }

  idle();
  return wrap;
}
