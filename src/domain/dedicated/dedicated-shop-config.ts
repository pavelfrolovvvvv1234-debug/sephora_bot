/**
 * Dedicated purchase shop: tier per server index (prices.json dedicated_servers order).
 * Indices 0–14 = standard, 15–24 = bulletproof — 25 servers total.
 */

export type DedicatedShopTier = "start" | "standard" | "performance" | "enterprise";

export const DEDICATED_SHOP_PAGE_SIZE = 6;

/** Tier by global index in prices.dedicated_servers (must cover every server). */
export const DEDICATED_INDEX_TIER: Record<number, DedicatedShopTier> = {
  // Standard (15)
  0: "standard",
  1: "standard",
  2: "standard",
  3: "performance",
  4: "performance",
  5: "performance",
  6: "start",
  7: "standard",
  8: "performance",
  9: "performance",
  10: "enterprise",
  11: "enterprise",
  12: "enterprise",
  13: "enterprise",
  14: "enterprise",
  // Bulletproof (10)
  15: "start",
  16: "start",
  17: "standard",
  18: "performance",
  19: "performance",
  20: "enterprise",
  21: "enterprise",
  22: "enterprise",
  23: "enterprise",
  24: "enterprise",
};

/** Short list labels (premium, compact) — one per index; must match catalog length. */
export const DEDICATED_COMPACT_LABEL: Record<number, string> = {
  0: "i7-6700 • 64GB",
  1: "i7-8700 • 64GB",
  2: "Xeon E3 • 64GB",
  3: "Ryzen 7 • 64GB",
  4: "Ryzen 9 • 64GB",
  5: "Ryzen 9 • 128GB",
  6: "Xeon E3 • 32GB",
  7: "2x Xeon • 64GB",
  8: "2x Xeon • 144GB",
  9: "2x Xeon • 256GB",
  10: "2x Xeon • 384GB",
  11: "2x Xeon • 512GB",
  12: "2x Platinum 8173M • 768GB",
  13: "2x Platinum 8168 • 768GB · 4TB",
  14: "2x Platinum 8168 • 1024GB",
  15: "Xeon E3 • 16GB",
  16: "Xeon E3 • 32GB",
  17: "2x Xeon • 64GB",
  18: "2x Xeon • 144GB",
  19: "2x Xeon • 256GB",
  20: "2x Xeon • 384GB",
  21: "2x Xeon • 512GB",
  22: "2x Platinum 8173M • 768GB",
  23: "2x Platinum 8168 • 768GB · 8TB",
  24: "2x Platinum 8168 • 1024GB",
};

export function assertDedicatedCatalogLength(catalogLen: number): void {
  const expected = Object.keys(DEDICATED_INDEX_TIER).length;
  if (catalogLen !== expected) {
    console.warn(
      `[dedicated-shop] Catalog has ${catalogLen} servers, config expects ${expected}. Update dedicated-shop-config.ts.`
    );
  }
}

/** Location keys (FTL: dedicated-location-{key}). */
export const DEDICATED_LOCATION_KEYS = ["nl-amsterdam", "de-germany", "usa", "tr-istanbul"] as const;

const AUTOMATED_LOCATION_KEY = "nl-amsterdam";

function prioritizeAutomatedLocation(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    if (a === AUTOMATED_LOCATION_KEY && b !== AUTOMATED_LOCATION_KEY) return -1;
    if (b === AUTOMATED_LOCATION_KEY && a !== AUTOMATED_LOCATION_KEY) return 1;
    return 0;
  });
}

export function dedicatedLocationKeysForServer(server: { locations?: string[] } | undefined): string[] {
  const keys = DEDICATED_LOCATION_KEYS as readonly string[];
  if (server?.locations?.length && keys.filter((k) => server.locations!.includes(k)).length > 0) {
    const filtered = (server.locations as string[]).filter((k) => keys.includes(k));
    return prioritizeAutomatedLocation(filtered);
  }
  return prioritizeAutomatedLocation([...keys]);
}

/** OS keys (FTL: dedicated-os-{key}). */
export const DEDICATED_OS_KEYS = [
  "alma8",
  "alma9",
  "rockylinux",
  "centos9",
  "debian11",
  "debian12",
  "debian13",
  "freebsd",
  "ubuntu2204",
  "ubuntu2404",
] as const;
