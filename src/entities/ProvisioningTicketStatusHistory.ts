import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("provisioning_ticket_status_history")
@Index(["ticketId", "createdAt"])
export default class ProvisioningTicketStatusHistory {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @Column({ type: "varchar", nullable: true })
  fromStatus!: string | null;

  @Column({ type: "varchar" })
  toStatus!: string;

  @Column({ type: "integer" })
  actorUserId!: number;

  @Column({ type: "varchar", nullable: true })
  note!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
