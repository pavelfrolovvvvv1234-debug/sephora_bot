import type { DataSource } from "typeorm";
import AdminAuditLog from "../../entities/AdminAuditLog.js";

export type AdminAuditAction =
  | "role_changed"
  | "role_auto_fixed"
  | "balance_changed"
  | "service_extended"
  | "service_blocked"
  | "service_unblocked"
  | "ticket_replied";

export async function writeAdminAuditLog(
  dataSource: DataSource,
  actorUserId: number,
  targetUserId: number,
  action: AdminAuditAction,
  oldValue?: string | null,
  newValue?: string | null
): Promise<void> {
  const repo = dataSource.getRepository(AdminAuditLog);
  const rec = repo.create({
    actorUserId,
    targetUserId,
    action,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
  });
  await repo.save(rec);
}
