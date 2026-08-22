/**
 * Nexa E2E test suite — runs against a local `wrangler dev` (default ws://127.0.0.1:8787/ws).
 * Covers: plain HTTP tunnel, invalid-UUID rejection, real TLS handshake through the
 * tunnel, and UDP DNS (cmd=2) over DoH.
 *
 * Usage: node scripts/e2e-suite.mjs <uuid>
 */
import WebSocket from 'ws';
import tls from 'node:tls';
import { Duplex } from 'node:stream';

const uuid = process.argv[2];
if (!uuid) { console.error('usage: e2e-suite.mjs <uuid>'); process.exit(2); }
const WS_URL = 'ws://127.0.0.1:8787/ws';
const results = [];
function report(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS ✓' : 'FAIL ✗'}  ${name}${extra ? ' — ' + extra : ''}`);
}

function buildHeader(cmd, target, port) {
  const hex = uuid.replace(/-/g, '');
  const b = [0x00];
  for (let i = 0; i < 32; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
  b.push(0x00, cmd, (port >> 8) & 255, port & 255);
  const hb = [...Buffer.from(target)];
  b.push(0x02, hb.length, ...hb);
  return Buffer.from(b);
}

// ── test 1: plain HTTP through the tunnel ──
async function httpTest() {
  return new Promise((resolve) => {
    const req = Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nUser-Agent: nexa-test\r\nConnection: close\r\n\r\n');
    const ws = new WebSocket(WS_URL);
    let body = '', gotResp = false;
    const t = setTimeout(() => { report('HTTP tunnel', false, 'timeout'); resolve(); }, 20000);
    ws.on('open', () => ws.send(Buffer.concat([buildHeader(1, 'example.com', 80), req])));
    ws.on('message', (d) => {
      const b = Buffer.from(d);
      if (!gotResp) {
        if (b.length < 2 || b[0] !== 0 || b[1] !== 0) { clearTimeout(t); report('HTTP tunnel', false, 'bad vless resp'); resolve(); return; }
        gotResp = true; body += b.subarray(2).toString();
      } else body += b.toString();
    });
    ws.on('close', () => {
      clearTimeout(t);
      const line = body.split('\r\n')[0] || '';
      report('HTTP tunnel', /^HTTP\/\d\.\d 200/.test(line), line);
      resolve();
    });
    ws.on('error', () => { clearTimeout(t); report('HTTP tunnel', false, 'ws error'); resolve(); });
  });
}

// ── test 2: invalid UUID is rejected ──
async function invalidTest() {
  return new Promise((resolve) => {
    const hex = '99999999999949998999999999999999';
    const b = [0x00];
    for (let i = 0; i < 32; i += 2) b.push(parseInt(hex.substr(i, 2), 16));
    b.push(0x00, 0x01, 0x00, 0x50, 0x02, 11, ...[...Buffer.from('example.com')]);
    const ws = new WebSocket(WS_URL);
    let gotData = false;
    const t = setTimeout(() => { report('invalid UUID rejected', false, 'timeout'); resolve(); }, 15000);
    ws.on('open', () => ws.send(Buffer.from(b)));
    ws.on('message', () => { gotData = true; });
    ws.on('close', () => { clearTimeout(t); report('invalid UUID rejected', !gotData); resolve(); });
    ws.on('error', () => { clearTimeout(t); report('invalid UUID rejected', !gotData, 'ws err'); resolve(); });
  });
}

// ── test 3: real TLS handshake through the tunnel ──
async function tlsTest() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const chunks = [];
    let stream = null;
    let finished = false;
    const t = setTimeout(() => { if (!finished) { finished = true; report('TLS tunnel', false, 'timeout'); resolve(); } }, 20000);
    const finish = (ok, extra) => {
      if (finished) return;
      finished = true; clearTimeout(t);
      report('TLS tunnel', ok, extra);
      try { ws.close(); } catch {}
      resolve();
    };
    ws.on('open', () => ws.send(buildHeader(1, 'example.com', 443)));
    ws.on('message', (d) => {
      const b = Buffer.from(d);
      if (!stream) {
        if (b.length < 2 || b[0] !== 0 || b[1] !== 0) { finish(false, 'bad vless resp'); return; }
        if (b.length > 2) chunks.push(b.subarray(2));
        stream = new Duplex({
          read() { while (chunks.length) { if (!this.push(chunks.shift())) break; } },
          write(chunk, enc, cb) { try { ws.send(chunk); cb(); } catch (e) { cb(e); } }
        });
        const tlsSock = tls.connect({ socket: stream, servername: 'example.com' }, () => {
          tlsSock.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        });
        let resp = '';
        tlsSock.on('data', (d) => { resp += d.toString(); });
        const onDone = () => {
          const line = resp.split('\r\n')[0] || '';
          finish(/^HTTP\/\d\.\d 200/.test(line), line);
        };
        tlsSock.on('end', onDone);
        tlsSock.on('close', () => { if (resp) onDone(); });
        tlsSock.on('error', (e) => finish(false, e.message));
        return;
      }
      stream.push(b);
    });
    ws.on('close', () => {
      if (stream) {
        // remote side finished; let the TLS stack drain buffered data first
        stream.push(null);
        setTimeout(() => finish(false, 'tls did not complete'), 3000);
      } else {
        finish(false, 'closed early');
      }
    });
    ws.on('error', () => finish(false, 'ws error'));
  });
}

// ── test 4: UDP DNS through DoH fallback ──
async function dnsTest() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let gotResp = false, acc = Buffer.alloc(0), done = false;
    const t = setTimeout(() => { if (!done) { report('UDP DNS', false, 'timeout'); resolve(); } }, 20000);
    ws.on('open', () => {
      // DNS query: example.com A
      const q = Buffer.from('001001000001000000000000076578616d706c6503636f6d0000010001', 'hex');
      const framed = Buffer.concat([Buffer.from([0, q.length]), q]);
      ws.send(Buffer.concat([buildHeader(2, '1.1.1.1', 53), framed]));
    });
    ws.on('message', (d) => {
      const b = Buffer.from(d);
      if (!gotResp) { if (b.length >= 2 && b[0] === 0 && b[1] === 0) { gotResp = true; acc = Buffer.concat([acc, b.subarray(2)]); } return; }
      acc = Buffer.concat([acc, b]);
      if (acc.length >= 3) {
        const len = (acc[0] << 8) | acc[1];
        if (acc.length >= 2 + len && len > 0) {
          const ans = acc.subarray(2, 2 + len);
          done = true; clearTimeout(t);
          report('UDP DNS', (ans[2] & 0x80) === 0x80, 'dns answer ' + len + ' bytes');
          try { ws.close(); } catch {}
          resolve();
        }
      }
    });
    ws.on('close', () => { if (!done) { clearTimeout(t); report('UDP DNS', gotResp, 'closed early'); resolve(); } });
    ws.on('error', () => { clearTimeout(t); if (!done) { report('UDP DNS', false, 'ws error'); resolve(); } });
  });
}

(async () => {
  await httpTest();
  await invalidTest();
  await tlsTest();
  await dnsTest();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
