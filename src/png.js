/**
 * Nexa PNG — minimal 8-bit grayscale PNG encoder for turning QR matrices
 * into photos straight inside the Worker (zero dependencies).
 * Uses the runtime's CompressionStream('deflate') for zlib IDAT.
 */

import { makeQR } from './qr.js';

const QR = makeQR();

// CRC-32 (PNG chunks)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * qrPng(text, opts) -> Promise<Uint8Array>  (a complete PNG file)
 */
export async function qrPng(text, opts = {}) {
  const quiet = opts.quiet != null ? opts.quiet : 6;
  const ec = opts.ec || 'M';
  const { size, m } = QR.qrEncode(text, ec);
  const modules = size + quiet * 2;
  const scale = opts.scale || Math.max(2, Math.min(14, Math.floor(416 / modules)));
  const dim = modules * scale;

  // raw scanlines, each prefixed with filter byte 0 (None)
  const raw = new Uint8Array(dim * (dim + 1));
  for (let y = 0; y < dim; y++) {
    const rowStart = y * (dim + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < dim; x++) {
      const r = Math.floor(y / scale) - quiet;
      const c = Math.floor(x / scale) - quiet;
      const on = r >= 0 && c >= 0 && r < size && c < size && m[r][c];
      raw[rowStart + 1 + x] = on ? 0x00 : 0xff;
    }
  }

  const idat = await zlibDeflate(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, dim); // width
  dv.setUint32(4, dim); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
