import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  CreateDateColumn,
} from "typeorm";
import { Role } from "./User";

@Entity()
export default class TempLink {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "varchar" })
  code!: string;

  @Column({ nullable: false, type: "varchar" })
  userPromoteTo!: Role;

  @Column({ nullable: true, type: "integer" })
  userId: number | null = null;

  @Column({ nullable: false, type: "datetime" })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;
}

export function createLink(role: Role): TempLink {
  const code =
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);
  const newTempLink = new TempLink();

  newTempLink.code = code;
  newTempLink.userPromoteTo = role;
  // 6 Hours
  newTempLink.expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000);

  return newTempLink;
}
