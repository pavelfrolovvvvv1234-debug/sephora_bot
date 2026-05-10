/**
 * Domain entity for managing registered domains via Amper API.
 *
 * @module entities/Domain
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Domain status enum.
 */
export enum DomainStatus {
  DRAFT = "draft",
  WAIT_PAYMENT = "wait_payment",
  REGISTERING = "registering",
  REGISTERED = "registered",
  FAILED = "failed",
  EXPIRED = "expired",
}

/**
 * Domain entity for storing registered domains.
 */
@Entity()
export default class Domain {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  userId!: number;

  @Column({ nullable: false, type: "varchar" })
  domain!: string; // Full domain name (e.g., "example.com")

  @Column({ nullable: false, type: "varchar" })
  tld!: string; // Top-level domain (e.g., "com")

  @Column({ nullable: false, type: "integer" })
  period!: number; // Registration period in years

  @Column({ nullable: false, type: "real" })
  price!: number;

  @Column({ type: "varchar", default: DomainStatus.DRAFT, nullable: false })
  status!: DomainStatus;

  @Column({ nullable: true, type: "varchar" })
  ns1!: string | null; // Nameserver 1

  @Column({ nullable: true, type: "varchar" })
  ns2!: string | null; // Nameserver 2

  @Column({ type: "varchar", default: "amper", nullable: false })
  provider!: string; // Provider name (e.g., "amper")

  @Column({ nullable: true, type: "varchar" })
  providerDomainId!: string | null; // External provider domain ID

  @Column({ nullable: true, type: "datetime" })
  lastSyncAt!: Date | null; // Last sync with provider

  /** Set when domain was purchased as part of an infrastructure bundle (e.g. "1m", "3m"). */
  @Column({ nullable: true, type: "varchar" })
  bundleType!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
