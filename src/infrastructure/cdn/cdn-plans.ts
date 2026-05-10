/**
 * CDN product tiers — prices and ids stored in the bot (USD / month per site).
 * Display names in Fluent (cdn-plan-*-name, cdn-card-*-body). Internal ids: standard | bulletproof | bundle.
 */

export const CDN_PLAN_IDS = ["standard", "bulletproof", "bundle"] as const;

export type CdnPlanId = (typeof CDN_PLAN_IDS)[number];

export interface CdnPlanDef {
  id: CdnPlanId;
  /** Charged from user balance (same currency as other CDN copy: USD). */
  priceUsd: number;
  /** Fluent key for short plan title (confirm, API description). */
  labelKey: string;
}

export const CDN_PLANS: Record<CdnPlanId, CdnPlanDef> = {
  standard: { id: "standard", priceUsd: 25, labelKey: "cdn-plan-standard-name" },
  bulletproof: { id: "bulletproof", priceUsd: 49, labelKey: "cdn-plan-bulletproof-name" },
  bundle: { id: "bundle", priceUsd: 169, labelKey: "cdn-plan-bundle-name" },
};

export function parseCdnPlanId(raw: string): CdnPlanId | null {
  const s = raw.trim();
  return CDN_PLAN_IDS.includes(s as CdnPlanId) ? (s as CdnPlanId) : null;
}

export function getCdnPlan(id: CdnPlanId): CdnPlanDef {
  return CDN_PLANS[id];
}
