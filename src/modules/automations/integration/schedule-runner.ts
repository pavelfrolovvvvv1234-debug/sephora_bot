/**
 * Schedule runner: run SCHEDULE (cron/calendar) scenarios for matching users.
 *
 * @module modules/automations/integration/schedule-runner
 */

import type { DataSource } from "typeorm";
import type { Bot } from "grammy";
import cronParser from "cron-parser";
import { getPublishedConfig, getAllPublishedKeys, runScenarioForScheduleUser } from "../engine/index.js";
import type { ScenarioConfig } from "../schemas/scenario-config.schema.js";
import AutomationScenario from "../../../entities/automations/AutomationScenario.js";
import User from "../../../entities/User.js";
import VirtualDedicatedServer from "../../../entities/VirtualDedicatedServer.js";
import { Logger } from "../../../app/logger.js";

const lastCronRun = new Map<string, number>();
const lastCalendarRun = new Map<string, string>();

function isEndOfMonth(daysBefore: number, tz: string): boolean {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: tz });
  const day = parseInt(formatter.format(now), 10);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return day >= lastDay - daysBefore && day <= lastDay;
}

function cronShouldRunNow(scenarioKey: string, expression: string): boolean {
  const now = Date.now();
  const windowMs = 65 * 60 * 1000;
  try {
    const interval = (cronParser as unknown as { parseExpression: (expr: string, opts?: { currentDate?: Date }) => { prev: () => Date } }).parseExpression(expression, { currentDate: new Date(now - windowMs) });
    const prev = interval.prev().getTime();
    if (now - prev > windowMs) return false;
    const last = lastCronRun.get(scenarioKey) ?? 0;
    if (prev <= last) return false;
    lastCronRun.set(scenarioKey, now);
    return true;
  } catch {
    return false;
  }
}

function matchesSchedule(config: ScenarioConfig, scenarioKey: string, now: Date): boolean {
  const schedule = config.trigger.schedule;
  if (!schedule) return false;
  if (schedule.type === "cron") {
    return cronShouldRunNow(scenarioKey, schedule.expression);
  }
  if (schedule.type === "calendar") {
    const tz = schedule.timezone || "UTC";
    const daysBefore = schedule.daysBefore ?? 2;
    if (schedule.window === "end_of_month") {
      if (!isEndOfMonth(daysBefore, tz)) return false;
      const slot = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
      if (lastCalendarRun.get(scenarioKey) === slot) return false;
      lastCalendarRun.set(scenarioKey, slot);
      return true;
    }
  }
  return false;
}

async function getUsersForSegment(
  dataSource: DataSource,
  segmentKey: string | undefined,
  limit: number
): Promise<Array<{ id: number; balance: number; hasActiveVds: number; createdAt: Date }>> {
  const userRepo = dataSource.getRepository(User);
  const vdsRepo = dataSource.getRepository(VirtualDedicatedServer);
  const now = new Date();

  const allUsers = await userRepo.find({
    select: ["id", "balance", "createdAt"],
    where: { isBanned: false },
    take: limit * 2,
  });

  const vdsCountByUser = new Map<number, number>();
  const vdsList = await vdsRepo
    .createQueryBuilder("v")
    .select("v.targetUserId", "userId")
    .addSelect("COUNT(1)", "cnt")
    .where("v.expireAt > :now OR (v.payDayAt IS NOT NULL AND v.payDayAt > :now)", { now })
    .groupBy("v.targetUserId")
    .getRawMany<{ userId: number; cnt: string }>();
  for (const row of vdsList) {
    vdsCountByUser.set(row.userId, parseInt(row.cnt, 10));
  }

  const withMeta = allUsers.map((u) => ({
    id: u.id,
    balance: u.balance,
    hasActiveVds: vdsCountByUser.get(u.id) ?? 0,
    createdAt: u.createdAt,
  }));

  if (!segmentKey) {
    return withMeta.slice(0, limit);
  }

  if (segmentKey === "inactive_30d") {
    return withMeta
      .filter((u) => u.balance === 0 && u.hasActiveVds === 0)
      .slice(0, limit);
  }
  if (segmentKey === "has_balance_no_services") {
    return withMeta
      .filter((u) => u.balance >= 10 && u.hasActiveVds === 0)
      .slice(0, limit);
  }
  if (segmentKey === "anniversary_1y") {
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    return withMeta
      .filter((u) => u.createdAt <= oneYearAgo)
      .slice(0, limit);
  }
  if (segmentKey === "activity_drop") {
    return [];
  }
  return withMeta.slice(0, limit);
}

export function startScheduleRunner(dataSource: DataSource, bot: Bot): () => void {
  const sendMessage: (tid: number, text: string, buttons?: Array<{ text: string; url?: string; callback_data?: string }>) => Promise<void> = async (tid, text, buttons) => {
    const extra: { parse_mode?: string; reply_markup?: unknown } = { parse_mode: "HTML" };
    if (buttons?.length) {
      const { InlineKeyboard } = await import("grammy");
      const kb = new InlineKeyboard();
      for (const b of buttons) {
        if (b.url) kb.url(b.text, b.url);
        else if (b.callback_data) kb.text(b.text, b.callback_data);
      }
      extra.reply_markup = kb;
    }
    await bot.api.sendMessage(tid, text, extra as Parameters<typeof bot.api.sendMessage>[2]).catch(() => {});
  };

  const tick = async (): Promise<void> => {
    try {
      const scenarioRepo = dataSource.getRepository(AutomationScenario);
      const publishedKeys = await getAllPublishedKeys(dataSource);
      const now = new Date();

      for (const key of publishedKeys) {
        const scenario = await scenarioRepo.findOne({ where: { key } });
        if (!scenario?.enabled) continue;

        const config = await getPublishedConfig(dataSource, key);
        if (!config) continue;
        if (config.trigger.type !== "SCHEDULE") continue;
        if (!matchesSchedule(config, key, now)) continue;

        const segmentKey = config.segment?.segmentKey;
        const users = await getUsersForSegment(dataSource, segmentKey, 500);
        let sent = 0;
        for (const u of users) {
          const contextData: Record<string, number | string> = {
            balance: u.balance,
            has_active_services: u.hasActiveVds,
            last_activity_days: 30,
          };
          const outcome = await runScenarioForScheduleUser({
            dataSource,
            scenarioKey: key,
            userId: u.id,
            sendMessage,
            contextData,
          });
          if (outcome === "sent") sent++;
        }
        if (sent > 0) Logger.info(`[Automations] Schedule ${key} sent to ${sent} users`);
      }
    } catch (e) {
      Logger.error("[Automations] Schedule runner error", e);
    }
  };

  const intervalMs = 60 * 60 * 1000;
  const id = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(id);
}
