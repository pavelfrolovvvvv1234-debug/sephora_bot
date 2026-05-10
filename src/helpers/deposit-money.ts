import { Menu } from "@grammyjs/menu";
import { Context, InlineKeyboard } from "grammy";
import type { AppContext, AppConversation } from "../shared/types/context";
import { PaymentBuilder } from "@/api/payment";

const DEPOSIT_PRESETS = [30, 50, 100, 150] as const;
const MIN_TOPUP_USD = 5;
const MAX_TOPUP_USD = 1_500_000;

type TopupMethod = "crystalpay" | "cryptobot" | "heleket" | "manual";

function shouldAutoProceedWithPrefilledAmount(session: any): boolean {
  return session.other.deposit.prefilledAmount && session.main.lastSumDepositsEntered > 0;
}

function renderTopupMethodText(ctx: AppContext): string {
  return ctx.t("topup-select-method");
}

function normalizeTopupAmount(raw: number): number {
  if (!Number.isFinite(raw)) return 50;
  const normalized = Math.round(raw * 100) / 100;
  if (normalized < MIN_TOPUP_USD) return MIN_TOPUP_USD;
  if (normalized > MAX_TOPUP_USD) return MAX_TOPUP_USD;
  return normalized;
}

function getSelectedTopupAmount(session: any): number {
  const selected = normalizeTopupAmount(
    session.other.deposit.selectedAmount || session.main.lastSumDepositsEntered || 50
  );
  session.other.deposit.selectedAmount = selected;
  return selected;
}

export function renderTopupAmountsText(ctx: AppContext): string {
  const session = ctx.session as any;
  getSelectedTopupAmount(session);
  return ctx.t("topup-amounts-title");
}

async function showTopupMethodMenu(ctx: AppContext): Promise<void> {
  await ctx.editMessageText(renderTopupMethodText(ctx), {
    reply_markup: topupMethodMenu,
    parse_mode: "HTML",
  });
}

async function openAmountPicker(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  getSelectedTopupAmount(session);
  await ctx.editMessageText(renderTopupAmountsText(ctx), {
    reply_markup: depositMenu,
    parse_mode: "HTML",
  });
}

async function showProfileScreen(ctx: AppContext): Promise<void> {
  const session = await ctx.session;
  if (!ctx.chat) return;

  const { profileMenu, getProfileText } = await import("../ui/menus/profile-menu.js");
  const profileText = await getProfileText(ctx);
  await ctx.editMessageText(profileText, {
    reply_markup: profileMenu,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function ensureTopupMethod(
  ctx: AppContext
): Promise<TopupMethod | null> {
  const session = await ctx.session;
  if (!session.main.topupMethod) {
    await showTopupMethodMenu(ctx);
    return null;
  }

  return session.main.topupMethod as TopupMethod;
}

async function handleTopupByMethod(
  ctx: AppContext,
  method: TopupMethod,
  amount: number
): Promise<void> {
  const session = await ctx.session;
  const { id: targetUser } = session.main.user;

  if (method === "manual") {
    const amountWhole = Math.round(amount);
    const supportMessage = ctx.t("topup-manual-support-message", { amount: amountWhole });
    const supportUrl = `tg://resolve?domain=sephora_sup&text=${encodeURIComponent(supportMessage)}`;
    await ctx.editMessageText(
      ctx.t("topup-manual-created", { amount: amountWhole, ticketId: "-" }),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(
          ctx.t("button-support"),
          supportUrl
        ),
      }
    );
    return;
  }

  const cryptopayToken =
    process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
    process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
  if (method === "cryptobot" && !cryptopayToken) {
    await ctx.editMessageText(ctx.t("topup-cryptobot-not-configured"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ctx.t("button-back"), "topup_manual_back"),
    });
    return;
  }

  const heleketMerchant = process.env["PAYMENT_HELEKET_MERCHANT"]?.trim();
  const heleketKey = process.env["PAYMENT_HELEKET_API_KEY"]?.trim();
  if (method === "heleket" && (!heleketMerchant || !heleketKey)) {
    await ctx.editMessageText(ctx.t("topup-heleket-not-configured"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ctx.t("button-back"), "topup_manual_back"),
    });
    return;
  }

  await ctx.editMessageText(ctx.t("payment-information"), {
    reply_markup: new InlineKeyboard().text(ctx.t("payment-await")),
    parse_mode: "HTML",
  });

  const builder = new PaymentBuilder(amount, targetUser);
  const result =
    method === "crystalpay"
      ? await builder.createCrystalPayment()
      : method === "cryptobot"
        ? await builder.createCryptoBotPayment()
        : await builder.createHeleketPayment();

  await ctx.editMessageReplyMarkup({
    reply_markup: new InlineKeyboard()
      .url(ctx.t("payment-next-url-label"), `${result.url}`)
      .row()
      .text(ctx.t("button-back"), "topup_back_to_amount"),
  });
}

export const topupMethodMenu = new Menu<AppContext>("topup-method-menu")
  .text((ctx) => ctx.t("topup-method-heleket"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.main.topupMethod = "heleket";
    if (shouldAutoProceedWithPrefilledAmount(session)) {
      session.other.deposit.prefilledAmount = false;
      await handleTopupByMethod(ctx, "heleket", session.main.lastSumDepositsEntered);
      return;
    }
    await openAmountPicker(ctx);
  })
  .row()
  .text((ctx) => ctx.t("topup-method-cryptobot"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.main.topupMethod = "cryptobot";
    if (shouldAutoProceedWithPrefilledAmount(session)) {
      session.other.deposit.prefilledAmount = false;
      await handleTopupByMethod(ctx, "cryptobot", session.main.lastSumDepositsEntered);
      return;
    }
    await openAmountPicker(ctx);
  })
  .row()
  .text((ctx) => ctx.t("topup-method-crystalpay"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.main.topupMethod = "crystalpay";
    if (shouldAutoProceedWithPrefilledAmount(session)) {
      session.other.deposit.prefilledAmount = false;
      await handleTopupByMethod(ctx, "crystalpay", session.main.lastSumDepositsEntered);
      return;
    }
    await openAmountPicker(ctx);
  })
  .row()
  .text((ctx) => ctx.t("topup-method-bank"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.main.topupMethod = "manual";
    if (shouldAutoProceedWithPrefilledAmount(session)) {
      session.other.deposit.prefilledAmount = false;
      await handleTopupByMethod(ctx, "manual", session.main.lastSumDepositsEntered);
      return;
    }
    const supportMessage = ctx.t("topup-manual-support-message-no-amount");
    const supportUrl = `tg://resolve?domain=sephora_sup&text=${encodeURIComponent(supportMessage)}`;
    await ctx.editMessageText(ctx.t("topup-manual-support"), {
      reply_markup: new InlineKeyboard()
        .url(ctx.t("button-support"), supportUrl)
        .row()
        .text(ctx.t("button-back"), "topup_manual_back"),
      parse_mode: "HTML",
    });
  })
  .row()
  .text((ctx) => ctx.t("topup-method-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showProfileScreen(ctx);
  });

/**
 * Redirect to top-up flow with a pre-filled amount (e.g. when balance is insufficient for a purchase).
 * Sets lastSumDepositsEntered and shows method menu; when user picks a method, payment is created for that amount.
 */
export async function showTopupForMissingAmount(ctx: AppContext, missingAmount: number): Promise<void> {
  const session = await ctx.session;
  session.main.lastSumDepositsEntered = Math.round(missingAmount * 100) / 100;
  session.other.deposit.selectedAmount = session.main.lastSumDepositsEntered;
  session.other.deposit.prefilledAmount = true;
  await ctx.reply(ctx.t("money-not-enough-go-topup", { amount: session.main.lastSumDepositsEntered }), {
    reply_markup: topupMethodMenu,
    parse_mode: "HTML",
  });
}

export const depositMenu = new Menu<AppContext>("deposit-menu")
  .dynamic((ctx, range) => {
    const session = ctx.session as any;
    const selected = getSelectedTopupAmount(session);
    const formatPreset = (value: number): string => {
      const isSelected = value === selected;
      const isPopular = value === 50;
      if (isSelected && isPopular) return `✅ $${value} • ${ctx.t("topup-popular-badge")}`;
      if (isSelected) return `✅ $${value}`;
      if (isPopular) return `$${value} • ${ctx.t("topup-popular-badge")}`;
      return `$${value}`;
    };

    range
      .text(formatPreset(30), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const session = await ctx.session;
        const method = await ensureTopupMethod(ctx);
        if (!method) return;
        session.other.deposit.selectedAmount = 30;
        session.main.lastSumDepositsEntered = 30;
        session.other.deposit.prefilledAmount = false;
        await handleTopupByMethod(ctx, method, 30);
      })
      .text(formatPreset(50), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const session = await ctx.session;
        const method = await ensureTopupMethod(ctx);
        if (!method) return;
        session.other.deposit.selectedAmount = 50;
        session.main.lastSumDepositsEntered = 50;
        session.other.deposit.prefilledAmount = false;
        await handleTopupByMethod(ctx, method, 50);
      })
      .row()
      .text(formatPreset(100), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const session = await ctx.session;
        const method = await ensureTopupMethod(ctx);
        if (!method) return;
        session.other.deposit.selectedAmount = 100;
        session.main.lastSumDepositsEntered = 100;
        session.other.deposit.prefilledAmount = false;
        await handleTopupByMethod(ctx, method, 100);
      })
      .text(formatPreset(150), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const session = await ctx.session;
        const method = await ensureTopupMethod(ctx);
        if (!method) return;
        session.other.deposit.selectedAmount = 150;
        session.main.lastSumDepositsEntered = 150;
        session.other.deposit.prefilledAmount = false;
        await handleTopupByMethod(ctx, method, 150);
      })
      .row()
      .text((ctx) => ctx.t("topup-enter-custom-button"), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const method = await ensureTopupMethod(ctx);
        if (!method) return;
        const session = await ctx.session;
        session.other.deposit.awaitingAmount = true;
        session.other.deposit.prefilledAmount = false;
        await ctx.reply(ctx.t("topup-enter-custom-prompt"), {
          reply_markup: new InlineKeyboard().text(ctx.t("button-cancel"), "deposit-cancel"),
          parse_mode: "HTML",
        });
      });
  })
  .row()
  .back((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    session.other.deposit.prefilledAmount = false;
    await ctx.editMessageText(renderTopupMethodText(ctx), {
      reply_markup: topupMethodMenu,
      parse_mode: "HTML",
    });
  });

export const depositPaymentSystemChoose = new Menu<AppContext>(
  "deposit-menu-payment-choose"
)
  .text((ctx) => ctx.t("button-pay"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const method = session.main.topupMethod || "crystalpay";

    const { id: targetUser } = session.main.user;
    const { lastSumDepositsEntered } = session.main;

    const cryptopayToken =
      process.env["PAYMENT_CRYPTOBOT_TOKEN"]?.trim() ||
      process.env["PAYMENT_CRYPTO_PAY_TOKEN"]?.trim();
    if (method === "cryptobot" && !cryptopayToken) {
      await ctx.editMessageText(ctx.t("topup-cryptobot-not-configured"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(ctx.t("button-back"), "topup_manual_back"),
      });
      return;
    }

    const heleketMerchant = process.env["PAYMENT_HELEKET_MERCHANT"]?.trim();
    const heleketKey = process.env["PAYMENT_HELEKET_API_KEY"]?.trim();
    if (method === "heleket" && (!heleketMerchant || !heleketKey)) {
      await ctx.editMessageText(ctx.t("topup-heleket-not-configured"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text(ctx.t("button-back"), "topup_manual_back"),
      });
      return;
    }

    await ctx.editMessageText(ctx.t("payment-information"), {
      reply_markup: new InlineKeyboard().text(ctx.t("payment-await")),
      parse_mode: "HTML",
    });

    const builder = new PaymentBuilder(lastSumDepositsEntered, targetUser);
    const result =
      method === "cryptobot"
        ? await builder.createCryptoBotPayment()
        : method === "heleket"
          ? await builder.createHeleketPayment()
          : await builder.createCrystalPayment();

    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard()
        .url(ctx.t("payment-next-url-label"), `${result.url}`)
        .row()
        .text(ctx.t("button-back"), "topup_back_to_amount"),
    });
  })
  .row()
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(ctx.t("topup-select-amount"), {
      reply_markup: depositMenu,
      parse_mode: "HTML",
    });
  });

// Choose any sum for create deposit
export async function depositMoneyConversation(
  conversation: AppConversation,
  ctx: Context
): Promise<void> {
  const message = await conversation.external((ctx: AppContext) =>
    ctx.t("deposit-money-enter-sum")
  );

  await (ctx as AppContext).reply(message, {
    reply_markup: new InlineKeyboard().text((ctx as AppContext).t("button-cancel"), "deposit-cancel"),
    parse_mode: "HTML",
  });

  const {
    message: { text: rawText },
  } = await conversation.waitFor("message:text");

  const sumToDeposit = handleRawSum(rawText);

  const incorrectMessage = await conversation.external((ctx) => {
    return ctx.t("deposit-money-incorrect-sum");
  });

  if (isNaN(sumToDeposit) || sumToDeposit <= 0 || sumToDeposit > 1_500_000) {
    await (ctx as AppContext).reply(incorrectMessage, {
      parse_mode: "HTML",
    });

    await conversation.external(async (ctx) => {
      const session = await ctx.session;
      session.main.lastSumDepositsEntered = -1;
    });
    return;
  }

  const session = await conversation.external(async (ctx) => {
    const session = await ctx.session;
    session.main.lastSumDepositsEntered = sumToDeposit;
    return session;
  });

  await conversation.external(async (ctx) => {
    const method = await ensureTopupMethod(ctx);
    if (!method) return;
    await handleTopupByMethod(ctx, method, session.main.lastSumDepositsEntered);
  });
}

function handleRawSum(rawText: string): number {
  const text = rawText
    .replaceAll("$", "")
    .replaceAll(",", "")
    .replaceAll(".", "")
    .replaceAll(" ", "")
    .trim();

  return Number.parseFloat(text);
}
