/**
 * Domain shop categories and TLD grouping. Only TLDs present in prices.json are shown.
 */

export type DomainShopCategory = "popular" | "business" | "tech" | "geo" | "all";

/** Preferred TLDs per category (with leading dot). Missing from prices are skipped at runtime. */
export const DOMAIN_SHOP_CATEGORY_TLDS: Record<Exclude<DomainShopCategory, "all">, string[]> = {
  popular: [".com", ".net", ".org", ".io"],
  business: [".shop", ".biz", ".pro", ".site"],
  tech: [".dev", ".app", ".io", ".host"],
  geo: [".us", ".uk", ".cc", ".at", ".ca"],
};

/** Max TLD choice buttons per screen (excluding nav rows). */
export const DOMAIN_SHOP_PAGE_SIZE = 6;

export function zoneToCallbackSuffix(zone: string): string {
  return zone.replace(/^\./, "").toLowerCase();
}

export function suffixToZone(suffix: string): string {
  const s = suffix.trim().toLowerCase();
  if (!s) return "";
  return s.startsWith(".") ? s : `.${s}`;
}
