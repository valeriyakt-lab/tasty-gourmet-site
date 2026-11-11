'use strict';
const { sb, adminFromRequest, telegram, iiko, iikoIds, iikoConfigured } = require('./_lib');

// Обновление меню из iiko («внешнее меню», как в старом сайте).
// Вызывается: по расписанию (Vercel Cron, раз в сутки, нужен CRON_SECRET) и кнопкой в админке.
// Правила:
//  • цена блюда берётся из iiko;
//  • блюдо, которого больше нет в меню iiko, скрывается (и возвращается само, когда снова появится);
//  • блюдо, скрытое вручную, синхронизация не включает;
//  • новые блюда из iiko добавляются скрытыми, чтобы вы проверили их перед показом клиентам.
const stripNum = (s) => String(s || '').replace(/^\d+(\.\d+)*\s+/, '').trim();
const key = (s) => stripNum(s).toLowerCase().replace(/ё/g, 'е');

async function syncMenu() {
  const cfgRows = (await sb('integration_settings?select=key,value')) || [];
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
  const menuId = String(cfg.iiko_external_menu_id || '').trim();
  if (!menuId) throw new Error('Не задан код внешнего меню iiko (integration_settings → iiko_external_menu_id)');
  const groups = Array.isArray(cfg.iiko_menu_groups) ? cfg.iiko_menu_groups : [];
  const showNew = cfg.iiko_new_dishes === 'show';
  const priceCat = String(cfg.iiko_price_category_id || '').trim();

  const ids = await iikoIds();
  const num = (p) => { const v = p && typeof p === 'object' ? p.currentPrice : p; return Number(v); };
  const img = (x) => { const u = x.buttonImageUrl || (x.images && x.images[0] && (x.images[0].imageUrl || x.images[0].url)) || (x.itemSizes && x.itemSizes[0] && x.itemSizes[0].buttonImageUrl) || ''; return /^https?:\/\//.test(u) ? u : ''; };
  // формат 1 (как в сценарии n8n): itemsGroups[].items[] с productId и sizePrices
  const parseV3 = (m) => { const out = []; for (const g of m.itemsGroups || []) for (const x of g.items || []) {
    const id = x.productId || x.itemId, name = String(x.name || '').trim(); if (!id || !name) continue;
    const sizes = x.sizePrices || [], sz = sizes.find((q) => q.isDefault) || sizes[0] || {};
    out.push({ id, name, price: num(sz.price), group: stripNum(g.name), gid: g.id, image: img(x) }); } return out; };
  // формат 2 (iikoCloud /api/2/menu/by_id): itemCategories[].items[] с itemId и itemSizes[].prices[]
  const parseV2 = (m) => { const out = []; for (const g of m.itemCategories || []) for (const x of g.items || []) {
    const id = x.itemId || x.productId, name = String(x.name || '').trim(); if (!id || !name) continue;
    const sz = (x.itemSizes || []).find((q) => q.isDefault) || (x.itemSizes || [])[0] || {}, pr = (sz.prices || [])[0] || {};
    out.push({ id, name, price: num(pr.price), group: stripNum(g.name), gid: g.id, image: img(x) }); } return out; };

  const diag = [];
  let fromIiko = [];
  const attempts = [
    ['/api/menu/v3/by_id', { externalMenuId: menuId, organizationId: ids.org, ...(priceCat ? { priceCategoryId: priceCat } : {}) }, parseV3],
    ['/api/2/menu/by_id', { externalMenuId: menuId, organizationIds: [ids.org], ...(priceCat ? { priceCategoryId: priceCat } : {}) }, parseV2],
  ];
  for (const [path, body, parse] of attempts) {
    try {
      const m = await iiko(path, body);
      const got = parse(m);
      diag.push(path + ': блюд ' + got.length + (got.length ? '' : ' (поля ответа: ' + Object.keys(m).join(', ') + ')'));
      if (got.length) { fromIiko = got; break; }
    } catch (e) { diag.push(path + ': ' + e.message); }
  }
  if (!fromIiko.length) {
    let menus = '';
    try { const l = await iiko('/api/2/menu', {}); menus = ((l.externalMenus || []).map((x) => x.id + ' «' + x.name + '»').join('; ')) || 'список пуст'; } catch (e) { menus = 'не удалось получить (' + e.message + ')'; }
    throw new Error('Из iiko пришло 0 блюд для меню «' + menuId + '». ' + diag.join(' | ') + '. Доступные внешние меню: ' + menus);
  }
  // фильтр по группам применяем, только если он действительно подходит (иначе идентификаторы групп из старого сайта не совпадают с меню)
  if (groups.length) { const f = fromIiko.filter((x) => groups.includes(x.gid)); if (f.length >= 5) fromIiko = f; }

  const items = (await sb('menu_items?select=id,name,price,active,iiko_id,sync_hidden,category_id,image_url&iiko_id=not.is.null')) || [];
  // защита: если iiko вернул пустое или подозрительно короткое меню, ничего не меняем
  if (fromIiko.length < 5 || fromIiko.length < items.length * 0.5) throw new Error('Из iiko пришло ' + fromIiko.length + ' блюд (у нас ' + items.length + '): похоже на сбой, меню не изменено');

  const mine = Object.fromEntries(items.map((i) => [i.iiko_id, i]));
  const seen = new Set(), res = { prices: [], hidden: [], restored: [], added: [], noPrice: [], total: fromIiko.length };
  const priceUpdates = [], restoreIds = [], toAdd = [], photoUpdates = [];
  for (const x of fromIiko) {
    seen.add(x.id);
    const it = mine[x.id];
    if (!it) { toAdd.push(x); continue; }
    if (x.price > 0) { if (Number(it.price) !== x.price) { priceUpdates.push({ id: it.id, price: x.price }); res.prices.push(it.name + ': ' + Number(it.price) + ' → ' + x.price); } }
    else res.noPrice.push(it.name);
    if (!it.active && it.sync_hidden) { restoreIds.push(it.id); res.restored.push(it.name); }
    if (x.image && !it.image_url) photoUpdates.push({ id: it.id, image_url: x.image });
  }
  const hideIds = items.filter((i) => i.active && !seen.has(i.iiko_id));
  hideIds.forEach((i) => res.hidden.push(i.name));

  const patch = (q, body) => sb('menu_items?' + q, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  for (let i = 0; i < priceUpdates.length; i += 10) await Promise.all(priceUpdates.slice(i, i + 10).map((u) => patch('id=eq.' + u.id, { price: u.price, updated_at: new Date().toISOString() })));
  res.photos = photoUpdates.length;
  for (let i = 0; i < photoUpdates.length; i += 10) await Promise.all(photoUpdates.slice(i, i + 10).map((u) => patch('id=eq.' + u.id, { image_url: u.image_url })));
  if (restoreIds.length) await patch('id=in.(' + restoreIds.join(',') + ')', { active: true, sync_hidden: false });
  if (hideIds.length) await patch('id=in.(' + hideIds.map((i) => i.id).join(',') + ')', { active: false, sync_hidden: true });

  if (toAdd.length) {
    const cats = (await sb('categories?select=id,name&order=id')) || [];
    const byName = Object.fromEntries(cats.map((c) => [key(c.name), c.id]));
    let sort = 1000;
    for (const x of toAdd) {
      if (!byName[key(x.group)] && x.group) {
        const c = (await sb('categories', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: x.group, sort: 100 + Object.keys(byName).length }) }))[0];
        byName[key(x.group)] = c.id;
      }
    }
    await sb('menu_items', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(toAdd.map((x) => ({
      name: x.name, iiko_id: x.id, image_url: x.image || null, price: x.price > 0 ? x.price : 0, category_id: byName[key(x.group)] || null, sort: sort++, active: showNew && x.price > 0 })) ) });
    toAdd.forEach((x) => res.added.push(x.name));
  }

  res.at = new Date().toISOString();
  await sb('integration_settings', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'iiko_menu_last', value: res, updated_at: res.at }) });
  return res;
}

module.exports = async (req, res) => {
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET;
  try {
    if (!cron && !(await adminFromRequest(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!iikoConfigured()) return res.status(400).json({ ok: false, error: 'iiko не настроен: добавьте IIKO_API_LOGIN в переменные окружения Vercel' });
    const r = await syncMenu();
    if (r.added.length) await telegram('🆕 В меню iiko появились новые блюда (добавлены скрытыми, проверьте в админке → Меню):\n' + r.added.slice(0, 30).join('\n'));
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    await telegram('⚠️ Не удалось обновить меню из iiko: ' + e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
