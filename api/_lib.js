'use strict';
// Общие функции серверной части. Ключи берутся ТОЛЬКО из переменных окружения Vercel.
const SB_URL = (process.env.SUPABASE_URL || 'https://jllewvlpvlgylaaynztc.supabase.co').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IIKO_URL = (process.env.IIKO_BASE_URL || 'https://api-ru.iiko.services').replace(/\/$/, '');

const need = (v, name) => { if (!v) throw Object.assign(new Error('Не задана переменная окружения ' + name), { config: true }); return v; };

async function sb(path, opts = {}) {
  const key = need(SB_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!r.ok) throw new Error('База данных: ' + ((body && body.message) || r.status));
  return body;
}

// Кто вызывает: администратор (по сессии Supabase) или клиент (по личному токену)
async function adminFromRequest(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: need(SB_KEY, 'SUPABASE_SERVICE_ROLE_KEY'), Authorization: h } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.id) return null;
  const rows = await sb('admins?select=user_id&user_id=eq.' + encodeURIComponent(u.id));
  return rows && rows.length ? u : null;
}

// Подпись, с какого сайта пришло уведомление (у вас два сайта и один чат)
const siteLabel = () => '🆕 ' + (process.env.TELEGRAM_SITE_LABEL || 'Новый сайт Tasty Gourmet');
const siteUrl = () => (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/$/, '');

async function tgCall(method, payload) {
  const token = need(process.env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN');
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || 'Telegram вернул ошибку ' + r.status);
  return j.result;
}

async function telegram(text, opts = {}) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!process.env.TELEGRAM_BOT_TOKEN || !chat) return { sent: false, reason: 'Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' };
  try {
    const m = await tgCall('sendMessage', { chat_id: chat, text: (siteLabel() + '\n' + text).slice(0, 3900), disable_web_page_preview: true, ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}) });
    return { sent: true, message_id: m && m.message_id };
  } catch (e) { return { sent: false, reason: e.message }; }
}

// Секрет для проверки, что вызов пришёл именно от Telegram (отдельная переменная не нужна)
const webhookSecret = () => require('crypto').createHash('sha256').update(need(process.env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN') + ':tgw').digest('hex');

// Решение по заявке на регистрацию: одобрить (создаёт клиента) или отклонить
async function decideRequest(id, action) {
  const rid = encodeURIComponent(id);
  const claim = await sb('registration_requests?id=eq.' + rid + '&status=eq.new', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected' }) });
  if (!claim || !claim.length) {
    const ex = ((await sb('registration_requests?select=status&id=eq.' + rid)) || [])[0];
    return { status: ex ? 'already' : 'missing', current: ex && ex.status };
  }
  const r = claim[0];
  if (action !== 'approve') return { status: 'rejected', request: r };
  try {
    const c = (await sb('clients', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: r.name, phone: r.phone, contact_person: r.contact_person }) }))[0];
    if (r.address) await sb('client_addresses', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ client_id: c.id, address: r.address }) });
    await sb('registration_requests?id=eq.' + rid, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ client_id: c.id }) });
    return { status: 'approved', request: r, link: siteUrl() + '/?t=' + c.access_token };
  } catch (e) {
    await sb('registration_requests?id=eq.' + rid, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'new' }) }).catch(() => {});
    throw e;
  }
}

// Подтверждение клиенту в его личный Telegram («заказ принят» и сумма), как в старом сайте.
// Отправляется токеном СТАРОГО бота (TELEGRAM_CLIENT_BOT_TOKEN): клиенты подключали уведомления именно ему, а новому боту писать не могут.
const fmtMoney = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' тг';
async function notifyClient(order, phone) {
  const token = process.env.TELEGRAM_CLIENT_BOT_TOKEN;
  if (!token || !phone) return 0;
  const links = (await sb('tg_links?select=chat_id&phone=eq.' + encodeURIComponent(phone))) || [];
  if (!links.length) return 0;
  const day = new Date(order.created_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
  const qty = order.order_items.reduce((a, i) => a + Number(i.qty), 0);
  const text = ['✅ Tasty Gourmet: заказ №' + order.number + ' принят', '📅 ' + day, order.pickup ? '🏃 Самовывоз' : '📍 ' + order.address,
    ...order.order_items.map((i) => '• ' + i.name + ' × ' + i.qty), '', '💰 Сумма: ' + fmtMoney(order.total) + ' · ' + qty + ' шт'].join('\n');
  let n = 0;
  for (const l of links) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: l.chat_id, text: text.slice(0, 4000) }) });
      if (r.ok) n += 1;
    } catch (e) { /* клиент мог заблокировать бота: заказ от этого не страдает */ }
  }
  return n;
}

const iikoConfigured = () => !!process.env.IIKO_API_LOGIN;
let tokenCache = { t: null, exp: 0 };
// Авторизация как в рабочем сценарии n8n: если заданы IIKO_APP_ID и IIKO_CLIENT_SECRET, используется /api/v2/access_token, иначе стандартный /api/1/access_token
async function iikoToken() {
  if (tokenCache.t && Date.now() < tokenCache.exp) return tokenCache.t;
  const login = need(process.env.IIKO_API_LOGIN, 'IIKO_API_LOGIN');
  const v2 = process.env.IIKO_APP_ID && process.env.IIKO_CLIENT_SECRET;
  const r = await fetch(IIKO_URL + (v2 ? '/api/v2/access_token' : '/api/1/access_token'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(v2 ? { appId: process.env.IIKO_APP_ID, clientSecret: process.env.IIKO_CLIENT_SECRET, apiKey: login } : { apiLogin: login }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error('iiko: не удалось получить токен (' + (j.errorDescription || j.description || j.error || r.status) + ')');
  tokenCache = { t: j.token, exp: Date.now() + 50 * 60 * 1000 };
  return tokenCache.t;
}
async function iiko(path, body) {
  const token = await iikoToken();
  const r = await fetch(IIKO_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) tokenCache = { t: null, exp: 0 }; throw new Error('iiko ' + path + ': ' + (j.errorDescription || j.description || j.error || 'ошибка ' + r.status)); }
  return j;
}
// Организация и касса: из переменных окружения, а если не заданы и в iiko она единственная, берётся автоматически
let idsCache = null;
async function iikoIds() {
  if (idsCache) return idsCache;
  let org = process.env.IIKO_ORGANIZATION_ID, tg = process.env.IIKO_TERMINAL_GROUP_ID;
  if (!org) {
    const list = (await iiko('/api/1/organizations', { returnAdditionalInfo: false, includeDisabled: false })).organizations || [];
    if (list.length !== 1) throw new Error(list.length ? 'В iiko несколько организаций: задайте IIKO_ORGANIZATION_ID (его покажет «Проверить iiko»)' : 'Для этого apiLogin нет организаций');
    org = list[0].id;
  }
  if (!tg) {
    const items = ((await iiko('/api/1/terminal_groups', { organizationIds: [org] })).terminalGroups || []).flatMap((g) => g.items || []);
    if (items.length !== 1) throw new Error(items.length ? 'В iiko несколько касс: задайте IIKO_TERMINAL_GROUP_ID (его покажет «Проверить iiko»)' : 'В организации нет касс');
    tg = items[0].id;
  }
  return (idsCache = { org, tg });
}

// Адрес → улица / дом / квартира (та же логика, что в рабочем сценарии n8n)
function parseAddress(addr) {
  let a = String(addr || '').replace(/^(г\.?|город)\s*алматы,?\s*/i, ''), street = '', house = '', flat = '';
  const fm = a.match(/[,\s]+(?:кв\.?|квартира|оф\.?|офис)\s*([\w\/-]+)\s*$/i);
  if (fm) { flat = fm[1]; a = a.slice(0, fm.index); }
  const hm = a.match(/^(.*?)[,\s]+(?:д\.?\s*|дом\s*)?(\d+[А-Яа-яA-Za-z]?(?:[\/-]\d+[А-Яа-я]?)?)\s*$/);
  if (hm && hm[1].trim()) { street = hm[1].replace(/^(ул\.?|улица)\s*/i, '').replace(/,$/, '').trim(); house = hm[2]; }
  else { street = a.trim(); house = 'б/н'; }
  return { street, house, flat };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 ? '+7' + d.slice(1) : d.length === 10 ? '+7' + d : null; };

module.exports = { sb, adminFromRequest, telegram, tgCall, webhookSecret, decideRequest, siteUrl, iiko, iikoIds, iikoConfigured, parseAddress, sleep, normPhone, notifyClient, need };
