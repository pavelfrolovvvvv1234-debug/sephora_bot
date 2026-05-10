/**
 * Cross-sell: has VDS but no domain / no backup / no extra IP.
 * Message: «Для стабильности проекта подключите резервный IP / бэкап-пакет. -7% 72 часа.»
 * Cooldown: global 72h.
 *
 * @module modules/growth/campaigns/cross-sell.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import Domain from "../../../entities/Domain.js";
import { Logger } from "../../../app/logger.js";

const CROSSSELL_COOLDOWN_KEY = "growth_cross_sell:";
const CROSSSELL_COOLDOWN_SEC = 14 * 24 * 60 * 60; // 14 days
const MESSAGE =
  "Для стабильности проекта подключите резервный IP / бэкап-пакет. -7% 72 часа.";

/**
 * Find users with at least one active VDS and no domain (or no backup — we only check domain for now).
 */
export async function runCrossSellCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 500
): Promise<number> {
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const userRepo = dataSource.getRepository(User);
  const domainRepo = dataSource.getRepository(Domain);
  const vdsList = await vdsRepo
    .createQueryBuilder("v")
    .where("v.expireAt > :now", { now: new Date() })
    .select("DISTINCT v.targetUserId", "userId")
    .getRawMany<{ userId: number }>();
  let sent = 0;
  for (const row of vdsList.slice(0, limit)) {
    const userId = row.userId;
    try {
      const hasDomain = await domainRepo.findOne({ where: { userId }, select: ["id"] });
      if (hasDomain) continue;
      const key = `${CROSSSELL_COOLDOWN_KEY}${userId}`;
      const last = await getOffer(key);
      if (last) {
        const ts = parseInt(last, 10);
        if (!Number.isNaN(ts) && Date.now() - ts * 1000 < CROSSSELL_COOLDOWN_SEC * 1000) continue;
      }
      if (!(await canSendCommercialPush(userId))) continue;
      const user = await userRepo.findOne({ where: { id: userId }, select: ["telegramId"] });
      if (!user?.telegramId) continue;
      await sendMessage(user.telegramId, MESSAGE);
      await setOffer(key, String(Math.floor(Date.now() / 1000)), CROSSSELL_COOLDOWN_SEC);
      await markCommercialPushSent(userId);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] Cross-sell for user ${userId} failed`, e);
    }
  }
  return sent;
}
