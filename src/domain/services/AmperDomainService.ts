/**
 * Domain service for managing domain registrations via Amper API.
 *
 * @module domain/services/AmperDomainService
 */

import { DataSource } from "typeorm";
import Domain, { DomainStatus } from "../../entities/Domain.js";
import DomainOperation, { DomainOperationType, DomainOperationStatus } from "../../entities/DomainOperation.js";
import { DomainRepository } from "../../infrastructure/db/repositories/DomainRepository.js";
import { BillingService } from "../billing/BillingService.js";
import { AmperDomainsProvider } from "../../infrastructure/domains/AmperDomainsProvider.js";
import type { DomainProvider } from "../../infrastructure/domains/DomainProvider.js";
import { NotFoundError, BusinessError, ExternalApiError } from "../../shared/errors/index.js";
import { Logger } from "../../app/logger.js";
import User from "../../entities/User.js";

/**
 * Domain service for managing domain registrations.
 */
export class AmperDomainService {
  private domainProvider: DomainProvider;

  constructor(
    private dataSource: DataSource,
    private domainRepository: DomainRepository,
    private billingService: BillingService,
    provider: AmperDomainsProvider
  ) {
    this.domainProvider = provider;
  }

  /**
   * Check domain availability.
   * @throws ExternalApiError if API error (not format error)
   * @returns true if available, false if unavailable or format error (can't determine)
   */
  async checkAvailability(domain: string): Promise<boolean> {
    try {
      const result = await this.domainProvider.checkAvailability(domain);
      // Если API вернул ошибку формата — не можем определить доступность, считаем недоступным
      // (вызывающий код может использовать DomainR или другой провайдер)
      if (result.formatError) {
        Logger.warn(`Amper API format error for ${domain}, cannot determine availability`);
        return false;
      }
      return result.available;
    } catch (error: any) {
      Logger.error(`Failed to check domain availability for ${domain}:`, error);
      throw new ExternalApiError(
        `Failed to check domain availability: ${error.message}`,
        "AmperDomainsProvider",
        error
      );
    }
  }

  /**
   * Get domain price (base, no Prime discount).
   */
  async getPrice(tld: string, period: number): Promise<number> {
    try {
      const priceInfo = await this.domainProvider.getPrice(tld, period);
      return priceInfo.price;
    } catch (error: any) {
      Logger.error(`Failed to get price for ${tld} (${period}y):`, error);
      throw new ExternalApiError(
        `Failed to get domain price: ${error.message}`,
        "AmperDomainsProvider",
        error
      );
    }
  }

  /**
   * Get domain price for user (10% discount if Prime active).
   *
   * @returns { price, discountApplied }
   */
  async getPriceForUser(
    userId: number,
    tld: string,
    period: number
  ): Promise<{ price: number; discountApplied: boolean }> {
    const basePrice = await this.getPrice(tld, period);
    const hasPrime = await this.billingService.hasActivePrime(userId);
    if (hasPrime) {
      const discounted = Math.round(basePrice * 0.9 * 100) / 100;
      return { price: discounted, discountApplied: true };
    }
    return { price: basePrice, discountApplied: false };
  }

  /**
   * Register domain (create domain entity, deduct balance, call provider).
   */
  async registerDomain(
    userId: number,
    domain: string,
    tld: string,
    period: number,
    ns1?: string,
    ns2?: string
  ): Promise<Domain> {
    // Validate domain format
    const fullDomain = `${domain}${tld}`;
    if (!this.isValidDomain(fullDomain)) {
      throw new BusinessError("Invalid domain format");
    }

    // Get price (with Prime 10% discount if active)
    const { price } = await this.getPriceForUser(userId, tld, period);

    // Check balance
    if (!(await this.billingService.hasSufficientBalance(userId, price))) {
      const balance = await this.billingService.getBalance(userId);
      throw new BusinessError(
        `Insufficient balance. Required: ${price}, Available: ${balance}`
      );
    }

    // Check availability
    const available = await this.checkAvailability(fullDomain);
    if (!available) {
      throw new BusinessError("Domain is not available");
    }

    // Create domain and deduct balance in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(Domain);
      const userRepo = manager.getRepository(User);
      const operationRepo = manager.getRepository(DomainOperation);

      // Deduct balance
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundError("User", userId);
      }

      if (user.balance < price) {
        throw new BusinessError(
          `Insufficient balance. Required: ${price}, Available: ${user.balance}`
        );
      }

      user.balance -= price;

      // Create domain entity
      const domainEntity = new Domain();
      domainEntity.userId = userId;
      domainEntity.domain = fullDomain;
      domainEntity.tld = tld;
      domainEntity.period = period;
      domainEntity.price = price;
      domainEntity.status = DomainStatus.WAIT_PAYMENT as any;
      domainEntity.ns1 = ns1 || null;
      domainEntity.ns2 = ns2 || null;
      domainEntity.provider = "amper";
      domainEntity.providerDomainId = null;

      await userRepo.save(user);
      const savedDomain = await domainRepo.save(domainEntity);

      // Register with provider
      try {
        const result = await this.domainProvider.registerDomain({
          domain: fullDomain,
          period,
          ns1: ns1,
          ns2: ns2,
        });

        if (result.success && result.domainId) {
          savedDomain.providerDomainId = result.domainId;
          savedDomain.status = (result.operationId
            ? DomainStatus.REGISTERING
            : DomainStatus.REGISTERED) as any;

          // Create operation record if async
          if (result.operationId) {
            const operation = new DomainOperation();
            operation.domainId = savedDomain.id;
            operation.type = DomainOperationType.REGISTER;
            operation.status = DomainOperationStatus.IN_PROGRESS;
            operation.providerOpId = result.operationId;
            await operationRepo.save(operation);
          }
        } else {
          const errLower = (result.error ?? "").toLowerCase();
          const isAlreadyOwned = errLower.includes("already owned by you") || errLower.includes("owned by you");
          if (isAlreadyOwned && result.domainId) {
            savedDomain.providerDomainId = result.domainId;
            savedDomain.status = DomainStatus.REGISTERED as any;
            user.balance += price;
            await userRepo.save(user);
            await domainRepo.save(savedDomain);
            Logger.info(`[AmperDomainService] Domain ${fullDomain} already owned, linked providerId ${result.domainId}`);
          } else {
            savedDomain.status = DomainStatus.FAILED as any;
            user.balance += price;
            await userRepo.save(user);
            await domainRepo.save(savedDomain);
          }
          throw new BusinessError(
            result.error || "Registrar rejected the registration"
          );
        }

        await domainRepo.save(savedDomain);
      } catch (error: any) {
        Logger.error(`Failed to register domain with provider:`, error);
        savedDomain.status = DomainStatus.FAILED as any;
        await domainRepo.save(savedDomain);
        // Refund balance
        user.balance += price;
        await userRepo.save(user);
        throw new ExternalApiError(
          `Failed to register domain: ${error.message}`,
          "AmperDomainsProvider",
          error
        );
      }

      Logger.info(
        `Registered domain ${fullDomain} for user ${userId} (domain ID: ${savedDomain.id})`
      );

      return savedDomain;
    });
  }

  /**
   * Get user domains.
   */
  async getUserDomains(userId: number): Promise<Domain[]> {
    return await this.domainRepository.findByUserId(userId);
  }

  /**
   * Get domain by ID.
   */
  async getDomainById(domainId: number): Promise<Domain> {
    const domain = await this.domainRepository.findById(domainId);
    if (!domain) {
      throw new NotFoundError("Domain", domainId);
    }
    return domain;
  }

  /**
   * Renew domain.
   */
  async renewDomain(domainId: number): Promise<Domain> {
    const domain = await this.getDomainById(domainId);

    if (domain.status !== "registered") {
      throw new BusinessError(`Cannot renew domain with status: ${domain.status}`);
    }

    // Get price for renewal (with Prime 10% discount if active)
    const { price } = await this.getPriceForUser(domain.userId, domain.tld, domain.period);

    // Check balance
    if (!(await this.billingService.hasSufficientBalance(domain.userId, price))) {
      const balance = await this.billingService.getBalance(domain.userId);
      throw new BusinessError(
        `Insufficient balance for renewal. Required: ${price}, Available: ${balance}`
      );
    }

    if (!domain.providerDomainId) {
      throw new BusinessError("Domain provider ID not found");
    }

    // Renew in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(Domain);
      const userRepo = manager.getRepository(User);
      const operationRepo = manager.getRepository(DomainOperation);

      // Deduct balance
      const user = await userRepo.findOne({ where: { id: domain.userId } });
      if (!user) {
        throw new NotFoundError("User", domain.userId);
      }

      user.balance -= price;

      // Renew with provider
      const result = await this.domainProvider.renewDomain({
        domainId: domain.providerDomainId!,
        period: domain.period,
      });

      if (result.success) {
        // Create operation record if async
        if (result.operationId) {
          const operation = new DomainOperation();
          operation.domainId = domain.id;
          operation.type = DomainOperationType.RENEW;
          operation.status = DomainOperationStatus.IN_PROGRESS;
          operation.providerOpId = result.operationId;
          await operationRepo.save(operation);
        }
      } else {
        // Refund on failure
        user.balance += price;
        throw new BusinessError(result.error || "Renewal failed");
      }

      await userRepo.save(user);
      await domainRepo.save(domain);

      Logger.info(`Renewed domain ${domainId} for user ${domain.userId}`);
      return domain;
    });
  }

  /**
   * Update nameservers.
   * If providerDomainId is missing (stub domain), tries to resolve it from Amper list before updating.
   */
  async updateNameservers(domainId: number, ns1: string, ns2: string): Promise<Domain> {
    const domain = await this.getDomainById(domainId);

    if (domain.status !== "registered") {
      throw new BusinessError(`Cannot update nameservers for domain with status: ${domain.status}`);
    }

    // Amper API: PUT /domains/{domainId}/nameservers — в пути Amper domain ID или имя домена
    if (!domain.providerDomainId) {
      let list = await this.domainProvider.listDomains("");
      if (list.length === 0 && "listDomainsByDomain" in this.domainProvider) {
        list = await (this.domainProvider as any).listDomainsByDomain(domain.domain);
      }
      const amper = list.find((d: any) => d.domain?.toLowerCase() === domain.domain.toLowerCase());
      if (amper?.domainId) {
        domain.providerDomainId = amper.domainId;
        domain.ns1 = amper.ns1 ?? null;
        domain.ns2 = amper.ns2 ?? null;
        await this.domainRepository.getRepository().save(domain);
      }
    }
    const domainIdOrName = domain.providerDomainId ?? domain.domain;

    // Update in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(Domain);
      const operationRepo = manager.getRepository(DomainOperation);

      const result = await this.domainProvider.updateNameservers({
        domainId: String(domainIdOrName),
        ns1,
        ns2,
      });

      if (result.success) {
        domain.ns1 = ns1;
        domain.ns2 = ns2;

        // Create operation record if async
        if (result.operationId) {
          const operation = new DomainOperation();
          operation.domainId = domain.id;
          operation.type = DomainOperationType.UPDATE_NS;
          operation.status = DomainOperationStatus.IN_PROGRESS;
          operation.providerOpId = result.operationId;
          await operationRepo.save(operation);
        }

        await domainRepo.save(domain);
        Logger.info(`Updated nameservers for domain ${domainId}`);
      } else {
        throw new BusinessError(result.error || "Nameserver update failed");
      }

      return domain;
    });
  }

  /**
   * Import a domain already owned by the user in Amper into our DB so it appears in "Услуги" and user can change nameservers.
   * Tries listDomains with our user.id first; if empty and telegramId is provided, tries with telegram id (Amper may use it).
   *
   * @param telegramId - Optional Telegram user id; used as fallback for listDomains if Amper filters by it.
   * @returns Domain entity (existing or newly created), or null if not found in Amper.
   */
  async importDomainFromAmper(userId: number, fullDomain: string, telegramId?: number): Promise<Domain | null> {
    const normalized = fullDomain.toLowerCase().trim();
    if (!this.isValidDomain(normalized)) {
      return null;
    }
    let list = await this.domainProvider.listDomains(String(userId));
    if (list.length === 0 && telegramId != null) {
      list = await this.domainProvider.listDomains(String(telegramId));
    }
    // Amper может не фильтровать по userId — тогда запрашиваем все домены по API-ключу
    if (list.length === 0) {
      list = await this.domainProvider.listDomains("");
    }
    // Попытка по имени: GET /domains?domain=upgrader2.com (если API поддерживает)
    if (list.length === 0 && "listDomainsByDomain" in this.domainProvider) {
      list = await (this.domainProvider as any).listDomainsByDomain(normalized);
    }
    const existingByUser = await this.domainRepository.findByUserId(userId);
    const inDb = existingByUser.find((d) => d.domain.toLowerCase() === normalized);
    if (inDb) {
      return inDb;
    }

    const amperInfo = list.find((d) => d.domain.toLowerCase() === normalized);
    const lastDot = normalized.lastIndexOf(".");
    const tld = lastDot >= 0 ? normalized.slice(lastDot) : "";

    const domainEntity = new Domain();
    domainEntity.userId = userId;
    domainEntity.domain = normalized;
    domainEntity.tld = tld.startsWith(".") ? tld.slice(1) : tld;
    domainEntity.period = 1;
    domainEntity.price = 0;
    domainEntity.status = DomainStatus.REGISTERED as any;
    domainEntity.provider = "amper";

    if (amperInfo?.domainId) {
      const existing = await this.domainRepository.findByProviderDomainId(amperInfo.domainId);
      if (existing) {
        return existing;
      }
      domainEntity.providerDomainId = amperInfo.domainId;
      domainEntity.ns1 = amperInfo.ns1 ?? null;
      domainEntity.ns2 = amperInfo.ns2 ?? null;
      Logger.info(`Imported domain ${normalized} from Amper for user ${userId} (providerId: ${amperInfo.domainId})`);
    } else {
      domainEntity.providerDomainId = null;
      domainEntity.ns1 = null;
      domainEntity.ns2 = null;
      Logger.info(`Added domain ${normalized} to user ${userId} (stub, Amper list empty — domainId will be resolved on NS update)`);
    }

    const saved = await this.domainRepository.getRepository().save(domainEntity);
    return saved;
  }

  /**
   * Set Amper provider domain ID for a domain (e.g. when list doesn't return it).
   * Admin can paste the ID from Amper dashboard.
   */
  async setProviderDomainId(domainId: number, providerDomainId: string): Promise<Domain> {
    const domain = await this.getDomainById(domainId);
    const trimmed = providerDomainId.trim();
    if (!trimmed) {
      throw new BusinessError("Amper Domain ID не может быть пустым");
    }
    domain.providerDomainId = trimmed;
    await this.domainRepository.getRepository().save(domain);
    Logger.info(`Set providerDomainId for domain ${domainId} (${domain.domain}) -> ${trimmed}`);
    return domain;
  }

  /**
   * Validate domain format.
   */
  private isValidDomain(domain: string): boolean {
    // Basic domain validation
    const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;
    return domainRegex.test(domain) && domain.length <= 253;
  }
}
