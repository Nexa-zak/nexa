/**
 * Nexa Bot E2E test — self-contained:
 *  1. spawns a mock Telegram API server (records every call)
 *  2. spawns `wrangler dev` with TELEGRAM_API pointed at the mock
 *  3. walks a full conversation through the webhook endpoint:
 *     /start → password → menu → links → QR → add-user flow → delete
 *  4. asserts every expected Telegram call happened and panel state changed
 *
 * Usage: node scripts/bot-test.mjs   (needs KV binding in wrangler.toml)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const WORKER = 'http://127.0.0.1:8787';
const PASSWORD = 'nexa-test-123';
const BOT_TOKEN = '123456:TEST-TOKEN';
const TG_MOCK_PORT = 9911;

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SECRET = sha256Hex('nexa:tg:' + BOT_TOKEN).slice(0, 32);

// ── mock telegram api ──
const calls = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(body.toString()); } catch { parsed = { multipart: true, bytes: body.length }; }
    calls.push({ method: req.url.split('/').pop(), body: parsed });
    res.setHeader('content-type', 'application/json');
    let result = {};
    if (req.url.endsWith('getWebhookInfo')) result = { url: '', pending_update_count: 0 };
    if (req.url.endsWith('getMe')) result = { id: 1, username: 'nexa_test_bot' };
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => mock.listen(TG_MOCK_PORT, '127.0.0.1', r));

// ── spawn wrangler dev ──
const wrangler = spawn('npx', [
  'wrangler', 'dev', '--port', '8787',
  '--var', 'UUID:11111111-2222-4333-8444-555555555555',
  '--var', 'PASSWORD:' + PASSWORD,
  '--var', 'TELEGRAM_BOT_TOKEN:' + BOT_TOKEN,
  '--var', 'TELEGRAM_API:http://127.0.0.1:' + TG_MOCK_PORT
], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_ANALYTICS: 'false' } });
wrangler.stdout.on('data', () => {});
wrangler.stderr.on('data', (d) => process.stderr.write(d.toString().match(/error/i) ? d : ''));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(WORKER + '/healthz');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS ✓' : 'FAIL ✗'}  ${name}${extra ? ' — ' + extra : ''}`);
}

async function sendUpdate(update) {
  const r = await fetch(WORKER + '/tg/' + SECRET, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify(update)
  });
  return r.status;
}

const msg = (text, id = 111) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 10, chat: { id, type: 'private' }, from: { id, first_name: 'Ali', username: 'ali_tg' }, text } });
const cbq = (data, id = 111) => ({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: 'cb1', from: { id, first_name: 'Ali', username: 'ali_tg' }, data, message: { message_id: 20, chat: { id, type: 'private' } } } });

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const found = calls.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const api = async (path, opts) => (await fetch(WORKER + path, opts)).json();

try {
  if (!(await waitReady())) throw new Error('wrangler dev did not start');
  calls.length = 0;

  // 1. webhook security
  const bad = await fetch(WORKER + '/tg/wrongsecret', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: '{}' });
  check('wrong webhook secret rejected', bad.status === 404);

  // 2. connect bot from panel API
  const login = await fetch(WORKER + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const hook = await api('/api/bot/setwebhook', { method: 'POST', headers: { cookie } });
  check('setwebhook via panel', hook.ok === true, hook.webhook || '');
  const hookCall = await waitFor((c) => c.method === 'setWebhook');
  check('telegram got setWebhook', !!hookCall && hookCall.body.url === hook.webhook, hookCall && hookCall.body.url);
  check('secret_token sent to telegram', !!hookCall && hookCall.body.secret_token === SECRET);

  // 3. /start asks for password
  await sendUpdate(msg('/start'));
  const ask = await waitFor((c) => c.method === 'sendMessage' && /رمز عبور پنل/.test(c.body.text || ''));
  check('/start asks for password', !!ask);

  // 4. wrong password rejected
  await sendUpdate(msg('wrong-pass'));
  const wrong = await waitFor((c) => c.method === 'sendMessage' && /اشتباه/.test(c.body.text || ''));
  check('wrong password rejected', !!wrong);

  // 5. correct password → main menu
  await sendUpdate(msg(PASSWORD));
  const menu = await waitFor((c) => c.method === 'sendMessage' && /پنل Nexa/.test(c.body.text || '') && c.body.reply_markup);
  check('password → main menu', !!menu && !!(menu.body.reply_markup && menu.body.reply_markup.inline_keyboard));

  // 6. /links → personal user + links + QR buttons
  await sendUpdate(msg('/links'));
  const linksMsg = await waitFor((c) => c.method === 'sendMessage' && /کانکشن‌های شما/.test(c.body.text || ''));
  check('/links returns personal links', !!linksMsg && linksMsg.body.text.includes('vless://'));
  check('links message has QR buttons', !!linksMsg && /callback_data.*qr:0/.test(JSON.stringify(linksMsg.body.reply_markup)));

  // 7. personal user auto-created in panel
  const state = await api('/api/state', { headers: { cookie } });
  check('personal user auto-created', state.users.some((u) => u.name === '@ali_tg'), state.users.map((u) => u.name).join(','));

  // 8. QR callback → sendPhoto (multipart png)
  await sendUpdate(cbq('qr:0'));
  const photo = await waitFor((c) => c.method === 'sendPhoto');
  check('QR button sends photo', !!photo && photo.body.multipart === true, photo ? photo.body.bytes + ' bytes' : '');

  // 9. sub links
  await sendUpdate(cbq('mysub'));
  const subMsg = await waitFor((c) => c.method === 'editMessageText' && /لینک‌های اشتراک/.test(c.body.text || ''));
  check('sub links view', !!subMsg && subMsg.body.text.includes('/sub/'));

  // 10. add-user conversation
  await sendUpdate(msg('/add'));
  await waitFor((c) => /نام کاربر/.test(c.body.text || '') && c.method === 'sendMessage');
  await sendUpdate(msg('maryam'));
  await waitFor((c) => /چند روز/.test(c.body.text || ''));
  await sendUpdate(msg('30'));
  await waitFor((c) => /چند گیگابایت/.test(c.body.text || ''));
  await sendUpdate(msg('2'));
  const added = await waitFor((c) => /کاربر <b>maryam<\/b> ساخته شد/.test(c.body.text || ''));
  check('add-user flow completes', !!added);
  const state2 = await api('/api/state', { headers: { cookie } });
  check('user visible in panel', state2.users.some((u) => u.name === 'maryam' && u.limitMB === 2048));

  // 11. status shows usage info
  await sendUpdate(msg('/status'));
  const st = await waitFor((c) => c.method === 'sendMessage' && /وضعیت شما/.test(c.body.text || ''));
  check('/status works', !!st);

  // 12. logout
  await sendUpdate(msg('/logout'));
  const out = await waitFor((c) => c.method === 'sendMessage' && /خارج شدید/.test(c.body.text || ''));
  check('logout works', !!out);
  await sendUpdate(msg('anything'));
  const askAgain = await waitFor((c) => /رمز عبور پنل را بفرستید|رمز عبور اشتباه/.test(c.body.text || ''));
  check('after logout, auth required again', !!askAgain);
} catch (e) {
  check('test suite crashed: ' + e.message, false);
} finally {
  wrangler.kill('SIGTERM');
  mock.close();
}

setTimeout(() => {
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}, 2500);
