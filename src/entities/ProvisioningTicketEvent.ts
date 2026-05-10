import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("provisioning_ticket_events")
@Index(["ticketId", "createdAt"])
@Index(["eventType", "createdAt"])
export default class ProvisioningTicketEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @Column({ type: "varchar" })
  eventType!: string;

  @Column({ type: "integer", nullable: true })
  actorUserId!: number | null;

  @Column({ type: "text", nullable: true })
  payload!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
