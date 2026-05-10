/**
 * Growth service: orchestrates upsell, reactivation, trigger. Called from payment and expiration.
 *
 * @module modules/growth/growth.service
 */

import type { DataSource } from "typeorm";
import { UpsellService } from "./upsell.service.js";
import { ReactivationService } from "./reactivation.service.js";
import { TriggerEngine } from "./trigger.engine.js";
import { OfferEngine } from "./offer.engine.js";
import GrowthEvent, { GrowthEventType } from "../../entities/GrowthEvent.js";
import { Logger } from "../../app/logger.js";

export interface GrowthHandleTopUpResult {
  upsellOfferCreated: boolean;
  upsellBonusApplied: number;
  reactivationBonusApplied: number;
  messageOffer?: string; // e.g. "Пополните ещё $50 и получите +10%"
}

export class GrowthService {
  private upsell: UpsellService;
  private reactivation: ReactivationService;
  private trigger: TriggerEngine;
  private offerEngine: OfferEngine;

  constructor(private dataSource: DataSource) {
    this.upsell = new UpsellService(dataSource);
    this.reactivation = new ReactivationService(dataSource);
    this.trigger = new TriggerEngine(dataSource);
    this.offerEngine = new OfferEngine();
  }

  /**
   * Call after confirmed top-up. Idempotent per topUpId (bonus applied only once).
   */
  async handleTopUpSuccess(
    userId: number,
    topUpId: number,
    amount: number
  ): Promise<GrowthHandleTopUpResult> {
    const result: GrowthHandleTopUpResult = {
      upsellOfferCreated: false,
      upsellBonusApplied: 0,
      reactivationBonusApplied: 0,
    };

    try {
      // 1) Try to apply active upsell bonus (from previous offer)
      const upsellResult = await this.upsell.tryApplyBonus(userId, topUpId, amount);
      if (upsellResult.applied) {
        result.upsellBonusApplied = upsellResult.bonusAmount;
        return result;
      }

      // 2) Try to apply reactivation bonus (first top-up after reactivation offer)
      const reactResult = await this.reactivation.tryApplyBonus(userId, amount);
      if (reactResult.applied) {
        result.reactivationBonusApplied = reactResult.bonusAmount;
        return result;
      }

      // 3) Maybe create new upsell offer: amount >= 50 and no offer in 24h
      const canShow = await this.offerEngine.canShowOffer(userId);
      if (canShow && amount >= 50) {
        const created = await this.upsell.maybeCreateOffer(userId, amount);
        if (created) {
          result.upsellOfferCreated = true;
          await this.offerEngine.markOfferShown(userId);
          result.messageOffer = "Пополните ещё $50 и получите +10% бонуса";
        }
      }
    } catch (e) {
      Logger.error("[Growth] handleTopUpSuccess error", e);
    }
    return result;
  }

  getUpsellService(): UpsellService {
    return this.upsell;
  }

  getReactivationService(): ReactivationService {
    return this.reactivation;
  }

  getTriggerEngine(): TriggerEngine {
    return this.trigger;
  }

  getOfferEngine(): OfferEngine {
    return this.offerEngine;
  }

  async recordEvent(userId: number, type: GrowthEventType, amount: number): Promise<void> {
    const repo = this.dataSource.getRepository(GrowthEvent);
    const ev = new GrowthEvent();
    ev.userId = userId;
    ev.type = type;
    ev.amount = amount;
    await repo.save(ev);
  }

  // --- Metrics ---
  async getUpsellConversionRate(sinceDays: number = 30): Promise<number> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const repo = this.dataSource.getRepository(GrowthEvent);
    const total = await repo.count({ where: { type: "upsell" } });
    const withAmount = await repo
      .createQueryBuilder("e")
      .where("e.type = :type", { type: "upsell" })
      .andWhere("e.createdAt >= :since", { since })
      .andWhere("e.amount > 0")
      .getCount();
    return total > 0 ? withAmount / total : 0;
  }

  async getReactivationConversionRate(sinceDays: number = 30): Promise<number> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const repo = this.dataSource.getRepository(GrowthEvent);
    const total = await repo.count({ where: { type: "reactivation" } });
    const withAmount = await repo
      .createQueryBuilder("e")
      .where("e.type = :type", { type: "reactivation" })
      .andWhere("e.createdAt >= :since", { since })
      .andWhere("e.amount > 0")
      .getCount();
    return total > 0 ? withAmount / total : 0;
  }

  async getAverageDepositBeforeAfter(sinceDays: number = 30): Promise<{ before: number; after: number }> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const repo = this.dataSource.getRepository(GrowthEvent);
    const events = await repo.find({
      where: { type: "upsell" },
      order: { createdAt: "ASC" },
    });
    // Simplified: before = avg of first topups, after = avg when bonus applied
    const withAmount = events.filter((e) => e.amount > 0);
    const after = withAmount.length ? withAmount.reduce((s, e) => s + e.amount, 0) / withAmount.length : 0;
    return { before: 0, after };
  }
}
