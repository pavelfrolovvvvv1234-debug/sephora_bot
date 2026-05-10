import { DataSource } from "typeorm";
import DedicatedServerOrder, {
  DedicatedOrderPaymentStatus,
} from "../../entities/DedicatedServerOrder.js";
import ProvisioningTicket, {
  ProvisioningTicketStatus,
} from "../../entities/ProvisioningTicket.js";
import ProvisioningTicketStatusHistory from "../../entities/ProvisioningTicketStatusHistory.js";
import ProvisioningTicketAssignment from "../../entities/ProvisioningTicketAssignment.js";
import ProvisioningTicketChecklist from "../../entities/ProvisioningTicketChecklist.js";
import ProvisioningTicketNote from "../../entities/ProvisioningTicketNote.js";
import ProvisioningTicketEvent from "../../entities/ProvisioningTicketEvent.js";
import { Role } from "../../entities/User.js";

export type DedicatedSelectionConfig = {
  productId: string;
  productName: string;
  category?: string | null;
  cpuModel?: string | null;
  cpuCores?: number | null;
  cpuThreads?: number | null;
  ram?: string | null;
  storageType?: string | null;
  storageSize?: string | null;
  diskCount?: number | null;
  raidOption?: string | null;
  bandwidth?: string | null;
  uplinkSpeed?: string | null;
  trafficPackage?: string | null;
  unmeteredTraffic?: boolean | null;
  locationKey?: string | null;
  locationLabel?: string | null;
  country?: string | null;
  requestedIpCount?: number | null;
  osKey?: string | null;
  osLabel?: string | null;
  controlPanel?: string | null;
  extras?: string[] | null;
  ddosProtection?: string | null;
  customHostname?: string | null;
  reverseDns?: string | null;
  sshKey?: string | null;
  loginPreference?: string | null;
  deploymentNotes?: string | null;
  intendedUse?: string | null;
  addons?: Record<string, unknown> | null;
};

export type CreateProvisioningInput = {
  userId: number;
  telegramUserId?: number | null;
  telegramUsername?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  customerLanguage?: string | null;
  customerNotes?: string | null;
  balanceUsedAmount?: number | null;
  paymentAmount: number;
  currency?: string;
  paymentMethod?: string | null;
  paymentStatus: DedicatedOrderPaymentStatus;
  paymentId?: string | null;
  transactionId?: string | null;
  billingCycle?: string;
  promoCode?: string | null;
  discountAmount?: number | null;
  idempotencyKey?: string | null;
  /** Admin/mod purchases: do not count toward user «orders» in control panel. */
  excludeFromUserStats?: boolean;
  config: DedicatedSelectionConfig;
};

export const PROVISIONING_CHECKLIST_KEYS = [
  "payment_verified",
  "order_reviewed",
  "stock_checked",
  "hardware_reserved",
  "os_installed",
  "disks_raid_configured",
  "network_configured",
  "ips_assigned",
  "addons_installed",
  "credentials_generated",
  "credentials_sent_to_customer",
  "provisioning_verified",
  "ticket_completed",
] as const;

export class DedicatedProvisioningService {
  constructor(private readonly dataSource: DataSource) {}

  private buildOrderNumber(orderId: number): string {
    return `DSO-${orderId.toString().padStart(6, "0")}`;
  }

  private buildTicketNumber(ticketId: number): string {
    return `DSP-${ticketId.toString().padStart(6, "0")}`;
  }

  async createPaidOrderAndTicket(input: CreateProvisioningInput): Promise<{
    order: DedicatedServerOrder;
    ticket: ProvisioningTicket;
    created: boolean;
  }> {
    return this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(DedicatedServerOrder);
      const ticketRepo = manager.getRepository(ProvisioningTicket);
      const historyRepo = manager.getRepository(ProvisioningTicketStatusHistory);
      const checklistRepo = manager.getRepository(ProvisioningTicketChecklist);
      const eventRepo = manager.getRepository(ProvisioningTicketEvent);

      if (input.idempotencyKey) {
        const existingOrder = await orderRepo.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existingOrder) {
          const existingTicket = await ticketRepo.findOne({
            where: { orderId: existingOrder.id },
          });
          if (existingTicket) {
            return { order: existingOrder, ticket: existingTicket, created: false };
          }
        }
      }

      const order = new DedicatedServerOrder();
      order.orderNumber = `TMP-${Date.now()}`;
      order.idempotencyKey = input.idempotencyKey ?? null;
      order.userId = input.userId;
      order.telegramUserId = input.telegramUserId ?? null;
      order.telegramUsername = input.telegramUsername ?? null;
      order.fullName = input.fullName ?? null;
      order.email = input.email ?? null;
      order.phone = input.phone ?? null;
      order.source = "telegram_bot";
      order.paymentId = input.paymentId ?? null;
      order.transactionId = input.transactionId ?? null;
      order.paymentMethod = input.paymentMethod ?? "balance";
      order.paymentStatus = input.paymentStatus;
      order.paymentAmount = input.paymentAmount;
      order.currency = input.currency ?? "USD";
      order.billingCycle = input.billingCycle ?? "monthly";
      order.promoCode = input.promoCode ?? null;
      order.discountAmount = input.discountAmount ?? null;
      order.balanceUsedAmount = input.balanceUsedAmount ?? null;
      order.customerLanguage = input.customerLanguage ?? null;
      order.customerNotes = input.customerNotes ?? null;
      order.productId = input.config.productId;
      order.productName = input.config.productName;
      order.serverCategory = input.config.category ?? null;
      order.locationKey = input.config.locationKey ?? null;
      order.locationLabel = input.config.locationLabel ?? null;
      order.country = input.config.country ?? null;
      order.osKey = input.config.osKey ?? null;
      order.osLabel = input.config.osLabel ?? null;
      order.configurationSnapshot = JSON.stringify(input.config);
      order.paidAt = input.paymentStatus === DedicatedOrderPaymentStatus.PAID ? new Date() : null;
      order.excludeFromUserStats = input.excludeFromUserStats === true;

      const savedOrder = await orderRepo.save(order);
      savedOrder.orderNumber = this.buildOrderNumber(savedOrder.id);
      await orderRepo.save(savedOrder);

      const ticket = new ProvisioningTicket();
      ticket.orderId = savedOrder.id;
      ticket.ticketNumber = `TMP-${Date.now()}`;
      ticket.status = ProvisioningTicketStatus.OPEN;
      ticket.assigneeUserId = null;
      ticket.linkedLegacyTicketId = null;
      ticket.completedAt = null;
      ticket.cancelledAt = null;
      const savedTicket = await ticketRepo.save(ticket);
      savedTicket.ticketNumber = this.buildTicketNumber(savedTicket.id);
      await ticketRepo.save(savedTicket);

      const history = new ProvisioningTicketStatusHistory();
      history.ticketId = savedTicket.id;
      history.fromStatus = null;
      history.toStatus = savedTicket.status;
      history.actorUserId = input.userId;
      history.note = "ticket_created";
      await historyRepo.save(history);

      for (const key of PROVISIONING_CHECKLIST_KEYS) {
        const row = new ProvisioningTicketChecklist();
        row.ticketId = savedTicket.id;
        row.key = key;
        row.isChecked = false;
        row.checkedByUserId = null;
        row.checkedAt = null;
        await checklistRepo.save(row);
      }

      const event = new ProvisioningTicketEvent();
      event.ticketId = savedTicket.id;
      event.eventType = "ticket_created";
      event.actorUserId = input.userId;
      event.payload = JSON.stringify({
        orderId: savedOrder.id,
        paymentStatus: input.paymentStatus,
        amount: input.paymentAmount,
      });
      await eventRepo.save(event);

      return { order: savedOrder, ticket: savedTicket, created: true };
    });
  }

  async listTicketsByStatus(status: ProvisioningTicketStatus, limit = 20): Promise<ProvisioningTicket[]> {
    return this.dataSource.getRepository(ProvisioningTicket).find({
      where: { status },
      order: { createdAt: "ASC" },
      take: limit,
    });
  }

  async countTicketsByStatus(status: ProvisioningTicketStatus): Promise<number> {
    return this.dataSource.getRepository(ProvisioningTicket).count({
      where: { status },
    });
  }

  async getTicketById(ticketId: number): Promise<ProvisioningTicket | null> {
    return this.dataSource.getRepository(ProvisioningTicket).findOne({ where: { id: ticketId } });
  }

  async getOrderById(orderId: number): Promise<DedicatedServerOrder | null> {
    return this.dataSource.getRepository(DedicatedServerOrder).findOne({ where: { id: orderId } });
  }

  async assignTicket(ticketId: number, assigneeUserId: number | null, actorUserId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(ProvisioningTicket);
      const assignmentRepo = manager.getRepository(ProvisioningTicketAssignment);
      const eventRepo = manager.getRepository(ProvisioningTicketEvent);
      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) throw new Error("Provisioning ticket not found");
      const prev = ticket.assigneeUserId;
      ticket.assigneeUserId = assigneeUserId;
      await ticketRepo.save(ticket);

      const assignment = new ProvisioningTicketAssignment();
      assignment.ticketId = ticketId;
      assignment.fromAssigneeUserId = prev;
      assignment.toAssigneeUserId = assigneeUserId;
      assignment.actorUserId = actorUserId;
      assignment.note = null;
      await assignmentRepo.save(assignment);

      const event = new ProvisioningTicketEvent();
      event.ticketId = ticketId;
      event.eventType = "assigned";
      event.actorUserId = actorUserId;
      event.payload = JSON.stringify({ from: prev, to: assigneeUserId });
      await eventRepo.save(event);
    });
  }

  async updateStatus(
    ticketId: number,
    toStatus: ProvisioningTicketStatus,
    actorUserId: number,
    note?: string | null
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(ProvisioningTicket);
      const historyRepo = manager.getRepository(ProvisioningTicketStatusHistory);
      const eventRepo = manager.getRepository(ProvisioningTicketEvent);
      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) throw new Error("Provisioning ticket not found");
      const fromStatus = ticket.status;
      ticket.status = toStatus;
      if (toStatus === ProvisioningTicketStatus.DONE) {
        ticket.completedAt = new Date();
      }
      await ticketRepo.save(ticket);

      const history = new ProvisioningTicketStatusHistory();
      history.ticketId = ticketId;
      history.fromStatus = fromStatus;
      history.toStatus = toStatus;
      history.actorUserId = actorUserId;
      history.note = note ?? null;
      await historyRepo.save(history);

      const event = new ProvisioningTicketEvent();
      event.ticketId = ticketId;
      event.eventType = "status_changed";
      event.actorUserId = actorUserId;
      event.payload = JSON.stringify({ fromStatus, toStatus, note: note ?? null });
      await eventRepo.save(event);
    });
  }

  async setChecklistItem(
    ticketId: number,
    key: string,
    isChecked: boolean,
    actorUserId: number
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const checklistRepo = manager.getRepository(ProvisioningTicketChecklist);
      const eventRepo = manager.getRepository(ProvisioningTicketEvent);
      let row = await checklistRepo.findOne({ where: { ticketId, key } });
      if (!row) {
        row = new ProvisioningTicketChecklist();
        row.ticketId = ticketId;
        row.key = key;
      }
      row.isChecked = isChecked;
      row.checkedByUserId = isChecked ? actorUserId : null;
      row.checkedAt = isChecked ? new Date() : null;
      await checklistRepo.save(row);

      const event = new ProvisioningTicketEvent();
      event.ticketId = ticketId;
      event.eventType = "checklist_toggled";
      event.actorUserId = actorUserId;
      event.payload = JSON.stringify({ key, isChecked });
      await eventRepo.save(event);
    });
  }

  async getChecklist(ticketId: number): Promise<ProvisioningTicketChecklist[]> {
    return this.dataSource.getRepository(ProvisioningTicketChecklist).find({
      where: { ticketId },
      order: { id: "ASC" },
    });
  }

  async addInternalNote(ticketId: number, actorUserId: number, text: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const noteRepo = manager.getRepository(ProvisioningTicketNote);
      const eventRepo = manager.getRepository(ProvisioningTicketEvent);

      const note = new ProvisioningTicketNote();
      note.ticketId = ticketId;
      note.actorUserId = actorUserId;
      note.isInternal = true;
      note.text = text;
      await noteRepo.save(note);

      const event = new ProvisioningTicketEvent();
      event.ticketId = ticketId;
      event.eventType = "note_added";
      event.actorUserId = actorUserId;
      event.payload = JSON.stringify({ text });
      await eventRepo.save(event);
    });
  }

  async listRecentNotes(ticketId: number, limit = 5): Promise<ProvisioningTicketNote[]> {
    return this.dataSource.getRepository(ProvisioningTicketNote).find({
      where: { ticketId },
      order: { createdAt: "DESC" },
      take: limit,
    });
  }

  canManage(role: Role): boolean {
    return role === Role.Admin || role === Role.Moderator;
  }
}
