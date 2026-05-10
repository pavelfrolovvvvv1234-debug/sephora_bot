/**
 * Offer engine: eligibility and rate limit (max 1 growth offer per 24h;
 * global max 1 commercial push per 72h for all campaigns).
 *
 * @module modules/growth/offer.engine
 */

import { getOffer, setOffer } from "./storage.js";

const LAST_OFFER_KEY = "growth_last_offer:";
const OFFER_COOLDOWN_SEC = 24 * 60 * 60; // 24h

/** Global anti-spam: max 1 commercial campaign message per 72h per user. */
const LAST_COMMERCIAL_KEY = "growth_last_commercial:";
export const COMMERCIAL_PUSH_COOLDOWN_SEC = 72 * 60 * 60; // 72h

export class OfferEngine {
  /**
   * Returns true if we can show a growth offer to this user (no offer in last 24h).
   */
  async canShowOffer(userId: number): Promise<boolean> {
    const key = `${LAST_OFFER_KEY}${userId}`;
    const last = await getOffer(key);
    if (!last) return true;
    const ts = parseInt(last, 10);
    return Number.isNaN(ts) || Date.now() - ts * 1000 >= OFFER_COOLDOWN_SEC * 1000;
  }

  /**
   * Mark that we showed an offer (call after sending upsell/reactivation message).
   */
  async markOfferShown(userId: number): Promise<void> {
    const key = `${LAST_OFFER_KEY}${userId}`;
    await setOffer(key, String(Math.floor(Date.now() / 1000)), OFFER_COOLDOWN_SEC);
  }

  /**
   * Returns true if we can send a commercial campaign push (no such push in last 72h).
   */
  async canSendCommercialPush(userId: number): Promise<boolean> {
    const key = `${LAST_COMMERCIAL_KEY}${userId}`;
    const last = await getOffer(key);
    if (!last) return true;
    const ts = parseInt(last, 10);
    return Number.isNaN(ts) || Date.now() - ts * 1000 >= COMMERCIAL_PUSH_COOLDOWN_SEC * 1000;
  }

  /**
   * Mark that we sent a commercial push (call after sending any campaign message).
   */
  async markCommercialPushSent(userId: number): Promise<void> {
    const key = `${LAST_COMMERCIAL_KEY}${userId}`;
    await setOffer(key, String(Math.floor(Date.now() / 1000)), COMMERCIAL_PUSH_COOLDOWN_SEC);
  }
}
