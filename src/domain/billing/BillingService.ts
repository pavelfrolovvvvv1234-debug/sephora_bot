/**
 * Billing service for payment and balance management.
 *
 * @module domain/billing/BillingService
 */

import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import type { PaymentProviderName } from "../../infrastructure/payments/types";
import { InvoiceStatus } from "../../infrastructure/payments/types";
import { createPaymentProvider } from "../../infrastructure/payments/factory";
import { TopUpRepository } from "../../infrastructure/db/repositories/TopUpRepository";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository";
import TopUp, { TopUpStatus } from "../../entities/TopUp";
import User from "../../entities/User";
import { PaymentError, BusinessError, NotFoundError } from "../../shared/errors/index";
import { Logger } from "../../app/logger";
import { retry } from "../../shared/utils/retry";
import type { ReferralRewardApplied } from "../referral/ReferralService.js";

export type ApplyPaymentResult = {
  amount: number;
  referralNotify?: ReferralRewardApplied;
  /** Same row already settled by another worker (e.g. api/payment finalize). */
  skippedDuplicate?: boolean;
};

/**
 * Billing service for managing payments, invoices, and balance operations.
 */
export class BillingService {
  constructor(
    private dataSource: DataSource,
    private userRepository: UserRepository,
    private topUpRepository: TopUpRepository
  ) {}

  /**
   * Create a payment invoice for top-up.
   *
   * @param userId - User ID
   * @param amount - Payment amount in USD
   * @param provider - Payment provider name
   * @returns Created TopUp entity
   * @throws {PaymentError} If invoice creation fails
   * @throws {NotFoundError} If user not found
   */
  async createInvoice(
    userId: number,
    amount: number,
    provider: PaymentProviderName
  ): Promise<TopUp> {
    // Validate user exists
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }

    // Validate amount
    if (amount <= 0 || amount > 1_500_000) {
      throw new BusinessError("Invalid payment amount");
    }

    // Generate unique order ID
    const orderId = randomUUID();

    // Create payment provider
    const paymentProvider = createPaymentProvider(provider);

    // Create invoice with retry
    const invoice = await retry(
      () => paymentProvider.createInvoice(amount, orderId),
      {
        maxAttempts: 3,
        delayMs: 1000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error("Failed to create payment invoice", error);
      throw new PaymentError(
        `Failed to create ${provider} invoice: ${error.message}`,
        provider
      );
    });

    // Create TopUp record
    const topUp = new TopUp();
    topUp.orderId = invoice.id;
    topUp.amount = amount;
    topUp.target_user_id = userId;
    topUp.paymentSystem = provider;
    topUp.url = invoice.url;
    topUp.status = TopUpStatus.Created;

    return await this.topUpRepository.save(topUp);
  }

  /**
   * Check payment status and update TopUp record.
   *
   * @param topUpId - TopUp ID
   * @returns Updated TopUp entity with new status
   * @throws {NotFoundError} If TopUp not found
   * @throws {PaymentError} If status check fails
   */
  async checkPaymentStatus(topUpId: number): Promise<TopUp> {
    const topUp = await this.topUpRepository.findById(topUpId);
    if (!topUp) {
      throw new NotFoundError("TopUp", topUpId);
    }

    // Skip if already completed or expired
    if (topUp.status !== TopUpStatus.Created) {
      return topUp;
    }

    // Get payment provider
    const paymentProvider = createPaymentProvider(topUp.paymentSystem);

    // Check status with retry
    const status = await retry(
      () => paymentProvider.checkStatus(topUp.orderId),
      {
        maxAttempts: 3,
        delayMs: 500,
      }
    ).catch((error) => {
      Logger.error("Failed to check payment status", error);
      throw new PaymentError(
        `Failed to check ${topUp.paymentSystem} status: ${error.message}`,
        topUp.paymentSystem
      );
    });

    // Update status
    switch (status) {
      case InvoiceStatus.PAID:
        topUp.status = TopUpStatus.Completed;
        break;
      case InvoiceStatus.EXPIRED:
      case InvoiceStatus.FAILED:
        topUp.status = TopUpStatus.Expired;
        break;
      default:
        // Still pending
        break;
    }

    return await this.topUpRepository.save(topUp);
  }

  /**
   * Apply completed payment to user balance (atomic operation).
   * Uses database transaction to ensure consistency.
   *
   * @param topUpId - TopUp ID
   * @returns Applied amount
   * @throws {NotFoundError} If TopUp or User not found
   * @throws {BusinessError} If payment not completed
   */
  async applyPayment(topUpId: number): Promise<ApplyPaymentResult> {
    return await this.dataSource.transaction(async (manager) => {
      // Use transaction repositories
      const topUpRepo = manager.getRepository(TopUp);
      const userRepo = manager.getRepository(User);

      // Get TopUp with lock
      const topUp = await topUpRepo.findOne({
        where: { id: topUpId },
      });

      if (!topUp) {
        throw new NotFoundError("TopUp", topUpId);
      }

      // Check if already applied
      if (topUp.status !== TopUpStatus.Completed) {
        throw new BusinessError(
          `Cannot apply payment with status: ${topUp.status}`
        );
      }

      if (topUp.balanceCreditedAt != null) {
        return {
          amount: topUp.amount,
          skippedDuplicate: true,
        };
      }

      // Get user with lock
      const user = await userRepo.findOne({
        where: { id: topUp.target_user_id },
      });

      if (!user) {
        throw new NotFoundError("User", topUp.target_user_id);
      }

      // Apply balance
      user.balance += topUp.amount;
      topUp.balanceCreditedAt = new Date();

      // Save both in transaction
      await userRepo.save(user);
      await topUpRepo.save(topUp);

      Logger.info(`Applied payment ${topUpId} of ${topUp.amount} to user ${user.id}`);

      // Apply referral reward if applicable (outside transaction to avoid deadlocks)
      let referralNotify: ReferralRewardApplied | undefined;
      try {
        const { ReferralService } = await import("../referral/ReferralService.js");
        const referralService = new ReferralService(
          this.dataSource,
          this.userRepository
        );
        const referralResult = await referralService.applyReferralRewardOnTopup(
          topUp.target_user_id,
          topUpId,
          topUp.amount
        );

        if (referralResult && typeof referralResult === "object") {
          Logger.info(
            `Applied referral reward ${referralResult.rewardAmount} for topUp ${topUpId}`
          );
          referralNotify = referralResult;
        }
      } catch (error: any) {
        Logger.error(`Failed to apply referral reward:`, error);
        // Don't fail payment if referral reward fails
      }

      return { amount: topUp.amount, referralNotify, skippedDuplicate: false };
    });
  }

  /**
   * Get user balance.
   *
   * @param userId - User ID
   * @returns User balance
   * @throws {NotFoundError} If user not found
   */
  async getBalance(userId: number): Promise<number> {
    return await this.userRepository.getBalance(userId);
  }

  /**
   * Check if user has sufficient balance.
   *
   * @param userId - User ID
   * @param amount - Required amount
   * @returns True if sufficient balance
   */
  async hasSufficientBalance(userId: number, amount: number): Promise<boolean> {
    return await this.userRepository.hasSufficientBalance(userId, amount);
  }

  /**
   * Check if user has active Prime subscription (10% domain discount).
   *
   * @param userId - User ID
   * @returns True if primeActiveUntil is set and in the future
   */
  async hasActivePrime(userId: number): Promise<boolean> {
    const user = await this.userRepository.findById(userId);
    if (!user || !user.primeActiveUntil) return false;
    return new Date() < new Date(user.primeActiveUntil);
  }

  /**
   * Deduct balance atomically (with transaction support).
   *
   * @param userId - User ID
   * @param amount - Amount to deduct
   * @param transaction - Optional transaction manager
   * @returns Updated user
   * @throws {NotFoundError} If user not found
   * @throws {BusinessError} If insufficient balance
   */
  async deductBalance(
    userId: number,
    amount: number,
    transaction?: DataSource
  ): Promise<User> {
    const userRepo = transaction
      ? transaction.getRepository(User)
      : this.userRepository.getRepository();

    const user = await userRepo.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError("User", userId);
    }

    if (user.balance < amount) {
      throw new BusinessError(
        `Insufficient balance. Required: ${amount}, Available: ${user.balance}`
      );
    }

    user.balance -= amount;
    return await userRepo.save(user);
  }

  /**
   * Add balance atomically (with transaction support).
   *
   * @param userId - User ID
   * @param amount - Amount to add
   * @param transaction - Optional transaction manager
   * @returns Updated user
   * @throws {NotFoundError} If user not found
   */
  async addBalance(
    userId: number,
    amount: number,
    transaction?: DataSource
  ): Promise<User> {
    return await this.userRepository.updateBalance(userId, amount, transaction);
  }
}
