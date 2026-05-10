import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("provisioning_ticket_assignments")
@Index(["ticketId", "createdAt"])
export default class ProvisioningTicketAssignment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer" })
  ticketId!: number;

  @Column({ type: "integer", nullable: true })
  fromAssigneeUserId!: number | null;

  @Column({ type: "integer", nullable: true })
  toAssigneeUserId!: number | null;

  @Column({ type: "integer" })
  actorUserId!: number;

  @Column({ type: "varchar", nullable: true })
  note!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
