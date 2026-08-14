/**
 * Supabase Edge Function: roybal-portal
 *
 * The customer portal's read + messaging gateway. Customers hold no login —
 * they present the share token from their link, and this function returns
 * ONLY that job's curated slice from `portal_jobs`, with short-lived signed
 * URLs for the shared photos, and lets them read/post messages on that job's
 * thread (`portal_messages`).
 *
 * Why the service role: customers have no JWT, so RLS (authenticated-only)
 * can't serve them. This function uses the auto-injected SERVICE_ROLE key
 * STRICTLY to (a) read the single row whose share_token matches, (b) sign
 * that row's media, and (c) read/insert messages for THAT job only. It never
 * runs arbitrary queries and returns only customer-safe data — the
 * unguessable token is the credential. Deployed `--no-verify-jwt` (public).
 *
 * Actions:
 *   view     — { token } -> { ok, job, photos, documents, unread }
 *   messages — { token } -> { ok, messages:[{id,from,body,at,channel}] }
 *              (also marks outbound messages as seen by the customer)
 *   send     — { token, body } -> { ok, message:{id,from,body,at} }
 *   selections        — { token } -> { ok, selections:[…], total, answered, remaining, complete }
 *                       The customer's decision sheet, published by the office from
 *                       the approved estimate. Projected through selections.ts's
 *                       allow-list: our loaded prices and the Xactimate Cat/Sel
 *                       codes are on the row and never cross this boundary.
 *   respondSelection  — { token, selectionId, choice:'match'|'change', note? } -> the sheet
 *   submitSelections  — { token } -> the sheet + submittedAt. Stamps the job and
 *                       posts a note to the thread so a finished sheet lands where
 *                       the office already watches for customer activity.
 *   ask      — { token, body } -> { ok, posted, answered, handoff, reply }
 *              The customer concierge: posts the question, then answers it
 *              instantly from the customer-safe slice + thread, or hands off
 *              to the office. This is the ONLY place this public endpoint
 *              calls a paid LLM, so it is fenced by three limits — a
 *              per-minute flood guard, a per-job daily answer cap
 *              (CONCIERGE_DAILY_MAX), and the account monthly spend cap
 *              (SPEND_CAP_USD) — and every call is logged to ai_usage. The
 *              model is handed ONLY the curated portal_jobs digest, so it
 *              physically cannot reveal anything the customer shouldn't see.
 *              Requires the LLM_API_KEY secret (shared with roybal-ai-office).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { customerSheet, validateResponse, submissionMessage } from "./selections.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MEDIA_BUCKET = "field-media";
const PHOTO_MAX = 24;    // max full images inlined in a view response
const DOC_MAX = 6;       // max shared documents in a view response
const DOC_PAGE_MAX = 8;  // max inlined pages per document
const MSG_MAX = 2000;    // max characters a customer may send in one message
const MSG_LIMIT = 200;   // most-recent messages returned per thread
const FLOOD_WINDOW_MS = 60_000;  // inbound-message rate window
const FLOOD_MAX = 8;             // max inbound messages per window per job

/* ---------- concierge (customer-facing AI) config ----------
   The concierge answers routine questions instantly, grounded ONLY in the
   customer-safe portal_jobs slice + the thread, and hands off anything it
   can't ground. It is the one place this public endpoint calls a paid LLM,
   so it is fenced by three limits: the per-minute flood guard (below), a
   per-job daily answer cap, and the account-wide monthly spend cap. */
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";                      // Anthropic (shared secret)
const CONCIERGE_MODEL = Deno.env.get("CONCIERGE_MODEL") ?? "claude-sonnet-4-6";   // customer-facing + public: fast + cost-controlled
const SPEND_CAP_USD = Number(Deno.env.get("SPEND_CAP_USD") ?? "50");
const CONCIERGE_DAILY_MAX = Number(Deno.env.get("CONCIERGE_DAILY_MAX") ?? "40"); // AI answers/job/24h
const LLM_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};
const priceFor = (m: string) => LLM_PRICES[m] ?? { in: 1.0, out: 5.0 };
const HANDOFF_LINE =
  "Thanks for your message! I've passed this along to the Roybal Construction team and they'll get back to you soon. " +
  "If it's urgent, please call us at 907-371-9868.";

/* ---------- CF-1 contact sessions (accounts) ----------
   "My projects" without a DB credential: the customer proves possession of
   the phone ALREADY ON FILE (a 6-digit texted code) and receives a long
   bearer session, hashed at rest in contact_sessions. The gateway then
   accepts {session, jobId} anywhere it accepts a job token — resolved
   server-side to that job's own share_token, which never leaves the server
   in a session response. Rate caps + attempt counters live in the 232 RPCs. */
const SESSION_TTL_DAYS = Number(Deno.env.get("PORTAL_SESSION_TTL_DAYS") ?? "180");
const CODE_HOURLY_MAX = Number(Deno.env.get("PORTAL_CODE_HOURLY_MAX") ?? "3");
const CODE_DAILY_MAX = Number(Deno.env.get("PORTAL_CODE_DAILY_MAX") ?? "20");

const sha256Hex = async (s: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const randHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const randCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
const goodSession = (t: string) => /^[0-9a-f]{64}$/.test(t);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

const goodToken = (t: string) => /^[0-9a-f]{16,}$/.test(t);

/* the single enabled portal_jobs row for this token (service role; token-gated) */
async function jobByToken(token: string) {
  const q = `portal_jobs?share_token=eq.${encodeURIComponent(token)}&enabled=eq.true` +
    `&select=id,contact_id,customer_name,property_address,status,milestones,photos,documents,drying,selections_submitted_at&limit=1`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

/* the image for one field-media object (by content hash = path). Sync stores
   each photo as its ORIGINAL `data:` URL string (text/plain), so a signed
   storage URL would hand the <img> a text file, not an image. We instead
   fetch the object and return the data URL itself, which <img src> renders
   natively. Returns null when the object is missing or isn't an image. */
async function mediaSrc(hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(String(hash || ""))) return null;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${hash}`, { headers: svc });
  if (!res.ok) return null;
  const text = await res.text();
  return text.startsWith("data:image/") ? text : null;
}

/* count of inbound messages the customer hasn't-yet been the concern of —
   here we surface the count of office replies the customer hasn't read, for
   a subtle "new reply" hint on the portal. */
async function unreadForCustomer(jobId: string): Promise<number> {
  const q = `portal_messages?portal_job_id=eq.${jobId}&direction=eq.out&read_by_customer=eq.false&select=id`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = res.headers.get("content-range") || "";
  const n = Number(cr.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

async function view(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  const photos: Array<{ url: string; caption: string; stage: string }> = [];
  // Cap how many full images we inline so the response stays reasonable on a
  // phone; the office shares a handful of progress photos in practice.
  for (const p of (Array.isArray(row.photos) ? row.photos : []).slice(0, PHOTO_MAX)) {
    const url = await mediaSrc(p.mediaHash);
    if (url) photos.push({ url, caption: p.caption || "", stage: p.stage || "" });
  }
  // documents (CF-2): office-picked supporting-doc pages, served through the
  // same content-addressed media path as photos. Caps keep the payload sane.
  const documents: Array<{ label: string; type: string; pages: string[] }> = [];
  for (const d of (Array.isArray(row.documents) ? row.documents : []).slice(0, DOC_MAX)) {
    const pages: string[] = [];
    for (const hash of (Array.isArray(d.pages) ? d.pages : []).slice(0, DOC_PAGE_MAX)) {
      const url = await mediaSrc(hash);
      if (url) pages.push(url);
    }
    if (pages.length) documents.push({ label: String(d.label || "Document").slice(0, 120), type: String(d.type || "").slice(0, 60), pages });
  }
  // drying (CF-2): readings only, re-projected through an explicit allow-list —
  // a field added to the stored blob later cannot leak by being forgotten here.
  const dr = row.drying && typeof row.drying === "object" ? row.drying : null;
  const drying = dr ? {
    asOf: String(dr.asOf || "").slice(0, 10),
    areas: (Array.isArray(dr.areas) ? dr.areas : []).slice(0, 12).map((a: Record<string, unknown>) => ({
      area: String(a.area || "").slice(0, 80),
      material: String(a.material || "").slice(0, 60),
      current: Number(a.current),
      goal: a.goal == null ? null : Number(a.goal),
      dry: !!a.dry,
    })).filter((a: { current: number }) => Number.isFinite(a.current)),
    equipmentOut: Number(dr.equipmentOut) || 0,
  } : null;
  return {
    job: {
      customerName: row.customer_name || "",
      address: row.property_address || "",
      status: row.status || "",
      milestones: Array.isArray(row.milestones) ? row.milestones : [],
    },
    photos,
    documents,
    drying: drying && (drying.areas.length || drying.equipmentOut) ? drying : null,
    unread: await unreadForCustomer(row.id),
  };
}

/* the job's thread, oldest-first, mapped to customer-safe shape. Reading the
   thread marks the office's outbound messages as seen by the customer. */
async function messages(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  const q = `portal_messages?portal_job_id=eq.${row.id}` +
    `&select=id,direction,author,body,channel,created_at&order=created_at.asc&limit=${MSG_LIMIT}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) throw new Error(`thread failed (${res.status})`);
  const rows = await res.json();

  // mark office->customer messages as read now that the customer is viewing them
  await fetch(
    `${SUPABASE_URL}/rest/v1/portal_messages?portal_job_id=eq.${row.id}&direction=eq.out&read_by_customer=eq.false`,
    { method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ read_by_customer: true }) },
  ).catch(() => {});

  return {
    messages: (Array.isArray(rows) ? rows : []).map((m: Record<string, unknown>) => ({
      id: m.id,
      from: m.direction === "in" ? "you" : "office",   // customer's point of view
      body: String(m.body ?? ""),
      at: m.created_at,
      channel: m.channel,
    })),
  };
}

/* count rows matching a portal_messages filter (service role, exact count) */
async function countMessages(filter: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/portal_messages?${filter}&select=id`, {
    headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
  });
  const n = Number((res.headers.get("content-range") || "").split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

/* per-minute inbound flood guard (throws rate_limited) */
async function floodGuard(jobId: string) {
  const sinceIso = new Date(Date.now() - FLOOD_WINDOW_MS).toISOString();
  const recent = await countMessages(`portal_job_id=eq.${jobId}&direction=eq.in&created_at=gt.${encodeURIComponent(sinceIso)}`);
  if (recent >= FLOOD_MAX) throw new Error("rate_limited");
}

/* insert one message row; returns the saved row */
async function insertMessage(m: Record<string, unknown>) {
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/portal_messages`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify([m]),
  });
  if (!ins.ok) throw new Error(`insert failed (${ins.status})`);
  return (await ins.json())[0] || {};
}

/* ---------- customer selections ----------
   The office publishes a sheet of decisions (portal_selections) off the
   approved estimate. The customer may read their own sheet and answer each
   decision — keep what was there, or ask to change it. Every query is
   pinned to the portal_job_id resolved from the token, and everything the
   customer sees goes through customerSelection()'s allow-list, so our cost
   basis and the Xactimate codes never cross the boundary. */

async function selectionsFor(jobId: string) {
  const q = `portal_selections?portal_job_id=eq.${jobId}` +
    `&select=selection_id,sort_order,type,label,scope,room,rooms,title,descr,qty,unit,items,` +
    `customer_choice,customer_note,responded_at&order=sort_order.asc`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) throw new Error(`selections read failed (${res.status})`);
  return customerSheet(await res.json());
}

async function selections(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  // submittedAt has to ride along, or a customer who already sent their
  // choices comes back after a reload to a sheet that looks unsent.
  return { ...(await selectionsFor(row.id)), submittedAt: row.selections_submitted_at || null };
}

/* one decision answered */
async function respondSelection(token: string, selectionId: unknown, choice: unknown, note: unknown) {
  if (!goodToken(token)) throw new Error("bad_token");
  const v = validateResponse(selectionId, choice, note);
  const row = await jobByToken(token);
  if (!row) return null;
  await floodGuard(row.id);

  // Scoped to this job AND this decision — a token can never touch another job's sheet.
  const q = `portal_selections?portal_job_id=eq.${row.id}&selection_id=eq.${encodeURIComponent(v.id)}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    method: "PATCH",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      customer_choice: v.choice,
      customer_note: v.note,
      responded_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
  const saved = await res.json();
  if (!Array.isArray(saved) || !saved.length) throw new Error("bad_selection");

  /* Changing an answer after sending un-sends the sheet: the office was told
     one thing and the customer now means another, so it needs re-sending
     rather than quietly diverging. The design leans on people being free to
     change their mind, so this path has to be a normal one, not an error. */
  if (row.selections_submitted_at) {
    await fetch(`${SUPABASE_URL}/rest/v1/portal_jobs?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ selections_submitted_at: null }),
    }).catch(() => { /* the answer is saved either way */ });
  }
  return { ...(await selectionsFor(row.id)), submittedAt: null };
}

/* the customer is done — stamp the job and tell the office on the thread,
   so a finished sheet shows up where they already look for customer activity */
async function submitSelections(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  await floodGuard(row.id);
  const sheet = await selectionsFor(row.id);
  if (!sheet.total) throw new Error("nothing_to_submit");
  if (!sheet.complete) throw new Error("incomplete");

  const at = new Date().toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/portal_jobs?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ selections_submitted_at: at }),
  }).catch(() => { /* the answers are saved; the stamp is bookkeeping */ });

  await insertMessage({
    portal_job_id: row.id, direction: "in", channel: "portal", author: "customer",
    body: submissionMessage(sheet), read_by_office: false, read_by_customer: true,
  }).catch(() => { /* same — never fail a submit because the notice didn't post */ });

  return { ...sheet, submittedAt: at };
}

/* month-to-date AI spend across the account (service role) */
async function monthSpend(): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ai_usage?select=cost_usd&billing_month=eq.${month}`, { headers: svc });
  if (!res.ok) return 0;   // fail-open on read; the daily cap + flood guard still fence abuse
  return ((await res.json().catch(() => [])) as Array<{ cost_usd: number }>).reduce((a, r) => a + (Number(r.cost_usd) || 0), 0);
}

/* record concierge spend on the shared ai_usage ledger (service role) */
async function logConciergeUsage(jobId: string, inTok: number, outTok: number, cost: number, capped: boolean) {
  await insertRowSvc("ai_usage", {
    form_key: "portalAsk", captured_by: "portal-concierge", provider: capped ? "none" : "anthropic",
    llm_model: capped ? null : CONCIERGE_MODEL, input_tokens: inTok, output_tokens: outTok,
    llm_cost_usd: cost, cost_usd: cost, capped, note: `portal_job ${jobId}`,
  }).catch(() => {});
}
async function insertRowSvc(table: string, row: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([row]),
  });
}

/* Anthropic forced tool-call — returns the structured input + token usage. */
async function conciergeAnswer(digest: unknown, thread: Array<{ from: string; body: string }>, question: string):
  Promise<{ answerable: boolean; message: string; inTok: number; outTok: number }> {
  if (!LLM_API_KEY) throw new Error("llm_key_missing");
  const threadText = thread.slice(-12).map((m) => `${m.from === "customer" ? "CUSTOMER" : "ROYBAL"}: ${m.body.slice(0, 600)}`).join("\n") || "(none yet)";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CONCIERGE_MODEL,
      max_tokens: 600,
      system:
        "You are the friendly virtual assistant on the customer project portal for Roybal Construction, LLC (a family water/fire " +
        "restoration and reconstruction company in North Pole / Fairbanks, Alaska). You are chatting with the CUSTOMER about THEIR job. " +
        "You may use ONLY the JOB FACTS and MESSAGE THREAD provided — nothing else. Answer routine questions: what their current status " +
        "means, what each milestone is, what generally comes next, and what the shared photos show.\n" +
        "SET answerable=false (do not attempt an answer) whenever a good answer would need information you were NOT given — a specific " +
        "completion or visit DATE, any PRICE / cost / estimate / deductible, INSURANCE or claim or adjuster details, scheduling or " +
        "rescheduling a visit, or any promise, commitment, or decision. Never guess, never invent dates or numbers, never quote policy. " +
        "When unsure, choose answerable=false. When answerable=true, write a warm, brief reply (1-4 sentences, plain language, no " +
        "signature). Call `respond`.",
      messages: [{ role: "user", content:
        `JOB FACTS (all you may use):\n\`\`\`json\n${JSON.stringify(digest)}\n\`\`\`\n\n` +
        `MESSAGE THREAD (oldest to newest):\n${threadText}\n\n` +
        `The customer just asked:\n"${question.slice(0, MSG_MAX)}"` }],
      tools: [{
        name: "respond", description: "Return whether you can answer from the facts, and the answer if so.",
        input_schema: {
          type: "object", additionalProperties: false, required: ["answerable", "message"],
          properties: {
            answerable: { type: "boolean", description: "true only if the JOB FACTS/THREAD fully support a correct answer" },
            message: { type: "string", description: "the reply to the customer when answerable; empty string otherwise" },
          },
        },
      }],
      tool_choice: { type: "tool", name: "respond" },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`llm_failed (${res.status})`);
  const data = JSON.parse(raw);
  const block = (data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "respond");
  const inp = (block?.input ?? {}) as { answerable?: boolean; message?: string };
  const u = data.usage ?? {};
  return {
    answerable: inp.answerable === true, message: String(inp.message ?? ""),
    inTok: Number(u.input_tokens) || 0, outTok: Number(u.output_tokens) || 0,
  };
}

/* the customer posts a message onto their job's thread (inbound). */
async function send(token: string, bodyText: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const text = (bodyText || "").trim();
  if (!text) throw new Error("empty");
  if (text.length > MSG_MAX) throw new Error("too_long");
  const row = await jobByToken(token);
  if (!row) return null;
  await floodGuard(row.id);
  const saved = await insertMessage({
    portal_job_id: row.id, direction: "in", channel: "portal", author: "customer",
    body: text, read_by_office: false, read_by_customer: true,
  });
  return { message: { id: saved.id, from: "you", body: text, at: saved.created_at } };
}

/* the customer asks a question — posted to the thread, then the concierge
   answers instantly from the customer-safe slice, or hands off to the office.
   Every branch leaves an auditable trail: the question always lands in the
   thread; handoffs stay unread for the office; answers are logged + visible. */
async function ask(token: string, bodyText: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const text = (bodyText || "").trim();
  if (!text) throw new Error("empty");
  if (text.length > MSG_MAX) throw new Error("too_long");
  const row = await jobByToken(token);
  if (!row) return null;
  await floodGuard(row.id);

  // customer question always goes on the thread first
  const q = await insertMessage({
    portal_job_id: row.id, direction: "in", channel: "portal", author: "customer",
    body: text, read_by_office: false, read_by_customer: true,
  });

  // customer-safe digest (portal_jobs already holds only curated fields)
  const digest = {
    customerName: row.customer_name || "", status: row.status || "",
    milestones: (Array.isArray(row.milestones) ? row.milestones : []).map((m: Record<string, unknown>) => ({ label: m.label, state: m.state })),
    sharedPhotos: (Array.isArray(row.photos) ? row.photos : []).map((p: Record<string, unknown>) => ({ caption: p.caption || "", stage: p.stage || "" })),
  };

  // recent thread for context (customer POV)
  const tRes = await fetch(`${SUPABASE_URL}/rest/v1/portal_messages?portal_job_id=eq.${row.id}&select=direction,body&order=created_at.asc&limit=${MSG_LIMIT}`, { headers: svc });
  const tRows = tRes.ok ? await tRes.json() : [];
  const thread = (Array.isArray(tRows) ? tRows : []).map((m: Record<string, unknown>) => ({ from: m.direction === "in" ? "customer" : "office", body: String(m.body ?? "") }));

  // GUARDRAILS before any paid call: daily per-job cap, then monthly spend cap
  const dayIso = new Date(Date.now() - 86_400_000).toISOString();
  const answersToday = await countMessages(`portal_job_id=eq.${row.id}&author=eq.ai&created_at=gt.${encodeURIComponent(dayIso)}`);
  const overDaily = answersToday >= CONCIERGE_DAILY_MAX;
  const spent = await monthSpend();
  const overMonthly = SPEND_CAP_USD > 0 && spent >= SPEND_CAP_USD;

  const handoff = async (reason: "capped" | "handoff", inTok = 0, outTok = 0, cost = 0) => {
    // the question stays unread for the office (needs a human)
    const a = await insertMessage({
      portal_job_id: row.id, direction: "out", channel: "portal", author: "ai",
      body: HANDOFF_LINE, read_by_office: true, read_by_customer: true,
    });
    await logConciergeUsage(row.id, inTok, outTok, cost, reason === "capped");
    return { posted: { id: q.id }, answered: false, handoff: true, reply: { id: a.id, from: "office", body: HANDOFF_LINE, at: a.created_at } };
  };

  if (overDaily || overMonthly) return handoff("capped");
  if (!LLM_API_KEY) return handoff("capped");

  let ai;
  try { ai = await conciergeAnswer(digest, thread, text); }
  catch (_) { return handoff("handoff"); }   // any LLM hiccup → graceful handoff

  const price = priceFor(CONCIERGE_MODEL);
  const cost = Math.max(0, (ai.inTok / 1e6) * price.in + (ai.outTok / 1e6) * price.out);

  if (!ai.answerable || !ai.message.trim()) {
    // leave the question unread for the office so a human follows up
    await fetch(`${SUPABASE_URL}/rest/v1/portal_messages?id=eq.${q.id}`, {
      method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ read_by_office: false }),
    }).catch(() => {});
    return handoff("handoff", ai.inTok, ai.outTok, cost);
  }

  // answered: post the reply, mark the question handled (still visible for audit)
  const a = await insertMessage({
    portal_job_id: row.id, direction: "out", channel: "portal", author: "ai",
    body: ai.message.trim(), read_by_office: true, read_by_customer: true,
  });
  await fetch(`${SUPABASE_URL}/rest/v1/portal_messages?id=eq.${q.id}`, {
    method: "PATCH", headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ read_by_office: true }),
  }).catch(() => {});
  await logConciergeUsage(row.id, ai.inTok, ai.outTok, cost, false);
  return { posted: { id: q.id }, answered: true, handoff: false, reply: { id: a.id, from: "office", body: ai.message.trim(), at: a.created_at } };
}

/* ---------- CF-1 account actions ---------- */

/* the contact behind an ACTIVE session token, or null */
async function sessionContact(session: string): Promise<{ contactId: string } | null> {
  if (!goodSession(session)) return null;
  const th = await sha256Hex(session);
  const q = `contact_sessions?token_hash=eq.${th}&revoked_at=is.null&expires_at=gt.now&select=contact_id&limit=1`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) return null;
  const row = (await res.json())[0];
  return row ? { contactId: String(row.contact_id) } : null;
}

/* {session, jobId} → that job's own share_token — ONLY when the job belongs
   to the session's contact. The token stays server-side; the client never
   receives it from a session flow. */
async function tokenForSession(session: string, jobId: string): Promise<string | null> {
  const sc = await sessionContact(session);
  if (!sc || !/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const q = `portal_jobs?id=eq.${jobId}&contact_id=eq.${sc.contactId}&enabled=eq.true&select=share_token&limit=1`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) return null;
  const row = (await res.json())[0];
  return row ? String(row.share_token) : null;
}

/* "save this to my account" — text a code to the phone ON FILE (never a
   number the visitor typed; decision 5's identity bar). Degrades politely:
   sent:false is a normal outcome, not an error. */
async function requestAccess(token: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  const row = await jobByToken(token);
  if (!row) return null;
  if (!row.contact_id) return { sent: false, reason: "no_account" };
  const cres = await fetch(
    `${SUPABASE_URL}/rest/v1/contacts?id=eq.${row.contact_id}&merged_into=is.null&select=phone_norm,name&limit=1`,
    { headers: svc });
  const c = cres.ok ? (await cres.json())[0] : null;
  if (!c || String(c.phone_norm || "").length !== 10) return { sent: false, reason: "no_phone" };

  const code = randCode();
  const masked = "•••-" + String(c.phone_norm).slice(-4);
  const begin = await fetch(`${SUPABASE_URL}/rest/v1/rpc/portal_access_begin`, {
    method: "POST", headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ p_contact: row.contact_id, p_channel: "sms", p_dest: masked,
      p_code_hash: await sha256Hex(code), p_hourly: CODE_HOURLY_MAX, p_daily: CODE_DAILY_MAX }),
  });
  const sessionId = begin.ok ? await begin.json() : null;
  if (!sessionId) return { sent: false, reason: "try_later" };

  const send = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
    method: "POST", headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendSms", to: c.phone_norm, kind: "portalCode", captured_by: "portal-gateway",
      body: `Roybal Construction: your project portal code is ${code}. It expires in 10 minutes. Didn't request this? Ignore it.` }),
  });
  if (!send.ok) return { sent: false, reason: "try_later" };
  return { sent: true, dest: masked };
}

/* code → long-lived session. The raw session token is returned exactly once. */
async function verifyAccess(token: string, code: string) {
  if (!goodToken(token)) throw new Error("bad_token");
  if (!/^\d{6}$/.test(code)) return { verified: false };
  const row = await jobByToken(token);
  if (!row) return null;
  if (!row.contact_id) return { verified: false };
  const session = randHex(32);
  const ver = await fetch(`${SUPABASE_URL}/rest/v1/rpc/portal_access_verify`, {
    method: "POST", headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify({ p_contact: row.contact_id, p_code_hash: await sha256Hex(code),
      p_token_hash: await sha256Hex(session), p_ttl_days: SESSION_TTL_DAYS, p_max_attempts: 5 }),
  });
  const ok = ver.ok && (await ver.json()) === true;
  return ok ? { verified: true, session } : { verified: false };
}

/* every enabled job for the session's contact — the "My projects" list.
   Share tokens are deliberately NOT included. */
async function myProjects(session: string) {
  const sc = await sessionContact(session);
  if (!sc) return null;
  const q = `portal_jobs?contact_id=eq.${sc.contactId}&enabled=eq.true` +
    `&select=id,property_address,status,milestones,updated_at&order=updated_at.desc&limit=24`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: svc });
  if (!res.ok) return null;
  const rows = await res.json();
  return {
    projects: (Array.isArray(rows) ? rows : []).map((r: Record<string, unknown>) => ({
      jobId: r.id,
      address: String(r.property_address || "Your project"),
      status: String(r.status || ""),
      statusLabel: (Array.isArray(r.milestones) ? r.milestones as Array<Record<string, unknown>> : [])
        .find((m) => m.state === "current")?.label || "",
      updated: String(r.updated_at || "").slice(0, 10),
    })),
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "view");
    let token = String(body.token ?? "").trim();
    const session = String(body.session ?? "").trim();

    // CF-1: a session + jobId is as good as that job's own token — resolved
    // here, once, server-side. Every action below stays token-shaped.
    if (!token && session && body.jobId) {
      token = (await tokenForSession(session, String(body.jobId))) ?? "";
      if (!token) return json({ ok: false, error: "not_found" }, 404);
    }

    let result: unknown = null;
    if (action === "myProjects") result = await myProjects(session);
    else if (action === "requestAccess") result = await requestAccess(token);
    else if (action === "verifyAccess") result = await verifyAccess(token, String(body.code ?? "").trim());
    else if (action === "view") result = await view(token);
    else if (action === "messages") result = await messages(token);
    else if (action === "send") result = await send(token, String(body.body ?? ""));
    else if (action === "ask") result = await ask(token, String(body.body ?? ""));
    else if (action === "selections") result = await selections(token);
    else if (action === "respondSelection") result = await respondSelection(token, body.selectionId, body.choice, body.note);
    else if (action === "submitSelections") result = await submitSelections(token);
    else return json({ ok: false, error: "Unknown action" }, 400);

    if (result === null) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const code = msg === "rate_limited" ? 429 : msg === "too_long" || msg === "empty" ? 422 : 400;
    return json({ ok: false, error: msg }, code);
  }
});
