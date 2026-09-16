/* The assistant registry — unit tests (no Deno, no network).
   Run: node --experimental-strip-types --test supabase/functions/_shared/personas.test.mjs
   (picked up by `npm run fn:test`, which globs every function dir's .test.mjs)

   Three things this file guards:
     1. Every proposable action has a schema the strict-mode API accepts, and
        every actionset names only actions that exist.
     2. The checker rejects what the executors used to discover too late — a
        bad date, an unknown stage, a missing recipient — and accepts a good
        proposal, so a chip fails at the schema with a readable sentence.
     3. The browser's copy of the schemas (apps/field/js/actionschemas.js +
        schemacheck.js) is byte-identical to what emit-client.mjs renders from
        this source — the lockstep guard. A failure here means: run
        node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERSONAS, REGISTERS, CORE_SECURITY, CTX_LABELS, TOOLSETS, TOOLS, PHONE_TOOLS,
  ACTION_DEFS, ACTIONSETS, PROPOSE_TOOL_NAME, proposeToolDef, supportsStrictTools,
  validateSchema, checkActionParams,
} from "./personas/index.ts";
import { renderClientFiles, CLIENT_DIR } from "./personas/emit-client.mjs";

/* ---------- 1. the registry is well-formed ---------- */

test("every register composes into a persona that ends with the core rules", () => {
  for (const key of Object.keys(REGISTERS)) {
    assert.ok(PERSONAS[key].startsWith(REGISTERS[key].role), `${key} persona opens with its role`);
    assert.ok(PERSONAS[key].endsWith(CORE_SECURITY), `${key} persona carries the security rule last`);
  }
  // the four channels the runtimes route on
  for (const key of ["phone", "field", "board", "admin"]) {
    assert.ok(typeof PERSONAS[key] === "string" && PERSONAS[key].length > 200, `${key} persona exists`);
    assert.ok(CTX_LABELS[key], `${key} has a context label`);
  }
  // the phone register stays transport-coupled and says so
  assert.match(PERSONAS.phone, /live phone call/);
});

test("actionsets and toolsets name only things that exist", () => {
  for (const [app, names] of Object.entries(ACTIONSETS)) {
    for (const n of names) assert.ok(ACTION_DEFS[n], `${app} actionset names unknown action ${n}`);
    assert.ok(PERSONAS[app], `${app} actionset has a persona`);
  }
  for (const [app, names] of Object.entries(TOOLSETS)) {
    for (const n of names) assert.ok(TOOLS[n], `${app} toolset names unknown tool ${n}`);
  }
  assert.deepEqual(TOOLSETS.phone, [], "the phone lane never calls the office tool loop");
  assert.equal(ACTIONSETS.phone, undefined, "the phone persona proposes nothing through the chip path");
});

/* Strict tool use accepts exactly this subset. A schema that strays gets a
   400 from the API on the first turn that carries it — so the walk below is
   the test that keeps the model's tool definition deployable. */
const STRICT_KEYS = new Set(["type", "enum", "const", "required", "properties", "additionalProperties", "items", "anyOf", "format", "description"]);
function assertStrictSubset(schema, path) {
  assert.equal(typeof schema, "object", `${path} is an object`);
  for (const k of Object.keys(schema)) assert.ok(STRICT_KEYS.has(k), `${path}.${k} is not strict-mode safe`);
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties:false`);
    assert.ok(Array.isArray(schema.required), `${path} must list required`);
    for (const [k, v] of Object.entries(schema.properties || {})) assertStrictSubset(v, `${path}.${k}`);
    for (const r of schema.required) assert.ok(schema.properties[r], `${path} requires unknown ${r}`);
  }
  if (schema.type === "array") assertStrictSubset(schema.items, `${path}[]`);
  if (schema.format) assert.equal(schema.format, "date", `${path} uses a format strict mode doesn't know`);
  if (schema.anyOf) schema.anyOf.forEach((s, i) => assertStrictSubset(s, `${path}.anyOf[${i}]`));
}

test("every action schema (and the composed tool) stays inside the strict-mode subset", () => {
  const seventeen = Object.keys(ACTION_DEFS);
  assert.equal(seventeen.length, 17, "seventeen proposable writes");
  for (const [name, def] of Object.entries(ACTION_DEFS)) {
    assert.ok(def.desc && def.desc.length > 20, `${name} keeps its prose desc`);
    assert.equal(def.input_schema.type, "object", `${name} params are an object`);
    assertStrictSubset(def.input_schema, name);
    // every date field is typed as one — the whole point of the schemas
    for (const [k, v] of Object.entries(def.input_schema.properties)) {
      if (/(^date$|Date$|On$)/.test(k) && v.type === "string") assert.equal(v.format, "date", `${name}.${k} is format:date`);
    }
  }
  const tool = proposeToolDef(ACTIONSETS.admin, { strict: true });
  assert.equal(tool.name, PROPOSE_TOOL_NAME);
  assert.equal(tool.strict, true);
  assertStrictSubset(tool.input_schema, "proposeActions");
  const branches = tool.input_schema.properties.actions.items.anyOf;
  assert.equal(branches.length, ACTIONSETS.admin.length, "one anyOf branch per admin action");
  assert.deepEqual(branches.map((b) => b.properties.type.const), ACTIONSETS.admin, "branches keyed by type, in actionset order");
  assert.equal(proposeToolDef(ACTIONSETS.field).strict, undefined, "strict is opt-in per model");
  assert.equal(proposeToolDef(["sendText", "notAnAction"]).input_schema.properties.actions.items.anyOf.length, 1, "unknown names are dropped, not emitted");
});

test("strict is offered only to models that accept it", () => {
  assert.equal(supportsStrictTools("claude-sonnet-5"), true);
  assert.equal(supportsStrictTools("claude-opus-5"), true);
  assert.equal(supportsStrictTools("claude-haiku-4-5"), true);
  assert.equal(supportsStrictTools("claude-sonnet-4-6"), false);
  assert.equal(supportsStrictTools(""), false);
});

/* ---------- 2. the checker catches what executors used to ---------- */

test("a bad date string is rejected at the schema", () => {
  const errs = validateSchema(ACTION_DEFS.boardWrite.input_schema, { job: "Hansen", startDate: "next Tuesday" }, "params");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /params\.startDate must be a real date written YYYY-MM-DD/);
  // and a well-formed impossible date is still not a date
  assert.equal(validateSchema(ACTION_DEFS.phaseUpdate.input_schema, { job: "x", phase: "Demo", completedOn: "2026-02-30" }, "params").length, 1);
  assert.equal(validateSchema(ACTION_DEFS.phaseUpdate.input_schema, { job: "x", phase: "Demo", completedOn: "2026-02-28" }, "params").length, 0);
});

test("an unknown stage is rejected, a known one accepted", () => {
  const bad = validateSchema(ACTION_DEFS.boardWrite.input_schema, { job: "Hansen", stage: "started" }, "params");
  assert.match(bad[0], /params\.stage must be one of lead, scheduled, in_progress, on_hold, final, done/);
  assert.deepEqual(validateSchema(ACTION_DEFS.boardWrite.input_schema, { job: "Hansen", stage: "in_progress" }, "params"), []);
});

test("missing and extra fields are named, not swallowed", () => {
  const missing = validateSchema(ACTION_DEFS.sendText.input_schema, { to: "9075551234" }, "params");
  assert.deepEqual(missing, ["params.message is required", "params.audience is required"]);
  const extra = validateSchema(ACTION_DEFS.sendText.input_schema, { to: "9075551234", message: "hi", audience: "crew", cc: "x" }, "params");
  assert.deepEqual(extra, ["params.cc is not a known field"]);
  const wrongType = validateSchema(ACTION_DEFS.hoursWrite.input_schema, { job: "x", crewMember: "Mike", hours: "eight" }, "params");
  assert.deepEqual(wrongType, ["params.hours must be a number"]);
});

test("nested line items are checked item by item", () => {
  const errs = validateSchema(ACTION_DEFS.estimateWrite.input_schema, {
    job: "x",
    lineItems: [
      { description: "Drywall hang", quantity: 120, unit: "SF", unitPrice: 2.1, type: "replace" },
      { description: "Paint", quantity: 120, unit: "SF", type: "spray" },
    ],
  }, "params");
  assert.deepEqual(errs, ["params.lineItems[1].unitPrice is required", "params.lineItems[1].type must be one of replace, tearout, detach_reset, labor"]);
});

test("the composed tool's anyOf reports the branch that matched the type", () => {
  const tool = proposeToolDef(ACTIONSETS.board);
  const item = tool.input_schema.properties.actions.items;
  assert.deepEqual(validateSchema(item, { type: "sendText", label: "Text Mike", params: { to: "907", message: "hi", audience: "crew" } }), []);
  const errs = validateSchema(item, { type: "crewSwap", label: "Swap", params: { fromJob: "A", toJob: "B", crewMembers: ["Mike"], date: "tomorrow" } });
  assert.deepEqual(errs, ["value.params.date must be a real date written YYYY-MM-DD"]);
  const unknown = validateSchema(item, { type: "nope", label: "x", params: {} });
  assert.ok(unknown.length >= 1, "an unknown type matches no branch");
  assert.match(unknown[0], /^value\.type must be /, "the first complaint names the type");
});

test("checkActionParams: known types are checked, unknown (legacy) types are skipped", () => {
  assert.deepEqual(checkActionParams(ACTION_DEFS, "moveJob", { job: "x", newStart: "2026-01-01" }), { known: false, errors: [] });
  const r = checkActionParams(ACTION_DEFS, "docRequest", { job: "Hansen" });
  assert.equal(r.known, true);
  assert.deepEqual(r.errors, ["params.items is required"]);
});

/* ---------- 3. the browser copy is in lockstep ---------- */

test("apps/field/js/actionschemas.js + schemacheck.js match what emit-client.mjs renders", () => {
  const rendered = renderClientFiles();
  for (const [name, body] of Object.entries(rendered)) {
    let onDisk = "";
    try { onDisk = readFileSync(join(CLIENT_DIR, name), "utf8"); } catch { /* missing = drift */ }
    assert.equal(onDisk, body,
      `apps/field/js/${name} is stale — run: node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs`);
  }
});

test("the browser checker is the server checker", async () => {
  const client = await import(join(CLIENT_DIR, "schemacheck.js"));
  const schemas = await import(join(CLIENT_DIR, "actionschemas.js"));
  assert.deepEqual(Object.keys(schemas.ACTION_SCHEMAS), Object.keys(ACTION_DEFS));
  assert.deepEqual(schemas.ACTIONSETS, ACTIONSETS);
  const bad = { job: "x", stage: "started" };
  assert.deepEqual(
    client.validateSchema(schemas.ACTION_SCHEMAS.boardWrite, bad, "params"),
    validateSchema(ACTION_DEFS.boardWrite.input_schema, bad, "params"));
});

/* ---------- the P7 consumer: the schemas round-trip into an MCP tool list ---------- */
test("every action schema is a complete MCP tool definition without edits", () => {
  const mcpTools = Object.entries(ACTION_DEFS).map(([name, d]) => ({ name: `propose_${name}`, description: d.desc, inputSchema: d.input_schema }));
  for (const t of mcpTools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, `${t.name} is a legal MCP tool name`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 0);
    // JSON-serializable, no functions or undefined leaking from the builders
    assert.equal(JSON.parse(JSON.stringify(t.inputSchema)).type, "object");
  }
});
