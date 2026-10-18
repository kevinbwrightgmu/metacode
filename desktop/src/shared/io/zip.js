// @ts-check
// ── ZIP archives (for .xlsx) ──────────────────────────────────────────────────
// Reads and writes the subset of ZIP that Office files use: stored and
// deflated entries, no encryption, no spanning; ZIP64 sizes are refused.
// Decompression is passed in (the app's window uses the browser's
// DecompressionStream, tests use Node's zlib) and is always bounded, so a
// "zip bomb" can't fill memory: every entry and the archive as a whole have
// a size limit, checked while inflating.

export class ZipError extends Error {}

/**
 * @typedef {(data: Uint8Array, maxBytes: number) => Promise<Uint8Array>} Inflate  raw-deflate → bytes; rejects past maxBytes
 * @typedef {(data: Uint8Array) => Promise<Uint8Array>} Deflate
 * @typedef {{ name: string, method: number, flags: number, compressedSize: number, size: number, offset: number, crc: number }} Entry
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** @param {Uint8Array} data */
export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Opens an archive: lists its entries; read(name) inflates one.
 * @param {Uint8Array} bytes
 * @param {{ inflate: Inflate, maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number }} o
 */
export function openZip(bytes, o) {
  const maxEntries = o.maxEntries || 10000;
  const maxEntry = o.maxEntryBytes || 512 * 1024 * 1024;
  const maxTotal = o.maxTotalBytes || 1024 * 1024 * 1024;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new ZipError('This isn\'t a ZIP-based file (an .xlsx is a ZIP archive).');
  const count = dv.getUint16(end + 10, true);
  const cdSize = dv.getUint32(end + 12, true);
  let p = dv.getUint32(end + 16, true);
  if (count === 0xFFFF || p === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) throw new ZipError('ZIP64 archives aren\'t supported.');
  if (count > maxEntries) throw new ZipError('The archive has too many entries (' + count + ').');
  if (p + cdSize > bytes.length) throw new ZipError('The archive is damaged (its directory is cut off).');
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('The archive is damaged (bad directory entry).');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true), compressedSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (compressedSize === 0xFFFFFFFF || size === 0xFFFFFFFF || offset === 0xFFFFFFFF) throw new ZipError('ZIP64 archives aren\'t supported.');
    entries.set(name, { name, method, flags, compressedSize, size, offset, crc });
  }
  let total = 0;
  return {
    names: () => Array.from(entries.keys()),
    has: (/** @type {string} */ name) => entries.has(name),
    /** @param {string} name @returns {Promise<Uint8Array | null>} */
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.flags & 1) throw new ZipError('The file is encrypted (password-protected). Remove the password in the app that made it.');
      if (e.size > maxEntry) throw new ZipError('"' + name + '" is too large (' + Math.round(e.size / 1048576) + ' MB).');
      if (e.offset + 30 > bytes.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new ZipError('The archive is damaged (bad local header).');
      const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
      if (start + e.compressedSize > bytes.length) throw new ZipError('The archive is damaged (an entry is cut off).');
      const data = bytes.subarray(start, start + e.compressedSize);
      let out;
      if (e.method === 0) out = data;
      else if (e.method === 8) out = await o.inflate(data, Math.min(maxEntry, maxTotal - total));
      else throw new ZipError('"' + name + '" uses a compression method that isn\'t supported (' + e.method + ').');
      total += out.length;
      if (total > maxTotal) throw new ZipError('The file expands to more than ' + Math.round(maxTotal / 1048576) + ' MB.');
      if (crc32(out) !== e.crc) throw new ZipError('"' + name + '" is damaged (checksum mismatch).');
      return out;
    },
    /** @param {string} name */
    async text(name) { const b = await this.read(name); return b === null ? null : new TextDecoder('utf-8').decode(b); }
  };
}

/**
 * Builds an archive (deflated entries).
 * @param {{ name: string, data: Uint8Array | string }[]} files
 * @param {{ deflate: Deflate, date?: Date }} o
 */
export async function makeZip(files, o) {
  const enc = new TextEncoder();
  const d = o.date || new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xFFFF;
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  /** @type {Uint8Array[]} */
  const parts = [];
  /** @type {Uint8Array[]} */
  const central = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const comp = await o.deflate(raw);
    const crc = crc32(raw);
    const lh = new Uint8Array(30), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 8, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, name.length, true);
    const ch = new Uint8Array(46), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 8, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    parts.push(lh, name, comp);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const endRec = new Uint8Array(22), ev = new DataView(endRec.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = parts.concat(central, [endRec]);
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** Inflate/deflate with the browser's streams (the app's window and workers) */
export const browserCodec = {
  /** @type {Inflate} */
  async inflate(data, maxBytes) {
    const ds = new DecompressionStream('deflate-raw');
    const reader = new Blob([/** @type {any} */ (data)]).stream().pipeThrough(ds).getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { await reader.cancel(); throw new ZipError('An entry expands to more than ' + Math.round(maxBytes / 1048576) + ' MB.'); }
      chunks.push(value);
    }
    const out = new Uint8Array(n);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  },
  /** @type {Deflate} */
  async deflate(data) {
    const cs = new CompressionStream('deflate-raw');
    return new Uint8Array(await new Response(new Blob([/** @type {any} */ (data)]).stream().pipeThrough(cs)).arrayBuffer());
  }
};
