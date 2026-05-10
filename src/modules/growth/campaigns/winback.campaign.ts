/**
 * Win-back: balance > $X, no active services for 7 days.
 * Message: «У вас $X на балансе. Запустите VDS сегодня — +5% к сроку.»
 * Cooldown: via global 72h.
 *
 * @module modules/growth/campaigns/winback.campaign
 */

import type { DataSource } from "typeorm";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import DedicatedServer from "../../../entities/DedicatedServer.js";
import Domain from "../../../entities/Domain.js";
import { Logger } from "../../../app/logger.js";

const WINBACK_MIN_BALANCE = 10; // $X
const NO_SERVICES_DAYS = 7;

function formatMessage(balance: number): string {
  return `У вас ${balance.toFixed(0)} $ на балансе. Запустите VDS сегодня — +5% к сроку.`;
}

/**
 * Find users: balance >= WINBACK_MIN_BALANCE, no VDS/dedicated/domain activity in last 7 days.
 * "No activity" = no active VDS, no dedicated, and no domain renewed/created in 7 days (simplified: no VDS/dedicated).
 */
export async function runWinBackCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 200
): Promise<number> {
  const userRepo = dataSource.getRepository(User);
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const dediRepo = dataSource.getRepository(DedicatedServer);
  const domainRepo = dataSource.getRepository(Domain);
  const cutoff = new Date(Date.now() - NO_SERVICES_DAYS * 24 * 60 * 60 * 1000);

  const users = await userRepo
    .createQueryBuilder("u")
    .where("u.balance >= :minBal", { minBal: WINBACK_MIN_BALANCE })
    .andWhere("u.isBanned = 0")
    .select(["u.id", "u.telegramId", "u.balance"])
    .take(limit)
    .getMany();

  let sent = 0;
  for (const u of users) {
    try {
      const hasVds = await vdsRepo
        .createQueryBuilder("v")
        .where("v.targetUserId = :uid", { uid: u.id })
        .andWhere("v.expireAt > :now", { now: new Date() })
        .getOne();
      if (hasVds) continue;
      const hasDedi = await dediRepo.findOne({ where: { userId: u.id }, select: ["id"] });
      if (hasDedi) continue;
      const hasRecentDomain = await domainRepo
        .createQueryBuilder("d")
        .where("d.userId = :uid", { uid: u.id })
        .andWhere("d.updatedAt >= :cutoff", { cutoff })
        .getOne();
      if (hasRecentDomain) continue;
      if (!(await canSendCommercialPush(u.id))) continue;
      await sendMessage(u.telegramId, formatMessage(u.balance));
      await markCommercialPushSent(u.id);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] Win-back for user ${u.id} failed`, e);
    }
  }
  return sent;
}
