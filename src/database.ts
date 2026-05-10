import { DataSource } from "typeorm";
import User from "./entities/User";
import TempLink from "./entities/TempLink";
import TopUp from "./entities/TopUp";
import DomainRequest from "./entities/DomainRequest";
import Promo from "./entities/Promo";
import VirtualDedicatedServer from "./entities/VirtualDedicatedServer";
import Ticket from "./entities/Ticket";
import Broadcast from "./entities/Broadcast";
import BroadcastLog from "./entities/BroadcastLog";
import DedicatedServer from "./entities/DedicatedServer";
import TicketAudit from "./entities/TicketAudit";
import Domain from "./entities/Domain";
import DomainOperation from "./entities/DomainOperation";
import ReferralReward from "./entities/ReferralReward";
import ServiceInvoice from "./entities/ServiceInvoice";
import CdnProxyService from "./entities/CdnProxyService";
import CdnProxyAudit from "./entities/CdnProxyAudit";
import AutomationScenario from "./entities/automations/AutomationScenario";
import ScenarioVersion from "./entities/automations/ScenarioVersion";
import UserNotificationState from "./entities/automations/UserNotificationState";
import OfferInstance from "./entities/automations/OfferInstance";
import AutomationEventLog from "./entities/automations/AutomationEventLog";
import ScenarioMetric from "./entities/automations/ScenarioMetric";
import AdminSetting from "./entities/AdminSetting";

const AppDataSource = new DataSource({
  type: "better-sqlite3",
  database: "data.db",
  synchronize: true,
  entities: [
    User,
    TempLink,
    TopUp,
    DomainRequest,
    Promo,
    VirtualDedicatedServer,
    Ticket,
    Broadcast,
    BroadcastLog,
    DedicatedServer,
    TicketAudit,
    Domain,
    DomainOperation,
    ReferralReward,
    ServiceInvoice,
    CdnProxyService,
    CdnProxyAudit,
    AutomationScenario,
    ScenarioVersion,
    UserNotificationState,
    OfferInstance,
    AutomationEventLog,
    ScenarioMetric,
    AdminSetting,
  ],
  enableWAL: true,
});

export async function getAppDataSource() {
  if (AppDataSource.isInitialized) {
    return AppDataSource;
  }
  return await AppDataSource.initialize();
}
