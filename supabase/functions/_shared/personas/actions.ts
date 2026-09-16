/* ============================================================
   Proposed actions — chips, not autonomy — now with schemas
   ------------------------------------------------------------
   The model PROPOSES; the user CONFIRMS. Every proposal renders as
   a tap-to-confirm chip in the client and executes CLIENT-SIDE
   through the app's own guarded paths (sms.js company lane, the
   board's guarded job writes, portal.js) — the server never
   executes an action (that changes in P1, when these same schemas
   become the operation_catalog input schemas).

   Each action carries TWO contracts that must agree:
     desc         — the prose the model reads in the tool description
                    (what the action does, where a value must come from)
     input_schema — the JSON Schema the API validates the params
                    against (strict tool use) and the client re-checks
                    before the executor runs (validate.js)

   The schemas stay inside the subset Anthropic's strict mode accepts:
   type / enum / const / required / properties / additionalProperties:
   false / items / anyOf / format:date. No minimum, maxItems, minLength
   or $ref — strict mode rejects them, so semantic bounds (hours > 0,
   count ≤ 20) stay in the executors, where they always were.

   Adding an action: a desc, an input_schema, a line in the ACTIONSETS
   that may propose it, an executor in the app — and run
   `node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs`
   so the browser copy of the schemas is regenerated (personas.test.mjs
   fails until it is).
   ============================================================ */

export type ActionDef = { desc: string; input_schema: Record<string, unknown> };

/* Appended to the persona whenever the turn carries an actionset. */
export const ACTION_RULE =
  "\n\nPROPOSED ACTIONS: when the natural next step is an action you can propose (see the proposeActions tool), call proposeActions — " +
  "each proposal shows the user a tap-to-confirm chip and NOTHING executes unless they tap it, so never claim an action already happened. " +
  "Propose at most 3 per turn, and only what the user clearly wants or just asked for; never re-propose one already confirmed or ignored. " +
  "Compose message text completely — it sends verbatim. Use phone numbers, names, and dates exactly as they appear in the context or a " +
  "lookup; if you don't have a number, look it up or say so rather than inventing one. After proposing, still give your normal short " +
  "answer and point at the chip ('tap to send it').";

/* ---------- shared fragments ---------- */
const DATE = (description: string) => ({ type: "string", format: "date", description: `${description} (YYYY-MM-DD)` });
const STR = (description: string) => ({ type: "string", description });
const NUM = (description: string) => ({ type: "number", description });
const JOB = STR("The job: customer name, address, or claim — enough to match exactly one job (or its exact id)");
const STRINGS = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** One estimate / change-order line. Shared by estimateWrite and changeOrderWrite. */
export const LINE_ITEM_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["description", "quantity", "unit", "unitPrice"],
  properties: {
    description: STR("What the line is"),
    category: STR("Xactimate category code (DRY/PNT/INS/FNC/FRM/ACT/APP/LAB)"),
    quantity: NUM("How many units"),
    unit: STR("SF / LF / EA / HR"),
    unitPrice: NUM("Price per unit; negative = credit. From priceLookup, quoted exactly — NEVER invented"),
    type: { type: "string", enum: ["replace", "tearout", "detach_reset", "labor"] },
  },
};

/* Per-action contract: desc (embedded in the proposeActions tool description)
   + input_schema (the params contract the API and the client both enforce). */
export const ACTION_DEFS: Record<string, ActionDef> = {
  sendText: {
    desc:
      "Send an SMS from the company number. `to` is the recipient's phone from the context or a lookup (NEVER invented); " +
      "`message` is the complete text, sent verbatim. Customer texts only go out 7am–8pm Alaska (quiet hours) — an off-hours " +
      "tap fails with a clear error, so warn the user when it's late.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["to", "message", "audience"],
      properties: {
        to: STR("The recipient's phone number, from the context or a lookup — never invented"),
        message: STR("The complete text, sent verbatim"),
        audience: { type: "string", enum: ["customer", "crew"] },
      },
    },
  },
  boardWrite: {
    desc:
      "Update ONE existing Job Board job. Include only the fields being changed. startDate pins the start and the engine reflows " +
      "dependent jobs; targetDate sets the job's duration so it finishes that day (NOTE: on a job WITH phases the live engine re-derives " +
      "the finish from phase progress, so a typed targetDate won't stick — manage those via phaseUpdate / phase estimates instead); " +
      "assignedCrew REPLACES the whole crew list (members kept in the list keep any dated assignment windows); notes is appended, never overwrites.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job"],
      properties: {
        job: JOB,
        stage: { type: "string", enum: ["lead", "scheduled", "in_progress", "on_hold", "final", "done"] },
        startDate: DATE("Pins the start; the engine reflows dependent jobs"),
        targetDate: DATE("Finish date — sets the duration (won't stick on a phased job)"),
        assignedCrew: STRINGS("Crew member names — REPLACES the whole crew list"),
        materialStatus: { type: "string", enum: ["none", "ordered", "received"] },
        notes: STR("Appended to the job's notes, never overwrites"),
      },
    },
  },
  jobCreate: {
    desc:
      "Create a new job on the Job Board. With startDate the job lands in stage 'scheduled'; without it, 'lead'.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["insured", "address", "lossType"],
      properties: {
        insured: STR("The customer's name"),
        address: STR("The property address"),
        lossType: { type: "string", enum: ["water", "fire", "mold", "restoration", "remodel", "new_build", "other"] },
        startDate: DATE("Pins the start (stage becomes 'scheduled')"),
        targetDate: DATE("Target finish"),
        assignedCrew: STRINGS("Crew member names"),
        notes: STR("Notes for the job"),
      },
    },
  },
  crewAvailabilityWrite: {
    desc:
      "Block out or restore a crew member's availability (PTO, training, injury, no-show). available:false blocks the days, " +
      "true restores them; endDate is inclusive (same date as startDate for a single day). Blocking also frees the member's job " +
      "slots on those days (a per-day override), exactly like the Crew board's Out column.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["crewMember", "startDate", "endDate", "available"],
      properties: {
        crewMember: STR("Full name"),
        startDate: DATE("First day"),
        endDate: DATE("Last day, inclusive"),
        available: { type: "boolean", description: "false blocks the days, true restores them" },
        reason: STR("Why (PTO, training, injury, no-show…)"),
      },
    },
  },
  crewSwap: {
    desc:
      "Move crew from one job to another. scope 'day' (default) = that ONE day only (a per-day override — the rest of each job keeps " +
      "its planned crew). scope 'forward' = from that day through the END of each job (cycling a guy off a long job onto another; the " +
      "days he already worked stay on his record, and remaining work re-sizes for the new crews). For a start-to-finish reassignment " +
      "use boardWrite's assignedCrew instead.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["fromJob", "toJob", "crewMembers", "date"],
      properties: {
        fromJob: STR("Title or customer matching exactly one job"),
        toJob: STR("Title or customer matching exactly one job"),
        crewMembers: STRINGS("Names to move"),
        date: DATE("The day"),
        scope: { type: "string", enum: ["day", "forward"] },
      },
    },
  },
  hoursWrite: {
    desc:
      "Log crew hours on a board job's time log. Omit date for today; omit phase and the engine places the hours by date and phase " +
      "completions, same as QuickBooks Time hours. The confirmation reports the job's new logged-hours total (manual + linked QuickBooks Time).",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "crewMember", "hours"],
      properties: {
        job: STR("Job title or customer"),
        crewMember: STR("The crew member's name"),
        date: DATE("Omit for today"),
        hours: NUM("Hours worked"),
        phase: STR("A phase name on that job to pin the hours to"),
        trade: STR("e.g. demo / framing / drying / general"),
        notes: STR("Notes"),
      },
    },
  },
  phaseUpdate: {
    desc:
      "Mark a job's phase complete (or reopen it) — THE write that moves the real schedule: logged hours drive each phase's progress, an unfinished " +
      "phase keeps sliding the job's finish date out day by day, and marking it done stops the slide, re-flows the job's remaining phases from its " +
      "completion date, and pushes/pulls every linked job. done defaults to true (false reopens); completedOn backdates if it actually wrapped " +
      "earlier (default today). The confirmation reports the job's new projected finish and how many linked jobs re-flowed.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "phase"],
      properties: {
        job: JOB,
        phase: STR("The phase's name"),
        done: { type: "boolean", description: "Default true; false reopens" },
        completedOn: DATE("Backdate if it wrapped earlier; default today"),
      },
    },
  },
  adjusterEmail: {
    desc:
      "Draft the claim-submission email for a job (subject + body from its documented facts). The user reviews the draft — nothing is " +
      "emailed automatically.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job"],
      properties: { job: STR("Customer name or address, enough to match exactly one job") },
    },
  },
  docRequest: {
    desc:
      "Text the job's customer asking for a specific document or photos (signed authorization, insurance letter, photos of the damage…). " +
      "The message is composed politely and sent as SMS to the phone number ON THE JOB RECORD — never an invented number. " +
      "Customer texts respect quiet hours (7am–8pm Alaska).",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "items"],
      properties: {
        job: STR("Customer name or address to match exactly one job"),
        items: STR("What to ask for, in plain words"),
        note: STR("Optional extra context"),
      },
    },
  },
  portalPhotoShare: {
    desc:
      "Share the job's newest photos to its customer portal page and republish it. count defaults to 5 (max 20). Requires the job's " +
      "Client Portal to already be enabled; the confirmation reports how many photos the portal now shows.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job"],
      properties: {
        job: STR("Customer name or address to match exactly one job"),
        count: NUM("How many of the newest photos to add (default 5, max 20)"),
      },
    },
  },
  emailSend: {
    desc:
      "Send an email from the connected office Gmail — it goes out the moment the user confirms the chip, from the owner's real address. " +
      "to 'reply' answers that job's most recent inbound email inside its thread; 'customer' emails the customer's address on the job record. " +
      "subject is required for 'customer' and defaults to Re: the thread for 'reply'. body is the COMPLETE email, sent verbatim; professional, " +
      "plain language, signed Roybal Construction. Addresses come ONLY from the job's records or its email thread — never typed from memory, never invented.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "to", "body"],
      properties: {
        job: STR("Customer name or address to match exactly one job"),
        to: { type: "string", enum: ["reply", "customer"] },
        subject: STR("Required for 'customer'; defaults to Re: the thread for 'reply'"),
        body: STR("The COMPLETE email, sent verbatim"),
      },
    },
  },
  portalReply: {
    desc:
      "Draft a message for a job's customer-portal thread. The user reviews the draft, then confirms a second chip before it posts. " +
      "mode 'reply' answers their last message; 'status' is a proactive update.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "mode"],
      properties: {
        job: STR("Customer name or address to match"),
        mode: { type: "string", enum: ["reply", "status"] },
      },
    },
  },
  estimateWrite: {
    desc:
      "Create or update a job's reconstruction estimate, line by line. Omit estimateId to create; give an existing estimate's number " +
      "(e.g. 'EST-1') to update. On update, lineItems REPLACES the whole item list — omit it to keep the existing lines. O&P is set " +
      "automatically by the GC rule (10&10 only when a subcontractor is on file, else 0). Pull unit prices with priceLookup and quote " +
      "them exactly — NEVER invent a price.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job"],
      properties: {
        job: STR("Customer / address / claim, matching exactly one job"),
        estimateId: STR("Omit to create; an existing estimate's number (e.g. 'EST-1') to update"),
        lineItems: { type: "array", items: LINE_ITEM_SCHEMA, description: "REPLACES the whole list on update; omit to keep existing lines" },
        notes: STR("Notes"),
        status: { type: "string", enum: ["draft", "pending_approval", "approved", "rejected"] },
      },
    },
  },
  invoiceCreate: {
    desc:
      "Generate an invoice from an APPROVED estimate (refuses any other status). billedTo is the customer, carrier, or entity from the job record.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "estimateId", "invoiceDate", "dueDate", "billedTo"],
      properties: {
        job: JOB,
        estimateId: STR("The estimate's number or id"),
        invoiceDate: DATE("Invoice date"),
        dueDate: DATE("Due date"),
        billedTo: STR("Customer, carrier, or entity from the job record"),
        notes: STR("Notes"),
      },
    },
  },
  invoiceStatusUpdate: {
    desc:
      "Update an invoice's payment lifecycle. amountReceived is required for partially_paid and never more than the balance. Add job " +
      "(customer/claim) when that invoice number exists on more than one job. The confirmation reports the running balance.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["invoiceId", "status"],
      properties: {
        invoiceId: STR("The invoice number (e.g. 'INV-2')"),
        job: STR("Customer/claim — when the number exists on more than one job"),
        status: { type: "string", enum: ["sent", "viewed", "partially_paid", "paid", "void"] },
        amountReceived: NUM("Required for partially_paid; never more than the balance"),
        paymentDate: DATE("When it was paid"),
        paymentMethod: STR("e.g. check / ACH / card / insurance_draft"),
        notes: STR("Notes"),
      },
    },
  },
  changeOrderWrite: {
    desc:
      "Create or update a change order on a job. Omit changeOrderId to create. lineItems REPLACES existing lines when provided " +
      "(negative unitPrice for credits); costDelta is positive to add, negative to credit.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "description", "reason", "costDelta"],
      properties: {
        job: JOB,
        changeOrderId: STR("Omit to create"),
        description: STR("What changes"),
        reason: STR("e.g. 'hidden damage', 'owner request', 'code upgrade'"),
        lineItems: { type: "array", items: LINE_ITEM_SCHEMA, description: "REPLACES existing lines when provided" },
        costDelta: NUM("Positive adds, negative credits"),
        approvalStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
      },
    },
  },
  receiptLog: {
    desc:
      "Log a material/equipment receipt against a job (feeds the budget-vs-estimate flag). Omit date for today.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["job", "vendor", "amount"],
      properties: {
        job: JOB,
        vendor: STR("Who was paid"),
        amount: NUM("Dollars"),
        category: STR("e.g. materials / equipment / dump / sub"),
        date: DATE("Omit for today"),
        notes: STR("Notes"),
      },
    },
  },
};

/* Which persona may propose which actions. The phone persona gets none
   (its own tools execute directly on Fly, rate-limited); unknown apps get
   NO actions, never a fallback set. */
export const ACTIONSETS: Record<string, string[]> = {
  field: ["sendText"],
  board: ["sendText", "boardWrite", "jobCreate", "crewAvailabilityWrite", "crewSwap", "hoursWrite", "phaseUpdate"],
  admin: ["sendText", "adjusterEmail", "portalReply", "emailSend", "docRequest", "portalPhotoShare",
    "estimateWrite", "invoiceCreate", "invoiceStatusUpdate", "changeOrderWrite", "receiptLog"],
  // the owner by text (J0): a proposal here lands in pending_actions for
  // "YES n", so only kinds roybal-notify's approval executor can run —
  // smsassist.test.mjs holds this list equal to TEXT_EXECUTABLE_KINDS
  sms: ["sendText"],
};

export const PROPOSE_TOOL_NAME = "proposeActions";

/** The proposeActions tool for one actionset. Each action becomes an anyOf
    branch keyed by `type` — so the API validates the params against THAT
    action's schema (strict mode), instead of accepting a free object the
    executor discovers is wrong. `strict` is only honoured by models that
    support strict tool use; the caller decides per model, and the server
    re-checks every proposal with validate.js either way. */
export function proposeToolDef(actionNames: string[], opts: { strict?: boolean } = {}): Record<string, unknown> {
  const names = actionNames.filter((n) => Object.prototype.hasOwnProperty.call(ACTION_DEFS, n));
  return {
    name: PROPOSE_TOOL_NAME,
    description:
      "Propose concrete next-step actions for the user to confirm. Each renders as a tap-to-confirm chip — NOTHING executes " +
      "unless tapped, so never claim an action already happened. Propose at most 3 per call. Action types available here:\n" +
      names.map((n) => `- ${n}: ${ACTION_DEFS[n].desc}`).join("\n"),
    ...(opts.strict ? { strict: true } : {}),
    input_schema: {
      type: "object", additionalProperties: false, required: ["actions"],
      properties: {
        actions: {
          type: "array",
          items: {
            anyOf: names.map((n) => ({
              type: "object", additionalProperties: false, required: ["type", "label", "params"],
              properties: {
                type: { type: "string", const: n },
                label: { type: "string", description: "Short imperative chip label, e.g. 'Text Sarah the ETA'" },
                params: ACTION_DEFS[n].input_schema,
              },
            })),
          },
        },
      },
    },
  };
}

/** Models whose tool definitions may carry `strict: true`. Anything else
    gets the same schema without the flag and relies on the server re-check. */
export const supportsStrictTools = (model: string): boolean =>
  /^claude-(sonnet-5|opus-5|opus-4-8|haiku-4-5|fable|mythos)/.test(String(model || ""));
