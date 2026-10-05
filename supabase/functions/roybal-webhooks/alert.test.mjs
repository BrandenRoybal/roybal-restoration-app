import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAlert, alertText, safeEqual, parseAlertBody, projectRef, STALE_MS, GUARD_MS } from "./alert.ts";

const T0 = Date.parse("2026-10-05T19:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

test("a fresh heartbeat is never an alarm; 10 minutes of silence is", () => {
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: iso(T0 - 2 * 60_000), lastTextedAt: null }).text, false);
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: iso(T0 - STALE_MS + 1000), lastTextedAt: null }).text, false);
  const d = decideAlert({ now: T0, lastHeartbeatAt: iso(T0 - 14 * 60_000), lastTextedAt: null });
  assert.equal(d.text, true);
  assert.equal(d.reason, "stale");
  assert.equal(d.staleMinutes, 14);
});

test("no heartbeat on record is an alarm, an unreadable one too", () => {
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: null, lastTextedAt: null }).text, true);
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: "garbage", lastTextedAt: null }).text, true);
});

test("one text per 24 hours, even when the worker is still down", () => {
  const stale = iso(T0 - 60 * 60_000);
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: stale, lastTextedAt: iso(T0 - 3600_000) }).text, false);
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: stale, lastTextedAt: iso(T0 - GUARD_MS + 1000) }).text, false);
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: stale, lastTextedAt: iso(T0 - GUARD_MS - 1000) }).text, true);
  // the guard wins over "no heartbeat on record" too
  assert.equal(decideAlert({ now: T0, lastHeartbeatAt: null, lastTextedAt: iso(T0 - 1000) }).text, false);
});

test("the text names the gap in Alaska time, fits an SMS, and says what to run", () => {
  const t = alertText({ now: T0, lastHeartbeatAt: iso(T0 - 14 * 60_000), workerId: "roybal-worker-abc" });
  assert.match(t, /^Roybal worker is down: no check-in since Oct 5, 10:46 AM Alaska time \(14 min\)\./);
  assert.match(t, /fly status -a roybal-worker/);
  assert.ok(t.length <= 300, `length ${t.length}`);
  assert.doesNotMatch(t, /Project/, "no project line when none is known");
  assert.match(alertText({ now: T0, lastHeartbeatAt: null }), /never checked in/);
  const p = alertText({ now: T0, lastHeartbeatAt: iso(T0 - 14 * 60_000), project: "djpgvcvhvgrzgaziruze" });
  assert.match(p, /\(14 min\)\. Project djpgvcvhvgrzgaziruze\. Approved texts/);
  assert.ok(p.length <= 300, `length ${p.length}`);
});

test("projectRef reads the ref out of a Supabase URL and nothing else", () => {
  assert.equal(projectRef("https://djpgvcvhvgrzgaziruze.supabase.co"), "djpgvcvhvgrzgaziruze");
  assert.equal(projectRef("http://localhost:54321"), null);
  assert.equal(projectRef(""), null);
  assert.equal(projectRef(undefined), null);
});

test("safeEqual is exact and refuses empties", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual("é", "é"), true);
});

test("parseAlertBody clips and tolerates junk", () => {
  assert.deepEqual(parseAlertBody(null), { kind: "", worker_id: null, last_heartbeat_at: null });
  const b = parseAlertBody({ kind: "worker_down", worker_id: "w".repeat(200), last_heartbeat_at: "2026-10-05T18:46:00Z", extra: 1 });
  assert.equal(b.kind, "worker_down");
  assert.equal(b.worker_id.length, 120);
  assert.equal(b.last_heartbeat_at, "2026-10-05T18:46:00Z");
});
