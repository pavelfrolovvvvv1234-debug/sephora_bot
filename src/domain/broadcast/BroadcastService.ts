/**
 * BroadcastService for sending messages to all users.
 *
 * @module domain/broadcast/BroadcastService
 */

import { DataSource } from "typeorm";
import Broadcast, { BroadcastStatus } from "../../entities/Broadcast.js";
import BroadcastLog, { BroadcastLogStatus } from "../../entities/BroadcastLog.js";
import User from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import type { Bot } from "grammy";

/**
 * Broadcast service for managing message broadcasts.
 */
export class BroadcastService {
  constructor(
    private dataSource: DataSource,
    private bot: Bot
  ) {}

  private async sendMessageSafe(telegramId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(telegramId, text, { parse_mode: "HTML" });
    } catch (error: any) {
      const description = error?.description || error?.message || "";
      if (description.includes("can't parse entities")) {
        await this.bot.api.sendMessage(telegramId, text);
        return;
      }
      throw error;
    }
  }

  /**
   * Create a new broadcast.
   *
   * @param adminId - Admin user ID
   * @param text - Message text
   * @returns Created broadcast
   */
  async createBroadcast(adminId: number, text: string): Promise<Broadcast> {
    const broadcastRepo = this.dataSource.getRepository(Broadcast);
    const userRepo = this.dataSource.getRepository(User);

    // Get total user count
    const totalCount = await userRepo.count();

    const broadcast = new Broadcast();
    broadcast.adminId = adminId;
    broadcast.text = text;
    broadcast.status = BroadcastStatus.NEW;
    broadcast.totalCount = totalCount;
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    broadcast.blockedCount = 0;

    const saved = await broadcastRepo.save(broadcast);
    Logger.info(`Created broadcast ${saved.id} by admin ${adminId}`);

    return saved;
  }

  /**
   * Send broadcast to all users with rate limiting and error handling.
   *
   * @param broadcastId - Broadcast ID
   * @returns Final broadcast status
   */
  async sendBroadcast(broadcastId: number): Promise<Broadcast> {
    const broadcastRepo = this.dataSource.getRepository(Broadcast);
    const broadcastLogRepo = this.dataSource.getRepository(BroadcastLog);
    const userRepo = this.dataSource.getRepository(User);

    const broadcast = await broadcastRepo.findOne({ where: { id: broadcastId } });
    if (!broadcast) {
      throw new Error(`Broadcast ${broadcastId} not found`);
    }

    // Update status to sending
    broadcast.status = BroadcastStatus.SENDING;
    await broadcastRepo.save(broadcast);

    // Get all users
    const users = await userRepo.find();

    Logger.info(`Starting broadcast ${broadcastId} to ${users.length} users`);

    // Send in batches with delay
    const BATCH_SIZE = 10;
    const DELAY_MS = 1000; // 1 second between batches

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (user) => {
          const log = new BroadcastLog();
          log.broadcastId = broadcastId;
          log.userId = user.id;
          log.status = BroadcastLogStatus.PENDING;

          try {
            await this.sendMessageSafe(user.telegramId, broadcast.text);

            log.status = BroadcastLogStatus.SENT;
            broadcast.sentCount++;
            await broadcastLogRepo.save(log);
          } catch (error: any) {
            const errorMessage = error?.description || error?.message || String(error);

            // Check for specific errors
            if (
              errorMessage.includes("blocked") ||
              errorMessage.includes("chat not found") ||
              errorMessage.includes("user is deactivated")
            ) {
              log.status = BroadcastLogStatus.BLOCKED;
              log.error = errorMessage;
              broadcast.blockedCount++;
              await broadcastLogRepo.save(log);
            } else if (error?.error_code === 429) {
              // Rate limit - retry after delay for this specific user
              const retryAfter = error?.parameters?.retry_after || 60;
              Logger.warn(`Rate limit hit for user ${user.id}, waiting ${retryAfter}s`);
              
              // Wait for rate limit
              await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

              // Retry once
              try {
                await this.sendMessageSafe(user.telegramId, broadcast.text);
                log.status = BroadcastLogStatus.SENT;
                broadcast.sentCount++;
                await broadcastLogRepo.save(log);
              } catch (retryError: any) {
                log.status = BroadcastLogStatus.FAILED;
                log.error = retryError?.description || retryError?.message || String(retryError);
                broadcast.failedCount++;
                await broadcastLogRepo.save(log);
              }
            } else {
              log.status = BroadcastLogStatus.FAILED;
              log.error = errorMessage;
              broadcast.failedCount++;
              await broadcastLogRepo.save(log);
            }
          }
        })
      );

      // Update broadcast progress
      await broadcastRepo.save(broadcast);

      // Delay between batches
      if (i + BATCH_SIZE < users.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    }

    // Final status
    broadcast.status = BroadcastStatus.DONE;
    await broadcastRepo.save(broadcast);

    Logger.info(
      `Broadcast ${broadcastId} completed: ${broadcast.sentCount} sent, ${broadcast.failedCount} failed, ${broadcast.blockedCount} blocked`
    );

    return broadcast;
  }

  /**
   * Get broadcast by ID.
   *
   * @param broadcastId - Broadcast ID
   * @returns Broadcast or null
   */
  async getBroadcastById(broadcastId: number): Promise<Broadcast | null> {
    const broadcastRepo = this.dataSource.getRepository(Broadcast);
    return broadcastRepo.findOne({ where: { id: broadcastId } });
  }

  /**
   * Get all broadcasts.
   *
   * @param limit - Limit results
   * @returns List of broadcasts
   */
  async getAllBroadcasts(limit: number = 50): Promise<Broadcast[]> {
    const broadcastRepo = this.dataSource.getRepository(Broadcast);
    return broadcastRepo.find({
      order: { createdAt: "DESC" },
      take: limit,
    });
  }

  /**
   * Send message to all users in a segment (for growth/targeted broadcast).
   *
   * @param segment - Segment name: active_vps | domain_only | inactive_30d | high_spender | new_user
   * @param message - HTML message text
   * @returns Count of users sent to
   */
  async sendToSegment(segment: string, message: string): Promise<{ sent: number; failed: number }> {
    const { SegmentService } = await import("../../modules/growth/segment.service.js");
    const segmentService = new SegmentService(this.dataSource);
    const userIds = await segmentService.getUserIdsBySegment(segment as any, 10_000);
    const userRepo = this.dataSource.getRepository(User);
    if (userIds.length === 0) return { sent: 0, failed: 0 };
    const users = await userRepo
      .createQueryBuilder("u")
      .select(["u.id", "u.telegramId"])
      .where("u.id IN (:...ids)", { ids: userIds })
      .getMany();
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 10;
    const DELAY_MS = 1000;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (user) => {
          try {
            await this.sendMessageSafe(user.telegramId, message);
            sent++;
          } catch (error: any) {
            failed++;
          }
        })
      );
      if (i + BATCH_SIZE < users.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    }
    return { sent, failed };
  }

  /**
   * Get broadcast errors summary.
   *
   * @param broadcastId - Broadcast ID
   * @returns Error summary
   */
  async getBroadcastErrors(broadcastId: number): Promise<string[]> {
    const broadcastLogRepo = this.dataSource.getRepository(BroadcastLog);
    const logs = await broadcastLogRepo.find({
      where: {
        broadcastId,
        status: BroadcastLogStatus.FAILED,
      },
      take: 10,
    });

    const errors = new Set<string>();
    for (const log of logs) {
      if (log.error) {
        errors.add(log.error);
      }
    }

    return Array.from(errors);
  }
}
