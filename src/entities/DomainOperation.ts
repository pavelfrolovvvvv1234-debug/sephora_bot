/**
 * DomainOperation entity for tracking domain operations (register/renew/update_ns).
 *
 * @module entities/DomainOperation
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * Domain operation type enum.
 */
export enum DomainOperationType {
  REGISTER = "register",
  RENEW = "renew",
  UPDATE_NS = "update_ns",
}

/**
 * Domain operation status enum.
 */
export enum DomainOperationStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
}

/**
 * DomainOperation entity for tracking domain operations.
 */
@Entity()
export default class DomainOperation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  domainId!: number;

  @Column({ type: "varchar", nullable: false })
  type!: DomainOperationType;

  @Column({ type: "varchar", default: DomainOperationStatus.PENDING, nullable: false })
  status!: DomainOperationStatus;

  @Column({ nullable: true, type: "varchar" })
  providerOpId!: string | null; // External provider operation ID

  @Column({ nullable: true, type: "text" })
  error!: string | null; // Error message if failed

  @CreateDateColumn()
  createdAt!: Date;
}
