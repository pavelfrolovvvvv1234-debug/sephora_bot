/**
 * Tier (gamification): Bronze $0–499, Silver $500+, Gold $2000+, Platinum $5000+.
 * On tier upgrade: «Вы перешли в Silver. Теперь +3% к каждому пополнению.»
 * Called from payment flow after top-up (no cron).
 *
 * @module modules/growth/campaigns/tier.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import type { UserTier } from "../types.js";
import { TIER_THRESHOLDS } from "../types.js";
import User from "../../../entities/User.js";
import TopUp, { TopUpStatus } from "../../../entities/TopUp.js";

const TIER_LAST_KEY = "growth_tier_last:";

const TIER_MESSAGES: Record<Exclude<UserTier, "bronze">, string> = {
  silver: "Вы перешли в Silver. Теперь +3% к каждому пополнению.",
  gold: "Вы перешли в Gold. Теперь +5% к каждому пополнению.",
  platinum: "Вы перешли в Platinum. Теперь +7% к каждому пополнению и приоритетная поддержка.",
};

function getTierByLtv(ltv: number): UserTier {
  if (ltv >= TIER_THRESHOLDS.platinum) return "platinum";
  if (ltv >= TIER_THRESHOLDS.gold) return "gold";
  if (ltv >= TIER_THRESHOLDS.silver) return "silver";
  return "bronze";
}

/**
 * Get cumulative deposit (LTV) for user from TopUp completed.
 */
export async function getCumulativeDeposit(dataSource: DataSource, userId: number): Promise<number> {
  const repo = dataSource.getRepository(TopUp);
  const result = await repo
    .createQueryBuilder("t")
    .select("COALESCE(SUM(t.amount), 0)", "total")
    .where("t.target_user_id = :uid", { uid: userId })
    .andWhere("t.status = :status", { status: TopUpStatus.Completed })
    .getRawOne<{ total: string }>();
  return Number(result?.total ?? 0);
}

export interface TierUpgradeInfo {
  message: string;
  newTier: UserTier;
  previousTier: UserTier;
  cumulativeDeposit: number;
}

/**
 * Check if user just crossed into a new tier after this top-up. Returns message and tier info for emit.
 */
export async function getTierUpgradeInfo(
  dataSource: DataSource,
  userId: number,
  newLtvAfterTopUp: number
): Promise<TierUpgradeInfo | null> {
  const newTier = getTierByLtv(newLtvAfterTopUp);
  if (newTier === "bronze") return null;
  const key = `${TIER_LAST_KEY}${userId}`;
  const last = await getOffer(key);
  const prevTier: UserTier = last === "silver" || last === "gold" || last === "platinum" ? last : "bronze";
  const tierOrder: UserTier[] = ["bronze", "silver", "gold", "platinum"];
  const prevIdx = tierOrder.indexOf(prevTier);
  const newIdx = tierOrder.indexOf(newTier);
  if (newIdx <= prevIdx) return null;
  await setOffer(key, newTier, 365 * 24 * 60 * 60);
  return {
    message: TIER_MESSAGES[newTier],
    newTier,
    previousTier: prevTier,
    cumulativeDeposit: newLtvAfterTopUp,
  };
}

/**
 * Check if user just crossed into a new tier after this top-up. If so, return message to send.
 */
export async function getTierUpgradeMessage(
  dataSource: DataSource,
  userId: number,
  newLtvAfterTopUp: number
): Promise<string | null> {
  const info = await getTierUpgradeInfo(dataSource, userId, newLtvAfterTopUp);
  return info?.message ?? null;
}
