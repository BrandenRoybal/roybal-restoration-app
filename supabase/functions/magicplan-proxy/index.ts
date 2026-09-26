/**
 * Magicplan Proxy — Supabase Edge Function (docs/Magicplan_Integration_Design.md)
 *
 * The only place the company's Magicplan key is used. The field app and the
 * admin call this with the user's session; this calls the Magicplan Cloud
 * API v2 and writes two things, both under the service role:
 *   - files in the existing field-media bucket, at the Site Visit panel's own
 *     path shape (sitevisit/<job>/mp-<hash8>-<name>), and
 *   - rows in public.magicplan_exports (migration 0010).
 * It NEVER writes field_projects. The field app reads a ready row and merges
 * it into the job itself (design decision 4 — no second write door).
 *
 * Actions (all office: owner/office, both role vocabularies — doc 09 §1.2):
 *   getWorkspace   — GET /workspace, for the admin Settings panel
 *   createProject  — find-or-create the Magicplan project for a bid file
 *                    (idempotent: name search + external_reference_id first)
 *   status         — GET /projects/{id}: user_modified, archived_at, plan_id
 *   sync           — design §4.2: files + photos + statistics + floor SVGs
 *                    copied in, one magicplan_exports row written
 *   markImported   — stamp imported_at/imported_by once the field app adopted
 *   archiveProject — PUT /projects/{id}/archive (a cancelled visit, a staging
 *                    test project)
 *   linkExport     — the Settings panel's "Link to job" for an unmatched row:
 *                    re-sync that scan onto the job the office picked
 *
 * AUTH: the default-deny ACTION_AUTH gate from gmail-proxy (findings F-003).
 * verify_jwt=true only proves the caller holds SOME key — the publishable key
 * ships in the browser — so every action is also checked here, before
 * dispatch, and an action missing from the table is refused.
 * Regression guard: supabase/functions/qb-time-proxy/authgate.test.mjs.
 *
 * Secrets: MAGICPLAN_API_KEY, MAGICPLAN_CUSTOMER_ID, MAGICPLAN_PROJECT_EMAIL
 *          (the one seat — §6 ruling 1), MAGICPLAN_NAME_PREFIX ("[STAGING] "
 *          on staging, empty on production — §6 ruling 7).
 *
 * Deploy: supabase functions deploy magicplan-proxy --project-ref <ref>
 *         (verify_jwt pinned true in supabase/config.toml)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  MP_BASE, mpHeaders, mpErrorText, retryDelayMs, createProjectBody, projectName, projectOf, findOurs,
  workspaceOf, runSync, isSitePath, type ExportRow,
} from "./magicplan.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const MEDIA_BUCKET = "field-media";

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
type Db = ReturnType<typeof serviceDb>;

/* ============================================================
   The per-action gate — copied from gmail-proxy (F-003)
   ============================================================ */
const OFFICE_ROLES = ["admin", "office", "owner"];
// both vocabularies until migration 0007's cutover completes (docs/architecture/09 §1.2)

/** DEFAULT-DENY: an action not listed here is refused before dispatch. */
type AuthKind = "user" | "office" | "cron";
const ACTION_AUTH: Record<string, AuthKind[]> = {
  getWorkspace: ["office"],
  createProject: ["office"],
  status: ["office"],
  sync: ["office"],
  markImported: ["office"],
  archiveProject: ["office"],
  linkExport: ["office"],
};

/** The caller's bearer token, or "" when it is not a user JWT at all (the
    publishable key and the legacy anon key are rejected by shape). */
function userJwt(req: Request): string {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === Deno.env.get("SUPABASE_ANON_KEY")) return "";
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? token : "";
}

async function callerIdentity(req: Request, sb: Db): Promise<{ uid: string | null; email: string; role: string | null }> {
  const token = userJwt(req);
  if (!token) return { uid: null, email: "", role: null };
  let uid: string | null = null, email = "";
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (!error && data?.user?.id) { uid = String(data.user.id); email = String(data.user.email || ""); }
  } catch (_) { /* stays anonymous */ }
  if (!uid) return { uid: null, email: "", role: null };
  try {
    const { data } = await sb.from("profiles").select("role").eq("id", uid).maybeSingle();
    return { uid, email, role: data?.role ? String(data.role) : null };
  } catch (_) { return { uid, email, role: null }; }
}

async function authorize(action: string, req: Request, sb: Db) {
  const allowed = ACTION_AUTH[action];
  if (!allowed) return { deny: err(`Unknown action: ${action}`, 404), email: "" };
  const { uid, email, role } = await callerIdentity(req, sb);
  if (!uid) return { deny: err("Sign in to use Magicplan", 401), email: "" };
  const passes = allowed.includes("user") || (allowed.includes("office") && !!role && OFFICE_ROLES.includes(role));
  if (!passes) return { deny: err("Not authorized — office or owner only", 403), email };
  return { deny: null, email };
}

/* ============================================================
   Magicplan transport
   ============================================================ */
function secrets() {
  const key = Deno.env.get("MAGICPLAN_API_KEY") ?? "";
  const customer = Deno.env.get("MAGICPLAN_CUSTOMER_ID") ?? "";
  if (!key || !customer) throw new Error("Magicplan isn't set up on this project yet (MAGICPLAN_API_KEY / MAGICPLAN_CUSTOMER_ID)");
  return {
    key, customer,
    email: Deno.env.get("MAGICPLAN_PROJECT_EMAIL") ?? "",
    prefix: Deno.env.get("MAGICPLAN_NAME_PREFIX") ?? "",
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Magicplan call. 429 → one backoff retry, then fail loud. The error
    text names the call, never the key. */
async function mpCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const s = secrets();
  const what = `${method} ${path.split("?")[0]}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(MP_BASE + path, {
      method, headers: mpHeaders(s.key, s.customer, body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) { await sleep(retryDelayMs(res.headers.get("retry-after"))); continue; }
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(mpErrorText(res.status, parsed, what));
    return parsed;
  }
}

/** A file Magicplan hosts. Its own API paths (floor SVGs) need our key; the
    report/photo URLs are pre-signed and take no headers. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const s = secrets();
  const own = url.startsWith(MP_BASE) || url.startsWith("https://cloud.magicplan.app/");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, own ? { headers: { key: s.key, customer: s.customer } } : {});
    if (res.status === 429 && attempt === 0) { await sleep(retryDelayMs(res.headers.get("retry-after"))); continue; }
    if (!res.ok) throw new Error(`Couldn't download a Magicplan file (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

async function sha256(bytes: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   Sync — design §4.2 (the algorithm lives in magicplan.ts runSync)
   ============================================================ */
async function syncInto(sb: Db, projectId: string, fieldProjectId: string, trustLink = false) {
  let row: ExportRow;
  try {
    row = await runSync({
      mp: (p) => mpCall("GET", p),
      fetchBytes, sha256,
      upload: async (path, bytes, mime) => {
        if (!isSitePath(path)) throw new Error("not a site-visit path");
        const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
        if (error) throw new Error(`Storage upload failed for ${path.split("/").pop()}: ${error.message}`);
      },
      priorRows: async (planId) => {
        const { data } = await sb.from("magicplan_exports").select("files, photos")
          .eq("mp_plan_id", planId).in("status", ["ready", "imported"]).order("received_at", { ascending: false }).limit(5);
        return data ?? [];
      },
      now: () => new Date().toISOString(),
    }, { projectId, fieldProjectId, trustLink });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.from("magicplan_exports").insert({
      mp_project_id: projectId, mp_plan_id: "", field_project_id: fieldProjectId || null,
      status: "failed", error: message.slice(0, 1000),
    });
    throw e;
  }
  const { data, error } = await sb.from("magicplan_exports").insert(row).select().single();
  if (error) throw new Error(`Couldn't record the scan: ${error.message}`);
  return data;
}

const safeJob = (v: unknown) => /^[A-Za-z0-9_-]{1,80}$/.test(String(v ?? ""));

/* ============================================================
   Main handler
   ============================================================ */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = serviceDb();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }
  const action = String(body.action ?? "");

  // ── the gate — before any dispatch, default-deny ────────────────────────
  let caller = "";
  try {
    const gate = await authorize(action, req, sb);
    if (gate.deny) return gate.deny;
    caller = gate.email;
  } catch (e) {
    return err(e instanceof Error ? e.message : "Authorization failed", 401);
  }

  try {
    // ── getWorkspace ──────────────────────────────────────────────────────
    if (action === "getWorkspace") {
      const w = workspaceOf(await mpCall("GET", "/workspace"));
      return ok({ ...w, prefix: secrets().prefix, projectEmailSet: !!secrets().email });
    }

    // ── createProject ─────────────────────────────────────────────────────
    if (action === "createProject") {
      const fieldProjectId = String(body.fieldProjectId ?? "");
      if (!safeJob(fieldProjectId)) return err("fieldProjectId is missing or malformed");
      const s = secrets();
      if (!s.email) return err("MAGICPLAN_PROJECT_EMAIL isn't set on this project");
      const address = (body.address && typeof body.address === "object" ? body.address : {}) as Record<string, unknown>;
      const name = s.prefix + projectName(body.customer, address.street);
      const found = findOurs(await mpCall("GET", `/projects?name=${encodeURIComponent(name)}&page_size=50`), fieldProjectId);
      const p = found
        ? projectOf(await mpCall("GET", `/projects/${encodeURIComponent(found)}`))
        : projectOf(await mpCall("POST", "/projects", createProjectBody({ fieldProjectId, customer: String(body.customer ?? ""), address }, s.email, s.prefix)), "create project");
      return ok({ projectId: p.id, planId: p.planId, cloudUrl: p.cloudUrl, createdAt: p.createdAt, existed: !!found });
    }

    // ── status ────────────────────────────────────────────────────────────
    if (action === "status") {
      const p = projectOf(await mpCall("GET", `/projects/${encodeURIComponent(String(body.projectId ?? ""))}`));
      return ok({ externalReferenceId: p.externalReferenceId, userModified: p.userModified, archivedAt: p.archivedAt, planId: p.planId });
    }

    // ── sync ──────────────────────────────────────────────────────────────
    if (action === "sync") {
      const fieldProjectId = String(body.fieldProjectId ?? "");
      if (!safeJob(fieldProjectId)) return err("fieldProjectId is missing or malformed");
      return ok(await syncInto(sb, String(body.projectId ?? ""), fieldProjectId));
    }

    // ── markImported ──────────────────────────────────────────────────────
    if (action === "markImported") {
      const { data, error } = await sb.from("magicplan_exports")
        .update({ status: "imported", imported_at: new Date().toISOString(), imported_by: caller || null })
        .eq("id", String(body.exportId ?? "")).eq("field_project_id", String(body.fieldProjectId ?? ""))
        .in("status", ["ready", "imported"]).select("id");
      if (error) return err(error.message, 500);
      if (!data || !data.length) return err("No such scan for this job", 404);
      return ok({ ok: true });
    }

    // ── archiveProject ────────────────────────────────────────────────────
    if (action === "archiveProject") {
      const s = secrets();
      const p = projectOf(await mpCall("PUT", `/projects/${encodeURIComponent(String(body.projectId ?? ""))}/archive`,
        s.email ? { acting_user: s.email } : {}), "archive");
      return ok({ ok: true, archivedAt: p.archivedAt });
    }

    // ── linkExport ────────────────────────────────────────────────────────
    if (action === "linkExport") {
      const fieldProjectId = String(body.fieldProjectId ?? "");
      if (!safeJob(fieldProjectId)) return err("Pick a job to link it to");
      const { data: row } = await sb.from("magicplan_exports").select("id, mp_project_id, status")
        .eq("id", String(body.exportId ?? "")).maybeSingle();
      if (!row || row.status !== "unmatched") return err("That scan isn't waiting for a job", 404);
      const ready = await syncInto(sb, String(row.mp_project_id), fieldProjectId, true);
      await sb.from("magicplan_exports").update({ field_project_id: fieldProjectId }).eq("id", row.id);
      return ok(ready);
    }

    return err(`Unknown action: ${action}`, 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 502);
  }
});
