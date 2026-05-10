/**
 * Smart retarget before VDS deletion: Day 1 (existing), Day 2: «+5% действует ещё 24ч», Day 3: «Последний шанс продлить без потери данных».
 * Called from ExpirationService daily check when VDS is in grace (payDayAt set).
 *
 * @module modules/growth/campaigns/grace-retarget.campaign
 */

import { getOffer, setOffer } from "../storage.js";
import { canSendCommercialPush, markCommercialPushSent } from "./commercial-limiter.js";
import { Logger } from "../../../app/logger.js";

const GRACE_DAY2_KEY = "growth_grace_day2:";
const GRACE_DAY3_KEY = "growth_grace_day3:";
const GRACE_DAY2_TTL = 2 * 24 * 60 * 60; // 2 days
const GRACE_DAY3_TTL = 1 * 24 * 60 * 60; // 1 day

const MESSAGE_DAY2 = "+5% скидка при продлении действует ещё 24ч. Продлите сейчас.";
const MESSAGE_DAY3 = "Последний шанс продлить без потери данных. Скидка 5% ещё активна.";

/**
 * Get hours until payDayAt (deletion date).
 */
function hoursUntilPayDay(payDayAt: Date): number {
  return (new Date(payDayAt).getTime() - Date.now()) / (60 * 60 * 1000);
}

/**
 * Send Day 2 or Day 3 reminder if applicable. Returns true if a message was sent.
 */
export async function maybeSendGraceDay2OrDay3(
  vdsId: number,
  userId: number,
  telegramId: number,
  payDayAt: Date,
  sendMessage: (telegramId: number, text: string) => Promise<void>
): Promise<boolean> {
  const hoursLeft = hoursUntilPayDay(payDayAt);
  if (hoursLeft > 48) return false; // Day 2 not yet
  if (hoursLeft <= 0) return false;

  try {
    if (hoursLeft <= 24) {
      const key3 = `${GRACE_DAY3_KEY}${vdsId}`;
      if (!(await getOffer(key3))) {
        if (await canSendCommercialPush(userId)) {
          await sendMessage(telegramId, MESSAGE_DAY3);
          await setOffer(key3, "1", GRACE_DAY3_TTL);
          await markCommercialPushSent(userId);
          return true;
        }
      }
    } else {
      const key2 = `${GRACE_DAY2_KEY}${vdsId}`;
      if (!(await getOffer(key2))) {
        if (await canSendCommercialPush(userId)) {
          await sendMessage(telegramId, MESSAGE_DAY2);
          await setOffer(key2, "1", GRACE_DAY2_TTL);
          await markCommercialPushSent(userId);
          return true;
        }
      }
    }
  } catch (e) {
    Logger.error(`[Growth] Grace day2/day3 for VDS ${vdsId} failed`, e);
  }
  return false;
}
