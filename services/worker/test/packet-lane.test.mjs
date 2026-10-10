/* The packet.build lane (lanes/packet.mjs) with everything around it
   stood in: the database (fakeSupa, every door answering what the test
   says), Storage (an in-memory bucket that records each call), the model,
   recipient and renderer (ctx.packetDeps: small stubs whose answers the
   test steers, so this file tests the lane's decisions and calls, not the
   document; packet-model.test.mjs and packet-pdf.test.mjs test those), and
   roybal-notify (a fake fetch). All data is made up. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { packetBuild, certSignPending, imageBytes } from "../lanes/packet.mjs";
import { fakeSupa, fakeFetch, testConfig, recordingLog, jobRow } from "./helpers.mjs";

const NOW = new Date("2026-10-10T20:00:00Z");          // noon in Fairbanks
const uuid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const J1 = uuid(1), J2 = uuid(2), J3 = uuid(3), J4 = uuid(4), J5 = uuid(5);
const NIL = "00000000-0000-0000-0000-000000000000";
const BUCKET = "carrier-packets";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const hex = (s) => sha(String(s));
const H1 = hex("photo-1"), H2 = hex("sketch-1");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const PDF_BYTES = Buffer.from("%PDF-1.4\n% demo packet\n%%EOF\n");
const CUSTOMER_STRINGS = ["Jane Sample", "Example St", "DEMO-12345", "Sample Mutual", "adjuster@example.com",
  "jane@example.com", "+19075550199"];

const project = (id, over = {}) => ({
  id, customer: "Jane Sample", address: "123 Example St, Fairbanks, AK 99701", claimNo: "DEMO-12345",
  carrier: "Sample Mutual", adjuster: "adjuster@example.com", email: "jane@example.com",
  certDrying: { sigTech: "data:image/png;base64,AAAA" }, ...over,
});
const fieldRow = (p, over = {}) => ({ id: p.id, data: p, deleted: false, updated_at: "2026-10-09T18:00:00Z", ...over });
const cand = (job_id, over = {}) => ({ job_id, updated_at: "2026-10-09T18:00:00Z", has_row: false, open_row: false, ...over });
const reserveBuild = (id, over = {}) => ({
  action: "build", packet_id: uuid(100 + Number(id.slice(-2))), number: `PKT-2026-00${id.slice(-2)}`, version: 1, seq: 1,
  build_token: uuid(200 + Number(id.slice(-2))), path: null, sha256: null, bytes: null, pages: null, mode: null, replaces: null,
  ...over,
});
const packetJob = (over = {}) => jobRow({ kind: "packet.build", payload: {}, principal_kind: "system", principal_id: null,
  run_after: "2026-10-10T19:25:00Z", created_at: "2026-10-10T19:25:00Z", ...over });

/* The model stub: what the lane reads of a model, built from the job. */
const stubModel = (p) => ({
  v: 1, jobId: p.id,
  cover: { customer: p.customer, address: p.address, claimNo: p.claimNo, carrier: p.carrier },
  sections: [{ key: "cert", title: "Certificate of Drying", parts: [] }],
  media: p._media ?? {
    [H1]: { kind: "photo", full: { hash: H1 }, small: null },
    [H2]: { kind: "sketch", full: { hash: H2 }, small: null },
  },
  photoNums: { ph1: 1 }, counts: { photos: 1 }, unitsOut: [], hardGaps: [], missing: 0,
});

function stubDeps(trail, over = {}) {
  const calls = {};
  const rec = (name, fn) => (...args) => { (calls[name] ??= []).push(args); trail.push(`dep:${name}`); return fn(...args); };
  const deps = {
    HOLD_REASONS: new Set(["no_invoice", "unchecked_fills", "unread_meter_photos"]),
    WITHDRAW_REASONS: new Set(["deleted", "archived", "not_water", "excluded", "not_certified", "no_invoice",
      "unchecked_fills", "unread_meter_photos"]),
    packetGate: rec("packetGate", (p) => p._gate ?? { ok: true, anchor: "2026-10-06" }),
    buildModel: rec("buildModel", (p) => stubModel(p)),
    modelHash: rec("modelHash", (m) => hex(`model:${m.jobId}`)),
    sectionHashes: rec("sectionHashes", (m) => ({ cover: hex(`cover:${m.jobId}`), cert: hex(`cert:${m.jobId}`) })),
    changedSections: rec("changedSections", () => ["Job Photos"]),
    mediaNames: rec("mediaNames", (m) => Object.values(m.media).flatMap((r) => [r.full?.hash, r.small?.hash]).filter(Boolean)),
    planMedia: rec("planMedia", (m) => ({
      mode: "full", estimateBytes: 4096,
      load: Object.entries(m.media).map(([key, ref]) => ({ key, source: ref.full })),
    })),
    emailText: rec("emailText", (m, l) => ({
      subject: `Claim ${m.cover.claimNo} - ${m.cover.customer} - water mitigation documentation (${l.number} v${l.version})`,
      body: `Hello,\n\nAttached for ${m.cover.customer}.\n`, filename: `${l.number} v${l.version} - Sample.pdf`,
    })),
    rationaleText: rec("rationaleText", (m, l, f) => `Carrier packet ${l.number} v${l.version} for ${m.cover.customer}. To ${f.recipient.to}.`),
    readyText: rec("readyText", (m, l) => `Carrier packet ${l.number} v${l.version} for ${m.cover.customer} is ready.`),
    holdText: rec("holdText", (reason, m) => `Carrier packet hold ${reason} for ${m?.customer ?? m?.cover?.customer ?? "the lane"}.`),
    suggestedFrom: rec("suggestedFrom", (source) => `from ${source || "nothing on file"}`),
    pickRecipient: rec("pickRecipient", ({ lastSentTo }) => (lastSentTo
      ? { to: lastSentTo, source: "last_sent" } : { to: "adjuster@example.com", source: "claim" })),
    renderPacket: rec("renderPacket", () => ({ bytes: new Uint8Array(PDF_BYTES), pages: 12, sha256: sha(PDF_BYTES) })),
    ...over,
  };
  deps.calls = calls;
  return deps;
}

function fakeStorage(trail, over = {}) {
  const calls = [];
  const objects = new Map();
  const key = (b, n) => `${b}/${n}`;
  const note = (op, ...args) => { calls.push([op, ...args]); trail.push(`storage:${op}`); };
  const st = {
    calls, objects,
    async ensureBucket(id, opts) { note("ensureBucket", id, opts); return true; },
    async getText(b, n) { note("getText", b, n); const v = objects.get(key(b, n)); return v == null ? null : String(v); },
    async getBytes(b, n) { note("getBytes", b, n); return objects.get(key(b, n)) ?? null; },
    async put(b, n, bytes, ct) {
      note("put", b, n, ct);
      if (objects.has(key(b, n))) throw Object.assign(new Error("The resource already exists"), { status: 409 });
      objects.set(key(b, n), new Uint8Array(bytes));
      return {};
    },
    async sign(b, n, s) { note("sign", b, n, s); return `https://stub.supabase.co/storage/v1/object/sign/${b}/${n}?token=t0k`; },
    async remove(b, names) { note("remove", b, names); for (const n of names) objects.delete(key(b, n)); return []; },
    ...over,
  };
  st.objects.set(key("field-media", H1), JPEG_URL);
  st.objects.set(key("field-media", H2), JPEG_URL);
  return st;
}

/* One run's world. `rpc` and `select` add to or replace the defaults. */
function world({ candidates = [cand(J1)], projects = [project(J1)], rpc = {}, select = {}, cfg = {}, deps = {}, storage = {},
  notify, now = NOW } = {}) {
  const trail = [];
  const rows = new Map(projects.map((p) => [p.id, p.__row ?? fieldRow(p)]));
  const supa = fakeSupa({
    rpc: {
      carrier_packet_candidates: candidates,
      carrier_packet_state: { photo_nums: { ph1: 1 }, last_sent: null },
      carrier_packet_media_sizes: (a) => a.p_names.map((name) => ({ name, bytes: 2000 })),
      carrier_packet_storage_bytes: 1_000_000,
      carrier_packet_reserve: (a) => reserveBuild(a.p_job_id),
      carrier_packet_file: (a) => ({ status: "filed", proposal_id: uuid(300), superseded: [] }),
      carrier_packet_fail: () => ({ status: "failed", capped: false }),
      carrier_packet_withdraw: () => ({ withdrawn: true, pdf: null }),
      carrier_packet_hold: () => ({ text_due: true }),
      carrier_packet_hold_texted: () => ({ recorded: true }),
      carrier_packet_pdfs_to_remove: [],
      carrier_packet_pdfs_removed: (a) => a.p_ids.length,
      ...rpc,
    },
    select: {
      field_projects: (q) => { const id = /id=eq\.([0-9a-f-]+)/.exec(q)?.[1]; return rows.has(id) ? [rows.get(id)] : []; },
      portal_jobs: [],
      email_messages: [{ from_addr: "adjuster@example.com", matched_by: "claim", received_at: "2026-10-08T17:00:00Z", direction: "in" }],
      gmail_tokens: [{ account: "office@example.com" }],
      ...select,
    },
  });
  for (const verb of ["rpc", "select"]) {
    const real = supa[verb];
    supa[verb] = async (name, arg) => { trail.push(`${verb}:${name}`); return real(name, arg); };
  }
  const fetch = fakeFetch([{
    match: (u) => u === testConfig().notifyUrl,
    reply: (_u, init) => { trail.push("text"); return notify ? notify(init) : { body: { ok: true, sid: "SM1" } }; },
  }]);
  const st = fakeStorage(trail, storage);
  const packetDeps = stubDeps(trail, { makeStorage: (opts) => { trail.push("makeStorage"); st.opts = opts; return st; }, ...deps });
  const ctx = {
    cfg: testConfig({ channels: ["sms", "email", "qbo", "packet"], queueKinds: ["packet.build"], ...cfg }),
    supa, log: recordingLog(), fetch, now: () => now, stopping: () => false, packetDeps,
  };
  return { ctx, supa, storage: st, deps: packetDeps, fetch, trail, run: (job = packetJob()) => packetBuild(ctx, job) };
}
const texts = (fetch) => fetch.calls.filter((c) => c.url === testConfig().notifyUrl).map((c) => c.body);
const before = (trail, a, b) => {
  const i = trail.indexOf(a), j = trail.indexOf(b);
  assert.ok(i >= 0, `${a} happened`);
  assert.ok(j >= 0, `${b} happened`);
  assert.ok(i < j, `${a} before ${b}`);
};

/* ---------------------------------------------------------------------- */

test("CARRIER_PACKET=off, a stale run and a lane without the packet channel finish without reading anything", async () => {
  const off = world({ cfg: { carrierPacket: false } });
  assert.deepEqual(await off.run(), { skipped: "off" });
  assert.deepEqual(off.trail, []);

  const stale = world();
  assert.deepEqual(await stale.run(packetJob({ run_after: "2026-10-10T17:59:00Z" })), { skipped: "stale" });
  assert.deepEqual(stale.trail, []);
  // with no run_after the queued time is created_at
  assert.deepEqual(await world().run(packetJob({ run_after: undefined, created_at: "2026-10-10T17:00:00Z" })), { skipped: "stale" });
  // two hours late is still on time
  const onTime = world();
  const r = await onTime.run(packetJob({ run_after: "2026-10-10T18:00:00Z" }));
  assert.equal(r.seen, 1);

  const laneOff = world({ cfg: { channels: ["sms", "email"] } });
  assert.deepEqual(await laneOff.run(), { skipped: "lane_off" });
  assert.deepEqual(laneOff.trail, []);
});

test("a bucket that cannot be made ends the run as bucket_missing before any job is read", async () => {
  const w = world({ storage: { async ensureBucket() { throw Object.assign(new Error("403 Unauthorized"), { status: 403 }); } } });
  assert.deepEqual(await w.run(), { skipped: "bucket_missing" });
  assert.deepEqual(w.supa.calls.rpc, []);
  assert.deepEqual(w.supa.calls.select, []);
  assert.ok(w.ctx.log.events().includes("packet.bucket_missing"));

  const ok = world();
  await ok.run();
  assert.deepEqual(ok.storage.calls[0], ["ensureBucket", BUCKET,
    { public: false, fileSizeLimit: 26214400, allowedMimeTypes: ["application/pdf"] }]);
  assert.deepEqual(ok.storage.opts, { supabaseUrl: "https://stub.supabase.co", serviceKey: "sb_secret_test", fetchImpl: ok.ctx.fetch });
});

test("a gate no withdraws an open card only for the out-of-scope reasons, and holds only for the fixable ones", async () => {
  const no = (reason, detail = `${reason} detail`) => ({ ok: false, reason, detail });
  const w = world({
    candidates: [
      cand(J1, { open_row: true, has_row: true }),     // not water any more, with a card: withdraw
      cand(J2),                                          // not water, no card: nothing to withdraw
      cand(J3, { open_row: true, has_row: true }),     // settling: nothing at all
      cand(J4, { open_row: true, has_row: true }),     // invoice voided: withdraw and hold
      cand(J5, { open_row: true, has_row: true }),     // the row is gone: withdraw as deleted
    ],
    projects: [
      project(J1, { _gate: no("not_water") }), project(J2, { _gate: no("not_water") }),
      project(J3, { _gate: no("settle") }), project(J4, { _gate: no("no_invoice", "1 invoice on the job, none numbered and ready") }),
    ],
  });
  const r = await w.run();
  assert.deepEqual(w.supa.rpcs("carrier_packet_withdraw"), [
    { p_job_id: J1, p_reason: "not_water" }, { p_job_id: J4, p_reason: "no_invoice" }, { p_job_id: J5, p_reason: "deleted" },
  ]);
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold"), [
    { p_job_id: J4, p_reason: "no_invoice", p_detail: "1 invoice on the job, none numbered and ready" },
  ]);
  assert.equal(w.supa.rpcs("carrier_packet_reserve").length, 0);
  assert.equal(w.supa.rpcs("carrier_packet_state").length, 0);
  assert.deepEqual(r, {
    seen: 5, in_scope: 0, built: 0, reoffered: 0, withdrawn: 3, held: 1,
    skipped: { not_water: 2, settle: 1, no_invoice: 1, deleted: 1 }, failed: [],
  });
  // the gate was asked with the run's Alaska date and the row's facts
  const [p, opts] = w.deps.calls.packetGate[0];
  assert.equal(p.id, J1);
  assert.deepEqual(opts, {
    today: "2026-10-10", now: NOW, lookbackDays: 14, settleMin: 120, updatedAt: "2026-10-09T18:00:00Z",
    deleted: false, hasRow: true, certSignPending: false,
  });

  // a withdraw that found the card being approved is not counted
  const busy = world({ candidates: [cand(J1, { open_row: true })], projects: [project(J1, { _gate: no("archived") })],
    rpc: { carrier_packet_withdraw: { withdrawn: false, pdf: null } } });
  assert.equal((await busy.run()).withdrawn, 0);
});

test("a hold texts once: text_due sends it and records it; a failed or silenced text records nothing", async () => {
  const gate = { ok: false, reason: "unchecked_fills", detail: "3 meter readings to check" };
  const w = world({ projects: [project(J1, { _gate: gate })] });
  await w.run();
  const [sms] = texts(w.fetch);
  assert.deepEqual(sms, { action: "sendSms", to: "+19075550199", kind: "brief", captured_by: "worker-packet",
    body: "Carrier packet hold unchecked_fills for Jane Sample." });
  const call = w.fetch.calls[0];
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.apikey, "sb_secret_test");
  assert.equal(call.init.headers.Authorization, "Bearer sb_secret_test");
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(w.deps.calls.holdText[0], ["unchecked_fills", project(J1, { _gate: gate }), "3 meter readings to check"]);
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold_texted"), [{ p_job_id: J1, p_reason: "unchecked_fills" }]);
  before(w.trail, "text", "rpc:carrier_packet_hold_texted");

  const already = world({ projects: [project(J1, { _gate: gate })], rpc: { carrier_packet_hold: { text_due: false } } });
  await already.run();
  assert.equal(texts(already.fetch).length, 0);
  assert.equal(already.supa.rpcs("carrier_packet_hold_texted").length, 0);

  for (const notify of [() => ({ status: 500, body: { ok: false, error: "twilio down" } }), () => ({ body: { ok: false, error: "quiet" } })]) {
    const failed = world({ projects: [project(J1, { _gate: gate })], notify });
    const r = await failed.run();
    assert.equal(texts(failed.fetch).length, 1);
    assert.equal(failed.supa.rpcs("carrier_packet_hold_texted").length, 0, "tried again next run");
    assert.ok(failed.ctx.log.events().includes("packet.text_failed"));
    assert.equal(r.held, 1);
    assert.deepEqual(r.failed, [], "a text that failed fails nothing");
  }
  const thrown = world({ projects: [project(J1, { _gate: gate })], notify: () => { throw new Error("socket hang up"); } });
  assert.deepEqual((await thrown.run()).failed, []);
  assert.equal(thrown.supa.rpcs("carrier_packet_hold_texted").length, 0);

  for (const cfg of [{ packetTexts: false }, { ownerCell: "" }]) {
    const quiet = world({ projects: [project(J1, { _gate: gate })], cfg });
    await quiet.run();
    assert.equal(quiet.fetch.calls.length, 0);
    assert.equal(quiet.supa.rpcs("carrier_packet_hold_texted").length, 0, "the text is still owed when texts come back");
    assert.equal(quiet.supa.rpcs("carrier_packet_hold").length, 1);
  }
});

test("a build: reserve, download, render, upload, recipient, sign, file, the ready text, then the superseded PDFs go", async () => {
  const old = `${J1}/PKT-2026-0001-v1-b1.pdf`;
  const w = world({
    rpc: {
      carrier_packet_state: { photo_nums: { ph1: 1, ph0: 2 }, last_sent: null },
      carrier_packet_reserve: (a) => reserveBuild(a.p_job_id, { seq: 2 }),
      carrier_packet_file: { status: "filed", proposal_id: uuid(300),
        superseded: [{ bucket: BUCKET, path: old }, { bucket: "field-media", path: H1 }] },
    },
  });
  const r = await w.run();
  assert.deepEqual(r, { seen: 1, in_scope: 1, built: 1, reoffered: 0, withdrawn: 0, held: 0, skipped: {}, failed: [] });

  for (const [a, b] of [
    ["rpc:carrier_packet_candidates", "select:field_projects"],
    ["dep:packetGate", "rpc:carrier_packet_state"],
    ["rpc:carrier_packet_state", "dep:buildModel"],
    ["dep:buildModel", "rpc:carrier_packet_media_sizes"],
    ["rpc:carrier_packet_media_sizes", "rpc:carrier_packet_storage_bytes"],
    ["rpc:carrier_packet_storage_bytes", "rpc:carrier_packet_reserve"],
    ["rpc:carrier_packet_reserve", "storage:getText"],
    ["storage:getText", "dep:renderPacket"],
    ["dep:renderPacket", "storage:put"],
    ["storage:put", "select:email_messages"],
    ["select:gmail_tokens", "dep:pickRecipient"],
    ["dep:pickRecipient", "storage:sign"],
    ["storage:sign", "rpc:carrier_packet_file"],
    ["rpc:carrier_packet_file", "text"],
    ["text", "storage:remove"],
    ["storage:remove", "rpc:carrier_packet_pdfs_to_remove"],
  ]) before(w.trail, a, b);

  const [, modelOpts] = w.deps.calls.buildModel[0];
  assert.deepEqual(modelOpts, { today: "2026-10-10", now: NOW, prevPhotoNums: { ph1: 1, ph0: 2 } });
  const [reserve] = w.supa.rpcs("carrier_packet_reserve");
  assert.deepEqual(reserve, {
    p_job_id: J1, p_model_hash: hex(`model:${J1}`),
    p_section_hashes: { cover: hex(`cover:${J1}`), cert: hex(`cert:${J1}`) },
    p_photo_nums: { ph1: 1 },
    p_meta: { counts: { photos: 1 }, missing: 0, units_out: [], hard_gaps: [], anchor: "2026-10-06" },
    p_year: 2026,
  });
  assert.deepEqual(w.supa.rpcs("carrier_packet_media_sizes"), [{ p_names: [H1, H2] }]);
  const [planModel, sizes, planOpts] = w.deps.calls.planMedia[0];
  assert.equal(planModel.jobId, J1);
  assert.deepEqual([...sizes], [[H1, 2000], [H2, 2000]]);
  assert.deepEqual(planOpts, { fullKb: 9500 });

  const [, render] = w.deps.calls.renderPacket[0];
  assert.deepEqual(render.label, {
    number: "PKT-2026-0001", version: 1, replaces: null, changed: [], built: NOW, mode: "full", hash: hex(`model:${J1}`),
  });
  assert.equal(render.mode, "full");
  assert.equal(render.now, NOW);
  assert.deepEqual([...render.images.keys()].sort(), [H1, H2].sort());
  assert.deepEqual(Buffer.from(render.images.get(H1)), JPEG, "the data URL's prefix is stripped and the rest decoded");
  assert.deepEqual(w.storage.calls.filter((c) => c[0] === "getText").map((c) => c.slice(1)), [["field-media", H1], ["field-media", H2]]);

  const path = `${J1}/PKT-2026-0001-v1-b2.pdf`;
  assert.deepEqual(w.storage.calls.find((c) => c[0] === "put"), ["put", BUCKET, path, "application/pdf"]);
  assert.deepEqual(Buffer.from(w.storage.objects.get(`${BUCKET}/${path}`)), PDF_BYTES);
  assert.deepEqual(w.supa.calls.select.filter((c) => c.table === "email_messages").map((c) => c.query),
    [`select=from_addr,matched_by,received_at,direction&job_id=eq.${J1}&direction=eq.in&order=received_at.desc&limit=50`]);
  assert.deepEqual(w.supa.calls.select.filter((c) => c.table === "gmail_tokens").map((c) => c.query),
    ["select=account&order=created_at.desc&limit=1"]);
  const [pick] = w.deps.calls.pickRecipient[0];
  assert.equal(pick.account, "office@example.com");
  assert.equal(pick.lastSentTo, "");
  assert.equal(pick.project.id, J1);
  assert.equal(pick.emails.length, 1);
  assert.deepEqual(w.storage.calls.find((c) => c[0] === "sign"), ["sign", BUCKET, path, 15 * 86400]);

  const [file] = w.supa.rpcs("carrier_packet_file");
  assert.deepEqual(file, {
    p_packet_id: uuid(101), p_build_token: uuid(201),
    p_pdf: { bucket: BUCKET, path, sha256: sha(PDF_BYTES), bytes: PDF_BYTES.length, pages: 12, mode: "full" },
    p_input: {
      subject: "Claim DEMO-12345 - Jane Sample - water mitigation documentation (PKT-2026-0001 v1)",
      body: "Hello,\n\nAttached for Jane Sample.\n", filename: "PKT-2026-0001 v1 - Sample.pdf",
      suggested_to: "adjuster@example.com", suggested_from: "from claim",
    },
    p_rationale: "Carrier packet PKT-2026-0001 v1 for Jane Sample. To adjuster@example.com.",
    p_evidence_refs: [{ kind: "pdf", label: "Open the PDF", url: `https://stub.supabase.co/storage/v1/object/sign/${BUCKET}/${path}?token=t0k` }],
  });
  assert.ok(!("to" in file.p_input) && !("cc" in file.p_input), "the To is never filed");
  const [, , facts] = w.deps.calls.rationaleText[0];
  assert.deepEqual(facts, { recipient: { to: "adjuster@example.com", source: "claim" }, bytes: PDF_BYTES.length, pages: 12,
    mode: "full", missing: 0, changed: [] });

  assert.deepEqual(texts(w.fetch).map((t) => t.body), ["Carrier packet PKT-2026-0001 v1 for Jane Sample is ready."]);
  // only the carrier-packets PDF is deleted, whatever else the answer lists
  assert.deepEqual(w.storage.calls.filter((c) => c[0] === "remove"), [["remove", BUCKET, [old]]]);
  assert.equal(w.supa.rpcs("carrier_packet_fail").length, 0);
});

test("a version 2 build is labelled with the version it replaces and what changed since", async () => {
  const sent = { version: 1, sent_at: "2026-10-01T19:00:00Z", sent_to: "claims@example.com", section_hashes: { cover: "x", cert: "y" } };
  const w = world({
    rpc: {
      carrier_packet_state: { photo_nums: { ph1: 1 }, last_sent: sent },
      carrier_packet_reserve: (a) => reserveBuild(a.p_job_id, { version: 2, seq: 3, replaces: sent }),
    },
  });
  await w.run();
  assert.deepEqual(w.deps.calls.changedSections[0], [sent.section_hashes, { cover: hex(`cover:${J1}`), cert: hex(`cert:${J1}`) },
    w.deps.calls.renderPacket[0][0]]);
  const { label } = w.deps.calls.renderPacket[0][1];
  assert.deepEqual(label.replaces, { version: 1, sentAt: "2026-10-01T19:00:00Z" });
  assert.deepEqual(label.changed, ["Job Photos"]);
  assert.equal(w.deps.calls.pickRecipient[0][0].lastSentTo, "claims@example.com", "version 2 goes where version 1 went");
  assert.equal(w.supa.rpcs("carrier_packet_file")[0].p_pdf.path, `${J1}/PKT-2026-0001-v2-b3.pdf`);
  assert.equal(w.supa.rpcs("carrier_packet_file")[0].p_input.suggested_to, "claims@example.com");
});

test("at most PACKET_MAX_BUILDS builds a run; re-offers do not count, and nothing is reserved past the cap", async () => {
  const answers = { [J1]: "reoffer", [J2]: "build", [J3]: "build", [J4]: "build", [J5]: "build" };
  const w = world({
    cfg: { packetMaxBuilds: 2 },
    candidates: [J1, J2, J3, J4, J5].map((id) => cand(id)),
    projects: [J1, J2, J3, J4, J5].map((id) => project(id)),
    rpc: {
      carrier_packet_reserve: (a) => (answers[a.p_job_id] === "reoffer"
        ? { ...reserveBuild(a.p_job_id), action: "reoffer", path: `${a.p_job_id}/PKT-2026-0001-v1-b1.pdf`, bytes: 900, pages: 3, mode: "full" }
        : reserveBuild(a.p_job_id)),
      carrier_packet_reoffer: { status: "filed", proposal_id: uuid(301), offer: 1, superseded: [] },
    },
  });
  const r = await w.run();
  assert.deepEqual(w.supa.rpcs("carrier_packet_reserve").map((a) => a.p_job_id), [J1, J2, J3]);
  assert.equal(w.deps.calls.renderPacket.length, 2);
  assert.equal(r.built, 2);
  assert.equal(r.reoffered, 1);
  assert.equal(r.in_scope, 5);
  assert.deepEqual(r.skipped, { max_builds: 2 });
});

test("over the storage cap: one lane-wide hold and one text, and nothing more is reserved this run", async () => {
  const cap = 300 * 1_048_576;
  const w = world({
    candidates: [cand(J1), cand(J2)],
    projects: [project(J1), project(J2)],
    rpc: { carrier_packet_storage_bytes: cap - 1000 },
  });
  const r = await w.run();
  assert.equal(w.supa.rpcs("carrier_packet_reserve").length, 0, "no row is reserved, so no try is spent");
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold"), [{ p_job_id: NIL, p_reason: "storage_full", p_detail: "300.0 MB of 300 MB used" }]);
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold_texted"), [{ p_job_id: NIL, p_reason: "storage_full" }]);
  assert.equal(texts(w.fetch).length, 1);
  assert.deepEqual(w.deps.calls.holdText[0], ["storage_full", null, "300.0 MB of 300 MB used"]);
  assert.equal(w.supa.rpcs("carrier_packet_storage_bytes").length, 1);
  assert.deepEqual(r.skipped, { storage_full: 2 });
  assert.equal(r.held, 1);

  // the first build's PDF counts against the cap for the next job
  const pdf = PDF_BYTES.length;
  const tight = world({
    candidates: [cand(J1), cand(J2)],
    projects: [project(J1), project(J2)],
    rpc: { carrier_packet_storage_bytes: cap - 100 - pdf + 1 },
    deps: { planMedia: () => ({ mode: "full", estimateBytes: 100, load: [] }) },
  });
  const r2 = await tight.run();
  assert.equal(r2.built, 1);
  assert.deepEqual(tight.supa.rpcs("carrier_packet_reserve").map((a) => a.p_job_id), [J1]);
  assert.deepEqual(r2.skipped, { storage_full: 1 });
});

test("a PDF too large to email fails permanent, is never uploaded, and holds the job with a text", async () => {
  const big = new Uint8Array(1_500_000);
  const w = world({
    cfg: { packetHardKb: 1000 },
    deps: { renderPacket: () => ({ bytes: big, pages: 40, sha256: sha(big) }) },
  });
  const r = await w.run();
  assert.deepEqual(w.supa.rpcs("carrier_packet_fail"), [
    { p_packet_id: uuid(101), p_build_token: uuid(201), p_error: "too_large: 1.4 MB", p_permanent: true },
  ]);
  assert.equal(w.storage.calls.filter((c) => c[0] === "put").length, 0);
  assert.equal(w.supa.rpcs("carrier_packet_file").length, 0);
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold"), [{ p_job_id: J1, p_reason: "too_large", p_detail: "1.4 MB" }]);
  assert.deepEqual(w.deps.calls.holdText[0].slice(0, 1), ["too_large"]);
  assert.equal(texts(w.fetch).length, 1);
  assert.deepEqual(r.skipped, { too_large: 1 });
  assert.deepEqual(r.failed, []);
  assert.equal(r.built, 0);
});

test("an upload that meets its own earlier copy keeps it when the bytes match and replaces it when they do not", async () => {
  const path = `${J1}/PKT-2026-0001-v1-b1.pdf`;
  const same = world();
  same.storage.objects.set(`${BUCKET}/${path}`, new Uint8Array(PDF_BYTES));
  await same.run();
  assert.deepEqual(same.storage.calls.filter((c) => ["put", "getBytes", "remove"].includes(c[0])).map((c) => c[0]), ["put", "getBytes"]);
  assert.equal(same.supa.rpcs("carrier_packet_file").length, 1);

  const other = world();
  other.storage.objects.set(`${BUCKET}/${path}`, new Uint8Array([1, 2, 3]));
  const r = await other.run();
  assert.deepEqual(other.storage.calls.filter((c) => ["put", "getBytes", "remove"].includes(c[0])),
    [["put", BUCKET, path, "application/pdf"], ["getBytes", BUCKET, path], ["remove", BUCKET, [path]], ["put", BUCKET, path, "application/pdf"]]);
  assert.deepEqual(Buffer.from(other.storage.objects.get(`${BUCKET}/${path}`)), PDF_BYTES);
  assert.equal(r.built, 1);
});

test("a build the door would not file (relabel, lost) has its upload deleted and sends no text", async () => {
  for (const status of ["relabel", "lost"]) {
    const w = world({ rpc: { carrier_packet_file: { status } } });
    const r = await w.run();
    const path = `${J1}/PKT-2026-0001-v1-b1.pdf`;
    assert.deepEqual(w.storage.calls.filter((c) => c[0] === "remove"), [["remove", BUCKET, [path]]], status);
    assert.equal(w.storage.objects.has(`${BUCKET}/${path}`), false);
    assert.equal(texts(w.fetch).length, 0);
    assert.equal(w.supa.rpcs("carrier_packet_fail").length, 0, "the door already settled the row");
    assert.deepEqual(r.skipped, { [status]: 1 });
    assert.equal(r.built, 0);
    assert.deepEqual(r.failed, []);
  }
});

test("one job's error is recorded and the next job still runs; an error after the reserve fails the row", async () => {
  // J1's read fails before anything is reserved; J2 builds
  const w = world({
    candidates: [cand(J1), cand(J2)],
    projects: [project(J1), project(J2)],
    select: { field_projects: (q) => {
      if (q.includes(J1)) throw new Error("field_projects: 503 upstream timeout");
      return [fieldRow(project(J2))];
    } },
  });
  const r = await w.run();
  assert.deepEqual(r.failed, [J1]);
  assert.equal(r.built, 1);
  assert.equal(w.supa.rpcs("carrier_packet_fail").length, 0);
  assert.ok(w.ctx.log.lines.some((l) => l.event === "packet.job_failed" && l.job_id === J1));

  // a renderer that throws: bad data, failed permanent; the tries are spent, so held with a text
  const broken = world({
    candidates: [cand(J1), cand(J2)],
    projects: [project(J1), project(J2)],
    deps: { renderPacket: (m) => { if (m.jobId === J1) throw new TypeError("cannot read properties of undefined"); return { bytes: new Uint8Array(PDF_BYTES), pages: 2 }; } },
    rpc: { carrier_packet_fail: () => ({ status: "failed", capped: true }) },
  });
  const r2 = await broken.run();
  assert.deepEqual(r2.failed, [J1]);
  assert.equal(r2.built, 1);
  const [fail] = broken.supa.rpcs("carrier_packet_fail");
  assert.equal(fail.p_packet_id, uuid(101));
  assert.equal(fail.p_build_token, uuid(201));
  assert.equal(fail.p_permanent, true);
  assert.match(fail.p_error, /^render: cannot read properties/);
  assert.deepEqual(broken.supa.rpcs("carrier_packet_hold").map((h) => [h.p_job_id, h.p_reason]), [[J1, "failed_cap"]]);
  assert.deepEqual(broken.deps.calls.holdText[0].slice(0, 1), ["failed_cap"]);
  assert.equal(texts(broken.fetch).length, 2, "the hold's text and J2's ready text");

  // an outage while downloading is a try, not bad data; nothing was uploaded
  const outage = world({ storage: { async getText() { throw Object.assign(new Error("GET field-media: 503"), { status: 503 }); } } });
  const r3 = await outage.run();
  assert.deepEqual(r3.failed, [J1]);
  assert.equal(outage.supa.rpcs("carrier_packet_fail")[0].p_permanent, false);
  assert.equal(outage.supa.rpcs("carrier_packet_hold").length, 0, "not capped: no hold");
  assert.equal(outage.storage.calls.filter((c) => c[0] === "put" || c[0] === "remove").length, 0);

  // an error after the upload: the row was still building, so the PDF goes
  const late = world({ storage: { async sign() { throw new Error("sign: 502"); } } });
  const r4 = await late.run();
  const path = `${J1}/PKT-2026-0001-v1-b1.pdf`;
  assert.deepEqual(r4.failed, [J1]);
  assert.deepEqual(late.storage.calls.filter((c) => c[0] === "remove"), [["remove", BUCKET, [path]]]);
  assert.equal(late.supa.rpcs("carrier_packet_file").length, 0);

  // the filing call itself failed: the row may be filed, so its PDF stays
  const unsure = world({
    rpc: {
      carrier_packet_file: () => { throw new Error("rpc carrier_packet_file: socket hang up"); },
      carrier_packet_fail: () => ({ status: "lost", capped: false }),
    },
  });
  const r5 = await unsure.run();
  assert.deepEqual(r5.failed, [J1]);
  assert.equal(unsure.storage.calls.filter((c) => c[0] === "remove").length, 0);
  assert.equal(unsure.storage.objects.has(`${BUCKET}/${path}`), true);

  // an invalid argument from a door is bad data too
  const refused = world({
    rpc: { carrier_packet_file: () => { throw Object.assign(new Error("carrier_packet_file: pdf must be …"), { code: "22023" }); } },
  });
  await refused.run();
  assert.equal(refused.supa.rpcs("carrier_packet_fail")[0].p_permanent, true);
});

test("a re-offer files the stored PDF on a fresh card: no render, no upload, a new link and the ready text", async () => {
  const stored = `${J1}/PKT-2026-0001-v1-b1.pdf`;
  const w = world({
    rpc: {
      carrier_packet_reserve: (a) => ({ ...reserveBuild(a.p_job_id), action: "reoffer", build_token: null, path: stored,
        sha256: sha(PDF_BYTES), bytes: 123456, pages: 9, mode: "compact" }),
      carrier_packet_reoffer: { status: "filed", proposal_id: uuid(301), offer: 1, superseded: [] },
    },
  });
  const r = await w.run();
  assert.equal(r.reoffered, 1);
  assert.equal(r.built, 0);
  assert.equal(w.deps.calls.renderPacket, undefined);
  assert.equal(w.storage.calls.filter((c) => ["put", "getText"].includes(c[0])).length, 0);
  assert.deepEqual(w.storage.calls.find((c) => c[0] === "sign"), ["sign", BUCKET, stored, 15 * 86400]);
  const [re] = w.supa.rpcs("carrier_packet_reoffer");
  assert.deepEqual(Object.keys(re).sort(), ["p_evidence_refs", "p_input", "p_packet_id", "p_rationale"]);
  assert.equal(re.p_packet_id, uuid(101));
  assert.deepEqual(re.p_evidence_refs, [{ kind: "pdf", label: "Open the PDF", url: `https://stub.supabase.co/storage/v1/object/sign/${BUCKET}/${stored}?token=t0k` }]);
  assert.equal(re.p_input.suggested_to, "adjuster@example.com");
  assert.equal(w.deps.calls.emailText[0][1].mode, "compact");
  assert.deepEqual(w.deps.calls.rationaleText[0][2].bytes, 123456);
  assert.deepEqual(texts(w.fetch).map((t) => t.body), ["Carrier packet PKT-2026-0001 v1 for Jane Sample is ready."]);
  assert.equal(w.deps.calls.rationaleText[0][2].missing, 0);

  // an image the bucket no longer lists is counted on the fresh card too
  const gone = world({
    rpc: {
      carrier_packet_reserve: (a) => ({ ...reserveBuild(a.p_job_id), action: "reoffer", build_token: null, path: stored,
        sha256: sha(PDF_BYTES), bytes: 123456, pages: 9, mode: "compact" }),
      carrier_packet_reoffer: { status: "filed", proposal_id: uuid(301), offer: 1, superseded: [] },
      carrier_packet_media_sizes: (a) => a.p_names.filter((n) => n !== H1).map((name) => ({ name, bytes: 2000 })),
    },
  });
  await gone.run();
  assert.equal(gone.deps.calls.rationaleText[0][2].missing, 1);

  const lost = world({ rpc: {
    carrier_packet_reserve: (a) => ({ ...reserveBuild(a.p_job_id), action: "reoffer", path: stored, mode: "full" }),
    carrier_packet_reoffer: { status: "lost", reason: "not_latest" },
  } });
  const r2 = await lost.run();
  assert.deepEqual(r2.skipped, { lost: 1 });
  assert.equal(texts(lost.fetch).length, 0);
});

test("a reserve that skips is counted by its reason, and nothing is built", async () => {
  const w = world({
    candidates: [cand(J1), cand(J2)], projects: [project(J1), project(J2)],
    rpc: { carrier_packet_reserve: (a) => ({ action: "skip", reason: a.p_job_id === J1 ? "open" : "sent" }) },
  });
  const r = await w.run();
  assert.deepEqual(r.skipped, { open: 1, sent: 1 });
  assert.equal(r.in_scope, 2);
  assert.equal(w.storage.calls.filter((c) => c[0] !== "ensureBucket").length, 0);
});

test("a reserve that answers failed_cap holds the job with the last error and texts once", async () => {
  const w = world({
    rpc: {
      carrier_packet_reserve: { action: "skip", reason: "failed_cap", error: "render: out of memory" },
      carrier_packet_hold: { text_due: true },
    },
  });
  const r = await w.run();
  assert.deepEqual(r.skipped, { failed_cap: 1 });
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold"), [{ p_job_id: J1, p_reason: "failed_cap", p_detail: "render: out of memory" }]);
  assert.equal(texts(w.fetch).length, 1);
  assert.deepEqual(w.supa.rpcs("carrier_packet_hold_texted"), [{ p_job_id: J1, p_reason: "failed_cap" }]);
  assert.equal(w.storage.calls.filter((c) => c[0] !== "ensureBucket").length, 0, "nothing is built");

  // already texted: the hold is kept, nobody hears twice; no error still names the tries
  const again = world({ rpc: { carrier_packet_reserve: { action: "skip", reason: "failed_cap" }, carrier_packet_hold: { text_due: false } } });
  await again.run();
  assert.deepEqual(again.supa.rpcs("carrier_packet_hold").map((h) => h.p_detail), ["3 tries"]);
  assert.equal(texts(again.fetch).length, 0);
});

test("the cleanup deletes the PDFs nobody can send, then stamps those rows; a failed delete stamps nothing", async () => {
  const rows = [
    { id: uuid(401), bucket: BUCKET, path: `${J1}/PKT-2026-0001-v1-b1.pdf` },
    { id: uuid(402), bucket: BUCKET, path: `${J2}/PKT-2026-0002-v1-b4.pdf` },
    { id: uuid(403), bucket: "field-media", path: H1 },
  ];
  const w = world({ candidates: [], rpc: { carrier_packet_pdfs_to_remove: rows } });
  await w.run();
  assert.deepEqual(w.supa.rpcs("carrier_packet_pdfs_to_remove"), [{ p_limit: 20 }]);
  assert.deepEqual(w.storage.calls.filter((c) => c[0] === "remove"), [["remove", BUCKET, [rows[0].path, rows[1].path]]]);
  assert.deepEqual(w.supa.rpcs("carrier_packet_pdfs_removed"), [{ p_ids: [uuid(401), uuid(402)] }]);
  before(w.trail, "storage:remove", "rpc:carrier_packet_pdfs_removed");

  const down = world({ candidates: [], rpc: { carrier_packet_pdfs_to_remove: rows },
    storage: { async remove() { throw new Error("DELETE: 503"); } } });
  const r = await down.run();
  assert.equal(down.supa.rpcs("carrier_packet_pdfs_removed").length, 0);
  assert.ok(down.ctx.log.events().includes("packet.cleanup_failed"));
  assert.equal(r.seen, 0);
});

test("the result and the log lines carry ids and counts, never the job's customer data", async () => {
  const gate = { ok: false, reason: "no_invoice", detail: "no invoice on the job" };
  const w = world({
    candidates: [cand(J1), cand(J2, { open_row: true }), cand(J3)],
    projects: [project(J1), project(J2, { _gate: gate }), project(J3)],
    deps: { renderPacket: (m) => { if (m.jobId === J3) throw new TypeError("Cannot read properties of undefined (reading 'items')"); return { bytes: new Uint8Array(PDF_BYTES), pages: 2 }; } },
    notify: () => ({ status: 400, body: { ok: false, error: "refused for +19075550199" } }),
  });
  const r = await w.run();
  assert.equal(r.built, 1);
  assert.deepEqual(r.failed, [J3]);
  const out = JSON.stringify(r);
  const logs = JSON.stringify(w.ctx.log.lines);
  assert.ok(w.ctx.log.events().includes("packet.job_failed"));
  assert.ok(w.ctx.log.events().includes("packet.text_failed"));
  for (const s of CUSTOMER_STRINGS) {
    assert.ok(!out.includes(s), `the result holds ${s}`);
    assert.ok(!logs.includes(s), `a log line holds ${s}`);
  }
  // the texts, which go to the owner, are where the names are
  assert.ok(texts(w.fetch).some((t) => t.body.includes("Jane Sample")));
});

test("media downloads run at most PACKET_DOWNLOADS at a time, and what is missing or not an image is null", async () => {
  const media = {};
  const names = [];
  for (let i = 0; i < 10; i++) {
    const h = hex(`img-${i}`);
    names.push(h);
    media[h] = { kind: "photo", full: { hash: h }, small: null };
  }
  const inline = `inline:${hex(JPEG_URL)}`;
  media[inline] = { kind: "sig", full: { inline: JPEG_URL }, small: null };
  let active = 0, peak = 0;
  const w = world({
    cfg: { packetDownloads: 3 },
    projects: [project(J1, { _media: media })],
    storage: {
      async getText(b, n) {
        active += 1; peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active -= 1;
        if (n === names[0]) return null;                                  // gone from the bucket
        if (n === names[1]) return "data:application/pdf;base64,JVBERi0=";  // a document page, not an image
        return JPEG_URL;
      },
    },
  });
  await w.run();
  assert.equal(peak, 3, "three at a time, never more");
  const { images } = w.deps.calls.renderPacket[0][1];
  assert.equal(images.size, 11);
  assert.equal(images.get(names[0]), null);
  assert.equal(images.get(names[1]), null);
  assert.deepEqual(Buffer.from(images.get(names[2])), JPEG);
  assert.deepEqual(Buffer.from(images.get(inline)), JPEG, "an inline image is decoded without a download");
  assert.equal(w.deps.calls.rationaleText[0][2].missing, 2, "the card counts both images that print as not available");

  const one = world({ cfg: { packetDownloads: 1 }, projects: [project(J1, { _media: media })],
    storage: { async getText() { active += 1; peak = Math.max(peak, active); await new Promise((res) => setTimeout(res, 1)); active -= 1; return JPEG_URL; } } });
  active = 0; peak = 0;
  await one.run();
  assert.equal(peak, 1);
});

test("a portal signature on its way holds the packet: the approval is read and handed to the gate", async () => {
  const portalId = uuid(900);
  const approvals = [{ id: "certDrying", status: "pending", doc: { html: "media:abc" }, updatedAt: "2026-10-10T08:00:00Z" }];
  const w = world({
    projects: [project(J1, { portalShare: { id: portalId } })],
    select: { portal_jobs: [{ approvals }] },
    deps: { packetGate: (p, o) => (o.certSignPending ? { ok: false, reason: "cert_sign_pending", detail: "x" } : { ok: true }) },
  });
  const r = await w.run();
  assert.deepEqual(w.supa.calls.select.filter((c) => c.table === "portal_jobs").map((c) => c.query), [`id=eq.${portalId}&select=approvals`]);
  assert.deepEqual(r.skipped, { cert_sign_pending: 1 });
  assert.equal(w.supa.rpcs("carrier_packet_withdraw").length, 0);
  assert.equal(w.supa.rpcs("carrier_packet_hold").length, 0);

  // a portal id that is not a uuid is never sent to PostgREST
  const odd = world({ projects: [project(J1, { portalShare: { id: "id-1700000000-abc" } })] });
  await odd.run();
  assert.equal(odd.supa.calls.select.filter((c) => c.table === "portal_jobs").length, 0);
});

test("certSignPending follows §4: pending with a document, or approved but not copied back, for 72 hours", () => {
  const at = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  const a = (over) => [{ id: "certDrying", status: "pending", doc: { html: "media:x" }, updatedAt: at(1), ...over }];
  assert.equal(certSignPending(a({}), {}, NOW), true);
  assert.equal(certSignPending(a({ doc: null }), {}, NOW), false, "nothing to sign yet");
  assert.equal(certSignPending(a({ updatedAt: at(73) }), {}, NOW), false, "a customer who never signs holds nothing");
  assert.equal(certSignPending(a({ updatedAt: "" }), {}, NOW), false);
  assert.equal(certSignPending(a({ status: "approved" }), {}, NOW), true, "signed, not yet copied into the blob");
  assert.equal(certSignPending(a({ status: "approved" }), { sigOwner: "data:image/png;base64,AA" }, NOW), false);
  assert.equal(certSignPending(a({ status: "approved" }), { portalSignedAt: at(2) }, NOW), false);
  assert.equal(certSignPending(a({ status: "declined" }), {}, NOW), false);
  assert.equal(certSignPending(a({ id: "workAuth" }), {}, NOW), false);
  assert.equal(certSignPending(null, {}, NOW), false);
});

test("imageBytes decodes an image data URL and refuses anything else", () => {
  assert.deepEqual(Buffer.from(imageBytes(JPEG_URL)), JPEG);
  assert.deepEqual(Buffer.from(imageBytes(`data:image/png;base64,${Buffer.from([137, 80]).toString("base64")}`)), Buffer.from([137, 80]));
  for (const v of [null, "", "media:abc:12", "data:application/pdf;base64,JVBERi0=", "data:image/jpeg;base64,", "data:image/jpeg,raw"]) {
    assert.equal(imageBytes(v), null, String(v));
  }
});

test("a worker stopping between jobs gives the run back to the queue", async () => {
  const w = world({ candidates: [cand(J1), cand(J2)], projects: [project(J1), project(J2)] });
  let n = 0;
  w.ctx.stopping = () => (n += 1) > 1;
  await assert.rejects(w.run(), /stopping/);
  assert.equal(w.supa.rpcs("carrier_packet_reserve").length, 1);
});
