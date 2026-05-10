/**
 * Domain request repository for moderation flow.
 *
 * @module infrastructure/db/repositories/DomainRequestRepository
 */

import { DataSource } from "typeorm";
import DomainRequest, { DomainRequestStatus } from "../../../entities/DomainRequest";
import { BaseRepository } from "./base";

export class DomainRequestRepository extends BaseRepository<DomainRequest> {
  constructor(dataSource: DataSource) {
    super(dataSource, DomainRequest);
  }

  /**
   * Find domain requests with status InProgress.
   */
  async findPending(): Promise<DomainRequest[]> {
    return this.getRepository().find({
      where: { status: DomainRequestStatus.InProgress },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * Find domain requests that are due for renewal (Completed, payday_at in the past).
   */
  async findExpiringSoon(): Promise<DomainRequest[]> {
    const repo = this.getRepository();
    return repo
      .createQueryBuilder("r")
      .where("r.status = :status", { status: DomainRequestStatus.Completed })
      .andWhere("r.payday_at <= :now", { now: new Date() })
      .orderBy("r.payday_at", "ASC")
      .getMany();
  }

  /**
   * Find domain requests by target user ID.
   */
  async findByTargetUserId(userId: number): Promise<DomainRequest[]> {
    return this.getRepository().find({
      where: { target_user_id: userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Approve a domain request: set expireAt, payday_at, status Completed.
   */
  async approve(
    id: number,
    expireAt: Date,
    paydayAt: Date
  ): Promise<DomainRequest> {
    const repo = this.getRepository();
    const request = await repo.findOne({ where: { id } });
    if (!request) throw new Error(`DomainRequest ${id} not found`);
    request.expireAt = expireAt;
    request.payday_at = paydayAt;
    request.status = DomainRequestStatus.Completed;
    return repo.save(request);
  }
}
