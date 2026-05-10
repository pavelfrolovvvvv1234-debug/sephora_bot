/**
 * FOMO: "Осталось N серверов по старой цене". remaining per planId, decrement on purchase.
 *
 * @module modules/growth/fomo.service
 */

import { setOffer, getOffer } from "./storage.js";
import type { FomoState } from "./types.js";
import type { DataSource } from "typeorm";
import GrowthEvent from "../../entities/GrowthEvent.js";

const FOMO_PREFIX = "fomo:";
const FOMO_TTL_SEC = 7 * 24 * 60 * 60; // 7 days default cycle

export class FomoService {
  constructor(private dataSource: DataSource) {}

  async getState(planId: string): Promise<FomoState | null> {
    const raw = await getOffer(`${FOMO_PREFIX}${planId}`);
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as FomoState;
      if (state.expiresAt <= Date.now() / 1000) return null;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Set or reset FOMO for a plan (e.g. "vds_rate_5").
   */
  async setState(planId: string, remaining: number, ttlSec: number = FOMO_TTL_SEC): Promise<void> {
    const state: FomoState = {
      remaining,
      expiresAt: Math.floor(Date.now() / 1000) + ttlSec,
    };
    await setOffer(`${FOMO_PREFIX}${planId}`, JSON.stringify(state), ttlSec);
  }

  /**
   * On purchase: decrement remaining. Returns new remaining (or null if no FOMO).
   */
  async onPurchase(
    planId: string,
    userId: number,
    amount: number
  ): Promise<{ remaining: number | null }> {
    const raw = await getOffer(`${FOMO_PREFIX}${planId}`);
    if (!raw) return { remaining: null };
    try {
      const state = JSON.parse(raw) as FomoState;
      if (state.remaining <= 0) return { remaining: 0 };
      state.remaining -= 1;
      const ttl = Math.max(60, state.expiresAt - Math.floor(Date.now() / 1000));
      await setOffer(`${FOMO_PREFIX}${planId}`, JSON.stringify(state), ttl);
      const eventRepo = this.dataSource.getRepository(GrowthEvent);
      const ev = new GrowthEvent();
      ev.userId = userId;
      ev.type = "fomo";
      ev.amount = amount;
      await eventRepo.save(ev);
      return { remaining: state.remaining };
    } catch {
      return { remaining: null };
    }
  }
}
