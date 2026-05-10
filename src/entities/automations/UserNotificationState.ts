/**
 * Per-user state for cooldowns, last sent, step counters. Keyed by scenario + user.
 *
 * @module entities/automations/UserNotificationState
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("user_notification_state")
@Index(["scenarioKey", "userId"], { unique: true })
export default class UserNotificationState {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  scenarioKey!: string;

  @Column({ type: "integer", nullable: false })
  userId!: number;

  @Column({ type: "datetime", nullable: true })
  lastSentAt!: Date | null;

  @Column({ type: "int", default: 0, nullable: false })
  sendCount!: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  lastStepId!: string | null;

  @Column({ type: "datetime", nullable: true })
  lastStepAt!: Date | null;

  /** JSON: { "stepId": "timestamp" } for per-step caps */
  @Column({ type: "text", nullable: true })
  stepSentAt!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
