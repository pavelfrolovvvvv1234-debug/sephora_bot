import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from "typeorm";

@Entity()
export default class ReferralReward {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false, type: "integer" })
  referrerId!: number;

  @Column({ nullable: false, type: "integer" })
  refereeId!: number;

  @Column({ nullable: false, type: "integer" })
  topUpId!: number;

  @Column({ nullable: false, type: "real" })
  amount!: number;

  @Column({ nullable: false, type: "real" })
  rewardAmount!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
