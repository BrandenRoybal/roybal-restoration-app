/* A thin PostgREST client under the service role key. No SDK: four verbs and
   rpc are all the worker needs, and a dependency-free image has nothing to
   install or audit. Every call throws SupaError with the HTTP status and
   PostgREST's {code, message, details} so callers can tell a lost lease
   (code 55000, object_not_in_prerequisite_state) from an outage. */

export class SupaError extends Error {
  constructor(status, body, where) {
    const msg = body && typeof body === "object"
      ? `${body.message ?? body.error ?? "request failed"}${body.details ? ` (${body.details})` : ""}`
      : String(body ?? "request failed");
    super(`${where}: ${status} ${msg}`.slice(0, 1000));
    this.name = "SupaError";
    this.status = status;
    this.code = body && typeof body === "object" ? body.code ?? null : null;
    this.body = body;
  }
}

/** PostgREST's `Content-Range: 0-9/123` (or `*​/123`) → 123; null when absent. */
export function parseCount(contentRange) {
  const m = /\/(\d+)\s*$/.exec(String(contentRange ?? ""));
  return m ? Number(m[1]) : null;
}

export function makeSupa({ supabaseUrl, serviceKey, fetchImpl }) {
  const doFetch = (...a) => (fetchImpl ?? globalThis.fetch)(...a);
  const base = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

  async function call(path, init = {}) {
    const res = await doFetch(`${supabaseUrl}${path}`, { ...init, headers: { ...base, ...(init.headers ?? {}) } });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!res.ok) throw new SupaError(res.status, body, path.split("?")[0]);
    return { body, res };
  }

  return {
    /** POST /rest/v1/rpc/<fn>. setof functions return an array, others a value. */
    async rpc(fn, args = {}) {
      const { body } = await call(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
      return body;
    },
    /** GET /rest/v1/<table>?<query> → rows. */
    async select(table, query) {
      const { body } = await call(`/rest/v1/${table}?${query}`, { method: "GET" });
      return Array.isArray(body) ? body : [];
    },
    /** Exact count of the rows a query matches, without fetching them. */
    async count(table, query) {
      const { res } = await call(`/rest/v1/${table}?select=id&limit=1&${query}`, {
        method: "GET", headers: { Prefer: "count=exact" },
      });
      return parseCount(res.headers.get("content-range")) ?? 0;
    },
    async insert(table, rows) {
      const { body } = await call(`/rest/v1/${table}`, {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(rows),
      });
      return Array.isArray(body) ? body : [];
    },
    async upsert(table, rows, onConflict = "id") {
      const { body } = await call(`/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
      return Array.isArray(body) ? body : [];
    },
    async patch(table, query, patch) {
      const { body } = await call(`/rest/v1/${table}?${query}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch),
      });
      return Array.isArray(body) ? body : [];
    },
  };
}
