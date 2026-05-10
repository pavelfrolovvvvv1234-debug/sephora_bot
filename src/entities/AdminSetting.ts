import { Entity, Column, PrimaryColumn } from "typeorm";

export const ADMIN_SETTING_KEYS = {
  SERVICE_PERCENT_ALL: "service_percent_all",
  SERVICE_PERCENT_VDS_STANDARD: "service_percent_vds_standard",
  SERVICE_PERCENT_VDS_BULLETPROOF: "service_percent_vds_bulletproof",
  SERVICE_PERCENT_DEDICATED_STANDARD: "service_percent_dedicated_standard",
  SERVICE_PERCENT_DEDICATED_BULLETPROOF: "service_percent_dedicated_bulletproof",
} as const;

@Entity("admin_settings")
export default class AdminSetting {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "varchar", length: 32, default: "0" })
  value!: string;
}
