/**
 * Supabase Edge Function: magicplan-proxy
 *
 * Proxies requests from the web app to the Magicplan API.
 * Needed because cloud.magicplan.app blocks direct browser requests (CORS).
 *
 * Deploy: supabase functions deploy magicplan-proxy
 *
 * Actions (passed as JSON body):
 *   { action: "listProjects" }
 *   { action: "createProject", jobId, jobData }
 *   { action: "getProject", projectId }
 *   { action: "getProjectFiles", projectId }
 *   { action: "syncFloorPlan", projectId }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const MAGICPLAN_API_KEY = Deno.env.get("MAGICPLAN_API_KEY")!;
const MAGICPLAN_CUSTOMER_ID = Deno.env.get("MAGICPLAN_CUSTOMER_ID")!;
const BASE_URL = "https://cloud.magicplan.app/api/v2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const mpHeaders = {
  "key": MAGICPLAN_API_KEY,
  "customer": MAGICPLAN_CUSTOMER_ID,
  "Content-Type": "application/json",
  "Accept": "application/json",
};

async function mpFetch(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: mpHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Magicplan ${method} ${path}: ${res.status} — ${text}`);
  return JSON.parse(text);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { action, jobId, jobData, projectId } = await req.json();

    let result: unknown;

    if (action === "listProjects") {
      const res = await mpFetch("GET", "/projects");
      result = res.data ?? res;

    } else if (action === "createProject") {
      const res = await mpFetch("POST", "/projects", {
        name: `${jobData.job_number ?? jobId} — ${jobData.property_address ?? ""}`.trim(),
        external_reference_id: jobId,
        notes: jobData.notes ?? "",
        address: jobData.property_address ?? "",
      });
      const project = res.data ?? res;
      result = { magicplanProjectId: project.id, project };

    } else if (action === "getProject") {
      const res = await mpFetch("GET", `/projects/${projectId}`);
      result = res.data ?? res;

    } else if (action === "getProjectFiles") {
      const res = await mpFetch("GET", `/projects/${projectId}/plan`);
      result = res.files ?? res.data ?? [];

    } else if (action === "syncFloorPlan") {
      const res = await mpFetch("GET", `/projects/${projectId}/plan`);
      const files: Array<{ type: string; url: string; name: string }> = res.files ?? res.data ?? [];
      const pdfFile = files.find((f) => f.type === "pdf");
      const imageFile = files.find((f) => f.type === "image");
      const best = pdfFile ?? imageFile ?? null;
      result = {
        fileUrl: best?.url ?? null,
        fileType: best ? (pdfFile ? "pdf" : "image") : null,
        allFiles: files,
      };

    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    return new Response(JSON.stringify({ ok: true, data: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
