/**
 * Wrapper: check global 72h commercial push limit before sending campaign message.
 *
 * @module modules/growth/campaigns/commercial-limiter
 */

import { OfferEngine } from "../offer.engine.js";
import { isTelegramOptedOutOfSephoraBroadcasts } from "../../../shared/broadcast-opt-out.js";

const offerEngine = new OfferEngine();

export async function canSendCommercialPush(userId: number, telegramId?: number): Promise<boolean> {
  if (telegramId != null && isTelegramOptedOutOfSephoraBroadcasts(telegramId)) return false;
  return offerEngine.canSendCommercialPush(userId);
}

export async function markCommercialPushSent(userId: number): Promise<void> {
  return offerEngine.markCommercialPushSent(userId);
}
