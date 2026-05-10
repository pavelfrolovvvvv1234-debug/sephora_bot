/**
 * Session user helpers.
 *
 * @module shared/utils/session-user
 */

import type { AppContext } from "../types/context.js";
import type { MainSessionData } from "../types/session.js";
import User, { Role, UserStatus } from "../../entities/User.js";

const emptyUser: MainSessionData["user"] = {
  id: 0,
  balance: 0,
  referralBalance: 0,
  role: Role.User,
  status: UserStatus.User,
  isBanned: false,
};

/**
 * Ensure session.main.user is populated from the database if possible.
 *
 * @param ctx - App context
 * @returns True when session user is available
 */
export const ensureSessionUser = async (ctx: AppContext): Promise<boolean> => {
  const session = await ctx.session;
  if (!session || !session.main) {
    return false;
  }

  if (session.main.user?.id && session.main.user.id > 0) {
    return true;
  }

  const telegramId = ctx.from?.id ?? ctx.chatId;
  if (!telegramId || !ctx.appDataSource) {
    return false;
  }

  const userRepo = ctx.appDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { telegramId } });
  if (!user) {
    session.main.user = {
      id: 0,
      balance: 0,
      referralBalance: 0,
      role: Role.User,
      status: UserStatus.User,
      isBanned: false,
    };
    return false;
  }

  session.main.user = {
    id: user.id,
    balance: user.balance,
    referralBalance: user.referralBalance ?? 0,
    role: user.role,
    status: user.status,
    isBanned: user.isBanned,
  };

  if (!session.main.locale || session.main.locale === "0") {
    session.main.locale = user.lang === "en" ? "en" : "ru";
  }

  return true;
};
