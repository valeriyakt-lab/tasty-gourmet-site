-- =====================================================================
-- ПЕРЕНОС ДАННЫХ ИЗ СТАРОЙ БАЗЫ («Tasty gourmet opt») В НОВУЮ («Tasty Gourmet Site»)
-- Старая база только ЧИТАЕТСЯ, в ней ничего не меняется.
--
-- Запускать в НОВОМ проекте: supabase.com → «Tasty Gourmet Site» → SQL Editor.
--
-- ШАГ 1 (один раз, 2 минуты): подключить старую базу.
--   В СТАРОМ проекте: Connect → «Session pooler» → скопируйте Host, User и пароль базы
--   (пароль: Project Settings → Database → Reset database password, если не помните).
--   Подставьте их ниже вместо <...> и выполните ШАГ 1 отдельно.
--
--   create extension if not exists postgres_fdw;
--   create server old_site foreign data wrapper postgres_fdw
--     options (host '<HOST из Session pooler>', port '5432', dbname 'postgres');
--   create user mapping for postgres server old_site
--     options (user '<USER, вида postgres.xxxxxxxx>', password '<ПАРОЛЬ старой базы>');
--   create schema if not exists old;
--   import foreign schema public limit to (clients, orders, tg_links, blocked)
--     from server old_site into old;
--
--   Проверка: select count(*) from old.clients;   -- должно вернуть около 200
--
-- ШАГ 2: выполнить всё, что ниже (его можно запускать повторно: данные обновятся,
--   дублей не будет, ничего не удаляется). В день переключения запустите его ещё раз, чтобы забрать самые
--   свежие заказы и клиентов.
--
-- Защита: если на НОВОМ сайте уже есть настоящие заказы перенесённых клиентов,
--   скрипт остановится и ничего не изменит (чтобы не затереть их).
-- =====================================================================

-- 0. Подготовка: связи со старыми записями; на время переноса отключаем автоматические
--    записи истории статусов и запрет заказов (они нужны только для новых заказов)
alter table public.clients add column if not exists legacy_id text;
alter table public.orders add column if not exists legacy_id bigint;
create unique index if not exists clients_legacy_id_idx on public.clients (legacy_id);
create unique index if not exists orders_legacy_id_idx on public.orders (legacy_id);

do $$ begin
  if exists (select 1 from public.orders o join public.clients c on c.id = o.client_id
             where o.legacy_id is null and c.legacy_id is not null) then
    raise exception 'На новом сайте уже есть настоящие заказы перенесённых клиентов. Перенос остановлен, чтобы их не затереть.';
  end if;
end $$;

alter table public.orders disable trigger orders_status_log;
do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'orders_block_stopped' and tgrelid = 'public.orders'::regclass) then
    alter table public.orders disable trigger orders_block_stopped;
  end if;
end $$;

-- 1. Тестовые данные нового сайта: демо-клиент блокируется, номера тестовых заказов получают приставку
--    (чтобы не совпасть с номерами старых заказов). Ничего не удаляется.
update public.clients set status = 'blocked' where legacy_id is null and name like '%(ДЕМО)%';
update public.orders set number = 'ТЕСТ-' || number where legacy_id is null and number ~ '^[0-9]+$';

-- 2. Клиенты (ссылка клиента = его прежний ключ, поэтому старые ссылки продолжают работать)
insert into public.clients (legacy_id, name, phone, contact_person, status, access_token, created_at, woken_at)
select c.id, c.name, c.phone, nullif(btrim(c.contact), ''),
       case when c.status = 'approved' then 'active' else 'blocked' end,
       c."key", c.created_at, c.active_from
from old.clients c
where c.status in ('approved', 'blocked')
on conflict (legacy_id) do update set
  name = excluded.name, phone = excluded.phone, contact_person = excluded.contact_person,
  status = excluded.status, access_token = excluded.access_token, woken_at = excluded.woken_at;

-- 2а. Стоп-лист по телефону (таблица blocked)
update public.clients n set stop_list = true, stop_reason = nullif(btrim(b.reason), ''), stop_since = b.created_at
from old.blocked b where b.phone = n.phone and n.legacy_id is not null;

-- 2б. Клиенты, которые ещё ждут одобрения, становятся заявками на регистрацию (без уведомления в Telegram)
insert into public.registration_requests (name, phone, address, contact_person, status, notified, created_at)
select c.name, c.phone, c.addrs->>0, nullif(btrim(c.contact), ''), 'new', true, c.created_at
from old.clients c
where c.status = 'pending'
  and not exists (select 1 from public.registration_requests r where r.phone = c.phone and r.name = c.name);

-- 3. Адреса клиентов (без «удалённых» клиентом; порядок сохраняется: последний использованный первым)
insert into public.client_addresses (client_id, address)
select n.id, a.addr
from old.clients c
join public.clients n on n.legacy_id = c.id
cross join lateral jsonb_array_elements_text(coalesce(c.addrs, '[]'::jsonb)) with ordinality as a(addr, ord)
where btrim(a.addr) <> ''
  and not exists (select 1 from jsonb_array_elements_text(coalesce(c.addr_hidden, '[]'::jsonb)) h where lower(btrim(h)) = lower(btrim(a.addr)))
  and not exists (select 1 from public.client_addresses x where x.client_id = n.id and lower(btrim(x.address)) = lower(btrim(a.addr)))
order by n.id, a.ord;

-- 4. Заказы (номер остаётся прежним)
insert into public.orders (legacy_id, number, client_id, pickup, address, comment, status, total, iiko_order_id, iiko_error, created_at)
select o.id, o.id::text, n.id, coalesce(o.pickup, false), case when o.pickup then null else nullif(btrim(o.addr), '') end,
       nullif(btrim(o.comment), ''),
       case when o.status = 'принят' then 'accepted'
            when o.status like 'отменен%' or o.status like 'отправлен заново%' then 'cancelled'
            else 'failed' end,
       coalesce(o.sum, 0), o.iiko_id,
       case when o.status = 'принят' or o.status like 'отменен%' or o.status like 'отправлен заново%' then null else left(o.status, 500) end,
       o.created_at
from old.orders o
join public.clients n on n.legacy_id = o.client_id
on conflict (legacy_id) do update set
  status = excluded.status, total = excluded.total, iiko_order_id = excluded.iiko_order_id, iiko_error = excluded.iiko_error,
  address = excluded.address, comment = excluded.comment, pickup = excluded.pickup;

-- 5. Состав заказов (строки старого заказа: [название, количество, цена])
insert into public.order_items (order_id, item_id, name, qty, price)
select n.id,
       (select m.id from public.menu_items m where lower(btrim(m.name)) = lower(btrim(x.e->>0)) limit 1),
       btrim(x.e->>0),
       greatest(round((x.e->>1)::numeric), 1)::int,
       coalesce((x.e->>2)::numeric, 0)
from old.orders o
join public.orders n on n.legacy_id = o.id
cross join lateral jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) as x(e)
where btrim(coalesce(x.e->>0, '')) <> ''
  and not exists (select 1 from public.order_items i where i.order_id = n.id);   -- состав переносится один раз

-- 6. История статусов («Мои заказы» → «История заявки»)
insert into public.order_events (order_id, status, created_at)
select o.id, 'new', o.created_at from public.orders o
where o.legacy_id is not null and not exists (select 1 from public.order_events e where e.order_id = o.id and e.status = 'new');
insert into public.order_events (order_id, status, created_at)
select o.id, o.status, o.created_at + interval '4 seconds' from public.orders o
where o.legacy_id is not null and o.status <> 'new'
  and not exists (select 1 from public.order_events e where e.order_id = o.id and e.status = o.status);

-- 7. Клиенты, подключившие уведомления в Telegram (подтверждения шлёт старый бот)
insert into public.tg_links (phone, chat_id, tg_name, created_at)
select phone, chat_id, tg_name, created_at from old.tg_links
on conflict (phone) do update set chat_id = excluded.chat_id, tg_name = excluded.tg_name;

-- 8. Нумерация новых заказов продолжается после последнего старого
select setval('public.order_number_seq', greatest(coalesce((select max(legacy_id) from public.orders), 0), 1000) + 1, false);

-- 9. Возвращаем автоматику
alter table public.orders enable trigger orders_status_log;
do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'orders_block_stopped' and tgrelid = 'public.orders'::regclass) then
    alter table public.orders enable trigger orders_block_stopped;
  end if;
end $$;

-- Итог (посмотрите цифры: сравните с числом клиентов и заказов в старом сайте)
select
  (select count(*) from public.clients where legacy_id is not null) as клиентов,
  (select count(*) from public.clients where legacy_id is not null and stop_list) as в_стоп_листе,
  (select count(*) from public.client_overview where legacy_id is not null and status = 'active' and sleeping) as ссылок_спит,
  (select count(*) from public.client_addresses) as адресов,
  (select count(*) from public.orders where legacy_id is not null) as заказов,
  (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id where o.legacy_id is not null and oi.item_id is null) as позиций_без_блюда_в_меню,
  (select count(*) from public.tg_links) as telegram_подключений,
  (select last_value from public.order_number_seq) as следующий_номер_заказа;
