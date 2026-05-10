/**
 * Domain repository for database operations.
 *
 * @module infrastructure/db/repositories/DomainRepository
 */

import { DataSource, Repository } from "typeorm";
import Domain, { DomainStatus } from "../../../entities/Domain";
import { BaseRepository } from "./base";

/**
 * Domain repository for managing domain entities.
 */
export class DomainRepository extends BaseRepository<Domain> {
  constructor(dataSource: DataSource) {
    super(dataSource, Domain);
  }

  /**
   * Find domain by ID.
   */
  async findById(id: number): Promise<Domain | null> {
    return this.getRepository().findOne({ where: { id } });
  }

  /**
   * Find domains by user ID.
   */
  async findByUserId(userId: number): Promise<Domain[]> {
    return this.getRepository().find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Find domain by provider domain ID.
   */
  async findByProviderDomainId(providerDomainId: string): Promise<Domain | null> {
    return this.getRepository().findOne({
      where: { providerDomainId },
    });
  }

  /**
   * Find domains by status.
   */
  async findByStatus(status: DomainStatus): Promise<Domain[]> {
    return this.getRepository().find({
      where: { status },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * Find domains requiring payment (expired or about to expire).
   */
  async findRequiringPayment(): Promise<Domain[]> {
    const repo = this.getRepository();
    // This would need a more complex query in production
    // For now, return domains with REGISTERED status
    return repo.find({
      where: { status: DomainStatus.REGISTERED },
    });
  }
}
