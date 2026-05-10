/**
 * Telegram "animation" utilities (typing, progress, editMessageText).
 * These create perceived animations in Telegram.
 *
 * @module ui/utils/animations
 */

import type { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";

/**
 * Show typing indicator.
 *
 * @param ctx - Grammy context
 * @param durationMs - How long to show typing (default: 1000ms)
 */
export async function showTyping(
  ctx: AppContext,
  durationMs: number = 1000
): Promise<void> {
  if (!ctx.chat) return;

  try {
    await ctx.api.sendChatAction(ctx.chat.id, "typing");
    if (durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
  } catch (error) {
    // Ignore errors from typing indicator
    console.warn("Failed to show typing indicator", error);
  }
}

/**
 * Show progress indicator in message.
 *
 * @param ctx - Grammy context
 * @param messageId - Message ID to edit
 * @param text - Base text
 * @param progress - Progress 0-1
 */
export async function showProgress(
  ctx: AppContext,
  messageId: number,
  text: string,
  progress: number
): Promise<void> {
  if (!ctx.chat) return;

  const bars = 10;
  const filled = Math.round(progress * bars);
  const empty = bars - filled;
  const progressBar = "█".repeat(filled) + "░".repeat(empty);
  const percentage = Math.round(progress * 100);

  await ctx.api.editMessageText(ctx.chat.id, messageId, `${text}\n\n${progressBar} ${percentage}%`, {
    parse_mode: "HTML",
  });
}

/**
 * Edit message with smooth transition.
 * Falls back to new message if edit fails.
 *
 * @param ctx - Grammy context
 * @param text - New text
 * @param options - Additional options (reply_markup, parse_mode)
 * @returns Message ID
 */
export async function editOrSend(
  ctx: AppContext,
  text: string,
  options?: {
    reply_markup?: InlineKeyboard;
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  }
): Promise<number> {
  if (!ctx.chat) {
    throw new Error("No chat in context");
  }

  const apiOptions: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2"; reply_markup?: InlineKeyboard } | undefined = options
    ? { parse_mode: options.parse_mode, reply_markup: options.reply_markup }
    : undefined;
  try {
    // Try to edit if message exists
    if (ctx.callbackQuery?.message && "message_id" in ctx.callbackQuery.message) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        text,
        apiOptions as Parameters<typeof ctx.api.editMessageText>[3]
      );
      return ctx.callbackQuery.message.message_id;
    }
  } catch (error) {
    // If edit fails, send new message
    console.warn("Failed to edit message, sending new", error);
  }

  // Send new message
  const message = await ctx.api.sendMessage(ctx.chat.id, text, apiOptions as Parameters<typeof ctx.api.sendMessage>[2]);
  return message.message_id;
}
