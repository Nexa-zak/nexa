/**
 * PNG round-trip test: encode QR → PNG with Nexa's encoder,
 * decode the PNG with pngjs, then decode the QR with jsQR.
 * Verifies the entire QR→PNG pipeline.
 */
import { qrPng } from '../src/png.js';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

function decodePng(buf) {
  const png = PNG.sync.read(Buffer.from(buf));
  return png;
}

let pass = 0, fail = 0;
const samples = [
  'HELLO',
  'سلام نکسا 🤖',
  'vless://11111111-2222-4333-8444-555555555555@104.17.147.22:443?encryption=none&security=tls&sni=nexa.example.workers.dev&fp=chrome&type=ws&host=nexa.example.workers.dev&path=%2Fws%3Fed%3D2048#Nexa%20%7C%20user',
  'https://nexa.example.workers.dev/sub/0123456789abcdef0123456789abcdef?format=clash'
];

for (const s of samples) {
  try {
    const pngBytes = await qrPng(s);
    const png = decodePng(pngBytes);
    if (png.width !== png.height) throw new Error('not square: ' + png.width);
    // pngjs grayscale → data is RGBA
    const rgba = new Uint8ClampedArray(png.data);
    const res = jsQR(rgba, png.width, png.height);
    if (res && res.data === s) {
      pass++;
      console.log(`PASS ✓  qr→png→decode (${s.length} chars, ${png.width}×${png.height}px, ${(pngBytes.length / 1024).toFixed(1)}KB)`);
    } else {
      fail++;
      console.error('FAIL: jsQR got', res && res.data);
    }
  } catch (e) {
    fail++;
    console.error('FAIL:', e.message);
  }
}

console.log(`PNG test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
