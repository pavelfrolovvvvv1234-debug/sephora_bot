/**
 * Run due multi-step steps: find users whose next step delay has elapsed and send that step.
 *
 * @module modules/automations/engine/due-steps-runner
 */

import type { DataSource } from "typeorm";
import { getPublishedConfig, getAllPublishedKeys } from "./config-loader.js";
import {
  getStepToSend,
  checkThrottle,
  checkQuietHours,
} from "./evaluator.js";
import { renderTemplate } from "./template-renderer.js";
import { createOfferInstance } from "./offer-service.js";
import User from "../../../entities/User.js";
import UserNotificationState from "../../../entities/automations/UserNotificationState.js";
import AutomationEventLog from "../../../entities/automations/AutomationEventLog.js";
import AutomationScenario from "../../../entities/automations/AutomationScenario.js";
import type { SendMessageFn } from "./runner.js";
import { Logger } from "../../../app/logger.js";

export async function runDueMultiSteps(
  dataSource: DataSource,
  sendMessage: SendMessageFn
): Promise<number> {
  const publishedKeys = await getAllPublishedKeys(dataSource);
  const scenarioRepo = dataSource.getRepository(AutomationScenario);
  const stateRepo = dataSource.getRepository(UserNotificationState);
  const userRepo = dataSource.getRepository(User);
  let sent = 0;

  for (const scenarioKey of publishedKeys) {
    const scenario = await scenarioRepo.findOne({ where: { key: scenarioKey } });
    if (!scenario?.enabled) continue;

    const config = await getPublishedConfig(dataSource, scenarioKey);
    if (!config?.steps?.length || config.steps.length < 2) continue;

    const lastStepId = config.steps[config.steps.length - 1]?.id;
    const states = await stateRepo.find({
      where: { scenarioKey },
    });
    for (const state of states) {
      if (state.lastStepId === lastStepId || !state.lastStepId || !state.lastStepAt) continue;

      const step = getStepToSend(config, {
        userId: state.userId,
        telegramId: 0,
        lang: "ru",
        payload: {},
      }, { lastStepId: state.lastStepId, lastStepAt: state.lastStepAt });
      if (!step) continue;

      const user = await userRepo.findOne({
        where: { id: state.userId },
        select: ["id", "telegramId", "lang"],
      });
      if (!user?.telegramId) continue;

      const throttle = await checkThrottle(dataSource, scenarioKey, state.userId, config);
      if (!throttle.allowed) continue;
      if (!checkQuietHours(config, null).allowed) continue;

      const template = config.templates?.[step.templateKey];
      if (!template) continue;

      const variables: Record<string, string | number> = {
        "user.balance": 0,
        "user.id": state.userId,
      };
      try {
        const rendered = renderTemplate(template, (user.lang as "ru" | "en") ?? "ru", variables);
        await sendMessage(user.telegramId, rendered.text, rendered.buttons);

        const offer = step.offerKey ? config.offers?.[step.offerKey] : null;
        if (offer) {
          await createOfferInstance(dataSource, {
            userId: state.userId,
            scenarioKey,
            stepId: step.stepId,
            offerKey: offer.key,
            type: offer.type,
            value: offer.value,
            ttlHours: offer.ttlHours,
          });
        }

        state.lastSentAt = new Date();
        state.sendCount += 1;
        state.lastStepId = step.stepId;
        state.lastStepAt = new Date();
        await stateRepo.save(state);

        const logRepo = dataSource.getRepository(AutomationEventLog);
        await logRepo.save(
          logRepo.create({ scenarioKey, userId: state.userId, outcome: "sent", stepId: step.stepId, reason: null })
        );
        sent++;
      } catch (e) {
        Logger.error(`[Automations] due step ${scenarioKey} ${step.stepId} for user ${state.userId} failed`, e);
        const logRepo = dataSource.getRepository(AutomationEventLog);
        await logRepo.save(
          logRepo.create({
            scenarioKey,
            userId: state.userId,
            outcome: "error",
            stepId: step.stepId,
            reason: String(e),
          })
        );
      }
    }
  }
  return sent;
}
