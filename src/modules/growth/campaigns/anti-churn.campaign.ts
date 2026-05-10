/**
 * Anti-churn: was active 60+ days, then traffic/logins dropped.
 * Message: «Видим снижение активности. Предлагаем оптимизацию тарифа или перенос на более выгодный план.»
 * Stub: needs traffic / login metrics.
 *
 * @module modules/growth/campaigns/anti-churn.campaign
 */

import type { DataSource } from "typeorm";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
const MESSAGE =
  "Видим снижение активности. Предлагаем оптимизацию тарифа или перенос на более выгодный план.";

/**
 * Stub: would need VDS age 60+ days and recent traffic drop from monitoring.
 */
export async function runAntiChurnCampaign(
  _dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  _limit: number = 100
): Promise<number> {
  // TODO: segment: active VDS 60+ days, traffic or login count dropped vs previous period
  return 0;
}
