import { describe, it } from "node:test";
import assert from "node:assert";
import { Role, UserStatus } from "../../../entities/User.js";
import {
  calculateRoleFixPlan,
  normalizeLegacyRoleValue,
  normalizeLegacyStatusValue,
  resolveRoleFromAllowlist,
} from "../../../shared/auth/role-fix.js";

describe("role migration safety", () => {
  it("keeps regular users as USER in legacy normalization", () => {
    assert.strictEqual(normalizeLegacyRoleValue("user"), Role.User);
    assert.strictEqual(normalizeLegacyRoleValue("пользователь"), Role.User);
    assert.strictEqual(normalizeLegacyStatusValue("user"), UserStatus.User);
    assert.strictEqual(normalizeLegacyStatusValue("пользователь"), UserStatus.User);
  });

  it("allows moderator/admin only by allowlist", () => {
    const adminIds = new Set<number>([1001]);
    const moderatorIds = new Set<number>([2002]);

    assert.strictEqual(resolveRoleFromAllowlist(1001, adminIds, moderatorIds), Role.Admin);
    assert.strictEqual(
      resolveRoleFromAllowlist(2002, adminIds, moderatorIds),
      Role.Moderator
    );
    assert.strictEqual(resolveRoleFromAllowlist(3003, adminIds, moderatorIds), Role.User);
  });

  it("demotes accidental moderators and keeps allowlisted roles", () => {
    const users = [
      { id: 1, telegramId: 1001, role: "admin" },
      { id: 2, telegramId: 2002, role: "mod" },
      { id: 3, telegramId: 3003, role: "moderator" },
      { id: 4, telegramId: 4004, role: "user" },
    ];

    const summary = calculateRoleFixPlan(users, new Set([1001]), new Set([2002]));
    const byId = new Map(summary.toUpdate.map((x) => [x.id, x]));

    assert.strictEqual(summary.totalUsers, 4);
    assert.strictEqual(summary.willRemainAdmin, 1);
    assert.strictEqual(summary.willRemainModerator, 1);
    assert.strictEqual(summary.willChangeModeratorToUser, 1);

    assert.strictEqual(byId.get(3)?.newRole, Role.User);
    assert.strictEqual(byId.get(4), undefined);
  });
});
