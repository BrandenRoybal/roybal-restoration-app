/* Supabase Storage under the service role key: the carrier packet's PDFs
   (bucket carrier-packets) and the job media they are drawn from (bucket
   field-media). docs/Carrier_Packet_Design.md §10. No SDK, for the reason
   supa.mjs gives: six calls are all the packet lane needs.

     ensureBucket(id, opts)        create a private bucket; one that already
                                   exists is success
     getText(bucket, name)         an object as text (a field-media object is
                                   a data URL's text); null when absent
     getBytes(bucket, name)        an object's bytes; null when absent
     put(bucket, name, bytes, ct)  upload, never over an existing object
                                   (x-upsert: false): one that exists throws
                                   StorageError with status 409
     sign(bucket, name, seconds)   an absolute signed URL; null when absent
     remove(bucket, names)         delete; names that are not there are fine

   Every attempt has its own timeout. A 429, a 5xx or a request that never
   got an answer is tried again after a pause, three tries in all; anything
   else answers at once. A timed-out upload that did land comes back as 409
   on the next try, which the lane checks by content (lanes/packet.mjs).

   Storage reports most errors as HTTP 400 with the real status in the
   body's statusCode ("404" for a missing object, "409" for one that already
   exists); newer builds send that status on the response itself. Both are
   read as the same status here, so callers see 404 and 409 either way. */

import { errText } from "./log.mjs";

export class StorageError extends Error {
  constructor(status, body, where) {
    const msg = body && typeof body === "object"
      ? body.message ?? body.error ?? "request failed"
      : String(body ?? "request failed");
    super(`${where}: ${status} ${msg}`.slice(0, 1000));
    this.name = "StorageError";
    this.status = status;
    this.body = body;
  }
}

const TRIES = 3;
const RETRY_DELAYS_MS = [500, 2000];
const TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A bucket id or object name as URL path segments. An empty, "." or ".."
   segment would name some other object once the URL is normalised, so it
   is refused rather than encoded. */
function segments(value, what) {
  const parts = String(value ?? "").split("/");
  if (!parts.length || parts.some((s) => s === "" || s === "." || s === "..")) {
    throw new StorageError(0, `${what} ${JSON.stringify(String(value ?? "")).slice(0, 120)} is not a safe path`, "storage");
  }
  return parts.map(encodeURIComponent).join("/");
}
const bucketSeg = (bucket) => {
  if (String(bucket ?? "").includes("/")) throw new StorageError(0, "a bucket id has no slash", "storage");
  return segments(bucket, "bucket");
};

async function readBody(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/* the status Storage meant: a 400 carrying statusCode "404" is a 404 */
function statusOf(res, body) {
  const inner = body && typeof body === "object" ? String(body.statusCode ?? "") : "";
  return res.status === 400 && /^[1-5]\d\d$/.test(inner) ? Number(inner) : res.status;
}

export function makeStorage({ supabaseUrl, serviceKey, fetchImpl, timeoutMs = TIMEOUT_MS, retryDelaysMs = RETRY_DELAYS_MS, sleepImpl = sleep }) {
  const doFetch = (...a) => (fetchImpl ?? globalThis.fetch)(...a);
  const root = `${supabaseUrl}/storage/v1`;
  const auth = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const pause = (i) => sleepImpl(retryDelaysMs[Math.min(i, retryDelaysMs.length - 1)] ?? 0);

  /** One request with its retries → the last Response. */
  async function send(method, path, { headers = {}, body } = {}) {
    const where = `${method} /storage/v1${path.split("?")[0]}`;
    for (let i = 0; ; i++) {
      const last = i === TRIES - 1;
      let res;
      try {
        res = await doFetch(`${root}${path}`, {
          method, headers: { ...auth, ...headers }, body, signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (last) throw new StorageError(0, `no answer: ${errText(e, 200)}`, where);
        await pause(i);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && !last) {
        await res.arrayBuffer().catch(() => null);
        await pause(i);
        continue;
      }
      return { res, where };
    }
  }

  /** A JSON call: its parsed body, or StorageError with the status Storage meant. */
  async function json(method, path, payload) {
    const { res, where } = await send(method, path, {
      headers: { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await readBody(res);
    const status = statusOf(res, body);
    if (!res.ok) throw new StorageError(status, body, where);
    return body;
  }

  /** GET an object; null when Storage says it is not there. */
  async function download(bucket, name) {
    const { res, where } = await send("GET", `/object/${bucketSeg(bucket)}/${segments(name, "object")}`);
    if (res.ok) return res;
    const body = await readBody(res);
    const status = statusOf(res, body);
    if (status === 404) return null;
    throw new StorageError(status, body, where);
  }

  return {
    /** Creates the bucket; true when it was created, false when it was there already. */
    async ensureBucket(id, { public: isPublic = false, fileSizeLimit = null, allowedMimeTypes = null } = {}) {
      const payload = { id, name: id, public: isPublic === true };
      if (fileSizeLimit != null) payload.file_size_limit = fileSizeLimit;
      if (allowedMimeTypes != null) payload.allowed_mime_types = allowedMimeTypes;
      try {
        await json("POST", "/bucket", payload);
        return true;
      } catch (e) {
        const b = e?.body && typeof e.body === "object" ? e.body : {};
        const exists = e?.status === 409 || b.error === "Duplicate" || /already exists/i.test(String(b.message ?? ""));
        if (e instanceof StorageError && exists) return false;
        throw e;
      }
    },

    async getText(bucket, name) {
      const res = await download(bucket, name);
      return res ? res.text() : null;
    },

    async getBytes(bucket, name) {
      const res = await download(bucket, name);
      return res ? new Uint8Array(await res.arrayBuffer()) : null;
    },

    async put(bucket, name, bytes, contentType) {
      const { res, where } = await send("POST", `/object/${bucketSeg(bucket)}/${segments(name, "object")}`, {
        headers: { "Content-Type": contentType || "application/octet-stream", "x-upsert": "false" },
        body: bytes,
      });
      const body = await readBody(res);
      const status = statusOf(res, body);
      if (!res.ok) throw new StorageError(status, body, where);
      return body;
    },

    async sign(bucket, name, seconds) {
      let body;
      try {
        body = await json("POST", `/object/sign/${bucketSeg(bucket)}/${segments(name, "object")}`, { expiresIn: seconds });
      } catch (e) {
        if (e instanceof StorageError && e.status === 404) return null;
        throw e;
      }
      // signedURL is relative to /storage/v1 ("/object/sign/<bucket>/<name>?token=…")
      const rel = String(body?.signedURL ?? body?.signedUrl ?? "");
      if (!rel) throw new StorageError(200, "the signing answer has no signedURL", "POST /storage/v1/object/sign");
      if (/^https:\/\//i.test(rel)) return rel;
      return `${root}${rel.startsWith("/") ? rel : `/${rel}`}`;
    },

    async remove(bucket, names) {
      const list = (Array.isArray(names) ? names : [names]).map(String);
      if (!list.length) return [];
      for (const n of list) segments(n, "object");
      const body = await json("DELETE", `/object/${bucketSeg(bucket)}`, { prefixes: list });
      return Array.isArray(body) ? body : [];
    },
  };
}
