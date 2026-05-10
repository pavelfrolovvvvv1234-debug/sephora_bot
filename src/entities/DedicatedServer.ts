/**
 * DedicatedServer entity for managing dedicated server provisioning.
 *
 * @module entities/DedicatedServer
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Dedicated server status enum.
 */
export enum DedicatedServerStatus {
  REQUESTED = "requested",
  ACTIVE = "active",
  SUSPENDED = "suspended",
}

/**
 * DedicatedServer entity for storing dedicated server credentials and status.
 */
@Entity()
export default class DedicatedServer {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  userId!: number;

  @Column({ type: "varchar", nullable: true })
  label!: string | null;

  @Column({ type: "varchar", default: DedicatedServerStatus.REQUESTED, nullable: false })
  status!: DedicatedServerStatus;

  @Column({ type: "integer", nullable: true })
  ticketId!: number | null; // Order ticket ID

  @Column({ type: "text", nullable: true })
  credentials!: string | null; // JSON string with IP/login/password/notes

  @Column({ type: "datetime", nullable: true })
  paidUntil!: Date | null;

  @Column({ type: "real", nullable: true })
  monthlyPrice!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
