/**
 * Supabase Edge Function: roybal-voice
 *
 * Twilio VOICE webhook for the company toll-free number — the phone lane's
 * front door ("no-answer forwarding first": the AI only takes calls that
 * would have been missed).
 *
 * Call flow (all endpoints Twilio-signature verified, no JWT — Twilio has
 * no user session; auth is X-Twilio-Signature exactly like roybal-notify's
 * /inbound):
 *   POST /            incoming call → <Dial answerOnBridge> the owner's
 *                     cell (timeout DIAL_TIMEOUT, default 15s) with a
 *                     press-any-key SCREEN on the callee leg, action=
 *                     /screen. OWNER_CELL unset → straight to the relay.
 *   POST /whisper     runs on the OWNER's leg when their phone answers:
 *                     "Call for Roybal Construction — press any key."
 *                     Only a human can pass it — the owner's carrier
 *                     VOICEMAIL answering counts as an answer to Twilio,
 *                     but voicemail can't press keys, so an unattended
 *                     forward always falls through to the AI instead of
 *                     dying in personal voicemail.
 *   POST /accept      a key was pressed → empty TwiML → the legs bridge.
 *   POST /screen      after the dial attempt. DialBridged (not
 *                     DialCallStatus!) is the truth: a rejected screen
 *                     reports status "completed", so only DialBridged
 *                     "true" means humans talked (→ hang up); anything
 *                     else → hand the call to the AI receptionist via
 *                     <Connect action=/action><ConversationRelay …>.
 *   POST /action      when the relay session ends: escalate handoff →
 *                     <Dial> the owner (urgent); a voicemail handoff
 *                     (agent capped / token mismatch / envelope failure)
 *                     or a failed session → voicemail; else hang up.
 *
 * Day-one resilience: if PHONE_AGENT_WSS is unset, or the relay session
 * FAILS, the caller never dead-ends — they get voicemail (<Record>) after
 * an apology, and the recording lives in the Twilio console.
 *
 * The AI receptionist itself is the always-on Node agent on Fly.io
 * (services/phone-agent) — this function only speaks TwiML. The shared
 * secret PHONE_RELAY_TOKEN rides to the agent as a <Parameter> and is
 * validated in the WebSocket setup message.
 *
 * Secrets:  TWILIO_AUTH_TOKEN (shared), PHONE_AGENT_WSS
 *           (wss://<app>.fly.dev/relay), PHONE_RELAY_TOKEN, OWNER_CELL,
 *           DIAL_TIMEOUT (optional, seconds)
 * Deploy:   supabase functions deploy roybal-voice --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const AGENT_WSS = Deno.env.get("PHONE_AGENT_WSS") ?? "";
const RELAY_TOKEN = Deno.env.get("PHONE_RELAY_TOKEN") ?? "";
const OWNER_CELL = Deno.env.get("OWNER_CELL") ?? "";
const DIAL_TIMEOUT = Math.min(Math.max(Number(Deno.env.get("DIAL_TIMEOUT") ?? "15") || 15, 5), 30);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const twiml = (inner: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
    { headers: { "Content-Type": "text/xml" } });

/* Same HMAC-SHA1 check as roybal-notify's /inbound: base64(HMAC(auth token,
   URL + params sorted by name)), tried against the URL Twilio actually hit
   and the canonical SUPABASE_URL form (edge runtime can rewrite the host). */
async function twilioSignatureValid(req: Request, params: URLSearchParams, path: string): Promise<boolean> {
  const sig = req.headers.get("X-Twilio-Signature") ?? "";
  if (!sig || !TWILIO_AUTH) return false;
  const payload = [...new Set(params.keys())].sort().map((n) => n + (params.get(n) ?? "")).join("");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(TWILIO_AUTH), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  for (const url of new Set([req.url, `${SUPABASE_URL}/functions/v1/roybal-voice${path}`])) {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url + payload)));
    if (btoa(String.fromCharCode(...mac)) === sig) return true;
  }
  return false;
}

/* Voicemail: never dead-end a caller. The recording lands in the Twilio
   console; the daily habit is checking texts, so this is the last resort. */
const voicemail = (lead: string) =>
  `<Say>${esc(lead)} Please leave your name, number, and the property address after the tone, and we'll call you right back.</Say>` +
  `<Record maxLength="120" playBeep="true"/>` +
  `<Say>Thanks — we'll be in touch soon. Goodbye.</Say><Hangup/>`;

/* Business hours = the same 8am–8pm America/Anchorage window the SMS
   quiet-hours use (SMS_QUIET_START/END are project-wide secrets), so
   "office hours" means one thing across the whole phone/text lane. */
const BIZ_START = qhNum(Deno.env.get("SMS_QUIET_START"), 8);
const BIZ_END = qhNum(Deno.env.get("SMS_QUIET_END"), 20);
function qhNum(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : dflt;
}
function greeting(): string {
  const hr = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage", hour: "numeric", hourCycle: "h23",
  }).format(new Date()));
  return hr >= BIZ_START && hr < BIZ_END
    ? "Thanks for calling Roybal Construction. This is the office assistant — the crew is out on jobs right now. How can I help?"
    : "Thanks for calling Roybal Construction. This is the after hours assistant — how can I help?";
}

/* The AI receptionist TwiML. Deepgram STT with the trade vocabulary the
   transcriber would otherwise mangle; the greeting plays instantly while
   the WebSocket connects, so the caller never hears dead air. */
function relayTwiml(): string {
  if (!AGENT_WSS) return voicemail("Thanks for calling Roybal Construction. We can't pick up right now.");
  return (
    `<Connect action="${esc(SUPABASE_URL)}/functions/v1/roybal-voice/action">` +
    `<ConversationRelay url="${esc(AGENT_WSS)}" ` +
    `welcomeGreeting="${esc(greeting())}" ` +
    `transcriptionProvider="Deepgram" speechModel="nova-3-general" ` +
    `hints="water damage, flood, burst pipe, water heater, sewage, mitigation, restoration, drywall, Fairbanks, North Pole, claim, adjuster, remodel">` +
    `<Parameter name="token" value="${esc(RELAY_TOKEN)}"/>` +
    `</ConversationRelay></Connect>` +
    // if the relay drops without our /action handler running, fall through
    voicemail("Sorry — we got cut off there.")
  );
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const rawPath = new URL(req.url).pathname.replace(/^.*\/roybal-voice/, "").replace(/\/$/, "");
  const path = rawPath === "" ? "" : rawPath;               // "", "/screen", "/action"
  const params = new URLSearchParams(await req.text());
  if (!(await twilioSignatureValid(req, params, path)))
    return new Response("signature mismatch", { status: 403 });

  const base = `${esc(SUPABASE_URL)}/functions/v1/roybal-voice`;

  // ---- incoming call: try the owner first (no-answer forwarding).
  // answerOnBridge keeps ringback playing for the caller while the owner's
  // leg runs the press-any-key screen. ----
  if (path === "") {
    if (!OWNER_CELL) return twiml(relayTwiml());
    return twiml(
      `<Dial timeout="${DIAL_TIMEOUT}" answerOnBridge="true" action="${base}/screen">` +
      `<Number url="${base}/whisper">${esc(OWNER_CELL)}</Number></Dial>`);
  }

  // ---- the owner's leg answered: human gate (voicemail can't press keys) ----
  if (path === "/whisper") {
    return twiml(
      `<Gather action="${base}/accept" numDigits="1" timeout="4">` +
      `<Say>Call for Roybal Construction — press any key to take it.</Say>` +
      `</Gather><Hangup/>`);
  }
  if (path === "/accept") return twiml("");                 // key pressed → bridge the legs

  // ---- after the dial attempt: DialBridged is the truth (a rejected
  // screen still reports DialCallStatus "completed") ----
  if (path === "/screen") {
    if (String(params.get("DialBridged") ?? "") === "true") return twiml("<Hangup/>"); // humans talked
    return twiml(relayTwiml());                             // missed / screened-out → the AI answers
  }

  // ---- relay session ended ----
  if (path === "/action") {
    const status = String(params.get("SessionStatus") ?? "");
    let handoff: Record<string, unknown> = {};
    try { handoff = JSON.parse(String(params.get("HandoffData") ?? "{}")); } catch (_) { /* absent on hangups */ }
    if (handoff.reasonCode === "escalate" && OWNER_CELL) {
      return twiml(
        `<Say>Connecting you now — one moment.</Say>` +
        `<Dial timeout="25">${esc(OWNER_CELL)}</Dial>` +
        voicemail("We couldn't reach anyone directly."));
    }
    // the agent deliberately handed off (capped / token mismatch / envelope
    // failure) — the caller must land in voicemail, never a bare hangup
    if (handoff.reasonCode === "voicemail" || status === "failed")
      return twiml(voicemail("Sorry — our assistant couldn't take this one."));
    return twiml("<Hangup/>");                              // normal wrap-up or caller hung up
  }

  return new Response("not found", { status: 404 });
});
