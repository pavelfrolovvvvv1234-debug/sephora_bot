/**
 * Ticket entity for dedicated server moderation and support.
 *
 * @module entities/Ticket
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Ticket type enum.
 */
export enum TicketType {
  DEDICATED_ORDER = "dedicated_order",
  DEDICATED_REINSTALL = "dedicated_reinstall",
  DEDICATED_REBOOT = "dedicated_reboot",
  DEDICATED_RESET = "dedicated_reset",
  DEDICATED_POWER_ON = "dedicated_power_on",
  DEDICATED_POWER_OFF = "dedicated_power_off",
  DEDICATED_OTHER = "dedicated_other",
  MANUAL_TOPUP = "manual_topup",
  WITHDRAW_REQUEST = "withdraw_request",
}

/**
 * Ticket status enum.
 */
export enum TicketStatus {
  NEW = "new",
  IN_PROGRESS = "in_progress",
  WAIT_USER = "wait_user",
  DONE = "done",
  REJECTED = "rejected",
}

/**
 * Ticket entity for managing dedicated server requests and moderation.
 */
@Entity()
export default class Ticket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false })
  type!: TicketType;

  @Column({ type: "varchar", default: TicketStatus.NEW, nullable: false })
  status!: TicketStatus;

  @Column({ nullable: false, type: "integer" })
  userId!: number;

  @Column({ type: "integer", nullable: true })
  assignedModeratorId!: number | null;

  @Column({ type: "text", nullable: true })
  payload!: string | null; // JSON string with plan/comment/action/OS etc.

  @Column({ type: "text", nullable: true })
  result!: string | null; // JSON string or text with issued data or result

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  resolvedAt!: Date | null;

  /** Staff/internal purchases: omit from admin panel user stats (tickets & orders counters). */
  @Column({ default: false, type: "boolean", nullable: false })
  excludeFromUserStats!: boolean;
}
