import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum TopUpStatus {
  Created = "created",
  Completed = "completed",
  Expired = "expired",
}

@Entity()
export default class TopUp {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ default: TopUpStatus.Created, type: "varchar", nullable: false })
  status!: TopUpStatus;

  @Column({ nullable: false, type: "varchar" })
  url!: string;

  @Column({ nullable: false, type: "real" })
  amount!: number;

  @Column({ nullable: true, type: "varchar" })
  orderId!: string;

  @Column({ nullable: false, type: "varchar" })
  paymentSystem!: "crystalpay" | "cryptobot" | "heleket";

  @Column({ nullable: false, type: "integer" })
  target_user_id!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;

  /** Set when balance was applied (either via api/payment or BillingService.applyPayment); prevents double credit. */
  @Column({ type: "datetime", nullable: true, default: null })
  balanceCreditedAt: Date | null = null;
}
