#!/usr/bin/env node
/**
 * Post-build fixups that keep the new site byte-compatible with what Google
 * already knows about this domain.
 *
 * 1. /sitemap.xml — the old robots.txt advertised that exact path and it is
 *    the URL registered in Search Console. @astrojs/sitemap emits
 *    sitemap-index.xml, so publish a copy at the name Google is already
 *    polling. (A sitemap index served at /sitemap.xml is valid; it just
 *    points at the sitemap-0.xml sibling.)
 */
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const index = join(dist, "sitemap-index.xml");
if (!existsSync(index)) {
  console.error("postbuild: sitemap-index.xml missing — did the sitemap integration run?");
  process.exit(1);
}
copyFileSync(index, join(dist, "sitemap.xml"));
console.log("  postbuild: /sitemap.xml published (matches the URL in Search Console)");
