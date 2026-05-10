/**
 * Infrastructure bundle types and interfaces.
 *
 * @module domain/bundles/types
 */

/**
 * Bundle tier/period for pricing.
 */
export enum BundlePeriod {
  MONTHLY = "monthly", // 1 month - 10-12% discount
  QUARTERLY = "quarterly", // 3 months - 15-18% discount
  SEMI_ANNUAL = "semi_annual", // 6 months - 20% discount
}

/**
 * Bundle type identifier.
 */
export enum BundleType {
  STARTER_SHIELD = "starter_shield",
  LAUNCH_PACK = "launch_pack",
  INFRASTRUCTURE_BUNDLE = "infrastructure_bundle",
  SECURE_LAUNCH_KIT = "secure_launch_kit",
  FULL_STACK_DEPLOY_PACK = "full_stack_deploy_pack",
  PRO_INFRASTRUCTURE_PACK = "pro_infrastructure_pack", // Premium version
}

/**
 * Bundle configuration: what's included.
 */
export interface BundleConfig {
  /** Bundle type identifier. */
  type: BundleType;
  /** Display name (localized). */
  nameKey: string;
  /** Description key (localized). */
  descriptionKey: string;
  /** Domain TLD (e.g., ".com") - null if not included. */
  domainTld: string | null;
  /** VPS rate ID from prices.json (index in virtual_vds array) - null if not included. */
  vpsRateId: number | null;
  /** Whether VPS should be bulletproof. */
  vpsBulletproof: boolean;
  /** Period in months (1, 3, or 6). */
  periodMonths: number;
  /** Discount percentage (10-20%). */
  discountPercent: number;
  /** Included services/features. */
  features: BundleFeature[];
}

/**
 * Feature included in bundle.
 */
export enum BundleFeature {
  DOMAIN = "domain",
  VPS = "vps",
  DNS_SETUP = "dns_setup",
  DOMAIN_VPS_BINDING = "domain_vps_binding",
  NGINX_CONFIG = "nginx_config",
  SSL_CERTIFICATE = "ssl_certificate",
  FIREWALL_CONFIG = "firewall_config",
  INCLUDED_IP = "included_ip",
  DEPLOY_TEMPLATE = "deploy_template", // LAMP / Docker / FastPanel
  REVERSE_DNS = "reverse_dns", // Pro only
  PRIVATE_DNS = "private_dns", // Pro only
  MONITORING = "monitoring", // Pro only
  EXTRA_IP = "extra_ip", // Pro only
}

/**
 * Bundle pricing calculation result.
 */
export interface BundlePrice {
  /** Base price (sum of individual services). */
  basePrice: number;
  /** Discount amount. */
  discountAmount: number;
  /** Final price after discount. */
  finalPrice: number;
  /** Discount percentage applied. */
  discountPercent: number;
  /** Savings message (localized). */
  savingsMessage: string;
}

/**
 * Bundle purchase context (what user selected).
 */
export interface BundlePurchaseContext {
  /** Bundle type. */
  bundleType: BundleType;
  /** Period. */
  period: BundlePeriod;
  /** Domain name (if user provided). */
  domainName?: string;
  /** VPS OS ID (if user selected). */
  vpsOsId?: number;
}
