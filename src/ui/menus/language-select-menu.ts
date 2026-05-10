/**
 * Language selection menu for first-time users.
 *
 * @module ui/menus/language-select-menu
 */

import { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { invalidateUser } from "../../shared/user-cache.js";

/**
 * Language selection menu shown to new users.
 */
export const languageSelectMenu = new Menu<AppContext>("language-select-menu", {
  autoAnswer: false,
})
  .text(
    (ctx) => ctx.t("button-change-locale-ru"),
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      session.main.locale = "ru";
      (ctx as any)._requestLocale = "ru";

      const userRepo = new UserRepository(ctx.appDataSource);
      try {
        await userRepo.updateLanguage(session.main.user.id, "ru");
        if (ctx.chatId) invalidateUser(Number(ctx.chatId));
      } catch (error) {
        // Ignore if user not found
      }

      ctx.fluent.useLocale("ru");
      const welcomeText = ctx.t("welcome", { balance: session.main.user.balance });
      const { getReplyMainMenu } = await import("./main-menu-registry.js");
      await ctx.editMessageText(welcomeText, {
        reply_markup: await getReplyMainMenu(),
        parse_mode: "HTML",
      });
    }
  )
  .row()
  .text(
    (ctx) => ctx.t("button-change-locale-en"),
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      session.main.locale = "en";
      (ctx as any)._requestLocale = "en";

      const userRepo = new UserRepository(ctx.appDataSource);
      try {
        await userRepo.updateLanguage(session.main.user.id, "en");
        if (ctx.chatId) invalidateUser(Number(ctx.chatId));
      } catch (error) {
        // Ignore if user not found
      }

      ctx.fluent.useLocale("en");
      const welcomeText = ctx.t("welcome", { balance: session.main.user.balance });
      const { getReplyMainMenu } = await import("./main-menu-registry.js");
      await ctx.editMessageText(welcomeText, {
        reply_markup: await getReplyMainMenu(),
        parse_mode: "HTML",
      });
    }
  );
