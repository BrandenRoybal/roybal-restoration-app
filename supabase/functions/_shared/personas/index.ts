/* ============================================================
   Roybal assistant registry — one brain, many mouths
   ------------------------------------------------------------
   The single source of truth for WHO the assistant is per channel,
   WHAT it may look up, and WHAT it may propose. Imported by
   roybal-ai-office (Deno) and by the Fly phone agent (Node, via the
   Dockerfile COPY of this directory). Pure data + pure functions —
   no runtime imports anywhere below this file.

     core.ts       the company, the standards, the two rules every
                   register carries
     registers.ts  the audience-specific role + rules; composes PERSONAS
     tools.ts      read-tool + phone-tool schemas, per-persona toolsets
     actions.ts    the 17 proposable writes with desc + input_schema,
                   per-persona actionsets, the proposeActions tool builder
     validate.js   the JSON Schema checker the server and the browser share
                   (emit-client.mjs copies it into apps/field/js/)

   The browser cannot import from this directory (the apps deploy from
   apps/ alone, with no bundler until P3.0), so emit-client.mjs writes
   apps/field/js/actionschemas.js + schemacheck.js and personas.test.mjs
   fails the build if those copies drift from this source.
   ============================================================ */
export { COMPANY_SHORT, COMPANY_LONG, CORE_STANDARDS, CORE_PRIVACY, CORE_SECURITY, CORE_RULES } from "./core.ts";
export { REGISTERS, composePersona, PERSONAS, CTX_LABELS, SPOKEN_RULE } from "./registers.ts";
export type { Register } from "./registers.ts";
export { TOOL_RULE, TOOLS, TOOLSETS, PHONE_TOOLS, PHONE_TOOL_RULE } from "./tools.ts";
export { ACTION_RULE, ACTION_DEFS, ACTIONSETS, PROPOSE_TOOL_NAME, LINE_ITEM_SCHEMA, proposeToolDef, supportsStrictTools } from "./actions.ts";
export type { ActionDef } from "./actions.ts";
export { validateSchema, checkActionParams } from "./validate.js";
