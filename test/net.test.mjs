/* Shared network belief — likelyOffline() / noteNetworkOk() (core.js).
   navigator.onLine has false negatives: a home-screen app woken from sleep can
   report offline on perfect wifi and never fire "online" again. Every offline
   gate in the app asks likelyOffline(), so these rules decide whether a lying
   flag can disable sync, AI, voice and photo moves at once.
   Run: node apps/field/test/net.test.mjs   (from repo root) */
import assert from "node:assert";

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("  ✓ " + name); pass++; };
const setNav = (v) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true });

setNav({ onLine: true });
const { likelyOffline, noteNetworkOk } = await import("../js/core.js");

console.log("Network belief");

ok("flag says online -> not offline", likelyOffline() === false);

/* COLD START: the flag is the only evidence there is, so it is believed.
   This is the case the sync engine's periodic probe exists to rescue. */
setNav({ onLine: false });
ok("flag says offline and nothing has ever worked -> believed offline", likelyOffline() === true);

/* THE RESCUE: a request that actually reached the server outranks the flag. */
noteNetworkOk();
ok("a request that succeeded outranks the lying flag", likelyOffline() === false);
ok("…and the flag itself is still false — belief, not the flag, is what changed",
  navigator.onLine === false);

/* never block on the unknown */
setNav({});
ok("onLine undefined -> not offline (never gate on a missing flag)", likelyOffline() === false);
setNav(undefined);
ok("no navigator at all -> not offline", likelyOffline() === false);

console.log(`\n${pass} checks passed.`);
