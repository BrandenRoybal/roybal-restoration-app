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
