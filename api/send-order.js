'use strict';
const { sb, adminFromRequest, telegram, iiko, iikoIds, iikoConfigured, parseAddress, sleep, normPhone, notifyClient } = require('./_lib');

// Передача заказа на кассу iiko.
// Вызывает сайт (после оформления заказа клиентом) или администратор (кнопка «Отправить в iiko»).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });
  let order = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const admin = await adminFromRequest(req);
    const sel = '*,clients(name,phone,access_token),order_items(name,qty,price,menu_items(iiko_id,price))';
    if (admin) {
      const q = body.order_id ? 'id=eq.' + encodeURIComponent(body.order_id) : 'number=eq.' + encodeURIComponent(body.number || '');
      order = ((await sb('orders?select=' + sel + '&' + q)) || [])[0];
    } else if (body.token && body.number) {
      const c = ((await sb('clients?select=id&status=eq.active&access_token=eq.' + encodeURIComponent(body.token))) || [])[0];
      if (!c) return res.status(403).json({ ok: false, error: 'unauthorized' });
      order = ((await sb('orders?select=' + sel + '&client_id=eq.' + c.id + '&number=eq.' + encodeURIComponent(body.number))) || [])[0];
    } else return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
    if (order.iiko_order_id) return res.status(200).json({ ok: true, already: true, iiko_order_id: order.iiko_order_id });
    if (['cancelled'].includes(order.status)) return res.status(409).json({ ok: false, error: 'Заказ отменён' });

    if (!iikoConfigured()) {
      // касса ещё не подключена: заказ остаётся «новым» и обрабатывается вручную
      return res.status(admin ? 400 : 200).json({ ok: !admin, skipped: 'iiko_not_configured', error: admin ? 'iiko не настроен: добавьте IIKO_API_LOGIN в переменные окружения Vercel' : undefined });
    }

    const missing = order.order_items.filter((i) => !(i.menu_items && i.menu_items.iiko_id)).map((i) => i.name);
    if (missing.length) throw new Error('У блюд не задан iiko ID: ' + missing.join(', '));

    const phone = normPhone(order.clients && order.clients.phone);
    const ids = await iikoIds();
    const comment = [order.pickup ? 'САМОВЫВОЗ' : '', order.comment, order.pickup ? '' : 'Адрес: ' + order.address, 'Заказ с сайта № ' + order.number].filter(Boolean).join(' | ');
    const payload = {
      organizationId: ids.org,
      terminalGroupId: ids.tg,
      order: {
        ...(phone ? { phone } : {}),
        customer: { name: (order.clients && order.clients.name) || 'Клиент', type: 'regular' },
        orderServiceType: order.pickup ? 'DeliveryByClient' : 'DeliveryByCourier',
        comment,
        // цена передаётся только если она отличается от обычной (оптовая цена клиента), иначе берётся цена iiko
        items: order.order_items.map((i) => ({ productId: i.menu_items.iiko_id, type: 'Product', amount: i.qty, ...(Number(i.price) !== Number(i.menu_items.price) ? { price: Number(i.price) } : {}) })),
        ...(order.pickup ? {} : (() => { const a = parseAddress(order.address); return { deliveryPoint: { address: { street: { name: a.street, city: process.env.IIKO_CITY || 'Алматы' }, house: a.house, ...(a.flat ? { flat: a.flat } : {}) }, comment: order.address } }; })()),
      },
    };
    // оплата, как в старом сценарии: «Банковские карты» на всю сумму заказа
    const payName = process.env.IIKO_PAYMENT_NAME === undefined ? 'Банковские карты' : process.env.IIKO_PAYMENT_NAME;
    if (payName && Number(order.total) > 0) {
      const types = ((await iiko('/api/1/payment_types', { organizationIds: [ids.org] }).catch(() => ({}))).paymentTypes || []).filter((t) => !t.isDeleted);
      const w = payName.toLowerCase();
      const pt = types.find((t) => String(t.name).toLowerCase() === w) || types.find((t) => String(t.name).toLowerCase().includes(w)) || types.find((t) => t.paymentTypeKind === 'Card');
      if (pt) payload.order.payments = [{ paymentTypeKind: pt.paymentTypeKind || 'Card', sum: Number(order.total), paymentTypeId: pt.id, isProcessedExternally: false }];
    }
    const r = await iiko('/api/1/deliveries/create', payload);
    const iikoId = (r.orderInfo && r.orderInfo.id) || r.correlationId || 'ok';
    // как в старом сценарии: ждём, пока касса примет команду (до 6 проверок), и сообщаем об ошибке, если она есть
    for (let i = 0; i < 6 && r.correlationId; i++) {
      await sleep(Number(process.env.IIKO_POLL_MS === undefined ? 2000 : process.env.IIKO_POLL_MS));
      const st = await iiko('/api/1/commands/status', { organizationId: ids.org, correlationId: r.correlationId }).catch(() => null);
      if (!st || st.state === 'InProgress') continue;
      if (st.state !== 'Success') throw new Error('iiko: ' + ((st.exception && st.exception.message) || JSON.stringify(st.exception || st)));
      break;
    }
    await sb('orders?id=eq.' + order.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ iiko_order_id: String(iikoId), iiko_error: null, status: ['new', 'failed'].includes(order.status) ? 'accepted' : order.status }) });
    let notified = 0;
    try { notified = await notifyClient(order, phone); } catch (e) { /* подтверждение клиенту не должно ломать передачу заказа */ }
    return res.status(200).json({ ok: true, iiko_order_id: String(iikoId), client_notified: notified });
  } catch (e) {
    const msg = e.message || String(e);
    let tg = null;
    if (order) {
      try { await sb('orders?id=eq.' + order.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', iiko_error: msg.slice(0, 500) }) }); } catch (e2) { /* ошибку базы сообщит Telegram ниже */ }
    }
    tg = await telegram(['⚠️ Заказ не попал на кассу', order ? 'Заказ № ' + order.number + (order.clients ? ' · ' + order.clients.name : '') : 'Заказ не определён', 'Причина: ' + msg, order ? 'Отправьте заново в админ-панели (вкладка «Заказы»).' : ''].filter(Boolean).join('\n'));
    return res.status(e.config ? 500 : 502).json({ ok: false, error: msg, telegram: tg });
  }
};
