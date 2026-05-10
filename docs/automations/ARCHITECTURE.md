# Automations / Notifications / Offers — Architecture

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ADMIN PANEL (Next.js)                          │
│  Scenarios list │ Editor (presets, conditions, steps, offers, templates) │
│  Test Send │ Preview │ Publish (draft → published) │ Audit log          │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ REST API
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BOT BACKEND (Node/Express)                        │
│  Admin API: GET/POST/PUT /api/admin/automations/scenarios, ...           │
│  Engine: Event bus ← Evaluator pipeline → Send (Telegram) / Offer store  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌──────────────┐
│  Event        │         │  Schedule /      │         │  Redis        │
│  ingestion    │         │  Metric runners  │         │  (state,      │
│  (deposit,    │         │  (cron, calendar) │         │   BullMQ)     │
│   login,      │         │                  │         │  Optional     │
│   service,    │         │                  │         │  for queues   │
│   incident)   │         │                  │         │               │
└───────────────┘         └─────────────────┘         └──────────────┘
        │                           │
        └───────────────────────────┼───────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Evaluator pipeline (per scenario, per candidate user)                   │
│  1. Load published config (scenario_versions)                            │
│  2. Segment filter (JSON rules or segment key)                           │
│  3. Conditions (thresholds, time windows, service/user props)             │
│  4. Throttles (per_user_per_scenario, per_user_global, per_step)         │
│  5. Quiet hours (user TZ or default; skip if outside window)              │
│  6. Experiment (A/B variant selection)                                  │
│  7. Pick step + template (RU/EN) → render variables                       │
│  8. Send Telegram message / create offer_instance                        │
│  9. Log to event_log; update user_notification_state                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Postgres (or SQLite): scenarios, versions, config JSONB,              │
│  user_notification_state, offer_instances, event_log, scenario_metrics   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Implementation plan

### Phase 1 — Data & config
- [x] Zod schemas: `ScenarioConfig`, `TriggerConfig`, `ConditionConfig`, `StepConfig`, `OfferConfig`, `TemplateConfig`, `ThrottleConfig`, `QuietHoursConfig`, `ExperimentConfig`
- [ ] DB entities: `AutomationScenario`, `ScenarioVersion`, `UserNotificationState`, `OfferInstance`, `AutomationEventLog`, `ScenarioMetric`
- [ ] Migrations (Postgres-first; SQLite-compatible entities via TypeORM)

### Phase 2 — Engine
- [ ] Event types and ingestion: `deposit.created`, `user.login`, `service.expiring`, `service.created`, `incident.created`, etc.
- [ ] Event bus (in-process emitter + optional BullMQ for async)
- [ ] Schedule runner: cron parser + calendar windows (end-of-month, end-of-quarter)
- [ ] Metric runner: placeholder for CPU/RAM/disk (integrate panel API later)
- [ ] Evaluator: load config → segment → conditions → throttles → quiet hours → variant → template render → send
- [ ] Offer service: create `offer_instances`, apply on deposit/renewal, claim-by-button

### Phase 3 — Admin API
- [ ] `GET/POST /api/admin/automations/scenarios` — list, create
- [ ] `GET/PUT/DELETE /api/admin/automations/scenarios/:key` — get, update, delete
- [ ] `GET/POST /api/admin/automations/scenarios/:key/versions` — list versions, create draft
- [ ] `POST /api/admin/automations/scenarios/:key/versions/:id/publish` — publish
- [ ] `POST /api/admin/automations/scenarios/:key/test-send` — send to user_id with preview payload
- [ ] `GET /api/admin/automations/event-log` — paginated log (sent/skipped/error)
- [ ] `GET /api/admin/automations/offer-instances` — list with filters

### Phase 4 — Admin UI (Next.js)
- [ ] Scenarios list with filters (category, enabled, tags)
- [ ] Scenario editor: preset dropdown → pre-fill config; full form (trigger, conditions, steps, offers, templates, throttles, quiet hours, experiment)
- [ ] Condition builder (rules + advanced JSON)
- [ ] Template editor (RU/EN, variables, buttons, deep-links)
- [ ] Multi-step flow builder (drag, delay, template per step)
- [ ] Offer editor (type, value, ttl, auto_apply, claim_button)
- [ ] Test Send + Preview
- [ ] Publish workflow + audit

### Phase 5 — Integration
- [ ] Replace hardcoded growth/campaigns with engine: load scenarios by key (B01, B02, B03, S01–S15), run evaluator on events/schedule
- [ ] Telegram callback handler: map payload to `scenario_key + step + offer_id` for claim and NPS branching
- [ ] ExpirationService: emit `service.expiring` / grace steps; engine runs S09 multistep

## Scenario keys (reference)

| Key | Name | Trigger type |
|-----|------|---------------|
| B01 | deposit-always | EVENT |
| B02 | deposit-growth-offer | EVENT |
| B03 | reactivation-30d | SCHEDULE |
| B04 | vds-expiration (legacy; replaced by S09) | SCHEDULE |
| S01 | usage-upsell | METRIC |
| S02 | winback-unused-balance | SCHEDULE |
| S03 | behavioral-upsell | EVENT |
| S04 | scarcity-monthly | SCHEDULE |
| S05 | cross-sell-addons | SCHEDULE / EVENT |
| S06 | anti-churn | SCHEDULE |
| S07 | tier-achieved | EVENT |
| S08 | referral-push | EVENT |
| S09 | expiration-multistep | SCHEDULE + EVENT |
| S10 | large-deposit-accelerator | EVENT |
| S11 | nps-sales | SCHEDULE |
| S12 | ltv-dynamic-bonus | EVENT / SCHEDULE |
| S13 | incident-stability-addons | EVENT |
| S14 | anniversary-offer | SCHEDULE |
| S15 | b2b-dedicated | SCHEDULE |

## Tech alignment

- **Backend:** Existing stack (Node, Express, TypeORM, Grammy). No NestJS; use Express routes and service classes.
- **DB:** Postgres preferred for JSONB and concurrency; entities written to support SQLite (simple-json/text) for local dev.
- **Admin:** Next.js/React app; can live in `admin-panel/` or separate repo; consumes REST API from bot backend.
- **Queue:** Redis + BullMQ optional for async evaluation and scheduled jobs; first version can be in-process cron + sync evaluator.

---

## Implementation summary (done)

- **Zod schemas:** `src/modules/automations/schemas/scenario-config.schema.ts` — Trigger, Condition, Segment, Step, Offer, Template, Throttle, QuietHours, Experiment, Attribution, ScenarioConfig.
- **Entities:** `src/entities/automations/` — AutomationScenario, ScenarioVersion, UserNotificationState, OfferInstance, AutomationEventLog, ScenarioMetric. Registered in `datasource.ts`.
- **Migrations:** `migrations/automations/001_automation_tables.sql` (Postgres). For SQLite use TypeORM `synchronize: true` (already in use).
- **Engine:** `src/modules/automations/engine/` — config-loader, evaluator (conditions, throttle, quiet hours, experiment), template-renderer, offer-service, event-bus, runner (runScenarioForEvent). Event bus is in-process; schedule/metric runners can call runner with synthetic events.
- **Admin API:** `src/api/admin/automations-routes.ts` — GET/POST/PUT/DELETE scenarios, GET/POST versions, POST publish, POST test-send, GET event-log, GET offer-instances. Mounted at `/api/admin/automations` in webhook mode in `app/bot.ts`.
- **Admin UI spec:** `docs/automations/ADMIN_UI.md` — pages, editor sections, components.
- **Sample configs:** `docs/automations/samples/` — B01, B02, B03, S01, S04, S07, S09, S11 (JSON).
- **Tests:** `src/modules/automations/__tests__/` — evaluator (conditions, quiet hours, experiment, template renderer), nps-callback (parse payload, promoter/detractor). Run: `npm test`.
- **Next steps:** Wire event bus to deposit/payment and ExpirationService; add schedule cron that loads SCHEDULE scenarios and runs evaluator; implement step sequencing (D-2, D-1) using lastStepId; add NPS callback handler in bot that calls parseNpsPayload and sends follow-up message.
