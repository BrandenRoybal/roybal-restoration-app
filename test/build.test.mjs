/* The server's min-build gate compares the build the client SENDS against a
   floor. That number is only trustworthy if the shipped constant matches the
   service-worker cache the deploy actually publishes — if they drift, a stale
   device can report a build it isn't running.
   Run: node test/build.test.mjs */
import { readFileSync } from "node:fs";
import { BUILD } from "../js/config.js";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const cache = (sw.match(/const CACHE = "roybal-field-(v\d+)"/) || [])[1];

ok(!!cache, "sw.js declares a roybal-field-vNNN cache name");
ok(/^v\d+$/.test(BUILD), "config.js BUILD is a vNNN string");
ok(BUILD === cache, `config.js BUILD (${BUILD}) matches sw.js CACHE (${cache}) — bump them together`);

console.log(failures ? `\nFAILED: ${failures}` : "\nBUILD TAG IN LOCKSTEP");
process.exit(failures ? 1 : 0);
