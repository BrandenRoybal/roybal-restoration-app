/**
 * Magicplan proxy — the pure half (no Deno, no network, Node-testable).
 *
 * Everything that can be wrong about a Magicplan sync lives here: the request
 * paths, the ONE accepted shape of every response, the storage path builder,
 * the metric→feet normalization and the sync algorithm itself. index.ts is
 * only the transport (fetch, headers, the 429 retry) and the gate. That split
 * is why this file has NO imports and does no I/O of its own: `syncPlan` takes
 * an `Io` bag of injected functions so magicplan.test.mjs can run design §4.2
 * end to end with fakes under `node --experimental-strip-types`, where a Deno
 * URL import or a `fetch` would not load.
 *
 * SHARED HELPERS — change both copies. cleanSegment, mpFileId, mpFilePath,
 * MP_SAFE_PATH, isMpSitePath, parsePhotoName, parseMpTime and
 * normalizeStatistics are duplicated, logic for logic, in
 * apps/field/js/magicplancalc.js: the field app builds the same ids and
 * paths when it adopts a row, so a drift between the two would make a re-pull
 * duplicate a file instead of replacing it. The parity test in
 * magicplan.test.mjs asserts byte-identical output on the canonical fixtures,
 * and MP_SAFE_PATH is asserted textually identical to the office function's
 * SAFE_PATH (roybal-ai-office/sitevisit.ts) — the regex that decides which
 * storage objects the estimator may sign.
 *
 * ONE SHAPE PER CALL (brief rule 8): GET /workspace and GET /plans/statistics
 * are UNWRAPPED; every other call is `{ data }`. A parser that sees anything
 * else throws with the call's name. "Handle several known shapes" is the
 * sentence that got the era-0 proxy deleted.
 *
 * Only erasable TypeScript here (types, `as const`, a plain class) so the
 * strip-types loader accepts it. Type-check:
 *   npx tsc --noEmit --strict --target es2022 --module esnext \
 *     --moduleResolution bundler --allowImportingTsExtensions \
 *     supabase/functions/magicplan-proxy/magicplan.ts
 */

/* ============================================================
   SHARED helpers — identical in apps/field/js/magicplancalc.js
   ============================================================ */

/** siteFilePath's `clean` (apps/field/js/sitevisit.js), byte for byte. */
export function cleanSegment(s: unknown, max: number): string {
  return String(s ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-max);
}

/** The stable file id for one Magicplan object: the first 8 hex of its sha256.
    Same bytes → same id on every device and every re-pull, which is what lets
    adoptExport replace in place instead of duplicating. A bad hash is a bug,
    never a default. */
export function mpFileId(hash: unknown): string {
  if (!/^[0-9a-f]{64}$/i.test(String(hash))) throw new Error("bad hash");
  return "mp-" + String(hash).toLowerCase().slice(0, 8);
}

/** `sitevisit/<job>/mp-<hash8>-<cleanname>` — the client's siteFilePath shape.
    The job segment maps "." to "_" because isSitePath's job alphabet has no
    dot; for every real job id (bj-<uuid>, uid()) the result equals
    siteFilePath(job, mpFileId(hash), name) exactly. */
export function mpFilePath(job: unknown, hash: unknown, name: unknown): string {
  const jobSeg = String(job ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").slice(-80) || "job";
  const base = cleanSegment(name, 80).replace(/^[._]+/, "") || "file";
  return `sitevisit/${jobSeg}/${mpFileId(hash)}-${base}`;
}

/** Textually identical to SAFE_PATH in roybal-ai-office/sitevisit.ts — the
    only paths the estimator will ever sign. Asserted by the test. */
export const MP_SAFE_PATH = /^sitevisit\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/;
export function isMpSitePath(p: unknown): p is string {
  return typeof p === "string" && MP_SAFE_PATH.test(p) && !p.includes("..");
}

/** "1st Floor - Living Room - Window - 2.jpg" → floor / room / caption.
    Fewer than three " - " parts means we do not know the room — say so with
    "" rather than guess (design §4.3). */
export function parsePhotoName(name: unknown): { floor: string; room: string; caption: string } {
  const base = String(name ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const parts = base.split(" - ").map((s) => s.trim());
  if (parts.length < 3) return { floor: "", room: "", caption: "" };
  if (/^\d+$/.test(parts[parts.length - 1])) parts.pop();
  return { floor: parts[0], room: parts[1], caption: parts.slice(2).join(" - ") };
}

/** Magicplan stamps come in two shapes: "2024-08-08T10:27:10.000000+00:00"
    (six fraction digits, which Date.parse rejects) and "2023-11-09 08:40:02"
    (no zone — the API's clock is UTC). */
export function parseMpTime(s: unknown): number | null {
  let t = String(s ?? "").trim();
  if (!t) return null;
  t = t.replace(/(\.\d{3})\d+/, "$1");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) t = t.replace(" ", "T") + "Z";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

export type MpRoom = {
  name: string; floorSF: number | null; perimLF: number | null; ceilingFt: number | null;
  wallSF: number | null; wallSFNet: number | null; doors: number; windows: number;
  volumeCF: number | null; dims: string;
};
export type MpStatistics = { units: "imperial" | "metric"; floors: { name: string; rooms: MpRoom[] }[] };

/** The UNWRAPPED GET /plans/statistics/{id} body → the quantities block the
    Floor Plan form and the M3 estimate read. Metric converts and rounds to
    1 ft² / 0.5 ft / 1 ft³ (design §4.3); anything that is not "metric" is
    imperial and passes through unrounded. Rooms come from rooms[], never from
    room_count (Magicplan counts a bathroom outside room_count). */
export function normalizeStatistics(raw: unknown): MpStatistics {
  const r = raw as { units?: unknown; statistics?: unknown } | null;
  if (!r || typeof r.statistics !== "object" || r.statistics === null) {
    throw new Error("Unexpected Magicplan statistics shape");
  }
  const units: "imperial" | "metric" = String(r.units ?? "").toLowerCase() === "metric" ? "metric" : "imperial";
  const metric = units === "metric";
  const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const area = (v: unknown) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 10.764) : n; };
  const len = (v: unknown) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 3.281 * 2) / 2 : n; };
  const vol = (v: unknown) => { const n = num(v); return n === null ? null : metric ? Math.round(n * 35.315) : n; };
  const count = (v: unknown) => Number(v) | 0;
  const stats = r.statistics as { floors?: unknown };
  const floorsRaw = Array.isArray(stats.floors) ? stats.floors as Record<string, unknown>[] : [];
  const floors = floorsRaw.map((f) => {
    const roomsRaw = Array.isArray(f.rooms) ? f.rooms as Record<string, unknown>[] : [];
    return {
      name: String(f.name ?? "").trim(),
      rooms: roomsRaw.map((room): MpRoom => ({
        name: String(room.name ?? "").trim(),
        floorSF: area(room.area_without_walls),
        perimLF: len(room.ground_perimeter),
        ceilingFt: len(room.height),
        wallSF: area(room.walls_surface),
        wallSFNet: area(room.walls_surface_without_openings),
        doors: count(room.door_count),
        windows: count(room.window_count),
        volumeCF: vol(room.volume),
        dims: String(room.dimensions ?? ""),
      })),
    };
  });
  return { units, floors };
}

/* ============================================================
   Server-only: constants, env, paths, bodies
   ============================================================ */

export const MP_BASE = "https://cloud.magicplan.app/api/v2";
export const MP_ORIGIN = "https://cloud.magicplan.app";
export const MAX_FILE_BYTES = 80 * 1024 * 1024;   // one report PDF; a bigger one is a mistake, not a packet
export const MAX_PHOTOS = 120;                    // per sync — the edge function's wall clock is the real cap
export const RATE_LIMIT_MESSAGE = "Magicplan rate limit (429) — try again in a few minutes";

export type MpEnv = { key: string; customer: string; projectEmail: string; prefix: string };

/** A link-mode sync found the project bound to ANOTHER job. Never written to
    the table; index.ts answers 409 so the office picks the right job file. */
export class MpConflict extends Error {}

export function mpHeaders(env: MpEnv): Record<string, string> {
  return { key: env.key, customer: env.customer };
}

/** The company key goes ONLY to the API origin. File urls come back on S3;
    sending the key there would hand it to whoever reads that bucket's logs. */
export function attachAuth(url: string, env: MpEnv): Record<string, string> {
  try {
    return new URL(url).origin === MP_ORIGIN ? mpHeaders(env) : {};
  } catch { return {}; }
}

export function listProjectsPath(name: string, page: number): string {
  return `/projects?name=${encodeURIComponent(name)}&page_size=50&page=${page}`;
}
export function planFilesPath(planId: string): string {
  return `/plans/${encodeURIComponent(planId)}/files?format[]=pdf&include_photos=true`;
}
export function planStatisticsPath(planId: string): string {
  return `/plans/statistics/${encodeURIComponent(planId)}`;
}
/** `main` dimensions, no annotations: a clean floor SVG for the Moisture Map
    base (design §1). */
export function projectPlanPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/plan?floor_svg_dimensions=main&floor_svg_show_annotations=false`;
}
export function archivePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/archive`;
}

/** "<Customer> — <street>" — what the owner sees in the app's project list. */
export function projectName(customer: unknown, street: unknown): string {
  const c = String(customer ?? "").trim(), s = String(street ?? "").trim();
  return c && s ? `${c} — ${s}` : (c || s || "Site visit");
}

export type CreateInput = {
  fieldProjectId: string; customer: string;
  address: { street?: string; city?: string; postal_code?: string; country?: string };
  by?: string;
};

/** POST /projects body. `email` is the owner's one Magicplan seat (ruling:
    siteVisit.by is recorded on the blob, never used here). The address has no
    state field in the API. */
export function createProjectBody(input: CreateInput, env: MpEnv): {
  name: string; external_reference_id: string; email: string;
  address: { street: string | null; city: string | null; postal_code: string | null; country: string };
} {
  const a = input.address || {};
  const orNull = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s : null; };
  return {
    name: env.prefix + projectName(input.customer, a.street),
    external_reference_id: input.fieldProjectId,
    email: env.projectEmail,
    address: {
      street: orNull(a.street), city: orNull(a.city), postal_code: orNull(a.postal_code),
      country: String(a.country ?? "").trim() || "US",
    },
  };
}

/** Error bodies are `{message, data}`; `data` is not always a string. */
export function errorMessage(status: number, body: unknown): string {
  if (!body || typeof body !== "object") return `Magicplan ${status}: request failed`;
  const b = body as { message?: unknown; data?: unknown };
  let msg = `Magicplan ${status}: ${b.message ?? "request failed"}`;
  if (b.data !== undefined) msg += " — " + JSON.stringify(b.data).slice(0, 300);
  return msg;
}

/** Content type for storage: the API's file_type first (S3 answers every
    download as octet-stream), the response header second. */
export function mimeFor(fileType: unknown, contentType?: string): string {
  const t = String(fileType ?? "").toLowerCase();
  if (t === "pdf") return "application/pdf";
  if (t === "jpg" || t === "jpeg") return "image/jpeg";
  if (t === "png") return "image/png";
  if (t === "svg") return "image/svg+xml";
  if (t === "webp") return "image/webp";
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  return ct || "application/octet-stream";
}

/* ============================================================
   Input validation — thrown Errors become 400s in index.ts
   ============================================================ */

const FIELD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXPORT_ID = /^[0-9a-f-]{36}$/i;
const shortStr = (v: unknown, what: string, max = 160): string => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > max) throw new Error(`Invalid ${what}`);
  return v;
};

export function validateSyncInput(input: { projectId?: unknown; fieldProjectId?: unknown }): { projectId: string; fieldProjectId: string } {
  const projectId = input?.projectId;
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 64) throw new Error("Invalid projectId");
  const fieldProjectId = input?.fieldProjectId;
  if (typeof fieldProjectId !== "string" || !FIELD_ID.test(fieldProjectId)) throw new Error("Invalid fieldProjectId");
  return { projectId, fieldProjectId };
}
export function validateProjectId(v: unknown): string {
  return validateSyncInput({ projectId: v, fieldProjectId: "x" }).projectId;
}
export function validateExportInput(input: { exportId?: unknown; fieldProjectId?: unknown }): { exportId: string; fieldProjectId: string } {
  const exportId = input?.exportId;
  if (typeof exportId !== "string" || !EXPORT_ID.test(exportId)) throw new Error("Invalid exportId");
  const { fieldProjectId } = validateSyncInput({ projectId: "x", fieldProjectId: input?.fieldProjectId });
  return { exportId, fieldProjectId };
}
export function validateCreateInput(input: Record<string, unknown> | null | undefined): CreateInput {
  const { fieldProjectId } = validateSyncInput({ projectId: "x", fieldProjectId: input?.fieldProjectId });
  const a = (input?.address && typeof input.address === "object" ? input.address : {}) as Record<string, unknown>;
  return {
    fieldProjectId,
    customer: shortStr(input?.customer, "customer"),
    address: {
      street: shortStr(a.street, "address.street"), city: shortStr(a.city, "address.city"),
      postal_code: shortStr(a.postal_code, "address.postal_code"), country: shortStr(a.country, "address.country"),
    },
    by: shortStr(input?.by, "by"),
  };
}

/* ============================================================
   Response parsers — ONE shape each, throw on anything else
   ============================================================ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** GET /workspace — UNWRAPPED (the one list-free call that is). */
export function parseWorkspace(json: unknown): { name: string; ownerEmail: string; formats: string[]; lastModified: string } {
  if (!isObj(json) || typeof json.name !== "string") throw new Error("Unexpected Magicplan response for GET /workspace");
  const owner = isObj(json.owner) ? json.owner : {};
  return {
    name: json.name,
    ownerEmail: str(owner.email),
    formats: Array.isArray(json.formats) ? json.formats.filter((f): f is string => typeof f === "string") : [],
    lastModified: str(json.last_modified),
  };
}

export type MpProject = {
  projectId: string; planId: string; cloudUrl: string; externalReferenceId: string | null;
  userModified: string; archivedAt: string | null; name: string; createdAt: string;
};

/** `{ data: Project }` — POST /projects (201 and 207 alike; warnings are not
    errors), GET /projects/{id}, PUT /projects/{id}/archive. */
export function parseProject(json: unknown): MpProject {
  const d = isObj(json) && isObj(json.data) ? json.data : null;
  if (!d || d.id === undefined || d.id === null || d.id === "") throw new Error("Unexpected Magicplan response for project");
  return {
    projectId: str(d.id),
    planId: str(d.plan_id),
    cloudUrl: str(d.cloud_url),
    externalReferenceId: strOrNull(d.external_reference_id),
    userModified: str(d.user_modified),
    archivedAt: strOrNull(d.archived_at),
    name: str(d.name),
    createdAt: str(d.user_created),
  };
}

/** GET /projects — list items carry NO plan_id; a match is confirmed by
    external_reference_id and then GET /projects/{id} follows. */
export function parseProjectList(json: unknown): {
  items: { id: string; externalReferenceId: string | null; name: string; archivedAt: string | null; userModified: string }[];
  nextPage: number | null;
} {
  if (!isObj(json) || !Array.isArray(json.data)) throw new Error("Unexpected Magicplan response for GET /projects");
  const items = (json.data as unknown[]).filter(isObj).map((p) => ({
    id: str(p.id),
    externalReferenceId: strOrNull(p.external_reference_id),
    name: str(p.name),
    archivedAt: strOrNull(p.archived_at),
    userModified: str(p.user_modified),
  }));
  const info = isObj(json.page_info) ? json.page_info : {};
  const np = Number(info.next_page);
  return { items, nextPage: Number.isFinite(np) && np > 0 ? np : null };
}

export type RawFile = { name: string; folder: string; url: string; last_modified: string; size: number; file_type: string };
export type RawPhoto = RawFile & { symbol_instance_id: string };

const rawFile = (f: Obj): RawFile => ({
  name: str(f.name), folder: str(f.folder), url: str(f.url), last_modified: str(f.last_modified),
  size: Number(f.size) || 0, file_type: str(f.file_type),
});

/** GET /plans/{id}/files → `{ data: { files[], photos[] } }`. Only the Report
    PDF and jpg/png photos are wanted; the API has no content hash, so the
    caller's own sha256 is the identity. */
export function parsePlanFiles(json: unknown): { files: RawFile[]; photos: RawPhoto[] } {
  const d = isObj(json) && isObj(json.data) ? json.data : null;
  if (!d || !Array.isArray(d.files)) throw new Error("Unexpected Magicplan response for GET /plans/{id}/files");
  const files = (d.files as unknown[]).filter(isObj).map(rawFile)
    .filter((f) => f.file_type.toLowerCase() === "pdf" && f.url);
  const photos = (Array.isArray(d.photos) ? d.photos as unknown[] : []).filter(isObj)
    .map((p) => ({ ...rawFile(p), symbol_instance_id: str(p.symbol_instance_id) }))
    .filter((p) => /^(jpg|jpeg|png)$/.test(p.file_type.toLowerCase()) && p.url);
  return { files, photos };
}

/** GET /projects/{id}/plan → the floors' SVG urls (`data.plan_data.floors[]`). */
export function parsePlanFloors(json: unknown): { name: string; image: string }[] {
  const d = isObj(json) && isObj(json.data) ? json.data : null;
  const pd = d && isObj(d.plan_data) ? d.plan_data : null;
  if (!pd || !Array.isArray(pd.floors)) return [];
  return (pd.floors as unknown[]).filter(isObj)
    .filter((f) => typeof f.name === "string" && typeof f.image === "string" && f.image)
    .map((f) => ({ name: f.name as string, image: f.image as string }));
}

/* ============================================================
   429 — one retry, then fail loud (brief §4.1)
   ============================================================ */

export function shouldRetry(status: number, attempt: number): boolean {
  return status === 429 && attempt === 0;
}
/** Retry-After is absent from the OpenAPI document; honour it when present,
    cap it so a hostile header cannot pin the function to its wall clock. */
export function retryDelayMs(retryAfterHeader: string | null): number {
  const s = Number(retryAfterHeader);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 10) * 1000 : 2000;
}

/* ============================================================
   Rows and the "already have it" index
   ============================================================ */

export type FileEntry = {
  path: string; name: string; mime: string; size: number; hash: string;
  folder: string; mp_last_modified: string; file_type: string;
};
export type PhotoEntry = FileEntry & { room: string; floor: string; caption: string; symbol_instance_id: string };
export type SvgEntry = { floor: string; path: string; hash: string; name: string; size: number };
export type ExportRow = {
  id: string; mp_project_id: string; mp_plan_id: string; field_project_id: string | null; status: string;
  files: FileEntry[]; photos: PhotoEntry[]; statistics: unknown; floors_svg: SvgEntry[];
  error: string | null; synced_at: string | null; received_at?: string;
  imported_at?: string | null; imported_by?: string | null;
};

/** The pre-download identity of an API file. No content hash comes back from
    the API, so a prior row's entry is trusted when folder, name, size and
    last_modified all agree; the folder is in the key because the same name in
    two folders must not alias. */
export function reuseKey(f: { folder?: string; name?: string; size?: number; mp_last_modified?: string; last_modified?: string }): string {
  return `${f.folder ?? ""}|${f.name ?? ""}|${f.size ?? ""}|${f.mp_last_modified ?? f.last_modified ?? ""}`;
}

export type PriorIndex = {
  byKey: Map<string, { hash: string; path: string; size: number; mime: string }>;
  bySvg: Map<string, { hash: string; path: string; size: number }>;
  hashes: Set<string>;
  paths: Set<string>;
};

/** Index prior ready|imported rows of the same plan so a re-pull downloads
    nothing it already has and uploads nothing already in the bucket. */
export function indexPrior(rows: ExportRow[]): PriorIndex {
  const byKey = new Map<string, { hash: string; path: string; size: number; mime: string }>();
  const bySvg = new Map<string, { hash: string; path: string; size: number }>();
  const hashes = new Set<string>();
  const paths = new Set<string>();
  for (const row of rows || []) {
    const entries: FileEntry[] = [...(Array.isArray(row?.files) ? row.files : []), ...(Array.isArray(row?.photos) ? row.photos : [])];
    for (const f of entries) {
      if (!f || !f.hash || !f.path) continue;
      if (!byKey.has(reuseKey(f))) byKey.set(reuseKey(f), { hash: f.hash, path: f.path, size: f.size, mime: f.mime });
      hashes.add(f.hash); paths.add(f.path);
    }
    for (const s of (Array.isArray(row?.floors_svg) ? row.floors_svg : [])) {
      if (!s || !s.hash || !s.path) continue;
      const k = `${s.floor}|${s.name}`;
      if (!bySvg.has(k)) bySvg.set(k, { hash: s.hash, path: s.path, size: s.size });
      hashes.add(s.hash); paths.add(s.path);
    }
  }
  return { byKey, bySvg, hashes, paths };
}

/* ============================================================
   The injected I/O and the actions
   ============================================================ */

export type Io = {
  /** Relative to MP_BASE; the transport adds the headers and the one 429 retry.
      Resolves for EVERY status — the pure steps decide what a non-2xx means. */
  api: (path: string, init?: { method?: string; body?: string }) => Promise<{ status: number; json: unknown }>;
  /** Throws errorMessage(...) on a non-2xx. */
  download: (url: string, headers: Record<string, string>) => Promise<{ bytes: Uint8Array; contentType: string }>;
  sha256: (bytes: Uint8Array) => Promise<string>;                                   // lowercase hex
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;  // field-media, upsert
  priorRows: (planId: string) => Promise<ExportRow[]>;                              // status in (ready, imported)
  insertRow: (row: Partial<ExportRow>) => Promise<ExportRow>;
  updateRow: (id: string, patch: Partial<ExportRow>) => Promise<ExportRow>;
  now: () => string;                                                                // ISO
};

const is2xx = (status: number) => status >= 200 && status < 300;

/** One API call, checked. A 429 that reaches here already had its retry. */
async function call(io: Io, path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const { status, json } = await io.api(path, init);
  if (status === 429) throw new Error(RATE_LIMIT_MESSAGE);
  if (!is2xx(status)) throw new Error(errorMessage(status, json));
  return json;
}

const needEmail = (env: MpEnv) => {
  if (!env.projectEmail) throw new Error("MAGICPLAN_PROJECT_EMAIL is not set on this server");
};

/** Our project, if it already exists: same external_reference_id, not
    archived. `name=` is a partial match on the API side, so the id is the
    only thing that confirms it. Five pages of 50 is far past any real list. */
export async function findProject(io: Io, env: MpEnv, name: string, fieldProjectId: string): Promise<{ id: string } | null> {
  void env;
  let page: number | null = 1;
  for (let i = 0; i < 5 && page; i++) {
    const list = parseProjectList(await call(io, listProjectsPath(name, page)));
    const hit = list.items.find((p) => p.externalReferenceId === fieldProjectId && p.archivedAt == null);
    if (hit) return { id: hit.id };
    page = list.nextPage;
  }
  return null;
}

/** Idempotent create: the lookup runs first so a second device scheduling the
    same visit links the existing project instead of burning a metered one. */
export async function createProject(io: Io, env: MpEnv, input: CreateInput): Promise<{
  projectId: string; planId: string; cloudUrl: string; createdAt: string; existed: boolean; name: string;
}> {
  needEmail(env);
  const body = createProjectBody(input, env);
  const found = await findProject(io, env, body.name, input.fieldProjectId);
  const p = found
    ? parseProject(await call(io, `/projects/${encodeURIComponent(found.id)}`))
    : parseProject(await call(io, "/projects", { method: "POST", body: JSON.stringify(body) }));
  return {
    projectId: p.projectId, planId: p.planId, cloudUrl: p.cloudUrl, createdAt: p.createdAt,
    existed: !!found, name: p.name || body.name,
  };
}

export async function getStatus(io: Io, env: MpEnv, projectId: string): Promise<{
  externalReferenceId: string | null; userModified: string; archivedAt: string | null; planId: string;
}> {
  void env;
  const p = parseProject(await call(io, `/projects/${encodeURIComponent(projectId)}`));
  return { externalReferenceId: p.externalReferenceId, userModified: p.userModified, archivedAt: p.archivedAt, planId: p.planId };
}

/** The scan stays in Magicplan; the project leaves the phone's active list.
    `acting_user` attributes the action to the owner's login. */
export async function archiveProject(io: Io, env: MpEnv, projectId: string): Promise<{ archivedAt: string | null }> {
  needEmail(env);
  const p = parseProject(await call(io, archivePath(projectId), {
    method: "PUT", body: JSON.stringify({ acting_user: env.projectEmail }),
  }));
  return { archivedAt: p.archivedAt };
}

const clampName = (s: string) => s.slice(0, 200);
const mb = (n: number) => Math.round(n / (1024 * 1024));

/** The sync (brief §4.2, design §4.2). Ownership first: a project whose
    external_reference_id is not this job is never imported into it — the row
    lands `unmatched` for the admin's Link picker. Then files, photos, the
    quantities and the floor SVGs, each downloaded once per content (prior
    rows of the same plan short-circuit), each stored under the client's path
    shape and asserted safe before upload. One row per sync, always — the
    blob merge can drop an adopted scan, and a fresh row is the recovery.
    Never touches field_projects. */
export async function syncPlan(
  io: Io, env: MpEnv,
  input: { projectId: string; fieldProjectId: string },
  opts: { linkMode?: boolean; updateRowId?: string } = {},
): Promise<ExportRow> {
  const { projectId, fieldProjectId } = input;

  // 1. ownership
  const p = parseProject(await call(io, `/projects/${encodeURIComponent(projectId)}`));
  const ext = p.externalReferenceId ?? "";
  if (!opts.linkMode && ext !== fieldProjectId) {
    return io.insertRow({
      mp_project_id: projectId, mp_plan_id: p.planId || "", field_project_id: null, status: "unmatched",
      error: `external_reference_id ${ext || "null"} ≠ ${fieldProjectId}`, synced_at: io.now(),
    });
  }
  if (opts.linkMode && ext && ext !== fieldProjectId) {
    throw new MpConflict(`This Magicplan project is linked to job ${ext} — open that job and Pull`);
  }
  const planId = p.planId;

  const write = (row: Partial<ExportRow>) => opts.updateRowId ? io.updateRow(opts.updateRowId, row) : io.insertRow(row);

  try {
    if (!planId) throw new Error("Magicplan project has no plan yet");

    // 2. files + photos
    const prior = indexPrior(await io.priorRows(planId));
    const listed = parsePlanFiles(await call(io, planFilesPath(planId)));
    const over = Math.max(0, listed.photos.length - MAX_PHOTOS);
    const photosWanted = listed.photos.slice(0, MAX_PHOTOS);
    const capNote = over ? `+${over} photos not pulled (cap)` : null;

    /* One object: reuse the prior entry when the pre-download key hits AND the
       prior path is the one this job would build (a prior row of the same plan
       can belong to another job in link mode — its files stay in that job's
       folder); otherwise download, hash, and upload unless the bucket already
       holds these bytes at this path. */
    const fetchOne = async (f: RawFile, name: string): Promise<{ hash: string; path: string; size: number; mime: string }> => {
      const hit = prior.byKey.get(reuseKey(f));
      if (hit && hit.path === mpFilePath(fieldProjectId, hit.hash, name)) return hit;
      if (f.size > MAX_FILE_BYTES) throw new Error(`Magicplan file ${name} is ${mb(f.size)} MB — over the 80 MB limit`);
      const { bytes, contentType } = await io.download(f.url, attachAuth(f.url, env));
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`Magicplan file ${name} is ${mb(bytes.length)} MB — over the 80 MB limit`);
      const hash = await io.sha256(bytes);
      const path = mpFilePath(fieldProjectId, hash, name);
      if (!isMpSitePath(path)) throw new Error("Refusing unsafe storage path");
      const mime = mimeFor(f.file_type, contentType);
      if (!(prior.hashes.has(hash) && prior.paths.has(path))) await io.upload(path, bytes, mime);
      return { hash, path, size: bytes.length, mime };
    };

    const files: FileEntry[] = [];
    for (const f of listed.files) {
      const name = clampName(f.name);
      const got = await fetchOne(f, name);
      files.push({
        path: got.path, name, mime: got.mime, size: got.size, hash: got.hash,
        folder: f.folder, mp_last_modified: f.last_modified, file_type: f.file_type,
      });
    }
    const photos: PhotoEntry[] = [];
    for (const f of photosWanted) {
      const name = clampName(f.name);
      const got = await fetchOne(f, name);
      const { room, floor, caption } = parsePhotoName(f.name);   // re-run on reuse so parser fixes apply
      photos.push({
        path: got.path, name, mime: got.mime, size: got.size, hash: got.hash,
        folder: f.folder, mp_last_modified: f.last_modified, file_type: f.file_type,
        room, floor, caption, symbol_instance_id: f.symbol_instance_id,
      });
    }

    // 3. quantities + floor SVGs
    const statistics = normalizeStatistics(await call(io, planStatisticsPath(planId)));
    const floors = parsePlanFloors(await call(io, projectPlanPath(projectId)));
    const floors_svg: SvgEntry[] = [];
    for (const fl of floors) {
      const svgName = clampName(svgFileName(fl.image));
      const hit = prior.bySvg.get(`${fl.name}|${svgName}`);
      if (hit && hit.path === mpFilePath(fieldProjectId, hit.hash, svgName)) {
        floors_svg.push({ floor: fl.name, path: hit.path, hash: hit.hash, name: svgName, size: hit.size });
        continue;
      }
      const { bytes } = await io.download(fl.image, attachAuth(fl.image, env));
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`Magicplan file ${svgName} is ${mb(bytes.length)} MB — over the 80 MB limit`);
      const hash = await io.sha256(bytes);
      const path = mpFilePath(fieldProjectId, hash, svgName);
      if (!isMpSitePath(path)) throw new Error("Refusing unsafe storage path");
      if (!(prior.hashes.has(hash) && prior.paths.has(path))) await io.upload(path, bytes, "image/svg+xml");
      floors_svg.push({ floor: fl.name, path, hash, name: svgName, size: bytes.length });
    }

    // 4. the row
    return await write({
      mp_project_id: projectId, mp_plan_id: planId, field_project_id: fieldProjectId, status: "ready",
      files, photos, statistics, floors_svg, synced_at: io.now(), error: capNote,
    });
  } catch (e) {
    // 5. a failed row so the phone (and the admin list) can see why; re-thrown for the 502
    const message = e instanceof Error ? e.message : String(e);
    await write({
      mp_project_id: projectId, mp_plan_id: planId || "", field_project_id: fieldProjectId, status: "failed",
      error: message.slice(0, 2000), synced_at: io.now(),
    });
    throw e;
  }
}

/** The last path segment of a floor's `image` url, query stripped. */
export function svgFileName(image: string): string {
  let path = String(image ?? "");
  try { path = new URL(path).pathname; } catch { path = path.split(/[?#]/)[0]; }
  return path.split("/").filter(Boolean).pop() || "floor.svg";
}
