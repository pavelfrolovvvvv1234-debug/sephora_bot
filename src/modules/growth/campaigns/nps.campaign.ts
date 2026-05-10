/**
 * NPS: 14 days after first VDS activation → «Оцените сервис от 1 до 5.» If 4–5 → «Спасибо. Реферальная программа / апгрейд / годовая скидка -10%.»
 * Stub: requires conversation flow for rating and follow-up; can be triggered from cron (find users with VDS created 14 days ago).
 *
 * @module modules/growth/campaigns/nps.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const NPS_DAYS_AFTER_VDS = 14;
const NPS_SENT_KEY = "growth_nps_sent:";
const NPS_COOLDOWN_SEC = 365 * 24 * 60 * 60; // 1 year per user
const MESSAGE_REQUEST = "Оцените сервис от 1 до 5.";
const MESSAGE_FOLLOWUP = "Спасибо. Реферальная программа и годовая скидка -10% — в боте.";

/**
 * Find users whose first VDS was created exactly ~14 days ago; send NPS request if not sent yet.
 * Follow-up (4–5) would be in a separate conversation handler when user replies with rating.
 */
export async function runNpsCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 200
): Promise<number> {
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const userRepo = dataSource.getRepository(User);
  const from = new Date(Date.now() - (NPS_DAYS_AFTER_VDS + 1) * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() - NPS_DAYS_AFTER_VDS * 24 * 60 * 60 * 1000);
  const firstVds = await vdsRepo
    .createQueryBuilder("v")
    .select("MIN(v.createdAt)", "firstAt")
    .addSelect("v.targetUserId", "userId")
    .groupBy("v.targetUserId")
    .getRawMany<{ userId: number; firstAt: Date }>();
  let sent = 0;
  for (const row of firstVds.slice(0, limit)) {
    const firstAt = row.firstAt instanceof Date ? row.firstAt : new Date(row.firstAt);
    if (firstAt < from || firstAt > to) continue;
    try {
      const key = `${NPS_SENT_KEY}${row.userId}`;
      if (await getOffer(key)) continue;
      if (!(await canSendCommercialPush(row.userId))) continue;
      const user = await userRepo.findOne({ where: { id: row.userId }, select: ["telegramId"] });
      if (!user?.telegramId) continue;
      await sendMessage(user.telegramId, MESSAGE_REQUEST);
      await setOffer(key, "1", NPS_COOLDOWN_SEC);
      await markCommercialPushSent(row.userId);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] NPS for user ${row.userId} failed`, e);
    }
  }
  return sent;
}

export function getNpsFollowupMessage(): string {
  return MESSAGE_FOLLOWUP;
}
