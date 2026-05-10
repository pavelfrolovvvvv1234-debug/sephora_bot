/**
 * Broadcast entity for admin message broadcasting.
 *
 * @module entities/Broadcast
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * Broadcast status enum.
 */
export enum BroadcastStatus {
  NEW = "new",
  SENDING = "sending",
  DONE = "done",
  FAILED = "failed",
}

/**
 * Broadcast entity for tracking message broadcasts to all users.
 */
@Entity()
export default class Broadcast {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  adminId!: number;

  @Column({ type: "text", nullable: false })
  text!: string;

  @Column({ type: "varchar", default: BroadcastStatus.NEW, nullable: false })
  status!: BroadcastStatus;

  @Column({ default: 0, nullable: false, type: "integer" })
  totalCount!: number;

  @Column({ default: 0, nullable: false, type: "integer" })
  sentCount!: number;

  @Column({ default: 0, nullable: false, type: "integer" })
  failedCount!: number;

  @Column({ default: 0, nullable: false, type: "integer" })
  blockedCount!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
