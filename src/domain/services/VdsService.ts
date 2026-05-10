/**
 * VDS service for managing virtual dedicated servers.
 *
 * @module domain/services/VdsService
 */

import { DataSource } from "typeorm";
import ms from "../../lib/multims";
import type { VmProvider } from "../../infrastructure/vmmanager/provider.js";
import { VdsRepository } from "../../infrastructure/db/repositories/VdsRepository";
import { BillingService } from "../billing/BillingService";
import VirtualDedicatedServer, {
  generatePassword,
  generateRandomName,
} from "../../entities/VirtualDedicatedServer";
import User from "../../entities/User";
import { NotFoundError, BusinessError, ExternalApiError } from "../../shared/errors/index";
import { Logger } from "../../app/logger";
import { retry } from "../../shared/utils/retry";
import { buildVdsProxmoxDescriptionLine } from "../../shared/vds-proxmox-label.js";

/**
 * VDS rate structure from prices.json.
 */
export interface VdsRate {
  name: string;
  cpu: number;
  ram: number; // GB
  ssd: number; // GB
  network: number; // Mbit/s
  price: {
    bulletproof: number;
    default: number;
  };
}

/**
 * Result of VDS creation.
 */
export interface CreateVdsResult {
  vds: VirtualDedicatedServer;
  price: number;
}

/**
 * VDS service for managing virtual dedicated servers.
 */
export class VdsService {
  constructor(
    private dataSource: DataSource,
    private vdsRepository: VdsRepository,
    private billingService: BillingService,
    private vmManager: VmProvider
  ) {}

  /**
   * Calculate VDS price based on rate and bulletproof mode.
   */
  calculatePrice(rate: VdsRate, bulletproof: boolean): number {
    return bulletproof ? rate.price.bulletproof : rate.price.default;
  }

  /**
   * Check if user has sufficient balance for VDS purchase.
   */
  async canAffordVds(
    userId: number,
    rate: VdsRate,
    bulletproof: boolean
  ): Promise<boolean> {
    const price = this.calculatePrice(rate, bulletproof);
    return await this.billingService.hasSufficientBalance(userId, price);
  }

  /**
   * Create and purchase VDS (atomic operation with transaction).
   *
   * @param userId - User ID
   * @param rate - VDS rate configuration
   * @param rateId - Rate ID (for reference)
   * @param osId - Operating system ID
   * @param bulletproof - Whether bulletproof mode is enabled
   * @returns Created VDS and price
   * @throws {NotFoundError} If user not found
   * @throws {BusinessError} If insufficient balance
   * @throws {ExternalApiError} If VMManager API fails
   */
  async createAndPurchaseVds(
    userId: number,
    rate: VdsRate,
    rateId: number,
    osId: number,
    bulletproof: boolean
  ): Promise<CreateVdsResult> {
    const price = this.calculatePrice(rate, bulletproof);

    // Check balance before starting
    if (!(await this.canAffordVds(userId, rate, bulletproof))) {
      const balance = await this.billingService.getBalance(userId);
      throw new BusinessError(
        `Insufficient balance. Required: ${price}, Available: ${balance}`
      );
    }

    // Generate credentials
    const password = generatePassword(12);
    const name = generateRandomName(13);

    // Create VM with retry
    const vmResult = await retry(
      () =>
        this.vmManager.createVM(
          name,
          password,
          rate.cpu,
          rate.ram,
          osId,
          `UserID:${userId},${rate.name}`,
          rate.ssd,
          1, // ipv4Count
          rate.network,
          rate.network
        ),
      {
        maxAttempts: 3,
        delayMs: 2000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error("Failed to create VM", error);
      throw new ExternalApiError(
        `Failed to create VM: ${error.message}`,
        "VMManager",
        error
      );
    });

    if (vmResult === false || !vmResult) {
      throw new ExternalApiError("VMManager returned false", "VMManager");
    }

    // Get VM info with retry
    const vmInfo = await retry(
      () => this.vmManager.getInfoVM(vmResult.id),
      {
        maxAttempts: 5,
        delayMs: 1000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error("Failed to get VM info", error);
      throw new ExternalApiError(
        `Failed to get VM info: ${error.message}`,
        "VMManager",
        error
      );
    });

    if (!vmInfo) {
      throw new ExternalApiError("VM info not available", "VMManager");
    }

    // Get IPv4 address with retry
    const ipv4Addrs = await retry(
      () => this.vmManager.getIpv4AddrVM(vmResult.id),
      {
        maxAttempts: 5,
        delayMs: 1000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error("Failed to get IPv4 address", error);
      throw new ExternalApiError(
        `Failed to get IPv4 address: ${error.message}`,
        "VMManager",
        error
      );
    });

    if (!ipv4Addrs || !ipv4Addrs.list || ipv4Addrs.list.length === 0) {
      throw new ExternalApiError("IPv4 address not available", "VMManager");
    }

    // Create VDS record and deduct balance in transaction
    return await this.dataSource.transaction(async (manager) => {
      const vdsRepo = manager.getRepository(VirtualDedicatedServer);
      const userRepo = manager.getRepository(User);

      // Create VDS entity
      const vds = new VirtualDedicatedServer();
      vds.vdsId = vmResult.id;
      vds.cpuCount = rate.cpu;
      vds.diskSize = rate.ssd;
      vds.rateName = rate.name;
      vds.expireAt = new Date(Date.now() + ms("30d"));
      vds.ramSize = rate.ram;
      vds.lastOsId = osId;
      vds.password = password;
      vds.networkSpeed = rate.network;
      vds.targetUserId = userId;
      vds.isBulletproof = bulletproof;
      vds.renewalPrice = price;
      vds.ipv4Addr = ipv4Addrs.list[0].ip_addr;
      vds.autoRenewEnabled = true;
      vds.adminBlocked = false;
      vds.managementLocked = false;
      vds.extraIpv4Count = 0;

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

      // Save both in transaction
      await userRepo.save(user);
      const savedVds = await vdsRepo.save(vds);

      Logger.info(
        `Created VDS ${savedVds.id} (VM ID: ${vds.vdsId}) for user ${userId}`
      );

      return {
        vds: savedVds,
        price,
      };
    });
  }

  /**
   * Get VDS by ID.
   */
  async getVdsById(vdsId: number): Promise<VirtualDedicatedServer> {
    const vds = await this.vdsRepository.findById(vdsId);
    if (!vds) {
      throw new NotFoundError("VirtualDedicatedServer", vdsId);
    }
    return vds;
  }

  /**
   * Get all VDS for a user.
   */
  async getUserVds(userId: number): Promise<VirtualDedicatedServer[]> {
    return await this.vdsRepository.findByUserId(userId);
  }

  /**
   * Reinstall OS on VDS.
   *
   * @param vdsId - VDS ID
   * @param osId - New OS ID
   * @returns Success status
   * @throws {NotFoundError} If VDS not found
   * @throws {ExternalApiError} If VMManager API fails
   */
  async reinstallOs(vdsId: number, osId: number): Promise<boolean> {
    const vds = await this.getVdsById(vdsId);
    if (vds.managementLocked) {
      throw new BusinessError("VDS management is locked (subscription expired). Renew first.");
    }
    if (vds.adminBlocked) {
      throw new BusinessError("VDS is blocked by administrator.");
    }

    const rootPassword = vds.password?.trim() || generatePassword(12);
    const proxmoxMarker = buildVdsProxmoxDescriptionLine(vds);
    const result = await retry(
      () => this.vmManager.reinstallOS(vds.vdsId, osId, rootPassword, proxmoxMarker),
      {
        maxAttempts: 3,
        delayMs: 2000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error(`Failed to reinstall OS on VDS ${vdsId}`, error);
      throw new ExternalApiError(
        `Failed to reinstall OS: ${error.message}`,
        "VMManager",
        error
      );
    });

    if (!result) {
      throw new ExternalApiError("OS reinstall failed", "VMManager");
    }

    if (
      typeof result === "object" &&
      result !== null &&
      "_rootPassword" in result &&
      typeof (result as { _rootPassword?: string })._rootPassword === "string"
    ) {
      const np = (result as { _rootPassword: string })._rootPassword;
      if (np) {
        vds.password = np;
      }
    } else {
      vds.password = rootPassword;
    }
    vds.lastOsId = osId;
    await this.vdsRepository.save(vds);

    Logger.info(`Reinstalled OS ${osId} on VDS ${vdsId}`);

    return true;
  }

  /**
   * Delete VDS (both from VMManager and database).
   *
   * @param vdsId - VDS ID
   * @returns Success status
   * @throws {NotFoundError} If VDS not found
   * @throws {ExternalApiError} If VMManager API fails
   */
  async deleteVds(vdsId: number): Promise<boolean> {
    const vds = await this.getVdsById(vdsId);

    // Delete from VMManager with retry
    await retry(
      () => this.vmManager.deleteVM(vds.vdsId),
      {
        maxAttempts: 3,
        delayMs: 2000,
        exponentialBackoff: true,
      }
    ).catch((error) => {
      Logger.error(`Failed to delete VM ${vds.vdsId}`, error);
      throw new ExternalApiError(
        `Failed to delete VM: ${error.message}`,
        "VMManager",
        error
      );
    });

    // Delete from database
    await this.vdsRepository.deleteById(vdsId);

    Logger.info(`Deleted VDS ${vdsId} (VM ID: ${vds.vdsId})`);

    return true;
  }

  /**
   * Rename VDS (update displayName).
   *
   * @param vdsId - VDS ID
   * @param userId - User ID (for authorization check)
   * @param displayName - New display name (3-32 characters, trimmed)
   * @returns Updated VDS
   * @throws {NotFoundError} If VDS not found
   * @throws {BusinessError} If user doesn't own VDS or invalid name
   */
  async renameVds(
    vdsId: number,
    userId: number,
    displayName: string
  ): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);

    // Check ownership
    if (vds.targetUserId !== userId) {
      throw new BusinessError("You don't own this VDS");
    }
    if (vds.managementLocked) {
      throw new BusinessError("VDS management is locked (subscription expired). Renew first.");
    }
    if (vds.adminBlocked) {
      throw new BusinessError("VDS is blocked by administrator.");
    }

    // Validate display name
    const trimmed = displayName.trim();
    if (trimmed.length < 3 || trimmed.length > 32) {
      throw new BusinessError("Display name must be between 3 and 32 characters");
    }

    // Check for newlines (shouldn't be in display name)
    if (trimmed.includes("\n") || trimmed.includes("\r")) {
      throw new BusinessError("Display name cannot contain line breaks");
    }

    vds.displayName = trimmed;
    await this.vdsRepository.save(vds);

    Logger.info(`Renamed VDS ${vdsId} to "${trimmed}" by user ${userId}`);

    return vds;
  }

  /**
   * Renew VDS (extend expiration and deduct balance).
   *
   * @param vdsId - VDS ID
   * @returns Success status
   * @throws {NotFoundError} If VDS not found
   * @throws {BusinessError} If insufficient balance
   */
  async renewVds(vdsId: number): Promise<boolean> {
    const vds = await this.getVdsById(vdsId);
    return this.renewVdsWithMonths(vdsId, vds.targetUserId, 1);
  }

  /**
   * Renew VDS for N months (`renewalPrice` is per month). Clears grace and management lock.
   */
  async renewVdsWithMonths(
    vdsId: number,
    userIdForOwnershipCheck: number,
    months: 1 | 3 | 6 | 12
  ): Promise<boolean> {
    const vds = await this.getVdsById(vdsId);

    if (vds.targetUserId !== userIdForOwnershipCheck) {
      throw new BusinessError("You don't own this VDS");
    }

    const total = Math.round(vds.renewalPrice * months * 100) / 100;

    if (!(await this.billingService.hasSufficientBalance(vds.targetUserId, total))) {
      const balance = await this.billingService.getBalance(vds.targetUserId);
      throw new BusinessError(
        `Insufficient balance for renewal. Required: ${total}, Available: ${balance}`
      );
    }

    const extendMs = months * ms("30d");

    await this.dataSource.transaction(async (manager) => {
      const vdsRepo = manager.getRepository(VirtualDedicatedServer);
      const userRepo = manager.getRepository(User);

      const user = await userRepo.findOne({
        where: { id: vds.targetUserId },
      });
      if (!user) {
        throw new NotFoundError("User", vds.targetUserId);
      }

      user.balance -= total;

      const base =
        vds.expireAt.getTime() > Date.now() ? vds.expireAt.getTime() : Date.now();
      vds.expireAt = new Date(base + extendMs);
      vds.payDayAt = null;
      vds.managementLocked = false;

      await userRepo.save(user);
      await vdsRepo.save(vds);
    });

    try {
      await retry(
        () => this.vmManager.startVM(vds.vdsId),
        { maxAttempts: 2, delayMs: 1500, exponentialBackoff: true }
      );
    } catch {
      Logger.warn(`Could not start VM ${vds.vdsId} after renewal`);
    }

    Logger.info(`Renewed VDS ${vdsId} for ${months} mo, user ${vds.targetUserId}`);

    return true;
  }

  /** Toggle auto-renewal flag (owner). */
  async setAutoRenewEnabled(
    vdsId: number,
    userId: number,
    enabled: boolean
  ): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);
    if (vds.targetUserId !== userId) {
      throw new BusinessError("You don't own this VDS");
    }
    vds.autoRenewEnabled = enabled;
    await this.vdsRepository.save(vds);
    return vds;
  }

  /** Price per extra IPv4 (USD) from env, default 2. */
  getExtraIpv4UnitPrice(): number {
    const raw = process.env.VDS_EXTRA_IPV4_PRICE_USD;
    const n = raw != null && raw !== "" ? parseFloat(raw) : 2;
    return Number.isFinite(n) && n > 0 ? n : 2;
  }

  /**
   * Purchase one extra IPv4 (billing + DB). VM attach may require manual/API follow-up.
   */
  async purchaseExtraIpv4(vdsId: number, userId: number): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);
    if (vds.targetUserId !== userId) {
      throw new BusinessError("You don't own this VDS");
    }
    if (vds.managementLocked) {
      throw new BusinessError("Management is locked for this VDS; renew first.");
    }
    if (vds.adminBlocked) {
      throw new BusinessError("This VDS is blocked by administrator.");
    }
    if (vds.extraIpv4Count >= 9) {
      throw new BusinessError("Maximum extra IPv4 count reached (10 IPs total).");
    }

    const price = this.getExtraIpv4UnitPrice();
    if (!(await this.billingService.hasSufficientBalance(userId, price))) {
      throw new BusinessError("Insufficient balance for extra IPv4.");
    }

    await this.dataSource.transaction(async (manager) => {
      const vdsRepo = manager.getRepository(VirtualDedicatedServer);
      const userRepo = manager.getRepository(User);
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) throw new NotFoundError("User", userId);
      user.balance -= price;
      vds.extraIpv4Count += 1;
      await userRepo.save(user);
      await vdsRepo.save(vds);
    });

    const apiOk = await this.vmManager.addIpv4ToHost(vds.vdsId);
    if (!apiOk) {
      Logger.warn(
        `VDS ${vdsId}: extra IPv4 billed in DB; VMmanager addIpv4 API failed — check panel or API version`
      );
    }

    Logger.info(`VDS ${vdsId}: extra IPv4 purchased, count=${vds.extraIpv4Count}`);
    return await this.getVdsById(vdsId);
  }

  /** Admin: transfer VDS to another user (DB only). */
  async adminTransferVds(vdsId: number, newUserId: number): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);
    const userRepo = this.dataSource.getRepository(User);
    const target = await userRepo.findOne({ where: { id: newUserId } });
    if (!target) {
      throw new NotFoundError("User", newUserId);
    }
    vds.targetUserId = newUserId;
    await this.vdsRepository.save(vds);
    return vds;
  }

  /** Admin: block or unblock user actions. */
  async adminSetBlocked(vdsId: number, blocked: boolean): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);
    vds.adminBlocked = blocked;
    await this.vdsRepository.save(vds);
    return vds;
  }

  /** Admin: extend paid-until by days from now (or from current expire if later). */
  async adminExtendByDays(vdsId: number, days: number): Promise<VirtualDedicatedServer> {
    const vds = await this.getVdsById(vdsId);
    const add = days * ms("1d");
    const base = Math.max(Date.now(), vds.expireAt.getTime());
    vds.expireAt = new Date(base + add);
    vds.payDayAt = null;
    vds.managementLocked = false;
    await this.vdsRepository.save(vds);
    return vds;
  }
}
