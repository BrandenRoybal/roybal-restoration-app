/**
 * Narrated walk → scope notes: the pure half of the walkExtract action
 * (no Deno, no network, Node-testable). docs/Narrated_Walkthrough_Design.md
 * §4.2 (the shape), §6 (the rules), build brief §6.1.
 *
 * One clip per call. The client hands over the clip's utterances, its
 * stills (signed here by the caller, ≤ 24), the job's room names and the
 * Magicplan room names, and the job kind. The model answers with the
 * schema below — every item timed into the clip — and parseWalkResult
 * turns that into the per-clip half of siteVisit.scopeNotes: every item
 * carries {clip, at}; an item without a time is dropped, a room the job
 * never named goes job-wide, and on a mitigation clip anything counted or
 * measured lands in verify, never in quantities.
 */
import { isSitePath, IMAGE_TYPES } from "./sitevisit.ts";

export const WALK_BUCKETS = ["observations", "materials", "damage", "quantities", "instructions", "preExisting", "homeownerSaid", "verify", "safety", "trades"] as const;
export type Bucket = typeof WALK_BUCKETS[number];
export const MAX_STILLS = 24;
export const MAX_UTTERANCES = 2000;
export const MAX_ROOMS = 100;
export const MAX_ITEM_CHARS = 400;

export type WalkUtt = { start: number; end: number; speaker: number; text: string };
export type WalkStill = { path: string; caption: string; t: number };
export type WalkInput = {
  clip: { id: string; room: string; utterances: WalkUtt[] };
  stills: WalkStill[];
  rooms: string[];
  magicplanRooms: string[];
  jobKind: "claim" | "construction" | "mitigation";
};

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };

/** Bound and normalise the client's input; throws when there is no clip to read. */
export function cleanWalkInput(raw: unknown): WalkInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.clip && typeof r.clip === "object" ? r.clip : {}) as Record<string, unknown>;
  const utterances: WalkUtt[] = (Array.isArray(c.utterances) ? c.utterances : []).slice(0, MAX_UTTERANCES)
    .map((u) => {
      const x = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
      const start = Math.max(0, num(x.start) || 0);
      return { start, end: Math.max(start, num(x.end) || start), speaker: Math.max(0, Math.round(num(x.speaker) || 0)), text: str(x.text, 2000) };
    })
    .filter((u) => u.text);
  const id = str(c.id, 80);
  if (!id) throw new Error("walkExtract needs the clip's id");
  if (!utterances.length) throw new Error("That clip has no transcript to read yet.");
  const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((s) => str(s, 80)).filter(Boolean))].slice(0, MAX_ROOMS);
  const stills: WalkStill[] = (Array.isArray(r.stills) ? r.stills : [])
    .map((s) => { const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>; return { path: String(x.path ?? ""), caption: str(x.caption, 300), t: num(x.t), mime: String(x.mime ?? "").toLowerCase().split(";")[0].trim() }; })
    .filter((s) => isSitePath(s.path) && Number.isFinite(s.t) && s.t >= 0 && (!s.mime || IMAGE_TYPES.includes(s.mime)))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_STILLS)
    .map(({ path, caption, t }) => ({ path, caption, t }));
  const jk = String(r.jobKind ?? "");
  return {
    clip: { id, room: str(c.room, 80), utterances },
    stills, rooms: names(r.rooms), magicplanRooms: names(r.magicplanRooms),
    jobKind: jk === "construction" ? "construction" : jk === "mitigation" ? "mitigation" : "claim",
  };
}

/* ---------- the output shape (structured output: every object closed, all keys required) ---------- */
const cited = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object", additionalProperties: false,
  required: ["text", "at", ...required],
  properties: {
    text: { type: "string", description: "The item, in the recorder's own words where possible (quote before paraphrase). One thing per item." },
    at: { type: "number", description: "Seconds into THIS clip where it was said or seen. Required: an item you cannot place in time must be left out." },
    ...extra,
  },
} as const);
const ROOM_NOTES_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["room", ...WALK_BUCKETS],
  properties: {
    room: { type: "string", description: "One of ALLOWED ROOMS exactly as listed, or an empty string when the items are about the whole job or a place the job never named." },
    observations: { type: "array", items: cited(), description: "What is there and what condition it is in — 'ceiling drywall stained about 4 by 6 at the sink wall'." },
    materials: { type: "array", items: cited(), description: "Finishes and materials named or clearly visible — 'oak shaker uppers, laminate tops, LVP over OSB'." },
    damage: { type: "array", items: cited({ cause: { type: "string", description: "The cause as stated on the clip, or an empty string." } }, ["cause"]), description: "Damage and its stated cause — 'supply line under the sink, Cat 1, about three days'." },
    quantities: { type: "array", items: cited({ value: { type: "number", description: "The number spoken, or 0 when none was." }, unit: { type: "string", description: "SF, LF, EA, HR, or an empty string." } }, ["value", "unit"]), description: "Quantities SPOKEN ALOUD only — 'about twelve feet of base'. Never a number you worked out from a picture." },
    instructions: { type: "array", items: cited(), description: "What the recorder said to do — 'take it to four feet on the sink wall'. Keep their words." },
    preExisting: { type: "array", items: cited(), description: "Conditions called out as pre-existing or unrelated — 'that crack was there before'." },
    homeownerSaid: { type: "array", items: cited(), description: "What the homeowner or occupant said, attributed ('Homeowner: …'), never rewritten into a finding." },
    verify: { type: "array", items: cited(), description: "Unknowns to check before pricing, plus every number you INFERRED from a still, written '~12 LF (est. from still 01:42)'. On a mitigation clip: every reading, equipment count and date spoken, with the spoken value." },
    safety: { type: "array", items: cited(), description: "Hazards noted — 'panel is wet, breaker off', 'mold on the back of the vanity'." },
    trades: { type: "array", items: cited({ trade: { type: "string", description: "The trade needed — 'Electrical', 'Plumbing', 'Roofing'. A trade, never a company or a person's name." } }, ["trade"]), description: "Subcontractor trades the recorder said the job needs." },
  },
} as const;
export const WALK_NOTES_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["clipRoom", "rooms"],
  properties: {
    clipRoom: { type: "string", description: "The room this clip is mainly about: the one spoken in its first seconds if it matches ALLOWED ROOMS, else the given clip room, else an empty string." },
    rooms: { type: "array", items: ROOM_NOTES_SCHEMA, description: "One entry per room the clip covers (usually one), plus at most one entry with room '' for job-wide items." },
  },
} as const;

/* ---------- the request ---------- */
export const WALK_SYSTEM =
  "You are the senior estimator at Roybal Construction, LLC, a general contractor and IICRC-certified water restoration company in Fairbanks / North Pole, Alaska, turning ONE narrated walk clip into scope notes the owner will review before pricing. " +
  "You have the clip's transcript with timestamps and still frames captioned with what was being said when each was taken. " +
  "Rules: quote before paraphrase, and keep the recorder's own words for instructions. Every item names the second into the clip it comes from; leave out anything you cannot place. " +
  "Rooms come only from what was spoken, then the ALLOWED ROOMS list — never invent one; what you cannot place goes under room ''. " +
  "Quantities are only what was spoken aloud; a number you infer from a still goes to verify as '~12 LF (est. from still 01:42)'. " +
  "Name trades, never a subcontractor's company or a person. What the homeowner said stays attributed to them and is never turned into a finding. " +
  "On a mitigation clip, readings, equipment counts and dates go to verify with the spoken value — they are never applied to a log. " +
  "One thing per item, nothing padded, nothing invented. Return JSON matching the schema.";

type Block = Record<string, unknown>;
const stamp = (sec: number) => { const s = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** The user turn: the stills, then the transcript, the allowed rooms and the job framing. */
export function buildWalkContent(input: WalkInput, signed: Record<string, string>): Block[] {
  const out: Block[] = [];
  let n = 0;
  for (const s of input.stills) {
    const url = signed[s.path];
    if (!url) continue;
    n++;
    out.push({ type: "text", text: `STILL ${n} at ${stamp(s.t)} (${s.t}s)${s.caption ? ` — ${s.caption}` : ""}:` });
    out.push({ type: "image", source: { type: "url", url } });
  }
  const allowed = [...new Set([input.clip.room, ...input.rooms, ...input.magicplanRooms].filter(Boolean))];
  const transcript = input.clip.utterances.map((u) => `[${stamp(u.start)} · ${u.start}s]${new Set(input.clip.utterances.map((x) => x.speaker)).size > 1 ? ` Speaker ${u.speaker + 1}:` : ""} ${u.text}`).join("\n");
  const kind = input.jobKind === "construction" ? "a construction / remodel bid" : input.jobKind === "mitigation" ? "an active water/fire mitigation job (readings and equipment counts you hear go to verify, never anywhere else)" : "an insurance restoration claim";
  out.push({ type: "text", text: [
    `CLIP: ${input.clip.id}${input.clip.room ? ` · recorded as room "${input.clip.room}"` : ""} · ${input.clip.utterances.length} utterances · ${n} stills. Times in brackets are seconds into THIS clip; use them for every item's at.`,
    `JOB: ${kind}.`,
    `ALLOWED ROOMS: ${allowed.length ? allowed.join(" | ") : "(none named yet — use only a room spoken on the clip, else '')"}`,
    "TRANSCRIPT:\n" + transcript,
  ].join("\n\n") });
  return out;
}

/* ---------- the result → the per-clip half of scopeNotes ---------- */
export type NoteItem = { text: string; clip: string; at: number; cause?: string; value?: number; unit?: string; trade?: string };
export type RoomNotes = { room: string } & Record<Bucket, NoteItem[]>;
export type ClipNotes = { clip: string; clipRoom: string; rooms: RoomNotes[]; jobWide: RoomNotes; dropped: number };

const emptyRoom = (room: string): RoomNotes => {
  const r = { room } as RoomNotes;
  for (const b of WALK_BUCKETS) r[b] = [];
  return r;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Parse the model's JSON (already schema-shaped) into cited items. Every
    item gets {clip, at}; no time → dropped (counted); a room not in the
    allowed set → merged into jobWide; mitigation → quantities become verify. */
export function parseWalkResult(json: unknown, opts: { clipId: string; allowedRooms: string[]; jobKind: WalkInput["jobKind"] }): ClipNotes {
  const d = (json && typeof json === "object" ? json : {}) as { clipRoom?: unknown; rooms?: unknown };
  const allowed = new Map(opts.allowedRooms.filter(Boolean).map((r) => [norm(r), r]));
  const rooms = new Map<string, RoomNotes>();
  const jobWide = emptyRoom("");
  let dropped = 0;
  const item = (raw: unknown, bucket: Bucket): NoteItem | null => {
    const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const text = str(x.text, MAX_ITEM_CHARS);
    const at = num(x.at);
    if (!text || !Number.isFinite(at) || at < 0) { dropped++; return null; }
    const it: NoteItem = { text, clip: opts.clipId, at: Math.round(at * 10) / 10 };
    if (bucket === "damage") it.cause = str(x.cause, 200);
    if (bucket === "quantities") { const v = num(x.value); it.value = Number.isFinite(v) && v > 0 ? v : 0; it.unit = str(x.unit, 10); }
    if (bucket === "trades") { it.trade = str(x.trade, 60); if (!it.trade) { dropped++; return null; } }
    return it;
  };
  for (const raw of Array.isArray(d.rooms) ? d.rooms : []) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = allowed.get(norm(str(r.room, 80))) ?? "";
    const target = name ? (rooms.get(name) ?? (rooms.set(name, emptyRoom(name)), rooms.get(name)!)) : jobWide;
    for (const b of WALK_BUCKETS) {
      for (const raw2 of Array.isArray(r[b]) ? (r[b] as unknown[]) : []) {
        const it = item(raw2, b);
        if (!it) continue;
        if (b === "quantities" && opts.jobKind === "mitigation") {
          const { value, unit, ...rest } = it;
          target.verify.push({ ...rest, text: `${it.text} (spoken: ${value ? value + " " + unit : "value not caught"} — verify, never apply)`.replace(/\s+/g, " ") });
        } else target[b].push(it);
      }
    }
  }
  const clipRoom = allowed.get(norm(str(d.clipRoom, 80))) ?? "";
  return { clip: opts.clipId, clipRoom, rooms: [...rooms.values()], jobWide, dropped };
}

/** How many items a clip's notes hold (for the action summary). */
export function countItems(notes: ClipNotes): number {
  const one = (r: RoomNotes) => WALK_BUCKETS.reduce((t, b) => t + r[b].length, 0);
  return notes.rooms.reduce((t, r) => t + one(r), 0) + one(notes.jobWide);
}

/* ---------- "Not in estimate" → a proposals row (brief §6.6) ----------
   0004's row shape, filled for one accepted walk note the draft has no
   line for. The idempotency key is the note's own key under the estimate,
   so a second draft (or a second tap) never files the same note twice. */
const PROPOSAL_TTL_DAYS = 30;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function missingLineProposal(o: { projectId: string; estimateId: string; item: { key: string; room: string; bucket: string; text: string; clip: string; at: number; trade?: string } }) {
  const room = String(o.item.room || "").slice(0, 80);
  const text = String(o.item.text || "").slice(0, 400);
  const at = Number(o.item.at) || 0;
  const cite = `walk ${room || "job-wide"} ${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`;
  return {
    operation: "estimate.missing_line@1",
    action_type: "job",
    input: { projectId: o.projectId, estimateId: o.estimateId, room, bucket: String(o.item.bucket || "").slice(0, 20), text, trade: String(o.item.trade || "").slice(0, 60), citation: { clip: String(o.item.clip || "").slice(0, 80), at, label: cite } },
    proposed_by_kind: "agent",
    proposed_via: "agent",
    rationale: `Accepted on the narrated walk (${cite}) but no line in the draft estimate matches it.`,
    evidence_refs: [{ kind: "walk_clip", clip: String(o.item.clip || "").slice(0, 80), at, room }],
    job_id: isUuid(o.projectId) ? o.projectId : null,
    assigned_role: "owner",
    status: "proposed",
    expires_at: new Date(Date.now() + PROPOSAL_TTL_DAYS * 86400e3).toISOString(),
    idempotency_key: `estimate.missing_line:${o.projectId}:${o.estimateId}:${String(o.item.key || "").slice(0, 160)}`,
  };
}
