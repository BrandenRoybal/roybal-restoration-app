/**
 * QuickBooks Time Proxy — Supabase Edge Function
 *
 * Handles all OAuth token exchange/refresh and QB Time API calls
 * server-side so the Client Secret is never exposed to the browser.
 *
 * Actions:
 *   exchangeCode   — swap auth code for access/refresh tokens
 *   getStatus      — check connection status
 *   disconnect     — delete stored tokens
 *   syncJobcodes   — fetch jobcodes from QB Time and upsert to DB
 *   getTimesheets  — get time entries for a jobcode / date range
 *   getUsers       — list employees
 *   getCurrentTotals — who is currently clocked in
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// QuickBooks Time (TSheets) OAuth 2.0 — its OWN server, not QuickBooks Online's.
// Token exchange/refresh put client_id/secret in the form body (no Basic auth,
// no Intuit oauth.platform endpoint). No `scope`; no `realmId`.
const QB_TOKEN_URL = "https://rest.tsheets.com/api/v1/grant";
const QB_TIME_BASE = "https://rest.tsheets.com/api/v1";
const QB_TIME_REALM = "tsheets"; // single-company placeholder for the token row key

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return json({ ok: true, data });
}

function err(message: string, status = 400) {
  return json({ ok: false, error: message }, status);
}

async function qbFetch(
  path: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<unknown> {
  const res = await fetch(`${QB_TIME_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB Time API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Local wall-clock "HH:MM" from a QB timestamp like 2020-03-08T09:00:00-08:00.
    We intentionally read the string, not a Date, to preserve the time the crew
    actually saw on the clock (no UTC conversion). */
function hhmm(ts: string | undefined): string {
  const m = /T(\d{2}:\d{2})/.exec(ts ?? "");
  return m ? m[1] : "";
}

/** Reject anyone who isn't a signed-in user of this project. pullDay writes
    data with the service role, so gate it on a valid caller JWT (the field/
    admin apps forward the crew session token). */
async function requireUser(
  supabase: ReturnType<typeof createClient>,
  req: Request
): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data?.user;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getValidToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  const clientId = Deno.env.get("QB_TIME_CLIENT_ID")!;
  const clientSecret = Deno.env.get("QB_TIME_CLIENT_SECRET")!;

  const { data: tokenRow, error } = await supabase
    .from("qb_time_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !tokenRow) throw new Error("QuickBooks Time is not connected");

  const expiresAt = new Date(tokenRow.expires_at).getTime();
  const nowPlusFive = Date.now() + 5 * 60 * 1000;

  // Token still valid
  if (expiresAt > nowPlusFive) return tokenRow.access_token;

  // Refresh the token — TSheets wants the client creds in the form body.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenRow.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await supabase
    .from("qb_time_tokens")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: newExpiry,
    })
    .eq("id", tokenRow.id);

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const clientId = Deno.env.get("QB_TIME_CLIENT_ID");
  const clientSecret = Deno.env.get("QB_TIME_CLIENT_SECRET");
  const redirectUri = Deno.env.get("QB_TIME_REDIRECT_URI");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Service-role client (bypasses RLS for token storage)
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const action = body.action as string;

  // ── exchangeCode ──────────────────────────────────────────────────────────
  if (action === "exchangeCode") {
    const code = body.code as string;
    const userId = body.userId as string;

    if (!code) return err("Missing code");
    if (!clientId || !clientSecret || !redirectUri) {
      return err("QB_TIME_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI not configured");
    }

    // TSheets grant: client creds go in the form body (no Basic auth).
    const formBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return err(`Token exchange failed: ${text}`);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await supabase.from("qb_time_tokens").upsert(
      {
        realm_id: QB_TIME_REALM,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        connected_by: userId ?? null,
      },
      { onConflict: "realm_id" }
    );

    return ok({ connected: true });
  }

  // ── getStatus ─────────────────────────────────────────────────────────────
  if (action === "getStatus") {
    const { data, error } = await supabase
      .from("qb_time_tokens")
      .select("realm_id, expires_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return ok({ connected: false });
    return ok({ connected: true, realmId: data.realm_id, updatedAt: data.updated_at });
  }

  // ── disconnect ────────────────────────────────────────────────────────────
  // TSheets has no simple token-revoke endpoint; dropping the stored token is
  // enough to disconnect this app (the user can also revoke in QuickBooks Time).
  if (action === "disconnect") {
    await supabase.from("qb_time_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    return ok({ disconnected: true });
  }

  // ── syncJobcodes ──────────────────────────────────────────────────────────
  if (action === "syncJobcodes") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch(
        "/jobcodes?active=yes&type=regular&per_page=200",
        accessToken
      )) as { results: { jobcodes: Record<string, { id: number; name: string; parent_id: number; type: string; active: boolean }> } };

      const jobcodes = Object.values(res.results?.jobcodes ?? {});

      if (jobcodes.length > 0) {
        await supabase.from("qb_time_jobcodes").upsert(
          jobcodes.map((jc) => ({
            qb_id: String(jc.id),
            name: jc.name,
            parent_id: jc.parent_id ? String(jc.parent_id) : null,
            jobcode_type: jc.type,
            active: jc.active,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: "qb_id" }
        );
      }

      return ok({ synced: jobcodes.length });
    } catch (e) {
      return err(e instanceof Error ? e.message : "syncJobcodes failed");
    }
  }

  // ── getTimesheets ─────────────────────────────────────────────────────────
  if (action === "getTimesheets") {
    const jobcodeId = body.jobcodeId as string;
    const startDate = (body.startDate as string) ?? new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const endDate = (body.endDate as string) ?? new Date().toISOString().slice(0, 10);

    if (!jobcodeId) return err("Missing jobcodeId");

    try {
      const accessToken = await getValidToken(supabase);
      const qs = new URLSearchParams({
        jobcode_ids: jobcodeId,
        start_date: startDate,
        end_date: endDate,
        on_the_clock: "no",
        per_page: "200",
        supplemental_data: "yes",
      });

      const res = (await qbFetch(`/timesheets?${qs}`, accessToken)) as {
        results: {
          timesheets: Record<string, {
            id: number;
            user_id: number;
            jobcode_id: number;
            start: string;
            end: string;
            duration: number;
            date: string;
            notes: string;
          }>;
        };
        supplemental_data: {
          users: Record<string, { id: number; first_name: string; last_name: string; email: string }>;
        };
      };

      const timesheets = Object.values(res.results?.timesheets ?? {});
      const users = res.supplemental_data?.users ?? {};

      return ok({ timesheets, users });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getTimesheets failed");
    }
  }

  // ── getUsers ──────────────────────────────────────────────────────────────
  if (action === "getUsers") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch("/users?active=yes&per_page=200", accessToken)) as {
        results: { users: Record<string, { id: number; first_name: string; last_name: string; email: string; employee_number: string }> };
      };
      const users = Object.values(res.results?.users ?? {});
      return ok({ users });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getUsers failed");
    }
  }

  // ── getCurrentTotals ──────────────────────────────────────────────────────
  if (action === "getCurrentTotals") {
    try {
      const accessToken = await getValidToken(supabase);
      const res = (await qbFetch(
        "/reports/current_totals?on_the_clock=yes&supplemental_data=yes",
        accessToken
      )) as {
        results: {
          totals: Record<string, {
            user_id: number;
            jobcode_id: number;
            shift_seconds: number;
            on_the_clock: boolean;
          }>;
        };
        supplemental_data: {
          users: Record<string, { id: number; first_name: string; last_name: string }>;
          jobcodes: Record<string, { id: number; name: string }>;
        };
      };

      const totals = Object.values(res.results?.totals ?? {}).filter((t) => t.on_the_clock);
      const users = res.supplemental_data?.users ?? {};
      const jobcodes = res.supplemental_data?.jobcodes ?? {};

      return ok({ totals, users, jobcodes });
    } catch (e) {
      return err(e instanceof Error ? e.message : "getCurrentTotals failed");
    }
  }

  // ── pullDay ───────────────────────────────────────────────────────────────
  // Pull one day's timesheets for a jobcode and upsert them into time_entries,
  // tagged to a field project. Idempotent on qbTimesheetId. Called by the field
  // app's "Pull today's hours" button and (phase 2) the nightly cron.
  if (action === "pullDay") {
    if (!(await requireUser(supabase, req))) return err("Not authorized", 401);

    const jobcodeId = body.jobcodeId as string;
    const date = (body.date as string) ?? new Date().toISOString().slice(0, 10);
    const fieldProjectId = (body.fieldProjectId as string) ?? null;
    if (!jobcodeId) return err("Missing jobcodeId");

    try {
      const accessToken = await getValidToken(supabase);
      const qs = new URLSearchParams({
        jobcode_ids: jobcodeId,
        start_date: date,
        end_date: date,
        on_the_clock: "no",
        per_page: "200",
        supplemental_data: "yes",
      });

      const res = (await qbFetch(`/timesheets?${qs}`, accessToken)) as {
        results: {
          timesheets: Record<string, {
            id: number; user_id: number; jobcode_id: number;
            start: string; end: string; duration: number; date: string; notes: string;
          }>;
        };
        supplemental_data: {
          users?: Record<string, { id: number; first_name: string; last_name: string }>;
          jobcodes?: Record<string, { id: number; name: string }>;
        };
      };

      const timesheets = Object.values(res.results?.timesheets ?? {});
      const users = res.supplemental_data?.users ?? {};
      const jobcodes = res.supplemental_data?.jobcodes ?? {};

      // Reuse existing row ids for these timesheets so a re-pull updates in place.
      const { data: existing } = await supabase
        .from("time_entries")
        .select("id, data")
        .eq("deleted", false)
        .filter("data->>qbJobcodeId", "eq", jobcodeId)
        .filter("data->>date", "eq", date);

      const idByTs = new Map<string, string>();
      for (const r of (existing ?? []) as { id: string; data: { qbTimesheetId?: string } }[]) {
        if (r.data?.qbTimesheetId) idByTs.set(String(r.data.qbTimesheetId), r.id);
      }

      const nowIso = new Date().toISOString();
      const rows = timesheets.map((ts) => {
        const u = users[String(ts.user_id)];
        const employee = u ? `${u.first_name} ${u.last_name}`.trim() : `QB user ${ts.user_id}`;
        const jc = jobcodes[String(ts.jobcode_id)];
        const start = hhmm(ts.start);
        const finish = hhmm(ts.end);
        const hours = ts.duration ? ts.duration / 3600 : 0;
        const id = idByTs.get(String(ts.id)) ?? crypto.randomUUID();
        return {
          id,
          deleted: false,
          data: {
            id,
            jobId: fieldProjectId,
            fieldProjectId,
            qbJobcodeId: jobcodeId,
            jobcodeName: jc?.name ?? null,
            date,
            employee,
            task: ts.notes || jc?.name || "",
            start,
            finish,
            hours: Number(hours.toFixed(2)),
            source: "qbtime",
            qbTimesheetId: String(ts.id),
            qbUserId: String(ts.user_id),
            enteredBy: "quickbooks-time",
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        };
      });

      if (rows.length > 0) {
        const { error } = await supabase.from("time_entries").upsert(rows, { onConflict: "id" });
        if (error) return err(`time_entries upsert failed: ${error.message}`);
      }

      return ok({ pulled: rows.length, date, jobcodeId });
    } catch (e) {
      return err(e instanceof Error ? e.message : "pullDay failed");
    }
  }

  return err(`Unknown action: ${action}`, 404);
});
