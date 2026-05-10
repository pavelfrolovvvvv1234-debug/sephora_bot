import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum DedicatedOrderPaymentStatus {
  PENDING = "pending",
  PAID = "paid",
  FAILED = "failed",
  REFUNDED = "refunded",
  CANCELLED = "cancelled",
}

@Entity("dedicated_server_orders")
@Index(["userId", "createdAt"])
@Index(["paymentStatus", "createdAt"])
@Index(["locationKey", "productId"])
export default class DedicatedServerOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", unique: true })
  orderNumber!: string;

  @Column({ type: "varchar", nullable: true, unique: true })
  idempotencyKey!: string | null;

  @Column({ type: "integer" })
  userId!: number;

  @Column({ type: "integer", nullable: true })
  telegramUserId!: number | null;

  @Column({ type: "varchar", nullable: true })
  telegramUsername!: string | null;

  @Column({ type: "varchar", nullable: true })
  fullName!: string | null;

  @Column({ type: "varchar", nullable: true })
  email!: string | null;

  @Column({ type: "varchar", nullable: true })
  phone!: string | null;

  @Column({ type: "varchar", default: "telegram_bot" })
  source!: string;

  @Column({ type: "varchar", nullable: true })
  paymentId!: string | null;

  @Column({ type: "varchar", nullable: true })
  transactionId!: string | null;

  @Column({ type: "varchar", nullable: true })
  paymentMethod!: string | null;

  @Column({ type: "varchar", default: DedicatedOrderPaymentStatus.PENDING })
  paymentStatus!: DedicatedOrderPaymentStatus;

  @Column({ type: "real", default: 0 })
  paymentAmount!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "varchar", default: "monthly" })
  billingCycle!: string;

  @Column({ type: "varchar", nullable: true })
  promoCode!: string | null;

  @Column({ type: "real", nullable: true })
  discountAmount!: number | null;

  @Column({ type: "real", nullable: true })
  balanceUsedAmount!: number | null;

  @Column({ type: "varchar", nullable: true })
  customerLanguage!: string | null;

  @Column({ type: "text", nullable: true })
  customerNotes!: string | null;

  @Column({ type: "varchar" })
  productId!: string;

  @Column({ type: "varchar" })
  productName!: string;

  @Column({ type: "varchar", nullable: true })
  serverCategory!: string | null;

  @Column({ type: "varchar", nullable: true })
  locationKey!: string | null;

  @Column({ type: "varchar", nullable: true })
  locationLabel!: string | null;

  @Column({ type: "varchar", nullable: true })
  country!: string | null;

  @Column({ type: "varchar", nullable: true })
  osKey!: string | null;

  @Column({ type: "varchar", nullable: true })
  osLabel!: string | null;

  @Column({ type: "text", nullable: true })
  configurationSnapshot!: string | null;

  @Column({ type: "datetime", nullable: true })
  paidAt!: Date | null;

  /** Staff/internal provisioning orders: omit from admin panel «orders» counter. */
  @Column({ default: false, type: "boolean", nullable: false })
  excludeFromUserStats!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
