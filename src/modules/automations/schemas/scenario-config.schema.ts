/**
 * Zod schemas for Automation Scenario config.
 * Single schema covering triggers, conditions, steps, offers, templates, throttles, quiet hours, experiments.
 *
 * @module modules/automations/schemas/scenario-config.schema
 */

import { z } from "zod";

// —— Trigger ——
export const TriggerTypeEnum = z.enum(["EVENT", "SCHEDULE", "METRIC"]);
export type TriggerType = z.infer<typeof TriggerTypeEnum>;

export const EventNameEnum = z.enum([
  "deposit.created",
  "deposit.completed",
  "user.login",
  "service.created",
  "service.expiring",
  "service.grace_start",
  "incident.created",
  "tier.achieved",
]);
export type EventName = z.infer<typeof EventNameEnum>;

export const ScheduleCronSchema = z.object({
  type: z.literal("cron"),
  expression: z.string(), // e.g. "0 9 * * *" daily 09:00
});
export const ScheduleCalendarSchema = z.object({
  type: z.literal("calendar"),
  window: z.enum(["end_of_month", "end_of_quarter", "end_of_week"]),
  daysBefore: z.number().int().min(0).max(14).optional().default(2),
  timezone: z.string().optional().default("UTC"),
});
export const ScheduleSchema = z.discriminatedUnion("type", [
  ScheduleCronSchema,
  ScheduleCalendarSchema,
]);

export const MetricSourceSchema = z.object({
  source: z.string(), // e.g. "vmm", "panel"
  metric: z.enum(["cpu", "ram", "disk", "traffic", "io_throttle"]),
  aggregation: z.enum(["avg", "max"]).default("avg"),
  lookbackHours: z.number().int().min(1).max(168).default(24),
  thresholdPercent: z.number().min(0).max(100),
});

export const TriggerConfigSchema = z.object({
  type: TriggerTypeEnum,
  eventNames: z.array(EventNameEnum).optional(), // for EVENT
  schedule: ScheduleSchema.optional(), // for SCHEDULE
  metric: MetricSourceSchema.optional(), // for METRIC
});
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// —— Conditions ——
export const ConditionOperator = z.enum(["gte", "lte", "eq", "neq", "in", "not_in"]);
export type ConditionOperatorType = z.infer<typeof ConditionOperator>;

export const ConditionRuleSchema = z.object({
  field: z.string(), // balance, tier, ltv, service_count, last_deposit_days, etc.
  operator: ConditionOperator,
  value: z.union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))]),
});
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;

export const ConditionConfigSchema = z.object({
  rules: z.array(ConditionRuleSchema).default([]),
  notSentInHours: z.number().int().min(0).optional(),
  cooldownHours: z.number().int().min(0).optional(),
  minPlan: z.string().optional(),
  serviceTypes: z.array(z.enum(["vds", "dedicated", "domain"])).optional(),
  serviceStatus: z.array(z.string()).optional(),
});
export type ConditionConfig = z.infer<typeof ConditionConfigSchema>;

// —— Segment ——
export const SegmentRuleSchema = z.object({
  segmentKey: z.string().optional(), // e.g. "active_vps", "inactive_30d"
  jsonRules: z.record(z.unknown()).optional(), // advanced: JSON rules
  sqlSegment: z.string().optional(), // advanced: raw SQL condition (admin only)
});
export type SegmentConfig = z.infer<typeof SegmentRuleSchema>;

// —— Step (multi-step flow) ——
export const StepConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  delayHours: z.number().min(0).default(0), // offset from trigger or previous step
  condition: ConditionConfigSchema.optional(), // step-level conditions
  templateKey: z.string(), // key into templates map
  offerVariantKey: z.string().optional(), // key into offers map for this step
});
export type StepConfig = z.infer<typeof StepConfigSchema>;

// —— Offer ——
export const OfferTypeEnum = z.enum([
  "bonus_percent",
  "discount_percent",
  "extra_days",
  "free_trial",
]);
export const OfferScopeEnum = z.enum(["deposit", "renewal", "upgrade", "add_on"]);

export const OfferConfigSchema = z.object({
  key: z.string(),
  type: OfferTypeEnum,
  scope: OfferScopeEnum.optional().default("deposit"),
  value: z.number(), // percent or days
  ttlHours: z.number().int().min(0),
  autoApply: z.boolean().default(true),
  claimButton: z.boolean().default(false),
});
export type OfferConfig = z.infer<typeof OfferConfigSchema>;

// —— Template ——
export const ButtonActionSchema = z.object({
  text: z.string(),
  action: z.enum(["url", "callback", "deep_link"]),
  payload: z.string(), // url, or callback data, or deep-link path
});
export const TemplateConfigSchema = z.object({
  key: z.string(),
  ru: z.object({
    text: z.string(),
    fallback: z.string().optional(),
    buttons: z.array(ButtonActionSchema).optional(),
  }),
  en: z.object({
    text: z.string(),
    fallback: z.string().optional(),
    buttons: z.array(ButtonActionSchema).optional(),
  }).optional(),
  variables: z.array(z.string()).optional(), // e.g. ["user.balance", "offer.percent"]
});
export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;

// —— Throttle ——
export const ThrottleConfigSchema = z.object({
  perUserPerScenarioHours: z.number().int().min(0).optional(), // e.g. 72
  perUserPerScenarioCount: z.number().int().min(0).optional(),
  perUserGlobalPromosPerDays: z.number().int().min(0).optional(),
  perUserGlobalDays: z.number().int().min(0).optional(),
  perStepCap: z.number().int().min(0).optional(),
});
export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

// —— Quiet hours ——
export const QuietHoursConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezoneDefault: z.string().default("UTC"),
  allowedStartHour: z.number().int().min(0).max(23), // inclusive
  allowedEndHour: z.number().int().min(0).max(23),   // exclusive
});
export type QuietHoursConfig = z.infer<typeof QuietHoursConfigSchema>;

// —— Experiment ——
export const ExperimentVariantSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  splitPercent: z.number().min(0).max(100),
  templateKey: z.string().optional(),
  offerKey: z.string().optional(),
});
export const ExperimentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  variants: z.array(ExperimentVariantSchema).default([]),
});
export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;

// —— Attribution ——
export const AttributionConfigSchema = z.object({
  conversionWindowHours: z.number().int().min(0).default(72),
  successEvent: z.enum(["deposit", "renew", "upgrade", "add_on"]).default("deposit"),
  model: z.enum(["last_touch"]).default("last_touch"),
});
export type AttributionConfig = z.infer<typeof AttributionConfigSchema>;

// —— Top-level Scenario Config ——
export const ScenarioConfigSchema = z.object({
  trigger: TriggerConfigSchema,
  conditions: ConditionConfigSchema.optional().default({ rules: [] }),
  segment: SegmentRuleSchema.optional(),
  steps: z.array(StepConfigSchema).default([]),
  offers: z.record(OfferConfigSchema).default({}),
  templates: z.record(TemplateConfigSchema).default({}),
  throttle: ThrottleConfigSchema.optional(),
  quietHours: QuietHoursConfigSchema.optional(),
  experiment: ExperimentConfigSchema.optional(),
  attribution: AttributionConfigSchema.optional(),
});
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;
