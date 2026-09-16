#!/usr/bin/env node
/* ============================================================
   emit-client.mjs — the browser's copy of the action schemas
   ------------------------------------------------------------
   The field / board / admin apps validate a chip's params before
   the executor runs (apps/field/js/assist.js runAction), with the
   SAME schemas and the SAME checker the server uses. The browser
   cannot import this directory — the apps deploy from apps/ with
   no bundler until P3.0 — so this script writes two generated
   files into apps/field/js/ (the shared module directory all three
   apps reach through ../../js/):

     actionschemas.js  ACTION_SCHEMAS (name → input_schema) + ACTIONSETS
     schemacheck.js    validate.js, verbatim

   Run after editing actions.ts or validate.js:
     node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs

   personas.test.mjs renders the same output in memory and fails when
   the committed files differ — the lockstep guard, same idea as
   apps/field/test/build.test.mjs for the build tag.
   ============================================================ */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACTION_DEFS, ACTIONSETS } from "./actions.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = join(here, "..", "..", "..", "..", "apps", "field", "js");
export const CLIENT_FILES = { schemas: "actionschemas.js", checker: "schemacheck.js" };

const BANNER = (what) =>
  `/* GENERATED — do not edit. ${what}\n` +
  `   Source: supabase/functions/_shared/personas/ · regenerate with\n` +
  `   node --experimental-strip-types supabase/functions/_shared/personas/emit-client.mjs\n` +
  `   personas.test.mjs fails the build if this copy drifts from the source. */\n`;

/** The two files' contents, keyed like CLIENT_FILES. */
export function renderClientFiles() {
  const schemas = Object.fromEntries(Object.entries(ACTION_DEFS).map(([k, d]) => [k, d.input_schema]));
  const actionschemas =
    BANNER("The proposable actions' param schemas + which app may propose which.") +
    `export const ACTION_SCHEMAS = ${JSON.stringify(schemas, null, 2)};\n\n` +
    `export const ACTIONSETS = ${JSON.stringify(ACTIONSETS, null, 2)};\n`;
  const checker = BANNER("The JSON Schema checker the server runs, so a chip fails the same way in both places.") +
    readFileSync(join(here, "validate.js"), "utf8");
  return { [CLIENT_FILES.schemas]: actionschemas, [CLIENT_FILES.checker]: checker };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = renderClientFiles();
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(CLIENT_DIR, name), body);
    console.log(`wrote apps/field/js/${name} (${body.length} bytes)`);
  }
}
