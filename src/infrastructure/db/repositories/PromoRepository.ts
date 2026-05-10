/**
 * Promo repository for promo code management.
 *
 * @module infrastructure/db/repositories/PromoRepository
 */

import { DataSource } from "typeorm";
import Promo from "../../../entities/Promo";
import { BaseRepository } from "./base";
import { NotFoundError, BusinessError } from "../../../shared/errors/index";

/**
 * Promo repository with promo code-specific operations.
 */
export class PromoRepository extends BaseRepository<Promo> {
  constructor(dataSource: DataSource) {
    super(dataSource, Promo);
  }

  /**
   * Find promo by code (case-insensitive).
   */
  async findByCode(code: string): Promise<Promo | null> {
    const normalizedCode = code.toLowerCase().trim();
    return this.repository.findOne({
      where: { code: normalizedCode },
    });
  }

  /**
   * Check if promo code can be used by user.
   */
  async canUsePromo(code: string, userId: number): Promise<boolean> {
    const promo = await this.findByCode(code);
    if (!promo) return false;
    if (promo.uses >= promo.maxUses) return false;
    if (promo.users.includes(userId)) return false;
    return true;
  }

  /**
   * Apply promo code to user (with transaction support).
   * Returns the promo amount or throws error.
   */
  async applyPromo(
    code: string,
    userId: number,
    transaction?: DataSource
  ): Promise<number> {
    const repo = transaction ? transaction.getRepository(Promo) : this.repository;
    const promo = await repo.findOne({
      where: { code: code.toLowerCase().trim() },
    });

    if (!promo) {
      throw new BusinessError("Promo code not found");
    }

    if (promo.uses >= promo.maxUses) {
      throw new BusinessError("Promo code has reached maximum uses");
    }

    if (promo.users.includes(userId)) {
      throw new BusinessError("Promo code already used by this user");
    }

    // Update promo
    promo.uses += 1;
    promo.users.push(userId);
    await repo.save(promo);

    return promo.sum;
  }
}
