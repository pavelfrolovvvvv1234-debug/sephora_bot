/**
 * Reactivation: users inactive 30d, no services, balance 0 → "Вернитесь и получите +15% к депозиту".
 *
 * @module modules/growth/reactivation.service
 */

import type { DataSource } from "typeorm";
import { setOffer, getOffer, deleteOffer } from "./storage.js";
import type { ReactivationOffer } from "./types.js";
import User from "../../entities/User.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DedicatedServer from "../../entities/DedicatedServer.js";
import { Logger } from "../../app/logger.js";

const REACTIVATION_PREFIX = "reactivation:";
const REACTIVATION_TTL_SEC = 48 * 60 * 60; // 48h
const BONUS_PERCENT = 15;
const INACTIVE_DAYS = 30;

export class ReactivationService {
  constructor(private dataSource: DataSource) {}

  /**
   * Find users: no login 30d (approximate via lastUpdateAt), balance 0, no active VDS/dedicated.
   */
  async findInactiveUsers(limit: number = 500): Promise<User[]> {
    const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);
    const userRepo = this.dataSource.getRepository(User);
    const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
    const dediRepo = this.dataSource.getRepository(DedicatedServer);

    const users = await userRepo
      .createQueryBuilder("u")
      .where("u.lastUpdateAt < :cutoff", { cutoff })
      .andWhere("u.balance = 0")
      .andWhere("u.isBanned = 0")
      .select(["u.id", "u.telegramId", "u.lang"])
      .take(limit)
      .getMany();

    const result: User[] = [];
    for (const u of users) {
      const hasVds = await vdsRepo.findOne({ where: { targetUserId: u.id }, select: ["id"] });
      const hasDedi = await dediRepo.findOne({ where: { userId: u.id }, select: ["id"] });
      if (!hasVds && !hasDedi) result.push(u);
    }
    return result;
  }

  /**
   * Create reactivation offer for user (call from cron).
   */
  async createOffer(userId: number): Promise<void> {
    const key = `${REACTIVATION_PREFIX}${userId}`;
    const existing = await getOffer(key);
    if (existing) return;
    const offer: ReactivationOffer = {
      bonusPercent: BONUS_PERCENT,
      expiresAt: Math.floor(Date.now() / 1000) + REACTIVATION_TTL_SEC,
    };
    await setOffer(key, JSON.stringify(offer), REACTIVATION_TTL_SEC);
    Logger.info(`[Growth] Reactivation offer created for user ${userId}`);
  }

  async getActiveOffer(userId: number): Promise<ReactivationOffer | null> {
    const raw = await getOffer(`${REACTIVATION_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      const offer = JSON.parse(raw) as ReactivationOffer;
      if (offer.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      return offer;
    } catch {
      return null;
    }
  }

  /**
   * On first top-up after reactivation: apply bonus once.
   */
  async tryApplyBonus(
    userId: number,
    amount: number
  ): Promise<{ applied: boolean; bonusAmount: number }> {
    const offer = await this.getActiveOffer(userId);
    if (!offer) return { applied: false, bonusAmount: 0 };
    const bonusAmount = Math.round((amount * (offer.bonusPercent / 100)) * 100) / 100;
    if (bonusAmount <= 0) return { applied: false, bonusAmount: 0 };

    const GrowthEvent = (await import("../../entities/GrowthEvent.js")).default;
    await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const eventRepo = manager.getRepository(GrowthEvent);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) return;
      user.balance += bonusAmount;
      await userRepo.save(user);
      const ev = new GrowthEvent();
      ev.userId = userId;
      ev.type = "reactivation";
      ev.amount = bonusAmount;
      await eventRepo.save(ev);
    });

    await deleteOffer(`${REACTIVATION_PREFIX}${userId}`);
    return { applied: true, bonusAmount };
  }
}
