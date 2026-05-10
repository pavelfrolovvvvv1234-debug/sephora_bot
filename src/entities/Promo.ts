import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity()
export default class Promo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "integer", nullable: false })
  maxUses!: number;

  @Column({ default: 0, type: "integer", nullable: false })
  uses!: number;

  @Column({
    type: "simple-json",
    default: "[]",
  })
  users!: number[];

  @Column({ type: "varchar", nullable: false })
  code!: string;

  @Column({ type: "real", nullable: false })
  sum!: number;

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  lastUpdateAt!: Date;
}
