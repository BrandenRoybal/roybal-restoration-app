/* The carrier packet's configuration (docs/Carrier_Packet_Design.md §9, §11):
   the knobs parse and clamp like the others, the 'packet' channel is served
   only with Gmail and without CARRIER_PACKET=off, and packet.build is in the
   default queue kinds. The rest of loadConfig is tested in supa.test.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.mjs";

const base = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_k" };
const gmail = { ...base, GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "s" };

test("the packet knobs default to the design's values", () => {
  const c = loadConfig(gmail);
  assert.equal(c.carrierPacket, true);
  assert.equal(c.packetLookbackDays, 14);
  assert.equal(c.packetSettleMin, 120);
  assert.equal(c.packetMaxBuilds, 3);
  assert.equal(c.packetDownloads, 4);
  assert.equal(c.packetFullKb, 9500);
  assert.equal(c.packetHardKb, 17000);
  assert.equal(c.packetStorageMb, 300);
  assert.equal(c.packetTexts, true);
});

test("each packet knob is clamped, rounds, and keeps its default for blank or nonsense", () => {
  const knobs = [
    ["PACKET_LOOKBACK_DAYS", "packetLookbackDays", 14, 1, 90],
    ["PACKET_SETTLE_MIN", "packetSettleMin", 120, 0, 1440],
    ["PACKET_MAX_BUILDS", "packetMaxBuilds", 3, 1, 10],
    ["PACKET_DOWNLOADS", "packetDownloads", 4, 1, 8],
    ["PACKET_FULL_KB", "packetFullKb", 9500, 1000, 17000],
    ["PACKET_HARD_KB", "packetHardKb", 17000, 2000, 18000],
    ["PACKET_STORAGE_MB", "packetStorageMb", 300, 50, 900],
  ];
  for (const [env, key, dflt, lo, hi] of knobs) {
    const v = (raw) => loadConfig({ ...gmail, [env]: raw })[key];
    assert.equal(v("-1"), lo, `${env} floor`);
    assert.equal(v("99999999"), hi, `${env} ceiling`);
    assert.equal(v(` ${lo + 1} `), lo + 1, `${env} trimmed`);
    assert.equal(v(`${lo + 1}.6`), lo + 2, `${env} rounded`);
    assert.equal(v(""), dflt, `${env} blank is unset`);
    assert.equal(v("abc"), dflt, `${env} nonsense keeps the default`);
    assert.equal(v("Infinity"), dflt, `${env} infinity keeps the default`);
  }
  assert.equal(loadConfig({ ...gmail, PACKET_SETTLE_MIN: "0" }).packetSettleMin, 0, "zero settle is allowed");
});

test("the full-photo budget never exceeds the hard ceiling", () => {
  assert.equal(loadConfig({ ...gmail, PACKET_HARD_KB: "5000" }).packetFullKb, 5000);
  assert.equal(loadConfig({ ...gmail, PACKET_HARD_KB: "5000", PACKET_FULL_KB: "3000" }).packetFullKb, 3000);
  assert.equal(loadConfig({ ...gmail, PACKET_FULL_KB: "17000" }).packetFullKb, 17000);
  assert.equal(loadConfig({ ...gmail, PACKET_FULL_KB: "17000", PACKET_HARD_KB: "16000" }).packetFullKb, 16000);
});

test("'packet' is served only with Gmail configured and CARRIER_PACKET not off", () => {
  assert.deepEqual(loadConfig(gmail).channels, ["sms", "email", "qbo", "packet"]);
  assert.deepEqual(loadConfig(base).channels, ["sms", "qbo"], "no Gmail, no packet: the email adapter is what sends it");
  assert.deepEqual(loadConfig({ ...base, GMAIL_CLIENT_ID: "id" }).channels, ["sms", "qbo"]);
  for (const v of ["off", "OFF", " off "]) {
    const c = loadConfig({ ...gmail, CARRIER_PACKET: v });
    assert.equal(c.carrierPacket, false, v);
    assert.deepEqual(c.channels, ["sms", "email", "qbo"], v);
    assert.ok(c.queueKinds.includes("packet.build"), "the hourly row is still claimed, and finishes {skipped:'off'}");
  }
  for (const v of ["", "on", "yes", "0", "false"]) {
    const c = loadConfig({ ...gmail, CARRIER_PACKET: v });
    assert.equal(c.carrierPacket, true, v);
    assert.ok(c.channels.includes("packet"), v);
  }
  // CARRIER_PACKET=off does not touch the other switches, nor they it.
  assert.deepEqual(loadConfig({ ...gmail, RECEIPTS_QBO: "off" }).channels, ["sms", "email", "packet"]);
  assert.deepEqual(loadConfig({ ...gmail, RECEIPTS_QBO: "off", CARRIER_PACKET: "off" }).channels, ["sms", "email"]);
  // An OUTBOX_CHANNELS set on the app replaces the list; the gates still apply.
  assert.deepEqual(loadConfig({ ...gmail, OUTBOX_CHANNELS: "sms,email" }).channels, ["sms", "email"]);
  assert.deepEqual(loadConfig({ ...gmail, OUTBOX_CHANNELS: "sms,packet" }).channels, ["sms", "packet"]);
  assert.deepEqual(loadConfig({ ...base, OUTBOX_CHANNELS: "sms,packet" }).channels, ["sms"]);
  assert.deepEqual(loadConfig({ ...gmail, OUTBOX_CHANNELS: "sms,packet", CARRIER_PACKET: "off" }).channels, ["sms"]);
});

test("PACKET_TEXTS=off stops the texts only: the channel and the lane stay on", () => {
  for (const v of ["off", " OFF "]) {
    const c = loadConfig({ ...gmail, PACKET_TEXTS: v });
    assert.equal(c.packetTexts, false, v);
    assert.equal(c.carrierPacket, true);
    assert.ok(c.channels.includes("packet"));
  }
  assert.equal(loadConfig({ ...gmail, PACKET_TEXTS: "on" }).packetTexts, true);
});

test("packet.build is in the default queue kinds, and a QUEUE_KINDS on the app still wins", () => {
  assert.deepEqual(loadConfig(base).queueKinds, ["proposal.execute", "billing.reconcile", "receipts.qbo_match", "packet.build"]);
  assert.deepEqual(loadConfig({ ...base, QUEUE_KINDS: "proposal.execute,billing.reconcile" }).queueKinds,
    ["proposal.execute", "billing.reconcile"], "so a QUEUE_KINDS secret must name packet.build too");
});
