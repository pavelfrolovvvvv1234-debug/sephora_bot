import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("admin_audit_log")
export default class AdminAuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer", nullable: false })
  actorUserId!: number;

  @Column({ type: "integer", nullable: false })
  targetUserId!: number;

  @Column({ type: "varchar", nullable: false })
  action!: string;

  @Column({ type: "varchar", nullable: true })
  oldValue!: string | null;

  @Column({ type: "varchar", nullable: true })
  newValue!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
