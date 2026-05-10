/**
 * Global error handler for Grammy bot.
 * Provides user-friendly error messages and logging.
 *
 * @module app/error-handler
 */

import type { Bot } from "grammy";
import { Logger } from "./logger.js";
import type { AppContext } from "../shared/types/context.js";
import { AppError, BusinessError, ExternalApiError, PaymentError } from "../shared/errors/index.js";
import { InlineKeyboard } from "grammy";

/**
 * Setup global error handler for bot.
 *
 * @param bot - Grammy bot instance
 */
export function setupErrorHandler(bot: Bot<AppContext>): void {
  bot.catch(async (err) => {
    const ctx = err.ctx;
    const error = err.error;

    if (isMessageNotModifiedError(error)) {
      return;
    }

    // Log error
    Logger.error("Bot error occurred", error, {
      updateId: ctx.update?.update_id,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
    });

    // Handle different error types
    if (error instanceof AppError) {
      await handleAppError(ctx, error);
    } else if (error instanceof Error) {
      await handleGenericError(ctx, error);
    } else {
      await handleUnknownError(ctx, error);
    }
  });
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("message is not modified");
}

/**
 * Handle application errors (user-friendly messages).
 */
async function handleAppError(ctx: AppContext, error: AppError): Promise<void> {
  if (!ctx.chat) return;

  try {
    let message: string;
    let showMenu = false;

    if (error instanceof BusinessError) {
      // Business logic errors - show to user
      message = `❌ ${error.message}`;
      showMenu = true;
    } else if (error instanceof PaymentError) {
      // Payment errors - show to user
      message = `💳 ${error.message}\n\n${ctx.t("support")}`;
      showMenu = true;
    } else if (error instanceof ExternalApiError) {
      // External API errors - show generic message
      message = ctx.t("bad-error");
      showMenu = true;
      Logger.error(`External API error: ${error.service}`, error.originalError);
    } else {
      // Other application errors
      message = ctx.t("bad-error");
      showMenu = true;
    }

    const keyboard = showMenu
      ? new InlineKeyboard().text(ctx.t("button-back"), "main-menu")
      : undefined;

    // Try to edit message if it exists, otherwise send new
    try {
      if (ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message) {
        await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, message, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(message, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      }
    } catch (editError) {
      // If edit fails, send new message
      await ctx.reply(message, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    }
  } catch (replyError) {
    Logger.error("Failed to send error message to user", replyError);
  }
}

/**
 * Handle generic JavaScript errors.
 */
async function handleGenericError(ctx: AppContext, error: Error): Promise<void> {
  if (!ctx.chat) return;

  try {
    const message = ctx.t("bad-error");
    const keyboard = new InlineKeyboard().text(
      ctx.t("button-back"),
      "main-menu"
    );

    // Try to edit message if it exists, otherwise send new
    try {
      if (ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          message,
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
          }
        );
      } else {
        await ctx.reply(message, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      }
    } catch (editError) {
      await ctx.reply(message, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    }
  } catch (replyError) {
    Logger.error("Failed to send error message to user", replyError);
  }
}

/**
 * Handle unknown errors (non-Error objects).
 */
async function handleUnknownError(ctx: AppContext, error: unknown): Promise<void> {
  if (!ctx.chat) return;

  try {
    const message = ctx.t("bad-error");
    const keyboard = new InlineKeyboard().text(
      ctx.t("button-back"),
      "main-menu"
    );

    await ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } catch (replyError) {
    Logger.error("Failed to send error message to user", replyError);
  }
}
