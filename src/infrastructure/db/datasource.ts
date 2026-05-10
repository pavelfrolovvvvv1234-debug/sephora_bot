/**
 * TypeORM DataSource configuration and initialization.
 *
 * @module infrastructure/db/datasource
 */

import { DataSource } from "typeorm";
import User from "../../entities/User.js";
import TempLink from "../../entities/TempLink.js";
import TopUp from "../../entities/TopUp.js";
import DomainRequest from "../../entities/DomainRequest.js";
import Promo from "../../entities/Promo.js";
import VirtualDedicatedServer from "../../entities/VirtualDedicatedServer.js";
import DomainService from "../../entities/DomainService.js";
import Ticket from "../../entities/Ticket.js";
import Broadcast from "../../entities/Broadcast.js";
import BroadcastLog from "../../entities/BroadcastLog.js";
import DedicatedServer from "../../entities/DedicatedServer.js";
import TicketAudit from "../../entities/TicketAudit.js";
import Domain from "../../entities/Domain.js";
import DomainOperation from "../../entities/DomainOperation.js";
import ReferralReward from "../../entities/ReferralReward.js";
import ServiceInvoice from "../../entities/ServiceInvoice.js";
import GrowthEvent from "../../entities/GrowthEvent.js";
import CdnProxyService from "../../entities/CdnProxyService.js";
import CdnProxyAudit from "../../entities/CdnProxyAudit.js";
import DedicatedServerOrder from "../../entities/DedicatedServerOrder.js";
import ProvisioningTicket from "../../entities/ProvisioningTicket.js";
import ProvisioningTicketStatusHistory from "../../entities/ProvisioningTicketStatusHistory.js";
import ProvisioningTicketNote from "../../entities/ProvisioningTicketNote.js";
import ProvisioningTicketAssignment from "../../entities/ProvisioningTicketAssignment.js";
import ProvisioningTicketChecklist from "../../entities/ProvisioningTicketChecklist.js";
import ProvisioningTicketEvent from "../../entities/ProvisioningTicketEvent.js";
import {
  AutomationScenario,
  ScenarioVersion,
  UserNotificationState,
  OfferInstance,
  AutomationEventLog,
  ScenarioMetric,
} from "../../entities/automations/index.js";
import { Logger } from "../../app/logger.js";
import AdminAuditLog from "../../entities/AdminAuditLog.js";
import { runRoleModelMigration } from "./role-migration.js";
import { runProvisioningStatusMigration } from "./provisioning-status-migration.js";
import { dedupeVdslistDuplicateVdsIds } from "./vdslist-dedupe.js";

/**
 * TypeORM DataSource singleton instance.
 */
const AppDataSource = new DataSource({
  type: "better-sqlite3",
  database: "data.db",
  synchronize: true, // TODO: Use migrations in production
  entities: [
    User,
    TempLink,
    TopUp,
    DomainRequest,
    Promo,
    VirtualDedicatedServer,
    DomainService,
    Ticket,
    Broadcast,
    BroadcastLog,
    DedicatedServer,
    TicketAudit,
    Domain,
    DomainOperation,
    ReferralReward,
    ServiceInvoice,
    GrowthEvent,
    CdnProxyService,
    CdnProxyAudit,
    DedicatedServerOrder,
    ProvisioningTicket,
    ProvisioningTicketStatusHistory,
    ProvisioningTicketNote,
    ProvisioningTicketAssignment,
    ProvisioningTicketChecklist,
    ProvisioningTicketEvent,
    AutomationScenario,
    ScenarioVersion,
    UserNotificationState,
    OfferInstance,
    AutomationEventLog,
    ScenarioMetric,
    AdminAuditLog,
  ],
  enableWAL: true,
  logging: false,
});

let initialized = false;

/**
 * Get or initialize the application DataSource.
 * Ensures only one initialization attempt.
 *
 * @returns {Promise<DataSource>} Initialized DataSource instance
 * @throws {Error} If DataSource initialization fails
 */
export async function getAppDataSource(): Promise<DataSource> {
  if (AppDataSource.isInitialized) {
    return AppDataSource;
  }

  if (!initialized) {
    initialized = true;
    try {
      const dbPath =
        typeof AppDataSource.options.database === "string"
          ? AppDataSource.options.database
          : "data.db";
      dedupeVdslistDuplicateVdsIds(dbPath);

      await AppDataSource.initialize();
      await runRoleModelMigration(AppDataSource);
      await runProvisioningStatusMigration(AppDataSource);
      Logger.info("Database DataSource initialized successfully");
    } catch (error) {
      Logger.error("Failed to initialize DataSource", error);
      initialized = false;
      throw error;
    }
  }

  return AppDataSource;
}

/**
 * Close the DataSource connection gracefully.
 *
 * @returns {Promise<void>}
 */
export async function closeDataSource(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
    Logger.info("Database DataSource closed");
  }
}
