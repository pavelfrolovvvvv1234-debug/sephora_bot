/**
 * Amper Domains menu for users.
 *
 * @module ui/menus/amper-domains-menu
 */

import { Menu } from "@grammyjs/menu";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { Logger } from "../../app/logger.js";
import { createInitialOtherSession } from "../../shared/session-initial.js";
import { setPendingDomainNsUpdate } from "../conversations/domain-update-ns-conversation.js";

const PRIME_MONTHLY_PRICE = "9.99";

/** Ссылка на канал Prime по умолчанию (SephoraHost). */
const DEFAULT_PRIME_CHANNEL_INVITE = "https://t.me/sephora_news";

/**
 * Build Prime subscription block text (title, intro, benefits, status).
 * Exported for use in Prime callback handlers (e.g. after activating trial).
 */
export function buildPrimeBlockText(
  ctx: AppContext,
  primeActiveUntil: Date | null,
  monthlyPrice: string = PRIME_MONTHLY_PRICE,
  locale?: string
): string {
  const lines = [
    ctx.t("prime-subscription-title"),
    "",
    ctx.t("prime-subscription-body"),
    "",
    ctx.t("prime-subscription-benefits-block"),
    "",
  ];

  const now = new Date();
  const isActive = primeActiveUntil && new Date(primeActiveUntil) > now;
  if (isActive && primeActiveUntil) {
    const loc = locale ?? "ru";
    const dateStr = new Date(primeActiveUntil).toLocaleDateString(loc === "en" ? "en-US" : "ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    lines.push(ctx.t("prime-subscription-status-active"));
    lines.push(ctx.t("prime-subscription-status-until", { date: dateStr }));
  } else {
    lines.push(ctx.t("prime-subscription-trial-line"));
    lines.push(ctx.t("prime-trial-activate", { monthlyPrice }));
  }

  // Fluent may leave literal "\n" in strings from .ftl; Telegram needs real newlines.
  return lines.join("\n").replace(/\\n/g, "\n");
}

export type DomainsPrimeScreenOptions = {
  /** Back button callback (unused: Back always goes to main menu for reliability). */
  backCallback?: string;
};

/**
 * Build Prime subscription screen (message + keyboard).
 * Back button always uses "prime-back-to-main" so it reliably returns to main menu.
 */
export async function getDomainsListWithPrimeScreen(
  ctx: AppContext,
  options?: DomainsPrimeScreenOptions
): Promise<{ fullText: string; keyboard: InlineKeyboard }> {
  const session = await ctx.session;
  const userRepo = new UserRepository(ctx.appDataSource);
  const user = await userRepo.findById(session.main.user.id);
  const primeActiveUntil = user?.primeActiveUntil ?? null;
  const fullText = buildPrimeBlockText(ctx, primeActiveUntil, undefined, session?.main?.locale);

  const keyboard = new InlineKeyboard();
  const hasActivePrime = primeActiveUntil && new Date(primeActiveUntil) > new Date();
  if (!hasActivePrime) {
    keyboard
      .text(ctx.t("prime-button-activate-trial"), "prime_activate_trial")
      .row();
  }
  const backCb = options?.backCallback?.trim() || "prime-back-to-main";
  keyboard.text(ctx.t("button-back"), backCb).row();

  return { fullText, keyboard };
}

/**
 * Amper Domains menu.
 */
export const amperDomainsMenu = new Menu<AppContext>("amper-domains-menu")
  .text(
    (ctx) => ctx.t("button-register-domain"),
    async (ctx) => {
      try {
        await ctx.conversation.enter("domainRegisterConversation");
      } catch (error: any) {
        Logger.error("Failed to start domain register conversation:", error);
        await ctx.editMessageText(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
      }
    }
  )
  .text(
    (ctx) => ctx.t("button-my-domains"),
    async (ctx) => {
      try {
        const { fullText, keyboard } = await getDomainsListWithPrimeScreen(ctx);
        await ctx.editMessageText(fullText, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        });
      } catch (error: any) {
        Logger.error("Failed to get domains:", error);
        await ctx.editMessageText(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
      }
    }
  )
  .row()
  .back((ctx) => ctx.t("button-back"));

/**
 * Create domain view menu.
 */
export function createDomainViewMenu(domainId: number): Menu<AppContext> {
  return new Menu<AppContext>(`domain-view-${domainId}`)
    .text(
      (ctx) => ctx.t("button-domain-update-ns"),
      async (ctx) => {
        try {
          await ctx.answerCallbackQuery().catch(() => {});
          const session = (await ctx.session) as any;
          if (session && !session.other) {
            (session as any).other = createInitialOtherSession();
          }
          if (session?.other) {
            session.other.currentDomainId = domainId;
          }
          const telegramId = Number(ctx.from?.id ?? ctx.chatId ?? 0);
          if (telegramId > 0) {
            setPendingDomainNsUpdate(telegramId, domainId);
          }
          await ctx.conversation.enter("domainUpdateNsConversation");
        } catch (error: any) {
          Logger.error(`Failed to start update NS conversation for domain ${domainId}:`, error);
          const errText =
            typeof (ctx as any).t === "function"
              ? ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200)
              : "Error. Try again.";
          await ctx.answerCallbackQuery(errText).catch(() => {});
        }
      }
    )
    .row()
    .back((ctx) => ctx.t("button-back"), async (ctx) => {
      ctx.menu.nav("amper-domains-menu");
    });
}
