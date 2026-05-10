/**
 * Auto-push on server/incident: technical notification + «Рекомендуем подключить мониторинг + авто-ребут. Бесплатно 7 дней.»
 * Called from incident/monitoring webhook (stub: no webhook wired yet).
 *
 * @module modules/growth/campaigns/incident-upsell.campaign
 */

import type { DataSource } from "typeorm";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const MESSAGE =
  "Рекомендуем подключить мониторинг + авто-ребут. Бесплатно 7 дней.";

/**
 * Call when incident webhook fires for a VDS. Send technical notice (caller) + this upsell if user hasn't had commercial push in 72h.
 */
export async function sendIncidentUpsell(
  dataSource: DataSource,
  userId: number,
  sendMessage: (telegramId: number, text: string) => Promise<void>
): Promise<boolean> {
  try {
    if (!(await canSendCommercialPush(userId))) return false;
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId }, select: ["telegramId"] });
    if (!user?.telegramId) return false;
    await sendMessage(user.telegramId, MESSAGE);
    await markCommercialPushSent(userId);
    return true;
  } catch (e) {
    Logger.error(`[Growth] Incident upsell for user ${userId} failed`, e);
    return false;
  }
}
