/**
 * Supabase Edge Function: magicplan-webhook
 *
 * Receives floor plan update events from Magicplan's webhook system.
 * Downloads the updated floor plan files and saves them to Supabase Storage,
 * then updates the floor_plans table.
 *
 * Deploy: supabase functions deploy magicplan-webhook
 * Webhook URL: https://<project>.supabase.co/functions/v1/magicplan-webhook
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAGICPLAN_API_KEY = Deno.env.get("MAGICPLAN_API_KEY")!;
const MAGICPLAN_CUSTOMER_ID = Deno.env.get("MAGICPLAN_CUSTOMER_ID")!;
const MAGICPLAN_WEBHOOK_SECRET = Deno.env.get("MAGICPLAN_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface MagicplanWebhookPayload {
  event: string;
  project_id: string;
  external_reference_id?: string; // Our internal job UUID
  updated_at: string;
  files?: MagicplanFile[];
}

interface MagicplanFile {
  type: "pdf" | "image" | "json";
  url: string;
  name: string;
}

serve(async (req: Request) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Optional: verify webhook signature if Magicplan provides one
  const signature = req.headers.get("x-magicplan-signature") ?? "";
  if (MAGICPLAN_WEBHOOK_SECRET && !verifySignature(signature, MAGICPLAN_WEBHOOK_SECRET)) {
    console.warn("Webhook signature mismatch");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: MagicplanWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log("Magicplan webhook received:", payload.event, payload.project_id);

  // Only handle floor plan export/update events
  if (!["project.exported", "project.updated", "floorplan.updated"].includes(payload.event)) {
    return new Response(JSON.stringify({ received: true, action: "ignored" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Find the job linked to this Magicplan project
    const jobId = await resolveJobId(payload.project_id, payload.external_reference_id);
    if (!jobId) {
      console.warn("No job found for magicplan_project_id:", payload.project_id);
      return new Response(JSON.stringify({ received: true, action: "no_job_found" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fetch the latest project files from Magicplan
    const files = payload.files ?? await fetchProjectFiles(payload.project_id);

    // Find the best file: prefer PDF, fall back to image
    const floorPlanFile =
      files.find((f) => f.type === "pdf") ??
      files.find((f) => f.type === "image");

    if (!floorPlanFile) {
      console.warn("No usable floor plan file in payload");
      return new Response(JSON.stringify({ received: true, action: "no_file" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Download the file content from Magicplan
    const fileResponse = await fetch(floorPlanFile.url, {
      headers: magicplanHeaders(),
    });
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file: ${fileResponse.status}`);
    }
    const fileBuffer = await fileResponse.arrayBuffer();
    const contentType =
      floorPlanFile.type === "pdf" ? "application/pdf" : "image/png";

    // Determine next version number
    const { data: existingPlans } = await supabase
      .from("floor_plans")
      .select("version")
      .eq("job_id", jobId)
      .eq("magicplan_project_id", payload.project_id)
      .order("version", { ascending: false })
      .limit(1);
    const nextVersion = ((existingPlans?.[0]?.version) ?? 0) + 1;

    // Upload to Supabase Storage
    const ext = floorPlanFile.type === "pdf" ? "pdf" : "png";
    const storagePath = `${jobId}/${payload.project_id}/v${nextVersion}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("floor-plans")
      .upload(storagePath, fileBuffer, {
        contentType,
        upsert: false,
      });
    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    // Get a signed URL (valid for 10 years ~ read-only for app use)
    const { data: signedUrlData } = await supabase.storage
      .from("floor-plans")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);

    // Insert record into floor_plans
    const { error: dbError } = await supabase.from("floor_plans").insert({
      job_id: jobId,
      magicplan_project_id: payload.project_id,
      file_url: signedUrlData?.signedUrl ?? null,
      storage_path: storagePath,
      version: nextVersion,
      synced_at: new Date().toISOString(),
    });
    if (dbError) {
      throw new Error(`DB insert failed: ${dbError.message}`);
    }

    console.log(`Floor plan v${nextVersion} saved for job ${jobId}`);
    return new Response(
      JSON.stringify({ received: true, action: "synced", version: nextVersion }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Webhook processing error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

/** Look up our internal job UUID from Magicplan project ID or external_reference_id */
async function resolveJobId(
  magicplanProjectId: string,
  externalRefId?: string
): Promise<string | null> {
  // Try direct match on magicplan_project_id first
  const { data: byMagicplan } = await supabase
    .from("jobs")
    .select("id")
    .eq("magicplan_project_id", magicplanProjectId)
    .single();
  if (byMagicplan) return byMagicplan.id;

  // Fall back to external_reference_id (our UUID passed at project creation)
  if (externalRefId) {
    const { data: byRef } = await supabase
      .from("jobs")
      .select("id")
      .eq("id", externalRefId)
      .single();
    if (byRef) return byRef.id;
  }

  return null;
}

/** Fetch project files directly from Magicplan API */
async function fetchProjectFiles(projectId: string): Promise<MagicplanFile[]> {
  const res = await fetch(
    `https://app.magicplan.app/api/v1/projects/${projectId}/files`,
    { headers: magicplanHeaders() }
  );
  if (!res.ok) {
    console.warn("Failed to fetch project files:", res.status);
    return [];
  }
  const json = await res.json();
  return (json.files ?? json.data ?? []) as MagicplanFile[];
}

/** Standard Magicplan API request headers */
function magicplanHeaders(): Record<string, string> {
  return {
    "X-Api-Key": MAGICPLAN_API_KEY,
    "X-Customer-Id": MAGICPLAN_CUSTOMER_ID,
    Accept: "application/json",
  };
}

/** Basic webhook signature verification (HMAC-SHA256 if Magicplan supports it) */
function verifySignature(signature: string, secret: string): boolean {
  // If no secret configured, skip verification
  if (!secret) return true;
  // Placeholder — implement HMAC check here once Magicplan documents their signing method
  return signature.length > 0;
}
