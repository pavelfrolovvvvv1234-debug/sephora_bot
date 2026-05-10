/**
 * Domain nameserver update conversation.
 *
 * @module ui/conversations/domain-update-ns-conversation
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
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import { createInitialOtherSession } from "../../shared/session-initial.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";

const pendingNsDomainByTelegramId = new Map<number, number>();

export function setPendingDomainNsUpdate(telegramId: number, domainId: number): void {
  pendingNsDomainByTelegramId.set(telegramId, domainId);
}

function safeT(ctx: AppContext, key: string, vars?: Record<string, string | number>): string {
  const t = (ctx as any).t;
  if (typeof t === "function") return String(t(key, vars));
  if (key === "not-specified") return "не указано";
  if (key === "error-access-denied") return "Доступ запрещен.";
  if (key === "domain-api-not-configured") return "API доменов не настроен.";
  if (key === "domain-invalid-ns-format") {
    return "Неверный формат NS. Введите два nameserver, например: ns1.example.com ns2.example.com";
  }
  if (key === "domain-update-ns-enter") {
    return `Текущие NS:\nNS1: ${String(vars?.currentNs1 ?? "—")}\nNS2: ${String(vars?.currentNs2 ?? "—")}\n\nОтправьте два NS через пробел: ns1.example.com ns2.example.com`;
  }
  if (key === "domain-ns-updated") {
    return `NS обновлены для ${String(vars?.domain ?? "домена")}:\nNS1: ${String(vars?.ns1 ?? "—")}\nNS2: ${String(vars?.ns2 ?? "—")}`;
  }
  if (key === "error-unknown") return `Ошибка: ${String(vars?.error ?? "Unknown error")}`;
  if (key === "error-invalid-context") return "Некорректный контекст. Откройте домен заново.";
  return key;
}

/**
 * Domain nameserver update conversation.
 */
export async function domainUpdateNsConversation(
  conversation: AppConversation,
  ctx: AppContext
) {
  const session = await ctx.session;
  if (session && !session.other) {
    (session as any).other = createInitialOtherSession();
  }
  if (session) {
    await ensureSessionUser(ctx);
  }
  const telegramId = Number(ctx.from?.id ?? ctx.chatId ?? 0);

  // Try to get domainId from callback query data or session
  let domainId: number | undefined;
  if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
    const match = (ctx.callbackQuery.data ?? "").match(/^domain_update_ns_(\d+)$/);
    if (match) {
      domainId = parseInt(match[1]);
      if (session?.other) {
        (session.other as any).currentDomainId = domainId;
      }
      if (telegramId > 0) {
        setPendingDomainNsUpdate(telegramId, domainId);
      }
    }
  }

  if (!domainId) {
    domainId = (session?.other as any)?.currentDomainId as number;
  }

  if (!domainId && telegramId > 0) {
    domainId = pendingNsDomainByTelegramId.get(telegramId);
  }

  if (!domainId) {
    await ctx.reply(safeT(ctx, "error-invalid-context"));
    return;
  }

  const apiBaseUrl = process.env.AMPER_API_BASE_URL?.trim();
  const apiToken = process.env.AMPER_API_TOKEN?.trim();
  if (!apiBaseUrl || !apiToken) {
    await ctx.reply(safeT(ctx, "domain-api-not-configured"));
    return;
  }

  try {
    const dataSource = ctx.appDataSource ?? (await getAppDataSource());
    const domainRepo = new DomainRepository(dataSource);
    const userRepo = new UserRepository(dataSource);
    const topUpRepo = new TopUpRepository(dataSource);
    const billingService = new BillingService(dataSource, userRepo, topUpRepo);

    const config = {
      apiBaseUrl: process.env.AMPER_API_BASE_URL || "",
      apiToken: process.env.AMPER_API_TOKEN || "",
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

    const domain = await domainService.getDomainById(domainId);

    let currentUserId = session?.main?.user?.id ?? 0;
    if (!currentUserId && telegramId > 0) {
      const byTid = await userRepo.findByTelegramId(telegramId);
      currentUserId = byTid?.id ?? 0;
    }
    if (!currentUserId || domain.userId !== currentUserId) {
      await ctx.reply(safeT(ctx, "error-access-denied"));
      return;
    }

    await ctx.reply(safeT(ctx, "domain-update-ns-enter", {
      currentNs1: domain.ns1 || safeT(ctx, "not-specified"),
      currentNs2: domain.ns2 || safeT(ctx, "not-specified"),
    }), {
      parse_mode: "HTML",
    });

    const nsCtx = await conversation.waitFor("message:text");
    const nsText = nsCtx.message.text.trim();
    const nsParts = nsText.split(/[\s,]+/);

    if (nsParts.length < 2) {
      await ctx.reply(safeT(ctx, "domain-invalid-ns-format"));
      return;
    }

    const ns1 = nsParts[0];
    const ns2 = nsParts[1];

    // Validate nameserver format
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(ns1) ||
        !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(ns2)) {
      await ctx.reply(safeT(ctx, "domain-invalid-ns-format"));
      return;
    }

    try {
      await domainService.updateNameservers(domainId, ns1, ns2);
      if (telegramId > 0) {
        pendingNsDomainByTelegramId.delete(telegramId);
      }
      await ctx.reply(safeT(ctx, "domain-ns-updated", {
        domain: domain.domain,
        ns1,
        ns2,
      }), {
        parse_mode: "HTML",
      });
    } catch (error: any) {
      Logger.error(`Failed to update nameservers for domain ${domainId}:`, error);
      const msg = error?.message || String(error);
      await ctx.reply(safeT(ctx, "error-unknown", { error: msg.slice(0, 300) }), {
        parse_mode: "HTML",
      });
    }
  } catch (error: any) {
    Logger.error("Domain update NS conversation error:", error);
    await ctx.reply(safeT(ctx, "error-unknown", { error: error.message || "Unknown error" }));
  }
}
