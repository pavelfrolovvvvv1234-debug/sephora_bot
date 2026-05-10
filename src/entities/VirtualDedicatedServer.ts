import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

enum VdsStatus {
  InProgress = "in_progress",
  Created = "created",
}

@Entity("vdslist")
export default class VirtualDedicatedServer {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Proxmox / VMManager host id — must be unique per row. */
  @Column({ type: "integer", nullable: false, unique: true })
  vdsId!: number;

  @Column({ default: "root", type: "varchar", nullable: false })
  login!: string;

  @Column({ type: "varchar", nullable: false })
  password!: string;

  @Column({ nullable: true, type: "varchar" })
  ipv4Addr!: string;

  @Column({ type: "integer", nullable: false })
  cpuCount!: number;

  // Mbits/ps
  @Column({ type: "integer", nullable: false })
  networkSpeed!: number;

  @Column({ type: "boolean", nullable: false })
  isBulletproof!: boolean;

  @Column({ nullable: true, type: "datetime" })
  payDayAt!: Date | null;

  // Gb
  @Column({ type: "integer", nullable: false })
  ramSize!: number;

  @Column({ type: "integer", nullable: false })
  diskSize!: number;

  @Column({ type: "integer", nullable: false })
  lastOsId!: number;

  @Column({ type: "varchar", nullable: false })
  rateName!: string;

  @Column({ nullable: false, type: "datetime" })
  expireAt!: Date;

  @Column({ nullable: false, type: "integer" })
  targetUserId!: number;

  @Column({ nullable: false, type: "real" })
  renewalPrice!: number;

  @Column({ nullable: true, type: "varchar" })
  displayName!: string | null;

  /** Set when VPS was purchased as part of an infrastructure bundle (e.g. "1m", "3m"). */
  @Column({ nullable: true, type: "varchar" })
  bundleType!: string | null;

  /** Optional reseller owner identifier for API-scoped access. */
  @Column({ nullable: true, type: "varchar" })
  resellerId!: string | null;

  /** Optional reseller client identifier (their CRM/customer ID). */
  @Column({ nullable: true, type: "varchar" })
  resellerClientId!: string | null;

  /** Monthly auto-renewal from balance when the period ends. */
  @Column({ default: true, type: "boolean" })
  autoRenewEnabled!: boolean;

  /** Admin blocked: user cannot start/stop/manage until cleared. */
  @Column({ default: false, type: "boolean" })
  adminBlocked!: boolean;

  /** Set when subscription expired without renewal: user actions disabled until renewal. */
  @Column({ default: false, type: "boolean" })
  managementLocked!: boolean;

  /** Extra IPv4 slots purchased (0–9); total IPs = 1 + extraIpv4Count, max 10. */
  @Column({ default: 0, type: "integer" })
  extraIpv4Count!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;
}

export function generatePassword(length: number): string {
  const charset =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }
  return password;
}

export function generateRandomName(length: number): string {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const words = [
    "Alpha",
    "Beta",
    "Gamma",
    "Delta",
    "Epsilon",
    "Zeta",
    "Eta",
    "Theta",
    "Iota",
    "Kappa",
  ];
  let name = words[Math.floor(Math.random() * words.length)];
  for (let i = name.length; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    name += charset[randomIndex];
  }
  return name;
}
