/**
 * Daily aggregates per scenario (sent count, conversion count, etc.).
 *
 * @module entities/automations/ScenarioMetric
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("scenario_metrics")
@Index(["scenarioKey", "date"], { unique: true })
export default class ScenarioMetric {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  scenarioKey!: string;

  @Column({ type: "date", nullable: false })
  date!: string;

  @Column({ type: "int", default: 0, nullable: false })
  sentCount!: number;

  @Column({ type: "int", default: 0, nullable: false })
  skippedCount!: number;

  @Column({ type: "int", default: 0, nullable: false })
  errorCount!: number;

  @Column({ type: "int", default: 0, nullable: false })
  conversionCount!: number;

  @Column({ type: "real", default: 0, nullable: false })
  conversionRevenue!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
