/**
 * Main bot initialization and configuration.
 * Thin bootstrap file that wires all components together.
 *
 * @module app/bot
 */

import {
  Bot,
  session,
  MemorySessionStorage,
  webhookCallback,
  InlineKeyboard,
} from "grammy";
import { FileAdapter } from "@grammyjs/storage-file";
import { useFluent } from "@grammyjs/fluent";
import { conversations } from "@grammyjs/conversations";
import { run as grammyRun } from "@grammyjs/runner";
import express, { type NextFunction, type Request, type Response } from "express";

import { config, isWebhookMode, getWebhookPort } from "./config.js";
import { Logger } from "./logger.js";
import { setupErrorHandler } from "./error-handler.js";
import {
  databaseMiddleware,
  localeMiddleware,
  banCheckMiddleware,
  vmmanagerMiddleware,
  languagesMiddleware,
} from "./middlewares.js";
import { startOsListBackgroundRefresh } from "../shared/vmmanager-os-cache.js";
import { initFluent } from "../fluent.js";
import { getAppDataSource } from "../infrastructure/db/datasource.js";
import { createVmProvider } from "../infrastructure/vmmanager/factory.js";
import { Role, UserStatus } from "../entities/User.js";
import type { AppContext } from "../shared/types/context.js";
import type { MainSessionData, OtherSessionData } from "../shared/types/session.js";
import { PaymentStatusChecker } from "../domain/billing/PaymentStatusChecker.js";
import { ServicePaymentStatusChecker } from "../domain/billing/ServicePaymentStatusChecker.js";
import { BillingService } from "../domain/billing/BillingService.js";
import { UserRepository } from "../infrastructure/db/repositories/UserRepository.js";
import { invalidateUser } from "../shared/user-cache.js";
import { TopUpRepository } from "../infrastructure/db/repositories/TopUpRepository.js";
import { ExpirationService } from "../domain/services/ExpirationService.js";
import { handleCryptoPayWebhook } from "../infrastructure/payments/cryptopay-webhook.js";
import {
  adminPromosMenu,
  registerAdminPromosHandlers,
} from "../ui/menus/admin-promocodes-menu.js";

/**
 * Initialize and configure the Telegram bot.
 *
 * @returns Configured bot instance and cleanup function
 */
export async function createBot(): Promise<{
  bot: Bot<AppContext>;
  cleanup: () => Promise<void>;
}> {
  Logger.info("Initializing bot...");

  // Initialize Fluent i18n
  const { fluent, availableLocales } = await initFluent();
  Logger.info("Fluent i18n initialized");

  // Initialize database
  const dataSource = await getAppDataSource();
  Logger.info("Database initialized");

  // Initialize VM provider (VMManager/Proxmox)
  const vmManager = createVmProvider();
  startOsListBackgroundRefresh(vmManager);
  Logger.info("VM provider initialized");

  // Initialize services
  const userRepo = new UserRepository(dataSource);
  const topUpRepo = new TopUpRepository(dataSource);
  const billingService = new BillingService(dataSource, userRepo, topUpRepo);
  Logger.info("Services initialized");

  // Create bot instance first
  const bot = new Bot<AppContext>(config.BOT_TOKEN, {});

  // Inline mode: pop-up card above input (title + description), like Market & Tochka. Placeholder "Search..." = BotFather.
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

  // Initialize payment status checker with bot
  const paymentChecker = new PaymentStatusChecker(bot as any, billingService, fluent);
  Logger.info("PaymentStatusChecker initialized");
  const servicePaymentChecker = new ServicePaymentStatusChecker(bot as any);
  Logger.info("ServicePaymentStatusChecker initialized");

  // Setup session
  bot.use(
    session({
      type: "multi",
      other: {
        storage: new MemorySessionStorage<OtherSessionData>(),
        initial: (): OtherSessionData => ({
          broadcast: {
            step: "idle",
          },
          controlUsersPage: {
            orderBy: "id",
            sortBy: "ASC",
            page: 0,
          },
          vdsRate: {
            bulletproof: true,
            selectedRateId: -1,
            selectedOs: -1,
          },
          dedicatedType: {
            bulletproof: false,
            selectedDedicatedId: -1,
          },
          manageVds: {
            page: 0,
            lastPickedId: -1,
            expandedId: null,
            showPassword: false,
            pendingRenewMonths: null,
          },
          adminVds: {
            page: 0,
            searchQuery: "",
            selectedVdsId: null,
            awaitingSearch: false,
            awaitingTransferUserId: false,
          },
          manageDedicated: {
            expandedId: null,
            showPassword: false,
          },
          domains: {
            lastPickDomain: "",
            page: 0,
            pendingZone: undefined,
          },
          dedicatedOrder: {
            step: "idle",
            requirements: undefined,
          },
          ticketsView: {
            list: null,
            currentTicketId: null,
            pendingAction: null,
            pendingTicketId: null,
            pendingData: {},
          },
          deposit: {
            awaitingAmount: false,
            prefilledAmount: false,
            selectedAmount: 50,
          },
          promocode: {
            awaitingInput: false,
          },
          promoAdmin: {
            page: 0,
            editingPromoId: null,
            createStep: null,
            createDraft: {},
            editStep: null,
          },
          adminCdn: {
            page: 0,
            searchQuery: "",
            selectedProxyId: null,
            awaitingSearch: false,
          },
        }),
      },
      main: {
        initial: (): MainSessionData => ({
          locale: "0",
          user: {
            id: 0,
            balance: 0,
            referralBalance: 0,
            role: Role.User,
            status: UserStatus.User,
            isBanned: false,
          },
          lastSumDepositsEntered: 0,
          topupMethod: null,
        }),
        storage: new FileAdapter({
          dirName: "sessions",
        }),
      },
    })
  );

  // Setup middlewares
  bot.use(languagesMiddleware(availableLocales));
  bot.use(databaseMiddleware);
  bot.use(localeMiddleware);

  // Setup Fluent i18n — defaultLocale "ru" чтобы при ошибках не переключало на английский
  bot.use(
    useFluent({
      fluent,
      defaultLocale: "ru",
      localeNegotiator: async (ctx) => {
        const session = await ctx.session;
        const loc = session.main.locale;
        return loc === "en" ? "en" : "ru";
      },
    })
  );

  // Фиксируем локаль на весь запрос и переопределяем ctx.t для приветствия
  bot.use(async (ctx, next) => {
    const session = await ctx.session;
    (ctx as any)._requestLocale = session.main.locale === "en" ? "en" : "ru";
    const origT = (ctx as any).t;
    (ctx as any).t = (key: string, vars?: Record<string, string | number>) => {
      const locale = (ctx as any)._requestLocale ?? "ru";
      if (key === "welcome") {
        return String(fluent.translate(locale, "welcome", vars ?? {}));
      }
      return typeof origT === "function" ? origT(key, vars) : key;
    };
    return next();
  });

  // Check if user is banned
  bot.use(banCheckMiddleware);

  // Setup VMManager middleware
  bot.use(vmmanagerMiddleware(vmManager));

  // Setup conversations
  bot.use(conversations());
  const { registerPromoConversations } = await import(
    "../ui/conversations/admin-promocodes-conversations.js"
  );
  registerPromoConversations(bot);
  const { domainRegisterConversation } = await import(
    "../ui/conversations/domain-register-conversation.js"
  );
  const { domainUpdateNsConversation } = await import(
    "../ui/conversations/domain-update-ns-conversation.js"
  );
  const { createConversation } = await import("@grammyjs/conversations");
  bot.use(createConversation(domainRegisterConversation as any, "domainRegisterConversation"));
  bot.use(createConversation(domainUpdateNsConversation as any, "domainUpdateNsConversation"));
  const { cdnAddProxyConversation } = await import("../ui/menus/cdn-menu.js");
  bot.use(createConversation(cdnAddProxyConversation as any, "cdnAddProxyConversation"));

  // Register menus - using old menus temporarily to preserve functionality
  // TODO: Gradually migrate to new menu structure (ui/menus/)
  const { getLegacyMenus, createMainMenu } = await import("../ui/menus/legacy-menus.js");
  const legacyMenus = await getLegacyMenus();
  
  // Create main menu without circular dependency
  const mainMenu = createMainMenu();
  {
    const { registerWelcomeMainMenu } = await import("../ui/menus/main-menu-registry.js");
    registerWelcomeMainMenu(mainMenu);
  }

  // Import old menus from helpers
  const servicesMenu = legacyMenus.servicesMenu.servicesMenu;
  const domainsMenu = legacyMenus.servicesMenu.domainsMenu;
  const vdsMenu = legacyMenus.servicesMenu.vdsMenu;
  const vdsRateChoose = legacyMenus.servicesMenu.vdsRateChoose;
  const vdsRateOs = legacyMenus.servicesMenu.vdsRateOs;
  const domainOrderMenu = legacyMenus.servicesMenu.domainOrderMenu;
  const domainQuestion = legacyMenus.servicesMenu.domainQuestion;
  const dedicatedTypeMenu = legacyMenus.servicesMenu.dedicatedTypeMenu;
  const dedicatedServersMenu = legacyMenus.servicesMenu.dedicatedServersMenu;
  const vdsTypeMenu = legacyMenus.servicesMenu.vdsTypeMenu;
  
  const depositMenu = legacyMenus.depositMoney.depositMenu;
  const topupMethodMenu = legacyMenus.depositMoney.topupMethodMenu;
  const depositPaymentSystemChoose = legacyMenus.depositMoney.depositPaymentSystemChoose;
  const depositMoneyConversation = legacyMenus.depositMoney.depositMoneyConversation;
  
  const manageSerivcesMenu = legacyMenus.manageServices.manageSerivcesMenu;
  const domainManageServicesMenu = legacyMenus.manageServices.domainManageServicesMenu;
  const vdsManageServiceMenu = legacyMenus.manageServices.vdsManageServiceMenu;
  const bundleManageServicesMenu = legacyMenus.manageServices.bundleManageServicesMenu;
  const vdsManageSpecific = legacyMenus.manageServices.vdsManageSpecific;
  const vdsReinstallOs = legacyMenus.manageServices.vdsReinstallOs;
  
  const controlUser = legacyMenus.usersControl.controlUser;
  const controlUsers = legacyMenus.usersControl.controlUsers;
  const controlUserStatus = legacyMenus.usersControl.controlUserStatus;
  
  const promocodeQuestion = legacyMenus.promocodeInput.promocodeQuestion;
  const handlePromocodeInput = legacyMenus.promocodeInput.handlePromocodeInput;
  
  // Import Menu for creating new menus
  const { Menu } = await import("@grammyjs/menu");
  
  // Create profile menu
  const profileMenu = new Menu<AppContext>("profile-menu", { onMenuOutdated: false })
    .text((ctx) => ctx.t("button-deposit"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(ctx.t("topup-select-method"), {
        reply_markup: topupMethodMenu,
        parse_mode: "HTML",
      });
    })
    .row()
    .text(
      (ctx) => ctx.t("button-promocode"),
      async (ctx) => {
      const session = await ctx.session;
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
      const session = await ctx.session;
      const nextLocale = session.main.locale === "ru" ? "en" : "ru";
      session.main.locale = nextLocale;
      (ctx as any)._requestLocale = nextLocale;

      const userRepo = new UserRepository(ctx.appDataSource);
      try {
        await userRepo.updateLanguage(session.main.user.id, nextLocale as "ru" | "en");
        if (ctx.chatId) invalidateUser(Number(ctx.chatId));
      } catch {
        // Ignore if user not found
      }

      ctx.fluent.useLocale(nextLocale);

      const { getProfileText } = await import("../ui/menus/profile-menu.js");
      const profileText = await getProfileText(ctx, { locale: nextLocale });
      try {
        await ctx.editMessageText(profileText, {
          reply_markup: profileMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch (err: unknown) {
        const msg = String((err as any)?.message ?? (err as any)?.description ?? "");
        if (msg.includes("message is not modified")) return;
        await ctx.reply(profileText, {
          reply_markup: profileMenu,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }).catch(() => {});
      }
    })
    .row()
    .back(
      (ctx) => ctx.t("button-profile-back"),
      async (ctx) => {
        const session = await ctx.session;
        await ctx.editMessageText(
          ctx.t("welcome", { balance: session.main.user.balance }),
          {
            parse_mode: "HTML",
          }
        );
      }
    );

  // Create change locale menu
  const changeLocaleMenu = new Menu<AppContext>("change-locale-menu", {
    autoAnswer: false,
    onMenuOutdated: false,
  })
    .dynamic(async (ctx, range) => {
      const session = await ctx.session;
      for (const lang of ctx.availableLanguages) {
        if (lang !== session.main.locale) {
          range
            .text(ctx.t(`button-change-locale-${lang}`), async (ctx) => {
              session.main.locale = lang;
              const userRepo = new UserRepository(ctx.appDataSource);
              try {
                await userRepo.updateLanguage(session.main.user.id, lang as "ru" | "en");
                if (ctx.chatId) invalidateUser(Number(ctx.chatId));
              } catch (error) {
                // Ignore if user not found
              }
              ctx.fluent.useLocale(lang);
              await ctx.editMessageText(
                ctx.t("welcome", { balance: session.main.user.balance }),
                {
                  parse_mode: "HTML",
                }
              );
              ctx.menu.back();
            })
            .row();
        }
      }
    })
    .back((ctx) => ctx.t("button-back"));

  // Create about us menu
  const aboutUsMenu = new Menu<AppContext>("about-us-menu", {
    autoAnswer: false,
  })
    .url((ctx) => ctx.t("button-go-to-site"), "https://sephora.host")
    .row()
    .back(
      (ctx) => ctx.t("button-back"),
      async (ctx) => {
        const session = await ctx.session;
        await ctx.editMessageText(
          ctx.t("welcome", { balance: session.main.user.balance }),
          {
            parse_mode: "HTML",
          }
        );
      }
    );

  // Create support menu
  const supportMenu = new Menu<AppContext>("support-menu", {
    autoAnswer: false,
  })
    .url(
      (ctx) => ctx.t("button-ask-question"),
      (ctx) => {
        return `tg://resolve?domain=sephora_sup&text=${encodeURIComponent(
          ctx.t("support-message-template")
        )}`;
      }
    )
    .back(
      (ctx) => ctx.t("button-support-back"),
      async (ctx) => {
        const session = await ctx.session;
        await ctx.editMessageText(
          ctx.t("welcome", { balance: session.main.user.balance }),
          {
            parse_mode: "HTML",
          }
        );
      }
    );
  
  // Prime "Back" handler MUST run before any menu so it catches prime-back-* callbacks
  const { registerPrimeBackHandler } = await import("../ui/integration/broadcast-tickets-integration.js");
  registerPrimeBackHandler(bot);
  const { registerDomainPurchaseFlow } = await import("../domain/domains/domain-purchase-flow.js");
  registerDomainPurchaseFlow(bot);
  const { registerDedicatedShopHandlers } = await import("../domain/dedicated/dedicated-shop-flow.js");
  registerDedicatedShopHandlers(bot);
  const { registerVpsShopHandlers } = await import("../domain/vds/vds-shop-flow.js");
  registerVpsShopHandlers(bot);

  // Register all menus
  bot.use(mainMenu);
  // languageSelectMenu will be registered dynamically in /start command
  bot.use(servicesMenu);
  bot.use(adminPromosMenu);
  bot.use(domainOrderMenu);
  bot.use(depositPaymentSystemChoose);
  bot.use(controlUser);
  bot.use(controlUsers);
  bot.use(controlUserStatus);
  
  // Admin menu is registered in index.ts to avoid duplicate registration
  
  // Menu hierarchy registration is done in index.ts to avoid duplicate registration
  
  // Register menu hierarchy
  mainMenu.register(aboutUsMenu, "main-menu");
  mainMenu.register(supportMenu, "main-menu");
  mainMenu.register(profileMenu, "main-menu");
  mainMenu.register(servicesMenu, "main-menu");
  
  // Register admin menu in main menu (for admins)
  try {
    const { adminMenu } = await import("../ui/menus/admin-menu");
    const { ticketViewMenu } = await import("../ui/menus/moderator-menu");
    mainMenu.register(adminMenu, "main-menu");
    bot.use(ticketViewMenu);
    try {
      adminMenu.register(adminPromosMenu, "admin-menu");
      const { adminAutomationsMenu } = await import("../ui/menus/admin-automations-menu.js");
      adminMenu.register(adminAutomationsMenu, "admin-menu");
    } catch (error: any) {
      if (!error.message?.includes("already registered")) {
        Logger.warn("Failed to register admin submenus:", error);
      }
    }
  } catch (error: any) {
    Logger.warn("Failed to register admin menu:", error);
  }
  
  profileMenu.register(topupMethodMenu, "profile-menu");
  topupMethodMenu.register(depositMenu, "topup-method-menu");
  
  manageSerivcesMenu.register(domainManageServicesMenu, "manage-services-menu");
  manageSerivcesMenu.register(vdsManageServiceMenu, "manage-services-menu");
  manageSerivcesMenu.register(bundleManageServicesMenu, "manage-services-menu");
  try {
    const { dedicatedMenu } = await import("../ui/menus/dedicated-menu");
    if (dedicatedMenu) {
      dedicatedTypeMenu.register(dedicatedMenu, "dedicated-type-menu");
    }
  } catch (error: any) {
    Logger.warn("Failed to register dedicated menu:", error);
  }
  
  // Register bundles menu (bundle-type-menu = Starter Shield / Pro Pack, no intermediate screen)
  try {
    const { bundleTypeMenu, bundlePeriodMenu } = await import("../ui/menus/bundles-menu.js");
    servicesMenu.register(bundleTypeMenu, "services-menu");
    bundleTypeMenu.register(bundlePeriodMenu, "bundle-type-menu");
  } catch (error: any) {
    Logger.warn("Failed to register bundles menu:", error);
  }

  servicesMenu.register(domainsMenu, "services-menu");
  servicesMenu.register(dedicatedTypeMenu, "services-menu");
  servicesMenu.register(vdsTypeMenu, "services-menu");
  // Shop flow uses inline dsh:*; dedicatedServersMenu stays on bot.use for legacy keyboards only.
  vdsMenu.register(vdsRateChoose, "vds-menu");
  vdsRateChoose.register(vdsRateOs, "vds-selected-rate");
  
  vdsManageSpecific.register(vdsReinstallOs);
  vdsManageServiceMenu.register(vdsReinstallOs, "vds-manage-services-list");

  // Register conversations (createConversation imported above)
  bot.use(createConversation(depositMoneyConversation, "depositMoneyConversation"));
  const { renameVdsConversation, vdsPasswordManualConversation } = await import("../helpers/manage-services.js");
  bot.use(createConversation(renameVdsConversation as any, "renameVdsConversation"));
  bot.use(createConversation(vdsPasswordManualConversation as any, "vdsPasswordManualConversation"));


  // Register broadcast and tickets functionality before text handlers
  const { registerBroadcastAndTickets } = await import("../ui/integration/broadcast-tickets-integration.js");
  registerBroadcastAndTickets(bot);
  registerAdminPromosHandlers(bot);

  // Register other conversations
  bot.use(promocodeQuestion.middleware());
  bot.use(domainQuestion.middleware());
  bot.use(vdsManageSpecific);
  bot.callbackQuery(
    /^(cdn_(open|renew|retryssl|delask|delok):.+|cdn_autorenew:.+:[01]|cdn_target_auto|cdn_target_help|cdn_plan:(standard|bulletproof|bundle)|cdn_plan_back|cdn_list|cdn_back_to_manage|cdn_empty_row|cdn_exit_services|cdn_nav:(main|tariffs|proxy)|cdn_card:(standard|bulletproof|bundle)|cdn_detail:(standard|bulletproof|bundle)|cdn_prime_row)$/,
    async (ctx) => {
      const { handleCdnActionCallback } = await import("../ui/menus/cdn-menu.js");
      await handleCdnActionCallback(ctx as AppContext);
    }
  );
  bot.callbackQuery(/^acdn:/, async (ctx) => {
    const { handleAdminCdnCallback } = await import("../ui/menus/admin-cdn-menu.js");
    await handleAdminCdnCallback(ctx as AppContext);
  });

  bot.callbackQuery("promocode-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.other.promocode.awaitingInput = false;
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
  });

  bot.callbackQuery("deposit-cancel", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.main.lastSumDepositsEntered = -1;
    session.other.deposit.awaitingAmount = false;
    if (ctx.callbackQuery.message) {
      await ctx.deleteMessage().catch(() => {});
    }
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
    const { parseNpsPayload } = await import("../modules/automations/nps-callback.js");
    const parsed = parseNpsPayload(data);
    if (!parsed) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const key = `nps-${parsed.branch}` as "nps-promoter" | "nps-detractor" | "nps-neutral";
    const text = ctx.t(key);
    await ctx.reply(text, { parse_mode: "HTML" }).catch(() => {});
  });

  bot.callbackQuery("admin-menu-back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session) {
      await ctx.answerCallbackQuery(
        ctx.t("error-unknown", { error: "Session not initialized" }).substring(0, 200)
      );
      return;
    }

    const { clearAdminVdsPanelState } = await import("../ui/menus/admin-vds-menu.js");
    clearAdminVdsPanelState(session.other);

    try {
      const { adminMenu } = await import("../ui/menus/admin-menu");
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

  bot.on("message:text", async (ctx, next) => {
    const { handleCdnAddProxyTextInput } = await import("../ui/menus/cdn-menu.js");
    const consumed = await handleCdnAddProxyTextInput(ctx as AppContext);
    if (consumed) return;
    const session = await ctx.session;
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

  bot.on("message:text", async (ctx, next) => {
    const session = await ctx.session;
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

    const sumToDeposit = Number.parseInt(
      input.replaceAll("$", "").replaceAll(",", "").replaceAll(".", "").replaceAll(" ", "").trim()
    );

    if (isNaN(sumToDeposit) || sumToDeposit <= 0 || sumToDeposit > 1_500_000) {
      await ctx.reply(ctx.t("deposit-money-incorrect-sum"), { parse_mode: "HTML" });
      return;
    }

    session.main.lastSumDepositsEntered = sumToDeposit;
    await ctx.reply(ctx.t("deposit-success-sum", { amount: sumToDeposit }), {
      reply_markup: depositMenu,
      parse_mode: "HTML",
    });
  });
  
  // Register middleware
  bot.use(legacyMenus.promotePerms.promotePermissions());
  legacyMenus.domainReg.registerDomainRegistrationMiddleware(bot);
  
  // Register commands
  const { registerCommands } = await import("../ui/commands/index.js");
  registerCommands(bot);

  // Setup global error handler (must be last)
  setupErrorHandler(bot);

  // Start payment checker
  paymentChecker.start();
  Logger.info("PaymentStatusChecker started");
  servicePaymentChecker.start();
  Logger.info("ServicePaymentStatusChecker started");

  // Growth trigger: when grace period starts (3 days left), create discount offer
  let triggerEngine: import("../modules/growth/trigger.engine.js").TriggerEngine | undefined;
  try {
    const dataSource = await getAppDataSource();
    const { GrowthService } = await import("../modules/growth/growth.service.js");
    const growthService = new GrowthService(dataSource);
    triggerEngine = growthService.getTriggerEngine();
  } catch {
    // growth module optional
  }

  const onGracePeriodStarted: import("../domain/services/ExpirationService.js").OnGracePeriodStarted | undefined =
    triggerEngine
      ? async (userId, serviceId, serviceType) => {
          await triggerEngine!.handleServiceExpiration(userId, serviceId, serviceType);
        }
      : undefined;

  const sendGrowthMessage = (telegramId: number, text: string): Promise<void> =>
    bot.api.sendMessage(telegramId, text, { parse_mode: "HTML" }).then(() => {});

  let onGraceDayCheck: import("../domain/services/ExpirationService.js").OnGraceDayCheck | undefined;
  try {
    const { maybeSendGraceDay2OrDay3 } = await import("../modules/growth/campaigns/index.js");
    onGraceDayCheck = (vdsId, userId, telegramId, payDayAt) =>
      maybeSendGraceDay2OrDay3(vdsId, userId, telegramId, payDayAt, sendGrowthMessage);
  } catch {
    // optional
  }

  // Initialize and start expiration service
  const expirationService = new ExpirationService(
    bot as any,
    vmManager,
    fluent,
    onGracePeriodStarted,
    onGraceDayCheck
  );
  expirationService.start();
  Logger.info("ExpirationService started");

  // Automations: setup event handler for EVENT-triggered scenarios
  let stopAutomationHandler: (() => void) | undefined;
  let stopDueStepsCron: (() => void) | undefined;
  let stopScheduleRunner: (() => void) | undefined;
  try {
    const dataSource = await getAppDataSource();
    const { setupAutomationEventHandler } = await import("../modules/automations/integration/event-handler.js");
    stopAutomationHandler = setupAutomationEventHandler(dataSource, bot as any);
    Logger.info("Automation event handler started");

    const sendMessage: (tid: number, text: string, buttons?: Array<{ text: string; url?: string; callback_data?: string }>) => Promise<void> = async (tid, text, buttons) => {
      const extra: { parse_mode?: string; reply_markup?: unknown } = { parse_mode: "HTML" };
      if (buttons?.length) {
        const { InlineKeyboard } = await import("grammy");
        const kb = new InlineKeyboard();
        for (const b of buttons) {
          if (b.url) kb.url(b.text, b.url);
          else if (b.callback_data) kb.text(b.text, b.callback_data);
        }
        extra.reply_markup = kb;
      }
      await bot.api.sendMessage(tid, text, extra as { parse_mode?: "HTML"; reply_markup?: import("grammy").InlineKeyboard }).catch(() => {});
    };
    const { runDueMultiSteps } = await import("../modules/automations/engine/index.js");
    const dueStepsTick = () => {
      runDueMultiSteps(dataSource, sendMessage).then((n) => {
        if (n > 0) Logger.info(`[Automations] Due steps sent: ${n}`);
      });
    };
    const dueStepsIntervalId = setInterval(dueStepsTick, 30 * 60 * 1000);
    dueStepsTick();
    stopDueStepsCron = () => clearInterval(dueStepsIntervalId);
    Logger.info("Automation due-steps cron started (30m)");

    const { startScheduleRunner } = await import("../modules/automations/integration/schedule-runner.js");
    stopScheduleRunner = startScheduleRunner(dataSource, bot as any);
    Logger.info("Automation schedule runner started");
  } catch (e) {
    Logger.warn("Automation event handler not started", e);
  }

  // Growth: reactivation cron (inactive 30d → offer +15%)
  let stopReactivation: (() => void) | undefined;
  let stopCampaignsCron: (() => void) | undefined;
  try {
    const dataSource = await getAppDataSource();
    const { startReactivationCron } = await import("../modules/growth/growth.module.js");
    stopReactivation = await startReactivationCron(dataSource, sendGrowthMessage);
    Logger.info("Growth reactivation cron started");

    const { runAllCampaignsCron } = await import("../modules/growth/campaigns/index.js");
    const campaignIntervalMs = 24 * 60 * 60 * 1000;
    const campaignsTick = () => {
      runAllCampaignsCron(dataSource, sendGrowthMessage).then((r) => {
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        if (total > 0) Logger.info("[Growth] Campaigns cron sent", r);
      });
    };
    const campaignIntervalId = setInterval(campaignsTick, campaignIntervalMs);
    campaignsTick();
    stopCampaignsCron = () => clearInterval(campaignIntervalId);
    Logger.info("Growth campaigns cron started (24h)");
  } catch (e) {
    Logger.warn("Growth reactivation/campaigns not started", e);
  }

  // Cleanup function
  const cleanup = async (): Promise<void> => {
    Logger.info("Cleaning up bot resources...");
    stopAutomationHandler?.();
    stopDueStepsCron?.();
    stopScheduleRunner?.();
    stopReactivation?.();
    stopCampaignsCron?.();
    paymentChecker.stop();
    servicePaymentChecker.stop();
    expirationService.stop();
    vmManager.destroy?.();
    await getAppDataSource().then((ds) => ds.destroy()).catch(() => {});
    Logger.info("Cleanup completed");
  };

  Logger.info("Bot initialized successfully");

  return { bot, cleanup };
}

/**
 * Start the bot (long polling or webhook mode).
 *
 * @param bot - Bot instance
 */
export async function startBot(bot: Bot<AppContext>): Promise<void> {
  Logger.info("Starting bot...");

  if (isWebhookMode()) {
    Logger.info("Starting in webhook mode");

    const app = express();

    app.use(
      express.json({
        verify: (req: Request, _res: Response, buf: Buffer) => {
          (req as any).rawBody = buf.toString("utf8");
        },
      })
    );

    const corsOrigin = process.env.CORS_ORIGIN ?? "*";
    app.use("/api/admin/automations", (req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-API-Key, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      const apiKey = process.env.ADMIN_API_KEY;
      if (apiKey && apiKey.length > 0) {
        const key = req.get("X-Admin-API-Key") ?? req.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (key !== apiKey) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }
      next();
    });

    app.post("/webhooks/cryptopay", (req: Request, res: Response) =>
      handleCryptoPayWebhook(req, res, bot)
    );

    const { createAutomationsRouter } = await import("../api/admin/automations-routes.js");
    app.use("/api/admin/automations", createAutomationsRouter({ getBot: () => bot }));

    app.use(
      webhookCallback(bot, "express", {
        onTimeout: "return",
      })
    );

    await bot.api.setWebhook(config.IS_WEBHOOK!);
    Logger.info(`Webhook set to: ${config.IS_WEBHOOK}`);

    const port = getWebhookPort();
    app.listen(port, () => {
      Logger.info(`Webhook server listening on port ${port}`);
    });
  } else {
    Logger.info("Starting in long polling mode");

    // Delete webhook if exists
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    Logger.info("Webhook deleted (if existed)");

    // Start long polling
    grammyRun(bot);
    Logger.info("Bot started in long polling mode");
  }
}
