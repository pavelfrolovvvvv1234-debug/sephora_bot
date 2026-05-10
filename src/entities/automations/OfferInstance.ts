/**
 * Offer instance: created when scenario triggers (auto_apply or claim button).
 *
 * @module entities/automations/OfferInstance
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

export type OfferInstanceStatus = "active" | "applied" | "expired" | "claimed";

@Entity("offer_instances")
@Index(["userId", "scenarioKey", "status"])
@Index(["expiresAt"])
export default class OfferInstance {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer", nullable: false })
  userId!: number;

  @Column({ type: "varchar", length: 64, nullable: false })
  scenarioKey!: string;

  @Column({ type: "varchar", length: 64, nullable: true })
  stepId!: string | null;

  @Column({ type: "varchar", length: 64, nullable: false })
  offerKey!: string;

  @Column({ type: "varchar", length: 32, nullable: false })
  type!: string; // bonus_percent, discount_percent, extra_days, free_trial

  @Column({ type: "real", nullable: false })
  value!: number;

  @Column({ type: "datetime", nullable: false })
  expiresAt!: Date;

  @Column({ type: "varchar", length: 20, default: "active", nullable: false })
  status!: OfferInstanceStatus;

  @Column({ type: "datetime", nullable: true })
  appliedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  claimedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
