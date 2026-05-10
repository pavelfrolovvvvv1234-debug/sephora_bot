/**
 * TopUp repository for payment tracking.
 *
 * @module infrastructure/db/repositories/TopUpRepository
 */

import { DataSource } from "typeorm";
import TopUp, { TopUpStatus } from "../../../entities/TopUp";
import { BaseRepository } from "./base";
import { NotFoundError } from "../../../shared/errors/index";

/**
 * TopUp repository with payment-specific operations.
 */
export class TopUpRepository extends BaseRepository<TopUp> {
  constructor(dataSource: DataSource) {
    super(dataSource, TopUp);
  }

  /**
   * Find top-up by order ID.
   */
  async findByOrderId(orderId: string): Promise<TopUp | null> {
    return this.repository.findOne({
      where: { orderId },
    });
  }

  /**
   * Find all pending top-ups (status: Created).
   */
  async findPending(): Promise<TopUp[]> {
    return this.repository.find({
      where: { status: TopUpStatus.Created },
    });
  }

  /**
   * Find top-ups by user ID.
   */
  async findByUserId(userId: number): Promise<TopUp[]> {
    return this.repository.find({
      where: { target_user_id: userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Find top-ups by payment system.
   */
  async findByPaymentSystem(
    paymentSystem: "crystalpay" | "cryptobot" | "heleket"
  ): Promise<TopUp[]> {
    return this.repository.find({
      where: { paymentSystem },
    });
  }

  /**
   * Update top-up status.
   */
  async updateStatus(
    topUpId: number,
    status: TopUpStatus
  ): Promise<TopUp> {
    const topUp = await this.findById(topUpId);
    if (!topUp) {
      throw new NotFoundError("TopUp", topUpId);
    }
    topUp.status = status;
    return this.save(topUp);
  }
}
