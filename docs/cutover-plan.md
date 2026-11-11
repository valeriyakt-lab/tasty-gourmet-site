# План переключения на новый сайт (пятница, по команде владельца)

Старый сайт: Netlify + Supabase «Tasty gourmet opt» + n8n. Остаётся как запасной вариант.
Новый сайт: Vercel + Supabase «Tasty Gourmet Site». Домен `tastygourmet-opt.com`, DNS в Netlify.

В пятницу и субботу заявки не принимаются, поэтому в пятницу данные в старой базе не меняются.

## Накануне (четверг) — подготовка, ничего не ломает

1. **Netlify → Domains → tastygourmet-opt.com → DNS records**: у всех записей поставить TTL 300 секунд (5 минут), чтобы переключение и откат были быстрыми.
2. **Пробный перенос данных** (см. `db/migrate_from_old.sql`):
   - в СТАРОМ проекте Supabase: Connect → Session pooler: скопировать Host, User; пароль: Project Settings → Database → Reset database password;
   - в НОВОМ проекте (Tasty Gourmet Site) → SQL Editor: выполнить ШАГ 1 (подключение), проверить `select count(*) from old.clients;`
   - выполнить ШАГ 2, сверить итоговые цифры со старым сайтом (клиенты ~200, заказы ~2850, Telegram 48).
3. **Проверка на реальных ссылках:** открыть на новом сайте (`...vercel.app/?k=ключ`) ссылку одного клиента из старого сайта: меню, адреса, «Мои заказы». Заказ НЕ оформлять (он уйдёт в настоящую кассу).
4. **Поддомен для проверки на настоящем домене** (по желанию): в Netlify DNS добавить `new` → CNAME `cname.vercel-dns.com`, в Vercel (Settings → Domains) добавить `new.tastygourmet-opt.com`.

## В пятницу (после команды)

1. Выполнить ШАГ 2 переноса ещё раз (заберёт свежие данные).
2. Проверить в итоге «ссылок_спит». Если нужно «разбудить» всех: `update public.clients set woken_at = now() where legacy_id is not null;`
3. Админка → Меню → «Обновить меню из iiko сейчас», проверить цены и новые блюда.
4. Перенести домен:
   - Netlify → сайт → Domain management → убрать `tastygourmet-opt.com` (и `www`) у старого сайта;
   - Vercel → Settings → Domains → добавить `tastygourmet-opt.com` и `www.tastygourmet-opt.com`;
   - в Netlify DNS: `A  @  76.76.21.21` и `CNAME  www  cname.vercel-dns.com`;
   - дождаться «Valid Configuration» в Vercel (5–15 минут, HTTPS-сертификат выпускается сам).
5. Проверка: личная ссылка клиента `https://tastygourmet-opt.com/?k=…`, тестовый заказ самовывозом с комментарием «ТЕСТ» (предупредить кухню, удалить в iiko).
6. Добавить в Vercel переменную `SITE_URL=https://tastygourmet-opt.com` (ссылки в Telegram при одобрении заявок), Redeploy.

## Откат (в первые минуты, пока на новом сайте нет настоящих заказов)

1. Vercel → Settings → Domains → убрать `tastygourmet-opt.com`.
2. Netlify DNS: удалить записи `A @` и `CNAME www`; Netlify → сайт → Domain management → снова привязать домен.
3. Заказы, оформленные на новом сайте после переключения, в старой базе не окажутся: перенесите их вручную.
