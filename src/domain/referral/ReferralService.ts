/**
 * Referral service for managing referral system.
 *
 * @module domain/referral/ReferralService
 */

import { DataSource } from "typeorm";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import User from "../../entities/User.js";
import ReferralReward from "../../entities/ReferralReward.js";
import { NotFoundError, BusinessError } from "../../shared/errors/index.js";
import { Logger } from "../../app/logger.js";
import { config } from "../../app/config.js";

/** Result when referral reward was applied (for notifying referrer). */
export type ReferralRewardApplied = {
  rewardAmount: number;
  referrerTelegramId: number;
  percent: number;
  referrerLang: string;
};

/**
 * Referral service for managing referrals and rewards.
 */
export class ReferralService {
  constructor(
    private dataSource: DataSource,
    private userRepository: UserRepository
  ) {}

  /**
   * Bind referrer to referee (atomic transaction).
   * Validates:
   * - refCode exists and is valid user ID
   * - Not self-referral
   * - Referee doesn't already have a referrer
   *
   * @param refereeUserId - User ID of the referee (new user)
   * @param refCode - Referral code (telegram user ID as string)
   * @returns True if bound successfully, false if ignored
   * @throws {BusinessError} If invalid refCode or self-referral
   */
  async bindReferrer(refereeUserId: number, refCode: string): Promise<boolean> {
    return await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);

      // Get referee
      const referee = await userRepo.findOne({
        where: { id: refereeUserId },
      });

      if (!referee) {
        throw new NotFoundError("User", refereeUserId);
      }

      // If referee already has a referrer, don't change it
      if (referee.referrerId !== null) {
        Logger.info(
          `User ${refereeUserId} already has referrer ${referee.referrerId}, skipping`
        );
        return false;
      }

      // Parse refCode (should be telegram user ID)
      const referrerTelegramId = parseInt(refCode, 10);
      if (isNaN(referrerTelegramId)) {
        Logger.warn(`Invalid refCode format: ${refCode}`);
        return false;
      }

      // Find referrer by telegram ID
      const referrer = await userRepo.findOne({
        where: { telegramId: referrerTelegramId },
      });

      if (!referrer) {
        Logger.warn(`Referrer with telegramId ${referrerTelegramId} not found`);
        return false;
      }

      // Check self-referral
      if (referrer.id === referee.id) {
        Logger.warn(`Self-referral attempt by user ${refereeUserId}`);
        return false;
      }

      // Bind referrer
      referee.referrerId = referrer.id;
      await userRepo.save(referee);

      Logger.info(
        `Bound referrer ${referrer.id} (telegramId: ${referrerTelegramId}) to referee ${refereeUserId}`
      );

      return true;
    });
  }

  /**
   * Get referral link for user.
   *
   * @param userId - User ID
   * @returns Referral link
   * @throws {NotFoundError} If user not found
   */
  async getReferralLink(userId: number): Promise<string> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }

    // Use telegramId as referral code
    const refCode = user.telegramId.toString();
    const rawBot = config.BOT_USERNAME === "your_bot_name" ? "sephora_host_bot" : config.BOT_USERNAME;
    const botUsername = rawBot.replace(/^@/, "");
    return `https://t.me/${botUsername}?start=${refCode}`;
  }

  /**
   * Count referrals for user.
   *
   * @param userId - User ID (referrer)
   * @returns Number of referrals
   */
  async countReferrals(userId: number): Promise<number> {
    const count = await this.dataSource
      .getRepository(User)
      .count({
        where: { referrerId: userId },
      });

    return count;
  }

  /**
   * Get total referral income (sum of reward amounts) for a referrer.
   *
   * @param userId - User ID (referrer)
   * @returns Total profit from referrals
   */
  async getReferralIncome(userId: number): Promise<number> {
    const result = await this.dataSource
      .getRepository(ReferralReward)
      .createQueryBuilder("r")
      .select("COALESCE(SUM(r.rewardAmount), 0)", "total")
      .where("r.referrerId = :uid", { uid: userId })
      .getRawOne<{ total: string }>();
    return Math.round(Number(result?.total ?? 0) * 100) / 100;
  }

  /**
   * Apply referral reward on successful top-up (atomic transaction).
   * Validates:
   * - Amount > 10
   * - Referee has referrer
   * - Reward not already applied for this topUpId
   *
   * @param refereeId - User ID who made the top-up
   * @param topUpId - TopUp ID
   * @param amount - Top-up amount
   * @returns Reward amount if applied, or object with referrer info for notification; 0 if not applicable
   */
  async applyReferralRewardOnTopup(
    refereeId: number,
    topUpId: number,
    amount: number
  ): Promise<number | ReferralRewardApplied> {
    // Check amount threshold
    if (amount <= 10) {
      Logger.debug(
        `Top-up ${topUpId} amount ${amount} <= 10, skipping referral reward`
      );
      return 0;
    }

    return await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const rewardRepo = manager.getRepository(ReferralReward);

      // Check if reward already applied (using findOne with where clause)
      const existingReward = await rewardRepo.findOne({
        where: { topUpId: topUpId },
      });

      if (existingReward) {
        Logger.info(
          `Referral reward already applied for topUp ${topUpId}, skipping`
        );
        return 0;
      }

      // Get referee
      const referee = await userRepo.findOne({
        where: { id: refereeId },
      });

      if (!referee) {
        throw new NotFoundError("User", refereeId);
      }

      // Check if referee has referrer
      if (!referee.referrerId) {
        Logger.debug(`User ${refereeId} has no referrer, skipping reward`);
        return 0;
      }

      // Get referrer (need telegramId and lang for notification)
      const referrer = await userRepo.findOne({
        where: { id: referee.referrerId },
        select: ["id", "telegramId", "referralPercent", "referralBalance", "lang"],
      });

      if (!referrer) {
        Logger.warn(
          `Referrer ${referee.referrerId} not found for referee ${refereeId}`
        );
        return 0;
      }

      // Calculate reward: referrer's percentage or default 5%
      const percent = referrer.referralPercent != null ? referrer.referralPercent : 5;
      const rewardAmount = Math.round((amount * (percent / 100)) * 100) / 100;

      // Add to referral balance (for withdrawal), not to purchase balance
      referrer.referralBalance = (referrer.referralBalance ?? 0) + rewardAmount;
      await userRepo.save(referrer);

      // Create reward record
      const reward = new ReferralReward();
      reward.referrerId = referrer.id;
      reward.refereeId = referee.id;
      reward.topUpId = topUpId;
      reward.amount = amount;
      reward.rewardAmount = rewardAmount;
      await rewardRepo.save(reward);

      Logger.info(
        `Applied referral reward: ${rewardAmount} to referrer ${referrer.id} for topUp ${topUpId} (amount: ${amount})`
      );

      const referrerLang = referrer.lang === "en" ? "en" : "ru";
      return {
        rewardAmount,
        referrerTelegramId: referrer.telegramId,
        percent,
        referrerLang,
      };
    });
  }
}
