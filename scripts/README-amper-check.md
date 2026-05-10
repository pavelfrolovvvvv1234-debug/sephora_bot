# Проверка Amper Domains API

## Быстрый тест

```bash
npx tsx scripts/test-amper-api.ts
```

Проверяет:
1. **check** — доступность домена (GET `/api/v1/domains/check?domain=...`);
2. **getPrice** — цену за TLD и период (GET `/api/v1/domains/price` с `tld` или `domain`).

В `.env` должны быть заданы:
- `AMPER_API_BASE_URL` (например `https://amper.lat/api/v1/docs` — скрипт уберёт `/docs`);
- `AMPER_API_TOKEN` (ключ API).

## Отладка запросов

```bash
npx tsx scripts/amper-api-debug.ts
```

Печатает сырые ответы API для разных вариантов check и price. Нужно для выяснения формата параметров, если Amper изменил API.

## Текущий результат (на момент проверки)

- **Подключение и токен** — в порядке (ответ 400, не 401).
- **Check** — для всех проверенных доменов (`example.com`, `test.com`, `test.lat`, `sephorahost-check.com`) API возвращает `400 VALIDATION_ERROR: Invalid domain format. Example: example.com`. То есть запрос доходит, но валидация на стороне Amper не проходит.
- **Price** — то же самое: оба варианта (`tld`+`period` и `domain`+`period`) дают 400 с той же ошибкой про формат домена.
- **POST /domains/check** — у Amper не поддерживается (404 Cannot POST).

**Что сделать:** уточнить у поддержки Amper (или в актуальной документации https://amper.lat/api/v1/docs):
- точный формат и примеры значений для параметра `domain` в check и price;
- список допустимых TLD или ограничения по доменам;
- не изменился ли путь/версия API.

После уточнения формата можно поправить `AmperDomainsProvider` (и при необходимости тестовый домен в `test-amper-api.ts`) и снова запустить `npx tsx scripts/test-amper-api.ts`.
