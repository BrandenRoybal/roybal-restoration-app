/* ============================================================
   Roybal Field Forms — offline QR codes (lazy-loaded)
   Wraps the vendored qrcode-generator to emit a crisp SVG string
   for pack-out box labels and equipment tags. Loaded on first use only.
   ============================================================ */
let _qrcode;
async function lib() {
  if (!_qrcode) _qrcode = (await import("../assets/vendor/qrcode/qrcode.mjs")).default;
  return _qrcode;
}

/* Error-correction level: L / M / Q / H. M (the default every existing
   caller gets) for paper; equipment labels ask for Q so a scuffed or
   dirty tag on a working machine still reads. Anything else falls back
   to M rather than throwing. */
const ECC = { L: 1, M: 1, Q: 1, H: 1 };
function eccOf(ecc) {
  const e = String(ecc || "M").toUpperCase();
  return ECC[e] ? e : "M";
}

/** Returns an <svg> string encoding `text`. */
export async function qrSvg(text, cell = 3, margin = 2, ecc = "M") {
  const qrcode = await lib();
  const qr = qrcode(0, eccOf(ecc));   // type 0 = auto-size
  qr.addData(text || " ");
  qr.make();
  return qr.createSvgTag(cell, margin);
}

/** The QR as a boolean matrix — rows of dark cells — for renderers that draw
    it themselves (the photo-log PDF emits one rectangle per run of cells,
    crisp at any print size and a few KB, where a raster QR would be a lossy
    JPEG). Same auto-sized code as qrSvg, medium error correction unless
    `ecc` says otherwise. */
export async function qrModules(text, ecc = "M") {
  const qrcode = await lib();
  const qr = qrcode(0, eccOf(ecc));
  qr.addData(text || " ");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}
