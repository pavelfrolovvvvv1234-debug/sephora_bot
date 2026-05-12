import { getAppDataSource } from "@/database";
import TopUp, { TopUpStatus } from "../entities/TopUp.js";
import { createHash, randomUUID } from "crypto";
import { CrystalPayClient } from "./crystal-pay";
import User from "../entities/User.js";
import { Api, Bot, RawApi } from "grammy";
import type { AppContext } from "../shared/types/context";
import { invalidateUser } from "../shared/user-cache.js";
import axios from "axios";
import { notifyAdminsAboutTopUp, notifyReferrerAboutReferralTopUp } from "../helpers/notifier.js";
import { Logger } from "../app/logger.js";

const CRYPTOBOT_API_URL = "https://pay.crypt.bot/api";
const HELEKET_API_URL = process.env["PAYMENT_HELEKET_API_URL"]?.trim() || "https://api.heleket.com";

type CryptoBotInvoiceResult = {
  invoice_id: number;
  pay_url?: string;
  bot_invoice_url?: string;
  status: "active" | "paid" | "expired" | "paid_over";
};

type CryptoBotResponse<T> = {
  ok: boolean;
  result?: T;
  error?: {
    name?: string;
    code?: number;
  };
};

function getCryptoBotToken(): string {
  const token =
    process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
    process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "PAYMENT_CRYPTOBOT_TOKEN or PAYMENT_CRYPTO_PAY_TOKEN is not set"
    );
  }
  return token;
}

function getHeleketConfig(): { merchant: string; apiKey: string } {
  const merchant = process.env["PAYMENT_HELEKET_MERCHANT"]?.trim();
  const apiKey = process.env["PAYMENT_HELEKET_API_KEY"]?.trim();
  if (!merchant || !apiKey) {
    throw new Error("PAYMENT_HELEKET_MERCHANT and PAYMENT_HELEKET_API_KEY are required");
  }
  return { merchant, apiKey };
}

function signHeleket(body: string, apiKey: string): string {
  return createHash("md5").update(Buffer.from(body).toString("base64") + apiKey).digest("hex");
}

type HeleketPaymentResult = {
  uuid?: string;
  order_id?: string;
  url?: string;
  status?: string;
  payment_status?: string;
};

type HeleketResponse<T> = {
  state?: number;
  result?: T;
  error_message?: string;
  message?: string;
};

async function createHeleketInvoice(
  amount: number,
  orderId: string
): Promise<{ orderId: string; url: string }> {
  const { merchant, apiKey } = getHeleketConfig();
  const payload = {
    amount: amount.toFixed(2),
    currency: "USD",
    order_id: orderId,
  };
  const body = JSON.stringify(payload);
  const sign = signHeleket(body, apiKey);

  const response = await axios.post<HeleketResponse<HeleketPaymentResult>>(
    `${HELEKET_API_URL}/v1/payment`,
    payload,
    {
      headers: {
        merchant,
        sign,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  const result = response.data?.result;
  const url = String(result?.url || "").trim();
  if (!url) {
    const err = response.data?.error_message || response.data?.message || "Heleket invoice failed";
    throw new Error(err);
  }
  return {
    orderId: String(result?.order_id || orderId),
    url,
  };
}

async function getHeleketInvoiceStatus(orderId: string): Promise<string> {
  const { merchant, apiKey } = getHeleketConfig();
  const payload = { order_id: orderId };
  const body = JSON.stringify(payload);
  const sign = signHeleket(body, apiKey);

  const response = await axios.post<HeleketResponse<HeleketPaymentResult>>(
    `${HELEKET_API_URL}/v1/payment/info`,
    payload,
    {
      headers: {
        merchant,
        sign,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );

  const result = response.data?.result;
  const status = String(result?.payment_status || result?.status || "").trim().toLowerCase();
  if (!status) {
    const err = response.data?.error_message || response.data?.message || "Heleket invoice not found";
    throw new Error(err);
  }
  return status;
}

async function createCryptoBotInvoice(amount: number): Promise<CryptoBotInvoiceResult> {
  const token = getCryptoBotToken();
  const response = await axios.post<CryptoBotResponse<CryptoBotInvoiceResult>>(
    `${CRYPTOBOT_API_URL}/createInvoice`,
    {
      asset: "USDT",
      amount: amount.toString(),
    },
    {
      headers: {
        "Crypto-Pay-API-Token": token,
      },
    }
  );

  if (!response.data?.ok || !response.data.result) {
    const errorName = response.data?.error?.name || "CryptoBot invoice failed";
    throw new Error(errorName);
  }

  return response.data.result;
}

async function getCryptoBotInvoiceStatus(
  invoiceId: string
): Promise<CryptoBotInvoiceResult["status"]> {
  const token = getCryptoBotToken();
  const response = await axios.post<
    CryptoBotResponse<{ items: CryptoBotInvoiceResult[] }>
  >(
    `${CRYPTOBOT_API_URL}/getInvoices`,
    {
      invoice_ids: [Number(invoiceId)],
    },
    {
      headers: {
        "Crypto-Pay-API-Token": token,
      },
    }
  );

  if (!response.data?.ok || !response.data.result?.items?.length) {
    const errorName =
      response.data?.error?.name || "CryptoBot invoice not found";
    throw new Error(errorName);
  }

  return response.data.result.items[0].status;
}

export class PaymentBuilder {
  constructor(private amount: number, private targetUser: number) {}

  private generatedOrderId() {
    return randomUUID();
  }

  async createCrystalPayment(): Promise<TopUp> {
    const id = process.env["PAYMENT_CRYSTALPAY_ID"];
    const secret = process.env["PAYMENT_CRYSTALPAY_SECRET_ONE"];
    if (!id || !secret) throw new Error("PAYMENT_CRYSTALPAY_ID and PAYMENT_CRYSTALPAY_SECRET_ONE required");
    const crystalpay = new CrystalPayClient(id, secret);

    const appdatasource = await getAppDataSource();
    const repo = appdatasource.getRepository(TopUp);

    const topUp = new TopUp();

    const invoice = await crystalpay.createInvoice(this.amount);
    topUp.orderId = invoice.id;
    topUp.amount = this.amount;
    topUp.target_user_id = this.targetUser;
    topUp.paymentSystem = "crystalpay";
    topUp.url = invoice.url;

    return await repo.save(topUp);
  }

  async createCryptoBotPayment(): Promise<TopUp> {
    const appdatasource = await getAppDataSource();
    const repo = appdatasource.getRepository(TopUp);

    const topUp = new TopUp();
    const invoice = await createCryptoBotInvoice(this.amount);

    topUp.orderId = String(invoice.invoice_id);
    topUp.amount = this.amount;
    topUp.target_user_id = this.targetUser;
    topUp.paymentSystem = "cryptobot";
    topUp.url = invoice.bot_invoice_url ?? invoice.pay_url ?? "";

    return await repo.save(topUp);
  }

  async createHeleketPayment(): Promise<TopUp> {
    const appdatasource = await getAppDataSource();
    const repo = appdatasource.getRepository(TopUp);
    const topUp = new TopUp();
    const orderId = this.generatedOrderId();
    const invoice = await createHeleketInvoice(this.amount, orderId);

    topUp.orderId = invoice.orderId;
    topUp.amount = this.amount;
    topUp.target_user_id = this.targetUser;
    topUp.paymentSystem = "heleket";
    topUp.url = invoice.url;

    return await repo.save(topUp);
  }
}

const TOP_UP_POLL_MS = 10_000;

/** Atomically: Created → Completed + credit user balance. Idempotent via single-row CAS on status. */
async function claimPaidTopUpCredit(
  topUpId: number
): Promise<{ user: User; topUp: TopUp } | null> {
  const datasource = await getAppDataSource();
  return datasource.transaction(async (em) => {
    const tup = await em.findOne(TopUp, {
      where: { id: topUpId, status: TopUpStatus.Created },
    });
    if (!tup) {
      return null;
    }
    const u = await em.findOneBy(User, { id: tup.target_user_id });
    if (!u) {
      Logger.error("[Payment] claimPaidTopUpCredit: user missing for TopUp", { topUpId, target: tup.target_user_id });
      return null;
    }
    const updateRes = await em
      .getRepository(TopUp)
      .createQueryBuilder()
      .update(TopUp)
      .set({ status: TopUpStatus.Completed })
      .where("id = :id AND status = :st", {
        id: topUpId,
        st: TopUpStatus.Created,
      })
      .execute();
    if ((updateRes.affected ?? 0) < 1) {
      return null;
    }

    const amount = tup.amount;
    u.balance += amount;
    await em.save(u);
    await em.update(TopUp, { id: topUpId }, { balanceCreditedAt: new Date() });

    const topUpFresh = await em.findOneBy(TopUp, { id: topUpId });
    if (!topUpFresh) {
      return null;
    }
    return { user: u, topUp: topUpFresh };
  });
}

/** After gateways report paid status: grant balance once, then referrals / notifies / hooks. */
export async function finalizePaidTopUp(bot: Bot<AppContext, Api<RawApi>>, topUpId: number): Promise<void> {
  const claimed = await claimPaidTopUpCredit(topUpId);
  if (!claimed) {
    return;
  }

  invalidateUser(claimed.user.telegramId);

  try {
    await runPostTopUpCreditSideEffects(bot, claimed.user, claimed.topUp);
  } catch (error) {
    Logger.error("[Payment] post-topup side effects failed (balance already credited)", error, {
      topUpId: claimed.topUp.id,
      userId: claimed.user.id,
    });
    try {
      await bot.api.sendMessage(
        claimed.user.telegramId,
        "Пополнение зачислено. Дополнительные уведомления временно недоступны — обратитесь в поддержку при вопросах."
      );
    } catch {
      /* best effort */
    }
  }
}

async function checkTopUpsOnce(bot: Bot<AppContext, Api<RawApi>>): Promise<void> {
  const appdatasource = await getAppDataSource();
  const repo = appdatasource.getRepository(TopUp);

  const allTopUps = await repo.find({
    where: {
      status: TopUpStatus.Created,
    },
  });

  for (const topUp of allTopUps) {
    switch (topUp.paymentSystem) {
      case "crystalpay": {
        const cpayId = process.env["PAYMENT_CRYSTALPAY_ID"];
        const cpaySecret = process.env["PAYMENT_CRYSTALPAY_SECRET_ONE"];
        if (!cpayId || !cpaySecret) break;
        const crystalpay = new CrystalPayClient(cpayId, cpaySecret);

        const invoiceInfo = await crystalpay.getInvoice(topUp.orderId);

        if (invoiceInfo.state === "payed") {
          await finalizePaidTopUp(bot, topUp.id);
          break;
        }

        if (invoiceInfo.state === "failed" || invoiceInfo.state === "unavailable") {
          topUp.status = TopUpStatus.Expired;
          await repo.save(topUp);
          break;
        }

        const expiredAt = new Date(invoiceInfo.expired_at + " UTC+3");
        if (expiredAt < new Date()) {
          topUp.status = TopUpStatus.Expired;
          await repo.save(topUp);
        }

        break;
      }
      case "cryptobot": {
        const cryptopayToken =
          process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
          process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
        if (!cryptopayToken) {
          break;
        }
        try {
          const status = await getCryptoBotInvoiceStatus(topUp.orderId);

          if (status === "paid" || status === "paid_over") {
            await finalizePaidTopUp(bot, topUp.id);
          }

          if (status === "expired") {
            topUp.status = TopUpStatus.Expired;
            await repo.save(topUp);
          }
        } catch (err) {
          console.error(`[Payment] CryptoBot status check failed for ${topUp.orderId}:`, err);
        }
        break;
      }
      case "heleket": {
        const merchant = process.env["PAYMENT_HELEKET_MERCHANT"]?.trim();
        const apiKey = process.env["PAYMENT_HELEKET_API_KEY"]?.trim();
        if (!merchant || !apiKey) {
          break;
        }
        try {
          const status = await getHeleketInvoiceStatus(topUp.orderId);
          if (status === "paid" || status === "paid_over") {
            await finalizePaidTopUp(bot, topUp.id);
          }
          if (
            status === "cancel" ||
            status === "fail" ||
            status === "wrong_amount" ||
            status === "system_fail" ||
            status === "refund_process" ||
            status === "refund_fail" ||
            status === "refund_paid"
          ) {
            topUp.status = TopUpStatus.Expired;
            await repo.save(topUp);
          }
        } catch (err) {
          console.error(`[Payment] Heleket status check failed for ${topUp.orderId}:`, err);
        }
        break;
      }
    }
  }
}

export async function startCheckTopUpStatus(bot: Bot<AppContext, Api<RawApi>>): Promise<void> {
  try {
    await checkTopUpsOnce(bot);
  } catch (e) {
    Logger.error("[Payment] initial top-up poll failed", e);
  }

  setInterval(() => {
    void checkTopUpsOnce(bot).catch((e) =>
      Logger.error("[Payment] top-up polling tick failed", e)
    );
  }, TOP_UP_POLL_MS);
}

async function runPostTopUpCreditSideEffects(
  bot: Bot<AppContext, Api<RawApi>>,
  user: User,
  topUp: TopUp
) {
  const targetUser = user.id;
  const topUpId = topUp.id;
  const datasource = await getAppDataSource();

  // Apply referral reward if applicable and notify referrer
  try {
    const { ReferralService } = await import("../domain/referral/ReferralService.js");
    const { UserRepository } = await import("../infrastructure/db/repositories/UserRepository.js");
    const userRepo = new UserRepository(datasource);
    const referralService = new ReferralService(datasource, userRepo);
    const referralResult = await referralService.applyReferralRewardOnTopup(
      targetUser,
      topUpId,
      topUp.amount
    );

    if (referralResult && typeof referralResult === "object") {
      Logger.info(`[Referral] Applied reward ${referralResult.rewardAmount} for topUp ${topUpId}`);
      await notifyReferrerAboutReferralTopUp(bot, referralResult, topUp.amount);
    }
  } catch (error: unknown) {
    console.error("[Referral] Failed to apply referral reward:", error);
    // Don't fail payment if referral reward fails
  }

  let balanceMessage = `+ ${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(topUp.amount)} $`;
  try {
    const { GrowthService } = await import("../modules/growth/growth.service.js");
    const growthService = new GrowthService(datasource);
    const growthResult = await growthService.handleTopUpSuccess(targetUser, topUpId, topUp.amount);
    if (growthResult.upsellBonusApplied > 0) {
      balanceMessage += `\n+ бонус ${growthResult.upsellBonusApplied.toFixed(2)} $`;
    }
    if (growthResult.reactivationBonusApplied > 0) {
      balanceMessage += `\n+ бонус возврата ${growthResult.reactivationBonusApplied.toFixed(2)} $`;
    }
    if (growthResult.upsellOfferCreated && growthResult.messageOffer) {
      await bot.api
        .sendMessage(user.telegramId, growthResult.messageOffer, { parse_mode: "HTML" })
        .catch(() => {});
    }
  } catch (growthErr: unknown) {
    console.error("[Growth] handleTopUpSuccess failed:", growthErr);
  }

  await bot.api.sendMessage(user.telegramId, balanceMessage).catch((err: unknown) => {
    Logger.error("[Payment] send balance notification failed", err);
  });

  await notifyAdminsAboutTopUp(bot, user, topUp.amount, topUp.paymentSystem);

  // Emit automation event for deposit.completed
  try {
    const { emit } = await import("../modules/automations/engine/event-bus.js");
    emit({
      event: "deposit.completed",
      userId: targetUser,
      timestamp: new Date(),
      topUpId,
      amount: topUp.amount,
      targetUserId: targetUser,
    });
  } catch (e) {
    // Ignore if automations module not available
  }

  // At most one commercial campaign per 72h: tier upgrade, large deposit, or referral push
  try {
    const { canSendCommercialPush, markCommercialPushSent } = await import(
      "../modules/growth/campaigns/commercial-limiter.js"
    );
    const { getCumulativeDeposit, getTierUpgradeInfo } = await import(
      "../modules/growth/campaigns/tier.campaign.js"
    );
    const { handleLargeDeposit } = await import("../modules/growth/campaigns/large-deposit.campaign.js");
    const {
      shouldSendReferralPush,
      getReferralPushMessage,
      markReferralPushSent,
    } = await import("../modules/growth/campaigns/referral-push.campaign.js");
    if (await canSendCommercialPush(targetUser, user.telegramId)) {
      const newLtv = await getCumulativeDeposit(datasource, targetUser);
      const tierInfo = await getTierUpgradeInfo(datasource, targetUser, newLtv);
      if (tierInfo) {
        await bot.api.sendMessage(user.telegramId, tierInfo.message, { parse_mode: "HTML" }).catch(() => {});
        await markCommercialPushSent(targetUser);
        try {
          const { emit } = await import("../modules/automations/engine/event-bus.js");
          emit({
            event: "tier.achieved",
            userId: targetUser,
            timestamp: new Date(),
            tier: tierInfo.newTier,
            previousTier: tierInfo.previousTier,
            cumulativeDeposit: tierInfo.cumulativeDeposit,
          });
        } catch {
          // Ignore if automations module not available
        }
      } else {
        const largeResult = await handleLargeDeposit(datasource, targetUser, topUp.amount);
        if (largeResult.shouldSendMessage && largeResult.message) {
          await bot.api.sendMessage(user.telegramId, largeResult.message, { parse_mode: "HTML" }).catch(() => {});
          await markCommercialPushSent(targetUser);
        } else if (await shouldSendReferralPush(datasource, targetUser, topUp.amount)) {
          await bot.api
            .sendMessage(user.telegramId, getReferralPushMessage(), { parse_mode: "HTML" })
            .catch(() => {});
          await markReferralPushSent(targetUser);
          await markCommercialPushSent(targetUser);
        }
      }
    }
  } catch (campaignErr: unknown) {
    console.error("[Growth] Post-payment campaigns failed:", campaignErr);
  }
}
