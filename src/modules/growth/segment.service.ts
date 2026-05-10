/**
 * User segmentation for broadcast and growth. Segments are computed from DB.
 *
 * @module modules/growth/segment.service
 */

import type { DataSource } from "typeorm";
import type { UserSegment } from "./types.js";
import User from "../../entities/User.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DedicatedServer from "../../entities/DedicatedServer.js";
import Domain from "../../entities/Domain.js";
import TopUp, { TopUpStatus } from "../../entities/TopUp.js";

const NEW_USER_DAYS = 7;
const INACTIVE_DAYS = 30;
const HIGH_SPENDER_MIN_TOTAL = 200; // USD total top-ups

export class SegmentService {
  constructor(private dataSource: DataSource) {}

  /**
   * Get user IDs that belong to the given segment.
   */
  async getUserIdsBySegment(segment: UserSegment, limit: number = 10_000): Promise<number[]> {
    const userRepo = this.dataSource.getRepository(User);
    const qb = userRepo.createQueryBuilder("u").select("u.id", "id").where("u.isBanned = 0");

    switch (segment) {
      case "new_user": {
        const since = new Date(Date.now() - NEW_USER_DAYS * 24 * 60 * 60 * 1000);
        const ids = await qb.clone().andWhere("u.createdAt >= :since", { since }).take(limit).getRawMany<{ id: number }>();
        return ids.map((r) => r.id);
      }
      case "inactive_30d": {
        const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);
        const ids = await qb.clone().andWhere("u.lastUpdateAt < :cutoff", { cutoff }).take(limit).getRawMany<{ id: number }>();
        return ids.map((r) => r.id);
      }
      case "active_vps": {
        const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
        const vdsUsers = await vdsRepo.createQueryBuilder("v").select("DISTINCT v.targetUserId", "id").getRawMany<{ id: number }>();
        return vdsUsers.map((r) => r.id).filter(Boolean).slice(0, limit);
      }
      case "domain_only": {
        const domainRepo = this.dataSource.getRepository(Domain);
        const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
        const dediRepo = this.dataSource.getRepository(DedicatedServer);
        const domainUserIds = (await domainRepo.find({ select: ["userId"] })).map((d) => d.userId);
        const vdsUserIds = new Set((await vdsRepo.find({ select: ["targetUserId"] })).map((v) => v.targetUserId));
        const dediUserIds = new Set((await dediRepo.find({ select: ["userId"] })).map((d) => d.userId));
        const domainOnly = domainUserIds.filter((id) => !vdsUserIds.has(id) && !dediUserIds.has(id));
        return [...new Set(domainOnly)].slice(0, limit);
      }
      case "high_spender": {
        const topUpRepo = this.dataSource.getRepository(TopUp);
        const rows = await topUpRepo
          .createQueryBuilder("t")
          .select("t.target_user_id", "id")
          .addSelect("SUM(t.amount)", "total")
          .where("t.status = :status", { status: TopUpStatus.Completed })
          .groupBy("t.target_user_id")
          .having("SUM(t.amount) >= :min", { min: HIGH_SPENDER_MIN_TOTAL })
          .getRawMany<{ id: number }>();
        return rows.map((r) => r.id).slice(0, limit);
      }
      default:
        return [];
    }
  }
}
