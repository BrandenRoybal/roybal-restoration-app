/* Photo-log PDF test — the pure writer (photopdf.js: JPEG headers, WinAnsi
   text, wrapping, part planning, the document itself), the field export path
   with a stubbed canvas + network, and the portal's verbatim copy.
   Run: node test/photopdf.test.mjs */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM("<!DOCTYPE html><body><div id=\"toast\" hidden></div></body>", { url: "http://localhost/" });
const { window } = dom;
for (const k of ["document", "window", "navigator", "location", "HTMLElement", "Node", "localStorage"]) {
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
}

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

const { buildPhotoLogPdf, jpegInfo, winAnsi, textWidth, wrapText, planParts, cardCaption, fmtDate, PART_MAX_BYTES, PAGE } =
  await import("../js/photopdf.js");

/* real JPEGs from the marketing site — restoration photos, portrait 1200×2000
   and square 600×600, the mix a job log has */
const IMG = new URL("../../site/public/images/", import.meta.url);
const jpg = (name) => new Uint8Array(readFileSync(new URL(name, IMG)));
const tall = jpg("cd486074-gallery2.jpg");
const tall2 = jpg("41c2cde1-gallery7.jpg");
const square = jpg("48b534fc-adobestock_131184384.jpeg");
const wide = jpg("9593287d-adobestock_225490549.jpeg");
const small = jpg("c25e4951-adobestock_492445295.jpeg");
const latin1 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };

/* ---- 1. JPEG header parsing ---- */
{
  const a = jpegInfo(tall);
  ok(a && a.width === 1200 && a.height === 2000 && a.components === 3, "baseline JPEG: width, height, 3 components");
  const w = jpegInfo(wide);
  ok(w && w.width === 800 && w.height === 364, "landscape JPEG dimensions");
  // hand-built progressive frame header (SOI, APP0, SOF2 640×480 gray)
  const sof2 = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0, 0xff, 0xda]);
  const p = jpegInfo(sof2);
  ok(p && p.width === 640 && p.height === 480 && p.components === 1 && p.progressive, "progressive (SOF2) header parses, grayscale flagged");
  ok(jpegInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])) === null, "PNG bytes are not a JPEG");
  ok(jpegInfo(new Uint8Array(0)) === null && jpegInfo(null) === null, "empty / null input is rejected, not thrown");
}

/* ---- 2. WinAnsi text + Helvetica metrics ---- */
{
  const b = winAnsi("· — é ’ €");
  ok(b[0] === 0xb7 && b[2] === 0x97 && b[4] === 0xe9 && b[6] === 0x92 && b[8] === 0x80, "middle dot, em dash, é, curly quote, € take their WinAnsi codes");
  ok(latin1(winAnsi("wet 🚿 drywall → sub")) === "wet  drywall -> sub", "emoji drop, arrows substitute — nothing becomes '?'");
  ok(Math.abs(textWidth("Hello", 10) - 22.78) < 1e-9, "Helvetica width of 'Hello' at 10pt is 22.78 (AFM metrics)");
  ok(textWidth("Hello", 10, true) > textWidth("Hello", 10), "bold is wider than regular");
  ok(fmtDate("2026-07-31") === "Jul 31, 2026" && fmtDate("July 2026") === "July 2026" && fmtDate("") === "", "date of loss formats like the sheets; free text passes through");
}

/* ---- 3. wrapping ---- */
{
  const sentence = "Moisture meter on a pole mount affixed to textured drywall at monitoring point 15, tracking in-wall drying progress.";
  const lines = wrapText(sentence, 9, false, 200);
  ok(lines.length > 1 && lines.every((l) => textWidth(l, 9) <= 200), "a long caption wraps and no line exceeds the width");
  ok(lines.join(" ") === sentence, "wrapping loses no words");
  const url = "https://portal.roybalconstruction.com/photos/" + "ab".repeat(24);
  const ul = wrapText(url, 9, false, 150);
  ok(ul.length > 1 && ul.join("") === url && ul.every((l) => textWidth(l, 9) <= 150), "an over-wide URL breaks by character, like word-break: break-all");
  const cut = wrapText(sentence, 9, false, 120, { maxLines: 2 });
  ok(cut.length === 2 && cut[1].endsWith("…") && textWidth(cut[1], 9) <= 120, "past maxLines the last line ends in an ellipsis that still fits");
  const first = wrapText("one two three four five six", 9, false, 200, { firstWidth: 30 });
  ok(first[0] === "one" && first.length === 2, "a narrower first line (room for the bold prefix) is honored");
}

/* ---- 4. part planning ---- */
{
  ok(planParts([]).length === 0, "no photos, no parts");
  ok(JSON.stringify(planParts([3e6, 3e6, 3e6, 3e6, 3e6], 10e6)) === "[[0,3],[3,5]]", "15 MB of photos under a 10 MB cap: two balanced parts");
  ok(JSON.stringify(planParts([12e6], 10e6)) === "[[0,1]]", "one photo over the cap gets a part of its own (the encode, not the split, is the fix)");
  ok(JSON.stringify(planParts([12e6, 1e6], 10e6)) === "[[0,1],[1,2]]", "an oversize photo never drags a neighbor into an over-cap part");
  const sizes = Array.from({ length: 216 }, (_, i) => 60_000 + (i * 7919) % 50_000);   // ~18 MB, varied
  const parts = planParts(sizes, PART_MAX_BYTES);
  const sum = ([a, b]) => sizes.slice(a, b).reduce((x, y) => x + y, 0);
  ok(parts.length === 2 && parts[0][0] === 0 && parts[1][1] === 216 && parts[0][1] === parts[1][0], "216 varied photos: two contiguous parts covering every photo once");
  ok(parts.every((p) => sum(p) + (p[1] - p[0]) * 1400 + 60_000 <= PART_MAX_BYTES), "each planned part is under the cap with structure counted");
  ok(Math.abs(sum(parts[0]) - sum(parts[1])) < 150_000, "the two parts are balanced, not one full and one nearly empty");
}

/* ---- 5. the document ---- */
const qr = Array.from({ length: 21 }, (_, r) => Array.from({ length: 21 }, (_, c) => (r * 7 + c * 3) % 5 < 2));
const photos = [
  { num: 1, stage: "during", room: "Kitchen", caption: "Dehumidifier and air mover placement", jpeg: tall },
  { num: 2, stage: "before", room: "Hall", caption: "Standing water at the base of the wall — café door", jpeg: square },
  { num: 3, stage: "after", room: "", caption: "Final: subfloor replaced, moisture at dry standard", jpeg: wide },
  { num: 4, stage: "during", room: "Bath", caption: "", jpeg: small },
  { num: 5, stage: "before", room: "Kitchen", caption: "Cabinet toe-kick wicking", jpeg: tall2, preview: true },
];
const header = { customer: "Cheria Fidler", address: "1750 Persinger Dr, North Pole, AK 99705", claimNo: "030132628-800", dateOfLoss: "2026-07-31" };
const url = "https://portal.roybalconstruction.com/photos/" + "ab".repeat(24);
const links = [{ head: "All job photos — full resolution, view & download:", url, sub: "Open the link (or scan the code).", qr }];
{
  const out = buildPhotoLogPdf({ header, links, photos, generated: new Date(2026, 8, 11, 9, 30) });
  ok(out.parts.length === 1 && out.total === 5 && out.skipped.length === 0, "five photos, one part, nothing skipped");
  const part = out.parts[0];
  const pdf = latin1(part.bytes);
  ok(pdf.startsWith("%PDF-1.4\n") && pdf.endsWith("%%EOF\n"), "PDF header and trailer");
  // every xref offset lands on its object
  const sx = Number(pdf.slice(pdf.lastIndexOf("startxref") + 10).trim().split("\n")[0]);
  ok(pdf.slice(sx, sx + 4) === "xref", "startxref points at the xref table");
  const entries = pdf.slice(sx).split("\n").slice(2).filter((l) => / n $/.test(l) || / n\s*$/.test(l));
  const bad = entries.filter((l, i) => !pdf.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`));
  ok(entries.length > 10 && bad.length === 0, `all ${entries.length} xref offsets resolve to their objects`);
  ok(/\/Type \/Pages \/Kids \[[^\]]+\] \/Count 4 >>/.test(pdf) && part.pages === 4, "cover + 3 photo pages for 5 photos at two per page");
  // each JPEG is embedded verbatim as a DCT stream
  const embedded = (bytes) => {
    const re = /\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g;
    let m; while ((m = re.exec(pdf))) {
      if (Number(m[1]) !== bytes.length) continue;
      const at = m.index + m[0].length;
      let same = true;
      for (let i = 0; i < bytes.length; i += 97) if (part.bytes[at + i] !== bytes[i]) { same = false; break; }
      if (same && part.bytes[at + bytes.length - 1] === bytes[bytes.length - 1]) return true;
    }
    return false;
  };
  ok([tall, square, wide, small, tall2].every(embedded), "all five JPEGs are in the file byte-for-byte (no re-encode)");
  ok(/\/Width 1200 \/Height 2000 \/ColorSpace \/DeviceRGB/.test(pdf) && /\/Width 800 \/Height 364/.test(pdf), "image objects carry the parsed dimensions");
  // grouped before → during → after, log numbers kept
  const at = (s) => pdf.indexOf(s);
  const cap = (n, stage) => `(#00${n} \\267 ${stage})`;
  ok([cap(2, "BEFORE"), cap(5, "BEFORE"), cap(1, "DURING"), cap(4, "DURING"), cap(3, "AFTER")].every((c) => at(c) >= 0), "every card is captioned #NNN · STAGE");
  ok(at(cap(2, "BEFORE")) < at(cap(5, "BEFORE")) && at(cap(5, "BEFORE")) < at(cap(1, "DURING")) && at(cap(4, "DURING")) < at(cap(3, "AFTER")),
    "cards run before → during → after while keeping their log numbers");
  ok(at("(BEFORE \\(2\\))") >= 0 && at("(DURING \\(2\\))") >= 0 && at("(AFTER \\(1\\))") >= 0, "a stage band with its count opens each group");
  ok(at("(\\267 Hall \\267 Standing water at the base of the wall \\227 caf\\351 door)") >= 0, "room + caption follow the prefix; em dash and é survive");
  ok(at("preview only") >= 0, "a preview-only photo says so on its card");
  ok(at("2026-08") < 0 && at("Aug ") < 0, "no capture or caption dates on the cards");
  ok(at("(Jul 31, 2026)") >= 0 && at("(030132628-800)") >= 0 && at("(Cheria Fidler)") >= 0 && at("1750 Persinger Dr") >= 0, "the cover carries customer, address, claim # and date of loss");
  ok(pdf.includes(`/Subtype /Link /Rect [`) && pdf.includes(`/URI (${url})`), "the live portal link is a clickable annotation on the cover");
  ok((pdf.match(/ re f/g) || []).length > 60, "the QR is drawn as vector rectangles");
  ok(/\/Title \(Photo Log - Cheria Fidler - Claim 030132628-800\)/.test(pdf) && /\/CreationDate \(D:20260911093000\)/.test(pdf), "document title and creation date");
  ok(pdf.includes("(Generated Sep 11, 2026 by Roybal Field Forms.)"), "the cover says when the log was generated");
  ok(part.count === 5 && JSON.stringify(part.nums) === "[2,5,1,4,3]" && part.stages.BEFORE === 2 && part.stages.AFTER === 1, "part summary: count, ordered numbers, stage tally");
  ok(pdf.includes("cm /Im1 Do Q"), "images are placed with a transform (object-fit: contain, drawn by the page)");
  // contain, never crop: every placed image fits inside the card width/height
  const placed = [...pdf.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im\d Do Q/g)]
    .map((m) => ({ w: +m[1], h: +m[2], x: +m[3], y: +m[4] }));
  ok(placed.length === 5 && placed.every((p) => p.w <= 540 && p.h <= 340 && p.x >= 36 && p.x + p.w <= PAGE.w - 36 + 0.01), "every photo is drawn inside its card at its own aspect ratio");
  const tallDraw = placed.find((p) => Math.abs(p.w / p.h - 0.6) < 0.01), wideDraw = placed.find((p) => Math.abs(p.w / p.h - 800 / 364) < 0.01);
  ok(!!tallDraw && !!wideDraw && wideDraw.w > tallDraw.w && tallDraw.h > wideDraw.h, "portrait and landscape photos keep their proportions (nothing cropped to a box)");
}

/* ---- 6. no live link: nothing prints; a bad JPEG is skipped, not fatal ---- */
{
  const out = buildPhotoLogPdf({ header, links: [], photos: [...photos, { num: 6, stage: "after", caption: "corrupt", jpeg: Uint8Array.from([1, 2, 3]) }] });
  const pdf = latin1(out.parts[0].bytes);
  ok(!pdf.includes("/Annot") && !pdf.includes("FULL-RESOLUTION") && (pdf.match(/ re f/g) || []).length < 20, "without a live link the cover has no link box, annotation or QR (only the section bands and photo boxes are filled)");
  ok(JSON.stringify(out.skipped) === "[6]" && out.total === 5, "an unreadable image is reported by number and left out");
  const item = buildPhotoLogPdf({ header, links: [], photos: [{ num: 1, stage: "", item: "2× Lamps", room: "Den", caption: "brass", jpeg: small }] });
  ok(latin1(item.parts[0].bytes).includes("(#001 \\267 PHOTOS)") && latin1(item.parts[0].bytes).includes("2\\327 Lamps \\267 Den \\267 brass"), "a contents share (no stage) groups as PHOTOS and leads with the item");
  ok(JSON.stringify(cardCaption({ num: 7, stage: "after", room: " Kitchen ", caption: "" })) === JSON.stringify(["#007 · AFTER", "Kitchen"]), "caption parts: padded number, stage, trimmed room");
}

/* ---- 7. splitting into parts under a cap ---- */
{
  const many = Array.from({ length: 12 }, (_, i) => ({ num: i + 1, stage: ["before", "during", "after"][i % 3], caption: "shot " + (i + 1), jpeg: [tall, tall2, square][i % 3] }));
  const cap = 1_200_000;
  const out = buildPhotoLogPdf({ header, links, photos: many, maxBytes: cap });
  ok(out.parts.length >= 2, `a 12-photo log over a ${cap / 1e6} MB cap splits into ${out.parts.length} parts`);
  ok(out.parts.every((p) => p.bytes.length <= cap), "every part's actual file size is under the cap");
  const nums = out.parts.flatMap((p) => p.nums);
  ok(nums.length === 12 && new Set(nums).size === 12, "every photo lands in exactly one part");
  const rank = { before: 0, during: 1, after: 2 };
  const stages = nums.map((n) => rank[many[n - 1].stage]);
  ok(stages.every((s, i) => i === 0 || s >= stages[i - 1]), "the stage order runs across parts, not restarting in each");
  const texts = out.parts.map((p) => latin1(p.bytes));
  ok(texts.every((t, i) => t.includes(`(Part ${i + 1} of ${out.parts.length} \\267 Page 2 of `)), "every part has its own cover and page numbering");
  ok(texts.every((t) => t.includes(`/URI (${url})`)), "the portal link is on every part's cover");
  const cont = texts.slice(1).some((t) => t.includes("\\267 continued)"));
  ok(cont, "a stage that carries over from the previous part is marked continued");
}

/* ---- 8. the field export path (stubbed canvas + network) ---- */
{
  const { exportPhotoLogPdf } = await import("../js/photoexport.js");
  const dataUrl = (bytes) => "data:image/jpeg;base64," + Buffer.from(bytes).toString("base64");
  const project = {
    id: "job-1", customer: "Cheria Fidler", address: "1750 Persinger Dr", claimNo: "030132628-800", dateOfLoss: "2026-07-31",
    photoShares: { photos: { id: "s1", token: "ab".repeat(24), publishedAt: "2026-09-01T00:00:00Z", enabled: true, count: 4 } },
    photos: [
      { id: "p1", src: dataUrl(square), caption: "inline original", room: "Kitchen", stage: "before", ts: "2026-08-13T10:00:00Z" },
      { id: "p2", src: dataUrl(small), cloud: "cd".repeat(32), caption: "offloaded, cloud reachable", stage: "" },
      { id: "p3", src: "", caption: "nothing here" },                                          // no src, no cloud: not a photo
      { id: "p4", src: dataUrl(small), cloud: "ef".repeat(32), caption: "offloaded, cloud unreachable", stage: "after" },
      { id: "p5", src: "media:" + "12".repeat(32) + ":5000", caption: "marker, not on this device", stage: "after" },
    ],
  };
  const shrunk = [];
  const fetched = [];
  const r = await exportPhotoLogPdf(project, () => {}, {
    fetchFull: async (ph) => { fetched.push(ph.id); return ph.cloud === "cd".repeat(32) ? dataUrl(wide) : null; },
    shrink: async (src) => { shrunk.push(src.length); return src; },
    qr: async () => qr,
  });
  ok(r.count === 3 && r.missing === 1 && r.previews === 1 && r.linked === true, "3 photos in, 1 unreachable marker missing, 1 preview-only, live link found");
  ok(JSON.stringify(fetched) === '["p2","p4"]', "only offloaded photos go to the cloud");
  ok(shrunk.length === 3, "every included photo is re-encoded through the canvas step");
  const pdf = latin1(r.parts[0].bytes);
  ok(pdf.includes("(#001 \\267 BEFORE)") && pdf.includes("(#002 \\267 DURING)") && pdf.includes("(#003 \\267 AFTER)") && !pdf.includes("#004") && !pdf.includes("#005"),
    "numbers follow the ZIP's rule: position among photos that exist (the empty entry gets none), the unlabeled photo files as DURING, and the missing marker photo's number is left unused");
  ok(pdf.includes("offloaded, cloud unreachable \\267 preview only"), "the unreachable original is labelled preview only");
  ok(pdf.includes(`/URI (https://portal.roybalconstruction.com/photos/${"ab".repeat(24)})`) && (pdf.match(/ re f/g) || []).length > 60, "the live insurance link + QR are on the cover");
  ok(!pdf.includes("Aug 13") && !pdf.includes("2026-08-13"), "the caption date never reaches the card");
  let msg = "";
  try { await exportPhotoLogPdf({ id: "e", photos: [] }); } catch (e) { msg = e.message; }
  ok(/No photos/.test(msg), "an empty log refuses with a plain answer");
  msg = "";
  try { await exportPhotoLogPdf({ id: "e2", photos: [{ src: "media:" + "ab".repeat(32) + ":9" }] }, () => {}, { fetchFull: async () => null }); } catch (e) { msg = e.message; }
  ok(/No photo is reachable/.test(msg), "nothing reachable refuses instead of shipping an empty log");
}

/* ---- 9. the portal's copy is the same file ---- */
{
  const a = readFileSync(new URL("../js/photopdf.js", import.meta.url), "utf8");
  const b = readFileSync(new URL("../../portal/js/photopdf.js", import.meta.url), "utf8");
  ok(a === b, "apps/portal/js/photopdf.js is byte-identical to apps/field/js/photopdf.js");
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL PHOTO-LOG PDF CHECKS PASSED");
process.exit(failures ? 1 : 0);
