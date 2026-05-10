/**
 * B2B-style upsell: 2+ VDS, deposit > $1000 → «Рассмотрите выделенный сервер. Выгода до 18%.»
 * Cooldown: global 72h + 14 days per user.
 *
 * @module modules/growth/campaigns/b2b-dedicated.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import TopUp, { TopUpStatus } from "../../../entities/TopUp.js";
import { Logger } from "../../../app/logger.js";

const B2B_COOLDOWN_KEY = "growth_b2b:";
const B2B_COOLDOWN_SEC = 14 * 24 * 60 * 60; // 14 days
const MIN_VDS_COUNT = 2;
const MIN_TOTAL_DEPOSIT = 1000;
const MESSAGE =
  "Рассмотрите выделенный сервер. Выгода до 18% по сравнению с текущими расходами.";

/**
 * Find users with 2+ active VDS and total completed top-ups > 1000.
 */
export async function runB2BDedicatedCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 200
): Promise<number> {
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const topUpRepo = dataSource.getRepository(TopUp);
  const userRepo = dataSource.getRepository(User);
  const vdsCounts = await vdsRepo
    .createQueryBuilder("v")
    .where("v.expireAt > :now", { now: new Date() })
    .select("v.targetUserId", "userId")
    .addSelect("COUNT(*)", "cnt")
    .groupBy("v.targetUserId")
    .having("COUNT(*) >= :min", { min: MIN_VDS_COUNT })
    .getRawMany<{ userId: number; cnt: string }>();
  let sent = 0;
  for (const row of vdsCounts.slice(0, limit)) {
    const userId = row.userId;
    try {
      const sumResult = await topUpRepo
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.amount), 0)", "total")
        .where("t.target_user_id = :uid", { uid: userId })
        .andWhere("t.status = :status", { status: TopUpStatus.Completed })
        .getRawOne<{ total: string }>();
      const total = Number(sumResult?.total ?? 0);
      if (total < MIN_TOTAL_DEPOSIT) continue;
      const key = `${B2B_COOLDOWN_KEY}${userId}`;
      const last = await getOffer(key);
      if (last) {
        const ts = parseInt(last, 10);
        if (!Number.isNaN(ts) && Date.now() - ts * 1000 < B2B_COOLDOWN_SEC * 1000) continue;
      }
      if (!(await canSendCommercialPush(userId))) continue;
      const user = await userRepo.findOne({ where: { id: userId }, select: ["telegramId"] });
      if (!user?.telegramId) continue;
      await sendMessage(user.telegramId, MESSAGE);
      await setOffer(key, String(Math.floor(Date.now() / 1000)), B2B_COOLDOWN_SEC);
      await markCommercialPushSent(userId);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] B2B dedicated for user ${userId} failed`, e);
    }
  }
  return sent;
}
