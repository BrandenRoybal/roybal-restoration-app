/**
 * Magicplan — the pure half of magicplan-proxy (no Deno, no network of its
 * own; Node-tested under --experimental-strip-types by magicplan.test.mjs).
 *
 * docs/Magicplan_Integration_Design.md is the spec. Response shapes here are
 * the LIVE ones, read from the Cloud API's OpenAPI 3.1.1 document (API v1.2)
 * on 2026-09-25, and where they differ from design §1 the live one wins:
 *   - GET /workspace is NOT wrapped in {data}; every other call used here
 *     is, GET /plans/statistics/{id} included (seen live 2026-10-01, which
 *     also showed it carries plan totals only: rooms come from the plan).
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
/** Every export format the API accepts — the list is Magicplan's own,
    copied from its 400 reply on 10/1 ("Please use the following formats:
    …"): the Report PDF, drawings (svg/png/jpg/dxf), the 3D model (usdz,
    ifc), Magicplan's plan files (fml, xml) and the
    spreadsheets (xls, csv). A format only comes back once it has been
    exported in the app or by the workspace's export configuration.
    Asked ONE FORMAT PER CALL: the live API refuses several format[] values
    in one request (10/1 18:00, "Value [...] for argument format is
    invalid"), while a single format[]=pdf has always worked. obj, xfif and
    magicplan are left out: that 400 reply lists them, but the files call
    itself refuses each one alone (10/1 18:06). */
export const ALL_FORMATS = ["pdf", "jpg", "svg", "png", "usdz", "xls", "csv", "ifc", "dxf", "fml", "xml"];
export const filesPath = (planId: string, format: string) =>
  `/plans/${encodeURIComponent(planId)}/files?format[]=${encodeURIComponent(format)}&include_photos=true`;

/** The body of POST /projects. `email` is the MAGICPLAN_PROJECT_EMAIL secret
    (§6 ruling 1), never the caller; the name carries the environment prefix. */
export function createProjectBody(input: { fieldProjectId: string; customer?: string; address?: Json }, email: string, prefix: string) {
  const a = (input.address && typeof input.address === "object" ? input.address : {}) as Json;
  return {
    name: prefix + projectName(input.customer, a.street),
    external_reference_id: input.fieldProjectId,
    email: String(email ?? "").trim(),
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
/** Every room's own drawing — data.plan_data.floors[].rooms[].image (design §1). */
export function roomImagesOf(resp: unknown) {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  need(d && typeof d === "object", "plan");
  const pd = (d.plan_data && typeof d.plan_data === "object" ? d.plan_data : {}) as Json;
  const out: Array<{ floor: string; room: string; image: string }> = [];
  arr<Json>(pd.floors).forEach((f, fi) => {
    arr<Json>(f && f.rooms).forEach((rm, ri) => {
      const image = str(rm && rm.image);
      if (image) out.push({ floor: str(f && f.name) || `Floor ${fi + 1}`, room: str(rm && rm.name) || `Room ${ri + 1}`, image });
    });
  });
  return out;
}
/** {data: [ProjectFile]} — GET /projects/{id}/files, the files attached to
    the project (not yet seen live: an item without a URL is skipped, and a
    response that isn't a list says so with its key outline). */
export function projectFilesOf(resp: unknown): MpFile[] {
  const d = resp && typeof resp === "object" ? (resp as Json).data : null;
  const list = Array.isArray(d) ? d : null;
  if (!list) throw new Error(`Magicplan project files: unexpected response shape ${shapeOutline(resp)}`.slice(0, 900));
  return (list as Json[]).filter((f) => f && typeof f === "object").map((f) => {
    const file = (f.file && typeof f.file === "object" ? f.file : {}) as Json;
    return {
      name: str(f.name || f.filename || file.name), folder: str(f.folder), url: str(f.url || file.url),
      lastModified: str(f.last_modified || f.updated_at || f.created_at), size: num(f.size || file.size),
      fileType: str(f.file_type || f.filetype),
    };
  }).filter((f) => f.url);
}
/** One file's identity across listings and pages: the signed url changes
    from call to call, the name, size and timestamp don't. The plan listing
    and the project listing give the same export the same name and size. */
export const fileKey = (f: { name: string; size: number }) => `${f.name}|${f.size}`;
export const PROJECT_FILES_PAGES = 20;
export const projectFilesPath = (projectId: string, page: number) =>
  `/projects/${encodeURIComponent(projectId)}/files${page > 1 ? `?page=${page}` : ""}`;
const listLength = (resp: unknown) => {
  const d = resp && typeof resp === "object" ? (resp as Json).data : null;
  return Array.isArray(d) ? d.length : 0;
};
/** Is there a page after `page`? Read from a list response's page_info
    (GET /projects answers {data, page_info}), whichever of the usual
    spellings it uses; null when it doesn't say. */
export function moreAfter(resp: unknown, page: number): boolean | null {
  const r = resp && typeof resp === "object" ? resp as Json : null;
  const pi = r ? (r.page_info ?? r.pagination ?? r.meta) : null;
  if (!pi || typeof pi !== "object") return null;
  const p = pi as Json;
  for (const k of ["has_next_page", "hasNextPage", "has_more", "has_next"]) if (typeof p[k] === "boolean") return p[k] as boolean;
  if ("next_page" in p) return p.next_page != null && p.next_page !== false && p.next_page !== "";
  if ("next_page_url" in p) return !!p.next_page_url;
  const cur = num(p.current_page ?? p.page) || page;
  const last = num(p.last_page ?? p.total_pages ?? p.page_count);
  if (last) return cur < last;
  const total = num(p.total ?? p.total_count), per = num(p.per_page ?? p.page_size ?? p.limit);
  if (total && per) return cur * per < total;
  return null;
}
/** The keys of a response, two levels deep, with no values: what the logs
    carry when a shape surprises us, so the next fix reads the live shape
    instead of guessing it. Never a value — no addresses, no URLs, no key. */
export function shapeOutline(v: unknown, depth = 2): string {
  if (Array.isArray(v)) return v.length ? `[${shapeOutline(v[0], depth)}]` : "[]";
  if (!v || typeof v !== "object") return v === null ? "null" : typeof v;
  const keys = Object.keys(v as Json).slice(0, 20);
  if (depth <= 0) return `{${keys.join(",")}}`;
  return `{${keys.map((k) => `${k}:${shapeOutline((v as Json)[k], depth - 1)}`).join(",")}}`;
}
/** The units of a plan, from GET /plans/statistics/{id}. LIVE shape
    (first production pull, 2026-10-01): {data: {id, project_id, units,
    project_statistics: {…whole-plan totals…}}} — wrapped in data, and no
    per-room figures at all. Only `units` is read here; the rooms come from
    the plan (statsFromPlan). An unknown unit name throws rather than guess
    feet vs metres. */
export function planUnitsOf(resp: unknown): "metric" | "imperial" {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  if (!(d && typeof d === "object" && typeof d.units === "string")) {
    throw new Error(`Magicplan statistics: unexpected response shape ${shapeOutline(resp)}`.slice(0, 900));
  }
  const u = str(d.units).trim().toLowerCase();
  if (/^(metric|meters?|metres?|m)$/.test(u)) return "metric";
  if (/^(imperial|feet|foot|ft)$/.test(u)) return "imperial";
  throw new Error(`Magicplan statistics: unknown units "${u.slice(0, 20)}"`);
}
/** Per-room measurements from GET /projects/{id}/plan: each room carries a
    `statistics` object (Magicplan changelog 2026-03-16: statistics under the
    Plan, Floor and Room objects) with the same field names the old
    statistics endpoint used. Normalized through normalizeStatistics so the
    unit conversion and rounding stay the one tested path. A plan with
    floors but no readable room figures throws with the room's key outline
    (keys only), so the next fix reads the live shape. */
const METRIC_KEYS: Record<string, number> = {
  area: M2_FT2, area_without_walls: M2_FT2, walls_surface: M2_FT2, walls_surface_without_openings: M2_FT2,
  perimeter: M_FT, ground_perimeter: M_FT, height: M_FT, volume: M3_FT3,
};
/** Which units the plan's room figures are in. The first live pull (10/1
    18:00, a 12 x 12 ft bedroom on an imperial project) gave floor 14,
    perimeter 13.5, walls 37, volume 35: square metres and metres, though
    the statistics call says "imperial". So compare against the
    statistics call's own plan totals: rooms summing to about a tenth of
    the stated floor area are metric, and are converted to feet. And a
    physical check that needs no totals: on an imperial project, rooms
    whose walls average 1.8 to 4.5 high (wall area / perimeter) are in
    metres, since no room has a 4 ft ceiling. */
export function roomScale(fl: Json[], totals: unknown, units: "metric" | "imperial" = "imperial"): "same" | "metric-in-imperial" {
  if (units !== "imperial") return "same";
  const t = totals && typeof totals === "object" ? totals as Json : null;
  const stated = num(t && (t.area_without_walls ?? t.area));
  let sum = 0, wall = 0, perim = 0;
  for (const f of fl) for (const rm of arr<Json>(f && f.rooms)) {
    const st = rm && typeof rm === "object" && rm.statistics && typeof rm.statistics === "object" ? rm.statistics as Json : null;
    sum += num(st && st.area_without_walls);
    wall += num(st && st.walls_surface);
    perim += num(st && st.ground_perimeter);
  }
  if (stated && sum) {
    const ratio = stated / sum;
    if (ratio > 7 && ratio < 16) return "metric-in-imperial";
    if (ratio > 0.7 && ratio < 1.4) {
      const h = perim ? wall / perim : 0;
      return h >= 1.8 && h <= 4.5 ? "metric-in-imperial" : "same";
    }
    return "same";
  }
  const h = perim ? wall / perim : 0;
  return h >= 1.8 && h <= 4.5 ? "metric-in-imperial" : "same";
}
/** The units and whole-plan totals from GET /plans/statistics/{id}. */
export function planTotalsOf(resp: unknown): Json | null {
  const d = resp && typeof resp === "object" ? (resp as Json).data as Json : null;
  const t = d && typeof d === "object" ? d.project_statistics : null;
  return t && typeof t === "object" ? t as Json : null;
}
export function statsFromPlan(planResp: unknown, units: "metric" | "imperial", statsTotals: unknown = null): Stats {
  const d = planResp && typeof planResp === "object" ? (planResp as Json).data as Json : null;
  need(d && typeof d === "object", "plan");
  const pd = (d.plan_data && typeof d.plan_data === "object" ? d.plan_data : {}) as Json;
  const fl = arr<Json>(pd.floors).filter((f) => f && typeof f === "object");
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : null);
  let rooms = 0, measured = 0;
  const scale = roomScale(fl, statsTotals, units);
  const floors = fl.map((f) => {
    const fs = obj(f.statistics) || {};
    return {
      name: str(f.name), height: fs.height ?? f.height,
      rooms: arr<Json>(f.rooms).filter((rm) => rm && typeof rm === "object").map((rm) => {
        rooms++;
        const st = obj(rm.statistics);
        if (st) measured++;
        const x: Json = { ...(st || {}) };
        // no room height on the live plan: the ceiling is volume / floor area
        if (!num(x.height) && num(x.volume) && num(x.area_without_walls)) x.height = num(x.volume) / num(x.area_without_walls);
        if (scale === "metric-in-imperial") for (const [k, v] of Object.entries(METRIC_KEYS)) if (x[k] != null) x[k] = num(x[k]) * v;
        return { ...x, name: str(rm.name) || str(st && st.name) };
      }),
    };
  });
  if (rooms && !measured) {
    const r0 = arr<Json>(fl.find((f) => arr(f.rooms).length)?.rooms)[0];
    throw new Error(`Magicplan plan rooms: no statistics on rooms ${shapeOutline(r0, 2)}`.slice(0, 900));
  }
  const out = normalizeStatistics({ units, statistics: { floors } });
  // statistics present but none of the names we read: say which names it has
  if (measured && out.floors.every((f) => f.rooms.every((r) => !r.floorSF && !r.perimLF && !r.wallSF))) {
    const st0 = floors.flatMap((f) => f.rooms).find((r) => Object.keys(r).length > 1);
    throw new Error(`Magicplan plan rooms: no measurements we read in room statistics ${shapeOutline(st0, 1)}`.slice(0, 900));
  }
  return out;
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
/** POST /plans/{id}/custom-export → {data: ProjectFile[]}; the one file the
    workspace's export configuration generated as an Xactimate ESX sketch
    (generated_by "ExportConfig.XactimateEsx"), or null when the
    configuration has no ESX in it — the M3 feature check. The whole call is
    idle in that case: nothing is stored, nothing is reported. */
export const ESX_GENERATED_BY = "ExportConfig.XactimateEsx";
export type EsxFile = { filename: string; mime: string; url: string; hash: string; size: number };
export function esxOf(resp: unknown): { esx: EsxFile | null; files: number } {
  const d = resp && typeof resp === "object" ? (resp as Json).data : null;
  const list = arr<Json>(d).filter((f) => f && typeof f === "object");
  const hit = list.find((f) => str(f.generated_by) === ESX_GENERATED_BY);
  if (!hit) return { esx: null, files: list.length };
  const file = (hit.file && typeof hit.file === "object" ? hit.file : {}) as Json;
  const url = str(file.url);
  if (!url) return { esx: null, files: list.length };
  const filename = str(hit.filename) || "sketch.esx";
  return {
    esx: { filename, mime: /^[a-z]+\/[\w.+-]+$/i.test(str(hit.filetype)) ? str(hit.filetype) : "application/octet-stream", url, hash: str(file.hash), size: num(file.size) },
    files: list.length,
  };
}

/** A 4xx/5xx body → one readable line. The documented 400 is
    {message, data: {errors}}, but the first live one (POST /projects,
    2026-09-30) came back with none of the text we read, so the owner saw a
    bare "(400)". Read every place Magicplan documents a reason, and when none
    matches, show the body itself: it is Magicplan's reply, never our key. */
const reasonText = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "";
export function mpErrorText(status: number, body: unknown, what: string) {
  const b = (body && typeof body === "object" ? body : {}) as Json;
  const d = (b.data && typeof b.data === "object" && !Array.isArray(b.data) ? b.data : {}) as Json;
  const parts = [str(b.message), typeof b.data === "string" ? b.data : "", reasonText(d.errors), str(d.message),
    reasonText(b.errors), reasonText(b.error)].filter(Boolean);
  const msg = [...new Set(parts)].join(" — ") || (body == null ? "" : reasonText(body));
  return `Magicplan ${what} failed (${status})${msg ? ": " + msg.slice(0, 300) : ""}`;
}

/* ---------- 429: one backoff retry, then fail loud ---------- */
export function retryDelayMs(retryAfter: string | null) {
  const s = Number(retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(s, 30) * 1000 : 3000;
}

/* ---------- files ---------- */
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  heic: "image/heic", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  usdz: "model/vnd.usdz+zip", ifc: "application/x-step", dxf: "image/vnd.dxf",
  csv: "text/csv", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml", json: "application/json", txt: "text/plain",
};
/** What a Magicplan file is, for the Site Visit panel: only a PDF is a
    report the estimate draft reads; the rest are kept and listed. */
export type MpKind = "report" | "model3d" | "drawing" | "video" | "data" | "room" | "photo";
export function kindOf(name: string, fileType = ""): MpKind {
  const ext = str((/\.([A-Za-z0-9]+)$/.exec(name) || [])[1] || fileType).toLowerCase();
  if (ext === "pdf") return "report";
  if (ext === "usdz" || ext === "ifc" || ext === "obj" || ext === "glb") return "model3d";
  if (["mp4", "mov", "m4v"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "heic", "webp"].includes(ext)) return "photo";
  if (["svg", "dxf"].includes(ext)) return "drawing";
  return "data";
}
/** The largest single file a pull copies. The edge worker holds a file in
    memory while it hashes and stores it, so bigger ones are listed on the
    row as skipped instead of crashing the pull. */
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
/** Stop starting downloads with this much of the worker's time left; the
    row is written with what landed, and the next ⟳ Pull skips those and
    fetches the rest. */
export const STOP_WITH_MS_LEFT = 60_000;
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
  files: Array<Stored & { folder: string; kind?: MpKind; room?: string; floor?: string }>;
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
  warn?: (message: string) => void;                             // the function log
  timeLeft?: () => number;                                      // ms the worker has left (absent: no limit)
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

  const note = (what: string, e: unknown) => {
    const line = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    base.error = [base.error, line].filter(Boolean).join(" · ").slice(0, 1000);
    deps.warn?.(line);
  };
  // Every download goes through here: too big → listed as skipped; out of
  // time → stop, the next Pull picks up where this one ended.
  let outOfTime = false;
  const skipped: string[] = [];
  const fetchOne = async (f: MpFile, name: string) => {
    if (outOfTime) return null;
    if (deps.timeLeft && deps.timeLeft() < STOP_WITH_MS_LEFT) { outOfTime = true; return null; }
    if (f.size > MAX_FILE_BYTES) { skipped.push(`${f.name} (${Math.round(f.size / 1048576)} MB)`); return null; }
    return await store(f, name);
  };
  const storeJson = async (name: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
    const hash = await deps.sha256(bytes);
    const path = mpFilePath(job, hash, name);
    if (!isSitePath(path)) throw new Error(`Refusing to store ${name}: ${path} is not a site-visit path`);
    const hit = prior.get(reuseKey(name, project.userModified, bytes.byteLength));
    if (hit && hit.path === path) return hit;   // unchanged since the last pull
    await deps.upload(path, bytes, "application/json");
    return { path, name, mime: "application/json", size: bytes.byteLength, hash, mp_last_modified: project.userModified, mp_size: bytes.byteLength };
  };

  // 1. Every exported file and every pinned photo (videos included, when
  //    Magicplan lists them with the photos)
  const files: MpFile[] = [], photos: MpFile[] = [];
  const seenFile = new Set<string>(), refused: string[] = [];
  let firstErr: unknown = null;
  for (const fmt of ALL_FORMATS) {
    try {
      const got = filesOf(await deps.mp(filesPath(project.planId, fmt)));
      for (const f of got.files) if (!seenFile.has(f.url)) { seenFile.add(f.url); files.push(f); }
      for (const f of got.photos) if (!seenFile.has(f.url)) { seenFile.add(f.url); photos.push(f); }
    } catch (e) { refused.push(fmt); firstErr ??= e; }
  }
  if (refused.length === ALL_FORMATS.length) note("Exported files and photos not imported", firstErr);
  else if (refused.length) note(`Magicplan refused these formats: ${refused.join(", ")}`, firstErr);
  for (const f of files) {
    const s = await fetchOne(f, f.name || "Magicplan file");
    if (s) base.files.push({ ...s, folder: f.folder, kind: kindOf(f.name, f.fileType) });
  }
  for (const f of photos) {
    const s = await fetchOne(f, f.name || "photo.jpg");
    if (!s) continue;
    const { floor, room, caption } = parsePhotoName(f.name);
    if (kindOf(f.name, f.fileType) === "video") base.files.push({ ...s, folder: f.folder, kind: "video", room, floor });
    else base.photos.push({ ...s, room, floor, caption, symbol_instance_id: f.symbolInstanceId || "" });
  }

  // 2. Files attached to the project itself (videos, documents), page by
  //    page: on 10/1 18:13 the listing held exactly 10 and the two oldest (a
  //    video and the plan thumbnail) dropped off once the exports joined it.
  //    The exports are listed here too; one the plan listing already brought
  //    in (same name and size) is not copied a second time.
  const fromPlan = new Set([...files, ...photos].map(fileKey));
  const seenProj = new Set<string>();
  let fullPage = 0;
  for (let page = 1; page <= PROJECT_FILES_PAGES; page++) {
    let resp: unknown, list: MpFile[];
    try {
      resp = await deps.mp(projectFilesPath(project.id, page));
      list = projectFilesOf(resp);
    } catch (e) {
      note(page === 1 ? "Project attachments not imported" : `Project attachments after page ${page - 1} not imported`, e);
      break;
    }
    const fresh = list.filter((f) => !seenProj.has(fileKey(f)));
    if (!fresh.length) break;          // the end, or a server that ignores ?page=
    for (const f of fresh) {
      if (seenProj.has(fileKey(f))) continue;
      seenProj.add(fileKey(f));
      if (fromPlan.has(fileKey(f))) continue;
      const s = await fetchOne(f, f.name || "attachment");
      if (s) base.files.push({ ...s, folder: f.folder || "Project files", kind: kindOf(f.name, f.fileType) });
    }
    const listed = listLength(resp);
    if (page === 1) fullPage = listed;
    const more = moreAfter(resp, page);
    if (more === false) break;
    // page_info silent: ask again only while pages come back full
    if (more === null && !(fullPage >= 10 && listed >= fullPage)) break;
    if (page === PROJECT_FILES_PAGES) note("Project attachments", new Error(`stopped after ${PROJECT_FILES_PAGES} pages`));
  }

  // 3. The plan: floor drawings, every room's own drawing, room measurements
  let plan: unknown = null;
  try { plan = await deps.mp(`/projects/${encodeURIComponent(project.id)}/plan`); } catch (e) { note("Floor plan not read", e); }
  let statsResp: unknown = null;
  if (plan) {
    try {
      statsResp = await deps.mp(`/plans/statistics/${encodeURIComponent(project.planId)}`);
      base.statistics = statsFromPlan(plan, planUnitsOf(statsResp), planTotalsOf(statsResp));
    } catch (e) { note("Room measurements not imported", e); }

    try {
      for (const fl of floorImagesOf(plan)) {
        const s = await fetchOne({ name: `${fl.name}.svg`, folder: "floor", url: fl.image, lastModified: project.userModified, size: 0, fileType: "svg" }, `${fl.name}.svg`);
        if (s) base.floors_svg.push({ ...s, floor: fl.name });
      }
      for (const rm of roomImagesOf(plan)) {
        const label = `${rm.floor} - ${rm.room}.svg`;
        const s = await fetchOne({ name: label, folder: "Room plans", url: rm.image, lastModified: project.userModified, size: 0, fileType: "svg" }, label);
        if (s) base.files.push({ ...s, folder: "Room plans", kind: "room", room: rm.room, floor: rm.floor });
      }
    } catch (e) { note("Floor plan images not imported", e); }
  }

  // 4. Everything Magicplan knows as data, kept whole: the plan with every
  //    room's geometry and statistics, the full statistics, and the forms
  //    filled in on the job (descriptions, notes, per-room answers). Saved as
  //    JSON exactly as Magicplan sent it, so nothing is lost to our reading.
  const keep: Array<[string, () => Promise<unknown>]> = [
    ["Magicplan plan.json", async () => plan],
    ["Magicplan statistics.json", async () => statsResp],
    ["Magicplan forms.json", () => deps.mp(`/plans/forms/${encodeURIComponent(project.planId)}`)],
    ["Magicplan project.json", () => deps.mp(`/plans/get/${encodeURIComponent(project.planId)}`)],
  ];
  for (const [name, get] of keep) {
    try {
      const v = await get();
      if (v == null) continue;
      base.files.push({ ...(await storeJson(name, v)), folder: "Magicplan data", kind: "data" });
    } catch (e) { note(`${name} not saved`, e); }
  }

  if (skipped.length) note("Too large to copy", new Error(skipped.join(", ")));
  if (outOfTime) note("Stopped early", new Error("ran out of time — press ⟳ Pull again for the rest"));
  base.synced_at = deps.now();
  return base;
}
