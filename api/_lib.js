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
    return { sent: true, message_id: m.message_id };
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

const iikoConfigured = () => !!process.env.IIKO_API_LOGIN;
let tokenCache = { t: null, exp: 0 };
async function iiko(path, body) {
  if (!tokenCache.t || Date.now() > tokenCache.exp) {
    const r = await fetch(IIKO_URL + '/api/1/access_token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiLogin: need(process.env.IIKO_API_LOGIN, 'IIKO_API_LOGIN') }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error('iiko: не удалось получить токен (' + (j.errorDescription || j.error || r.status) + ')');
    tokenCache = { t: j.token, exp: Date.now() + 50 * 60 * 1000 };
  }
  const r = await fetch(IIKO_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenCache.t }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) tokenCache = { t: null, exp: 0 }; throw new Error('iiko: ' + (j.errorDescription || j.error || 'ошибка ' + r.status)); }
  return j;
}

const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 ? '+7' + d.slice(1) : d.length === 10 ? '+7' + d : null; };

module.exports = { sb, adminFromRequest, telegram, tgCall, webhookSecret, decideRequest, siteUrl, iiko, iikoConfigured, normPhone, need };
