/**
 * Walk scope notes — the pure half of `walkExtract` (no Deno, no network,
 * Node-tested in ./walkextract.test.mjs). docs/Narrated_Walkthrough_Design.md
 * §3 step 7, §4.2, §6.
 *
 * The narrated walk clips already land in the packet as a transcript and as
 * stills captioned with what was being said. Before V2 the estimate draft read
 * that raw transcript; nothing in between gave the owner a list he could check.
 * This step reads the clips' transcripts (and their stills) and returns the
 * reviewable middle layer: per-room observations, materials, damage, spoken
 * quantities, instructions, pre-existing conditions, what the homeowner said,
 * things to verify, safety and trades — every item tied to a clip and the
 * second it was said, so the panel can play it back.
 *
 * Shape note: the design's §4.2 keeps one array per bucket. The model returns
 * (and the field app stores) one flat list per room with a `bucket` on each
 * item instead: the same information, one parser path, one review loop.
 */

export const SCOPE_BUCKETS = [
  "observations", "materials", "damage", "quantities", "instructions",
  "preExisting", "homeownerSaid", "verify", "safety", "trades",
] as const;
export type Bucket = typeof SCOPE_BUCKETS[number];

export const JOB_WIDE = "Main Level";
export const MAX_CLIPS = 40;
export const MAX_STILLS = 60;
export const MAX_CLIP_CHARS = 60_000;
export const MAX_ITEMS = 400;

export type ExtractClip = { n: number; room: string; seconds: number; text: string };
export type ExtractStill = { path: string; clip: number; at: number; caption: string };
export type ExtractInput = { jobKind: "claim" | "construction" | ""; rooms: string[]; clips: ExtractClip[]; stills: ExtractStill[] };
export type ScopeItem = { bucket: Bucket; text: string; clip: number; at: number; value?: number; unit?: string; trade?: string; cause?: string };
export type ScopeRoom = { room: string; items: ScopeItem[] };

const SAFE_STILL = /^sitevisit\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Bound and normalise what the field app sent. Clips without words are
    dropped (nothing to extract); stills must belong to a kept clip. */
export function cleanExtractInput(raw: unknown): ExtractInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clips: ExtractClip[] = [];
  const seen = new Set<number>();
  for (const c of (Array.isArray(b.clips) ? b.clips : []).slice(0, MAX_CLIPS) as Array<Record<string, unknown>>) {
    const n = Math.round(num(c?.n));
    const text = String(c?.text ?? "").trim().slice(0, MAX_CLIP_CHARS);
    if (!(n >= 1) || seen.has(n) || !text) continue;
    seen.add(n);
    clips.push({ n, room: str(c.room, 80), seconds: Math.max(0, num(c.seconds) || 0), text });
  }
  const stills = (Array.isArray(b.stills) ? b.stills : [] as unknown[])
    .map((s) => s as Record<string, unknown>)
    .filter((s) => s && typeof s.path === "string" && SAFE_STILL.test(s.path) && !String(s.path).includes("..") && seen.has(Math.round(num(s.clip))))
    .slice(0, MAX_STILLS)
    .map((s) => ({ path: String(s.path), clip: Math.round(num(s.clip)), at: Math.max(0, num(s.at) || 0), caption: str(s.caption, 300) }));
  const kind = b.jobKind === "construction" ? "construction" : b.jobKind === "claim" ? "claim" : "";
  const rooms = (Array.isArray(b.rooms) ? b.rooms : []).map((r) => str(r, 80)).filter(Boolean).slice(0, 80);
  return { jobKind: kind, rooms, clips, stills };
}

const item = (extra: Record<string, unknown> = {}) => ({
  type: "object", additionalProperties: false,
  required: ["bucket", "text", "clip", "at"],
  properties: {
    bucket: { type: "string", enum: [...SCOPE_BUCKETS] },
    text: { type: "string", description: "One finding, short. instructions keep the speaker's own words; homeownerSaid starts 'Homeowner:'." },
    clip: { type: "integer", description: "The clip number (from its header) the item was said in or seen in." },
    at: { type: "number", description: "Seconds into THAT clip where it was said (from the [m:ss] stamp) or where the still was taken." },
    value: { type: "number", description: "quantities only: the number that was spoken." },
    unit: { type: "string", description: "quantities only: LF, SF, EA, SY, etc." },
    trade: { type: "string", description: "trades only: the trade (Electrician, Plumber), never a company name." },
    cause: { type: "string", description: "damage only: the cause when it was said (supply line, ice dam)." },
    ...extra,
  },
});

export const SCOPE_NOTES_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["rooms"],
  properties: {
    rooms: {
      type: "array",
      description: `One entry per room in walk order. Items that belong to no single room go under '${JOB_WIDE}'.`,
      items: {
        type: "object", additionalProperties: false,
        required: ["room", "items"],
        properties: {
          room: { type: "string" },
          items: { type: "array", items: item() },
        },
      },
    },
  },
} as const;

export const SCOPE_SYSTEM =
  "You turn a contractor's narrated site-walk clips into scope notes the owner reviews before an estimate is drafted. " +
  "Roybal Construction LLC is a restoration and remodeling contractor in Fairbanks / North Pole, Alaska. " +
  "You are given each clip's timestamped transcript and still frames from the clips (each captioned with the words said around it). " +
  "Return ONLY what the evidence supports, in these buckets:\n" +
  "- observations: what is there or what condition it is in.\n" +
  "- materials: materials and finishes (\"oak shaker uppers, laminate tops\").\n" +
  "- damage: damage and, when it was said, its cause.\n" +
  "- quantities: ONLY numbers that were spoken aloud, with value and unit.\n" +
  "- instructions: what the speaker said to do. Keep the speaker's own words (\"take it to four feet on the sink wall\").\n" +
  "- preExisting: conditions the speaker said were there before the loss.\n" +
  "- homeownerSaid: what the homeowner said, attributed (\"Homeowner: it started Tuesday\"); never rewritten into a finding.\n" +
  "- verify: unknowns to check, and any quantity you estimate from a still (say so: \"~12 LF (est. from still 1:42)\").\n" +
  "- safety: hazards.\n" +
  "- trades: trades needed (Electrician, Plumber, HVAC); trade only, never a company name, even when one is spoken.\n" +
  "Rules:\n" +
  "- Every item cites the clip number and the second it was said or seen. No citation, no item.\n" +
  "- Rooms come from what was said (a clip opens by naming its room), then the job's room list. Never invent a room; what you can't place goes under '" + JOB_WIDE + "'.\n" +
  "- Never state a quantity that was not spoken. An estimated quantity goes in verify, never quantities.\n" +
  "- Readings, equipment counts and dates spoken on a mitigation clip go to verify with the spoken value; they are not findings.\n" +
  "- One idea per item. Short. No prices. Do not repeat the same item in two buckets.\n" +
  "Return the result with the scope_notes tool.";

type Block = Record<string, unknown>;

/** The user turn: each still beside its caption, then every clip's transcript. */
export function buildExtractContent(input: ExtractInput, signed: Record<string, string>): Block[] {
  const out: Block[] = [];
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  for (const s of input.stills) {
    const url = signed[s.path];
    if (!url) continue;
    out.push({ type: "text", text: `STILL — clip ${s.clip} at ${mmss(s.at)}${s.caption ? ` (${s.caption})` : ""}:` });
    out.push({ type: "image", source: { type: "url", url } });
  }
  const clips = input.clips.map((c) =>
    `— Clip ${c.n} · ${c.room || "room not named"} · ${mmss(c.seconds)} — (stamps are minutes:seconds into this clip)\n${c.text}`).join("\n\n");
  out.push({ type: "text", text: [
    `JOB: ${input.jobKind === "construction" ? "a remodel / construction bid" : input.jobKind === "claim" ? "an insurance claim (restoration)" : "unknown kind"}`,
    `ROOMS ON THE JOB FILE: ${input.rooms.length ? input.rooms.join(", ") : "(none listed)"}`,
    "WALK CLIPS:\n" + (clips || "(none)"),
  ].join("\n\n") });
  return out;
}

/** The model's answer → rooms of cited items. An item with no valid clip or
    second is dropped (the parser, not the prompt, enforces "no citation, no
    item"); a quantity with no number moves to verify; the same text in the
    same clip and second appears once. */
export function parseScopeNotes(raw: unknown, clips: ExtractClip[]): { rooms: ScopeRoom[]; dropped: number } {
  const byN = new Map(clips.map((c) => [c.n, c]));
  const r = (raw && typeof raw === "object" ? raw : {}) as { rooms?: unknown };
  const rooms: ScopeRoom[] = [];
  const index = new Map<string, ScopeRoom>();
  const seen = new Set<string>();
  let dropped = 0, kept = 0;
  for (const room of (Array.isArray(r.rooms) ? r.rooms : []) as Array<Record<string, unknown>>) {
    const name = str(room?.room, 80) || JOB_WIDE;
    for (const it of (Array.isArray(room?.items) ? room.items : []) as Array<Record<string, unknown>>) {
      let bucket = String(it?.bucket ?? "") as Bucket;
      const text = str(it?.text, 400);
      const clip = byN.get(Math.round(num(it?.clip)));
      let at = num(it?.at);
      if (!SCOPE_BUCKETS.includes(bucket) || !text || !clip || !(at >= 0)) { dropped++; continue; }
      if (clip.seconds > 0) at = Math.min(at, clip.seconds);
      at = Math.round(at * 10) / 10;
      const value = num(it?.value);
      if (bucket === "quantities" && !Number.isFinite(value)) bucket = "verify";
      const key = `${clip.n}|${at}|${text.toLowerCase()}`;
      if (seen.has(key)) { dropped++; continue; }
      if (kept >= MAX_ITEMS) { dropped++; continue; }
      seen.add(key);
      kept++;
      const out: ScopeItem = { bucket, text, clip: clip.n, at };
      if (bucket === "quantities") { out.value = value; const u = str(it?.unit, 12); if (u) out.unit = u; }
      if (bucket === "trades") { const t = str(it?.trade, 60); if (t) out.trade = t; }
      if (bucket === "damage") { const c = str(it?.cause, 120); if (c) out.cause = c; }
      let target = index.get(name.toLowerCase());
      if (!target) { target = { room: name, items: [] }; index.set(name.toLowerCase(), target); rooms.push(target); }
      target.items.push(out);
    }
  }
  return { rooms, dropped };
}
