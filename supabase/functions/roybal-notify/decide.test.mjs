/* decide() — the order one answer runs in, whichever channel it came from
   (approve.ts), with the I/O stubbed. No Deno, no network.
   Run: node --experimental-strip-types --test supabase/functions/roybal-notify/decide.test.mjs

   handleApproval (a YES/NO text) and decidePending (the Approvals tab) both
   hand decide() the same wiring (decideIO in index.ts). The order is what
   keeps a 9pm customer text pending instead of burning it, and what stops a
   tap and a text from both firing one row, so these tests pin it. The last
   few read index.ts as text, the technique of qb-time-proxy/authgate.test.mjs,
   because index.ts can't be imported here (Deno URL imports and a top-level
   serve). */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide } from "./approve.ts";

/** One stubbed pending_actions row. `flip` honours the status=pending guard
    the way the PATCH filter does: check-and-set with no await in between,
    so it is as atomic here as the UPDATE is in Postgres. */
function row({ held = false, state = "pending", executes = async () => {}, fail = null } = {}) {
  const w = { state, calls: [] };
  w.io = {
    held,
    flip: async (to) => {
      await null;                         // the PATCH is a round trip
      w.calls.push("flip:" + to);
      if (w.state !== "pending") return false;
      w.state = to;
      return true;
    },
    execute: async () => {
      w.calls.push("execute");
      await executes();
      w.state = "executed";
    },
    fail: fail ?? (async (error) => { w.calls.push("fail:" + error); w.state = "failed"; }),
  };
  return w;
}

test("approve flips pending → approved first, then runs the executor", async () => {
  const w = row();
  assert.deepEqual(await decide("approve", w.io), { status: "executed" });
  assert.deepEqual(w.calls, ["flip:approved", "execute"]);
  assert.equal(w.state, "executed");
});

test("decline flips pending → declined and runs nothing", async () => {
  const w = row();
  assert.deepEqual(await decide("decline", w.io), { status: "declined" });
  assert.deepEqual(w.calls, ["flip:declined"]);
  assert.equal(w.state, "declined");
});

test("a held customer text is never flipped: it stays pending for the morning", async () => {
  const w = row({ held: true });
  assert.deepEqual(await decide("approve", w.io), { status: "quiet_hours" });
  assert.deepEqual(w.calls, [], "no PATCH at all, so the row is still live");
  assert.equal(w.state, "pending");
});

test("a held row can still be declined at 9pm", async () => {
  const w = row({ held: true });
  assert.deepEqual(await decide("decline", w.io), { status: "declined" });
});

test("an answer that lost the race is not_open and executes nothing", async () => {
  for (const state of ["approved", "executed", "failed", "declined", "expired"]) {
    const yes = row({ state });
    assert.deepEqual(await decide("approve", yes.io), { status: "not_open" }, `approve on ${state}`);
    assert.deepEqual(yes.calls, ["flip:approved"]);
    const no = row({ state });
    assert.deepEqual(await decide("decline", no.io), { status: "not_open" }, `decline on ${state}`);
    assert.equal(no.state, state, "a late NO never un-does what already happened");
  }
});

test("a tap and a text racing for one row execute it exactly once", async () => {
  const w = row();
  const outs = await Promise.all([decide("approve", w.io), decide("approve", w.io)]);
  assert.deepEqual(outs.map((o) => o.status).sort(), ["executed", "not_open"]);
  assert.equal(w.calls.filter((c) => c === "execute").length, 1);

  // an Approve racing a Decline: whichever flip lands first is the answer
  const v = row();
  const [a, d] = await Promise.all([decide("approve", v.io), decide("decline", v.io)]);
  assert.deepEqual([a.status, d.status], ["executed", "not_open"]);
  assert.equal(v.state, "executed");
});

test("an executor throw stamps the row failed with its sentence", async () => {
  const w = row({ executes: async () => { throw new Error("that job is no longer on the board"); } });
  assert.deepEqual(await decide("approve", w.io), { status: "failed", error: "that job is no longer on the board" });
  assert.deepEqual(w.calls, ["flip:approved", "execute", "fail:that job is no longer on the board"]);
  assert.equal(w.state, "failed", "never left sitting at approved");
});

test("the error is clipped to 300, the length result.error has always stored", async () => {
  const long = "x".repeat(500);
  const w = row({ executes: async () => { throw new Error(long); } });
  const out = await decide("approve", w.io);
  assert.equal(out.error.length, 300);
  assert.equal(w.calls[2], "fail:" + long.slice(0, 300));
});

test("a failed stamp that fails too still reports the failure, never throws", async () => {
  const boom = async () => { throw new Error("twilio 400"); };
  const rejects = row({ executes: boom, fail: async () => { throw new Error("db down"); } });
  assert.deepEqual(await decide("approve", rejects.io), { status: "failed", error: "twilio 400" });
  const throwsSync = row({ executes: boom, fail: () => { throw new Error("db down"); } });
  assert.deepEqual(await decide("approve", throwsSync.io), { status: "failed", error: "twilio 400" });
});

test("a thrown non-Error still becomes a sentence", async () => {
  const w = row({ executes: async () => { throw "gmail-proxy hung up"; } });
  assert.deepEqual(await decide("approve", w.io), { status: "failed", error: "gmail-proxy hung up" });
});

test("a flip that never answered is the caller's to report, and nothing executes", async () => {
  const w = row();
  w.io.flip = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(decide("approve", w.io), /fetch failed/);
  assert.deepEqual(w.calls, []);
});

/* ---------- index.ts, read as text ---------- */

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");
const fnBody = (name) => {
  const at = src.indexOf(`async function ${name}(`);
  assert.ok(at >= 0, `${name} is in index.ts`);
  return src.slice(at, src.indexOf("\n}\n", at));
};

test("both channels run decide() with the one shared wiring", () => {
  for (const name of ["handleApproval", "decidePending"]) {
    assert.match(fnBody(name), /await decide\(\w+(\.decision)?, decideIO\(act, admin\)\)/, name);
  }
  // one executor: a single gmail-proxy call site, reached only through decideIO
  assert.equal(src.split("/functions/v1/gmail-proxy").length - 1, 1);
  assert.equal(src.split("executeApproved(act, admin)").length - 1, 1);
});

test("decidePending proves the owner under the caller's JWT before touching the service role", () => {
  const body = fnBody("decidePending");
  const gate = body.search(/db\("rpc\/role_is", jwt, \{[^}]*p_roles: \["owner"\]/);
  assert.ok(gate >= 0, "role_is('owner') under the caller's jwt");
  assert.match(body, /\.catch\(\(\) => null\)\) !== true\) return answer\(\{ status: "not_owner" \}\)/, "only a literal true passes");
  assert.ok(gate < body.indexOf("SERVICE_KEY"), "the owner check comes first");
  assert.ok(body.indexOf("parseDecideRequest(") < body.indexOf("SERVICE_KEY"), "and so does the request check");
  assert.doesNotMatch(body, /twilioPost\(|\bsay\(/, "no text goes back for an inbox decision");
});

test("the router names both actions", () => {
  assert.match(src, /action === "decidePending"\) return await decidePending\(/);
  assert.match(src, /"Unknown action\. Expected one of: sendSms, decidePending"/);
});
