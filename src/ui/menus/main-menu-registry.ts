/**
 * Single {@link Menu} instance for the welcome / home grid (Dev+Traff, crypto, etc.).
 * Must match {@code bot.use(mainMenu)} — never attach another Menu with id "main-menu".
 */

import type { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";

let welcomeMainMenu: Menu<AppContext> | null = null;

export function registerWelcomeMainMenu(menu: Menu<AppContext>): void {
  welcomeMainMenu = menu;
}

export function getWelcomeMainMenu(): Menu<AppContext> {
  if (!welcomeMainMenu) {
    throw new Error(
      "[main-menu-registry] Welcome main menu not registered — call registerWelcomeMainMenu from bot bootstrap"
    );
  }
  return welcomeMainMenu;
}

/** Prefer registered welcome menu; otherwise short legacy menu (e.g. before bootstrap). */
export async function getReplyMainMenu(): Promise<Menu<AppContext>> {
  if (welcomeMainMenu) return welcomeMainMenu;
  const { mainMenu } = await import("./main-menu.js");
  return mainMenu;
}
