import DomainRequest, { DomainRequestStatus } from "../entities/DomainRequest.js";
import User, { Role } from "../entities/User.js";
import { Bot, Api, RawApi } from "grammy";
import type { AppContext } from "../shared/types/context";
import prices from "./prices";
import { StatelessQuestion } from "@grammyjs/stateless-question";
import { escapeUserInput } from "@helpers/formatting";
import { AmperDomainsProvider } from "@/infrastructure/domains/AmperDomainsProvider";
import { AmperDomainService } from "@/domain/services/AmperDomainService";
import { DomainRepository } from "@/infrastructure/db/repositories/DomainRepository";
import { BillingService } from "@/domain/billing/BillingService";
import { UserRepository } from "@/infrastructure/db/repositories/UserRepository";
import { TopUpRepository } from "@/infrastructure/db/repositories/TopUpRepository";
import { BusinessError, NotFoundError } from "@/shared/errors";
import { Logger } from "@/app/logger";
import { showTopupForMissingAmount } from "@helpers/deposit-money";

export function registerDomainRegistrationMiddleware(
  bot: Bot<AppContext, Api<RawApi>>
) {
  const createDomainRequest = async (
    ctx: AppContext,
    domain: string,
    additionalInformation: string
  ): Promise<void> => {
    const session = await ctx.session;

    const pricesList = await prices();
    const domainExtension = domain.split(
      "."
    )[1] as keyof typeof pricesList.domains;

    // @ts-ignore
    const basePrice = pricesList.domains[`.${domainExtension}`].price;

    const usersRepo = ctx.appDataSource.getRepository(User);
    const domainRequestRepo = ctx.appDataSource.getRepository(DomainRequest);
    const userRepo = new UserRepository(ctx.appDataSource);
    const topUpRepo = new TopUpRepository(ctx.appDataSource);
    const billingService = new BillingService(
      ctx.appDataSource,
      userRepo,
      topUpRepo
    );

    const user = await usersRepo.findOne({
      where: {
        id: session.main.user.id,
      },
    });

    if (!user) {
      return;
    }

    const hasPrime = await billingService.hasActivePrime(user.id);
    const price = hasPrime
      ? Math.round(basePrice * 0.9 * 100) / 100
      : basePrice;

    user.balance -= price;

    await usersRepo.save(user);

    const domainRequest = new DomainRequest();

    domainRequest.domainName = domain.split(".")[0];
    domainRequest.zone = `.${domainExtension}`;
    domainRequest.target_user_id = user.id;
    domainRequest.price = price;
    domainRequest.additionalInformation = additionalInformation;

    await domainRequestRepo.save(domainRequest);

    await ctx.reply(
      ctx.t("domain-registration-in-progress", {
        domain,
      }),
      {
        parse_mode: "HTML",
      }
    );

    const mods = usersRepo.find({
      where: [
        {
          role: Role.Admin,
        },
        {
          role: Role.Moderator,
        },
      ],
    });

    const countRequests = await domainRequestRepo.count({
      where: {
        status: DomainRequestStatus.InProgress,
      },
    });

    (await mods).forEach((user) => {
      ctx.api.sendMessage(
        user.telegramId,
        ctx.t("domain-request-notification", {
          count: countRequests,
        })
      );
    });
  };

  const additionalInformationQuestion = new StatelessQuestion<AppContext>(
    "add-info",
    async (ctx, domain) => {
      const rawInput = ctx.message?.text?.trim() ?? "";
      if (rawInput.length > 100) {
        await additionalInformationQuestion.replyWithHTML(
          ctx,
          ctx.t("domain-registration-complete-fail-message-length")
        );
        return;
      }

      const userInput =
        rawInput.length === 0 || rawInput.toLowerCase() === "/skip"
          ? "AUTO"
          : escapeUserInput(rawInput);

      await createDomainRequest(ctx, domain, userInput);
    }
  );

  bot.use(additionalInformationQuestion.middleware());

  bot.on("callback_query:data", async (ctx, next) => {
    if (!ctx.callbackQuery.data.startsWith("agree-buy-domain:")) {
      return next();
    }

    const session = await ctx.session;
    const domain = ctx.callbackQuery.data.split(":")[1];
    if (!domain || !domain.includes(".")) {
      await ctx.answerCallbackQuery({ text: "Invalid domain" });
      return;
    }

    const domainName = domain.split(".")[0];
    const tld = "." + domain.split(".").slice(1).join(".");
    const period = 1;
    const apiBaseUrl = process.env.AMPER_API_BASE_URL || "";
    const apiToken = process.env.AMPER_API_TOKEN || "";

    if (apiBaseUrl && apiToken) {
      try {
        await ctx.answerCallbackQuery();
      } catch {
        /* ignore */
      }
      try {
        const dataSource = ctx.appDataSource;
        const userRepo = new UserRepository(dataSource);
        const domainRepo = new DomainRepository(dataSource);
        const topUpRepo = new TopUpRepository(dataSource);
        const billingService = new BillingService(dataSource, userRepo, topUpRepo);
        const provider = new AmperDomainsProvider({
          apiBaseUrl,
          apiToken,
          timeoutMs: parseInt(process.env.AMPER_API_TIMEOUT_MS || "8000"),
          defaultNs1: process.env.DEFAULT_NS1,
          defaultNs2: process.env.DEFAULT_NS2,
        });
        const amperService = new AmperDomainService(
          dataSource,
          domainRepo,
          billingService,
          provider
        );

        await amperService.registerDomain(
          session.main.user.id,
          domainName,
          tld,
          period,
          process.env.DEFAULT_NS1,
          process.env.DEFAULT_NS2
        );

        const updatedUser = await userRepo.findById(session.main.user.id);
        if (updatedUser) {
          session.main.user.balance = updatedUser.balance;
          session.main.user.referralBalance = updatedUser.referralBalance ?? 0;
        }

        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            ctx.callbackQuery.message!.message_id,
            ctx.t("domain-registration-in-progress", { domain }),
            { parse_mode: "HTML" }
          );
        } catch {
          await ctx.reply(
            ctx.t("domain-registration-in-progress", { domain }),
            { parse_mode: "HTML" }
          );
        }
      } catch (err: unknown) {
        Logger.error(`[DomainRegistration] Registration failed for ${domain}:`, {
          error: err,
          errorType: err?.constructor?.name,
          errorMessage: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        let message: string;
        let isRegistrarBalance = false;
        let isAlreadyOwnedByYou = false;
        
        if (err instanceof BusinessError) {
          message = err.message;
          Logger.info(`[DomainRegistration] BusinessError: ${message}`);
          const msgLower = message.toLowerCase();
          isRegistrarBalance =
            msgLower.includes("balance") ||
            msgLower.includes("insufficient") ||
            msgLower.includes("funds") ||
            msgLower.includes("баланс") ||
            msgLower.includes("средств") ||
            msgLower.includes("пополните");
          isAlreadyOwnedByYou = msgLower.includes("already owned by you") || msgLower.includes("owned by you");
          if (message.includes("not available") || message.includes("недоступен") || message.includes("Domain is not available")) {
            message = ctx.t("domain-register-failed-domain-taken", { domain });
          } else if (isAlreadyOwnedByYou) {
            message = ctx.t("domain-register-failed-already-owned", { domain });
          }
        } else if (err instanceof NotFoundError) {
          message = err.message;
        } else {
          const errMsg = (err as Error)?.message || "Unknown error";
          const errMsgLower = errMsg.toLowerCase();
          isRegistrarBalance =
            errMsgLower.includes("balance") ||
            errMsgLower.includes("insufficient") ||
            errMsgLower.includes("funds") ||
            errMsgLower.includes("баланс") ||
            errMsgLower.includes("средств");
          isAlreadyOwnedByYou = errMsgLower.includes("already owned by you") || errMsgLower.includes("owned by you");
          message = errMsg;
        }
        
        Logger.error("Amper domain registration failed", { domain, userId: session.main.user.id, error: err });
        
        const alertText = isRegistrarBalance
          ? ctx.t("domain-register-failed-registrar-balance")
          : isAlreadyOwnedByYou
            ? ctx.t("domain-register-failed-already-owned", { domain })
            : message.length > 200
              ? message.slice(0, 197) + "…"
              : message;
        
        await ctx.answerCallbackQuery({
          text: alertText,
          show_alert: true,
        }).catch(() => {});
        
        try {
          const replyText = isRegistrarBalance
            ? ctx.t("domain-register-failed-registrar-balance")
            : isAlreadyOwnedByYou
              ? ctx.t("domain-register-failed-already-owned", { domain })
              : ctx.t("domain-register-failed", { domain, error: message });
          const { InlineKeyboard } = await import("grammy");
          const replyMarkup = isAlreadyOwnedByYou
            ? new InlineKeyboard().text(
                ctx.t("button-domain-add-to-services"),
                `domain_import_${domain.replace(/\./g, "_")}`
              )
            : undefined;
          await ctx.reply(replyText, {
            parse_mode: "HTML",
            ...(replyMarkup && { reply_markup: replyMarkup }),
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const pricesList = await prices();
    const domainExtension = domain.split(
      "."
    )[1] as keyof typeof pricesList.domains;

    // @ts-ignore
    const price = pricesList.domains[`.${domainExtension}`].price;

    if (session.main.user.balance < price) {
      await ctx.answerCallbackQuery().catch(() => {});
      await showTopupForMissingAmount(ctx, price - session.main.user.balance);
      return;
    }

    const domainRequestRepo = ctx.appDataSource.getRepository(DomainRequest);

    const isDomain = await domainRequestRepo.findOneBy({
      domainName: domain.split(".")[0],
      zone: `.${domainExtension}`,
    });

    if (isDomain) {
      if (
        isDomain.status == DomainRequestStatus.Completed ||
        isDomain.status == DomainRequestStatus.InProgress
      ) {
        await ctx.answerCallbackQuery(ctx.t("domain-already-pending-registration"));
        return;
      }
    }

    await createDomainRequest(ctx, domain, "AUTO");
  });
}
