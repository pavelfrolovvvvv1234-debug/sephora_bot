/**
 * Admin menu: Automations / Scenarios / Notifications.
 * List scenarios, enable/disable.
 *
 * @module ui/menus/admin-automations-menu
 */

import { Menu } from "@grammyjs/menu";
import type { AppContext } from "../../shared/types/context.js";
import { Role } from "../../entities/User.js";
import { ensureSessionUser } from "../../shared/utils/session-user.js";
import AutomationScenario from "../../entities/automations/AutomationScenario.js";
import { ScenarioAdminService } from "../../modules/automations/admin/scenario-admin.service.js";

const safeT = (ctx: AppContext, key: string, vars?: Record<string, string | number>): string => {
  const tFn = (ctx as { t?: (k: string, v?: Record<string, string | number>) => string }).t;
  return typeof tFn === "function" ? tFn.call(ctx, key, vars ?? {}) : key;
};

export async function buildAdminAutomationsText(ctx: AppContext): Promise<string> {
  try {
    const ds = ctx.appDataSource;
    const service = new ScenarioAdminService(ds);
    const scenarios = await service.listScenarios();
  const lines: string[] = [safeT(ctx, "admin-automations-header"), "", safeT(ctx, "admin-automations-description"), ""];
  if (scenarios.length === 0) {
    lines.push(safeT(ctx, "admin-automations-empty"));
  } else {
    for (const s of scenarios) {
      const status = s.enabled ? "✅" : "⏸";
      const name = (s.name || s.key).slice(0, 24);
      lines.push(`${status} <code>${s.key}</code> — ${name}`);
    }
  }
    return lines.join("\n");
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    if (errorMsg.includes("No metadata") || errorMsg.includes("AutomationScenario")) {
      return [
        safeT(ctx, "admin-automations-header"),
        "",
        "⚠️ Сущности автоматизаций не загружены. Перезапустите бота после добавления новых сущностей.",
        "",
        "Entities not loaded. Restart bot after adding new entities.",
      ].join("\n");
    }
    throw error;
  }
}

export const adminAutomationsMenu = new Menu<AppContext>("admin-automations-menu").dynamic(
  async (ctx, range) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      range.text(safeT(ctx, "button-back"), async (ctx) => {
        await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
          reply_markup: (await import("./admin-menu.js")).adminMenu,
          parse_mode: "HTML",
        });
      });
      return;
    }
    if (session.main.user.role !== Role.Admin) {
      range.text(safeT(ctx, "button-back"), async (ctx) => {
        await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
          reply_markup: (await import("./admin-menu.js")).adminMenu,
          parse_mode: "HTML",
        });
      });
      return;
    }

    const ds = ctx.appDataSource;
    const service = new ScenarioAdminService(ds);
    const scenarios = await service.listScenarios();

    // Group buttons: 2 per row to fit all 19 scenarios
    for (let i = 0; i < scenarios.length; i += 2) {
      const s1 = scenarios[i];
      const s2 = scenarios[i + 1];
      
      const label1 = s1.enabled ? `${s1.key} ✅` : `${s1.key} ⏸`;
      range.text(label1, async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        try {
          const repo = ctx.appDataSource.getRepository(AutomationScenario);
          const row = await repo.findOne({ where: { key: s1.key } });
          if (!row) return;
          row.enabled = !row.enabled;
          await repo.save(row);
          const text = await buildAdminAutomationsText(ctx);
          await ctx.editMessageText(text, {
            reply_markup: adminAutomationsMenu,
            parse_mode: "HTML",
          });
        } catch (e) {
          await ctx.answerCallbackQuery(String((e as Error).message).slice(0, 200)).catch(() => {});
        }
      });
      
      if (s2) {
        const label2 = s2.enabled ? `${s2.key} ✅` : `${s2.key} ⏸`;
        range.text(label2, async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          try {
            const repo = ctx.appDataSource.getRepository(AutomationScenario);
            const row = await repo.findOne({ where: { key: s2.key } });
            if (!row) return;
            row.enabled = !row.enabled;
            await repo.save(row);
            const text = await buildAdminAutomationsText(ctx);
            await ctx.editMessageText(text, {
              reply_markup: adminAutomationsMenu,
              parse_mode: "HTML",
            });
          } catch (e) {
            await ctx.answerCallbackQuery(String((e as Error).message).slice(0, 200)).catch(() => {});
          }
        });
      }
      
      range.row();
    }

    range.text(safeT(ctx, "button-back"), async (ctx) => {
      await ctx.editMessageText(safeT(ctx, "admin-panel-header"), {
        reply_markup: (await import("./admin-menu.js")).adminMenu,
        parse_mode: "HTML",
      });
    });
  }
);
