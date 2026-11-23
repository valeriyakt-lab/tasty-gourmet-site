'use strict';
const { sb, adminFromRequest, telegram, iiko, iikoIds, iikoConfigured } = require('./_lib');
const MenuOrder = require('../menu-order.js');

// Обновление меню из iiko («внешнее меню», как в старом сайте).
// Вызывается: по расписанию (Vercel Cron, раз в сутки, нужен CRON_SECRET) и кнопкой в админке.
// Правила:
//  • цена блюда берётся из iiko;
//  • блюдо, которого больше нет в меню iiko, скрывается (и возвращается само, когда снова появится);
//  • блюдо, скрытое вручную, синхронизация не включает;
//  • новые блюда из iiko добавляются скрытыми, чтобы вы проверили их перед показом клиентам.
const stripNum = (s) => String(s || '').replace(/^\d+(\.\d+)*\s+/, '').trim();
const key = (s) => stripNum(s).toLowerCase().replace(/ё/g, 'е');
const ckey = (s) => key(s).replace(/[^a-zа-я0-9]/g, '');
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
// «Салат и боул» и «Салаты и боул», «Онигири,ролл» и «Онигири, ролл» считаются одной категорией
function findCat(cats, name) {
  const k = ckey(name); if (!k) return null;
  return cats.find((c) => c.k === k) || (k.length >= 8 ? cats.find((c) => c.k.length >= 8 && lev(c.k, k) <= 2) : null) || null;
}

async function syncMenu() {
  const cfgRows = (await sb('integration_settings?select=key,value')) || [];
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
  const menuId = String(cfg.iiko_external_menu_id || '').trim();
  if (!menuId) throw new Error('Не задан код внешнего меню iiko (integration_settings → iiko_external_menu_id)');
  const showNew = cfg.iiko_new_dishes !== 'hide';   // по умолчанию новое блюдо с ценой сразу в меню, как в старом сайте
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
  // выбранное в админке меню iiko и есть источник правды: никаких дополнительных фильтров по группам

  const items = (await sb('menu_items?select=id,name,price,active,iiko_id,sync_hidden,category_id,image_url&iiko_id=not.is.null')) || [];
  // защита: если iiko вернул пустое или подозрительно короткое меню, ничего не меняем
  if (fromIiko.length < 5 || fromIiko.length < items.length * 0.2) throw new Error('Из iiko пришло ' + fromIiko.length + ' блюд (у нас ' + items.length + '): похоже на сбой, меню не изменено');

  const mine = Object.fromEntries(items.map((i) => [i.iiko_id, i]));
  const seen = new Set(), res = { prices: [], hidden: [], restored: [], added: [], noPrice: [], total: fromIiko.length };
  const idsNow = new Set(fromIiko.map((x) => x.id));
  const byNameFree = new Map();
  for (const i of items) { if (idsNow.has(i.iiko_id)) continue; const k = key(i.name); if (!byNameFree.has(k)) byNameFree.set(k, []); byNameFree.get(k).push(i); }
  const rebinds = [];
  const priceUpdates = [], restoreIds = [], toAdd = [], photoUpdates = [];
  for (const x of fromIiko) {
    seen.add(x.id);
    let it = mine[x.id];
    if (!it) {
      // в другом недельном меню iiko у того же блюда другой ID: ищем по названию и перепривязываем, а не плодим дубли
      const byName = byNameFree.get(key(x.name));
      if (byName && byName.length) { it = byName.shift(); rebinds.push({ id: it.id, iiko_id: x.id }); it = { ...it, iiko_id: x.id }; }
    }
    if (!it) { toAdd.push(x); continue; }
    if (x.price > 0) { if (Number(it.price) !== x.price) { priceUpdates.push({ id: it.id, price: x.price }); res.prices.push(it.name + ': ' + Number(it.price) + ' → ' + x.price); } }
    else res.noPrice.push(it.name);
    if (!it.active && it.sync_hidden) { restoreIds.push(it.id); res.restored.push(it.name); }
    if (x.image && !it.image_url) photoUpdates.push({ id: it.id, image_url: x.image });
  }
  const reboundIds = new Set(rebinds.map((r) => r.id));
  const hideIds = items.filter((i) => i.active && !seen.has(i.iiko_id) && !reboundIds.has(i.id));
  hideIds.forEach((i) => res.hidden.push(i.name));

  const patch = (q, body) => sb('menu_items?' + q, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  for (const r of rebinds) await patch('id=eq.' + r.id, { iiko_id: r.iiko_id });
  res.rebound = rebinds.length;
  for (let i = 0; i < priceUpdates.length; i += 10) await Promise.all(priceUpdates.slice(i, i + 10).map((u) => patch('id=eq.' + u.id, { price: u.price, updated_at: new Date().toISOString() })));
  res.photos = photoUpdates.length;
  for (let i = 0; i < photoUpdates.length; i += 10) await Promise.all(photoUpdates.slice(i, i + 10).map((u) => patch('id=eq.' + u.id, { image_url: u.image_url })));
  if (restoreIds.length) await patch('id=in.(' + restoreIds.join(',') + ')', { active: true, sync_hidden: false });
  if (hideIds.length) await patch('id=in.(' + hideIds.map((i) => i.id).join(',') + ')', { active: false, sync_hidden: true });

  if (toAdd.length) {
    const cats = ((await sb('categories?select=id,name&active=eq.true&order=id')) || []).map((c) => ({ id: c.id, k: ckey(c.name) }));
    const catId = {};
    let sort = 1000;
    for (const x of toAdd) {
      if (!x.group) continue;
      let c = findCat(cats, x.group);
      if (!c) { const made = (await sb('categories', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: x.group, sort: 100 + cats.length }) }))[0]; c = { id: made.id, k: ckey(x.group) }; cats.push(c); }
      catId[x.id] = c.id;
    }
    await sb('menu_items', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(toAdd.map((x) => ({
      name: x.name, iiko_id: x.id, image_url: x.image || null, price: x.price > 0 ? x.price : 0, category_id: catId[x.id] || null, sort: sort++, active: showNew && x.price > 0 })) ) });
    toAdd.forEach((x) => res.added.push(x.name));
  }

  // порядок блюд внутри категорий (салаты → боулы → поке, завтраки → блины → сырники → каша → суп) закрепляется при каждой выгрузке
  try {
    const cats2 = (await sb('categories?select=id,name')) || [], all = (await sb('menu_items?select=id,name,category_id,sort&order=sort.asc,id.asc')) || [];
    const fixes = [];
    for (const c of cats2) {
      const group = all.filter((i) => i.category_id === c.id);
      MenuOrder.sortItems(c.name, group).forEach((it, idx) => { if (Number(it.sort) !== (idx + 1) * 10) fixes.push({ id: it.id, sort: (idx + 1) * 10 }); });
    }
    for (let i = 0; i < fixes.length; i += 10) await Promise.all(fixes.slice(i, i + 10).map((u) => patch('id=eq.' + u.id, { sort: u.sort })));
    res.reordered = fixes.length;
  } catch (e) { res.orderError = e.message; }

  res.newShown = showNew;
  res.at = new Date().toISOString();
  await sb('integration_settings', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'iiko_menu_last', value: res, updated_at: res.at }) });
  return res;
}

// Список внешних меню iiko (для выбора) и категорий цен
async function listMenus() {
  const l = await iiko('/api/2/menu', {});
  const row = (x) => ({ id: String(x.id), name: String(x.name || x.id) });
  return { menus: (l.externalMenus || []).map(row), priceCategories: (l.priceCategories || []).map(row) };
}
// Сохраняет выбор администратора: какое меню iiko использовать, категория цен, что делать с новыми блюдами
async function saveChoice(b) {
  const rows = [];
  if (b.menuId !== undefined) rows.push({ key: 'iiko_external_menu_id', value: String(b.menuId).trim() });
  if (b.priceCategoryId !== undefined) rows.push({ key: 'iiko_price_category_id', value: String(b.priceCategoryId || '').trim() });
  if (b.newDishes === 'hide' || b.newDishes === 'show') rows.push({ key: 'iiko_new_dishes', value: b.newDishes });
  if (b.menuId !== undefined && !String(b.menuId).trim()) throw new Error('Выберите меню');
  if (rows.length) await sb('integration_settings', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))) });
}

module.exports = async (req, res) => {
  const cron = !!process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET;
  try {
    if (!cron && !(await adminFromRequest(req))) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!iikoConfigured()) return res.status(400).json({ ok: false, error: 'iiko не настроен: добавьте IIKO_API_LOGIN в переменные окружения Vercel' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.action === 'list') return res.status(200).json({ ok: true, ...(await listMenus()) });
    if (!cron) await saveChoice(body);
    const r = await syncMenu();
    if (r.added.length) await telegram('🆕 В меню iiko появились новые блюда (' + (r.newShown ? 'добавлены на сайт' : 'добавлены скрытыми, проверьте в админке → Меню') + '):\n' + r.added.slice(0, 30).join('\n'));
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    const isList = req.body && (req.body.action === 'list' || (typeof req.body === 'string' && req.body.includes('"list"')));
    if (!isList) await telegram('⚠️ Не удалось обновить меню из iiko: ' + e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
};
