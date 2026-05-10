import { Role, UserStatus } from "../../entities/User.js";

export type RoleFixUser = {
  id: number;
  telegramId: number;
  role: Role | string;
};

export function normalizeLegacyRoleValue(value: string | null | undefined): Role {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "admin" || normalized === "админ") return Role.Admin;
  if (
    normalized === "moderator" ||
    normalized === "mod" ||
    normalized === "модератор"
  ) {
    return Role.Moderator;
  }
  return Role.User;
}

export function normalizeLegacyStatusValue(
  value: string | null | undefined
): UserStatus {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "admin" || normalized === "админ") return UserStatus.Admin;
  if (
    normalized === "moderator" ||
    normalized === "mod" ||
    normalized === "модератор"
  ) {
    return UserStatus.Moderator;
  }
  return UserStatus.User;
}

export function resolveRoleFromAllowlist(
  telegramId: number,
  adminIds: Set<number>,
  moderatorIds: Set<number>
): Role {
  if (adminIds.has(telegramId)) return Role.Admin;
  if (moderatorIds.has(telegramId)) return Role.Moderator;
  return Role.User;
}

export function calculateRoleFixPlan(
  users: RoleFixUser[],
  adminIds: Set<number>,
  moderatorIds: Set<number>
): {
  totalUsers: number;
  currentAdmins: number;
  currentModerators: number;
  currentUsers: number;
  willChangeModeratorToUser: number;
  willRemainAdmin: number;
  willRemainModerator: number;
  toUpdate: Array<{ id: number; telegramId: number; oldRole: Role; newRole: Role }>;
} {
  let currentAdmins = 0;
  let currentModerators = 0;
  let currentUsers = 0;
  let willChangeModeratorToUser = 0;
  let willRemainAdmin = 0;
  let willRemainModerator = 0;
  const toUpdate: Array<{ id: number; telegramId: number; oldRole: Role; newRole: Role }> = [];

  for (const user of users) {
    const oldRole = normalizeLegacyRoleValue(String(user.role));
    if (oldRole === Role.Admin) currentAdmins++;
    else if (oldRole === Role.Moderator) currentModerators++;
    else currentUsers++;

    const newRole = resolveRoleFromAllowlist(user.telegramId, adminIds, moderatorIds);

    if (oldRole === Role.Admin && newRole === Role.Admin) willRemainAdmin++;
    if (oldRole === Role.Moderator && newRole === Role.Moderator) willRemainModerator++;
    if (oldRole === Role.Moderator && newRole === Role.User) willChangeModeratorToUser++;

    if (oldRole !== newRole) {
      toUpdate.push({
        id: user.id,
        telegramId: user.telegramId,
        oldRole,
        newRole,
      });
    }
  }

  return {
    totalUsers: users.length,
    currentAdmins,
    currentModerators,
    currentUsers,
    willChangeModeratorToUser,
    willRemainAdmin,
    willRemainModerator,
    toUpdate,
  };
}
