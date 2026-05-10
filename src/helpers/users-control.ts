import { Menu } from "@grammyjs/menu";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { MoreThan } from "typeorm";
import type { AppContext } from "../shared/types/context";
import type { SessionData } from "../shared/types/session";
import User, { Role, UserStatus } from "../entities/User.js";
import VirtualDedicatedServer from "../entities/VirtualDedicatedServer.js";
import DedicatedServer, { DedicatedServerStatus } from "../entities/DedicatedServer.js";
import Domain, { DomainStatus } from "../entities/Domain.js";
import CdnProxyService from "../entities/CdnProxyService.js";
import TopUp, { TopUpStatus } from "../entities/TopUp.js";
import Ticket, { TicketType } from "../entities/Ticket.js";
import DedicatedServerOrder, {
  DedicatedOrderPaymentStatus,
} from "../entities/DedicatedServerOrder.js";
import ReferralReward from "../entities/ReferralReward.js";
import { UserRepository } from "../infrastructure/db/repositories/UserRepository";
import { ReferralService } from "../domain/referral/ReferralService";
import { ensureSessionUser } from "../shared/utils/session-user.js";
import { canChangeRoles, canEditBalance, canManageServices } from "../shared/auth/permissions.js";
import { writeAdminAuditLog } from "../shared/audit/admin-audit.js";

const LIMIT_ON_PAGE = 7;

async function getQuickUserStats(
  dataSource: AppContext["appDataSource"],
  userId: number,
  userLastUpdateAt: Date
): Promise<{
  totalDeposit: number;
  activeServicesCount: number;
  totalServicesCount: number;
  ticketsCount: number;
  ordersCount: number;
  referralIncome: number;
  topupsCount: number;
  lastDepositAt: Date | null;
  lastActivityAt: Date | null;
}> {
  const now = new Date();
  const topUpRepo = dataSource.manager.getRepository(TopUp);
  const totalDepositResult = await topUpRepo
    .createQueryBuilder("t")
    .select("COALESCE(SUM(t.amount), 0)", "total")
    .where("t.target_user_id = :uid", { uid: userId })
    .andWhere("t.status = :status", { status: TopUpStatus.Completed })
    .getRawOne<{ total: string }>();
  const totalDeposit = Math.round(Number(totalDepositResult?.total ?? 0) * 100) / 100;

  const topupsCount = await topUpRepo.count({
    where: { target_user_id: userId, status: TopUpStatus.Completed },
  });

  const lastDeposit = await topUpRepo.findOne({
    where: { target_user_id: userId, status: TopUpStatus.Completed },
    order: { createdAt: "DESC" },
    select: ["createdAt"],
  });
  const lastDepositAt = lastDeposit?.createdAt ?? null;

  const [
    activeVds,
    activeDedicated,
    activeDomain,
    totalVds,
    totalDedicated,
    totalDomain,
    ticketsCount,
    legacyOrdersCount,
    provisioningOrdersCount,
  ] = await Promise.all([
    dataSource.manager.count(VirtualDedicatedServer, {
      where: { targetUserId: userId, expireAt: MoreThan(now) },
    }),
    dataSource.manager.count(DedicatedServer, {
      where: { userId, status: DedicatedServerStatus.ACTIVE },
    }),
    dataSource.manager.count(Domain, {
      where: { userId, status: DomainStatus.REGISTERED },
    }),
    dataSource.manager.count(VirtualDedicatedServer, { where: { targetUserId: userId } }),
    dataSource.manager.count(DedicatedServer, { where: { userId } }),
    dataSource.manager.count(Domain, { where: { userId } }),
    dataSource.manager.count(Ticket, { where: { userId, excludeFromUserStats: false } }),
    dataSource.manager.count(Ticket, {
      where: { userId, type: TicketType.DEDICATED_ORDER, excludeFromUserStats: false },
    }),
    dataSource.manager.count(DedicatedServerOrder, {
      where: { userId, paymentStatus: DedicatedOrderPaymentStatus.PAID, excludeFromUserStats: false },
    }),
  ]);
  const ordersCount = legacyOrdersCount + provisioningOrdersCount;
  const activeServicesCount = activeVds + activeDedicated + activeDomain;
  const totalServicesCount = totalVds + totalDedicated + totalDomain;

  const lastTicket = await dataSource.manager.getRepository(Ticket).findOne({
    where: { userId },
    order: { updatedAt: "DESC" },
    select: ["updatedAt"],
  });
  const lastActivityAt = [userLastUpdateAt, lastDepositAt, lastTicket?.updatedAt]
    .filter((d): d is Date => d != null)
    .reduce<Date | null>((max, d) => (!max || d > max ? d : max), null);

  const referralIncomeResult = await dataSource.manager
    .getRepository(ReferralReward)
    .createQueryBuilder("r")
    .select("COALESCE(SUM(r.rewardAmount), 0)", "total")
    .where("r.referrerId = :uid", { uid: userId })
    .getRawOne<{ total: string }>();
  const referralIncome = Math.round(Number(referralIncomeResult?.total ?? 0) * 100) / 100;

  return {
    totalDeposit,
    activeServicesCount,
    totalServicesCount,
    ticketsCount,
    ordersCount,
    referralIncome,
    topupsCount,
    lastDepositAt,
    lastActivityAt,
  };
}

const sorting = (
  orderBy: SessionData["other"]["controlUsersPage"]["orderBy"],
  sortBy: SessionData["other"]["controlUsersPage"]["sortBy"]
) => {
  switch (orderBy) {
    case "balance":
      return {
        balance: sortBy,
      };
    case "id":
      return {
        id: sortBy,
      };
  }
};

/** Build profile text and reply_markup for control panel user view. Pass replyMarkup (e.g. controlUser) at call site. */
export async function buildControlPanelUserReply(
  ctx: AppContext,
  user: User,
  username: string | undefined,
  replyMarkup: Menu<AppContext>
): Promise<{ text: string; reply_markup: Menu<AppContext> }> {
  let un = username;
  if (un === undefined) {
    try {
      const chat = await ctx.api.getChat(user.telegramId);
      const c = chat as { username?: string; first_name?: string; last_name?: string };
      un = (c.username ?? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()) || "Unknown";
    } catch {
      un = "Unknown";
    }
  }
  const usernameDisplay =
    un && un !== "Unknown" && !un.includes(" ")
      ? (un.startsWith("@") ? un : `@${un}`)
      : "—";
  const stats = await getQuickUserStats(ctx.appDataSource, user.id, user.lastUpdateAt);
  const session = await ctx.session;
  const uiLocale = session.main.locale === "en" ? "en" : "ru";
  const statusLine = user.isBanned
    ? ctx.t("control-panel-user-status-banned")
    : ctx.t("control-panel-user-status-active");
  const hasPrime = user.primeActiveUntil != null && new Date(user.primeActiveUntil) > new Date();
  const primeStatusLabel = hasPrime ? ctx.t("control-panel-prime-yes") : ctx.t("control-panel-prime-no");
  const statusForLevel =
    user.status && ["user", "moderator", "admin"].includes(String(user.status))
      ? (user.status as UserStatus)
      : UserStatus.User;
  const userLevelLabel = ctx.t(`admin-user-level-${statusForLevel}` as "admin-user-level-user");
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const balanceFormatted = money.format(user.balance);
  const depositFormatted = money.format(stats.totalDeposit);
  const formatRuDateTime = (d: Date) =>
    d.toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const formatEnDateOnly = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const registeredAtStr =
    uiLocale === "en" ? formatEnDateOnly(user.createdAt) : formatRuDateTime(user.createdAt);
  const lastActiveStr = stats.lastActivityAt
    ? uiLocale === "en"
      ? formatEnDateOnly(stats.lastActivityAt)
      : formatRuDateTime(stats.lastActivityAt)
    : "—";
  return {
    text: ctx.t("control-panel-about-user", {
      id: user.id,
      usernameDisplay,
      statusLine,
      primeStatusLabel,
      userLevelLabel,
      balanceFormatted,
      depositFormatted,
      topupsCount: stats.topupsCount,
      activeServicesCount: stats.activeServicesCount,
      totalServicesCount: stats.totalServicesCount,
      ticketsCount: stats.ticketsCount,
      ordersCount: stats.ordersCount,
      registeredAtStr,
      lastActiveStr,
      gap: "\n\n",
    }),
    reply_markup: replyMarkup,
  };
}

let _controlUserMenu: Menu<AppContext> | null = null;
function getControlUserMenu(): Menu<AppContext> {
  if (!_controlUserMenu) throw new Error("Control user menu not initialized");
  return _controlUserMenu;
}

/** Build referral summary message and keyboard (for admin "Партнёрка" and "back to summary"). */
export async function buildReferralSummaryReply(
  ctx: AppContext,
  user: User
): Promise<{ text: string; reply_markup: InlineKeyboard }> {
  const referralService = new ReferralService(ctx.appDataSource, new UserRepository(ctx.appDataSource));
  const link = await referralService.getReferralLink(user.id);
  const count = await referralService.countReferrals(user.id);
  const referees = await ctx.appDataSource.manager.find(User, {
    where: { referrerId: user.id },
    select: ["id"],
  });
  const refereeIds = referees.map((r) => r.id);
  let conversionPercent = 0;
  let avgDepositPerReferral = 0;
  let activeReferrals30d = 0;
  if (refereeIds.length > 0) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const refereesWithDeposit = await ctx.appDataSource.manager
      .getRepository(TopUp)
      .createQueryBuilder("t")
      .select("DISTINCT t.target_user_id", "uid")
      .where("t.target_user_id IN (:...ids)", { ids: refereeIds })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .getRawMany<{ uid: number }>();
    const countWithDeposit = refereesWithDeposit.length;
    conversionPercent = count > 0 ? Math.round((countWithDeposit / count) * 100) : 0;
    const depositSumResult = await ctx.appDataSource.manager
      .getRepository(TopUp)
      .createQueryBuilder("t")
      .select("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.target_user_id IN (:...ids)", { ids: refereeIds })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .getRawOne<{ total: string }>();
    const depositSum = Number(depositSumResult?.total ?? 0);
    avgDepositPerReferral = countWithDeposit > 0 ? Math.round((depositSum / countWithDeposit) * 100) / 100 : 0;
    const active30Result = await ctx.appDataSource.manager
      .getRepository(TopUp)
      .createQueryBuilder("t")
      .select("COUNT(DISTINCT t.target_user_id)", "cnt")
      .where("t.target_user_id IN (:...ids)", { ids: refereeIds })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .andWhere("t.createdAt >= :since", { since: thirtyDaysAgo })
      .getRawOne<{ cnt: string }>();
    activeReferrals30d = Number(active30Result?.cnt ?? 0);
  }
  const referralKeyboard = new InlineKeyboard()
    .text(ctx.t("button-ref-topup-percent"), "admin-referrals-change-percent")
    .text(ctx.t("button-referral-percent-by-service"), "admin-referrals-percent-by-service")
    .row()
    .text(ctx.t("button-back"), "admin-referrals-back");
  const referralPercent = user.referralPercent != null ? user.referralPercent : 5;
  const referralBalance = Math.round((user.referralBalance ?? 0) * 100) / 100;
  const text = ctx.t("admin-user-referrals-summary", {
    link,
    count,
    conversionPercent,
    avgDepositPerReferral,
    referralPercent,
    activeReferrals30d,
    referralBalance,
  });
  return { text, reply_markup: referralKeyboard };
}

type ManagedServiceType = "vps" | "dedicated" | "domain" | "cdn";
type ManagedServiceDraft = {
  type: ManagedServiceType;
  userId: number;
};
type ManagedServiceItem = {
  type: ManagedServiceType;
  id: number | string;
  title: string;
  expiresAt: Date | null;
  status: string;
};

async function getManagedServiceData(
  dataSource: AppContext["appDataSource"],
  userId: number
): Promise<{
  counts: { vps: number; dedicated: number; domains: number; cdn: number };
  items: ManagedServiceItem[];
}> {
  const [vpsList, dedicatedList, domainList, cdnList] = await Promise.all([
    dataSource.manager.find(VirtualDedicatedServer, { where: { targetUserId: userId } }),
    dataSource.manager.find(DedicatedServer, { where: { userId } }),
    dataSource.manager.find(Domain, { where: { userId } }),
    dataSource.manager.find(CdnProxyService, { where: { targetUserId: userId, isDeleted: false } }),
  ]);

  const items: ManagedServiceItem[] = [
    ...vpsList.map((v) => ({
      type: "vps" as const,
      id: v.id,
      title: `VDS #${v.id} • ${v.ipv4Addr || "-"}`,
      expiresAt: v.expireAt ?? null,
      status: v.managementLocked ? "locked" : v.adminBlocked ? "blocked" : "active",
    })),
    ...dedicatedList.map((d) => ({
      type: "dedicated" as const,
      id: d.id,
      title: `Dedicated #${d.id} • ${d.label || "server"}`,
      expiresAt: d.paidUntil ?? null,
      status: d.status || "requested",
    })),
    ...domainList.map((d) => ({
      type: "domain" as const,
      id: d.id,
      title: `Domain • ${d.domain}`,
      expiresAt: null,
      status: d.status || "draft",
    })),
    ...cdnList.map((c) => ({
      type: "cdn" as const,
      id: c.id,
      title: `CDN • ${c.domainName}`,
      expiresAt: c.expiresAt ?? null,
      status: c.lifecycleStatus || c.status || "active",
    })),
  ];

  return {
    counts: {
      vps: vpsList.length,
      dedicated: dedicatedList.length,
      domains: domainList.length,
      cdn: cdnList.length,
    },
    items,
  };
}

function formatIsoDate(date: Date | null): string {
  if (!date || Number.isNaN(new Date(date).getTime())) return "—";
  return new Date(date).toISOString().slice(0, 10);
}

function buildManagedServiceCard(item: ManagedServiceItem): string {
  return [
    `📦 <b>${item.title}</b>`,
    `Тип: ${item.type}`,
    `Статус: ${item.status}`,
    `Истекает: ${formatIsoDate(item.expiresAt)}`,
  ].join("\n");
}

async function buildManagedServicesSummaryText(
  ctx: AppContext,
  userId: number
): Promise<string> {
  const { counts } = await getManagedServiceData(ctx.appDataSource, userId);
  return [
    "📦 <b>Услуги пользователя</b>",
    "",
    `VPS/VDS: ${counts.vps}`,
    `Dedicated: ${counts.dedicated}`,
    `Domains: ${counts.domains}`,
    `CDN: ${counts.cdn}`,
  ].join("\n");
}

async function removeManagedService(
  ctx: AppContext,
  userId: number,
  type: ManagedServiceType,
  id: string
): Promise<boolean> {
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  if (type === "vps") {
    const repo = ctx.appDataSource.getRepository(VirtualDedicatedServer);
    const rec = await repo.findOneBy({ id: n, targetUserId: userId });
    if (!rec) return false;
    await repo.delete({ id: n });
    return true;
  }
  if (type === "dedicated") {
    const repo = ctx.appDataSource.getRepository(DedicatedServer);
    const rec = await repo.findOneBy({ id: n, userId });
    if (!rec) return false;
    await repo.delete({ id: n });
    return true;
  }
  if (type === "domain") {
    const repo = ctx.appDataSource.getRepository(Domain);
    const rec = await repo.findOneBy({ id: n, userId });
    if (!rec) return false;
    await repo.delete({ id: n });
    return true;
  }
  const repo = ctx.appDataSource.getRepository(CdnProxyService);
  const rec = await repo.findOneBy({ id: n, targetUserId: userId, isDeleted: false });
  if (!rec) return false;
  rec.isDeleted = true;
  rec.deletedAt = new Date();
  await repo.save(rec);
  return true;
}

export const controlUsers = new Menu<AppContext>("control-users", {})
  .text(
    async (ctx) => {
      const session = await ctx.session;
      switch (session.other.controlUsersPage.orderBy) {
        case "balance":
          return ctx.t("sorting-by-balance");
        case "id":
          return ctx.t("sorting-by-id");
      }
    },
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (session.other.controlUsersPage.orderBy === "balance") {
        session.other.controlUsersPage.orderBy = "id";
      } else {
        session.other.controlUsersPage.orderBy = "balance";
      }
      ctx.menu.update();
    }
  )
  .text(
    async (ctx) => {
      const session = await ctx.session;
      switch (session.other.controlUsersPage.sortBy) {
        case "ASC":
          return ctx.t("sort-asc");
        case "DESC":
          return ctx.t("sort-desc");
      }
    },
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      if (session.other.controlUsersPage.sortBy === "ASC") {
        session.other.controlUsersPage.sortBy = "DESC";
      } else {
        session.other.controlUsersPage.sortBy = "ASC";
      }
      ctx.menu.update();
    }
  )
  .row()
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      range.text(ctx.t("list-empty"), async () => {});
      range.row();
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    if (!session.other.controlUsersPage) {
      session.other.controlUsersPage = {
        orderBy: "id",
        sortBy: "ASC",
        page: 0,
      };
    }

    if (session.main.user.role != Role.User) {
      range.text(ctx.t("admin-lookup-user-button"), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        session.other.controlUsersPage.awaitingUserLookup = true;
        await ctx.reply(ctx.t("admin-lookup-user-prompt"), { parse_mode: "HTML" });
      });
      if (session.main.user.role === Role.Admin) {
        range.text(ctx.t("admin-lookup-vds-button"), async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          if (session.other.promoAdmin) {
            session.other.promoAdmin.createStep = null;
            session.other.promoAdmin.editStep = null;
            session.other.promoAdmin.createDraft = {};
            session.other.promoAdmin.editingPromoId = null;
          }
          if (!session.other.adminVds) {
            session.other.adminVds = {
              page: 0,
              searchQuery: "",
              selectedVdsId: null,
              awaitingSearch: false,
              awaitingTransferUserId: false,
            };
          }
          session.other.adminVds.awaitingSearch = true;
          await ctx.reply(ctx.t("admin-vds-search-prompt"), { parse_mode: "HTML" });
        });
      }
      range.row();

      const [users, total] = await ctx.appDataSource.manager.findAndCount(
        User,
        {
          where: { role: Role.User },
          order: sorting(
            session.other.controlUsersPage.orderBy,
            session.other.controlUsersPage.sortBy
          ),
          select: ["id", "balance", "createdAt", "telegramId"],
          skip: session.other.controlUsersPage.page * LIMIT_ON_PAGE,
          take: LIMIT_ON_PAGE,
        }
      );

      if (total === 0) {
        range.text(ctx.t("list-empty"), async () => {});
        range.row();
        range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
        return;
      }

      const maxPages = Math.max(0, Math.ceil(total / LIMIT_ON_PAGE) - 1);

      for (const user of users) {
        let username = "";
        try {
          const chat = await ctx.api.getChat(user.telegramId);
          username = chat.username || `${chat.first_name} ${chat.last_name}`;
        } catch (err) {
          username = "Unknown";
        }

        range
          .text(
            `ID: ${username} (${user.id}) - ${user.balance} $`,
            async (ctx) => {
              try {
                await ctx.answerCallbackQuery().catch(() => {});
                session.other.controlUsersPage.pickedUserData = {
                  id: user.id,
                };
                const fullUser = await ctx.appDataSource.manager.findOne(User, {
                  where: { id: user.id },
                });
                if (!fullUser) {
                  await ctx.reply(ctx.t("error-user-not-found"), { parse_mode: "HTML" });
                  return;
                }
                const menu = getControlUserMenu();
                const { text, reply_markup } = await buildControlPanelUserReply(ctx, fullUser, username, menu);
                await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                await ctx.reply(ctx.t("error-unknown", { error: msg })).catch(() => {});
              }
            }
          )
          .row();
      }

      range.text(
        (ctx) => ctx.t("pagination-left"),
        async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          session.other.controlUsersPage.page--;

          if (session.other.controlUsersPage.page < 0) {
            session.other.controlUsersPage.page = maxPages;
          }

          await ctx.menu.update({
            immediate: true,
          });
        }
      );
      range.text(
        () => `${session.other.controlUsersPage.page + 1}/${maxPages + 1}`
      );
      range.text(
        (ctx) => ctx.t("pagination-right"),
        async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          session.other.controlUsersPage.page++;

          if (session.other.controlUsersPage.page > maxPages) {
            session.other.controlUsersPage.page = 0;
          }

          await ctx.menu.update({
            immediate: true,
          });
        }
      );

      range.row();
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
    }
  });

export const controlUser = new Menu<AppContext>("control-user", {})
  .dynamic(
  async (ctx, range) => {
    const session = await ctx.session;
    if (!session?.other?.controlUsersPage?.pickedUserData) {
      range.text(ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    const hasSessionUser = session.main?.user?.id != null && session.main.user.id > 0 ? true : await ensureSessionUser(ctx);
    if (!hasSessionUser) {
      range.text(ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }

    const user = await ctx.appDataSource.manager.findOne(User, {
      where: {
        id: session.other.controlUsersPage.pickedUserData.id,
      },
    });

    if (!user) {
      range.text(ctx.t("error-user-not-found"), async () => {});
      range.row();
      range.text(ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }

    // Row 1: 💳 Баланс | 💼 Услуги
    range.text((ctx) => ctx.t("button-balance-short"), (ctx) => ctx.menu.nav("control-user-balance"));
    range.text("📦 Управление услугами", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      const picked = session.other.controlUsersPage?.pickedUserData?.id;
      if (!picked || !canManageServices(session.main.user.role)) {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
        return;
      }
      try {
        const text = await buildManagedServicesSummaryText(ctx, picked);
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: controlUserServices,
        });
      } catch {
        // Fallback for stale/non-editable messages: still open services panel.
        const text = await buildManagedServicesSummaryText(ctx, picked);
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: controlUserServices,
        });
      }
    });
    range.row();

    // Row 2: 📨 Сообщение | 🎫 Тикеты
    range.text((ctx) => ctx.t("button-message-short"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      session.other.messageToUser = { userId: user.id, telegramId: user.telegramId };
      await ctx.reply(ctx.t("admin-message-to-user-enter"), { parse_mode: "HTML" });
    });
    range.text((ctx) => ctx.t("button-tickets-short"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const count = await ctx.appDataSource.manager.count(Ticket, { where: { userId: user.id } });
      await ctx.reply(ctx.t("admin-user-tickets-summary", { count }), { parse_mode: "HTML" });
    });

    range.row();

    // Row 3: 🔐 Подписка | 🏷 Роль
    range.text((ctx) => ctx.t("button-subscription-short"), (ctx) => ctx.menu.nav("control-user-subscription"));
    if (session.main.user.role === Role.Admin) {
      range.text((ctx) => ctx.t("button-status-short"), (ctx) => ctx.menu.nav("control-user-status"));
    } else {
      range.text((ctx) => ctx.t("button-status-short"), async (ctx) => {
        await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200)).catch(() => {});
      });
    }

    range.row();

    // Row 4: 👥 Рефералы | ⛔ Блокировать
    range.text((ctx) => ctx.t("button-referrals"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const { text, reply_markup } = await buildReferralSummaryReply(ctx, user);
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup,
          link_preview_options: { is_disabled: true },
        });
      } catch (e: any) {
        await ctx.reply(ctx.t("error-unknown", { error: String(e?.message || e).slice(0, 200) }), {
          parse_mode: "HTML",
        });
      }
    });
    range.text(
      (ctx) => (user.isBanned ? ctx.t("unblock-user") : ctx.t("button-block-short")),
      async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        user.isBanned = !user.isBanned;
        await ctx.appDataSource.manager.save(user);
        ctx.menu.update();
      }
    );

    range.row();

    range.text((ctx) => ctx.t("button-control-user-back"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      await ctx.editMessageText(ctx.t("control-panel-users"), {
        parse_mode: "HTML",
        reply_markup: controlUsers,
      });
    });
  }
);

_controlUserMenu = controlUser;

async function resolveUserFromAdminLookup(ctx: AppContext, raw: string): Promise<User | null> {
  const input = raw.trim();
  if (!input) return null;
  const repo = ctx.appDataSource.getRepository(User);
  if (/^\d+$/.test(input)) {
    const n = parseInt(input, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    let u = await repo.findOne({ where: { id: n } });
    if (u) return u;
    u = await repo.findOne({ where: { telegramId: n } });
    return u;
  }
  const username = input.replace(/^@+/, "").trim();
  if (!username || !/^[a-zA-Z_][a-zA-Z0-9_]{4,31}$/.test(username)) {
    return null;
  }
  try {
    const chat = await ctx.api.getChat(`@${username}`);
    if (chat.type !== "private") return null;
    const tid = "id" in chat ? Number(chat.id) : NaN;
    if (!Number.isFinite(tid)) return null;
    return repo.findOne({ where: { telegramId: tid } });
  } catch {
    return null;
  }
}

/** Staff text handler: lookup user by DB id, Telegram id, or @username. Returns true if the message was consumed. */
export async function handleAdminUserLookupText(ctx: AppContext, raw: string): Promise<boolean> {
  const session = await ctx.session;
  if (!session.other.controlUsersPage?.awaitingUserLookup) return false;
  session.other.controlUsersPage.awaitingUserLookup = false;

  const user = await resolveUserFromAdminLookup(ctx, raw);
  if (!user) {
    await ctx.reply(ctx.t("admin-lookup-user-not-found"), { parse_mode: "HTML" });
    return true;
  }
  session.other.controlUsersPage.pickedUserData = { id: user.id };
  const menu = getControlUserMenu();
  const { text, reply_markup } = await buildControlPanelUserReply(ctx, user, undefined, menu);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup });
  return true;
}

/** Balance submenu: add / deduct. */
export const controlUserBalance = new Menu<AppContext>("control-user-balance", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    if (!canEditBalance(session.main.user.role)) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const targetUser = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
    });
    if (!targetUser) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    range.text((ctx) => ctx.t("button-add-balance"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      session.other.balanceEdit = { userId: targetUser.id, action: "add" };
      await ctx.reply(ctx.t("admin-balance-enter-amount", { action: ctx.t("admin-balance-action-add") }), {
        parse_mode: "HTML",
      });
    });
    range.text((ctx) => ctx.t("button-deduct-balance"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      session.other.balanceEdit = { userId: targetUser.id, action: "deduct" };
      await ctx.reply(ctx.t("admin-balance-enter-amount", { action: ctx.t("admin-balance-action-deduct") }), {
        parse_mode: "HTML",
      });
    });
    range.row();
    range.back((ctx) => ctx.t("button-back"));
  });

/** Subscription submenu: grant or revoke Prime. */
export const controlUserSubscription = new Menu<AppContext>("control-user-subscription", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    if (!session.other.controlUsersPage?.pickedUserData) return;
    const targetUser = await ctx.appDataSource.manager.findOne(User, {
      where: { id: session.other.controlUsersPage.pickedUserData.id },
    });
    if (!targetUser) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    range.text((ctx) => ctx.t("admin-subscription-grant"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      session.other.subscriptionEdit = { userId: targetUser.id };
      await ctx.reply(ctx.t("admin-subscription-enter-days"), { parse_mode: "HTML" });
    });
    range.text((ctx) => ctx.t("admin-subscription-revoke"), async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      targetUser.primeActiveUntil = null;
      await ctx.appDataSource.manager.save(targetUser);
      const { text, reply_markup } = await buildControlPanelUserReply(ctx, targetUser, undefined, controlUser);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup }).catch(() => {});
    });
    range.row();
    range.back((ctx) => ctx.t("button-back"));
  });

/**
 * Menu for changing user status.
 */
export const controlUserStatus = new Menu<AppContext>("control-user-status", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const hasSessionUser = await ensureSessionUser(ctx);
    if (!session || !hasSessionUser) {
      range.text(ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }

    // Only admins can change user status
    if (!canChangeRoles(session.main.user.role)) {
      await ctx.answerCallbackQuery(ctx.t("error-access-denied").substring(0, 200));
      ctx.menu.back();
      return;
    }

    if (!session.other.controlUsersPage.pickedUserData) return;

    const user = await ctx.appDataSource.manager.findOne(User, {
      where: {
        id: session.other.controlUsersPage.pickedUserData.id,
      },
    });

    if (!user) return;

    // Show current status
    range.text(
      (ctx) => ctx.t("user-status-current", { status: ctx.t(`user-status-${user.status}`) }),
      async () => {}
    );
    range.row();

    // Status selection buttons
    const statuses = [UserStatus.User, UserStatus.Moderator, UserStatus.Admin];
    for (const status of statuses) {
      if (user.status !== status) {
        range.text(
          (ctx) => ctx.t(`user-status-${status}`),
          async (ctx) => {
            await ctx.answerCallbackQuery().catch(() => {});
            const oldRole = user.role;
            user.status = status;
            user.role =
              status === UserStatus.Admin
                ? Role.Admin
                : status === UserStatus.Moderator
                  ? Role.Moderator
                  : Role.User;
            await ctx.appDataSource.manager.save(user);
            await writeAdminAuditLog(
              ctx.appDataSource,
              session.main.user.id,
              user.id,
              "role_changed",
              oldRole,
              user.role
            );
            if (status === UserStatus.Admin) {
              const { adminMenu } = await import("../ui/menus/admin-menu.js");
              await ctx.editMessageText(ctx.t("admin-panel-header"), {
                parse_mode: "HTML",
                reply_markup: adminMenu,
              });
              try {
                const { InlineKeyboard } = await import("grammy");
                await ctx.api.sendMessage(user.telegramId, ctx.t("admin-promoted-notification"), {
                  parse_mode: "HTML",
                  reply_markup: new InlineKeyboard().text(ctx.t("button-open-admin-panel"), "admin-open-panel"),
                });
              } catch (_) {
                // User may have blocked the bot or disabled messages
              }
            } else {
              ctx.menu.back();
            }
          }
        );
      } else {
        range.text(
          (ctx) => `✓ ${ctx.t(`user-status-${status}`)}`,
          async () => {}
        );
      }
      range.row();
    }

    range.back((ctx) => ctx.t("button-back"));
  });

export const controlUserServices = new Menu<AppContext>("control-user-services", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const picked = session.other.controlUsersPage?.pickedUserData?.id;
    if (!picked || !canManageServices(session.main.user.role)) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    range.text("➕ Добавить услугу", (ctx) => ctx.menu.nav("control-user-services-add"));
    range.text("➖ Удалить услугу", (ctx) => ctx.menu.nav("control-user-services-delete"));
    range.row();
    range.text("📋 Список услуг", async (ctx) => {
      const session = await ctx.session;
      (session.other as any).adminServicePanelMode = "list";
      await ctx.menu.update({ immediate: true });
    });
    range.row();
    range.text("💰 Баланс операции", (ctx) => ctx.menu.nav("control-user-balance"));
    range.row();
    range.text("⏳ Продлить услугу", async (ctx) => {
      const session = await ctx.session;
      (session.other as any).adminServicePanelMode = "extend";
      await ctx.menu.update({ immediate: true });
    });
    range.text("⛔/🟢 Блок/Разблок", async (ctx) => {
      const session = await ctx.session;
      (session.other as any).adminServicePanelMode = "lock";
      await ctx.menu.update({ immediate: true });
    });
    range.row();
    range.text("✏️ Изменить тариф", async (ctx) => {
      const session = await ctx.session;
      (session.other as any).adminServicePanelMode = "tariff";
      await ctx.menu.update({ immediate: true });
    });
    range.row();
    range.back((ctx) => ctx.t("button-back"));
  });

export const controlUserServicesAdd = new Menu<AppContext>("control-user-services-add", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const userId = session.other.controlUsersPage?.pickedUserData?.id;
    if (!userId) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    range.text("🖥 VPS/VDS", async (ctx) => {
      (session.other as any).adminServiceDraft = { type: "vps", userId } as ManagedServiceDraft;
      await ctx.reply("Введите данные:\nIP | VMID | Plan | Price | Expiration(YYYY-MM-DD)");
    });
    range.text("🧱 Dedicated", async (ctx) => {
      (session.other as any).adminServiceDraft = { type: "dedicated", userId } as ManagedServiceDraft;
      await ctx.reply("Введите данные:\nIP | ServerID | Plan | Price | Expiration(YYYY-MM-DD)");
    });
    range.row();
    range.text("🌐 Domain", async (ctx) => {
      (session.other as any).adminServiceDraft = { type: "domain", userId } as ManagedServiceDraft;
      await ctx.reply("Введите данные:\ndomain | registrar | expiry(YYYY-MM-DD)");
    });
    range.text("⚡ CDN", async (ctx) => {
      (session.other as any).adminServiceDraft = { type: "cdn", userId } as ManagedServiceDraft;
      await ctx.reply("Введите данные:\ndomain/project | plan | expiry(YYYY-MM-DD)");
    });
    range.row();
    range.back((ctx) => ctx.t("button-back"));
  });

export const controlUserServicesDelete = new Menu<AppContext>("control-user-services-delete", {})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const userId = session.other.controlUsersPage?.pickedUserData?.id;
    if (!userId) {
      range.text((ctx) => ctx.t("button-back"), (ctx) => ctx.menu.back());
      return;
    }
    const { items } = await getManagedServiceData(ctx.appDataSource, userId);
    if (items.length === 0) {
      range.text("Список пуст", async () => {});
      range.row();
      range.back((ctx) => ctx.t("button-back"));
      return;
    }
    for (const item of items.slice(0, 20)) {
      range.text(item.title, async (ctx) => {
        await ctx.reply(buildManagedServiceCard(item), {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("❌ Удалить", `admin:service:delete:confirm:${item.type}:${item.id}`)
            .text("⬅️ Назад", "admin:service:noop"),
        });
      });
      range.row();
    }
    range.back((ctx) => ctx.t("button-back"));
  });

export function registerAdminServiceManagementCallbacks(bot: Bot<AppContext>): void {
  bot.callbackQuery(/^admin:service:delete:confirm:(vps|dedicated|domain|cdn):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!canManageServices(session.main.user.role)) return;
    const userId = session.other.controlUsersPage?.pickedUserData?.id;
    if (!userId) return;
    const type = ctx.match?.[1] as ManagedServiceType;
    const id = ctx.match?.[2] as string;
    const ok = await removeManagedService(ctx, userId, type, id);
    await ctx.reply(ok ? "✅ Услуга удалена" : "❌ Не удалось удалить");
  });

  bot.callbackQuery("admin:service:noop", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  bot.on("message:text", async (ctx, next) => {
    const session = await ctx.session;
    const draft = (session.other as any).adminServiceDraft as ManagedServiceDraft | undefined;
    if (!draft) return next();
    if (!canManageServices(session.main.user.role)) {
      delete (session.other as any).adminServiceDraft;
      return next();
    }
    const raw = (ctx.message?.text || "").trim();
    if (!raw) return;
    const parts = raw.split("|").map((p) => p.trim());
    try {
      if (draft.type === "vps" || draft.type === "dedicated") {
        if (parts.length < 5) throw new Error("invalid");
        const [ip, vmid, plan, priceRaw, dateRaw] = parts;
        const price = Number(priceRaw);
        const exp = new Date(dateRaw);
        if (!Number.isFinite(price) || Number.isNaN(exp.getTime())) throw new Error("invalid");
        if (draft.type === "vps") {
          const repo = ctx.appDataSource.getRepository(VirtualDedicatedServer);
          const row = repo.create({
            targetUserId: draft.userId,
            vdsId: Number(vmid) || 0,
            login: "root",
            password: "Not set",
            ipv4Addr: ip || "0.0.0.0",
            cpuCount: 1,
            networkSpeed: 100,
            isBulletproof: false,
            payDayAt: null,
            ramSize: 1,
            diskSize: 10,
            lastOsId: 0,
            rateName: plan || "Custom",
            expireAt: exp,
            renewalPrice: price,
            displayName: null,
            bundleType: null,
            autoRenewEnabled: true,
            adminBlocked: false,
            managementLocked: false,
            extraIpv4Count: 0,
          });
          await repo.save(row);
        } else {
          const repo = ctx.appDataSource.getRepository(DedicatedServer);
          const row = repo.create({
            userId: draft.userId,
            label: `${plan} (${ip})`,
            status: DedicatedServerStatus.ACTIVE,
            ticketId: null,
            credentials: JSON.stringify({ ip, serverId: vmid }),
            paidUntil: exp,
            monthlyPrice: price,
          });
          await repo.save(row);
        }
      } else if (draft.type === "domain") {
        if (parts.length < 3) throw new Error("invalid");
        const [domainName, registrar, dateRaw] = parts;
        const exp = new Date(dateRaw);
        if (Number.isNaN(exp.getTime())) throw new Error("invalid");
        const tld = domainName.includes(".") ? domainName.split(".").pop() || "com" : "com";
        const repo = ctx.appDataSource.getRepository(Domain);
        const row = repo.create({
          userId: draft.userId,
          domain: domainName,
          tld,
          period: 1,
          price: 0,
          status: DomainStatus.REGISTERED,
          ns1: null,
          ns2: null,
          provider: registrar || "manual",
          providerDomainId: null,
          lastSyncAt: exp,
          bundleType: null,
        });
        await repo.save(row);
      } else {
        if (parts.length < 3) throw new Error("invalid");
        const [domainName, plan, dateRaw] = parts;
        const exp = new Date(dateRaw);
        if (Number.isNaN(exp.getTime())) throw new Error("invalid");
        const repo = ctx.appDataSource.getRepository(CdnProxyService);
        const row = repo.create({
          proxyId: `manual-${Date.now()}`,
          domainName,
          targetUrl: null,
          status: plan || "active",
          lifecycleStatus: "active",
          serverIp: null,
          expiresAt: exp,
          autoRenew: true,
          targetUserId: draft.userId,
          telegramId: 0,
          isDeleted: false,
          deletedAt: null,
        });
        await repo.save(row);
      }
      await ctx.reply("✅ Услуга добавлена");
    } catch {
      await ctx.reply("❌ Неверный формат данных");
    } finally {
      delete (session.other as any).adminServiceDraft;
    }
  });
}
