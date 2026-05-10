import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("provisioning_ticket_checklist")
@Index(["ticketId", "key"], { unique: true })
export default class ProvisioningTicketChecklist {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @Column({ type: "varchar" })
  key!: string;

  @Column({ type: "boolean", default: false })
  isChecked!: boolean;

  @Column({ type: "integer", nullable: true })
  checkedByUserId!: number | null;

  @Column({ type: "datetime", nullable: true })
  checkedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
