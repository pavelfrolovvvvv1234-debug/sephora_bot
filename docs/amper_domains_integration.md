# Amper Domains API Integration Specification

This document describes the required API endpoints and formats for integrating with the **Amper Domains API** so users can buy domains from the Telegram bot.

**Official API docs:** [https://amper.lat/api/v1/docs](https://amper.lat/api/v1/docs) — актуальные эндпоинты и форматы ответов.

Если реальный API использует другие имена полей (например `snake_case`: `domain_id`, `expire_at`), провайдер в коде поддерживает оба варианта.

## Base Configuration

- **Base URL**: Configured via `AMPER_API_BASE_URL` environment variable
- **Authentication**: ApiKey token via `AMPER_API_TOKEN` environment variable
- **Timeout**: Configured via `AMPER_API_TIMEOUT_MS` (default: 8000ms)
- **Default Nameservers**: `DEFAULT_NS1` and `DEFAULT_NS2` environment variables

## Required API Endpoints

### 1. Check Domain Availability

**Endpoint**: `GET /api/v1/domains/check`

**Query Parameters**:
- `domain` (string, required): Full domain name (e.g., "example.com")

**Response Format**:
```json
{
  "available": true,
  "domain": "example.com",
  "reason": "Domain is available" // Optional, only if not available
}
```

**Error Response**:
```json
{
  "error": "Invalid domain format",
  "message": "Domain must be a valid format"
}
```

---

### 2. Get Domain Price

**Endpoint**: `GET /api/v1/domains/price`

**Query Parameters**:
- `tld` (string, required): Top-level domain (e.g., "com", "org")
- `period` (integer, required): Registration period in years (e.g., 1, 2)

**Response Format**:
```json
{
  "price": 10.99,
  "currency": "USD",
  "tld": "com",
  "period": 1
}
```

**Error Response**:
```json
{
  "error": "TLD not supported",
  "message": "The requested TLD is not available"
}
```

---

### 3. Register Domain

**Endpoint**: `POST /api/v1/domains/register`

**Request Body**:
```json
{
  "domain": "example.com",
  "period": 1,
  "nameservers": {
    "ns1": "ns1.example.com",
    "ns2": "ns2.example.com"
  },
  "contact": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "+1234567890",
    "address": "123 Main St",
    "city": "New York",
    "country": "US",
    "zipCode": "10001"
  }
}
```

**Response Format** (Success):
```json
{
  "success": true,
  "domainId": "dom_123456789",
  "operationId": "op_987654321" // Optional, for async operations
}
```

**Response Format** (Error):
```json
{
  "success": false,
  "error": "Domain already registered",
  "message": "The domain is not available"
}
```

---

### 4. List User Domains

**Endpoint**: `GET /api/v1/domains`

**Query Parameters**:
- `userId` (string, required): User identifier (provider-specific format)

**Response Format**:
```json
{
  "domains": [
    {
      "domain": "example.com",
      "domainId": "dom_123456789",
      "status": "registered",
      "expireAt": "2025-12-31T23:59:59Z",
      "ns1": "ns1.example.com",
      "ns2": "ns2.example.com",
      "registeredAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### 5. Get Domain Information

**Endpoint**: `GET /api/v1/domains/{domainId}`

**Path Parameters**:
- `domainId` (string, required): Provider domain ID

**Response Format**:
```json
{
  "domain": "example.com",
  "domainId": "dom_123456789",
  "status": "registered",
  "expireAt": "2025-12-31T23:59:59Z",
  "ns1": "ns1.example.com",
  "ns2": "ns2.example.com",
  "registeredAt": "2024-01-01T00:00:00Z"
}
```

**Error Response** (404):
```json
{
  "error": "Domain not found",
  "message": "The requested domain does not exist"
}
```

---

### 6. Renew Domain

**Endpoint**: `POST /api/v1/domains/{domainId}/renew`

**Path Parameters**:
- `domainId` (string, required): Provider domain ID

**Request Body**:
```json
{
  "period": 1
}
```

**Response Format** (Success):
```json
{
  "success": true,
  "operationId": "op_987654321" // Optional, for async operations
}
```

**Response Format** (Error):
```json
{
  "success": false,
  "error": "Insufficient funds",
  "message": "Payment required for renewal"
}
```

---

### 7. Update Nameservers

**Endpoint**: `PUT /api/v1/domains/{domainId}/nameservers`

**Path Parameters**:
- `domainId` (string, required): Provider domain ID

**Request Body**:
```json
{
  "ns1": "ns1.example.com",
  "ns2": "ns2.example.com"
}
```

**Response Format** (Success):
```json
{
  "success": true,
  "operationId": "op_987654321" // Optional, for async operations
}
```

**Response Format** (Error):
```json
{
  "success": false,
  "error": "Invalid nameserver format",
  "message": "Nameservers must be valid hostnames"
}
```

---

### 8. Get Operation Status

**Endpoint**: `GET /api/v1/operations/{operationId}`

**Path Parameters**:
- `operationId` (string, required): Provider operation ID

**Response Format**:
```json
{
  "status": "completed", // "pending" | "in_progress" | "completed" | "failed"
  "result": {
    // Operation-specific result data
  },
  "error": null // Only present if status is "failed"
}
```

**Error Response** (404):
```json
{
  "error": "Operation not found",
  "message": "The requested operation does not exist"
}
```

---

## Authentication

All requests must include an Authorization header:

```
Authorization: ApiKey {AMPER_API_TOKEN}
```

## Error Handling

All endpoints should return appropriate HTTP status codes:
- `200 OK`: Successful request
- `400 Bad Request`: Invalid request parameters
- `401 Unauthorized`: Missing or invalid authentication
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server error

Error responses should follow this format:
```json
{
  "error": "Error code",
  "message": "Human-readable error message"
}
```

## Что делать, если API возвращает 400 "Invalid domain format"

1. **Открой официальную документацию**  
   [https://amper.lat/api/v1/docs](https://amper.lat/api/v1/docs) — посмотри точный вид запросов для **check** и **price**: метод (GET/POST), URL (path или query), имена параметров.

2. **Напиши в поддержку Amper**  
   Отправь им пример:  
   `GET https://amper.lat/api/v1/domains/check?domain=example.com`  
   и ответ: `400, "Invalid domain format. Example: example.com"`, поле `domain`.  
   Спроси: в каком формате нужно передавать домен (query, path, body, кодировка)?

3. **Проверь вручную (Postman / curl)**  
   С тем же токеном из `.env` выполни запрос из доки и посмотри, что возвращает сервер:
   ```bash
   curl -H "Authorization: ApiKey YOUR_TOKEN" "https://amper.lat/api/v1/domains/check?domain=example.com"
   curl -H "Authorization: ApiKey YOUR_TOKEN" "https://amper.lat/api/v1/domains/price?tld=com&period=1"
   ```
   Если в доке указаны другие параметры — подставь их.

4. **Временный обход в боте**  
   Пока API не совпадает со спецификацией, можно не вызывать Amper для проверки/цены и использовать фиксированную цену из конфига и проверку «всё доступно» или другой сервис (например Domainr). Это настраивается в коде (условия по `AMPER_API_BASE_URL`).

## Notes

1. **Async Operations**: Some operations (register, renew, update_ns) may be asynchronous. In such cases, the API should return an `operationId` that can be used to check status via the `/api/v1/operations/{operationId}` endpoint.

2. **User Identification**: The `userId` parameter format is provider-specific. It should uniquely identify the user in the partner's system. This could be:
   - Telegram user ID
   - Partner's internal user ID
   - Email address
   - Other unique identifier

3. **Domain Status Values**: The `status` field in domain information should be one of:
   - `"registered"`: Domain is active
   - `"pending"`: Domain registration is in progress
   - `"expired"`: Domain has expired
   - `"suspended"`: Domain is suspended
   - Other provider-specific statuses

4. **Date Formats**: All dates should be in ISO 8601 format (e.g., `"2025-12-31T23:59:59Z"`).

5. **Rate Limiting**: The API should implement appropriate rate limiting to prevent abuse.

6. **Webhooks** (Optional): For real-time updates, the partner may provide webhook endpoints to notify about domain status changes.

## Implementation Status

⚠️ **Current Status**: Stub implementation with placeholder endpoints.

The actual API endpoints, request/response formats, and authentication method need to be confirmed with the partner (@amper_domains_bot) before production use.
