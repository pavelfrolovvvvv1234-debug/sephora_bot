/**
 * Referral push: after deposit >= $X, send «Поделитесь реферальной ссылкой. За первый депозит реферала — +10% на ваш баланс.»
 * Called from payment flow (no cron). Optional: 72h boost after own deposit.
 *
 * @module modules/growth/campaigns/referral-push.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import User from "../../../entities/User.js";
const REFERRAL_PUSH_MIN_AMOUNT = 20; // $X
const REFERRAL_PUSH_COOLDOWN_KEY = "growth_referral_push:";
const REFERRAL_PUSH_COOLDOWN_SEC = 30 * 24 * 60 * 60; // 30 days
const MESSAGE =
  "Поделитесь реферальной ссылкой. За первый депозит реферала — +10% на ваш баланс.";

/**
 * If user just topped up >= REFERRAL_PUSH_MIN_AMOUNT and we haven't sent this in cooldown, return message.
 * Caller sends message and then markReferralPushSent(userId).
 */
export async function shouldSendReferralPush(
  dataSource: DataSource,
  userId: number,
  amount: number
): Promise<boolean> {
  if (amount < REFERRAL_PUSH_MIN_AMOUNT) return false;
  const key = `${REFERRAL_PUSH_COOLDOWN_KEY}${userId}`;
  const last = await getOffer(key);
  if (last) {
    const ts = parseInt(last, 10);
    if (!Number.isNaN(ts) && Date.now() - ts * 1000 < REFERRAL_PUSH_COOLDOWN_SEC * 1000) return false;
  }
  return true;
}

export function getReferralPushMessage(): string {
  return MESSAGE;
}

export async function markReferralPushSent(userId: number): Promise<void> {
  const key = `${REFERRAL_PUSH_COOLDOWN_KEY}${userId}`;
  await setOffer(key, String(Math.floor(Date.now() / 1000)), REFERRAL_PUSH_COOLDOWN_SEC);
}
