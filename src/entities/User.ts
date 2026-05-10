import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  CreateDateColumn,
} from "typeorm";

export enum Role {
  User = "user",
  Moderator = "mod",
  Admin = "admin",
}

export enum UserStatus {
  User = "user",
  Moderator = "moderator",
  Admin = "admin",
}

@Entity()
export default class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  telegramId!: number;

  @Column({ default: 0.0, type: "real", nullable: false })
  balance!: number;

  /** Referral earnings (for withdrawal only). Separate from balance used for purchases. */
  @Column({ default: 0.0, type: "real", nullable: false })
  referralBalance!: number;

  @Column({ default: 0, nullable: false, type: "boolean" })
  isBanned!: boolean;

  @Column({ default: Role.User, type: "varchar", nullable: false })
  role!: Role;

  @Column({ default: UserStatus.User, type: "varchar", nullable: false })
  status!: UserStatus;

  @Column({ nullable: true, type: "varchar" })
  lang!: "ru" | "en";

  @Column({ nullable: true, type: "integer" })
  referrerId!: number | null;

  /** Referral reward percentage (0–100). Null = use default 5%. */
  @Column({ nullable: true, type: "real" })
  referralPercent!: number | null;

  /** Referral % for domain sales. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentDomains!: number | null;

  /** Referral % for dedicated standard. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentDedicatedStandard!: number | null;

  /** Referral % for dedicated bulletproof. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentDedicatedBulletproof!: number | null;

  /** Referral % for VDS standard. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentVdsStandard!: number | null;

  /** Referral % for VDS bulletproof. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentVdsBulletproof!: number | null;

  /** Referral % for CDN. Null = use referralPercent. */
  @Column({ nullable: true, type: "real" })
  referralPercentCdn!: number | null;

  /** Prime subscription active until (null = not active). */
  @Column({ nullable: true, type: "datetime" })
  primeActiveUntil!: Date | null;

  /** Whether user has already used the free 7-day trial (via channel). */
  @Column({ default: false, type: "boolean", nullable: false })
  primeTrialUsed!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;
}
