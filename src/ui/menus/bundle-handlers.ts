/**
 * Bundle purchase handlers.
 *
 * @module ui/menus/bundle-handlers
 */

import type { AppContext } from "../../shared/types/context.js";
import { BundleType, BundlePeriod } from "../../domain/bundles/types.js";
import { BundleService } from "../../domain/bundles/BundleService.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { Logger } from "../../app/logger.js";
import { InlineKeyboard } from "grammy";

/**
 * Handle bundle purchase callback.
 */
export async function handleBundlePurchase(ctx: AppContext, bundleTypeStr: string, periodStr: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery().catch(() => {});

    const bundleType = bundleTypeStr as BundleType;
    const period = periodStr as BundlePeriod;

    const session = await ctx.session;
    const userId = session.main.user.id;

    // TODO: Get domain name and VPS OS from conversation or session
    // For now, we'll need to start a conversation to collect this info
    await ctx.reply(
      ctx.t("bundle-enter-domain-name"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(ctx.t("button-cancel"), "bundle-cancel"),
      }
    );

    // Store bundle context and mark that we're waiting for domain name
    if (!session.other.bundle) {
      session.other.bundle = { type: bundleTypeStr, period: periodStr };
    }
    session.other.bundle.type = bundleTypeStr;
    session.other.bundle.period = periodStr;
    session.other.bundle.step = "awaiting_domain";
  } catch (error) {
    Logger.error("Failed to handle bundle purchase:", error);
    await ctx.reply(ctx.t("error-unknown", { error: String(error) })).catch(() => {});
  }
}

/**
 * Handle bundle period change.
 */
export async function handleBundleChangePeriod(ctx: AppContext): Promise<void> {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const { bundlePeriodMenu } = await import("./bundles-menu.js");
    await ctx.editMessageText(ctx.t("bundle-select-period"), {
      reply_markup: bundlePeriodMenu,
      parse_mode: "HTML",
    });
  } catch (error) {
    Logger.error("Failed to handle bundle period change:", error);
  }
}

/** Label only: [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])? */
const DOMAIN_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
/** Full domain: label.tld (e.g. example.com) */
const FULL_DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

/**
 * Parse domain input: "example" -> label only; "example.com" -> label + tld.
 * Returns { label, fullDomain } where fullDomain = label + defaultTld (bundle uses defaultTld for registration).
 */
function parseDomainInput(input: string, defaultTld: string): { label: string; fullDomain: string } | null {
  const s = input.toLowerCase().trim();
  if (!s || s.length > 253) return null;
  if (s.includes(".")) {
    if (!FULL_DOMAIN_REGEX.test(s)) return null;
    const lastDot = s.lastIndexOf(".");
    const label = s.slice(0, lastDot);
    if (label.length > 63) return null;
    const tld = s.slice(lastDot);
    return { label, fullDomain: `${label}${defaultTld}` };
  }
  if (!DOMAIN_LABEL_REGEX.test(s)) return null;
  return { label: s, fullDomain: `${s}${defaultTld}` };
}

/**
 * Handle user text when we're waiting for bundle domain name.
 * Accepts domain with or without zone: example or example.com.
 * Returns true if the message was consumed (bundle flow).
 */
export async function handleBundleDomainInput(ctx: AppContext, text: string): Promise<boolean> {
  const session = await ctx.session;
  if (!session.other.bundle || session.other.bundle.step !== "awaiting_domain") {
    return false;
  }
  const { getBundleConfig, calculateBundlePrice } = await import("../../domain/bundles/config.js");
  const bundleType = session.other.bundle.type as BundleType;
  const period = session.other.bundle.period as BundlePeriod;
  const config = await getBundleConfig(bundleType, period);
  if (!config) {
    delete session.other.bundle;
    await ctx.reply(ctx.t("error-unknown", { error: "Bundle config not found" }));
    return true;
  }
  const defaultTld = config.domainTld || ".com";
  const parsed = parseDomainInput(text, defaultTld);
  if (!parsed) {
    await ctx.reply(
      ctx.t("domain-invalid-format-registrar") ||
        "Неверный формат. Введите домен с зоной (example.com) или без (example)."
    );
    return true;
  }
  const { label: domainLabel, fullDomain } = parsed;

  const user = await ctx.appDataSource.manager.findOne(await import("../../entities/User.js").then((m) => m.default), {
    where: { id: session.main.user.id },
  });
  const hasPrime = user?.primeActiveUntil && new Date(user.primeActiveUntil) > new Date();
  const pricing = await calculateBundlePrice(config, !!hasPrime);

  session.other.bundle.domainName = domainLabel;
  session.other.bundle.step = "awaiting_confirm";

  const confirmText =
    ctx.t("bundle-confirm-purchase-text", {
      domain: fullDomain,
      price: pricing.finalPrice.toFixed(2),
    }) ||
    `Домен: <b>${fullDomain}</b>\nИтоговая цена пакета: <b>$${pricing.finalPrice.toFixed(2)}</b>\n\nПодтвердить покупку?`;
  await ctx.reply(confirmText, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text(ctx.t("button-confirm") || "✅ Подтвердить", "bundle-confirm-purchase")
      .row()
      .text(ctx.t("button-cancel"), "bundle-cancel"),
  });
  return true;
}

/**
 * Handle bundle purchase confirmation (user clicked "Подтвердить").
 */
export async function handleBundleConfirmPurchase(ctx: AppContext): Promise<void> {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const bundle = session.other?.bundle;
    if (!bundle?.domainName || bundle.step !== "awaiting_confirm") {
      await ctx.reply(ctx.t("error-invalid-context") || "Сессия истекла. Начните выбор пакета заново.");
      if (session.other.bundle) delete session.other.bundle;
      return;
    }
    const userId = session.main.user.id;
    const context = {
      bundleType: bundle.type as BundleType,
      period: bundle.period as BundlePeriod,
      domainName: bundle.domainName,
      vpsOsId: bundle.vpsOsId ?? 1,
    };
    const dataSource = (ctx as any).appDataSource ?? (await getAppDataSource());
    const vmmanager = (ctx as any).vmmanager as import("../../infrastructure/vmmanager/provider.js").VmProvider | undefined;
    const apiToken = (process.env.AMPER_API_TOKEN || "").trim();
    let registerDomainFn: ((fullDomain: string, ns1: string, ns2: string) => Promise<{ success: boolean; domainId?: string; error?: string }>) | undefined;
    if (apiToken) {
      const defaultNs1 = process.env.DEFAULT_NS1 || "ns1.example.com";
      const defaultNs2 = process.env.DEFAULT_NS2 || "ns2.example.com";
      const { AmperDomainsProvider } = await import("../../infrastructure/domains/AmperDomainsProvider.js");
      const amperProvider = new AmperDomainsProvider({
        apiBaseUrl: process.env.AMPER_API_BASE_URL || "https://amper.lat",
        apiToken,
        timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
        defaultNs1,
        defaultNs2,
      });
      registerDomainFn = async (fullDomain: string, ns1: string, ns2: string) => {
        const result = await amperProvider.registerDomain({
          domain: fullDomain,
          period: 1,
          ns1,
          ns2,
        });
        return { success: result.success, domainId: result.domainId, error: result.error };
      };
    }
    if (!vmmanager && !registerDomainFn) {
      await ctx.reply(
        ctx.t("bundle-unavailable-no-vm-no-amper") ||
          "Сейчас пакет недоступен: не настроены VPS (VMManager) и домены (Amper). Настройте .env и попробуйте позже.",
        { parse_mode: "HTML" }
      );
      if (session.other.bundle) delete session.other.bundle;
      return;
    }

    const bundleService = new BundleService(dataSource, vmmanager ?? null);
    const result = vmmanager
      ? await bundleService.purchaseBundle(
          userId,
          context,
          context.domainName,
          context.vpsOsId,
          registerDomainFn
        )
      : await bundleService.purchaseBundleDomainOnly(userId, context, context.domainName, registerDomainFn!);

    if (session.other.bundle) delete session.other.bundle;

    if (result.success) {
      const msg = result.vds
        ? (ctx.t("bundle-purchase-success", {
            domain: result.domain?.domain ?? "",
            vdsId: result.vds?.vdsId,
            ip: result.vds?.ipv4Addr,
          }) ||
          `Пакет успешно приобретён.\nДомен: ${result.domain?.domain}\nVPS ID: ${result.vds?.vdsId}\nIP: ${result.vds?.ipv4Addr}`)
        : (ctx.t("bundle-purchase-domain-only", {
            domain: result.domain?.domain ?? "",
          }) ||
          `Домен <b>${result.domain?.domain}</b> успешно зарегистрирован.\n\nVPS временно недоступен (не подключены данные от VMManager). Когда подключите — пакеты с VPS заработают.`);
      await ctx.reply(msg, { parse_mode: "HTML" });
    } else {
      await ctx.reply(ctx.t("error-unknown", { error: result.error || "Purchase failed" }), {
        parse_mode: "HTML",
      });
    }
  } catch (error: any) {
    Logger.error("Bundle confirm purchase error:", error);
    const session = await ctx.session;
    if (session.other?.bundle) delete session.other.bundle;
    await ctx.reply(ctx.t("error-unknown", { error: error?.message || "Unknown error" }), {
      parse_mode: "HTML",
    });
  }
}
