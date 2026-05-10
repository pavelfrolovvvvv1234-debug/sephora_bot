/**
 * Repository exports.
 *
 * @module infrastructure/db/repositories
 */

import { DataSource } from "typeorm";
import { BaseRepository } from "./base.js";
import { UserRepository } from "./UserRepository.js";
import { TopUpRepository } from "./TopUpRepository.js";
import { VdsRepository } from "./VdsRepository.js";
import { DomainRepository } from "./DomainRepository.js";
import { PromoRepository } from "./PromoRepository.js";
import { ServiceInvoiceRepository } from "./ServiceInvoiceRepository.js";

export * from "./base.js";
export * from "./UserRepository.js";
export * from "./TopUpRepository.js";
export * from "./VdsRepository.js";
export * from "./DomainRepository.js";
export * from "./PromoRepository.js";
export * from "./ServiceInvoiceRepository.js";

/**
 * Repository factory for dependency injection.
 */
export class RepositoryFactory {
  constructor(private dataSource: DataSource) {}

  createUserRepository(): UserRepository {
    return new UserRepository(this.dataSource);
  }

  createTopUpRepository(): TopUpRepository {
    return new TopUpRepository(this.dataSource);
  }

  createVdsRepository(): VdsRepository {
    return new VdsRepository(this.dataSource);
  }

  createDomainRepository(): DomainRepository {
    return new DomainRepository(this.dataSource);
  }

  createPromoRepository(): PromoRepository {
    return new PromoRepository(this.dataSource);
  }
}
