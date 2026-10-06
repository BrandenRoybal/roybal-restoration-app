#!/usr/bin/env node
/* Build a branded PDF from docs/manual/: the app manual or the field SOP.
   Usage (repo root):  node docs/manual/tools/build.mjs [manual|sop] [out.pdf]
   Default: the manual, written to docs/manual/dist/Roybal_App_Manual.pdf
   (git-ignored); "sop" builds sop-water-mitigation.html into
   dist/Roybal_Water_Mitigation_SOP.pdf. A lone .pdf argument still means
   the manual, written there.
   Page numbers in the contents are filled by a second pass when python3 +
   pypdf are available; without them the contents still links, unnumbered. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { return require(p); } catch {} } throw new Error("Playwright not found"); })();

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIR = join(ROOT, "docs/manual");
const DOCS = {
  manual: { src: "manual.html", pdf: "Roybal_App_Manual.pdf", label: "App Manual" },
  sop: { src: "sop-water-mitigation.html", pdf: "Roybal_Water_Mitigation_SOP.pdf", label: "Water Mitigation SOP" },
};
const args = process.argv.slice(2);
const doc = DOCS[DOCS[args[0]] ? args.shift() : "manual"];
const out = resolve(args[0] || join(DIR, "dist", doc.pdf));
mkdirSync(dirname(out), { recursive: true });

const BUILD = (readFileSync(join(ROOT, "apps/field/js/config.js"), "utf8").match(/BUILD = "(v\d+)"/) || [])[1] || "";
const LICENSES = (readFileSync(join(ROOT, "apps/field/js/model.js"), "utf8").match(/licenses:\s*\[([\s\S]*?)\]/) || [, ""])[1]
  .match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)).join(" · ") || "";
const EDITION = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Anchorage" });

const SHORT_LIC = LICENSES.split(" · ").filter((l) => /GC Lic|WRT/.test(l)).join(" · ");
const footer = `<div style="width:100%;font-family:Helvetica Neue,Arial;font-size:7.5pt;color:#5b6b80;padding:0 0.5in;display:flex;justify-content:space-between;white-space:nowrap">
  <span>Roybal Construction, LLC · ${doc.label} · ${EDITION}</span><span>${SHORT_LIC}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

function fill(html, pages) {
  html = html.replaceAll("{{EDITION}}", EDITION).replaceAll("{{BUILD}}", BUILD).replaceAll("{{LICENSES}}", LICENSES);
  if (pages) html = html.replace(/<nav class="toc">[\s\S]*?<\/nav>/, (nav) => nav.replace(/<a (class="ch" )?href="#([\w-]+)">([^<]*)<\/a>/g,
    (m, ch, id, label) => pages[id] ? `<a ${ch || ""}href="#${id}">${label}<span>${pages[id]}</span></a>` : m));
  return html;
}

async function render(html, file) {
  const tmp = join(DIR, ".build.html");
  writeFileSync(tmp, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("file://" + tmp, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    // anchors for the page-number pass: the heading text of each contents target
    const targets = await page.evaluate(() => [...document.querySelectorAll(".toc a")].map((a) => {
      const id = a.getAttribute("href").slice(1); const el = document.getElementById(id);
      return { id, text: (el.querySelector("h1") || el).textContent.trim() };
    }));
    await page.pdf({ path: file, format: "Letter", printBackground: true, preferCSSPageSize: true, outline: true, tagged: true,
      displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: footer });
    return targets;
  } finally { await browser.close(); rmSync(tmp, { force: true }); }
}

const src = readFileSync(join(DIR, doc.src), "utf8");
const targets = await render(fill(src), out);

let pages = null;
try {
  const py = `
import sys, json, re
from pypdf import PdfReader
t = json.load(sys.stdin); r = PdfReader(sys.argv[1])
norm = lambda s: re.sub(r"\\W+", "", s).lower()
texts = [norm(p.extract_text() or "") for p in r.pages]
out, start = {}, 2   # skip cover + contents
for x in t:
    key = norm(x["text"])[:40]
    for i in range(start, len(texts)):
        if key and key in texts[i]: out[x["id"]] = i + 1; start = i; break
print(json.dumps(out))`;
  pages = JSON.parse(execFileSync("python3", ["-c", py, out], { input: JSON.stringify(targets) }).toString());
} catch (e) { console.warn("contents page numbers skipped (needs python3 + pypdf):", e.message.split("\n")[0]); }

if (pages && Object.keys(pages).length) await render(fill(src, pages), out);
console.log("wrote", out, pages ? `(${Object.keys(pages).length}/${targets.length} contents entries numbered)` : "");
