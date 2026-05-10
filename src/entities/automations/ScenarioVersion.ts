/**
 * Scenario version (draft or published). Config stored as JSON.
 *
 * @module entities/automations/ScenarioVersion
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";
export type VersionStatus = "draft" | "published";

/** Stored config is validated at runtime with ScenarioConfigSchema. */
export type ScenarioConfigStored = Record<string, unknown>;

@Entity("scenario_versions")
@Index(["scenarioKey", "status"])
export default class ScenarioVersion {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  scenarioKey!: string;

  @Column({ type: "varchar", length: 20, nullable: false })
  status!: VersionStatus;

  @Column({ type: "int", default: 1, nullable: false })
  versionNumber!: number;

  /** Full scenario config (triggers, conditions, steps, offers, templates, throttle, etc.) */
  @Column({ type: "simple-json", nullable: false })
  config!: ScenarioConfigStored;

  @Column({ type: "integer", nullable: true })
  publishedBy!: number | null;

  @Column({ type: "datetime", nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
