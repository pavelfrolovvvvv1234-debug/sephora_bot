/**
 * Bot commands registration.
 *
 * @module ui/commands
 */

import type { Bot } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import User, { Role } from "../../entities/User.js";
import { profileMenu } from "../menus/profile-menu.js";
import { topupMethodMenu } from "../../helpers/deposit-money.js";
import { adminMenu } from "../menus/admin-menu";
import { ScreenRenderer } from "../screens/renderer.js";
import { InlineKeyboard } from "grammy";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { VdsRepository } from "../../infrastructure/db/repositories/VdsRepository.js";
import { DomainRequestRepository } from "../../infrastructure/db/repositories/DomainRequestRepository.js";
import { PromoRepository } from "../../infrastructure/db/repositories/PromoRepository.js";
import DomainRequest, { DomainRequestStatus } from "../../entities/DomainRequest.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import { Logger } from "../../app/logger.js";
import { config, getAdminTelegramIds } from "../../app/config.js";
import ms from "../../lib/multims.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { BroadcastService } from "../../domain/broadcast/BroadcastService.js";

import { PREFIX_PROMOTE } from "../../helpers/promote-permissions.js";
import TempLink, { createLink } from "../../entities/TempLink.js";
import Promo from "../../entities/Promo.js";

// Track registered bots to prevent duplicate registration
const registeredBots = new WeakSet<Bot<AppContext>>();
// Track processed updates to prevent duplicate execution
const processedUpdates = new Set<string>();

/**
 * Register all bot commands.
 */
export function registerCommands(bot: Bot<AppContext>): void {
  // Prevent duplicate registration for the same bot instance
  if (registeredBots.has(bot)) {
    console.warn("[Commands] registerCommands called multiple times for the same bot, skipping");
    return;
  }
  registeredBots.add(bot);
  
  // Register bot commands in Telegram menu
  bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "balance", description: "Проверить баланс" },
    { command: "services", description: "Управление услугами" },
  ]).catch((error) => {
    Logger.error("Failed to set bot commands:", error);
  });

  // Bot profile: name and descriptions (visible in @ mention and profile)
  bot.api.setMyName("Sephora Host").catch((error) => {
    Logger.error("Failed to set bot name:", error);
  });
  bot.api
    .setMyShortDescription("Bulletproof VPS, domains & dedicated servers — order and manage hosting in TG. 24/7.")
    .catch((error) => {
      Logger.error("Failed to set bot short description:", error);
    });
  bot.api
    .setMyDescription("Welcome to Sephora Host!\n\nBulletproof VPS, domains and dedicated servers — order and manage hosting in TG. 24/7 support, offshore, reliable infrastructure.\n\nPress /start to begin.")
    .catch((error) => {
      Logger.error("Failed to set bot description:", error);
    });

  // Start command
  bot.command("start", async (ctx) => {
    // Create unique key for this update to prevent duplicate processing
    const updateKey = `${ctx.update.update_id}_${ctx.chatId}_start`;
    if (processedUpdates.has(updateKey)) {
      console.warn("[Commands] Duplicate /start command detected, ignoring");
      return;
    }
    processedUpdates.add(updateKey);
    
    // Clean up old processed updates (keep only last 100)
    if (processedUpdates.size > 100) {
      const firstKey = processedUpdates.values().next().value;
      if (firstKey !== undefined) processedUpdates.delete(firstKey);
    }
    // Check if this is a promote link - if so, let promotePermissions middleware handle it
    if (ctx.match && typeof ctx.match === "string" && ctx.match.startsWith("promote_")) {
      // Let promotePermissions middleware handle it first, but don't continue
      return;
    }
    
    // Delete the command message if it exists
    try {
      if (ctx.message) {
        await ctx.deleteMessage();
      }
    } catch (error) {
      // Ignore if message already deleted
    }

    const session = await ctx.session;
    
    // Handle referral code from /start payload (for new users)
    if (ctx.match && typeof ctx.match === "string" && ctx.match.length > 0) {
      // Check if this is not a promote link
      if (!ctx.match.startsWith("promote_")) {
        try {
          const { ReferralService } = await import("../../domain/referral/ReferralService.js");
          const { UserRepository } = await import("../../infrastructure/db/repositories/UserRepository.js");
          const userRepo = new UserRepository(ctx.appDataSource);
          const referralService = new ReferralService(ctx.appDataSource, userRepo);
          
          // Only bind if user is new (doesn't have referrer yet)
          const user = await userRepo.findById(session.main.user.id);
          if (user && !user.referrerId) {
            const bound = await referralService.bindReferrer(user.id, ctx.match);
            if (bound) {
              console.log(`[Referral] Bound referrer for user ${user.id} with refCode ${ctx.match}`);
              const referrerTelegramId = parseInt(ctx.match, 10);
              if (!Number.isNaN(referrerTelegramId)) {
                const referrer = await userRepo.findByTelegramId(referrerTelegramId);
                if (referrer) {
                  const referrerLang = referrer.lang === "en" ? "en" : "ru";
                  const referralsCount = await referralService.countReferrals(referrer.id);
                  const { notifyReferrerAboutNewSignup } = await import("../../helpers/notifier.js");
                  await notifyReferrerAboutNewSignup(
                    ctx.api,
                    referrer.telegramId,
                    referrerLang,
                    referralsCount
                  );
                }
              }
            }
          }
        } catch (error: any) {
          console.error(`[Referral] Failed to bind referrer:`, error);
          // Don't fail the request if referral binding fails
        }
      }
    }
    
    // If locale is not set (first time user), show language selection
    if (session.main.locale === "0" || !session.main.locale) {
      // Use default locale for the selection message
      ctx.fluent.useLocale("ru");
      const { languageSelectMenu } = await import("../menus/language-select-menu.js");
      await ctx.reply(ctx.t("select-language"), {
        reply_markup: languageSelectMenu,
        parse_mode: "HTML",
      });
      return;
    }

    const renderer = ScreenRenderer.fromContext(ctx);
    const screen = renderer.renderWelcome({
      balance: session.main.user.balance,
    });

    const { getReplyMainMenu } = await import("../menus/main-menu-registry.js");
    await ctx.reply(screen.text, {
      reply_markup: await getReplyMainMenu(),
      parse_mode: screen.parse_mode,
    });
  });

  // Balance command - open deposit menu for balance top-up
  bot.command("balance", async (ctx) => {
    try {
      if (ctx.message) {
        await ctx.deleteMessage().catch(() => {});
      }

      const session = await ctx.session;
      session.other.deposit.prefilledAmount = false;
      session.other.deposit.selectedAmount = 50;
      session.main.lastSumDepositsEntered = 0;
      
      if (!ctx.hasChatType("private")) {
        return;
      }

      // Open deposit menu for balance top-up
      await ctx.reply(ctx.t("topup-select-method"), {
        reply_markup: topupMethodMenu,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      Logger.error("Failed to execute /balance command:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Services command — сразу список тарифов VPS
  bot.command("services", async (ctx) => {
    try {
      if (ctx.message) {
        await ctx.deleteMessage().catch(() => {});
      }

      const { openVpsTariffSelection } = await import("../../domain/vds/vds-shop-flow.js");
      await openVpsTariffSelection(ctx as AppContext);
    } catch (error: any) {
      Logger.error("Failed to execute /services command:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Help command (admin only)
  bot.command("help", async (ctx) => {
    const session = await ctx.session;

    if (session.main.user.role === Role.Admin) {
      await ctx.reply(ctx.t("admin-help"), {
        parse_mode: "HTML",
      });
    }
  });

  // Admin panel command (admin only) — check ONLY by DB, ignore session
  bot.command("admin", async (ctx) => {
    try {
      const telegramId = ctx.chatId ?? ctx.from?.id;
      if (!telegramId) {
        await ctx.reply(ctx.t("error-access-denied"));
        return;
      }
      const { getAppDataSource } = await import("../../infrastructure/db/datasource.js");
      const dataSource = ctx.appDataSource ?? (await getAppDataSource());
      const dbUser = await dataSource.manager.findOneBy(User, {
        telegramId: Number(telegramId),
      });
      const roleStr = dbUser ? String(dbUser.role).toLowerCase() : "";
      const adminIds = getAdminTelegramIds();
      const isAdmin = (dbUser && (roleStr === "admin" || dbUser.role === Role.Admin)) || adminIds.includes(Number(telegramId));
      if (!isAdmin) {
        await ctx.reply(ctx.t("error-access-denied"));
        return;
      }
      if (dbUser && adminIds.includes(Number(telegramId)) && dbUser.role !== Role.Admin) {
        dbUser.role = Role.Admin;
        await dataSource.manager.save(dbUser);
      }
      const session = await ctx.session;
      if (session?.main?.user) {
        session.main.user.role = Role.Admin;
        session.main.user.status = dbUser?.status ?? session.main.user.status;
        session.main.user.id = dbUser?.id ?? 0;
        session.main.user.balance = dbUser?.balance ?? 0;
        session.main.user.referralBalance = dbUser?.referralBalance ?? 0;
        session.main.user.isBanned = dbUser?.isBanned ?? false;
      }
      await ctx.reply(ctx.t("admin-panel-header"), {
        parse_mode: "HTML",
        reply_markup: adminMenu,
      });
    } catch (error: any) {
      Logger.error("[Admin] Failed to open admin menu:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Broadcast command (admin only)
  bot.command("broadcast", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.reply(ctx.t("error-unknown", { error: "Session not initialized" }));
      return;
    }

    if (session.main.user.role !== Role.Admin) {
      return;
    }

    session.other.broadcast = {
      step: "awaiting_text",
    };
    await ctx.reply(ctx.t("broadcast-enter-text"));
  });

  // Send broadcast immediately (admin only)
  bot.command("send", async (ctx) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      await ctx.reply(ctx.t("error-unknown", { error: "Session not initialized" }));
      return;
    }

    if (session.main.user.role !== Role.Admin) {
      return;
    }

    const text = ctx.message?.text?.split(" ").slice(1).join(" ").trim() || "";
    if (text.length === 0) {
      session.other.broadcast = { step: "awaiting_text" };
      await ctx.reply(ctx.t("broadcast-enter-text"), { parse_mode: "HTML" });
      return;
    }

    try {
      const broadcastService = new BroadcastService(ctx.appDataSource, bot as unknown as Bot);
      const broadcast = await broadcastService.createBroadcast(session.main.user.id, text);

      const statusMessage = await ctx.reply(
        ctx.t("broadcast-starting", { id: broadcast.id })
      );

      broadcastService
        .sendBroadcast(broadcast.id)
        .then(async (result) => {
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

            await ctx.api.editMessageText(
              ctx.chatId,
              statusMessage.message_id,
              completedText,
              { parse_mode: "HTML" }
            );
          } catch (error) {
            Logger.warn("Failed to update broadcast status:", error);
          }
        })
        .catch((error) => {
          Logger.error("Broadcast failed:", error);
        });
    } catch (error) {
      Logger.error("Failed to start broadcast:", error);
      await ctx.reply(
        ctx.t("error-unknown", {
          error: (error as Error)?.message || "Unknown error",
        }).substring(0, 200)
      );
    }
  });

  // Domain requests command (admin/moderator)
  bot.command("domainrequests", async (ctx) => {
    const session = await ctx.session;
    if (
      session.main.user.role !== Role.Admin &&
      session.main.user.role !== Role.Moderator
    ) {
      return;
    }

    const dataSource = await getAppDataSource();
    const domainRequestRepo = new DomainRequestRepository(dataSource);

    const requests = await domainRequestRepo.findPending();

    if (requests.length > 0) {
      const text = `${ctx.t("domain-request-list-header")}\n${requests
        .map((request: DomainRequest) =>
          ctx.t("domain-request", {
            id: request.id,
            targetId: request.target_user_id,
            domain: `${request.domainName}${request.zone}`,
            info: request.additionalInformation || ctx.t("empty"),
          })
        )
        .join("\n")}\n\n${ctx.t("domain-request-list-info")}`;

      await ctx.reply(text, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(
        `${ctx.t("domain-request-list-header")}\n${ctx.t("list-empty")}`,
        {
          parse_mode: "HTML",
        }
      );
    }
  });

  // Promote link command (admin only)
  bot.command("promote_link", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Admin) return;

    const dataSource = await getAppDataSource();
    const link = createLink(Role.Moderator);
    const savedLink = await dataSource.getRepository(TempLink).save(link);

    const linkUrl = `tg://msg_url?url=https://t.me/${config.BOT_USERNAME}?start=${PREFIX_PROMOTE}${savedLink.code}`;

    await ctx.reply(ctx.t("promote-link"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url(
        ctx.t("button-send-promote-link"),
        linkUrl
      ),
    });
  });

  // Create promo command (admin only)
  bot.command("create_promo", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Admin) return;

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 3) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [name, sumStr, maxUsesStr] = args;
    const sum = Number.parseFloat(sumStr);
    const maxUses = Number.parseInt(maxUsesStr, 10);

    if (!name || isNaN(sum) || isNaN(maxUses)) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const promoRepo = new PromoRepository(dataSource);

    const existingPromo = await promoRepo.findByCode(name);

    if (existingPromo) {
      await ctx.reply(ctx.t("promocode-already-exist"), {
        parse_mode: "HTML",
      });
      return;
    }

    const newPromo = new Promo();
    newPromo.code = name.toLowerCase();
    newPromo.maxUses = maxUses;
    newPromo.sum = sum;
    newPromo.uses = 0;
    newPromo.users = [];

    await promoRepo.save(newPromo);

    await ctx.reply(ctx.t("new-promo-created"), {
      parse_mode: "HTML",
    });
  });

  // Promo codes list command (admin only)
  bot.command("promo_codes", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Admin) return;

    const dataSource = await getAppDataSource();
    const promoRepo = new PromoRepository(dataSource);

    const promos = await promoRepo.findAll();

    let promocodeList: string;
    if (promos.length === 0) {
      promocodeList = ctx.t("list-empty");
    } else {
      promocodeList = promos
        .map((promo) =>
          ctx.t("promocode", {
            id: promo.id,
            name: promo.code.toLowerCase(),
            use: promo.uses,
            maxUses: promo.maxUses,
            amount: promo.sum,
          })
        )
        .join("\n");
    }

    await ctx.reply(promocodeList, {
      parse_mode: "HTML",
    });
  });

  // Remove promo command (admin only)
  bot.command("remove_promo", async (ctx) => {
    const session = await ctx.session;
    if (session.main.user.role !== Role.Admin) return;

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [idStr] = args;
    const id = Number.parseInt(idStr, 10);

    if (isNaN(id)) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const promoRepo = new PromoRepository(dataSource);

    const promo = await promoRepo.findById(id);

    if (!promo) {
      await ctx.reply(ctx.t("promocode-not-found"), {
        parse_mode: "HTML",
      });
      return;
    }

    await promoRepo.deleteById(id);

    await ctx.reply(
      ctx.t("promocode-deleted", {
        name: promo.code,
      }),
      {
        parse_mode: "HTML",
      }
    );
  });

  // Approve domain command (admin/moderator)
  bot.command("approve_domain", async (ctx) => {
    const session = await ctx.session;
    if (
      session.main.user.role !== Role.Admin &&
      session.main.user.role !== Role.Moderator
    ) {
      return;
    }

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 2) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [idStr, expireAtStr] = args;
    const id = Number.parseInt(idStr, 10);
    const expireAtMs = ms(expireAtStr);

    if (isNaN(id) || !expireAtMs) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const domainRequestRepo = new DomainRequestRepository(dataSource);

    const request = await domainRequestRepo.findById(id);

    if (!request || request.status !== DomainRequestStatus.InProgress) {
      await ctx.reply(ctx.t("domain-request-not-found"), {
        parse_mode: "HTML",
      });
      return;
    }

    const expireAt = new Date(Date.now() + expireAtMs);
    const paydayAt = new Date(expireAt.getTime() - ms("7d"));

    await domainRequestRepo.approve(id, expireAt, paydayAt);

    await ctx.reply(ctx.t("domain-request-approved"), {
      parse_mode: "HTML",
    });
  });

  // Show VDS command (admin/moderator)
  bot.command("showvds", async (ctx) => {
    const session = await ctx.session;
    if (
      session.main.user.role !== Role.Admin &&
      session.main.user.role !== Role.Moderator
    ) {
      return;
    }

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [userIdStr] = args;
    const userId = Number.parseInt(userIdStr, 10);

    if (isNaN(userId)) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const vdsRepo = new VdsRepository(dataSource);

    const vdsList = await vdsRepo.findByUserId(userId);

    if (vdsList.length === 0) {
      await ctx.reply(ctx.t("no-vds-found"), {
        parse_mode: "HTML",
      });
      return;
    }

    const vdsInfo = vdsList
      .map((vds) =>
        ctx.t("vds-info-admin", {
          id: vds.id,
          ip: vds.ipv4Addr || "N/A",
          expireAt: vds.expireAt.toISOString(),
          renewalPrice: vds.renewalPrice,
        })
      )
      .join("\n");

    await ctx.reply(vdsInfo, {
      parse_mode: "HTML",
    });
  });

  // Remove VDS command (admin/moderator)
  bot.command("removevds", async (ctx) => {
    const session = await ctx.session;
    if (
      session.main.user.role !== Role.Admin &&
      session.main.user.role !== Role.Moderator
    ) {
      return;
    }

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [idVdsStr] = args;
    const idVds = Number.parseInt(idVdsStr, 10);

    if (isNaN(idVds)) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const vdsRepo = new VdsRepository(dataSource);

    const vds = await vdsRepo.findById(idVds);

    if (!vds) {
      await ctx.reply(ctx.t("vds-not-found"), {
        parse_mode: "HTML",
      });
      return;
    }

    // Delete VM with retry
    let deleted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await ctx.vmmanager.deleteVM(vds.vdsId);
        if (result) {
          deleted = true;
          break;
        }
      } catch (error) {
        Logger.error(`Failed to delete VM ${vds.vdsId} (attempt ${attempt + 1})`, error);
      }
    }

    if (!deleted) {
      await ctx.reply(
        ctx.t("vds-remove-failed", { id: idVds }),
        {
          parse_mode: "HTML",
        }
      );
      return;
    }

    await vdsRepo.deleteById(idVds);

    await ctx.reply(ctx.t("vds-removed", { id: idVds }), {
      parse_mode: "HTML",
    });
  });

  // Reject domain command (admin/moderator)
  bot.command("reject_domain", async (ctx) => {
    const session = await ctx.session;
    if (
      session.main.user.role !== Role.Admin &&
      session.main.user.role !== Role.Moderator
    ) {
      return;
    }

    const args = (ctx.match || "").trim().split(/\s+/).filter(Boolean);

    if (args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const [idStr] = args;
    const id = Number.parseInt(idStr, 10);

    if (isNaN(id)) {
      await ctx.reply(ctx.t("invalid-arguments"), {
        parse_mode: "HTML",
      });
      return;
    }

    const dataSource = await getAppDataSource();
    const domainRequestRepo = new DomainRequestRepository(dataSource);
    const userRepo = new UserRepository(dataSource);

    const request = await domainRequestRepo.findById(id);

    if (!request || request.status !== DomainRequestStatus.InProgress) {
      await ctx.reply(ctx.t("domain-request-not-found"), {
        parse_mode: "HTML",
      });
      return;
    }

    // Reject and refund in transaction
    await dataSource.transaction(async (manager) => {
      const domainManager = manager.getRepository(DomainRequest);
      const userManager = manager.getRepository(User);

      const user = await userManager.findOne({
        where: { id: request.target_user_id },
      });

      if (user) {
        user.balance += request.price;
        await userManager.save(user);
      }

      request.status = DomainRequestStatus.Failed;
      await domainManager.save(request);
    });

    await ctx.reply(ctx.t("domain-request-reject"), {
      parse_mode: "HTML",
    });
  });

  // Users command (admin/moderator)
  bot.command("users", async (ctx) => {
    if (ctx.message) {
      await ctx.deleteMessage();
    }

    const session = await ctx.session;
    if (session.main.user.role === Role.User) return;

    try {
      const { controlUsers } = await import("../../helpers/users-control");
      await ctx.reply(ctx.t("control-panel-users"), {
        parse_mode: "HTML",
        reply_markup: controlUsers,
      });
    } catch (error: any) {
      Logger.error("Failed to open control users menu:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  Logger.info("Commands registered");
}
