/**
 * Supabase Edge Function: roybal-notify
 *
 * Company-number texting (Twilio) for the field app + job board.
 * Same self-protection invariants as roybal-ai-office: anon key only,
 * the caller's JWT on every DB op, and the RLS-gated sms_messages
 * insert BEFORE the paid Twilio call. Monthly send cap.
 *
 * Actions (body.action):
 *   sendSms — { to, body, kind?, unified_job_id?, captured_by?, mediaUrls?[] }
 *             sends from TWILIO_FROM, records the row, returns { sid, status }.
 *             Customer-facing kinds only send 8am–8pm Alaska (quiet hours);
 *             crew/office kinds (fieldReport, forward) are exempt.
 *
 * Inbound (POST …/roybal-notify/inbound):
 *   Twilio's incoming-message webhook (form-encoded, no JWT). Auth is the
 *   X-Twilio-Signature check — only Twilio holds the auth token — and only
 *   after it passes does the service-role key log the reply (direction
 *   'inbound'). If SMS_FORWARD_TO is set, the reply is also forwarded as a
 *   text from the company number (never back to the sender, never past the
 *   monthly cap). Responds with empty TwiML so no auto-reply goes out.
 *
 * Secrets:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (+1XXXXXXXXXX)
 *           SMS_MONTHLY_CAP (optional, default 500 messages / month)
 *           SMS_RESERVE     (optional, default 150 — the tail of the monthly
 *                            cap held for PROTECTED_KINDS. Public lanes
 *                            (webOwner/webLead, reachable by any stranger on
 *                            the website) are refused once the balance drops
 *                            this low, so they can never silence the phone
 *                            receptionist's alerts or approve-by-text.)
 *           SMS_FORWARD_TO  (optional — US number that inbound texts forward to)
 *           SMS_QUIET_START / SMS_QUIET_END (optional, default 8 / 20 — the
 *           Alaska-time window customer-facing texts may send in)
 * Deploy:   supabase functions deploy roybal-notify --no-verify-jwt
 *   (--no-verify-jwt required for browser CORS preflight + the Twilio
 *    webhook; the function self-protects — sendSms runs its DB ops under
 *    the caller's JWT and /inbound demands a valid Twilio signature, so an
 *    unauthenticated caller can never reach a paid Twilio call.)
 *
 * Success (200): { ok:true, sid, status, month_count }
 * Error   (400): { ok:false, error }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { parseApproval, matchProposal, replyText, validateBoardEdit, buildNextSubtasks, revGuard } from "./approve.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_FROM = Deno.env.get("TWILIO_FROM") ?? "";
const SMS_FORWARD_TO = Deno.env.get("SMS_FORWARD_TO") ?? "";
// A non-numeric SMS_MONTHLY_CAP secret (e.g. "500 texts") must NOT silently
// disable the cap — fall back to the 500 default when it isn't a finite
// number. A BLANK secret is the same trap: Deno hands back "" and Number("")
// is 0, which would disable the cap entirely. envNum (below) treats blank as
// unset; this line is kept in sync with it.
const SMS_MONTHLY_CAP = (() => {
  const raw = (Deno.env.get("SMS_MONTHLY_CAP") ?? "").trim();
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 500;
})();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/* ---------- Supabase REST via the caller's token (RLS applies for user
   JWTs; /inbound passes the service-role key AFTER the Twilio signature
   check, since Twilio has no user session) ---------- */
/* ⚠️ New-format Supabase API keys (`sb_secret_…`, `sb_publishable_…`) are NOT
   JWTs. Sending one in Authorization while `apikey` is the legacy anon JWT
   makes PostgREST try to parse the bearer as a JWT, fail, and return 401 —
   which surfaced here as `send-count read failed (401)` from monthCount(),
   thrown BEFORE the sms_messages insert, so nothing was logged and the caller
   saw an opaque 400.

   That is not hypothetical: this project's SUPABASE_SERVICE_ROLE_KEY is now an
   `sb_secret_…` key, so every service-role caller of this function was silently
   unable to send. Pair a new-format token with itself; JWT callers (the phone
   agent's machine session, the field app's user JWT) are unaffected. */
const isNewFormatKey = (t: string) => /^sb_(secret|publishable)_/.test(t);

function db(path: string, token: string, opts: RequestInit = {}, apikey = ANON_KEY) {
  const key = isNewFormatKey(token) ? token : apikey;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

/* +1XXXXXXXXXX for a US / North-American number; empty for anything else.
   We intentionally reject international and malformed input (including a bare
   "+" with the wrong digit count) so a fat-fingered or foreign number can
   never be dialed and billed — every branch here yields a US number or "". */
export function toE164(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 10) return "+1" + digits;                          // 907-371-9868
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits; // 1-907-371-9868 / +1 907...
  return "";                                                               // international / malformed -> rejected
}

/* Truncate by CODE POINT, never mid-surrogate — slicing a UTF-16 string at a
   fixed unit index can split an emoji and corrupt the send. */
const clip = (t: string, n = 1600) => Array.from(t).slice(0, n).join("");

/* ---------- quiet hours ----------
   Customer-facing texts only go out 8am–8pm America/Anchorage — a 6am
   "on our way" or an evening assistant-proposed text waits for morning.
   Crew/office kinds are exempt (the office WANTS a 6am field report,
   and a chip-confirmed evening text to the crew about tomorrow's start
   is the dispatcher's call — assistCrew is user-confirmed by the tap).
   Every unknown kind counts as customer-facing, so a new send path is
   quiet-hours-guarded by default until it's deliberately exempted. */
/* phoneOwner = the phone receptionist's owner alerts — a 2am new-loss
   call MUST reach the owner's cell, so it is quiet-hours exempt. */
const CREW_KINDS = new Set([
  "fieldReport", "forward", "assistCrew", "phoneOwner", "brief",
  // Website lead alerts. A 2am flooding basement should buzz the owner's
  // phone — that is the whole point of a 24/7 restoration business.
  "webOwner", "webLead",
  // Portal access codes (CF-1): a SOLICITED one-time code — the customer just
  // tapped the button, so quiet hours must not eat their own login.
  "portalCode",
]);

/* ---------- the monthly reserve ----------
   SMS_MONTHLY_CAP is ONE shared budget across every lane in the business.
   Before this, a runaway on any lane could spend the last message and
   silently take out the ones the company actually runs on: the phone
   receptionist's owner alerts, inbound forwarding, the morning brief, and
   approve-by-text.

   So the PUBLIC lanes — the two an anonymous stranger on the website can
   reach — are refused once the remaining balance drops to SMS_RESERVE.
   Everything else keeps sending down to zero.

   The split is by who can trigger it, not by importance. A crew member
   texting a customer "on our way" is authenticated and must not be refused
   because the website had a busy afternoon; only webOwner (the AI chat) and
   webLead (the quote form) are reachable without a login. */
const PROTECTED_KINDS = new Set([
  "phoneOwner", "forward", "brief", "assistCrew", "fieldReport",
  // field app + board customer messaging (authenticated callers)
  "onOurWay", "assist", "text", "portal", "reminder",
]);
// portalCode is public by this file's own rule — anyone holding a share token
// can request one — so it respects the reserve floor (its own 232-RPC caps of
// 3/contact/hr + 20/day bound it long before the reserve matters).
const PUBLIC_KINDS = new Set(["webOwner", "webLead", "portalCode"]);

// Owner/crew-directed kinds: their to_number is the OWNER or a crew member,
// never a customer, so they must NOT be stamped onto a customer's contact_id
// (the contact_timeline would show internal notifications on a customer
// thread). Everything else is customer-numbered and stamps on a single match.
const OWNER_KINDS = new Set([
  "brief", "phoneOwner", "webOwner", "webLead", "forward", "assistCrew", "approval",
]);

/* The person behind a phone number: exactly one live contact, or null.
   `q` is a REST caller — `admin` on the inbound service path, a jwt-bound
   closure on the outbound path. kind gates out owner/crew-directed sends. */
async function contactByPhone(
  q: (path: string, opts?: RequestInit) => Promise<Response>,
  digits10: string,
  kind = "",
): Promise<string | null> {
  // portalCode is customer-directed but is OTP plumbing, not conversation —
  // it stays off the contact timeline.
  if (OWNER_KINDS.has(kind) || kind === "portalCode" || digits10.length !== 10) return null;
  try {
    const r = await q(`contacts?select=id&phone_norm=eq.${digits10}&merged_into=is.null&limit=2`, { method: "GET" });
    if (r.ok) {
      const rows = (await r.json()) as Array<{ id: string }>;
      if (rows.length === 1) return rows[0].id;
    }
  } catch (_) { /* the link is optional */ }
  return null;
}

/* A BLANK secret must not disable the cap. Deno returns "" for a secret set to
   an empty value, and Number("") === 0 — which would make `used >= 0` true
   forever, refusing everything, or with the cap at 0 disable it entirely.
   Treat blank exactly like unset. */
const envNum = (name: string, dflt: number) => {
  const raw = (Deno.env.get(name) ?? "").trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const SMS_RESERVE = envNum("SMS_RESERVE", 150);
const qh = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : dflt;
};
const QUIET_START = qh(Deno.env.get("SMS_QUIET_START"), 8);
const QUIET_END = qh(Deno.env.get("SMS_QUIET_END"), 20);
export function anchorageHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Anchorage", hour: "numeric", hourCycle: "h23",
  }).format(d));
}
function assertSendWindow(kind: string) {
  if (CREW_KINDS.has(kind)) return;
  const hr = anchorageHour();
  if (hr >= QUIET_START && hr < QUIET_END) return;
  const fmt = (h: number) => (h === 0 || h === 24 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h}am` : `${h - 12}pm`);
  throw new Error(
    `quiet_hours: customer texts send between ${fmt(QUIET_START)} and ${fmt(QUIET_END)} Alaska time — ` +
    `it's ${fmt(hr === 0 ? 24 : hr)}–${fmt(hr + 1)} there now. It was NOT sent; try again in the window.`);
}

async function monthCount(token: string, apikey = ANON_KEY): Promise<number> {
  const from = new Date();
  from.setUTCDate(1); from.setUTCHours(0, 0, 0, 0);
  const res = await db(
    `sms_messages?select=id&direction=eq.outbound&created_at=gte.${encodeURIComponent(from.toISOString())}`,
    token, { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } }, apikey);
  if (!res.ok) throw new Error(`send-count read failed (${res.status})`);
  const range = res.headers.get("content-range") || "";           // e.g. "0-0/37"
  return Number(range.split("/")[1]) || 0;
}

/* Bare Twilio REST send. Resolves with the parsed outcome; rejects only on a
   network-level failure (DNS/TLS/reset) so callers decide what failure means. */
async function twilioPost(to: string, text: string, media: string[] = []) {
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: clip(text) });
  for (const u of media) form.append("MediaUrl", u);
  const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_AUTH}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const body = (await tw.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: tw.ok, status: tw.status, body };
}

async function sendSms(body: Record<string, unknown>, jwt: string) {
  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM)
    throw new Error("texting_not_configured: set the TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM function secrets");
  const to = toE164(body.to);
  if (!to) throw new Error("Provide `to` as a valid US phone number.");
  const text = String(body.body ?? "").trim();
  if (!text) throw new Error("Provide `body` — the message text.");
  const kind = String(body.kind ?? "text");
  assertSendWindow(kind);
  const media = (Array.isArray(body.mediaUrls) ? body.mediaUrls : [])
    .map((u) => String(u)).filter((u) => /^https:\/\//.test(u)).slice(0, 5);

  // spend guard first — a runaway loop can't burn the account
  const used = await monthCount(jwt);
  if (SMS_MONTHLY_CAP > 0 && used >= SMS_MONTHLY_CAP)
    throw new Error(`sms_cap_reached: ${used} of ${SMS_MONTHLY_CAP} texts this month — raise SMS_MONTHLY_CAP if intended.`);

  // …and the reserve floor: a public lane may not spend the last SMS_RESERVE
  // messages that the phone lane and approve-by-text depend on.
  // ⚠️ Refusal is an explicit allowlist. Adding a new PUBLIC lane means adding
  // it to PUBLIC_KINDS — otherwise it sends down to zero like an internal one.
  if (SMS_MONTHLY_CAP > 0 && PUBLIC_KINDS.has(kind) && used >= SMS_MONTHLY_CAP - SMS_RESERVE)
    throw new Error(
      `sms_reserve_reached: ${used} of ${SMS_MONTHLY_CAP} used — the last ${SMS_RESERVE} are held for ` +
      `the phone lane. Kind '${kind}' is refused until next month or until SMS_MONTHLY_CAP is raised.`,
    );

  // person link: customer-directed kinds stamp the outbound side so the
  // contact_timeline shows both halves of the conversation. Owner/crew kinds
  // are skipped inside contactByPhone. Runs under the caller's JWT (RLS).
  const outContact = await contactByPhone((p, o) => db(p, jwt, o), to.replace(/[^\d]/g, "").slice(-10), kind);

  // RLS-gated insert BEFORE the paid call — unauthenticated callers stop here
  const ins = await db("sms_messages", jwt, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      unified_job_id: body.unified_job_id ?? null,
      contact_id: outContact,
      direction: "outbound", to_number: to, from_number: TWILIO_FROM,
      body: clip(text), kind,
      sent_by: body.captured_by ?? null, status: "pending",
    }]),
  });
  if (!ins.ok) throw new Error(`log insert failed (${ins.status}): ${await ins.text().catch(() => "")}`);
  const row = (await ins.json())[0];

  // mark the row's outcome and never leave it orphaned at "pending"
  const settle = (patch: Record<string, unknown>) =>
    db(`sms_messages?id=eq.${row.id}`, jwt, { method: "PATCH", body: JSON.stringify(patch) }).catch(() => {});

  let r: { ok: boolean; status: number; body: Record<string, unknown> };
  try {
    r = await twilioPost(to, text, media);
  } catch (netErr) {
    // the fetch itself rejected (DNS/TLS/reset) — record the failure so the
    // row isn't stranded at "pending", then surface it to the caller
    await settle({ status: "failed", error: ("network: " + String((netErr as Error)?.message ?? netErr)).slice(0, 500), updated_at: new Date().toISOString() });
    throw new Error("send_failed: could not reach Twilio — the message was not sent");
  }
  const patch = r.ok
    ? { twilio_sid: r.body.sid ?? null, status: r.body.status ?? "sent", updated_at: new Date().toISOString() }
    : { status: "failed", error: String(r.body.message ?? `twilio ${r.status}`).slice(0, 500), updated_at: new Date().toISOString() };
  await settle(patch);
  if (!r.ok) throw new Error(`send_failed: ${patch.error}`);

  return { sid: r.body.sid ?? "", status: r.body.status ?? "sent", month_count: used + 1 };
}

/* ---------- inbound: Twilio incoming-message webhook ---------- */

/* Twilio webhook auth: base64(HMAC-SHA1(auth token, URL + params sorted by
   name)). The URL must be byte-identical to the one configured in Twilio;
   req.url is the URL Twilio actually hit, with the SUPABASE_URL form as a
   fallback in case the edge runtime ever rewrites the host. */
async function twilioSignatureValid(req: Request, params: URLSearchParams): Promise<boolean> {
  const sig = req.headers.get("X-Twilio-Signature") ?? "";
  if (!sig || !TWILIO_AUTH) return false;
  const payload = [...new Set(params.keys())].sort().map((n) => n + (params.get(n) ?? "")).join("");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(TWILIO_AUTH), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  for (const url of new Set([req.url, `${SUPABASE_URL}/functions/v1/roybal-notify/inbound`])) {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url + payload)));
    if (btoa(String.fromCharCode(...mac)) === sig) return true;
  }
  return false;
}

/* ---------- approve-by-text ----------
   A YES/NO from the OWNER'S cell acts on pending_actions proposals (the
   morning brief creates them — see roybal-brief + migration 210). Everything
   here runs AFTER the Twilio signature check, with the service role:
   approval state only ever changes on this verified path. Returns true when
   the text was an approval keyword (handled + replied), false otherwise. */
async function handleApproval(
  from: string, text: string,
  admin: (path: string, opts?: RequestInit) => Promise<Response>,
): Promise<boolean> {
  const owner = toE164(Deno.env.get("OWNER_CELL") ?? SMS_FORWARD_TO ?? "");
  if (!owner || toE164(from) !== owner) return false;
  const p = parseApproval(text);
  if (!p.yes && !p.no) return false;

  const say = async (msg: string) => {
    try {
      const r = await twilioPost(owner, msg);
      await admin("sms_messages", {
        method: "POST",
        body: JSON.stringify([{
          direction: "outbound", to_number: owner, from_number: TWILIO_FROM,
          body: clip(msg), kind: "approval",
          status: r.ok ? (r.body.status ?? "sent") : "failed",
          twilio_sid: r.ok ? (r.body.sid ?? null) : null,
        }]),
      });
    } catch (e) { console.error("approval reply failed", e); }
  };

  const nowIso = new Date().toISOString();
  const live = await admin(
    `pending_actions?status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso)}&order=created_at.desc&limit=20`,
    { method: "GET" });
  const rows = live.ok ? ((await live.json()) as Record<string, unknown>[]) : [];
  const m = matchProposal(rows, p.code);
  if (!m.hit) { await say(replyText(m.reason as "none-open")!); return true; }
  const act = m.hit as Record<string, unknown>;

  if (p.no) {
    await admin(`pending_actions?id=eq.${act.id}&status=eq.pending`, {
      method: "PATCH", body: JSON.stringify({ status: "declined" }),
    });
    await say(replyText("cancelled", act)!);
    return true;
  }

  // approve first (guarded on still-pending — a double YES can't fire twice)…
  const appr = await admin(`pending_actions?id=eq.${act.id}&status=eq.pending`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "approved" }),
  });
  const landed = appr.ok && ((await appr.json().catch(() => [])) as unknown[]).length > 0;
  if (!landed) { await say(replyText("none-open")!); return true; }

  // …then execute by kind. The executor re-verifies the approved row itself.
  try {
    const params = (act.params ?? {}) as Record<string, unknown>;
    if (act.kind === "emailSend") {
      const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
      const r = await fetch(`${SUPABASE_URL}/functions/v1/gmail-proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", "x-cron-secret": cronSecret,
          apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify({ action: "sendEmail", pendingActionId: act.id, ...params }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(String(body.error || `email send failed (${r.status})`));
    } else if (act.kind === "sendText") {
      const to = toE164(params.to);
      if (!to) throw new Error("no valid recipient number on the proposal");
      const r = await twilioPost(to, String(params.message ?? ""));
      if (!r.ok) throw new Error(String(r.body.message ?? `twilio ${r.status}`));
      await admin(`pending_actions?id=eq.${act.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "executed", executed_at: new Date().toISOString(), result: { sid: r.body.sid ?? "" } }),
      });
    } else if (act.kind === "boardEdit") {
      // qb-time proposes a phase for hours it already saw logged; a YES writes
      // it to the board. Rev-guarded like every other board write.
      const { rowId, phase } = validateBoardEdit(params);
      const got = await admin(
        `coordination_jobs?id=eq.${encodeURIComponent(rowId)}&select=id,data,deleted`, { method: "GET" });
      // A lookup that never landed is not a missing job — saying "no longer on
      // the board" would send the owner hunting for a job that's sitting there.
      if (!got.ok) throw new Error("couldn't reach the board just now — text YES again in a minute");
      const row = ((await got.json().catch(() => [])) as Record<string, unknown>[])[0];
      if (!row || row.deleted) throw new Error("that job is no longer on the board");
      const data = (row.data ?? {}) as Record<string, unknown>;
      // Refuse to give an unphased job its FIRST phase. schedule.js treats any
      // job with subtasks as engine-managed, so one text would re-derive a
      // hand-dated job's whole timeline from a single phase and cascade the new
      // dates into everything downstream. That's a board decision, not an SMS.
      if (!Array.isArray(data.subtasks) || !data.subtasks.length) {
        throw new Error("that job has no phases yet — add the first one on the board");
      }

      const stamp = (result: Record<string, unknown>) =>
        admin(`pending_actions?id=eq.${act.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "executed", executed_at: new Date().toISOString(), result }),
        });

      const nextSubtasks = buildNextSubtasks(data.subtasks as Record<string, unknown>[], phase);
      if (!nextSubtasks) {
        // already there (added by hand while this sat) — the owner's intent is
        // satisfied, so this is done, not failed
        await stamp({ rowId, skipped: "phase already exists" });
      } else {
        const base = Number(data.rev) || 0;
        const next = { ...data, subtasks: nextSubtasks, rev: base + 1, updatedAt: new Date().toISOString() };
        const patch = await admin(`coordination_jobs?id=eq.${encodeURIComponent(rowId)}&${revGuard(base)}`, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ data: next }),
        });
        // 0 rows back = someone edited the job first; refusing beats clobbering
        // them, and tomorrow's pull re-proposes the same phase
        const wrote = patch.ok && ((await patch.json().catch(() => [])) as unknown[]).length > 0;
        if (!wrote) throw new Error("the board job changed while this was pending — nothing was added");
        await stamp({ rowId, rev: base + 1, phaseId: phase.id ?? null });
      }
    } else {
      throw new Error(`unknown action kind "${act.kind}"`);
    }
    await say(replyText("done", act)!);
  } catch (e) {
    await admin(`pending_actions?id=eq.${act.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "failed", result: { error: String((e as Error).message).slice(0, 300) } }),
    }).catch(() => {});
    await say(replyText("failed", act, (e as Error).message)!);
  }
  return true;
}

/* Log the reply, optionally forward it to the office, answer empty TwiML
   (empty <Response> = receive without auto-replying to the customer). */
async function handleInbound(req: Request): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  if (!(await twilioSignatureValid(req, params)))
    return new Response("signature mismatch", { status: 403 });

  const from = String(params.get("From") ?? "");
  let text = String(params.get("Body") ?? "").trim();
  const nMedia = Math.min(Number(params.get("NumMedia") ?? "0") || 0, 10);
  for (let i = 0; i < nMedia; i++) {
    const u = params.get(`MediaUrl${i}`);
    if (u) text += (text ? "\n" : "") + "[media] " + u;
  }

  const admin = (path: string, opts: RequestInit = {}) => db(path, SERVICE_KEY, opts, SERVICE_KEY);

  // best-effort links: the PERSON first (contacts by indexed phone_norm,
  // stamped only on an unambiguous single live match — lookup-only, an
  // unknown texter never mints a contact), then the sender's unified job so
  // the field app's Message log can find this reply by JOB, not just number
  const fromDigits = from.replace(/[^\d]/g, "").slice(-10);
  // person link: separate call so a contacts hiccup can't cost the job link.
  // Inbound is always a reply FROM a customer, so no kind gate is needed.
  const contact_id = await contactByPhone(admin, fromDigits);
  let unified_job_id: string | null = null;
  try {
    if (fromDigits.length === 10) {
      const jr = await admin("unified_jobs?select=id,owner_phone&owner_phone=not.is.null&limit=500", { method: "GET" });
      if (jr.ok) {
        const hit = ((await jr.json()) as Array<{ id: string; owner_phone: string }>)
          .find((j) => String(j.owner_phone).replace(/[^\d]/g, "").slice(-10) === fromDigits);
        unified_job_id = hit?.id ?? null;
      }
    }
  } catch (_) { /* the job link is optional — the row still logs by number */ }

  const ins = await admin("sms_messages", {
    method: "POST",
    body: JSON.stringify([{
      unified_job_id,
      contact_id,
      direction: "inbound", to_number: String(params.get("To") ?? ""), from_number: from,
      body: clip(text), kind: "reply", status: "received",
      twilio_sid: params.get("MessageSid") ?? null,
    }]),
  });
  if (!ins.ok) console.error("inbound log insert failed", ins.status, await ins.text().catch(() => ""));

  // approve-by-text: a YES/NO from the owner's cell acts on a proposal and
  // gets its own confirmation text — no need to also forward it
  try {
    if (await handleApproval(from, text, admin)) {
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { "Content-Type": "text/xml" } });
    }
  } catch (e) { console.error("approval handling failed", e); }

  // best-effort forward — never back to the sender (a one-hop echo guard),
  // never past the monthly cap, and a failure still ACKs Twilio with TwiML
  const fwd = toE164(SMS_FORWARD_TO);
  if (fwd && fwd !== toE164(from) && TWILIO_SID && TWILIO_AUTH && TWILIO_FROM) {
    try {
      const used = await monthCount(SERVICE_KEY, SERVICE_KEY);
      if (SMS_MONTHLY_CAP <= 0 || used < SMS_MONTHLY_CAP) {
        const r = await twilioPost(fwd, `${from}: ${text}`);
        // this row is claim documentation AND what monthCount() bills the cap
        // against — a silent insert failure would drift the cap optimistic
        const flog = await admin("sms_messages", {
          method: "POST",
          body: JSON.stringify([{
            unified_job_id,
            direction: "outbound", to_number: fwd, from_number: TWILIO_FROM,
            body: clip(`${from}: ${text}`), kind: "forward",
            status: r.ok ? (r.body.status ?? "sent") : "failed",
            error: r.ok ? null : String(r.body.message ?? `twilio ${r.status}`).slice(0, 500),
            twilio_sid: r.ok ? (r.body.sid ?? null) : null,
          }]),
        });
        if (!flog.ok) console.error("forward log insert failed", flog.status, await flog.text().catch(() => ""));
      } else {
        console.error(`forward skipped: sms_cap_reached (${used}/${SMS_MONTHLY_CAP})`);
      }
    } catch (e) {
      console.error("forward failed", e);
    }
  }

  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { headers: { "Content-Type": "text/xml" } });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  if (/\/inbound\/?$/.test(new URL(req.url).pathname)) return handleInbound(req);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Missing Authorization bearer token" }, 401);
  try {
    const body = (await req.json()) ?? {};
    const action = String(body.action ?? "");
    if (action !== "sendSms") return json({ ok: false, error: "Unknown action. Expected one of: sendSms" }, 400);
    const result = await sendSms(body as Record<string, unknown>, jwt);
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 400);
  }
});
