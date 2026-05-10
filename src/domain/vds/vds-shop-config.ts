/**
 * VPS shop: tier per plan index (prices.json virtual_vds order). 4 plans total.
 */

export type VpsShopTier = "start" | "standard" | "performance" | "enterprise";

export const VDS_SHOP_PAGE_SIZE = 6;

/** Tier by index in prices.virtual_vds */
export const VDS_INDEX_TIER: Record<number, VpsShopTier> = {
  0: "start",
  1: "start",
  2: "standard",
  3: "standard",
};

export function assertVdsCatalogLength(catalogLen: number): void {
  const expected = Object.keys(VDS_INDEX_TIER).length;
  if (catalogLen !== expected) {
    console.warn(
      `[vds-shop] Catalog has ${catalogLen} rates, config expects ${expected}. Update vds-shop-config.ts.`
    );
  }
}
