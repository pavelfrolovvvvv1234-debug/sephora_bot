/**
 * Legacy menus exported from old structure.
 * This is a temporary file to avoid circular dependencies during migration.
 * These menus will be gradually migrated to the new structure.
 *
 * @module ui/menus/legacy-menus
 */

import { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";

/**
 * Re-export old menus to avoid circular dependencies.
 * These are imported dynamically from helpers to maintain functionality.
 */
export async function getLegacyMenus() {
  const servicesMenu = await import("../../helpers/services-menu.js");
  const depositMoney = await import("../../helpers/deposit-money.js");
  const manageServices = await import("../../helpers/manage-services.js");
  const usersControl = await import("../../helpers/users-control");
  const promocodeInput = await import("../../helpers/promocode-input.js");
  const domainReg = await import("../../helpers/domain-registraton.js");
  const promotePerms = await import("../../helpers/promote-permissions.js");

  return {
    servicesMenu,
    depositMoney,
    manageServices,
    usersControl,
    promocodeInput,
    domainReg,
    promotePerms,
  };
}

/**
 * Create main menu directly to avoid circular dependency.
 * This is a temporary solution until full migration is complete.
 */
export function createMainMenu(): Menu<AppContext> {
  return new Menu<AppContext>("main-menu")
    .text((ctx) => ctx.t("button-purchase"), async (ctx) => {
      const { openVpsTariffSelection } = await import("../../domain/vds/vds-shop-flow.js");
      await openVpsTariffSelection(ctx);
    })
    .row()
    .submenu(
      (ctx) => ctx.t("button-personal-profile"),
      "profile-menu",
      async (ctx) => {
        const session = await ctx.session;
        if (ctx.hasChatType("private")) {
          const { profileMenu, getProfileText } = await import("./profile-menu.js");
          const profileText = await getProfileText(ctx);
          await ctx.editMessageText(profileText, {
            reply_markup: profileMenu,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      }
    )
    .text((ctx) => ctx.t("button-manage-services"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const { openVdsManageServicesListScreen } = await import("../../helpers/manage-services.js");
      await openVdsManageServicesListScreen(ctx);
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
    .submenu(
      (ctx) => ctx.t("button-about-us"),
      "about-us-menu",
      async (ctx) => {
        await ctx.editMessageText(ctx.t("about-us"), {
          parse_mode: "HTML",
        });
      }
    );
}
