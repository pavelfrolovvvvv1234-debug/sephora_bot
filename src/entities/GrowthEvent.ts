/**
 * Growth event for metrics (upsell, bundle, fomo, reactivation, trigger).
 *
 * @module entities/GrowthEvent
 */

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from "typeorm";

export type GrowthEventType =
  | "upsell"
  | "bundle"
  | "fomo"
  | "reactivation"
  | "trigger"
  | "usage_upsell"
  | "winback"
  | "scarcity"
  | "cross_sell"
  | "tier"
  | "referral_push"
  | "large_deposit"
  | "nps"
  | "anniversary"
  | "b2b"
  | "grace_day2"
  | "grace_day3"
  | "incident_upsell";

@Entity()
export default class GrowthEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer", nullable: false })
  userId!: number;

  @Column({ type: "varchar", nullable: false })
  type!: GrowthEventType;

  @Column({ type: "real", default: 0, nullable: false })
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
