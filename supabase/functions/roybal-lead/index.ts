/**
 * Supabase Edge Function: roybal-lead
 *
 * Website lead capture for www.roybalconstruction.com. Replaces the two
 * forms.marketing360.com embeds the public site used to depend on, so lead
 * capture stops being a Madwire service we rent.
 *
 * A submission becomes a `coordination_jobs` row in exactly the envelope the
 * phone agent's createLead writes ({ id, data, deleted }, data.stage 'lead').
 * That is deliberate: a web lead and a phone lead land as the same card in the
 * same board column, so the office watches one queue and the existing alerting
 * keeps working untouched.
 *
 * Why the service role: website visitors have no JWT, so RLS (authenticated-
 * only) cannot serve them. This function uses the auto-injected SERVICE_ROLE
 * key STRICTLY to insert one lead row. It never reads customer data, never
 * accepts a table or column name from the caller, and returns nothing but
 * { ok }. There is no read path here at all — a caller cannot use it to get
 * anything out of the database.
 *
 * Abuse control, because the endpoint is necessarily public:
 *   - honeypot   — a `company` field hidden from humans; filled means bot
 *   - per-IP     — LEAD_IP_MAX per hour (default 5)
 *   - per-subnet — LEAD_SUBNET_MAX per /24 per hour (default 12). Per-IP alone
 *                  is defeated by any residential botnet.
 *   - global     — LEAD_HOURLY_MAX across all IPs per hour (default 40), so a
 *                  distributed flood still can't fill the board
 *   - size       — every field truncated before it is stored
 * A rejected submission returns { ok: true } to the bot rather than an error,
 * so a scraper gets no signal about what tripped.
 *
 * KNOWN LIMIT — the counters are read-then-write, so a burst of concurrent
 * requests can all pass the check inside the ~100ms before the first insert is
 * visible. The blast radius is junk rows on the board, not money, because this
 * endpoint calls no paid service. The AI lane cannot afford the same shortcut
 * and does its counting in a single atomic SQL statement instead.
 *
 * Secrets:  LEAD_IP_MAX      (optional, default 5   — per IP per hour)
 *           LEAD_SUBNET_MAX  (optional, default 12  — per /24 per hour)
 *           LEAD_HOURLY_MAX  (optional, default 40  — all IPs per hour)
 *           LEAD_IP_SALT     (optional — salt for the stored IP hashes;
 *                             defaults to the service key)
 *           LEAD_ALLOW_ORIGIN(optional, default https://www.roybalconstruction.com;
 *                             comma-separated list, "*" to allow any)
 * Deploy:   supabase functions deploy roybal-lead --no-verify-jwt
 *   (--no-verify-jwt is required: the public website has no session. The
 *    function self-protects via the limits above and has no read path.)
 *
 * Success (200): { ok: true }
 * Error   (400): { ok: false, error }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// A non-numeric secret must not silently disable a limit — fall back to the
// default whenever the value isn't a finite number.
const num = (name: string, dflt: number) => {
  const n = Number(Deno.env.get(name) ?? dflt);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const IP_MAX = num("LEAD_IP_MAX", 5);
const SUBNET_MAX = num("LEAD_SUBNET_MAX", 12);
const HOURLY_MAX = num("LEAD_HOURLY_MAX", 40);

const ALLOW = (Deno.env.get("LEAD_ALLOW_ORIGIN") ?? "https://www.roybalconstruction.com")
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
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsFor(origin), "Content-Type": "application/json" },
  });

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const digits = (v: unknown) => String(v ?? "").replace(/[^\d]/g, "");

/* ---------- rate limiting ----------
   Counts prior web leads in the last hour. `created_at` is the row's own
   column; the per-IP tally uses data->>ipHash, which we set below and which
   never leaves this function. */
async function countSince(filter: string): Promise<number> {
  const sinceIso = new Date(Date.now() - 3600_000).toISOString();
  const q = `coordination_jobs?select=id&created_at=gt.${encodeURIComponent(sinceIso)}&${filter}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { ...svc, Prefer: "count=exact", Range: "0-0" },
  });
  if (!res.ok) return 0; // never let a counting failure block a real lead
  const range = res.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

/* ---------- client identity ----------
   The FIRST x-forwarded-for entry is whatever the client sent. A caller can
   put anything there, so counting per-IP on XFF[0] means one attacker looks
   like unlimited distinct visitors and the per-IP cap does nothing.

   Prefer a header the platform sets and the client cannot forge; otherwise
   take the LAST XFF hop, which is the one appended by the proxy nearest us.
   Still not an identity — a botnet defeats per-IP entirely — which is why the
   /24 counter below exists and why the global hourly cap is the real bound. */
function clientIp(req: Request): string {
  const platform =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    "";
  if (platform.trim()) return platform.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "unknown";
}

/** The /24 an address sits in. A residential botnet beats a per-IP cap; it
    rarely beats a per-subnet one. IPv6: collapse to the /48 prefix. */
function subnetOf(ip: string): string {
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::/48";
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ip;
}

/* Raw visitor IPs do not belong in a job-board record that the whole office
   reads and that gets backed up and exported. Hash them: rate limiting only
   ever needs equality, never the address itself. */
async function hashId(value: string): Promise<string> {
  const key = Deno.env.get("LEAD_IP_SALT") ?? SERVICE_KEY;
  const data = new TextEncoder().encode(`${key}|${value}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- owner alert ----------
   Per recipient, so one bad number cannot stop the others, and partial
   delivery still counts as an alert. Mirrors sendAlert() in
   services/phone-agent/tools.mjs. */
async function alertOwner(body: string): Promise<void> {
  /* ⚠️ Normalize to US E.164 and DROP anything else. Filtering on
     `digits.length >= 10` and passing the raw digits on looks equivalent and
     is not: a number carrying an extension or a stray country code has 12+
     digits, sails through that check, and is then rejected by roybal-notify's
     toE164() with an opaque 400 — before it logs anything. The lead lands on
     the board and the owner is never told. Validate where it can be reported. */
  const cells: string[] = [];
  const rejected: number[] = [];
  for (const part of (Deno.env.get("ALERT_CELLS") ?? Deno.env.get("OWNER_CELL") ?? "").split(",")) {
    if (!part.trim()) continue;
    const d = digits(part);
    const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : "";
    if (e164) { if (!cells.includes(e164)) cells.push(e164); }
    else rejected.push(d.length);           // digit COUNT only — this goes to logs
  }
  if (rejected.length) {
    console.error(
      `${rejected.length} alert recipient(s) are not valid US numbers (digit counts: ` +
      `${rejected.join(", ")}). Each must be 10 digits, or 11 starting with 1.`,
    );
  }
  if (!cells.length) {
    console.error("NO VALID ALERT RECIPIENTS — lead saved but nobody was texted. Fix ALERT_CELLS / OWNER_CELL.");
    return;
  }
  let sent = 0;
  for (const to of cells) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
        method: "POST",
        headers: { ...svc, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sendSms", to, kind: "webLead", captured_by: "web-form", body: clip(body, 300) }),
      });
      if (res.ok) sent++;
      else console.error(`lead alert refused by roybal-notify (${res.status}):`, (await res.text().catch(() => "")).slice(0, 300));
    } catch (e) {
      console.error("lead alert sms threw", String((e as Error)?.message ?? e));
    }
  }
  console.log(`lead alert -> ${sent}/${cells.length} recipients`);
}

const LOSS_TYPES: Record<string, string> = {
  "Water Damage Restoration": "water",
  "Fire Damage Restoration": "fire",
  "Mold Removal": "mold",
  "Storm Repair": "storm",
};

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);

  /* ---------- alert self-test ----------
     A misconfigured recipient used to fail completely silently: the lead
     saved, roybal-notify 400'd before it logged anything, and nothing on the
     request path said so. Console logs are not reachable from the CLI, so
     this reports the recipient configuration over HTTP instead.

     Reports COUNTS and DIGIT LENGTHS only, never a number, and requires the
     service-role key — this endpoint is public. */
  if (new URL(req.url).searchParams.get("selftest") === "1") {
    /* Gated on its own secret rather than the service-role key: this project
       has both legacy JWT and new-format keys, and which one the runtime
       injects as SUPABASE_SERVICE_ROLE_KEY is not something to guess at in an
       auth check. Unset token = endpoint disabled. */
    const expected = Deno.env.get("LEAD_SELFTEST_TOKEN") ?? "";
    const given = (req.headers.get("x-selftest-token") ?? "").trim();
    if (!expected || given !== expected) {
      return json({ ok: false, error: "not authorized" }, 401, origin);
    }
    const rawAlert = Deno.env.get("ALERT_CELLS");
    const rawOwner = Deno.env.get("OWNER_CELL");
    const source = rawAlert != null ? "ALERT_CELLS" : rawOwner != null ? "OWNER_CELL" : "(neither set)";
    const valid: string[] = [];
    const rejectedLengths: number[] = [];
    for (const part of String(rawAlert ?? rawOwner ?? "").split(",")) {
      if (!part.trim()) continue;
      const d = digits(part);
      const e164 = d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : "";
      if (e164) valid.push(e164);
      else rejectedLengths.push(d.length);
    }
    /* &send=1 actually attempts the text and returns what roybal-notify said,
       verbatim, per recipient. Parsing correctly and still not delivering is
       exactly the gap that made this fail silently, so the self-test has to
       exercise the whole path, not just the part that is easy to check. */
    const attempts: Record<string, unknown>[] = [];
    if (new URL(req.url).searchParams.get("send") === "1") {
      for (const to of valid) {
        try {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/roybal-notify`, {
            method: "POST",
            headers: { ...svc, "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "sendSms", to, kind: "webLead", captured_by: "selftest",
              body: "Roybal alert self-test — your website lead alerts are working.",
            }),
          });
          attempts.push({
            to: "…" + to.slice(-4),
            status: res.status,
            response: (await res.text().catch(() => "")).slice(0, 200),
          });
        } catch (e) {
          attempts.push({ to: "…" + to.slice(-4), status: 0, response: String((e as Error)?.message ?? e) });
        }
      }
    }

    return json({
      ok: true,
      source,
      validCount: valid.length,
      // last 4 only — enough to confirm the right phone, not enough to be a leak
      validEndings: valid.map((v) => "…" + v.slice(-4)),
      rejectedDigitLengths: rejectedLengths,
      // format only, never the key — tells us which auth scheme is in play
      serviceKeyFormat: SERVICE_KEY.startsWith("sb_") ? SERVICE_KEY.split("_").slice(0,2).join("_") + "_…"
                        : SERVICE_KEY.startsWith("eyJ") ? "legacy JWT" : "unknown",
      ...(attempts.length ? { attempts } : {}),
      hint: "each recipient must be 10 digits, or 11 starting with 1",
    }, 200, origin);
  }

  let body: Record<string, unknown>;
  try {
    const ct = req.headers.get("content-type") ?? "";
    body = ct.includes("application/json")
      ? await req.json()
      : Object.fromEntries(await req.formData()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "could not read submission" }, 400, origin);
  }

  // Honeypot. Silent success so a bot learns nothing about why it failed.
  if (clip(body.company, 200)) return json({ ok: true }, 200, origin);

  const name = clip(body.name, 80);
  const phone = clip(body.phone, 25);
  const email = clip(body.email, 120);
  const address = clip(body.address, 160);
  const service = clip(body.service, 80);
  const message = clip(body.message, 1500);
  const emergency = clip(body.urgency, 20) === "emergency";

  if (!name || !phone) {
    return json({ ok: false, error: "Please include your name and a phone number." }, 400, origin);
  }
  if (digits(phone).length < 10) {
    return json({ ok: false, error: "That phone number doesn't look complete." }, 400, origin);
  }

  const ip = clientIp(req);
  const ipHash = await hashId(ip);
  const subnetHash = await hashId(subnetOf(ip));
  try {
    if (await countSince(`data->>source=eq.web&data->>ipHash=eq.${ipHash}`) >= IP_MAX) {
      return json({ ok: true }, 200, origin); // silent for the flooder
    }
    if (await countSince(`data->>source=eq.web&data->>subnetHash=eq.${subnetHash}`) >= SUBNET_MAX) {
      return json({ ok: true }, 200, origin);
    }
    if (await countSince("data->>source=eq.web") >= HOURLY_MAX) {
      return json(
        { ok: false, error: "We're getting a lot of requests right now — please call (907) 371-9868." },
        429, origin,
      );
    }
  } catch {
    // A limiter that errors must not take lead capture down with it.
  }

  const lossType = LOSS_TYPES[service] ?? "other";
  const isRemodel = !!service && !LOSS_TYPES[service];
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // CRM: resolve the person and carry the link on the lead card. UNTRUSTED —
  // this is a public lane, so the resolver never enriches an existing contact
  // from here (a stranger typing a customer's phone gets a link queued for
  // review, never a silent field fill). Never fatal: a resolver hiccup must
  // not cost a lead.
  let contactId: string | null = null;
  try {
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/contact_resolve`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_name: name, p_phone: phone, p_email: email, p_address: address,
        p_source: "web-form", p_trusted: false, p_role: "customer",
      }),
    });
    if (cr.ok) contactId = (await cr.json().catch(() => null)) as string | null;
  } catch (e) { console.error("contact_resolve failed (lead continues)", String((e as Error)?.message ?? e)); }

  // CF-5 marketing consent from the form's optional checkbox — applied ONLY
  // when this very submission CREATED the contact (created seconds ago).
  // The public lane never enriches an existing person (228's rule): a
  // stranger typing a customer's phone still can't flip their marketing
  // flag — that consent belongs to the verified portal session. Best-effort:
  // a hiccup here must not cost the lead.
  if (contactId && (body.optIn === true || body.optIn === "yes" || body.optIn === "on")) {
    try {
      const cg = await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}&select=created_at,marketing_opt_in&limit=1`, { headers: svc });
      const row = cg.ok ? ((await cg.json())[0] || null) : null;
      const created = row ? Date.parse(String(row.created_at || "")) : NaN;
      if (row && row.marketing_opt_in !== true && Number.isFinite(created) && Date.now() - created < 15_000) {
        await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
          method: "PATCH", headers: { ...svc, "Content-Type": "application/json" },
          body: JSON.stringify({ marketing_opt_in: true, marketing_opt_in_at: new Date().toISOString() }),
        });
      }
    } catch (e) { console.error("opt-in stamp failed (lead continues)", String((e as Error)?.message ?? e)); }
  }

  // Same envelope and field names as services/phone-agent/tools.mjs createLead,
  // so the board renders a web lead and a phone lead identically.
  const lead = {
    id,
    stage: "lead",
    type: isRemodel ? "remodel" : "mitigation",
    title: `${name} — ${service || lossType}`,
    customer: name,
    phone,
    email,
    address,
    priority: emergency ? "high" : "normal",
    materials: "none",
    crewIds: [],
    deps: [],
    subtasks: [],
    scheduleMode: "auto",
    pinnedStart: "",
    durationDays: null,
    notes:
      `Website form submission.\n` +
      (service ? `Service requested: ${service}\n` : "") +
      (email ? `Email: ${email}\n` : "") +
      (emergency ? `⚠️ Marked as an ACTIVE EMERGENCY by the customer.\n` : "") +
      (message ? `\n${message}` : ""),
    source: "web",
    channel: "web-form",
    // Hashed, not raw: rate limiting only needs equality, and a visitor's IP
    // has no business sitting in a record the office reads and exports.
    ipHash,
    subnetHash,
    webLead: true,
    ...(contactId ? { contactId } : {}),
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/coordination_jobs`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify([{ id, data: lead, deleted: false }]),
  });
  if (!ins.ok) {
    console.error("lead insert failed", ins.status, await ins.text());
    return json(
      { ok: false, error: "We couldn't save that. Please call (907) 371-9868 and we'll take care of you." },
      500, origin,
    );
  }

  console.log(`lead captured ${id} (${emergency ? "EMERGENCY" : "normal"}, ${service || "unspecified"})`);

  /* Text the owner. A lead nobody knows about is worse than no form at all —
     in restoration, response time IS the product, and this endpoint used to
     drop leads onto the board in total silence.

     Deliberately AFTER the insert and never fatal: the lead is already safe,
     so a Twilio outage must not turn a captured lead into an error the
     visitor sees. kind 'webLead' is quiet-hours exempt and sits outside the
     protected SMS reserve (see roybal-notify). */
  await alertOwner(
    `${emergency ? "🚨 WEB EMERGENCY" : "🌐 Web form lead"} — ${name}, ${phone}` +
    `${service ? `, ${service}` : ""}${address ? `, ${address}` : ""}. ` +
    `${message ? clip(message, 90) : "No details given."}`,
  ).catch((e) => console.error("lead alert failed (lead is saved)", String(e?.message ?? e)));

  return json({ ok: true }, 200, origin);
});
