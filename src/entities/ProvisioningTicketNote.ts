import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("provisioning_ticket_notes")
@Index(["ticketId", "createdAt"])
export default class ProvisioningTicketNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @Column({ type: "integer" })
  actorUserId!: number;

  @Column({ type: "boolean", default: true })
  isInternal!: boolean;

  @Column({ type: "text" })
  text!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
