/**
 * Event handler: subscribe to automation events and run matching scenarios.
 * Call this from app initialization.
 *
 * @module modules/automations/integration/event-handler
 */

import type { DataSource } from "typeorm";
import type { Bot } from "grammy";
import { onEvent, getAllPublishedKeys, getPublishedConfig, runScenarioForEvent } from "../engine/index.js";
import type { AutomationEventPayload } from "../events/types.js";
import { Logger } from "../../../app/logger.js";

export function setupAutomationEventHandler(
  dataSource: DataSource,
  bot: Bot
): () => void {
  const sendMessage: Parameters<typeof runScenarioForEvent>[0]["sendMessage"] = async (
    telegramId,
    text,
    buttons
  ) => {
    const extra: { parse_mode?: string; reply_markup?: unknown } = { parse_mode: "HTML" };
    if (buttons && buttons.length > 0) {
      const { InlineKeyboard } = await import("grammy");
      const kb = new InlineKeyboard();
      for (const b of buttons) {
        if (b.url) kb.url(b.text, b.url);
        else if (b.callback_data) kb.text(b.text, b.callback_data);
      }
      extra.reply_markup = kb;
    }
    await bot.api.sendMessage(telegramId, text, extra as Parameters<typeof bot.api.sendMessage>[2]).catch(() => {});
  };

  const handler = async (payload: AutomationEventPayload): Promise<void> => {
    try {
      const publishedKeys = await getAllPublishedKeys(dataSource);
      for (const key of publishedKeys) {
        const config = await getPublishedConfig(dataSource, key);
        if (!config) continue;
        if (config.trigger.type !== "EVENT") continue;
        if (!config.trigger.eventNames?.includes(payload.event as any)) continue;
        const contextData: Record<string, number | string> = {
          balance: (payload as any).amount || 0,
          amount: (payload as any).amount || 0,
          userId: payload.userId,
        };
        await runScenarioForEvent({
          dataSource,
          scenarioKey: key,
          event: payload,
          sendMessage,
          contextData,
        });
      }
    } catch (e) {
      Logger.error("[Automations] Event handler error", e);
    }
  };

  return onEvent(handler);
}
