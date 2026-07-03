/**
 * Client wrappers for the ai-proxy Supabase Edge Function.
 * All Claude API calls happen server-side — see supabase/functions/ai-proxy.
 */

import { supabase } from "./supabase";
import { PRICE_CATALOG } from "@roybal/shared";
import type { PhotoAnalysis } from "@roybal/shared";

const aiProxy = async <T>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await supabase.functions.invoke("ai-proxy", {
    body: { action, ...params },
  });
  if (error) throw new Error(error.message ?? "AI request failed");
  if (!data.ok) throw new Error(data.error ?? "AI request failed");
  return data.data as T;
};

export interface PhotoAnalysisResult {
  id: string;
  ok: boolean;
  error?: string;
  analysis?: PhotoAnalysis;
}

/** Analyze up to 25 photos; captions + analysis are saved server-side. */
export function analyzePhotos(photoIds: string[]) {
  return aiProxy<{ results: PhotoAnalysisResult[] }>("analyzePhotos", { photoIds });
}

/** Generate + save the job narrative; returns the narrative text. */
export function generateNarrative(jobId: string) {
  return aiProxy<{ narrative: string }>("generateNarrative", { jobId });
}

export interface InvoiceDraftItem {
  room_name: string | null;
  code: string | null;
  category: string;
  description: string;
  quantity: number;
  unit: string;
  /** cents */
  unit_price: number;
  notes: string | null;
}

export interface InvoiceDraft {
  title: string;
  notes: string | null;
  items: InvoiceDraftItem[];
}

/**
 * Generate an invoice draft from all job data + AI photo analysis.
 * Nothing is saved server-side — the caller reviews and saves the draft.
 */
export function generateInvoiceDraft(
  jobId: string,
  roomAreas?: Record<string, { floor_area: number; perimeter: number; net_wall_area: number; height: number }>
) {
  return aiProxy<{ draft: InvoiceDraft }>("generateInvoice", {
    jobId,
    catalog: PRICE_CATALOG,
    roomAreas,
  });
}
