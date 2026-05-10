/**
 * Admin promo codes menu.
 *
 * @module ui/menus/admin-promocodes-menu
 */

import { Menu } from "@grammyjs/menu";
import { InlineKeyboard, type Bot } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import Promo from "../../entities/Promo.js";
import { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";

const PAGE_SIZE = 8;

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

const formatAmount = (amount: number): string =>
  Number.isFinite(amount) ? amount.toFixed(2) : String(amount);

const renderTable = (promos: Promo[], emptyText: string): string => {
  if (promos.length === 0) {
    return `<pre>${emptyText}</pre>`;
  }

  const header = "CODE         | AMOUNT | USED/MAX | LEFT | STATUS";
  const rows = promos.map((promo) => {
    const code = promo.code.padEnd(12).slice(0, 12);
    const amount = formatAmount(promo.sum).padStart(6);
    const used = `${promo.uses}/${promo.maxUses}`.padStart(7);
    const left = String(Math.max(0, promo.maxUses - promo.uses)).padStart(4);
    const status = promo.isActive !== false ? "ON " : "OFF";
    return `${code} | ${amount} | ${used} | ${left} | ${status}`;
  });

  return `<pre>${[header, ...rows].join("\n")}</pre>`;
};

export const buildAdminPromosText = async (ctx: AppContext): Promise<string> => {
  const promoRepo = ctx.appDataSource.getRepository(Promo);
  const session = await ctx.session;
  if (!session.other.promoAdmin) {
    session.other.promoAdmin = { page: 0, editingPromoId: null };
  }
  const page = session.other.promoAdmin.page;
  const [promos, total] = await promoRepo.findAndCount({
    order: { createdAt: "DESC" },
    take: PAGE_SIZE,
    skip: page * PAGE_SIZE,
  });
  const table = renderTable(promos, safeT(ctx, "admin-promos-empty"));
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return [
    `<strong>${safeT(ctx, "admin-promos-header")}</strong>`,
    "",
    table,
    "",
    safeT(ctx, "admin-promos-footer", { page: page + 1, total: totalPages }),
  ].join("\n");
};

export const adminPromosMenu = new Menu<AppContext>("admin-promos-menu").dynamic(
  async (ctx, range) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      range.text(safeT(ctx, "button-back"), async (ctx) => {
        await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
          reply_markup: (await import("./admin-menu.js")).adminMenu,
          parse_mode: "HTML",
        });
      });
      return;
    }
    if (!session.other.promoAdmin) {
      session.other.promoAdmin = { page: 0, editingPromoId: null };
    }
    if (session.main.user.role !== Role.Admin) {
      range.text(safeT(ctx, "button-back"), async (ctx) => {
        await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
          reply_markup: (await import("./admin-menu.js")).adminMenu,
          parse_mode: "HTML",
        });
      });
      return;
    }

    range.text(safeT(ctx, "button-promos-create"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      session.other.promoAdmin.createStep = "code";
      session.other.promoAdmin.createDraft = {};
      await ctx.reply(safeT(ctx, "admin-promos-enter-code"));
    });
    range.row();

    const promoRepo = ctx.appDataSource.getRepository(Promo);
    const [promos, total] = await promoRepo.findAndCount({
      order: { createdAt: "DESC" },
      take: PAGE_SIZE,
      skip: session.other.promoAdmin.page * PAGE_SIZE,
    });

    promos.forEach((promo) => {
      const statusLabel = promo.isActive ? "⛔" : "✅";
      range
        .text(`✏️ ${promo.code}`, async (ctx) => {
          session.other.promoAdmin.editingPromoId = promo.id;
          session.other.promoAdmin.editStep = "code";
          await ctx.reply(safeT(ctx, "admin-promos-edit-code", { code: promo.code }));
        })
        .text(statusLabel, async (ctx) => {
          try {
            promo.isActive = !promo.isActive;
            await promoRepo.save(promo);
            await refreshPromos(ctx);
          } catch (error: any) {
            Logger.warn("Failed to toggle promo status:", error);
            await ctx.reply(
              safeT(ctx, "error-unknown", { error: error.message || "Unknown error" })
            );
          }
        })
        .text("🗑", async (ctx) => {
          try {
            const keyboard = new InlineKeyboard()
              .text(safeT(ctx, "button-delete"), `promo_delete_confirm_${promo.id}`)
              .text(safeT(ctx, "button-cancel"), "promo_delete_cancel");
            await ctx.editMessageText(
              safeT(ctx, "admin-promos-delete-confirm", { code: promo.code }),
              {
                reply_markup: keyboard,
                parse_mode: "HTML",
              }
            );
          } catch (error: any) {
            Logger.warn("Failed to open delete confirmation:", error);
            await ctx.reply(
              safeT(ctx, "error-unknown", { error: error.message || "Unknown error" })
            );
          }
        })
        .row();
    });

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (totalPages > 1) {
      range.text("⬅️", async (ctx) => {
        session.other.promoAdmin.page =
          session.other.promoAdmin.page - 1 < 0
            ? totalPages - 1
            : session.other.promoAdmin.page - 1;
        await refreshPromos(ctx);
      });
      range.text(`${session.other.promoAdmin.page + 1}/${totalPages}`);
      range.text("➡️", async (ctx) => {
        session.other.promoAdmin.page =
          session.other.promoAdmin.page + 1 >= totalPages
            ? 0
            : session.other.promoAdmin.page + 1;
        await refreshPromos(ctx);
      });
      range.row();
    }

    range.text(safeT(ctx, "button-back"), async (ctx) => {
      await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
        reply_markup: (await import("./admin-menu.js")).adminMenu,
        parse_mode: "HTML",
      });
    });
  }
);

export const refreshPromos = async (ctx: AppContext): Promise<void> => {
  try {
    const text = await buildAdminPromosText(ctx);
    await ctx.editMessageText(text, {
      reply_markup: adminPromosMenu,
      parse_mode: "HTML",
    });
  } catch (error) {
    Logger.warn("Failed to refresh promo menu:", error);
  }
};

export const registerAdminPromosHandlers = (bot: Bot<AppContext>): void => {
  bot.callbackQuery(/^promo_delete_confirm_(\d+)$/, async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery({ text: safeT(ctx, "error-unknown", { error: "Session not initialized" }).substring(0, 200), show_alert: true }).catch(() => {});
      return;
    }
    if (session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery({ text: safeT(ctx, "error-access-denied").substring(0, 200), show_alert: true }).catch(() => {});
      return;
    }

    const promoId = Number(ctx.match[1]);
    const promoRepo = ctx.appDataSource.getRepository(Promo);
    const promo = await promoRepo.findOne({ where: { id: promoId } });
    if (!promo) {
      await ctx.answerCallbackQuery({ text: safeT(ctx, "admin-promos-not-found").substring(0, 200), show_alert: true }).catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await promoRepo.remove(promo);
    await refreshPromos(ctx);
  });

  bot.callbackQuery("promo_delete_cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await refreshPromos(ctx);
  });
};
