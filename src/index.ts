import "reflect-metadata";
import {
  Api,
  Bot,
  Context,
  LazySessionFlavor,
  MemorySessionStorage,
  RawApi,
  session,
  webhookCallback,
} from "grammy";
import dotenv from "dotenv";
import path from "path";
import { FluentContextFlavor, useFluent } from "@grammyjs/fluent";
import { initFluent } from "./fluent";
import { FileAdapter } from "@grammyjs/storage-file";
import { Menu, MenuFlavor } from "@grammyjs/menu";
import { DataSource, MoreThan, MoreThanOrEqual } from "typeorm";
import { getAppDataSource } from "./infrastructure/db/datasource.js";
import { getAdminTelegramIds, getPrimeChannelForCheck } from "./app/config";
import User, { Role, UserStatus } from "./entities/User";
import { createLink } from "./entities/TempLink";
import {
  PREFIX_PROMOTE,
  promotePermissions,
} from "./helpers/promote-permissions";
import {
  buildControlPanelUserReply,
  buildReferralSummaryReply,
  controlUser,
  controlUserBalance,
  controlUserServices,
  controlUserServicesAdd,
  controlUserServicesDelete,
  controlUsers,
  controlUserStatus,
  controlUserSubscription,
  registerAdminServiceManagementCallbacks,
} from "./helpers/users-control";
import express, { type Request, type Response } from "express";
import { run as grammyRun } from "@grammyjs/runner";
import { adminMenu, openResellerDetails, openResellerPanel, openResellerServicesList } from "./ui/menus/admin-menu";
import { ticketViewMenu } from "./ui/menus/moderator-menu";
import { moderatorMenu } from "./ui/menus/moderator-menu";
import {
  registerBroadcastAndTickets,
  handlePrimeActivateTrial,
  handlePrimeISubscribed,
} from "./ui/integration/broadcast-tickets-integration";
import { BroadcastService } from "./domain/broadcast/BroadcastService";
import { Logger } from "./app/logger";
import {
  adminPromosMenu,
  registerAdminPromosHandlers,
} from "./ui/menus/admin-promocodes-menu.js";
import { adminAutomationsMenu } from "./ui/menus/admin-automations-menu.js";
import {
  domainOrderMenu,
  domainsMenu,
  servicesMenu,
  vdsMenu,
  vdsRateChoose,
  vdsRateOs,
  dedicatedTypeMenu,
  vdsTypeMenu,
  dedicatedServersMenu,
  dedicatedSelectedServerMenu,
  dedicatedLocationMenu,
  dedicatedOsMenu,
  handleDedicatedOsSelect,
  openCdnPurchaseFromServicesMenu,
} from "./helpers/services-menu";
import {
  handlePendingVdsManageInput,
  renameVdsConversation,
  vdsPasswordManualConversation,
  openVdsManageServicesListScreen,
} from "./helpers/manage-services";
import {
  depositMenu,
  depositMoneyConversation,
  depositPaymentSystemChoose,
  renderTopupAmountsText,
  topupMethodMenu,
} from "./helpers/deposit-money";
// Admin menu will be loaded dynamically to avoid circular dependencies
// Import language select menu - will be loaded dynamically in /start command
import {
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { domainRegisterConversation } from "./ui/conversations/domain-register-conversation";
import { domainUpdateNsConversation } from "./ui/conversations/domain-update-ns-conversation";
import { withdrawRequestConversation } from "./ui/conversations/withdraw-conversation";
import { registerPromoConversations } from "./ui/conversations/admin-promocodes-conversations.js";
import { startCheckTopUpStatus } from "./api/payment";
import { ServicePaymentStatusChecker } from "./domain/billing/ServicePaymentStatusChecker.js";
import { InlineKeyboard } from "grammy";
import {
  bundleManageServicesMenu,
  domainManageServicesMenu,
  manageSerivcesMenu,
  vdsManageServiceMenu,
  vdsManageSpecific,
  vdsReinstallOs,
} from "./helpers/manage-services";
import DomainRequest, { DomainRequestStatus } from "./entities/DomainRequest";
import Domain, { DomainStatus } from "./entities/Domain";
import DedicatedServer, { DedicatedServerStatus } from "./entities/DedicatedServer";
import TopUp, { TopUpStatus } from "./entities/TopUp";
import Ticket, { TicketType } from "./entities/Ticket";
import Promo from "./entities/Promo";
import { handlePromocodeInput, promocodeQuestion } from "./helpers/promocode-input";
import { registerDomainPurchaseFlow } from "./domain/domains/domain-purchase-flow.js";
import { registerDedicatedShopHandlers } from "./domain/dedicated/dedicated-shop-flow.js";
import { openVpsTariffSelection, registerVpsShopHandlers } from "./domain/vds/vds-shop-flow.js";
import { registerDomainRegistrationMiddleware } from "./helpers/domain-registraton";
import ms from "./lib/multims";
import type { GetOsListResponse } from "./infrastructure/vmmanager/provider.js";
import { createVmProvider } from "./infrastructure/vmmanager/factory.js";
import { startResellerApiServer } from "./api/reseller-api.js";
import VirtualDedicatedServer from "./entities/VirtualDedicatedServer";
import DomainChecker from "./api/domain-checker";
import { escapeUserInput } from "./helpers/formatting";
import type { SessionData } from "./shared/types/session";
import type { AppContext, AppConversation } from "./shared/types/context";
import { createInitialMainSession, createInitialOtherSession } from "./shared/session-initial.js";
import { ensureSessionUser } from "./shared/utils/session-user.js";
import { getCachedOsList, startOsListBackgroundRefresh } from "./shared/vmmanager-os-cache.js";
import { getCachedUser, setCachedUser, invalidateUser } from "./shared/user-cache.js";
import { handleCryptoPayWebhook } from "./infrastructure/payments/cryptopay-webhook.js";
import { registerWelcomeMainMenu } from "./ui/menus/main-menu-registry.js";
// Note: Commands are registered via registerCommands call below
// Using dynamic import to avoid ts-node ESM resolution issues
// override: true — правки в .env должны побеждать устаревшие переменные из окружения PM2/systemd
dotenv.config({ path: path.join(process.cwd(), ".env"), override: true });
// Если запуск из dist/, .env может быть в родительской папке
if (!process.env.AMPER_API_BASE_URL?.trim() || !process.env.AMPER_API_TOKEN?.trim()) {
  dotenv.config({ path: path.join(process.cwd(), "..", ".env"), override: true });
}

const PRIME_MONTHLY_PRICE_USD = 9.99;
const PRIME_BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const primeBillingLocks = new Set<number>();

async function ensurePrimePaidAfterTrial(ctx: AppContext, session: SessionData): Promise<void> {
  if (!ctx.hasChatType("private") || ctx.chatId == null) {
    return;
  }
  const userId = Number(session.main.user.id || 0);
  const telegramId = Number(ctx.chatId);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(telegramId) || telegramId <= 0) {
    return;
  }
  if (primeBillingLocks.has(userId)) {
    return;
  }
  primeBillingLocks.add(userId);
  try {
    const now = Date.now();
    let changed = false;
    await ctx.appDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user || !user.primeTrialUsed) {
        return;
      }
      const activeUntilTs = user.primeActiveUntil ? new Date(user.primeActiveUntil).getTime() : 0;
      if (activeUntilTs > now) {
        return;
      }
      if (Number(user.balance || 0) < PRIME_MONTHLY_PRICE_USD) {
        if (user.primeActiveUntil !== null) {
          user.primeActiveUntil = null;
          await userRepo.save(user);
          changed = true;
        }
        return;
      }
      user.balance = Math.round((Number(user.balance || 0) - PRIME_MONTHLY_PRICE_USD) * 100) / 100;
      user.primeActiveUntil = new Date(now + PRIME_BILLING_PERIOD_MS);
      await userRepo.save(user);
      changed = true;
    });

    if (!changed) {
      return;
    }
    const changedUser = await ctx.appDataSource.getRepository(User).findOne({ where: { id: userId } });
    if (!changedUser) {
      return;
    }

    setCachedUser(telegramId, changedUser);
    ctx.loadedUser = changedUser;
    session.main.user.balance = changedUser.balance;
    session.main.user.referralBalance = changedUser.referralBalance ?? 0;
    session.main.user.id = changedUser.id;
    session.main.user.role = changedUser.role;
    session.main.user.status = changedUser.status;
    session.main.user.isBanned = changedUser.isBanned;
  } catch (error: any) {
    Logger.error("Prime auto-billing after trial failed:", error);
  } finally {
    primeBillingLocks.delete(userId);
  }
}

export const mainMenu = new Menu<AppContext>("main-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("button-purchase"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await openVpsTariffSelection(ctx as AppContext);
  })
  .row()
  .text((ctx) => ctx.t("button-manage-services"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await openVdsManageServicesListScreen(ctx as AppContext);
  })
  .submenu(
    (ctx) => ctx.t("button-personal-profile"),
    "profile-menu",
    async (ctx) => {
      const session = (await ctx.session) as SessionData;
      if (ctx.hasChatType("private")) {
        const { getProfileText } = await import("./ui/menus/profile-menu.js");
        const profileText = await getProfileText(ctx);
        await ctx.editMessageText(profileText, {
          reply_markup: profileMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    }
  );

registerWelcomeMainMenu(mainMenu);

const supportMenu = new Menu<AppContext>("support-menu", {
  autoAnswer: false,
})
  .url(
    (ctx) => ctx.t("button-ask-question"),
    (ctx) =>
      `tg://resolve?domain=sephora_sup&text=${encodeURIComponent(
        ctx.t("support-message-template")
      )}`
  )
  .row()
  .text((ctx) => ctx.t("button-support-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if ((session as any)?.other?.profileNavSource === "profile") {
      const { getProfileText } = await import("./ui/menus/profile-menu.js");
      const profileText = await getProfileText(ctx);
      await ctx.editMessageText(profileText, {
        parse_mode: "HTML",
        reply_markup: profileMenu,
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
      parse_mode: "HTML",
      reply_markup: mainMenu,
    });
  });

const profileMenu = new Menu<AppContext>("profile-menu", { onMenuOutdated: false })
  .text((ctx) => ctx.t("button-deposit"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.other.deposit.prefilledAmount = false;
    session.other.deposit.selectedAmount = 50;
    session.main.lastSumDepositsEntered = 0;
    await ctx.editMessageText(ctx.t("topup-select-method"), {
      reply_markup: topupMethodMenu,
      parse_mode: "HTML",
    });
  })
  .row()
  .text(
    (ctx) => ctx.t("button-promocode"),
    async (ctx) => {
      const session = (await ctx.session) as SessionData;
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
    const session = (await ctx.session) as SessionData;
    const nextLocale = session.main.locale === "ru" ? "en" : "ru";
    session.main.locale = nextLocale;
    (ctx as any)._requestLocale = nextLocale;

    const usersRepo = ctx.appDataSource.getRepository(User);
    const user = await usersRepo.findOneBy({ id: session.main.user.id });
    if (user) {
      user.lang = nextLocale as "ru" | "en";
      await usersRepo.save(user);
      invalidateUser(user.telegramId);
    }

    ctx.fluent.useLocale(nextLocale);

    const { getProfileText } = await import("./ui/menus/profile-menu.js");
    const profileText = await getProfileText(ctx, { locale: nextLocale });
    try {
      await ctx.editMessageText(profileText, {
        reply_markup: profileMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      if (err?.message?.includes("message is not modified") || err?.description?.includes("message is not modified")) return;
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
      const session = (await ctx.session) as SessionData;
      (session as any).other.profileNavSource = "profile";
      await ctx.editMessageText(ctx.t("support"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  )
  .row()
  .dynamic(async (ctx, range) => {
    if (!ctx.hasChatType("private")) return;
    const telegramId = ctx.chatId ?? ctx.from?.id;
    if (!telegramId) return;
    const dataSource = ctx.appDataSource ?? (await getAppDataSource());
    const dbUser = await dataSource.manager.findOneBy(User, {
      telegramId: Number(telegramId),
    });
    const roleStr = dbUser ? String(dbUser.role).toLowerCase() : "";
    const adminIds = getAdminTelegramIds();
    const isAdmin = (dbUser && (roleStr === "admin" || dbUser.role === Role.Admin)) || adminIds.includes(Number(telegramId));
    if (!isAdmin) return;
    if (dbUser && adminIds.includes(Number(telegramId)) && dbUser.role !== Role.Admin) {
      dbUser.role = Role.Admin;
      await dataSource.manager.save(dbUser);
    }
    const session = (await ctx.session) as SessionData;
    if (session?.main?.user) {
      session.main.user.role = Role.Admin;
      session.main.user.status = dbUser?.status ?? session.main.user.status;
      session.main.user.id = dbUser?.id ?? 0;
      session.main.user.balance = dbUser?.balance ?? 0;
      session.main.user.referralBalance = dbUser?.referralBalance ?? 0;
      session.main.user.isBanned = dbUser?.isBanned ?? false;
    }
    range.text(ctx.t("button-admin-panel"), async (ctx) => {
      try {
        await ctx.editMessageText(ctx.t("admin-panel-header"), {
          parse_mode: "HTML",
          reply_markup: adminMenu,
        });
      } catch (error: any) {
        console.error("[Admin] Failed to open admin panel from profile:", error);
        await ctx.answerCallbackQuery(
          ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200)
        );
      }
    });
    range.row();
  })
  .row()
  .back(
    (ctx) => ctx.t("button-profile-back"),
    async (ctx) => {
      const session = (await ctx.session) as SessionData;
      await ctx.editMessageText(
        ctx.t("welcome", { balance: session.main.user.balance }),
        {
          parse_mode: "HTML",
          reply_markup: mainMenu,
        }
      );
    }
  );

const changeLocaleMenu = new Menu<AppContext>("change-locale-menu", {
  autoAnswer: false,
  onMenuOutdated: false,
})
  .dynamic(async (ctx, range) => {
    const session = (await ctx.session) as SessionData;
    for (const lang of ctx.availableLanguages) {
      if (lang !== session.main.locale) {
        range
          .text(ctx.t(`button-change-locale-${lang}`), async (ctx) => {
            session.main.locale = lang;
            (ctx as any)._requestLocale = lang;
            const usersRepo = ctx.appDataSource.getRepository(User);

            const user = await usersRepo.findOneBy({
              id: session.main.user.id,
            });

            if (user) {
              user.lang = lang as "ru" | "en";
              await usersRepo.save(user);
              invalidateUser(user.telegramId);
            }

            ctx.fluent.useLocale(lang);
            await ctx.editMessageText(
              ctx.t("welcome", { balance: session.main.user.balance }),
              {
                parse_mode: "HTML",
                reply_markup: mainMenu,
              }
            );
            ctx.menu.back();
          })
          .row();
      }
    }
  })
  .back((ctx) => ctx.t("button-back"));

/** Harmless Telegram 400s (menus often re-edit identical markup/text). Avoid error-log spam in production. */
function isIgnoredTelegramBotNoise(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("message is not modified") ||
    msg.includes("query is too old") ||
    msg.includes("message to edit not found") ||
    msg.includes("MESSAGE_ID_INVALID")
  );
}

async function index() {
  const { fluent, availableLocales } = await initFluent();
  const appDataSource = await getAppDataSource();

  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is required");
  const bot = new Bot<AppContext>(token, {});

  // Ответ на callback первым делом — убирает "загрузку" в клиенте до любых других действий.
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => {});
    }
    return next();
  });

  // Inline mode: pop-up card above input (title + description), like Market & Tochka. Must run before session.
  bot.use(async (ctx, next) => {
    if (!ctx.inlineQuery) return next();
    const queryId = ctx.inlineQuery.id;
    const query = ctx.inlineQuery.query;
    Logger.info("[Inline] Query received", { queryId, query });
    try {
      const results = [
        {
          type: "article" as const,
          id: `sephora-welcome-${queryId}`,
          title: "💚 Welcome to Sephora Host!",
          description:
            "Bulletproof VPS, domains & dedicated servers — order and manage hosting in TG. 24/7, offshore.",
          input_message_content: {
            message_text:
              "✨ Welcome to Sephora Host!\n\nBulletproof VPS, domains and dedicated servers — order and manage hosting in TG. 24/7 support, offshore.\n\n👉 Open bot: t.me/sephora_host_bot",
          },
        },
      ];
      await bot.api.answerInlineQuery(queryId, results, { cache_time: 0 });
      Logger.info("[Inline] Answer sent");
    } catch (err) {
      Logger.error("[Inline] answerInlineQuery failed", err);
    }
  });

  // Память для сессий — без диска, моментальный отклик. Перезапуск бота сбрасывает сессии.
  bot.use(
    session({
      type: "multi",
      other: {
        storage: new MemorySessionStorage<SessionData["other"]>(),
        initial: createInitialOtherSession,
      },
      main: {
        initial: createInitialMainSession,
        storage: new MemorySessionStorage<SessionData["main"]>(),
      },
    })
  );

  bot.use(async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (!session.main) {
      session.main = createInitialMainSession();
    }
    if (!session.other) {
      session.other = createInitialOtherSession();
    }
    return next();
  });

  // Must run right after session: otherwise long middleware chains can reach Menu handlers
  // without ConversationFlavor and ctx.conversation.enter() throws (reading 'enter').
  bot.use(conversations());

  const vmmanager = createVmProvider();
  startResellerApiServer({ dataSource: appDataSource, vmProvider: vmmanager, botApi: bot.api });

  {
    const { ExpirationService } = await import("./domain/services/ExpirationService.js");
    let onGracePeriodStarted: import("./domain/services/ExpirationService.js").OnGracePeriodStarted | undefined;
    try {
      const dataSource = await getAppDataSource();
      const { GrowthService } = await import("./modules/growth/growth.service.js");
      const growthService = new GrowthService(dataSource);
      const triggerEngine = growthService.getTriggerEngine();
      onGracePeriodStarted = async (userId, serviceId, serviceType) => {
        await triggerEngine.handleServiceExpiration(userId, serviceId, serviceType);
      };
    } catch {
      /* growth optional */
    }
    let onGraceDayCheck: import("./domain/services/ExpirationService.js").OnGraceDayCheck | undefined;
    try {
      const { maybeSendGraceDay2OrDay3 } = await import("./modules/growth/campaigns/index.js");
      const sendGrowthMessage = (telegramId: number, text: string): Promise<void> =>
        bot.api.sendMessage(telegramId, text, { parse_mode: "HTML" }).then(() => {});
      onGraceDayCheck = (vdsId, userId, telegramId, payDayAt) =>
        maybeSendGraceDay2OrDay3(vdsId, userId, telegramId, payDayAt, sendGrowthMessage);
    } catch {
      /* optional */
    }
    const expirationService = new ExpirationService(
      bot as any,
      vmmanager,
      fluent as any,
      onGracePeriodStarted,
      onGraceDayCheck
    );
    expirationService.start();
  }
  startOsListBackgroundRefresh(vmmanager);

  bot.use((ctx, next) => {
    ctx.vmmanager = vmmanager;
    ctx.osList = getCachedOsList();
    return next();
  });

  // Add the available languages to the context (appDataSource уже инициализирован — без await на каждый запрос)
  // Для callback_query при промахе кэша не ждём БД — используем сессию и подгружаем юзера в фоне.
  bot.use(async (ctx, next) => {
    const session = (await ctx.session) as SessionData;

    ctx.availableLanguages = availableLocales;
    ctx.appDataSource = appDataSource;
    ctx.loadedUser = null;

    if (!session?.main) {
      return next();
    }

    if (ctx.hasChatType("private") && ctx.chatId != null) {
      const tid = Number(ctx.chatId);
      let user = getCachedUser(tid);

      if (!user) {
        const isCallback = !!ctx.callbackQuery;
        const hasSessionUser = session.main.user.id > 0;
        if (isCallback && hasSessionUser) {
          // Быстрый путь: не ждём БД, используем данные из сессии, подгрузку делаем в фоне.
          ctx.loadedUser = Object.assign(new User(), {
            id: session.main.user.id,
            telegramId: tid,
            balance: session.main.user.balance,
            referralBalance: session.main.user.referralBalance ?? 0,
            role: session.main.user.role,
            status: session.main.user.status,
            isBanned: session.main.user.isBanned,
            lang: session.main.locale === "en" ? "en" : "ru",
          }) as User;
          void appDataSource.manager.findOneBy(User, { telegramId: ctx.chatId }).then((fresh) => {
            if (fresh) {
              setCachedUser(tid, fresh);
            }
          });
        } else {
          user = await appDataSource.manager.findOneBy(User, {
            telegramId: ctx.chatId,
          });
          if (!user) {
            const newUser = new User();
            newUser.telegramId = ctx.chatId;
            newUser.status = UserStatus.User;
            newUser.referrerId = null;
            user = await appDataSource.manager.save(newUser);
          }
          setCachedUser(tid, user);
          ctx.loadedUser = user;
          session.main.user.balance = user.balance;
          session.main.user.referralBalance = user.referralBalance ?? 0;
          session.main.user.id = user.id;
          session.main.user.role = user.role;
          session.main.user.status = user.status;
          session.main.user.isBanned = user.isBanned;
          const adminIds = getAdminTelegramIds();
          if (adminIds.length > 0 && adminIds.includes(tid)) {
            session.main.user.role = Role.Admin;
            if (user.role !== Role.Admin) {
              user.role = Role.Admin;
              void appDataSource.manager.save(user).then(() => setCachedUser(tid, user!));
            }
          }
          return next();
        }
      } else if (user) {
        ctx.loadedUser = user;
        session.main.user.balance = user.balance;
        session.main.user.referralBalance = user.referralBalance ?? 0;
        session.main.user.id = user.id;
        session.main.user.role = user.role;
        session.main.user.status = user.status;
        session.main.user.isBanned = user.isBanned;
        const adminIds = getAdminTelegramIds();
        if (adminIds.length > 0 && adminIds.includes(tid)) {
          session.main.user.role = Role.Admin;
          if (user.role !== Role.Admin) {
            user.role = Role.Admin;
            void appDataSource.manager.save(user).then(() => setCachedUser(tid, user!));
          }
        }
      }
    }
    return next();
  });

  // Prime billing lifecycle:
  // 1) trial grants 7 days via primeActiveUntil;
  // 2) after expiration, if balance >= 9.99$, extend for 30 days and charge automatically.
  bot.use(async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (session?.main?.user?.id) {
      await ensurePrimePaidAfterTrial(ctx, session);
    }
    return next();
  });

  bot.use(async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (!session?.main) {
      return next();
    }
    // Берём lang из уже загруженного user (ctx.loadedUser), без второго запроса в БД.
    const user = ctx.loadedUser ?? (session.main.user.id > 0 ? await ctx.appDataSource.getRepository(User).findOne({ where: { id: session.main.user.id }, select: ["lang"] }) : null);
    if (user?.lang === "en") {
      session.main.locale = "en";
    } else if (user?.lang === "ru") {
      session.main.locale = "ru";
    } else {
      session.main.locale = "0";
    }
    return next();
  });

  bot.use(
    useFluent({
      fluent,
      defaultLocale: "ru",
      localeNegotiator: async (ctx) => {
        const session = (await ctx.session) as SessionData;
        return session?.main?.locale === "en" ? "en" : "ru";
      },
    })
  );

  bot.use(async (ctx, next) => {
    const fluentObj = (ctx as any).fluent;
    if (!fluentObj) return next();
    const session = (await ctx.session) as SessionData;
    const userId = Number(session?.main?.user?.id ?? 0);
    if (userId > 0) {
      const now = new Date();
      const [activeVds, activeDedicated, activeDomain] = await Promise.all([
        ctx.appDataSource.manager.count(VirtualDedicatedServer, {
          where: { targetUserId: userId, expireAt: MoreThan(now) },
        }),
        ctx.appDataSource.manager.count(DedicatedServer, {
          where: { userId, status: DedicatedServerStatus.ACTIVE },
        }),
        ctx.appDataSource.manager.count(Domain, {
          where: { userId, status: DomainStatus.REGISTERED },
        }),
      ]);
      (ctx as any)._activeServicesCount = activeVds + activeDedicated + activeDomain;
      (ctx as any)._activeVdsCount = activeVds;
    } else {
      (ctx as any)._activeServicesCount = 0;
      (ctx as any)._activeVdsCount = 0;
    }
    // Фиксируем локаль на весь запрос — иначе текст и кнопки (меню) рендерятся с разной локалью
    const requestLocale = session?.main?.locale === "en" ? "en" : "ru";
    (ctx as any)._requestLocale = requestLocale;
    const fluentInstance = fluentObj.instance ?? fluentObj;
    const originalT = (ctx as any).t;
    const tFn = (key: string, vars?: Record<string, string | number>) => {
      const locale = (ctx as any)._requestLocale ?? requestLocale;
      // Приветствие в текущей локали (en/ru)
      if (key === "welcome") {
        const baseBalance =
          typeof vars?.balance === "number"
            ? vars.balance
            : (session?.main?.user?.balance ?? 0);
        const usernameRaw = ctx.from?.username?.trim();
        const username = usernameRaw && usernameRaw.length > 0 ? usernameRaw : "username";
        const userId = Number(ctx.from?.id ?? ctx.chatId ?? 0);
        const userIdText = String(Number.isFinite(userId) ? Math.trunc(userId) : 0);
        const servicesCount =
          typeof vars?.servicesCount === "number"
            ? vars.servicesCount
            : Number((ctx as any)._activeServicesCount ?? 0);
        const vdsCount =
          typeof vars?.vdsCount === "number"
            ? vars.vdsCount
            : Number((ctx as any)._activeVdsCount ?? 0);
        return String(
          fluent.translate(locale, "welcome", {
            balance: baseBalance,
            username,
            userId,
            userIdText,
            servicesCount,
            vdsCount,
          })
        );
      }
      fluentObj.useLocale?.(locale);
      return typeof fluentInstance.translate === "function"
        ? String(fluentInstance.translate(locale, key, vars ?? {}))
        : typeof originalT === "function"
          ? String(originalT(key, vars))
          : key;
    };
    (ctx as any).t = tFn;
    return next();
  });

  // mainMenu обязательно регистрируем до /start: иначе при ctx.reply(..., mainMenu) плагин меню выдаёт "Cannot send menu 'main-menu'!"
  bot.use(mainMenu);

  // /start и promote — сразу после mainMenu, чтобы команда и ссылки работали
  bot.use(promotePermissions());
  bot.command("start", async (ctx) => {
    try {
      if (ctx.message) {
        await ctx.deleteMessage().catch(() => {});
      }
      const session = (await ctx.session) as SessionData;
      const payload = ctx.match && typeof ctx.match === "string" ? ctx.match.trim() : "";
      if (payload.length > 0 && !payload.startsWith("promote_")) {
        try {
          const { ReferralService } = await import("./domain/referral/ReferralService.js");
          const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
          const userRepo = new UserRepository(ctx.appDataSource);
          const referralService = new ReferralService(ctx.appDataSource, userRepo);
          const user = await userRepo.findById(session.main.user.id);
          if (user && user.referrerId == null) {
            const bound = await referralService.bindReferrer(user.id, payload);
            if (bound) {
              Logger.info(`[Referral] Bound referrer for user ${user.id} with refCode ${payload}`);
              const referrerTelegramId = Number.parseInt(payload, 10);
              if (!Number.isNaN(referrerTelegramId)) {
                const referrer = await userRepo.findByTelegramId(referrerTelegramId);
                if (referrer) {
                  const referrerLang = referrer.lang === "en" ? "en" : "ru";
                  const referralsCount = await referralService.countReferrals(referrer.id);
                  const { notifyReferrerAboutNewSignup } = await import("./helpers/notifier.js");
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
        } catch (err: any) {
          Logger.error("[Referral] Failed to bind referrer:", err);
        }
      }
      const hasLocale = session.main.locale && session.main.locale !== "0" && (session.main.locale === "ru" || session.main.locale === "en");
      if (hasLocale) {
        const welcomeText = ctx.t("welcome", { balance: session.main.user.balance });
        await ctx.reply(welcomeText, {
          reply_markup: mainMenu,
          parse_mode: "HTML",
        });
        return;
      }
      const keyboard = new InlineKeyboard()
        .text(ctx.t("button-change-locale-ru"), "lang_ru")
        .text(ctx.t("button-change-locale-en"), "lang_en");
      await ctx.reply(ctx.t("select-language"), {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      console.error("[Start] Error in /start command:", error);
      await ctx.reply("Error: " + (error.message || "Unknown error")).catch(() => {});
    }
  });

  // === Меню и callback сразу после /start — кнопки не проходят через conversations/broadcast ===
  try {
    await import("./ui/menus/cdn-menu.js");
  } catch (error: any) {
    console.error("[Bot] Failed to preload CDN module:", error?.stack ?? error);
  }

  bot.callbackQuery(/^services-menu\/1\/0($|\/)/, async (ctx) => {
    await openCdnPurchaseFromServicesMenu(ctx as any);
  });

  /** Inline shop (vsh:* / dsh:*) before Menu middleware so «Купить»/«Заказать» are not lost in the stack. */
  registerDomainPurchaseFlow(bot);
  registerDedicatedShopHandlers(bot);
  registerVpsShopHandlers(bot);

  /** Plain `dedicated-os:*` keys (after location) — before Menu stack so callbacks are not swallowed. */
  bot.callbackQuery(/^dedicated-os:(.+)$/, async (ctx) => {
    const payload = ctx.match[1];
    if (payload === "back") {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      await ctx.editMessageText(
        ctx.t("welcome", { balance: session.main.user.balance }),
        { parse_mode: "HTML", reply_markup: mainMenu }
      );
    } else {
      await handleDedicatedOsSelect(ctx, payload);
    }
  });

  // conversations() is registered immediately after session (see above).
  registerPromoConversations(bot);
  bot.use(createConversation(domainRegisterConversation as any, "domainRegisterConversation"));
  bot.use(createConversation(domainUpdateNsConversation as any, "domainUpdateNsConversation"));
  bot.use(createConversation(withdrawRequestConversation as any, "withdrawRequestConversation"));
  try {
    const { cdnAddProxyConversation } = await import("./ui/menus/cdn-menu.js");
    bot.use(createConversation(cdnAddProxyConversation as any, "cdnAddProxyConversation"));
  } catch (error: any) {
    console.error("[Bot] Failed to register CDN conversation:", error?.stack ?? error);
  }
  bot.use(
    createConversation(depositMoneyConversation as any, "depositMoneyConversation")
  );
  bot.use(
    createConversation(renameVdsConversation as any, "renameVdsConversation")
  );
  bot.use(
    createConversation(vdsPasswordManualConversation as any, "vdsPasswordManualConversation")
  );

  bot.use(adminMenu);
  bot.use(moderatorMenu);
  bot.use(ticketViewMenu);
  bot.use(servicesMenu);
  bot.use(profileMenu);
  bot.use(manageSerivcesMenu);
  bot.use(domainsMenu);
  bot.use(vdsMenu);
  bot.use(dedicatedTypeMenu);
  bot.use(vdsTypeMenu);
  bot.use(dedicatedServersMenu);
  bot.use(dedicatedSelectedServerMenu);
  bot.use(dedicatedLocationMenu);
  bot.use(dedicatedOsMenu);
  bot.use(adminPromosMenu);
  bot.use(vdsRateChoose);
  bot.use(vdsRateOs);
  bot.use(depositMenu);
  bot.use(topupMethodMenu);
  bot.use(domainManageServicesMenu);
  bot.use(vdsManageServiceMenu);
  bot.use(bundleManageServicesMenu);
  bot.use(domainOrderMenu);
  bot.use(controlUser);
  bot.use(controlUserBalance);
  bot.use(controlUserSubscription);
  bot.use(controlUsers);
  bot.use(controlUserStatus);

  adminMenu.register(controlUsers, "admin-menu");
  adminMenu.register(moderatorMenu, "admin-menu");

  bot.callbackQuery("topup_manual_back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.other.deposit.prefilledAmount = false;
    await ctx.editMessageText(ctx.t("topup-select-method"), {
      reply_markup: topupMethodMenu,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("topup_back_to_amount", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(ctx.t("button-deposit"), {
      reply_markup: depositMenu,
      parse_mode: "HTML",
    });
  });

  try {
    const { referralsMenu } = await import("./ui/menus/referrals-menu");
    bot.use(referralsMenu);
    console.log("[Bot] Referrals menu registered via bot.use()");
  } catch (error: any) {
    console.error("[Bot] Failed to register referrals menu:", error);
  }

  bot.callbackQuery("referral-stats-back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    const { ReferralService } = await import("./domain/referral/ReferralService.js");
    const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
    const { referralsMenu } = await import("./ui/menus/referrals-menu.js");
    const referralService = new ReferralService(
      ctx.appDataSource,
      new UserRepository(ctx.appDataSource)
    );
    const referralLink = await referralService.getReferralLink(session.main.user.id);
    const referralsCount = await referralService.countReferrals(session.main.user.id);
    const userForRef = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.main.user.id },
      select: ["referralBalance"],
    });
    const refBalance = userForRef?.referralBalance ?? session.main.user.referralBalance ?? 0;
    const profitFormatted = refBalance.toFixed(2);
    const text = ctx
      .t("referrals-screen", {
        link: referralLink,
        count: referralsCount,
        profit: profitFormatted,
      })
      .replace(/\\n/g, "\n");
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: referralsMenu,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery("back:profile", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if ((session as any)?.other?.profileNavSource === "profile") {
      const { getProfileText } = await import("./ui/menus/profile-menu.js");
      const profileText = await getProfileText(ctx);
      await ctx.editMessageText(profileText, {
        parse_mode: "HTML",
        reply_markup: profileMenu,
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
      parse_mode: "HTML",
      reply_markup: mainMenu,
    });
  });

  try {
    const { amperDomainsMenu } = await import("./ui/menus/amper-domains-menu");
    bot.use(amperDomainsMenu);
    domainsMenu.register(amperDomainsMenu, "domains-menu");
    console.log("[Bot] Amper domains menu registered via bot.use()");
  } catch (error: any) {
    console.error("[Bot] Failed to register amper domains menu:", error);
  }

  try {
    const dedicatedModule = await import("./ui/menus/dedicated-menu");
    if (dedicatedModule?.dedicatedMenu) {
      bot.use(dedicatedModule.dedicatedMenu as any);
      dedicatedTypeMenu.register(dedicatedModule.dedicatedMenu, "dedicated-type-menu");
      console.log("[Bot] Dedicated menu registered via bot.use()");
    }
  } catch (error: any) {
    console.error("[Bot] Failed to import dedicated menu:", error);
  }

  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery?.data) return next();
    const data = ctx.callbackQuery.data;
    const isPrimeBack = typeof data === "string" && data.startsWith("prime-back-");
    const isPrimeActivate = data === "prime_activate_trial";
    const isPrimeSubscribed = data === "prime_i_subscribed";
    if (!isPrimeBack && !isPrimeActivate && !isPrimeSubscribed) return next();

    if (!isPrimeSubscribed) await ctx.answerCallbackQuery().catch(() => {});

    try {
      if (isPrimeBack) {
        const session = (await ctx.session) as SessionData;
        const balance = session?.main?.user?.balance ?? 0;
        const welcomeText = ctx.t("welcome", { balance });
        await ctx.editMessageText(welcomeText, {
          reply_markup: mainMenu,
          parse_mode: "HTML",
        });
        return;
      }
      if (isPrimeActivate) {
        await handlePrimeActivateTrial(ctx as AppContext);
        return;
      }
      if (isPrimeSubscribed) {
        await handlePrimeISubscribed(ctx as AppContext);
        return;
      }
    } catch (err: any) {
      Logger.error("Prime callback error:", err);
      await ctx.answerCallbackQuery({
        text: String(err?.message || "Error").slice(0, 200),
        show_alert: true,
      }).catch(() => {});
    }
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data !== "lang_ru" && data !== "lang_en") {
      return next();
    }
    const lang = data === "lang_ru" ? "ru" : "en";
    try {
      await ctx.answerCallbackQuery();
      const session = (await ctx.session) as SessionData;
      session.main.locale = lang;
      (ctx as any)._requestLocale = lang;
      const usersRepo = ctx.appDataSource.getRepository(User);
      const user = await usersRepo.findOneBy({
        id: session.main.user.id,
      });
      if (user) {
        user.lang = lang as "ru" | "en";
        await usersRepo.save(user);
        invalidateUser(user.telegramId);
      }
      ctx.fluent.useLocale(lang);
      const welcomeText = ctx.t("welcome", { balance: session.main.user.balance });
      try {
        await ctx.editMessageText(welcomeText, {
          reply_markup: mainMenu,
          parse_mode: "HTML",
        });
      } catch (editError: any) {
        try {
          await ctx.deleteMessage().catch(() => {});
        } catch {}
        await ctx.reply(welcomeText, {
          reply_markup: mainMenu,
          parse_mode: "HTML",
        });
      }
      return;
    } catch (error: any) {
      console.error(`[Lang] Error processing lang_${lang} callback:`, error);
      const errorText = lang === "ru" ? "Ошибка при выборе языка" : "Error selecting language";
      await ctx.answerCallbackQuery({ text: errorText, show_alert: true }).catch(() => {});
      return;
    }
  });

  bot.use(async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (session.main.user.isBanned) {
      await ctx.reply(ctx.t("message-about-block"));
      await ctx.deleteMessage().catch(() => {});
      return;
    }
    return next();
  });

  // Conversations are registered above, before menu middleware.
  registerBroadcastAndTickets(bot);
  registerAdminPromosHandlers(bot);

  bot.use(depositPaymentSystemChoose);

  // Register domain registration conversation
  // Note: This is also registered in broadcast-tickets-integration, so we skip it here to avoid duplicates
  // The conversation will be registered by registerBroadcastAndTickets() below
  // bot.use(
  //   createConversation(confirmDomainRegistration, "confirmDomainRegistration")
  // );

  bot.use(promocodeQuestion.middleware());
  bot.use(vdsManageSpecific);

  bot.callbackQuery(/^vds-renew-yes:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    const vdsId = Number(ctx.match![1]);
    const months = Number(ctx.match![2]) as 1 | 3 | 6 | 12;
    if (![1, 3, 6, 12].includes(months)) return;
    session.other.manageVds.pendingRenewMonths = null;
    const { VdsService } = await import("./domain/services/VdsService.js");
    const { VdsRepository } = await import("./infrastructure/db/repositories/VdsRepository.js");
    const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
    const { TopUpRepository } = await import("./infrastructure/db/repositories/TopUpRepository.js");
    const { BillingService } = await import("./domain/billing/BillingService.js");
    const vdsRepo = new VdsRepository(ctx.appDataSource);
    const userRepo = new UserRepository(ctx.appDataSource);
    const topUpRepo = new TopUpRepository(ctx.appDataSource);
    const billing = new BillingService(ctx.appDataSource, userRepo, topUpRepo);
    const vdsService = new VdsService(ctx.appDataSource, vdsRepo, billing, ctx.vmmanager);
    try {
      await vdsService.renewVdsWithMonths(vdsId, session.main.user.id, months);
      const u = await ctx.appDataSource.getRepository(User).findOneBy({ id: session.main.user.id });
      if (u) session.main.user.balance = u.balance;
      await ctx.reply(ctx.t("vds-renew-success", { months }), { parse_mode: "HTML" });
    } catch (e: any) {
      await ctx.reply(ctx.t("error-unknown", { error: e?.message || "err" }), { parse_mode: "HTML" });
    }
    await ctx.deleteMessage().catch(() => {});
  });

  bot.callbackQuery(/^vds-renew-no:\d+$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.other.manageVds.pendingRenewMonths = null;
    await ctx.deleteMessage().catch(() => {});
  });

  bot.callbackQuery(/^adv:/, async (ctx) => {
    const { handleAdminVdsCallback } = await import("./ui/menus/admin-vds-menu.js");
    await handleAdminVdsCallback(ctx as AppContext);
  });

  // NOTE: proxy id comes after the first colon (e.g. cdn_open:<id>, cdn_autorenew:<id>:1).
  // A pattern like `cdn_open:` with `$` at end never matched real callbacks — buttons did nothing.
  bot.callbackQuery(
    /^(cdn_(open|renew|retryssl|delask|delok):.+|cdn_autorenew:.+:[01]|cdn_target_auto|cdn_target_help|cdn_plan:(standard|bulletproof|bundle)|cdn_plan_back|cdn_list|cdn_back_to_manage|cdn_empty_row|cdn_exit_services|cdn_nav:(main|tariffs|proxy)|cdn_card:(standard|bulletproof|bundle)|cdn_detail:(standard|bulletproof|bundle)|cdn_prime_row)$/,
    async (ctx) => {
      const { handleCdnActionCallback } = await import("./ui/menus/cdn-menu.js");
      await handleCdnActionCallback(ctx as AppContext);
    }
  );
  bot.callbackQuery(/^acdn:/, async (ctx) => {
    const { handleAdminCdnCallback } = await import("./ui/menus/admin-cdn-menu.js");
    await handleAdminCdnCallback(ctx as AppContext);
  });

  bot.callbackQuery("promocode-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.other.promocode.awaitingInput = false;
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
  });

  bot.callbackQuery("promocode-back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.other.promocode.awaitingInput = false;
    const balance = session?.main?.user?.balance ?? 0;
    await ctx.reply(ctx.t("welcome", { balance }), {
      reply_markup: mainMenu,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("deposit-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    session.main.lastSumDepositsEntered = -1;
    session.other.deposit.awaitingAmount = false;
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
  });

  // Bundle purchase handlers
  bot.callbackQuery(/^bundle-purchase-(.+)-(.+)$/, async (ctx) => {
    const match = ctx.callbackQuery?.data?.match(/^bundle-purchase-(.+)-(.+)$/);
    if (!match) return;
    const [, bundleTypeStr, periodStr] = match;
    const { handleBundlePurchase } = await import("./ui/menus/bundle-handlers.js");
    await handleBundlePurchase(ctx as AppContext, bundleTypeStr, periodStr);
  });

  bot.callbackQuery("bundle-change-period", async (ctx) => {
    const { handleBundleChangePeriod } = await import("./ui/menus/bundle-handlers.js");
    await handleBundleChangePeriod(ctx as AppContext);
  });

  bot.callbackQuery("bundle-back-to-types", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { bundleTypeMenu } = await import("./ui/menus/bundles-menu.js");
    await ctx.editMessageText(ctx.t("bundle-select-type"), {
      reply_markup: bundleTypeMenu,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("bundle-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.other.bundle) {
      delete session.other.bundle;
    }
    const { servicesMenu } = await import("./helpers/services-menu.js");
    await ctx.editMessageText(ctx.t("menu-service-for-buy-choose"), {
      reply_markup: servicesMenu,
      parse_mode: "HTML",
    });
  });

  // Bundle: confirm purchase (after user entered domain name)
  bot.callbackQuery("bundle-confirm-purchase", async (ctx) => {
    const { handleBundleConfirmPurchase } = await import("./ui/menus/bundle-handlers.js");
    await handleBundleConfirmPurchase(ctx as AppContext);
  });

  bot.callbackQuery("domain-register-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
    await ctx.reply(ctx.t("domain-register-cancelled"), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^nps:[1-5]$/, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;
    const { parseNpsPayload } = await import("./modules/automations/nps-callback.js");
    const parsed = parseNpsPayload(data);
    if (!parsed) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const key = `nps-${parsed.branch}` as "nps-promoter" | "nps-detractor" | "nps-neutral";
    const text = ctx.t(key);
    await ctx.reply(text, { parse_mode: "HTML" }).catch(() => {});
  });

  bot.callbackQuery("admin-menu-back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    const hasSessionUser = await ensureSessionUser(ctx as AppContext);
    if (!session || !hasSessionUser) {
      await ctx.reply(ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200)).catch(() => {});
      return;
    }

    const { clearAdminVdsPanelState } = await import("./ui/menus/admin-vds-menu.js");
    clearAdminVdsPanelState(session.other);

    try {
      await ctx.editMessageText(ctx.t("admin-panel-header"), {
        reply_markup: adminMenu,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      const description = error?.description || error?.message || "";
      if (description.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  });

  bot.callbackQuery("admin-resellers-open", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      return;
    }
    await openResellerPanel(ctx as AppContext);
  });

  bot.callbackQuery("admin-resellers-services", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      return;
    }
    await openResellerServicesList(ctx as AppContext);
  });

  bot.callbackQuery(/^admin-reseller:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role !== Role.Admin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      return;
    }
    const resellerId = String(ctx.match?.[1] ?? "").trim();
    if (!resellerId) return;
    await openResellerDetails(ctx as AppContext, resellerId);
  });

  bot.callbackQuery("admin-open-panel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const telegramId = ctx.chatId ?? ctx.from?.id;
    if (!telegramId) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      return;
    }
    const dataSource = ctx.appDataSource ?? (await getAppDataSource());
    const dbUser = await dataSource.manager.findOneBy(User, { telegramId: Number(telegramId) });
    const roleStr = dbUser ? String(dbUser.role).toLowerCase() : "";
    const adminIds = getAdminTelegramIds();
    const isAdmin = (dbUser && (roleStr === "admin" || dbUser.role === Role.Admin)) || adminIds.includes(Number(telegramId));
    if (!isAdmin) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      return;
    }
    if (dbUser && adminIds.includes(Number(telegramId)) && dbUser.role !== Role.Admin) {
      dbUser.role = Role.Admin;
      await dataSource.manager.save(dbUser);
    }
    const session = (await ctx.session) as SessionData;
    if (session?.main?.user) {
      session.main.user.role = Role.Admin;
      session.main.user.status = dbUser?.status ?? session.main.user.status;
      session.main.user.id = dbUser?.id ?? 0;
      session.main.user.balance = dbUser?.balance ?? 0;
      session.main.user.referralBalance = dbUser?.referralBalance ?? 0;
      session.main.user.isBanned = dbUser?.isBanned ?? false;
    }
    try {
      await ctx.editMessageText(ctx.t("admin-panel-header"), {
        parse_mode: "HTML",
        reply_markup: adminMenu,
      });
    } catch (e) {
      await ctx.answerCallbackQuery(ctx.t("error-unknown", { error: "Unknown error" }).substring(0, 200)).catch(() => {});
    }
  });

  bot.callbackQuery("admin-referrals-back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const user = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
    });
    if (!user) return;
    const { text, reply_markup } = await buildControlPanelUserReply(ctx, user, undefined, controlUser);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
  });

  bot.callbackQuery("admin-referrals-change-percent", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) return;
    session.other.referralPercentEdit = { userId: session.other.controlUsersPage.pickedUserData.id };
    await ctx.reply(ctx.t("admin-referral-percent-enter"), { parse_mode: "HTML" });
  });

  async function buildReferralPercentByServiceReply(ctx: AppContext, userId: number) {
    const user = await ctx.appDataSource.manager.findOne(User, {
      where: { id: userId },
      select: [
        "id",
        "referralPercent",
        "referralPercentDomains",
        "referralPercentDedicatedStandard",
        "referralPercentDedicatedBulletproof",
        "referralPercentVdsStandard",
        "referralPercentVdsBulletproof",
        "referralPercentCdn",
      ],
    });
    const fmt = (v: number | null | undefined) => (v != null ? `${v}%` : "—");
    const text = [
      ctx.t("admin-referral-percent-by-service-title"),
      "",
      `${ctx.t("ref-percent-label-domains")}: ${fmt(user?.referralPercentDomains ?? undefined)}`,
      `${ctx.t("ref-percent-label-dedicated")}: ${ctx.t("button-standard")} ${fmt(user?.referralPercentDedicatedStandard)}, ${ctx.t("button-bulletproof")} ${fmt(user?.referralPercentDedicatedBulletproof)}`,
      `${ctx.t("ref-percent-label-vds")}: ${ctx.t("button-standard")} ${fmt(user?.referralPercentVdsStandard)}, ${ctx.t("button-bulletproof")} ${fmt(user?.referralPercentVdsBulletproof)}`,
      `${ctx.t("ref-percent-label-cdn")}: ${fmt(user?.referralPercentCdn ?? undefined)}`,
    ].join("\n");
    const keyboard = new InlineKeyboard()
      .text(`🌐 ${ctx.t("ref-percent-label-domains")} %`, "admin-referrals-percent-domains")
      .text(`🖥 ${ctx.t("ref-percent-label-vds")} %`, "admin-referrals-percent-vds-menu")
      .row()
      .text(`🛠 ${ctx.t("ref-percent-label-dedicated")} %`, "admin-referrals-percent-dedicated-menu")
      .text(`🚀 ${ctx.t("ref-percent-label-cdn")} %`, "admin-referrals-percent-cdn")
      .row()
      .text(ctx.t("button-back"), "admin-referrals-back-to-summary");
    return { text, reply_markup: keyboard };
  }

  bot.callbackQuery("admin-referrals-percent-by-service", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) return;
    const userId = session.other.controlUsersPage.pickedUserData.id;
    const { text, reply_markup } = await buildReferralPercentByServiceReply(ctx, userId);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup });
  });

  bot.callbackQuery("admin-referrals-percent-back-to-list", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const user = await ctx.appDataSource.manager.findOne(User, { where: { id: session.other.controlUsersPage.pickedUserData.id } });
    if (!user) return;
    const { text, reply_markup } = await buildReferralPercentByServiceReply(ctx, user.id);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
  });

  bot.callbackQuery("admin-referrals-back-to-summary", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const user = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
    });
    if (!user) return;
    const { text, reply_markup } = await buildReferralSummaryReply(ctx, user);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery("admin-referrals-percent-dedicated-menu", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const user = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
      select: ["referralPercent", "referralPercentDedicatedStandard", "referralPercentDedicatedBulletproof"],
    });
    const fmt = (v: number | null | undefined) => (v != null ? `${v}%` : "—");
    const text = `${ctx.t("ref-percent-label-dedicated")}\n${ctx.t("button-standard")}: ${fmt(user?.referralPercentDedicatedStandard ?? undefined)}\n${ctx.t("button-bulletproof")}: ${fmt(user?.referralPercentDedicatedBulletproof ?? undefined)}`;
    const keyboard = new InlineKeyboard()
      .text(`⚙️ ${ctx.t("button-standard")}`, "admin-referrals-percent-dedicated-standard")
      .text(`🛡 ${ctx.t("button-bulletproof")}`, "admin-referrals-percent-dedicated-bulletproof")
      .row()
      .text(ctx.t("admin-referral-percent-back-to-list"), "admin-referrals-percent-back-to-list");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery("admin-referrals-percent-vds-menu", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const user = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
      select: ["referralPercent", "referralPercentVdsStandard", "referralPercentVdsBulletproof"],
    });
    const fmt = (v: number | null | undefined) => (v != null ? `${v}%` : "—");
    const text = `${ctx.t("ref-percent-label-vds")}\n${ctx.t("button-standard")}: ${fmt(user?.referralPercentVdsStandard)}\n${ctx.t("button-bulletproof")}: ${fmt(user?.referralPercentVdsBulletproof)}`;
    const keyboard = new InlineKeyboard()
      .text(`⚙️ ${ctx.t("button-standard")}`, "admin-referrals-percent-vds-standard")
      .text(`🛡 ${ctx.t("button-bulletproof")}`, "admin-referrals-percent-vds-bulletproof")
      .row()
      .text(ctx.t("admin-referral-percent-back-to-list"), "admin-referrals-percent-back-to-list");
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  const REFERRAL_PERCENT_KEYS: Array<{
    callback: string;
    key: "domains" | "dedicated_standard" | "dedicated_bulletproof" | "vds_standard" | "vds_bulletproof" | "cdn";
    nameKey: string;
  }> = [
    { callback: "admin-referrals-percent-domains", key: "domains", nameKey: "ref-percent-label-domains" },
    { callback: "admin-referrals-percent-dedicated-standard", key: "dedicated_standard", nameKey: "ref-percent-label-dedicated" },
    { callback: "admin-referrals-percent-dedicated-bulletproof", key: "dedicated_bulletproof", nameKey: "ref-percent-label-dedicated" },
    { callback: "admin-referrals-percent-vds-standard", key: "vds_standard", nameKey: "ref-percent-label-vds" },
    { callback: "admin-referrals-percent-vds-bulletproof", key: "vds_bulletproof", nameKey: "ref-percent-label-vds" },
    { callback: "admin-referrals-percent-cdn", key: "cdn", nameKey: "ref-percent-label-cdn" },
  ];

  for (const { callback, key, nameKey } of REFERRAL_PERCENT_KEYS) {
    bot.callbackQuery(callback, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = (await ctx.session) as SessionData;
      if (!session.other.controlUsersPage?.pickedUserData) return;
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) return;
      session.other.referralPercentEdit = { userId: session.other.controlUsersPage.pickedUserData.id, key };
      const name = key.includes("standard") ? `${ctx.t(nameKey)} — ${ctx.t("button-standard")}` : key.includes("bulletproof") ? `${ctx.t(nameKey)} — ${ctx.t("button-bulletproof")}` : ctx.t(nameKey);
      await ctx.reply(ctx.t("admin-referral-percent-enter-for", { name }), { parse_mode: "HTML" });
    });
  }

  bot.callbackQuery(/^admin-user-services-domains-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (ctx.session && (ctx.session as SessionData).main?.user?.role !== Role.Admin && (ctx.session as SessionData).main?.user?.role !== Role.Moderator) return;
    const userId = parseInt(ctx.match[1]);
    const domainRepo = ctx.appDataSource.getRepository(Domain);
    const domains = await domainRepo.find({ where: { userId }, order: { createdAt: "DESC" } });
    const lines = domains.map((d) => `• ${d.domain} — ${d.ns1 || "—"}, ${d.ns2 || "—"}`);
    const text = `${ctx.t("admin-user-services-domains-title")}\n\n${lines.length === 0 ? "—" : lines.join("\n")}`;
    const keyboard = new InlineKeyboard();
    for (const d of domains) {
      keyboard
        .text(`${d.domain} → ${ctx.t("button-admin-domain-change-ns")}`, `admin-domain-ns-${d.id}`)
        .text(ctx.t("button-admin-delete-domain"), `admin-domain-delete-${d.id}`)
        .row();
    }
    keyboard.text(ctx.t("button-admin-register-domain"), `admin-register-domain-${userId}`).row();
    keyboard.text(ctx.t("button-admin-services-back"), `admin-user-services-back-${userId}`);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery(/^admin-register-domain-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main?.user?.role !== Role.Admin && session.main?.user?.role !== Role.Moderator) return;
    const userId = parseInt(ctx.match[1]);
    session.other.adminRegisterDomain = { userId };
    await ctx.reply(ctx.t("admin-domain-register-prompt"), { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^admin-domain-delete-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (ctx.session && (ctx.session as SessionData).main?.user?.role !== Role.Admin && (ctx.session as SessionData).main?.user?.role !== Role.Moderator) return;
    const domainId = parseInt(ctx.match[1]);
    const domainRepo = ctx.appDataSource.getRepository(Domain);
    const domain = await domainRepo.findOne({ where: { id: domainId } });
    if (!domain) {
      await ctx.reply(ctx.t("admin-domain-delete-not-found"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    const userId = domain.userId;
    await domainRepo.remove(domain);
    const domains = await domainRepo.find({ where: { userId }, order: { createdAt: "DESC" } });
    const lines = domains.map((d) => `• ${d.domain} — ${d.ns1 || "—"}, ${d.ns2 || "—"}`);
    const text = `${ctx.t("admin-user-services-domains-title")}\n\n${lines.length === 0 ? "—" : lines.join("\n")}`;
    const keyboard = new InlineKeyboard();
    for (const d of domains) {
      keyboard
        .text(`${d.domain} → ${ctx.t("button-admin-domain-change-ns")}`, `admin-domain-ns-${d.id}`)
        .text(ctx.t("button-admin-delete-domain"), `admin-domain-delete-${d.id}`)
        .row();
    }
    keyboard.text(ctx.t("button-admin-register-domain"), `admin-register-domain-${userId}`).row();
    keyboard.text(ctx.t("button-admin-services-back"), `admin-user-services-back-${userId}`);
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery(/^admin-domain-set-amper-id-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) return;
    const domainId = parseInt(ctx.match[1]);
    session.other.adminDomainSetAmperId = { domainId };
    await ctx.reply(ctx.t("admin-domain-set-amper-id-prompt") + "\nОтмена: /cancel", { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^admin-user-services-back-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const userId = parseInt(ctx.match[1]);
    const now = new Date();
    const totalDepositResult = await ctx.appDataSource.manager.getRepository(TopUp).createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.target_user_id = :uid", { uid: userId })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .getRawOne<{ total: string }>();
    const totalDeposit = Math.round(Number(totalDepositResult?.total ?? 0) * 100) / 100;
    const [activeVds, activeDedicated, activeDomain, vdsCount, dedicatedCount, domainCount, ticketsCount] = await Promise.all([
      ctx.appDataSource.manager.count(VirtualDedicatedServer, { where: { targetUserId: userId, expireAt: MoreThan(now) } }),
      ctx.appDataSource.manager.count(DedicatedServer, { where: { userId, status: DedicatedServerStatus.ACTIVE } }),
      ctx.appDataSource.manager.count(Domain, { where: { userId, status: DomainStatus.REGISTERED } }),
      ctx.appDataSource.manager.count(VirtualDedicatedServer, { where: { targetUserId: userId } }),
      ctx.appDataSource.manager.count(DedicatedServer, { where: { userId } }),
      ctx.appDataSource.manager.count(Domain, { where: { userId } }),
      ctx.appDataSource.manager.count(Ticket, { where: { userId } }),
    ]);
    const activeServicesCount = activeVds + activeDedicated + activeDomain;
    const summaryText = ctx.t("admin-user-services-summary", {
      totalDeposit,
      activeServicesCount,
      ticketsCount,
      vdsCount,
      dedicatedCount,
      domainCount,
    });
    const keyboard = new InlineKeyboard();
    if (domainCount > 0) {
      keyboard.text(ctx.t("button-admin-domains-list", { count: domainCount }), `admin-user-services-domains-${userId}`).row();
    }
    await ctx.editMessageText(summaryText, { parse_mode: "HTML", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery(/^admin-domain-ns-(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) return;
    const domainId = parseInt(ctx.match[1]);
    session.other.adminDomainNs = { domainId };
    await ctx.reply(ctx.t("admin-domain-ns-prompt"), { parse_mode: "HTML" });
  });

  bot.on("message:text", async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    {
      const { handleCdnAddProxyTextInput } = await import("./ui/menus/cdn-menu.js");
      const consumed = await handleCdnAddProxyTextInput(ctx as AppContext);
      if (consumed) return;
    }
    const messageToUser = session.other.messageToUser;
    if (messageToUser) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.messageToUser;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      try {
        await ctx.api.sendMessage(messageToUser.telegramId, ctx.t("admin-message-to-user-prefix") + "\n\n" + input);
        delete session.other.messageToUser;
        await ctx.reply(ctx.t("admin-message-to-user-sent"), { parse_mode: "HTML" });
      } catch (err: any) {
        await ctx.reply(ctx.t("admin-message-to-user-failed", { error: String(err?.message || err).slice(0, 200) }), {
          parse_mode: "HTML",
        });
      }
      return;
    }

    const controlUsersPage = session.other.controlUsersPage;
    if (
      controlUsersPage?.awaitingUserLookup &&
      (session.main.user.role === Role.Admin || session.main.user.role === Role.Moderator)
    ) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      const lookupInput = ctx.message.text.trim();
      if (lookupInput.startsWith("/")) {
        return next();
      }
      const { handleAdminUserLookupText } = await import("./helpers/users-control.js");
      if (await handleAdminUserLookupText(ctx as AppContext, lookupInput)) return;
    }

    const adminVds = session.other.adminVds;
    if (adminVds?.awaitingSearch && session.main.user.role === Role.Admin) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      adminVds.awaitingSearch = false;
      const low = input.toLowerCase();
      if (low === "очистить" || low === "clear") {
        adminVds.searchQuery = "";
      } else {
        adminVds.searchQuery = input;
      }
      adminVds.page = 0;
      const { replyAdminVdsList } = await import("./ui/menus/admin-vds-menu.js");
      await replyAdminVdsList(ctx as AppContext);
      return;
    }

    if (adminVds?.awaitingTransferUserId && session.main.user.role === Role.Admin) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      adminVds.awaitingTransferUserId = false;
      const newUserId = parseInt(input.replace(/\D/g, ""), 10);
      if (Number.isNaN(newUserId) || newUserId <= 0) {
        await ctx.reply(ctx.t("bad-error"));
        return;
      }
      const vid = adminVds.selectedVdsId;
      if (!vid) {
        return next();
      }
      const { VdsService } = await import("./domain/services/VdsService.js");
      const { VdsRepository } = await import("./infrastructure/db/repositories/VdsRepository.js");
      const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
      const { TopUpRepository } = await import("./infrastructure/db/repositories/TopUpRepository.js");
      const { BillingService } = await import("./domain/billing/BillingService.js");
      const vdsRepo = new VdsRepository(ctx.appDataSource);
      const userRepo = new UserRepository(ctx.appDataSource);
      const topUpRepo = new TopUpRepository(ctx.appDataSource);
      const billing = new BillingService(ctx.appDataSource, userRepo, topUpRepo);
      const vdsService = new VdsService(ctx.appDataSource, vdsRepo, billing, ctx.vmmanager);
      try {
        await vdsService.adminTransferVds(vid, newUserId);
        await ctx.reply(ctx.t("admin-vds-transferred", { userId: newUserId }), { parse_mode: "HTML" });
      } catch (e: any) {
        await ctx.reply(ctx.t("error-unknown", { error: e?.message || "err" }), { parse_mode: "HTML" });
      }
      return;
    }

    const adminCdn = session.other.adminCdn;
    if (adminCdn?.awaitingSearch && session.main.user.role === Role.Admin) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      adminCdn.awaitingSearch = false;
      const low = input.toLowerCase();
      adminCdn.searchQuery = low === "очистить" || low === "clear" ? "" : input;
      adminCdn.page = 0;
      const { openAdminCdnPanel } = await import("./ui/menus/admin-cdn-menu.js");
      await openAdminCdnPanel(ctx as AppContext);
      return;
    }

    // Bundle: user entered domain name (after "Купить пакет")
    const bundle = session.other.bundle;
    if (bundle?.step === "awaiting_domain" && ctx.message?.text) {
      const { handleBundleDomainInput } = await import("./ui/menus/bundle-handlers.js");
      const consumed = await handleBundleDomainInput(ctx as AppContext, ctx.message.text.trim());
      if (consumed) return;
    }

    const balanceEdit = session.other.balanceEdit;
    if (balanceEdit) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.balanceEdit;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      const amount = Number.parseFloat(
        input.replaceAll("$", "").replaceAll(",", ".").replaceAll(" ", "").trim()
      );
      if (Number.isNaN(amount) || amount <= 0 || amount > 1_000_000) {
        await ctx.reply(ctx.t("admin-balance-invalid"), { parse_mode: "HTML" });
        return;
      }
      const targetUser = await ctx.appDataSource.manager.findOne(User, {
        where: { id: balanceEdit.userId },
      });
      if (!targetUser) {
        delete session.other.balanceEdit;
        await ctx.reply(ctx.t("error-user-not-found"), { parse_mode: "HTML" });
        return;
      }
      if (balanceEdit.action === "add") {
        targetUser.balance += amount;
      } else {
        if (targetUser.balance < amount) {
          await ctx.reply(
            ctx.t("admin-balance-deduct-more-than-have", {
              balance: targetUser.balance,
              amount,
            }),
            { parse_mode: "HTML" }
          );
          return;
        }
        targetUser.balance -= amount;
      }
      await ctx.appDataSource.manager.save(targetUser);
      // Force fresh DB read for that user on next update.
      invalidateUser(targetUser.telegramId);
      delete session.other.balanceEdit;
      await ctx.reply(
        ctx.t("admin-balance-success", {
          action: balanceEdit.action === "add" ? ctx.t("admin-balance-action-add") : ctx.t("admin-balance-action-deduct"),
          amount,
          balance: targetUser.balance,
        }),
        { parse_mode: "HTML" }
      );
      return;
    }

    const subscriptionEdit = session.other.subscriptionEdit;
    if (subscriptionEdit) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.subscriptionEdit;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      const days = Number.parseInt(input.replace(/\s/g, ""), 10);
      if (Number.isNaN(days) || days <= 0 || days > 3650) {
        await ctx.reply(ctx.t("admin-subscription-invalid-days"), { parse_mode: "HTML" });
        return;
      }
      const targetUser = await ctx.appDataSource.manager.findOne(User, {
        where: { id: subscriptionEdit.userId },
      });
      if (!targetUser) {
        delete session.other.subscriptionEdit;
        await ctx.reply(ctx.t("error-user-not-found"), { parse_mode: "HTML" });
        return;
      }
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      targetUser.primeActiveUntil = until;
      await ctx.appDataSource.manager.save(targetUser);
      delete session.other.subscriptionEdit;
      const { text, reply_markup } = await buildControlPanelUserReply(ctx, targetUser, undefined, controlUser);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
      return;
    }

    const referralPercentEdit = session.other.referralPercentEdit;
    if (referralPercentEdit) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.referralPercentEdit;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input.startsWith("/")) {
        return next();
      }
      const value = Number.parseFloat(input.replace(",", ".").replace(/\s/g, ""));
      if (Number.isNaN(value) || value < 0 || value > 100) {
        await ctx.reply(ctx.t("admin-referral-percent-invalid"), { parse_mode: "HTML" });
        return;
      }
      const targetUser = await ctx.appDataSource.manager.findOne(User, {
        where: { id: referralPercentEdit.userId },
      });
      if (!targetUser) {
        delete session.other.referralPercentEdit;
        await ctx.reply(ctx.t("error-user-not-found"), { parse_mode: "HTML" });
        return;
      }
      const rounded = Math.round(value * 100) / 100;
      const key = referralPercentEdit.key;
      if (key === "default" || !key) {
        targetUser.referralPercent = rounded;
        delete session.other.referralPercentEdit;
        await ctx.reply(ctx.t("admin-referral-percent-success", { percent: rounded }), { parse_mode: "HTML" });
        await ctx.appDataSource.manager.save(targetUser);
        return;
      }
      const columnMap: Record<string, keyof User> = {
        domains: "referralPercentDomains",
        dedicated_standard: "referralPercentDedicatedStandard",
        dedicated_bulletproof: "referralPercentDedicatedBulletproof",
        vds_standard: "referralPercentVdsStandard",
        vds_bulletproof: "referralPercentVdsBulletproof",
        cdn: "referralPercentCdn",
      };
      const col = columnMap[key];
      if (col) {
        (targetUser as any)[col] = rounded;
        await ctx.appDataSource.manager.save(targetUser);
      }
      const name =
        key.startsWith("dedicated_")
          ? `${ctx.t("ref-percent-label-dedicated")} — ${ctx.t(key === "dedicated_standard" ? "button-standard" : "button-bulletproof")}`
          : key.startsWith("vds_")
            ? `${ctx.t("ref-percent-label-vds")} — ${ctx.t(key === "vds_standard" ? "button-standard" : "button-bulletproof")}`
            : ctx.t(key === "domains" ? "ref-percent-label-domains" : "ref-percent-label-cdn");
      delete session.other.referralPercentEdit;
      await ctx.reply(ctx.t("admin-referral-percent-success-for", { name, percent: rounded }), { parse_mode: "HTML" });
      return;
    }

    const adminDomainNs = session.other.adminDomainNs;
    if (adminDomainNs) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.adminDomainNs;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input === "/cancel") {
        delete session.other.adminDomainNs;
        await ctx.reply(ctx.t("admin-domain-ns-cancelled"), { parse_mode: "HTML" });
        return;
      }
      if (input === "/skip") {
        delete session.other.adminDomainNs;
        await ctx.reply(ctx.t("admin-domain-ns-skipped"), { parse_mode: "HTML" });
        return;
      }
      if (input.startsWith("/")) {
        return next();
      }
      const parts = input.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        await ctx.reply(ctx.t("admin-domain-ns-prompt"), { parse_mode: "HTML" });
        return;
      }
      const [ns1, ns2] = [parts[0], parts[1]];
      const nsRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
      if (!nsRegex.test(ns1) || !nsRegex.test(ns2)) {
        await ctx.reply(ctx.t("admin-domain-ns-prompt"), { parse_mode: "HTML" });
        return;
      }
      try {
        const { DomainRepository } = await import("./infrastructure/db/repositories/DomainRepository.js");
        const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
        const { TopUpRepository } = await import("./infrastructure/db/repositories/TopUpRepository.js");
        const { BillingService } = await import("./domain/billing/BillingService.js");
        const { AmperDomainsProvider } = await import("./infrastructure/domains/AmperDomainsProvider.js");
        const { AmperDomainService } = await import("./domain/services/AmperDomainService.js");
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
        const domain = await domainService.updateNameservers(adminDomainNs.domainId, ns1, ns2);
        delete session.other.adminDomainNs;
        await ctx.reply(ctx.t("admin-domain-ns-success", { domain: domain.domain }), { parse_mode: "HTML" });
      } catch (err: any) {
        await ctx.reply(
          ctx.t("admin-domain-ns-failed", { error: String(err?.message || err).slice(0, 200) }),
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    const adminDomainSetAmperId = session.other.adminDomainSetAmperId;
    if (adminDomainSetAmperId) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.adminDomainSetAmperId;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input === "/cancel") {
        delete session.other.adminDomainSetAmperId;
        await ctx.reply(ctx.t("admin-domain-set-amper-id-cancelled"), { parse_mode: "HTML" });
        return;
      }
      if (input.startsWith("/")) {
        return next();
      }
      try {
        const { DomainRepository } = await import("./infrastructure/db/repositories/DomainRepository.js");
        const { UserRepository } = await import("./infrastructure/db/repositories/UserRepository.js");
        const { TopUpRepository } = await import("./infrastructure/db/repositories/TopUpRepository.js");
        const { BillingService } = await import("./domain/billing/BillingService.js");
        const { AmperDomainsProvider } = await import("./infrastructure/domains/AmperDomainsProvider.js");
        const { AmperDomainService } = await import("./domain/services/AmperDomainService.js");
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
        const domain = await domainService.setProviderDomainId(adminDomainSetAmperId.domainId, input);
        delete session.other.adminDomainSetAmperId;
        await ctx.reply(ctx.t("admin-domain-set-amper-id-success", { domain: domain.domain }), { parse_mode: "HTML" });
      } catch (err: any) {
        await ctx.reply(
          ctx.t("admin-domain-ns-failed", { error: String(err?.message || err).slice(0, 200) }),
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    const adminRegisterDomain = session.other.adminRegisterDomain;
    if (adminRegisterDomain) {
      if (!ctx.hasChatType("private")) {
        return next();
      }
      if (session.main.user.role !== Role.Admin && session.main.user.role !== Role.Moderator) {
        delete session.other.adminRegisterDomain;
        return next();
      }
      const input = ctx.message.text.trim();
      if (input === "/cancel") {
        delete session.other.adminRegisterDomain;
        await ctx.reply(ctx.t("admin-domain-register-cancelled"), { parse_mode: "HTML" });
        return;
      }
      if (input.startsWith("/")) {
        return next();
      }
      const fullDomain = input.toLowerCase().replace(/^\s+|\s+$/g, "");
      const lastDot = fullDomain.lastIndexOf(".");
      if (lastDot <= 0 || lastDot === fullDomain.length - 1) {
        await ctx.reply(ctx.t("admin-domain-register-failed", { error: "Invalid format (use example.com)" }), { parse_mode: "HTML" });
        return;
      }
      const tld = fullDomain.slice(lastDot + 1);
      const domainName = fullDomain.slice(0, lastDot);
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(domainName) || !/^[a-z]{2,}$/i.test(tld)) {
        await ctx.reply(ctx.t("admin-domain-register-failed", { error: "Invalid domain or TLD" }), { parse_mode: "HTML" });
        return;
      }
      try {
        const domainRepo = ctx.appDataSource.getRepository(Domain);
        const existing = await domainRepo.findOne({ where: { userId: adminRegisterDomain.userId, domain: fullDomain } });
        if (existing) {
          await ctx.reply(ctx.t("admin-domain-register-failed", { error: "Domain already exists for this user" }), { parse_mode: "HTML" });
          return;
        }
        const defaultNs1 = process.env.DEFAULT_NS1?.trim() || undefined;
        const defaultNs2 = process.env.DEFAULT_NS2?.trim() || undefined;
        let providerDomainId: string | null = null;
        let ns1 = defaultNs1 ?? null;
        let ns2 = defaultNs2 ?? null;

        const amperBaseUrl = process.env.AMPER_API_BASE_URL?.trim();
        const amperToken = process.env.AMPER_API_TOKEN?.trim();
        let amperError: string | null = null;
        if (amperBaseUrl && amperToken) {
          try {
            const { AmperDomainsProvider } = await import("./infrastructure/domains/AmperDomainsProvider.js");
            const provider = new AmperDomainsProvider({
              apiBaseUrl: amperBaseUrl,
              apiToken: amperToken,
              timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
              defaultNs1: process.env.DEFAULT_NS1,
              defaultNs2: process.env.DEFAULT_NS2,
            });
            const result = await provider.registerDomain({
              domain: fullDomain,
              period: 1,
              ns1: defaultNs1,
              ns2: defaultNs2,
            });
            if (result.success) {
              providerDomainId = result.domainId || null;
              if (defaultNs1) ns1 = defaultNs1;
              if (defaultNs2) ns2 = defaultNs2;
            } else {
              amperError = result.error || "Unknown error";
            }
          } catch (err: any) {
            amperError = err?.message || String(err);
          }
        }

        const domain = new Domain();
        domain.userId = adminRegisterDomain.userId;
        domain.domain = fullDomain;
        domain.tld = tld;
        domain.period = 1;
        domain.price = 0;
        domain.status = DomainStatus.REGISTERED;
        domain.ns1 = ns1;
        domain.ns2 = ns2;
        domain.provider = "amper";
        domain.providerDomainId = providerDomainId;
        await domainRepo.save(domain);
        delete session.other.adminRegisterDomain;
        if (providerDomainId) {
          await ctx.reply(ctx.t("admin-domain-register-success", { domain: domain.domain }), { parse_mode: "HTML" });
        } else if (amperError) {
          await ctx.reply(
            ctx.t("admin-domain-register-success-local-amper-failed", { domain: domain.domain, error: amperError }),
            { parse_mode: "HTML" }
          );
        } else {
          await ctx.reply(
            ctx.t("admin-domain-register-success-local-no-amper", { domain: domain.domain }),
            { parse_mode: "HTML" }
          );
        }
      } catch (err: any) {
        await ctx.reply(
          ctx.t("admin-domain-register-failed", { error: String(err?.message || err).slice(0, 200) }),
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    if (!session.other.promocode.awaitingInput) {
      return next();
    }
    if (!ctx.hasChatType("private")) {
      return next();
    }
    const input = ctx.message.text.trim();
    if (input.startsWith("/")) {
      return next();
    }

    session.other.promocode.awaitingInput = false;
    await handlePromocodeInput(ctx, input);
  });

  // VDS manage inline prompts (rename / manual password) without conversations.
  bot.on("message:text", async (ctx, next) => {
    const handled = await handlePendingVdsManageInput(ctx as AppContext);
    if (handled) return;
    return next();
  });

  // Withdraw: user tapped "Вывод средств", we asked for amount; this message is the amount → enter conversation
  bot.on("message:text", async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    const withdrawStart = session.other?.withdrawStart;
    if (!withdrawStart?.awaitingAmount || !ctx.message?.text) {
      return next();
    }
    if (!ctx.hasChatType("private")) {
      return next();
    }
    const text = ctx.message.text.trim().replace(/[$,]/g, "");
    const amount = parseFloat(text);
    const maxBalance = withdrawStart.maxBalance ?? 0;
    delete session.other.withdrawStart;

    if (isNaN(amount) || amount <= 0) {
      await ctx.reply(ctx.t("withdraw-invalid-amount"));
      return;
    }
    if (amount < 15) {
      await ctx.reply(ctx.t("withdraw-minimum-not-met", { balance: maxBalance }));
      return;
    }
    if (amount > maxBalance) {
      await ctx.reply(ctx.t("withdraw-amount-exceeds-balance", { amount, balance: maxBalance }));
      return;
    }

    session.other.withdrawInitialAmount = amount;
    try {
      await ctx.conversation.enter("withdrawRequestConversation");
    } catch (err: unknown) {
      Logger.error("Failed to start withdraw conversation:", err);
      delete session.other.withdrawInitialAmount;
      await ctx.reply(ctx.t("error-unknown", { error: "failed to start" })).catch(() => {});
    }
  });

  bot.on("message:text", async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    if (!session.other.deposit.awaitingAmount) {
      return next();
    }
    if (!ctx.hasChatType("private")) {
      return next();
    }
    const input = ctx.message.text.trim();
    if (input.startsWith("/")) {
      return next();
    }

    session.other.deposit.awaitingAmount = false;

    const sumToDeposit = Number.parseFloat(
      input.replaceAll("$", "").replaceAll(",", "").replaceAll(" ", "").trim()
    );

    if (isNaN(sumToDeposit) || sumToDeposit < 5 || sumToDeposit > 1_500_000) {
      await ctx.reply(ctx.t("deposit-money-incorrect-sum"), { parse_mode: "HTML" });
      return;
    }

    session.main.lastSumDepositsEntered = sumToDeposit;
    session.other.deposit.selectedAmount = sumToDeposit;
    await ctx.reply(renderTopupAmountsText(ctx as AppContext), {
      reply_markup: depositMenu,
      parse_mode: "HTML",
    });
  });

  vdsManageSpecific.register(vdsReinstallOs);
  vdsManageServiceMenu.register(vdsReinstallOs, "vds-manage-services-list");

  // Domain purchase flow for zone-based domains menu
  bot.on("message:text", async (ctx, next) => {
    const session = (await ctx.session) as SessionData;
    const pendingZone = session.other.domains?.pendingZone;
    if (!pendingZone) {
      return next();
    }
    if (!ctx.hasChatType("private")) {
      return next();
    }
    if (session.other.broadcast?.step === "awaiting_text") {
      return next();
    }

    const input = ctx.message.text.trim().toLowerCase();
    if (input.startsWith("/")) {
      return next();
    }

    // If user entered full domain (e.g. "name.com"), use it as-is; do not append pendingZone (would produce "name.com.club")
    const domain = input.includes(".")
      ? input
      : `${input}${pendingZone}`;
    const domainChecker = new DomainChecker();

    if (!domainChecker.domainIsValid(domain)) {
      await ctx.reply(
        ctx.t("domain-invalid", {
          domain: escapeUserInput(domain),
        }),
        { parse_mode: "HTML" }
      );
      await ctx.reply(ctx.t("domain-question", { zoneName: pendingZone }), {
        reply_markup: new InlineKeyboard().text(
          ctx.t("button-cancel"),
          "domain-register-cancel"
        ),
        parse_mode: "HTML",
      });
      return;
    }

    try {
      await ctx.reply(ctx.t("domain-checking-availability", { domain }));

      let available: boolean;
      const amperBaseUrl = process.env.AMPER_API_BASE_URL || "";
      const amperToken = process.env.AMPER_API_TOKEN || "";

      let checkReason: string | undefined;
      if (amperBaseUrl && amperToken) {
        const { AmperDomainsProvider } = await import("./infrastructure/domains/AmperDomainsProvider.js");
        const provider = new AmperDomainsProvider({
          apiBaseUrl: amperBaseUrl,
          apiToken: amperToken,
          timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
        });
        const result = await provider.checkAvailability(domain);
        Logger.info(`[DomainCheck] Amper result for ${domain}:`, {
          available: result.available,
          formatError: result.formatError,
          reason: result.reason,
          domain: result.domain,
        });
        // Если Amper возвращает ошибку формата — не можем определить доступность заранее
        // Разрешаем попытку регистрации, Amper сам проверит при регистрации
        if (result.formatError) {
          Logger.warn(`[DomainCheck] Format error for ${domain}, allowing registration attempt`);
          // Показываем предупреждение, но разрешаем попробовать зарегистрировать
          available = true;
          checkReason = "⚠️ Проверка доступности через API недоступна. При регистрации домен будет проверен автоматически.";
        } else {
          available = result.available;
          checkReason = result.reason;
          Logger.info(`[DomainCheck] Domain ${domain} availability: ${available}, reason: ${checkReason}`);
        }
      } else if (process.env.DOMAINR_TOKEN && process.env.DOMAINR_TOKEN.trim().length > 0) {
        try {
          const status = await domainChecker.getStatus(domain);
          available = status === "Available";
        } catch {
          // DomainR не работает — разрешаем попробовать зарегистрировать
          available = true;
        }
      } else {
        available = true;
      }

      if (available) {
        session.other.domains.lastPickDomain = domain;
        session.other.domains.pendingZone = undefined; // clear so next message doesn't reuse old zone

        await ctx.reply(
          ctx.t("domain-available", {
            domain: `${escapeUserInput(domain)}`,
          }),
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              ctx.t("button-agree"),
              `agree-buy-domain:${domain}`
            ),
          }
        );
        return;
      }

      const notAvailableText = checkReason
        ? ctx.t("domain-not-available-with-reason", {
            domain: escapeUserInput(domain),
            reason: checkReason.slice(0, 200),
          })
        : ctx.t("domain-not-available", { domain: escapeUserInput(domain) });
      await ctx.reply(notAvailableText, { parse_mode: "HTML" });
      await ctx.reply(ctx.t("domain-check-unrelated-to-balance"), { parse_mode: "HTML" });
      await ctx.reply(ctx.t("domain-question", { zoneName: pendingZone }), {
        reply_markup: new InlineKeyboard().text(
          ctx.t("button-cancel"),
          "domain-register-cancel"
        ),
        parse_mode: "HTML",
      });
    } catch (error: any) {
      console.error("[Domain] Check failed:", error);
      await ctx.reply(
        ctx.t("error-unknown", { error: error?.message || "Unknown error" })
      );
    }
  });

  // Register commands AFTER all menus are registered via bot.use()
  // Balance command - show profile with balance
  bot.command("balance", async (ctx) => {
    try {
      if (ctx.message) {
        await ctx.deleteMessage().catch(() => {});
      }

      const session = (await ctx.session) as SessionData;
      session.other.deposit.prefilledAmount = false;
      session.other.deposit.selectedAmount = 50;
      session.main.lastSumDepositsEntered = 0;
      
      if (!ctx.hasChatType("private")) {
        return;
      }

      // Open topup method menu
      await ctx.reply(ctx.t("topup-select-method"), {
        reply_markup: topupMethodMenu,
        parse_mode: "HTML",
      });
    } catch (error: any) {
      console.error("Failed to execute /balance command:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Services command — сразу список тарифов VPS
  bot.command("services", async (ctx) => {
    try {
      if (ctx.message) {
        await ctx.deleteMessage().catch(() => {});
      }

      await openVpsTariffSelection(ctx as AppContext);
    } catch (error: any) {
      console.error("Failed to execute /services command:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Admin panel command (admin only) — check ONLY by DB, ignore session
  bot.command("admin", async (ctx) => {
    try {
      if (ctx.message) await ctx.deleteMessage().catch(() => {});

      const telegramId = ctx.chatId ?? ctx.from?.id;
      if (!telegramId) {
        await ctx.reply(ctx.t("error-access-denied"));
        return;
      }
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
      const session = (await ctx.session) as SessionData;
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
      console.error("[Admin] /admin failed:", error);
      await ctx.reply(ctx.t("error-unknown", { error: error.message || "Unknown error" }));
    }
  });

  // Broadcast command (admin only)
  bot.command("broadcast", async (ctx) => {
    const session = (await ctx.session) as SessionData;
    const hasSessionUser = await ensureSessionUser(ctx as AppContext);
    if (!session || !hasSessionUser) {
      await ctx.reply(ctx.t("error-unknown", { error: "Session not initialized" }));
      return;
    }
    if (session.main.user.role !== Role.Admin) {
      return;
    }

    session.other.broadcast = { step: "awaiting_text" };
    await ctx.reply(ctx.t("broadcast-enter-text"), { parse_mode: "HTML" });
  });

  // Send broadcast immediately (admin only)
  bot.command("send", async (ctx) => {
    const session = (await ctx.session) as SessionData;
    const hasSessionUser = await ensureSessionUser(ctx as AppContext);
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
      const broadcastService = new BroadcastService(ctx.appDataSource, bot as any);
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

  // Register bot commands in Telegram menu (after all commands are registered)
  bot.api.setMyCommands([
    { command: "start", description: "Главное меню" },
    { command: "balance", description: "Проверить баланс" },
    { command: "services", description: "Управление услугами" },
  ]).catch((error) => {
    console.error("Failed to set bot commands:", error);
  });

  mainMenu.register(supportMenu, "main-menu");
  mainMenu.register(profileMenu, "main-menu");
  mainMenu.register(servicesMenu, "main-menu");
  
  // Register referrals menu in main menu
  try {
    const { referralsMenu } = await import("./ui/menus/referrals-menu");
    mainMenu.register(referralsMenu, "main-menu");
  } catch (error: any) {
    console.error("[Bot] Failed to register referrals menu in main menu:", error);
  }
  
  // Register admin menu in main menu (for admins)
  try {
    mainMenu.register(adminMenu, "main-menu");
  } catch (error: any) {
    console.error("[Bot] Failed to register admin menu in main menu:", error);
  }

  try {
    adminMenu.register(adminPromosMenu, "admin-menu");
    adminMenu.register(adminAutomationsMenu, "admin-menu");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register admin submenus:", error);
    }
  }

  manageSerivcesMenu.register(domainManageServicesMenu, "manage-services-menu");
  manageSerivcesMenu.register(vdsManageServiceMenu, "manage-services-menu");
  manageSerivcesMenu.register(bundleManageServicesMenu, "manage-services-menu");
  // CDN menu is registered under services-menu only; manage services opens it via .text() + reply_markup
  // Register bundles menu
  try {
    const { bundleTypeMenu, bundlePeriodMenu } = await import("./ui/menus/bundles-menu.js");
    servicesMenu.register(bundleTypeMenu, "services-menu");
    bundleTypeMenu.register(bundlePeriodMenu, "bundle-type-menu");
  } catch (error: any) {
    console.error("[Bot] Failed to register bundles menu:", error);
  }

  servicesMenu.register(domainsMenu, "services-menu");
  try {
    servicesMenu.register(dedicatedTypeMenu, "services-menu");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register dedicatedTypeMenu:", error);
    }
  }
  servicesMenu.register(vdsTypeMenu, "services-menu");
  
  // dedicatedServersMenu: bot.use only (legacy keyboards); not registered under type — shop flow is inline (dsh:*).
  try {
    dedicatedServersMenu.register(dedicatedSelectedServerMenu, "dedicated-servers-menu");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register dedicatedSelectedServerMenu:", error);
    }
  }

  // Register dedicated location menu (after Make Order) and OS menu
  try {
    dedicatedSelectedServerMenu.register(dedicatedLocationMenu, "dedicated-selected-server");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register dedicatedLocationMenu:", error);
    }
  }
  try {
    dedicatedLocationMenu.register(dedicatedOsMenu, "dedicated-location-menu");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register dedicatedOsMenu:", error);
    }
  }
  
  // vdsMenu: legacy chain for OS selection only (bot.use); not nested under vds-type-menu (shop is inline vsh:*).
  try {
    vdsMenu.register(vdsRateChoose, "vds-menu");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register vdsRateChoose:", error);
    }
  }
  try {
    vdsRateChoose.register(vdsRateOs, "vds-selected-rate");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register vdsRateOs:", error);
    }
  }
  profileMenu.register(topupMethodMenu, "profile-menu");
  profileMenu.register(changeLocaleMenu, "profile-menu");
  topupMethodMenu.register(depositMenu, "topup-method-menu");

  // Register menu hierarchy (only in index.ts, not in bot.ts)
  // Note: Registration is done conditionally to avoid duplicate registration
  try {
    controlUsers.register(controlUser, "control-users");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUser under controlUsers:", error);
    }
  }
  try {
    controlUser.register(controlUserBalance, "control-user");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUserBalance:", error);
    }
  }
  try {
    controlUser.register(controlUserSubscription, "control-user");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUserSubscription:", error);
    }
  }
  try {
    controlUser.register(controlUserStatus, "control-user");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUserStatus:", error);
    }
  }
  try {
    controlUser.register(controlUserServices, "control-user");
    controlUserServices.register(controlUserServicesAdd, "control-user-services");
    controlUserServices.register(controlUserServicesDelete, "control-user-services");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUserServices menus:", error);
    }
  }
  try {
    controlUserStatus.register(controlUser, "control-user-status");
  } catch (error: any) {
    if (!error.message?.includes("already registered")) {
      console.error("[Bot] Failed to register controlUser in controlUserStatus:", error);
    }
  }

  registerAdminServiceManagementCallbacks(bot);

  registerDomainRegistrationMiddleware(bot);

  bot.command("domainrequests", async (ctx) => {
    const session = (await ctx.session) as SessionData;
    if (
      session.main.user.role != Role.Admin &&
      session.main.user.role != Role.Moderator
    )
      return;

    const { DomainRequestRepository } = await import("./infrastructure/db/repositories/DomainRequestRepository.js");
    const domainRequestRepo = new DomainRequestRepository(ctx.appDataSource);

    const requests = await domainRequestRepo.findPending();

    if (requests.length > 0) {
      ctx.reply(
        `${ctx.t("domain-request-list-header")}\n${requests
          .map((request) =>
            ctx.t("domain-request", {
              id: request.id,
              targetId: request.target_user_id,
              domain: `${request.domainName}${request.zone}`,
              info: request.additionalInformation || ctx.t("empty"),
            })
          )
          .join("\n")}\n\n${ctx.t("domain-request-list-info")}`,
        {
          parse_mode: "HTML",
        }
      );
    } else {
      ctx.reply(
        `${ctx.t("domain-request-list-header")}\n${ctx.t("list-empty")}`,
        {
          parse_mode: "HTML",
        }
      );
    }
  });

  bot.command("help", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (session.main.user.role == Role.Admin) {
      ctx.reply(ctx.t("admin-help"), {
        parse_mode: "HTML",
      });
    }
  });

  bot.command("promote_link", async (ctx) => {
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role != Role.Admin) return;

    const link = createLink(Role.Moderator);
    const createdLink = await ctx.appDataSource.manager.save(link);

    ctx.reply(ctx.t("promote-link"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().url(
        ctx.t("button-send-promote-link"),
        `tg://msg_url?url=https://t.me/${ctx.me.username}?start=${PREFIX_PROMOTE}${createdLink.code}`
      ),
    });
  });

  // create_promo <name> <sum> <max_uses>
  bot.command("create_promo", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (session.main.user.role != Role.Admin) return;

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 3) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [name, sum, maxUses] = args;

    if (!name || isNaN(Number(sum)) || isNaN(Number(maxUses))) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const promoRepo = ctx.appDataSource.getRepository(Promo);

    const promo = await promoRepo.findOneBy({
      code: name.toLowerCase(),
    });

    if (promo) {
      await ctx.reply(ctx.t("promocode-already-exist"));
      return;
    }

    const newPromo = new Promo();

    newPromo.code = name.toLowerCase();
    newPromo.maxUses = Number(maxUses);
    newPromo.sum = Number(sum);
    newPromo.isActive = true;

    await promoRepo.save(newPromo);

    await ctx.reply(ctx.t("new-promo-created"), {
      parse_mode: "HTML",
    });
  });

  // promo_codes
  bot.command("promo_codes", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (session.main.user.role != Role.Admin) return;

    const promoRepo = ctx.appDataSource.getRepository(Promo);

    const promos = await promoRepo.find({});
    let promocodeList;
    if (promos.length == 0) {
      promocodeList = ctx.t("list-empty");
    } else {
      // name use maxUses
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

  // remove_promo <id>
  bot.command("remove_promo", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (session.main.user.role != Role.Admin) return;

    const promoRepo = ctx.appDataSource.getRepository(Promo);

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [id] = args;

    if (!id || isNaN(Number(id))) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const promo = await promoRepo.findOneBy({
      id: Number(id),
    });

    if (!promo) {
      await ctx.reply(ctx.t("promocode-not-found"));
      return;
    }

    await promoRepo.delete({
      id: Number(id),
    });

    await ctx.reply(
      ctx.t("promocode-deleted", {
        name: promo.code,
      }),
      {
        parse_mode: "HTML",
      }
    );
  });

  // approve_domain <id> <expire_at>
  bot.command("approve_domain", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (
      session.main.user.role != Role.Admin &&
      session.main.user.role != Role.Moderator
    )
      return;

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 2) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [id, expireAt] = args;

    const expireAtN = ms(expireAt);

    if (!id || isNaN(Number(id)) || !expireAt || expireAtN == undefined) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const domainRequestRepo = ctx.appDataSource.getRepository(DomainRequest);

    const request = await domainRequestRepo.findOneBy({
      id: Number(id),
      status: DomainRequestStatus.InProgress,
    });

    if (!request) {
      await ctx.reply(ctx.t("domain-request-not-found"));
      return;
    }

    request.status = DomainRequestStatus.Completed;
    request.expireAt = new Date(Date.now() + expireAtN);
    request.payday_at = new Date(
      request.expireAt.getTime() - 7 * 24 * 60 * 60 * 1000
    );

    await domainRequestRepo.save(request);

    await ctx.reply(ctx.t("domain-request-approved", {}), {
      parse_mode: "HTML",
    });
  });

  // showvds <userId>
  bot.command("showvds", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (
      session.main.user.role != Role.Admin &&
      session.main.user.role != Role.Moderator
    )
      return;

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [userId] = args;

    if (!userId || isNaN(Number(userId))) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const vdsRepo = ctx.appDataSource.getRepository(VirtualDedicatedServer);

    const vdsList = await vdsRepo.find({
      where: {
        targetUserId: Number(userId),
      },
    });

    if (vdsList.length === 0) {
      await ctx.reply(ctx.t("no-vds-found"));
      return;
    }

    const vdsInfo = vdsList
      .map((vds) =>
        ctx.t("vds-info-admin", {
          id: vds.id,
          ip: vds.ipv4Addr,
          expireAt: vds.expireAt.toISOString(),
          renewalPrice: vds.renewalPrice,
        })
      )
      .join("\n");

    await ctx.reply(vdsInfo, {
      parse_mode: "HTML",
    });
  });

  // removevds <idVds>
  bot.command("removevds", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (
      session.main.user.role != Role.Admin &&
      session.main.user.role != Role.Moderator
    )
      return;

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [idVds] = args;

    if (!idVds || isNaN(Number(idVds))) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const vdsRepo = ctx.appDataSource.getRepository(VirtualDedicatedServer);

    const vds = await vdsRepo.findOneBy({
      id: Number(idVds),
    });

    if (!vds) {
      await ctx.reply(ctx.t("vds-not-found"));
      return;
    }

    let result;
    let attempts = 0;

    while (result == undefined && attempts < 3) {
      result = await ctx.vmmanager.deleteVM(vds.vdsId);
      attempts++;
    }

    if (result == undefined) {
      await ctx.reply(ctx.t("vds-remove-failed", { id: idVds }), {
        parse_mode: "HTML",
      });
      return;
    }

    await vdsRepo.delete({
      id: Number(idVds),
    });

    await ctx.reply(ctx.t("vds-removed", { id: idVds }), {
      parse_mode: "HTML",
    });
  });

  // reject_domain <id>
  bot.command("reject_domain", async (ctx) => {
    const session = (await ctx.session) as SessionData;

    if (
      session.main.user.role != Role.Admin &&
      session.main.user.role != Role.Moderator
    )
      return;

    const args = ctx.match.split(" ").map((s) => s.trim());

    if (!args || args.length !== 1) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const [id] = args;

    if (!id || isNaN(Number(id))) {
      await ctx.reply(ctx.t("invalid-arguments"));
      return;
    }

    const domainRequestRepo = ctx.appDataSource.getRepository(DomainRequest);
    const userRequestRepo = ctx.appDataSource.getRepository(User);

    const request = await domainRequestRepo.findOneBy({
      id: Number(id),
      status: DomainRequestStatus.InProgress,
    });

    if (!request) {
      await ctx.reply(ctx.t("domain-request-not-found"));
      return;
    }

    request.status = DomainRequestStatus.Failed;

    const user = await userRequestRepo.findOneBy({
      id: session.main.user.id,
    });

    if (user) {
      user.balance += request.price;
      await userRequestRepo.save(user);
    }

    await domainRequestRepo.save(request);
    await ctx.reply(ctx.t("domain-request-reject", {}), {
      parse_mode: "HTML",
    });
  });

  bot.command("users", async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    const session = (await ctx.session) as SessionData;
    if (session.main.user.role == Role.User) return;

    await ctx.reply(ctx.t("control-panel-users"), {
      reply_markup: controlUsers,
      parse_mode: "HTML",
    });
  });

  const isWebhookEnabled = (): boolean => {
    const url = process.env.IS_WEBHOOK?.trim();
    const port = process.env.PORT_WEBHOOK?.trim();
    if (!url || !port) {
      return false;
    }
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const run = async () => {
    console.info("[Sephora Host Bot]: Starting");
    await getAppDataSource();
    if (isWebhookEnabled()) {
      console.info("[Sephora Host Bot]: Starting in webhook mode");
      const app = express();

      app.use(
        express.json({
          verify: (req: Request, _res: Response, buf: Buffer) => {
            (req as any).rawBody = buf.toString("utf8");
          },
        })
      );
      app.post("/webhooks/cryptopay", (req: Request, res: Response) =>
        handleCryptoPayWebhook(req, res, bot)
      );
      app.use(
        webhookCallback(bot, "express", {
          onTimeout: "return",
        })
      );

      await bot.api.setWebhook(process.env.IS_WEBHOOK!);

      app.listen(Number(process.env.PORT_WEBHOOK), () => {});
    } else {
      if (process.env.IS_WEBHOOK || process.env.PORT_WEBHOOK) {
        console.warn(
          "[Sephora Host Bot]: Webhook disabled. Check IS_WEBHOOK (must be https URL) and PORT_WEBHOOK."
        );
      }
      // Delete webhook anyway in this way :)
      await bot.api.deleteWebhook();

      bot.catch((err) => {
        if (isIgnoredTelegramBotNoise(err)) {
          return;
        }
        console.error("[Bot Error]", err.name, err.message);
        if (process.env["NODE_ENV"] == "development") {
          console.error(err.stack);
        }
        // Don't crash the bot on errors
      });
      
      // Global error handlers to prevent crashes
      process.on("unhandledRejection", (reason, promise) => {
        console.error("[Unhandled Rejection]", reason);
        // Don't exit, just log
      });
      
      process.on("uncaughtException", (error) => {
        console.error("[Uncaught Exception]", error);
        // Don't exit in development, but log
        if (process.env["NODE_ENV"] != "development") {
          process.exit(1);
        }
      });

      console.info("[Sephora Host Bot]: Starting in long polling mode");
      grammyRun(bot);

      console.info("[Sephora Host Bot]: Started");
    }
  };

  startCheckTopUpStatus(bot);
  const servicePaymentChecker = new ServicePaymentStatusChecker(bot);
  servicePaymentChecker.start();

  await run();
}

index()
  .then(() => {
    console.log("[Bot] Initialization completed successfully");
    const cryptopayToken =
      process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
      process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
    if (cryptopayToken) {
      console.log("[Bot] Crypto Pay (CryptoBot): configured");
    } else {
      console.warn(
        "[Bot] Crypto Pay (CryptoBot): not configured — set PAYMENT_CRYPTOBOT_TOKEN or PAYMENT_CRYPTO_PAY_TOKEN in .env"
      );
    }
    const adminIds = getAdminTelegramIds();
    if (adminIds.length > 0) {
      console.log("[Bot] Admin Telegram IDs (ADMIN_TELEGRAM_IDS):", adminIds.join(", "));
    } else {
      console.log("[Bot] Admin Telegram IDs: not set (add ADMIN_TELEGRAM_IDS to .env for admin-by-ID)");
    }
    const primeChannel = getPrimeChannelForCheck();
    if (primeChannel != null) {
      console.log("[Bot] Prime trial channel (for subscription check):", primeChannel);
      if (typeof primeChannel === "number" && primeChannel > 0) {
        console.log("[Bot] Prime: for private channels use full ID with -100 prefix, e.g. PRIME_CHANNEL_ID=-1001234567890 (get ID from @userinfobot in the channel)");
      }
    } else {
      console.log("[Bot] Prime trial channel: not set (add PRIME_CHANNEL_ID or PRIME_CHANNEL_USERNAME to .env for «Я подписался»)");
    }
  })
  .catch((err) => {
    console.error("[Bot] Fatal error during initialization:", err);
    // In development, don't exit immediately - allow nodemon to restart
    if (process.env["NODE_ENV"] != "development") {
      process.exit(1);
    }
  });

