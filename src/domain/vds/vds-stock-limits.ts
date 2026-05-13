/**
 * Stock limits for Sephora VPS/VDS (table `vdslist`).
 *
 * @module domain/vds/vds-stock-limits
 */

import type { DataSource } from "typeorm";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";

/** Max active VDS rows per owning user (`targetUserId`). */
export const VDS_MAX_PER_USER = 2;

/** Max VDS rows platform-wide (all users + resellers). */
export const VDS_MAX_GLOBAL = 40;

export type VdsPurchaseDenyReason = "global_full" | "user_limit";

export async function getVdsCountGlobal(dataSource: DataSource): Promise<number> {
  return dataSource.getRepository(VirtualDedicatedServer).count();
}

export async function getVdsCountForUser(dataSource: DataSource, userId: number): Promise<number> {
  return dataSource.getRepository(VirtualDedicatedServer).count({ where: { targetUserId: userId } });
}

/**
 * If non-null, a new VDS must not be created for this user (global cap first, then per-user).
 */
export async function getVdsPurchaseDenyReason(
  dataSource: DataSource,
  userId: number
): Promise<VdsPurchaseDenyReason | null> {
  const global = await getVdsCountGlobal(dataSource);
  if (global >= VDS_MAX_GLOBAL) return "global_full";
  const owned = await getVdsCountForUser(dataSource, userId);
  if (owned >= VDS_MAX_PER_USER) return "user_limit";
  return null;
}
