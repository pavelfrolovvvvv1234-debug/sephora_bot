/**
 * Withdraw request conversation for users.
 *
 * @module ui/conversations/withdraw-conversation
 */

import type { AppConversation } from "../../shared/types/context.js";
import type { AppContext } from "../../shared/types/context.js";
import { TicketService } from "../../domain/tickets/TicketService.js";
import { TicketType } from "../../entities/Ticket.js";
import User, { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { getModeratorChatId } from "../../shared/moderator-chat.js";

/** Minimum balance (USD) required to request a withdrawal. */
export const MIN_WITHDRAW_AMOUNT = 15;

/**
 * Withdraw request conversation.
 */
export async function withdrawRequestConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  const session = await ctx.session;
  const userRepo = ctx.appDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: session.main.user.id } });

  if (!user) {
    await ctx.reply(ctx.t("error-user-not-found"));
    return;
  }

  const refBalance = user.referralBalance ?? 0;
  if (refBalance <= 0) {
    await ctx.reply(ctx.t("withdraw-insufficient-balance", {
      balance: refBalance,
    }));
    return;
  }

  if (refBalance < MIN_WITHDRAW_AMOUNT) {
    await ctx.reply(ctx.t("withdraw-minimum-not-met", {
      balance: refBalance,
    }));
    return;
  }

  let amount: number;
  const initialAmount = session.other?.withdrawInitialAmount;
  if (initialAmount != null && initialAmount >= MIN_WITHDRAW_AMOUNT && initialAmount <= refBalance) {
    amount = initialAmount;
    delete session.other?.withdrawInitialAmount;
  } else {
    if (initialAmount != null) delete session.other?.withdrawInitialAmount;
    // Ask for amount
    await ctx.reply(ctx.t("withdraw-enter-amount", {
      maxAmount: refBalance,
      balance: refBalance,
    }), {
      parse_mode: "HTML",
    });

    const amountCtx = await conversation.waitFor("message:text");
    const amountText = amountCtx.message.text.trim().replace(/[$,]/g, "");
    amount = parseFloat(amountText);

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply(ctx.t("withdraw-invalid-amount"));
      return;
    }
    if (amount < MIN_WITHDRAW_AMOUNT) {
      await ctx.reply(ctx.t("withdraw-minimum-not-met", {
        balance: refBalance,
      }));
      return;
    }
    if (amount > refBalance) {
      await ctx.reply(ctx.t("withdraw-amount-exceeds-balance", {
        amount,
        balance: refBalance,
      }));
      return;
    }
  }

  // Ask for payment details
  await ctx.reply(ctx.t("withdraw-enter-details"));
  const detailsCtx = await conversation.waitFor("message:text");
  const details = detailsCtx.message.text.trim();

  if (!details || details.length < 5) {
    await ctx.reply(ctx.t("withdraw-details-too-short"));
    return;
  }

  // Ask for comment (optional)
  await ctx.reply(ctx.t("withdraw-enter-comment-optional"));
  const commentCtx = await conversation.waitFor("message:text");
  const commentText = commentCtx.message.text.trim();
  const comment = commentText.toLowerCase() === "/skip" ? null : (commentText || null);

  // Confirm
  const { InlineKeyboard } = await import("grammy");
  const keyboard = new InlineKeyboard()
    .text(ctx.t("button-agree"), `withdraw_confirm_${Date.now()}`)
    .text(ctx.t("button-cancel"), "withdraw_cancel");

  await ctx.reply(ctx.t("withdraw-confirm", {
    amount,
    details,
    comment: comment || ctx.t("none"),
  }), {
    reply_markup: keyboard,
    parse_mode: "HTML",
  });

  // Wait for confirmation
  const confirmCtx = await conversation.waitForCallbackQuery(/^withdraw_(confirm|cancel)/);
  if (confirmCtx.match[1] === "cancel") {
    await confirmCtx.editMessageText(ctx.t("withdraw-cancelled"));
    return;
  }

  // Create ticket
  const ticketService = new TicketService(ctx.appDataSource);
  const payload = {
    amount,
    details,
    comment,
  };

  try {
    const ticket = await ticketService.createTicket(
      session.main.user.id,
      TicketType.WITHDRAW_REQUEST,
      payload
    );

    // Notify moderators
    const moderators = await userRepo.find({
      where: [{ role: Role.Moderator }, { role: Role.Admin }],
    });

    for (const mod of moderators) {
      try {
        const modKeyboard = new InlineKeyboard()
          .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
          .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);

        await ctx.api.sendMessage(
          mod.telegramId,
          ctx.t("ticket-moderator-notification", {
            ticketId: ticket.id,
            userId: session.main.user.id,
            username: ctx.from?.username || ctx.from?.first_name || "Unknown",
            type: ctx.t(`ticket-type-${ticket.type}`),
            amountLine: ctx.t("withdraw-notification-amount", { amount }),
            detailsLine: ctx.t("withdraw-notification-details", { details }),
          }),
          {
            reply_markup: modKeyboard,
            parse_mode: "HTML",
          }
        );
      } catch (error) {
        Logger.warn(`Failed to notify moderator ${mod.telegramId} about withdraw ${ticket.id}:`, error);
      }
    }

    const moderatorChatId = getModeratorChatId();
    if (moderatorChatId) {
      try {
        const modKeyboard = new InlineKeyboard()
          .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
          .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);

        await ctx.api.sendMessage(
          moderatorChatId,
          ctx.t("ticket-moderator-notification", {
            ticketId: ticket.id,
            userId: session.main.user.id,
            username: ctx.from?.username || ctx.from?.first_name || "Unknown",
            type: ctx.t(`ticket-type-${ticket.type}`),
            amountLine: ctx.t("withdraw-notification-amount", { amount }),
            detailsLine: ctx.t("withdraw-notification-details", { details }),
          }),
          {
            reply_markup: modKeyboard,
            parse_mode: "HTML",
          }
        );
      } catch (error) {
        Logger.warn(`Failed to notify moderator chat about withdraw ${ticket.id}:`, error);
      }
    }

    await confirmCtx.editMessageText(ctx.t("withdraw-request-created", {
      ticketId: ticket.id,
    }), {
      parse_mode: "HTML",
    });
  } catch (error: any) {
    Logger.error("Failed to create withdraw request:", error);
    await confirmCtx.editMessageText(ctx.t("error-unknown", {
      error: error.message || "Unknown error",
    }));
  }
}
