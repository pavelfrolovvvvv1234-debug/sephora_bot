/**
 * VPS shop: tier per plan index (prices.json virtual_vds order). 4 plans total.
 *
 * Sephora VPS template (must match prices.json virtual_vds rows in order):
 * 1/1/10 ($1), 1/2/15 ($2), 2/2/20 ($3), 2/3/30 ($4) — Proxmox createVM uses cpu/ram/ssd/network from these rows.
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

/** Canonical Sephora VPS SKUs — warn on startup if prices.json drifts (Proxmox resize uses these). */
export const VPS_CATALOG_TEMPLATE: ReadonlyArray<{
  name: string;
  cpu: number;
  ram: number;
  ssd: number;
  network: number;
}> = [
  { name: "1/1/10", cpu: 1, ram: 1, ssd: 10, network: 150 },
  { name: "1/2/15", cpu: 1, ram: 2, ssd: 15, network: 150 },
  { name: "2/2/20", cpu: 2, ram: 2, ssd: 20, network: 150 },
  { name: "2/3/30", cpu: 2, ram: 3, ssd: 30, network: 150 },
];

export function assertVdsCatalogLength(catalogLen: number): void {
  const expected = Object.keys(VDS_INDEX_TIER).length;
  if (catalogLen !== expected) {
    console.warn(
      `[vds-shop] Catalog has ${catalogLen} rates, config expects ${expected}. Update vds-shop-config.ts.`
    );
  }
}

/** Log if virtual_vds does not match Sephora template (ops / Proxmox plans must stay aligned). */
export function warnIfVdsCatalogDrift(
  list: Array<{ name?: string; cpu?: number; ram?: number; ssd?: number; network?: number }>
): void {
  if (list.length !== VPS_CATALOG_TEMPLATE.length) {
    console.warn(
      `[vds-shop] virtual_vds length ${list.length} !== template ${VPS_CATALOG_TEMPLATE.length} — update VPS_CATALOG_TEMPLATE or prices.json.`
    );
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const want = VPS_CATALOG_TEMPLATE[i]!;
    const got = list[i]!;
    const ok =
      String(got.name) === want.name &&
      Number(got.cpu) === want.cpu &&
      Number(got.ram) === want.ram &&
      Number(got.ssd) === want.ssd &&
      Number(got.network) === want.network;
    if (!ok) {
      console.warn(
        `[vds-shop] Rate index ${i} drift: expected ${JSON.stringify(want)}, got ${JSON.stringify({
          name: got.name,
          cpu: got.cpu,
          ram: got.ram,
          ssd: got.ssd,
          network: got.network,
        })} — Proxmox sizing may not match тариф.`
      );
    }
  }
}
