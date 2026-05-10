import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("cdn_proxy_services")
export default class CdnProxyService {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false, unique: true })
  proxyId!: string;

  @Column({ type: "varchar", nullable: false })
  domainName!: string;

  @Column({ type: "varchar", nullable: true })
  targetUrl!: string | null;

  @Column({ type: "varchar", nullable: true })
  status!: string | null;

  @Column({ type: "varchar", nullable: true })
  lifecycleStatus!: string | null;

  @Column({ type: "varchar", nullable: true })
  serverIp!: string | null;

  @Column({ type: "datetime", nullable: true })
  expiresAt!: Date | null;

  @Column({ type: "boolean", default: false })
  autoRenew!: boolean;

  @Column({ type: "integer", nullable: false })
  targetUserId!: number;

  @Column({ type: "integer", nullable: false })
  telegramId!: number;

  @Column({ type: "boolean", default: false })
  isDeleted!: boolean;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

