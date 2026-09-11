/* ZIP writer test — round-trips zip.js (writer) through xlsx.js (reader).
   Run: node test/zip.test.mjs */
import { zipStore, crc32, dataURLToBytes } from "../js/zip.js";
import { zipIndex, zipRead } from "../js/xlsx.js";

let failures = 0;
const ok = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) failures++; };

const enc = new TextEncoder();
const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// CRC-32 known-answer vector
ok(crc32(enc.encode("123456789")) === 0xcbf43926, "crc32 matches the standard test vector");

// binary payload with every byte value (would corrupt if pushed through text)
const binary = new Uint8Array(256);
for (let i = 0; i < 256; i++) binary[i] = i;

const parts = zipStore([
  { name: "photo-index.csv", bytes: enc.encode("#,file\n1,001 during Kitchen.jpg\n") },
  { name: "001 during Kitchen flooded subfloor.jpg", bytes: binary },
  { name: "002 after Café — done.jpg", bytes: enc.encode("jpeg-ish") },   // UTF-8 name
]);
const buf = concat(parts);

const entries = zipIndex(buf);
ok(entries.size === 3, "central directory lists all three entries");
ok(entries.has("002 after Café — done.jpg"), "UTF-8 filenames survive");

const csv = await zipRead(buf, entries, "photo-index.csv");
ok(csv === "#,file\n1,001 during Kitchen.jpg\n", "text entry round-trips through the reader");

// verify the binary entry byte-for-byte (reader returns text, so use its
// central-directory offsets and pull the raw stored bytes ourselves)
const e = entries.get("001 during Kitchen flooded subfloor.jpg");
ok(e.method === 0, "entries are stored uncompressed (method 0)");
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const start = e.localOff + 30 + u16(buf, e.localOff + 26) + u16(buf, e.localOff + 28);
const raw = buf.subarray(start, start + e.compSize);
ok(raw.length === 256 && raw.every((v, i) => v === i), "binary entry round-trips byte-for-byte");
ok(crc32(raw) === crc32(binary), "stored CRC input matches the original bytes");

// dataURLToBytes
const b64 = dataURLToBytes("data:image/jpeg;base64,SGVsbG8=");
ok(b64 && b64.mime === "image/jpeg" && new TextDecoder().decode(b64.bytes) === "Hello", "base64 data URL decodes");
const plain = dataURLToBytes("data:text/plain,hi%20there");
ok(plain && new TextDecoder().decode(plain.bytes) === "hi there", "URL-encoded (non-base64) data URL decodes");
ok(dataURLToBytes("media:abc:123") === null && dataURLToBytes("") === null, "non-data-URLs return null");

console.log("\n" + (failures ? `FAILED: ${failures}` : "ALL ZIP CHECKS PASSED"));
process.exit(failures ? 1 : 0);
