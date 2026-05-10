/**
 * Growth campaigns: usage, winback, scarcity, cross-sell, tier, referral, grace, large-deposit,
 * NPS, LTV, incident, anniversary, B2B. Run from cron or payment/expiration.
 *
 * @module modules/growth/campaigns
 */

export { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
export { runUsageUpsellCampaign, getUsageOverThreshold } from "./usage-upsell.campaign.js";
export { runWinBackCampaign } from "./winback.campaign.js";
export { runScarcityCampaign } from "./scarcity.campaign.js";
export { runCrossSellCampaign } from "./cross-sell.campaign.js";
export {
  getCumulativeDeposit,
  getTierUpgradeMessage,
} from "./tier.campaign.js";
export {
  shouldSendReferralPush,
  getReferralPushMessage,
  markReferralPushSent,
} from "./referral-push.campaign.js";
export { maybeSendGraceDay2OrDay3 } from "./grace-retarget.campaign.js";
export { handleLargeDeposit } from "./large-deposit.campaign.js";
export { runAnniversaryCampaign } from "./anniversary.campaign.js";
export { runB2BDedicatedCampaign } from "./b2b-dedicated.campaign.js";
export { runBehavioralUpsellCampaign } from "./behavioral.campaign.js";
export { runAntiChurnCampaign } from "./anti-churn.campaign.js";
export { runNpsCampaign, getNpsFollowupMessage } from "./nps.campaign.js";
export {
  getLtvSegment,
  getBonusPercentForSegment,
  VIP_PRIVILEGE_MESSAGE,
} from "./ltv-bonus.campaign.js";
export { sendIncidentUpsell } from "./incident-upsell.campaign.js";

import type { DataSource } from "typeorm";
import { runUsageUpsellCampaign } from "./usage-upsell.campaign.js";
import { runWinBackCampaign } from "./winback.campaign.js";
import { runScarcityCampaign } from "./scarcity.campaign.js";
import { runCrossSellCampaign } from "./cross-sell.campaign.js";
import { runAnniversaryCampaign } from "./anniversary.campaign.js";
import { runB2BDedicatedCampaign } from "./b2b-dedicated.campaign.js";
import { runBehavioralUpsellCampaign } from "./behavioral.campaign.js";
import { runAntiChurnCampaign } from "./anti-churn.campaign.js";
import { runNpsCampaign } from "./nps.campaign.js";
import { Logger } from "../../../app/logger.js";

export type SendMessageFn = (telegramId: number, text: string) => Promise<void>;

/**
 * Run all cron-based campaigns (daily). Respects 72h commercial push limit per user.
 * Order: winback, scarcity, cross-sell, anniversary, B2B, usage (stub), behavioral (stub), anti-churn (stub), NPS.
 */
export async function runAllCampaignsCron(
  dataSource: DataSource,
  sendMessage: SendMessageFn
): Promise<{ [campaign: string]: number }> {
  const results: { [campaign: string]: number } = {};
  try {
    results.winback = await runWinBackCampaign(dataSource, sendMessage);
    results.scarcity = await runScarcityCampaign(dataSource, sendMessage);
    results.crossSell = await runCrossSellCampaign(dataSource, sendMessage);
    results.anniversary = await runAnniversaryCampaign(dataSource, sendMessage);
    results.b2b = await runB2BDedicatedCampaign(dataSource, sendMessage);
    results.usageUpsell = await runUsageUpsellCampaign(dataSource, sendMessage);
    results.behavioral = await runBehavioralUpsellCampaign(dataSource, sendMessage);
    results.antiChurn = await runAntiChurnCampaign(dataSource, sendMessage);
    results.nps = await runNpsCampaign(dataSource, sendMessage);
  } catch (e) {
    Logger.error("[Growth] runAllCampaignsCron error", e);
  }
  return results;
}
