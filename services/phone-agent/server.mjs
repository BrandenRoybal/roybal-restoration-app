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
import { runTurn } from "./brain.mjs";

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
  };
}

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket already gone */ } };
const say = (ws, text, last = true) => send(ws, { type: "text", token: text, last });
const endWith = (ws, reasonCode, reason) =>
  send(ws, { type: "end", handoffData: JSON.stringify({ reasonCode, reason: String(reason || "").slice(0, 140) }) });

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
    endWith(session.ws, "voicemail", "relay token mismatch");
    return;
  }
  const capped = await overCap();
  if (capped) {
    say(session.ws, "Sorry — our assistant is unavailable right now. Let me get you to voicemail.");
    endWith(session.ws, "voicemail", capped);
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
    endWith(session.ws, "voicemail", "envelope failed");
  }
}

async function onPrompt(session, msg) {
  if (!msg.last) return;                       // partials off; finals only
  const text = String(msg.voicePrompt || "").trim();
  if (!text || session.busy || !session.captureEventId) return;
  session.busy = true;
  session.turns++;
  session.abort = new AbortController();
  try {
    await runTurn(session, text, {
      system: systemFor(session), tools: TOOLS,
      onToken: (tok) => say(session.ws, tok, false),
    });
    say(session.ws, "", true);                 // close the talk cycle
    if (session.escalate) endWith(session.ws, "escalate", session.escalate);
  } catch (e) {
    if (e.name !== "AbortError") {
      console.error("turn failed", e.message);
      say(session.ws, "Sorry — I'm having trouble hearing myself think. Could you say that once more?");
    }
  }
  session.busy = false;
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
  createAgentServer().listen(PORT, () => console.log(`phone agent on :${PORT}`));
}
