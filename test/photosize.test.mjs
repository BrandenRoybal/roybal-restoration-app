/* Job Photos gallery — a cloud-offloaded photo must come back at real quality.
   Since the Aug 2026 offload nearly every photo keeps only a 480px preview
   inline (ph.src) with the original in the field-media bucket (ph.cloud).
   The gallery, the printed Photo Report and the packet share all read the
   card's <img>, so applySize (forms.js) has to fetch the original and
   re-encode it to the chosen size tier — behind an offline gate that has to
   be a real, imported function. Deployed v173 shipped
   `p.cloud && !likelyOffline()` with likelyOffline never imported: the
   preview landed, the ReferenceError aborted the rest, and every cloud photo
   stayed at 480px everywhere (864 exceptions on one packet page, 2026-09-11).
   The smoke test never saw it because its fixture photos carry no `cloud`,
   so the `&&` never reached the missing name.
   Run: node test/photosize.test.mjs */
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";
import { MEDIA_MIN } from "../js/media.js";

const dom = new JSDOM("<!DOCTYPE html><body><div id=\"toast\" hidden></div></body>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["document", "window", "location", "HTMLElement", "Node", "Event", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
/* the device's own network belief — likelyOffline() (core.js) reads
   navigator.onLine and only trusts a FALSE when nothing has succeeded lately */
let onLine = true;
Object.defineProperty(globalThis, "navigator", {   // Node ships its own getter-only navigator
  value: new Proxy(window.navigator, { get: (t, k) => (k === "onLine" ? onLine : Reflect.get(t, k, t)) }),
  configurable: true, writable: true,
});
globalThis.confirm = () => true;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.localStorage.setItem("roybal-offline", "1");

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/* The production failure was an unhandled rejection out of the
   fire-and-forget applySize() call — report it as a red line with the
   message instead of letting it kill the process mid-run. */
process.on("unhandledRejection", (e) => ok(false, "gallery threw: " + (e && e.message || e)));

/* shrinkDataURL (core.js) re-encodes through an Image load and a 2d canvas,
   neither of which jsdom has. The Image stub records every source it was
   asked to load, so a test can tell "re-encoded the original" from
   "re-encoded the preview". */
const PREVIEW = "data:image/jpeg;base64,PREVIEW480";
const FULL = "data:image/jpeg;base64," + "ORIGINAL".repeat(8);
const SHRUNK = "data:image/jpeg;base64,SHRUNK";
const HASH = "a".repeat(64);
const shrunk = [];
globalThis.Image = class {
  constructor() { this.width = 1600; this.height = 1200; }
  set src(v) { this._src = v; shrunk.push(v); setTimeout(() => this.onload && this.onload(), 0); }
  get src() { return this._src; }
};
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.toDataURL = () => SHRUNK;

/* fake field-media bucket: the original lives under its hash */
let bucketGets = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const resp = (status, text = "") => ({ ok: status < 400, status, text: async () => text, json: async () => ({}) });
  if (u.pathname === `/storage/v1/object/field-media/${HASH}` && (opts.method || "GET") === "GET") { bucketGets++; return resp(200, FULL); }
  return resp(404);
};

const { photosForm } = await import("../js/forms.js");

const cloudPhoto = () => ({ id: "c1", src: PREVIEW, cloud: HASH, caption: "Cloud shot", room: "Kitchen", stage: "during", ts: "2026-08-01T10:00:00Z" });
const inlinePhoto = () => ({ id: "i1", src: "data:image/jpeg;base64,INLINE", caption: "Inline shot", room: "Hall", stage: "after", ts: "2026-08-02T10:00:00Z" });
const render = (project) => { const el = photosForm(project); document.body.append(el); return el; };
const imgFor = (el, caption) => el.querySelector(`.photocard__img[alt="${caption}"]`);
const toastText = () => document.getElementById("toast").textContent;

// ---------- 1. Standard tier: the fetched original replaces the preview ----------
{
  const project = { id: "j1", customer: "Tier Full", photos: [cloudPhoto(), inlinePhoto()], photoSize: "full" };
  const el = render(project);
  const img = imgFor(el, "Cloud shot");
  ok(!!img, "a cloud-offloaded photo renders a gallery card");
  ok(img.getAttribute("src") === PREVIEW, "the inline preview shows immediately");
  await tick();
  ok(bucketGets === 1, "the original is fetched from the field-media bucket by hash");
  ok(img.getAttribute("src") === FULL, "…and replaces the preview once it lands (Standard tier shows the original itself)");
  ok(imgFor(el, "Inline shot").getAttribute("src") === "data:image/jpeg;base64,INLINE", "an inline-only photo keeps its own src");
  el.remove();
}

// ---------- 2. Default tier (medium): re-encoded FROM THE ORIGINAL, never from the preview ----------
{
  shrunk.length = 0; bucketGets = 0;
  const project = { id: "j2", customer: "Tier Default", photos: [cloudPhoto()] };   // photoSize unset → the app default
  const el = render(project);
  const img = imgFor(el, "Cloud shot");
  await tick();
  ok(project.photoSize === "medium", "an unset size tier defaults to medium");
  ok(shrunk.includes(FULL), "the medium tier is re-encoded from the fetched original");
  ok(!shrunk.includes(PREVIEW), "the 480px preview is never what gets re-encoded");
  ok(img.getAttribute("src") === SHRUNK, "the card shows the re-encoded original, not the preview");
  el.remove();
}

// ---------- 3. Offline: keep the preview, stay off the network — and the other gate toasts instead of throwing ----------
{
  onLine = false; bucketGets = 0;
  const big = { id: "b1", src: "data:image/jpeg;base64," + "X".repeat(MEDIA_MIN + 100), caption: "Big inline", stage: "during", ts: "2026-08-03T10:00:00Z" };
  const project = { id: "j3", customer: "Offline", photos: [cloudPhoto(), big], photoSize: "full" };
  const el = render(project);
  const img = imgFor(el, "Cloud shot");
  await tick();
  ok(bucketGets === 0, "offline (flag down, no recent network proof) never hits the bucket");
  ok(img.getAttribute("src") === PREVIEW, "…and the card keeps its preview instead of going blank");
  const moveBtn = [...el.querySelectorAll("button")].find((b) => /Move photos to cloud/.test(b.textContent));
  ok(!!moveBtn, "the gallery offers ☁ Move photos to cloud");
  moveBtn.click();
  await tick();
  ok(/needs internet/.test(toastText()), "offline, moving photos toasts 'needs internet' instead of throwing");
  el.remove();
  onLine = true;
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PHOTO-SIZE CHECKS PASSED");
process.exit(failures ? 1 : 0);
