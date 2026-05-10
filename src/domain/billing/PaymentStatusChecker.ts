/**
 * Background service for checking payment statuses.
 *
 * @module domain/billing/PaymentStatusChecker
 */

import type { Bot, Api, RawApi } from "grammy";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { TopUpRepository } from "../../infrastructure/db/repositories/TopUpRepository.js";
import { BillingService } from "./BillingService.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { TopUpStatus } from "../../entities/TopUp.js";
import { Logger } from "../../app/logger.js";
import type { FluentTranslator } from "../../fluent.js";
import { notifyAdminsAboutTopUp, notifyReferrerAboutReferralTopUp } from "../../helpers/notifier.js";
import { invalidateUser } from "../../shared/user-cache.js";

/**
 * Background service that periodically checks payment statuses.
 */
export class PaymentStatusChecker {
  private intervalId?: NodeJS.Timeout;
  private readonly checkIntervalMs = 10_000; // 10 seconds

  constructor(
    private bot: Bot<any, Api<RawApi>>,
    private billingService: BillingService,
    private fluent: FluentTranslator
  ) {}

  /**
   * Start checking payment statuses periodically.
   */
  start(): void {
    if (this.intervalId) {
      Logger.warn("PaymentStatusChecker already started");
      return;
    }

    Logger.info("Starting PaymentStatusChecker");

    this.intervalId = setInterval(() => {
      this.checkPayments().catch((error) => {
        Logger.error("Error in PaymentStatusChecker", error);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop checking payment statuses.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      Logger.info("PaymentStatusChecker stopped");
    }
  }

  /**
   * Check all pending payments and apply completed ones.
   */
  private async checkPayments(): Promise<void> {
    const dataSource = await getAppDataSource();
    const topUpRepo = new TopUpRepository(dataSource);

    // Get all pending top-ups
    const pendingTopUps = await topUpRepo.findPending();

    if (pendingTopUps.length === 0) {
      return;
    }

    Logger.debug(`Checking ${pendingTopUps.length} pending payments`);

    for (const topUp of pendingTopUps) {
      try {
        // Check status
        const updatedTopUp = await this.billingService.checkPaymentStatus(
          topUp.id
        );

        // If completed, apply to balance (idempotent vs api/payment.ts finalizePaidTopUp)
        if (updatedTopUp.status === TopUpStatus.Completed) {
          const result = await this.billingService.applyPayment(topUp.id);

          if (result.skippedDuplicate) {
            continue;
          }

          const amount = result.amount;

          const userRepo = new UserRepository(dataSource);
          const user = await userRepo.findById(topUp.target_user_id);
          if (user) {
            invalidateUser(user.telegramId);
          }

          // Notify referrer if referral reward was applied
          if (result.referralNotify) {
            try {
              await notifyReferrerAboutReferralTopUp(this.bot, result.referralNotify, topUp.amount);
            } catch (refErr) {
              Logger.error("Failed to notify referrer about referral top-up", refErr);
            }
          }

          // Notify user
          await this.notifyUser(topUp.target_user_id, amount);

          // Notify admins (parallel path to api/payment.ts side effects)
          if (user) {
            try {
              await notifyAdminsAboutTopUp(this.bot, user, amount, topUp.paymentSystem);
            } catch (adminErr) {
              Logger.error("Failed to notify admins about top-up", adminErr);
            }
          }

          try {
            const { emit } = await import("../../modules/automations/engine/event-bus.js");
            emit({
              event: "deposit.completed",
              userId: topUp.target_user_id,
              timestamp: new Date(),
              topUpId: topUp.id,
              amount,
              targetUserId: topUp.target_user_id,
            });
          } catch {
            // Ignore if automations module not available
          }
        }
      } catch (error) {
        Logger.error(`Failed to check payment ${topUp.id}`, error);
        // Continue with other payments
      }
    }
  }

  /**
   * Notify user about successful payment.
   */
  private async notifyUser(userId: number, amount: number): Promise<void> {
    try {
      const userRepo = new UserRepository(await getAppDataSource());
      const user = await userRepo.findById(userId);

      if (!user) {
        Logger.warn(`User ${userId} not found for payment notification`);
        return;
      }

      const locale = user.lang || "ru";
      const message = this.fluent.translate(locale, "payment-success", {
        amount: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(amount),
      });

      await this.bot.api.sendMessage(user.telegramId, message);
    } catch (error) {
      Logger.error(`Failed to notify user ${userId}`, error);
    }
  }
}
