/* ============================================================
   Roybal Field Forms — minimal ZIP writer (STORE method only)
   Photos are already-compressed JPEGs, so entries go in
   uncompressed: instant to pack, and every unzip tool reads
   them. The matching reader lives in xlsx.js (zipIndex/zipRead),
   which the tests use to round-trip archives.
   Pure byte-pushing, no DOM — Node-testable.
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* entries: [{ name, bytes: Uint8Array }] → array of Uint8Array parts, ready
   for `new Blob(parts, { type: "application/zip" })`. Parts (not one buffer)
   so a 40MB photo archive never needs a second contiguous copy in memory. */
export function zipStore(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = ((((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const bytes = e.bytes;
    const crc = crc32(bytes);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);   // local file header
    head.setUint16(4, 20, true);           // version needed to extract
    head.setUint16(6, 0x0800, true);       // flags: UTF-8 names
    head.setUint16(8, 0, true);            // method: store
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, bytes.length, true);  // compressed = uncompressed (store)
    head.setUint32(22, bytes.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);           // no extra field
    parts.push(new Uint8Array(head.buffer), name, bytes);
    central.push({ name, crc, size: bytes.length, offset });
    offset += 30 + name.length + bytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);     // central directory entry
    cd.setUint16(4, 20, true);             // version made by
    cd.setUint16(6, 20, true);             // version needed
    cd.setUint16(8, 0x0800, true);         // flags: UTF-8 names
    cd.setUint16(10, 0, true);             // method: store
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, c.crc, true);
    cd.setUint32(20, c.size, true);
    cd.setUint32(24, c.size, true);
    cd.setUint16(28, c.name.length, true);
    cd.setUint32(42, c.offset, true);      // remaining fields stay 0
    parts.push(new Uint8Array(cd.buffer), c.name);
    cdSize += 46 + c.name.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);     // end of central directory
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  parts.push(new Uint8Array(eocd.buffer));
  return parts;
}

/* "data:image/jpeg;base64,..." → { mime, bytes } (null when not a data URL) */
export function dataURLToBytes(src) {
  const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(src || "");
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  if (!m[2]) return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}
