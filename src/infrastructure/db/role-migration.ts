import type { DataSource } from "typeorm";
import User, { UserStatus } from "../../entities/User.js";
import { Logger } from "../../app/logger.js";
import {
  normalizeLegacyRoleValue,
  normalizeLegacyStatusValue,
} from "../../shared/auth/role-fix.js";

/**
 * Idempotent role/status migration:
 * - status newbie/newbie(ru) -> user
 * - status user/пользователь -> user
 * - status admin -> admin
 * - role values normalized to user/mod/admin
 */
export async function runRoleModelMigration(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(User);
  const users = await repo.find();
  let changed = 0;

  for (const user of users) {
    const oldRole = String(user.role || "");
    const oldStatus = String(user.status || "");
    let dirty = false;

    const nextRole = normalizeLegacyRoleValue(oldRole);
    const normalizedStatus = normalizeLegacyStatusValue(oldStatus);
    const statusByRole =
      nextRole === "admin"
        ? UserStatus.Admin
        : nextRole === "mod"
          ? UserStatus.Moderator
          : UserStatus.User;
    // Keep status aligned with effective role so regular users never appear as moderators/admins.
    const nextStatus = statusByRole !== normalizedStatus ? statusByRole : normalizedStatus;

    if (user.role !== nextRole) {
      user.role = nextRole;
      dirty = true;
    }

    if (user.status !== nextStatus) {
      user.status = nextStatus;
      dirty = true;
    }

    if (dirty) {
      await repo.save(user);
      changed++;
    }
  }

  if (changed > 0) {
    Logger.info(`Role migration applied: ${changed} user records updated`);
  }
}
