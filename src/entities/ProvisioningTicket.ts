import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum ProvisioningTicketStatus {
  OPEN = "open",
  IN_PROGRESS = "in_progress",
  WAITING = "waiting",
  DONE = "done",
  // Legacy aliases (same canonical values) for backward compatibility.
  NEW = "open",
  PENDING_REVIEW = "in_progress",
  AWAITING_PAYMENT = "waiting",
  PAID = "waiting",
  AWAITING_STOCK = "waiting",
  IN_PROVISIONING = "in_progress",
  AWAITING_FINAL_CHECK = "in_progress",
  COMPLETED = "done",
  REJECTED = "done",
  CANCELLED = "done",
}

@Entity("provisioning_tickets")
@Index(["status", "createdAt"])
@Index(["assigneeUserId", "status"])
@Index(["orderId"], { unique: true })
export default class ProvisioningTicket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  orderId!: number;

  @Column({ type: "varchar", unique: true })
  ticketNumber!: string;

  @Column({ type: "varchar", default: ProvisioningTicketStatus.OPEN })
  status!: ProvisioningTicketStatus;

  @Column({ type: "integer", nullable: true })
  assigneeUserId!: number | null;

  @Column({ type: "integer", nullable: true })
  linkedLegacyTicketId!: number | null;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
