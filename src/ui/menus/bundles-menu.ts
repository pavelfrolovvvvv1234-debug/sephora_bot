/**
 * Infrastructure bundles menu.
 *
 * @module ui/menus/bundles-menu
 */

import { Menu } from "@grammyjs/menu";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import User from "../../entities/User.js";
import { BundleType } from "../../domain/bundles/types.js";
import { getBundleConfig, calculateBundlePrice } from "../../domain/bundles/config.js";
import { Logger } from "../../app/logger.js";

const PERIOD_MONTHLY = "monthly";
const PERIOD_QUARTERLY = "quarterly";
const PERIOD_SEMI_ANNUAL = "semi_annual";

type BundlePeriodStr = "monthly" | "quarterly" | "semi_annual";

function parseBundlePeriod(periodStr: string | undefined): BundlePeriodStr {
  if (!periodStr) return PERIOD_MONTHLY;
  if (periodStr === PERIOD_MONTHLY || periodStr === "monthly") return PERIOD_MONTHLY;
  if (periodStr === PERIOD_QUARTERLY || periodStr === "quarterly") return PERIOD_QUARTERLY;
  if (periodStr === PERIOD_SEMI_ANNUAL || periodStr === "semi_annual") return PERIOD_SEMI_ANNUAL;
  return PERIOD_MONTHLY;
}

/**
 * Bundle period selection menu.
 */
function getCurrentBundleType(session: { other?: { bundle?: { type?: string } } }): BundleType {
  const t = session.other?.bundle?.type;
  if (t === BundleType.STARTER_SHIELD || t === "starter_shield") return BundleType.STARTER_SHIELD;
  if (t === BundleType.PRO_INFRASTRUCTURE_PACK || t === "pro_infrastructure_pack") return BundleType.PRO_INFRASTRUCTURE_PACK;
  return BundleType.STARTER_SHIELD;
}

export const bundlePeriodMenu = new Menu<AppContext>("bundle-period-menu")
  .text(
    (ctx) => `${ctx.t("bundle-period-monthly")} (${ctx.t("bundle-discount-12")})`,
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (!session.other.bundle) {
        session.other.bundle = { type: BundleType.STARTER_SHIELD as string, period: PERIOD_MONTHLY };
      }
      session.other.bundle.period = PERIOD_MONTHLY;
      const bundleType = getCurrentBundleType(session);
      await showBundleDetails(ctx, bundleType, PERIOD_MONTHLY);
    }
  )
  .row()
  .text(
    (ctx) => `${ctx.t("bundle-period-quarterly")} (${ctx.t("bundle-discount-17")})`,
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (!session.other.bundle) {
        session.other.bundle = { type: BundleType.STARTER_SHIELD as string, period: PERIOD_QUARTERLY };
      }
      session.other.bundle.period = PERIOD_QUARTERLY;
      const bundleType = getCurrentBundleType(session);
      await showBundleDetails(ctx, bundleType, PERIOD_QUARTERLY);
    }
  )
  .row()
  .text(
    (ctx) => `${ctx.t("bundle-period-semi-annual")} (${ctx.t("bundle-discount-20")})`,
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (!session.other.bundle) {
        session.other.bundle = { type: BundleType.STARTER_SHIELD as string, period: PERIOD_SEMI_ANNUAL };
      }
      session.other.bundle.period = PERIOD_SEMI_ANNUAL;
      const bundleType = getCurrentBundleType(session);
      await showBundleDetails(ctx, bundleType, PERIOD_SEMI_ANNUAL);
    }
  )
  .row()
  .back((ctx) => ctx.t("button-back"));

/**
 * Bundle type selection menu.
 */
export const bundleTypeMenu = new Menu<AppContext>("bundle-type-menu")
  .text(
    (ctx) => `🛡️ ${ctx.t("bundle-starter-shield")}`,
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (!session.other.bundle) {
        session.other.bundle = { type: BundleType.STARTER_SHIELD as string, period: PERIOD_MONTHLY };
      }
      session.other.bundle.type = BundleType.STARTER_SHIELD as string;
      const period = parseBundlePeriod(session.other.bundle.period);
      await showBundleDetails(ctx, BundleType.STARTER_SHIELD, period);
    }
  )
  .row()
  .text(
    (ctx) => `⭐ ${ctx.t("bundle-pro-infrastructure")}`,
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (!session.other.bundle) {
        session.other.bundle = { type: BundleType.PRO_INFRASTRUCTURE_PACK as string, period: PERIOD_MONTHLY };
      }
      session.other.bundle.type = BundleType.PRO_INFRASTRUCTURE_PACK as string;
      const period = parseBundlePeriod(session.other.bundle.period);
      await showBundleDetails(ctx, BundleType.PRO_INFRASTRUCTURE_PACK, period);
    }
  )
  .row()
  .back((ctx) => ctx.t("button-back"));

/**
 * Main bundles menu.
 */
export const bundlesMenu = new Menu<AppContext>("bundles-menu")
  .submenu(
    (ctx) => ctx.t("bundle-infrastructure-bundles"),
    "bundle-type-menu",
    async (ctx) => {
      await ctx.editMessageText(ctx.t("bundle-select-type"), {
        parse_mode: "HTML",
      });
    }
  )
  .row()
  .back((ctx) => ctx.t("button-back"));

/**
 * Show bundle details with pricing.
 */
async function showBundleDetails(ctx: AppContext, bundleType: BundleType, period: BundlePeriodStr): Promise<void> {
  try {
    const config = await getBundleConfig(bundleType, period as import("../../domain/bundles/types.js").BundlePeriod);
    if (!config) {
      await ctx.editMessageText(ctx.t("error-unknown", { error: "Bundle not found" }));
      return;
    }

    const dataSource = await getAppDataSource();
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOneBy({ id: (await ctx.session).main.user.id });
    const hasPrime = user?.primeActiveUntil && new Date(user.primeActiveUntil) > new Date();

    const pricing = await calculateBundlePrice(config, hasPrime ?? false);

    const isStarterShield = bundleType === BundleType.STARTER_SHIELD;
    const isProPack = bundleType === BundleType.PRO_INFRASTRUCTURE_PACK;

    const text = isStarterShield
      ? [
          `<b>${ctx.t("bundle-starter-shield-title")}</b>`,
          "",
          ctx.t("bundle-starter-shield-intro"),
          "",
          ctx.t("bundle-starter-shield-tagline"),
          "",
          `<b>${ctx.t("bundle-starter-shield-includes-title")}</b>`,
          "",
          ctx.t("bundle-starter-shield-includes-list"),
          "",
          `<b>${ctx.t("bundle-starter-shield-benefits-title")}</b>`,
          "",
          ctx.t("bundle-starter-shield-benefits-list"),
          "",
          ctx.t("bundle-ready-in-15min"),
          "",
          `<b>${ctx.t("bundle-starter-shield-pricing-title")}</b>`,
          "",
          `${ctx.t("bundle-starter-shield-pricing-base")}: $${pricing.basePrice.toFixed(2)}`,
          `${ctx.t("bundle-starter-shield-pricing-discount")}: –${pricing.discountPercent}%`,
          `${ctx.t("bundle-starter-shield-pricing-final")}: $${pricing.finalPrice.toFixed(2)}`,
          `${ctx.t("bundle-starter-shield-pricing-savings")}: $${pricing.discountAmount.toFixed(2)}`,
        ].join("\n")
      : isProPack
        ? [
            `<b>${ctx.t("bundle-pro-infrastructure-title")}</b>`,
            "",
            ctx.t("bundle-pro-infrastructure-intro"),
            "",
            ctx.t("bundle-pro-infrastructure-tagline"),
            "",
            `<b>${ctx.t("bundle-pro-infrastructure-includes-title")}</b>`,
            "",
            ctx.t("bundle-pro-infrastructure-includes-list"),
            "",
            `<b>${ctx.t("bundle-pro-infrastructure-benefits-title")}</b>`,
            "",
            ctx.t("bundle-pro-infrastructure-benefits-list"),
            "",
            ctx.t("bundle-ready-in-15min"),
            "",
            `<b>${ctx.t("bundle-starter-shield-pricing-title")}</b>`,
            "",
            `${ctx.t("bundle-starter-shield-pricing-base")}: $${pricing.basePrice.toFixed(2)}`,
            `${ctx.t("bundle-starter-shield-pricing-discount")}: –${pricing.discountPercent}%`,
            `${ctx.t("bundle-starter-shield-pricing-final")}: $${pricing.finalPrice.toFixed(2)}`,
            `${ctx.t("bundle-starter-shield-pricing-savings")}: $${pricing.discountAmount.toFixed(2)}`,
          ].join("\n")
        : (() => {
          const featureList = Array.isArray(config.features) ? config.features : [];
          const features = featureList.map((f) => {
            switch (f) {
              case "domain":
                return `✔ ${ctx.t("bundle-feature-domain")}`;
              case "vps":
                return `✔ ${ctx.t("bundle-feature-vps")}`;
              case "dns_setup":
                return `✔ ${ctx.t("bundle-feature-dns-setup")}`;
              case "domain_vps_binding":
                return `✔ ${ctx.t("bundle-feature-domain-binding")}`;
              case "nginx_config":
                return `✔ ${ctx.t("bundle-feature-nginx")}`;
              case "ssl_certificate":
                return `✔ ${ctx.t("bundle-feature-ssl")}`;
              case "firewall_config":
                return `✔ ${ctx.t("bundle-feature-firewall")}`;
              case "included_ip":
                return `✔ ${ctx.t("bundle-feature-ip")}`;
              case "deploy_template":
                return `✔ ${ctx.t("bundle-feature-deploy-template")}`;
              case "reverse_dns":
                return `✔ ${ctx.t("bundle-feature-reverse-dns")}`;
              case "private_dns":
                return `✔ ${ctx.t("bundle-feature-private-dns")}`;
              case "monitoring":
                return `✔ ${ctx.t("bundle-feature-monitoring")}`;
              case "extra_ip":
                return `✔ ${ctx.t("bundle-feature-extra-ip")}`;
              default:
                return "";
            }
          });
          return [
            `<b>${ctx.t(config.nameKey)}</b>`,
            "",
            ctx.t(config.descriptionKey),
            "",
            `<b>${ctx.t("bundle-includes")}:</b>`,
            features.join("\n"),
            "",
            `<b>${ctx.t("bundle-pricing")}:</b>`,
            `${ctx.t("bundle-base-price")}: ${pricing.basePrice.toFixed(2)} $`,
            `${ctx.t("bundle-discount")}: -${pricing.discountPercent}%`,
            `${ctx.t("bundle-final-price")}: <b>${pricing.finalPrice.toFixed(2)} $</b>`,
            `${ctx.t("bundle-savings")}: ${pricing.discountAmount.toFixed(2)} $`,
            "",
            ctx.t("bundle-ready-in-15min"),
          ].join("\n");
        })();

    const keyboard = new InlineKeyboard()
      .text(ctx.t("bundle-button-purchase"), `bundle-purchase-${bundleType}-${period}`)
      .row()
      .text(ctx.t("bundle-button-change-period"), "bundle-change-period")
      .row()
      .text(ctx.t("button-back"), "bundle-back-to-types");

    await ctx.editMessageText(text, {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  } catch (error) {
    Logger.error("Failed to show bundle details:", error);
    await ctx.editMessageText(ctx.t("error-unknown", { error: String(error) }));
  }
}
