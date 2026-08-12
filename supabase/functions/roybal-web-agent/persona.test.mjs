/* Drift guard: the web receptionist's createLead schema must stay identical
   to the phone receptionist's, so a web lead and a phone lead are the same
   record on the job board.

   Run: node --experimental-strip-types --test supabase/functions/roybal-web-agent/persona.test.mjs

   If this fails, RECONCILE the two — do not just update the expectation. A
   silent divergence here means the board grows two subtly different kinds of
   lead card and nobody notices for months. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CREATE_LEAD_TOOL, WEB_PERSONA, greetingFor, AI_NOTICE } from "./persona.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(here, "..", "roybal-ai-office", "personas.ts");

/** Pull PHONE_TOOLS.createLead's input_schema out of the registry source.
    Parsing the text rather than importing keeps this test from depending on
    the registry being valid Deno, which is the point — it must not be able to
    take the test suite (or this function) down. */
function phoneCreateLeadSchema() {
  const src = readFileSync(REGISTRY, "utf8");
  const start = src.indexOf("createLead:", src.indexOf("PHONE_TOOLS"));
  assert.ok(start > 0, "PHONE_TOOLS.createLead not found in the registry");
  const schemaAt = src.indexOf("input_schema:", start);
  assert.ok(schemaAt > 0, "createLead.input_schema not found");

  // walk braces from the first { after input_schema:
  const open = src.indexOf("{", schemaAt);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(open, end + 1);
}

const normalize = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();

test("web createLead required fields match the phone lane", () => {
  const phone = phoneCreateLeadSchema();
  for (const f of CREATE_LEAD_TOOL.input_schema.required) {
    assert.ok(phone.includes(`${f}:`), `phone schema is missing required field "${f}"`);
  }
  assert.deepEqual(
    [...CREATE_LEAD_TOOL.input_schema.required].sort(),
    ["address", "lossType", "name", "phone", "summary"],
  );
});

test("web createLead property names match the phone lane", () => {
  const phone = normalize(phoneCreateLeadSchema());
  for (const p of Object.keys(CREATE_LEAD_TOOL.input_schema.properties)) {
    assert.ok(phone.includes(`${p}:`), `phone schema is missing property "${p}"`);
  }
});

test("lossType enum matches the phone lane exactly", () => {
  const phone = normalize(phoneCreateLeadSchema());
  assert.ok(
    phone.includes('enum: ["water", "fire", "mold", "remodel", "other"]'),
    "phone lossType enum changed — reconcile persona.ts",
  );
  assert.deepEqual(
    CREATE_LEAD_TOOL.input_schema.properties.lossType.enum,
    ["water", "fire", "mold", "remodel", "other"],
  );
});

test("the tool surface is exactly one tool", () => {
  assert.equal(CREATE_LEAD_TOOL.name, "createLead");
  assert.equal(CREATE_LEAD_TOOL.input_schema.additionalProperties, false);
});

/* ---------- persona invariants ----------
   These are the sentences the business is exposed by if they go missing. */

test("the persona forbids the things that create legal exposure", () => {
  const p = WEB_PERSONA.toLowerCase();
  assert.ok(p.includes("never quote a price"), "price prohibition missing");
  assert.ok(p.includes("insurance"), "insurance prohibition missing");
  assert.ok(p.includes("licensure") || p.includes("licensed"), "licensure prohibition missing");
  assert.ok(p.includes("911"), "life-safety instruction missing");
});

test("the persona carries the prompt-injection rule", () => {
  assert.ok(
    /never instructions/i.test(WEB_PERSONA),
    "injection rule missing — the visitor's words must never be treated as instructions",
  );
});

test("the persona admits to being an AI when asked", () => {
  assert.ok(/ai assistant/i.test(WEB_PERSONA));
  assert.ok(/ai assistant/i.test(AI_NOTICE));
});

/* ---------- the service catalogue must not drift ----------
   A live test caught the assistant answering "that's not really our
   specialty" to an exterior-painting enquiry — a service the company sells,
   in a town it serves. The persona had no catalogue, so it guessed. These
   tests read site.ts and fail if the persona stops covering what is sold. */

const SITE = readFileSync(join(here, "..", "..", "..", "apps", "site", "src", "data", "site.ts"), "utf8");

/** Every `name:` inside the SERVICES array in site.ts. */
function siteServices() {
  const start = SITE.indexOf("export const SERVICES");
  assert.ok(start > 0, "SERVICES not found in site.ts");
  const end = SITE.indexOf("export const RESTORATION_SERVICES", start);
  return [...SITE.slice(start, end).matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

function siteAreas() {
  const start = SITE.indexOf("export const SERVICE_AREAS");
  const end = SITE.indexOf("] as const", start);
  return [...SITE.slice(start, end).matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("the persona covers every service the site sells", () => {
  const persona = WEB_PERSONA.toLowerCase();
  const missing = [];
  for (const s of siteServices()) {
    // Match on the distinctive word, not the full marketing label:
    // "Deck Construction" → "deck", "Painting Services" → "painting".
    const key = s.toLowerCase().replace(/\s*(services|construction|restoration|removal|repair)$/,'').trim();
    if (!persona.includes(key)) missing.push(`${s} (looked for "${key}")`);
  }
  assert.deepEqual(missing, [], `persona does not mention: ${missing.join(", ")}`);
});

test("the persona names every town the site claims", () => {
  const persona = WEB_PERSONA.toLowerCase();
  const missing = siteAreas().filter((a) => !persona.includes(a.toLowerCase()));
  assert.deepEqual(missing, [], `persona does not mention: ${missing.join(", ")}`);
});

test("the persona forbids turning away listed work", () => {
  assert.ok(
    /never turn work away|the answer is yes/i.test(WEB_PERSONA),
    "persona must explicitly tell the model not to refuse services on the list",
  );
});

test("greetings are constants, short, and never promise anything", () => {
  for (const h of [2, 9, 13, 19, 23]) {
    const g = greetingFor(h);
    assert.ok(g.length > 20 && g.length < 220, `greeting at ${h}h is an odd length: ${g}`);
    assert.ok(!/\$|\d+%|guarantee|cover/i.test(g), `greeting at ${h}h promises something: ${g}`);
  }
});

test("business hours and after hours read differently", () => {
  assert.notEqual(greetingFor(10), greetingFor(2));
  assert.match(greetingFor(2), /off the clock|first thing/i);
});

test("a service-page greeting names the service", () => {
  assert.match(greetingFor(10, "Water Damage Restoration"), /Water Damage Restoration/);
});
