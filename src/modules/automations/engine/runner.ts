/**
 * Run scenario for an event: load config, evaluate, send, log.
 *
 * @module modules/automations/engine/runner
 */

import type { DataSource } from "typeorm";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import type { AutomationEventPayload } from "../events/types.js";
import { getPublishedConfig } from "./config-loader.js";
import {
  evaluateConditions,
  checkThrottle,
  checkQuietHours,
  getStepToSend,
  type EvalContext,
} from "./evaluator.js";
import { renderTemplate } from "./template-renderer.js";
import { createOfferInstance } from "./offer-service.js";
import User from "../../../entities/User.js";
import UserNotificationState from "../../../entities/automations/UserNotificationState.js";
import AutomationEventLog from "../../../entities/automations/AutomationEventLog.js";
import AutomationScenario from "../../../entities/automations/AutomationScenario.js";
import { Logger } from "../../../app/logger.js";

export type SendMessageFn = (telegramId: number, text: string, buttons?: Array<{ text: string; url?: string; callback_data?: string }>) => Promise<void>;

export interface RunScenarioParams {
  dataSource: DataSource;
  scenarioKey: string;
  event: AutomationEventPayload;
  sendMessage: SendMessageFn;
  contextData: Record<string, number | string>;
}

export interface RunScheduleScenarioParams {
  dataSource: DataSource;
  scenarioKey: string;
  userId: number;
  sendMessage: SendMessageFn;
  contextData: Record<string, number | string>;
}

export async function runScenarioForEvent(params: RunScenarioParams): Promise<"sent" | "skipped" | "error"> {
  const { dataSource, scenarioKey, event, sendMessage, contextData } = params;
  const userId = event.userId;

  const scenarioRepo = dataSource.getRepository(AutomationScenario);
  const scenario = await scenarioRepo.findOne({ where: { key: scenarioKey } });
  if (!scenario?.enabled) return "skipped";

  const config = await getPublishedConfig(dataSource, scenarioKey);
  if (!config) return "skipped";

  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId }, select: ["id", "telegramId", "lang"] });
  if (!user?.telegramId) return "skipped";

  const ctx: EvalContext = {
    userId: user.id,
    telegramId: user.telegramId,
    lang: (user.lang as "ru" | "en") ?? "ru",
    payload: event as unknown as Record<string, unknown>,
  };

  const conditionsOk = await evaluateConditions(config, ctx, contextData);
  if (!conditionsOk) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, "conditions");
    return "skipped";
  }

  const throttle = await checkThrottle(dataSource, scenarioKey, userId, config);
  if (!throttle.allowed) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, throttle.reason ?? null);
    return "skipped";
  }

  const quiet = checkQuietHours(config, null);
  if (!quiet.allowed) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, quiet.reason ?? null);
    return "skipped";
  }

  const stateRepo = dataSource.getRepository(UserNotificationState);
  let state = await stateRepo.findOne({ where: { scenarioKey, userId } });
  const step = getStepToSend(config, ctx, state ? { lastStepId: state.lastStepId, lastStepAt: state.lastStepAt } : null);
  if (!step) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, "no_step");
    return "skipped";
  }

  const template = config.templates?.[step.templateKey];
  if (!template) {
    await logOutcome(dataSource, scenarioKey, userId, "error", step.stepId, "missing_template");
    return "error";
  }

  const offer = step.offerKey ? config.offers?.[step.offerKey] : null;

  const variables: Record<string, string | number> = {
    "user.balance": (contextData["balance"] as number) ?? 0,
    "user.id": userId,
    ...contextData,
  };

  try {
    const rendered = renderTemplate(template, ctx.lang, variables);
    await sendMessage(user.telegramId, rendered.text, rendered.buttons);

    if (offer) {
      await createOfferInstance(dataSource, {
        userId,
        scenarioKey,
        stepId: step.stepId,
        offerKey: offer.key,
        type: offer.type,
        value: offer.value,
        ttlHours: offer.ttlHours,
      });
    }

    if (!state) {
      state = stateRepo.create({ scenarioKey, userId, sendCount: 0 });
      await stateRepo.save(state);
    }
    state.lastSentAt = new Date();
    state.sendCount += 1;
    state.lastStepId = step.stepId;
    state.lastStepAt = new Date();
    await stateRepo.save(state);

    await logOutcome(dataSource, scenarioKey, userId, "sent", step.stepId, null);
    return "sent";
  } catch (e) {
    Logger.error(`[Automations] runScenario ${scenarioKey} send failed`, e);
    await logOutcome(dataSource, scenarioKey, userId, "error", step.stepId, String(e));
    return "error";
  }
}

/** Run a SCHEDULE-triggered scenario for one user (e.g. from schedule runner). */
export async function runScenarioForScheduleUser(params: RunScheduleScenarioParams): Promise<"sent" | "skipped" | "error"> {
  const { dataSource, scenarioKey, userId, sendMessage, contextData } = params;

  const scenarioRepo = dataSource.getRepository(AutomationScenario);
  const scenario = await scenarioRepo.findOne({ where: { key: scenarioKey } });
  if (!scenario?.enabled) return "skipped";

  const config = await getPublishedConfig(dataSource, scenarioKey);
  if (!config || config.trigger.type !== "SCHEDULE") return "skipped";

  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId }, select: ["id", "telegramId", "lang"] });
  if (!user?.telegramId) return "skipped";

  const ctx: EvalContext = {
    userId: user.id,
    telegramId: user.telegramId,
    lang: (user.lang as "ru" | "en") ?? "ru",
    payload: {},
  };

  const conditionsOk = await evaluateConditions(config, ctx, contextData);
  if (!conditionsOk) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, "conditions");
    return "skipped";
  }

  const throttle = await checkThrottle(dataSource, scenarioKey, userId, config);
  if (!throttle.allowed) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, throttle.reason ?? null);
    return "skipped";
  }

  const quiet = checkQuietHours(config, null);
  if (!quiet.allowed) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, quiet.reason ?? null);
    return "skipped";
  }

  const stateRepo = dataSource.getRepository(UserNotificationState);
  let state = await stateRepo.findOne({ where: { scenarioKey, userId } });
  const step = getStepToSend(config, ctx, state ? { lastStepId: state.lastStepId, lastStepAt: state.lastStepAt } : null);
  if (!step) {
    await logOutcome(dataSource, scenarioKey, userId, "skipped", null, "no_step");
    return "skipped";
  }

  const template = config.templates?.[step.templateKey];
  if (!template) {
    await logOutcome(dataSource, scenarioKey, userId, "error", step.stepId, "missing_template");
    return "error";
  }

  const offer = step.offerKey ? config.offers?.[step.offerKey] : null;
  const variables: Record<string, string | number> = {
    "user.balance": (contextData["balance"] as number) ?? 0,
    "user.id": userId,
    ...contextData,
  };

  try {
    const rendered = renderTemplate(template, ctx.lang, variables);
    await sendMessage(user.telegramId, rendered.text, rendered.buttons);
    if (offer) {
      await createOfferInstance(dataSource, {
        userId,
        scenarioKey,
        stepId: step.stepId,
        offerKey: offer.key,
        type: offer.type,
        value: offer.value,
        ttlHours: offer.ttlHours,
      });
    }
    if (!state) {
      state = stateRepo.create({ scenarioKey, userId, sendCount: 0 });
      await stateRepo.save(state);
    }
    state.lastSentAt = new Date();
    state.sendCount += 1;
    state.lastStepId = step.stepId;
    state.lastStepAt = new Date();
    await stateRepo.save(state);
    await logOutcome(dataSource, scenarioKey, userId, "sent", step.stepId, null);
    return "sent";
  } catch (e) {
    Logger.error(`[Automations] runScenarioForScheduleUser ${scenarioKey} send failed`, e);
    await logOutcome(dataSource, scenarioKey, userId, "error", step.stepId, String(e));
    return "error";
  }
}

async function logOutcome(
  dataSource: DataSource,
  scenarioKey: string,
  userId: number | null,
  outcome: "sent" | "skipped" | "error",
  stepId: string | null,
  reason: string | null
): Promise<void> {
  const repo = dataSource.getRepository(AutomationEventLog);
  await repo.save(
    repo.create({ scenarioKey, userId, outcome, stepId, reason })
  );
}
