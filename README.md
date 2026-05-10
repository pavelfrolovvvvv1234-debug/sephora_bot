# Sephora Host Bot

Telegram-бот (grammY), TypeORM + SQLite, Fluent i18n. Платежи (CrystalPay/CryptoBot и др.), VMManager, домены, услуги.

## Требования

- Node.js 18+
- npm (есть `package-lock.json`)

## Быстрый старт

```bash
cp .env.example .env
# заполнить .env — см. комментарии в src/app/config.ts (валидация Zod)

npm install
npm run dev
```

Сборка и прод:

```bash
npm run build
npm start
# или PM2: см. ecosystem.config.js (имя процесса: sephora-host-bot)
```

## Полезные скрипты

| Команда | Назначение |
|--------|------------|
| `npm run dev` | разработка (nodemon) |
| `npm run build` | tsc + правки dist |
| `npm run start` | запуск `dist/index.js` |
| `npm run fix-dist` | починка алиасов в dist после сборки |
| `npm run typecheck` | проверка типов |
| `npm run lint` | ESLint |
| `npm test` | тесты |

## Структура

Кратко: `src/app/` — вход и конфиг, `src/domain/` — логика, `src/infrastructure/` — БД и внешние API, `src/ui/` — Telegram UI, `locales/` — переводы.

Подробнее по интеграциям: каталог `docs/`.

## Безопасность

Не коммить `.env`, `data.db*`, `sessions/`, `dist/`.

## Деплой на VPS

На сервере после обновления кода из репозитория:

```bash
git fetch origin && git reset --hard origin/<ветка>
npm ci
npm run build
pm2 restart sephora-host-bot
```

Если после сборки ошибки вида `Cannot find module '@/...'`: `npm run fix-dist`, затем перезапуск.

## Docker

```bash
docker build -t sephora-host-bot .
docker compose up -d
```

## Лицензия

PRIVATE
