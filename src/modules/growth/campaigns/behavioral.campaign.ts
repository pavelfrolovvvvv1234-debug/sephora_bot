/**
 * Behavioral upsell: 3+ "panel logins" or bot sessions in 24h.
 * Message: «Вижу активную работу. Нужны snapshot/backup/доп IP? Подключите за 1 клик.»
 * Stub: panel logins are not available; could use bot interaction count per 24h when tracked.
 *
 * @module modules/growth/campaigns/behavioral.campaign
 */

import type { DataSource } from "typeorm";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
const MESSAGE =
  "Вижу активную работу. Нужны snapshot/backup/доп IP? Подключите за 1 клик.";

/**
 * Stub: would need last N "sessions" or panel API. Returns empty list until we have activity source.
 */
export async function runBehavioralUpsellCampaign(
  _dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  _limit: number = 100
): Promise<number> {
  // TODO: get user IDs with 3+ interactions in last 24h (e.g. from User.lastUpdateAt spread or panel API)
  return 0;
}
