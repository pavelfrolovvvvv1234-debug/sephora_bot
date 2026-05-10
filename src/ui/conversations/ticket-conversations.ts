/**
 * Ticket-related conversations for moderators.
 *
 * @module ui/conversations/ticket-conversations
 */

import type { AppConversation } from "../../shared/types/context.js";
import type { AppContext } from "../../shared/types/context.js";
import { TicketService } from "../../domain/tickets/TicketService.js";
import { DedicatedService } from "../../domain/dedicated/DedicatedService.js";
import { TicketType } from "../../entities/Ticket.js";
import User from "../../entities/User.js";
import DedicatedServer from "../../entities/DedicatedServer.js";
import { Logger } from "../../app/logger.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { escapeUserInput } from "../../helpers/formatting.js";

const safeT = (
  ctx: AppContext,
  key: string,
  vars?: Record<string, string | number>
): string => {
  const tFn = (ctx as any).t;
  if (typeof tFn === "function" && tFn !== safeT) {
    return tFn.call(ctx, key, vars);
  }
  return key;
};

const ensureTranslator = (ctx: AppContext): void => {
  if (typeof (ctx as any).t === "function") {
    return;
  }
  (ctx as any).t = (key: string) => key;
};

const parseTicketPayload = (payload: string | null): Record<string, any> => {
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    return {};
  }
};

const resolveAskUserRecipientId = async (
  ctx: AppContext,
  ticket: { userId: number; type: TicketType; payload: string | null },
  moderatorUserId: number
): Promise<number> => {
  if (
    ticket.type === TicketType.DEDICATED_REINSTALL ||
    ticket.type === TicketType.DEDICATED_REBOOT ||
    ticket.type === TicketType.DEDICATED_RESET ||
    ticket.type === TicketType.DEDICATED_OTHER
  ) {
    const payload = parseTicketPayload(ticket.payload);
    const dedicatedId = Number(payload.dedicatedId);
    if (Number.isInteger(dedicatedId)) {
      const dedicatedRepo = ctx.appDataSource.getRepository(DedicatedServer);
      const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
      if (dedicated?.userId && dedicated.userId !== moderatorUserId) {
        return dedicated.userId;
      }
    }
  }

  return ticket.userId;
};

const resolveAskUserRecipientIds = async (
  ctx: AppContext,
  ticket: { userId: number; type: TicketType; payload: string | null },
  moderatorUserId: number
): Promise<number[]> => {
  const recipients = new Set<number>();
  recipients.add(ticket.userId);

  if (
    ticket.type === TicketType.DEDICATED_REINSTALL ||
    ticket.type === TicketType.DEDICATED_REBOOT ||
    ticket.type === TicketType.DEDICATED_RESET ||
    ticket.type === TicketType.DEDICATED_OTHER
  ) {
    const payload = parseTicketPayload(ticket.payload);
    const dedicatedId = Number(payload.dedicatedId);
    if (Number.isInteger(dedicatedId)) {
      const dedicatedRepo = ctx.appDataSource.getRepository(DedicatedServer);
      const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
      if (dedicated?.userId) {
        recipients.add(dedicated.userId);
      }
    }
  }

  const recipientList = Array.from(recipients);
  const nonModerator = recipientList.filter((id) => id !== moderatorUserId);
  return nonModerator.length > 0 ? nonModerator : recipientList;
};

/**
 * Ask user conversation.
 */
export async function askUserConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  ensureTranslator(ctx);
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  const ticketId = session.other.ticketsView?.currentTicketId as number;
  if (!ticketId) {
    await ctx.reply(safeT(ctx, "error-invalid-context"));
    return;
  }

  await ctx.reply(safeT(ctx, "ticket-ask-user-enter-question"));
  const questionCtx = await conversation.waitFor("message:text");
  const question = questionCtx.message.text;

  const ticketService = new TicketService(ctx.appDataSource);

  try {
    const ticket = await ticketService.getTicketById(ticketId);
    if (!ticket) {
      await ctx.reply(safeT(ctx, "error-ticket-not-found"));
      return;
    }

    await ticketService.askUser(
      ticketId,
      question,
      session.main.user.id,
      session.main.user.role
    );

    // Notify user
    const userRepo = ctx.appDataSource.getRepository(User);
    const recipientIds = await resolveAskUserRecipientIds(
      ctx,
      ticket,
      session.main.user.id
    );
    if (recipientIds.length === 0) {
      await ctx.reply(safeT(ctx, "error-user-not-found"));
      return;
    }

    const safeQuestion = escapeUserInput(question);
    const message = safeT(ctx, "ticket-question-from-moderator", {
      question: safeQuestion,
      ticketId,
    });

    let delivered = false;
    for (const recipientId of recipientIds) {
      const user = await userRepo.findOne({ where: { id: recipientId } });
      if (!user) {
        continue;
      }
      try {
        await ctx.api.sendMessage(user.telegramId, message, { parse_mode: "HTML" });
        delivered = true;
      } catch (error) {
        // User might have blocked bot
        Logger.warn(`Failed to notify user ${user.telegramId} about ticket ${ticketId}:`, error);
      }
    }

    if (!delivered) {
      await ctx.reply(safeT(ctx, "error-user-not-found"));
      return;
    }

    await ctx.reply(safeT(ctx, "ticket-question-sent"));
  } catch (error: any) {
    Logger.error(`Failed to ask user for ticket ${ticketId}:`, error);
    await ctx.reply(safeT(ctx, "error-unknown", { error: error.message || "Unknown error" }));
  }
}

/**
 * Provide dedicated result conversation (for DEDICATED_ORDER).
 */
export async function provideDedicatedResultConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  ensureTranslator(ctx);
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  const ticketId = session.other.ticketsView?.currentTicketId as number;
  if (!ticketId) {
    await ctx.reply(safeT(ctx, "error-invalid-context"));
    return;
  }

  await ctx.reply(safeT(ctx, "ticket-provide-ip"));
  const ipCtx = await conversation.waitFor("message:text");
  const ip = ipCtx.message.text.trim();

  await ctx.reply(safeT(ctx, "ticket-provide-login"));
  const loginCtx = await conversation.waitFor("message:text");
  const login = loginCtx.message.text.trim();

  await ctx.reply(safeT(ctx, "ticket-provide-password"));
  const passwordCtx = await conversation.waitFor("message:text");
  const password = passwordCtx.message.text.trim();

  await ctx.reply(safeT(ctx, "ticket-provide-panel-optional"));
  const panelCtx = await conversation.waitFor("message:text");
  const panelText = panelCtx.message.text.trim();
  const panel = panelText.toLowerCase() === "/skip" ? null : (panelText || null);

  await ctx.reply(safeT(ctx, "ticket-provide-notes-optional"));
  const notesCtx = await conversation.waitFor("message:text");
  const notesText = notesCtx.message.text.trim();
  const notes = notesText.toLowerCase() === "/skip" ? null : (notesText || null);

  const credentials: Record<string, string> = {
    ip,
    login,
    password,
  };
  if (panel) credentials.panel = panel;
  if (notes) credentials.notes = notes;

  const ticketService = new TicketService(ctx.appDataSource);

  try {
    const ticket = await ticketService.provideResult(
      ticketId,
      credentials,
      session.main.user.id,
      session.main.user.role
    );

    // Notify user
    const userRepo = ctx.appDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: ticket.userId } });
    if (user) {
      try {
        const { InlineKeyboard } = await import("grammy");
        const keyboard = new InlineKeyboard()
          .text(safeT(ctx, "button-my-dedicated"), "dedicated_menu")
          .row()
          .text(safeT(ctx, "button-back"), "main-menu");

        await ctx.api.sendMessage(
          user.telegramId,
          safeT(ctx, "ticket-dedicated-ready", {
            ticketId,
            ip,
            login,
            password,
            panel: panel || safeT(ctx, "not-specified"),
            notes: notes || safeT(ctx, "none"),
          }),
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
          }
        );
      } catch (error) {
        // User might have blocked bot
        Logger.warn(`Failed to notify user ${user.telegramId} about ticket ${ticketId}:`, error);
      }
    }

    await ctx.reply(safeT(ctx, "ticket-result-provided"));
  } catch (error: any) {
    Logger.error(`Failed to provide ticket result for ticket ${ticketId}:`, error);
    const errorMessage = error?.message || "Unknown error";
    // Check if it's a validation error
    if (errorMessage.includes("Credentials must include")) {
      await ctx.reply(safeT(ctx, "ticket-credentials-invalid"));
    } else {
      await ctx.reply(safeT(ctx, "error-unknown", { error: errorMessage }));
    }
  }
}

/**
 * Provide result conversation (for operations).
 */
export async function provideResultConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  ensureTranslator(ctx);
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  const ticketId = session.other.ticketsView?.currentTicketId as number;
  if (!ticketId) {
    await ctx.reply(safeT(ctx, "error-invalid-context"));
    return;
  }

  await ctx.reply(safeT(ctx, "ticket-provide-result-text"));
  const resultCtx = await conversation.waitFor("message:text");
  const result = resultCtx.message.text.trim();

  const ticketService = new TicketService(ctx.appDataSource);

  try {
    const ticket = await ticketService.provideResult(
      ticketId,
      result,
      session.main.user.id,
      session.main.user.role
    );

    // Notify user
    const userRepo = ctx.appDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: ticket.userId } });
    if (user) {
      try {
        await ctx.api.sendMessage(
          user.telegramId,
          safeT(ctx, "ticket-result-received", { ticketId, result }),
          { parse_mode: "HTML" }
        );
      } catch (error) {
        // User might have blocked bot
        Logger.warn(`Failed to notify user ${user.telegramId} about ticket ${ticketId}:`, error);
      }
    }

    await ctx.reply(safeT(ctx, "ticket-result-provided"));
  } catch (error: any) {
    Logger.error(`Failed to provide ticket result for ticket ${ticketId}:`, error);
    const errorMessage = error?.message || "Unknown error";
    // Check if it's a validation error
    if (errorMessage.includes("Credentials must include")) {
      await ctx.reply(safeT(ctx, "ticket-credentials-invalid"));
    } else {
      await ctx.reply(safeT(ctx, "error-unknown", { error: errorMessage }));
    }
  }
}

/**
 * Reject ticket conversation.
 */
export async function rejectTicketConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  ensureTranslator(ctx);
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  const ticketId = session.other.ticketsView?.currentTicketId as number;
  if (!ticketId) {
    await ctx.reply(safeT(ctx, "error-invalid-context"));
    return;
  }

  await ctx.reply(safeT(ctx, "ticket-reject-enter-reason-optional"));
  const reasonCtx = await conversation.waitFor("message:text");
  const reason = reasonCtx.message.text.trim() || null;

  const ticketService = new TicketService(ctx.appDataSource);

  try {
    const ticket = await ticketService.rejectTicket(
      ticketId,
      reason,
      session.main.user.id,
      session.main.user.role
    );

    // Notify user
    const userRepo = ctx.appDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: ticket.userId } });
    if (user) {
      try {
        await ctx.api.sendMessage(
          user.telegramId,
          safeT(ctx, "ticket-rejected", {
            ticketId,
            reason: reason || safeT(ctx, "no-reason-provided"),
          }),
          { parse_mode: "HTML" }
        );
      } catch (error) {
        // User might have blocked bot
        Logger.warn(`Failed to notify user ${user.telegramId} about ticket ${ticketId}:`, error);
      }
    }

    await ctx.reply(safeT(ctx, "ticket-rejected-by-moderator"));
  } catch (error: any) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: error.message }));
  }
}
