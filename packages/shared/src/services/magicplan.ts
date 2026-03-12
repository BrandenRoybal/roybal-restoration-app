/**
 * MagicplanService
 *
 * Wraps the Magicplan REST API (https://app.magicplan.app/api/v1).
 * Authentication: X-Api-Key + X-Customer-Id headers.
 *
 * Usage (web/mobile — uses anon key; only reads project data):
 *   const mp = new MagicplanService(apiKey, customerId);
 *   const project = await mp.createProject(jobId, jobData);
 */

import type { Job, MagicplanFile, MagicplanProject } from "../types/index.js";

const BASE_URL = "https://app.magicplan.app/api/v1";

export class MagicplanService {
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, customerId: string) {
    this.headers = {
      "X-Api-Key": apiKey,
      "X-Customer-Id": customerId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ------------------------------------------------------------------
  // 1. createProject
  //    Creates a new Magicplan project linked to a Roybal job.
  //    Returns the Magicplan project_id to store in jobs.magicplan_project_id
  // ------------------------------------------------------------------
  async createProject(
    jobId: string,
    jobData: Partial<Job>
  ): Promise<{ magicplanProjectId: string; project: MagicplanProject }> {
    const body = {
      name: `${jobData.job_number ?? jobId} — ${jobData.property_address ?? ""}`.trim(),
      external_reference_id: jobId, // our UUID so webhook can resolve back
      notes: jobData.notes ?? "",
      address: jobData.property_address ?? "",
      tags: [jobData.loss_type ?? "water"].filter(Boolean),
    };

    const res = await this.request("POST", "/projects", body);

    const data = res['data'] as Record<string, unknown> | undefined;
    const magicplanProjectId = (res['id'] ?? res['project_id'] ?? data?.['id']) as string | undefined;
    if (!magicplanProjectId) {
      throw new Error("Magicplan createProject: no project ID in response");
    }

    return { magicplanProjectId, project: res as unknown as MagicplanProject };
  }

  // ------------------------------------------------------------------
  // 2. getProjectFiles
  //    Fetches all files (PDF, images) for a given Magicplan project.
  // ------------------------------------------------------------------
  async getProjectFiles(magicplanProjectId: string): Promise<MagicplanFile[]> {
    const res = await this.request("GET", `/projects/${magicplanProjectId}/files`);
    const rawFiles = (res['files'] ?? res['data'] ?? []) as unknown[];
    return rawFiles as MagicplanFile[];
  }

  // ------------------------------------------------------------------
  // 3. getProject
  //    Fetches project metadata (status, name, etc.)
  // ------------------------------------------------------------------
  async getProject(magicplanProjectId: string): Promise<MagicplanProject> {
    const res = await this.request("GET", `/projects/${magicplanProjectId}`);
    return res as unknown as MagicplanProject;
  }

  // ------------------------------------------------------------------
  // 4. listProjects
  //    Lists all projects for this customer account.
  // ------------------------------------------------------------------
  async listProjects(): Promise<MagicplanProject[]> {
    const res = await this.request("GET", "/projects");
    return (res.projects ?? res.data ?? res) as MagicplanProject[];
  }

  // ------------------------------------------------------------------
  // 5. syncFloorPlan (client-side manual trigger)
  //    Fetches the latest files and returns the best floor plan URL.
  //    The actual storage upload happens server-side (edge function or backend).
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // 6. handleWebhook (utility — parsing helper for edge function)
  //    Parses and validates an incoming Magicplan webhook payload.
  // ------------------------------------------------------------------
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
      externalReferenceId: payload["external_reference_id"]
        ? String(payload["external_reference_id"])
        : null,
      files: (payload["files"] as MagicplanFile[]) ?? [],
    };
  }

  // ------------------------------------------------------------------
  // Private: generic request helper
  // ------------------------------------------------------------------
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : null,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Magicplan API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`
      );
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}
