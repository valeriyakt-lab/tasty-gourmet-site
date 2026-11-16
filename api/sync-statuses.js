'use strict';
const { sb, staffFromRequest, iiko, iikoIds, iikoConfigured } = require('./_lib');

// Статусы заказов берутся только из iiko. Вызывается при открытии «Заказов» в админке и «Мои заказы» у клиента
// (клиент передаёт свою ссылку и обновляет только свои заказы). Не чаще раза в 20 секунд.
const done = new Set(['Closed', 'Delivered']);
const map = (s) => (done.has(s) ? 'done' : s === 'Cancelled' ? 'cancelled' : 'accepted');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    let clientFilter = '';
    if (!(await staffFromRequest(req))) {
      const c = body.token ? ((await sb('clients?select=id&access_token=eq.' + encodeURIComponent(String(body.token)))) || [])[0] : null;
      if (!c) return res.status(401).json({ ok: false, error: 'unauthorized' });
      clientFilter = '&client_id=eq.' + c.id;
    }
    if (!iikoConfigured()) return res.status(200).json({ ok: true, skipped: 'iiko_not_configured' });

    const last = ((await sb('integration_settings?select=value&key=eq.status_sync_at')) || [])[0];
    if (last && Date.now() - Number(last.value) < 20000) return res.status(200).json({ ok: true, skipped: 'recent' });
    await sb('integration_settings', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'status_sync_at', value: Date.now(), updated_at: new Date().toISOString() }) });

    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    const rows = (await sb('orders?select=id,status,iiko_order_id&iiko_order_id=not.is.null&status=in.(new,accepted)&created_at=gte.' + since + clientFilter + '&order=created_at.desc&limit=60')) || [];
    const list = rows.filter((o) => /^[0-9a-f-]{36}$/i.test(o.iiko_order_id));
    if (!list.length) return res.status(200).json({ ok: true, checked: 0, changed: 0 });

    const ids = await iikoIds();
    let changed = 0;
    for (let i = 0; i < list.length; i += 20) {
      const part = list.slice(i, i + 20);
      const r = await iiko('/api/1/deliveries/by_id', { organizationId: ids.org, orderIds: part.map((o) => o.iiko_order_id) });
      for (const x of r.orders || []) {
        const o = part.find((p) => p.iiko_order_id === x.id);
        if (!o) continue;
        const next = x.creationStatus === 'Error' ? 'failed' : map(x.order && x.order.status);
        if (next !== o.status) {
          const patch = { status: next };
          if (next === 'failed') patch.iiko_error = 'iiko не создал заказ: ' + ((x.errorInfo && (x.errorInfo.message || x.errorInfo.description)) || 'неизвестная ошибка');
          await sb('orders?id=eq.' + o.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
          changed++;
        }
      }
    }
    return res.status(200).json({ ok: true, checked: list.length, changed });
  } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
