/**
 * Automation scenario (key, category, enabled, tags). One row per scenario key.
 *
 * @module entities/automations/AutomationScenario
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export type ScenarioCategory =
  | "Retention"
  | "Upsell"
  | "Promo"
  | "Referral"
  | "System";

@Entity("automation_scenarios")
export default class AutomationScenario {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "varchar", length: 64, nullable: false })
  category!: ScenarioCategory;

  @Column({ type: "boolean", default: true, nullable: false })
  enabled!: boolean;

  @Column({ type: "varchar", length: 256, nullable: true })
  name!: string | null;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  /** JSON array of tags, e.g. ["deposit", "growth"] */
  @Column({ type: "text", nullable: true })
  tags!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
