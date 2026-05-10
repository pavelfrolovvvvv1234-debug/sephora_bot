/**
 * Admin CRUD for automation scenarios and versions.
 *
 * @module modules/automations/admin/scenario-admin.service
 */

import type { DataSource } from "typeorm";
import { ScenarioConfigSchema } from "../schemas/scenario-config.schema.js";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import AutomationScenario from "../../../entities/automations/AutomationScenario.js";
import ScenarioVersion from "../../../entities/automations/ScenarioVersion.js";
import type { ScenarioCategory } from "../../../entities/automations/AutomationScenario.js";

export interface ListScenariosFilters {
  category?: ScenarioCategory;
  enabled?: boolean;
  tags?: string[];
}

export interface CreateScenarioInput {
  key: string;
  category: ScenarioCategory;
  name?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface UpdateScenarioInput {
  category?: ScenarioCategory;
  name?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface CreateVersionInput {
  scenarioKey: string;
  config: ScenarioConfig;
  status?: "draft" | "published";
}

export class ScenarioAdminService {
  constructor(private dataSource: DataSource) {}

  /** Seed default scenarios (B01–B04, S01–S15) on first use. */
  private async seedDefaultsIfEmpty(): Promise<void> {
    const repo = this.dataSource.getRepository(AutomationScenario);
    const count = await repo.count();
    if (count > 0) return;

    const defaults: Array<CreateScenarioInput> = [
      // Base / legacy
      {
        key: "B01",
        category: "System",
        name: "Deposit receipt (always)",
        description: "Base receipt message on every successful deposit.",
        tags: ["deposit", "system"],
      },
      {
        key: "B02",
        category: "Upsell",
        name: "Deposit growth offer",
        description: "Upsell after deposit >= $50 with temporary bonus offer.",
        tags: ["deposit", "upsell"],
      },
      {
        key: "B03",
        category: "Retention",
        name: "Reactivation 30d",
        description: "Inactive 30 days, balance 0, no services — reactivation bonus.",
        tags: ["reactivation", "retention"],
      },
      {
        key: "B04",
        category: "Retention",
        name: "VDS expiration (legacy)",
        description: "Legacy single-step VDS expiration reminder. Replaced by S09.",
        tags: ["expiration", "vds", "legacy"],
        enabled: false,
      },
      // S01–S15
      {
        key: "S01",
        category: "Upsell",
        name: "Usage-based upsell",
        description: "CPU/RAM/DISK/Traffic thresholds → suggest upgrade with discount.",
        tags: ["usage", "metrics", "upsell"],
      },
      {
        key: "S02",
        category: "Retention",
        name: "Win-back unused balance",
        description: "Balance >= X, no services N days → push to start VDS.",
        tags: ["winback", "balance", "retention"],
      },
      {
        key: "S03",
        category: "Upsell",
        name: "Behavioral upsell (logins)",
        description: "3+ logins in T hours → suggest add-ons (backup/IP/etc).",
        tags: ["behavior", "logins", "upsell"],
      },
      {
        key: "S04",
        category: "Promo",
        name: "Monthly/quarterly scarcity promo",
        description: "End-of-month/quarter bonus to deposits.",
        tags: ["promo", "scarcity", "calendar"],
      },
      {
        key: "S05",
        category: "Upsell",
        name: "Cross-sell domains/CDN/IP/backup",
        description: "Has VDS but missing add-ons → bundle discount.",
        tags: ["cross-sell", "addons"],
      },
      {
        key: "S06",
        category: "Retention",
        name: "Anti-churn on activity drop",
        description: "Was active 60+ days then drop in activity → retention offer.",
        tags: ["churn", "retention"],
      },
      {
        key: "S07",
        category: "Upsell",
        name: "Tier / gamification",
        description: "Tier upgrade based on cumulative deposit (Bronze/Silver/Gold/Platinum).",
        tags: ["tier", "ltv", "gamification"],
      },
      {
        key: "S08",
        category: "Referral",
        name: "Referral push",
        description: "After deposit or tier unlock → push referral program/boost.",
        tags: ["referral"],
      },
      {
        key: "S09",
        category: "Retention",
        name: "Expiration multi-step (VDS/dedicated)",
        description: "D-3/D-2/D-1 or grace day1/2/3 with discount & renew CTA.",
        tags: ["expiration", "multistep", "vds"],
      },
      {
        key: "S10",
        category: "Upsell",
        name: "Large deposit accelerator",
        description: "Big deposit → offer lock-in bonus if extra deposit within T hours.",
        tags: ["deposit", "high-value"],
      },
      {
        key: "S11",
        category: "Promo",
        name: "NPS → sales",
        description: "Ask NPS after activation, branch 4–5 to upsell/referral/yearly discount.",
        tags: ["nps", "survey"],
      },
      {
        key: "S12",
        category: "Upsell",
        name: "Dynamic bonus by LTV",
        description: "New/Active/VIP segments with different bonus/privileges.",
        tags: ["ltv", "segments"],
      },
      {
        key: "S13",
        category: "Retention",
        name: "Incident → stability add-ons",
        description: "After incident recommend monitoring/auto-reboot/backup trial.",
        tags: ["incident", "stability"],
      },
      {
        key: "S14",
        category: "Promo",
        name: "Anniversary offer",
        description: "1 year with us → anniversary bonus on deposit.",
        tags: ["anniversary", "promo"],
      },
      {
        key: "S15",
        category: "Upsell",
        name: "High-check B2B push (Dedicated)",
        description: "Multiple VDS or high spend → suggest dedicated with savings.",
        tags: ["b2b", "dedicated"],
      },
    ];

    const rows = defaults.map((d) =>
      repo.create({
        key: d.key,
        category: d.category,
        name: d.name ?? null,
        description: d.description ?? null,
        tags: d.tags ? JSON.stringify(d.tags) : null,
        enabled: d.enabled ?? true,
      })
    );
    await repo.save(rows);
  }

  /** Auto-publish default scenarios with minimal configs if no published version exists. */
  private async autoPublishDefaultsIfNeeded(): Promise<void> {
    const defaults: Array<{ key: string; config: ScenarioConfig }> = [
      {
        key: "B01",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [] },
          steps: [{ id: "receipt", templateKey: "receipt", delayHours: 0 }],
          offers: {},
          templates: {
            receipt: {
              key: "receipt",
              ru: { text: "+ {{amount}} $ зачислено на баланс." },
              en: { text: "+ {{amount}} $ added to your balance." },
              variables: ["amount"],
            },
          },
          throttle: {},
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      {
        key: "B02",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: {
            rules: [{ field: "amount", operator: "gte", value: 50 }],
            cooldownHours: 24,
          },
          steps: [{ id: "upsell", templateKey: "upsell_50", offerVariantKey: "upsell_offer", delayHours: 0 }],
          offers: {
            upsell_offer: {
              key: "upsell_offer",
              type: "bonus_percent",
              scope: "deposit",
              value: 10,
              ttlHours: 1,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            upsell_50: {
              key: "upsell_50",
              ru: { text: "Пополните ещё $50 и получите +10% бонуса." },
              en: { text: "Top up another $50 and get +10% bonus." },
            },
          },
          throttle: { perUserPerScenarioHours: 24 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      {
        key: "B03",
        config: {
          trigger: { type: "SCHEDULE", schedule: { type: "cron", expression: "0 10 * * *" } },
          conditions: {
            rules: [
              { field: "balance", operator: "eq", value: 0 },
              { field: "last_activity_days", operator: "gte", value: 30 },
              { field: "has_active_services", operator: "eq", value: 0 },
            ],
          },
          segment: { segmentKey: "inactive_30d" },
          steps: [{ id: "reactivation", templateKey: "reactivation_15", offerVariantKey: "reactivation_offer", delayHours: 0 }],
          offers: {
            reactivation_offer: {
              key: "reactivation_offer",
              type: "bonus_percent",
              scope: "deposit",
              value: 15,
              ttlHours: 48,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            reactivation_15: {
              key: "reactivation_15",
              ru: { text: "Вернитесь и получите +15% к депозиту!" },
              en: { text: "Come back and get +15% on your deposit!" },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S01 – Usage-based upsell (METRIC fallback: trigger on deposit for demo)
      {
        key: "S01",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [], cooldownHours: 168 },
          steps: [{ id: "usage_upsell", templateKey: "usage_upgrade", delayHours: 0 }],
          offers: {
            upgrade_discount: {
              key: "upgrade_discount",
              type: "discount_percent",
              scope: "upgrade",
              value: 10,
              ttlHours: 48,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            usage_upgrade: {
              key: "usage_upgrade",
              ru: { text: "Нагрузка на VDS близка к лимиту. Апгрейд — скидка 10% на 48ч." },
              en: { text: "VDS load near limit. Upgrade — 10% discount for 48h." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "upgrade", model: "last_touch" },
        },
      },
      // S02 – Win-back unused balance
      {
        key: "S02",
        config: {
          trigger: { type: "SCHEDULE", schedule: { type: "cron", expression: "0 11 * * *" } },
          conditions: { rules: [{ field: "balance", operator: "gte", value: 10 }] },
          segment: { segmentKey: "has_balance_no_services" },
          steps: [{ id: "winback", templateKey: "winback", delayHours: 0 }],
          offers: {},
          templates: {
            winback: {
              key: "winback",
              ru: { text: "У вас есть баланс. Запустите VDS и начните пользоваться." },
              en: { text: "You have balance. Start a VDS and get going." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S03 – Behavioral upsell (logins)
      {
        key: "S03",
        config: {
          trigger: { type: "EVENT", eventNames: ["user.login"] },
          conditions: { rules: [], cooldownHours: 72 },
          steps: [{ id: "behavioral", templateKey: "addon_offer", delayHours: 0 }],
          offers: {},
          templates: {
            addon_offer: {
              key: "addon_offer",
              ru: { text: "Добавьте бэкап или выделенный IP к VDS со скидкой." },
              en: { text: "Add backup or dedicated IP to your VDS with a discount." },
            },
          },
          throttle: { perUserPerScenarioHours: 72 },
          attribution: { conversionWindowHours: 72, successEvent: "add_on", model: "last_touch" },
        },
      },
      // S04 – Monthly scarcity promo
      {
        key: "S04",
        config: {
          trigger: {
            type: "SCHEDULE",
            schedule: { type: "calendar", window: "end_of_month", daysBefore: 2, timezone: "UTC" },
          },
          conditions: { rules: [] },
          steps: [{ id: "scarcity", templateKey: "scarcity", offerVariantKey: "scarcity_offer", delayHours: 0 }],
          offers: {
            scarcity_offer: {
              key: "scarcity_offer",
              type: "bonus_percent",
              scope: "deposit",
              value: 5,
              ttlHours: 48,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            scarcity: {
              key: "scarcity",
              ru: { text: "Конец месяца — бонус +5% к пополнению 48ч." },
              en: { text: "End of month — +5% bonus on deposit for 48h." },
            },
          },
          throttle: { perUserPerScenarioHours: 24 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S05 – Cross-sell domains/CDN
      {
        key: "S05",
        config: {
          trigger: { type: "EVENT", eventNames: ["service.created"] },
          conditions: { rules: [], cooldownHours: 168 },
          steps: [{ id: "crosssell", templateKey: "crosssell", delayHours: 0 }],
          offers: {},
          templates: {
            crosssell: {
              key: "crosssell",
              ru: { text: "Домен или CDN в подарок к VDS? Оформите доп. услуги." },
              en: { text: "Domain or CDN with your VDS? Add extra services." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "add_on", model: "last_touch" },
        },
      },
      // S06 – Anti-churn
      {
        key: "S06",
        config: {
          trigger: { type: "SCHEDULE", schedule: { type: "cron", expression: "0 12 * * *" } },
          conditions: { rules: [] },
          segment: { segmentKey: "activity_drop" },
          steps: [{ id: "antichurn", templateKey: "antichurn", delayHours: 0 }],
          offers: {},
          templates: {
            antichurn: {
              key: "antichurn",
              ru: { text: "Мы скучали. Вернитесь — специальное предложение для вас." },
              en: { text: "We missed you. Come back — a special offer for you." },
            },
          },
          throttle: { perUserPerScenarioHours: 336 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S07 – Tier / gamification
      {
        key: "S07",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed", "tier.achieved"] },
          conditions: { rules: [], cooldownHours: 24 },
          steps: [{ id: "tier", templateKey: "tier_up", delayHours: 0 }],
          offers: {},
          templates: {
            tier_up: {
              key: "tier_up",
              ru: { text: "Новый уровень! Вам доступны привилегии." },
              en: { text: "New tier! You now have extra privileges." },
            },
          },
          throttle: { perUserPerScenarioHours: 24 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S08 – Referral push
      {
        key: "S08",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [], cooldownHours: 168 },
          steps: [{ id: "referral", templateKey: "referral_push", delayHours: 0 }],
          offers: {},
          templates: {
            referral_push: {
              key: "referral_push",
              ru: { text: "Приглашайте друзей — получайте % с их пополнений." },
              en: { text: "Invite friends — earn % from their deposits." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S09 – Expiration multi-step (D-1, D-2, D-3)
      {
        key: "S09",
        config: {
          trigger: { type: "EVENT", eventNames: ["service.expiring", "service.grace_start"] },
          conditions: { rules: [] },
          steps: [
            { id: "grace_day1", name: "Day 1", templateKey: "vds_expiration", offerVariantKey: "renew_discount", delayHours: 0 },
            { id: "grace_day2", name: "Day 2", templateKey: "grace_day2", offerVariantKey: "renew_discount", delayHours: 24 },
            { id: "grace_day3", name: "Day 3", templateKey: "grace_day3", offerVariantKey: "renew_discount", delayHours: 48 },
          ],
          offers: {
            renew_discount: {
              key: "renew_discount",
              type: "discount_percent",
              scope: "renewal",
              value: 5,
              ttlHours: 72,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            vds_expiration: {
              key: "vds_expiration",
              ru: { text: "VDS истекает. Пополните на {{amount}} $. Скидка 5% при продлении — 72ч." },
              en: { text: "VDS expiring. Top up {{amount}} $. 5% renewal discount — 72h." },
              variables: ["amount"],
            },
            grace_day2: {
              key: "grace_day2",
              ru: { text: "Скидка 5% при продлении ещё 24ч. Продлите сейчас." },
              en: { text: "5% renewal discount for 24h more. Renew now." },
            },
            grace_day3: {
              key: "grace_day3",
              ru: { text: "Последний шанс продлить без потери данных. Скидка 5% активна." },
              en: { text: "Last chance to renew without data loss. 5% discount still active." },
            },
          },
          throttle: { perUserPerScenarioHours: 24, perStepCap: 3 },
          attribution: { conversionWindowHours: 72, successEvent: "renew", model: "last_touch" },
        },
      },
      // S10 – Large deposit accelerator
      {
        key: "S10",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [{ field: "amount", operator: "gte", value: 100 }], cooldownHours: 72 },
          steps: [{ id: "large", templateKey: "large_deposit", offerVariantKey: "lock_in", delayHours: 0 }],
          offers: {
            lock_in: {
              key: "lock_in",
              type: "bonus_percent",
              scope: "deposit",
              value: 5,
              ttlHours: 24,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            large_deposit: {
              key: "large_deposit",
              ru: { text: "Крупное пополнение! Доп. пополнение в течение 24ч — +5% бонуса." },
              en: { text: "Large deposit! Top up again within 24h for +5% bonus." },
            },
          },
          throttle: { perUserPerScenarioHours: 72 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S11 – NPS → sales
      {
        key: "S11",
        config: {
          trigger: { type: "EVENT", eventNames: ["service.created"] },
          conditions: { rules: [], cooldownHours: 720 },
          steps: [{ id: "nps", templateKey: "nps_ask", delayHours: 0 }],
          offers: {},
          templates: {
            nps_ask: {
              key: "nps_ask",
              ru: { text: "Оцените сервис от 1 до 5. Ваш отзыв важен." },
              en: { text: "Rate our service 1–5. Your feedback matters." },
            },
          },
          throttle: { perUserPerScenarioHours: 720 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S12 – Dynamic bonus by LTV
      {
        key: "S12",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [], cooldownHours: 48 },
          steps: [{ id: "ltv_bonus", templateKey: "ltv_bonus", delayHours: 0 }],
          offers: {},
          templates: {
            ltv_bonus: {
              key: "ltv_bonus",
              ru: { text: "Спасибо за лояльность. Вам доступен персональный бонус." },
              en: { text: "Thanks for your loyalty. A personal bonus is available for you." },
            },
          },
          throttle: { perUserPerScenarioHours: 48 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S13 – Incident → stability add-ons
      {
        key: "S13",
        config: {
          trigger: { type: "EVENT", eventNames: ["incident.created"] },
          conditions: { rules: [], cooldownHours: 168 },
          steps: [{ id: "incident", templateKey: "stability_addon", delayHours: 0 }],
          offers: {},
          templates: {
            stability_addon: {
              key: "stability_addon",
              ru: { text: "Рекомендуем мониторинг и авто-перезагрузку для стабильности." },
              en: { text: "We recommend monitoring and auto-reboot for stability." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "add_on", model: "last_touch" },
        },
      },
      // S14 – Anniversary offer
      {
        key: "S14",
        config: {
          trigger: { type: "SCHEDULE", schedule: { type: "cron", expression: "0 9 * * *" } },
          conditions: { rules: [] },
          segment: { segmentKey: "anniversary_1y" },
          steps: [{ id: "anniversary", templateKey: "anniversary", offerVariantKey: "anniversary_offer", delayHours: 0 }],
          offers: {
            anniversary_offer: {
              key: "anniversary_offer",
              type: "bonus_percent",
              scope: "deposit",
              value: 10,
              ttlHours: 168,
              autoApply: true,
              claimButton: false,
            },
          },
          templates: {
            anniversary: {
              key: "anniversary",
              ru: { text: "Год с нами! Бонус +10% к пополнению на неделю." },
              en: { text: "One year with us! +10% bonus on deposit for a week." },
            },
          },
          throttle: { perUserPerScenarioHours: 8760 },
          attribution: { conversionWindowHours: 72, successEvent: "deposit", model: "last_touch" },
        },
      },
      // S15 – High-check B2B (Dedicated)
      {
        key: "S15",
        config: {
          trigger: { type: "EVENT", eventNames: ["deposit.completed"] },
          conditions: { rules: [{ field: "amount", operator: "gte", value: 500 }], cooldownHours: 168 },
          steps: [{ id: "b2b", templateKey: "b2b_dedicated", delayHours: 0 }],
          offers: {},
          templates: {
            b2b_dedicated: {
              key: "b2b_dedicated",
              ru: { text: "Высокий чек — рассмотрите выделенный сервер. Экономия и контроль." },
              en: { text: "High spend — consider a dedicated server. Savings and full control." },
            },
          },
          throttle: { perUserPerScenarioHours: 168 },
          attribution: { conversionWindowHours: 72, successEvent: "upgrade", model: "last_touch" },
        },
      },
    ];

    for (const { key, config } of defaults) {
      try {
        const existing = await this.getPublishedVersion(key);
        if (existing) continue;
        const version = await this.createVersion({ scenarioKey: key, config, status: "draft" });
        await this.publishVersion(key, version.id);
      } catch (e) {
        // Ignore errors
      }
    }
  }

  async listScenarios(filters?: ListScenariosFilters): Promise<AutomationScenario[]> {
    const repo = this.dataSource.getRepository(AutomationScenario);
    await this.seedDefaultsIfEmpty();
    // Auto-publish default scenarios if they don't have published versions
    await this.autoPublishDefaultsIfNeeded();
    const qb = repo.createQueryBuilder("s");
    if (filters?.category) qb.andWhere("s.category = :category", { category: filters.category });
    if (filters?.enabled !== undefined) qb.andWhere("s.enabled = :enabled", { enabled: filters.enabled });
    return qb.orderBy("s.key").getMany();
  }

  async getScenario(key: string): Promise<AutomationScenario | null> {
    return this.dataSource.getRepository(AutomationScenario).findOne({ where: { key } });
  }

  async createScenario(input: CreateScenarioInput): Promise<AutomationScenario> {
    const repo = this.dataSource.getRepository(AutomationScenario);
    const row = repo.create({
      key: input.key,
      category: input.category,
      name: input.name ?? null,
      description: input.description ?? null,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      enabled: input.enabled ?? true,
    });
    return repo.save(row);
  }

  async updateScenario(key: string, input: UpdateScenarioInput): Promise<AutomationScenario> {
    const repo = this.dataSource.getRepository(AutomationScenario);
    const row = await repo.findOneOrFail({ where: { key } });
    if (input.category != null) row.category = input.category;
    if (input.name != null) row.name = input.name;
    if (input.description != null) row.description = input.description;
    if (input.tags != null) row.tags = JSON.stringify(input.tags);
    if (input.enabled != null) row.enabled = input.enabled;
    return repo.save(row);
  }

  async deleteScenario(key: string): Promise<void> {
    await this.dataSource.getRepository(AutomationScenario).delete({ key });
  }

  async listVersions(scenarioKey: string): Promise<ScenarioVersion[]> {
    return this.dataSource.getRepository(ScenarioVersion).find({
      where: { scenarioKey },
      order: { createdAt: "DESC" },
    });
  }

  async getPublishedVersion(scenarioKey: string): Promise<ScenarioVersion | null> {
    return this.dataSource.getRepository(ScenarioVersion).findOne({
      where: { scenarioKey, status: "published" },
    });
  }

  async createVersion(input: CreateVersionInput): Promise<ScenarioVersion> {
    const parsed = ScenarioConfigSchema.safeParse(input.config);
    if (!parsed.success) throw new Error("Invalid config: " + parsed.error.message);
    const repo = this.dataSource.getRepository(ScenarioVersion);
    const maxVer = await repo
      .createQueryBuilder("v")
      .select("MAX(v.versionNumber)", "m")
      .where("v.scenarioKey = :key", { key: input.scenarioKey })
      .getRawOne<{ m: number }>();
    const versionNumber = (maxVer?.m ?? 0) + 1;
    const row = repo.create({
      scenarioKey: input.scenarioKey,
      status: input.status ?? "draft",
      versionNumber,
      config: parsed.data as unknown as Record<string, unknown>,
    });
    return repo.save(row);
  }

  async publishVersion(scenarioKey: string, versionId: number, publishedBy?: number): Promise<ScenarioVersion> {
    const repo = this.dataSource.getRepository(ScenarioVersion);
    await repo.update({ scenarioKey, status: "published" }, { status: "draft" as const });
    const row = await repo.findOneOrFail({ where: { id: versionId, scenarioKey } });
    row.status = "published";
    row.publishedBy = publishedBy ?? null;
    row.publishedAt = new Date();
    return repo.save(row);
  }

  async getVersion(scenarioKey: string, versionId: number): Promise<ScenarioVersion | null> {
    return this.dataSource.getRepository(ScenarioVersion).findOne({
      where: { scenarioKey, id: versionId },
    });
  }
}
