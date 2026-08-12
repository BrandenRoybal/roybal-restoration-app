#!/usr/bin/env node
/**
 * Live URL parity gate — run this against a REAL deployment.
 *
 *   npm run site:check-live -- https://roybal-site.workers.dev
 *   npm run site:check-live -- https://www.roybalconstruction.com
 *
 * check-parity.mjs proves the 36 ranking URLs exist as FILES in dist/. That is
 * necessary and not sufficient: whether a visitor actually gets them depends on
 * how the host maps paths to files. A host that answers /contact-us with a 301
 * to /contact-us/ puts a redirect on all 36 ranking URLs at the exact moment
 * of cutover — the single most likely way to lose rankings in this migration,
 * and completely invisible in a local build.
 *
 * So this asks the server, and demands a bare 200. Run it on the *.workers.dev
 * URL BEFORE changing DNS.
 *
 * NOTE: point it at a real deployment or `npm run preview` (which serves
 * dist/), NOT at `npm run dev`. The dev server renders from source and never
 * runs postbuild, so /sitemap.xml legitimately 404s there — a false failure.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base)) {
  console.error("\n  usage: npm run site:check-live -- https://your-deployment-url\n");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const archive = join(here, "..", "..", "..", ".site-archive", "content.json");
if (!existsSync(archive)) {
  console.error(`archive not found at ${archive}`);
  process.exit(1);
}
const pages = JSON.parse(readFileSync(archive, "utf8"));

/** Follow nothing — a redirect is exactly what we are hunting for. */
async function probe(path) {
  const url = `${base}${path}`;
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "roybal-parity-check" } });
    return { path, status: res.status, location: res.headers.get("location") };
  } catch (err) {
    return { path, status: 0, error: String(err?.message ?? err) };
  }
}

console.log(`\n  Checking ${pages.length} ranking URLs against ${base}\n`);

const results = [];
// Sequential on purpose: 36 requests is nothing, and a burst from one IP can
// trip a host's rate limiter and produce a false failure.
for (const p of pages) {
  const r = await probe(p.path);
  results.push(r);
  const bad = r.status !== 200;
  if (bad) {
    const detail = r.error ? r.error : r.location ? `→ ${r.location}` : "";
    console.log(`  ✗ ${String(r.status).padEnd(3)} ${p.path}  ${detail}`);
  }
}

const failed = results.filter((r) => r.status !== 200);
const redirected = failed.filter((r) => r.status >= 300 && r.status < 400);

console.log(`\n  200 OK        : ${results.length - failed.length} / ${results.length}`);
if (redirected.length) console.log(`  redirected    : ${redirected.length}`);
if (failed.length - redirected.length) console.log(`  other failures: ${failed.length - redirected.length}`);

/* Extras worth catching while we are here. */
const extras = [
  { path: "/sitemap.xml", want: 200 },
  { path: "/robots.txt", want: 200 },
  { path: "/this-page-does-not-exist-9f3a", want: 404 },
];
console.log("");
for (const e of extras) {
  const r = await probe(e.path);
  const ok = r.status === e.want;
  console.log(`  ${ok ? "✓" : "✗"} ${e.path} → ${r.status} (expected ${e.want})`);
  if (!ok) failed.push(r);
}

if (failed.length) {
  console.error(
    `\n  ✗ ${failed.length} problem(s).\n` +
      (redirected.length
        ? "\n  Redirects on ranking URLs are the dangerous kind. If /contact-us is\n" +
          "  301ing to /contact-us/, the host is adding a trailing slash — check\n" +
          "  `html_handling` in wrangler.jsonc. Do NOT point DNS at this.\n"
        : "\n  Do NOT point DNS at this deployment until these resolve.\n"),
  );
  process.exit(1);
}

console.log("\n  ✓ Every ranking URL answers 200 with no redirect. Safe to cut over.\n");
