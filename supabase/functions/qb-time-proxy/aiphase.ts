/* ============================================================
   Haiku fallback for phase attribution — pure module
   ------------------------------------------------------------
   The deterministic matcher (phasematch.ts) only fires on a clear
   winner. What's left is the fuzzy tail: "Nate's punch stuff", "put
   the last pieces up". This builds ONE batched forced-tool call per
   job per pull and validates what comes back — no free-form JSON,
   same shape as roybal-ai-ingest/roybal-ai-office.

   Nothing here talks to the network: index.ts owns the fetch, the
   spend cap, and the ai_usage ledger. Unit tests: aiphase.test.mjs.
   ============================================================ */

import type { Subtask } from "./phasematch.ts";

export type AiEntry = { id: string; hours?: number; date?: string; note?: string; task?: string; service?: string };
export type AiAssignment = { entryId: string; phaseId: string; confidence: number };

/** Below this the model is guessing — leave the entry unstamped and let the
    board's date fallback have it. Deliberately strict: a wrong stamp is worse
    than no stamp, because it silently re-dates the schedule. */
export const MIN_CONFIDENCE = 0.7;

/** Cap one call's size — a job with a huge backlog batches across pulls. */
export const MAX_BATCH = 40;

export const SYSTEM = [
  "You assign construction time entries to the job's work phases.",
  "Each entry is one crew member's timesheet: what they wrote plus the QuickBooks service item.",
  "Pick the phase the described work belongs to. Use ONLY the phase ids given — never invent one.",
  "When the note is too vague to tell (\"worked on site\", \"misc\", \"finish up\"), or no listed phase covers",
  "the work, return an empty phase id. Guessing corrupts the schedule; abstaining is safe.",
  "confidence is 0-1: how sure you are THIS entry belongs to THAT phase.",
].join("\n");

export const TOOL_NAME = "assign";

export const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      description: "One item per entry, in the order the entries were listed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entry", "phaseId", "confidence"],
        properties: {
          entry: { type: "integer", description: "The entry number shown in the list." },
          phaseId: { type: "string", description: "The chosen phase id, or \"\" when none fits or the note is too vague." },
          confidence: { type: "number", description: "0-1 certainty that this entry belongs to this phase." },
        },
      },
    },
  },
} as const;

/** The user-turn text: the phase menu, then the numbered entries. */
export function buildUserContent(entries: AiEntry[], phases: Subtask[]): string {
  const phaseLines = phases
    .filter((st) => st && st.id && String(st.name || "").trim())
    .map((st) => `- ${st.id} = ${String(st.name).trim()}${st.done ? " (already finished)" : ""}`);
  const entryLines = entries.map((e, i) => {
    const said = [e.note, e.task].filter(Boolean).join(" / ") || "(no note)";
    const svc = e.service ? ` [service: ${e.service}]` : "";
    const hrs = e.hours != null ? ` (${e.hours}h)` : "";
    return `${i + 1}. ${e.date || ""}${hrs} "${said}"${svc}`;
  });
  return [
    "Phases on this job:",
    ...phaseLines,
    "",
    "Time entries to assign:",
    ...entryLines,
  ].join("\n");
}

/** Validate the model's tool input against reality: known phase ids, in-range
    entry numbers, confidence at or above the bar, one assignment per entry.
    Anything that fails a check is simply dropped (entry stays unstamped). */
export function applyAiMatches(
  toolInput: unknown,
  entries: AiEntry[],
  phases: Subtask[],
  minConfidence: number = MIN_CONFIDENCE
): AiAssignment[] {
  const raw = (toolInput as { assignments?: unknown })?.assignments;
  if (!Array.isArray(raw)) return [];
  const known = new Set(phases.filter((st) => st && st.id).map((st) => st.id));
  const used = new Set<string>();
  const out: AiAssignment[] = [];
  for (const a of raw) {
    const item = a as { entry?: unknown; phaseId?: unknown; confidence?: unknown };
    const idx = Number(item?.entry);
    if (!Number.isInteger(idx) || idx < 1 || idx > entries.length) continue;
    const entry = entries[idx - 1];
    if (!entry?.id || used.has(entry.id)) continue;        // no double-assigning one entry
    const phaseId = String(item?.phaseId ?? "").trim();
    if (!phaseId || !known.has(phaseId)) continue;          // abstention or hallucinated id
    const confidence = Number(item?.confidence);
    if (!Number.isFinite(confidence) || confidence < minConfidence) continue;
    used.add(entry.id);
    out.push({ entryId: entry.id, phaseId, confidence: Math.round(confidence * 100) / 100 });
  }
  return out;
}

/** The Anthropic request body — house style: forced tool, no temperature. */
export function buildRequestBody(model: string, entries: AiEntry[], phases: Subtask[], maxTokens = 2048) {
  return {
    model,
    max_tokens: maxTokens,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserContent(entries, phases) }],
    tools: [{ name: TOOL_NAME, description: "Return one assignment per time entry.", input_schema: TOOL_SCHEMA }],
    tool_choice: { type: "tool", name: TOOL_NAME },
  };
}
