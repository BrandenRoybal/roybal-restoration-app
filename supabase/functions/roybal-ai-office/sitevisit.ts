/**
 * Site Visit estimator — the pure half (no Deno, no network, Node-testable).
 *
 * Branden's working estimate process is: walk the site, Magicplan LiDAR scan
 * with photos pinned per room, a phone recording of the walk, handwritten
 * notes, a typed scope — then hand ALL of it to Claude. The older
 * `invoiceDraft` path hands the model a JSON digest of the mitigation job
 * instead, so it never sees a photo, the plan, the audio or the notes.
 *
 * This module builds the one request that reads the evidence directly:
 *   - the Magicplan report PDF(s) as document blocks,
 *   - extra photos and photographed note pages as image blocks,
 *   - the site-walk transcript (Deepgram, formatted here) and typed scope,
 *   - the job header / any documented facts, the company estimating rules
 *     and the Fairbanks price catalog as text.
 * Files are referenced by signed URL, never inlined — a 40 MB report never
 * passes through the edge function's 256 MB / 2 s-CPU budget.
 *
 * The request runs through the Message Batches API (one request per batch):
 * a top-model run over a large report can outlast the edge function's 400 s
 * wall clock, and a batch result waits on Anthropic's side until we fetch it.
 */

/* Uploads live in the private field-media bucket under this prefix, one
   folder per field project. Anything else is refused before it is signed. */
export const SITE_PREFIX = "sitevisit/";
const SAFE_PATH = /^sitevisit\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/;
export const isSitePath = (p: unknown): p is string =>
  typeof p === "string" && SAFE_PATH.test(p) && !p.includes("..");

/* Claude reads these image types; anything else (HEIC off an iPhone that the
   browser could not re-encode) is dropped client-side and here. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/* Per-request caps — generous for one site visit, bounded so a mistaken bulk
   upload cannot build a runaway request. */
export const MAX_REPORTS = 4;
export const MAX_IMAGES = 90;     // photos + note pages together
export const MAX_TRANSCRIPT_CHARS = 400_000;
export const MAX_SCOPE_CHARS = 40_000;

export type SiteFile = { path: string; name?: string; mime?: string; room?: string; caption?: string };
export type SitePacket = {
  reports?: SiteFile[];      // Magicplan report PDF(s)
  photos?: SiteFile[];       // extra site photos (already JPEG, ≤1568px)
  notes?: SiteFile[];        // photographed handwritten note pages
  transcript?: string;       // site-walk transcript (from siteVisitTranscribe)
  typedScope?: string;       // Branden's typed scope / instructions
};

/** Normalise and bound the client's packet; drops anything unsafe. */
export function cleanPacket(raw: unknown): Required<SitePacket> {
  const p = (raw && typeof raw === "object" ? raw : {}) as SitePacket;
  const files = (v: unknown, keep: (f: SiteFile) => boolean) =>
    (Array.isArray(v) ? v : [])
      .filter((f): f is SiteFile => !!f && typeof f === "object" && isSitePath((f as SiteFile).path))
      .map((f) => ({
        path: f.path,
        name: String(f.name ?? "").slice(0, 120),
        mime: String(f.mime ?? "").toLowerCase().split(";")[0].trim(),
        room: String(f.room ?? "").slice(0, 80),
        caption: String(f.caption ?? "").slice(0, 300),
      }))
      .filter(keep);
  const reports = files(p.reports, (f) => !f.mime || f.mime === "application/pdf").slice(0, MAX_REPORTS);
  const isImg = (f: SiteFile) => IMAGE_TYPES.includes(String(f.mime));
  const notes = files(p.notes, isImg).slice(0, MAX_IMAGES);
  const photos = files(p.photos, isImg).slice(0, Math.max(0, MAX_IMAGES - notes.length));
  return {
    reports, photos, notes,
    transcript: String(p.transcript ?? "").slice(0, MAX_TRANSCRIPT_CHARS),
    typedScope: String(p.typedScope ?? "").slice(0, MAX_SCOPE_CHARS),
  };
}

/** True when the packet carries enough evidence to draft from. */
export function packetHasEvidence(p: Required<SitePacket>): boolean {
  return p.reports.length > 0 || p.photos.length > 0 || p.notes.length > 0 ||
    p.transcript.trim().length > 0 || p.typedScope.trim().length > 0;
}

/* ---------- Deepgram → readable transcript ----------
   With diarize + utterances Deepgram returns speaker-split utterances with
   start times; the estimator cites them ("walk 14:20"), so keep the stamps. */
type Utterance = { start?: number; speaker?: number; transcript?: string };
const stamp = (sec: number) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
export function formatTranscript(dg: unknown): { transcript: string; seconds: number } {
  const d = (dg ?? {}) as {
    metadata?: { duration?: number };
    results?: { utterances?: Utterance[]; channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  const seconds = Number(d.metadata?.duration) || 0;
  const utts = Array.isArray(d.results?.utterances) ? d.results!.utterances! : [];
  if (utts.length) {
    const speakers = new Set(utts.map((u) => u.speaker ?? 0));
    const lines: string[] = [];
    for (const u of utts) {
      const text = String(u.transcript ?? "").trim();
      if (!text) continue;
      const who = speakers.size > 1 ? ` Speaker ${(u.speaker ?? 0) + 1}:` : "";
      lines.push(`[${stamp(Number(u.start) || 0)}]${who} ${text}`);
    }
    return { transcript: lines.join("\n"), seconds };
  }
  const flat = String(d.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
  return { transcript: flat, seconds };
}

/* ---------- the draft's output shape ----------
   Items keep the invoice editor's line shape exactly, so catalog price
   stamping, O&P, totals, the PDF and the QuickBooks push work unchanged.
   `rooms` adds the customer-facing plain-language scope the portal shows. */
const ITEM_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["room", "desc", "qty", "unit", "price", "basis", "category", "code", "priceBasis"],
  properties: {
    room: { type: "string", description: "Room / area exactly as the Magicplan report names it (e.g. 'Kitchen', 'Bedroom 2'). 'Main Level' for job-wide lines (permits, haul-off, final clean, protection)." },
    desc: { type: "string", description: "Plain-English line as it reads in an Xactimate estimate, e.g. 'Drywall - hung, taped, floated, ready for paint'. No catalog code abbreviations, no room name." },
    qty: { type: "number" },
    unit: { type: "string", description: "SF, LF, SY, EA, HR, DA (day) or LS" },
    price: { type: "number", description: "Unit price in DOLLARS. Overridden by the price catalog whenever category+code match a real row, so it only stands for lines no catalog row fits." },
    basis: { type: "string", description: "Where this line and its quantity come from, citable: 'Magicplan p.3: 12\\'4\" x 10\\'6\", 8\\' ceiling', 'walk 14:20: \"take it to four feet on the sink wall\"', 'photo 7 (Kitchen): swollen toe kick', 'notes p.2', 'typed scope'. Show the arithmetic for derived quantities." },
    category: { type: "string", description: "Xactimate CATEGORY of the catalog row billed (e.g. 'DRY', 'PNT', 'FNC'). Empty string only when no catalog row fits." },
    code: { type: "string", description: "Xactimate SELECTOR from the price catalog (must appear in it). Empty string only when no catalog row fits." },
    priceBasis: { type: "string", enum: ["replace", "remove", "detach_reset", "labor", "estimate"], description: "Which catalog price this line uses: replace = install/put-back; remove = tear-out; detach_reset = detach & reset; labor = an hourly LAB rate (HR lines only); estimate = no catalog row, your own Fairbanks price." },
  },
} as const;

export const SITE_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["lossSummary", "items", "rooms", "assumptions", "exclusions", "questions", "pricingNotes"],
  properties: {
    lossSummary: { type: "string", description: "2-4 sentence scope summary for the estimate header: what happened or what is being built, the areas involved, and the approach." },
    items: { type: "array", items: ITEM_SCHEMA },
    rooms: {
      type: "array",
      description: "One entry per room/area that has line items, in the same order the items first mention them.",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "customerSummary"],
        properties: {
          name: { type: "string", description: "Exactly the room value the items use." },
          customerSummary: { type: "string", description: "1-3 plain sentences a homeowner understands: what will be done in this room. No prices, no quantities with units, no codes, no insurance or Xactimate jargon." },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" }, description: "Conditions the pricing assumes (access, working hours, occupied home, materials to match existing, utilities on, winter conditions). One line each." },
    exclusions: { type: "array", items: { type: "string" }, description: "What this estimate does not include (hidden conditions behind finishes, code upgrades not observed, contents, permits if not priced, hazardous materials testing). One line each." },
    questions: { type: "array", items: { type: "string" }, description: "Open questions the evidence could not settle and that change the price, each naming what you assumed meanwhile. Empty when none." },
    pricingNotes: { type: "string", description: "One short paragraph the adjuster or client can read justifying Fairbanks / North Pole pricing where it runs above a national baseline: remote freight and material lead times, winter working conditions, local labor market. Only claims the job supports." },
  },
} as const;

/* ---------- the request ---------- */
export const SITE_SYSTEM =
  "You are the senior estimator at Roybal Construction, LLC, a general contractor and IICRC-certified water restoration company in Fairbanks / North Pole, Alaska. " +
  "You are writing an Xactimate-style, room-by-room estimate from the evidence the owner collected on a site visit: the Magicplan LiDAR report (floor plan, room dimensions, wall and floor areas, photos pinned to rooms), extra photos, still frames pulled from Magicplan room videos, photographed handwritten notes, a transcript of the recorded site walk, and the owner's typed scope, plus any design drawings or customer documents the owner attached as PDFs. " +
  "The owner's typed scope and what the owner says on the walk are instructions: follow them. Photos, plan and notes are evidence: use them for scope detail and quantities. " +
  "Take quantities from the report's printed dimensions and areas, cite the page, and show arithmetic for anything derived. Never scale a drawing. " +
  "Several stills from one video show the same room from different angles: never count the same item twice. " +
  "Include only scope the evidence supports; when something that changes the price is uncertain, state the assumption, price the reasonable case, and list the question. " +
  "Write for the reader the job facts point to: an insurance adjuster on a claim, the owner or their facilities team on a remodel or build. Either way every line is traceable, nothing padded, nothing missing. Return the estimate as JSON matching the schema.";

type Block = Record<string, unknown>;

export type BuildArgs = {
  packet: Required<SitePacket>;
  signed: Record<string, string>;   // path → signed URL
  facts: unknown;                   // job header + any documented facts (JSON)
  rulesText: string;                // pricing mode + common + inclusion rules
  catalogText: string;              // Fairbanks price catalog, one row per line
};

/** The user turn: evidence blocks first, then the instructions and data. */
export function buildContent(a: BuildArgs): Block[] {
  const { packet, signed } = a;
  const out: Block[] = [];
  packet.reports.forEach((f, i) => {
    const url = signed[f.path];
    if (!url) return;
    out.push({ type: "text", text: `MAGICPLAN REPORT ${i + 1}${f.name ? ` (${f.name})` : ""}:` });
    out.push({ type: "document", source: { type: "url", url }, title: f.name || `Magicplan report ${i + 1}` });
  });
  let n = 0;
  for (const f of packet.photos) {
    const url = signed[f.path];
    if (!url) continue;
    n++;
    const label = [f.room && `room: ${f.room}`, f.caption && `note: ${f.caption}`].filter(Boolean).join(" · ");
    out.push({ type: "text", text: `PHOTO ${n}${label ? ` (${label})` : ""}:` });
    out.push({ type: "image", source: { type: "url", url } });
  }
  let pg = 0;
  for (const f of packet.notes) {
    const url = signed[f.path];
    if (!url) continue;
    pg++;
    out.push({ type: "text", text: `HANDWRITTEN NOTES, PAGE ${pg}:` });
    out.push({ type: "image", source: { type: "url", url } });
  }
  const sections = [
    "OWNER'S TYPED SCOPE:\n" + (packet.typedScope.trim() || "(none)"),
    "SITE WALK TRANSCRIPT (timestamps are minutes:seconds into the recording):\n" + (packet.transcript.trim() || "(no recording)"),
    "JOB HEADER AND ANY DOCUMENTED FACTS:\n```json\n" + JSON.stringify(a.facts ?? {}, null, 2) + "\n```",
    "HOW TO WRITE IT:\n" +
      "- Cite evidence in every basis: report page, walk timestamp, photo number, notes page, or typed scope.\n" +
      "- Room names follow the Magicplan report. Job-wide lines go under 'Main Level'.\n" +
      "- Fairbanks realism: freight and lead times, winter conditions (heat, protection, snow removal for access when the season calls for it), frost-depth and snow-load considerations on any exterior or structural scope.\n" +
      "- Tear-out and put-back both appear when the evidence shows damaged material; a remodel prices new work only.\n" +
      "- No overhead, profit or tax lines; they are applied separately.\n\n" + a.rulesText,
    "PRICE CATALOG (Fairbanks Xactimate; tag each line with a CATEGORY + CODE from here):\n" + a.catalogText,
  ];
  out.push({ type: "text", text: sections.join("\n\n") });
  return out;
}

/** One Message Batches request carrying the whole draft. */
export function buildBatchBody(opts: {
  customId: string; model: string; effort: string; content: Block[]; maxTokens?: number;
}): Record<string, unknown> {
  return {
    requests: [{
      custom_id: opts.customId,
      params: {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 64000,
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort, format: { type: "json_schema", schema: SITE_DRAFT_SCHEMA } },
        system: SITE_SYSTEM,
        messages: [{ role: "user", content: opts.content }],
      },
    }],
  };
}

/* ---------- the result ---------- */
export type SiteUsage = { inTok: number; outTok: number };
export type SiteDraft = {
  lossSummary: string;
  items: Array<Record<string, unknown>>;
  rooms: Array<{ name: string; customerSummary: string }>;
  assumptions: string[]; exclusions: string[]; questions: string[]; pricingNotes: string;
};

/** Parse one line of a batch results file into a draft, or a clear error.
    usage is always returned when the model ran, so a rejected result is
    still metered. */
export function parseBatchResult(line: unknown): { draft?: SiteDraft; usage: SiteUsage; model: string; error?: string } {
  const r = (line ?? {}) as { result?: { type?: string; error?: { error?: { message?: string } ; message?: string }; message?: Record<string, unknown> } };
  const res = r.result ?? {};
  if (res.type !== "succeeded") {
    const why = res.type === "expired" ? "the draft expired before it ran — start it again"
      : res.type === "canceled" ? "the draft was canceled"
      : "the draft failed: " + String(res.error?.error?.message ?? res.error?.message ?? res.type ?? "unknown error");
    return { usage: { inTok: 0, outTok: 0 }, model: "", error: why };
  }
  const msg = (res.message ?? {}) as {
    model?: string; stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    content?: Array<{ type?: string; text?: string }>;
  };
  const u = msg.usage ?? {};
  const usage = {
    inTok: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
    outTok: Number(u.output_tokens) || 0,
  };
  const model = String(msg.model ?? "");
  if (msg.stop_reason === "refusal") return { usage, model, error: "the model declined this draft — try again, or trim anything unrelated from the packet" };
  if (msg.stop_reason === "max_tokens") return { usage, model, error: "the draft ran past its length limit before finishing — split the job or trim the packet and try again" };
  const text = (msg.content ?? []).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
  let d: Partial<SiteDraft>;
  try { d = JSON.parse(text); } catch { return { usage, model, error: "the draft came back unreadable — try again" }; }
  const strs = (v: unknown) => (Array.isArray(v) ? v : []).map((s) => String(s ?? "").trim()).filter(Boolean);
  return {
    usage, model,
    draft: {
      lossSummary: String(d.lossSummary ?? ""),
      items: Array.isArray(d.items) ? d.items as Array<Record<string, unknown>> : [],
      rooms: (Array.isArray(d.rooms) ? d.rooms : [])
        .map((x) => ({ name: String(x?.name ?? "").trim(), customerSummary: String(x?.customerSummary ?? "").trim() }))
        .filter((x) => x.name && x.customerSummary),
      assumptions: strs(d.assumptions), exclusions: strs(d.exclusions), questions: strs(d.questions),
      pricingNotes: String(d.pricingNotes ?? "").trim(),
    },
  };
}
