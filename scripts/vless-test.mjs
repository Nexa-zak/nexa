/**
 * End-to-end VLESS test: speaks VLESS-over-WebSocket against a running worker
 * (wrangler dev), opens a real TCP target through the proxy and checks the
 * HTTP response that comes back through the tunnel.
 *
 * Usage: node scripts/vless-test.mjs <uuid> [wsUrl] [targetHost] [targetPort]
 */
import WebSocket from 'ws';

const uuid = process.argv[2] || (() => { console.error('usage: vless-test.mjs <uuid> [wsUrl] [host] [port]'); process.exit(2); })();
const wsUrl = process.argv[3] || 'ws://127.0.0.1:8787/ws';
const target = process.argv[4] || 'example.com';
const port = parseInt(process.argv[5] || '80', 10);

// build VLESS request header
const hex = uuid.replace(/-/g, '');
if (hex.length !== 32) { console.error('bad uuid'); process.exit(2); }
const bytes = [0x00];
for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
bytes.push(0x00); // addons length
bytes.push(0x01); // cmd: TCP
bytes.push((port >> 8) & 255, port & 255);
const hostBytes = [...Buffer.from(target)];
bytes.push(0x02, hostBytes.length, ...hostBytes); // atype: domain

const httpReq = Buffer.from(
  `GET / HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: nexa-e2e-test\r\nAccept: */*\r\nConnection: close\r\n\r\n`
);

let gotResp = false;
let body = '';
let timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20000);

const ws = new WebSocket(wsUrl, { headers: { 'user-agent': 'nexa-e2e-test' } });
ws.on('open', () => ws.send(Buffer.concat([Buffer.from(bytes), httpReq])));
ws.on('message', (data) => {
  const buf = Buffer.from(data);
  if (!gotResp) {
    if (buf.length < 2 || buf[0] !== 0 || buf[1] !== 0) {
      console.error('BAD VLESS RESPONSE HEADER:', buf.subarray(0, 8).toString('hex'));
      process.exit(1);
    }
    gotResp = true;
    body += buf.subarray(2).toString('latin1');
  } else {
    body += buf.toString('latin1');
  }
});
ws.on('close', () => {
  clearTimeout(timer);
  if (!gotResp) { console.error('closed before vless response'); process.exit(1); }
  const firstLine = body.split('\r\n')[0] || '';
  const ok = /^HTTP\/\d\.\d 200/.test(firstLine);
  console.log('vless response header ok, HTTP status line:', firstLine);
  const hasBody = body.toLowerCase().includes('<html') || body.toLowerCase().includes('doctype');
  console.log('body received:', hasBody ? 'yes' : 'no/unknown');
  console.log(ok && firstLine ? 'E2E TEST PASSED ✓' : 'E2E TEST INCONCLUSIVE (status: ' + firstLine + ')');
  process.exit(ok ? 0 : 1);
});
ws.on('error', (e) => { console.error('WS ERROR:', e.message); process.exit(1); });
