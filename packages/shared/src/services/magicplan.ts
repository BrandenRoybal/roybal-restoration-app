/**
 * MagicplanService
 *
 * Wraps the Magicplan REST API (https://cloud.magicplan.app/api/v2).
 * Authentication: key + customer headers.
 *
 * NOTE: Direct browser calls to cloud.magicplan.app are blocked by CORS.
 * Use the Supabase Edge Function proxy (magicplan-proxy) from the web app.
 * This class is used directly by the edge function (Deno / server-side).
 */

import type { Job, MagicplanFile, MagicplanProject } from "../types/index.js";

const BASE_URL = "https://cloud.magicplan.app/api/v2";

export class MagicplanService {
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, customerId: string) {
    this.headers = {
      "key": apiKey,
      "customer": customerId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async createProject(
    jobId: string,
    jobData: Partial<Job>
  ): Promise<{ magicplanProjectId: string; project: MagicplanProject }> {
    const body = {
      name: `${jobData.job_number ?? jobId} — ${jobData.property_address ?? ""}`.trim(),
      external_reference_id: jobId,
      notes: jobData.notes ?? "",
      address: jobData.property_address ?? "",
    };

    const res = await this.request("POST", "/projects", body);
    const project = (res["data"] ?? res) as Record<string, unknown>;
    const magicplanProjectId = String(project["id"] ?? "");
    if (!magicplanProjectId) throw new Error("Magicplan createProject: no project ID in response");
    return { magicplanProjectId, project: project as unknown as MagicplanProject };
  }

  async getProjectFiles(magicplanProjectId: string): Promise<MagicplanFile[]> {
    const res = await this.request("GET", `/projects/${magicplanProjectId}/plan`);
    const rawFiles = (res["files"] ?? res["data"] ?? []) as unknown[];
    return rawFiles as MagicplanFile[];
  }

  async getProject(magicplanProjectId: string): Promise<MagicplanProject> {
    const res = await this.request("GET", `/projects/${magicplanProjectId}`);
    const data = (res["data"] ?? res) as unknown;
    return data as MagicplanProject;
  }

  async listProjects(): Promise<MagicplanProject[]> {
    const res = await this.request("GET", "/projects");
    return ((res["data"] ?? res) as MagicplanProject[]);
  }

  async syncFloorPlan(magicplanProjectId: string): Promise<{
    fileUrl: string | null;
    fileType: "pdf" | "image" | null;
    allFiles: MagicplanFile[];
  }> {
    const files = await this.getProjectFiles(magicplanProjectId);
    const pdfFile = files.find((f) => f.type === "pdf");
    const imageFile = files.find((f) => f.type === "image");
    const best = pdfFile ?? imageFile ?? null;
    return {
      fileUrl: best?.url ?? null,
      fileType: best ? (pdfFile ? "pdf" : "image") : null,
      allFiles: files,
    };
  }

  static parseWebhookPayload(raw: unknown): {
    event: string;
    projectId: string;
    externalReferenceId: string | null;
    files: MagicplanFile[];
  } | null {
    if (typeof raw !== "object" || raw === null) return null;
    const payload = raw as Record<string, unknown>;
    return {
      event: String(payload["event"] ?? ""),
      projectId: String(payload["project_id"] ?? ""),
      externalReferenceId: payload["external_reference_id"] ? String(payload["external_reference_id"]) : null,
      files: (payload["files"] as MagicplanFile[]) ?? [],
    };
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Magicplan API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
