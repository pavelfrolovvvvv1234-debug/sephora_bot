/**
 * Domain registration conversation for users.
 *
 * @module ui/conversations/domain-register-conversation
 */

import type { AppConversation } from "../../shared/types/context.js";
import type { AppContext } from "../../shared/types/context.js";
import { AmperDomainService } from "../../domain/services/AmperDomainService.js";
import { DomainRepository } from "../../infrastructure/db/repositories/DomainRepository.js";
import { BillingService } from "../../domain/billing/BillingService.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { TopUpRepository } from "../../infrastructure/db/repositories/TopUpRepository.js";
import { AmperDomainsProvider } from "../../infrastructure/domains/AmperDomainsProvider.js";
import { Logger } from "../../app/logger.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { initFluent } from "../../fluent.js";
import { InlineKeyboard } from "grammy";
import type { Fluent } from "@moebius/fluent";
import DomainChecker from "../../api/domain-checker.js";

let cachedFluent: Fluent | null = null;

const getFluentInstance = async (): Promise<Fluent> => {
  if (!cachedFluent) {
    const { fluent } = await initFluent();
    cachedFluent = fluent;
  }
  return cachedFluent;
};

const resolveLocale = (locale?: string): string => {
  if (locale && locale !== "0") {
    return locale;
  }
  return "ru";
};

const safeT = (
  ctx: AppContext,
  key: string,
  vars?: Record<string, string | number>
): string => {
  const fluent = (ctx as any).fluent;
  if (fluent && typeof fluent.translate === "function") {
    return fluent.translate(resolveLocale((ctx as any).session?.main?.locale), key, vars);
  }
  if (fluent && typeof fluent.t === "function") {
    return fluent.t(key, vars);
  }
  const tFn = (ctx as any).t;
  if (typeof tFn === "function") {
    return tFn.call(ctx, key, vars);
  }
  if (key === "domain-register-enter-name") {
    return "Enter domain (with or without zone): example or example.com";
  }
  return key;
};

const ensureTranslator = (ctx: AppContext, locale?: string): void => {
  const fluent = (ctx as any).fluent;
  if (fluent && typeof fluent.translate === "function") {
    (ctx as any).t = (key: string, vars?: Record<string, string | number>) =>
      fluent.translate(resolveLocale(locale), key, vars);
    return;
  }
  if (fluent && typeof fluent.t === "function") {
    (ctx as any).t = (key: string, vars?: Record<string, string | number>) =>
      fluent.t(key, vars);
    return;
  }
  (ctx as any).t = (key: string) => key;
};

/**
 * Domain registration conversation.
 */
export async function domainRegisterConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  const session = await ctx.session;
  const dataSource = ctx.appDataSource ?? (await getAppDataSource());
  const userRepo = new UserRepository(dataSource);
  const telegramId = ctx.from?.id ?? ctx.chatId;
  if (!telegramId) {
    await ctx.reply("Ошибка: Telegram ID не найден");
    return;
  }

  const user = await userRepo.findOrCreateByTelegramId(telegramId);
  const locale = session?.main?.locale && session.main.locale !== "0"
    ? session.main.locale
    : user.lang || "ru";

  if (!(ctx as any).fluent) {
    (ctx as any).fluent = await getFluentInstance();
  }
  if ((ctx as any).fluent?.useLocale) {
    (ctx as any).fluent.useLocale(locale);
  }
  ensureTranslator(ctx, locale);
  const apiBaseUrl = process.env.AMPER_API_BASE_URL || "";
  const apiToken = process.env.AMPER_API_TOKEN || "";

  if (!apiBaseUrl || !apiToken) {
    await ctx.reply(
      safeT(ctx, "domain-api-not-configured", {
        baseUrl: apiBaseUrl || "AMPER_API_BASE_URL",
      }),
      { parse_mode: "HTML" }
    );
    return;
  }

  // Ask for domain name
  await ctx.reply(safeT(ctx, "domain-register-enter-name"), {
    reply_markup: new InlineKeyboard().text(
      safeT(ctx, "button-cancel"),
      "domain-register-cancel"
    ),
    parse_mode: "HTML",
  });

  const domainCtx = await conversation.waitFor("message:text");
  const domainInput = domainCtx.message.text.trim().toLowerCase();

  let domainName = domainInput;
  let tld = "";
  if (domainInput.includes(".")) {
    const lastDot = domainInput.lastIndexOf(".");
    domainName = domainInput.slice(0, lastDot);
    tld = domainInput.slice(lastDot);
  }

  // Ask for TLD
  if (!tld) {
    await ctx.reply(safeT(ctx, "domain-register-enter-tld"), {
      reply_markup: new InlineKeyboard().text(
        safeT(ctx, "button-cancel"),
        "domain-register-cancel"
      ),
      parse_mode: "HTML",
    });

    const tldCtx = await conversation.waitFor("message:text");
    tld = tldCtx.message.text.trim().toLowerCase();
    if (!tld.startsWith(".")) {
      tld = `.${tld}`;
    }
  }

  const fullDomain = `${domainName}${tld}`;

  // Max length of a label (RFC 1035: 1–63 chars per label)
  const MAX_LABEL_LENGTH = 63;
  if (domainName.length > MAX_LABEL_LENGTH) {
    await ctx.reply(
      safeT(ctx, "domain-label-too-long", { max: MAX_LABEL_LENGTH, length: domainName.length })
    );
    return;
  }

  // Validate format (allowed: letters, digits, hyphen; labels 1–63 chars)
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(fullDomain)) {
    await ctx.reply(safeT(ctx, "domain-invalid-format", { domain: fullDomain }));
    return;
  }

  try {
    // Initialize services
    const domainRepo = new DomainRepository(dataSource);
    const topUpRepo = new TopUpRepository(dataSource);
    const billingService = new BillingService(dataSource, userRepo, topUpRepo);

    const config = {
      apiBaseUrl,
      apiToken,
      timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
      defaultNs1: process.env.DEFAULT_NS1,
      defaultNs2: process.env.DEFAULT_NS2,
    };

    const provider = new AmperDomainsProvider(config);
    const domainService = new AmperDomainService(
      dataSource,
      domainRepo,
      billingService,
      provider
    );

    // Check availability
    await ctx.reply(safeT(ctx, "domain-checking-availability", { domain: fullDomain }));
    
    let availability;
    try {
      availability = await provider.checkAvailability(fullDomain);
    } catch (error: any) {
      Logger.error("Domain availability check failed:", error);
      await ctx.reply(
        safeT(ctx, "domain-check-error", { 
          domain: fullDomain, 
          error: error.message || "Unknown API error" 
        })
      );
      return;
    }

    // Если Amper возвращает ошибку формата — не можем проверить заранее
    // Продолжаем регистрацию, Amper проверит доступность при регистрации
    if (availability.formatError === true) {
      Logger.warn(`Amper format error for ${fullDomain}, proceeding with registration - Amper will check availability`);
      // Показываем предупреждение, но продолжаем
      await ctx.reply(
        safeT(ctx, "domain-check-format-warning", {
          domain: fullDomain,
        }),
        { parse_mode: "HTML" }
      );
      // Считаем доступным, чтобы продолжить регистрацию
      availability = {
        available: true,
        domain: fullDomain,
        reason: undefined,
        formatError: false,
      };
    }

    // Тестовый режим (только если явно включен)
    const fakeAvailable = process.env.AMPER_FAKE_AVAILABLE === "true" || process.env.AMPER_FAKE_AVAILABLE === "1";
    if (fakeAvailable && !availability.available) {
      availability = { ...availability, available: true, domain: fullDomain };
    }

    if (!availability.available) {
      const rawReason = availability.reason?.trim() || "";
      const reason = rawReason.slice(0, 300);
      
      // Проверяем, является ли это временной ошибкой сервера (502, 503, 504)
      const isTemporaryError = reason.toLowerCase().includes("temporarily unavailable") ||
        reason.includes("502") ||
        reason.includes("503") ||
        reason.includes("504");
      
      if (isTemporaryError) {
        const statusMatch = reason.match(/(\d{3})/);
        const statusCode = statusMatch ? statusMatch[1] : "502";
        await ctx.reply(
          safeT(ctx, "domain-check-service-unavailable", { statusCode }),
          { parse_mode: "HTML" }
        );
        return;
      }
      
      if (reason) {
        await ctx.reply(
          safeT(ctx, "domain-not-available-with-reason", {
            domain: fullDomain,
            reason,
          }),
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          safeT(ctx, "domain-not-available", { domain: fullDomain })
        );
      }
      return;
    }

    // Ask for period
    await ctx.reply(safeT(ctx, "domain-register-enter-period"));
    const periodCtx = await conversation.waitFor("message:text");
    const period = parseInt(periodCtx.message.text.trim());
    if (isNaN(period) || period < 1 || period > 10) {
      await ctx.reply(safeT(ctx, "domain-invalid-period"));
      return;
    }

    // Get price (with Prime 10% discount if active)
    const { price } = await domainService.getPriceForUser(
      user.id,
      tld.replace(".", ""),
      period
    );

    // Ask for nameservers (optional)
    await ctx.reply(
      safeT(ctx, "domain-register-enter-ns-optional", {
        defaultNs1: config.defaultNs1 || "ns1.example.com",
        defaultNs2: config.defaultNs2 || "ns2.example.com",
      })
    );
    const nsCtx = await conversation.waitFor("message:text");
    const nsText = nsCtx.message.text.trim();
    let ns1: string | undefined;
    let ns2: string | undefined;

    if (nsText.toLowerCase() !== "/skip" && nsText) {
      const nsParts = nsText.split(/[\s,]+/);
      if (nsParts.length >= 2) {
        ns1 = nsParts[0];
        ns2 = nsParts[1];
      } else {
        await ctx.reply(safeT(ctx, "domain-invalid-ns-format"));
        return;
      }
    }

    // Confirm
    const keyboard = new InlineKeyboard()
      .text(safeT(ctx, "button-agree"), `domain_confirm_${Date.now()}`)
      .text(safeT(ctx, "button-cancel"), "domain_cancel");

    await ctx.reply(
      safeT(ctx, "domain-register-confirm", {
        domain: fullDomain,
        period,
        price,
        ns1: ns1 || config.defaultNs1 || safeT(ctx, "default"),
        ns2: ns2 || config.defaultNs2 || safeT(ctx, "default"),
      }),
      {
        reply_markup: keyboard,
        parse_mode: "HTML",
      }
    );

    // Wait for confirmation
    const confirmCtx = await conversation.waitForCallbackQuery(/^domain_(confirm|cancel)/);
    if (confirmCtx.match[1] === "cancel") {
      await confirmCtx.editMessageText(safeT(ctx, "domain-register-cancelled"));
      return;
    }

    // Register domain
    await confirmCtx.editMessageText(
      safeT(ctx, "domain-registering", { domain: fullDomain })
    );

    try {
      const domain = await domainService.registerDomain(
        user.id,
        domainName,
        tld,
        period,
        ns1,
        ns2
      );

      await confirmCtx.editMessageText(
        safeT(ctx, "domain-registered", {
          domain: fullDomain,
          domainId: domain.id,
          status: domain.status,
        }),
        {
          parse_mode: "HTML",
        }
      );
    } catch (error: any) {
      Logger.error("Failed to register domain:", error);
      const errMsg = (error?.message || "Unknown error").toLowerCase();
      const isRegistrarBalance =
        errMsg.includes("balance") ||
        errMsg.includes("insufficient") ||
        errMsg.includes("funds") ||
        errMsg.includes("баланс") ||
        errMsg.includes("средств") ||
        errMsg.includes("пополните");
      const isDomainTaken =
        errMsg.includes("not available") ||
        errMsg.includes("недоступен") ||
        errMsg.includes("already taken") ||
        errMsg.includes("уже занят") ||
        errMsg.includes("domain is not available");
      const isAlreadyOwnedByYou =
        errMsg.includes("already owned by you") ||
        errMsg.includes("owned by you") ||
        errMsg.includes("уже принадлежит вам");
      
      const errMsgLower = errMsg.toLowerCase();
      const isTemporaryError =
        errMsgLower.includes("temporarily unavailable") ||
        errMsgLower.includes("502") ||
        errMsgLower.includes("503") ||
        errMsgLower.includes("504") ||
        errMsgLower.includes("bad gateway") ||
        errMsgLower.includes("service unavailable");
      const isNetworkError =
        errMsgLower.includes("econnrefused") ||
        errMsgLower.includes("etimedout") ||
        errMsgLower.includes("enotfound") ||
        errMsgLower.includes("ehostunreach") ||
        errMsgLower.includes("network") ||
        errMsgLower.includes("timeout");
      
      let text: string;
      if (isRegistrarBalance) {
        text = safeT(ctx, "domain-register-failed-registrar-balance");
      } else if (isAlreadyOwnedByYou) {
        text = safeT(ctx, "domain-register-failed-already-owned", { domain: fullDomain });
      } else if (isDomainTaken) {
        text = safeT(ctx, "domain-register-failed-domain-taken", { domain: fullDomain });
      } else if (isNetworkError) {
        text = safeT(ctx, "domain-register-failed-network");
      } else if (isTemporaryError) {
        const statusMatch = errMsg.match(/(\d{3})/);
        const statusCode = statusMatch ? statusMatch[1] : "502";
        text = safeT(ctx, "domain-service-temporarily-unavailable", { statusCode });
      } else {
        text = safeT(ctx, "domain-register-failed", {
          domain: fullDomain,
          error: error?.message || "Unknown error",
        });
      }
      const replyMarkup =
        isAlreadyOwnedByYou
          ? new InlineKeyboard().text(
              safeT(ctx, "button-domain-add-to-services"),
              `domain_import_${fullDomain.replace(/\./g, "_")}`
            )
          : undefined;
      await confirmCtx.editMessageText(text, {
        parse_mode: "HTML",
        ...(replyMarkup && { reply_markup: replyMarkup }),
      });
    }
  } catch (error: any) {
    Logger.error("Domain registration conversation error:", error);
    await ctx.reply(
      safeT(ctx, "error-unknown", { error: error.message || "Unknown error" })
    );
  }
}
