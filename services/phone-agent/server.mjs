/* ============================================================
   Roybal phone agent — ConversationRelay WebSocket server
   ------------------------------------------------------------
   The always-on Fly.io half of the phone lane. Twilio terminates
   the call audio and does STT/TTS/barge-in (ConversationRelay);
   this process is pure text: voicePrompt in → streamed tokens out.

   Wire (verified against Twilio's docs):
     in:  {type:"setup", callSid, from, to, customParameters:{token}}
          {type:"prompt", voicePrompt, lang, last}
          {type:"interrupt", utteranceUntilInterrupt, ...}
          {type:"dtmf"|"error", ...}
     out: {type:"text", token, last}          — TTS tokens
          {type:"end", handoffData:"<json>"}  — hand the call back
          (roybal-voice's /action turns the handoff into a live
           <Dial> to the owner, voicemail, or a hangup)

   Envelope + metering (rulebook): capture_events row BEFORE the
   first paid LLM call; on hangup an ai_usage row carries tokens,
   call seconds, and the estimated voice cost, so the phone lane
   rides the same $50 cap — plus its own VOICE_MINUTES_CAP.

   Auth: the shared PHONE_RELAY_TOKEN arrives as a <Parameter> in
   setup — wrong/missing token speaks nothing and hands off to
   voicemail. Transcripts are NOT persisted (working chatter);
   only the lead, the owner text, and the usage row remain.
   ============================================================ */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { PERSONAS, PHONE_TOOLS, PHONE_TOOL_RULE } from "../../supabase/functions/roybal-ai-office/personas.ts";
import { RELAY_TOKEN, OWNER_NAME, PORT, SPEND_CAP_USD, VOICE_MINUTES_CAP, VOICE_PRICE_PER_MIN, PHONE_MODEL, priceFor } from "./config.mjs";
import { signIn, insertRow, patchCaptureEvent, monthSpend, monthPhoneSeconds } from "./supa.mjs";
import { runTurn, probeLLM } from "./brain.mjs";

const TOOLS = Object.values(PHONE_TOOLS);

const systemFor = (session) =>
  PERSONAS.phone + PHONE_TOOL_RULE +
  `\n\nCALL CONTEXT: caller number ${session.from || "unknown"}; the owner is ${OWNER_NAME}; ` +
  `local time ${new Date().toLocaleString("en-US", { timeZone: "America/Anchorage", weekday: "short", hour: "numeric", minute: "2-digit" })} in Fairbanks.`;

function newSession(ws) {
  return {
    ws, from: "", callSid: "", startedAt: Date.now(),
    messages: [], usage: { inTok: 0, outTok: 0 }, turns: 0, toolCalls: 0,
    leadsCreated: 0, textsSent: 0, leadId: null, escalate: null,
    captureEventId: null, abort: null, busy: false, closedOut: false,
    llmFails: 0, pending: "", ended: false,
  };
}

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket already gone */ } };
const say = (ws, text, last = true) => send(ws, { type: "text", token: text, last });
const endWith = (session, reasonCode, reason) => {
  session.ended = true;
  send(session.ws, { type: "end", handoffData: JSON.stringify({ reasonCode, reason: String(reason || "").slice(0, 140) }) });
};

/* caps checked at call start — a capped month greets, apologizes, and
   hands off to voicemail instead of burning tokens */
async function overCap() {
  try {
    const [spend, seconds] = await Promise.all([monthSpend(), monthPhoneSeconds()]);
    if (SPEND_CAP_USD > 0 && spend >= SPEND_CAP_USD) return "monthly AI spend cap";
    if (VOICE_MINUTES_CAP > 0 && seconds / 60 >= VOICE_MINUTES_CAP) return "monthly voice minutes cap";
  } catch { /* cap reads failing must not kill the phone line */ }
  return null;
}

async function onSetup(session, msg) {
  session.from = String(msg.from || "");
  session.callSid = String(msg.callSid || "");
  const token = msg.customParameters && msg.customParameters.token;
  if (!RELAY_TOKEN || token !== RELAY_TOKEN) {
    // loud in the logs — this is a config mismatch, not a caller problem
    console.error("relay token mismatch — PHONE_RELAY_TOKEN differs between Fly and the roybal-voice edge secrets");
    endWith(session, "voicemail", "relay token mismatch");
    return;
  }
  const capped = await overCap();
  if (capped) {
    say(session.ws, "Sorry — our assistant is unavailable right now. Let me get you to voicemail.");
    endWith(session, "voicemail", capped);
    return;
  }
  // envelope BEFORE any paid call (rulebook #2)
  try {
    const ev = await insertRow("capture_events", {
      source_type: "phone_call", form_key: "phoneCall", captured_by: "phone-agent",
      raw_payload: { callSid: session.callSid, from: session.from }, status: "pending",
    });
    session.captureEventId = ev?.id ?? null;
  } catch (e) {
    // no envelope → no paid work; the caller still reaches a human lane
    console.error("envelope insert failed", e.message);
    say(session.ws, "Sorry — I'm having trouble on my end. Let me get you to voicemail.");
    endWith(session, "voicemail", "envelope failed");
    return;
  }
  // anything the caller said while the envelope was in flight (people often
  // talk right over the greeting) was queued, not dropped — answer it now
  if (session.pending && !session.busy) {
    const queued = session.pending; session.pending = "";
    await runOneTurn(session, queued);
  }
}

/* One LLM turn + failure policy. First failure: an honest apology (the
   problem is OUR side, not the caller's audio) and one retry courtesy of
   the pending queue. Second consecutive failure: stop wasting the caller's
   time — hand off to voicemail (the /action handler routes it). Six rounds
   of "could you say that once more?" is how a dead LLM key reads as "the
   agent can't hear me". */
async function runOneTurn(session, text) {
  session.busy = true;
  session.turns++;
  session.abort = new AbortController();
  try {
    await runTurn(session, text, {
      system: systemFor(session), tools: TOOLS,
      onToken: (tok) => say(session.ws, tok, false),
    });
    say(session.ws, "", true);                 // close the talk cycle
    session.llmFails = 0;
    if (session.escalate) endWith(session, "escalate", session.escalate);
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("turn failed", e.message);
      session.llmFails++;
      if (session.llmFails >= 2) {
        say(session.ws, "I'm so sorry — I'm having technical trouble on my end. Let me get you to voicemail so we don't lose you.");
        endWith(session, "voicemail", `llm failed: ${e.message}`);
      } else {
        // the failed turn rolled its history back, so a repeat starts clean
        say(session.ws, "Sorry — I hit a snag on my end, not you. Could you say that once more?");
      }
    }
  }
  session.busy = false;
  // whatever the caller said while we were busy gets answered, not dropped
  if (!session.ended && session.pending && session.captureEventId) {
    const queued = session.pending; session.pending = "";
    await runOneTurn(session, queued);
  }
}

async function onPrompt(session, msg) {
  if (!msg.last || session.ended) return;      // partials off; finals only
  const text = String(msg.voicePrompt || "").trim();
  if (!text) return;
  if (session.busy || !session.captureEventId) {
    // mid-turn or setup still in flight — queue (accumulate) instead of drop
    session.pending = session.pending ? `${session.pending} ${text}` : text;
    return;
  }
  await runOneTurn(session, text);
}

/* hangup / end: settle the ledger + envelope exactly once */
async function closeOut(session) {
  if (session.closedOut || !session.captureEventId) return;
  session.closedOut = true;
  const seconds = Math.round((Date.now() - session.startedAt) / 1000);
  const p = priceFor(PHONE_MODEL);
  const llmCost = Math.max(0, (session.usage.inTok / 1e6) * p.in + (session.usage.outTok / 1e6) * p.out);
  const voiceCost = Math.max(0, (seconds / 60) * VOICE_PRICE_PER_MIN);
  try {
    await insertRow("ai_usage", {
      capture_event_id: session.captureEventId, form_key: "phoneCall", captured_by: "phone-agent",
      provider: "twilio+anthropic", llm_model: PHONE_MODEL,
      input_tokens: session.usage.inTok, output_tokens: session.usage.outTok,
      audio_seconds: seconds, llm_cost_usd: llmCost,
      cost_usd: llmCost + voiceCost, capped: false, note: "phone lane",
    });
    await patchCaptureEvent(session.captureEventId, {
      status: "extracted", processed_at: new Date().toISOString(),
      result: {
        seconds, turns: session.turns, toolCalls: session.toolCalls,
        leadId: session.leadId, escalated: !!session.escalate, cost_usd: llmCost + voiceCost,
        llmFails: session.llmFails,            // >0 with 0 tokens = check LLM_API_KEY on Fly
      },
    });
  } catch (e) { console.error("closeout failed", e.message); }
}

export function createAgentServer() {
  const http = createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: http, path: "/relay" });
  wss.on("connection", (ws) => {
    const session = newSession(ws);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "setup") onSetup(session, msg);
      else if (msg.type === "prompt") onPrompt(session, msg);
      else if (msg.type === "interrupt") { try { session.abort?.abort(); } catch { /* not in flight */ } }
      else if (msg.type === "error") console.error("relay error:", msg.description);
      // dtmf ignored in v1
    });
    ws.on("close", () => { try { session.abort?.abort(); } catch { } closeOut(session); });
    ws.on("error", () => { /* close handler settles the ledger */ });
  });
  return http;
}

/* boot (skipped under test import) */
if (process.env.NODE_ENV !== "test") {
  signIn()
    .then(() => console.log("machine session ready"))
    .catch((e) => console.error("machine sign-in failed (will retry per call):", e.message));
  probeLLM()
    .then(() => console.log(`LLM ready — ${PHONE_MODEL} reachable with this key`))
    .catch((e) => console.error(
      "LLM PROBE FAILED — the receptionist will answer but cannot think; " +
      "callers get two apologies then voicemail. Fix LLM_API_KEY / PHONE_MODEL in Fly secrets. " +
      `Probe error ${e.message}`));
  createAgentServer().listen(PORT, () => console.log(`phone agent on :${PORT}`));
}
