'use strict';
const { adminFromRequest, telegram, tgCall, webhookSecret, siteUrl, iiko, iikoConfigured } = require('./_lib');

// Проверка связи из админ-панели (только для администратора): Telegram и iiko.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    if (!(await adminFromRequest(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.what === 'telegram') {
      const t = await telegram('✅ Tasty Gourmet: проверка связи. Если вы видите это сообщение, уведомления об ошибках заказов будут приходить сюда.');
      return res.status(200).json({ ok: t.sent, message: t.sent ? 'Сообщение отправлено, проверьте Telegram' : t.reason });
    }
    if (body.what === 'telegram-webhook') {
      // подключает кнопки «Одобрить/Отклонить»; отказывается, если у бота уже стоит чужой webhook (например, n8n)
      const url = (siteUrl() || 'https://' + req.headers.host) + '/api/telegram';
      const info = await tgCall('getWebhookInfo', {});
      if (info.url && info.url !== url) return res.status(200).json({ ok: false, message: 'У этого бота уже подключён другой webhook (' + info.url + '). Скорее всего, он используется старым сайтом. Создайте отдельного бота для нового сайта, иначе старый сайт перестанет получать сообщения.' });
      await tgCall('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['callback_query'] });
      return res.status(200).json({ ok: true, message: 'Кнопки подключены: ' + url });
    }
    if (body.what === 'iiko') {
      if (!iikoConfigured()) return res.status(200).json({ ok: false, message: 'Не задан IIKO_API_LOGIN в переменных окружения Vercel' });
      const orgs = await iiko('/api/1/organizations', { returnAdditionalInfo: false, includeDisabled: false });
      const list = orgs.organizations || [];
      const tg = list.length ? await iiko('/api/1/terminal_groups', { organizationIds: list.map((o) => o.id) }) : { terminalGroups: [] };
      const lines = list.map((o) => {
        const g = ((tg.terminalGroups || []).find((x) => x.organizationId === o.id) || {}).items || [];
        return 'Организация: ' + o.name + ' — IIKO_ORGANIZATION_ID=' + o.id + (g.length ? '\n' + g.map((t) => '   Терминал: ' + t.name + ' — IIKO_TERMINAL_GROUP_ID=' + t.id).join('\n') : '');
      });
      return res.status(200).json({ ok: true, message: 'Связь с iiko есть.\n' + (lines.join('\n') || 'Организации не найдены') });
    }
    return res.status(400).json({ ok: false, message: 'unknown' });
  } catch (e) { return res.status(200).json({ ok: false, message: e.message }); }
};
