/**
 * TicketService for managing tickets and moderation workflow.
 *
 * @module domain/tickets/TicketService
 */

import { DataSource } from "typeorm";
import Ticket, { TicketType, TicketStatus } from "../../entities/Ticket.js";
import TicketAudit from "../../entities/TicketAudit.js";
import DedicatedServer, { DedicatedServerStatus } from "../../entities/DedicatedServer.js";
import User, { Role } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import { NotFoundError, BusinessError } from "../../shared/errors/index.js";

/**
 * Ticket service for managing ticket lifecycle.
 */
export class TicketService {
  constructor(private dataSource: DataSource) {}

  /**
   * Create a new ticket.
   *
   * @param userId - User ID
   * @param type - Ticket type
   * @param payload - Payload data (JSON string)
   * @returns Created ticket
   */
  async createTicket(
    userId: number,
    type: TicketType,
    payload?: Record<string, any>,
    options?: { excludeFromUserStats?: boolean }
  ): Promise<Ticket> {
    const ticketRepo = this.dataSource.getRepository(Ticket);

    const ticket = new Ticket();
    ticket.userId = userId;
    ticket.type = type;
    ticket.status = TicketStatus.NEW;
    ticket.assignedModeratorId = null;
    ticket.payload = payload ? JSON.stringify(payload) : null;
    ticket.result = null;
    ticket.resolvedAt = null;
    ticket.excludeFromUserStats = options?.excludeFromUserStats === true;

    const saved = await ticketRepo.save(ticket);
    Logger.info(`Created ticket ${saved.id} of type ${type} for user ${userId}`);

    return saved;
  }

  /**
   * Get ticket by ID.
   *
   * @param ticketId - Ticket ID
   * @returns Ticket or null
   */
  async getTicketById(ticketId: number): Promise<Ticket | null> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    return ticketRepo.findOne({ where: { id: ticketId } });
  }

  /**
   * Get tickets by user ID.
   *
   * @param userId - User ID
   * @returns List of tickets
   */
  async getTicketsByUserId(userId: number): Promise<Ticket[]> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    return ticketRepo.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Get tickets by status (for moderators).
   *
   * @param status - Ticket status
   * @param limit - Limit results
   * @returns List of tickets
   */
  async getTicketsByStatus(status: TicketStatus, limit: number = 50): Promise<Ticket[]> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    return ticketRepo.find({
      where: { status },
      order: { createdAt: "ASC" },
      take: limit,
    });
  }

  /**
   * Take ticket (assign to moderator).
   *
   * @param ticketId - Ticket ID
   * @param moderatorId - Moderator ID
   * @param actorId - Actor ID (for audit)
   * @param actorRole - Actor role (for audit)
   * @returns Updated ticket
   */
  async takeTicket(
    ticketId: number,
    moderatorId: number,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      // Check if ticket can be taken
      if (ticket.status !== TicketStatus.NEW && 
          ticket.status !== TicketStatus.IN_PROGRESS) {
        throw new BusinessError(`Cannot take ticket with status: ${ticket.status}`);
      }

      if (ticket.status === TicketStatus.IN_PROGRESS && 
          ticket.assignedModeratorId !== null && 
          ticket.assignedModeratorId !== moderatorId) {
        throw new BusinessError("Ticket is already assigned to another moderator");
      }

      const before = JSON.stringify({
        status: ticket.status,
        assignedModeratorId: ticket.assignedModeratorId,
      });

      ticket.assignedModeratorId = moderatorId;
      ticket.status = TicketStatus.IN_PROGRESS;

      await ticketRepo.save(ticket);

      // Audit log
      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "take";
      audit.before = before;
      audit.after = JSON.stringify({
        status: ticket.status,
        assignedModeratorId: ticket.assignedModeratorId,
      });
      await auditRepo.save(audit);

      Logger.info(`Ticket ${ticketId} taken by moderator ${moderatorId}`);
      return ticket;
    });
  }

  /**
   * Unassign ticket (set assignedModeratorId to null, status to NEW).
   */
  async unassignTicket(
    ticketId: number,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      const before = JSON.stringify({
        status: ticket.status,
        assignedModeratorId: ticket.assignedModeratorId,
      });

      ticket.assignedModeratorId = null;
      ticket.status = TicketStatus.NEW;

      await ticketRepo.save(ticket);

      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "unassign";
      audit.before = before;
      audit.after = JSON.stringify({
        status: ticket.status,
        assignedModeratorId: ticket.assignedModeratorId,
      });
      await auditRepo.save(audit);

      Logger.info(`Ticket ${ticketId} unassigned by ${actorId}`);
      return ticket;
    });
  }

  /**
   * Ask user (change status to WAIT_USER).
   *
   * @param ticketId - Ticket ID
   * @param question - Question text (optional, for payload)
   * @param actorId - Actor ID (for audit)
   * @param actorRole - Actor role (for audit)
   * @returns Updated ticket
   */
  async askUser(
    ticketId: number,
    question: string | null,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      const before = JSON.stringify({ status: ticket.status });

      ticket.status = TicketStatus.WAIT_USER;
      if (question) {
        let payload: Record<string, any> = {};
        try {
          payload = ticket.payload ? JSON.parse(ticket.payload) : {};
        } catch (error) {
          payload = {};
        }
        payload.question = question;
        ticket.payload = JSON.stringify(payload);
      }

      await ticketRepo.save(ticket);

      // Audit log
      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "ask_user";
      audit.before = before;
      audit.after = JSON.stringify({ status: ticket.status, question });
      await auditRepo.save(audit);

      Logger.info(`Ticket ${ticketId} status changed to WAIT_USER by ${actorId}`);
      return ticket;
    });
  }

  /**
   * Provide result (for DEDICATED_ORDER or operations).
   *
   * @param ticketId - Ticket ID
   * @param result - Result data (credentials or text)
   * @param actorId - Actor ID (for audit)
   * @param actorRole - Actor role (for audit)
   * @returns Updated ticket
   */
  async provideResult(
    ticketId: number,
    result: Record<string, any> | string,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);
      const dedicatedRepo = manager.getRepository(DedicatedServer);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      const before = JSON.stringify({
        status: ticket.status,
        result: ticket.result,
      });

      ticket.status = TicketStatus.DONE;
      ticket.resolvedAt = new Date();
      ticket.result = typeof result === "string" ? result : JSON.stringify(result);

      // If DEDICATED_ORDER, update DedicatedServer
      if (ticket.type === TicketType.DEDICATED_ORDER && typeof result === "object") {
        let dedicated = await dedicatedRepo.findOne({
          where: { ticketId: ticketId },
        });

        if (!dedicated) {
          // Create new dedicated server if not exists
          dedicated = new DedicatedServer();
          dedicated.userId = ticket.userId;
          dedicated.ticketId = ticketId;
          dedicated.status = DedicatedServerStatus.REQUESTED;
        }

        // Validate credentials object has required fields
        if (!result.ip || !result.login || !result.password) {
          throw new BusinessError("Credentials must include IP, login, and password");
        }

        dedicated.credentials = JSON.stringify(result);
        dedicated.status = DedicatedServerStatus.ACTIVE;
        await dedicatedRepo.save(dedicated);
      }

      await ticketRepo.save(ticket);

      // Audit log
      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "provide_result";
      audit.before = before;
      audit.after = JSON.stringify({
        status: ticket.status,
        result: ticket.result,
      });
      await auditRepo.save(audit);

      Logger.info(`Ticket ${ticketId} resolved by ${actorId}`);
      return ticket;
    });
  }

  /**
   * Reject ticket.
   *
   * @param ticketId - Ticket ID
   * @param reason - Rejection reason
   * @param actorId - Actor ID (for audit)
   * @param actorRole - Actor role (for audit)
   * @returns Updated ticket
   */
  async rejectTicket(
    ticketId: number,
    reason: string | null,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      const before = JSON.stringify({ status: ticket.status });

      ticket.status = TicketStatus.REJECTED;
      ticket.resolvedAt = new Date();
      if (reason) {
        ticket.result = reason;
      }

      await ticketRepo.save(ticket);

      // Audit log
      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "reject";
      audit.before = before;
      audit.after = JSON.stringify({ status: ticket.status, reason });
      await auditRepo.save(audit);

      Logger.info(`Ticket ${ticketId} rejected by ${actorId}`);
      return ticket;
    });
  }

  /**
   * Approve withdraw request (deduct balance and mark ticket as done).
   *
   * @param ticketId - Ticket ID
   * @param actorId - Actor ID (for audit)
   * @param actorRole - Actor role (for audit)
   * @returns Updated ticket
   * @throws {NotFoundError} If ticket not found
   * @throws {BusinessError} If ticket is not WITHDRAW_REQUEST or insufficient balance
   */
  async approveWithdraw(
    ticketId: number,
    actorId: number,
    actorRole: Role
  ): Promise<Ticket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketRepo = manager.getRepository(Ticket);
      const auditRepo = manager.getRepository(TicketAudit);
      const userRepo = manager.getRepository(User);

      const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
      if (!ticket) {
        throw new NotFoundError("Ticket", ticketId);
      }

      if (ticket.type !== TicketType.WITHDRAW_REQUEST) {
        throw new BusinessError("Ticket is not a withdraw request");
      }

      if (ticket.status === TicketStatus.DONE || ticket.status === TicketStatus.REJECTED) {
        throw new BusinessError(`Cannot approve ticket with status: ${ticket.status}`);
      }

      // Parse payload
      let payload: Record<string, any> = {};
      try {
        payload = ticket.payload ? JSON.parse(ticket.payload) : {};
      } catch (error) {
        throw new BusinessError("Invalid ticket payload");
      }

      const amount = payload.amount;
      if (!amount || typeof amount !== "number" || amount <= 0) {
        throw new BusinessError("Invalid withdraw amount");
      }

      // Get user and check referral balance (withdraw is from referral balance only)
      const user = await userRepo.findOne({ where: { id: ticket.userId } });
      if (!user) {
        throw new NotFoundError("User", ticket.userId);
      }

      const refBalance = user.referralBalance ?? 0;
      if (refBalance < amount) {
        throw new BusinessError(
          `Insufficient referral balance. Required: ${amount}, Available: ${refBalance}`
        );
      }

      const before = JSON.stringify({
        status: ticket.status,
        userReferralBalance: refBalance,
      });

      // Deduct from referral balance
      user.referralBalance = refBalance - amount;
      await userRepo.save(user);

      // Update ticket
      ticket.status = TicketStatus.DONE;
      ticket.resolvedAt = new Date();
      ticket.result = JSON.stringify({ approved: true, amount, deductedAt: new Date().toISOString() });
      await ticketRepo.save(ticket);

      // Audit log
      const audit = new TicketAudit();
      audit.ticketId = ticketId;
      audit.actorId = actorId;
      audit.actorRole = actorRole;
      audit.action = "approve_withdraw";
      audit.before = before;
      audit.after = JSON.stringify({
        status: ticket.status,
        userReferralBalance: user.referralBalance,
        amount,
      });
      await auditRepo.save(audit);

      Logger.info(`Withdraw request ${ticketId} approved by ${actorId}, amount: ${amount}`);

      return ticket;
    });
  }

  /**
   * Get audit logs for a ticket.
   *
   * @param ticketId - Ticket ID
   * @returns List of audit logs
   */
  async getTicketAuditLogs(ticketId: number): Promise<TicketAudit[]> {
    const auditRepo = this.dataSource.getRepository(TicketAudit);
    return auditRepo.find({
      where: { ticketId },
      order: { createdAt: "ASC" },
    });
  }
}
