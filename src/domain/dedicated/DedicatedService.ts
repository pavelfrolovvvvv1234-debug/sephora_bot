/**
 * DedicatedService for managing dedicated server provisioning.
 *
 * @module domain/dedicated/DedicatedService
 */

import { DataSource } from "typeorm";
import DedicatedServer, { DedicatedServerStatus } from "../../entities/DedicatedServer.js";
import { NotFoundError } from "../../shared/errors/index.js";
import { Logger } from "../../app/logger.js";

/**
 * Dedicated server service for managing dedicated server lifecycle.
 */
export class DedicatedService {
  constructor(private dataSource: DataSource) {}

  /**
   * Get dedicated server by ID.
   *
   * @param dedicatedId - Dedicated server ID
   * @returns Dedicated server or null
   */
  async getDedicatedById(dedicatedId: number): Promise<DedicatedServer | null> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
    return dedicatedRepo.findOne({ where: { id: dedicatedId } });
  }

  /**
   * Get dedicated servers by user ID.
   *
   * @param userId - User ID
   * @returns List of dedicated servers
   */
  async getDedicatedByUserId(userId: number): Promise<DedicatedServer[]> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
    return dedicatedRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Get active dedicated server for user.
   *
   * @param userId - User ID
   * @returns Active dedicated server or null
   */
  async getActiveDedicatedByUserId(userId: number): Promise<DedicatedServer | null> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);
    return dedicatedRepo.findOne({
      where: {
        userId,
        status: DedicatedServerStatus.ACTIVE,
      },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Create dedicated server request (linked to ticket).
   *
   * @param userId - User ID
   * @param ticketId - Ticket ID
   * @param label - Optional label
   * @returns Created dedicated server
   */
  async createDedicatedRequest(
    userId: number,
    ticketId: number,
    label?: string
  ): Promise<DedicatedServer> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);

    const dedicated = new DedicatedServer();
    dedicated.userId = userId;
    dedicated.ticketId = ticketId;
    dedicated.status = DedicatedServerStatus.REQUESTED;
    dedicated.label = label || null;
    dedicated.credentials = null;

    const saved = await dedicatedRepo.save(dedicated);
    Logger.info(`Created dedicated server request ${saved.id} for user ${userId}, ticket ${ticketId}`);

    return saved;
  }

  /**
   * Update dedicated server credentials.
   *
   * @param dedicatedId - Dedicated server ID
   * @param credentials - Credentials object
   * @returns Updated dedicated server
   */
  async updateCredentials(
    dedicatedId: number,
    credentials: Record<string, any>
  ): Promise<DedicatedServer> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);

    const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
    if (!dedicated) {
      throw new NotFoundError("DedicatedServer", dedicatedId);
    }

    dedicated.credentials = JSON.stringify(credentials);
    dedicated.status = DedicatedServerStatus.ACTIVE;
    await dedicatedRepo.save(dedicated);

    Logger.info(`Updated credentials for dedicated server ${dedicatedId}`);
    return dedicated;
  }

  /**
   * Suspend dedicated server.
   *
   * @param dedicatedId - Dedicated server ID
   * @returns Updated dedicated server
   */
  async suspendDedicated(dedicatedId: number): Promise<DedicatedServer> {
    const dedicatedRepo = this.dataSource.getRepository(DedicatedServer);

    const dedicated = await dedicatedRepo.findOne({ where: { id: dedicatedId } });
    if (!dedicated) {
      throw new NotFoundError("DedicatedServer", dedicatedId);
    }

    dedicated.status = DedicatedServerStatus.SUSPENDED;
    await dedicatedRepo.save(dedicated);

    Logger.info(`Suspended dedicated server ${dedicatedId}`);
    return dedicated;
  }
}
