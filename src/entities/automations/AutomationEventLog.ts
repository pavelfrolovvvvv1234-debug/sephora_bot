/**
 * Event log: sent / skipped / error per scenario and user.
 *
 * @module entities/automations/AutomationEventLog
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export type LogOutcome = "sent" | "skipped" | "error";

@Entity("automation_event_log")
@Index(["scenarioKey", "createdAt"])
@Index(["userId", "createdAt"])
export default class AutomationEventLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  scenarioKey!: string;

  @Column({ type: "integer", nullable: true })
  userId!: number | null;

  @Column({ type: "varchar", length: 32, nullable: false })
  outcome!: LogOutcome;

  @Column({ type: "varchar", length: 64, nullable: true })
  stepId!: string | null;

  @Column({ type: "text", nullable: true })
  reason!: string | null;

  @Column({ type: "text", nullable: true })
  payload!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
