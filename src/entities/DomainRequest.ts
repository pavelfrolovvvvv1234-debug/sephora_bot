import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum DomainRequestStatus {
  InProgress = "in_progress",
  Failed = "failed",
  Completed = "completed",
  Expired = "expired",
}

@Entity()
export default class DomainRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false })
  domainName!: string;

  @Column({ type: "varchar", nullable: false })
  zone!: string;

  @Column({
    default: DomainRequestStatus.InProgress,
    type: "varchar",
    nullable: false,
  })
  status!: DomainRequestStatus;

  @Column({ nullable: false, type: "integer" })
  target_user_id!: number;

  @Column({ nullable: true, type: "text" })
  additionalInformation!: string;

  @Column({ nullable: true, type: "integer" })
  mod_id!: number;

  @Column({ nullable: false, type: "real" })
  price!: number;

  @Column({ nullable: true, type: "datetime" })
  expireAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;

  @Column({ nullable: true, type: "datetime" })
  payday_at!: Date;
}

export function createDomainRequest(
  domainName: string,
  zone: string,
  target_user_id: number,
  mod_id: number
): DomainRequest {
  const newDomainRequest = new DomainRequest();

  newDomainRequest.domainName = domainName;
  newDomainRequest.zone = zone;
  newDomainRequest.target_user_id = target_user_id;
  newDomainRequest.mod_id = mod_id;

  return newDomainRequest;
}
