/**
 * Evaluator pipeline: conditions, segment, throttle, quiet hours, experiment, template pick.
 *
 * @module modules/automations/engine/evaluator
 */

import type { DataSource } from "typeorm";
import type { ScenarioConfig, ConditionRule, ThrottleConfig } from "../schemas/scenario-config.schema.js";
import User from "../../../entities/User.js";
import UserNotificationState from "../../../entities/automations/UserNotificationState.js";
import AutomationEventLog from "../../../entities/automations/AutomationEventLog.js";

export interface EvalContext {
  userId: number;
  telegramId: number;
  lang: "ru" | "en";
  payload: Record<string, unknown>;
}

export interface EvalResult {
  ok: boolean;
  stepId?: string;
  templateKey?: string;
  offerKey?: string;
  variantId?: string;
  reason?: string;
}

function evalRule(rule: ConditionRule, context: EvalContext, data: Record<string, number | string>): boolean {
  const raw = data[rule.field] ?? null;
  const val = rule.value;
  switch (rule.operator) {
    case "gte":
      return typeof raw === "number" && typeof val === "number" && raw >= val;
    case "lte":
      return typeof raw === "number" && typeof val === "number" && raw <= val;
    case "eq":
      return raw === val;
    case "neq":
      return raw !== val;
    case "in":
      return Array.isArray(val) && val.includes(raw as string | number);
    case "not_in":
      return Array.isArray(val) && !val.includes(raw as string | number);
    default:
      return false;
  }
}

export async function evaluateConditions(
  config: ScenarioConfig,
  context: EvalContext,
  data: Record<string, number | string>
): Promise<boolean> {
  const rules = config.conditions?.rules ?? [];
  for (const r of rules) {
    if (!evalRule(r, context, data)) return false;
  }
  return true;
}

export async function checkThrottle(
  dataSource: DataSource,
  scenarioKey: string,
  userId: number,
  config: ScenarioConfig
): Promise<{ allowed: boolean; reason?: string }> {
  const throttle: ThrottleConfig | undefined = config.throttle;
  if (!throttle) return { allowed: true };

  const stateRepo = dataSource.getRepository(UserNotificationState);
  const state = await stateRepo.findOne({ where: { scenarioKey, userId } });

  if (throttle.perUserPerScenarioHours != null && state?.lastSentAt) {
    const elapsed = (Date.now() - new Date(state.lastSentAt).getTime()) / (60 * 60 * 1000);
    if (elapsed < throttle.perUserPerScenarioHours) {
      return { allowed: false, reason: "per_user_per_scenario_cooldown" };
    }
  }

  if (throttle.perUserPerScenarioCount != null && state) {
    if (state.sendCount >= throttle.perUserPerScenarioCount) {
      return { allowed: false, reason: "per_user_per_scenario_cap" };
    }
  }

  if (throttle.perUserGlobalPromosPerDays != null && throttle.perUserGlobalDays != null) {
    const logRepo = dataSource.getRepository(AutomationEventLog);
    const since = new Date(Date.now() - throttle.perUserGlobalDays * 24 * 60 * 60 * 1000);
    const count = await logRepo
      .createQueryBuilder("l")
      .where("l.userId = :userId", { userId })
      .andWhere("l.outcome = :outcome", { outcome: "sent" })
      .andWhere("l.createdAt >= :since", { since })
      .getCount();
    if (count >= throttle.perUserGlobalPromosPerDays) {
      return { allowed: false, reason: "per_user_global_cap" };
    }
  }

  return { allowed: true };
}

export function checkQuietHours(
  config: ScenarioConfig,
  userTz: string | null
): { allowed: boolean; reason?: string } {
  const qh = config.quietHours;
  if (!qh?.enabled) return { allowed: true };
  const tz = userTz ?? qh.timezoneDefault ?? "UTC";
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz });
  const hour = parseInt(formatter.format(now), 10);
  const start = qh.allowedStartHour;
  const end = qh.allowedEndHour;
  const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inWindow) return { allowed: false, reason: "quiet_hours" };
  return { allowed: true };
}

export function pickExperimentVariant(config: ScenarioConfig): string | null {
  const exp = config.experiment;
  if (!exp?.enabled || exp.variants.length === 0) return null;
  const r = Math.random() * 100;
  let acc = 0;
  for (const v of exp.variants) {
    acc += v.splitPercent;
    if (r < acc) return v.id;
  }
  return exp.variants[exp.variants.length - 1]?.id ?? null;
}

export interface StepToSend {
  stepId: string;
  templateKey: string;
  offerKey?: string;
}

export interface MultiStepState {
  lastStepId: string | null;
  lastStepAt: Date | null;
}

/**
 * Picks the step to send: first step if no state, or next step if delay has elapsed.
 */
export function getStepToSend(
  config: ScenarioConfig,
  _context: EvalContext,
  state?: MultiStepState | null
): StepToSend | null {
  const steps = config.steps ?? [];
  if (steps.length === 0) return null;

  const now = Date.now();
  const lastStepId = state?.lastStepId ?? null;
  const lastStepAt = state?.lastStepAt ? new Date(state.lastStepAt).getTime() : null;

  if (!lastStepId || lastStepAt == null) {
    const first = steps[0];
    return {
      stepId: first.id,
      templateKey: first.templateKey,
      offerKey: first.offerVariantKey ?? undefined,
    };
  }

  const idx = steps.findIndex((s) => s.id === lastStepId);
  if (idx < 0) {
    return { stepId: steps[0].id, templateKey: steps[0].templateKey, offerKey: steps[0].offerVariantKey ?? undefined };
  }
  const next = steps[idx + 1];
  if (!next) return null;
  const delayMs = (next.delayHours ?? 0) * 60 * 60 * 1000;
  if (now < lastStepAt + delayMs) return null;
  return {
    stepId: next.id,
    templateKey: next.templateKey,
    offerKey: next.offerVariantKey ?? undefined,
  };
}
