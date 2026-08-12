/**
 * Supabase Edge Function: roybal-web-agent
 *
 * The AI receptionist on www.roybalconstruction.com. A visitor types (or
 * speaks, via their own browser), a short conversation happens, and it ends
 * as a lead card on the job board — the same card the phone receptionist
 * creates, in the same column, with the same owner text.
 *
 * WHAT THIS FUNCTION IS NOT
 *
 * It is not a chatbot with a spend cap bolted on. It is a spend cap with a
 * chatbot inside it. This endpoint is public, unauthenticated, and every turn
 * costs real money at Anthropic — the exposure a small contractor cannot
 * absorb. An adversarial review of the original design found three ways to
 * run an unbounded bill against it; the shape below is the answer to those,
 * and the ordering of operations is load-bearing.
 *
 *   RESERVE BEFORE YOU SPEND. web_turn_begin writes the worst-case cost to
 *   ai_usage in the SAME transaction that checks the cap, BEFORE the model is
 *   called, then web_turn_end reconciles it down. Recording spend afterwards
 *   is the bug that lets a caller drop the connection mid-response and run a
 *   bill while the cap reads $0.00. If the isolate dies here, the money is
 *   already booked and the cap has already moved.
 *
 *   COUNT IN ONE STATEMENT. Every limiter is a SECURITY DEFINER RPC that
 *   counts and writes atomically under an advisory lock (migration 227).
 *   Read-then-write loses to concurrency: 2,000 simultaneous requests all read
 *   "0 this hour" and all pass.
 *
 *   FAIL CLOSED. Deliberately the inverse of roybal-voice, which fails OPEN
 *   because a missed phone call is lost revenue. Here, every failure —
 *   unreadable cap, dead LLM key, bad token, tripped limiter — degrades to
 *   `mode:"form"`, which renders the quote form and the phone number that
 *   already convert leads today. Do not "fix" this later: an uncapped public
 *   LLM endpoint is an unbounded bill, and the fallback is a working form.
 *
 *   NO READ PATH. This function never reads customer data. It touches the
 *   database ONLY through four fixed-signature RPCs; there is no
 *   /rest/v1/<table> path anywhere in this file, and guards.test.mjs greps the
 *   source and fails if that stops being true.
 *
 * THE MODEL IS NOT TRUSTED WITH ANYTHING THAT COSTS OR BINDS
 *
 *   - It has exactly one tool, createLead. It cannot text, dial, look anyone
 *     up, or read a record.
 *   - The owner SMS is a deterministic consequence of a lead insert, not a
 *     model decision.
 *   - The emergency escalation is a regex on the visitor's RAW text, run
 *     BEFORE the model sees it. It fires the call card and the owner text
 *     even if Anthropic is down — this project's logs show a dead LLM key is
 *     a real failure mode, and a homeowner in four inches of water must not
 *     depend on it.
 *   - Every reply passes a deterministic output filter (guards.redact) that
 *     replaces anything quoting a price, a percentage, insurance coverage, a
 *     guarantee, or licensure with owner-approved copy. Moffatt v. Air Canada
 *     (BCCRT, 2024) settled that the operator owns what its bot says.
 *
 * Actions (body.action):
 *   start — { t, company, path, service } -> { ok, mode:'chat', sid, token,
 *            turn, greeting, notice } | { ok, mode:'form' }
 *            No model call. Zero tokens. Warms the isolate.
 *   turn  — { sid, token, turn, sig, hist, text } -> { ok, mode:'chat', reply,
 *            sig, turn, lead, callNow, filtered } | { ok, mode:'form', reply }
 *
 * Secrets:  WEB_AGENT_ENABLED      kill switch, default true ("false" to stop)
 *           WEB_AGENT_SECRET       REQUIRED — openssl rand -hex 32
 *           LLM_API_KEY            shared with roybal-ai-office
 *           WEB_AGENT_ALLOW_ORIGIN default https://www.roybalconstruction.com
 *           WEB_SPEND_DAILY_USD    default 1.50
 *           WEB_SPEND_CAP_USD      default 8.00   (this lane, per month)
 *           SPEND_CAP_USD          default 50.00  (all lanes — shared)
 *           WEB_SESSION_IP_MAX     default 4   / hour
 *           WEB_SESSION_SUBNET_MAX default 12  / hour (/24)
 *           WEB_SESSION_HOURLY_MAX default 120 / hour (global)
 *           WEB_MAX_TURNS          default 12
 *           WEB_MAX_CALLS          default 16  (model calls incl. tool rounds)
 *           WEB_LEAD_DAILY_MAX     default 15
 *           WEB_SMS_MONTHLY_MAX    default 100 (recipient-messages)
 *           WEB_MODEL              default claude-haiku-4-5
 *           ALERT_CELLS            comma-separated; falls back to OWNER_CELL
 *           OWNER_CELL             the owner's cell
 * Deploy:   supabase functions deploy roybal-web-agent --no-verify-jwt
 *   (--no-verify-jwt is required: website visitors have no session. The
 *    function self-protects; see above.)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  clip, digitsOf, isUuid, mintToken, verifyToken, signTranscript, verifyTranscript,
  encodeTranscript, toModelTurns, isEmergency, redact, estimateTurnCost, actualCost,
  approxTokens, lossTypeFor, parseRecipients, type Turn,
} from "./guards.ts";
import { WEB_PERSONA, WEB_TOOL_RULE, CREATE_LEAD_TOOL, greetingFor, AI_NOTICE } from "./persona.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const SECRET = Deno.env.get("WEB_AGENT_SECRET") ?? "";

const ENABLED = (Deno.env.get("WEB_AGENT_ENABLED") ?? "true").toLowerCase() !== "false";

/* A non-numeric secret must never silently disable a limit. */
const num = (name: string, dflt: number) => {
  const n = Number(Deno.env.get(name) ?? dflt);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const DAILY_CAP = num("WEB_SPEND_DAILY_USD", 1.5);
const LANE_CAP = num("WEB_SPEND_CAP_USD", 8);
const SHARED_CAP = num("SPEND_CAP_USD", 50);
const IP_MAX = num("WEB_SESSION_IP_MAX", 4);
const SUBNET_MAX = num("WEB_SESSION_SUBNET_MAX", 12);
const HOURLY_MAX = num("WEB_SESSION_HOURLY_MAX", 120);
const MAX_ROUNDS = 2;      // model calls per turn (reply + one tool round)
const MAX_TURNS = num("WEB_MAX_TURNS", 12);
/* web_turn_begin charges MAX_ROUNDS calls per turn (a turn may take a tool
   round, and the budget must assume it did). So the call budget has to be
   MAX_TURNS × MAX_ROUNDS, or it — not MAX_TURNS — is what actually ends
   conversations. At 16 the session died after 8 turns while WEB_MAX_TURNS=12
   sat there looking authoritative. */
const MAX_CALLS = num("WEB_MAX_CALLS", MAX_TURNS * MAX_ROUNDS);
const LEAD_DAILY_MAX = num("WEB_LEAD_DAILY_MAX", 15);
/* Owner-text ceilings, enforced atomically by web_alert_claim. A single
   conversation is worth at most two texts — one when the emergency is
   recognised, one when the lead lands. */
const ALERTS_PER_SESSION = num("WEB_ALERTS_PER_SESSION", 2);
const ALERTS_PER_DAY = num("WEB_ALERTS_PER_DAY", 40);
const MODEL = Deno.env.get("WEB_MODEL") ?? "claude-haiku-4-5";

/* The published company number, in one place. It has already changed twice —
   local 907 → toll-free 866 → back to the local 907, because a 907 area code
   is a local-relevance signal a Fairbanks restoration company cannot afford
   to give up. Hardcoding it a third time would guarantee a fourth mismatch,
   so it is a secret with the current value as the default. Keep it in sync
   with BUSINESS.phone in apps/site/src/data/site.ts. */
const COMPANY_PHONE = Deno.env.get("COMPANY_PHONE") ?? "(907) 371-9868";
const COMPANY_PHONE_E164 = Deno.env.get("COMPANY_PHONE_E164") ?? "+19073719868";

const SESSION_TTL_MIN = 20;
const MAX_TEXT = 400;      // visitor message, characters
/* Assistant replies are clipped to this on BOTH the signing side and the
   rebuild side. max_tokens 200 is ~800 characters at the pessimistic end, so
   this never truncates a real reply — it exists so the two sides can never
   disagree about what was said. */
const MAX_REPLY = 1200;
const MAX_HIST = 12;       // exchanges kept
const MAX_TOKENS = 200;    // model reply ceiling

const ALLOW = (Deno.env.get("WEB_AGENT_ALLOW_ORIGIN") ?? "https://www.roybalconstruction.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function corsFor(origin: string | null) {
  const allowed = ALLOW.includes("*") ? "*" : ALLOW.includes(origin ?? "") ? origin! : ALLOW[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
const json = (b: unknown, s: number, origin: string | null) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsFor(origin), "Content-Type": "application/json" } });

/** Every degrade lands here. The visitor still converts — via the form. */
const toForm = (origin: string | null, reply?: string) =>
  json({ ok: true, mode: "form", ...(reply ? { reply } : {}) }, 200, origin);

/* ---------- database: RPCs only, never a table path ---------- */

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json().catch(() => null);
}

/* ---------- client identity ----------
   The FIRST x-forwarded-for hop is whatever the caller sent, so counting on
   it means one attacker looks like unlimited visitors. Prefer a header the
   platform sets; otherwise take the LAST hop, appended by the proxy nearest
   us. Still not an identity — a botnet defeats per-IP entirely — which is why
   there is a /24 counter and a global hourly cap behind it. */
function clientIp(req: Request): string {
  const platform = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "";
  if (platform.trim()) return platform.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "unknown";
}
const subnetOf = (ip: string) => {
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ip;
};
async function hashId(v: string): Promise<string> {
  const data = new TextEncoder().encode(`${SECRET || SERVICE_KEY}|${v}`);
  const d = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(d).slice(0, 12)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Alaska local hour (matches roybal-voice's window) ---------- */
function alaskaHour(): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage", hour: "numeric", hour12: false,
  }).format(new Date());
  const h = Number(s);
  return Number.isFinite(h) ? h % 24 : 12;
}

/* ---------- owner alert ----------
   A deterministic consequence of a lead, never a model decision. Per
   recipient so one bad number cannot stop the others; partial delivery still
   counts as one alert. Mirrors sendAlert() in services/phone-agent/tools.mjs. */
async function textOwner(body: string, sessionId: string): Promise<boolean> {
  /* Validate the recipients FIRST, before claiming any budget.
     Claiming and then discovering there is nobody valid to text burns the
     session's alert allowance on a send that never happened — so two
     misconfigured attempts would silence a conversation's alerts entirely. */
  const { valid: cells, rejected } = parseRecipients(
    Deno.env.get("ALERT_CELLS") ?? Deno.env.get("OWNER_CELL") ?? "",
  );
  if (rejected.length) {
    // Digit counts only — this line goes to logs.
    console.error(
      `web-agent: ${rejected.length} recipient(s) are not valid US numbers ` +
      `(digit counts: ${rejected.join(", ")}). Fix ALERT_CELLS / OWNER_CELL — ` +
      `each must be 10 digits, or 11 starting with 1.`,
    );
  }
  if (!cells.length) {
    console.error(
      "web-agent: NO VALID ALERT RECIPIENTS — the lead is saved but nobody was texted. " +
      "Set ALERT_CELLS or OWNER_CELL to a US number.",
    );
    return false;
  }

  /* ⚠️ Buy the right to send BEFORE sending. Without this the alert path was
     the cheapest thing to abuse in the whole design: replaying one 20-minute
     token fired unlimited texts to five recipients, and it worked best AFTER
     the spend cap was exhausted, because that branch skips the model and so
     skipped every meter with it. Twilio bills per message and the pool is
     shared with the phone receptionist. */
  let allowed = false;
  try {
    allowed = (await rpc("web_alert_claim", {
      p_session_id: sessionId,
      p_session_max: ALERTS_PER_SESSION,
      p_daily_max: ALERTS_PER_DAY,
    })) === true;
  } catch (e) {
    // Fail CLOSED. An unreadable meter is not a licence to spend.
    console.error("web-agent: alert_claim failed", String((e as Error)?.message ?? e));
    return false;
  }
  if (!allowed) {
    console.warn(`web-agent: alert refused for ${sessionId} (session or daily alert cap)`);
    return false;
  }
  let sent = 0;
  for (const to of cells) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sendSms",
          to,   // already normalized to +1XXXXXXXXXX by parseRecipients
          // kind 'webOwner' is quiet-hours exempt and sits OUTSIDE the
          // protected SMS reserve — see roybal-notify. A 2am website
          // emergency should buzz the phone; it must never be able to eat
          // the messages the phone receptionist depends on.
          kind: "webOwner",
          captured_by: "web-agent",
          body: clip(body, 300),
        }),
      });
      if (res.ok) sent++;
      else console.error(`web-agent: sms refused by roybal-notify (${res.status}):`, (await res.text().catch(() => "")).slice(0, 300));
    } catch (e) {
      console.error("web-agent: sms threw", String((e as Error)?.message ?? e));
    }
  }
  console.log(`web-agent: alert for ${sessionId} -> ${sent}/${cells.length} recipients`);
  return sent > 0;
}

/* ---------- the lead write ----------
   Called from inside the model loop so the tool_result can tell the truth
   about whether it worked. Returns why it didn't, for the model to relay. */
type LeadResult = { saved: boolean; reason: string; id?: string; urgent?: boolean };

async function saveLead(
  args: Record<string, unknown>,
  sid: string,
  hist: Turn[],
  latestText: string,
  emergency: boolean,
  path: string,
): Promise<LeadResult> {
  const name = clip(args.name, 80);
  const phone = clip(args.phone, 25);
  if (!name || digitsOf(phone).length < 10) {
    return { saved: false, reason: "the name or callback number is missing or incomplete" };
  }

  const lossType = lossTypeFor(args.lossType);
  const urgent = emergency || String(args.urgency ?? "") === "emergency";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const transcript = [...hist.map((m) => `${m.r === "a" ? "Assistant" : "Visitor"}: ${m.t}`), `Visitor: ${latestText}`]
    .join("\n").slice(0, 4000);

  // Field-for-field the envelope roybal-lead and phone-agent createLead write,
  // so the board renders this as the same card with no changes.
  const lead = {
    id,
    stage: "lead",
    type: lossType === "remodel" ? "remodel" : "mitigation",
    title: `${name} — ${lossType}`,
    customer: name,
    phone,
    email: "",
    address: clip(args.address, 160),
    priority: urgent ? "high" : "normal",
    materials: "none",
    crewIds: [], deps: [], subtasks: [],
    scheduleMode: "auto", pinnedStart: "", durationDays: null,
    notes:
      `AI web receptionist (roybalconstruction.com${path}).\n` +
      (urgent ? "⚠️ ACTIVE EMERGENCY per the visitor.\n" : "") +
      `${clip(args.summary, 500)}\n\n--- what they told the assistant ---\n${transcript}`,
    source: "web",
    channel: "ai-chat",
    webLead: true,
    aiBooked: true,
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const inserted = await rpc("web_lead_insert", {
      p_session_id: sid, p_lead: lead, p_daily_max: LEAD_DAILY_MAX,
    }) as string | null;
    if (!inserted) return { saved: false, reason: "a lead already exists for this conversation" };
    console.log(`web-agent: lead ${id} from ${sid}${urgent ? " (EMERGENCY)" : ""}`);
    return { saved: true, reason: "", id, urgent };
  } catch (e) {
    console.error("web-agent: lead insert failed", String((e as Error)?.message ?? e));
    return { saved: false, reason: "the system is temporarily unavailable" };
  }
}

/* ---------- Anthropic ---------- */

type Msg = { role: "user" | "assistant"; content: unknown };

async function callModel(messages: Msg[], system: string, tools: unknown[], signal: AbortSignal) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal, // an abandoned request stops generating rather than billing on
    headers: {
      "content-type": "application/json",
      "x-api-key": LLM_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      ...(tools.length ? { tools } : {}),
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

/* ============================================================ */

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);

  // Misconfiguration must not open the endpoint. No secret, no service.
  if (!ENABLED || !SECRET || !LLM_API_KEY) {
    if (!SECRET) console.error("web-agent: WEB_AGENT_SECRET is not set — refusing to serve");
    if (!LLM_API_KEY) console.error("web-agent: LLM_API_KEY is not set — refusing to serve");
    return toForm(origin);
  }

  // Origin allowlist. Not a security boundary (curl ignores it) — it just
  // keeps the lane for this site rather than someone else's embed.
  if (!ALLOW.includes("*") && origin && !ALLOW.includes(origin)) return toForm(origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return toForm(origin);
  }

  const action = String(body.action ?? "");

  /* ---------------- start ---------------- */
  if (action === "start") {
    // Honeypot and a timing gate. A human cannot open a page and submit in
    // under 800ms; a script always can. Both degrade silently to the form so
    // a scraper learns nothing about what tripped.
    if (clip(body.company, 200)) return toForm(origin);
    const elapsed = Number(body.t);
    if (!Number.isFinite(elapsed) || elapsed < 800) return toForm(origin);

    const ip = clientIp(req);
    let sid: string | null = null;
    try {
      sid = (await rpc("web_session_begin", {
        p_ip_hash: await hashId(ip),
        p_subnet_hash: await hashId(subnetOf(ip)),
        p_origin: clip(origin, 120),
        p_path: clip(body.path, 200),
        p_ua: clip(req.headers.get("user-agent"), 200),
        p_service: clip(body.service, 80),
        p_ip_max: IP_MAX,
        p_subnet_max: SUBNET_MAX,
        p_hourly_max: HOURLY_MAX,
      })) as string | null;
    } catch (e) {
      // Fail CLOSED — see the header. A limiter we cannot read is a limiter
      // that is not protecting us.
      console.error("web-agent: session_begin failed", String((e as Error)?.message ?? e));
      return toForm(origin);
    }
    if (!sid || !isUuid(sid)) return toForm(origin); // a limiter tripped

    const greeting = greetingFor(alaskaHour(), clip(body.service, 80) || undefined);
    return json({
      ok: true,
      mode: "chat",
      sid,
      token: await mintToken(SECRET, sid, SESSION_TTL_MIN * 60_000, Date.now()),
      turn: 0,
      greeting,
      // Sign the opening history here so turn 0 is verified like every other
      // turn. Leaving the first request unsigned was an unauthenticated way
      // to seed a forged assistant history — and forged assistant lines get
      // quoted verbatim into the lead notes the owner reads.
      sig: await signTranscript(SECRET, sid, 0, [{ r: "a", t: greeting }]),
      notice: AI_NOTICE,
    }, 200, origin);
  }

  /* ---------------- turn ---------------- */
  if (action !== "turn") return toForm(origin);

  const sid = String(body.sid ?? "");
  const turn = Number(body.turn);
  const text = clip(body.text, MAX_TEXT);

  if (!isUuid(sid) || !Number.isInteger(turn) || turn < 0 || !text) return toForm(origin);
  if (turn >= MAX_TURNS) {
    return toForm(origin, "I've got what I need for now — let me hand you to our quick form so Branden has it in writing.");
  }
  if (!(await verifyToken(SECRET, sid, String(body.token ?? ""), Date.now()))) return toForm(origin);

  /* History is client-held and signed. The visitor may say anything as a
     user turn — that is a conversation. What they cannot do is forge
     ASSISTANT turns to manufacture a compliant-sounding history, replay a
     maximal transcript into a fresh session, or rewind to a cheaper turn
     index: the signature binds sid AND turn. */
  const rawHist = Array.isArray(body.hist) ? body.hist : [];
  /* Clip to MAX_REPLY, not MAX_TEXT. The server signs the assistant's reply
     verbatim; if the rebuild here clipped it shorter, any reply over the
     limit would hash differently and permanently break the session on the
     NEXT turn — silently, mid-conversation. Both sides must clip identically,
     so the model's max_tokens ceiling is what bounds this. */
  const hist: Turn[] = rawHist.slice(-MAX_HIST * 2).map((m: Record<string, unknown>) => ({
    r: m?.r === "a" ? "a" : "u",
    t: clip(m?.t, m?.r === "a" ? MAX_REPLY : MAX_TEXT),
  }));

  /* Verified on EVERY turn including the first. `start` issues a signature
     over the greeting, so there is no unsigned entry point through which a
     forged assistant history could be seeded — and forged assistant turns end
     up quoted verbatim in the lead's notes, which is what the owner reads
     when deciding how to handle the job. */
  if (!(await verifyTranscript(SECRET, sid, turn, hist, String(body.sig ?? "")))) {
    console.error(`web-agent: bad transcript signature on ${sid} turn ${turn}`);
    return toForm(origin);
  }

  /* ---- the emergency net ----
     Runs on RAW visitor text BEFORE the model, and its outcome does not
     depend on the model answering at all. */
  const emergency = isEmergency(text);

  /* ---- reserve the spend BEFORE calling anyone ---- */
  const system = WEB_PERSONA + WEB_TOOL_RULE;
  const promptTokens = approxTokens(system) + approxTokens(encodeTranscript(hist)) + approxTokens(text) + 300;
  const estimate = estimateTurnCost(MODEL, promptTokens, MAX_TOKENS, MAX_ROUNDS);

  let usageId: string | null = null;
  try {
    usageId = (await rpc("web_turn_begin", {
      p_session_id: sid,
      p_est_usd: estimate,
      p_model: MODEL,
      p_daily_cap: DAILY_CAP,
      p_lane_cap: LANE_CAP,
      p_shared_cap: SHARED_CAP,
      p_max_calls: MAX_CALLS,
      p_session_ttl_minutes: SESSION_TTL_MIN,
    })) as string | null;
  } catch (e) {
    console.error("web-agent: turn_begin failed", String((e as Error)?.message ?? e));
    usageId = null;
  }

  if (!usageId) {
    // A cap is met, or we could not verify one. Either way: no model call.
    // The emergency net still fires — being out of budget must never mean a
    // flooding house goes unanswered.
    if (emergency) {
      await textOwner(
        `WEB EMERGENCY (assistant unavailable): visitor said "${clip(text, 160)}". No contact details captured — site form may follow.`,
        sid,
      ).catch(() => {});
      return json({
        ok: true, mode: "form",
        reply: `This sounds urgent — please call ${COMPANY_PHONE} right now. I've alerted Branden.`,
        callNow: { tel: COMPANY_PHONE_E164, label: `Call now — ${COMPANY_PHONE}`, reason: "emergency" },
      }, 200, origin);
    }
    return toForm(origin, `Let me hand you to our quick form — or call ${COMPANY_PHONE} and we'll take care of you.`);
  }

  /* ---- the bounded model loop ---- */
  /* ⚠️ toModelTurns drops the leading greeting. The Messages API requires
     messages[0] to be role "user", and the client's history opens with the
     assistant's greeting — mapping it straight through 400s EVERY call, which
     made the whole feature non-functional. `hist` itself stays whole: the
     signature and the saved transcript are computed over all of it. */
  const messages: Msg[] = [
    ...toModelTurns(hist).map((m) => ({
      role: (m.r === "a" ? "assistant" : "user") as "user" | "assistant",
      content: m.t,
    })),
    { role: "user", content: text },
  ];

  let reply = "";
  let leadArgs: Record<string, unknown> | null = null;
  let leadResult: LeadResult = { saved: false, reason: "" };
  let inTok = 0, outTok = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // createLead is offered only until it fires, so the model cannot burn a
      // round on an {error} tool_result for calling it twice.
      const tools = leadArgs ? [] : [CREATE_LEAD_TOOL];
      const data = await callModel(messages, system, tools, req.signal) as Record<string, any>;

      inTok += Number(data?.usage?.input_tokens ?? 0);
      outTok += Number(data?.usage?.output_tokens ?? 0);

      const blocks = Array.isArray(data?.content) ? data.content : [];
      reply = blocks.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join(" ").trim();
      const toolUse = blocks.find((b: any) => b?.type === "tool_use" && b?.name === "createLead");

      if (!toolUse) break;

      /* Do the write HERE, before telling the model it succeeded. The
         previous version fed back a hardcoded "Lead saved" and only attempted
         the insert afterwards — so a failed write still produced "Branden
         will call you shortly", and the visitor went away believing they were
         in the queue when nothing had been recorded. */
      leadArgs = (toolUse.input ?? {}) as Record<string, unknown>;
      leadResult = await saveLead(leadArgs, sid, hist, text, emergency, clip(body.path, 120));

      messages.push({ role: "assistant", content: blocks });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: !leadResult.saved,
          content: leadResult.saved
            ? `Lead saved. Tell them Branden will call shortly, and give them ${COMPANY_PHONE} for anything urgent.`
            : `Could not save the lead: ${leadResult.reason}. Apologize briefly and tell them to call ${COMPANY_PHONE} — do NOT say it was saved.`,
        }],
      });
    }
  } catch (e) {
    console.error("web-agent: model call failed", String((e as Error)?.message ?? e));
    // The reservation stands on purpose — we may well have been billed.
    await rpc("web_turn_end", {
      p_usage_id: usageId, p_in_tokens: inTok, p_out_tokens: outTok,
      p_actual_usd: Math.max(actualCost(MODEL, inTok, outTok), estimate / MAX_ROUNDS),
    }).catch(() => {});

    if (emergency) {
      await textOwner(`WEB EMERGENCY (assistant errored): "${clip(text, 160)}"`, sid).catch(() => {});
      return json({
        ok: true, mode: "form",
        reply: `This sounds urgent — please call ${COMPANY_PHONE} right now. I've alerted Branden.`,
        callNow: { tel: COMPANY_PHONE_E164, label: `Call now — ${COMPANY_PHONE}`, reason: "emergency" },
      }, 200, origin);
    }
    return toForm(origin, `Sorry — I dropped that. Use the quick form, or call ${COMPANY_PHONE}.`);
  }

  /* ---- reconcile the reservation down to what actually happened ---- */
  await rpc("web_turn_end", {
    p_usage_id: usageId, p_in_tokens: inTok, p_out_tokens: outTok,
    p_actual_usd: actualCost(MODEL, inTok, outTok),
  }).catch((e) => console.error("web-agent: turn_end failed (reservation stands)", String(e?.message ?? e)));

  /* ---- alerts ----
     Both paths go through textOwner, which buys the right to send from
     web_alert_claim first. Two texts per conversation, not one per turn. */
  if (leadResult.saved) {
    await textOwner(
      `${leadResult.urgent ? "🚨 WEB EMERGENCY" : "🌐 Web lead"} — ${clip(leadArgs?.name, 80)}, ` +
      `${clip(leadArgs?.phone, 25)}, ${lossTypeFor(leadArgs?.lossType)}` +
      `${clip(leadArgs?.address, 60) ? `, ${clip(leadArgs?.address, 60)}` : ""}. ${clip(leadArgs?.summary, 90)}`,
      sid,
    ).catch(() => {});
  } else if (emergency) {
    // An emergency the model failed to act on still reaches the owner. The
    // regex decides this, not the model — and the claim counter means a
    // twelve-turn panic does not become twelve texts.
    await textOwner(`🚨 WEB EMERGENCY in chat (no details yet): "${clip(text, 160)}"`, sid).catch(() => {});
  }

  /* ---- the output filter ---- */
  const filteredReply = redact(reply || "Got it — what's the best number to reach you at?", text);

  /* Clip the reply to exactly what the next turn's rebuild will clip it to,
     and sign THAT. Signing the raw reply while the next request rebuilds a
     clipped copy is a hash mismatch that silently ends the conversation. */
  const replyForHistory = clip(filteredReply.text, MAX_REPLY);
  const nextHist: Turn[] = [...hist, { r: "u", t: text }, { r: "a", t: replyForHistory }];

  return json({
    ok: true,
    mode: "chat",
    reply: replyForHistory,
    filtered: filteredReply.filtered,
    turn: turn + 1,
    sig: await signTranscript(SECRET, sid, turn + 1, nextHist),
    lead: leadResult.saved,
    callNow: emergency
      ? { tel: COMPANY_PHONE_E164, label: `Call now — ${COMPANY_PHONE}`, reason: "emergency" }
      : null,
  }, 200, origin);
});
