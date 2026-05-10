/**
 * VirtualDedicatedServer repository for VDS management.
 *
 * @module infrastructure/db/repositories/VdsRepository
 */

import { Brackets, DataSource, LessThanOrEqual } from "typeorm";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer";
import { BaseRepository } from "./base";
import { NotFoundError } from "../../../shared/errors/index";

/**
 * VDS repository with VDS-specific operations.
 */
export class VdsRepository extends BaseRepository<VirtualDedicatedServer> {
  constructor(dataSource: DataSource) {
    super(dataSource, VirtualDedicatedServer);
  }

  /**
   * Find VDS by VMManager ID.
   */
  async findByVdsId(vdsId: number): Promise<VirtualDedicatedServer | null> {
    return this.repository.findOne({
      where: { vdsId },
    });
  }

  /**
   * Find all VDS for a user.
   */
  async findByUserId(userId: number): Promise<VirtualDedicatedServer[]> {
    return this.repository.find({
      where: { targetUserId: userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Find expired VDS (expireAt <= now).
   */
  async findExpired(): Promise<VirtualDedicatedServer[]> {
    return this.repository.find({
      where: {
        expireAt: LessThanOrEqual(new Date()),
      },
    });
  }

  /**
   * Admin list with optional search by id, IP, name, rate.
   */
  async findPaginatedForAdmin(
    skip: number,
    take: number,
    search?: string
  ): Promise<[VirtualDedicatedServer[], number]> {
    const qb = this.repository.createQueryBuilder("v");
    const trimmed = search?.trim();
    if (trimmed) {
      const q = `%${trimmed}%`;
      qb.where(
        new Brackets((w) => {
          w.where("CAST(v.id AS TEXT) LIKE :q", { q })
            .orWhere("CAST(v.vdsId AS TEXT) LIKE :q", { q })
            .orWhere("v.ipv4Addr LIKE :q", { q })
            .orWhere("COALESCE(v.displayName, '') LIKE :q", { q })
            .orWhere("v.rateName LIKE :q", { q });
        })
      );
    }
    qb.orderBy("v.id", "DESC").skip(skip).take(take);
    return qb.getManyAndCount();
  }

  /**
   * Find VDS expiring soon (within days).
   */
  async findExpiringSoon(days: number): Promise<VirtualDedicatedServer[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return this.repository.find({
      where: {
        expireAt: LessThanOrEqual(futureDate),
      },
    });
  }

  /**
   * Update VDS expiration date.
   */
  async updateExpiration(
    vdsId: number,
    expireAt: Date
  ): Promise<VirtualDedicatedServer> {
    const vds = await this.findById(vdsId);
    if (!vds) {
      throw new NotFoundError("VirtualDedicatedServer", vdsId);
    }
    vds.expireAt = expireAt;
    return this.save(vds);
  }

  /**
   * Set pay day (when VDS will be deleted if not paid).
   */
  async setPayDay(
    vdsId: number,
    payDayAt: Date | null
  ): Promise<VirtualDedicatedServer> {
    const vds = await this.findById(vdsId);
    if (!vds) {
      throw new NotFoundError("VirtualDedicatedServer", vdsId);
    }
    vds.payDayAt = payDayAt;
    return this.save(vds);
  }
}
