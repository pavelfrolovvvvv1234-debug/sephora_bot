/**
 * Domain service for managing domain registrations.
 *
 * @module domain/services/DomainService
 */

import { DataSource } from "typeorm";
import ms from "../../lib/multims.js";
import { DomainRequestRepository } from "../../infrastructure/db/repositories/DomainRequestRepository.js";
import { BillingService } from "../billing/BillingService.js";
import DomainRequest, {
  DomainRequestStatus,
  createDomainRequest,
} from "../../entities/DomainRequest.js";
import User from "../../entities/User.js";
import { NotFoundError, BusinessError } from "../../shared/errors/index.js";
import { Logger } from "../../app/logger.js";

/**
 * Domain service for managing domain requests (moderation flow).
 */
export class DomainService {
  constructor(
    private dataSource: DataSource,
    private domainRequestRepository: DomainRequestRepository,
    private billingService: BillingService
  ) {}

  /**
   * Create domain request (deduct balance and create request).
   *
   * @param userId - User ID
   * @param domainName - Domain name (without zone)
   * @param zone - Domain zone (e.g., ".com")
   * @param price - Domain price
   * @param additionalInfo - Additional information
   * @returns Created domain request
   * @throws {NotFoundError} If user not found
   * @throws {BusinessError} If insufficient balance
   */
  async createDomainRequest(
    userId: number,
    domainName: string,
    zone: string,
    price: number,
    additionalInfo?: string
  ): Promise<DomainRequest> {
    // Check balance
    if (!(await this.billingService.hasSufficientBalance(userId, price))) {
      const balance = await this.billingService.getBalance(userId);
      throw new BusinessError(
        `Insufficient balance. Required: ${price}, Available: ${balance}`
      );
    }

    // Create request and deduct balance in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(DomainRequest);
      const userRepo = manager.getRepository(User);

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

      // Create domain request
      const domainRequest = createDomainRequest(domainName, zone, userId, 0);
      domainRequest.price = price;
      domainRequest.additionalInformation = additionalInfo || "";
      domainRequest.status = DomainRequestStatus.InProgress;

      await userRepo.save(user);
      const savedRequest = await domainRepo.save(domainRequest);

      Logger.info(
        `Created domain request ${savedRequest.id} for ${domainName}${zone} (user ${userId})`
      );

      return savedRequest;
    });
  }

  /**
   * Approve domain request (extend expiration and set payday).
   *
   * @param domainId - Domain request ID
   * @param expireDays - Expiration period in days (default: 365)
   * @returns Approved domain request
   * @throws {NotFoundError} If domain request not found
   */
  async approveDomain(
    domainId: number,
    expireDays: number = 365
  ): Promise<DomainRequest> {
    const request = await this.domainRequestRepository.findById(domainId);
    if (!request) {
      throw new NotFoundError("DomainRequest", domainId);
    }

    if (request.status !== DomainRequestStatus.InProgress) {
      throw new BusinessError(
        `Cannot approve domain with status: ${request.status}`
      );
    }

    const expireAt = new Date(Date.now() + ms(`${expireDays}d`));
    const paydayAt = new Date(expireAt.getTime() - ms("7d"));

    return await this.domainRequestRepository.approve(domainId, expireAt, paydayAt);
  }

  /**
   * Reject domain request (refund balance).
   *
   * @param domainId - Domain request ID
   * @param userId - User ID to refund
   * @returns Rejected domain request
   * @throws {NotFoundError} If domain request or user not found
   */
  async rejectDomain(domainId: number, userId: number): Promise<DomainRequest> {
    const request = await this.domainRequestRepository.findById(domainId);
    if (!request) {
      throw new NotFoundError("DomainRequest", domainId);
    }

    if (request.status !== DomainRequestStatus.InProgress) {
      throw new BusinessError(
        `Cannot reject domain with status: ${request.status}`
      );
    }

    // Reject and refund in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(DomainRequest);
      const userRepo = manager.getRepository(User);

      // Refund balance
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) {
        throw new NotFoundError("User", userId);
      }

      user.balance += request.price;

      // Reject domain
      request.status = DomainRequestStatus.Failed;

      await userRepo.save(user);
      const savedRequest = await domainRepo.save(request);

      Logger.info(
        `Rejected domain request ${domainId} and refunded ${request.price} to user ${userId}`
      );

      return savedRequest;
    });
  }

  /**
   * Renew domain (extend expiration and deduct balance).
   *
   * @param domainId - Domain request ID
   * @returns Renewed domain request
   * @throws {NotFoundError} If domain request not found
   * @throws {BusinessError} If insufficient balance or not completed
   */
  async renewDomain(domainId: number): Promise<DomainRequest> {
    const request = await this.domainRequestRepository.findById(domainId);
    if (!request) {
      throw new NotFoundError("DomainRequest", domainId);
    }

    if (request.status !== DomainRequestStatus.Completed) {
      throw new BusinessError(
        `Cannot renew domain with status: ${request.status}`
      );
    }

    // Check balance
    if (
      !(await this.billingService.hasSufficientBalance(
        request.target_user_id,
        request.price
      ))
    ) {
      const balance = await this.billingService.getBalance(
        request.target_user_id
      );
      throw new BusinessError(
        `Insufficient balance for renewal. Required: ${request.price}, Available: ${balance}`
      );
    }

    // Renew in transaction
    return await this.dataSource.transaction(async (manager) => {
      const domainRepo = manager.getRepository(DomainRequest);
      const userRepo = manager.getRepository(User);

      // Deduct balance
      const user = await userRepo.findOne({
        where: { id: request.target_user_id },
      });
      if (!user) {
        throw new NotFoundError("User", request.target_user_id);
      }

      user.balance -= request.price;

      // Extend expiration
      const now = Date.now();
      request.expireAt = new Date(now + ms("1y"));
      request.payday_at = new Date(now + ms("360d"));

      await userRepo.save(user);
      const savedRequest = await domainRepo.save(request);

      Logger.info(
        `Renewed domain ${domainId} for user ${request.target_user_id}`
      );

      return savedRequest;
    });
  }

  /**
   * Get domain request by ID.
   */
  async getDomainById(domainId: number): Promise<DomainRequest> {
    const request = await this.domainRequestRepository.findById(domainId);
    if (!request) {
      throw new NotFoundError("DomainRequest", domainId);
    }
    return request;
  }

  /**
   * Get all domain requests for a user.
   */
  async getUserDomains(userId: number): Promise<DomainRequest[]> {
    return await this.domainRequestRepository.findByTargetUserId(userId);
  }

  /**
   * Get pending domain requests (for moderators/admins).
   */
  async getPendingDomains(): Promise<DomainRequest[]> {
    return await this.domainRequestRepository.findPending();
  }
}
