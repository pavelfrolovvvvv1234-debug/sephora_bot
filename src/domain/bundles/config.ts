/**
 * Infrastructure bundle configurations.
 *
 * @module domain/bundles/config
 */

import type { BundleConfig } from "./types.js";
import { BundlePeriod, BundleType, BundleFeature } from "./types.js";
import prices from "@helpers/prices";

/**
 * Get bundle configuration by type and period.
 *
 * @param bundleType - Bundle type
 * @param period - Bundle period
 * @returns Bundle configuration
 */
export async function getBundleConfig(
  bundleType: BundleType,
  period: BundlePeriod
): Promise<BundleConfig | null> {
  const periodMonths = period === BundlePeriod.MONTHLY ? 1 : period === BundlePeriod.QUARTERLY ? 3 : 6;
  const discountPercent =
    period === BundlePeriod.MONTHLY ? 12 : period === BundlePeriod.QUARTERLY ? 17 : 20;

  const baseConfigs: Record<BundleType, Omit<BundleConfig, "periodMonths" | "discountPercent">> = {
    [BundleType.STARTER_SHIELD]: {
      type: BundleType.STARTER_SHIELD,
      nameKey: "bundle-starter-shield",
      descriptionKey: "bundle-starter-shield-desc",
      domainTld: ".com",
      vpsRateId: 0, // 1/1/10
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
      ],
    },
    [BundleType.LAUNCH_PACK]: {
      type: BundleType.LAUNCH_PACK,
      nameKey: "bundle-launch-pack",
      descriptionKey: "bundle-launch-pack-desc",
      domainTld: ".com",
      vpsRateId: 1, // 2/2/15
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.NGINX_CONFIG,
        BundleFeature.SSL_CERTIFICATE,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
        BundleFeature.DEPLOY_TEMPLATE,
      ],
    },
    [BundleType.INFRASTRUCTURE_BUNDLE]: {
      type: BundleType.INFRASTRUCTURE_BUNDLE,
      nameKey: "bundle-infrastructure",
      descriptionKey: "bundle-infrastructure-desc",
      domainTld: ".com",
      vpsRateId: 3, // 2/4/30
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.NGINX_CONFIG,
        BundleFeature.SSL_CERTIFICATE,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
        BundleFeature.DEPLOY_TEMPLATE,
      ],
    },
    [BundleType.SECURE_LAUNCH_KIT]: {
      type: BundleType.SECURE_LAUNCH_KIT,
      nameKey: "bundle-secure-launch",
      descriptionKey: "bundle-secure-launch-desc",
      domainTld: ".com",
      vpsRateId: 2, // 2/3/25
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.NGINX_CONFIG,
        BundleFeature.SSL_CERTIFICATE,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
        BundleFeature.DEPLOY_TEMPLATE,
      ],
    },
    [BundleType.FULL_STACK_DEPLOY_PACK]: {
      type: BundleType.FULL_STACK_DEPLOY_PACK,
      nameKey: "bundle-full-stack",
      descriptionKey: "bundle-full-stack-desc",
      domainTld: ".com",
      vpsRateId: 3, // 2/4/30
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.NGINX_CONFIG,
        BundleFeature.SSL_CERTIFICATE,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
        BundleFeature.DEPLOY_TEMPLATE,
      ],
    },
    [BundleType.PRO_INFRASTRUCTURE_PACK]: {
      type: BundleType.PRO_INFRASTRUCTURE_PACK,
      nameKey: "bundle-pro-infrastructure",
      descriptionKey: "bundle-pro-infrastructure-desc",
      domainTld: ".com",
      vpsRateId: 3, // 2/4/30
      vpsBulletproof: true,
      features: [
        BundleFeature.DOMAIN,
        BundleFeature.VPS,
        BundleFeature.DNS_SETUP,
        BundleFeature.DOMAIN_VPS_BINDING,
        BundleFeature.NGINX_CONFIG,
        BundleFeature.SSL_CERTIFICATE,
        BundleFeature.FIREWALL_CONFIG,
        BundleFeature.INCLUDED_IP,
        BundleFeature.DEPLOY_TEMPLATE,
        BundleFeature.REVERSE_DNS,
        BundleFeature.PRIVATE_DNS,
        BundleFeature.MONITORING,
        BundleFeature.EXTRA_IP,
      ],
    },
  };

  const base = baseConfigs[bundleType];
  if (!base) return null;

  return {
    ...base,
    periodMonths,
    discountPercent,
  };
}

/**
 * Calculate bundle price.
 *
 * @param config - Bundle configuration
 * @param primeDiscount - Whether user has Prime (additional 10% on top)
 * @returns Bundle price calculation
 */
export async function calculateBundlePrice(
  config: BundleConfig,
  primeDiscount: boolean = false
): Promise<{ basePrice: number; discountAmount: number; finalPrice: number; discountPercent: number }> {
  const pricesList = await prices();

  let basePrice = 0;

  // Domain price (1 year)
  if (config.domainTld) {
    const domainPrice = pricesList.domains[config.domainTld as keyof typeof pricesList.domains]?.price ?? 0;
    basePrice += domainPrice;
  }

  // VPS price (multiply by period months)
  if (config.vpsRateId != null) {
    const vpsRate = pricesList.virtual_vds[config.vpsRateId];
    if (vpsRate) {
      const vpsMonthlyPrice = config.vpsBulletproof ? vpsRate.price.bulletproof : vpsRate.price.default;
      basePrice += vpsMonthlyPrice * config.periodMonths;
    }
  }

  // Apply bundle discount
  const bundleDiscountAmount = Math.round((basePrice * config.discountPercent) / 100 * 100) / 100;
  const priceAfterBundleDiscount = basePrice - bundleDiscountAmount;

  // Apply Prime discount if applicable (10% on already discounted price)
  let finalPrice = priceAfterBundleDiscount;
  let totalDiscountPercent = config.discountPercent;
  if (primeDiscount) {
    const primeDiscountAmount = Math.round(priceAfterBundleDiscount * 0.1 * 100) / 100;
    finalPrice = priceAfterBundleDiscount - primeDiscountAmount;
    // Total discount = bundle discount + prime discount (compound)
    totalDiscountPercent = Math.round((1 - finalPrice / basePrice) * 100);
  }

  const discountAmount = basePrice - finalPrice;

  return {
    basePrice,
    discountAmount,
    finalPrice: Math.round(finalPrice * 100) / 100,
    discountPercent: totalDiscountPercent,
  };
}
