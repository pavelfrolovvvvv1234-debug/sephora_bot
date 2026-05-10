/**
 * Birthday / Anniversary: 1 year since registration. «Год с нами. +15% к пополнению 48ч.»
 * Cooldown: 1 per user (once per year). Run daily cron.
 *
 * @module modules/growth/campaigns/anniversary.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const ANNIVERSARY_COOLDOWN_KEY = "growth_anniversary:";
const ANNIVERSARY_COOLDOWN_SEC = 365 * 24 * 60 * 60; // 1 year
const MESSAGE = "Год с нами. +15% к пополнению в течение 48ч.";
const REGISTRATION_DAYS_AGO_MIN = 365;
const REGISTRATION_DAYS_AGO_MAX = 375; // window to catch

/**
 * Find users who registered between 365 and 375 days ago and haven't received anniversary message this year.
 */
export async function runAnniversaryCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  limit: number = 500
): Promise<number> {
  const userRepo = dataSource.getRepository(User);
  const from = new Date(Date.now() - REGISTRATION_DAYS_AGO_MAX * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() - REGISTRATION_DAYS_AGO_MIN * 24 * 60 * 60 * 1000);
  const users = await userRepo
    .createQueryBuilder("u")
    .where("u.createdAt >= :from", { from })
    .andWhere("u.createdAt <= :to", { to })
    .andWhere("u.isBanned = 0")
    .select(["u.id", "u.telegramId"])
    .take(limit)
    .getMany();
  let sent = 0;
  for (const u of users) {
    try {
      const key = `${ANNIVERSARY_COOLDOWN_KEY}${u.id}`;
      const last = await getOffer(key);
      if (last) {
        const ts = parseInt(last, 10);
        if (!Number.isNaN(ts) && Date.now() - ts * 1000 < ANNIVERSARY_COOLDOWN_SEC * 1000) continue;
      }
      if (!(await canSendCommercialPush(u.id))) continue;
      await sendMessage(u.telegramId, MESSAGE);
      await setOffer(key, String(Math.floor(Date.now() / 1000)), ANNIVERSARY_COOLDOWN_SEC);
      await markCommercialPushSent(u.id);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] Anniversary for user ${u.id} failed`, e);
    }
  }
  return sent;
}
