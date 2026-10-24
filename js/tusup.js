/* ============================================================
   Roybal Field Forms — resumable upload (tus 1.0.0) to Supabase Storage
   ------------------------------------------------------------
   A hand-written client for the one server we talk to. Supabase Storage
   speaks the tus protocol at POST {SUPABASE_URL}/storage/v1/upload/resumable:

     POST   → creates the upload; the object name and bucket ride in
              Upload-Metadata (base64 pairs); the reply's Location is the
              upload URL, good for 24 hours.
     PATCH  → one 6 MiB chunk at a time (Supabase requires exactly 6 MiB;
              the last chunk is whatever is left), Upload-Offset says where.
     HEAD   → asks the server how far it got, to resume after a drop.

   Why not tus-js-client: the app has no bundler and vendors nothing it
   doesn't have to (zip.js, docx.js are home-grown); this is 150 lines
   against one server, Node-tested against a mock of it (test/tusup.test.mjs).

   Nothing here touches the store or the DOM. The caller (mediaqueue.js)
   persists `uploadUrl` and `offset` between attempts and passes them back.
   ============================================================ */

export const TUS_VERSION = "1.0.0";
export const CHUNK_BYTES = 6 * 1024 * 1024;   // Supabase: "the chunk size must be set to 6MB and cannot be modified"
const b64 = (s) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(String(s)))) : Buffer.from(String(s), "utf8").toString("base64"));

/** Upload-Metadata: `key base64,key base64` — what Supabase reads the object name and bucket from. */
export function uploadMetadata({ bucket, path, contentType, cacheControl = "3600" }) {
  return [["bucketName", bucket], ["objectName", path], ["contentType", contentType || "application/octet-stream"], ["cacheControl", cacheControl]]
    .map(([k, v]) => `${k} ${b64(v)}`).join(",");
}

/** A Location header may be absolute or relative to the endpoint. */
export function resolveLocation(location, endpoint) {
  const loc = String(location || "").trim();
  if (!loc) return "";
  if (/^https?:\/\//i.test(loc)) return loc;
  try { return new URL(loc, endpoint).toString(); } catch { return ""; }
}

export class TusError extends Error {
  constructor(message, { status = 0, phase = "", retryable = true } = {}) { super(message); this.status = status; this.phase = phase; this.retryable = retryable; }
}
const isNetError = (e) => e instanceof TypeError || (e && e.name === "AbortError");

/**
 * Upload `blob` to `bucket/path`, resuming if `uploadUrl`/`offset` say so.
 *
 * opts: {
 *   endpoint, headers(): auth headers for every request (apikey + bearer),
 *   bucket, path, blob, contentType,
 *   uploadUrl?, offset?     — from a previous attempt (persisted by the caller)
 *   onProgress?(sent, total, uploadUrl)  — after every acknowledged chunk
 *   signal?                 — AbortSignal; a pause aborts the in-flight chunk,
 *                             progress so far stays valid on the server
 *   fetch?, chunkBytes?     — for tests
 * }
 * Resolves { uploadUrl, offset, complete: true }. Rejects with TusError
 * (retryable unless the server said no) or the network error (retryable).
 */
export async function tusUpload(opts) {
  const f = opts.fetch || globalThis.fetch;
  const chunk = opts.chunkBytes || CHUNK_BYTES;
  const total = opts.blob.size;
  const base = () => ({ ...(opts.headers ? opts.headers() : {}), "tus-resumable": TUS_VERSION });
  let uploadUrl = opts.uploadUrl || "";
  let offset = Math.max(0, Number(opts.offset) || 0);

  // 1. where are we? — a resumed upload asks the server; a new one is created
  if (uploadUrl) {
    const head = await f(uploadUrl, { method: "HEAD", headers: base(), signal: opts.signal });
    if (head.status === 404 || head.status === 410 || head.status === 403) { uploadUrl = ""; offset = 0; }   // expired (24 h) or gone: start over
    else if (!head.ok) throw new TusError(`Couldn't resume the upload (${head.status})`, { status: head.status, phase: "head" });
    else {
      const o = Number(head.headers.get("upload-offset"));
      if (Number.isFinite(o)) offset = o;
    }
  }
  if (!uploadUrl) {
    const res = await f(opts.endpoint, {
      method: "POST", signal: opts.signal,
      headers: { ...base(), "x-upsert": "true", "upload-length": String(total), "upload-metadata": uploadMetadata({ bucket: opts.bucket, path: opts.path, contentType: opts.contentType }) },
    });
    if (!res.ok && res.status !== 201) {
      const text = await res.text().catch(() => "");
      const retryable = res.status >= 500 || res.status === 429;
      throw new TusError(`Upload refused (${res.status})${text ? ": " + text.slice(0, 200) : ""}`, { status: res.status, phase: "create", retryable });
    }
    uploadUrl = resolveLocation(res.headers.get("location"), opts.endpoint);
    if (!uploadUrl) throw new TusError("The server accepted the upload but gave no Location", { status: res.status, phase: "create" });
    offset = 0;
  }

  // 2. send chunks until the server has every byte
  while (offset < total) {
    const end = Math.min(total, offset + chunk);
    const res = await f(uploadUrl, {
      method: "PATCH", signal: opts.signal,
      headers: { ...base(), "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
      body: opts.blob.slice(offset, end),
    });
    if (res.status === 409) {   // offset mismatch: believe the server and continue from there
      const head = await f(uploadUrl, { method: "HEAD", headers: base(), signal: opts.signal });
      const o = Number(head.headers.get("upload-offset"));
      if (!head.ok || !Number.isFinite(o)) throw new TusError("Lost track of the upload offset", { status: 409, phase: "patch" });
      offset = o;
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new TusError("The upload expired on the server — it starts over", { status: res.status, phase: "patch" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TusError(`Upload failed (${res.status})${text ? ": " + text.slice(0, 200) : ""}`, { status: res.status, phase: "patch", retryable: res.status >= 500 || res.status === 429 });
    }
    const o = Number(res.headers.get("upload-offset"));
    offset = Number.isFinite(o) ? o : end;
    if (opts.onProgress) opts.onProgress(offset, total, uploadUrl);
  }
  return { uploadUrl, offset, complete: true };
}

/** True when the caller should keep the row and try again later. */
export function retryable(err) {
  if (isNetError(err)) return true;
  if (err instanceof TusError) return err.retryable;
  return true;
}
