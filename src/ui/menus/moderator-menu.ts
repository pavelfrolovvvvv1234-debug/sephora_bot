/**
 * Moderator menu for ticket management.
 *
 * @module ui/menus/moderator-menu
 */

import { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";
import { TicketService } from "../../domain/tickets/TicketService.js";
import { TicketStatus, TicketType } from "../../entities/Ticket.js";
import User, { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { InlineKeyboard } from "grammy";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { escapeUserInput } from "../../helpers/formatting.js";

const safeT = (
  ctx: AppContext,
  key: string,
  vars?: Record<string, string | number>
): string => {
  const tFn = (ctx as any).t;
  if (typeof tFn === "function") {
    return tFn.call(ctx, key, vars);
  }
  return key;
};

const renderMultiline = (text: string): string => text.replace(/\\n/g, "\n");

const requireModeratorSession = async (ctx: AppContext) => {
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.answerCallbackQuery(
      safeT(ctx, "error-unknown", { error: "Session not initialized" }).substring(0, 200)
    );
    return null;
  }
  return session;
};

const showTicketsList = async (
  ctx: AppContext,
  status: TicketStatus
): Promise<void> => {
  const session = await requireModeratorSession(ctx);
  if (!session) {
    return;
  }
  if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
    await ctx.answerCallbackQuery(safeT(ctx, "error-access-denied").substring(0, 200));
    return;
  }
  if (!session.other.ticketsView) {
    session.other.ticketsView = {
      list: null,
      currentTicketId: null,
      pendingAction: null,
      pendingTicketId: null,
      pendingData: {},
    };
  }
  session.other.ticketsView.list = status === TicketStatus.NEW ? "new" : "in_progress";

  const ticketService = new TicketService(ctx.appDataSource);
  const tickets = await ticketService.getTicketsByStatus(status, 20);

  const emptyKey =
    status === TicketStatus.NEW ? "tickets-none-new" : "tickets-none-in-progress";
  const listKey =
    status === TicketStatus.NEW ? "tickets-list-new" : "tickets-list-in-progress";

  if (tickets.length === 0) {
    await ctx.editMessageText(safeT(ctx, emptyKey), {
      reply_markup: moderatorMenu,
      parse_mode: "HTML",
    });
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const ticket of tickets.slice(0, 10)) {
    keyboard.text(`#${ticket.id}`, `ticket_view_${ticket.id}`).row();
  }
  keyboard.text(safeT(ctx, "button-back"), "tickets-menu-back");

  await ctx.editMessageText(safeT(ctx, listKey, { count: tickets.length }), {
    reply_markup: keyboard,
    parse_mode: "HTML",
  });
};

/**
 * Moderator menu for managing tickets.
 */
export const moderatorMenu = new Menu<AppContext>("moderator-menu")
  .text(
    (ctx) => ctx.t("button-provisioning-tickets"),
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(renderMultiline(ctx.t("provisioning-menu-title", {
        open: 0,
        inProgress: 0,
        waiting: 0,
        done: 0,
        total: 0,
      })), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text(ctx.t("ticket-status-open"), "prov_list_open")
          .text(ctx.t("ticket-status-in_progress"), "prov_list_in_progress")
          .row()
          .text(ctx.t("ticket-status-waiting"), "prov_list_waiting")
          .text(ctx.t("ticket-status-done"), "prov_list_done")
          .row()
          .text(ctx.t("button-back"), "tickets-menu-back"),
      });
    }
  )
  .row()
  .back((ctx) => ctx.t("button-back"));

/**
 * Create ticket view menu.
 */
export const ticketViewMenu = new Menu<AppContext>("ticket-view-menu")
  .dynamic(async (ctx, range) => {
    const session = await requireModeratorSession(ctx);
    if (!session || (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin)) {
      return;
    }
    const ticketId = session.other.ticketsView.currentTicketId;
    if (!ticketId) return;
    const ticketService = new TicketService(ctx.appDataSource);
    const ticket = await ticketService.getTicketById(ticketId);
    if (!ticket || ticket.status === TicketStatus.DONE || ticket.status === TicketStatus.REJECTED) {
      return;
    }
    const isAssignedToMe = ticket.assignedModeratorId === session.main.user.id;
    const canTake =
      ticket.status === TicketStatus.NEW ||
      (ticket.status === TicketStatus.IN_PROGRESS && (ticket.assignedModeratorId === null || isAssignedToMe));

    if (isAssignedToMe) {
      range.text((ctx) => ctx.t("button-ticket-unassign"), async (ctx) => {
        const sess = await requireModeratorSession(ctx);
        if (!sess || (sess.main.user.role !== Role.Moderator && sess.main.user.role !== Role.Admin)) return;
        const tid = sess.other.ticketsView?.currentTicketId;
        if (!tid) return;
        try {
          await ticketService.unassignTicket(tid, sess.main.user.id, sess.main.user.role);
          await ctx.answerCallbackQuery(safeT(ctx, "ticket-unassigned"));
          await ctx.menu.update();
        } catch (e: any) {
          await ctx.answerCallbackQuery((e?.message || "Error").substring(0, 200));
        }
      });
    } else if (canTake) {
      range.text((ctx) => ctx.t("button-ticket-assign-self"), async (ctx) => {
        const sess = await requireModeratorSession(ctx);
        if (!sess || (sess.main.user.role !== Role.Moderator && sess.main.user.role !== Role.Admin)) return;
        const tid = sess.other.ticketsView?.currentTicketId;
        if (!tid) return;
        const t = await ticketService.getTicketById(tid);
        if (!t) return;
        const can = t.status === TicketStatus.NEW || (t.status === TicketStatus.IN_PROGRESS && (t.assignedModeratorId === null || t.assignedModeratorId === sess.main.user.id));
        if (!can) {
          await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-already-taken").substring(0, 200));
          return;
        }
        try {
          await ticketService.takeTicket(tid, sess.main.user.id, sess.main.user.id, sess.main.user.role);
          await ctx.answerCallbackQuery(safeT(ctx, "ticket-taken"));
          await ctx.menu.update();
        } catch (e: any) {
          await ctx.answerCallbackQuery((e?.message || safeT(ctx, "error-unknown", { error: "Unknown" })).substring(0, 200));
        }
      });
    }
  })
  .text((ctx) => ctx.t("button-ticket-ask-clarification"), async (ctx) => {
    const session = await requireModeratorSession(ctx);
    if (!session) {
      return;
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-access-denied").substring(0, 200));
      return;
    }

    const ticketId = session.other.ticketsView.currentTicketId;
    if (!ticketId) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-not-found").substring(0, 200));
      return;
    }

    session.other.ticketsView.pendingAction = "ask_user";
    session.other.ticketsView.pendingTicketId = ticketId;
    session.other.ticketsView.pendingData = {};
    await ctx.reply(safeT(ctx, "ticket-ask-user-enter-question"));
  })
  .row()
  .text((ctx) => ctx.t("button-ticket-complete"), async (ctx) => {
    const session = await requireModeratorSession(ctx);
    if (!session) {
      return;
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-access-denied").substring(0, 200));
      return;
    }

    const ticketId = session.other.ticketsView.currentTicketId;
    if (!ticketId) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-not-found").substring(0, 200));
      return;
    }

    const ticketService = new TicketService(ctx.appDataSource);
    const ticket = await ticketService.getTicketById(ticketId);

    if (!ticket) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-not-found").substring(0, 200));
      return;
    }

    session.other.ticketsView.pendingTicketId = ticketId;
    session.other.ticketsView.pendingData = {};
    if (ticket.type === TicketType.DEDICATED_ORDER) {
      session.other.ticketsView.pendingAction = "provide_dedicated_ip";
      await ctx.reply(safeT(ctx, "ticket-provide-ip"));
      return;
    }

    session.other.ticketsView.pendingAction = "provide_result";
    await ctx.reply(safeT(ctx, "ticket-provide-result-text"));
  })
  .text((ctx) => ctx.t("button-ticket-reject"), async (ctx) => {
    const session = await requireModeratorSession(ctx);
    if (!session) {
      return;
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-access-denied").substring(0, 200));
      return;
    }

    const ticketId = session.other.ticketsView.currentTicketId;
    if (!ticketId) {
      await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-not-found").substring(0, 200));
      return;
    }

    session.other.ticketsView.pendingAction = "reject";
    session.other.ticketsView.pendingTicketId = ticketId;
    session.other.ticketsView.pendingData = {};
    await ctx.reply(safeT(ctx, "ticket-reject-enter-reason-optional"));
  })
  .row()
  .dynamic(async (ctx, range) => {
    const session = await requireModeratorSession(ctx);
    if (!session) {
      return;
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      return;
    }

    const ticketId = session.other.ticketsView.currentTicketId;
    if (!ticketId) {
      return;
    }

    const ticketService = new TicketService(ctx.appDataSource);
    const ticket = await ticketService.getTicketById(ticketId);

    if (
      ticket &&
      ticket.type === TicketType.WITHDRAW_REQUEST &&
      ticket.status !== TicketStatus.DONE &&
      ticket.status !== TicketStatus.REJECTED
    ) {
      range.text((ctx) => ctx.t("button-ticket-approve-withdraw"), async (ctx) => {
        const session = await requireModeratorSession(ctx);
        if (!session) {
          return;
        }
        if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
          await ctx.answerCallbackQuery(safeT(ctx, "error-access-denied").substring(0, 200));
          return;
        }

        const ticketService = new TicketService(ctx.appDataSource);
        const ticket = await ticketService.getTicketById(ticketId);

        if (!ticket) {
          await ctx.answerCallbackQuery(safeT(ctx, "error-ticket-not-found").substring(0, 200));
          return;
        }

        if (ticket.type !== TicketType.WITHDRAW_REQUEST) {
          await ctx.answerCallbackQuery(safeT(ctx, "error-invalid-ticket-type").substring(0, 200));
          return;
        }

        try {
          await ticketService.approveWithdraw(ticketId, session.main.user.id, session.main.user.role);

          let payload: Record<string, any> = {};
          try {
            payload = ticket.payload ? JSON.parse(ticket.payload) : {};
          } catch (error) {
            // Ignore
          }

          const userRepo = ctx.appDataSource.getRepository(User);
          const user = await userRepo.findOne({ where: { id: ticket.userId } });
          if (user) {
            try {
              await ctx.api.sendMessage(
                user.telegramId,
                safeT(ctx, "withdraw-approved", {
                  ticketId,
                  amount: payload.amount || 0,
                }),
                { parse_mode: "HTML" }
              );
            } catch (error) {
              Logger.warn(`Failed to notify user ${user.telegramId} about withdraw approval:`, error);
            }
          }

          await ctx.answerCallbackQuery(safeT(ctx, "withdraw-approved-by-moderator"));
          try {
            await ctx.menu.update();
          } catch (error: any) {
            const description = error?.description || error?.message || "";
            if (!description.includes("message is not modified")) {
              throw error;
            }
          }
        } catch (error: any) {
          const errorMessage = error?.message || safeT(ctx, "error-unknown", { error: "Unknown error" });
          await ctx.answerCallbackQuery(errorMessage.substring(0, 200));
          Logger.error(`Failed to approve withdraw for ticket ${ticketId}:`, error);
        }
      });
      range.row();
    }
  })
  .row()
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    const session = await ctx.session;
    const listKey = session.other.ticketsView.list;
    const status =
      listKey === "in_progress" ? TicketStatus.IN_PROGRESS : TicketStatus.NEW;
    await showTicketsList(ctx, status);
  });

export const formatTicketPayload = (payload: Record<string, unknown>): string => {
  return Object.entries(payload)
    .map(([key, value]) => {
      const safeKey = escapeUserInput(String(key));
      const safeValue = escapeUserInput(String(value));
      return `<strong>${safeKey}:</strong> ${safeValue}`;
    })
    .join("\n");
};
