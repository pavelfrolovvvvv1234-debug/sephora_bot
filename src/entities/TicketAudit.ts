/**
 * TicketAudit entity for logging ticket actions and changes.
 *
 * @module entities/TicketAudit
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Role } from "./User";

/**
 * TicketAudit entity for audit logging of ticket operations.
 */
@Entity()
export default class TicketAudit {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  ticketId!: number;

  @Column({ nullable: false, type: "integer" })
  actorId!: number;

  @Column({ type: "varchar", nullable: false })
  actorRole!: Role;

  @Column({ type: "varchar", nullable: false })
  action!: string; // e.g., "take", "assign", "ask_user", "provide_result", "reject", "status_change"

  @Column({ type: "text", nullable: true })
  before!: string | null; // JSON string with previous state

  @Column({ type: "text", nullable: true })
  after!: string | null; // JSON string with new state

  @CreateDateColumn()
  createdAt!: Date;
}
