/**
 * Profile menu for user settings.
 *
 * @module ui/menus/profile-menu
 */

import { InlineKeyboard } from "grammy";
import { Menu } from "@grammyjs/menu";
import { MoreThan } from "typeorm";
import { topupMethodMenu } from "../../helpers/deposit-money.js";
import type { AppContext } from "../../shared/types/context.js";
import { ScreenRenderer } from "../screens/renderer.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { PROFILE_LINKS_RU } from "../../shared/ru-texts.js";
import { invalidateUser } from "../../shared/user-cache.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DedicatedServer, { DedicatedServerStatus } from "../../entities/DedicatedServer.js";
import Domain, { DomainStatus } from "../../entities/Domain.js";

const PROFILE_LINKS_EN =
  '<a href="https://t.me/sephora_sup">Support</a> | <a href="https://t.me/sephora_news">Sephora News</a>';

function escapeProfileHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function countActiveServicesForUser(
  ctx: AppContext,
  internalUserId: number
): Promise<number> {
  const now = new Date();
  const ds = ctx.appDataSource.manager;
  const [activeVds, activeDedicated, activeDomain] = await Promise.all([
    ds.count(VirtualDedicatedServer, {
      where: { targetUserId: internalUserId, expireAt: MoreThan(now) },
    }),
    ds.count(DedicatedServer, {
      where: { userId: internalUserId, status: DedicatedServerStatus.ACTIVE },
    }),
    ds.count(Domain, {
      where: { userId: internalUserId, status: DomainStatus.REGISTERED },
    }),
  ]);
  return activeVds + activeDedicated + activeDomain;
}

/**
 * Build profile screen text (balance, active services, footer links).
 * @param options.locale — для смены языка в меню без перезагрузки пользователя из БД.
 */
export async function getProfileText(
  ctx: AppContext,
  options?: { locale?: string }
): Promise<string> {
  const session = await ctx.session;
  const userRepo = new UserRepository(ctx.appDataSource);
  const user = await userRepo.findById(session.main.user.id);

  const locale = options?.locale ?? (user?.lang === "en" ? "en" : "ru");
  ctx.fluent.useLocale(locale);

  const telegramId = user?.telegramId ?? ctx.from?.id ?? session.main.user.id;
  const idSafe = String(telegramId).split("").join("&#8203;");

  let usernameLine: string;
  if (ctx.from?.username) {
    usernameLine = `@${escapeProfileHtml(ctx.from.username)}`;
  } else if (ctx.from?.first_name) {
    usernameLine = escapeProfileHtml(ctx.from.first_name);
  } else {
    usernameLine = ctx.t("profile-username-unknown");
  }

  const balanceAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(session.main.user.balance);

  const activeServices =
    user != null ? await countActiveServicesForUser(ctx, user.id) : 0;

  const links = locale === "ru" ? PROFILE_LINKS_RU : PROFILE_LINKS_EN;

  return `${ctx.t("profile-screen-header")}

${ctx.t("profile-screen-user", { username: usernameLine })}
${ctx.t("profile-screen-id", { id: idSafe })}
${ctx.t("profile-screen-balance", { amount: balanceAmount })}
${ctx.t("profile-screen-active-services", { count: activeServices })}

${links}`;
}

/**
 * Profile menu. onMenuOutdated: false — при смене языка кнопки меняются, не показывать "Menu was outdated".
 */
export const profileMenu = new Menu<AppContext>("profile-menu", { onMenuOutdated: false })
  .text((ctx) => ctx.t("button-deposit"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.other.deposit.prefilledAmount = false;
    session.other.deposit.selectedAmount = 50;
    session.main.lastSumDepositsEntered = 0;
    await ctx.editMessageText(ctx.t("topup-select-method"), {
      reply_markup: topupMethodMenu,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  })
  .row()
  .text(
    (ctx) => ctx.t("button-promocode"),
    async (ctx) => {
      const session = await ctx.session;
      session.other.promocode.awaitingInput = true;

      await ctx.reply(ctx.t("promocode-input-question"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(
          ctx.t("button-cancel"),
          "promocode-cancel"
        ),
      });
    }
  )
  .row()
  .text((ctx) => ctx.t("button-change-locale"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const nextLocale = session.main.locale === "ru" ? "en" : "ru";
    session.main.locale = nextLocale;
    (ctx as any)._requestLocale = nextLocale;

    try {
      const { UserRepository } = await import(
        "../../infrastructure/db/repositories/UserRepository.js"
      );
      const userRepo = new UserRepository(ctx.appDataSource);
      await userRepo.updateLanguage(session.main.user.id, nextLocale as "ru" | "en");
      if (ctx.chatId) invalidateUser(Number(ctx.chatId));
    } catch {
      // Ignore if user not found
    }

    ctx.fluent.useLocale(nextLocale);

    const profileText = await getProfileText(ctx, { locale: nextLocale });
    try {
      await ctx.editMessageText(profileText, {
        reply_markup: profileMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err: unknown) {
      const msg = (err as any)?.message ?? (err as any)?.description ?? "";
      if (String(msg).includes("message is not modified")) return;
      await ctx.reply(profileText, {
        reply_markup: profileMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => {});
    }
  })
  .row()
  .submenu(
    (ctx) => ctx.t("button-support"),
    "support-menu",
    async (ctx) => {
      await ctx.editMessageText(ctx.t("support"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  )
  .row()
  .back(
    (ctx) => ctx.t("button-profile-back"),
    async (ctx) => {
      const session = await ctx.session;
      const renderer = ScreenRenderer.fromContext(ctx);
      const screen = renderer.renderWelcome({
        balance: session.main.user.balance,
      });

      const { getReplyMainMenu } = await import("./main-menu-registry.js");
      await ctx.editMessageText(screen.text, {
        reply_markup: screen.keyboard || (await getReplyMainMenu()),
        parse_mode: screen.parse_mode,
      });
    }
  );
