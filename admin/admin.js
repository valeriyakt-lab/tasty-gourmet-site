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
const TABS = [['dashboard', 'Дашборд'], ['requests', 'Заявки'], ['orders', 'Заказы'], ['clients', 'Клиенты'], ['feedback', 'Отзывы'], ['menu', 'Меню'], ['certs', 'Сертификаты'], ['settings', 'Настройки']];
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

const S = { user: null, tab: 'dashboard', msg: null, err: null, d: {}, client: null, statusFilter: '', clientQ: '', fresh: null, from: ymd(addDays(new Date(), -6)), to: ymd(new Date()), orderClient: '', clientOrders: [], newFb: 0, checkMsg: '', xl: null, clientFilter: '', nStop: 0, nSleep: 0 };

function note(msg, err) { S.msg = err ? null : msg; S.err = err ? msg : null; render(); if (msg) setTimeout(() => { if (S.msg === msg || S.err === msg) { S.msg = S.err = null; render(); } }, 4000); }
async function api(path, body) {
  const { data } = await db.auth.getSession();
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (data.session ? data.session.access_token : '') }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  } catch (e) { return { ok: false, error: 'Нет связи с сервером: ' + e.message }; }
}
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
  if (tab === 'dashboard') {
    const len = Math.round((new Date(S.to + 'T00:00:00') - new Date(S.from + 'T00:00:00')) / 864e5) + 1;
    const pTo = ymd(addDays(new Date(S.from + 'T00:00:00'), -1)), pFrom = ymd(addDays(new Date(pTo + 'T00:00:00'), -(len - 1)));
    const [cur, prev] = await Promise.all([
      db.from('orders').select('id,created_at,status,total,client_id,clients(name),order_items(name,qty,price)').gte('created_at', startISO(S.from)).lt('created_at', endISO(S.to)).limit(5000),
      db.from('orders').select('id,status,total,client_id').gte('created_at', startISO(pFrom)).lt('created_at', endISO(pTo)).limit(5000),
    ]);
    d.dash = { cur: cur.data || [], prev: prev.data || [], len, error: cur.error ? cur.error.message : null };
  }
  if (tab === 'feedback') d.feedback = (await db.from('feedback').select('*, clients(name)').order('created_at', { ascending: false }).limit(300)).data || [];
  if (tab === 'requests') d.requests = (await db.from('registration_requests').select('*').order('created_at', { ascending: false }).limit(100)).data || [];
  if (tab === 'clients') d.clients = (await db.from('client_overview').select('*').order('name')).data || [];
  if (tab === 'menu') {
    d.cats = (await db.from('categories').select('*').order('sort').order('id')).data || [];
    d.items = (await db.from('menu_items').select('*').order('sort').order('id')).data || [];
    d.syncLast = ((await db.from('integration_settings').select('value').eq('key', 'iiko_menu_last').maybeSingle()).data || {}).value || null;
  }
  if (tab === 'certs') d.certs = (await db.from('certificates').select('*').order('sort').order('id')).data || [];
  if (tab === 'settings') d.settings = (await db.from('settings').select('*').order('key')).data || [];
  render();
}
async function countNew() {
  const r = await db.from('registration_requests').select('id', { count: 'exact', head: true }).eq('status', 'new'); S.newReq = r.count || 0;
  const f = await db.from('feedback').select('id', { count: 'exact', head: true }).eq('status', 'new'); S.newFb = f.count || 0;
  const st = await db.from('client_overview').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('stop_list', true); S.nStop = st.count || 0;
  const sl = await db.from('client_overview').select('id', { count: 'exact', head: true }).eq('status', 'active').eq('sleeping', true); S.nSleep = sl.count || 0;
}
async function loadClientOrders() {
  if (!S.client) return;
  S.clientOrders = (await db.from('orders').select('*, order_items(name,qty,price)').eq('client_id', S.client.c.id)
    .gte('created_at', startISO(S.from)).lt('created_at', endISO(S.to)).order('created_at', { ascending: false }).limit(2000)).data || [];
}
async function openClient(id) {
  const [c, a, p, items] = await Promise.all([
    db.from('client_overview').select('*').eq('id', id).single(),
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

/* ---------- дашборд ---------- */
const INK = '#393536', MUTED = '#6e696a', BAR = '#008037';
const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace('.0', '') + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(Math.round(n));
const niceMax = (v) => { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e; };
const dm = (k) => k.split('-').reverse().slice(0, 2).join('.');
function bucketKey(iso, weekly) {
  const d = new Date(iso); if (weekly) d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d);
}
function dashData() {
  const { cur, prev, len } = S.d.dash, ok = cur.filter(counted), pOk = prev.filter(counted);
  const rev = ordersSum(ok), pRev = ordersSum(pOk);
  const clients = new Set(ok.map((o) => o.client_id)).size, pClients = new Set(pOk.map((o) => o.client_id)).size;
  const weekly = len > 45, days = {};
  // непрерывная шкала дат без пропусков
  for (let d = new Date(S.from + 'T00:00:00'); ymd(d) <= S.to; d.setDate(d.getDate() + 1)) days[bucketKey(d.toISOString(), weekly)] = { rev: 0, n: 0 };
  ok.forEach((o) => { const b = days[bucketKey(o.created_at, weekly)]; if (b) { b.rev += Number(o.total); b.n += 1; } });
  const dishes = {}, cl = {};
  ok.forEach((o) => {
    const c = cl[o.client_id] || (cl[o.client_id] = { name: o.clients ? o.clients.name : '—', rev: 0, n: 0 }); c.rev += Number(o.total); c.n += 1;
    o.order_items.forEach((i) => { const x = dishes[i.name] || (dishes[i.name] = { name: i.name, rev: 0, n: 0 }); x.rev += i.qty * i.price; x.n += i.qty; });
  });
  const byStatus = {}; cur.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  return { rev, pRev, n: ok.length, pN: pOk.length, avg: ok.length ? rev / ok.length : 0, pAvg: pOk.length ? pRev / pOk.length : 0, clients, pClients, weekly,
    days: Object.entries(days).sort(), dishes: Object.values(dishes).sort((a, b) => b.rev - a.rev).slice(0, 8), cl: Object.values(cl).sort((a, b) => b.rev - a.rev).slice(0, 8), byStatus };
}
function delta(cur, prev) {
  if (!prev) return `<span class="delta" style="color:${MUTED}">нет данных за прошлый период</span>`;
  const p = (cur - prev) / prev * 100, up = p > 0.05, down = p < -0.05;
  const col = up ? '#006a2e' : down ? '#b53137' : MUTED;
  return `<span class="delta" style="color:${col}">${up ? '▲' : down ? '▼' : '●'} ${up ? '+' : ''}${p.toFixed(1).replace('.', ',')}% <span style="color:${MUTED}">к прошлому периоду</span></span>`;
}
const tile = (label, value, d, big) => `<div class="tile"><div class="tl">${label}</div><div class="tv ${big ? 'big' : ''}">${value}</div>${d || ''}</div>`;

function columnsChart(days, weekly) {
  const max = niceMax(Math.max(...days.map(([, v]) => v.rev), 0)), ticks = [0, 1, 2, 3, 4].map((i) => max / 4 * i);
  const step = Math.max(1, Math.ceil(days.length / 7));
  return `<div class="chart"><div class="yax">${ticks.slice().reverse().map((t) => `<span>${compact(t)}</span>`).join('')}</div>
    <div class="plot"><div class="grid">${ticks.map(() => '<i></i>').join('')}</div>
    <div class="cols">${days.map(([k, v], idx) => `<div class="col" tabindex="0" data-tip="${esc((weekly ? 'Неделя с ' : '') + k.split('-').reverse().join('.'))}|${fmt(v.rev)}|${v.n} зак."><div class="bar" style="height:${v.rev / max * 100}%"></div></div>`).join('')}</div>
    <div class="xax">${days.map(([k], idx) => `<span>${idx % step === 0 ? dm(k) : ''}</span>`).join('')}</div></div></div>`;
}
function hbars(rows, unit) {
  const max = Math.max(...rows.map((r) => r.rev), 1);
  return rows.length ? `<div class="hb">${rows.map((r) => `<div class="hr" tabindex="0" data-tip="${esc(r.name)}|${fmt(r.rev)}|${unit(r)}">
    <span class="hl">${esc(r.name)}</span><span class="ht"><i style="width:${r.rev / max * 100}%"></i></span><span class="hv">${fmt(r.rev)}</span></div>`).join('')}</div>` : '<div class="muted">Нет данных за период</div>';
}
function dashboardTab() {
  const dd = S.d.dash; if (!dd) return '<div class="boot">Загрузка…</div>';
  if (dd.error) return `<div class="msg err">${esc(dd.error)}</div>`;
  const m = dashData();
  const tbl = (head, rows) => `<details class="tv-t"><summary>Таблица значений</summary><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></details>`;
  return `<div class="row"><h1>Дашборд</h1><span class="spacer"></span><button class="btn g" data-act="reload">Обновить</button></div>
  ${rangeBar()}
  ${(() => { const bad = dd.cur.filter((o) => o.status === 'failed').length; return bad ? `<div class="msg err">Не дошли до кассы: <b>${bad}</b>. <a href="#" data-act="toFailed">Открыть и отправить заново</a></div>` : ''; })()}
  ${S.nStop || S.nSleep ? `<div class="msg" style="background:#fdf3dc;color:#6b4d0a">В стоп-листе: <b>${S.nStop}</b> · ссылка спит: <b>${S.nSleep}</b> · <a href="#" data-act="goClients" data-v="${S.nStop ? 'stop' : 'sleep'}">открыть</a>${S.nStop && S.nSleep ? ' · <a href="#" data-act="goClients" data-v="sleep">показать спящих</a>' : ''}</div>` : ''}
  <div class="tiles">
    ${tile('Выручка за период', fmt(m.rev), delta(m.rev, m.pRev), true)}
    ${tile('Заказов', m.n, delta(m.n, m.pN))}
    ${tile('Средний чек', fmt(m.avg), delta(m.avg, m.pAvg))}
    ${tile('Клиентов заказали', m.clients, delta(m.clients, m.pClients))}
    <button class="tile link-tile" data-act="tab" data-v="requests"><div class="tl">Новые заявки</div><div class="tv ${S.newReq ? 'warn' : ''}">${S.newReq || 0}</div><span class="delta muted">перейти →</span></button>
    <button class="tile link-tile" data-act="tab" data-v="feedback"><div class="tl">Новые отзывы</div><div class="tv ${S.newFb ? 'warn' : ''}">${S.newFb || 0}</div><span class="delta muted">перейти →</span></button>
  </div>
  <div class="card"><div class="row"><b>Выручка ${m.weekly ? 'по неделям' : 'по дням'}</b><span class="muted">${periodLabel()}, без отменённых</span></div>
    ${m.rev || m.n ? columnsChart(m.days, m.weekly) : '<div class="muted" style="padding:24px 0">За выбранный период заказов нет</div>'}
    ${tbl([m.weekly ? 'Неделя с' : 'Дата', 'Заказов', 'Выручка'], m.days.map(([k, v]) => [k.split('-').reverse().join('.'), v.n, fmt(v.rev)]))}</div>
  <div class="two">
    <div class="card"><b>Топ блюд по выручке</b>${hbars(m.dishes, (r) => r.n + ' шт')}
      ${tbl(['Блюдо', 'Штук', 'Выручка'], m.dishes.map((r) => [r.name, r.n, fmt(r.rev)]))}</div>
    <div class="card"><b>Топ клиентов по выручке</b>${hbars(m.cl, (r) => r.n + ' зак.')}
      ${tbl(['Клиент', 'Заказов', 'Выручка'], m.cl.map((r) => [r.name, r.n, fmt(r.rev)]))}</div>
  </div>
  <div class="card"><b>Заказы по статусам</b><div class="row">${Object.entries(STATUSES).map(([k, n]) => `<span class="pill" style="font-size:13px;padding:5px 12px">${n}: <b>${m.byStatus[k] || 0}</b></span>`).join('')}</div></div>`;
}

function ordersTab() {
  const rows = (S.d.orders || []).filter((o) => !S.statusFilter || o.status === S.statusFilter);
  const clientOpts = Object.fromEntries([['', 'Все клиенты'], ...(S.d.clients || []).map((c) => [c.id, c.name])]);
  return `<div class="row"><h1>Заказы</h1><span class="spacer"></span>
    ${sel(clientOpts, S.orderClient, 'data-act="orderClientFilter"')}${sel({ '': 'Все статусы', ...STATUSES }, S.statusFilter, 'data-act="filter"')}<button class="btn g" data-act="reload">Обновить</button></div>
    ${rangeBar()}
    <div class="msg">Период: ${periodLabel()} · заказов: <b>${rows.length}</b> · сумма (без отменённых): <b>${fmt(ordersSum(rows))}</b></div>
    ${rows.length ? rows.map((o) => `<div class="card" style="${o.status === 'failed' ? 'box-shadow:inset 0 0 0 2px #b53137' : ''}">
      <div class="row"><b class="geo green">№ ${esc(o.number)}</b><span class="muted">${fdt(o.created_at)}</span><b>${esc(o.clients ? o.clients.name : '')}</b><span class="spacer"></span><b class="geo">${fmt(o.total)}</b></div>
      <div class="muted">${o.pickup ? 'Самовывоз' : esc(o.address)}${o.comment ? ' · «' + esc(o.comment) + '»' : ''}</div>
      <div>${o.order_items.map((i) => `${esc(i.name)} × ${i.qty}`).join(', ')}</div>
      ${o.iiko_error ? `<div class="red">iiko: ${esc(o.iiko_error)}</div>` : ''}
      <div class="row">${sel(STATUSES, o.status, `data-act="orderStatus" data-id="${o.id}"`)}
        <span class="muted">${o.iiko_order_id ? 'iiko: ' + esc(o.iiko_order_id) : 'не передан в iiko'}</span>
        ${!o.iiko_order_id && o.status !== 'cancelled' ? `<button class="btn o" data-act="resend" data-id="${o.id}">${o.status === 'failed' || o.iiko_error ? 'Отправить в iiko заново' : 'Отправить в iiko'}</button>` : ''}<span class="spacer"></span>
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

function statusPills(c) {
  const p = [];
  if (c.status !== 'active') p.push('<span class="pill" style="background:#f6e3e4;color:#b53137">заблокирован</span>');
  else {
    if (c.stop_list) p.push(`<span class="pill" style="background:#f6e3e4;color:#b53137" title="${esc(c.stop_reason || '')}">стоп-лист${c.stop_reason ? ': ' + esc(c.stop_reason) : ''}</span>`);
    if (c.sleeping) p.push('<span class="pill" style="background:#fdf3dc;color:#8a6410">ссылка спит</span>');
    if (!p.length) p.push('<span class="pill" style="background:#e7f2eb;color:#006a2e">активен</span>');
  }
  return p.join(' ');
}

function clientsTab() {
  if (S.client) return clientDetail();
  const q = S.clientQ.toLowerCase();
  const F = S.clientFilter, all = S.d.clients || [];
  const rows = all.filter((c) => (!q || (c.name + ' ' + (c.phone || '')).toLowerCase().includes(q)) &&
    (!F || (F === 'stop' && c.stop_list) || (F === 'sleep' && c.sleeping && c.status === 'active') || (F === 'blocked' && c.status !== 'active')));
  const cnt = { stop: all.filter((c) => c.stop_list).length, sleep: all.filter((c) => c.sleeping && c.status === 'active').length, blocked: all.filter((c) => c.status !== 'active').length };
  return `<div class="row"><h1>Клиенты</h1><span class="spacer"></span>
    <select data-act="clientFilter"><option value="">Все (${all.length})</option><option value="stop" ${F === 'stop' ? 'selected' : ''}>Стоп-лист (${cnt.stop})</option><option value="sleep" ${F === 'sleep' ? 'selected' : ''}>Ссылка спит (${cnt.sleep})</option><option value="blocked" ${F === 'blocked' ? 'selected' : ''}>Заблокированные (${cnt.blocked})</option></select>
    <input class="inp" type="text" id="clientQ" placeholder="Поиск" value="${esc(S.clientQ)}"><button class="btn" data-act="newClient">+ Клиент</button></div>
    <div class="card scroll"><table><tr><th>Название</th><th>Телефон</th><th>Последний заказ</th><th>Статус</th><th></th></tr>
    ${rows.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.phone || '')}</td><td class="muted">${c.last_order_at ? fdt(c.last_order_at) : 'нет заказов'}</td><td>${statusPills(c)}</td>
      <td style="text-align:right;white-space:nowrap">
        ${c.status === 'active' ? (c.stop_list ? `<button class="btn g" data-act="stopOff" data-id="${c.id}">Снять стоп</button>` : `<button class="btn d" data-act="stopOn" data-id="${c.id}">В стоп-лист</button>`) : ''}
        ${c.sleeping && c.status === 'active' ? `<button class="btn o" data-act="wake" data-id="${c.id}">Разбудить</button>` : ''}
        <button class="btn g" data-act="openClient" data-id="${c.id}">Открыть</button></td></tr>`).join('')}</table>
    ${rows.length ? '' : '<div class="muted">Никого нет</div>'}
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
    <div class="card"><b>Доступ</b>
      <div>${statusPills(c)}</div>
      <div class="muted">Последний заказ: ${c.last_order_at ? fdt(c.last_order_at) : 'нет заказов'}</div>
      <label class="f">Причина стоп-листа (видна только вам)<input type="text" data-cf="stop_reason" value="${esc(c.stop_reason || '')}" placeholder="например: задолженность"></label>
      <div class="row">${c.stop_list ? `<button class="btn g" data-act="stopOff" data-id="${c.id}">Снять со стоп-листа</button>` : `<button class="btn d" data-act="stopOn" data-id="${c.id}">В стоп-лист</button>`}
        ${c.sleeping ? `<button class="btn o" data-act="wake" data-id="${c.id}">Разбудить ссылку</button>` : ''}</div>
      <span class="muted">Стоп-лист: клиент видит сайт, но не может отправить заявку. «Спит»: ссылка не открывает меню, пока вы не разбудите её.</span></div>
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

/* ---------- меню из Excel ---------- */
const HDR = { cat: ['категория', 'category', 'группа'], name: ['название', 'блюдо', 'наименование', 'name'], price: ['цена', 'price', 'стоимость'], iiko: ['iiko id', 'iiko_id', 'iiko', 'код iiko', 'код'], sort: ['порядок', 'sort', 'сортировка'], active: ['показывать', 'активно', 'в меню', 'active'] };
const cleanKey = (k) => String(k).trim().toLowerCase().replace(/\s+/g, ' ');
const pick = (row, names) => { for (const k of Object.keys(row)) if (names.includes(cleanKey(k))) return row[k]; return undefined; };
const toPrice = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = String(v).replace(/[\s\u00a0]|тг|₸/gi, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; // пустое или с буквами — ошибка, а не 0
};
const toBool = (v) => { const t = String(v).trim().toLowerCase(); if (t === '') return undefined; return !['нет', 'no', 'false', '0', 'н', '-'].includes(t); };
const COLORS = ['#008037', '#e0641c', '#b53137', '#e9ae2e', '#1d4f91', '#6e696a'];

function planImport(rows, hideMissing) {
  const items = S.d.items || [], cats = S.d.cats || [];
  const catByName = Object.fromEntries(cats.map((c) => [c.name.trim().toLowerCase(), c]));
  const byIiko = {}, byName = {};
  items.forEach((i) => { if (i.iiko_id) byIiko[String(i.iiko_id).trim()] = i; byName[i.name.trim().toLowerCase()] = i; });
  const plan = { add: [], upd: [], hide: [], errors: [], newCats: new Set(), seen: new Set(), same: 0 };
  rows.forEach((row, idx) => {
    const line = idx + 2, name = String(pick(row, HDR.name) ?? '').trim(), price = toPrice(pick(row, HDR.price));
    if (!name && String(pick(row, HDR.price) ?? '') === '') return; // пустая строка
    if (!name) return plan.errors.push(`строка ${line}: нет названия`);
    if (!(price >= 0)) {
      const iikoE = String(pick(row, HDR.iiko) ?? '').trim(), ex = (iikoE && byIiko[iikoE]) || byName[name.toLowerCase()];
      if (ex) plan.seen.add(ex.id); // блюдо есть в файле, просто строка с ошибкой: не скрываем его
      return plan.errors.push(`строка ${line} («${name}»): цена не число`);
    }
    const catName = String(pick(row, HDR.cat) ?? '').trim(), iiko = String(pick(row, HDR.iiko) ?? '').trim();
    const sortV = pick(row, HDR.sort), sort = sortV === undefined || sortV === '' ? undefined : Number(sortV), act = toBool(pick(row, HDR.active) ?? '');
    if (catName && !catByName[catName.toLowerCase()]) plan.newCats.add(catName);
    const cur = (iiko && byIiko[iiko]) || byName[name.toLowerCase()];
    if (!cur) return plan.add.push({ name, price, catName, iiko, sort, active: act === undefined ? true : act });
    plan.seen.add(cur.id);
    const patch = {}, notes = [];
    if (Number(cur.price) !== price) { patch.price = price; notes.push(`цена ${fmt(cur.price)} → ${fmt(price)}`); }
    if (cur.name !== name) { patch.name = name; notes.push('название'); }
    if (iiko && cur.iiko_id !== iiko) { patch.iiko_id = iiko; notes.push('iiko ID'); }
    if (sort !== undefined && !Number.isNaN(sort) && cur.sort !== sort) { patch.sort = sort; }
    const wantActive = act === undefined ? true : act;
    if (cur.active !== wantActive) { patch.active = wantActive; notes.push(wantActive ? 'включится' : 'скроется'); }
    const cc = catName && catByName[catName.toLowerCase()];
    if (cc && cur.category_id !== cc.id) { patch.category_id = cc.id; notes.push('категория'); }
    if (catName && !cc) { patch.catName = catName; notes.push('категория'); }
    if (Object.keys(patch).length) plan.upd.push({ id: cur.id, name: cur.name, patch, notes }); else plan.same++;
  });
  if (hideMissing) items.forEach((i) => { if (i.active && !plan.seen.has(i.id)) plan.hide.push(i); });
  return plan;
}

function iikoSyncCard() {
  const l = S.d.syncLast;
  const list = (title, arr) => arr && arr.length ? `<div><b>${title} (${arr.length})</b><div class="muted" style="max-height:120px;overflow:auto;font-size:13px">${arr.slice(0, 40).map(esc).join('<br>')}${arr.length > 40 ? '<br>…' : ''}</div></div>` : '';
  return `<div class="card"><b>Меню из iiko</b>
    <span class="muted">Цены и наличие блюд берутся из внешнего меню iiko. Обновляется только по кнопке: нажмите её после того, как выгрузили меню в iikoWeb. Новые блюда из iiko добавляются <b>скрытыми</b>: проверьте их и включите.</span>
    <div class="row"><button class="btn o" data-act="syncMenu">Обновить меню из iiko сейчас</button>
      ${l ? `<span class="muted">Последнее обновление: ${fdt(l.at)} · блюд в iiko: ${l.total}</span>` : '<span class="muted">Ещё не обновлялось</span>'}</div>
    ${l ? list('Изменились цены', l.prices) + list('Скрыты (нет в меню iiko)', l.hidden) + list('Возвращены в меню', l.restored) + list('Новые, скрыты, ждут вашей проверки', l.added) + list('Без цены в iiko', l.noPrice) : ''}</div>`;
}

function excelCard() {
  const x = S.xl;
  const list = (title, arr, cls) => arr.length ? `<div><b class="${cls || ''}">${title} (${arr.length})</b><div class="muted" style="max-height:140px;overflow:auto;font-size:13px">${arr.slice(0, 60).map(esc).join('<br>')}${arr.length > 60 ? '<br>…' : ''}</div></div>` : '';
  return `<div class="card"><b>Обновить меню из Excel</b>
    <span class="muted">Запасной вариант, если выгрузка из iiko не сработала. Столбцы: <b>Категория, Название, Цена</b>, а также по желанию iiko ID, Порядок, Показывать (да/нет). Блюдо ищется по iiko ID, а если его нет — по названию. Удобнее всего скачать текущее меню, поправить цены и загрузить обратно.</span>
    <div class="row"><button class="btn g" data-act="xlExport">Скачать текущее меню (Excel)</button><input type="file" accept=".xlsx,.xls,.csv" data-xl="1"></div>
    ${x ? `<div class="msg">Файл: <b>${esc(x.fileName)}</b> · новых блюд: <b>${x.plan.add.length}</b> · изменится: <b>${x.plan.upd.length}</b> · без изменений: ${x.plan.same} · скроется: <b>${x.plan.hide.length}</b>${x.plan.newCats.size ? ' · новых категорий: <b>' + x.plan.newCats.size + '</b>' : ''}</div>
      <label class="row"><input type="checkbox" data-act="xlHide" ${x.hide ? 'checked' : ''}> Скрыть блюда, которых нет в файле (меню на сегодня = то, что в файле)</label>
      ${list('Ошибки, эти строки будут пропущены', x.plan.errors, 'red')}
      ${list('Новые блюда', x.plan.add.map((a) => a.name + ' — ' + fmt(a.price)))}
      ${list('Изменения', x.plan.upd.map((u) => u.name + ': ' + u.notes.join(', ')))}
      ${list('Будут скрыты', x.plan.hide.map((h) => h.name))}
      <div class="row"><button class="btn o" data-act="xlApply" ${x.plan.add.length + x.plan.upd.length + x.plan.hide.length ? '' : 'disabled'}>Применить</button><button class="btn g" data-act="xlCancel">Отмена</button></div>` : ''}</div>`;
}

function menuTab() {
  const { cats = [], items = [] } = S.d;
  const catOpts = Object.fromEntries([['', '— без категории —'], ...cats.map((c) => [c.id, c.name])]);
  return `<div class="row"><h1>Меню</h1><span class="spacer"></span><button class="btn g" data-act="newCat">+ Категория</button><button class="btn" data-act="newItem">+ Блюдо</button></div>
  ${iikoSyncCard()}
  ${excelCard()}
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
  const names = { sleep_days: 'Через сколько дней без заказов ссылка клиента «засыпает»', min_delivery: 'Минимальная сумма доставки, тг', pickup_address: 'Адрес самовывоза', pickup_from: 'Самовывоз с (время)', manager_phone: 'Телефон менеджера' };
  return `<h1>Настройки</h1>
  <div class="card"><b>Связь с Telegram и iiko</b>
    <span class="muted">Ключи хранятся только в переменных окружения Vercel, здесь они не вводятся. Если заказ не попал на кассу, в Telegram придёт сообщение.</span>
    <div class="row"><button class="btn" data-act="checkTg">Проверить Telegram</button><button class="btn" data-act="checkIiko">Проверить iiko</button><button class="btn g" data-act="checkWebhook">Подключить кнопки Telegram</button></div>
    ${S.checkMsg ? `<pre class="link" style="white-space:pre-wrap">${esc(S.checkMsg)}</pre>` : ''}</div>
  <div class="card">${(S.d.settings || []).map((s) => `<label class="f">${esc(names[s.key] || s.key)}
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
  const body = { dashboard: dashboardTab, orders: ordersTab, requests: requestsTab, clients: clientsTab, feedback: feedbackTab, menu: menuTab, certs: certsTab, settings: settingsTab }[S.tab]();
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
  clientFilter: (el) => { S.clientFilter = el.value; render(); },
  goClients: async (el) => { S.tab = 'clients'; S.client = null; S.clientFilter = el.dataset.v; await loadTab('clients'); },
  stopOn: async (el) => {
    const reason = window.prompt('Причина (видна только вам), например: задолженность', ''); if (reason === null) return;
    if (await run(db.from('clients').update({ stop_list: true, stop_reason: reason.trim() || null, stop_since: new Date().toISOString() }).eq('id', el.dataset.id), 'Клиент в стоп-листе: заявки отправить не сможет')) { await countNew(); await afterClientChange(el.dataset.id); }
  },
  stopOff: async (el) => { if (await run(db.from('clients').update({ stop_list: false, stop_reason: null, stop_since: null }).eq('id', el.dataset.id), 'Снят со стоп-листа')) { await countNew(); await afterClientChange(el.dataset.id); } },
  wake: async (el) => { if (await run(db.from('clients').update({ woken_at: new Date().toISOString() }).eq('id', el.dataset.id), 'Ссылка снова работает')) { await countNew(); await afterClientChange(el.dataset.id); } },
  syncMenu: async (el) => {
    el.disabled = true; el.textContent = 'Обновляем…';
    const r = await api('/api/sync-menu', {});
    if (r.ok) note(`Меню обновлено: цен изменено ${r.prices.length}, скрыто ${r.hidden.length}, возвращено ${r.restored.length}, новых ${r.added.length}`);
    else note('Не удалось: ' + (r.error || 'ошибка'), true);
    await loadTab('menu');
  },
  xlCancel: () => { S.xl = null; render(); },
  xlHide: (el) => { S.xl.hide = el.checked; S.xl.plan = planImport(S.xl.rows, S.xl.hide); render(); },
  xlExport: () => {
    const cats = Object.fromEntries((S.d.cats || []).map((c) => [c.id, c.name]));
    const aoa = [['Категория', 'Название', 'Цена', 'iiko ID', 'Порядок', 'Показывать'], ...(S.d.items || []).map((i) => [cats[i.category_id] || '', i.name, Number(i.price), i.iiko_id || '', i.sort, i.active ? 'да' : 'нет'])];
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 22 }, { wch: 38 }, { wch: 10 }, { wch: 38 }, { wch: 9 }, { wch: 11 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Меню'); XLSX.writeFile(wb, 'menu-' + ymd(new Date()) + '.xlsx');
  },
  xlApply: async () => {
    const x = S.xl; if (!x) return; const plan = x.plan;
    if (plan.hide.length && plan.hide.length >= (S.d.items || []).filter((i) => i.active).length && !ask('Будут скрыты ВСЕ активные блюда. Файл точно правильный?')) return;
    // 1) категории
    const catsNow = (await db.from('categories').select('*')).data || [], catId = Object.fromEntries(catsNow.map((c) => [c.name.trim().toLowerCase(), c.id]));
    let n = catsNow.length;
    for (const name of plan.newCats) { const r = await run(db.from('categories').insert({ name, color: COLORS[n % COLORS.length], sort: ++n }).select().single()); if (!r) return; catId[name.toLowerCase()] = r.id; }
    // 2) обновления
    for (const u of plan.upd) {
      const patch = { ...u.patch }; if (patch.catName) { patch.category_id = catId[patch.catName.toLowerCase()]; delete patch.catName; }
      patch.updated_at = new Date().toISOString();
      if (!(await run(db.from('menu_items').update(patch).eq('id', u.id)))) return;
    }
    // 3) новые
    if (plan.add.length) {
      const rows = plan.add.map((a, i) => ({ name: a.name, price: a.price, category_id: a.catName ? catId[a.catName.toLowerCase()] : null, iiko_id: a.iiko || null, sort: a.sort ?? 1000 + i, active: a.active }));
      if (!(await run(db.from('menu_items').insert(rows)))) return;
    }
    // 4) скрыть отсутствующие
    if (plan.hide.length && !(await run(db.from('menu_items').update({ active: false }).in('id', plan.hide.map((h) => h.id))))) return;
    S.xl = null; note(`Меню обновлено: новых ${plan.add.length}, изменено ${plan.upd.length}, скрыто ${plan.hide.length}`); await loadTab('menu');
  },
  checkWebhook: async () => { S.checkMsg = 'Подключаем…'; render(); const r = await api('/api/check', { what: 'telegram-webhook' }); S.checkMsg = r.message || r.error || 'Нет ответа'; render(); },
  resend: async (el) => {
    el.disabled = true; el.textContent = 'Отправляем…';
    const r = await api('/api/send-order', { order_id: Number(el.dataset.id) });
    if (r.ok) note(r.already ? 'Заказ уже был передан в iiko' : 'Заказ передан в iiko'); else note('Не удалось: ' + (r.error || 'ошибка') + (r.telegram && r.telegram.sent ? ' (уведомление отправлено в Telegram)' : ''), true);
    await loadTab('orders');
  },
  toFailed: async () => { S.tab = 'orders'; S.statusFilter = 'failed'; await loadTab('orders'); },
  checkTg: async () => { S.checkMsg = 'Проверяем…'; render(); const r = await api('/api/check', { what: 'telegram' }); S.checkMsg = r.message || r.error || 'Нет ответа'; render(); },
  checkIiko: async () => { S.checkMsg = 'Проверяем…'; render(); const r = await api('/api/check', { what: 'iiko' }); S.checkMsg = r.message || r.error || 'Нет ответа'; render(); },
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
async function afterClientChange(id) { await loadTab('clients'); if (S.client && String(S.client.c.id) === String(id)) await openClient(id); }
async function reloadRange() { if (S.tab === 'clients' && S.client) { await loadClientOrders(); render(); } else await loadTab(S.tab === 'dashboard' ? 'dashboard' : 'orders'); }
async function openClientTab(id) { S.tab = 'clients'; if (!S.d.clients) await loadTab('clients'); await openClient(id); }

document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el && el.tagName !== 'SELECT' && el.type !== 'date' && A[el.dataset.act]) { if (el.tagName === 'A') e.preventDefault(); A[el.dataset.act](el); } });
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'loginForm') return; e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: val('em'), password: val('pw') });
  if (error) { S.err = 'Неверный email или пароль'; render(); } else await boot();
});
document.addEventListener('input', (e) => { if (e.target.id === 'clientQ') { S.clientQ = e.target.value; render(); } });
document.addEventListener('change', async (e) => {
  const el = e.target;
  if ((el.tagName === 'SELECT' || el.type === 'date') && el.dataset.act && A[el.dataset.act]) return A[el.dataset.act](el);
  if (el.dataset.xl) {
    const f = el.files[0]; if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' }), ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) return note('В файле нет строк', true);
      S.xl = { fileName: f.name, rows, hide: true }; S.xl.plan = planImport(rows, true); render();
    } catch (err) { note('Не удалось прочитать файл: ' + err.message, true); }
    return;
  }
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

/* ---------- подсказка на графиках ---------- */
const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
function showTip(el, x, y) {
  const [a, b, c] = (el.dataset.tip || '').split('|'); tip.textContent = '';
  const v = document.createElement('div'); v.className = 'tv1'; v.textContent = b;
  const l = document.createElement('div'); l.className = 'tl1'; l.textContent = a + (c ? ' · ' + c : '');
  tip.append(v, l); tip.style.display = 'block';
  const r = tip.getBoundingClientRect(); tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12)) + 'px'; tip.style.top = Math.max(8, y - r.height - 12) + 'px';
}
document.addEventListener('pointermove', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else tip.style.display = 'none'; });
document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); } });
document.addEventListener('focusout', () => { tip.style.display = 'none'; });

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
