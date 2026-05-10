/**
 * Create and apply offer instances (auto_apply or claim).
 *
 * @module modules/automations/engine/offer-service
 */

import type { DataSource } from "typeorm";
import type { OfferConfig } from "../schemas/scenario-config.schema.js";
import OfferInstance from "../../../entities/automations/OfferInstance.js";
import User from "../../../entities/User.js";

export async function createOfferInstance(
  dataSource: DataSource,
  params: {
    userId: number;
    scenarioKey: string;
    stepId: string | null;
    offerKey: string;
    type: string;
    value: number;
    ttlHours: number;
  }
): Promise<OfferInstance> {
  const repo = dataSource.getRepository(OfferInstance);
  const expiresAt = new Date(Date.now() + params.ttlHours * 60 * 60 * 1000);
  const row = repo.create({
    userId: params.userId,
    scenarioKey: params.scenarioKey,
    stepId: params.stepId,
    offerKey: params.offerKey,
    type: params.type,
    value: params.value,
    expiresAt,
    status: "active",
  });
  return repo.save(row);
}

export async function getActiveOffer(
  dataSource: DataSource,
  userId: number,
  scenarioKey: string,
  offerKey?: string
): Promise<OfferInstance | null> {
  const repo = dataSource.getRepository(OfferInstance);
  const qb = repo
    .createQueryBuilder("o")
    .where("o.userId = :userId", { userId })
    .andWhere("o.scenarioKey = :scenarioKey", { scenarioKey })
    .andWhere("o.status = :status", { status: "active" })
    .andWhere("o.expiresAt > :now", { now: new Date() });
  if (offerKey) qb.andWhere("o.offerKey = :offerKey", { offerKey });
  return qb.orderBy("o.expiresAt", "DESC").getOne();
}

export async function applyOfferToBalance(
  dataSource: DataSource,
  offerId: number,
  amount: number
): Promise<{ applied: boolean; bonusAmount: number }> {
  const repo = dataSource.getRepository(OfferInstance);
  const userRepo = dataSource.getRepository(User);
  const offer = await repo.findOne({ where: { id: offerId } });
  if (!offer || offer.status !== "active" || new Date(offer.expiresAt) <= new Date()) {
    return { applied: false, bonusAmount: 0 };
  }
  const bonusAmount = Math.round((amount * (offer.value / 100)) * 100) / 100;
  if (bonusAmount <= 0) return { applied: false, bonusAmount: 0 };
  await dataSource.transaction(async (manager) => {
    const u = await manager.getRepository(User).findOne({ where: { id: offer.userId } });
    if (!u) return;
    u.balance += bonusAmount;
    await manager.getRepository(User).save(u);
    offer.status = "applied";
    offer.appliedAt = new Date();
    await manager.getRepository(OfferInstance).save(offer);
  });
  return { applied: true, bonusAmount };
}
