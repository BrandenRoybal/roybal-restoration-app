/* The per-action auth gate on the integration proxies — F-003 (and magicplan-proxy, 2026-09-25).
   Run: node --experimental-strip-types --test supabase/functions/qb-time-proxy/authgate.test.mjs
   (picked up by `npm run fn:test`, which globs every function dir's .test.mjs)

   WHY one file for three functions: qbo-proxy, qb-time-proxy and gmail-proxy
   all sit behind the same door — verify_jwt=true, which admits the publishable
   key committed at apps/field/js/config.js:8 and served on the public site. So
   they now share one gate design (ACTION_AUTH + authorize before dispatch) and
   one test asserting it holds. The index.ts files cannot be imported here (they
   are Deno modules with URL imports and a top-level serve), so this reads them
   as text — the same technique as roybal-web-agent/guards.test.mjs.

   A failure here is a security regression, not a style nit. In particular the
   expected tables below are deliberately a SECOND copy of the policy: a new
   action, or a quietly widened one, fails this test until someone states the
   intent in both places. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fnDir = dirname(here);
const read = (fn) => readFileSync(join(fnDir, fn, "index.ts"), "utf8");

/** The policy, restated. Keys are the actions the handler dispatches; values
    are the caller kinds each admits.
      user   — any valid signed-in user JWT
      staff  — a JWT whose profiles.role is admin|office|tech
      office — a JWT whose profiles.role is admin|office
      cron   — the x-cron-secret header (a cron / an internal webhook)
      service — the service role itself (the worker): qbo-proxy only, see
                the checks at the end of this file */
const EXPECTED = {
  "qbo-proxy": {
    getStatus: ["user"],
    exchangeCode: ["office"],
    disconnect: ["office"],
    pushInvoice: ["staff"],
    invoiceLink: ["staff"],
    pullPayments: ["cron"],
    listProjects: ["office", "service"],  // receipts phase 3: the admin's project picker + the worker's matcher
    listPurchases: ["service"],           // every expense in a window: the worker only
    listBills: ["service"],               // every bill in a window: the worker only
    completePurchase: ["service"],        // writes QuickBooks after an owner approval: the worker only
  },
  "qb-time-proxy": {
    exchangeCode: ["office"],
    getStatus: ["user"],
    disconnect: ["office"],
    syncJobcodes: ["office"],
    getTimesheets: ["office"],
    getUsers: ["office"],
    getCurrentTotals: ["office"],
    pullDay: ["user"],
    pullRange: ["user"],
    pullAllLinked: ["cron", "user"],
    rematchAll: ["cron", "user"],
    clockinSweep: ["cron", "user"],
  },
  "gmail-proxy": {
    getStatus: ["user"],
    exchangeCode: ["office"],
    disconnect: ["office"],
    pullInbox: ["cron", "user"],
    sendEmail: ["cron", "user"],
  },
  "magicplan-proxy": {
    getWorkspace: ["office"],
    createProject: ["office"],
    status: ["office"],
    sync: ["office"],
    markImported: ["office"],
    archiveProject: ["office"],
    linkExport: ["office"],
    esxExport: ["office"],     // M3: the ESX sketch — runs the export configuration, so office only
    listProjects: ["office"],  // the Floor plan chip's Link: every project name and address in the workspace
    linkProject: ["office"],
  },
};

/** Parse the ACTION_AUTH literal out of an index.ts. */
function actionAuth(src) {
  const block = /const ACTION_AUTH[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "ACTION_AUTH table not found — the gate is gone");
  const table = {};
  for (const m of block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
    table[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]);
  }
  return table;
}

/** Every action the handler actually dispatches on. */
function dispatched(src) {
  return [...src.matchAll(/if \(action === "([^"]+)"\)/g)].map((m) => m[1]);
}

for (const [fn, expected] of Object.entries(EXPECTED)) {
  const src = read(fn);

  test(`${fn}: every dispatched action is declared in ACTION_AUTH`, () => {
    const table = actionAuth(src);
    for (const action of dispatched(src)) {
      assert.ok(table[action], `${fn} dispatches "${action}" with no ACTION_AUTH entry — it would be refused as unknown, and if the default-deny were ever relaxed it would be OPEN to the publishable key`);
    }
  });

  test(`${fn}: ACTION_AUTH has no stale entry`, () => {
    const live = new Set(dispatched(src));
    for (const action of Object.keys(actionAuth(src))) {
      assert.ok(live.has(action), `${fn} grants "${action}" but never dispatches it`);
    }
  });

  test(`${fn}: the policy is exactly what we intend`, () => {
    assert.deepEqual(actionAuth(src), expected);
  });

  test(`${fn}: the gate runs BEFORE the first dispatch`, () => {
    const gate = src.indexOf("await authorize(");
    const first = src.search(/if \(action === "/);
    assert.ok(gate > 0, `${fn} never calls authorize()`);
    assert.ok(gate < first, `${fn} dispatches an action before the gate runs`);
  });

  test(`${fn}: the publishable key is rejected by shape, not just by name`, () => {
    // token === SUPABASE_ANON_KEY only catches the LEGACY anon key. The key
    // that actually ships in the browser is sb_publishable_… — not a JWT —
    // so userJwt must also require the three-segment shape.
    assert.match(src, /\/\^\[\\w-\]\+\\\.\[\\w-\]\+\\\.\[\\w-\]\+\$\/\.test\(token\)/,
      `${fn} lost the JWT-shape check in userJwt`);
  });

  test(`${fn}: an unknown action is refused, not ignored`, () => {
    assert.match(src, /if \(!allowed\) return \{ deny: err\(`Unknown action/,
      `${fn} lost the default-deny for unlisted actions`);
  });
}

/* The 'service' kind (receipts phase 3). The worker's key is an sb_secret_
   key, which no user check can admit, so qbo-proxy proves it another way.
   A shape test alone would hand QuickBooks writes to ANY sb_secret_ string,
   so the proof must be the exact own key or the service-role-only ping, and
   only qbo-proxy may know the kind at all. The behaviour itself is driven
   through index.ts in qbo-proxy/purchases.test.mjs. */
test("only qbo-proxy grants the service kind", () => {
  // (each table is pinned to EXPECTED above, so checking EXPECTED is enough)
  for (const [fn, expected] of Object.entries(EXPECTED)) {
    if (fn === "qbo-proxy") continue;
    assert.ok(!Object.values(expected).flat().includes("service"), `${fn} grants 'service', which nothing there can prove`);
  }
});

test("qbo-proxy: a service caller is proven, never assumed from the key's shape", () => {
  const src = read("qbo-proxy");
  const body = /async function viaServiceKey[\s\S]*?\n\}\n/.exec(src)?.[0] ?? "";
  assert.ok(body, "viaServiceKey is gone");
  assert.match(body, /sameKey\(token, Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/, "the fast path must be an exact compare with the function's own key");
  assert.match(body, /\/rest\/v1\/rpc\/qbo_service_ping/, "another sb_secret_ key must be proven by the service-role-only ping");
  assert.match(body, /\(await res\.json\(\)[^;]*\) === true;/, "the ping must answer exactly true");
  assert.doesNotMatch(body, /console\./, "the key must never be logged");
  // the service check sits inside the gate and admits only actions that list it
  assert.match(src, /if \(allowed\.includes\("service"\) && await viaServiceKey\(req\)\)/);
  // and a service-only action is not open to a user JWT
  assert.match(src, /if \(!allowed\.some\(\(a\) => a !== "cron" && a !== "service"\)\)/);
});
