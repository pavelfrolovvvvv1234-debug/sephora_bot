/**
 * Bot middlewares for user management, locale, and context setup.
 *
 * @module app/middlewares
 */

import type { AppContext } from "../shared/types/context.js";
import { getAppDataSource } from "../infrastructure/db/datasource.js";
import { UserRepository } from "../infrastructure/db/repositories/UserRepository.js";
import User from "../entities/User.js";
import { getCachedOsList } from "../shared/vmmanager-os-cache.js";
import { getCachedUser, setCachedUser } from "../shared/user-cache.js";
import { Logger } from "./logger.js";

/**
 * Middleware to initialize database and user context.
 * Uses in-memory user cache to avoid DB hit on every update.
 */
export async function databaseMiddleware(ctx: AppContext, next: () => Promise<void>): Promise<void> {
  const session = await ctx.session;
  const dataSource = await getAppDataSource();
  const userRepo = new UserRepository(dataSource);

  ctx.appDataSource = dataSource;
  ctx.loadedUser = null;

  if (ctx.hasChatType("private") && ctx.chatId != null) {
    const tid = Number(ctx.chatId);
    let user = getCachedUser(tid);
    if (!user) {
      user = await userRepo.findOrCreateByTelegramId(ctx.chatId);
      setCachedUser(tid, user);
    }
    ctx.loadedUser = user;
    session.main.user.balance = user.balance;
    session.main.user.referralBalance = user.referralBalance ?? 0;
    session.main.user.id = user.id;
    session.main.user.role = user.role;
    session.main.user.status = user.status;
    session.main.user.isBanned = user.isBanned;
  }

  return next();
}

/**
 * Middleware to initialize locale from user settings.
 * Всегда читаем user.lang из БД, чтобы после смены языка не использовать старый кэш.
 */
export async function localeMiddleware(ctx: AppContext, next: () => Promise<void>): Promise<void> {
  const session = await ctx.session;

  if (session.main.user.id <= 0) {
    return next();
  }

  const ds = await getAppDataSource();
  const user = await ds.getRepository(User).findOneBy({ id: session.main.user.id }).catch(() => null);
  if (user?.lang === "en") {
    session.main.locale = "en";
  } else {
    // user.lang === "ru" | null — всегда русский по умолчанию
    session.main.locale = "ru";
    if (user && !user.lang) {
      try {
        const ds = await getAppDataSource();
        await ds.getRepository(User).update(user.id, { lang: "ru" });
        user.lang = "ru";
        if (ctx.loadedUser?.id === user.id) ctx.loadedUser.lang = "ru";
      } catch {
        /* ignore */
      }
    }
  }

  return next();
}

/**
 * Middleware to check if user is banned.
 */
export async function banCheckMiddleware(ctx: AppContext, next: () => Promise<void>): Promise<void> {
  const session = await ctx.session;

  if (session.main.user.isBanned) {
    await ctx.reply(ctx.t("message-about-block"), {
      parse_mode: "HTML",
    });
    // Delete the message that triggered this (if exists)
    if (ctx.message) {
      try {
        await ctx.deleteMessage();
      } catch (error) {
        // Ignore if message already deleted
      }
    }
    return;
  }

  return next();
}

/**
 * Middleware to setup VMManager and OS list in context.
 * OS list is read from in-memory cache (refreshed in background) so the request path never blocks on VMManager.
 */
export function vmmanagerMiddleware(vmManager: import("../infrastructure/vmmanager/provider.js").VmProvider) {
  return (ctx: AppContext, next: () => Promise<void>): Promise<void> => {
    ctx.vmmanager = vmManager;
    ctx.osList = getCachedOsList();
    return next();
  };
}

/**
 * Middleware to setup available languages in context.
 */
export function languagesMiddleware(availableLocales: string[]) {
  return async (ctx: AppContext, next: () => Promise<void>): Promise<void> => {
    ctx.availableLanguages = availableLocales;
    return next();
  };
}
