/**
 * Auto-offer on large deposit: deposit >= $300 → «Спасибо за крупное пополнение. Хотите закрепить бонус +3% навсегда? Пополните ещё $200 в течение 24ч.»
 * Create 24h offer; if they top up again within 24h we can apply permanent +3% (stored in user or offer). Effect: lock-in big depositor.
 *
 * @module modules/growth/campaigns/large-deposit.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer, deleteOffer } from "../storage.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const LARGE_DEPOSIT_THRESHOLD = 300;
const LARGE_DEPOSIT_FOLLOW_AMOUNT = 200;
const LARGE_DEPOSIT_TTL_SEC = 24 * 60 * 60; // 24h
const LARGE_DEPOSIT_OFFER_KEY = "growth_large_deposit_offer:";
const MESSAGE =
  "Спасибо за крупное пополнение. Хотите закрепить бонус +3% навсегда? Пополните ещё $200 в течение 24ч.";

export interface LargeDepositResult {
  shouldSendMessage: boolean;
  message: string;
  offerCreated: boolean;
}

/**
 * After top-up: if amount >= 300, create 24h offer and return message to send.
 * If user already had offer and now tops up >= 200, apply "permanent +3%" (e.g. store in user.referralPercent or separate field) and clear offer.
 */
export async function handleLargeDeposit(
  dataSource: DataSource,
  userId: number,
  amount: number
): Promise<LargeDepositResult> {
  const key = `${LARGE_DEPOSIT_OFFER_KEY}${userId}`;
  const existing = await getOffer(key);
  if (existing) {
    const parsed = JSON.parse(existing) as { expiresAt: number };
    if (parsed.expiresAt > Date.now() / 1000 && amount >= LARGE_DEPOSIT_FOLLOW_AMOUNT) {
      await deleteOffer(key);
      // TODO: apply permanent +3% to user (e.g. tier bonus or custom field)
      return { shouldSendMessage: false, message: "", offerCreated: false };
    }
  }
  if (amount >= LARGE_DEPOSIT_THRESHOLD) {
    const offer = { expiresAt: Math.floor(Date.now() / 1000) + LARGE_DEPOSIT_TTL_SEC };
    await setOffer(key, JSON.stringify(offer), LARGE_DEPOSIT_TTL_SEC);
    return { shouldSendMessage: true, message: MESSAGE, offerCreated: true };
  }
  return { shouldSendMessage: false, message: "", offerCreated: false };
}
