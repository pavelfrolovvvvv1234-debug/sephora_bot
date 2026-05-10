import type { DataSource } from "typeorm";
import type { AppContext } from "../types/context.js";
import User, { Role } from "../../entities/User.js";

export const ROLE_LABELS_RU: Record<Role, string> = {
  [Role.User]: "Пользователь",
  [Role.Moderator]: "Модератор",
  [Role.Admin]: "Админ",
};

export const ROLE_LEVEL: Record<Role, number> = {
  [Role.User]: 1,
  [Role.Moderator]: 2,
  [Role.Admin]: 3,
};

export function hasRoleAtLeast(role: Role, required: Role): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

export async function getActorRole(ctx: AppContext): Promise<Role | null> {
  const session = await ctx.session;
  return session?.main?.user?.role ?? null;
}

export async function isAdmin(ctx: AppContext): Promise<boolean> {
  const role = await getActorRole(ctx);
  return role === Role.Admin;
}

export async function isModerator(ctx: AppContext): Promise<boolean> {
  const role = await getActorRole(ctx);
  return role === Role.Moderator || role === Role.Admin;
}

export async function requireAdmin(ctx: AppContext): Promise<boolean> {
  if (await isAdmin(ctx)) return true;
  await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
  return false;
}

export async function requireModeratorOrAdmin(ctx: AppContext): Promise<boolean> {
  if (await isModerator(ctx)) return true;
  await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
  return false;
}

export function canViewPasswords(role: Role): boolean {
  return role === Role.Admin;
}

export function canManageServices(role: Role): boolean {
  return role === Role.Moderator || role === Role.Admin;
}

export function canEditBalance(role: Role): boolean {
  return role === Role.Admin;
}

export function canChangeRoles(role: Role): boolean {
  return role === Role.Admin;
}

export async function resolveRoleByUserId(dataSource: DataSource, userId: number): Promise<Role | null> {
  const user = await dataSource.getRepository(User).findOne({ where: { id: userId }, select: ["role"] });
  return user?.role ?? null;
}
