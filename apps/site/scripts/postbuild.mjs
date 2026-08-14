#!/usr/bin/env node
/**
 * Post-build fixups and deploy guards.
 *
 * 1. /sitemap.xml — the old robots.txt advertised that exact path and it is
 *    the URL registered in Search Console. @astrojs/sitemap emits
 *    sitemap-index.xml, so publish a copy at the name Google is already
 *    polling. (A sitemap index served at /sitemap.xml is valid; it just
 *    points at the sitemap-0.xml sibling.)
 *
 * 2. Conversion-path guard — on 2026-08-13 a build without apps/site/.env
 *    silently shipped with no receptionist panel and a quote form posting
 *    nowhere. The components now carry committed production defaults, and
 *    this guard makes the failure mode structurally undeployable anyway:
 *    the build FAILS unless the rendered HTML contains both the receptionist
 *    markup and the quote form's endpoint. The one sanctioned exception is
 *    the receptionist's explicit build-time kill switch
 *    (PUBLIC_WEB_AGENT_ENDPOINT="" or "off"), which skips that check with a
 *    loud warning. A dead quote form has no sanctioned state and always fails.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(site, "dist");

/* ── 1. sitemap alias ─────────────────────────────────────────── */

const index = join(dist, "sitemap-index.xml");
if (!existsSync(index)) {
  console.error("postbuild: sitemap-index.xml missing — did the sitemap integration run?");
  process.exit(1);
}
copyFileSync(index, join(dist, "sitemap.xml"));
console.log("  postbuild: /sitemap.xml published (matches the URL in Search Console)");

/* ── 2. conversion-path guard ─────────────────────────────────── */

/* Resolve the env vars the way the Astro build did: a real process env var
   wins (that is Vite's precedence and what Cloudflare's build UI sets),
   falling back to apps/site/.env for local builds. The .env parse is
   deliberately minimal — this project uses plain KEY=VALUE lines only. */
function dotEnv() {
  const file = join(site, ".env");
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#")) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}
const fileVars = dotEnv();
const envVar = (key) => (key in process.env ? process.env[key] : fileVars[key]);

/* Mirrors resolveEndpoint() in src/data/site.ts — keep the two in sync.
   (This script runs under plain node, so it cannot import the .ts module.) */
const resolve = (raw, fallback) => {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value.toLowerCase() === "off" ? "" : value;
};
const DEFAULT_LEAD = "https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-lead";
const DEFAULT_AGENT = "https://djpgvcvhvgrzgaziruze.supabase.co/functions/v1/roybal-web-agent";

const failures = [];

/* The quote form — the primary conversion path, no sanctioned off state.
   It renders on /contact-us (and /give-feedback), not the homepage. */
const leadEndpoint = resolve(envVar("PUBLIC_LEAD_ENDPOINT"), DEFAULT_LEAD);
const contact = join(dist, "contact-us.html");
if (!leadEndpoint) {
  failures.push(
    "PUBLIC_LEAD_ENDPOINT is explicitly blanked — that ships a quote form posting " +
      "nowhere, which is never deployable. Unset it to use the committed default.",
  );
} else if (!existsSync(contact)) {
  failures.push("dist/contact-us.html missing — the quote form page did not build.");
} else if (!readFileSync(contact, "utf8").includes(`action="${leadEndpoint}"`)) {
  failures.push(
    `dist/contact-us.html has no form posting to ${leadEndpoint} — ` +
      "the quote form lost its endpoint.",
  );
}

/* The receptionist — on every page via Base.astro, so index.html stands in
   for all of them. Explicit blank/"off" is the sanctioned kill switch. */
const agentEndpoint = resolve(envVar("PUBLIC_WEB_AGENT_ENDPOINT"), DEFAULT_AGENT);
if (!agentEndpoint) {
  console.warn(
    "  postbuild: ⚠️  PUBLIC_WEB_AGENT_ENDPOINT explicitly blanked — building WITHOUT " +
      "the receptionist panel. If this is not a deliberate kill, unset the var.",
  );
} else {
  const home = readFileSync(join(dist, "index.html"), "utf8");
  if (!home.includes("rcp__pill") || !home.includes(`data-endpoint="${agentEndpoint}"`)) {
    failures.push(
      "dist/index.html lacks the receptionist markup (rcp__pill / data-endpoint) — " +
        "the panel was silently dropped from the build.",
    );
  }
}

if (failures.length) {
  console.error("  postbuild: ✗ DEPLOY GUARD FAILED — this build must not ship:");
  for (const f of failures) console.error(`    - ${f}`);
  process.exit(1);
}
console.log(
  agentEndpoint
    ? "  postbuild: ✓ deploy guard — quote form and receptionist are in the build"
    : "  postbuild: ✓ deploy guard — quote form is in the build (receptionist deliberately off)",
);
