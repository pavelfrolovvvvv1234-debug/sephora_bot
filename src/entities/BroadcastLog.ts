/**
 * BroadcastLog entity for tracking individual broadcast delivery results.
 *
 * @module entities/BroadcastLog
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * Broadcast delivery status enum.
 */
export enum BroadcastLogStatus {
  PENDING = "pending",
  SENT = "sent",
  FAILED = "failed",
  BLOCKED = "blocked",
}

/**
 * BroadcastLog entity for tracking individual user broadcast delivery.
 */
@Entity()
export default class BroadcastLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  broadcastId!: number;

  @Column({ nullable: false, type: "integer" })
  userId!: number;

  @Column({ type: "varchar", default: BroadcastLogStatus.PENDING, nullable: false })
  status!: BroadcastLogStatus;

  @Column({ type: "text", nullable: true })
  error!: string | null;

  @CreateDateColumn()
  sentAt!: Date;
}
