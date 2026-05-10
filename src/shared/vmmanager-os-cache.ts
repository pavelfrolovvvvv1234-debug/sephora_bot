/**
 * In-memory cache for VMManager OS list.
 * Refreshed in background so the bot never blocks on getOsList() in the request path.
 *
 * @module shared/vmmanager-os-cache
 */

import type { GetOsListResponse, VmProvider } from "../infrastructure/vmmanager/provider.js";
import { Logger } from "../app/logger.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cached: GetOsListResponse | null = null;

/**
 * Returns the cached OS list or null. Never blocks.
 */
export function getCachedOsList(): GetOsListResponse | null {
  return cached;
}

/**
 * Starts background refresh of the OS list. Call once after creating VMManager.
 * Refreshes immediately and then every CACHE_TTL_MS.
 */
export function startOsListBackgroundRefresh(vmManager: VmProvider): void {
  const refresh = (): void => {
    vmManager
      .getOsList()
      .then((list) => {
        if (list) cached = list;
      })
      .catch(() => {
        cached = null;
      });
  };

  refresh();
  setInterval(refresh, CACHE_TTL_MS);
  Logger.info("VMManager OS list background refresh started (interval 5 min)");
}
