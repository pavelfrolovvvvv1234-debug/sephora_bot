import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("cdn_proxy_audit")
export default class CdnProxyAudit {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false })
  proxyId!: string;

  @Column({ type: "integer", nullable: true })
  actorUserId!: number | null;

  @Column({ type: "integer", nullable: true })
  actorTelegramId!: number | null;

  @Column({ type: "varchar", nullable: false })
  action!: string;

  @Column({ type: "boolean", default: false })
  success!: boolean;

  @Column({ type: "varchar", nullable: true })
  note!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}

