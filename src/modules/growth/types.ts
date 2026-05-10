/**
 * Shared types for Growth module.
 *
 * @module modules/growth/types
 */

export type GrowthEventType =
  | "upsell"
  | "bundle"
  | "fomo"
  | "reactivation"
  | "trigger"
  | "usage_upsell"
  | "winback"
  | "scarcity"
  | "cross_sell"
  | "tier"
  | "referral_push"
  | "large_deposit"
  | "nps"
  | "anniversary"
  | "b2b"
  | "grace_day2"
  | "grace_day3"
  | "incident_upsell";

export type UserSegment =
  | "active_vps"
  | "domain_only"
  | "inactive_30d"
  | "high_spender"
  | "new_user"
  | "vip_180d"
  | "active_30_180d"
  | "newbie_0_30d";

/** Tier by cumulative deposit (LTV). */
export type UserTier = "bronze" | "silver" | "gold" | "platinum";

export const TIER_THRESHOLDS: Record<UserTier, number> = {
  bronze: 0,
  silver: 500,
  gold: 2000,
  platinum: 5000,
};

/** LTV segment for dynamic bonus. */
export type LTVSegment = "newbie_0_30d" | "active_30_180d" | "vip_180d";

export interface UpsellOffer {
  requiredAmount: number;
  bonusPercent: number;
  expiresAt: number;
}

export interface ReactivationOffer {
  bonusPercent: number;
  expiresAt: number;
}

export interface TriggerDiscountOffer {
  bonusPercent: number;
  expiresAt: number;
  serviceId?: number;
  serviceType?: "vds" | "dedicated" | "domain";
}

export interface FomoState {
  remaining: number;
  expiresAt: number;
}
