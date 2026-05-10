/**
 * Expiration service for checking and renewing expired services.
 *
 * @module domain/services/ExpirationService
 */

import type { Bot, Api, RawApi } from "grammy";
import { DataSource } from "typeorm";
import type { FluentTranslator } from "../../fluent.js";
import ms from "../../lib/multims.js";
import { getAppDataSource } from "../../infrastructure/db/datasource.js";
import { VdsRepository } from "../../infrastructure/db/repositories/VdsRepository.js";
import { DomainRequestRepository } from "../../infrastructure/db/repositories/DomainRequestRepository.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import type { VmProvider } from "../../infrastructure/vmmanager/provider.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DomainRequest, { DomainRequestStatus } from "../../entities/DomainRequest.js";
import User from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { retry } from "../../shared/utils/retry.js";

/** Callback when grace period starts (3 days left). Used for growth trigger discount. */
export type OnGracePeriodStarted = (
  userId: number,
  serviceId: number,
  serviceType: "vds" | "dedicated" | "domain"
) => Promise<void>;

/** Callback when VDS is in grace (payDayAt set). Used for Day 2 / Day 3 retarget messages. */
export type OnGraceDayCheck = (
  vdsId: number,
  userId: number,
  telegramId: number,
  payDayAt: Date
) => Promise<boolean>;

/**
 * Service for handling expiration and renewal of services.
 */
export class ExpirationService {
  private intervalId?: NodeJS.Timeout;
  private readonly checkIntervalMs = ms("1d"); // Check once per day

  constructor(
    private bot: Bot<any, Api<RawApi>>,
    private vmManager: VmProvider,
    private fluent: FluentTranslator,
    private onGracePeriodStarted?: OnGracePeriodStarted,
    private onGraceDayCheck?: OnGraceDayCheck
  ) {}

  /**
   * Start the expiration checker.
   */
  start(): void {
    if (this.intervalId) {
      Logger.warn("ExpirationService already started");
      return;
    }

    Logger.info("Starting ExpirationService");

    // Check immediately on start
    this.checkExpirations().catch((error) => {
      Logger.error("Error in ExpirationService initial check", error);
    });

    // Then check periodically
    this.intervalId = setInterval(() => {
      this.checkExpirations().catch((error) => {
        Logger.error("Error in ExpirationService periodic check", error);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the expiration checker.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      Logger.info("ExpirationService stopped");
    }
  }

  /**
   * Check and handle expired services.
   */
  private async checkExpirations(): Promise<void> {
    Logger.debug("Checking expired services...");

    const dataSource = await getAppDataSource();
    const vdsRepo = new VdsRepository(dataSource);
    const domainRequestRepo = new DomainRequestRepository(dataSource);
    const userRepo = new UserRepository(dataSource);

    // Check expired VDS
    await this.checkExpiredVds(vdsRepo, userRepo, dataSource);

    // Check expired domain requests
    await this.checkExpiredDomains(domainRequestRepo, userRepo, dataSource);
  }

  /**
   * Check and handle expired VDS.
   */
  private async checkExpiredVds(
    vdsRepo: VdsRepository,
    userRepo: UserRepository,
    dataSource: DataSource
  ): Promise<void> {
    const expiredVds = await vdsRepo.findExpired();

    if (expiredVds.length === 0) {
      return;
    }

    Logger.info(`Found ${expiredVds.length} expired VDS to process`);

    for (const vds of expiredVds) {
      try {
        const user = await userRepo.findById(vds.targetUserId);
        if (!user) {
          Logger.warn(`User ${vds.targetUserId} not found for VDS ${vds.id}`);
          continue;
        }

        const autoRenewOn = vds.autoRenewEnabled !== false;
        const canAutoRenew =
          autoRenewOn && user.balance >= vds.renewalPrice;

        if (canAutoRenew) {
          await dataSource.transaction(async (manager) => {
            const vdsManager = manager.getRepository(VirtualDedicatedServer);
            const userManager = manager.getRepository(User);

            const updatedUser = await userManager.findOne({ where: { id: user.id } });
            const updatedVds = await vdsManager.findOne({ where: { id: vds.id } });

            if (!updatedUser || !updatedVds) {
              throw new Error("User or VDS not found during renewal");
            }

            updatedUser.balance -= vds.renewalPrice;
            const base = Math.max(Date.now(), updatedVds.expireAt.getTime());
            updatedVds.expireAt = new Date(base + ms("30d"));
            updatedVds.payDayAt = null;
            updatedVds.managementLocked = false;

            await userManager.save(updatedUser);
            await vdsManager.save(updatedVds);
          });

          try {
            await retry(
              () => this.vmManager.startVM(vds.vdsId),
              { maxAttempts: 2, delayMs: 1500, exponentialBackoff: true }
            );
          } catch {
            Logger.warn(`Could not start VM ${vds.vdsId} after auto-renew`);
          }

          await this.notifyUser(user.telegramId, user.lang || "ru", "vds-autorenew-notify", {
            vdsId: vds.id,
            amount: vds.renewalPrice,
          });

          Logger.info(`VDS ${vds.id} auto-renewed for user ${user.id}`);
          continue;
        }

        // No auto-renew: lock management, stop VM once, grace period
        if (!vds.managementLocked) {
          vds.managementLocked = true;
          try {
            await retry(
              () => this.vmManager.stopVM(vds.vdsId),
              { maxAttempts: 3, delayMs: 2000, exponentialBackoff: true }
            );
          } catch (error) {
            Logger.error(`Failed to stop VM ${vds.vdsId} on expiry for VDS ${vds.id}`, error);
          }
        }

        if (!vds.payDayAt) {
          vds.payDayAt = new Date(Date.now() + ms("3d"));
          await vdsRepo.save(vds);

          const missing = Math.max(0, Math.round((vds.renewalPrice - user.balance) * 100) / 100);
          let graceKey: "vds-grace-insufficient" | "vds-grace-autorenew-off" | "vds-expiration" =
            "vds-expiration";
          const graceArgs: Record<string, string | number> = {
            amount: vds.renewalPrice,
            vdsId: vds.id,
          };
          if (autoRenewOn && user.balance < vds.renewalPrice) {
            graceKey = "vds-grace-insufficient";
            graceArgs.missing = missing;
          } else if (!autoRenewOn) {
            graceKey = "vds-grace-autorenew-off";
          }

          await this.notifyUser(user.telegramId, user.lang || "ru", graceKey, graceArgs);
          if (this.onGracePeriodStarted) {
            this.onGracePeriodStarted(user.id, vds.id, "vds").catch((e) =>
              Logger.error(`[Expiration] onGracePeriodStarted failed`, e)
            );
          }
          try {
            const { emit } = await import("../../modules/automations/engine/event-bus.js");
            const ts = new Date();
            emit({
              event: "service.expiring",
              userId: user.id,
              timestamp: ts,
              serviceType: "vds",
              serviceId: vds.id,
              payDayAt: vds.payDayAt,
              graceDay: 1,
            });
            emit({
              event: "service.grace_start",
              userId: user.id,
              timestamp: ts,
              serviceType: "vds",
              serviceId: vds.id,
              payDayAt: vds.payDayAt,
              graceDay: 1,
            });
          } catch {
            // automations optional
          }
          Logger.info(`VDS ${vds.id} expired: VM stopped, grace 3d (user ${user.id})`);
          continue;
        }

        await vdsRepo.save(vds);

        if (vds.payDayAt && new Date(vds.payDayAt).getTime() <= Date.now()) {
          const deletedId = vds.id;
          await retry(
            () => this.vmManager.deleteVM(vds.vdsId),
            {
              maxAttempts: 3,
              delayMs: 2000,
              exponentialBackoff: true,
            }
          ).catch((error) => {
            Logger.error(`Failed to delete VM ${vds.vdsId} for VDS ${vds.id}`, error);
          });

          await this.notifyUser(user.telegramId, user.lang || "ru", "vds-deleted-after-grace", {
            vdsId: deletedId,
          });

          await vdsRepo.deleteById(vds.id);
          Logger.info(`VDS ${vds.id} deleted (grace period expired)`);
          continue;
        }

        if (this.onGraceDayCheck && vds.payDayAt) {
          this.onGraceDayCheck(vds.id, user.id, user.telegramId, vds.payDayAt).catch((e) =>
            Logger.error(`[Expiration] onGraceDayCheck failed`, e)
          );
        }
      } catch (error) {
        Logger.error(`Failed to process expired VDS ${vds.id}`, error);
      }
    }
  }

  /**
   * Check and handle expired domain requests.
   */
  private async checkExpiredDomains(
    domainRequestRepo: DomainRequestRepository,
    userRepo: UserRepository,
    dataSource: DataSource
  ): Promise<void> {
    const expiring = await domainRequestRepo.findExpiringSoon();

    if (expiring.length === 0) {
      return;
    }

    Logger.info(`Found ${expiring.length} domain requests to process for renewal`);

    for (const request of expiring) {
      try {
        const user = await userRepo.findById(request.target_user_id);
        if (!user) {
          Logger.warn(`User ${request.target_user_id} not found for domain request ${request.id}`);
          continue;
        }

        // If user has insufficient balance
        if (user.balance < request.price) {
          request.status = DomainRequestStatus.Expired;
          await domainRequestRepo.save(request);
          Logger.info(`Domain request ${request.id} expired (insufficient balance)`);
          continue;
        }

        // Auto-renew domain request
        await dataSource.transaction(async (manager) => {
          const domainManager = manager.getRepository(DomainRequest);
          const userManager = manager.getRepository(User);

          const updatedUser = await userManager.findOne({ where: { id: user.id } });
          const updatedRequest = await domainManager.findOne({ where: { id: request.id } });

          if (!updatedUser || !updatedRequest) {
            throw new Error("User or domain request not found during renewal");
          }

          updatedUser.balance -= request.price;
          const now = Date.now();
          updatedRequest.expireAt = new Date(now + ms("1y"));
          updatedRequest.payday_at = new Date(now + ms("360d"));

          await userManager.save(updatedUser);
          await domainManager.save(updatedRequest);
        });

        Logger.info(`Domain request ${request.id} auto-renewed for user ${user.id}`);
      } catch (error) {
        Logger.error(`Failed to process expired domain request ${request.id}`, error);
        // Continue with other domains
      }
    }
  }

  /**
   * Notify user about expiration.
   */
  private async notifyUser(
    telegramId: number,
    locale: string,
    key: string,
    args?: Record<string, string | number>
  ): Promise<void> {
    try {
      const message = this.fluent.translate(locale, key, (args || {}) as Record<string, string | number>);
      await this.bot.api.sendMessage(telegramId, message, {
        parse_mode: "HTML",
      });
    } catch (error) {
      Logger.error(`Failed to notify user ${telegramId}`, error);
    }
  }
}
