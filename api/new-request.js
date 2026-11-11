'use strict';
const { sb, telegram } = require('./_lib');

// Вызывается сайтом сразу после отправки заявки на регистрацию.
// Присылает в Telegram сообщение с кнопками «Одобрить» и «Отклонить». Каждая заявка уведомляется один раз.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false });
    // «занимаем» уведомление, чтобы повторные вызовы не слали дубли
    const claim = await sb('registration_requests?id=eq.' + id + '&status=eq.new&notified=eq.false', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ notified: true }) });
    if (!claim || !claim.length) return res.status(200).json({ ok: true, skipped: true });
    const r = claim[0];
    const t = await telegram(['📝 Заявка на регистрацию', 'Точка: ' + r.name, 'Телефон: ' + r.phone, 'Адрес: ' + (r.address || 'не указан'), r.contact_person ? 'Контакт: ' + r.contact_person : ''].filter(Boolean).join('\n'),
      { reply_markup: { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: 'ap:' + id }, { text: '❌ Отклонить', callback_data: 'rj:' + id }]] } });
    if (!t.sent) await sb('registration_requests?id=eq.' + id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ notified: false }) });
    return res.status(200).json({ ok: true, telegram: t });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
