/* Insurance photo link test — the pure share builders plus the full publish
   path against a fake Supabase (media bucket + photo_shares upsert).
   Run: node test/photoshare.test.mjs */
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM("<!DOCTYPE html><body><div id=\"toast\" hidden></div></body>", { url: "http://localhost/" });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "HTMLElement", "Node", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}
globalThis.confirm = () => true;

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

/* signed-in session BEFORE supa.js loads (it reads localStorage at import) */
window.localStorage.setItem("roybal-session", JSON.stringify({
  access_token: "tok", refresh_token: "ref", expires_at: Date.now() + 3600_000, email: "crew@test",
}));

/* ---- fake Supabase: field-media bucket + photo_shares table ---- */
const mediaStore = new Map();
const shareRows = new Map();
let uploads = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || "GET").toUpperCase();
  const resp = (status, body = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.pathname.startsWith("/storage/v1/object/field-media/")) {
    const hash = u.pathname.split("/").pop();
    if (method === "POST" || method === "PUT") { uploads++; mediaStore.set(hash, opts.body); return resp(200); }
    return mediaStore.has(hash) ? resp(200) : resp(404);   // HEAD existence check
  }
  if (u.pathname === "/rest/v1/photo_shares" && method === "POST") {
    for (const row of JSON.parse(opts.body)) shareRows.set(row.id, row);
    return resp(201, []);
  }
  if (u.pathname.startsWith("/rest/v1/photo_shares") && method === "PATCH") {
    const id = (u.search.match(/id=eq\.([^&]+)/) || [])[1];
    const row = shareRows.get(id);
    if (row) Object.assign(row, JSON.parse(opts.body));
    return resp(204);
  }
  return resp(404);
};

const { collectSharePhotos, buildSharePhotos, publishPhotoShare, setPhotoShareEnabled, photoShareLink,
  snapshotSheets, dehydrateImages, publishPacketShare } = await import("../js/photoshare.js");
const { sha256Hex } = await import("../js/media.js");

/* ---- 1. collectSharePhotos ---- */
{
  const project = {
    photos: [
      { src: "data:image/jpeg;base64,AAA", caption: "north wall", room: "Kitchen", stage: "before" },
      { src: "data:image/jpeg;base64,thumb", cloud: "ab".repeat(32), caption: "", room: "", stage: "after" },
    ],
    contents: [
      { name: "Sofa", qty: "1", room: "Living Room", photos: ["data:image/jpeg;base64,BBB", "data:image/jpeg;base64,CCC"] },
      { name: "Lamps", qty: "2", room: "Den", photos: ["data:image/jpeg;base64,DDD"] },
      { name: "No photos", qty: "1", photos: [] },
    ],
  };
  const log = collectSharePhotos(project, "photos");
  ok(log.length === 2, "photo-log share covers every gallery photo");
  ok(log[0].caption === "north wall" && log[0].room === "Kitchen" && log[0].stage === "before", "log photo keeps caption/room/stage");
  ok(log[1].cloud === "ab".repeat(32), "cloud-moved photo carries its bucket hash");
  const cont = collectSharePhotos(project, "contents");
  ok(cont.length === 3, "contents share covers every item photo (multi-photo items included)");
  ok(cont[0].item === "Sofa" && cont[1].item === "Sofa", "each contents photo is labeled with its item");
  ok(cont[2].item === "2× Lamps", "quantity > 1 shows in the item label");
  ok(cont[0].room === "Living Room", "contents photo carries the item's room");
}

/* ---- 2. buildSharePhotos hash resolution ---- */
{
  const inline = "data:image/jpeg;base64,INLINEPHOTO";
  const inlineHash = await sha256Hex(inline);
  const marker = `media:${"cd".repeat(32)}:12345`;
  const ensured = [];
  const { rows, skipped } = await buildSharePhotos([
    { cloud: "ab".repeat(32), src: "data:image/jpeg;base64,thumb", caption: "c1" },
    { src: marker, caption: "c2" },
    { src: inline, caption: "c3" },
    { src: "", caption: "empty" },
  ], async (hash, src) => ensured.push({ hash, src }));
  ok(rows.length === 3 && skipped === 1, "unreachable photo is skipped and counted, never invented");
  ok(rows[0].hash === "ab".repeat(32), "cloud hash used as-is (full-res already in the bucket)");
  ok(rows[1].hash === "cd".repeat(32), "sync marker's own hash is extracted");
  ok(rows[2].hash === inlineHash, "inline photo hashed content-addressed");
  ok(ensured.length === 1 && ensured[0].hash === inlineHash && ensured[0].src === inline,
    "only the inline photo goes through ensure-uploaded");
}

/* ---- 3. publishPhotoShare end-to-end against the fake server ---- */
{
  const big = "data:image/jpeg;base64," + "Q".repeat(9000);   // over MEDIA_MIN — realistic
  const project = {
    id: "job-1", customer: "Jane Homeowner", address: "123 Main St", claimNo: "CL-77", dateOfLoss: "2026-08-01",
    photos: [{ id: "p1", src: big, caption: "cap", room: "Kitchen", stage: "before" }],
  };
  const r = await publishPhotoShare(project, "photos");
  ok(r.count === 1 && !r.skipped, "publish reports the photo count");
  ok(/^https:\/\/portal\.roybalconstruction\.com\/photos\/[0-9a-f]{48}$/.test(r.link), "link is the portal /photos/<token> url");
  ok(uploads === 1 && mediaStore.size === 1, "missing media uploaded to the bucket before the link goes live");
  const s = project.photoShares.photos;
  ok(s && s.token && s.publishedAt && s.count === 1 && s.enabled, "share state saved on the job");
  const row = shareRows.get(s.id);
  ok(row && row.share_token === s.token && row.kind === "photos" && row.enabled === true, "photo_shares row upserted with the token");
  ok(row.customer_name === "Jane Homeowner" && row.claim_no === "CL-77" && row.date_of_loss === "2026-08-01",
    "claim header rides the row");
  ok(row.photos.length === 1 && /^[0-9a-f]{64}$/.test(row.photos[0].hash) && row.photos[0].caption === "cap",
    "row carries hashes + labels, never image data");

  // republish reuses the SAME token (the adjuster's link survives updates)
  project.photos.push({ id: "p2", src: "data:image/jpeg;base64," + "R".repeat(9000), caption: "", room: "", stage: "after" });
  const r2 = await publishPhotoShare(project, "photos");
  ok(r2.link === r.link, "republish keeps the same link");
  ok(shareRows.get(s.id).photos.length === 2, "republish updates the row's photo list");

  // turn off — row disabled, token kept
  await setPhotoShareEnabled(project, "photos", false);
  ok(shareRows.get(s.id).enabled === false, "turn-off flips the server row");
  ok(project.photoShares.photos.token === s.token, "token survives turn-off (re-enable restores the same url)");
}

/* ---- 4. guardrails ---- */
{
  let msg = "";
  try { await publishPhotoShare({ id: "job-2", photos: [] }, "photos"); } catch (e) { msg = e.message; }
  ok(/No photos/.test(msg), "publishing an empty photo log refuses with a plain answer");
  msg = "";
  try { await publishPhotoShare({ id: "job-3", contents: [{ name: "x", photos: [] }] }, "contents"); } catch (e) { msg = e.message; }
  ok(/No item photos/.test(msg), "publishing contents with no item photos refuses");
  ok(photoShareLink("") === "", "no token, no link");
}

/* ---- 5. packet share: snapshot semantics ---- */
// no native canvas in jsdom: 2d calls become no-ops, and toDataURL tells the
// two freeze paths apart (maps flatten to jpeg, signatures freeze to png)
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.toDataURL = (type) =>
  type === "image/jpeg" ? "data:image/jpeg;base64,MAPSTUB" : "data:image/png;base64,SIGSTUB";
const bigImg = "data:image/jpeg;base64," + "Z".repeat(9000);
const mkSheet = () => {
  const sheet = window.document.createElement("section");
  sheet.className = "sheet";
  sheet.innerHTML = `
    <div class="app-only"><button>screen-only tool</button></div>
    <input id="t1" type="text">
    <input id="c1" type="checkbox">
    <textarea id="ta"></textarea>
    <select id="se"><option value="a">A</option><option value="b">B</option></select>
    <canvas id="sig" class="sigpad"></canvas>
    <img id="big" src="${bigImg}">
    <img id="small" src="data:image/gif;base64,tiny">`;
  sheet.querySelector("#t1").value = "Jane Homeowner";
  sheet.querySelector("#c1").checked = true;
  sheet.querySelector("#ta").value = "north wall notes";
  sheet.querySelector("#se").selectedIndex = 1;
  return sheet;
};
{
  const snap = snapshotSheets([mkSheet()]);
  ok(snap.querySelector("#t1").getAttribute("value") === "Jane Homeowner", "typed value survives the snapshot");
  ok(snap.querySelector("#c1").hasAttribute("checked"), "checked box survives the snapshot");
  ok(snap.querySelector("#ta").textContent === "north wall notes", "textarea text survives the snapshot");
  ok(snap.querySelector("option[selected]")?.getAttribute("value") === "b", "select choice survives the snapshot");
  ok(!snap.querySelector("canvas") && snap.querySelector("img.sigpad")?.getAttribute("src") === "data:image/png;base64,SIGSTUB",
    "a drawn canvas freezes to an image");
  ok(!snap.querySelector(".app-only"), "app-only screen controls are stripped");

  // moisture/equipment map: floor-plan <img> + strokes <canvas> flatten to ONE image
  const mapSheet = window.document.createElement("section");
  mapSheet.className = "sheet";
  mapSheet.innerHTML = `<div class="sketch"><img class="sketch__bg" src="data:image/png;base64,PLAN"><canvas></canvas></div>`;
  const mapSnap = snapshotSheets([mapSheet]);
  ok(!mapSnap.querySelector("canvas") && !mapSnap.querySelector(".sketch__bg"),
    "map snapshot has no layered plan + strokes stack left to squish");
  const mapImg = mapSnap.querySelector(".sketch img.canvas-snap");
  ok(!!mapImg && mapImg.getAttribute("src") === "data:image/jpeg;base64,MAPSTUB",
    "map slot holds one flattened plan+strokes image");
  ok(/max-width:100%/.test(mapImg.getAttribute("style") || "") && /height:auto/.test(mapImg.getAttribute("style") || ""),
    "flattened map keeps its own aspect ratio");
  const media = await dehydrateImages(snap);
  ok(media.length === 1 && media[0].text === bigImg, "the big embedded image is extracted once");
  ok(!snap.querySelector("#big").hasAttribute("src") && snap.querySelector("#big").getAttribute("data-media") === media[0].hash,
    "the image slot points at its content hash");
  ok(snap.querySelector("#small").getAttribute("src") === "data:image/gif;base64,tiny", "small images stay inline");
}

/* ---- 6. packet share: full publish path ---- */
{
  const project = { id: "job-9", customer: "Jane Homeowner", address: "123 Main St", claimNo: "CL-77", dateOfLoss: "2026-08-01" };
  const r = await publishPacketShare(project, [mkSheet()]);
  ok(/^https:\/\/portal\.roybalconstruction\.com\/packet\/[0-9a-f]{48}$/.test(r.link), "packet link is /packet/<token>");
  ok(r.count === 1, "publish reports the page count");
  const s = project.photoShares.packet;
  const row = shareRows.get(s.id);
  ok(row && row.kind === "packet" && row.share_token === s.token, "photo_shares row upserted as kind packet");
  const htmlEntry = row.photos.find((p) => p.role === "html");
  const imgEntries = row.photos.filter((p) => p.role === "img");
  ok(!!htmlEntry && imgEntries.length === 1, "row lists the skeleton + each embedded image");
  const skeleton = String(mediaStore.get(htmlEntry.hash) || "");
  ok(skeleton.startsWith("<!DOCTYPE"), "skeleton uploaded as a self-contained HTML document");
  ok(skeleton.includes('value="Jane Homeowner"') && skeleton.includes("north wall notes"), "skeleton carries the frozen form state");
  ok(skeleton.includes(`data-media="${imgEntries[0].hash}"`) && !skeleton.includes("Z".repeat(100)),
    "skeleton references images by hash and carries no image bytes");
  ok(mediaStore.get(imgEntries[0].hash) === bigImg, "the embedded image uploaded content-addressed");

  // republish keeps the token; sheets with nothing in them refuse
  const r2 = await publishPacketShare(project, [mkSheet()]);
  ok(r2.link === r.link, "packet republish keeps the same link");
  let msg = "";
  try { await publishPacketShare({ id: "job-10" }, []); } catch (e) { msg = e.message; }
  ok(/Nothing in the packet/.test(msg), "an empty packet refuses to publish");
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
