(() => {
'use strict';
const CFG = window.TG_CONFIG;
const TOKEN_KEY = 'tg_token';

/* ---------- утилиты ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' тг';
const fdate = (iso) => new Date(iso).toLocaleDateString('ru-RU');
const ftime = (iso) => new Date(iso).toTimeString().slice(0, 5);
const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: (k) => { try { localStorage.removeItem(k); } catch (e) {} },
};

async function rpc(name, args) {
  const r = await fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) { const err = new Error((body && body.message) || 'request_failed'); err.code = err.message; throw err; }
  return body;
}

/* ---------- состояние ---------- */
const S = {
  token: null, data: null, loading: true, fatal: null,
  view: 'menu', authTab: 'login', regSent: false, regError: '',
  qty: {}, pend: {}, pickup: false, addr: '', q: '', active: 0, comment: '',
  cartOpen: false, sending: false, done: null, cartError: '',
  modal: null, draftName: '', repOrder: null, repAddr: '', newAddr: '',
  openOrder: null, idem: null, cartNotice: '', gate: null,
  fbKind: 'review', fbRating: 5, fbText: '', fbSent: false, fbError: '', fbSending: false,
};

const settings = () => (S.data && S.data.settings) || {};
const minDelivery = () => Number(settings().min_delivery || 0);
const allItems = () => { const m = {}; (S.data ? S.data.menu : []).forEach((c) => c.items.forEach((i) => { m[i.id] = i; })); return m; };

/* ---------- загрузка ---------- */
async function load() {
  S.loading = true; render();
  try {
    const data = await rpc('shop_data', { p_token: S.token });
    if (!data) { store.del(TOKEN_KEY); S.token = null; S.data = null; S.gate = null; S.fatal = 'Ссылка недействительна. Запросите новую у менеджера.'; }
    else if (data.state) { S.gate = data; S.data = null; S.fatal = null; }
    else {
      S.gate = null; S.data = data; S.fatal = null;
      if (!S.addr || !data.addresses.includes(S.addr)) S.addr = data.addresses[0] || '';
    }
  } catch (e) { S.fatal = 'Не удалось загрузить данные. Проверьте интернет и обновите страницу.'; }
  S.loading = false; render();
}

/* ---------- график работы ---------- */
function sched() {
  const now = new Date(), wd = (now.getDay() + 6) % 7, hr = now.getHours();
  const mode = wd === 5 ? 'weekend' : wd === 6 ? (hr < 18 ? 'sunday' : 'closed') : hr < 19 ? 'open' : 'closed';
  const T = {
    open: ['Приём заявок открыт до 19:00', '#e7f2eb', '#008037'],
    sunday: ['Принимаем заявки на понедельник до 18:00', '#e7f2eb', '#008037'],
    closed: ['Приём заявок на сегодня закрыт', '#fbe9de', '#c95614'],
    weekend: ['Сегодня выходной — заявки на понедельник принимаем в воскресенье до 18:00', '#fbe9de', '#c95614'],
  }[mode];
  const week = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((l, i) =>
    `<span style="background:${i >= 5 ? 'transparent' : '#fff'};color:${i >= 5 ? '#a8a2a0' : '#393536'};box-shadow:${i === wd ? 'inset 0 0 0 2px ' + T[2] : i >= 5 ? 'inset 0 0 0 1px #d9d5d0' : 'none'}">${l}</span>`).join('');
  return { title: T[0], bg: T[1], fg: T[2], week };
}

/* ---------- заказы ---------- */
const STATUS = {
  new: ['получена', '#e7f2eb', '#008037'], accepted: ['принята', '#e7f2eb', '#008037'],
  cooking: ['готовится', '#fdf3dc', '#8a6410'], delivering: ['в пути', '#e3eefc', '#1d4f91'],
  done: ['выполнен', '#e7f2eb', '#008037'], cancelled: ['отменён', '#efece7', '#6e696a'], failed: ['не принят', '#f6e3e4', '#b53137'],
};
function eventView(ev, o) {
  const cnt = o.items.reduce((a, i) => a + i.qty, 0);
  const where = o.pickup ? 'самовывоз' : o.address;
  const phone = settings().manager_phone || '';
  const T = {
    new: ['Заявка отправлена с сайта', `${o.items.length} поз. · ${cnt} шт · ${where}`, '#008037', '#393536'],
    accepted: ['Заявка принята', 'Проверены цены, адрес и минимальная сумма', '#008037', '#393536'],
    cooking: ['Готовится на кухне', '', '#008037', '#393536'],
    delivering: ['Передана в доставку', '', '#008037', '#393536'],
    done: ['Заказ выполнен', '', '#008037', '#393536'],
    cancelled: ['Заказ отменён', ev.note || '', '#6e696a', '#6e696a'],
    failed: ['Не передана на кухню', (ev.note ? ev.note + '. ' : '') + 'Позвоните ' + phone, '#b53137', '#b53137'],
  }[ev.status] || [ev.status, ev.note || '', '#6e696a', '#393536'];
  return `<li><span class="dot" style="background:${T[2]}"></span><span class="muted" style="font:500 13px Rubik,sans-serif;font-variant-numeric:tabular-nums;padding-top:1px">${ftime(ev.at)}</span>
    <span style="display:grid;gap:1px"><span style="font-size:14px;font-weight:500;color:${T[3]}">${esc(T[0])}</span><span class="muted" style="font-size:13px">${esc(T[1])}</span></span></li>`;
}

/* ---------- корзина ---------- */
function setQty(id, v) {
  v = Math.max(0, Math.min(999, Math.round(Number(String(v).replace(/\D/g, '')) || 0)));
  if (v) S.qty[id] = v; else delete S.qty[id];
  S.cartError = ''; S.idem = null;
}
function cartLines() {
  const items = allItems();
  return Object.keys(S.qty).filter((id) => items[id]).map((id) => ({ ...items[id], qty: S.qty[id] }));
}
function scrollToCat(i) {
  const el = document.getElementById('cat-' + i), h = document.querySelector('header.top');
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (h ? h.getBoundingClientRect().height : 0) - 4, behavior: 'smooth' });
}

/* ---------- представления ---------- */
function gateView() {
  const g = S.gate, phone = (g.settings && g.settings.manager_phone) || '', sleeping = g.state === 'sleeping';
  return `<div class="auth"><div class="auth-in"><div class="auth-head">
    <div class="geo green" style="font-weight:700;font-size:30px;line-height:1.1;text-transform:uppercase;letter-spacing:.01em">Tasty Gourmet</div>
    <div class="geo" style="font-weight:600;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#e0641c">оптовые заявки</div></div>
    <div class="card" style="text-align:center">
      <div class="geo" style="font-weight:600;font-size:20px">${esc(g.client && g.client.name)}</div>
      <p style="margin:0">${sleeping ? 'Ссылка неактивна: давно не было заказов. Чтобы продолжить, свяжитесь с менеджером — он вернёт доступ.' : 'Доступ для вашей точки закрыт. Пожалуйста, свяжитесь с менеджером.'}</p>
      ${phone ? `<a class="btn btn-orange" style="text-decoration:none;display:block" href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">Позвонить: ${esc(phone)}</a>` : ''}
      <button class="btn-ghost" data-act="retryLoad">Проверить снова</button>
    </div></div></div>`;
}

function authView() {
  if (S.gate) return gateView();
  const reg = S.authTab === 'reg';
  return `<div class="auth"><div class="auth-in">
    <div class="auth-head">
      <div class="geo green" style="font-weight:700;font-size:30px;line-height:1.1;text-transform:uppercase;letter-spacing:.01em">Tasty Gourmet</div>
      <div class="geo" style="font-weight:600;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#e0641c">оптовые заявки</div>
      <p class="muted" style="margin:8px 0 0;font-size:15px">Заказы для кофеен, офисов и магазинов. Цены доступны зарегистрированным точкам.</p>
      <div style="display:flex;justify-content:center;gap:28px;margin:10px 0 4px">
        <div style="display:grid"><b class="geo green" style="font-size:26px;line-height:1.1">170</b><span class="muted" style="font-size:13px">точек получают<br>отгрузку ежедневно</span></div>
        <div style="width:1px;background:#e3e0dc"></div>
        <div style="display:grid"><b class="geo green" style="font-size:26px;line-height:1.1">8+ лет</b><span class="muted" style="font-size:13px">на рынке<br>Казахстана</span></div>
      </div>
      <p class="muted" style="margin:0;font-size:14px">Приём заявок: Пн–Пт до 19:00, Вс до 18:00 · Сб, Вс — выходные<br>В праздники график уточняйте у менеджера</p>
    </div>
    <div class="tabs">
      <button data-act="tab" data-v="login" style="background:${reg ? 'transparent' : '#008037'};color:${reg ? '#6e696a' : '#fff'}">Вход</button>
      <button data-act="tab" data-v="reg" style="background:${reg ? '#008037' : 'transparent'};color:${reg ? '#fff' : '#6e696a'}">Регистрация</button>
    </div>
    ${S.fatal ? `<div class="err">${esc(S.fatal)}</div>` : ''}
    ${!reg ? `<div class="card">
      <p style="margin:0;font-size:15px">Откройте личную ссылку, которую прислал менеджер в WhatsApp, — вход выполнится автоматически.</p>
      <label class="field">Или вставьте ссылку сюда<input id="linkIn" placeholder="https://…/?t=…"></label>
      <button class="btn btn-orange" data-act="loginLink">Войти</button>
      <p class="muted" style="margin:0;font-size:14px">Нет ссылки? Отправьте заявку во вкладке «Регистрация».</p>
    </div>` : `<div class="card">${S.regSent ? `<div style="display:grid;gap:8px">
        <div class="geo green" style="font-weight:700;font-size:20px">Заявка отправлена</div>
        <p class="muted" style="margin:0">Менеджер проверит данные и пришлёт личную ссылку в WhatsApp.</p></div>` : `
      ${S.regError ? `<div class="err">${esc(S.regError)}</div>` : ''}
      <label class="field">Название точки<input id="rName" maxlength="80" placeholder="Кофейня Достык"></label>
      <label class="field">Телефон<input id="rPhone" type="tel" maxlength="30" placeholder="8 701 123 45 67"></label>
      <label class="field">Адрес доставки<input id="rAddr" maxlength="300" placeholder="ул. Достык 97, офис 3"></label>
      <label class="field">Контактное лицо (необязательно)<input id="rContact" maxlength="80" placeholder="Айгуль"></label>
      <button class="btn btn-orange" data-act="sendReg" style="margin-top:4px">Отправить заявку</button>`}</div>`}
  </div></div>`;
}

function dishCard(it) {
  const q = S.qty[it.id];
  return `<article class="dish" style="box-shadow:${q ? 'inset 0 0 0 2px #008037' : 'none'}">
    <div class="ph"><span>фото блюда</span></div>
    <div class="dish-name">${esc(it.name)}</div>
    <div class="dish-row"><div class="price">${fmt(it.price)}</div>
    ${q ? `<div class="stepper"><button class="m" data-act="dec" data-id="${it.id}" aria-label="Убрать">−</button>
        <input type="text" inputmode="numeric" value="${q}" data-chg="qty" data-id="${it.id}" aria-label="Количество">
        <button class="p" data-act="inc" data-id="${it.id}" aria-label="Добавить">+</button></div>`
      : `<div class="add"><input type="text" inputmode="numeric" id="pend-${it.id}" value="${esc(S.pend[it.id] || '')}" placeholder="1" data-chg="pend" data-id="${it.id}" aria-label="Количество">
        <button data-act="add" data-id="${it.id}">Добавить</button></div>`}
    </div></article>`;
}

function menuView() {
  const q = norm(S.q.trim());
  const secs = S.data.menu.map((c, i) => ({ c, i, items: c.items.filter((it) => !q || norm(it.name).includes(q)) })).filter((s) => s.items.length);
  const sc = sched();
  const certs = S.data.certificates;
  const stopped = S.data.client.stopped;
  return `<main>
    ${stopped ? stopBanner() : ''}
    <div class="sched" style="background:${sc.bg}">
      <div style="display:grid;gap:2px;min-width:0">
        <div class="geo" style="font-weight:600;font-size:16px;color:${sc.fg}">${sc.title}</div>
        <div class="muted" style="font-size:14px">Приём заявок: Пн–Пт до 19:00, Вс до 18:00 · Доставка: Пн–Пт 7:00–11:00 · Сб, Вс — выходные</div>
        <div class="muted" style="font-size:13px">В праздничные дни график уточняйте у менеджера</div>
      </div>
      <div class="week" aria-label="График работы">${sc.week}</div>
    </div>
    ${secs.map((s) => `<section class="cat" id="cat-${s.i}">
      <h2 class="cat-h"><i style="background:${esc(s.c.color)}"></i>${esc(s.c.name)}</h2>
      <div class="grid">${s.items.map(dishCard).join('')}</div></section>`).join('')}
    ${secs.length ? '' : '<p class="empty">Ничего не найдено</p>'}
    ${certs.length ? `<section class="cat" id="certificates" style="padding-top:40px">
      <h2 class="cat-h"><i style="background:#008037"></i>Сертификаты</h2>
      <div class="grid certs-grid">${certs.map(certCard).join('')}</div></section>` : ''}
    <footer class="foot">
      <span><b class="geo green" style="text-transform:uppercase">Tasty Gourmet</b> · более 8 лет на рынке · ежедневно отгружаем 170 точкам</span>
      <span>Менеджер: ${esc(settings().manager_phone || '')}</span>
    </footer></main>`;
}

function dlUrl(c) {
  const ext = ((c.file_url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'pdf';
  const name = String(c.title || 'certificate').replace(/[^\wА-Яа-яЁё.\- ]+/g, '').trim().replace(/\s+/g, '_') + '.' + ext;
  return c.file_url + (c.file_url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(name);
}
const stopText = () => 'Приём заявок для вашей точки приостановлен. Пожалуйста, свяжитесь с менеджером' + (settings().manager_phone ? ': ' + settings().manager_phone : '') + '.';
function stopBanner() { return `<div class="err" style="margin-top:20px;font-size:15px"><b>${esc(stopText())}</b></div>`; }

function certCard(c) {
  const isImg = c.file_url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(c.file_url);
  const pic = isImg
    ? `<a class="ph" href="${esc(c.file_url)}" target="_blank" rel="noopener"><img src="${esc(c.file_url)}" alt="${esc(c.title)}" loading="lazy"></a>`
    : `<div class="ph"><span>${c.file_url ? 'документ' : 'скан сертификата'}</span></div>`;
  return `<article class="dish">${pic}<div style="display:grid;gap:2px;padding:0 4px">
    <div class="cert-title">${esc(c.title)}</div><div class="cert-note">${esc(c.note || '')}</div>
    ${c.file_url ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      ${!isImg ? `<a class="btn-ghost" style="text-decoration:none" href="${esc(c.file_url)}" target="_blank" rel="noopener">Открыть</a>` : ''}
      <a class="btn-soft" style="text-decoration:none" href="${esc(dlUrl(c))}" download>Скачать</a></div>` : ''}</div></article>`;
}

function ordersView() {
  const items = allItems();
  return `<div class="orders"><h2 class="geo" style="margin:0 0 4px;font-weight:700;font-size:26px;text-transform:uppercase">Мои заказы</h2>
  ${S.data.orders.length ? '' : '<p class="muted">Заказов пока нет.</p>'}
  ${S.data.orders.map((o) => {
    const st = STATUS[o.status] || [o.status, '#efece7', '#6e696a'], open = S.openOrder === o.id;
    const canRepeat = o.items.some((i) => items[i.item_id]);
    return `<div class="order">
      <div class="order-top"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b class="geo green" style="font-size:17px">№ ${esc(o.number)}</b><span class="muted" style="font-size:14px">${fdate(o.created_at)} · ${ftime(o.created_at)}</span></div>
        <b class="geo" style="font-size:17px;font-variant-numeric:tabular-nums">${fmt(o.total)}</b></div>
      <div class="muted" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:14px"><span class="pill" style="background:${st[1]};color:${st[2]}">${st[0]}</span>${o.pickup ? 'Самовывоз' : esc(o.address)}</div>
      <div style="font-size:14px;line-height:1.6">${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join(', ')}</div>
      ${open ? `<ol class="timeline">${o.events.map((e) => eventView(e, o)).join('')}</ol>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-ghost" data-act="toggleOrder" data-id="${o.id}">${open ? 'Скрыть историю' : 'История заявки'}</button>
        ${canRepeat ? `<button class="btn-soft" data-act="repeat" data-id="${o.id}">${o.status === 'failed' ? 'Отправить заново' : 'Повторить заказ'}</button>` : ''}
      </div></div>`;
  }).join('')}</div>`;
}

function feedbackView() {
  const rv = S.fbKind === 'review';
  const tab = (on) => `background:${on ? '#008037' : 'transparent'};color:${on ? '#fff' : '#6e696a'}`;
  if (S.fbSent) return `<div class="orders"><div class="card" style="text-align:center">
    <div style="width:64px;height:64px;border-radius:50%;background:#008037;color:#fff;display:grid;place-items:center;font:700 30px Geologica,sans-serif;margin:0 auto">✓</div>
    <div class="geo green" style="font-weight:700;font-size:22px">Спасибо!</div>
    <p class="muted" style="margin:0">Мы получили ваше сообщение и обязательно его прочитаем.</p>
    <button class="btn btn-green" data-act="fbAgain">Написать ещё</button></div></div>`;
  return `<div class="orders"><h2 class="geo" style="margin:0 0 4px;font-weight:700;font-size:26px;text-transform:uppercase">Отзывы и предложения</h2>
    <div class="card">
      <div class="tabs" style="background:#f4f3f0"><button data-act="fbKind" data-v="review" style="${tab(rv)}">Отзыв</button><button data-act="fbKind" data-v="suggestion" style="${tab(!rv)}">Предложение</button></div>
      ${rv ? `<div><div class="muted" style="font-size:13px;font-weight:500;margin-bottom:6px">Ваша оценка</div><div style="display:flex;gap:4px">
        ${[1, 2, 3, 4, 5].map((n) => `<button data-act="fbRate" data-v="${n}" aria-label="${n}" style="border:0;background:none;font-size:32px;line-height:1;padding:0 2px;color:${n <= S.fbRating ? '#e9ae2e' : '#d9d5d0'}">★</button>`).join('')}</div></div>` : ''}
      <label class="field">${rv ? 'Расскажите, как всё прошло' : 'Что нам улучшить или добавить?'}
        <textarea id="fbText" rows="5" maxlength="2000" placeholder="${rv ? 'Качество блюд, доставка, работа менеджера…' : 'Новые блюда, удобство сайта, условия доставки…'}">${esc(S.fbText)}</textarea></label>
      ${S.fbError ? `<div class="err">${esc(S.fbError)}</div>` : ''}
      <button class="btn btn-orange" data-act="sendFb" ${S.fbSending ? 'disabled' : ''}>${S.fbSending ? 'Отправляем…' : 'Отправить'}</button>
    </div></div>`;
}

function modalView() {
  if (!S.modal) return '';
  const addrs = S.data.addresses;
  let title = '', body = '';
  if (S.modal === 'rename') {
    title = 'Название точки';
    body = `<label class="field">Название точки, как у организации<input id="draftName" value="${esc(S.draftName)}" maxlength="80"></label>
      <p class="muted" style="margin:0;font-size:13px">Менеджер увидит изменение в админ-панели.</p>
      <button class="btn btn-green" data-act="saveName">Сохранить</button>`;
  } else if (S.modal === 'repeat') {
    const o = S.repOrder, cant = S.repAddr === '__new' && !S.newAddr.trim();
    title = 'Повторить заказ № ' + o.number;
    body = `<p class="muted" style="margin:0;font-size:14px">Те же блюда и количество. Выберите, куда доставить:</p>
      ${[...addrs, '__new'].map((a) => { const on = S.repAddr === a; const c = on ? '#008037' : '#e3e0dc'; const blocked = a !== '__new' && repeatBlocked(o, a);
        return `<button class="pick" ${blocked ? 'disabled' : `data-act="pickAddr" data-v="${esc(a)}"`} style="border-color:${c};background:${on ? '#f1f7f3' : '#fff'};${blocked ? 'opacity:.5;cursor:default' : ''}"><i style="border-color:${c};background:${on ? '#008037' : '#fff'}"></i><span style="flex:1">${a === '__new' ? '+ Другой адрес' : esc(a)}</span>${blocked ? '<span class="muted" style="font-size:12px">уже заказано сегодня</span>' : o.address === a ? '<span class="muted" style="font-size:12px">был в заказе</span>' : ''}</button>`; }).join('')}
      ${S.repAddr === '__new' ? `<input class="inp" id="newAddr" value="${esc(S.newAddr)}" placeholder="ул. Абая 150, офис 3" aria-label="Новый адрес">` : ''}
      <button class="btn btn-orange" data-act="doRepeat" ${cant ? 'disabled' : ''} style="margin-top:4px">Добавить в корзину</button>`;
  } else if (S.modal === 'addr') {
    title = 'Новый адрес';
    body = `<input class="inp" id="newAddr" value="${esc(S.newAddr)}" placeholder="ул. Абая 150, офис 3" aria-label="Новый адрес">
      <button class="btn btn-green" data-act="saveAddr" ${S.newAddr.trim().length < 3 ? 'disabled' : ''}>Сохранить адрес</button>`;
  }
  return `<div class="shade" style="z-index:50" data-act="closeModal"></div><div class="modal" role="dialog">
    <div class="modal-h"><div class="geo" style="font-weight:700;font-size:20px;text-transform:uppercase">${esc(title)}</div><button class="x" data-act="closeModal" aria-label="Закрыть">×</button></div>${body}</div>`;
}

function cartView() {
  if (!S.cartOpen) return '';
  const lines = cartLines(), cnt = lines.reduce((a, l) => a + l.qty, 0), sum = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const min = minDelivery(), stopped = S.data.client.stopped, short = !S.pickup && cnt && sum < min;
  const where = S.pickup ? 'Самовывоз: ' + (settings().pickup_address || '') : 'Доставка: ' + S.addr;
  let inner;
  if (S.done) {
    inner = `<div class="center"><div style="width:64px;height:64px;border-radius:50%;background:#008037;color:#fff;display:grid;place-items:center;font:700 30px Geologica,sans-serif;margin:0 auto">✓</div>
      <div class="geo green" style="font-weight:700;font-size:24px">Заказ № ${esc(S.done.number)} принят</div>
      <p class="muted" style="margin:0">${esc(S.done.where)}<br>Статус заявки смотрите в разделе «Мои заказы».</p>
      <button class="btn btn-green" data-act="finish" style="margin-top:8px">Готово</button></div>`;
  } else if (!cnt) {
    inner = `<div class="center"><div class="geo" style="font-weight:600;font-size:18px">В корзине пусто</div><p class="muted" style="margin:0">Добавьте блюда из меню</p>
      <button data-act="closeCart" style="border:0;border-radius:999px;padding:12px 22px;background:#fbe9de;color:#c95614;font:600 15px Rubik,sans-serif">Перейти в меню</button></div>`;
  } else {
    inner = `<div class="cart-body">
      <div class="lines">${lines.map((l) => `<div class="line">
        <div style="min-width:0"><div style="font-weight:500;line-height:1.3">${esc(l.name)}</div><div class="muted" style="font-size:13px">${fmt(l.price)} × ${l.qty}</div></div>
        <div class="geo" style="font-weight:600;font-size:16px;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right">${fmt(l.price * l.qty)}</div>
        <button class="rm" data-act="remove" data-id="${l.id}">Убрать</button>
        <div class="stepper sm"><button class="m" data-act="dec" data-id="${l.id}" aria-label="Убрать">−</button>
          <input type="text" inputmode="numeric" value="${l.qty}" data-chg="qty" data-id="${l.id}" aria-label="Количество">
          <button class="p" data-act="inc" data-id="${l.id}" aria-label="Добавить">+</button></div></div>`).join('')}</div>
      ${S.cartNotice ? `<div class="err" style="background:#fdf3dc;color:#8a6410">${esc(S.cartNotice)}</div>` : ''}
      <div class="box"><div class="muted" style="font-size:13px;font-weight:500">${S.pickup ? 'Получение' : 'Адрес доставки'}</div>
        <div style="font-weight:500">${esc(where)}</div>
        <textarea id="comment" rows="2" maxlength="500" placeholder="Комментарий: ориентир, время, пожелания" class="inp" style="font-size:15px;resize:vertical">${esc(S.comment)}</textarea></div></div>
      <div class="cart-foot">
        ${stopped ? `<div class="err">${esc(stopText())}</div>` : ''}
        ${S.cartError ? `<div class="err">${esc(S.cartError)}</div>` : ''}
        ${!S.pickup ? `<div style="display:grid;gap:6px"><div style="font-size:14px;color:${short ? '#b53137' : '#008037'}">${short ? `До минимальной суммы доставки ${fmt(min)} осталось ${fmt(min - sum)}` : 'Минимальная сумма доставки набрана'}</div>
          <div class="bar"><div style="width:${Math.min(100, min ? sum / min * 100 : 100)}%;background:${short ? '#e0641c' : '#008037'}"></div></div></div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px"><span class="muted">${cnt} шт · ${lines.length} поз.</span><b class="geo" style="font-size:24px;font-variant-numeric:tabular-nums">${fmt(sum)}</b></div>
        <button class="btn btn-orange" data-act="submit" ${short || S.sending || stopped ? 'disabled' : ''} style="padding:16px 22px;font-size:17px">${S.sending ? 'Отправляем…' : 'Отправить заявку · ' + fmt(sum)}</button></div>`;
  }
  return `<div class="shade" style="z-index:40" data-act="closeCart"></div><aside class="cart" role="dialog" aria-label="Корзина">
    <div class="cart-h"><div class="geo" style="font-weight:700;font-size:22px;text-transform:uppercase">${S.done ? 'Готово' : 'Корзина'}</div>
      <button class="x" data-act="closeCart" aria-label="Закрыть" style="width:40px;height:40px;font-size:22px">×</button></div>${inner}</aside>`;
}

function shopView() {
  const lines = cartLines(), cnt = lines.reduce((a, l) => a + l.qty, 0), sum = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const seg = (on) => `background:${on ? '#fff' : 'transparent'};color:${on ? '#393536' : '#6e696a'};box-shadow:${on ? '0 1px 3px rgba(57,53,54,.15)' : 'none'}`;
  const isMenu = S.view === 'menu';
  const chips = S.data.menu.map((c, i) => { const k = c.items.filter((it) => S.qty[it.id]).length, on = i === S.active, col = esc(c.color);
    return `<button class="chip" data-act="goCat" data-id="${i}" style="border-color:${col};background:${on ? col : '#fff'};color:${on ? '#fff' : col}">${esc(c.name)}${k ? `<b style="background:${on ? '#fff' : col};color:${on ? col : '#fff'}">${k}</b>` : ''}</button>`; }).join('');
  return `<div class="page"><header class="top">
    <div class="top-row">
      <div style="display:grid;gap:2px"><button class="logo" data-act="toMenu">Tasty Gourmet</button>
        <button class="rename" data-act="openRename" title="Изменить название точки">${esc(S.data.client.name)} <u>изменить</u></button></div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 360px;min-width:0">
        <div class="seg"><button data-act="setDelivery" style="${seg(!S.pickup)}">Доставка</button><button data-act="setPickup" style="${seg(S.pickup)}">Самовывоз</button></div>
        ${!S.pickup ? `<select class="sel" data-chg="addr" aria-label="Адрес доставки">${S.data.addresses.map((a) => `<option value="${esc(a)}" ${a === S.addr ? 'selected' : ''}>${esc(a)}</option>`).join('')}<option value="__new">+ Новый адрес</option></select>`
          : `<span class="muted" style="font-size:14px">Кухня: ${esc(settings().pickup_address || '')}, с ${esc(settings().pickup_from || '7:00')}</span>`}
      </div>
      <nav class="nav"><button class="link" data-act="toOrders" style="background:${S.view === 'orders' ? '#f4f3f0' : 'transparent'}">Мои заказы</button>
        <button class="link" data-act="toFeedback" style="background:${S.view === 'feedback' ? '#f4f3f0' : 'transparent'}">Отзывы</button>
        <button class="link" data-act="logout" style="color:#6e696a;font-size:14px">Выйти</button>
        <button class="cart-btn" data-act="openCart"><span>Корзина</span>${cnt ? `<span style="display:flex;align-items:center;gap:10px"><span style="width:1px;height:18px;background:rgba(255,255,255,.45)"></span><span style="font-variant-numeric:tabular-nums">${cnt}</span></span>` : ''}</button></nav>
    </div>
    ${isMenu ? `<div class="chips">${chips}<input class="search" id="q" type="search" value="${esc(S.q)}" placeholder="Поиск блюда" aria-label="Поиск блюда"></div>` : ''}
  </header>
  ${isMenu ? menuView() : S.view === 'orders' ? ordersView() : feedbackView()}
  ${cnt && !S.cartOpen ? `<div class="float"><button data-act="openCart"><span style="font:600 16px Rubik,sans-serif">Корзина</span><span style="font-size:14px;opacity:.9;flex:1;text-align:left">${cnt} шт</span><span class="geo" style="font-weight:700;font-size:18px;font-variant-numeric:tabular-nums">${fmt(sum)}</span></button></div>` : ''}
  </div>${modalView()}${cartView()}`;
}

/* ---------- рендер ---------- */
const app = document.getElementById('app');
function render() {
  const ae = document.activeElement;
  const keep = ae && ae.id ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  if (S.loading && !S.data) app.innerHTML = '<div class="boot">Загрузка…</div>';
  else if (!S.data) app.innerHTML = authView();
  else app.innerHTML = shopView();
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) {} } }
}

/* ---------- действия ---------- */
function tokenFromText(t) {
  t = String(t || '').trim();
  const m = t.match(/[?&#](?:t|k|key|token)=([A-Za-z0-9_-]{16,128})/i);
  return m ? m[1] : /^[A-Za-z0-9_-]{20,128}$/.test(t) ? t : null;
}
const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };

// Меню меняется каждый день, поэтому повтор берёт сегодняшние блюда и цены.
// Заказ, отправленный сегодня на этот адрес, повторять на тот же адрес нельзя, чтобы не было дубля.
const isToday = (iso) => fdate(iso) === fdate(new Date().toISOString());
const repeatBlocked = (o, addr) => isToday(o.created_at) && !['failed', 'cancelled'].includes(o.status) && !o.pickup && o.address === addr;

const actions = {
  tab: (el) => { S.authTab = el.dataset.v; render(); },
  retryLoad: () => load(),
  loginLink: () => { const t = tokenFromText(val('linkIn')); if (!t) { S.fatal = 'Не удалось распознать ссылку.'; render(); return; } S.token = t; store.set(TOKEN_KEY, t); load(); },
  sendReg: async () => {
    S.regError = '';
    try {
      const rid = await rpc('submit_registration_v2', { p_name: val('rName'), p_phone: val('rPhone'), p_address: val('rAddr'), p_contact: val('rContact') });
      S.regSent = true;
      try { fetch('/api/new-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rid }), keepalive: true }).catch(() => {}); } catch (e) {}
    }
    catch (e) { S.regError = 'Проверьте название точки и телефон.'; }
    render();
  },
  logout: () => { store.del(TOKEN_KEY); S.token = null; S.data = null; S.gate = null; S.qty = {}; S.cartOpen = false; S.view = 'menu'; S.authTab = 'login'; S.fatal = null; render(); },
  toMenu: () => { S.view = 'menu'; render(); },
  toOrders: () => { S.view = 'orders'; render(); window.scrollTo({ top: 0 }); },
  toFeedback: () => { S.view = 'feedback'; render(); window.scrollTo({ top: 0 }); },
  fbKind: (el) => { S.fbText = val('fbText') || S.fbText; S.fbKind = el.dataset.v; S.fbError = ''; render(); },
  fbRate: (el) => { S.fbText = val('fbText') || S.fbText; S.fbRating = Number(el.dataset.v); render(); },
  fbAgain: () => { S.fbSent = false; S.fbText = ''; S.fbError = ''; render(); },
  sendFb: async () => {
    S.fbText = val('fbText'); S.fbError = '';
    if (S.fbText.trim().length < 3) { S.fbError = 'Напишите хотя бы пару слов.'; render(); return; }
    S.fbSending = true; render();
    try { await rpc('submit_feedback', { p_token: S.token, p_kind: S.fbKind, p_rating: S.fbKind === 'review' ? S.fbRating : null, p_message: S.fbText }); S.fbSent = true; S.fbText = ''; }
    catch (e) { S.fbError = e.code === 'too_many' ? 'Слишком много сообщений за час. Попробуйте позже.' : 'Не удалось отправить. Попробуйте ещё раз.'; }
    S.fbSending = false; render();
  },
  setDelivery: () => { S.pickup = false; S.idem = null; render(); },
  setPickup: () => { S.pickup = true; S.idem = null; render(); },
  goCat: (el) => scrollToCat(Number(el.dataset.id)),
  inc: (el) => { const id = el.dataset.id; setQty(id, (S.qty[id] || 0) + 1); render(); },
  dec: (el) => { const id = el.dataset.id; setQty(id, (S.qty[id] || 0) - 1); render(); },
  remove: (el) => { setQty(el.dataset.id, 0); render(); },
  add: (el) => { const id = el.dataset.id; const v = Number(S.pend[id]) || 1; setQty(id, (S.qty[id] || 0) + v); delete S.pend[id]; render(); },
  openCart: () => { S.cartOpen = true; S.cartError = ''; render(); },
  closeCart: () => { S.cartOpen = false; render(); },
  finish: () => { S.cartOpen = false; S.done = null; S.view = 'menu'; render(); },
  closeModal: () => { S.modal = null; render(); },
  openRename: () => { S.modal = 'rename'; S.draftName = S.data.client.name; render(); },
  saveName: async () => {
    const v = val('draftName').trim(); if (v.length < 2) return;
    try { await rpc('rename_client', { p_token: S.token, p_name: v }); S.modal = null; await load(); } catch (e) { alert('Не удалось сохранить название.'); }
  },
  saveAddr: async () => {
    const a = S.newAddr.trim(); if (a.length < 3) return;
    try { await rpc('add_address', { p_token: S.token, p_address: a }); S.addr = a; S.modal = null; await load(); } catch (e) { alert('Не удалось сохранить адрес.'); }
  },
  toggleOrder: (el) => { const id = Number(el.dataset.id); S.openOrder = S.openOrder === id ? null : id; render(); },
  repeat: (el) => {
    const o = S.data.orders.find((x) => x.id === Number(el.dataset.id)); if (!o) return;
    const free = S.data.addresses.find((a) => !repeatBlocked(o, a));
    S.modal = 'repeat'; S.repOrder = o; S.repAddr = free || '__new'; S.newAddr = ''; render();
  },
  pickAddr: (el) => { S.repAddr = el.dataset.v; render(); },
  doRepeat: async () => {
    const o = S.repOrder; if (!o) return;
    let addr = S.repAddr;
    if (addr === '__new') {
      addr = S.newAddr.trim(); if (!addr) return;
      try { await rpc('add_address', { p_token: S.token, p_address: addr }); await load(); } catch (e) { alert('Не удалось сохранить адрес.'); return; }
    }
    const items = allItems(), nq = {}, missing = [];
    o.items.forEach((i) => { if (items[i.item_id]) nq[i.item_id] = i.qty; else missing.push(i.name); });
    S.cartNotice = missing.length ? 'Этих блюд сегодня нет в меню, они не добавлены: ' + missing.join(', ') + '.' : '';
    S.idem = null; S.qty = nq; S.addr = addr; S.pickup = false; S.modal = null; S.view = 'menu'; S.cartOpen = true; S.done = null; S.cartError = ''; render();
  },
  submit: async () => {
    const lines = cartLines(), sum = lines.reduce((a, l) => a + l.qty * l.price, 0);
    if (S.sending || !lines.length || S.data.client.stopped) return;
    if (!S.pickup && sum < minDelivery()) return;
    S.comment = val('comment') || S.comment; S.sending = true; S.cartError = ''; render();
    try {
      if (!S.idem) S.idem = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      const r = await rpc('place_order', { p_token: S.token, p_items: lines.map((l) => ({ item_id: l.id, qty: l.qty })), p_pickup: S.pickup, p_address: S.pickup ? '' : S.addr, p_comment: S.comment, p_key: S.idem });
      S.done = { number: r.number, where: S.pickup ? 'Самовывоз: ' + (settings().pickup_address || '') : 'Доставка: ' + S.addr };
      S.qty = {}; S.comment = ''; S.sending = false; S.idem = null; S.cartNotice = '';
      pushToKitchen(r.number);
      await load();
    } catch (e) {
      S.sending = false;
      const dup = /^duplicate:(.+)$/.exec(e.code || '');
      if (dup) S.idem = null;
      if (e.code === 'sleeping') { S.cartOpen = false; await load(); return; }
      S.cartError = e.code === 'stopped' ? stopText() : dup ? `Такая же заявка на этот адрес уже отправлена сегодня (№ ${dup[1]}). Измените состав или выберите другой адрес.`
        : e.code === 'below_min' ? 'Сумма заказа ниже минимальной для доставки.'
        : e.code === 'unauthorized' ? 'Доступ закрыт. Обратитесь к менеджеру.' : 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните менеджеру.';
      render();
    }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.classList.contains('shade') && e.target !== el) return;
  const fn = actions[el.dataset.act]; if (fn) fn(el);
});
document.addEventListener('change', (e) => {
  const el = e.target, k = el.dataset && el.dataset.chg; if (!k) return;
  if (k === 'qty') { setQty(el.dataset.id, el.value || 1); render(); }
  else if (k === 'pend') { S.pend[el.dataset.id] = el.value.replace(/\D/g, '').slice(0, 3); }
  else if (k === 'addr') { if (el.value === '__new') { S.modal = 'addr'; S.newAddr = ''; render(); } else { S.addr = el.value; S.idem = null; render(); } }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'q') { S.q = el.value; render(); }
  else if (el.id === 'newAddr') { S.newAddr = el.value; const b = document.querySelector('[data-act="saveAddr"],[data-act="doRepeat"]'); if (b) b.disabled = S.modal === 'addr' ? S.newAddr.trim().length < 3 : !S.newAddr.trim(); }
  else if (el.id === 'comment') { S.comment = el.value; }
  else if (el.id === 'fbText') { S.fbText = el.value; }
});
document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches('input[data-chg="qty"],input[data-chg="pend"]')) e.target.select(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.chg === 'pend') { S.pend[e.target.dataset.id] = e.target.value.replace(/\D/g, '').slice(0, 3); actions.add(e.target); }
  if (e.key === 'Escape' && (S.modal || S.cartOpen)) { S.modal = null; S.cartOpen = false; render(); }
});
window.addEventListener('scroll', () => {
  if (!S.data || S.view !== 'menu') return;
  const h = document.querySelector('header.top'), top = (h ? h.getBoundingClientRect().bottom : 0) + 20;
  let cur = 0; S.data.menu.forEach((_, i) => { const el = document.getElementById('cat-' + i); if (el && el.getBoundingClientRect().top <= top) cur = i; });
  if (cur !== S.active) { S.active = cur; document.querySelectorAll('.chip').forEach((c, i) => {
    const col = S.data.menu[i].color, on = i === cur; c.style.background = on ? col : '#fff'; c.style.color = on ? '#fff' : col;
    const b = c.querySelector('b'); if (b) { b.style.background = on ? '#fff' : col; b.style.color = on ? col : '#fff'; } }); }
}, { passive: true });

/* передача заказа на кассу выполняется на сервере; ошибка не должна мешать клиенту */
function pushToKitchen(number) {
  try { fetch('/api/send-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.token, number }), keepalive: true }).catch(() => {}); } catch (e) {}
}

/* ---------- старт ---------- */
(function init() {
  const url = new URL(location.href);
  const fromUrl = tokenFromText(url.search + url.hash);
  if (fromUrl) { store.set(TOKEN_KEY, fromUrl); ['t', 'k', 'key', 'token'].forEach((n) => url.searchParams.delete(n)); history.replaceState(null, '', url.pathname + url.search); }
  S.token = fromUrl || store.get(TOKEN_KEY);
  if (!S.token) { S.loading = false; render(); return; }
  load();
})();
})();
