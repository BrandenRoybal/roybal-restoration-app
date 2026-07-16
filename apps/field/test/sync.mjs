/* Sync engine test — drives push/pull/merge against a fake Supabase.
   Run: node test/sync.mjs */
import "fake-indexeddb/auto";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

/* ---- minimal globals ---- */
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

/* ---- fake Supabase server ---- */
const serverRows = new Map();
let clock = 1;
const nowIso = () => new Date(1700000000000 + clock++ * 1000).toISOString();
const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const mediaStore = new Map();   // field-media bucket: hash -> text

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
  if (u.pathname.startsWith("/storage/v1/object/field-media/")) {
    const hash = u.pathname.split("/").pop();
    if (method === "POST" || method === "PUT") { mediaStore.set(hash, opts.body); return resp(200, {}); }
    if (mediaStore.has(hash)) return { ok: true, status: 200, json: async () => ({}), text: async () => mediaStore.get(hash) };
    return resp(404, {});
  }
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.pathname === "/auth/v1/token") {
    return resp(200, { access_token: "tok", refresh_token: "ref", expires_in: 3600, user: { email: body.email } });
  }
  if (u.pathname === "/rest/v1/field_projects" && method === "POST") {
    const out = body.map((r) => {
      const row = { id: r.id, data: r.data, deleted: !!r.deleted, updated_at: nowIso() };
      serverRows.set(r.id, row);
      return row;
    });
    return resp(201, out);
  }
  if (u.pathname === "/rest/v1/field_projects" && method === "GET") {
    const raw = u.searchParams.get("updated_at");
    const since = raw && raw.startsWith("gt.") ? raw.slice(3) : "";
    const rows = [...serverRows.values()]
      .filter((r) => !since || r.updated_at > since)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    return resp(200, rows);
  }
  return resp(404, {});
};

const { Store } = await import("../js/core.js");
const { signIn, isSignedIn } = await import("../js/supa.js");
const { syncNow } = await import("../js/sync.js");

(async () => {
  await signIn("crew@roybalconstruction.com", "pw");
  ok(isSignedIn(), "sign-in stores a session");

  // local job → push to server
  await Store.put({ id: "p1", customer: "Alpha" });
  await syncNow();
  ok(serverRows.has("p1"), "local job pushes up to the server");

  // another device adds a job → pulls down
  serverRows.set("p2", { id: "p2", data: { id: "p2", customer: "Beta", updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  const beta = await Store.get("p2");
  ok(beta && beta.customer === "Beta", "remote job pulls down to this device");

  // remote edit wins (newer)
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-EDITED", updatedAt: new Date(Date.now() + 9e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-EDITED", "newer remote edit is applied (last-write-wins)");

  // remote delete propagates
  serverRows.set("p2", { id: "p2", data: { id: "p2" }, deleted: true, updated_at: nowIso() });
  await syncNow();
  ok(!(await Store.get("p2")), "remote delete removes the job locally");

  // ---------- media offload: photo-heavy jobs stay under the row cap ----------
  const BIG = "data:image/jpeg;base64," + "P".repeat(80_000);
  await Store.put({ id: "p3", customer: "Gamma", photos: [{ id: "ph1", src: BIG }] });
  await syncNow();
  const row3 = serverRows.get("p3");
  ok(row3 && !JSON.stringify(row3.data).includes("PPPPPPPP"), "photo bytes never reach the job row");
  ok(/^media:[0-9a-f]{64}:\d+$/.test(row3.data.photos[0].src), "row carries a media marker instead");
  ok(mediaStore.size === 1 && [...mediaStore.values()][0] === BIG, "photo uploaded to the field-media bucket");

  // another device's row referencing that media inflates on pull
  serverRows.set("p4", { id: "p4", data: { ...row3.data, id: "p4", customer: "Delta", updatedAt: new Date().toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p4")).photos[0].src === BIG, "pulled marker re-inflates to the original photo");

  // ---------- clobber protection ----------
  // equal timestamps: local wins the tie, remote is NOT applied
  const p1 = await Store.get("p1");
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-TIE", updatedAt: p1.updatedAt }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-EDITED", "equal-timestamp remote does not overwrite local work");
  const snapsBefore = (await Store.backups("p1")).length;   // the legit overwrite above already took one

  // a strictly newer (stale-content) copy still wins — but the outgoing
  // local copy is snapshotted to on-device backups first
  serverRows.set("p1", { id: "p1", data: { id: "p1", customer: "Alpha-CLOBBER", updatedAt: new Date(Date.now() + 18e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p1")).customer === "Alpha-CLOBBER", "strictly newer remote still applies (last-edit-wins)");
  const snaps = await Store.backups("p1");
  ok(snaps.length === snapsBefore + 1 && snaps[0].data.customer === "Alpha-EDITED", "overwritten copy saved to on-device backups (newest first)");

  // ---------- unresolvable media never blanks a good local copy ----------
  // A good photo lives locally (data URL). A strictly-newer remote references a
  // media hash the bucket can't serve yet (transient auth gap / not-yet-uploaded).
  await Store.put({ id: "p5", customer: "Echo", photos: [{ id: "ph5", src: BIG }] });
  await syncNow();                       // push the good copy up
  const HASH = "a".repeat(64);           // a hash the bucket doesn't have (download → 404 → null)
  const missMarker = `media:${HASH}:${BIG.length}`;
  serverRows.set("p5", { id: "p5", data: { id: "p5", customer: "Echo-NEW", photos: [{ id: "ph5", src: missMarker }], updatedAt: new Date(Date.now() + 27e5).toISOString() }, deleted: false, updated_at: nowIso() });
  await syncNow();
  ok((await Store.get("p5")).photos[0].src === BIG, "failed media download does NOT overwrite the good local photo");

  // once the object is actually in the bucket, the next sync resolves it
  mediaStore.set(HASH, BIG);
  await syncNow();
  const p5done = await Store.get("p5");
  ok(p5done.customer === "Echo-NEW" && p5done.photos[0].src === BIG, "the row re-inflates and applies once the media is downloadable");

  console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL SYNC CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
