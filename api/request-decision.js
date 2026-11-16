'use strict';
const { staffFromRequest, decideRequest } = require('./_lib');

// Решение по заявке на регистрацию из админки (админ или менеджер): одобрить создаёт клиента и возвращает его личную ссылку.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    if (!(await staffFromRequest(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0 || !['approve', 'reject'].includes(body.action)) return res.status(400).json({ ok: false, error: 'bad request' });
    const r = await decideRequest(id, body.action);
    if (r.status === 'already') return res.status(200).json({ ok: false, error: 'Заявка уже обработана (' + r.current + ')' });
    if (r.status === 'missing') return res.status(404).json({ ok: false, error: 'Заявка не найдена' });
    return res.status(200).json({ ok: true, status: r.status, link: r.link || null });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
