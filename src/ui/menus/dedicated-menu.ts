/**
 * Dedicated server menu for users.
 *
 * @module ui/menus/dedicated-menu
 */

import { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";
import { DedicatedService } from "../../domain/dedicated/DedicatedService.js";
import { TicketType } from "../../entities/Ticket.js";
import DedicatedServer, { DedicatedServerStatus } from "../../entities/DedicatedServer.js";
import { Logger } from "../../app/logger.js";
import { buildServiceInfoBlock } from "../../shared/service-panel.js";

/**
 * Dedicated server menu.
 */
export const dedicatedMenu = new Menu<AppContext>("dedicated-menu")
  .dynamic(async (ctx, range) => {
    try {
      const session = await ctx.session;
      const expandedId = session.other.manageDedicated.expandedId;

      if (expandedId) {
        const repo = ctx.appDataSource.getRepository(DedicatedServer);
        const expanded = await repo.findOne({ where: { id: expandedId } });
        if (expanded && expanded.userId === session.main.user.id && expanded.credentials) {
          let credentials: Record<string, string> = {};
          try {
            credentials = JSON.parse(expanded.credentials);
          } catch {
            credentials = {};
          }

          range.copyText(ctx.t("button-copy-ip"), credentials.ip || "");
          range.copyText(ctx.t("button-copy-login"), credentials.login || "");
          range.copyText(ctx.t("button-copy-password"), credentials.password || "");
          range.row();

          range.text(
            session.other.manageDedicated.showPassword
              ? ctx.t("button-hide-password")
              : ctx.t("button-show-password"),
            async (ctx) => {
              const session = await ctx.session;
              session.other.manageDedicated.showPassword = !session.other.manageDedicated.showPassword;
              await updateDedicatedManageView(ctx);
            }
          );
          range.row();

          range.text(ctx.t("button-reinstall-os"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_REINSTALL);
          });

          range.text(ctx.t("button-reboot"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_REBOOT);
          });
          range.row();

          range.text(ctx.t("button-reset-password"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_RESET);
          });

          range.text(ctx.t("button-other-request"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_OTHER);
          });
          range.row();

          range.text(ctx.t("button-dedicated-start"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_POWER_ON);
          });
          range.text(ctx.t("button-dedicated-stop"), async (ctx) => {
            const { createDedicatedOperationTicket } = await import("../conversations/dedicated-conversations.js");
            await createDedicatedOperationTicket(ctx, expanded.id, TicketType.DEDICATED_POWER_OFF);
          });
          range.row();
        }
        return;
      }

      const dedicatedService = new DedicatedService(ctx.appDataSource);
      const dedicatedList = await dedicatedService.getDedicatedByUserId(session.main.user.id);

      if (dedicatedList.length === 0) {
        range.text(ctx.t("list-empty"), async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
        });
        return;
      }

      for (const dedicated of dedicatedList) {
        let label = dedicated.label || `Dedicated #${dedicated.id}`;
        if (dedicated.credentials) {
          try {
            const credentials = JSON.parse(dedicated.credentials) as Record<string, string>;
            if (credentials.ip) {
              label = `${label} • ${credentials.ip}`;
            }
          } catch {
            // Ignore invalid JSON
          }
        }

        range.text(label, async (ctx) => {
          try {
            const session = await ctx.session;
            const current = session.other.manageDedicated.expandedId;
            if (current === dedicated.id) {
              session.other.manageDedicated.expandedId = null;
              session.other.manageDedicated.showPassword = false;
            } else {
              session.other.manageDedicated.expandedId = dedicated.id;
              session.other.manageDedicated.showPassword = false;
            }
            await updateDedicatedManageView(ctx);
          } catch (error: any) {
            Logger.error("Failed to render dedicated details:", error);
            await ctx.editMessageText(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
          }
        }).row();
      }
    } catch (error: any) {
      Logger.error("Failed to load dedicated list:", error);
      range.text(ctx.t("bad-error"));
    }
  })
  .row()
  .back(
    (ctx) => ctx.t("button-back"),
    async (ctx) => {
      const session = await ctx.session;
      if (session.other.manageDedicated.expandedId) {
        session.other.manageDedicated.expandedId = null;
        session.other.manageDedicated.showPassword = false;
        await updateDedicatedManageView(ctx);
        return;
      }
      await ctx.editMessageText(ctx.t("manage-services-header"), {
        parse_mode: "HTML",
      });
    }
  );

const getDedicatedStatusLabel = (
  ctx: AppContext,
  status: DedicatedServerStatus
): string => {
  if (status === DedicatedServerStatus.ACTIVE) {
    return `🟢 ${ctx.t("status-active")}`;
  }
  if (status === DedicatedServerStatus.SUSPENDED) {
    return `⛔ ${ctx.t("status-suspended")}`;
  }
  return `🟡 ${ctx.t("status-pending")}`;
};

const updateDedicatedManageView = async (ctx: AppContext): Promise<void> => {
  const session = await ctx.session;
  const expandedId = session.other.manageDedicated.expandedId;

  if (!expandedId) {
    await ctx.editMessageText(ctx.t("dedicated-menu-header"), {
      reply_markup: dedicatedMenu,
      parse_mode: "HTML",
    });
    return;
  }

  const repo = ctx.appDataSource.getRepository(DedicatedServer);
  const dedicated = await repo.findOne({ where: { id: expandedId } });
  if (!dedicated) {
    session.other.manageDedicated.expandedId = null;
    await ctx.editMessageText(ctx.t("dedicated-menu-header"), {
      reply_markup: dedicatedMenu,
      parse_mode: "HTML",
    });
    return;
  }

  let credentials: Record<string, string> = {};
  if (dedicated.credentials) {
    try {
      credentials = JSON.parse(dedicated.credentials);
    } catch {
      credentials = {};
    }
  }

  const infoBlock = buildServiceInfoBlock(ctx, {
    ip: credentials.ip,
    login: credentials.login,
    password: credentials.password,
    showPassword: session.other.manageDedicated.showPassword,
    os: credentials.os || ctx.t("not-specified"),
    statusLabel: getDedicatedStatusLabel(ctx, dedicated.status),
    createdAt: dedicated.createdAt,
    paidUntil: dedicated.paidUntil,
  });

  await ctx.editMessageText(
    `${ctx.t("dedicated-menu-header")}\n\n${infoBlock}`,
    {
      reply_markup: dedicatedMenu,
      parse_mode: "HTML",
    }
  );
};
