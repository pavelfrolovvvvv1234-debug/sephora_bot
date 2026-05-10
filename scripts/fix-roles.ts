import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DataSource } from "typeorm";
import User, { Role } from "../src/entities/User.js";
import AdminAuditLog from "../src/entities/AdminAuditLog.js";
import {
  calculateRoleFixPlan,
  normalizeLegacyRoleValue,
} from "../src/shared/auth/role-fix.js";

const ADMIN_IDS = [
  // put real admin Telegram IDs here
] as const;

const MODERATOR_IDS = [
  // put real moderator Telegram IDs here
] as const;

type CliMode = "dry-run" | "apply";

function getMode(): CliMode {
  const args = new Set(process.argv.slice(2));
  if (args.has("--apply")) return "apply";
  return "dry-run";
}

function parseIdsFromEnv(key: string): number[] {
  const raw = process.env[key]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
}

function resolveAllowlist(): { adminIds: Set<number>; moderatorIds: Set<number> } {
  const envAdmin = parseIdsFromEnv("ROLE_FIX_ADMIN_IDS");
  const envModerator = parseIdsFromEnv("ROLE_FIX_MODERATOR_IDS");
  const adminIds = new Set<number>([...ADMIN_IDS, ...envAdmin]);
  const moderatorIds = new Set<number>([...MODERATOR_IDS, ...envModerator]);

  for (const adminId of adminIds) {
    moderatorIds.delete(adminId);
  }

  return { adminIds, moderatorIds };
}

function getBackupPath(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dbPath}.backup-${stamp}`;
}

async function createBackup(dbPath: string): Promise<string> {
  const backupPath = getBackupPath(dbPath);
  await fs.copyFile(dbPath, backupPath);
  return backupPath;
}

function printSummary(summary: ReturnType<typeof calculateRoleFixPlan>): void {
  console.log("=== FIX ROLES DRY-RUN SUMMARY ===");
  console.log(`total users: ${summary.totalUsers}`);
  console.log(`current admins count: ${summary.currentAdmins}`);
  console.log(`current moderators count: ${summary.currentModerators}`);
  console.log(`current users count: ${summary.currentUsers}`);
  console.log(
    `users that will be changed MODERATOR -> USER: ${summary.willChangeModeratorToUser}`
  );
  console.log(`users that will remain ADMIN: ${summary.willRemainAdmin}`);
  console.log(`users that will remain MODERATOR: ${summary.willRemainModerator}`);
  console.log(`total users that will be updated: ${summary.toUpdate.length}`);
}

async function confirmApply(changes: number): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Apply role updates for ${changes} user(s)? Type "apply" to continue: `
    );
    return answer.trim().toLowerCase() === "apply";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const mode = getMode();
  const dbPath = path.resolve(process.cwd(), "data.db");
  const backupCommand = `cp "${dbPath}" "${dbPath}.backup.$(date +%F_%H-%M-%S)"`;
  console.log(`backup command: ${backupCommand}`);

  const dataSource = new DataSource({
    type: "better-sqlite3",
    database: dbPath,
    synchronize: false,
    logging: false,
    entities: [User, AdminAuditLog],
  });

  await dataSource.initialize();
  try {
    const userRepo = dataSource.getRepository(User);
    const auditRepo = dataSource.getRepository(AdminAuditLog);
    const users = await userRepo.find({
      select: ["id", "telegramId", "role"],
      order: { id: "ASC" },
    });

    const { adminIds, moderatorIds } = resolveAllowlist();
    console.log(`allowlist admins: ${adminIds.size}`);
    console.log(`allowlist moderators: ${moderatorIds.size}`);

    const summary = calculateRoleFixPlan(users, adminIds, moderatorIds);
    printSummary(summary);

    if (mode !== "apply") {
      console.log("dry-run mode: no DB changes applied");
      return;
    }

    if (summary.toUpdate.length === 0) {
      console.log("nothing to update");
      return;
    }

    const confirmed = await confirmApply(summary.toUpdate.length);
    if (!confirmed) {
      console.log('cancelled: confirmation token was not "apply"');
      return;
    }

    const backupPath = await createBackup(dbPath);
    console.log(`backup created: ${backupPath}`);

    await dataSource.transaction(async (manager) => {
      const txUserRepo = manager.getRepository(User);
      const txAuditRepo = manager.getRepository(AdminAuditLog);

      for (const item of summary.toUpdate) {
        await txUserRepo.update(item.id, { role: item.newRole });

        const oldRole = normalizeLegacyRoleValue(item.oldRole);
        if (oldRole === Role.Moderator && item.newRole === Role.User) {
          const rec = txAuditRepo.create({
            actorUserId: 0,
            targetUserId: item.id,
            action: "role_auto_fixed",
            oldValue: "MODERATOR",
            newValue: "USER",
          });
          await txAuditRepo.save(rec);
        }
      }
    });

    const counts = await userRepo
      .createQueryBuilder("u")
      .select("u.role", "role")
      .addSelect("COUNT(*)", "count")
      .groupBy("u.role")
      .getRawMany<{ role: string; count: string }>();

    console.log("apply complete");
    console.log("new role counts:");
    for (const row of counts) {
      console.log(`- ${row.role}: ${row.count}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error("fix-roles failed:", error);
  process.exitCode = 1;
});
