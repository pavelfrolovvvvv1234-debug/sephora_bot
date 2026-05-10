# Сообщение для поддержки Amper

## Вариант 1: Короткий (Telegram @amper_domains_bot)

```
Здравствуйте! Интегрирую ваш API для регистрации доменов в Telegram-боте.

Проблема: все запросы к /api/v1/domains/check и /api/v1/domains/price возвращают 400 VALIDATION_ERROR: "Invalid domain format. Example: example.com", даже когда отправляю именно example.com.

Проверил через PowerShell (без Node.js/библиотек):
$Headers = @{ "Authorization" = "ApiKey sk_live_..." }
Invoke-WebRequest -Headers $Headers -Uri "https://amper.lat/api/v1/domains/check?domain=example.com"

Ответ:
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid domain format. Example: example.com",
    "field": "domain"
  }
}

Токен принимается (не 401), но валидация не проходит. Можете подсказать правильный формат параметров или проверить, может быть проблема на вашей стороне?

Спасибо!
```

## Вариант 2: Подробный (email support@amper.lat)

```
Тема: API /api/v1/domains/check и /api/v1/domains/price возвращает 400 VALIDATION_ERROR

Здравствуйте!

Интегрирую Amper Domains API в Telegram-бота для регистрации доменов. Столкнулся с проблемой: все запросы к endpoints check и price возвращают ошибку валидации, даже при использовании формата из вашей документации.

Детали:

1. Endpoint: GET /api/v1/domains/check
   Запрос: GET https://amper.lat/api/v1/domains/check?domain=example.com
   Headers: Authorization: ApiKey sk_live_...
   
   Ответ: 400
   {
     "success": false,
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "Invalid domain format. Example: example.com",
       "field": "domain",
       "details": [{
         "field": "domain",
         "message": "Invalid domain format. Example: example.com"
       }]
     }
   }

2. Endpoint: GET /api/v1/domains/price
   Пробовал оба варианта:
   - GET /api/v1/domains/price?tld=com&period=1
   - GET /api/v1/domains/price?domain=example.com&period=1
   
   Оба возвращают ту же ошибку про формат domain.

Что я пробовал:
- Разные домены (example.com, test.com, test.lat, sephorahost-check.com)
- Разные форматы параметров (domain, name, tld)
- GET и POST методы
- Разные варианты авторизации

Токен принимается (не получаю 401), значит проблема именно в валидации параметров.

Вопросы:
1. Какой точный формат параметра domain ожидает API?
2. Может быть нужен другой endpoint или версия API?
3. Есть ли ограничения по токену (sandbox vs production)?
4. Можете предоставить рабочий пример curl-запроса?

Спасибо за помощь!

С уважением,
[Твоё имя]
```

## Вариант 3: Очень короткий (если лень писать много)

```
Привет! API не работает — все запросы к /domains/check и /domains/price возвращают 400 "Invalid domain format", даже для example.com. Токен работает (не 401). Можете помочь с форматом или проверить на вашей стороне? Спасибо!
```

## Что приложить (если попросят)

1. Примеры запросов:

**PowerShell (проверено):**
```powershell
$Headers = @{ "Authorization" = "ApiKey sk_live_..." }
Invoke-WebRequest -Headers $Headers -Uri "https://amper.lat/api/v1/domains/check?domain=example.com"
```

**curl:**
```bash
curl -H "Authorization: ApiKey sk_live_..." "https://amper.lat/api/v1/domains/check?domain=example.com"
```

2. Полный ответ API (уже есть в логах и выше)

3. Версию API, которую используешь: `/api/v1/`

4. Токен (только если они попросят — обычно не нужен)

**Важно:** Проверка через PowerShell доказывает, что проблема не в Node.js/axios/коде бота — это точно на стороне валидации Amper API.

---

**Рекомендация:** Начни с варианта 1 (Telegram) — быстрее ответят. Если не помогут, отправь вариант 2 (email).
