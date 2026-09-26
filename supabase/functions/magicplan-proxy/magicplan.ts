/**
 * Magicplan — the pure half of magicplan-proxy (no Deno, no network of its
 * own; Node-tested under --experimental-strip-types by magicplan.test.mjs).
 *
 * docs/Magicplan_Integration_Design.md is the spec. Response shapes here are
 * the LIVE ones, read from the Cloud API's OpenAPI 3.1.1 document (API v1.2)
 * on 2026-09-25, and where they differ from design §1 the live one wins:
 *   - GET /workspace and GET /plans/statistics/{id} are NOT wrapped in
 *     {data}; every other call used here is.
 *   - GET /projects/{id}/plan puts the floors under data.plan_data.floors.
 *   - GET /projects (the name search) lists no plan_id — the project itself
 *     is read to get it.
 *   - GET /plans/{id}/files carries no content hash, so "already have it" is
 *     judged by name + last_modified + size before downloading, and the
 *     sha256 we compute is the hash from then on.
 * One shape per call. A response that doesn't match throws with the call's
 * name in the message — never a guess across several shapes.
 *
 * runSync() is the whole of design §4.2 with its I/O injected, so the
 * algorithm itself is tested here; index.ts supplies the real fetch, the
 * storage upload and the table. M2's webhook will import the same function.
 */

export const MP_BASE = "https://cloud.magicplan.app/api/v2";

type Json = Record<string, unknown>;
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/* ---------- the same pure helpers as apps/field/js/magicplancalc.js ----------
   Kept in lockstep by magicplan.test.mjs, which runs both on the same inputs. */
const clean = (s: unknown, max: number) => str(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(-max);
export function mpFileId(hash: string) {
  return "mp-" + str(hash).toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
}
export function mpFilePath(projectId: string, hash: string, name: string) {
  const job = clean(projectId, 80) || "job";
  const base = clean(name, 80).replace(/^[._]+/, "") || "file";
  return `sitevisit/${job}/${clean(mpFileId(hash), 60)}-${base}`;
}

export function parsePhotoName(name: unknown) {
  const none = { floor: "", room: "", caption: "" };
  const stem = str(name).replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const parts = stem.split(" - ").map((s) => s.trim());
  if (parts.length < 4 || !/^\d+$/.test(parts[parts.length - 1])) return none;
  const [floor, room, ...rest] = parts;
  const caption = rest.slice(0, -1).join(" - ");
  if (!floor || !room || !caption) return none;
  return { floor, room, caption };
}

const M2_FT2 = 10.764, M_FT = 3.281, M3_FT3 = 35.315;
const r1 = (v: number) => Math.round(v);
const rHalf = (v: number) => Math.round(v * 2) / 2;
export type Room = { name: string; floorSF: number; perimLF: number; ceilingFt: number; wallSF: number; wallSFNet: number; doors: number; windows: number; volumeCF: number; dims: string };
export type Stats = { units: "metric" | "imperial"; floors: Array<{ name: string; rooms: Room[] }> };
export function normalizeStatistics(resp: unknown): Stats {
  const r = (resp && typeof resp === "object" ? resp : {}) as Json;
  const metric = str(r.units).toLowerCase() === "metric";
  const area = (v: unknown) => r1(num(v) * (metric ? M2_FT2 : 1));
  const len = (v: unknown) => rHalf(num(v) * (metric ? M_FT : 1));
  const vol = (v: unknown) => r1(num(v) * (metric ? M3_FT3 : 1));
  const st = (r.statistics && typeof r.statistics === "object" ? r.statistics : {}) as Json;
  const floors = arr<Json>(st.floors).map((f, fi) => ({
    name: str(f && f.name).trim() || `Floor ${fi + 1}`,
    rooms: arr<Json>(f && f.rooms).map((rm, ri) => {
      const height = num(rm && rm.height) || num(f && f.height);
      return {
        name: str(rm && rm.name).trim() || `Room ${ri + 1}`,
        floorSF: area(rm && rm.area_without_walls),
        perimLF: len(rm && rm.ground_perimeter),
        ceilingFt: len(height),
        wallSF: area(rm && rm.walls_surface),
        wallSFNet: area(rm && rm.walls_surface_without_openings),
        doors: num(rm && rm.door_count),
        windows: num(rm && rm.window_count),
        volumeCF: vol(rm && rm.volume),
        dims: str(rm && rm.dimensions),
      };
    }),
  }));
  return { units: metric ? "metric" : "imperial", floors };
}

export function dedupeRoomNames(floors: Stats["floors"]) {
  const flat: Array<{ floor: string; room: Room }> = [];
  for (const f of arr<Stats["floors"][number]>(floors)) for (const rm of arr<Room>(f && f.rooms)) flat.push({ floor: str(f.name), room: rm });
  const floorsOf = new Map<string, Set<string>>();
  for (const x of flat) {
    const k = x.room.name.toLowerCase();
    if (!floorsOf.has(k)) floorsOf.set(k, new Set());
    floorsOf.get(k)!.add(x.floor);
  }
  const seen = new Map<string, number>();
  return flat.map((x) => {
    const k = x.room.name.toLowerCase();
    let label = floorsOf.get(k)!.size > 1 ? `${x.floor} — ${x.room.name}` : x.room.name;
    const n = (seen.get(label.toLowerCase()) || 0) + 1;
    seen.set(label.toLowerCase(), n);
    if (n > 1) label = `${label} ${n}`;
    return { ...x.room, floor: x.floor, label };
  });
}

export function projectName(customer: unknown, street: unknown) {
  return [str(customer).trim(), str(street).trim()].filter(Boolean).join(" — ") || "Site visit";
}

/* The server's own gate on a storage path (roybal-ai-office/sitevisit.ts
   isSitePath, restated so this module has no cross-function import; the
   test asserts the two agree). */
const SAFE_PATH = /^sitevisit\/[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9._-]{1,160}$/;
export const isSitePath = (p: unknown): p is string => typeof p === "string" && SAFE_PATH.test(p) && !p.includes("..");

/* ---------- requests ---------- */
export function mpHeaders(key: string, customer: string, json = false): Record<string, string> {
  return { key, customer, accept: "application/json", ...(json ? { "content-type": "application/json" } : {}) };
}
/** GET /plans/{id}/files query: Report PDF(s) + the photos pinned in the scan. */
export const filesPath = (planId: string) => `/plans/${encodeURIComponent(planId)}/files?format[]=pdf&include_photos=true`;

/** The body of POST /projects. `email` is the MAGICPLAN_PROJECT_EMAIL secret
    (§6 ruling 1), never the caller; the name carries the environment prefix. */
export function createProjectBody(input: { fieldProjectId: string; customer?: string; address?: Json }, email: string, prefix: string) {
  const a = (input.address && typeof input.address === "object" ? input.address : {}) as Json;
  return {
    name: prefix + projectName(input.customer, a.street),
    external_reference_id: input.fieldProjectId,
    email,
    address: {
      street: str(a.street) || null, city: str(a.city) || null,
      postal_code: str(a.postal_code) || null, country: str(a.country) || "US",
    },
  };
}

/* ---------- responses (live shapes) ---------- */
function need(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`Magicplan ${what}: unexpected response shape`);
}
export type MpProject = { id: string; planId: string; externalReferenceId: string; name: string; cloudUrl: string; createdAt: string; userModified: string; archivedAt: string | null };
/** {data: Project} — GET /projects/{id}, POST /projects (201/207), PUT …/archive */
export function projectOf(resp: unknown, what = "project"): MpProject {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  need(d && typeof d === "object" && d.id, what);
  return {
    id: str(d.id), planId: str(d.plan_id), externalReferenceId: str(d.external_reference_id),
    name: str(d.name), cloudUrl: str(d.cloud_url), createdAt: str(d.user_created),
    userModified: str(d.user_modified), archivedAt: d.archived_at ? str(d.archived_at) : null,
  };
}
/** {data: [ProjectListItem], page_info} — GET /projects?name= . Our project is
    the live one whose external_reference_id is the field project id. */
export function findOurs(resp: unknown, fieldProjectId: string) {
  const list = resp && typeof resp === "object" ? (resp as Json).data : null;
  need(Array.isArray(list), "project search");
  const hit = (list as Json[]).find((p) => p && str(p.external_reference_id) === fieldProjectId && !p.archived_at);
  return hit ? str(hit.id) : null;
}
export type MpFile = { name: string; folder: string; url: string; lastModified: string; size: number; fileType: string; symbolInstanceId?: string };
/** {data: {files: [...], photos: [...]}} — GET /plans/{id}/files */
export function filesOf(resp: unknown) {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  need(d && typeof d === "object" && Array.isArray(d.files), "plan files");
  const one = (f: Json): MpFile => ({
    name: str(f.name), folder: str(f.folder), url: str(f.url), lastModified: str(f.last_modified),
    size: num(f.size), fileType: str(f.file_type),
    ...(f.symbol_instance_id != null ? { symbolInstanceId: str(f.symbol_instance_id) } : {}),
  });
  return {
    files: arr<Json>(d.files).filter((f) => f && f.url).map(one),
    photos: arr<Json>(d.photos).filter((f) => f && f.url).map(one),
  };
}
/** {data: {plan_data: {floors: [{name, image}]}}} — GET /projects/{id}/plan */
export function floorImagesOf(resp: unknown) {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  need(d && typeof d === "object", "plan");
  const pd = (d.plan_data && typeof d.plan_data === "object" ? d.plan_data : {}) as Json;
  return arr<Json>(pd.floors).map((f, i) => ({ name: str(f && f.name) || `Floor ${i + 1}`, image: str(f && f.image) })).filter((f) => f.image);
}
/** Unwrapped — GET /plans/statistics/{id} */
export function statisticsOf(resp: unknown) {
  need(resp && typeof resp === "object" && (resp as Json).statistics && typeof (resp as Json).statistics === "object", "statistics");
  return normalizeStatistics(resp);
}
/** Unwrapped — GET /workspace */
export function workspaceOf(resp: unknown) {
  const w = resp && typeof resp === "object" ? resp as Json : null;
  need(w && w.id, "workspace");
  const owner = (w.owner && typeof w.owner === "object" ? w.owner : {}) as Json;
  return {
    id: str(w.id), name: str(w.name), ownerEmail: str(owner.email),
    webhookUrl: w.webhook_url ? str(w.webhook_url) : null, authorizeUrl: w.authorize_url ? str(w.authorize_url) : null,
    listingUrl: w.listing_url ? str(w.listing_url) : null, lastModified: str(w.last_modified),
  };
}
/** {message, data} on a 4xx/5xx → one readable line. */
export function mpErrorText(status: number, body: unknown, what: string) {
  const b = (body && typeof body === "object" ? body : {}) as Json;
  const msg = [str(b.message), typeof b.data === "string" ? b.data : ""].filter(Boolean).join(" — ");
  return `Magicplan ${what} failed (${status})${msg ? ": " + msg.slice(0, 300) : ""}`;
}

/* ---------- 429: one backoff retry, then fail loud ---------- */
export function retryDelayMs(retryAfter: string | null) {
  const s = Number(retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 30) * 1000 : 3000;
}

/* ---------- files ---------- */
const EXT_MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp" };
export function mimeOf(name: string, fileType = "") {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name) || [])[1] || fileType;
  return EXT_MIME[str(ext).toLowerCase()] || "application/octet-stream";
}
/** name + last_modified + size (as Magicplan listed them — kept on the row as
    mp_last_modified / mp_size): the only "same file" signal the live API
    gives before the bytes are fetched. */
export const reuseKey = (name: string, lastModified: string, size: number) => `${name}|${lastModified}|${size}`;

type Stored = { path: string; name: string; mime: string; size: number; hash: string; mp_last_modified: string; mp_size: number };
export type ExportRow = {
  mp_project_id: string; mp_plan_id: string; field_project_id: string | null;
  status: "ready" | "failed" | "unmatched";
  files: Array<Stored & { folder: string }>;
  photos: Array<Stored & { room: string; floor: string; caption: string; symbol_instance_id: string }>;
  statistics: Stats | null;
  floors_svg: Array<Stored & { floor: string }>;
  error: string | null;
  synced_at: string | null;
};

/** What a previous ready|imported row for this plan already stored, by reuseKey. */
export function priorIndex(rows: unknown) {
  const idx = new Map<string, Stored>();
  for (const r of arr<Json>(rows)) {
    for (const f of [...arr<Json>(r && r.files), ...arr<Json>(r && r.photos), ...arr<Json>(r && r.floors_svg)]) {
      if (!f || !f.path || !f.hash) continue;
      idx.set(reuseKey(str(f.name), str(f.mp_last_modified), num(f.mp_size)), {
        path: str(f.path), name: str(f.name), mime: str(f.mime), size: num(f.size), hash: str(f.hash),
        mp_last_modified: str(f.mp_last_modified), mp_size: num(f.mp_size),
      });
    }
  }
  return idx;
}

/* ---------- design §4.2, the sync ---------- */
export type SyncDeps = {
  mp: (path: string) => Promise<unknown>;                       // GET against MP_BASE with our key; throws readable errors
  fetchBytes: (url: string) => Promise<Uint8Array>;             // a Magicplan-hosted file (pre-signed URL)
  sha256: (bytes: Uint8Array) => Promise<string>;               // lowercase hex
  upload: (path: string, bytes: Uint8Array, mime: string) => Promise<void>;  // field-media, service role, upsert
  priorRows: (planId: string) => Promise<unknown[]>;            // ready|imported rows for this plan
  now: () => string;
};

/** Builds the magicplan_exports row for one pull. Never writes field_projects
    (it has no way to: no dependency reaches it). A project whose
    external_reference_id is not this job comes back 'unmatched' with nothing
    downloaded — never imported into the wrong job — unless the office linked
    it by hand (`trustLink`, the Settings panel's Link to job). */
export async function runSync(deps: SyncDeps, input: { projectId: string; fieldProjectId: string; trustLink?: boolean }): Promise<ExportRow> {
  const job = str(input.fieldProjectId);
  const project = projectOf(await deps.mp(`/projects/${encodeURIComponent(input.projectId)}`), "project");
  const base: ExportRow = {
    mp_project_id: project.id, mp_plan_id: project.planId, field_project_id: job || null, status: "ready",
    files: [], photos: [], statistics: null, floors_svg: [], error: null, synced_at: null,
  };
  if (!input.trustLink && project.externalReferenceId !== job) {
    return { ...base, field_project_id: null, status: "unmatched",
      error: `Magicplan project ${project.id} belongs to ${project.externalReferenceId || "no job"}, not ${job}` };
  }
  need(project.planId, "project (no plan_id)");

  const prior = priorIndex(await deps.priorRows(project.planId));
  const jobDir = mpFilePath(job, "", "x").replace(/[^/]+$/, "");   // "sitevisit/<job>/"
  const store = async (f: MpFile, name: string) => {
    // same name, timestamp and size as a file we already hold FOR THIS JOB:
    // no download (a scan relinked to another job gets its own copies)
    const hit = prior.get(reuseKey(f.name, f.lastModified, f.size));
    if (hit && hit.path.startsWith(jobDir)) return hit;
    const bytes = await deps.fetchBytes(f.url);
    const hash = await deps.sha256(bytes);
    const path = mpFilePath(job, hash, name);
    if (!isSitePath(path)) throw new Error(`Refusing to store ${name}: ${path} is not a site-visit path`);
    const mime = mimeOf(name, f.fileType);
    await deps.upload(path, bytes, mime);
    return { path, name: f.name, mime, size: bytes.byteLength || f.size, hash, mp_last_modified: f.lastModified, mp_size: f.size };
  };

  const { files, photos } = filesOf(await deps.mp(filesPath(project.planId)));
  for (const f of files) {
    const s = await store(f, f.name || "Magicplan report.pdf");
    base.files.push({ ...s, folder: f.folder });
  }
  for (const f of photos) {
    const s = await store(f, f.name || "photo.jpg");
    const { floor, room, caption } = parsePhotoName(f.name);
    base.photos.push({ ...s, room, floor, caption, symbol_instance_id: f.symbolInstanceId || "" });
  }

  base.statistics = statisticsOf(await deps.mp(`/plans/statistics/${encodeURIComponent(project.planId)}`));

  for (const fl of floorImagesOf(await deps.mp(`/projects/${encodeURIComponent(project.id)}/plan`))) {
    const s = await store({ name: `${fl.name}.svg`, folder: "floor", url: fl.image, lastModified: project.userModified, size: 0, fileType: "svg" }, `${fl.name}.svg`);
    base.floors_svg.push({ ...s, floor: fl.name });
  }

  base.synced_at = deps.now();
  return base;
}
