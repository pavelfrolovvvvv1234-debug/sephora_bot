/**
 * Scarcity: 1–2 days before end of month/quarter. +12% bonus to top-up until 23:59.
 * Message: «Закрываем месяц. +12% бонус к пополнению до 23:59.»
 * Cooldown: 1 per month per user.
 *
 * @module modules/growth/campaigns/scarcity.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const SCARCITY_COOLDOWN_KEY = "growth_scarcity:";
const SCARCITY_COOLDOWN_SEC = 30 * 24 * 60 * 60; // ~1 month
const MESSAGE = "Закрываем месяц. +12% бонус к пополнению до 23:59.";

function isLastDaysOfMonth(): boolean {
  const now = new Date();
  const day = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return day >= lastDay - 2 && day <= lastDay;
}

/**
 * Run scarcity campaign: send to all non-banned users if we're in last 1–2 days of month.
 * Each user gets at most 1 message per month.
 */
export async function runScarcityCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 5000
): Promise<number> {
  if (!isLastDaysOfMonth()) return 0;
  const userRepo = dataSource.getRepository(User);
  const users = await userRepo
    .createQueryBuilder("u")
    .where("u.isBanned = 0")
    .select(["u.id", "u.telegramId"])
    .take(limit)
    .getMany();
  let sent = 0;
  for (const u of users) {
    try {
      const key = `${SCARCITY_COOLDOWN_KEY}${u.id}`;
      const last = await getOffer(key);
      if (last) {
        const ts = parseInt(last, 10);
        if (!Number.isNaN(ts) && Date.now() - ts * 1000 < SCARCITY_COOLDOWN_SEC * 1000) continue;
      }
      if (!(await canSendCommercialPush(u.id))) continue;
      await sendMessage(u.telegramId, MESSAGE);
      await setOffer(key, String(Math.floor(Date.now() / 1000)), SCARCITY_COOLDOWN_SEC);
      await markCommercialPushSent(u.id);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] Scarcity for user ${u.id} failed`, e);
    }
  }
  return sent;
}
