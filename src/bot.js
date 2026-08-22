/**
 * 🤖 Nexa Bot — Telegram interface for the Nexa panel, running inside the
 * same Worker (webhook-based, no polling server needed).
 *
 * Flow: user opens the bot → sends the panel password → gets a personal
 * config (auto-provisioned user) + subscription links + QR codes.
 * Anyone with the panel password is an admin (same trust model as the web panel).
 *
 * Storage (in the panel's KV, bot:* keys):
 *   bot:chat:<id>  → { auth:true, tg:{...}, until }        (30 days)
 *   bot:st:<id>    → { act, data, tries, blockedUntil }    (10 min TTL)
 */

import {
  loadSettings,
  loadUsers,
  saveUsers,
  saveSettingsPatch,
  effectivePwHash,
  ensureSubToken,
  userStatus,
  buildUserLinks,
  randomHex,
  genUuid,
  sha256Hex,
  timingSafeEq
} from './worker.js';
import { qrPng } from './png.js';

// ─────────────────── telegram api ───────────────────

async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const api = env.TELEGRAM_API || 'https://api.telegram.org';
  try {
    const r = await fetch(api + '/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, body);
    return await r.json();
  } catch {
    return null;
  }
}

function sendMsg(env, chatId, text, extra) {
  return tg(env, 'sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(extra || {})
    })
  });
}

function editMsg(env, chatId, messageId, text, extra) {
  return tg(env, 'editMessageText', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) })
  });
}

function answerCb(env, id, text) {
  return tg(env, 'answerCallbackQuery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, ...(text ? { text } : {}) })
  });
}

async function sendQr(env, chatId, text, caption) {
  try {
    const png = await qrPng(text);
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) {
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
    }
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'nexa-qr.png');
    return await tg(env, 'sendPhoto', { method: 'POST', body: fd });
  } catch (e) {
    return sendMsg(env, chatId, '❌ ساخت QR ممکن نشد: ' + esc(e.message || ''));
  }
}

export async function webhookSecret(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return (await sha256Hex('nexa:tg:' + env.TELEGRAM_BOT_TOKEN)).slice(0, 32);
}

// ─────────────────── tiny helpers ───────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const mem = new Map(); // in-memory fallback when KV is not bound

async function kvGet(env, key) {
  if (env.KV) {
    try {
      const v = await env.KV.get(key);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  return mem.get(key) || null;
}

async function kvPut(env, key, val, ttlSec) {
  const obj = JSON.stringify(val);
  if (env.KV) {
    try {
      await env.KV.put(key, obj, ttlSec ? { expirationTtl: Math.max(ttlSec, 60) } : undefined);
      return;
    } catch {}
  }
  mem.set(key, val);
  if (ttlSec) setTimeout(() => mem.delete(key), ttlSec * 1000);
}

async function kvDel(env, key) {
  if (env.KV) {
    try {
      await env.KV.delete(key);
    } catch {}
  }
  mem.delete(key);
}

function fmtMB(mb) {
  if (mb == null) return 'نامحدود';
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return (mb || 0).toFixed(1) + ' MB';
}

function fmtDate(ts) {
  if (!ts) return 'نامحدود';
  try {
    return new Date(ts).toLocaleDateString('fa-IR');
  } catch {
    return String(ts);
  }
}

async function panelHost(env, settings) {
  return settings.botHost || env.PANEL_HOST || '';
}

// ─────────────────── auth ───────────────────

async function getChat(env, chatId) {
  const c = await kvGet(env, 'bot:chat:' + chatId);
  if (c && c.auth && c.until > Date.now()) return c;
  return null;
}

async function authChat(env, chatId, from) {
  await kvPut(env, 'bot:chat:' + chatId, { auth: true, tg: { id: from.id, name: from.first_name || '', username: from.username || '' }, until: Date.now() + 30 * 86400000 });
}

async function getState(env, chatId) {
  return (await kvGet(env, 'bot:st:' + chatId)) || { act: null, data: {} };
}
async function setState(env, chatId, st) {
  await kvPut(env, 'bot:st:' + chatId, st, 600);
}
async function clearState(env, chatId) {
  await kvDel(env, 'bot:st:' + chatId);
}

// ─────────────────── personal user ───────────────────

async function personalUser(env, chat) {
  const users = await loadUsers(env, '');
  const found = users.find((u) => u.tgChat === chat.id);
  if (found) return { user: found, users, created: false };
  if (!env.KV) return { user: users[0], users, created: false }; // single-user mode
  // prefer the identity stored at login time (@username > first name > tg-<id>)
  const rec = await kvGet(env, 'bot:chat:' + chat.id);
  const tgInfo = (rec && rec.tg) || {};
  const name = (tgInfo.username ? '@' + tgInfo.username : tgInfo.name || 'tg-' + chat.id).slice(0, 40);
  const user = {
    name,
    uuid: genUuid(),
    createdAt: Date.now(),
    expiry: null,
    limitMB: null,
    usedMB: 0,
    tgChat: chat.id
  };
  users.push(user);
  await saveUsers(env, users);
  return { user, users, created: true };
}

// ─────────────────── keyboards ───────────────────

function kbMenu() {
  return {
    inline_keyboard: [
      [{ text: '📡 کانکشن‌های من', callback_data: 'mylinks' }, { text: '📱 لینک اشتراک', callback_data: 'mysub' }],
      [{ text: '📊 وضعیت من', callback_data: 'mystatus' }, { text: '👥 کاربران', callback_data: 'users' }],
      [{ text: '⚙️ تنظیمات', callback_data: 'settings' }, { text: '❓ راهنما', callback_data: 'help' }]
    ]
  };
}

function kbBack() {
  return { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: 'menu' }]] };
}

async function editOrSend(env, chatId, messageId, text, markup) {
  const r = await editMsg(env, chatId, messageId, text, { reply_markup: markup });
  if (!r || !r.ok) return sendMsg(env, chatId, text, { reply_markup: markup });
  return r;
}

// ─────────────────── views ───────────────────

async function viewMenu(env, chatId) {
  const settings = await loadSettings(env);
  const host = await panelHost(env, settings);
  return sendMsg(env, chatId,
    '⚡ <b>پنل Nexa</b>\n\n' +
    (host ? '🌐 آدرس پنل: <code>' + esc(host) + '</code>\n' : '') +
    'از دکمه‌های زیر استفاده کنید:',
    { reply_markup: kbMenu() });
}

async function viewMyLinks(env, chatId, edit, messageId) {
  const chat = { id: chatId };
  const settings = await loadSettings(env);
  const host = await panelHost(env, settings);
  if (!host) return sendMsg(env, chatId, '❌ آدرس پنل تنظیم نشده. ابتدا از تب تنظیمات پنل وب، ربات را وصل کنید.');
  const { user, created } = await personalUser(env, chat);
  const links = buildUserLinks(host, settings, user);
  let text =
    (created ? '✅ کاربر اختصاصی شما ساخته شد!\n\n' : '') +
    '📡 <b>کانکشن‌های شما</b> (کاربر: ' + esc(user.name) + ')\n\n' +
    links.map((l, i) => '▪️ <b>' + esc(l.label) + '</b>\n<code>' + esc(l.link) + '</code>').join('\n\n') +
    '\n\nبرای دریافت QR هر کانکشن روی شماره آن بزنید:';
  const rows = [];
  const btns = links.slice(0, 16).map((l, i) => ({ text: '📷 ' + (i + 1), callback_data: 'qr:' + i }));
  for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu' }]);
  const markup = { inline_keyboard: rows };
  if (edit) return editOrSend(env, chatId, messageId, text, markup);
  return sendMsg(env, chatId, text, { reply_markup: markup });
}

async function viewMySub(env, chatId, edit, messageId) {
  const settings = await loadSettings(env);
  const host = await panelHost(env, settings);
  if (!host) return sendMsg(env, chatId, '❌ آدرس پنل تنظیم نشده است.');
  const token = await ensureSubToken(env, settings, host);
  const urls = {
    v2ray: 'https://' + host + '/sub/' + token,
    clash: 'https://' + host + '/sub/' + token + '?format=clash',
    singbox: 'https://' + host + '/sub/' + token + '?format=singbox'
  };
  const text =
    '📱 <b>لینک‌های اشتراک</b>\n\n' +
    '🔹 v2ray / v2rayNG / Streisand:\n<code>' + esc(urls.v2ray) + '</code>\n\n' +
    '🔹 Clash Meta:\n<code>' + esc(urls.clash) + '</code>\n\n' +
    '🔹 sing-box:\n<code>' + esc(urls.singbox) + '</code>\n\n' +
    'لینک اشتراک را در اپلیکیشن Add subscription کنید؛ کانکشن‌ها خودکار به‌روز می‌مانند.';
  const markup = {
    inline_keyboard: [
      [{ text: '📷 QR v2ray', callback_data: 'qrs:v2ray' }, { text: '📷 QR Clash', callback_data: 'qrs:clash' }, { text: '📷 QR sing-box', callback_data: 'qrs:singbox' }],
      [{ text: '🔙 بازگشت', callback_data: 'menu' }]
    ]
  };
  if (edit) return editOrSend(env, chatId, messageId, text, markup);
  return sendMsg(env, chatId, text, { reply_markup: markup });
}

async function viewMyStatus(env, chatId, edit, messageId) {
  const { user, users } = await personalUser(env, { id: chatId });
  const st = userStatus(user);
  const status = st === 'ok' ? '✅ فعال' : st === 'expiry' ? '⛔️ منقضی' : '⛔️ حجم پر شده';
  const text =
    '📊 <b>وضعیت شما</b>\n\n' +
    '👤 کاربر: <b>' + esc(user.name) + '</b>\n' +
    '🆔 UUID: <code>' + esc(user.uuid) + '</code>\n' +
    '📈 مصرف: <b>' + fmtMB(user.usedMB) + '</b>' + (user.limitMB ? ' از ' + fmtMB(user.limitMB) : '') + '\n' +
    '📅 انقضا: <b>' + fmtDate(user.expiry) + '</b>\n' +
    '🔘 وضعیت: ' + status + '\n\n' +
    '👥 کل کاربران پنل: ' + users.length;
  if (edit) return editMsg(env, chatId, messageId, text, { reply_markup: kbBack() });
  return sendMsg(env, chatId, text, { reply_markup: kbBack() });
}

async function viewUsers(env, chatId, edit, messageId) {
  const users = await loadUsers(env, '');
  const lines = users.map((u, i) => {
    const st = userStatus(u);
    const emoji = st === 'ok' ? '🟢' : '🔴';
    return emoji + ' <b>' + esc(u.name) + '</b> — ' + fmtMB(u.usedMB) + (u.limitMB ? ' / ' + fmtMB(u.limitMB) : '') + ' — انقضا: ' + fmtDate(u.expiry) + (u.tgChat ? ' 🤖' : '');
  });
  const text =
    '👥 <b>کاربران پنل</b> (' + users.length + ')\n\n' + lines.join('\n') +
    '\n\n🗑 برای حذف، کنار نام کاربر بزنید. ➕ برای افزودن.';
  const rows = users.slice(0, 24).map((u) => [{ text: '🗑 ' + u.name.slice(0, 24), callback_data: 'del:' + u.uuid.slice(0, 8) }]);
  rows.push([{ text: '➕ افزودن کاربر', callback_data: 'add' }, { text: '🔄 توکن اشتراک جدید', callback_data: 'token' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu' }]);
  if (edit) return editOrSend(env, chatId, messageId, text, { inline_keyboard: rows });
  return sendMsg(env, chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function viewSettings(env, chatId, edit, messageId) {
  const settings = await loadSettings(env);
  const text =
    '⚙️ <b>تنظیمات پنل</b>\n\n' +
    '🌐 ProxyIP: <code>' + esc(settings.proxyIP || 'غیرفعال') + '</code>\n' +
    '🔀 مسیر وب‌سوکت: <code>' + esc(settings.wsPath) + '</code>\n' +
    '🧹 IPهای تمیز: <b>' + settings.cleanIPs.length + ' مورد</b>';
  const markup = {
    inline_keyboard: [
      [{ text: '🌐 تغییر ProxyIP', callback_data: 'nip' }, { text: '🧹 ویرایش IPهای تمیز', callback_data: 'ips' }],
      [{ text: '🔙 بازگشت', callback_data: 'menu' }]
    ]
  };
  if (edit) return editOrSend(env, chatId, messageId, text, markup);
  return sendMsg(env, chatId, text, { reply_markup: markup });
}

const HELP_TEXT =
  '❓ <b>راهنمای ربات Nexa</b>\n\n' +
  '1. برای ورود، رمز عبور پنل را بفرستید (همان رمز ورود به پنل وب).\n' +
  '2. از «کانکشن‌های من» لینک اختصاصی خودتان را بگیرید — دکمه 📷 QR هر کانکشن را برای اسکن می‌فرستد.\n' +
  '3. «لینک اشتراک» را در v2rayNG / Hiddify / Streisand / Clash اضافه کنید.\n' +
  '4. هر کسی که رمز پنل را داشته باشد مدیر است و می‌تواند کاربر اضافه/حذف کند.\n\n' +
  '📌 اگر متن یک لینک vless یا لینک اشتراک را بفرستید، QR آن را می‌گیرید.\n' +
  '🔐 /logout — خروج از ربات\n' +
  'ℹ️ برای امنیت بیشتر، از چت مخفی (Secret Chat) استفاده کنید.';

// ─────────────────── flows ───────────────────

async function askPassword(env, chatId) {
  await setState(env, chatId, { act: 'pw', data: { tries: 0 }, until: 0 });
  return sendMsg(env, chatId,
    '🔒 <b>ورود به پنل Nexa</b>\n\nرمز عبور پنل را بفرستید:\n(لغو: /cancel)', { reply_markup: { inline_keyboard: [[{ text: '❌ لغو', callback_data: 'cancel' }]] } });
}

async function tryPassword(env, chatId, text, from) {
  const st = await getState(env, chatId);
  if (st.blockedUntil && st.blockedUntil > Date.now()) {
    return sendMsg(env, chatId, '⛔️ تلاش‌های ناموفق زیاد بود. ۱۰ دقیقه صبر کنید.');
  }
  const hash = await sha256Hex('nexa:pw:' + text);
  const settings = await loadSettings(env);
  const target = await effectivePwHash(env, settings);
  if (timingSafeEq(hash, target)) {
    await clearState(env, chatId);
    await authChat(env, chatId, from || { id: chatId });
    return viewMenu(env, chatId);
  }
  const tries = (st.data.tries || 0) + 1;
  if (tries >= 5) {
    await setState(env, chatId, { act: 'pw', data: { tries: 0 }, blockedUntil: Date.now() + 600000 });
    return sendMsg(env, chatId, '⛔️ ۵ بار اشتباه! ۱۰ دقیقه صبر کنید.');
  }
  await setState(env, chatId, { act: 'pw', data: { tries } });
  return sendMsg(env, chatId, '❌ رمز اشتباه است (' + tries + '/5). دوباره بفرستید یا /cancel بزنید.');
}

// add-user conversation
async function startAddUser(env, chatId) {
  if (!env.KV) return sendMsg(env, chatId, '⛔️ افزودن کاربر نیاز به KV دارد.');
  await setState(env, chatId, { act: 'add_name', data: {} });
  return sendMsg(env, chatId, '➕ <b>افزودن کاربر</b>\n\n۱/۳ — نام کاربر را بفرستید:', { reply_markup: kbBack() });
}

async function addUserStep(env, chatId, text) {
  const st = await getState(env, chatId);
  if (st.act === 'add_name') {
    st.act = 'add_days';
    st.data.name = text.trim().slice(0, 40);
    await setState(env, chatId, st);
    return sendMsg(env, chatId, '۲/۳ — چند روز اعتبار داشته باشد؟ (عدد — ۰ = نامحدود):');
  }
  if (st.act === 'add_days') {
    const days = parseInt(text, 10);
    if (isNaN(days) || days < 0) return sendMsg(env, chatId, '❌ فقط عدد بفرستید (۰ = نامحدود):');
    st.act = 'add_gb';
    st.data.days = days;
    await setState(env, chatId, st);
    return sendMsg(env, chatId, '۳/۳ — سقف حجم چند گیگابایت؟ (عدد — ۰ = نامحدود):');
  }
  if (st.act === 'add_gb') {
    const gb = parseFloat(text);
    if (isNaN(gb) || gb < 0) return sendMsg(env, chatId, '❌ فقط عدد بفرستید (۰ = نامحدود):');
    const users = await loadUsers(env, '');
    const user = {
      name: st.data.name,
      uuid: genUuid(),
      createdAt: Date.now(),
      expiry: st.data.days > 0 ? Date.now() + st.data.days * 86400000 : null,
      limitMB: gb > 0 ? Math.round(gb * 1024) : null,
      usedMB: 0
    };
    users.push(user);
    await saveUsers(env, users);
    await clearState(env, chatId);
    return sendMsg(env, chatId,
      '✅ کاربر <b>' + esc(user.name) + '</b> ساخته شد.\n' +
      '🆔 UUID: <code>' + esc(user.uuid) + '</code>\n' +
      '📅 انقضا: ' + fmtDate(user.expiry) + '\n' +
      '📦 سقف: ' + fmtMB(user.limitMB) + '\n\n' +
      'لینک‌های این کاربر از تب «کاربران» پنل وب یا با /links قابل مشاهده‌اند.', { reply_markup: kbBack() });
  }
}

// delete-user flow
async function confirmDelete(env, chatId, short) {
  const users = await loadUsers(env, '');
  if (users.length <= 1) return sendMsg(env, chatId, '⛔️ حداقل یک کاربر باید بماند.');
  const u = users.find((x) => x.uuid.slice(0, 8) === short);
  if (!u) return sendMsg(env, chatId, '❌ کاربر پیدا نشد.');
  await setState(env, chatId, { act: 'del', data: { uuid: u.uuid } });
  return sendMsg(env, chatId,
    '🗑 حذف کاربر <b>' + esc(u.name) + '</b>؟\nکانکشن‌های این کاربر بلافاصله قطع می‌شوند.',
    { reply_markup: { inline_keyboard: [[{ text: '✅ بله، حذف کن', callback_data: 'dely' }, { text: '❌ انصراف', callback_data: 'users' }]] } });
}

async function doDelete(env, chatId) {
  const st = await getState(env, chatId);
  const users = await loadUsers(env, '');
  const next = users.filter((u) => u.uuid !== st.data.uuid);
  if (next.length === users.length || !next.length) return sendMsg(env, chatId, '❌ حذف انجام نشد.');
  await saveUsers(env, next);
  await clearState(env, chatId);
  return viewUsers(env, chatId, false, 0);
}

// settings flows
async function setProxyIPFlow(env, chatId) {
  await setState(env, chatId, { act: 'set_ip', data: {} });
  return sendMsg(env, chatId, '🌐 آدرس ProxyIP را بفرستید (یا «off» برای غیرفعال کردن):', { reply_markup: kbBack() });
}

async function setCleanIPsFlow(env, chatId) {
  await setState(env, chatId, { act: 'set_ips', data: {} });
  const settings = await loadSettings(env);
  return sendMsg(env, chatId,
    '🧹 IPها/دامنه‌های تمیز را هر کدام در یک خط بفرستید:\n\n<code>' + esc(settings.cleanIPs.join('\n')) + '</code>',
    { reply_markup: kbBack() });
}

async function regenerateToken(env, chatId) {
  if (!env.KV) return sendMsg(env, chatId, '⛔️ نیاز به KV دارد.');
  const t = randomHex(16);
  await saveSettingsPatch(env, { subToken: t });
  return sendMsg(env, chatId, '✅ توکن اشتراک جدید ساخته شد. لینک‌های قبلی نامعتبرند.', { reply_markup: kbBack() });
}

// ─────────────────── update dispatcher ───────────────────

export async function handleTelegramUpdate(update, env /*, ctx*/) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const cb = update.callback_query;
    if (cb && cb.message) return handleCallback(env, cb);
    const msg = update.message;
    if (!msg || !msg.text) return;
    return handleMessage(env, msg);
  } catch (e) {
    try { console.error('nexa-bot error', e && e.message); } catch {}
  }
}

async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const chat = await getChat(env, chatId);

  // global commands
  if (cmd === '/start') {
    if (chat) return viewMenu(env, chatId);
    return askPassword(env, chatId);
  }
  if (cmd === '/cancel') {
    await clearState(env, chatId);
    return chat ? viewMenu(env, chatId) : askPassword(env, chatId);
  }
  if (!chat) {
    if (cmd === '/help') return askPassword(env, chatId);
    return tryPassword(env, chatId, text, msg.from); // unauthenticated: treat any text as password attempt
  }

  // authenticated commands
  if (cmd === '/logout') {
    await kvDel(env, 'bot:chat:' + chatId);
    await clearState(env, chatId);
    return sendMsg(env, chatId, '👋 خارج شدید. برای ورود دوباره /start بزنید.');
  }
  if (cmd === '/menu' || cmd === '/home') return viewMenu(env, chatId);
  if (cmd === '/links') return viewMyLinks(env, chatId, false, 0);
  if (cmd === '/sub') return viewMySub(env, chatId, false, 0);
  if (cmd === '/status') return viewMyStatus(env, chatId, false, 0);
  if (cmd === '/users') return viewUsers(env, chatId, false, 0);
  if (cmd === '/add') return startAddUser(env, chatId);
  if (cmd === '/token') return regenerateToken(env, chatId);
  if (cmd === '/proxyip') return setProxyIPFlow(env, chatId);
  if (cmd === '/ips') return setCleanIPsFlow(env, chatId);
  if (cmd === '/help') return sendMsg(env, chatId, HELP_TEXT);

  // conversation states
  const st = await getState(env, chatId);
  if (st.act === 'add_name' || st.act === 'add_days' || st.act === 'add_gb') return addUserStep(env, chatId, text);
  if (st.act === 'set_ip') {
    await clearState(env, chatId);
    const v = text.trim().toLowerCase() === 'off' ? '' : text.trim();
    const ok = await saveSettingsPatch(env, { proxyIP: v });
    if (!ok) return sendMsg(env, chatId, '⛔️ ذخیره تنظیمات نیاز به KV دارد.');
    return sendMsg(env, chatId, '✅ ProxyIP به‌روز شد: <code>' + esc(v || 'غیرفعال') + '</code>', { reply_markup: kbBack() });
  }
  if (st.act === 'set_ips') {
    const ips = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!ips.length) return sendMsg(env, chatId, '❌ حداقل یک IP بفرستید (هر خط یکی):');
    const ok = await saveSettingsPatch(env, { cleanIPs: ips });
    if (!ok) return sendMsg(env, chatId, '⛔️ ذخیره تنظیمات نیاز به KV دارد.');
    await clearState(env, chatId);
    return sendMsg(env, chatId, '✅ ' + ips.length + ' IP تمیز ذخیره شد.', { reply_markup: kbBack() });
  }

  // convenience: QR for any pasted vless/sub link
  if (/^vless:\/\//i.test(text) || /\/sub\/[a-f0-9]{16,}/i.test(text)) {
    return sendQr(env, chatId, text.split(/\s+/)[0], '📷 QR لینک شما');
  }

  return sendMsg(env, chatId, 'دستور را متوجه نشدم 🤔\n/menu را بزنید یا /help را ببینید.');
}

async function handleCallback(env, cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data || '';
  const chat = await getChat(env, chatId);
  if (!chat) {
    await answerCb(env, cb.id, 'نشست شما منقضی شده — /start بزنید');
    return sendMsg(env, chatId, '🔒 برای ادامه، رمز عبور پنل را بفرستید یا /start بزنید.');
  }

  // menu navigation
  if (data === 'menu') { await clearState(env, chatId); await answerCb(env, cb.id); return viewMenu(env, chatId); }
  if (data === 'cancel') { await clearState(env, chatId); await answerCb(env, cb.id); return askPassword(env, chatId); }
  if (data === 'mylinks') { await answerCb(env, cb.id); return viewMyLinks(env, chatId, true, cb.message.message_id); }
  if (data === 'mysub') { await answerCb(env, cb.id); return viewMySub(env, chatId, true, cb.message.message_id); }
  if (data === 'mystatus') { await answerCb(env, cb.id); return viewMyStatus(env, chatId, true, cb.message.message_id); }
  if (data === 'users') { await clearState(env, chatId); await answerCb(env, cb.id); return viewUsers(env, chatId, true, cb.message.message_id); }
  if (data === 'settings') { await clearState(env, chatId); await answerCb(env, cb.id); return viewSettings(env, chatId, true, cb.message.message_id); }
  if (data === 'help') { await answerCb(env, cb.id); return sendMsg(env, chatId, HELP_TEXT, { reply_markup: kbBack() }); }

  if (data === 'add') { await answerCb(env, cb.id); return startAddUser(env, chatId); }
  if (data === 'nip') { await answerCb(env, cb.id); return setProxyIPFlow(env, chatId); }
  if (data === 'ips') { await answerCb(env, cb.id); return setCleanIPsFlow(env, chatId); }
  if (data === 'token') {
    await answerCb(env, cb.id);
    return sendMsg(env, chatId, '🔄 توکن اشتراک جدید ساخته شود؟ لینک‌های اشتراک قبلی نامعتبر می‌شوند.', {
      reply_markup: { inline_keyboard: [[{ text: '✅ بله، بساز', callback_data: 'tokeny' }, { text: '❌ انصراف', callback_data: 'users' }]] }
    });
  }
  if (data === 'tokeny') { await answerCb(env, cb.id); return regenerateToken(env, chatId); }

  if (data.startsWith('del:')) {
    await answerCb(env, cb.id);
    return confirmDelete(env, chatId, data.slice(4));
  }
  if (data === 'dely') { await answerCb(env, cb.id); return doDelete(env, chatId); }

  if (data.startsWith('qr:')) {
    const idx = parseInt(data.slice(3), 10) || 0;
    const settings = await loadSettings(env);
    const host = await panelHost(env, settings);
    if (!host) { await answerCb(env, cb.id, 'آدرس پنل تنظیم نشده'); return; }
    const { user } = await personalUser(env, { id: chatId });
    const links = buildUserLinks(host, settings, user);
    const link = links[idx];
    if (!link) { await answerCb(env, cb.id, 'لینک پیدا نشد'); return; }
    await answerCb(env, cb.id);
    return sendQr(env, chatId, link.link, '📷 <b>' + esc(link.label) + '</b>');
  }

  if (data.startsWith('qrs:')) {
    const fmt = data.slice(4);
    const settings = await loadSettings(env);
    const host = await panelHost(env, settings);
    const token = await ensureSubToken(env, settings, host || 'x');
    const url = 'https://' + host + '/sub/' + token + (fmt !== 'v2ray' ? '?format=' + fmt : '');
    await answerCb(env, cb.id);
    return sendQr(env, chatId, url, '📷 لینک اشتراک ' + esc(fmt));
  }

  await answerCb(env, cb.id);
}
