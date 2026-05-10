/**
 * Dedicated server conversations for users.
 *
 * @module ui/conversations/dedicated-conversations
 */

import type { AppConversation } from "../../shared/types/context.js";
import type { AppContext } from "../../shared/types/context.js";
import { TicketService } from "../../domain/tickets/TicketService.js";
import { DedicatedService } from "../../domain/dedicated/DedicatedService.js";
import { TicketType } from "../../entities/Ticket.js";
import { DedicatedServerStatus } from "../../entities/DedicatedServer.js";
import User, { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { getModeratorChatId } from "../../shared/moderator-chat.js";

/**
 * Order dedicated server conversation.
 */
export async function orderDedicatedConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  await ctx.reply(ctx.t("dedicated-order-enter-requirements"));
  const requirementsCtx = await conversation.waitFor("message:text");
  const requirements = requirementsCtx.message.text.trim();

  await ctx.reply(ctx.t("dedicated-order-enter-comment-optional"));
  const commentCtx = await conversation.waitFor("message:text");
  const commentText = commentCtx.message.text.trim();
  const comment = commentText.toLowerCase() === "/skip" ? null : (commentText || null);

  await createDedicatedOrderTicket(ctx, requirements, comment);
}

/**
 * Create ticket for dedicated operation.
 */
export async function createDedicatedOperationTicket(
  ctx: AppContext,
  dedicatedId: number,
  type: TicketType
): Promise<void> {
  const session = await ctx.session;
  const ticketService = new TicketService(ctx.appDataSource);
  const dedicatedService = new DedicatedService(ctx.appDataSource);

  const dedicated = await dedicatedService.getDedicatedById(dedicatedId);
  if (!dedicated || dedicated.userId !== session.main.user.id) {
    await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
    return;
  }

  // Check if dedicated is active
  if (type === TicketType.DEDICATED_POWER_ON) {
    if (dedicated.status !== DedicatedServerStatus.SUSPENDED) {
      await ctx.answerCallbackQuery(ctx.t("dedicated-not-suspended").substring(0, 200));
      return;
    }
  } else if (type === TicketType.DEDICATED_POWER_OFF) {
    if (dedicated.status !== DedicatedServerStatus.ACTIVE) {
      await ctx.answerCallbackQuery(ctx.t("dedicated-not-active").substring(0, 200));
      return;
    }
  } else {
    if (dedicated.status !== DedicatedServerStatus.ACTIVE) {
      await ctx.answerCallbackQuery(ctx.t("dedicated-not-active").substring(0, 200));
      return;
    }
  }

  try {
    const ticket = await ticketService.createTicket(
      session.main.user.id,
      type,
      { dedicatedId }
    );

    // Notify moderators
    const userRepo = ctx.appDataSource.getRepository(User);
    const moderators = await userRepo.find({
      where: [{ role: Role.Moderator }, { role: Role.Admin }],
    });

    for (const mod of moderators) {
      try {
        const { InlineKeyboard } = await import("grammy");
        const keyboard = new InlineKeyboard()
          .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
          .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);

        await ctx.api.sendMessage(
          mod.telegramId,
          ctx.t("ticket-moderator-notification", {
            ticketId: ticket.id,
            userId: session.main.user.id,
            username: ctx.from?.username || ctx.from?.first_name || "Unknown",
            type: ctx.t(`ticket-type-${ticket.type}`),
            amountLine: "",
            detailsLine: "",
          }),
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
          }
        );
      } catch (error) {
        // Moderator might have blocked bot
        Logger.warn(`Failed to notify moderator ${mod.telegramId} about ticket ${ticket.id}:`, error);
      }
    }

    const moderatorChatId = getModeratorChatId();
    if (moderatorChatId) {
      try {
        const { InlineKeyboard } = await import("grammy");
        const keyboard = new InlineKeyboard()
          .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
          .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);
        await ctx.api.sendMessage(
          moderatorChatId,
          ctx.t("ticket-moderator-notification", {
            ticketId: ticket.id,
            userId: session.main.user.id,
            username: ctx.from?.username || ctx.from?.first_name || "Unknown",
            type: ctx.t(`ticket-type-${ticket.type}`),
            amountLine: "",
            detailsLine: "",
          }),
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
          }
        );
      } catch (error) {
        Logger.warn(`Failed to notify moderator chat about ticket ${ticket.id}:`, error);
      }
    }

    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard()
      .text(ctx.t("button-view-ticket"), `ticket_user_view_${ticket.id}`)
      .text(ctx.t("button-back"), "dedicated-menu-back");

    try {
      await ctx.editMessageText(
        ctx.t("dedicated-operation-requested", {
          operation: ctx.t(`ticket-type-${type}`),
          ticketId: ticket.id,
        }),
        {
          reply_markup: keyboard,
          parse_mode: "HTML",
        }
      );
    } catch (editError) {
      // If editMessageText fails, try to answer callback query
      await ctx.answerCallbackQuery(ctx.t("dedicated-operation-requested", {
        operation: ctx.t(`ticket-type-${type}`),
        ticketId: ticket.id,
      }).substring(0, 200));
    }
  } catch (error: any) {
    Logger.error(`Failed to create dedicated operation ticket:`, error);
    const errorMessage = error?.message || "Unknown error";
    try {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: errorMessage }).substring(0, 200));
    } catch (answerError) {
      // Ignore if callback query already answered
    }
  }
}

/**
 * Create ticket for dedicated order (shared by conversation and inline flow).
 */
export async function createDedicatedOrderTicket(
  ctx: AppContext,
  requirements: string,
  comment: string | null
): Promise<void> {
  const session = await ctx.session;
  const ticketService = new TicketService(ctx.appDataSource);
  const dedicatedService = new DedicatedService(ctx.appDataSource);
  const buyerIsStaff =
    session.main.user.role === Role.Admin || session.main.user.role === Role.Moderator;

  try {
    const payload = {
      requirements,
      comment,
    };

    const ticket = await ticketService.createTicket(
      session.main.user.id,
      TicketType.DEDICATED_ORDER,
      payload,
      { excludeFromUserStats: buyerIsStaff }
    );

    // Create dedicated server request
    await dedicatedService.createDedicatedRequest(
      session.main.user.id,
      ticket.id,
      undefined
    );

    const userRepo = ctx.appDataSource.getRepository(User);

    if (!buyerIsStaff) {
      const moderators = await userRepo.find({
        where: [{ role: Role.Moderator }, { role: Role.Admin }],
      });

      for (const mod of moderators) {
        try {
          const { InlineKeyboard } = await import("grammy");
          const keyboard = new InlineKeyboard()
            .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
            .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);

          await ctx.api.sendMessage(
            mod.telegramId,
            ctx.t("ticket-moderator-notification", {
              ticketId: ticket.id,
              userId: session.main.user.id,
              username: ctx.from?.username || ctx.from?.first_name || "Unknown",
              type: ctx.t(`ticket-type-${ticket.type}`),
              amountLine: "",
              detailsLine: "",
            }),
            {
              reply_markup: keyboard,
              parse_mode: "HTML",
            }
          );
        } catch (error) {
          // Moderator might have blocked bot
          Logger.warn(`Failed to notify moderator ${mod.telegramId} about ticket ${ticket.id}:`, error);
        }
      }

      const moderatorChatId = getModeratorChatId();
      if (moderatorChatId) {
        try {
          const { InlineKeyboard } = await import("grammy");
          const keyboard = new InlineKeyboard()
            .text(ctx.t("button-open"), `ticket_view_${ticket.id}`)
            .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);
          await ctx.api.sendMessage(
            moderatorChatId,
            ctx.t("ticket-moderator-notification", {
              ticketId: ticket.id,
              userId: session.main.user.id,
              username: ctx.from?.username || ctx.from?.first_name || "Unknown",
              type: ctx.t(`ticket-type-${ticket.type}`),
              amountLine: "",
              detailsLine: "",
            }),
            {
              reply_markup: keyboard,
              parse_mode: "HTML",
            }
          );
        } catch (error) {
          Logger.warn(`Failed to notify moderator chat about ticket ${ticket.id}:`, error);
        }
      }
    }

    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard()
      .url(ctx.t("button-support"), "tg://resolve?domain=sephora_sup")
      .row()
      .text(ctx.t("button-view-ticket"), `ticket_user_view_${ticket.id}`)
      .text(ctx.t("button-back"), "dedicated-menu-back");

    await ctx.reply(
      ctx.t("dedicated-order-success", {
        ticketId: ticket.id,
      }),
      {
        reply_markup: keyboard,
        parse_mode: "HTML",
      }
    );
  } catch (error: any) {
    Logger.error(`Failed to create dedicated order:`, error);
    await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
  }
}
