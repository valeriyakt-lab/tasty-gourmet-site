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

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok ? { sent: true } : { sent: false, reason: j.description || 'Telegram вернул ошибку ' + r.status };
  } catch (e) { return { sent: false, reason: 'Нет связи с Telegram: ' + e.message }; }
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

module.exports = { sb, adminFromRequest, telegram, iiko, iikoConfigured, normPhone, need };
