/**
 * Service invoice entity for Crypto Pay payments.
 *
 * @module entities/ServiceInvoice
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type ServiceType = "vds" | "dedicated";

export enum ServiceInvoiceStatus {
  Pending = "pending",
  Paid = "paid",
  Expired = "expired",
  Failed = "failed",
}

@Entity()
export default class ServiceInvoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false })
  invoiceId!: string;

  @Column({ type: "varchar", nullable: false })
  provider!: "cryptobot";

  @Column({ type: "integer", nullable: false })
  userId!: number;

  @Column({ type: "varchar", nullable: false })
  serviceType!: ServiceType;

  @Column({ type: "integer", nullable: false })
  serviceId!: number;

  @Column({ type: "real", nullable: false })
  amount!: number;

  @Column({ type: "varchar", nullable: false })
  status!: ServiceInvoiceStatus;

  @Column({ type: "text", nullable: false })
  payload!: string;

  @Column({ type: "text", nullable: false })
  payUrl!: string;

  @Column({ type: "integer", nullable: true })
  chatId!: number | null;

  @Column({ type: "integer", nullable: true })
  messageId!: number | null;

  @Column({ type: "datetime", nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
