/**
 * Trigger: expiration → "Продлите сейчас и получите 5% бонус". Discount TTL 72h.
 *
 * @module modules/growth/trigger.engine
 */

import { setOffer, getOffer, deleteOffer } from "./storage.js";
import type { TriggerDiscountOffer } from "./types.js";
import type { DataSource } from "typeorm";
import User from "../../entities/User.js";
import GrowthEvent from "../../entities/GrowthEvent.js";

const TRIGGER_PREFIX = "trigger_discount:";
const TRIGGER_TTL_SEC = 72 * 60 * 60; // 72h
const BONUS_PERCENT = 5;

export class TriggerEngine {
  constructor(private dataSource: DataSource) {}

  /**
   * Call when service has <= 3 days left. Creates discount offer for user.
   */
  async handleServiceExpiration(
    userId: number,
    serviceId: number,
    serviceType: "vds" | "dedicated" | "domain"
  ): Promise<void> {
    const key = `${TRIGGER_PREFIX}${userId}`;
    const offer: TriggerDiscountOffer = {
      bonusPercent: BONUS_PERCENT,
      expiresAt: Math.floor(Date.now() / 1000) + TRIGGER_TTL_SEC,
      serviceId,
      serviceType,
    };
    await setOffer(key, JSON.stringify(offer), TRIGGER_TTL_SEC);
  }

  async getActiveDiscount(userId: number): Promise<TriggerDiscountOffer | null> {
    const raw = await getOffer(`${TRIGGER_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      const offer = JSON.parse(raw) as TriggerDiscountOffer;
      if (offer.expiresAt <= Math.floor(Date.now() / 1000)) {
        await deleteOffer(`${TRIGGER_PREFIX}${userId}`);
        return null;
      }
      return offer;
    } catch {
      return null;
    }
  }

  /**
   * On renewal: apply discount and record event.
   */
  async applyDiscount(
    userId: number,
    amount: number
  ): Promise<{ applied: boolean; discountAmount: number }> {
    const offer = await this.getActiveDiscount(userId);
    if (!offer) return { applied: false, discountAmount: 0 };
    const discountAmount = Math.round((amount * (offer.bonusPercent / 100)) * 100) / 100;
    if (discountAmount <= 0) return { applied: false, discountAmount: 0 };

    await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const eventRepo = manager.getRepository(GrowthEvent);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) return;
      user.balance += discountAmount;
      await userRepo.save(user);
      const ev = new GrowthEvent();
      ev.userId = userId;
      ev.type = "trigger";
      ev.amount = discountAmount;
      await eventRepo.save(ev);
    });

    await deleteOffer(`${TRIGGER_PREFIX}${userId}`);
    return { applied: true, discountAmount };
  }
}
