'use strict';
const { tgCall, webhookSecret, decideRequest } = require('./_lib');

// Приём нажатий кнопок в Telegram (webhook). Работает только для отдельного бота нового сайта.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).end();
    if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret()) return res.status(401).end();
    const u = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const cb = u.callback_query;
    if (!cb || !cb.message) return res.status(200).json({ ok: true });

    // кнопки принимаются только из настроенного чата (и, если задан список, только от указанных людей)
    const allowedChat = String(process.env.TELEGRAM_CHAT_ID || '');
    const approvers = (process.env.TELEGRAM_APPROVER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (String(cb.message.chat.id) !== allowedChat || (approvers.length && !approvers.includes(String(cb.from.id)))) {
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет прав', show_alert: true });
      return res.status(200).json({ ok: true });
    }
    const m = /^(ap|rj):(\d+)$/.exec(cb.data || '');
    if (!m) return res.status(200).json({ ok: true });

    const who = [cb.from.first_name, cb.from.username ? '@' + cb.from.username : ''].filter(Boolean).join(' ');
    let out;
    try { out = await decideRequest(m[2], m[1] === 'ap' ? 'approve' : 'reject'); }
    catch (e) { await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка: ' + e.message, show_alert: true }); return res.status(200).json({ ok: false }); }

    if (out.status === 'already' || out.status === 'missing') {
      await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: out.status === 'already' ? 'Заявка уже обработана' : 'Заявка не найдена' });
      await tgCall('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    const ok = out.status === 'approved';
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: ok ? 'Одобрено' : 'Отклонено' });
    await tgCall('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: (cb.message.text || '') + '\n\n' + (ok ? '✅ Одобрено' : '❌ Отклонено') + (who ? ' · ' + who : ''), reply_markup: { inline_keyboard: [] } });
    if (ok) await tgCall('sendMessage', { chat_id: cb.message.chat.id, text: 'Личная ссылка для входа клиента «' + out.request.name + '» (отправьте ему в WhatsApp):\n' + out.link, disable_web_page_preview: true });
    return res.status(200).json({ ok: true });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
