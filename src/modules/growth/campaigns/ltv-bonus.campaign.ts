/**
 * Dynamic bonus by LTV segment: newbie (0–30d), active (30–180d), VIP (180+d).
 * VIP: not percent but privilege (priority ticket, personal manager). Used when applying bonus or showing message.
 *
 * @module modules/growth/campaigns/ltv-bonus.campaign
 */

import type { DataSource } from "typeorm";
import type { LTVSegment } from "../types.js";
import User from "../../../entities/User.js";
import TopUp, { TopUpStatus } from "../../../entities/TopUp.js";

const NEWBIE_DAYS = 30;
const ACTIVE_DAYS = 180;

/**
 * Get user's LTV segment from registration date and optional total deposit.
 */
export async function getLtvSegment(
  dataSource: DataSource,
  userId: number
): Promise<LTVSegment> {
  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { id: userId }, select: ["createdAt"] });
  if (!user) return "newbie_0_30d";
  const daysSinceReg = (Date.now() - new Date(user.createdAt).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceReg < NEWBIE_DAYS) return "newbie_0_30d";
  if (daysSinceReg < ACTIVE_DAYS) return "active_30_180d";
  return "vip_180d";
}

/**
 * Get bonus percent for segment (for display or application). VIP returns 0 (privilege instead).
 */
export function getBonusPercentForSegment(segment: LTVSegment): number {
  switch (segment) {
    case "newbie_0_30d":
      return 2;
    case "active_30_180d":
      return 4;
    case "vip_180d":
      return 0; // privilege: priority support, etc.
    default:
      return 0;
  }
}

/**
 * VIP privilege message (no percent).
 */
export const VIP_PRIVILEGE_MESSAGE =
  "Вы в статусе VIP. Доступны приоритетная поддержка и персональный менеджер. Подробности в разделе помощи.";
