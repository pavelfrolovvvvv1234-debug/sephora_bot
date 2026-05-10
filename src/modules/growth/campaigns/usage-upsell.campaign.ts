/**
 * Usage-based upsell: CPU > 70%, RAM > 80%, disk > 85%, I/O throttling, 90% traffic.
 * Message: «Нагрузка на VDS близка к лимиту. Апгрейд до тарифа X — +40% ресурсов... Скидка 10% на 48ч.»
 * Cooldown: 1/7 days per user.
 *
 * @module modules/growth/campaigns/usage-upsell.campaign
 */

import type { DataSource } from "typeorm";
import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import User from "../../../entities/User.js";
import { Logger } from "../../../app/logger.js";

const USAGE_COOLDOWN_KEY = "growth_usage_upsell:";
const USAGE_COOLDOWN_SEC = 7 * 24 * 60 * 60; // 7 days
const MESSAGE =
  "Нагрузка на VDS близка к лимиту. Апгрейд до тарифа выше — +40% ресурсов, без даунтайма. Скидка 10% на 48ч.";

/** Placeholder: fetch metrics from panel/hypervisor API. Return true if any threshold exceeded. */
export async function getUsageOverThreshold(_vdsId: number): Promise<{ over: boolean; nextTariff?: string }> {
  // TODO: integrate VMManager or external metrics (CPU > 70%, RAM > 80%, disk > 85%, I/O throttling, 90% traffic)
  return { over: false };
}

export interface UsageUpsellRecipient {
  userId: number;
  telegramId: number;
  vdsId: number;
  nextTariff?: string;
}

/**
 * Find users with VDS that have usage over threshold. Respect 7-day cooldown and 72h global limit.
 */
export async function runUsageUpsellCampaign(
  dataSource: DataSource,
  sendMessage: (telegramId: number, text: string) => Promise<void>
): Promise<number> {
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const userRepo = dataSource.getRepository(User);
  const vdsList = await vdsRepo.find({ select: ["id", "vdsId", "targetUserId"], where: {} });
  let sent = 0;
  for (const vds of vdsList) {
    try {
      const lastKey = `${USAGE_COOLDOWN_KEY}${vds.targetUserId}`;
      const last = await getOffer(lastKey);
      if (last) {
        const ts = parseInt(last, 10);
        if (!Number.isNaN(ts) && Date.now() - ts * 1000 < USAGE_COOLDOWN_SEC * 1000) continue;
      }
      const metrics = await getUsageOverThreshold(vds.vdsId);
      if (!metrics.over) continue;
      const canSend = await canSendCommercialPush(vds.targetUserId);
      if (!canSend) continue;
      const user = await userRepo.findOne({ where: { id: vds.targetUserId }, select: ["telegramId"] });
      if (!user?.telegramId) continue;
      await sendMessage(user.telegramId, MESSAGE);
      await setOffer(lastKey, String(Math.floor(Date.now() / 1000)), USAGE_COOLDOWN_SEC);
      await markCommercialPushSent(vds.targetUserId);
      sent++;
    } catch (e) {
      Logger.error(`[Growth] Usage upsell for VDS ${vds.id} failed`, e);
    }
  }
  return sent;
}
