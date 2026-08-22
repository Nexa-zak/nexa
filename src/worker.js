/**
 * ██████╗ ███████╗██╗  ██╗██████╗  █████╗
 * ██╔══██╗██╔════╝╚██╗██╔╝██╔══██╗██╔══██╗
 * ██████╔╝█████╗   ╚███╔╝ ██████╔╝███████║
 * ██╔══██╗██╔══╝   ██╔██╗ ██╔══██╗██╔══██║
 * ██████╔╝███████╗██╔╝ ██╗██║  ██║██║  ██║
 * ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
 *
 * Nexa — VLESS proxy + subscription panel on Cloudflare Workers
 *
 * ▸ VLESS over WebSocket (with 0-RTT early-data) — works with v2rayNG / Hiddify / Streisand / sing-box / Clash Meta
 * ▸ Persian admin panel (login with password), user management, traffic & expiry limits (needs KV)
 * ▸ Subscription links: v2ray (base64) / Clash Meta (yaml) / sing-box (json)
 * ▸ Optional PROXYIP fallback for destinations behind Cloudflare
 *
 * Deploy: put UUID / PASSWORD / PROXYIP in env vars (or .dev.vars for local dev).
 * Bind a KV namespace as "KV" to unlock multi-user management + settings persistence.
 */

import { connect } from 'cloudflare:sockets';
import { makeQR } from './qr.js';
import { handleTelegramUpdate, webhookSecret } from './bot.js';

const VERSION = '1.1.0';

const DEFAULT_CLEAN_IPS = [
  '104.17.147.22',
  '104.18.32.115',
  '104.19.195.29',
  '108.162.219.6',
  '162.159.135.42',
  '162.159.136.7',
  '172.64.32.5',
  '172.67.69.200',
  '188.114.96.3',
  '188.114.97.3',
  '190.93.246.181',
  'cdn-all.xn--b6gac.eu.org',
  'cloudflare.182682.xyz',
  'speed.cloudflare.com'
];

// ─────────────────────────── utils ───────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function genUuid() {
  const h = randomHex(16);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64urlToBytes(s) {
  s = String(s || '').split(',')[0].replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers
    }
  });
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeWsPath(p) {
  p = String(p || '/ws').trim();
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

// ─────────────────────────── state (KV-backed, with env fallback) ───────────────────────────

const DEFAULT_SETTINGS = {
  wsPath: '/ws',
  proxyIP: '',
  subToken: null,
  cleanIPs: null,
  passwordHash: null
};

async function loadSettings(env) {
  const s = { ...DEFAULT_SETTINGS };
  if (env.WS_PATH) s.wsPath = normalizeWsPath(env.WS_PATH);
  if (env.PROXYIP) s.proxyIP = String(env.PROXYIP).trim();
  if (env.KV) {
    try {
      const raw = await env.KV.get('nexa:settings');
      if (raw) Object.assign(s, JSON.parse(raw));
    } catch {}
  }
  if (!Array.isArray(s.cleanIPs) || !s.cleanIPs.length) s.cleanIPs = DEFAULT_CLEAN_IPS;
  s.wsPath = normalizeWsPath(s.wsPath);
  return s;
}

async function saveSettingsPatch(env, patch) {
  if (!env.KV) return false;
  const s = await loadSettings(env);
  Object.assign(s, patch);
  await env.KV.put('nexa:settings', JSON.stringify(s));
  return true;
}

async function effectivePwHash(env, settings) {
  if (settings.passwordHash) return settings.passwordHash;
  return sha256Hex('nexa:pw:' + (env.PASSWORD || 'nexa'));
}

function usingDefaultPassword(env, settings) {
  return !settings.passwordHash && !env.PASSWORD;
}

async function loadUsers(env, host) {
  if (env.KV) {
    try {
      const raw = await env.KV.get('nexa:users');
      if (raw) {
        const users = JSON.parse(raw);
        if (Array.isArray(users) && users.length) return users;
      }
    } catch {}
    // first run on this KV: create default user and persist it
    const users = [{ name: 'اصلی', uuid: env.UUID || genUuid(), createdAt: Date.now(), expiry: null, limitMB: null, usedMB: 0 }];
    await env.KV.put('nexa:users', JSON.stringify(users));
    return users;
  }
  // no-KV mode: single user, deterministic (survives isolate restarts)
  let uuid = env.UUID || '';
  if (!uuid) {
    const h = await sha256Hex('nexa:uuid:' + host + ':' + (await effectivePwHash(env, await loadSettings(env))));
    uuid = h.slice(0, 8) + '-4' + h.slice(9, 12) + '-8' + h.slice(13, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
  }
  return [{ name: 'اصلی', uuid, createdAt: 0, expiry: null, limitMB: null, usedMB: 0 }];
}

async function saveUsers(env, users) {
  if (!env.KV) return false;
  await env.KV.put('nexa:users', JSON.stringify(users));
  return true;
}

async function bumpUsage(env, uuid, bytes) {
  if (!env.KV || !bytes) return;
  try {
    const users = await loadUsers(env, '');
    const u = users.find((x) => x.uuid === uuid);
    if (!u) return;
    u.usedMB = Math.round(((u.usedMB || 0) + bytes / 1048576) * 1000) / 1000;
    await saveUsers(env, users);
  } catch {}
}

function userStatus(u, now = Date.now()) {
  if (u.expiry && new Date(u.expiry).getTime() < now) return 'expiry';
  if (u.limitMB != null && u.limitMB > 0 && (u.usedMB || 0) >= u.limitMB) return 'traffic';
  return 'ok';
}

async function ensureSubToken(env, settings, host) {
  if (settings.subToken) return settings.subToken;
  if (env.KV) {
    const t = randomHex(16);
    await saveSettingsPatch(env, { subToken: t });
    settings.subToken = t;
    return t;
  }
  const h = await sha256Hex('nexa:sub:' + host + ':' + (await effectivePwHash(env, settings)));
  return h.slice(0, 32);
}

// ─────────────────────────── auth ───────────────────────────

async function cookieToken(env, settings) {
  return sha256Hex('nexa:cookie:' + (await effectivePwHash(env, settings)));
}

async function isAuthed(request, env, settings) {
  // machine-to-machine auth (e.g. tools) via X-Nexa-Key header
  const key = request.headers.get('x-nexa-key');
  if (key) {
    const hash = await sha256Hex('nexa:pw:' + key);
    return timingSafeEq(hash, await effectivePwHash(env, settings));
  }
  const m = (request.headers.get('cookie') || '').match(/nexa_session=([a-f0-9]{64})/);
  if (!m) return false;
  return timingSafeEq(m[1], await cookieToken(env, settings));
}

// ─────────────────────────── links & subscriptions ───────────────────────────

function vlessLink(uuid, addr, port, wsPath, host, tls, remark) {
  const p = new URLSearchParams();
  p.set('encryption', 'none');
  p.set('type', 'ws');
  p.set('host', host);
  p.set('path', wsPath + '?ed=2048');
  if (tls) {
    p.set('security', 'tls');
    p.set('sni', host);
    p.set('fp', 'chrome');
    p.set('alpn', 'h2,http/1.1');
  } else {
    p.set('security', 'none');
  }
  return 'vless://' + uuid + '@' + addr + ':' + port + '?' + p.toString() + '#' + encodeURIComponent(remark);
}

function buildUserLinks(host, settings, user) {
  const out = [];
  const base = 'Nexa | ' + user.name;
  out.push({ label: 'اصلی — ' + host, link: vlessLink(user.uuid, host, 443, settings.wsPath, host, true, base) });
  out.push({ label: 'بدون TLS — پورت ۸۰', link: vlessLink(user.uuid, host, 80, settings.wsPath, host, false, base + ' | 80') });
  for (const ip of settings.cleanIPs) {
    out.push({ label: 'IP تمیز — ' + ip, link: vlessLink(user.uuid, ip, 443, settings.wsPath, host, true, base + ' | ' + ip) });
  }
  return out;
}

function clashYaml(host, users, settings) {
  const proxies = [];
  const names = [];
  let i = 1;
  for (const u of users) {
    if (userStatus(u) !== 'ok') continue;
    const variants = [
      { addr: host, port: 443, tls: true, tag: 'اصلی' },
      ...settings.cleanIPs.map((ip) => ({ addr: ip, port: 443, tls: true, tag: String(ip) }))
    ];
    for (const v of variants) {
      const name = 'nexa-' + i + ' | ' + u.name + ' | ' + v.tag;
      i++;
      names.push(name);
      const q = '"' + name.replace(/"/g, "'") + '"';
      proxies.push(
        '  - name: ' + q + '\n' +
        '    type: vless\n' +
        '    server: ' + v.addr + '\n' +
        '    port: ' + v.port + '\n' +
        '    uuid: ' + u.uuid + '\n' +
        (v.tls ? '    tls: true\n    servername: ' + host + '\n    client-fingerprint: chrome\n' : '    tls: false\n') +
        '    network: ws\n' +
        '    udp: true\n' +
        '    ws-opts:\n' +
        '      path: "' + settings.wsPath + '?ed=2048"\n' +
        '      headers:\n' +
        '        Host: ' + host
      );
    }
  }
  if (!names.length) return '# Nexa: هیچ کاربر فعالی موجود نیست\n';
  return (
    '# Nexa — Clash Meta config\n' +
    'proxies:\n' + proxies.join('\n') + '\n' +
    'proxy-groups:\n' +
    '  - name: "Nexa"\n' +
    '    type: select\n' +
    '    proxies:\n' + names.map((n) => '      - "' + n.replace(/"/g, "'") + '"').join('\n') + '\n' +
    'rules:\n' +
    '  - MATCH,Nexa\n'
  );
}

function singboxConfig(host, users, settings) {
  const outbounds = [];
  const tags = [];
  let i = 1;
  for (const u of users) {
    if (userStatus(u) !== 'ok') continue;
    const variants = [
      { addr: host, port: 443, tag: 'اصلی' },
      ...settings.cleanIPs.map((ip) => ({ addr: ip, port: 443, tag: String(ip) }))
    ];
    for (const v of variants) {
      const tag = 'nexa-' + i;
      i++;
      tags.push(tag);
      outbounds.push({
        type: 'vless',
        tag,
        server: v.addr,
        server_port: v.port,
        uuid: u.uuid,
        tls: { enabled: true, server_name: host, insecure: false, utls: { enabled: true, fingerprint: 'chrome' } },
        transport: { type: 'ws', path: settings.wsPath + '?ed=2048', headers: { Host: host } }
      });
    }
  }
  outbounds.push({ type: 'selector', tag: 'Nexa', outbounds: [...tags, 'direct'], default: tags[0] || 'direct' });
  return JSON.stringify({ outbounds, route: { rules: [{ action: 'route', outbound: 'Nexa' }] } }, null, 2);
}

// ─────────────────────────── VLESS core ───────────────────────────

function parseVlessHeader(buf) {
  if (buf.byteLength < 24) return null;
  let i = 0;
  const version = buf[i]; i += 1; // eslint-disable-line
  let hex = '';
  for (let k = 0; k < 16; k++) hex += buf[i + k].toString(16).padStart(2, '0');
  i += 16;
  const uuid = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const addonLen = buf[i]; i += 1 + addonLen;
  if (i + 4 > buf.length) return null;
  const cmd = buf[i]; i += 1;
  const port = (buf[i] << 8) | buf[i + 1]; i += 2;
  const atype = buf[i]; i += 1;
  let host;
  if (atype === 1) {
    if (i + 4 > buf.length) return null;
    host = buf[i] + '.' + buf[i + 1] + '.' + buf[i + 2] + '.' + buf[i + 3];
    i += 4;
  } else if (atype === 2) {
    const l = buf[i]; i += 1;
    if (i + l > buf.length) return null;
    host = dec.decode(buf.subarray(i, i + l));
    i += l;
  } else if (atype === 3) {
    if (i + 16 > buf.length) return null;
    const parts = [];
    for (let k = 0; k < 16; k += 2) parts.push(((buf[i + k] << 8) | buf[i + k + 1]).toString(16));
    host = parts.join(':');
    i += 16;
  } else {
    return null;
  }
  if (cmd !== 1 && cmd !== 2) return null;
  if (!host || !port) return null;
  return { uuid, cmd, port, host, dataStart: i };
}

async function toU8(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(0);
}

function parseProxyIP(proxyIP) {
  const s = String(proxyIP || '').trim();
  if (!s) return null;
  const idx = s.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) };
  return { host: s, port: 443 };
}

const VLESS_RESP = new Uint8Array([0, 0]);

async function handleWsUpgrade(request, env, ctx) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  const url = new URL(request.url);
  const settings = await loadSettings(env);
  // 0-RTT early data (e.g. v2rayNG with ?ed=2048) arrives in this header.
  // Note: wrangler's local dev server strips this header; production delivers it.
  const early = b64urlToBytes(request.headers.get('sec-websocket-protocol') || '');
  proxySession(server, early, settings, env, ctx, url.hostname).catch(() => {
    try { server.close(); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function proxySession(server, early, settings, env, ctx, host) {
  let header = null;
  let user = null;
  let writer = null;
  let socket = null;
  let udpMode = false;
  let bytesIn = 0, bytesOut = 0;
  let closed = false;
  let queue = Promise.resolve();

  // client→target chunks are funneled through one FIFO so ordering is strict
  // while the TCP writer is being set up.
  const pendingChunks = [];
  let flushing = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    try { if (socket) socket.close(); } catch {}
  }

  function countUsage() {
    if (user && env.KV && (bytesIn || bytesOut)) ctx.waitUntil(bumpUsage(env, user.uuid, bytesIn + bytesOut));
  }

  function sendToClient(u8) {
    if (closed) return;
    try { server.send(u8); } catch {}
  }

  async function flushPending() {
    if (flushing) return;
    flushing = true;
    try {
      while (writer && !closed && pendingChunks.length) {
        const chunk = pendingChunks.shift();
        bytesIn += chunk.length;
        await writer.write(chunk);
      }
    } catch {
      cleanup();
    } finally {
      flushing = false;
    }
  }

  function pushClientData(u8) {
    pendingChunks.push(u8);
    flushPending();
  }

  async function handleDns(framed) {
    // VLESS UDP framing: [2-byte length][datagram]
    if (framed.length < 3) return;
    const len = (framed[0] << 8) | framed[1];
    const query = framed.subarray(2, 2 + len);
    if (!query.length) return;
    try {
      const resp = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: query
      });
      const ans = new Uint8Array(await resp.arrayBuffer());
      const out = new Uint8Array(2 + ans.length);
      out[0] = (ans.length >> 8) & 255;
      out[1] = ans.length & 255;
      out.set(ans, 2);
      sendToClient(out);
    } catch {
      cleanup();
    }
  }

  async function startTcp(hdr) {
    let everData = false;
    let retried = false;

    const attempt = async (hostname, port) => {
      const sock = connect({ hostname, port });
      socket = sock;
      writer = sock.writable.getWriter();
      flushPending(); // drain whatever the client already sent
      const reader = sock.readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength) {
          everData = true;
          bytesOut += value.byteLength;
          sendToClient(value);
        }
      }
    };

    try {
      await attempt(hdr.host, hdr.port);
    } catch {
      const pip = parseProxyIP(settings.proxyIP);
      if (!everData && !retried && pip && !(hdr.host === pip.host && hdr.port === pip.port) && hdr.port === 443) {
        retried = true;
        writer = null;
        try { await attempt(pip.host, pip.port); } catch { /* give up */ }
      }
    }
    cleanup();
    countUsage();
  }

  const handleFirst = async (u8) => {
    header = parseVlessHeader(u8);
    if (!header) return cleanup();
    const users = await loadUsers(env, host);
    user = users.find((x) => x.uuid === header.uuid);
    if (!user || userStatus(user) !== 'ok') return cleanup();
    const payload = u8.subarray(header.dataStart);
    sendToClient(VLESS_RESP);
    if (header.cmd === 1) {
      if (payload.length) pendingChunks.push(payload);
      startTcp(header).catch(() => cleanup()); // not awaited: keep the queue flowing
    } else {
      udpMode = true;
      if (header.port === 53) await handleDns(payload);
    }
  };

  server.onmessage = (ev) => {
    queue = queue.then(async () => {
      try {
        const u8 = await toU8(ev.data);
        if (!header) {
          await handleFirst(u8);
        } else if (udpMode) {
          if (header.port === 53) await handleDns(u8);
        } else {
          pushClientData(u8);
        }
      } catch {
        cleanup();
      }
    });
  };

  server.onclose = () => { cleanup(); countUsage(); };
  server.onerror = () => { cleanup(); countUsage(); };

  if (early && early.length) {
    queue = queue.then(() => handleFirst(early));
  }
}

// ─────────────────────────── panel pages ───────────────────────────

function loginPage() {
  return html('<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ورود — Nexa</title><link rel="icon" href="/favicon.ico"><style>' + panelCss() + '</style></head><body class="login-body"><div class="login-card"><div class="logo-big">' + LOGO_SVG + '</div><h1>Nexa</h1><p class="dim">پنل مدیریت کانکشن‌ها — وارد شوید</p><form id="lf"><input type="password" id="pw" placeholder="رمز عبور" autocomplete="current-password" required><button class="btn primary" type="submit">ورود</button><div id="lerr" class="err"></div></form></div><script>' + LOGIN_JS + '</script></body></html>');
}

const LOGO_SVG = '<svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect x="3" y="3" width="58" height="58" rx="15" fill="url(#lg)"/><path d="M21 45V19l22 26V19" stroke="#0a0e17" stroke-width="5.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const LOGIN_JS = `
(function(){
  var f = document.getElementById('lf');
  f.addEventListener('submit', function(e){
    e.preventDefault();
    var pw = document.getElementById('pw').value;
    fetch('/login', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({password: pw})})
      .then(function(r){ return r.json(); })
      .then(function(j){ if (j.ok) location.href = '/'; else document.getElementById('lerr').textContent = j.error || 'رمز عبور اشتباه است'; })
      .catch(function(){ document.getElementById('lerr').textContent = 'خطای شبکه'; });
  });
})();
`.trim();

function panelCss() {
  return `
:root{--bg:#0a0e17;--card:#111726;--card2:#0d1320;--line:#1e2638;--txt:#e6ebf5;--dim:#8b96ad;--acc:#6d7cff;--acc2:#22d3ee;--ok:#34d399;--bad:#f87171}
*{box-sizing:border-box;margin:0;padding:0;font-family:Vazirmatn,'Segoe UI',Tahoma,sans-serif}
body{background:radial-gradient(1100px 700px at 85% -10%,#1b2340 0%,var(--bg) 55%);color:var(--txt);min-height:100vh;direction:rtl}
.dim{color:var(--dim)}a{color:var(--acc2)}
.login-body{display:flex;align-items:center;justify-content:center}
.login-card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:40px 36px;width:min(380px,92vw);text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.logo-big{width:72px;height:72px;margin:0 auto 14px}
.login-card h1{font-size:30px;letter-spacing:1px;margin-bottom:6px;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.login-card p{margin-bottom:22px;font-size:14px}
input,textarea,select{width:100%;background:var(--card2);border:1px solid var(--line);border-radius:10px;color:var(--txt);padding:11px 14px;font-size:14px;outline:none;transition:border .15s}
input:focus,textarea:focus,select:focus{border-color:var(--acc)}
textarea{min-height:110px;resize:vertical;font-family:monospace;direction:ltr;text-align:left}
.btn{border:none;border-radius:10px;padding:10px 18px;font-size:14px;cursor:pointer;background:var(--line);color:var(--txt);transition:filter .15s}
.btn:hover{filter:brightness(1.15)}
.btn.primary{background:linear-gradient(90deg,var(--acc),var(--acc2));color:#05070d;font-weight:700}
.btn.danger{background:rgba(248,113,113,.12);color:var(--bad)}
.btn.small{padding:6px 12px;font-size:12.5px}
.err{color:var(--bad);font-size:13px;margin-top:12px;min-height:18px}
.wrap{max-width:1060px;margin:0 auto;padding:26px 20px 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:26px}
header .logo{width:44px;height:44px;flex:none}
header h1{font-size:22px;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
header .sp{flex:1}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat .k{font-size:12px;color:var(--dim);margin-bottom:6px}
.stat .v{font-size:14px;font-weight:600;word-break:break-all;direction:ltr;text-align:right}
.chip{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11.5px;font-weight:600}
.chip.ok{background:rgba(52,211,153,.14);color:var(--ok)}
.chip.bad{background:rgba(248,113,113,.14);color:var(--bad)}
.chip.warn{background:rgba(250,204,21,.14);color:#facc15}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.tab{padding:9px 18px;border-radius:99px;border:1px solid var(--line);background:var(--card);color:var(--dim);cursor:pointer;font-size:14px}
.tab.on{background:linear-gradient(90deg,var(--acc),var(--acc2));color:#05070d;font-weight:700;border-color:transparent}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.card h3{font-size:16px;margin-bottom:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.mono{font-family:monospace;direction:ltr;unicode-bidi:embed}
.linkrow{display:flex;align-items:center;gap:10px;background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-bottom:8px}
.linkrow .lb{font-size:13px;min-width:170px}
.linkrow .lk{flex:1;font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:left}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:10px 8px;text-align:right;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:12.5px}
td .mono{font-size:12px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:6px}
.hint{font-size:12px;color:var(--dim);margin-top:8px;line-height:1.9}
#toast{position:fixed;bottom:24px;right:50%;transform:translateX(50%);background:var(--acc);color:#05070d;padding:10px 22px;border-radius:99px;font-weight:700;font-size:14px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99}
#toast.show{opacity:1}
#qrmodal{position:fixed;inset:0;background:rgba(5,8,15,.85);display:none;align-items:center;justify-content:center;z-index:98}
#qrmodal.show{display:flex}
.qrcard{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;text-align:center;max-width:92vw}
.qrcard canvas{background:#fff;border-radius:12px;margin:12px 0}
.guide p{font-size:14px;line-height:2.1;margin-bottom:8px}
.guide code{background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:12.5px}
@media(max-width:640px){.linkrow .lb{min-width:120px}}
`.trim();
}

const PANEL_JS = `
var state = null;
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.classList.remove('show'); }, 2200);
}
function copy(text, silent) {
  var done = function(){ if (!silent) toast('کپی شد ✓'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function(){ fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
}
function api(path, opts) {
  return fetch(path, opts).then(function(r){
    if (r.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
    return r.json();
  });
}
function fmtDate(iso) {
  if (!iso) return 'نامحدود';
  try { return new Date(iso).toLocaleDateString('fa-IR'); } catch(e) { return iso; }
}
function fmtMB(mb) {
  if (mb == null) return 'نامحدود';
  if (mb >= 1024) return (mb/1024).toFixed(2) + ' GB';
  return (mb||0).toFixed(1) + ' MB';
}
function showQr(text, title) {
  var modal = document.getElementById('qrmodal');
  var card = modal.querySelector('.qrcard');
  card.innerHTML = '';
  card.appendChild(el('div', null, title || ''));
  var cv = document.createElement('canvas');
  card.appendChild(cv);
  var close = el('button', 'btn', 'بستن');
  close.style.marginTop = '6px';
  close.onclick = function(){ modal.classList.remove('show'); };
  card.appendChild(close);
  try {
    var q = NexaQR.qrEncode(text);
    var scale = Math.max(2, Math.floor(232 / (q.size + 8)));
    var dim = (q.size + 8) * scale;
    cv.width = dim; cv.height = dim;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#0a0e17';
    for (var r = 0; r < q.size; r++) for (var c = 0; c < q.size; c++) {
      if (q.m[r][c]) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    }
  } catch (e) {
    card.appendChild(el('div', 'err', 'نمایش QR ممکن نیست'));
  }
  modal.classList.add('show');
}
function subRow(label, url) {
  var row = el('div', 'linkrow');
  row.appendChild(el('div', 'lb', label));
  var lk = el('div', 'lk mono', url);
  row.appendChild(lk);
  var b1 = el('button', 'btn small', 'کپی');
  b1.onclick = function(){ copy(url); };
  row.appendChild(b1);
  var b2 = el('button', 'btn small', 'QR');
  b2.onclick = function(){ showQr(url, label); };
  row.appendChild(b2);
  return row;
}
function renderLinks() {
  var box = document.getElementById('links');
  box.innerHTML = '';
  var sel = document.getElementById('userSel');
  var uuid = sel.value;
  var url = '/api/links?uuid=' + encodeURIComponent(uuid);
  api(url).then(function(j){
    var card = el('div', 'card');
    card.appendChild(el('h3', null, 'لینک اشتراک (Subscription)'));
    card.appendChild(subRow('v2ray / v2rayNG', state.sub.urls.v2ray));
    card.appendChild(subRow('Clash Meta', state.sub.urls.clash));
    card.appendChild(subRow('sing-box', state.sub.urls.singbox));
    var hint = el('p', 'hint', 'لینک اشتراک را در اپلیکیشن وارد کنید تا کانکشن‌ها به‌صورت خودکار اضافه و به‌روز نگه داشته شوند.');
    card.appendChild(hint);
    box.appendChild(card);

    var card2 = el('div', 'card');
    var h = el('h3', null, 'کانکشن‌های تکی');
    card2.appendChild(h);
    var allBtn = el('button', 'btn small primary', 'کپی همه لینک‌ها');
    allBtn.style.marginBottom = '12px';
    var allLinks = [];
    j.users.forEach(function(u){ u.links.forEach(function(l){ allLinks.push(l.link); }); });
    allBtn.onclick = function(){ copy(allLinks.join('\\n')); };
    card2.appendChild(allBtn);
    j.users.forEach(function(u){
      u.links.forEach(function(l){
        var row = el('div', 'linkrow');
        row.appendChild(el('div', 'lb', l.label));
        var lk = el('div', 'lk mono', l.link);
        row.appendChild(lk);
        var b1 = el('button', 'btn small', 'کپی');
        b1.onclick = (function(t){ return function(){ copy(t); }; })(l.link);
        row.appendChild(b1);
        var b2 = el('button', 'btn small', 'QR');
        b2.onclick = (function(t, lb){ return function(){ showQr(t, lb); }; })(l.link, l.label);
        row.appendChild(b2);
        card2.appendChild(row);
      });
    });
    box.appendChild(card2);
  });
}
function renderUsers() {
  var tb = document.getElementById('usersBody');
  tb.innerHTML = '';
  state.users.forEach(function(u){
    var tr = document.createElement('tr');
    var td1 = el('td', null, u.name); tr.appendChild(td1);
    var td2 = el('td'); var mono = el('span', 'mono', u.uuid); td2.appendChild(mono);
    var cb = el('button', 'btn small', 'کپی'); cb.style.marginRight = '6px';
    cb.onclick = function(){ copy(u.uuid); };
    td2.appendChild(cb); tr.appendChild(td2);
    var td3 = el('td', null, fmtMB(u.usedMB) + (u.limitMB ? ' / ' + fmtMB(u.limitMB) : ''));
    tr.appendChild(td3);
    var td4 = el('td', null, fmtDate(u.expiry)); tr.appendChild(td4);
    var td5 = el('td');
    var st = u.status === 'ok' ? ['ok', 'فعال'] : (u.status === 'expiry' ? ['bad', 'منقضی'] : ['bad', 'پر شده']);
    td5.appendChild(el('span', 'chip ' + st[0], st[1])); tr.appendChild(td5);
    var td6 = el('td');
    if (state.kv) {
      var del = el('button', 'btn small danger', 'حذف');
      del.onclick = function(){
        if (!confirm('کاربر «' + u.name + '» حذف شود؟')) return;
        api('/api/users/delete', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({uuid: u.uuid})})
          .then(loadAll);
      };
      td6.appendChild(del);
    }
    tr.appendChild(td6);
    tb.appendChild(tr);
  });
}
function renderSettings() {
  document.getElementById('proxyIP').value = state.settings.proxyIP || '';
  document.getElementById('wsPath').value = state.settings.wsPath || '/ws';
  document.getElementById('cleanIPs').value = (state.settings.cleanIPs || []).join('\\n');
  document.getElementById('kvWarn').style.display = state.kv ? 'none' : 'block';
  var bc = document.getElementById('botCard');
  if (state.bot && state.bot.enabled) {
    bc.style.display = 'block';
    document.getElementById('botStatus').textContent = state.bot.webhookUrl
      ? 'وضعیت: متصل — ' + state.bot.webhookUrl
      : 'توکن ربات تنظیم شده اما وب‌هوک هنوز ساخته نشده — روی «اتصال ربات» بزنید.';
  } else {
    bc.style.display = 'none';
  }
}
function loadAll() {
  return api('/api/state').then(function(j){
    state = j;
    document.getElementById('hostV').textContent = j.host;
    document.getElementById('usersV').textContent = String(j.users.length) + ' کاربر (' + j.users.filter(function(u){return u.status==='ok';}).length + ' فعال)';
    document.getElementById('verV').textContent = 'v' + j.version;
    var kvEl = document.getElementById('kvV');
    kvEl.innerHTML = '';
    kvEl.appendChild(el('span', 'chip ' + (j.kv ? 'ok' : 'warn'), j.kv ? 'متصل' : 'متصل نیست'));
    var dp = document.getElementById('defWarn');
    dp.style.display = j.defaultPassword ? 'block' : 'none';
    var sel = document.getElementById('userSel');
    sel.innerHTML = '';
    var optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = 'همه کاربران';
    sel.appendChild(optAll);
    j.users.forEach(function(u){
      var o = document.createElement('option');
      o.value = u.uuid; o.textContent = u.name + (u.status === 'ok' ? '' : ' (غیرفعال)');
      sel.appendChild(o);
    });
    sel.onchange = renderLinks;
    renderUsers();
    renderSettings();
    renderLinks();
  });
}
document.addEventListener('DOMContentLoaded', function(){
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function(t){
    t.onclick = function(){
      tabs.forEach(function(x){ x.classList.remove('on'); });
      t.classList.add('on');
      document.querySelectorAll('.page').forEach(function(p){ p.style.display = 'none'; });
      document.getElementById('pg-' + t.dataset.p).style.display = 'block';
    };
  });
  document.getElementById('logout').onclick = function(){
    fetch('/logout', {method:'POST'}).then(function(){ location.href = '/'; });
  };
  document.getElementById('addUser').onsubmit = function(e){
    e.preventDefault();
    var name = document.getElementById('uName').value.trim() || ('user-' + (state.users.length + 1));
    var days = parseInt(document.getElementById('uDays').value, 10) || 0;
    var gb = parseFloat(document.getElementById('uGb').value) || 0;
    api('/api/users', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name: name, expiryDays: days, limitGB: gb})})
      .then(function(j){
        if (j.ok) { toast('کاربر اضافه شد ✓'); loadAll(); }
        else toast(j.error || 'خطا');
      });
  };
  document.getElementById('saveSettings').onsubmit = function(e){
    e.preventDefault();
    var body = {
      proxyIP: document.getElementById('proxyIP').value.trim(),
      wsPath: document.getElementById('wsPath').value.trim(),
      cleanIPs: document.getElementById('cleanIPs').value
    };
    var np = document.getElementById('newPass').value;
    if (np) body.newPassword = np;
    api('/api/settings', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)})
      .then(function(j){
        if (j.ok) { toast('ذخیره شد ✓'); document.getElementById('newPass').value = ''; if (np) setTimeout(function(){ location.reload(); }, 800); else loadAll(); }
        else toast(j.error || 'خطا');
      });
  };
  document.getElementById('regenToken').onclick = function(){
    if (!confirm('توکن اشتراک جدید ساخته شود؟ لینک‌های اشتراک قبلی نامعتبر می‌شوند.')) return;
    api('/api/subtoken', {method:'POST'}).then(function(j){
      if (j.ok) { toast('توکن جدید ساخته شد ✓'); loadAll(); }
      else toast(j.error || 'خطا');
    });
  };
  document.getElementById('qrmodal').onclick = function(e){
    if (e.target === this) this.classList.remove('show');
  };
  document.getElementById('botConnect').onclick = function(){
    api('/api/bot/setwebhook', {method:'POST'})
      .then(function(j){
        if (j.ok) { toast('ربات متصل شد ✓'); loadAll(); }
        else toast(j.error || 'خطا در اتصال ربات');
      });
  };
  document.getElementById('botRefresh').onclick = function(){
    api('/api/bot/status').then(function(j){
      var info = j.telegram || {};
      var txt = 'فعال: ' + (j.enabled ? 'بله' : 'خیر');
      if (info.url) txt += ' | وب‌هوک: ' + info.url + ' | در انتظار: ' + (info.pending_update_count || 0);
      document.getElementById('botStatus').textContent = txt;
    });
  };
  loadAll();
});
`.trim();

function panelPage(host) {
  const body = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexa — پنل مدیریت</title><link rel="icon" href="/favicon.ico"><style>${panelCss()}</style></head><body>
<div class="wrap">
<header>
  <div class="logo">${LOGO_SVG}</div>
  <div><h1>Nexa</h1><div class="dim" style="font-size:12px">پنل مدیریت کانکشن</div></div>
  <div class="sp"></div>
  <button class="btn small" id="logout">خروج</button>
</header>
<div id="defWarn" class="card" style="border-color:rgba(250,204,21,.4);display:none"><b style="color:#facc15">⚠ رمز پیش‌فرض فعال است</b><p class="hint">رمز پنل هنوز «nexa» است. همین حالا از تب <b>تنظیمات</b> آن را تغییر دهید.</p></div>
<div class="stats">
  <div class="stat"><div class="k">دامنه ورکر</div><div class="v" id="hostV">${htmlEscape(host)}</div></div>
  <div class="stat"><div class="k">کاربران</div><div class="v" id="usersV">—</div></div>
  <div class="stat"><div class="k">نسخه</div><div class="v" id="verV">v${VERSION}</div></div>
  <div class="stat"><div class="k">حافظه KV</div><div class="v" id="kvV">—</div></div>
</div>
<div class="tabs">
  <div class="tab on" data-p="links">🔗 کانکشن‌ها</div>
  <div class="tab" data-p="users">👥 کاربران</div>
  <div class="tab" data-p="settings">⚙️ تنظیمات</div>
  <div class="tab" data-p="guide">📖 راهنما</div>
</div>
<div class="page" id="pg-links">
  <div class="card"><h3>کاربر</h3><select id="userSel" style="max-width:320px"></select></div>
  <div id="links"></div>
</div>
<div class="page" id="pg-users" style="display:none">
  <div class="card">
    <h3>افزودن کاربر</h3>
    <form id="addUser">
      <div class="row">
        <div class="field" style="flex:1;min-width:160px"><label>نام</label><input id="uName" placeholder="مثلاً ali"></div>
        <div class="field" style="flex:1;min-width:140px"><label>انقضا (روز — ۰ = نامحدود)</label><input id="uDays" type="number" min="0" value="0"></div>
        <div class="field" style="flex:1;min-width:140px"><label>سقف حجم (GB — ۰ = نامحدود)</label><input id="uGb" type="number" min="0" step="0.5" value="0"></div>
        <div class="field" style="flex:none;padding-top:20px"><button class="btn primary" type="submit">افزودن</button></div>
      </div>
      <p class="hint">UUID به‌صورت خودکار ساخته می‌شود. برای اتصال، از تب «کانکشن‌ها» لینک کاربر را بگیرید.</p>
    </form>
  </div>
  <div class="card">
    <h3>کاربران</h3>
    <table><thead><tr><th>نام</th><th>UUID</th><th>مصرف</th><th>انقضا</th><th>وضعیت</th><th></th></tr></thead><tbody id="usersBody"></tbody></table>
  </div>
</div>
<div class="page" id="pg-settings" style="display:none">
  <div id="kvWarn" class="card" style="border-color:rgba(250,204,21,.4);display:none"><b style="color:#facc15">⚠ حافظه KV متصل نیست</b><p class="hint">بدون KV فقط یک کاربر (از متغیر UUID) پشتیبانی می‌شود و تغییرات تنظیمات و مدیریت کاربران غیرفعال است. راهنمای اتصال KV در README ریپازیتوری.</p></div>
  <div class="card" id="botCard" style="display:none">
    <h3>🤖 ربات تلگرام</h3>
    <div id="botStatus" class="hint">—</div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" type="button" id="botConnect">🔌 اتصال ربات به تلگرام</button>
      <button class="btn" type="button" id="botRefresh">🔄 وضعیت</button>
    </div>
    <p class="hint">پس از اتصال، در تلگرام ربات را /start کنید و رمز همین پنل را بفرستید تا منوی مدیریت و لینک‌های اختصاصی هر کاربر نمایش داده شود.</p>
  </div>
  <div class="card">
    <h3>تنظیمات</h3>
    <form id="saveSettings">
      <div class="field"><label>ProxyIP (برای عبور از سایت‌های پشت کلادفلر — مثل 1.2.3.4 یا 1.2.3.4:443)</label><input id="proxyIP" placeholder="خالی = غیرفعال"></div>
      <div class="field"><label>مسیر وب‌سوکت</label><input id="wsPath" placeholder="/ws"></div>
      <div class="field"><label>IPها و دامنه‌های تمیز (هر خط یکی — در لینک‌ها استفاده می‌شود)</label><textarea id="cleanIPs"></textarea></div>
      <div class="field"><label>رمز عبور جدید پنل (خالی = بدون تغییر)</label><input id="newPass" type="password" autocomplete="new-password" placeholder="حداقل ۶ کاراکتر"></div>
      <div class="row"><button class="btn primary" type="submit">ذخیره تنظیمات</button>
      <button class="btn" type="button" id="regenToken">🔄 ساخت توکن اشتراک جدید</button></div>
    </form>
  </div>
</div>
<div class="page guide" id="pg-guide" style="display:none">
  <div class="card">
    <h3>راهنمای اتصال</h3>
    <p>۱. ساده‌ترین راه: از تب «کانکشن‌ها» یکی از <b>لینک‌های اشتراک</b> را کپی کنید و در اپلیکیشن (v2rayNG، Hiddify، Streisand، NekoBox و…) به‌عنوان Subscription اضافه کنید.</p>
    <p>۲. راه دیگر: روی دکمه <b>QR</b> کنار هر کانکشن بزنید و با اپلیکیشن اسکن کنید، یا لینک تکی را کپی و با <code>import from clipboard</code> اضافه کنید.</p>
    <p>۳. اگر کانکشن اصلی قطع بود، کانکشن‌های <b>IP تمیز</b> را امتحان کنید — همان سرور با IPهای مختلف کلادفلر.</p>
    <p>۴. برای سایت‌هایی که خودشان پشت کلادفلرند، در تنظیمات یک <b>ProxyIP</b> وارد کنید.</p>
    <p>۵. پورت‌های جایگزین TLS: 2053، 2083، 2087، 2096، 8443 — و پورت‌های بدون TLS: 8080، 8880، 2052، 2082، 2086، 2095 (در اپلیکیشن قابل تغییر است).</p>
  </div>
</div>
</div>
<div id="toast"></div>
<div id="qrmodal"><div class="qrcard"></div></div>
<script>const NexaQR = (${makeQR.toString()})();</script>
<script>${PANEL_JS}</script>
</body></html>`;
  return html(body);
}

// ─────────────────────────── router ───────────────────────────

async function handleSub(request, env, token, fmt) {
  const url = new URL(request.url);
  const host = url.hostname;
  const settings = await loadSettings(env);
  const expect = await ensureSubToken(env, settings, host);
  if (!timingSafeEq(String(token || ''), expect)) {
    return new Response('Not found', { status: 404 });
  }
  const users = (await loadUsers(env, host)).filter((u) => userStatus(u) === 'ok');
  const base = { 'profile-title': bytesToB64(enc.encode('✨ Nexa')), 'profile-web-page-url': 'https://' + host + '/', 'profile-update-interval': '24', 'cache-control': 'no-store' };

  if (fmt === 'clash') {
    return new Response(clashYaml(host, users, settings), { status: 200, headers: { 'content-type': 'text/yaml; charset=utf-8', 'content-disposition': 'attachment; filename=nexa-clash.yaml', ...base } });
  }
  if (fmt === 'singbox') {
    return new Response(singboxConfig(host, users, settings), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename=nexa-singbox.json', ...base } });
  }
  const links = users.flatMap((u) => buildUserLinks(host, settings, u)).map((l) => l.link);
  return new Response(bytesToB64(enc.encode(links.join('\n'))), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename=nexa-sub.txt', ...base }
  });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  const host = url.hostname;

  // websocket (VLESS)
  if (request.headers.get('Upgrade') === 'websocket') {
    const settings = await loadSettings(env);
    const uuidMatch = '/' + (env.UUID || '');
    if (path === settings.wsPath || path.startsWith(settings.wsPath + '/') || path === uuidMatch) {
      return handleWsUpgrade(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  }

  if (path === '/favicon.ico') {
    return new Response(LOGO_SVG, { status: 200, headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
  }
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (path === '/healthz') return new Response('ok', { status: 200 });

  // public sub endpoints
  if (path.startsWith('/sub/')) return handleSub(request, env, path.slice(5).split('/')[0], url.searchParams.get('format') || 'v2ray');

  // Telegram webhook (only reachable with the correct secret + header token)
  if (path.startsWith('/tg/')) {
    const secret = path.slice(4).split('/')[0];
    const expect = await webhookSecret(env);
    if (!expect || !timingSafeEq(secret, expect)) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('ok', { status: 200 });
    const hdrSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (!timingSafeEq(hdrSecret, expect)) return new Response('Not found', { status: 404 });
    let update = null;
    try { update = await request.json(); } catch {}
    if (update && env.TELEGRAM_BOT_TOKEN) {
      ctx.waitUntil(handleTelegramUpdate(update, env, ctx).catch(() => {}));
    }
    return new Response('', { status: 200 });
  }

  const settings = await loadSettings(env);

  if (path === '/login' && request.method === 'POST') {
    let pw = '';
    try {
      const body = await request.json();
      pw = String(body.password || '');
    } catch {}
    const hash = await sha256Hex('nexa:pw:' + pw);
    const target = await effectivePwHash(env, settings);
    if (!pw || !timingSafeEq(hash, target)) {
      return json({ ok: false, error: 'رمز عبور اشتباه است' }, 401);
    }
    const token = await cookieToken(env, settings);
    const secure = url.protocol === 'https:' ? ' Secure;' : '';
    return json({ ok: true }, 200, {
      'set-cookie': `nexa_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800;${secure}`
    });
  }

  if (path === '/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': 'nexa_session=; Path=/; HttpOnly; Max-Age=0' });
  }

  if (path === '/') {
    if (!(await isAuthed(request, env, settings))) return loginPage();
    return panelPage(host);
  }

  // authenticated API
  if (path.startsWith('/api/')) {
    if (!(await isAuthed(request, env, settings))) return json({ error: 'unauthorized' }, 401);

    if (path === '/api/state' && request.method === 'GET') {
      const users = await loadUsers(env, host);
      const token = await ensureSubToken(env, settings, host);
      const botEnabled = !!env.TELEGRAM_BOT_TOKEN;
      let botWebhook = null;
      if (botEnabled && settings.botHost) {
        botWebhook = `https://${settings.botHost}/tg/${await webhookSecret(env)}`;
      }
      return json({
        ok: true,
        host,
        version: VERSION,
        kv: !!env.KV,
        defaultPassword: usingDefaultPassword(env, settings),
        bot: { enabled: botEnabled, webhookUrl: botWebhook },
        settings: {
          wsPath: settings.wsPath,
          proxyIP: settings.proxyIP,
          cleanIPs: settings.cleanIPs
        },
        sub: {
          token,
          urls: {
            v2ray: `https://${host}/sub/${token}`,
            clash: `https://${host}/sub/${token}?format=clash`,
            singbox: `https://${host}/sub/${token}?format=singbox`
          }
        },
        users: users.map((u) => ({
          name: u.name,
          uuid: u.uuid,
          expiry: u.expiry || null,
          limitMB: u.limitMB,
          usedMB: u.usedMB || 0,
          status: userStatus(u)
        }))
      });
    }

    if (path === '/api/links' && request.method === 'GET') {
      const want = url.searchParams.get('uuid') || 'all';
      const users = (await loadUsers(env, host)).filter((u) => want === 'all' || u.uuid === want);
      return json({
        ok: true,
        users: users.map((u) => ({ name: u.name, uuid: u.uuid, links: buildUserLinks(host, settings, u) }))
      });
    }

    if (path === '/api/settings' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const patch = {};
      if (typeof body.wsPath === 'string' && body.wsPath.trim()) patch.wsPath = normalizeWsPath(body.wsPath);
      if (typeof body.proxyIP === 'string') patch.proxyIP = body.proxyIP.trim();
      if (typeof body.cleanIPs === 'string') {
        const ips = body.cleanIPs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        patch.cleanIPs = ips.length ? ips : DEFAULT_CLEAN_IPS;
      }
      if (body.newPassword) {
        const np = String(body.newPassword);
        if (np.length < 6) return json({ ok: false, error: 'رمز باید حداقل ۶ کاراکتر باشد' }, 400);
        patch.passwordHash = await sha256Hex('nexa:pw:' + np);
      }
      if (!env.KV) return json({ ok: false, error: 'برای ذخیره تنظیمات باید KV متصل کنید (راهنما در README)' }, 409);
      await saveSettingsPatch(env, patch);
      return json({ ok: true });
    }

    if (path === '/api/users' && request.method === 'POST') {
      if (!env.KV) return json({ ok: false, error: 'مدیریت کاربران نیاز به KV دارد (راهنما در README)' }, 409);
      let body = {};
      try { body = await request.json(); } catch {}
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return json({ ok: false, error: 'نام کاربر الزامی است' }, 400);
      const users = await loadUsers(env, host);
      const user = {
        name,
        uuid: genUuid(),
        createdAt: Date.now(),
        expiry: body.expiryDays > 0 ? Date.now() + body.expiryDays * 86400000 : null,
        limitMB: body.limitGB > 0 ? Math.round(body.limitGB * 1024) : null,
        usedMB: 0
      };
      users.push(user);
      await saveUsers(env, users);
      return json({ ok: true, user: { ...user, status: 'ok' } });
    }

    if (path === '/api/users/delete' && request.method === 'POST') {
      if (!env.KV) return json({ ok: false, error: 'مدیریت کاربران نیاز به KV دارد' }, 409);
      let body = {};
      try { body = await request.json(); } catch {}
      const users = await loadUsers(env, host);
      if (users.length <= 1) return json({ ok: false, error: 'حداقل یک کاربر باید باقی بماند' }, 400);
      const next = users.filter((u) => u.uuid !== body.uuid);
      if (next.length === users.length) return json({ ok: false, error: 'کاربر پیدا نشد' }, 404);
      await saveUsers(env, next);
      return json({ ok: true });
    }

    if (path === '/api/subtoken' && request.method === 'POST') {
      if (!env.KV) return json({ ok: false, error: 'ساخت توکن جدید نیاز به KV دارد' }, 409);
      const t = randomHex(16);
      await saveSettingsPatch(env, { subToken: t });
      return json({ ok: true, token: t });
    }

    // bot management endpoints (panel-authenticated)
    if (path === '/api/bot/setwebhook' && request.method === 'POST') {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'متغیر TELEGRAM_BOT_TOKEN روی ورکر تنظیم نشده است' }, 409);
      const secret = await webhookSecret(env);
      const hookUrl = `https://${host}/tg/${secret}`;
      const r = await telegramCall(env, 'setWebhook', {
        url: hookUrl,
        allowed_updates: ['message', 'callback_query'],
        secret_token: secret,
        drop_pending_updates: true
      });
      if (!r || !r.ok) return json({ ok: false, error: (r && r.description) || 'Telegram API error' }, 502);
      await saveSettingsPatch(env, { botHost: host });
      const c = await telegramCall(env, 'setMyCommands', { commands: BOT_COMMANDS });
      return json({ ok: true, webhook: hookUrl, commandsSet: !!(c && c.ok) });
    }

    if (path === '/api/bot/status' && request.method === 'GET') {
      if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: true, enabled: false });
      const r = await telegramCall(env, 'getWebhookInfo', {});
      const settingsNow = await loadSettings(env);
      const secret = await webhookSecret(env);
      return json({
        ok: true,
        enabled: true,
        host: settingsNow.botHost || null,
        expectedWebhook: settingsNow.botHost ? `https://${settingsNow.botHost}/tg/${secret}` : null,
        telegram: r && r.result ? r.result : null
      });
    }

    return json({ error: 'not found' }, 404);
  }

  return html('<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>404 — Nexa</title></head><body style="background:#0a0e17;color:#e6ebf5;font-family:Tahoma,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="text-align:center"><div style="font-size:64px">404</div><p>صفحه‌ای که دنبالش بودید اینجا نیست.</p><p><a href="/" style="color:#22d3ee">بازگشت به پنل</a></p></div></body></html>', 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      return new Response('Nexa error: ' + ((err && err.message) || err), { status: 500 });
    }
  }
};

// shared panel logic used by the Telegram bot (circular ESM — live bindings)
export {
  sha256Hex,
  randomHex,
  genUuid,
  timingSafeEq,
  json,
  loadSettings,
  saveSettingsPatch,
  effectivePwHash,
  usingDefaultPassword,
  loadUsers,
  saveUsers,
  bumpUsage,
  userStatus,
  ensureSubToken,
  cookieToken,
  buildUserLinks,
  vlessLink,
  clashYaml,
  singboxConfig
};

// ─────────────────── telegram bot endpoints ───────────────────

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const api = env.TELEGRAM_API || 'https://api.telegram.org';
  try {
    const r = await fetch(api + '/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: (e && e.message) || 'network error' };
  }
}

const BOT_COMMANDS = [
  { command: 'start', description: 'شروع و ورود به پنل' },
  { command: 'menu', description: 'منوی اصلی' },
  { command: 'links', description: 'کانکشن‌های من' },
  { command: 'sub', description: 'لینک‌های اشتراک' },
  { command: 'status', description: 'وضعیت و مصرف من' },
  { command: 'users', description: 'مدیریت کاربران' },
  { command: 'add', description: 'افزودن کاربر' },
  { command: 'token', description: 'توکن اشتراک جدید' },
  { command: 'proxyip', description: 'تغییر ProxyIP' },
  { command: 'ips', description: 'ویرایش IPهای تمیز' },
  { command: 'help', description: 'راهنما' },
  { command: 'logout', description: 'خروج از ربات' }
];
