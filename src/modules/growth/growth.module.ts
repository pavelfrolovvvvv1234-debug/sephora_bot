/**
 * Growth module: upsell, FOMO, trigger, reactivation. UI-independent.
 *
 * @module modules/growth/growth.module
 */

export { GrowthService } from "./growth.service.js";
export type { GrowthHandleTopUpResult } from "./growth.service.js";
export { UpsellService } from "./upsell.service.js";
export { FomoService } from "./fomo.service.js";
export { TriggerEngine } from "./trigger.engine.js";
export { ReactivationService } from "./reactivation.service.js";
export { OfferEngine } from "./offer.engine.js";
export { SegmentService } from "./segment.service.js";
export * from "./types.js";
export { setOffer, getOffer, deleteOffer, acquireLock, isRedisAvailable } from "./storage.js";

/**
 * Start daily reactivation job (find inactive users, create offers).
 * Call from app with dataSource and optional bot to send "Вернитесь и получите +15%" message.
 */
export async function startReactivationCron(
  dataSource: import("typeorm").DataSource,
  sendMessage?: (telegramId: number, text: string) => Promise<void>
): Promise<() => void> {
  const { ReactivationService } = await import("./reactivation.service.js");
  const reactivation = new ReactivationService(dataSource);
  const intervalMs = 24 * 60 * 60 * 1000; // 24h
  const tick = async () => {
    try {
      const users = await reactivation.findInactiveUsers(200);
      for (const u of users) {
        await reactivation.createOffer(u.id);
        if (sendMessage) {
          await sendMessage(u.telegramId, "Вернитесь и получите +15% к депозиту!").catch(() => {});
        }
      }
    } catch (e) {
      console.error("[Growth] Reactivation cron error", e);
    }
  };
  const id = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(id);
}
