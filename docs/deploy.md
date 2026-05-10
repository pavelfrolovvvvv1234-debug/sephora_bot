# Деплой: GitHub, VPS и Cloudflare

## Кратко: как задеплоить на VPS

1. **Локально** — отправить код на GitHub:
   ```bash
   git add -A && git commit -m "обновление" && git push origin main
   ```
2. **На VPS по SSH** — обновить проект и перезапустить бота:
   ```bash
   cd /opt/bot
   git fetch origin && git reset --hard origin/main
   npm ci && npm run build && npm run fix-dist
   pm2 restart all
   ```
3. Проверка: `pm2 status`, `pm2 logs`.

Файл `.env` на VPS создаётся вручную (скопировать с `.env.example` и подставить свои значения). После правок `.env` — `pm2 restart all`.

---

## 1. Деплой на GitHub (со своей машины)

Закоммитить и запушить все изменения в ветку `main`:

```bash
git add -A
git status
git commit -m "feat: admin by Telegram ID, deploy docs"
git push origin main
```

Если репозиторий ещё не привязан к GitHub:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

---

## 2. Деплой на VPS

### Вариант A: Автоматический (GitHub Actions)

Если в репозитории настроены **Secrets**:

- `SSH_HOST` — IP или хост VPS  
- `SSH_USER` — пользователь (например `root`)  
- `SSH_KEY` — приватный SSH-ключ (содержимое, без пароля)  
- при необходимости: `SSH_PORT`, `DEPLOY_PATH`  

то при каждом `git push origin main` workflow **Deploy Bot** сам соберёт проект и задеплоит на сервер (scp + ssh). Проверить: **Actions** → последний run **Deploy to Server**.

### Вариант B: Вручную на VPS

Зайти по SSH на VPS и выполнить (путь к проекту замените на свой, например `/opt/bot` или `~/sephora-tg`):

```bash
cd /opt/bot
git fetch origin
git reset --hard origin/main
npm ci
npm run build
npm run fix-dist
pm2 restart all
```

Если бот ещё не запускался на этом сервере:

```bash
npm run build
npm run fix-dist
pm2 start ecosystem.config.js
pm2 save
```

**Важно:** файл `.env` на VPS должен быть создан и заполнен вручную (его нет в репозитории). Скопируйте настройки с `.env.example` и добавьте свои значения.

**Чтобы выдать себе админку по Telegram ID**, в `.env` на VPS добавь (подставь свой ID, без пробелов):
```env
ADMIN_TELEGRAM_IDS=7568177886
```
После изменения `.env` выполни `pm2 restart all`. Затем открой бота в Telegram (приватный чат), нажми «Профиль» или отправь `/start` — кнопка «Админ» появится в главном меню; также работает команда `/admin`.

**Проверка:** в логах при первом запросе должно появиться сообщение `[Config] Admin Telegram IDs (ADMIN_TELEGRAM_IDS): 7568177886`. Если его нет — переменная не подхватилась (проверь путь к `.env`, перезапуск после правки, отсутствие пробелов в значении).

---

## 3. Webhook через Cloudflare Tunnel (опционально)

Если нужен режим **webhook** (Telegram шлёт обновления на твой URL), а не long polling, бот должен быть доступен по HTTPS. Один из способов — **Cloudflare Tunnel**: трафик идёт через Cloudflare, порты на VPS можно не открывать.

### Шаг 1: Бот на VPS в режиме webhook

В `.env` на VPS **пока не ставь** `IS_WEBHOOK` — сначала поднимем туннель и получим URL.

### Шаг 2: Установка cloudflared на VPS

```bash
# Linux (пример для x86_64)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
# или через пакетный менеджер: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

### Шаг 3: Запуск туннеля (быстрый вариант — временный URL)

Бот слушает webhook на порту `PORT_WEBHOOK` (по умолчанию 3002). Туннель пробросит его в интернет:

```bash
cloudflared tunnel --url http://127.0.0.1:3002
```

В консоли появится строка вида `https://xxxx-xx-xx-xx-xx.trycloudflare.com` — это твой временный HTTPS-URL.

### Шаг 4: Включить webhook в боте

1. В `.env` на VPS добавь (подставь свой URL из шага 3, без слэша в конце или со слэшем — как в логе):
   ```env
   IS_WEBHOOK=https://xxxx-xx-xx-xx-xx.trycloudflare.com
   PORT_WEBHOOK=3002
   ```
2. Перезапусти бота и туннель:
   ```bash
   pm2 restart all
   ```
   Туннель держи запущенным (в screen/tmux или как сервис). При перезагрузке VPS туннель нужно запускать заново; для постоянного URL лучше настроить [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) и свой домен.

### Шаг 5: Постоянный туннель и свой домен (по желанию)

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → Zero Trust → Access → Tunnels → Create a tunnel.
2. Установить connector на VPS, привязать туннель к домену (например `bot.sephora.host`) и указать Service = `http://localhost:3002`.
3. В `.env` задать `IS_WEBHOOK=https://bot.sephora.host` (или твой поддомен) и перезапустить бота.

**Важно:** в режиме webhook бот не использует long polling; все обновления приходят только на `IS_WEBHOOK`. Если туннель упадёт, бот перестанет получать сообщения, пока туннель снова не заработает.

---

## Краткий чеклист

| Шаг | Где | Действие |
|-----|-----|----------|
| 1 | Локально | `git add -A && git commit -m "..." && git push origin main` |
| 2 | GitHub | Убедиться, что push прошёл (при настроенных Secrets — проверить Actions) |
| 3 | VPS | Подключиться по SSH → `cd проект` → `git fetch && git reset --hard origin/main` → `npm ci && npm run build && npm run fix-dist` → `pm2 restart all` |

После деплоя: `pm2 logs` — просмотр логов, `pm2 status` — статус процессов.

---

## Prime: «Я подписался» показывает «Сначала подпишитесь на канал»

1. **В .env на VPS** должны быть заданы канал для проверки и (по желанию) ссылка:
   - `PRIME_CHANNEL_ID=-1001234567890` — числовой ID канала (приватный канал с ссылкой t.me/+xxx). Узнать: добавь в канал @userinfobot или перешли сообщение из канала боту @getidsbot.
   - Или `PRIME_CHANNEL_USERNAME=sephora_news` — для публичного канала (username без @).
   - Бот **обязательно** должен быть администратором этого канала, иначе проверка подписки не сработает.

2. **Посмотреть логи в момент нажатия «Я подписался»:**
   ```bash
   pm2 logs sephora-host-bot --lines 30
   ```
   - Если видишь **`Prime getChatMember failed`** и в логе есть `error`/`code` — значит запрос к Telegram не прошёл: проверь, что бот админ канала и что `PRIME_CHANNEL_ID` (или `PRIME_CHANNEL_USERNAME`) указан верно.
   - Если видишь **`Prime check: user not subscribed`** и `status: left` — пользователь не в канале (нужно подписаться именно на тот канал, ID которого задан в .env).
