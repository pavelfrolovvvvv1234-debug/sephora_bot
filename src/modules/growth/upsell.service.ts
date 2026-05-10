/**
 * Upsell: "Пополните ещё $50 и получите +10% бонуса". TTL 30 min, bonus on next top-up.
 *
 * @module modules/growth/upsell.service
 */

import type { DataSource } from "typeorm";
import { setOffer, getOffer, deleteOffer, acquireLock } from "./storage.js";
import type { UpsellOffer } from "./types.js";
import User from "../../entities/User.js";
import GrowthEvent from "../../entities/GrowthEvent.js";
import { Logger } from "../../app/logger.js";

const UPSELL_PREFIX = "upsell:";
const UPSELL_USED_PREFIX = "upsell_used:";
const UPSELL_TTL_SEC = 30 * 60; // 30 min
const UPSELL_COOLDOWN_SEC = 24 * 60 * 60; // 24h between offers
const MIN_TOPUP_FOR_OFFER = 50;
const BONUS_PERCENT = 10;
const REQUIRED_EXTRA = 50;

export class UpsellService {
  constructor(private dataSource: DataSource) {}

  /**
   * After successful top-up: if amount >= 50 and no upsell used in 24h, create offer.
   */
  async maybeCreateOffer(userId: number, amount: number): Promise<boolean> {
    if (amount < MIN_TOPUP_FOR_OFFER) return false;
    const usedKey = `${UPSELL_USED_PREFIX}${userId}`;
    const used = await getOffer(usedKey);
    if (used) return false; // already used upsell recently (or cooldown)

    const offer: UpsellOffer = {
      requiredAmount: REQUIRED_EXTRA,
      bonusPercent: BONUS_PERCENT,
      expiresAt: Math.floor(Date.now() / 1000) + UPSELL_TTL_SEC,
    };
    await setOffer(`${UPSELL_PREFIX}${userId}`, JSON.stringify(offer), UPSELL_TTL_SEC);
    Logger.info(`[Growth] Upsell offer created for user ${userId}`);
    return true;
  }

  /**
   * Get active upsell for user (if any).
   */
  async getActiveOffer(userId: number): Promise<UpsellOffer | null> {
    const raw = await getOffer(`${UPSELL_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      const offer = JSON.parse(raw) as UpsellOffer;
      if (offer.expiresAt <= Math.floor(Date.now() / 1000)) {
        await deleteOffer(`${UPSELL_PREFIX}${userId}`);
        return null;
      }
      return offer;
    } catch {
      return null;
    }
  }

  /**
   * On next top-up: if active upsell and amount >= required, apply bonus once and clear offer.
   */
  async tryApplyBonus(
    userId: number,
    topUpId: number,
    amount: number
  ): Promise<{ applied: boolean; bonusAmount: number }> {
    const offer = await this.getActiveOffer(userId);
    if (!offer || amount < offer.requiredAmount) {
      return { applied: false, bonusAmount: 0 };
    }

    const lockKey = `upsell_lock:${userId}:${topUpId}`;
    const acquired = await acquireLock(lockKey, 60);
    if (!acquired) return { applied: false, bonusAmount: 0 };

    const bonusAmount = Math.round((amount * (offer.bonusPercent / 100)) * 100) / 100;
    if (bonusAmount <= 0) return { applied: false, bonusAmount: 0 };

    await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const eventRepo = manager.getRepository(GrowthEvent);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) return;
      user.balance += bonusAmount;
      await userRepo.save(user);
      const ev = new GrowthEvent();
      ev.userId = userId;
      ev.type = "upsell";
      ev.amount = bonusAmount;
      await eventRepo.save(ev);
    });

    await deleteOffer(`${UPSELL_PREFIX}${userId}`);
    await setOffer(`${UPSELL_USED_PREFIX}${userId}`, "1", UPSELL_COOLDOWN_SEC);
    Logger.info(`[Growth] Upsell bonus applied for user ${userId}: +${bonusAmount}`);
    return { applied: true, bonusAmount };
  }
}
