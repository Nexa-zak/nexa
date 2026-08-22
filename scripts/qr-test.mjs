/**
 * QR round-trip test: encode with Nexa's built-in QR encoder,
 * decode with the independent jsQR library, compare.
 */
import { makeQR } from '../src/qr.js';
import jsQR from 'jsqr';

const QR = makeQR();

function decode(text, ec = 'M') {
  const { size, m } = QR.qrEncode(text, ec);
  const scale = 4, quiet = 4;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  const paint = (x, y) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const px = ((y + dy) * dim + (x + dx)) * 4;
        data[px] = data[px + 1] = data[px + 2] = 0;
      }
    }
  };
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (m[r][c]) paint((c + quiet) * scale, (r + quiet) * scale);
  const res = jsQR(data, dim, dim);
  return res ? res.data : null;
}

let pass = 0, fail = 0;
const vlessLike = (n) =>
  'vless://8f0b3c2a-1111-4bbb-9ccc-' + String(n).repeat(12).slice(0, 12) +
  '@104.17.147.22:443?encryption=none&security=tls&sni=nexa.example.workers.dev&fp=chrome&type=ws&host=nexa.example.workers.dev&path=%2Fws%3Fed%3D2048#Nexa%20%7C%20user%20' + n + '%20%7C%20' + 'x'.repeat(20);

const cases = [];
for (let i = 1; i <= 34; i++) cases.push(vlessLike(i).slice(0, 40 + i * 9)); // ~ 50..340 chars
cases.push('HELLO', 'سلام نکسا ✨', 'https://example.com/?a=1&b=2#frag');
for (const ec of ['L', 'M', 'Q', 'H']) cases.push(['QR-EC-' + ec + '-', 'n'].join('') + ec.repeat(3));

for (const c of cases) {
  const ec = c.startsWith('QR-EC-') ? c.slice(-1) : 'M';
  const got = decode(c, ec);
  if (got === c) pass++;
  else { fail++; console.error('FAIL len=' + c.length + ' ec=' + ec + ' got=' + JSON.stringify(got && got.slice(0, 60))); }
}

console.log(`QR test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
