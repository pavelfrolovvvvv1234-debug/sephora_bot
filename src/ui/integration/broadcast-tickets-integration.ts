/**
 * Integration file for Broadcast and Tickets functionality.
 * Registers all menus, conversations, and handlers.
 *
 * @module ui/integration/broadcast-tickets-integration
 */

import type { Bot } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import { createConversation } from "@grammyjs/conversations";
import { formatTicketPayload, ticketViewMenu, moderatorMenu } from "../menus/moderator-menu";
import { BroadcastService } from "../../domain/broadcast/BroadcastService";
import {
  askUserConversation,
  provideDedicatedResultConversation,
  provideResultConversation,
  rejectTicketConversation,
} from "../conversations/ticket-conversations";
import { orderDedicatedConversation, createDedicatedOperationTicket } from "../conversations/dedicated-conversations";
import { createDomainViewMenu } from "../menus/amper-domains-menu";
import { DomainStatus } from "../../entities/Domain";
import { TicketService } from "../../domain/tickets/TicketService";
import { TicketType, TicketStatus } from "../../entities/Ticket";
import { InlineKeyboard } from "grammy";
import { Role } from "../../entities/User";
import Promo from "../../entities/Promo";
import { Logger } from "../../app/logger";
import { adminPromosMenu } from "../menus/admin-promocodes-menu.js";
import {
  registerPromoConversations,
} from "../conversations/admin-promocodes-conversations";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { escapeUserInput } from "../../helpers/formatting.js";
import DedicatedServer from "../../entities/DedicatedServer";
import { setModeratorChatId } from "../../shared/moderator-chat.js";
import { createInitialOtherSession } from "../../shared/session-initial.js";
import type { DomainShopCategory } from "../../domain/domains/domain-purchase-config.js";
import { setPendingDomainNsUpdate } from "../conversations/domain-update-ns-conversation.js";
import {
  DedicatedProvisioningService,
  PROVISIONING_CHECKLIST_KEYS,
} from "../../domain/dedicated/DedicatedProvisioningService.js";
import {
  ProvisioningTicketStatus,
} from "../../entities/ProvisioningTicket.js";

const safeEditMessageText = async (
  ctx: AppContext,
  text: string,
  options?: Parameters<AppContext["editMessageText"]>[1]
): Promise<void> => {
  try {
    await ctx.editMessageText(text, options);
  } catch (error: any) {
    const description = error?.description || error?.message || "";
    if (description.includes("message is not modified")) {
      return;
    }
    throw error;
  }
};

const safeReplyHtml = async (
  ctx: AppContext,
  html: string,
  options?: Parameters<AppContext["reply"]>[1]
): Promise<void> => {
  try {
    await ctx.reply(html, { ...options, parse_mode: "HTML" });
  } catch (error: any) {
    const description = error?.description || error?.message || "";
    if (description.includes("can't parse entities")) {
      const plain = html.replace(/<[^>]+>/g, "");
      await ctx.reply(plain, options);
      return;
    }
    throw error;
  }
};

const safeSendHtml = async (
  ctx: AppContext,
  chatId: number,
  html: string,
  options?: Parameters<AppContext["api"]["sendMessage"]>[2]
): Promise<void> => {
  try {
    await ctx.api.sendMessage(chatId, html, { ...options, parse_mode: "HTML" });
  } catch (error: any) {
    const description = error?.description || error?.message || "";
    if (description.includes("can't parse entities")) {
      const plain = html.replace(/<[^>]+>/g, "");
      await ctx.api.sendMessage(chatId, plain, options);
      return;
    }
    throw error;
  }
};

const parseTicketPayload = (payload: string | null): Record<string, any> => {
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    return {};
  }
};
const renderMultiline = (text: string): string => text.replace(/\\n/g, "\n");

const toProvisioningStatus = (raw: string): ProvisioningTicketStatus | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  const legacyMap: Record<string, ProvisioningTicketStatus> = {
    new: ProvisioningTicketStatus.OPEN,
    paid: ProvisioningTicketStatus.WAITING,
    awaiting_payment: ProvisioningTicketStatus.WAITING,
    awaiting_stock: ProvisioningTicketStatus.WAITING,
    pending_review: ProvisioningTicketStatus.IN_PROGRESS,
    in_provisioning: ProvisioningTicketStatus.IN_PROGRESS,
    awaiting_final_check: ProvisioningTicketStatus.IN_PROGRESS,
    completed: ProvisioningTicketStatus.DONE,
    rejected: ProvisioningTicketStatus.DONE,
    cancelled: ProvisioningTicketStatus.DONE,
  };
  if (legacyMap[normalized]) {
    return legacyMap[normalized];
  }
  const values = new Set<string>(Object.values(ProvisioningTicketStatus));
  return values.has(normalized) ? (normalized as ProvisioningTicketStatus) : null;
};

const formatProvisioningStatus = (ctx: AppContext, status: ProvisioningTicketStatus): string => {
  const key = `ticket-status-${status}`;
  const translated = ctx.t(key as any);
  return translated === key ? status : translated;
};

const formatProvisioningQueueSummary = (
  ctx: AppContext,
  stats: {
    open: number;
    inProgress: number;
    waiting: number;
    done: number;
    total: number;
  }
): string =>
  renderMultiline(
    ctx.t("provisioning-menu-title", {
      open: stats.open,
      inProgress: stats.inProgress,
      waiting: stats.waiting,
      done: stats.done,
      total: stats.total,
    })
  );

const provisioningTicketKeyboard = (
  ctx: AppContext,
  ticketId: number
): InlineKeyboard =>
  new InlineKeyboard()
    .text(ctx.t("button-ticket-assign-self"), `prov_take_${ticketId}`)
    .text(ctx.t("button-ticket-ask-clarification"), `prov_note_${ticketId}`)
    .row()
    .text(ctx.t("ticket-status-in_progress"), `prov_status_${ticketId}_in_progress`)
    .text(ctx.t("ticket-status-waiting"), `prov_status_${ticketId}_waiting`)
    .row()
    .text(ctx.t("button-provisioning-send-credentials"), `prov_complete_${ticketId}`)
    .text(ctx.t("ticket-status-done"), `prov_status_${ticketId}_done`);

const resolveAskUserRecipientId = async (
  ctx: AppContext,
  ticket: { userId: number; type: TicketType; payload: string | null },
  moderatorUserId: number
): Promise<number> => {
  if (
    ticket.type === TicketType.DEDICATED_REINSTALL ||
    ticket.type === TicketType.DEDICATED_REBOOT ||
    ticket.type === TicketType.DEDICATED_RESET ||
    ticket.type === TicketType.DEDICATED_OTHER
  ) {
    const payload = parseTicketPayload(ticket.payload);
    const dedicatedId = Number(payload.dedicatedId);
    if (Number.isInteger(dedicatedId)) {
      const dedicatedRepo = ctx.appDataSource.getRepository(DedicatedServer);
      const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
      if (dedicated?.userId && dedicated.userId !== moderatorUserId) {
        return dedicated.userId;
      }
    }
  }

  return ticket.userId;
};

const resolveAskUserRecipientIds = async (
  ctx: AppContext,
  ticket: { userId: number; type: TicketType; payload: string | null },
  moderatorUserId: number
): Promise<number[]> => {
  const recipients = new Set<number>();
  recipients.add(ticket.userId);

  if (
    ticket.type === TicketType.DEDICATED_REINSTALL ||
    ticket.type === TicketType.DEDICATED_REBOOT ||
    ticket.type === TicketType.DEDICATED_RESET ||
    ticket.type === TicketType.DEDICATED_OTHER
  ) {
    const payload = parseTicketPayload(ticket.payload);
    const dedicatedId = Number(payload.dedicatedId);
    if (Number.isInteger(dedicatedId)) {
      const dedicatedRepo = ctx.appDataSource.getRepository(DedicatedServer);
      const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
      if (dedicated?.userId) {
        recipients.add(dedicated.userId);
      }
    }
  }

  const recipientList = Array.from(recipients);
  const nonModerator = recipientList.filter((id) => id !== moderatorUserId);
  return nonModerator.length > 0 ? nonModerator : recipientList;
};

const normalizePromoCode = (value: string): string => value.trim().toLowerCase();
const parsePromoNumber = (value: string): number =>
  Number.parseFloat(value.replace(",", "."));
const isValidPromoCode = (value: string): boolean =>
  /^[a-z0-9_-]{3,32}$/i.test(value);

/**
 * Single handler for all Prime "Назад" (Back) callbacks. Dispatches by ctx.callbackQuery.data.
 * Edits the existing message (no new messages). Fallback to main menu if callback unknown.
 */
async function handlePrimeBack(ctx: AppContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";

  try {
    if (data === "prime-back-to-main") {
      const session = await ctx.session;
      const balance = session?.main?.user?.balance ?? 0;
      const welcomeText = ctx.t("welcome", { balance });
      const { getReplyMainMenu } = await import("../menus/main-menu-registry.js");
      await ctx.editMessageText(welcomeText, {
        reply_markup: await getReplyMainMenu(),
        parse_mode: "HTML",
      });
      return;
    }
    if (data === "prime-back-to-domains-zones") {
      const { showDomainShopHome } = await import("../../domain/domains/domain-purchase-flow.js");
      await showDomainShopHome(ctx);
      return;
    }
    if (data === "prime-back-to-domain-shop-category") {
      const session = await ctx.session;
      const { showDomainCategoryTlds } = await import("../../domain/domains/domain-purchase-flow.js");
      if (!session.other) (session as any).other = createInitialOtherSession();
      const raw = session.other.domains?.shopCategory;
      const cat: DomainShopCategory =
        raw === "popular" || raw === "business" || raw === "tech" || raw === "geo" || raw === "all"
          ? raw
          : "popular";
      await showDomainCategoryTlds(ctx, cat);
      return;
    }
    if (data === "prime-back-to-dedicated-type") {
      const { showDedicatedShopStep1 } = await import("../../domain/dedicated/dedicated-shop-flow.js");
      await showDedicatedShopStep1(ctx);
      return;
    }
    if (data === "prime-back-to-dedicated-servers") {
      const session = await ctx.session;
      const {
        showDedicatedShopStep1,
        showDedicatedShopStep2Tier,
        showDedicatedShopStep3List,
      } = await import("../../domain/dedicated/dedicated-shop-flow.js");
      if (!session.other.dedicatedType) {
        await showDedicatedShopStep1(ctx);
        return;
      }
      const tier = session.other.dedicatedType.shopTier;
      if (tier) {
        await showDedicatedShopStep3List(ctx, session.other.dedicatedType.shopListPage ?? 0);
      } else {
        await showDedicatedShopStep2Tier(ctx);
      }
      return;
    }
    if (data === "prime-back-to-dedicated-tier") {
      const { showDedicatedShopStep2Tier } = await import("../../domain/dedicated/dedicated-shop-flow.js");
      await showDedicatedShopStep2Tier(ctx);
      return;
    }
    if (data === "prime-back-to-dedicated-list") {
      const session = await ctx.session;
      const { showDedicatedShopStep3List, showDedicatedShopStep2Tier } = await import(
        "../../domain/dedicated/dedicated-shop-flow.js"
      );
      if (!session.other.dedicatedType?.shopTier) {
        await showDedicatedShopStep2Tier(ctx);
        return;
      }
      await showDedicatedShopStep3List(ctx, session.other.dedicatedType.shopListPage ?? 0);
      return;
    }
    if (data === "prime-back-to-vds-menu") {
      const session = await ctx.session;
      const { showVpsShopStep2Tier, showVpsShopStep3List } = await import("../../domain/vds/vds-shop-flow.js");
      if (!session.other?.vdsRate?.shopTier) {
        await showVpsShopStep2Tier(ctx);
      } else {
        await showVpsShopStep3List(ctx, session.other.vdsRate.shopListPage ?? 0);
      }
      return;
    }
    if (data === "prime-back-to-vds-shop-tier") {
      const { showVpsShopStep2Tier } = await import("../../domain/vds/vds-shop-flow.js");
      await showVpsShopStep2Tier(ctx);
      return;
    }
    if (data === "prime-back-to-vds-shop-list") {
      const session = await ctx.session;
      const { showVpsShopStep3List, showVpsShopStep2Tier } = await import("../../domain/vds/vds-shop-flow.js");
      if (!session.other?.vdsRate?.shopTier) {
        await showVpsShopStep2Tier(ctx);
        return;
      }
      await showVpsShopStep3List(ctx, session.other.vdsRate.shopListPage ?? 0);
      return;
    }
    if (data === "prime-back-to-vds-type") {
      const { showVpsShopStep1 } = await import("../../domain/vds/vds-shop-flow.js");
      await showVpsShopStep1(ctx);
      return;
    }
    if (data === "prime-back-to-cdn-tariffs") {
      const { showCdnTariffsScreen } = await import("../menus/cdn-menu.js");
      await showCdnTariffsScreen(ctx);
      return;
    }
    if (data === "prime-back-to-profile" || data === "prime_sub_back") {
      const { getProfileText, profileMenu } = await import("../menus/profile-menu.js");
      const profileText = await getProfileText(ctx);
      await ctx.editMessageText(profileText, {
        reply_markup: profileMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    // Unknown prime-back-*: fallback to main menu so user is never stuck
    const session = await ctx.session;
    const balance = session?.main?.user?.balance ?? 0;
    const welcomeText = ctx.t("welcome", { balance });
    const { getReplyMainMenu } = await import("../menus/main-menu-registry.js");
    await ctx.editMessageText(welcomeText, {
      reply_markup: await getReplyMainMenu(),
      parse_mode: "HTML",
    });
  } catch (err: any) {
    const desc = err?.description ?? err?.message ?? "";
    if (desc.includes("message is not modified") || desc.includes("message not modified")) {
      return; // Same content, no need to alert
    }
    Logger.error(`Prime back handler error (${data}):`, err);
    await ctx.answerCallbackQuery({
      text: ctx.t("error-unknown", { error: err?.message || "Error" }).slice(0, 200),
      show_alert: true,
    }).catch(() => {});
  }
}

/** Ссылка на канал Prime по умолчанию (приглашение в канал SephoraHost). */
const DEFAULT_PRIME_CHANNEL_INVITE = "https://t.me/sephora_news";

/**
 * Prime: activate trial — send new message with channel link and buttons.
 * Exported so index.ts can call it from a single early middleware.
 */
export async function handlePrimeActivateTrial(ctx: AppContext): Promise<void> {
  const channelLink = process.env.PRIME_CHANNEL_INVITE?.trim() || DEFAULT_PRIME_CHANNEL_INVITE;

  const keyboard = new InlineKeyboard()
    .url(ctx.t("prime-button-go-subscribe"), channelLink)
    .row()
    .text(ctx.t("prime-button-i-subscribed"), "prime_i_subscribed")
    .row();

  await ctx.reply(ctx.t("prime-subscribe-message", { channelLink }), {
    reply_markup: keyboard,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Prime: user claims they subscribed — check and activate 7-day trial.
 * Exported so index.ts can call it from a single early middleware.
 */
export async function handlePrimeISubscribed(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  const hasSessionUser = await ensureSessionUser(ctx);
  if (!session || !hasSessionUser) {
    await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
    return;
  }

  const { getPrimeChannelForCheck } = await import("../../app/config.js");
  const chatIdForCheck = getPrimeChannelForCheck();

  if (chatIdForCheck == null || (typeof chatIdForCheck === "number" && Number.isNaN(chatIdForCheck))) {
    await ctx.answerCallbackQuery({
      text: ctx.t("prime-channel-not-configured").substring(0, 200),
      show_alert: true,
    });
    return;
  }

  const UserRepository = (await import("../../infrastructure/db/repositories/UserRepository.js")).UserRepository;
  const userRepo = new UserRepository(ctx.appDataSource);
  const user = await userRepo.findById(session.main.user.id);
  if (!user) {
    await ctx.answerCallbackQuery(ctx.t("error-user-not-found").substring(0, 200));
    return;
  }

  if (user.primeTrialUsed) {
    await ctx.answerCallbackQuery(
      ctx.t("prime-trial-already-used", { monthlyPrice: "9.99" }).substring(0, 200)
    );
    return;
  }

  // Проверка подписки: бот должен быть админом в канале (PRIME_CHANNEL_ID или PRIME_CHANNEL_USERNAME)
  const userId = ctx.from!.id;
  const SUBSCRIBED_STATUSES = ["member", "administrator", "creator", "restricted"] as const;

  const isSubscribedStatus = (s: string) => SUBSCRIBED_STATUSES.includes(s as any);

  let member: { status: string } | null = null;
  try {
    member = await ctx.api.getChatMember(chatIdForCheck, userId).then((m) => m as { status: string });
  } catch {
    // Часто бывает задержка обновления после подписки или временная ошибка — одна повторная попытка через 2 с
    await new Promise((r) => setTimeout(r, 2000));
    try {
      member = await ctx.api.getChatMember(chatIdForCheck, userId).then((m) => m as { status: string });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const code = err?.error_code ?? err?.code;
      Logger.error("Prime getChatMember failed", {
        chatId: typeof chatIdForCheck === "string" ? chatIdForCheck : `#${chatIdForCheck}`,
        userId,
        error: msg,
        code,
      });
      await ctx.answerCallbackQuery({
        text: ctx.t("prime-trial-subscribe-first").substring(0, 200),
        show_alert: true,
      });
      return;
    }
  }

  let status = member?.status ?? "left";
  if (!isSubscribedStatus(status) && (status === "left" || status === "kicked")) {
    // Только что подписался — Telegram может отдавать «left» с задержкой; проверяем ещё раз через 2.5 с
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const again = await ctx.api.getChatMember(chatIdForCheck, userId).then((m) => m as { status: string });
      status = again.status;
      if (isSubscribedStatus(status)) member = again;
    } catch {
      // оставляем прежний status
    }
  }

  const isSubscribed = member != null && isSubscribedStatus(status);
  if (!isSubscribed) {
    Logger.warn("Prime check: user not subscribed", {
      userId,
      channel: typeof chatIdForCheck === "string" ? chatIdForCheck : chatIdForCheck,
      status,
    });
    await ctx.answerCallbackQuery({
      text: ctx.t("prime-trial-subscribe-first-retry").substring(0, 200),
      show_alert: true,
    });
    return;
  }

  Logger.info("Prime check: subscribed", {
    userId,
    channel: typeof chatIdForCheck === "string" ? chatIdForCheck : chatIdForCheck,
    status,
  });

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  user.primeActiveUntil = new Date(Date.now() + sevenDaysMs);
  user.primeTrialUsed = true;
  await userRepo.save(user);

  await ctx.answerCallbackQuery(ctx.t("prime-trial-activated").substring(0, 200));

  const msg = ctx.callbackQuery?.message;
  if (msg && "message_id" in msg && ctx.chat?.id) {
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch((err: any) => {
      Logger.error("Failed to delete Prime subscribe message:", err);
    });
  }

  await ctx.reply(ctx.t("prime-trial-activated-message"));
}

/**
 * Register Prime "Back" button handler. Must be called BEFORE any menu/conversations.
 * Uses a single bot.use() middleware so we run for every update and consume prime-back-* callbacks
 * before any @grammyjs/menu or other handler can see them.
 */
export function registerPrimeBackHandler(bot: Bot<AppContext>): void {
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    const isPrimeBack =
      typeof data === "string" &&
      (data.startsWith("prime-back-") || data === "prime_sub_back");
    if (!isPrimeBack) return next();
    // Answer immediately so user sees feedback; then handle navigation
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await handlePrimeBack(ctx);
    } catch (err: any) {
      Logger.error("Prime back middleware error:", err);
      await ctx.answerCallbackQuery({
        text: (err?.message || "Error").slice(0, 200),
        show_alert: true,
      }).catch(() => {});
    }
    // Do not call next() — we handled the update
  });
}

/**
 * Register all broadcast and tickets functionality.
 */
export function registerBroadcastAndTickets(bot: Bot<AppContext>): void {
  const broadcastConfirmNonceByAdminId = new Map<number, string>();
  try {
    bot.use(adminPromosMenu);
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      Logger.warn("Failed to register admin promos menu:", error);
    }
  }
  // Register conversations (type assertion for grammY conversation builder compatibility)
  bot.use(createConversation(askUserConversation as any, "askUserConversation"));
  bot.use(createConversation(provideDedicatedResultConversation as any, "provideDedicatedResultConversation"));
  bot.use(createConversation(provideResultConversation as any, "provideResultConversation"));
  bot.use(createConversation(rejectTicketConversation as any, "rejectTicketConversation"));
  bot.use(createConversation(orderDedicatedConversation as any, "orderDedicatedConversation"));
  registerPromoConversations(bot);
  bot.use(ticketViewMenu);

  // Remember last moderator chat for notifications
  bot.use(async (ctx, next) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (session && hasSessionUser) {
      if ((session.main.user.role === Role.Moderator || session.main.user.role === Role.Admin) && ctx.chatId != null) {
        setModeratorChatId(ctx.chatId);
      }
    }
    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      return next();
    }
    if (!ctx.hasChatType("private")) {
      return next();
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      return next();
    }

    const promoStep = session.other.promoAdmin?.createStep;
    const promoEditStep = session.other.promoAdmin?.editStep;
    const hasOtherPendingAdminInput =
      !!session.other.controlUsersPage?.awaitingUserLookup ||
      !!session.other.adminVds?.awaitingSearch ||
      !!session.other.adminVds?.awaitingTransferUserId ||
      !!session.other.adminCdn?.awaitingSearch ||
      !!session.other.balanceEdit ||
      !!session.other.messageToUser ||
      !!session.other.subscriptionEdit ||
      !!session.other.referralPercentEdit ||
      !!session.other.adminDomainNs ||
      !!session.other.adminDomainSetAmperId ||
      !!session.other.adminRegisterDomain ||
      !!session.other.ticketsView?.pendingAction;
    if ((promoStep || promoEditStep) && session.main.user.role === Role.Admin) {
      // Never let stale promo edit/create state steal text from other admin flows.
      if (hasOtherPendingAdminInput) {
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }

      const promoRepo = ctx.appDataSource.getRepository(Promo);

      if (promoEditStep === "code") {
        const promoId = session.other.promoAdmin.editingPromoId;
        if (!promoId) {
          session.other.promoAdmin.editStep = null;
          await ctx.reply(ctx.t("admin-promos-edit-missing"));
          return;
        }

        const promo = await promoRepo.findOne({ where: { id: promoId } });
        if (!promo) {
          session.other.promoAdmin.editStep = null;
          session.other.promoAdmin.editingPromoId = null;
          await ctx.reply(ctx.t("admin-promos-not-found"));
          return;
        }

        const rawCode = input.trim();
        const code =
          rawCode.toLowerCase() === "/skip" ? promo.code : normalizePromoCode(rawCode);
        if (code !== promo.code && !isValidPromoCode(code)) {
          await ctx.reply(ctx.t("admin-promos-invalid-code"));
          return;
        }

        if (code !== promo.code) {
          const existing = await promoRepo.findOne({ where: { code } });
          if (existing && existing.id !== promo.id) {
            await ctx.reply(ctx.t("promocode-already-exist"));
            return;
          }
          promo.code = code;
          await promoRepo.save(promo);
        }

        await ctx.reply(ctx.t("admin-promos-updated", { code: promo.code }));
        session.other.promoAdmin.editStep = null;
        session.other.promoAdmin.editingPromoId = null;

        const text = await (await import("../menus/admin-promocodes-menu.js")).buildAdminPromosText(ctx);
        await ctx.reply(text, {
          reply_markup: adminPromosMenu,
          parse_mode: "HTML",
        });
        return;
      }

      if (promoStep === "code") {
        const code = normalizePromoCode(input);
        if (!isValidPromoCode(code)) {
          await ctx.reply(ctx.t("admin-promos-invalid-code"));
          return;
        }

        const existing = await promoRepo.findOne({ where: { code } });
        if (existing) {
          await ctx.reply(ctx.t("promocode-already-exist"));
          return;
        }

        session.other.promoAdmin.createDraft = { code };
        session.other.promoAdmin.createStep = "amount";
        await ctx.reply(ctx.t("admin-promos-enter-amount"));
        return;
      }

      if (promoStep === "amount") {
        const amount = parsePromoNumber(input);
        if (!Number.isFinite(amount) || amount <= 0) {
          await ctx.reply(ctx.t("admin-promos-invalid-amount"));
          return;
        }

        session.other.promoAdmin.createDraft = {
          ...session.other.promoAdmin.createDraft,
          amount,
        };
        session.other.promoAdmin.createStep = "max";
        await ctx.reply(ctx.t("admin-promos-enter-max-uses"));
        return;
      }

      if (promoStep === "max") {
        const maxUses = Number.parseInt(input, 10);
        if (!Number.isFinite(maxUses) || maxUses <= 0) {
          await ctx.reply(ctx.t("admin-promos-invalid-max-uses"));
          return;
        }

        const draft = session.other.promoAdmin.createDraft || {};
        if (!draft.code || !draft.amount) {
          session.other.promoAdmin.createStep = "code";
          await ctx.reply(ctx.t("admin-promos-enter-code"));
          return;
        }

        const promo = new Promo();
        promo.code = draft.code;
        promo.sum = draft.amount;
        promo.maxUses = maxUses;
        promo.uses = 0;
        promo.users = [];
        promo.isActive = true;

        await promoRepo.save(promo);
        await ctx.reply(ctx.t("admin-promos-created", { code: promo.code }));

        session.other.promoAdmin.createStep = null;
        session.other.promoAdmin.createDraft = {};

        const text = await (await import("../menus/admin-promocodes-menu.js")).buildAdminPromosText(ctx);
        await ctx.reply(text, {
          reply_markup: adminPromosMenu,
          parse_mode: "HTML",
        });
        return;
      }
    }

    const pendingAction = session.other.ticketsView?.pendingAction;
    const ticketId = session.other.ticketsView?.pendingTicketId;
    if (!pendingAction || !ticketId) {
      return next();
    }

    const input = ctx.message.text.trim();
    if (input.startsWith("/")) {
      return next();
    }

    const ticketService = new TicketService(ctx.appDataSource);

    try {
      if (pendingAction === "ask_user") {
        const question = input;
        const ticket = await ticketService.askUser(
          ticketId,
          question,
          session.main.user.id,
          session.main.user.role
        );

        const userRepo = ctx.appDataSource.getRepository(
          (await import("../../entities/User")).default
        );
        const recipientIds = await resolveAskUserRecipientIds(
          ctx,
          ticket,
          session.main.user.id
        );
        if (recipientIds.length === 0) {
          await ctx.reply(ctx.t("error-user-not-found"));
          return;
        }

        const safeQuestion = escapeUserInput(question);
        const message = ctx.t("ticket-question-from-moderator", {
          question: safeQuestion,
          ticketId,
        });

        let delivered = false;
        for (const recipientId of recipientIds) {
          const user = await userRepo.findOne({ where: { id: recipientId } });
          if (!user) {
            continue;
          }
          await safeSendHtml(ctx, user.telegramId, message);
          delivered = true;
        }

        if (!delivered) {
          await ctx.reply(ctx.t("error-user-not-found"));
          return;
        }

        await ctx.reply(ctx.t("ticket-question-sent"));
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }

      if (pendingAction === "provide_result") {
        const result = input;
        const ticket = await ticketService.provideResult(
          ticketId,
          result,
          session.main.user.id,
          session.main.user.role
        );

        const userRepo = ctx.appDataSource.getRepository(
          (await import("../../entities/User")).default
        );
        const user = await userRepo.findOne({ where: { id: ticket.userId } });
        if (user) {
          await ctx.api.sendMessage(
            user.telegramId,
            ctx.t("ticket-result-received", { ticketId, result }),
            { parse_mode: "HTML" }
          );
        }

        await ctx.reply(ctx.t("ticket-result-provided"));
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }

      if (pendingAction === "reject") {
        const reason = input.length > 0 ? input : null;
        const ticket = await ticketService.rejectTicket(
          ticketId,
          reason,
          session.main.user.id,
          session.main.user.role
        );

        const userRepo = ctx.appDataSource.getRepository(
          (await import("../../entities/User")).default
        );
        const user = await userRepo.findOne({ where: { id: ticket.userId } });
        if (user) {
          await ctx.api.sendMessage(
            user.telegramId,
            ctx.t("ticket-rejected", {
              ticketId,
              reason: reason || ctx.t("no-reason-provided"),
            }),
            { parse_mode: "HTML" }
          );
        }

        await ctx.reply(ctx.t("ticket-rejected-by-moderator"));
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }

      if (pendingAction === "provide_dedicated_ip") {
        session.other.ticketsView.pendingData = {
          ...session.other.ticketsView.pendingData,
          ip: input,
        };
        session.other.ticketsView.pendingAction = "provide_dedicated_login";
        await ctx.reply(ctx.t("ticket-provide-login"));
        return;
      }

      if (pendingAction === "provide_dedicated_login") {
        session.other.ticketsView.pendingData = {
          ...session.other.ticketsView.pendingData,
          login: input,
        };
        session.other.ticketsView.pendingAction = "provide_dedicated_password";
        await ctx.reply(ctx.t("ticket-provide-password"));
        return;
      }

      if (pendingAction === "provide_dedicated_password") {
        session.other.ticketsView.pendingData = {
          ...session.other.ticketsView.pendingData,
          password: input,
        };
        session.other.ticketsView.pendingAction = "provide_dedicated_panel";
        await ctx.reply(ctx.t("ticket-provide-panel-optional"));
        return;
      }

      if (pendingAction === "provide_dedicated_panel") {
        const panelValue =
          input.length === 0 || input.toLowerCase() === "/skip" ? null : input;
        session.other.ticketsView.pendingData = {
          ...session.other.ticketsView.pendingData,
          panel: panelValue,
        };
        session.other.ticketsView.pendingAction = "provide_dedicated_notes";
        await ctx.reply(ctx.t("ticket-provide-notes-optional"));
        return;
      }

      if (pendingAction === "provide_dedicated_notes") {
        const notesValue =
          input.length === 0 || input.toLowerCase() === "/skip" ? null : input;
        const pendingData = session.other.ticketsView.pendingData || {};
        const credentials: Record<string, string> = {
          ip: pendingData.ip || "",
          login: pendingData.login || "",
          password: pendingData.password || "",
        };
        if (pendingData.panel) {
          credentials.panel = pendingData.panel;
        }
        if (notesValue) {
          credentials.notes = notesValue;
        }

        const ticket = await ticketService.provideResult(
          ticketId,
          credentials,
          session.main.user.id,
          session.main.user.role
        );

        const userRepo = ctx.appDataSource.getRepository(
          (await import("../../entities/User")).default
        );
        const user = await userRepo.findOne({ where: { id: ticket.userId } });
        if (user) {
          const keyboard = new InlineKeyboard()
            .text(ctx.t("button-my-dedicated"), "dedicated_menu")
            .row()
            .text(ctx.t("button-back"), "main-menu");
          await ctx.api.sendMessage(
            user.telegramId,
            ctx.t("ticket-dedicated-ready", {
              ticketId,
              ip: credentials.ip,
              login: credentials.login,
              password: credentials.password,
              panel: pendingData.panel || ctx.t("not-specified"),
              notes: notesValue || ctx.t("none"),
            }),
            {
              reply_markup: keyboard,
              parse_mode: "HTML",
            }
          );
        }

        await ctx.reply(ctx.t("ticket-result-provided"));
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }

      if (pendingAction === "provisioning_note") {
        const service = new DedicatedProvisioningService(ctx.appDataSource);
        await service.addInternalNote(ticketId, session.main.user.id, input);
        await ctx.reply(ctx.t("provisioning-note-saved"), {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(ctx.t("button-open"), `prov_view_${ticketId}`),
        });
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }

      if (pendingAction === "provisioning_complete_message") {
        const service = new DedicatedProvisioningService(ctx.appDataSource);
        const ticket = await service.getTicketById(ticketId);
        if (!ticket) {
          await ctx.reply(ctx.t("error-ticket-not-found"));
          return;
        }
        const order = await service.getOrderById(ticket.orderId);
        if (!order) {
          await ctx.reply(ctx.t("error-ticket-not-found"));
          return;
        }
        await service.updateStatus(ticketId, ProvisioningTicketStatus.DONE, session.main.user.id, "completed_by_staff");
        await service.setChecklistItem(ticketId, "ticket_completed", true, session.main.user.id);
        await service.setChecklistItem(ticketId, "credentials_sent_to_customer", true, session.main.user.id);
        await ctx.api.sendMessage(order.telegramUserId || ctx.from!.id, renderMultiline(ctx.t("provisioning-user-ready-message", {
          ticketId,
          message: escapeUserInput(input),
        })), { parse_mode: "HTML" }).catch(() => {});
        await ctx.reply(ctx.t("provisioning-completed"), {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(ctx.t("button-open"), `prov_view_${ticketId}`),
        });
        session.other.ticketsView.pendingAction = null;
        session.other.ticketsView.pendingTicketId = null;
        session.other.ticketsView.pendingData = {};
        return;
      }
    } catch (error: any) {
      Logger.error("Ticket action failed:", error);
      await ctx.reply(
        ctx.t("error-unknown", { error: error?.message || "Unknown error" })
      );
      return;
    }

    return next();
  });
  
  // Broadcast flow (admin only, session-based)
  bot.on("message:text", async (ctx, next) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        return next();
      }
      if (session.main.user.role !== Role.Admin) {
        return next();
      }

      if (session.other.broadcast?.step !== "awaiting_text") {
        return next();
      }

      // Do not steal text from other admin input flows (search, transfer, user lookup, etc.)
      const hasOtherPendingAdminInput =
        !!session.other.controlUsersPage?.awaitingUserLookup ||
        !!session.other.adminVds?.awaitingSearch ||
        !!session.other.adminVds?.awaitingTransferUserId ||
        !!session.other.adminCdn?.awaitingSearch ||
        !!session.other.balanceEdit ||
        !!session.other.messageToUser ||
        !!session.other.subscriptionEdit ||
        !!session.other.referralPercentEdit ||
        !!session.other.adminDomainNs ||
        !!session.other.adminDomainSetAmperId ||
        !!session.other.adminRegisterDomain;
      if (hasOtherPendingAdminInput) {
        return next();
      }

      const text = ctx.message.text.trim();
      if (text.startsWith("/")) {
        return next();
      }
      if (text.length === 0) {
        await ctx.reply(ctx.t("broadcast-enter-text"));
        return;
      }

      session.other.broadcast = {
        step: "awaiting_confirm",
        text,
      };
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      broadcastConfirmNonceByAdminId.set(session.main.user.id, nonce);

      const previewText = escapeUserInput(text);
      const keyboard = new InlineKeyboard()
        .text(ctx.t("button-send"), `broadcast_confirm:${nonce}`)
        .text(ctx.t("button-cancel"), `broadcast_cancel:${nonce}`);

      await safeReplyHtml(ctx, ctx.t("broadcast-preview", { text: previewText }), {
        reply_markup: keyboard,
      });
    } catch (error) {
      Logger.error("Broadcast preview failed:", error);
      await ctx
        .reply(
          ctx.t("error-unknown", {
            error: (error as Error)?.message || "Unknown error",
          }).substring(0, 200)
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^broadcast_(confirm|cancel)(?::([a-z0-9]+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
      return;
    }

    if (session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      return;
    }

    const action = ctx.match[1];
    const nonce = ctx.match[2];
    const expectedNonce = broadcastConfirmNonceByAdminId.get(session.main.user.id);
    if (action === "cancel") {
      session.other.broadcast = { step: "idle" };
      broadcastConfirmNonceByAdminId.delete(session.main.user.id);
      await safeEditMessageText(ctx, ctx.t("broadcast-cancelled"));
      return;
    }

    if (
      session.other.broadcast?.step !== "awaiting_confirm" ||
      !session.other.broadcast?.text ||
      !nonce ||
      !expectedNonce ||
      nonce !== expectedNonce
    ) {
      session.other.broadcast = { step: "idle" };
      broadcastConfirmNonceByAdminId.delete(session.main.user.id);
      await safeEditMessageText(
        ctx,
        ctx.t("error-unknown", { error: "Broadcast confirmation expired. Please start again." }).substring(0, 200)
      );
      return;
    }

    const text = session.other.broadcast.text;

    session.other.broadcast = { step: "idle" };
    broadcastConfirmNonceByAdminId.delete(session.main.user.id);

    try {
      const broadcastService = new BroadcastService(ctx.appDataSource, bot as any);
      const broadcast = await broadcastService.createBroadcast(session.main.user.id, text);

      const messageId = ctx.callbackQuery.message?.message_id;
      if (messageId) {
        await safeEditMessageText(
          ctx,
          ctx.t("broadcast-starting", { id: broadcast.id })
        );
      }

      broadcastService.sendBroadcast(broadcast.id).then(async (result) => {
        try {
          const errors = await broadcastService.getBroadcastErrors(broadcast.id);
          const errorText =
            errors.length > 0 ? `\n\n<code>${errors.slice(0, 5).join("\n")}</code>` : "";
          const completedText =
            ctx.t("broadcast-completed") +
            "\n\n" +
            ctx.t("broadcast-stats", {
              total: result.totalCount,
              sent: result.sentCount,
              failed: result.failedCount,
              blocked: result.blockedCount,
            }) +
            errorText;

          if (messageId && ctx.chat?.id) {
            await bot.api.editMessageText(
              ctx.chat.id,
              messageId,
              completedText,
              { parse_mode: "HTML" }
            );
          }
        } catch (error) {
          Logger.warn("Failed to update broadcast status:", error);
        }
      }).catch((error) => {
        Logger.error("Broadcast failed:", error);
      });
    } catch (error) {
      Logger.error("Failed to start broadcast:", error);
      await safeEditMessageText(
        ctx,
        ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200)
      );
    }
  });

  // Register dedicated menu in dedicated-type-menu (if exists)
  // Note: This is done asynchronously, but it's safe to ignore errors
  import("../../helpers/services-menu")
    .then((module) => {
      // Registration of menus is handled in index.ts to avoid duplicates
    })
    .catch(() => {
      // Services menu might not be available, ignore
    });

  // Register admin menu in main menu (for admins)
  bot.use(async (ctx, next) => {
    const session = await ctx.session;
    if (session.main.user.role === Role.Admin) {
      // Admin menu will be accessible via /broadcast command or can be added to main menu
    }
    return next();
  });

  // Register moderator menu (for moderators and admins)
  bot.use(async (ctx, next) => {
    const session = await ctx.session;
    if (session.main.user.role === Role.Moderator || session.main.user.role === Role.Admin) {
      // Moderator menu accessible via callback or can be added to main menu
    }
    return next();
  });

  bot.command("tickets", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      return;
    }
    await ctx.reply(
      ctx.t("provisioning-menu-title", {
        open: 0,
        inProgress: 0,
        waiting: 0,
        done: 0,
        total: 0,
      }),
      {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text(ctx.t("ticket-status-open"), "prov_list_open")
        .text(ctx.t("ticket-status-in_progress"), "prov_list_in_progress")
        .row()
        .text(ctx.t("ticket-status-waiting"), "prov_list_waiting")
        .text(ctx.t("ticket-status-done"), "prov_list_done")
        .row()
        .text(ctx.t("button-back"), "tickets-menu-back"),
      }
    );
  });

  bot.command("ticket", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      return;
    }
    const text = ctx.message?.text ?? "";
    const parts = text.split(" ").filter(Boolean);
    const id = Number(parts[1]);
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply("Usage: /ticket <id>");
      return;
    }
    await ctx.reply(ctx.t("button-open"), {
      reply_markup: new InlineKeyboard().text(`#${id}`, `prov_view_${id}`),
    });
  });

  // Handle ticket view callbacks
  bot.callbackQuery(/^ticket_view_(\d+)$/, async (ctx) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
        return;
      }
      // Check if user is moderator or admin
      if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
        return;
      }

      const ticketId = parseInt(ctx.match[1]);
      const ticketService = new TicketService(ctx.appDataSource);
      const ticket = await ticketService.getTicketById(ticketId);

      if (!ticket) {
        await ctx.answerCallbackQuery(ctx.t("error-ticket-not-found").substring(0, 200));
        return;
      }

      const User = (await import("../../entities/User")).default;
      const userRepo = ctx.appDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: ticket.userId } });
      const username = user ? `User ${user.id}` : `User ${ticket.userId}`;

      let payload: Record<string, any> = {};
      try {
        payload = ticket.payload ? JSON.parse(ticket.payload) : {};
      } catch (error) {
        payload = { raw: ticket.payload || "" };
      }
      const ticketTextCandidate =
        payload.text ||
        payload.message ||
        payload.comment ||
        payload.reason ||
        payload.details ||
        payload.raw;
      const ticketText = ticketTextCandidate
        ? escapeUserInput(String(ticketTextCandidate))
        : "";

      const isDedicatedOp =
        ticket.type === TicketType.DEDICATED_REINSTALL ||
        ticket.type === TicketType.DEDICATED_REBOOT ||
        ticket.type === TicketType.DEDICATED_RESET ||
        ticket.type === TicketType.DEDICATED_OTHER ||
        ticket.type === TicketType.DEDICATED_POWER_ON ||
        ticket.type === TicketType.DEDICATED_POWER_OFF;

      let serverLine = "";
      if (isDedicatedOp && payload.dedicatedId != null) {
        const dedicatedId = Number(payload.dedicatedId);
        if (Number.isInteger(dedicatedId)) {
          const dedicatedRepo = ctx.appDataSource.getRepository(DedicatedServer);
          const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
          if (dedicated) {
            const labelPart = dedicated.label ? ` (${escapeUserInput(dedicated.label)})` : "";
            serverLine = `\n<strong>${ctx.t("ticket-request-server")}:</strong> Dedicated #${dedicated.id}${labelPart}`;
          }
        }
      }

      const locale = session.main.locale === "en" ? "en-GB" : "ru-RU";
      const createdStr = new Date(ticket.createdAt).toLocaleString(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const statusLabel = ctx.t(`ticket-status-${ticket.status}` as "ticket-status-new");
      const responsibleStr = ticket.assignedModeratorId
        ? String(ticket.assignedModeratorId)
        : ctx.t("ticket-card-responsible-none");

      let descriptionText = ticketText;
      if (!descriptionText && isDedicatedOp) {
        descriptionText = ctx.t("ticket-description-requested", {
          operation: ctx.t(`ticket-type-${ticket.type}`),
        });
      }
      if (!descriptionText) {
        descriptionText = ctx.t("ticket-description-empty");
      }

      let text = `🎫 <strong>${ctx.t("ticket-card-title", { id: ticket.id })}</strong>
${ctx.t(`ticket-type-${ticket.type}`)}${serverLine}

<strong>${ctx.t("ticket-card-client")}:</strong> ${ticket.userId}
<strong>${ctx.t("ticket-card-status")}:</strong> ${statusLabel}
<strong>${ctx.t("ticket-card-created")}:</strong> ${createdStr}
<strong>${ctx.t("ticket-card-responsible")}:</strong> ${responsibleStr}

📄 <strong>${ctx.t("ticket-card-description")}</strong>
${descriptionText}`;

      if (ticket.type === TicketType.WITHDRAW_REQUEST) {
        const ticketUser = await userRepo.findOne({ where: { id: ticket.userId } });
        if (ticketUser) {
          text += `\n\n<strong>${ctx.t("ticket-card-balance")}:</strong> ${ticketUser.balance} $`;
          if (payload.amount) {
            text += `\n<strong>${ctx.t("ticket-card-amount")}:</strong> ${payload.amount} $`;
          }
        }
      }

      session.other.ticketsView.currentTicketId = ticketId;
      session.other.ticketsView.pendingAction = null;
      session.other.ticketsView.pendingTicketId = null;
      session.other.ticketsView.pendingData = {};
      await ctx.editMessageText(text, {
        reply_markup: ticketViewMenu,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      Logger.error("Failed to view ticket:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle user ticket view
  bot.callbackQuery(/^ticket_user_view_(\d+)$/, async (ctx) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
        return;
      }
      const ticketId = parseInt(ctx.match[1]);
      const ticketService = new TicketService(ctx.appDataSource);
      const ticket = await ticketService.getTicketById(ticketId);

      if (!ticket || ticket.userId !== session.main.user.id) {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
        return;
      }

      let payload: Record<string, any> = {};
      try {
        payload = ticket.payload ? JSON.parse(ticket.payload) : {};
      } catch (error) {
        payload = { raw: ticket.payload || "" };
      }
      
      let result: any = null;
      if (ticket.result) {
        try {
          if (ticket.result.startsWith("{")) {
            result = JSON.parse(ticket.result);
          } else {
            result = ticket.result;
          }
        } catch (error) {
          result = ticket.result;
        }
      }

      let text = `<strong>Ticket #${ticket.id}</strong>

<strong>Type:</strong> ${ctx.t(`ticket-type-${ticket.type}`)}
<strong>Status:</strong> ${ticket.status}
<strong>Created:</strong> ${ticket.createdAt.toISOString()}`;

      if (payload && Object.keys(payload).length > 0) {
        text += `\n\n<strong>Request:</strong>\n${Object.entries(payload)
          .map(([key, value]) => `<strong>${key}:</strong> ${String(value)}`)
          .join("\n")}`;
      }

      if (result) {
        if (typeof result === "object") {
          text += `\n\n<strong>Result:</strong>\n${Object.entries(result)
            .map(([key, value]) => `<strong>${key}:</strong> ${String(value)}`)
            .join("\n")}`;
        } else {
          text += `\n\n<strong>Result:</strong> ${result}`;
        }
      }

      const keyboard = new InlineKeyboard().text(ctx.t("button-back"), "dedicated-menu-back");

      await ctx.editMessageText(text, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      Logger.error("Failed to view user ticket:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle dedicated operations
  bot.callbackQuery(/^dedicated_(reinstall|reboot|reset|other|start|stop)_(\d+)$/, async (ctx) => {
    try {
      const operation = ctx.match[1];
      const dedicatedId = parseInt(ctx.match[2]);

      const typeMap: Record<string, TicketType> = {
        reinstall: TicketType.DEDICATED_REINSTALL,
        reboot: TicketType.DEDICATED_REBOOT,
        reset: TicketType.DEDICATED_RESET,
        other: TicketType.DEDICATED_OTHER,
        start: TicketType.DEDICATED_POWER_ON,
        stop: TicketType.DEDICATED_POWER_OFF,
      };

      const type = typeMap[operation];
      if (!type) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Invalid operation" }).substring(0, 200));
        return;
      }

      // Confirm
      const keyboard = new InlineKeyboard()
        .text(ctx.t("button-agree"), `dedicated_confirm_${operation}_${dedicatedId}`)
        .text(ctx.t("button-cancel"), "dedicated-menu-back");

      await ctx.editMessageText(
        `<strong>Confirm Operation</strong>

Operation: ${ctx.t(`ticket-type-${type}`)}

Are you sure you want to proceed?`,
        {
          reply_markup: keyboard,
          parse_mode: "HTML",
        }
      );
    } catch (error: any) {
      Logger.error("Failed to handle dedicated operation:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle dedicated operation confirmation
  bot.callbackQuery(/^dedicated_confirm_(reinstall|reboot|reset|other|start|stop)_(\d+)$/, async (ctx) => {
    try {
      const operation = ctx.match[1];
      const dedicatedId = parseInt(ctx.match[2]);

      const typeMap: Record<string, TicketType> = {
        reinstall: TicketType.DEDICATED_REINSTALL,
        reboot: TicketType.DEDICATED_REBOOT,
        reset: TicketType.DEDICATED_RESET,
        other: TicketType.DEDICATED_OTHER,
        start: TicketType.DEDICATED_POWER_ON,
        stop: TicketType.DEDICATED_POWER_OFF,
      };

      const type = typeMap[operation];
      if (!type) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Invalid operation" }).substring(0, 200));
        return;
      }

      await createDedicatedOperationTicket(ctx, dedicatedId, type);
    } catch (error: any) {
      Logger.error("Failed to confirm dedicated operation:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle domain view
  bot.callbackQuery(/^domain_view_(\d+)$/, async (ctx) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
        return;
      }
      const domainId = parseInt(ctx.match[1]);
      const DomainRepository = (await import("../../infrastructure/db/repositories/DomainRepository.js")).DomainRepository;
      const domainRepo = new DomainRepository(ctx.appDataSource);
      const domain = await domainRepo.findById(domainId);

      if (!domain || domain.userId !== session.main.user.id) {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
        return;
      }

      const statusText = {
        draft: ctx.t("domain-status-draft"),
        wait_payment: ctx.t("domain-status-wait-payment"),
        registering: ctx.t("domain-status-registering"),
        registered: ctx.t("domain-status-registered"),
        failed: ctx.t("domain-status-failed"),
        expired: ctx.t("domain-status-expired"),
      }[domain.status] || domain.status;

      const text = `<strong>Domain: ${domain.domain}</strong>

<strong>Status:</strong> ${statusText}
<strong>TLD:</strong> ${domain.tld}
<strong>Period:</strong> ${domain.period} ${ctx.t("years")}
<strong>Price:</strong> ${domain.price} $
<strong>NS1:</strong> ${domain.ns1 || ctx.t("not-specified")}
<strong>NS2:</strong> ${domain.ns2 || ctx.t("not-specified")}
<strong>Created:</strong> ${domain.createdAt.toISOString()}`;

      const menu = createDomainViewMenu(domainId);
      bot.use(menu);

      await ctx.editMessageText(text, {
        reply_markup: menu,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      Logger.error("Failed to view domain:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle domain update NS button (from manage services or amper domains menu)
  bot.callbackQuery(/^domain_update_ns_(\d+)$/, async (ctx) => {
    const domainId = parseInt(ctx.match[1]);
    try {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = (await ctx.session) as any;
      if (!session) {
        const text =
          typeof (ctx as any).t === "function"
            ? ctx.t("error-unknown", { error: "Session not initialized" })
            : "Error: Session not initialized";
        await ctx.reply(text);
        return;
      }
      await ensureSessionUser(ctx);
      if (!session.other) {
        (session as any).other = createInitialOtherSession();
      }
      session.other.currentDomainId = domainId;
      const telegramId = Number(ctx.from?.id ?? ctx.chatId ?? 0);
      if (telegramId > 0) {
        setPendingDomainNsUpdate(telegramId, domainId);
      }

      await ctx.conversation.enter("domainUpdateNsConversation");
    } catch (error: any) {
      Logger.error("Failed to handle domain update NS:", error);
      const text =
        typeof (ctx as any).t === "function"
          ? ctx.t("error-unknown", { error: error?.message ?? "Unknown error" })
          : `Error: ${String(error?.message ?? "Unknown error")}`;
      await ctx.reply(text).catch(() => {});
    }
  });

  // Add domain from Amper to "Услуги" (when "already owned by you")
  bot.callbackQuery(/^domain_import_(.+)$/, async (ctx) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
        return;
      }
      const domainEnc = ctx.match[1];
      const domain = domainEnc.replace(/_/g, ".");
      const userId = session.main.user.id;

      const DomainRepository = (await import("../../infrastructure/db/repositories/DomainRepository.js")).DomainRepository;
      const UserRepository = (await import("../../infrastructure/db/repositories/UserRepository.js")).UserRepository;
      const TopUpRepository = (await import("../../infrastructure/db/repositories/TopUpRepository.js")).TopUpRepository;
      const BillingService = (await import("../../domain/billing/BillingService.js")).BillingService;
      const AmperDomainsProvider = (await import("../../infrastructure/domains/AmperDomainsProvider.js")).AmperDomainsProvider;
      const AmperDomainService = (await import("../../domain/services/AmperDomainService.js")).AmperDomainService;

      const domainRepo = new DomainRepository(ctx.appDataSource);
      const userRepo = new UserRepository(ctx.appDataSource);
      const topUpRepo = new TopUpRepository(ctx.appDataSource);
      const billingService = new BillingService(ctx.appDataSource, userRepo, topUpRepo);
      const provider = new AmperDomainsProvider({
        apiBaseUrl: process.env.AMPER_API_BASE_URL || "",
        apiToken: process.env.AMPER_API_TOKEN || "",
        timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
        defaultNs1: process.env.DEFAULT_NS1,
        defaultNs2: process.env.DEFAULT_NS2,
      });
      const domainService = new AmperDomainService(ctx.appDataSource, domainRepo, billingService, provider);

      const telegramId = ctx.from?.id;
      const imported = await domainService.importDomainFromAmper(userId, domain, telegramId);
      if (imported) {
        await ctx.answerCallbackQuery();
        await safeEditMessageText(
          ctx,
          ctx.t("domain-import-success", { domain: imported.domain }),
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.answerCallbackQuery({ text: ctx.t("domain-import-not-found").substring(0, 200), show_alert: true });
        await safeEditMessageText(ctx, ctx.t("domain-import-not-found"), { parse_mode: "HTML" });
      }
    } catch (error: any) {
      Logger.error("Failed to import domain from Amper:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Handle domain renew confirmation
  bot.callbackQuery(/^domain_renew_confirm_(\d+)$/, async (ctx) => {
    try {
      const session = await ctx.session;
      const hasSessionUser = await ensureSessionUser(ctx);
      if (!session || !hasSessionUser) {
        await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
        return;
      }
      const domainId = parseInt(ctx.match[1]);
      const DomainRepository = (await import("../../infrastructure/db/repositories/DomainRepository.js")).DomainRepository;
      const UserRepository = (await import("../../infrastructure/db/repositories/UserRepository.js")).UserRepository;
      const TopUpRepository = (await import("../../infrastructure/db/repositories/TopUpRepository.js")).TopUpRepository;
      const BillingService = (await import("../../domain/billing/BillingService.js")).BillingService;
      const AmperDomainsProvider = (await import("../../infrastructure/domains/AmperDomainsProvider.js")).AmperDomainsProvider;
      const AmperDomainService = (await import("../../domain/services/AmperDomainService.js")).AmperDomainService;

      const domainRepo = new DomainRepository(ctx.appDataSource);
      const userRepo = new UserRepository(ctx.appDataSource);
      const topUpRepo = new TopUpRepository(ctx.appDataSource);
      const billingService = new BillingService(ctx.appDataSource, userRepo, topUpRepo);

      const config = {
        apiBaseUrl: process.env.AMPER_API_BASE_URL || "",
        apiToken: process.env.AMPER_API_TOKEN || "",
        timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
        defaultNs1: process.env.DEFAULT_NS1,
        defaultNs2: process.env.DEFAULT_NS2,
      };

      const provider = new AmperDomainsProvider(config);
      const domainService = new AmperDomainService(
        ctx.appDataSource,
        domainRepo,
        billingService,
        provider
      );

      const domain = await domainService.getDomainById(domainId);

      if (domain.userId !== session.main.user.id) {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
        return;
      }

      await ctx.editMessageText(ctx.t("domain-renewing", { domain: domain.domain }));

      try {
        await domainService.renewDomain(domainId);
        await ctx.editMessageText(ctx.t("domain-renewed", {
          domain: domain.domain,
        }), {
          parse_mode: "HTML",
        });
      } catch (error: any) {
        Logger.error(`Failed to renew domain ${domainId}:`, error);
        await ctx.editMessageText(ctx.t("error-unknown", {
          error: error.message || "Unknown error",
        }));
      }
    } catch (error: any) {
      Logger.error("Failed to renew domain:", error);
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200));
    }
  });

  // Prime trial callbacks are handled in index.ts by a single early middleware that calls
  // handlePrimeActivateTrial and handlePrimeISubscribed so they run before conversations/menus.

  // Handle amper domains menu back
  bot.callbackQuery("amper-domains-menu-back", async (ctx) => {
    await ctx.answerCallbackQuery();
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      return;
    }
    const renderer = (await import("../screens/renderer.js")).ScreenRenderer.fromContext(ctx);
    const screen = renderer.renderWelcome({
      balance: session.main.user.balance,
    });

    const { getReplyMainMenu } = await import("../menus/main-menu-registry.js");
    await ctx.editMessageText(screen.text, {
      reply_markup: await getReplyMainMenu(),
      parse_mode: screen.parse_mode,
    });
  });

  // Back to manage services menu from domain info
  bot.callbackQuery("manage-services-menu-back", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery(
        ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200)
      );
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    const { openVdsManageServicesListScreen } = await import("../../helpers/manage-services.js");
    await openVdsManageServicesListScreen(ctx as AppContext);
  });

  bot.callbackQuery("maintenance-close", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
  });

  // Handle dedicated menu back
  bot.callbackQuery("dedicated-menu-back", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
      return;
    }
    const { dedicatedMenu } = await import("../menus/dedicated-menu.js");
    await ctx.editMessageText(ctx.t("dedicated-menu-header"), {
      reply_markup: dedicatedMenu,
      parse_mode: "HTML",
    });
  });

  // Handle moderator menu back
  bot.callbackQuery("moderator-menu-back", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
      return;
    }
    const renderer = (await import("../screens/renderer.js")).ScreenRenderer.fromContext(ctx);
    const screen = renderer.renderWelcome({
      balance: session.main.user.balance,
    });

    const { getReplyMainMenu } = await import("../menus/main-menu-registry.js");
    await ctx.editMessageText(screen.text, {
      reply_markup: await getReplyMainMenu(),
      parse_mode: screen.parse_mode,
    });
  });

  bot.callbackQuery("tickets-menu-back", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200));
      return;
    }
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      return;
    }

    if (session.main.user.role === Role.Admin) {
      const { adminMenu } = await import("../menus/admin-menu.js");
      await ctx.editMessageText(ctx.t("admin-panel-header"), {
        reply_markup: adminMenu,
        parse_mode: "HTML",
      });
      return;
    }

    await ctx.editMessageText(ctx.t("moderator-menu-header"), {
      reply_markup: moderatorMenu,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("prov_tickets", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      return;
    }
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    const [cntOpen, cntInProgress, cntWaiting, cntDone] = await Promise.all([
      service.countTicketsByStatus(ProvisioningTicketStatus.OPEN),
      service.countTicketsByStatus(ProvisioningTicketStatus.IN_PROGRESS),
      service.countTicketsByStatus(ProvisioningTicketStatus.WAITING),
      service.countTicketsByStatus(ProvisioningTicketStatus.DONE),
    ]);
    const stats = {
      open: cntOpen,
      inProgress: cntInProgress,
      waiting: cntWaiting,
      done: cntDone,
      total: cntOpen + cntInProgress + cntWaiting + cntDone,
    };

    await ctx.editMessageText(formatProvisioningQueueSummary(ctx, stats), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text(ctx.t("ticket-status-open"), "prov_list_open")
        .text(ctx.t("ticket-status-in_progress"), "prov_list_in_progress")
        .row()
        .text(ctx.t("ticket-status-waiting"), "prov_list_waiting")
        .text(ctx.t("ticket-status-done"), "prov_list_done")
        .row()
        .text(ctx.t("button-back"), "tickets-menu-back"),
    });
  });

  bot.callbackQuery(/^prov_list_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      return;
    }
    const status = toProvisioningStatus(ctx.match[1]);
    if (!status) return;
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    const tickets = await service.listTicketsByStatus(status, 20);
    if (tickets.length === 0) {
      await ctx.editMessageText(renderMultiline(ctx.t("provisioning-list-empty", { status: formatProvisioningStatus(ctx, status) })), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(ctx.t("button-back"), "prov_tickets"),
      });
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of tickets.slice(0, 10)) {
      const order = await service.getOrderById(t.orderId);
      const server = (order?.productName || "server").slice(0, 18);
      const userId = order?.userId ?? "—";
      const label = `#${t.id} • U${userId} • ${server}`;
      kb.text(label.slice(0, 62), `prov_view_${t.id}`).row();
    }
    kb.text(ctx.t("button-back"), "prov_tickets");
    await ctx.editMessageText(renderMultiline(ctx.t("provisioning-list-title", { status: formatProvisioningStatus(ctx, status), count: tickets.length })), {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^prov_view_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      return;
    }
    const ticketId = Number(ctx.match[1]);
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    const ticket = await service.getTicketById(ticketId);
    if (!ticket) return;
    const order = await service.getOrderById(ticket.orderId);
    if (!order) return;
    const checklist = await service.getChecklist(ticket.id);
    const notes = await service.listRecentNotes(ticket.id, 3);
    const checked = checklist.filter((x) => x.isChecked).length;
    const total = checklist.length || PROVISIONING_CHECKLIST_KEYS.length;
    const noteLine = notes.length
      ? `\n\n📝 ${ctx.t("provisioning-latest-note")}: ${escapeUserInput(notes[0].text).slice(0, 220)}`
      : "";
    const text = renderMultiline(ctx.t("provisioning-ticket-view", {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      orderNumber: order.orderNumber,
      status: formatProvisioningStatus(ctx, ticket.status),
      assignee: ticket.assigneeUserId ?? ctx.t("ticket-card-responsible-none"),
      userId: order.userId,
      amount: order.paymentAmount,
      currency: order.currency,
      serviceName: order.productName,
      location: order.locationLabel ?? "—",
      os: order.osLabel ?? "—",
      checklist: `${checked}/${total}`,
      createdAt: ticket.createdAt.toISOString(),
    })) + noteLine;
    const kb = provisioningTicketKeyboard(ctx, ticket.id)
      .row()
      .text(ctx.t("provisioning-checklist-open"), `prov_checklist_${ticket.id}`)
      .text(ctx.t("button-back"), "prov_tickets");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery(/^prov_take_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) return;
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    await service.assignTicket(Number(ctx.match[1]), session.main.user.id, session.main.user.id);
    await ctx.answerCallbackQuery(ctx.t("ticket-taken").substring(0, 200)).catch(() => {});
    await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery!.message!.message_id).catch(() => {});
    await ctx.api.sendMessage(ctx.chat!.id, ctx.t("provisioning-assigned-refresh"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ctx.t("button-open"), `prov_view_${Number(ctx.match[1])}`),
    }).catch(() => {});
  });

  bot.callbackQuery(/^prov_status_(\d+)_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) return;
    const ticketId = Number(ctx.match[1]);
    const status = toProvisioningStatus(ctx.match[2]);
    if (!status) return;
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    await service.updateStatus(ticketId, status, session.main.user.id);
    await ctx.answerCallbackQuery(ctx.t("provisioning-status-updated").substring(0, 200)).catch(() => {});
    await ctx.api.sendMessage(ctx.chat!.id, ctx.t("provisioning-status-updated"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ctx.t("button-open"), `prov_view_${ticketId}`),
    }).catch(() => {});
  });

  bot.callbackQuery(/^prov_checklist_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const ticketId = Number(ctx.match[1]);
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    const rows = await service.getChecklist(ticketId);
    const kb = new InlineKeyboard();
    for (const row of rows) {
      kb.text(`${row.isChecked ? "✅" : "☑️"} ${row.key}`.slice(0, 62), `prov_check_${ticketId}_${row.key}_${row.isChecked ? "0" : "1"}`).row();
    }
    kb.text(ctx.t("button-back"), `prov_view_${ticketId}`);
    await ctx.editMessageText(ctx.t("provisioning-checklist-title", { ticketId }), {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^prov_check_(\d+)_(.+)_(0|1)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (session.main.user.role !== Role.Moderator && session.main.user.role !== Role.Admin) return;
    const ticketId = Number(ctx.match[1]);
    const key = ctx.match[2];
    const isChecked = ctx.match[3] === "1";
    const service = new DedicatedProvisioningService(ctx.appDataSource);
    await service.setChecklistItem(ticketId, key, isChecked, session.main.user.id);
    if (isChecked && key === "ticket_completed") {
      await service.updateStatus(ticketId, ProvisioningTicketStatus.DONE, session.main.user.id, "checklist_completed");
    }
    await ctx.api.sendMessage(ctx.chat!.id, ctx.t("provisioning-checklist-updated"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ctx.t("provisioning-checklist-open"), `prov_checklist_${ticketId}`),
    }).catch(() => {});
  });

  bot.callbackQuery(/^prov_note_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.other.ticketsView.pendingAction = "provisioning_note";
    session.other.ticketsView.pendingTicketId = Number(ctx.match[1]);
    session.other.ticketsView.pendingData = {};
    await ctx.reply(ctx.t("provisioning-note-enter"), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^prov_complete_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.other.ticketsView.pendingAction = "provisioning_complete_message";
    session.other.ticketsView.pendingTicketId = Number(ctx.match[1]);
    session.other.ticketsView.pendingData = {};
    await ctx.reply(renderMultiline(ctx.t("provisioning-complete-enter-message")), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^ticket_notify_close_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch (error) {
      // Ignore if already deleted
    }
  });
}
