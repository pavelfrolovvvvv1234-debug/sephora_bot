/**
 * Referrals menu for referral system.
 *
 * @module ui/menus/referrals-menu
 */

import { Menu } from "@grammyjs/menu";
import { InlineKeyboard } from "grammy";
import type { AppContext } from "../../shared/types/context.js";
import { ReferralService } from "../../domain/referral/ReferralService.js";
import { UserRepository } from "../../infrastructure/db/repositories/UserRepository.js";
import { MIN_WITHDRAW_AMOUNT } from "../conversations/withdraw-conversation.js";
import User from "../../entities/User.js";
import ReferralReward from "../../entities/ReferralReward.js";
import ServiceInvoice, { ServiceInvoiceStatus } from "../../entities/ServiceInvoice.js";
import TopUp, { TopUpStatus } from "../../entities/TopUp.js";

/** Default referral commission % when user has no custom value. */
const DEFAULT_REFERRAL_PERCENT = 5;

export type ReferralSummary = {
  totalReferees: number;
  conversionPercent: number;
  avgDeposit: number;
  referralPercent: number;
  activeReferees30d: number;
};

async function getReferralSummary(
  dataSource: AppContext["appDataSource"],
  referrerId: number
): Promise<ReferralSummary> {
  const userRepo = dataSource.getRepository(User);
  const referrer = await userRepo.findOne({ where: { id: referrerId }, select: ["id", "referralPercent"] });
  const referralPercent = referrer?.referralPercent != null ? referrer.referralPercent : DEFAULT_REFERRAL_PERCENT;

  const referees = await dataSource.manager.find(User, {
    where: { referrerId },
    select: ["id"],
  });
  const totalReferees = referees.length;
  const refereeIds = referees.map((r) => r.id);

  let refereesWithDeposit = 0;
  let totalDepositSum = 0;
  let activeReferees30d = 0;

  if (refereeIds.length > 0) {
    const topUpRepo = dataSource.getRepository(TopUp);
    const depositQb = topUpRepo
      .createQueryBuilder("t")
      .select("t.target_user_id", "uid")
      .addSelect("SUM(t.amount)", "sum")
      .where("t.target_user_id IN (:...ids)", { ids: refereeIds })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .groupBy("t.target_user_id");
    const depositRows = await depositQb.getRawMany<{ uid: number; sum: string }>();
    refereesWithDeposit = depositRows.length;
    totalDepositSum = depositRows.reduce((acc, r) => acc + Number(r.sum ?? 0), 0);

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeFromTopUp = await topUpRepo
      .createQueryBuilder("t")
      .select("DISTINCT t.target_user_id", "uid")
      .where("t.target_user_id IN (:...ids)", { ids: refereeIds })
      .andWhere("t.status = :status", { status: TopUpStatus.Completed })
      .andWhere("t.createdAt >= :since", { since: since30d })
      .getRawMany<{ uid: number }>();
    const activeFromInvoices = await dataSource
      .getRepository(ServiceInvoice)
      .createQueryBuilder("i")
      .select("DISTINCT i.userId", "uid")
      .where("i.userId IN (:...ids)", { ids: refereeIds })
      .andWhere("i.status = :status", { status: ServiceInvoiceStatus.Paid })
      .andWhere("COALESCE(i.paidAt, i.createdAt) >= :since", { since: since30d })
      .getRawMany<{ uid: number }>();
    const activeIds = new Set<number>([
      ...activeFromTopUp.map((r) => r.uid),
      ...activeFromInvoices.map((r) => r.uid),
    ]);
    activeReferees30d = activeIds.size;
  }

  const conversionPercent = totalReferees > 0 ? (refereesWithDeposit / totalReferees) * 100 : 0;
  const avgDeposit = refereesWithDeposit > 0 ? totalDepositSum / refereesWithDeposit : 0;

  return {
    totalReferees,
    conversionPercent,
    avgDeposit,
    referralPercent,
    activeReferees30d,
  };
}

async function getReferralStats(
  dataSource: AppContext["appDataSource"],
  referrerId: number,
  since?: Date
): Promise<{ topupsCount: number; newClientsCount: number; profit: number }> {
  const rewardRepo = dataSource.getRepository(ReferralReward);
  const countQb = rewardRepo
    .createQueryBuilder("r")
    .where("r.referrerId = :rid", { rid: referrerId });
  if (since) {
    countQb.andWhere("r.createdAt >= :since", { since });
  }
  const topupsCount = await countQb.getCount();
  const sumResult = await rewardRepo
    .createQueryBuilder("r")
    .select("COALESCE(SUM(r.rewardAmount), 0)", "total")
    .where("r.referrerId = :rid", { rid: referrerId })
    .andWhere(since ? "r.createdAt >= :since" : "1=1", since ? { since } : {})
    .getRawOne<{ total: string }>();
  const profit = Math.round(Number(sumResult?.total ?? 0) * 100) / 100;

  const userQb = dataSource
    .getRepository(User)
    .createQueryBuilder("u")
    .where("u.referrerId = :rid", { rid: referrerId });
  if (since) {
    userQb.andWhere("u.createdAt >= :since", { since });
  }
  const newClientsCount = await userQb.getCount();

  return { topupsCount, newClientsCount, profit };
}

/**
 * Referrals menu.
 */
export const referralsMenu = new Menu<AppContext>("referrals-menu", {
  autoAnswer: false,
})
  .url(
    (ctx) => ctx.t("button-share-link"),
    async (ctx) => {
      const session = await ctx.session;
      const referralService = new ReferralService(
        ctx.appDataSource,
        new UserRepository(ctx.appDataSource)
      );
      const referralLink = await referralService.getReferralLink(
        session.main.user.id
      );
      // Use Telegram share URL
      return `https://t.me/share/url?url=${encodeURIComponent(
        referralLink
      )}&text=${encodeURIComponent(ctx.t("referrals-share-text"))}`;
    }
  )
  .text(
    (ctx) => ctx.t("button-withdraw"),
    async (ctx) => {
      const session = await ctx.session;
      const userRepo = ctx.appDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: session.main.user.id } });
      const refBalance = user?.referralBalance ?? session.main.user.referralBalance ?? 0;

      if (refBalance < MIN_WITHDRAW_AMOUNT) {
        const alertText = ctx.t("withdraw-minimum-alert", { balance: refBalance }).slice(0, 200);
        await ctx.answerCallbackQuery({ text: alertText, show_alert: true }).catch(() => {});
        return;
      }

      await ctx.answerCallbackQuery().catch(() => {});
      delete session.other.withdrawStart;
      delete session.other.withdrawInitialAmount;
      try {
        await ctx.conversation.enter("withdrawRequestConversation");
      } catch (error: any) {
        await ctx.reply(ctx.t("error-unknown", { error: "failed to start" }), { parse_mode: "HTML" }).catch(() => {});
      }
    }
  )
  .row()
  .text(
    (ctx) => ctx.t("button-referral-stats"),
    async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const session = await ctx.session;
      const referrerId = session.main.user.id;
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [summary, s24h, s7d, s30d, sAll] = await Promise.all([
        getReferralSummary(ctx.appDataSource, referrerId),
        getReferralStats(ctx.appDataSource, referrerId, since24h),
        getReferralStats(ctx.appDataSource, referrerId, since7d),
        getReferralStats(ctx.appDataSource, referrerId, since30d),
        getReferralStats(ctx.appDataSource, referrerId),
      ]);

      const fmt = (n: number) => (n === Math.floor(n) ? String(n) : n.toFixed(2));
      const block = (
        period: string,
        topups: number,
        newClients: number,
        profitVal: number
      ) =>
        `<b>${period}</b>\n├ ${ctx.t("admin-statistics-topups")}: ${fmt(topups)}\n├ ${ctx.t("referral-stat-new-clients")}: ${fmt(newClients)}\n└ ${ctx.t("referral-stat-earned")}: ${fmt(profitVal)} $`;

      const summaryLines = [
        ctx.t("referral-stat-count", { count: summary.totalReferees }),
        ctx.t("referral-stat-reg2dep", { percent: fmt(summary.conversionPercent) }),
        ctx.t("referral-stat-avg-deposit", { amount: fmt(summary.avgDeposit) }),
        ctx.t("referral-stat-percent", { percent: fmt(summary.referralPercent) }),
        ctx.t("referral-stat-active-30d", { count: summary.activeReferees30d }),
      ].join("\n");

      const text = [
        ctx.t("referral-statistics-header"),
        "",
        summaryLines,
        "",
        block(ctx.t("admin-statistics-24h"), s24h.topupsCount, s24h.newClientsCount, s24h.profit),
        "",
        block(ctx.t("admin-statistics-7d"), s7d.topupsCount, s7d.newClientsCount, s7d.profit),
        "",
        block(ctx.t("admin-statistics-30d"), s30d.topupsCount, s30d.newClientsCount, s30d.profit),
        "",
        block(ctx.t("admin-statistics-all"), sAll.topupsCount, sAll.newClientsCount, sAll.profit),
      ].join("\n");

      const keyboard = new InlineKeyboard().text(ctx.t("button-back"), "back:profile");
      await ctx.editMessageText(text, {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    }
  )
  .row()
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if ((session as any)?.other?.profileNavSource === "profile") {
      const { getProfileText, profileMenu } = await import("./profile-menu.js");
      const profileText = await getProfileText(ctx);
      await ctx.editMessageText(profileText, {
        reply_markup: profileMenu,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }
    const renderer = (await import("../screens/renderer.js")).ScreenRenderer.fromContext(ctx);
    const screen = renderer.renderWelcome({
      balance: session.main.user.balance,
    });

    const { getReplyMainMenu } = await import("./main-menu-registry.js");
    await ctx.editMessageText(screen.text, {
      reply_markup: await getReplyMainMenu(),
      parse_mode: screen.parse_mode,
    });
  });
