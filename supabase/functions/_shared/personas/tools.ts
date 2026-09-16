/* ============================================================
   Read tools + phone tools — Anthropic tool schemas
   ------------------------------------------------------------
   Definitions only. Tool EXECUTION lives with each runtime
   (roybal-ai-office runTool, always RLS-scoped under the caller's
   JWT; the Fly phone agent's tools.mjs under its machine user).
   Moved verbatim from roybal-ai-office/personas.ts.
   ============================================================ */

/* Appended to the persona whenever the turn carries tools. */
export const TOOL_RULE =
  "\n\nLOOKUP TOOLS: you can look things up — the price list, the job spine, the board schedule, the company text log, logged hours. " +
  "Use a tool when the provided context doesn't already answer the question; prefer one precise lookup over several broad ones. " +
  "Quote looked-up prices and dates exactly as returned, and say when a lookup came back empty rather than guessing.";

/* ---------- read-tool definitions (Anthropic tool schema) ---------- */
export const TOOLS: Record<string, Record<string, unknown>> = {
  priceLookup: {
    name: "priceLookup",
    description:
      "Search the company's Fairbanks Xactimate price list for unit prices — 'what do we charge for X'. " +
      "Returns catalog rows with replace / tear-out / detach-&-reset unit prices, and hourly trade rates under category LAB. " +
      "Search with the material or task words a price sheet would use (e.g. 'drywall hang', 'air mover', 'carpet pad').",
    input_schema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", description: "1-4 words matched against the price-line descriptions" },
        category: { type: "string", description: "Optional Xactimate category code to narrow (e.g. DRY, PNT, LAB, WTR, FCC)" },
      },
    },
  },
  jobLookup: {
    name: "jobLookup",
    description:
      "Find jobs on the company job spine by customer name, claim number, or property address. " +
      "Returns claim number, owner, address, status, loss type, and dates.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: { query: { type: "string", description: "Customer name, claim number, or address fragment" } },
    },
  },
  boardRead: {
    name: "boardRead",
    description:
      "Read the live Job Board schedule: every job's stage, start/target dates, assigned crew names, and material status. " +
      "Use when the provided context doesn't already cover the schedule question.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { include_done: { type: "boolean", description: "Include completed jobs (default false)" } },
    },
  },
  smsThread: {
    name: "smsThread",
    description:
      "Read the company-number text-message log, both directions — 'did the customer text back?', 'what did we last send them?'. " +
      "Optionally filter to one phone number (matches sender or recipient).",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: {
        phone: { type: "string", description: "Optional phone number to filter the thread to" },
        limit: { type: "number", description: "Messages to return, newest first (default 20, max 30)" },
      },
    },
  },
  hoursLookup: {
    name: "hoursLookup",
    description:
      "Aggregate logged crew hours from the board's time entries: totals by job and by crew member since N days ago.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { since_days: { type: "number", description: "Look-back window in days (default 7, max 90)" } },
    },
  },
  crewLookup: {
    name: "crewLookup",
    description:
      "The crew roster: each member's name, role, phone number, and whether they're active. Use it to get a crew member's " +
      "REAL phone number before proposing a text to them ('text Joel he's on the Henderson job tomorrow') — never invent or " +
      "guess a number. Optionally filter by name.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string", description: "Optional name (or fragment) to filter to one member" } },
    },
  },
};

/* Which persona may use which tools. All three in-app personas get every
   READ tool. `phone: []` is deliberate: the phone lane never calls the
   office function's tool loop — its own agent runs PHONE_TOOLS below — and
   a browser caller claiming app:"phone" gets the persona with NO tools. */
export const TOOLSETS: Record<string, string[]> = {
  field: ["priceLookup", "jobLookup", "boardRead", "smsThread", "hoursLookup", "crewLookup"],
  board: ["priceLookup", "jobLookup", "boardRead", "smsThread", "hoursLookup", "crewLookup"],
  admin: ["priceLookup", "jobLookup", "boardRead", "smsThread", "hoursLookup", "crewLookup"],
  phone: [],
};

/* ---------- phone-lane tools (Phase 6) ----------
   Executed by the Fly.io phone agent (services/phone-agent), which imports
   this registry — same brain, narrower hands. Every executor runs under the
   dedicated machine user's JWT (RLS-scoped, with restrictive deny policies
   on top), and createLead / textOwner are rate-limited per caller. The
   caller's number is injected server-side from the Twilio setup message —
   the model never chooses whose record to look at. */
export const PHONE_TOOLS: Record<string, Record<string, unknown>> = {
  lookupCaller: {
    name: "lookupCaller",
    description:
      "Check whether the CALLER's phone number matches a job on file. Returns at most a coarse status ('active water job', " +
      "'closed job last year') for your awareness — never read details back to the caller.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  availability: {
    name: "availability",
    description:
      "Read the crew's real schedule load for the next few days — how booked each day is. Use to say honestly whether the team " +
      "is slammed or has room; never promise a specific slot (the owner confirms on the callback).",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { days: { type: "number", description: "Look-ahead window in days (default 5, max 10)" } },
    },
  },
  createLead: {
    name: "createLead",
    description:
      "Create the new-loss lead on the Job Board (stage 'lead', flagged AI-booked) once you have the caller's name, callback " +
      "number, address, and what happened. Call it ONCE per call.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["name", "phone", "address", "lossType", "summary"],
      properties: {
        name: { type: "string", description: "Caller's name as given" },
        phone: { type: "string", description: "Callback number, confirmed by reading it back" },
        address: { type: "string", description: "Property address" },
        lossType: { type: "string", enum: ["water", "fire", "mold", "remodel", "other"] },
        summary: { type: "string", description: "One or two sentences: what happened, in the caller's words" },
        urgency: { type: "string", enum: ["emergency", "soon", "estimate"], description: "How urgent this feels" },
      },
    },
  },
  textOwner: {
    name: "textOwner",
    description:
      "Text the owner's cell from the company number (works at any hour). Use for new-lead alerts, messages from existing " +
      "customers, and anything that needs the owner's eyes. Keep it under 300 characters.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["message"],
      properties: { message: { type: "string", description: "The text, complete and self-explanatory (include the caller's name + number)" } },
    },
  },
  escalate: {
    name: "escalate",
    description:
      "Live-transfer this call toward the owner's cell — ONLY for an active emergency (water flowing now) or when the caller " +
      "urgently needs a human. Say you're connecting them BEFORE calling this; the call leaves you and cannot come back.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { type: "string", description: "One line: why this is being escalated" } },
    },
  },
};

/* Spoken-mode + tool ground rules appended to the phone persona. */
export const PHONE_TOOL_RULE =
  "\n\nTOOLS: use lookupCaller once early (silently). Gather intake conversationally, then createLead once, then textOwner with the " +
  "lead alert. If a tool fails, apologize briefly, take the message the old-fashioned way, and still textOwner. Never mention tool " +
  "names or that you are an AI system's tool loop — you're just the receptionist.";
