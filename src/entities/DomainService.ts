import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";

@Entity()
export default class DomainService {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", nullable: false })
  domain!: string;

  // Zone list
  // com
  // org
  // net
  // biz
  // club
  // pro
  // uk
  // cc
  // io
  // us
  // at
  // ca
  // guru
  // link
  // info
  @Column({ type: "varchar", nullable: false })
  zone!: string;

  @Column({ type: "text", nullable: false })
  nameservers!: string;

  @Column({ nullable: false, type: "integer" })
  target_user_id!: number;

  @Column({ nullable: false, type: "datetime" })
  expire_at!: Date;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ nullable: false, type: "datetime" })
  payday_at!: Date;
}
