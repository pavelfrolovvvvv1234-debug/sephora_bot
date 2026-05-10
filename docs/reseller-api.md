# Reseller API

Production base URL:

- `https://api.sephora.host`

Reference:

- `GET /reseller/openapi.json`
- `GET /reseller/docs`

## Required headers

- `x-api-key`: reseller API key

## Recommended security headers

- `x-timestamp`: unix seconds
- `x-nonce`: random UUID (one-time)
- `x-signature`: `hex(HMAC_SHA256(secret, "<timestamp>.<raw_json_body>"))`
- `x-idempotency-key`: unique logical operation key for POST retries

## Endpoints

### `POST /reseller/v1/services/create` — поля тела (JSON)

**Обязательные**

- `rateName` — тариф (как в вашем прайсе, например `Lite 1`).
- `clientExternalId` — строка: ваш внутренний id клиента у реселлера (до 128 символов).

**Необязательные**

- `osId` — число, шаблон ОС в Proxmox. **Можно не передавать:** тогда подставляется значение по умолчанию (**900** в текущей сборке).
- `name` — имя ВМ; если не указано — генерируется автоматически.
- `displayName` — подпись услуги в боте; если не указано — берётся `clientExternalId`.

---

### `POST /reseller/v1/services/import-existing` — поля тела (JSON)

Подключить уже существующую VM в Proxmox к реселлеру.

**Обязательные**

- `vmid` — число, VMID в Proxmox.
- `rateName` — тариф (как в прайсе).
- `clientExternalId` — ваш внутренний id клиента (до 128 символов).
- `expireAt` — строка даты окончания; парсится через `Date` (удобно **ISO 8601**, например `2026-12-31T23:59:59.000Z`).

**Необязательные**

- `ip` — строка IPv4, если известен заранее; иначе может подтянуться с ноды.
- `osId` — шаблон ОС (положительное целое).
- `displayName` — подпись в боте.

---

### `POST /reseller/v1/services/delete-by-ip`

Удалить услугу по **IPv4**, если запись в базе с этим IP и с **вашим** `resellerId` (тот же эффект, что `actions/delete`, но без `serviceId`).

**Тело (JSON):**

- `ip` — IPv4, например `45.74.7.104`.

**Ответ:** как у `delete` (`deleted.serviceId`, `deleted.vmid`, `deleted.ip`).

**Ошибки:** `invalid_ip` — не IPv4 или `0.0.0.0`; `404 service_not_found` — нет услуги с таким IP у реселлера; `409 ambiguous_ip` — два совпадения (аномалия, пиши в саппорт).

---

### `GET /reseller/v1/services/:id`

Тело не нужно. В пути `:id` — **`serviceId`** (внутренний id услуги в ответах API), только свои услуги данного реселлера.

---

### `POST /reseller/v1/services/:id/actions/:action` — тело по действию

В пути: `:id` = **`serviceId`**, `:action` = одно из ниже (латиница, нижний регистр).

| `action` | Тело JSON | Примечание |
|----------|-----------|------------|
| `start` | *(нет / пустой объект)* | Запуск VM |
| `stop` | *(нет)* | Остановка |
| `reboot` | *(нет)* | Перезагрузка |
| `reset-password` | *(нет)* | Новый пароль генерируется; в ответе `credentials` |
| `set-password` | **`{"password":"..."}`** — обязательно, 8–128 символов | Свой пароль root |
| `renew` | **`{"months": N}`** необязательно; `N` — положительное целое | Продление срока |
| `reinstall` | **`{"osId": N}`** необязательно | Переустановка ОС; если не указать `osId` — берётся сохранённый/дефолт |
| `delete` | *(нет)* | Удаление VM на ноде и записи услуги (**необратимо**) |

Остальные `action` → `400 unknown_action`.

---

### Маршруты

- `GET /reseller/health`
- `GET /reseller/v1/services`
- `POST /reseller/v1/services/create`
- `POST /reseller/v1/services/import-existing`
- `POST /reseller/v1/services/delete-by-ip`
- `GET /reseller/v1/services/:id`
- `POST /reseller/v1/services/:id/actions/:action`

Action values:

- `start`
- `stop`
- `reboot`
- `reset-password`
- `set-password`
- `renew`
- `reinstall`
- `delete`

## Isolation model

API key is bound to one `reseller_id`; data is isolated by `resellerId`.

## Webhook events

- `service_created`
- `service_imported`
- `service_started`
- `service_stopped`
- `service_rebooted`
- `service_password_reset`
- `service_password_set`
- `service_renewed`
- `service_reinstall_started`
- `service_deleted`

Webhook signing (optional) uses the same timestamp/signature scheme.

## Response metadata

- `x-request-id` header in all responses
- `idempotentReplay: true` in body on successful idempotency cache replay

## Partner integration example (Node.js)

```js
import crypto from "crypto";
import axios from "axios";

const baseUrl = "https://api.sephora.host";
const apiKey = "<your-reseller-api-key>";
const signSecret = "<your-reseller-signing-secret>";

function sign(ts, body) {
  return crypto
    .createHmac("sha256", signSecret)
    .update(`${ts}.${body}`)
    .digest("hex");
}

async function createService() {
  const payload = {
    rateName: "Lite 1",
    clientExternalId: "client_123",
    osId: 900,
    name: "client123-vps",
  };

  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const idem = crypto.randomUUID();

  const res = await axios.post(`${baseUrl}/reseller/v1/services/create`, payload, {
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "x-timestamp": ts,
      "x-nonce": nonce,
      "x-signature": sign(ts, body),
      "x-idempotency-key": idem,
    },
    timeout: 20000,
  });

  return res.data;
}
```
