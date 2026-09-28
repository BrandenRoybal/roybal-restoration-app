/**
 * Magicplan Proxy — Supabase Edge Function (THE SCAN LANE)
 *
 * Magicplan is a capture device, not a system of record
 * (docs/Magicplan_Integration_Design.md §2). The owner scans a room on his
 * phone; this function creates the project ahead of the visit, and after the
 * scan copies the Report PDF, the pinned photos, the measured quantities and
 * the floor SVGs into OUR storage (field-media) and ONE magicplan_exports row.
 * The field app then merges that row into the bid file through its own
 * Store.put — this function NEVER writes field_projects (the Aug-6 clobber
 * lesson; design decision 4). Delete this function and today comes back.
 *
 * THE KEY NEVER REACHES A BROWSER. MAGICPLAN_API_KEY / MAGICPLAN_CUSTOMER_ID
 * live only in this function's secrets and are attached only to requests
 * whose origin is cloud.magicplan.app (attachAuth) — file urls come back on
 * S3 and get no headers at all. The era-0 proxy of the same name shipped
 * verify_jwt=false and no caller check; it was deleted 2026-09-06 and this
 * is not it.
 *
 * Actions (all office — owner/office/admin JWT; no cron, no "user" kind):
 *   getWorkspace   — GET /workspace for the admin Settings panel
 *   createProject  — idempotent: look up by external_reference_id, else POST
 *   status         — GET /projects/{id} → "updated since import" on the Bid card
 *   sync           — design §4.2: files, photos, statistics, SVGs → one row
 *   markImported   — stamp imported_at/imported_by after the phone adopted a row
 *   archiveProject — PUT /projects/{id}/archive (cancelled visit, staging clean-up)
 *   linkExport     — re-run the sync into the job the office picked for an
 *                    unmatched row; refuses a project bound to another job
 *
 * AUTH — the per-action gate, copied from gmail-proxy (findings F-003):
 *   verify_jwt=true is NOT a caller check — the gateway admits the publishable
 *   key committed in apps/field/js/config.js. Every action is declared in
 *   ACTION_AUTH below and checked BEFORE dispatch, default-deny: an action
 *   missing from the table is refused, so a new one cannot ship ungated.
 *   Regression guard: supabase/functions/qb-time-proxy/authgate.test.mjs.
 *
 * ONE SHAPE PER CALL: every parser in ./magicplan.ts accepts exactly the live
 * response shape (ctx: OpenAPI 3.1.1, API v1.2) and throws otherwise. No
 * "several known shapes" — that sentence is why the old proxy went away.
 *
 * Secrets: MAGICPLAN_API_KEY, MAGICPLAN_CUSTOMER_ID (both required → 503
 *          when missing, checked after the gate so an unauthenticated caller
 *          cannot probe configuration), MAGICPLAN_PROJECT_EMAIL (the owner's
 *          one Magicplan seat; create/archive refuse without it),
 *          MAGICPLAN_NAME_PREFIX ("[STAGING] " on staging, empty on prod).
 *
 * Deploy: .github/workflows/fn-deploy.yml → magicplan-proxy
 *         (CLI: supabase functions deploy magicplan-proxy --project-ref <ref>)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  MP_BASE, MpConflict, type MpEnv, type Io, type ExportRow,
  mpHeaders, shouldRetry, retryDelayMs, errorMessage,
  validateSyncInput, validateProjectId, validateExportInput, validateCreateInput,
  parseWorkspace, createProject, getStatus, archiveProject, syncPlan,
} from "./magicplan.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const ok = (data: unknown) => json({ ok: true, data });
const err = (message: string, status = 400) => json({ ok: false, error: message }, status);

function serviceDb() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/* ============================================================
   The per-action gate — F-003 (gmail-proxy recipe, office only)
   ============================================================ */
const OFFICE_ROLES = ["admin", "office", "owner"];   // both vocabularies until 0007's cutover completes

/** Which callers each action admits. DEFAULT-DENY: an action that is not
    listed here is refused before dispatch (see authorize), so adding a new
    action to the handler without a line here fails closed instead of open.
    Every Magicplan action spends the company's metered project quota or
    reads a customer's scan — office only, no exceptions. */
type AuthKind = "office";
const ACTION_AUTH: Record<string, AuthKind[]> = {
  getWorkspace: ["office"],
  createProject: ["office"],
  status: ["office"],
  sync: ["office"],
  markImported: ["office"],
  archiveProject: ["office"],
  linkExport: ["office"],
};

/** The caller's bearer token, or "" when it is not a user JWT at all. The
    published publishable key (config.js:8) and the legacy anon key both get
    past the gateway, so they are rejected here by shape: an identity is a
    three-segment JWT, never a publishable or secret API key. */
function userJwt(req: Request): string {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === Deno.env.get("SUPABASE_ANON_KEY")) return "";
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? token : "";
}

/** Who is calling? { uid, role, email } for a real signed-in user, nulls
    otherwise. getUser on the service-role client first (does not depend on
    SUPABASE_ANON_KEY, which the legacy-JWT sunset made unreliable); the REST
    probe is the fallback. The email is what markImported stamps. */
async function callerIdentity(
  req: Request,
  sb: ReturnType<typeof serviceDb>,
): Promise<{ uid: string | null; role: string | null; email: string | null }> {
  const token = userJwt(req);
  if (!token) return { uid: null, role: null, email: null };
  let uid: string | null = null, email: string | null = null;
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (!error && data?.user?.id) { uid = String(data.user.id); email = data.user.email ? String(data.user.email).toLowerCase() : null; }
  } catch (_) { /* fall through to the REST probe */ }
  if (!uid) {
    try {
      const u = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
        headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: `Bearer ${token}` },
      });
      if (u.ok) {
        const body = await u.json().catch(() => null);
        uid = body?.id ?? null;
        email = body?.email ? String(body.email).toLowerCase() : null;
      }
    } catch (_) { /* stays anonymous */ }
  }
  if (!uid) return { uid: null, role: null, email: null };
  try {
    const { data } = await sb.from("profiles").select("role").eq("id", uid).maybeSingle();
    return { uid, role: data?.role ? String(data.role) : null, email };
  } catch (_) { return { uid, role: null, email }; }
}

/** The gate. Returns a refusal Response, or the caller it resolved. */
async function authorize(
  action: string,
  req: Request,
  sb: ReturnType<typeof serviceDb>,
): Promise<{ deny: Response | null; uid: string | null; role: string | null; email: string | null }> {
  const allowed = ACTION_AUTH[action];
  if (!allowed) return { deny: err(`Unknown action: ${action}`, 404), uid: null, role: null, email: null };
  const { uid, role, email } = await callerIdentity(req, sb);
  if (!uid) return { deny: err("Sign in to use Magicplan", 401), uid: null, role: null, email: null };
  if (!role || !OFFICE_ROLES.includes(role)) return { deny: err("Not authorized — office or owner only", 403), uid, role, email };
  return { deny: null, uid, role, email };
}

/* ============================================================
   Secrets and the transport (the only I/O in this function)
   ============================================================ */

/** The four secrets. Names only ever reach a log or a response — never values. */
function mpEnv(): MpEnv {
  const key = Deno.env.get("MAGICPLAN_API_KEY") ?? "";
  const customer = Deno.env.get("MAGICPLAN_CUSTOMER_ID") ?? "";
  if (!key || !customer) {
    throw new Error("Magicplan is not configured on this Supabase project — set MAGICPLAN_API_KEY and MAGICPLAN_CUSTOMER_ID");
  }
  return {
    key, customer,
    projectEmail: Deno.env.get("MAGICPLAN_PROJECT_EMAIL") ?? "",
    prefix: Deno.env.get("MAGICPLAN_NAME_PREFIX") ?? "",
  };
}

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

/** The Io bag magicplan.ts runs against. Everything that touches the network
    or the database is here and nowhere else. */
function makeIo(sb: ReturnType<typeof serviceDb>, env: MpEnv): Io {
  return {
    api: async (path, init) => {
      const headers: Record<string, string> = { ...mpHeaders(env), Accept: "application/json" };
      if (init?.body) headers["Content-Type"] = "application/json";
      let attempt = 0;
      for (;;) {
        const res = await fetch(MP_BASE + path, { method: init?.method ?? "GET", headers, body: init?.body });
        if (shouldRetry(res.status, attempt)) {
          // Magicplan's limit is 500 requests / 5 min; one polite wait, then the pure side fails loud
          attempt++;
          await res.body?.cancel().catch(() => {});
          await new Promise((r) => setTimeout(r, retryDelayMs(res.headers.get("retry-after"))));
          continue;
        }
        const text = await res.text();
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        return { status: res.status, json: body };
      }
    },
    download: async (url, headers) => {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        throw new Error(errorMessage(res.status, body));
      }
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "" };
    },
    sha256: async (bytes) => toHex(await crypto.subtle.digest("SHA-256", bytes)),
    upload: async (path, bytes, contentType) => {
      // the same bucket and prefix the Site Visit panel uploads to; upsert so a re-pull of the same bytes is a no-op
      const { error } = await sb.storage.from("field-media").upload(path, bytes, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
    },
    priorRows: async (planId) => {
      const { data, error } = await sb.from("magicplan_exports").select("files,photos,floors_svg")
        .eq("mp_plan_id", planId).in("status", ["ready", "imported"])
        .order("synced_at", { ascending: false }).limit(20);
      if (error) throw new Error(`magicplan_exports read failed: ${error.message}`);
      return (data ?? []) as ExportRow[];
    },
    insertRow: async (row) => {
      const { data, error } = await sb.from("magicplan_exports").insert(row).select().single();
      if (error) throw new Error(`magicplan_exports insert failed: ${error.message}`);
      return data as ExportRow;
    },
    updateRow: async (id, patch) => {
      const { data, error } = await sb.from("magicplan_exports").update(patch).eq("id", id).select().single();
      if (error) throw new Error(`magicplan_exports update failed: ${error.message}`);
      return data as ExportRow;
    },
    now: () => new Date().toISOString(),
  };
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* ============================================================
   Main handler
   ============================================================ */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = serviceDb();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const action = body.action as string;

  // ── the gate (F-003) — before any dispatch, default-deny ────────────────
  let caller: { uid: string | null; email: string | null };
  try {
    const gate = await authorize(action, req, supabase);
    if (gate.deny) return gate.deny;
    caller = gate;
  } catch (e) {
    // an identity lookup that throws must refuse, never fall through open
    return err(msg(e, "Authorization failed"), 401);
  }

  // ── secrets — after the gate (no configuration probing), before dispatch ─
  let env: MpEnv;
  try { env = mpEnv(); } catch (e) { return err(msg(e, "Magicplan is not configured"), 503); }
  const io = makeIo(supabase, env);

  /* Status mapping for every action: a validation throw is the caller's
     fault (400); MpConflict is a real answer (409); anything the Magicplan
     API or storage threw is upstream (502). */
  const upstream = (e: unknown) => (e instanceof MpConflict ? err(e.message, 409) : err(msg(e, "Magicplan request failed"), 502));

  try {
    // ── getWorkspace ──────────────────────────────────────────────────────
    if (action === "getWorkspace") {
      try {
        const { status, json: ws } = await io.api("/workspace");
        if (status < 200 || status >= 300) return err(errorMessage(status, ws), 502);
        const w = parseWorkspace(ws);
        return ok({ ...w, prefix: env.prefix, projectEmail: env.projectEmail });
      } catch (e) { return upstream(e); }
    }

    // ── createProject ─────────────────────────────────────────────────────
    if (action === "createProject") {
      let input;
      try { input = validateCreateInput(body); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      if (!env.projectEmail) return err("MAGICPLAN_PROJECT_EMAIL is not set on this server", 500);
      try { return ok(await createProject(io, env, input)); } catch (e) { return upstream(e); }
    }

    // ── status ────────────────────────────────────────────────────────────
    if (action === "status") {
      let projectId: string;
      try { projectId = validateProjectId(body.projectId); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      try { return ok(await getStatus(io, env, projectId)); } catch (e) { return upstream(e); }
    }

    // ── sync ──────────────────────────────────────────────────────────────
    if (action === "sync") {
      let input;
      try { input = validateSyncInput(body); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      // a `failed` row is already written by syncPlan before it re-throws; the phone gets the message as a toast
      try { return ok(await syncPlan(io, env, input)); } catch (e) { return upstream(e); }
    }

    // ── markImported ──────────────────────────────────────────────────────
    if (action === "markImported") {
      let input;
      try { input = validateExportInput(body); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      const { data: row, error } = await supabase.from("magicplan_exports")
        .select("id, field_project_id, imported_at").eq("id", input.exportId).maybeSingle();
      if (error) throw new Error(`magicplan_exports read failed: ${error.message}`);
      if (!row) return err("Export not found", 404);
      if (row.field_project_id !== input.fieldProjectId) return err("That export belongs to another job", 409);
      if (row.imported_at) return ok({ ok: true, already: true });
      const { error: updErr } = await supabase.from("magicplan_exports").update({
        imported_at: new Date().toISOString(),
        imported_by: caller.email || caller.uid,
        status: "imported",
      }).eq("id", input.exportId);
      if (updErr) throw new Error(`magicplan_exports update failed: ${updErr.message}`);
      return ok({ ok: true });
    }

    // ── archiveProject ────────────────────────────────────────────────────
    if (action === "archiveProject") {
      let projectId: string;
      try { projectId = validateProjectId(body.projectId); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      if (!env.projectEmail) return err("MAGICPLAN_PROJECT_EMAIL is not set on this server", 500);
      try {
        const { archivedAt } = await archiveProject(io, env, projectId);
        return ok({ ok: true, archivedAt });
      } catch (e) { return upstream(e); }
    }

    // ── linkExport ────────────────────────────────────────────────────────
    if (action === "linkExport") {
      let input;
      try { input = validateExportInput(body); } catch (e) { return err(msg(e, "Invalid input"), 400); }
      const { data: row, error } = await supabase.from("magicplan_exports")
        .select("id, mp_project_id, status").eq("id", input.exportId).maybeSingle();
      if (error) throw new Error(`magicplan_exports read failed: ${error.message}`);
      if (!row) return err("Export not found", 404);
      if (row.status !== "unmatched") return err("Only an unmatched export can be linked", 409);
      // link mode: only a hand-started scan (empty external_reference_id) may be bound to the chosen job;
      // the same row flips unmatched → ready in place, so the admin list never shows a ghost
      try {
        const updated = await syncPlan(io, env, { projectId: String(row.mp_project_id), fieldProjectId: input.fieldProjectId },
          { linkMode: true, updateRowId: String(row.id) });
        return ok(updated);
      } catch (e) { return upstream(e); }
    }

    return err(`Unknown action: ${action}`, 404);
  } catch (e) {
    return err(msg(e, "Internal error"), 500);
  }
});
