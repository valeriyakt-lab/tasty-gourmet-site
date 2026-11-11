(() => {
'use strict';
const CFG = window.TG_CONFIG;
const db = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' тг';
const fdt = (iso) => { const d = new Date(iso); return d.toLocaleDateString('ru-RU') + ' ' + d.toTimeString().slice(0, 5); };
const linkFor = (token) => location.origin + '/?t=' + token;
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

const STATUSES = { new: 'Новая', accepted: 'Принята', cooking: 'Готовится', delivering: 'В пути', done: 'Выполнен', cancelled: 'Отменён', failed: 'Не передана' };
const TABS = [['requests', 'Заявки'], ['orders', 'Заказы'], ['clients', 'Клиенты'], ['feedback', 'Отзывы'], ['menu', 'Меню'], ['certs', 'Сертификаты'], ['settings', 'Настройки']];
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startISO = (s) => new Date(s + 'T00:00:00').toISOString();
const endISO = (s) => addDays(new Date(s + 'T00:00:00'), 1).toISOString(); // конец выбранного дня включительно
const PRESETS = { today: 'Сегодня', yest: 'Вчера', d7: '7 дней', d30: '30 дней', month: 'Этот месяц' };
function presetRange(k) {
  const t = new Date();
  if (k === 'today') return [ymd(t), ymd(t)];
  if (k === 'yest') return [ymd(addDays(t, -1)), ymd(addDays(t, -1))];
  if (k === 'd7') return [ymd(addDays(t, -6)), ymd(t)];
  if (k === 'd30') return [ymd(addDays(t, -29)), ymd(t)];
  return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)];
}
const counted = (o) => !['cancelled', 'failed'].includes(o.status);
const ordersSum = (rows) => rows.filter(counted).reduce((a, o) => a + Number(o.total), 0);

const S = { user: null, tab: 'orders', msg: null, err: null, d: {}, client: null, statusFilter: '', clientQ: '', fresh: null, from: ymd(new Date()), to: ymd(new Date()), orderClient: '', clientOrders: [], newFb: 0 };

function note(msg, err) { S.msg = err ? null : msg; S.err = err ? msg : null; render(); if (msg) setTimeout(() => { if (S.msg === msg || S.err === msg) { S.msg = S.err = null; render(); } }, 4000); }
async function run(p, okMsg) { const { data, error } = await p; if (error) { note(error.message, true); return null; } if (okMsg) note(okMsg); return data === null ? true : data; }

/* ---------- загрузка ---------- */
async function loadTab(tab = S.tab) {
  const d = S.d;
  if (tab === 'orders') {
    let q = db.from('orders').select('*, clients(name), order_items(name,qty,price)').gte('created_at', startISO(S.from)).lt('created_at', endISO(S.to)).order('created_at', { ascending: false }).limit(2000);
    if (S.orderClient) q = q.eq('client_id', S.orderClient);
    d.orders = (await q).data || [];
    if (!d.clients) d.clients = (await db.from('clients').select('*').order('name')).data || [];
  }
  if (tab === 'feedback') d.feedback = (await db.from('feedback').select('*, clients(name)').order('created_at', { ascending: false }).limit(300)).data || [];
  if (tab === 'requests') d.requests = (await db.from('registration_requests').select('*').order('created_at', { ascending: false }).limit(100)).data || [];
  if (tab === 'clients') d.clients = (await db.from('clients').select('*').order('name')).data || [];
  if (tab === 'menu') {
    d.cats = (await db.from('categories').select('*').order('sort').order('id')).data || [];
    d.items = (await db.from('menu_items').select('*').order('sort').order('id')).data || [];
  }
  if (tab === 'certs') d.certs = (await db.from('certificates').select('*').order('sort').order('id')).data || [];
  if (tab === 'settings') d.settings = (await db.from('settings').select('*').order('key')).data || [];
  render();
}
async function countNew() {
  const r = await db.from('registration_requests').select('id', { count: 'exact', head: true }).eq('status', 'new'); S.newReq = r.count || 0;
  const f = await db.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'new'); S.newFb = f.count || 0;
}
async function loadClientOrders() {
  if (!S.client) return;
  S.clientOrders = (await db.from('orders').select('*, order_items(name,qty,price)').eq('client_id', S.client.c.id)
    .gte('created_at', startISO(S.from)).lt('created_at', endISO(S.to)).order('created_at', { ascending: false }).limit(2000)).data || [];
}
async function openClient(id) {
  const [c, a, p, items] = await Promise.all([
    db.from('clients').select('*').eq('id', id).single(),
    db.from('client_addresses').select('*').eq('client_id', id).order('id'),
    db.from('client_prices').select('item_id, price').eq('client_id', id),
    db.from('menu_items').select('id,name,price').order('name'),
  ]);
  S.client = { c: c.data, addrs: a.data || [], prices: p.data || [], items: items.data || [] }; await loadClientOrders(); render();
}

/* ---------- вкладки ---------- */
const sel = (opts, cur, attrs) => `<select ${attrs}>${Object.entries(opts).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(cur) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

function rangeBar() {
  const cur = Object.keys(PRESETS).find((k) => { const r = presetRange(k); return r[0] === S.from && r[1] === S.to; });
  return `<div class="card"><div class="row">
    ${Object.entries(PRESETS).map(([k, n]) => `<button class="btn ${cur === k ? '' : 'g'}" data-act="preset" data-v="${k}">${n}</button>`).join('')}
    <span class="spacer"></span>
    <label class="row muted">С <input type="date" data-act="from" value="${S.from}" max="${S.to}"></label>
    <label class="row muted">по <input type="date" data-act="to" value="${S.to}" min="${S.from}"></label></div></div>`;
}
const periodLabel = () => (S.from === S.to ? S.from.split('-').reverse().join('.') : S.from.split('-').reverse().join('.') + ' — ' + S.to.split('-').reverse().join('.'));

function ordersTab() {
  const rows = (S.d.orders || []).filter((o) => !S.statusFilter || o.status === S.statusFilter);
  const clientOpts = Object.fromEntries([['', 'Все клиенты'], ...(S.d.clients || []).map((c) => [c.id, c.name])]);
  return `<div class="row"><h1>Заказы</h1><span class="spacer"></span>
    ${sel(clientOpts, S.orderClient, 'data-act="orderClientFilter"')}${sel({ '': 'Все статусы', ...STATUSES }, S.statusFilter, 'data-act="filter"')}<button class="btn g" data-act="reload">Обновить</button></div>
    ${rangeBar()}
    <div class="msg">Период: ${periodLabel()} · заказов: <b>${rows.length}</b> · сумма (без отменённых): <b>${fmt(ordersSum(rows))}</b></div>
    ${rows.length ? rows.map((o) => `<div class="card">
      <div class="row"><b class="geo green">№ ${esc(o.number)}</b><span class="muted">${fdt(o.created_at)}</span><b>${esc(o.clients ? o.clients.name : '')}</b><span class="spacer"></span><b class="geo">${fmt(o.total)}</b></div>
      <div class="muted">${o.pickup ? 'Самовывоз' : esc(o.address)}${o.comment ? ' · «' + esc(o.comment) + '»' : ''}</div>
      <div>${o.order_items.map((i) => `${esc(i.name)} × ${i.qty}`).join(', ')}</div>
      ${o.iiko_error ? `<div class="red">iiko: ${esc(o.iiko_error)}</div>` : ''}
      <div class="row">${sel(STATUSES, o.status, `data-act="orderStatus" data-id="${o.id}"`)}
        <span class="muted">${o.iiko_order_id ? 'iiko: ' + esc(o.iiko_order_id) : 'не передан в iiko'}</span><span class="spacer"></span>
        <button class="btn d" data-act="delOrder" data-id="${o.id}">Удалить</button></div></div>`).join('') : '<div class="card muted">За выбранный период заказов нет</div>'}`;
}

function requestsTab() {
  const rows = S.d.requests || [];
  return `<h1>Заявки на регистрацию</h1>${rows.length ? rows.map((r) => `<div class="card">
    <div class="row"><b>${esc(r.name)}</b><span class="muted">${esc(r.phone)}</span><span class="spacer"></span><span class="muted">${fdt(r.created_at)}</span>
      <span class="pill">${{ new: 'новая', approved: 'одобрена', rejected: 'отклонена' }[r.status]}</span></div>
    <div class="muted">${esc(r.address || 'адрес не указан')}${r.contact_person ? ' · контакт: ' + esc(r.contact_person) : ''}</div>
    ${r.status === 'new' ? `<div class="row"><button class="btn" data-act="approve" data-id="${r.id}">Одобрить и создать клиента</button><button class="btn d" data-act="reject" data-id="${r.id}">Отклонить</button></div>` : ''}
    ${r.status === 'approved' && r.client_id ? `<div><button class="btn g" data-act="openClient" data-id="${r.client_id}">Открыть клиента</button></div>` : ''}
  </div>`).join('') : '<div class="card muted">Заявок нет</div>'}`;
}

function clientsTab() {
  if (S.client) return clientDetail();
  const q = S.clientQ.toLowerCase();
  const rows = (S.d.clients || []).filter((c) => !q || (c.name + ' ' + (c.phone || '')).toLowerCase().includes(q));
  return `<div class="row"><h1>Клиенты</h1><span class="spacer"></span>
    <input class="inp" type="text" id="clientQ" placeholder="Поиск" value="${esc(S.clientQ)}"><button class="btn" data-act="newClient">+ Клиент</button></div>
    <div class="card scroll"><table><tr><th>Название</th><th>Телефон</th><th>Статус</th><th></th></tr>
    ${rows.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.phone || '')}</td><td>${c.status === 'active' ? 'активен' : '<span class="red">заблокирован</span>'}</td>
      <td style="text-align:right"><button class="btn g" data-act="openClient" data-id="${c.id}">Открыть</button></td></tr>`).join('')}</table>
    ${rows.length ? '' : '<div class="muted">Клиентов нет</div>'}</div>`;
}

function clientDetail() {
  const { c, addrs, prices, items } = S.client;
  const priced = new Set(prices.map((p) => p.item_id));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  return `<div class="row"><button class="btn g" data-act="backClients">← Клиенты</button><h1>${esc(c.name)}</h1></div>
  <div class="two">
    <div class="card"><b>Данные</b>
      <label class="f">Название<input type="text" data-cf="name" value="${esc(c.name)}"></label>
      <label class="f">Телефон<input type="text" data-cf="phone" value="${esc(c.phone || '')}"></label>
      <label class="f">Контактное лицо<input type="text" data-cf="contact_person" value="${esc(c.contact_person || '')}"></label>
      <label class="f">Статус${sel({ active: 'Активен', blocked: 'Заблокирован' }, c.status, 'data-cf="status"')}</label>
    </div>
    <div class="card"><b>Личная ссылка для входа</b>
      <div class="link" id="lnk">${esc(linkFor(c.access_token))}</div>
      <div class="row"><button class="btn" data-act="copyLink">Скопировать</button><button class="btn d" data-act="regen">Выдать новую (старая перестанет работать)</button></div></div>
  </div>
  <div class="card"><b>Адреса доставки</b>
    ${addrs.map((a) => `<div class="row"><span style="flex:1">${esc(a.address)}</span><button class="btn d" data-act="delAddr" data-id="${a.id}">Удалить</button></div>`).join('') || '<span class="muted">Адресов нет</span>'}
    <div class="row"><input class="inp w" type="text" id="newAddr" placeholder="Новый адрес"><button class="btn" data-act="addAddr">Добавить</button></div></div>
  ${rangeBar()}
  <div class="card"><b>Заказы клиента</b>
    <div class="msg">Период: ${periodLabel()} · заказов: <b>${S.clientOrders.length}</b> · сумма (без отменённых): <b>${fmt(ordersSum(S.clientOrders))}</b></div>
    ${S.clientOrders.map((o) => `<div style="border-top:1px solid #efece7;padding-top:8px;display:grid;gap:2px">
      <div class="row"><b class="geo green">№ ${esc(o.number)}</b><span class="muted">${fdt(o.created_at)}</span><span class="pill">${STATUSES[o.status] || o.status}</span><span class="spacer"></span><b>${fmt(o.total)}</b></div>
      <div class="muted">${o.order_items.map((i) => `${esc(i.name)} × ${i.qty}`).join(', ')}</div></div>`).join('') || '<span class="muted">За выбранный период заказов нет</span>'}</div>
  <div class="card"><b>Индивидуальные цены</b><span class="muted">Если цена не задана, действует базовая цена из меню.</span>
    ${prices.map((p) => `<div class="row"><span style="flex:1">${esc(byId[p.item_id] ? byId[p.item_id].name : '#' + p.item_id)} <span class="muted">(база ${byId[p.item_id] ? fmt(byId[p.item_id].price) : '—'})</span></span>
      <input type="number" min="0" style="width:110px" data-pf="${p.item_id}" value="${p.price}"><button class="btn d" data-act="delPrice" data-id="${p.item_id}">Сбросить</button></div>`).join('')}
    <div class="row"><select id="newPriceItem" class="w">${items.filter((i) => !priced.has(i.id)).map((i) => `<option value="${i.id}">${esc(i.name)} — ${fmt(i.price)}</option>`).join('')}</select>
      <input type="number" min="0" id="newPriceVal" style="width:110px" placeholder="Цена"><button class="btn" data-act="addPrice">Добавить цену</button></div></div>`;
}

function feedbackTab() {
  const rows = S.d.feedback || [];
  return `<h1>Отзывы и предложения</h1>${rows.length ? rows.map((f) => `<div class="card" style="${f.status === 'new' ? 'box-shadow:inset 0 0 0 2px #e0641c' : ''}">
    <div class="row"><span class="pill" style="background:${f.kind === 'review' ? '#e7f2eb' : '#fdf3dc'}">${f.kind === 'review' ? 'отзыв' : 'предложение'}</span>
      ${f.rating ? `<span style="color:#e9ae2e;letter-spacing:2px">${'★'.repeat(f.rating)}<span style="color:#d9d5d0">${'★'.repeat(5 - f.rating)}</span></span>` : ''}
      <b>${esc(f.clients ? f.clients.name : '')}</b><span class="spacer"></span><span class="muted">${fdt(f.created_at)}</span></div>
    <div style="white-space:pre-wrap">${esc(f.message)}</div>
    <div class="row">${f.status === 'new' ? `<button class="btn" data-act="fbRead" data-id="${f.id}">Прочитано</button>` : '<span class="muted">прочитано</span>'}
      <span class="spacer"></span><button class="btn d" data-act="fbDel" data-id="${f.id}">Удалить</button></div></div>`).join('') : '<div class="card muted">Пока ничего нет</div>'}`;
}

function menuTab() {
  const { cats = [], items = [] } = S.d;
  const catOpts = Object.fromEntries([['', '— без категории —'], ...cats.map((c) => [c.id, c.name])]);
  return `<div class="row"><h1>Меню</h1><span class="spacer"></span><button class="btn g" data-act="newCat">+ Категория</button><button class="btn" data-act="newItem">+ Блюдо</button></div>
  <div class="card scroll"><b>Категории</b><table><tr><th>Название</th><th>Цвет</th><th>Порядок</th><th>Показ</th><th></th></tr>
    ${cats.map((c) => `<tr><td><input type="text" data-t="categories" data-id="${c.id}" data-c="name" value="${esc(c.name)}"></td>
      <td><input type="text" data-t="categories" data-id="${c.id}" data-c="color" value="${esc(c.color)}" style="width:100px"></td>
      <td><input type="number" data-t="categories" data-id="${c.id}" data-c="sort" data-n="1" value="${c.sort}" style="width:80px"></td>
      <td><input type="checkbox" data-t="categories" data-id="${c.id}" data-c="active" data-b="1" ${c.active ? 'checked' : ''}></td>
      <td><button class="btn d" data-act="delCat" data-id="${c.id}">×</button></td></tr>`).join('')}</table></div>
  <div class="card scroll"><b>Блюда</b><table><tr><th>Категория</th><th>Название</th><th>Базовая цена</th><th>Порядок</th><th>Показ</th><th>iiko ID</th><th></th></tr>
    ${items.map((i) => `<tr><td>${sel(catOpts, i.category_id || '', `data-t="menu_items" data-id="${i.id}" data-c="category_id" data-nullable="1"`)}</td>
      <td><input type="text" data-t="menu_items" data-id="${i.id}" data-c="name" value="${esc(i.name)}"></td>
      <td><input type="number" min="0" data-t="menu_items" data-id="${i.id}" data-c="price" data-n="1" value="${i.price}" style="width:100px"></td>
      <td><input type="number" data-t="menu_items" data-id="${i.id}" data-c="sort" data-n="1" value="${i.sort}" style="width:70px"></td>
      <td><input type="checkbox" data-t="menu_items" data-id="${i.id}" data-c="active" data-b="1" ${i.active ? 'checked' : ''}></td>
      <td><input type="text" data-t="menu_items" data-id="${i.id}" data-c="iiko_id" data-nullable="1" value="${esc(i.iiko_id || '')}" style="width:140px"></td>
      <td><button class="btn d" data-act="delItem" data-id="${i.id}">×</button></td></tr>`).join('')}</table></div>`;
}

function certsTab() {
  const rows = S.d.certs || [];
  return `<div class="row"><h1>Сертификаты</h1><span class="spacer"></span><button class="btn" data-act="newCert">+ Сертификат</button></div>
  <div class="msg">Сертификат виден на сайте, только когда включён «Показывать». Загрузите скан (JPG, PNG или PDF).</div>
  ${rows.map((c) => `<div class="card">
    <div class="row"><input class="inp w" type="text" data-t="certificates" data-id="${c.id}" data-c="title" value="${esc(c.title)}" placeholder="Название">
      <input class="inp w" type="text" data-t="certificates" data-id="${c.id}" data-c="note" data-nullable="1" value="${esc(c.note || '')}" placeholder="Описание">
      <label class="row"><input type="checkbox" data-t="certificates" data-id="${c.id}" data-c="active" data-b="1" ${c.active ? 'checked' : ''}> Показывать</label></div>
    <div class="row">${c.file_url ? `<a href="${esc(c.file_url)}" target="_blank" rel="noopener">Открыть файл</a>` : '<span class="muted">Файл не загружен</span>'}
      <input type="file" accept="image/*,application/pdf" data-up="${c.id}"><span class="spacer"></span>
      <button class="btn d" data-act="delCert" data-id="${c.id}">Удалить</button></div></div>`).join('')}`;
}

function settingsTab() {
  const names = { min_delivery: 'Минимальная сумма доставки, тг', pickup_address: 'Адрес самовывоза', pickup_from: 'Самовывоз с (время)', manager_phone: 'Телефон менеджера' };
  return `<h1>Настройки</h1><div class="card">${(S.d.settings || []).map((s) => `<label class="f">${esc(names[s.key] || s.key)}
    <input type="text" data-t="settings" data-key="${esc(s.key)}" value="${esc(s.value)}"></label>`).join('')}</div>`;
}

/* ---------- рендер ---------- */
function render() {
  const ae = document.activeElement, keep = ae && ae.id ? ae.id : null;
  if (S.user === undefined) { app.innerHTML = '<div class="boot">Загрузка…</div>'; return; }
  if (!S.user) {
    app.innerHTML = `<div class="login"><form id="loginForm"><div class="brand">Tasty Gourmet · админ</div>
      ${S.err ? `<div class="msg err">${esc(S.err)}</div>` : ''}
      <label class="f">Email<input type="email" id="em" required autocomplete="username"></label>
      <label class="f">Пароль<input type="password" id="pw" required autocomplete="current-password"></label>
      <button class="btn o" type="submit">Войти</button></form></div>`;
    return;
  }
  const body = { orders: ordersTab, requests: requestsTab, clients: clientsTab, feedback: feedbackTab, menu: menuTab, certs: certsTab, settings: settingsTab }[S.tab]();
  app.innerHTML = `<header class="bar"><div class="bar-in"><span class="brand">Tasty Gourmet</span>
    ${TABS.map(([k, n]) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}${k === 'requests' && S.newReq ? `<span class="n">${S.newReq}</span>` : ''}${k === 'feedback' && S.newFb ? `<span class="n">${S.newFb}</span>` : ''}</button>`).join('')}
    <span class="spacer"></span><span class="muted">${esc(S.user.email)}</span><button class="btn g" data-act="logout">Выйти</button></div></header>
    <main>${S.msg ? `<div class="msg">${esc(S.msg)}</div>` : ''}${S.err ? `<div class="msg err">${esc(S.err)}</div>` : ''}${body}</main>`;
  if (keep) { const el = document.getElementById(keep); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) {} } }
}

/* ---------- действия ---------- */
const ask = (t) => window.confirm(t);
const val = (id) => (document.getElementById(id) || {}).value || '';
const A = {
  tab: async (el) => { S.tab = el.dataset.v; S.client = null; await loadTab(); },
  reload: () => loadTab(),
  preset: async (el) => { [S.from, S.to] = presetRange(el.dataset.v); await reloadRange(); },
  from: async (el) => { if (!el.value) return; S.from = el.value; if (S.to < S.from) S.to = S.from; await reloadRange(); },
  to: async (el) => { if (!el.value) return; S.to = el.value; if (S.from > S.to) S.from = S.to; await reloadRange(); },
  orderClientFilter: async (el) => { S.orderClient = el.value; await loadTab('orders'); },
  fbRead: async (el) => { if (await run(db.from('feedback').update({ status: 'read' }).eq('id', el.dataset.id))) { await countNew(); loadTab('feedback'); } },
  fbDel: async (el) => { if (ask('Удалить сообщение?') && await run(db.from('feedback').delete().eq('id', el.dataset.id), 'Удалено')) { await countNew(); loadTab('feedback'); } },
  logout: async () => { await db.auth.signOut(); S.user = null; render(); },
  orderStatus: async (el) => { if (await run(db.from('orders').update({ status: el.value }).eq('id', el.dataset.id), 'Статус обновлён')) loadTab('orders'); },
  delOrder: async (el) => { if (ask('Удалить заказ?') && await run(db.from('orders').delete().eq('id', el.dataset.id), 'Заказ удалён')) loadTab('orders'); },
  approve: async (el) => {
    const r = S.d.requests.find((x) => x.id == el.dataset.id); if (!r) return;
    const c = await run(db.from('clients').insert({ name: r.name, phone: r.phone, contact_person: r.contact_person }).select().single()); if (!c) return;
    if (r.address) await run(db.from('client_addresses').insert({ client_id: c.id, address: r.address }));
    await run(db.from('registration_requests').update({ status: 'approved', client_id: c.id }).eq('id', r.id));
    await countNew(); await openClientTab(c.id); note('Клиент создан. Скопируйте личную ссылку и отправьте в WhatsApp.');
  },
  reject: async (el) => { if (ask('Отклонить заявку?') && await run(db.from('registration_requests').update({ status: 'rejected' }).eq('id', el.dataset.id))) { await countNew(); loadTab('requests'); } },
  filter: (el) => { S.statusFilter = el.value; render(); },
  openClient: (el) => openClientTab(el.dataset.id),
  backClients: async () => { S.client = null; await loadTab('clients'); },
  newClient: async () => { const n = window.prompt('Название точки'); if (!n || n.trim().length < 2) return; const c = await run(db.from('clients').insert({ name: n.trim() }).select().single()); if (c) { await loadTab('clients'); openClientTab(c.id); } },
  copyLink: async () => { try { await navigator.clipboard.writeText(linkFor(S.client.c.access_token)); note('Ссылка скопирована'); } catch (e) { note('Выделите и скопируйте ссылку вручную', true); } },
  regen: async () => { if (!ask('Старая ссылка клиента перестанет работать. Продолжить?')) return; if (await run(db.from('clients').update({ access_token: newToken() }).eq('id', S.client.c.id), 'Выдана новая ссылка')) openClient(S.client.c.id); },
  addAddr: async () => { const a = val('newAddr').trim(); if (a.length < 3) return; if (await run(db.from('client_addresses').insert({ client_id: S.client.c.id, address: a }))) openClient(S.client.c.id); },
  delAddr: async (el) => { if (await run(db.from('client_addresses').delete().eq('id', el.dataset.id))) openClient(S.client.c.id); },
  addPrice: async () => { const item = val('newPriceItem'), price = Number(val('newPriceVal')); if (!item || !(price >= 0) || val('newPriceVal') === '') return; if (await run(db.from('client_prices').upsert({ client_id: S.client.c.id, item_id: item, price }))) openClient(S.client.c.id); },
  delPrice: async (el) => { if (await run(db.from('client_prices').delete().eq('client_id', S.client.c.id).eq('item_id', el.dataset.id))) openClient(S.client.c.id); },
  newCat: async () => { const n = window.prompt('Название категории'); if (n && await run(db.from('categories').insert({ name: n.trim(), sort: (S.d.cats || []).length + 1 }))) loadTab('menu'); },
  newItem: async () => { const n = window.prompt('Название блюда'); if (!n) return; const cat = (S.d.cats || [])[0]; if (await run(db.from('menu_items').insert({ name: n.trim(), category_id: cat ? cat.id : null, price: 0, active: false }), 'Блюдо добавлено (выключено, пока не задана цена)')) loadTab('menu'); },
  delCat: async (el) => { if (ask('Удалить категорию? Блюда останутся без категории.') && await run(db.from('categories').delete().eq('id', el.dataset.id))) loadTab('menu'); },
  delItem: async (el) => { if (ask('Удалить блюдо?') && await run(db.from('menu_items').delete().eq('id', el.dataset.id))) loadTab('menu'); },
  newCert: async () => { if (await run(db.from('certificates').insert({ title: 'Новый сертификат', active: false, sort: (S.d.certs || []).length + 1 }))) loadTab('certs'); },
  delCert: async (el) => { if (ask('Удалить сертификат?') && await run(db.from('certificates').delete().eq('id', el.dataset.id))) loadTab('certs'); },
};
async function reloadRange() { if (S.tab === 'clients' && S.client) { await loadClientOrders(); render(); } else await loadTab('orders'); }
async function openClientTab(id) { S.tab = 'clients'; if (!S.d.clients) await loadTab('clients'); await openClient(id); }

document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el && el.tagName !== 'SELECT' && el.type !== 'date' && A[el.dataset.act]) A[el.dataset.act](el); });
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'loginForm') return; e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: val('em'), password: val('pw') });
  if (error) { S.err = 'Неверный email или пароль'; render(); } else await boot();
});
document.addEventListener('input', (e) => { if (e.target.id === 'clientQ') { S.clientQ = e.target.value; render(); } });
document.addEventListener('change', async (e) => {
  const el = e.target;
  if ((el.tagName === 'SELECT' || el.type === 'date') && el.dataset.act && A[el.dataset.act]) return A[el.dataset.act](el);
  if (el.dataset.up) { // загрузка скана сертификата
    const f = el.files[0]; if (!f) return;
    const path = el.dataset.up + '-' + Date.now() + '-' + f.name.replace(/[^\w.\-]+/g, '_');
    const up = await db.storage.from('certificates').upload(path, f, { upsert: true }); if (up.error) return note(up.error.message, true);
    const url = db.storage.from('certificates').getPublicUrl(path).data.publicUrl;
    if (await run(db.from('certificates').update({ file_url: url }).eq('id', el.dataset.up), 'Файл загружен')) loadTab('certs'); return;
  }
  if (el.dataset.cf) { const v = el.value.trim(); if (el.dataset.cf === 'name' && v.length < 2) return; await run(db.from('clients').update({ [el.dataset.cf]: v || null }).eq('id', S.client.c.id), 'Сохранено'); S.client.c[el.dataset.cf] = v; return; }
  if (el.dataset.pf) { await run(db.from('client_prices').update({ price: Number(el.value) }).eq('client_id', S.client.c.id).eq('item_id', el.dataset.pf), 'Цена сохранена'); return; }
  if (el.dataset.t === 'settings') { await run(db.from('settings').update({ value: el.value.trim() }).eq('key', el.dataset.key), 'Сохранено'); return; }
  if (el.dataset.t) {
    let v = el.dataset.b ? el.checked : el.dataset.n ? Number(el.value) : el.value.trim();
    if (el.dataset.nullable && (v === '' || v === null)) v = null;
    if (el.dataset.c === 'name' && !v) return;
    await run(db.from(el.dataset.t).update({ [el.dataset.c]: v }).eq('id', el.dataset.id), 'Сохранено');
  }
});

/* ---------- старт ---------- */
async function boot() {
  const { data } = await db.auth.getSession();
  if (!data.session) { S.user = null; render(); return; }
  const adm = await db.from('admins').select('user_id').eq('user_id', data.session.user.id);
  if (!adm.data || !adm.data.length) { await db.auth.signOut(); S.user = null; S.err = 'У этого пользователя нет доступа к админ-панели'; render(); return; }
  S.user = data.session.user; S.err = null;
  await countNew(); await loadTab();
}
S.user = undefined; render(); boot();
})();
