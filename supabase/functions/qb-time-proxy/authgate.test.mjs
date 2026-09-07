/* The per-action auth gate on the three integration proxies — F-003.
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
      cron   — the x-cron-secret header (a cron / an internal webhook) */
const EXPECTED = {
  "qbo-proxy": {
    getStatus: ["user"],
    exchangeCode: ["office"],
    disconnect: ["office"],
    pushInvoice: ["staff"],
    invoiceLink: ["staff"],
    pullPayments: ["cron"],
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
