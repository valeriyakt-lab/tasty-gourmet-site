# Серверные функции (Vercel)

| Файл | Что делает |
|---|---|
| `send-order.js` | Передаёт заказ в iiko. При сбое помечает заказ «не принят» и шлёт сообщение в Telegram. Вызывается сайтом после оформления и кнопкой «Отправить в iiko» в админке. |
| `check.js` | Проверка связи с Telegram и iiko из «Настройки» в админке (только администратор). |

## Переменные окружения (Vercel → Settings → Environment Variables)

| Переменная | Откуда взять |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (секретный, никому не показывать) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → создать бота |
| `TELEGRAM_CHAT_ID` | id чата или группы, куда писать (бота нужно добавить в чат) |
| `IIKO_API_LOGIN` | iikoWeb → API (apiLogin) |
| `IIKO_ORGANIZATION_ID`, `IIKO_TERMINAL_GROUP_ID` | админка → «Настройки» → «Проверить iiko» покажет значения |

Пока `IIKO_API_LOGIN` не задан, заказы остаются со статусом «Новая» и обрабатываются вручную.
После изменения переменных нужен Redeploy.
