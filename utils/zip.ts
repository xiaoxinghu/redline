// zip.ts — a tiny, dependency-free ZIP reader/writer for the side panel.
//
// Redline exports an image-bearing changeset as a .zip "bundle": a
// `changeset.json` plus the replacement images under `assets/`, referenced by
// filename. Images (PNG/JPG/WebP…) are already compressed, so we use the ZIP
// "store" method (no deflate) — same size, far less code, and the archive still
// opens in Finder/Explorer/`unzip` because we write a proper central directory.
//
// We only ever read archives we wrote (store-only), so the reader supports the
// store method and throws clearly on anything compressed.
//
//   zipSync(files)   files: { [name]: Uint8Array }  -> Uint8Array
//   unzipSync(bytes) bytes: Uint8Array              -> { [name]: Uint8Array }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipSync(files: Record<string, Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const name in files) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) continue;
    const data = files[name];
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header signature
    ldv.setUint16(4, 20, true);          // version needed
    ldv.setUint16(6, 0, true);           // flags
    ldv.setUint16(8, 0, true);           // method: store
    ldv.setUint16(10, 0, true);          // mod time
    ldv.setUint16(12, 0, true);          // mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true);       // compressed size
    ldv.setUint32(22, size, true);       // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);          // extra length
    lh.set(nameBytes, 30);
    locals.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);  // central dir signature
    cdv.setUint16(4, 20, true);          // version made by
    cdv.setUint16(6, 20, true);          // version needed
    cdv.setUint16(8, 0, true);           // flags
    cdv.setUint16(10, 0, true);          // method: store
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);     // local header offset
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + data.length;
  }

  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);    // EOCD signature
  edv.setUint16(8, centrals.length, true);
  edv.setUint16(10, centrals.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);            // comment length

  const all = locals.concat(centrals, [eocd]);
  let total = 0;
  for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

export function unzipSync(bytes: Uint8Array | ArrayBuffer): Record<string, Uint8Array> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory).');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;

    if (method !== 0) throw new Error('Unsupported compressed entry: ' + name);
    out[name] = buf.slice(dataStart, dataStart + compSize);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
