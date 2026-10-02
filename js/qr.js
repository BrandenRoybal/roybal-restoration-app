/* ============================================================
   Roybal Field Forms — offline QR codes (lazy-loaded)
   Wraps the vendored qrcode-generator to emit a crisp SVG string
   for pack-out box labels. Loaded on first use only.
   ============================================================ */
let _qrcode;
async function lib() {
  if (!_qrcode) _qrcode = (await import("../assets/vendor/qrcode/qrcode.mjs")).default;
  return _qrcode;
}

/** Returns an <svg> string encoding `text`. */
export async function qrSvg(text, cell = 3, margin = 2) {
  const qrcode = await lib();
  const qr = qrcode(0, "M");          // type 0 = auto-size, medium error correction
  qr.addData(text || " ");
  qr.make();
  return qr.createSvgTag(cell, margin);
}

/** The QR as a boolean matrix — rows of dark cells — for renderers that draw
    it themselves (the photo-log PDF emits one rectangle per run of cells,
    crisp at any print size and a few KB, where a raster QR would be a lossy
    JPEG). Same auto-sized, medium-error-correction code as qrSvg. */
export async function qrModules(text) {
  const qrcode = await lib();
  const qr = qrcode(0, "M");
  qr.addData(text || " ");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}
