#!/usr/bin/env node
/* Re-shoot every screenshot in the manual from the apps on this checkout.
   Usage (repo root):  node docs/manual/tools/shoot.mjs [name-filter]
   Starts the local static servers, mocks ALL network (mock.mjs + demo-data.mjs:
   made-up data only), and writes PNGs to docs/manual/shots/. */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";
import { installMocks } from "./mock.mjs";
import { PORTAL_TOKEN } from "./demo-data.mjs";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { return require(p); } catch {} }
  throw new Error("Playwright not found: npm i -D playwright (or run where it is installed)");
}
const { chromium } = loadPlaywright();

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "docs/manual/shots");
mkdirSync(OUT, { recursive: true });
const BUILD = (readFileSync(join(ROOT, "apps/field/js/config.js"), "utf8").match(/BUILD = "(v\d+)"/) || [])[1] || "v0";

const ADMIN = 4391, PORTAL = 4392;   // admin's server also serves the field app (/) and the board (/board/)
const servers = [
  spawn(process.execPath, [join(ROOT, "apps/admin/serve.mjs"), String(ADMIN)], { stdio: "ignore" }),
  spawn(process.execPath, [join(ROOT, "apps/portal/serve.mjs"), String(PORTAL)], { stdio: "ignore" }),
];
const F = `http://localhost:${ADMIN}`;
const P = `http://localhost:${PORTAL}`;
const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 800 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A shot: name, url, viewport, signedIn, optional steps(page), fullPage/clip height. */
const SHOTS = [
  { name: "field-signin", url: `${F}/`, vp: PHONE, signedIn: false },
  { name: "field-jobs", url: `${F}/`, vp: PHONE, mode: "restoration" },
  { name: "field-construction-list", url: `${F}/`, vp: PHONE, mode: "construction" },
  { name: "field-leadbids", url: `${F}/`, vp: PHONE, mode: "bids" },
  { name: "field-account", url: `${F}/`, vp: PHONE, steps: async (p) => { await p.click("text=👤 >> nth=1").catch(() => p.click("button[title*='ccount']")); await sleep(500); } },
  { name: "field-job-home", url: `${F}/#/p/demo-job-whitaker`, vp: PHONE, full: 1900 },
  { name: "field-job-edit", url: `${F}/#/p/demo-job-whitaker/edit`, vp: PHONE, full: 1500 },
  { name: "field-moisture-map", url: `${F}/#/p/demo-job-whitaker/f/moistureMaps/mm1`, vp: PHONE, full: 2200 },
  { name: "field-drying-log", url: `${F}/#/p/demo-job-whitaker/f/dryingLogs/dl1`, vp: PHONE, full: 1800 },
  { name: "field-photos", url: `${F}/#/p/demo-job-whitaker/f/photos`, vp: PHONE, full: 1700 },
  { name: "field-work-auth", url: `${F}/#/p/demo-job-whitaker/f/workAuth`, vp: PHONE, full: 1800 },
  { name: "field-receipts", url: `${F}/#/p/demo-job-marsh/f/receipts`, vp: PHONE, full: 1400 },
  { name: "field-receipt-edit", url: `${F}/#/p/demo-job-whitaker/f/receipts/rc1`, vp: PHONE, full: 1700 },
  { name: "field-portal-form", url: `${F}/#/p/demo-job-whitaker/f/portalShare`, vp: PHONE, full: 2000 },
  { name: "field-packet", url: `${F}/#/p/demo-job-whitaker/packet`, vp: PHONE, full: 1100 },
  { name: "field-construction-home", url: `${F}/#/p/demo-job-marsh`, vp: PHONE, full: 1900 },
  { name: "admin-today", url: `${F}/admin/`, vp: DESK },
  { name: "admin-approvals", url: `${F}/admin/#/approvals`, vp: DESK, full: 1100 },
  { name: "admin-leads", url: `${F}/admin/#/leads`, vp: DESK },
  { name: "admin-jobs", url: `${F}/admin/#/jobs`, vp: DESK },
  { name: "admin-receipts", url: `${F}/admin/#/receipts`, vp: DESK },
  { name: "admin-contacts", url: `${F}/admin/#/contacts`, vp: DESK },
  { name: "admin-settings", url: `${F}/admin/#/settings`, vp: DESK },
  { name: "board-kanban", url: `${F}/board/`, vp: DESK },
  { name: "board-crew", url: `${F}/board/`, vp: DESK, steps: async (p) => { await p.click("text=Crew >> nth=0"); await sleep(800); } },
  { name: "board-gantt", url: `${F}/board/`, vp: DESK, steps: async (p) => { await p.click("text=Gantt"); await sleep(800); } },
  { name: "board-editor", url: `${F}/board/`, vp: { width: 1280, height: 1500 }, steps: async (p) => { await p.click("text=Marsh kitchen + mudroom"); await sleep(800); } },
  { name: "field-estimate", url: `${F}/#/p/demo-job-marsh/f/reconEstimates/est1`, vp: PHONE, full: 2000 },
  { name: "admin-campaigns", url: `${F}/admin/#/campaigns`, vp: DESK },
  { name: "board-table", url: `${F}/board/`, vp: DESK, steps: async (p) => { await p.click("text=Table"); await sleep(800); } },
  { name: "board-pipeline", url: `${F}/board/`, vp: DESK, steps: async (p) => { await p.click("text=Pipeline"); await sleep(800); } },
  { name: "portal-sign", url: `${P}/j/${PORTAL_TOKEN}`, vp: PHONE, full: 1300, steps: async (p) => {
      await p.click("text=Read the change order"); await sleep(800); await p.click("text=Done reading").catch(() => {}); await sleep(800);
      await p.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => /Type your full legal name/.test(e.placeholder || "")); if (el) el.scrollIntoView({ block: "center" }); }); await sleep(400); } },
  { name: "portal-home", url: `${P}/j/${PORTAL_TOKEN}`, vp: PHONE, full: 2600 },
];

const filter = process.argv[2] || "";
const browser = await chromium.launch();
await sleep(600);
try {
  for (const s of SHOTS.filter((s) => s.name.includes(filter))) {
    const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: 1.5, serviceWorkers: "block",
      timezoneId: "America/Anchorage", locale: "en-US" });
    await installMocks(ctx);
    await ctx.addInitScript(({ signedIn, mode, build }) => {
      if (signedIn) {
        localStorage.setItem("roybal-session", JSON.stringify({ access_token: "demo", refresh_token: "demo", expires_at: Date.now() + 864e5, email: "branden@example.com" }));
        localStorage.setItem("roybal-tech", JSON.stringify({ id: "crew-cj", name: "CJ" }));
      }
      if (mode) localStorage.setItem("roybal-mode", mode);
      try { caches.open("roybal-field-" + build); } catch (_) {}
    }, { signedIn: s.signedIn !== false, mode: s.mode || "", build: BUILD });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  [${s.name}] pageerror: ${e.message}`));
    // first load pulls the demo jobs into IndexedDB; the second shows them
    const base = s.url.split("#")[0];
    await page.goto(base); await sleep(2500);
    await page.goto(s.url); await page.reload(); await sleep(2500);
    if (s.steps) await s.steps(page);
    if (s.full) await page.setViewportSize({ width: s.vp.width, height: s.full });
    await sleep(500);
    await page.screenshot({ path: join(OUT, s.name + ".jpg"), type: "jpeg", quality: 80 });
    console.log("shot", s.name);
    await ctx.close();
  }
} finally {
  await browser.close();
  servers.forEach((sv) => sv.kill());
}
