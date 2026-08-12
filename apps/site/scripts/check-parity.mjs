#!/usr/bin/env node
/**
 * URL parity gate.
 *
 * Every path the Marketing 360 site ranks for must resolve at the identical
 * URL on the new site. This diffs dist/ against the archived sitemap and
 * exits non-zero on any miss, so a rename can't quietly orphan a ranking page.
 *
 *   node scripts/check-parity.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const archive = join(here, "..", "..", "..", ".site-archive", "content.json");

if (!existsSync(dist)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(archive)) {
  console.error(`archive not found at ${archive}`);
  process.exit(1);
}

const pages = JSON.parse(readFileSync(archive, "utf8"));

/** Where a static host would look for `path` given build.format:'file'. */
const fileFor = (path) => (path === "/" ? "index.html" : `${path.replace(/^\//, "")}.html`);

const missing = [];
const found = [];
for (const p of pages) {
  const f = join(dist, fileFor(p.path));
  (existsSync(f) ? found : missing).push(p.path);
}

console.log(`\n  Archived live URLs : ${pages.length}`);
console.log(`  Present in dist/   : ${found.length}`);

if (missing.length) {
  console.error(`\n  ✗ MISSING ${missing.length} ranking URL(s):\n`);
  for (const m of missing) console.error(`      ${m}`);
  console.error(
    "\n  Each of these currently ranks. Restore the path, or add an explicit\n" +
      "  301 to its replacement before cutover.\n"
  );
  process.exit(1);
}

console.log("\n  ✓ All archived URLs resolve at identical paths.\n");
