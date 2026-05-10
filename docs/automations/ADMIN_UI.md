# Admin UI — Automations (Next.js/React)

## Pages and routes

| Route | Description |
|-------|-------------|
| `/automations` | List scenarios: table with key, category, enabled, last published, actions (Edit, Test, Logs) |
| `/automations/new` | Create scenario: key, category, name, description, tags |
| `/automations/[key]` | Scenario detail: header + tabs (Config, Versions, Event log, Offers) |
| `/automations/[key]/edit` | Full editor (see below) |
| `/automations/event-log` | Global event log with filters (scenarioKey, outcome, date) |
| `/automations/offers` | List offer_instances with filters (userId, scenarioKey, status) |

## Scenario editor (`/automations/[key]/edit`)

- **Preset dropdown**: Select scenario type (Deposit always, Growth offer, Reactivation, Usage upsell, Expiration multistep, NPS, Tier, Monthly promo, …) → pre-fill config, remain editable.
- **Trigger section**:
  - Type: EVENT | SCHEDULE | METRIC
  - If EVENT: multi-select event names
  - If SCHEDULE: Cron expression input OR Calendar (end_of_month / end_of_quarter / end_of_week, daysBefore, timezone)
  - If METRIC: source, metric (cpu/ram/disk/traffic/io_throttle), aggregation, lookbackHours, thresholdPercent
- **Conditions builder**:
  - Add rule: field (balance, tier, amount, last_activity_days, …), operator (gte, lte, eq, in, …), value
  - Optional: notSentInHours, cooldownHours
  - "Advanced JSON" toggle: raw JSON editor for `conditions.rules`
- **Segment**: segmentKey dropdown or JSON rules / SQL (power users)
- **Multi-step flow**:
  - List of steps; drag to reorder
  - Per step: id, name, delayHours, templateKey (dropdown), offerVariantKey (dropdown)
  - Add step button
- **Offers**:
  - Map of offerKey → type (bonus_percent, discount_percent, extra_days, free_trial), scope, value, ttlHours, autoApply, claimButton
- **Templates**:
  - Map of templateKey → ru.text, en.text, variables[], buttons[] (text, action, payload)
  - Variable insertion helper: click to insert {{ variable }}
- **Throttle**: perUserPerScenarioHours, perUserGlobalPromosPerDays, perUserGlobalDays, perStepCap
- **Quiet hours**: enabled, timezoneDefault, allowedStartHour, allowedEndHour
- **Experiment** (optional): enabled, variants[] (id, splitPercent, templateKey, offerKey)
- **Attribution**: conversionWindowHours, successEvent, model

## Actions

- **Save as draft**: POST `/api/admin/automations/scenarios/:key/versions` with `status: "draft"`
- **Publish**: POST `/api/admin/automations/scenarios/:key/versions/:id/publish`
- **Test send**: POST `/api/admin/automations/scenarios/:key/test-send` body `{ userId, lang?, variables? }` → show preview and "Sent" if bot available
- **Preview**: Render template with sample variables in RU/EN tabs

## API base URL

Configure in Admin UI env: `NEXT_PUBLIC_AUTOMATIONS_API=http://localhost:3001/api/admin/automations` (or bot backend URL).

## CORS and authorization

Backend (webhook Express app) sets CORS and optional API-key auth for `/api/admin/automations`:

- **CORS**: `Access-Control-Allow-Origin` is taken from env `CORS_ORIGIN` (default `*`). Set to your Next.js origin in production, e.g. `https://admin.example.com`.
- **Authorization**: If `ADMIN_API_KEY` is set in the bot env, every request to the automations API must include either:
  - Header `X-Admin-API-Key: <ADMIN_API_KEY>`, or
  - Header `Authorization: Bearer <ADMIN_API_KEY>`.
  If the key is missing or wrong, the server responds with `401 Unauthorized`.

In the Next.js app, use the same key in all fetch calls, e.g.:

```ts
const res = await fetch(`${process.env.NEXT_PUBLIC_AUTOMATIONS_API}/scenarios`, {
  headers: {
    "Content-Type": "application/json",
    "X-Admin-API-Key": process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? "",
  },
});
```

Use `NEXT_PUBLIC_ADMIN_API_KEY` only if the key is not sensitive (e.g. internal admin panel). Prefer a server-side proxy that injects the key.

## Deployment (Next.js Admin UI)

1. **Create the app** (e.g. in repo folder `admin-ui/`):
   - `npx create-next-app@latest admin-ui --typescript --tailwind --app`
   - Add pages: list scenarios, scenario detail, scenario edit (form with trigger/conditions/steps/offers/templates), event log, offer instances.

2. **Env** (e.g. `.env.local`):
   - `NEXT_PUBLIC_AUTOMATIONS_API=https://your-bot-backend.example.com/api/admin/automations`
   - If backend uses `ADMIN_API_KEY`: pass the same value to the front (e.g. via proxy or `NEXT_PUBLIC_*` for internal use).

3. **Backend** (bot in webhook mode):
   - Set `CORS_ORIGIN=https://your-admin-domain.com` (or the Next.js deploy URL).
   - Set `ADMIN_API_KEY` to a long random string; use it in the Admin UI requests.

4. **Deploy Next.js** to Vercel / your host; ensure HTTPS. The backend only accepts requests from `CORS_ORIGIN` and, when set, with valid `ADMIN_API_KEY`.

## Components (suggested)

- `ScenarioList.tsx` — table + filters
- `ScenarioEditor.tsx` — form with sections
- `TriggerEditor.tsx` — type + event/schedule/metric fields
- `ConditionBuilder.tsx` — rules list + add rule + advanced JSON
- `StepFlowBuilder.tsx` — drag list of steps
- `OfferEditor.tsx` — key + type + value + ttl + autoApply + claimButton
- `TemplateEditor.tsx` — RU/EN tabs, text + variables + buttons
- `TestSendDialog.tsx` — userId input, preview, send
