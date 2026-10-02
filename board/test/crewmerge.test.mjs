/* Crew saves merge onto the server copy instead of clobbering it.
   Run: node apps/board/test/crewmerge.test.mjs

   Why this exists: crew_members rows are whole-object last-write-wins (no rev
   guard), and data.email is now the link between a login and a crew card. A
   writer holding a pre-email copy — the Out toggle, the assistant's
   availability action, a long-open editor modal — used to erase it silently
   and break that tech's My Week. */
import assert from "node:assert/strict";
import { crewMergedOverServer } from "../js/crewmerge.js";

let pass = 0;
const test = async (name, fn) => { await fn(); console.log("  ✓ " + name); pass++; };
const server = (data) => async () => data;

const SERVER = { id: "c1", name: "Joel Hess", phone: "907-555-0101", email: "joel@x.com", active: true };

await test("a stale copy that predates the email field keeps the server's email", async () => {
  const stale = { id: "c1", name: "Joel Hess", phone: "907-555-0101", active: true, outDays: ["2026-08-20"] };
  const m = await crewMergedOverServer(stale, server(SERVER));
  assert.equal(m.email, "joel@x.com");           // survived
  assert.deepEqual(m.outDays, ["2026-08-20"]);   // the caller's actual edit still lands
});

await test("a blank email never overwrites a real one", async () => {
  const m = await crewMergedOverServer({ ...SERVER, email: "   " }, server(SERVER));
  assert.equal(m.email, "joel@x.com");
});

await test("a deliberate email change still lands", async () => {
  const m = await crewMergedOverServer({ ...SERVER, email: "joel.hess@newmail.com" }, server(SERVER));
  assert.equal(m.email, "joel.hess@newmail.com");
});

await test("the caller wins on every field it actually carries", async () => {
  const m = await crewMergedOverServer({ ...SERVER, phone: "907-555-9999", role: "Lead Carpenter" }, server(SERVER));
  assert.equal(m.phone, "907-555-9999");
  assert.equal(m.role, "Lead Carpenter");
  assert.equal(m.name, "Joel Hess");
});

await test("server keys the caller never carried survive (qb link, bio, photo)", async () => {
  const rich = { ...SERVER, qbUserId: "42", qbUserName: "Joel H", bioPublic: true, photoUrl: "https://x/y.jpg" };
  const m = await crewMergedOverServer({ id: "c1", name: "Joel Hess", active: false }, server(rich));
  assert.equal(m.qbUserId, "42");
  assert.equal(m.bioPublic, true);
  assert.equal(m.photoUrl, "https://x/y.jpg");
  assert.equal(m.active, false);   // the edit itself
});

await test("a brand-new member (no server row) writes through untouched", async () => {
  const fresh = { id: "new", name: "New Guy", email: "new@x.com" };
  assert.deepEqual(await crewMergedOverServer(fresh, server(null)), fresh);
});

await test("a failed read never blocks the save", async () => {
  const local = { id: "c1", name: "Joel Hess" };
  const m = await crewMergedOverServer(local, async () => { throw new Error("offline"); });
  assert.deepEqual(m, local);
});

console.log(`crewmerge: ${pass} passed`);
