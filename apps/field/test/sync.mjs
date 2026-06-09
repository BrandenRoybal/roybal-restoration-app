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

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
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

  console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL SYNC CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
