/**
 * Admin promo codes conversations.
 *
 * @module ui/conversations/admin-promocodes-conversations
 */

import type { Bot } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { AppConversation, AppContext } from "../../shared/types/context.js";
import Promo from "../../entities/Promo.js";
import { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { adminPromosMenu, buildAdminPromosText } from "../menus/admin-promocodes-menu.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";

const normalizeCode = (value: string): string => value.trim().toLowerCase();

const parseNumber = (value: string): number =>
  Number.parseFloat(value.replace(",", "."));

const isValidCode = (value: string): boolean =>
  /^[a-z0-9_-]{3,32}$/i.test(value);

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

const sendPromosView = async (ctx: AppContext): Promise<void> => {
  const text = await buildAdminPromosText(ctx);
  await ctx.reply(text, {
    reply_markup: adminPromosMenu,
    parse_mode: "HTML",
  });
};

const registeredPromoConversations = new WeakSet<Bot<AppContext>>();

export const registerPromoConversations = (bot: Bot<AppContext>): void => {
  if (registeredPromoConversations.has(bot)) {
    return;
  }
  registeredPromoConversations.add(bot);
  bot.use(createConversation(promoCreateConversation as any, "promoCreateConversation"));
  bot.use(createConversation(promoEditConversation as any, "promoEditConversation"));
};

export async function promoCreateConversation(
  conversation: AppConversation,
  ctx: AppContext
): Promise<void> {
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  if (session.main.user.role !== Role.Admin) {
    await ctx.reply(safeT(ctx, "error-access-denied"));
    return;
  }

  await ctx.reply(safeT(ctx, "admin-promos-enter-code"));
  const codeCtx = await conversation.waitFor("message:text");
  const code = normalizeCode(codeCtx.message.text);
  if (!isValidCode(code)) {
    await ctx.reply(safeT(ctx, "admin-promos-invalid-code"));
    await sendPromosView(ctx);
    return;
  }

  const promoRepo = ctx.appDataSource.getRepository(Promo);
  const existing = await promoRepo.findOne({ where: { code } });
  if (existing) {
    await ctx.reply(safeT(ctx, "promocode-already-exist"));
    await sendPromosView(ctx);
    return;
  }

  await ctx.reply(safeT(ctx, "admin-promos-enter-amount"));
  const amountCtx = await conversation.waitFor("message:text");
  const amount = parseNumber(amountCtx.message.text.trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply(safeT(ctx, "admin-promos-invalid-amount"));
    await sendPromosView(ctx);
    return;
  }

  await ctx.reply(safeT(ctx, "admin-promos-enter-max-uses"));
  const maxCtx = await conversation.waitFor("message:text");
  const maxUses = Number.parseInt(maxCtx.message.text.trim(), 10);
  if (!Number.isFinite(maxUses) || maxUses <= 0) {
    await ctx.reply(safeT(ctx, "admin-promos-invalid-max-uses"));
    await sendPromosView(ctx);
    return;
  }

  const promo = new Promo();
  promo.code = code;
  promo.sum = amount;
  promo.maxUses = maxUses;
  promo.uses = 0;
  promo.users = [];
  promo.isActive = true;

  await promoRepo.save(promo);
  await ctx.reply(safeT(ctx, "admin-promos-created", { code }));
  await sendPromosView(ctx);
}

export async function promoEditConversation(
  conversation: AppConversation,
  ctx: AppContext
): Promise<void> {
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.reply(safeT(ctx, "error-unknown", { error: "Session not initialized" }));
    return;
  }
  if (session.main.user.role !== Role.Admin) {
    await ctx.reply(safeT(ctx, "error-access-denied"));
    return;
  }

  if (!session.other.promoAdmin) {
    session.other.promoAdmin = { page: 0, editingPromoId: null };
  }
  const promoId = session.other.promoAdmin.editingPromoId;
  if (!promoId) {
    await ctx.reply(safeT(ctx, "admin-promos-edit-missing"));
    await sendPromosView(ctx);
    return;
  }

  const promoRepo = ctx.appDataSource.getRepository(Promo);
  const promo = await promoRepo.findOne({ where: { id: promoId } });
  if (!promo) {
    await ctx.reply(safeT(ctx, "admin-promos-not-found"));
    await sendPromosView(ctx);
    return;
  }

  await ctx.reply(
    safeT(ctx, "admin-promos-edit-code", { code: promo.code })
  );
  const codeCtx = await conversation.waitFor("message:text");
  const rawCode = codeCtx.message.text.trim();
  const code = rawCode === "/skip" ? promo.code : normalizeCode(rawCode);
  if (code !== promo.code) {
    if (!isValidCode(code)) {
      await ctx.reply(safeT(ctx, "admin-promos-invalid-code"));
      await sendPromosView(ctx);
      return;
    }
    const existing = await promoRepo.findOne({ where: { code } });
    if (existing && existing.id !== promo.id) {
      await ctx.reply(safeT(ctx, "promocode-already-exist"));
      await sendPromosView(ctx);
      return;
    }
    promo.code = code;
  }

  await ctx.reply(
    safeT(ctx, "admin-promos-edit-amount", { amount: promo.sum })
  );
  const amountCtx = await conversation.waitFor("message:text");
  const rawAmount = amountCtx.message.text.trim();
  if (rawAmount !== "/skip") {
    const amount = parseNumber(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply(safeT(ctx, "admin-promos-invalid-amount"));
      await sendPromosView(ctx);
      return;
    }
    promo.sum = amount;
  }

  await ctx.reply(
    safeT(ctx, "admin-promos-edit-max-uses", { maxUses: promo.maxUses })
  );
  const maxCtx = await conversation.waitFor("message:text");
  const rawMax = maxCtx.message.text.trim();
  if (rawMax !== "/skip") {
    const maxUses = Number.parseInt(rawMax, 10);
    if (!Number.isFinite(maxUses) || maxUses <= 0) {
      await ctx.reply(safeT(ctx, "admin-promos-invalid-max-uses"));
      await sendPromosView(ctx);
      return;
    }
    promo.maxUses = maxUses;
  }

  await promoRepo.save(promo);
  await ctx.reply(safeT(ctx, "admin-promos-updated", { code: promo.code }));
  await sendPromosView(ctx);
}
