import { Menu } from "@grammyjs/menu";
import { mainMenu } from "..";
import type { AppContext, AppConversation } from "../shared/types/context";
import prices from "@helpers/prices";
import { StatelessQuestion } from "@grammyjs/stateless-question";

import DomainChecker from "@api/domain-checker";
import { escapeUserInput } from "@helpers/formatting";
import { InlineKeyboard } from "grammy";
import { getAppDataSource } from "../infrastructure/db/datasource.js";
import User, { Role } from "@/entities/User";
import VirtualDedicatedServer, {
  generatePassword,
  generateRandomName,
} from "@/entities/VirtualDedicatedServer";
import ms from "@/lib/multims";
import { showTopupForMissingAmount } from "@helpers/deposit-money";
import { createInitialOtherSession } from "../shared/session-initial.js";
import {
  showDomainCategoryTlds,
} from "../domain/domains/domain-purchase-flow.js";
import { getVmManagerAllowedOsIds } from "../app/config.js";
import { humanizeVmmOsName } from "../shared/vmm-os-display.js";
import { clearedInlineKeyboard } from "../shared/cleared-inline-keyboard.js";
import { DedicatedProvisioningService } from "../domain/dedicated/DedicatedProvisioningService.js";
import {
  DEDICATED_OS_KEYS,
  dedicatedLocationKeysForServer,
} from "../domain/dedicated/dedicated-shop-config.js";
import { DedicatedOrderPaymentStatus } from "../entities/DedicatedServerOrder.js";
import { getModeratorChatId } from "../shared/moderator-chat.js";
import {
  buildPremiumVpsReadyHtml,
  escapeHtml,
  getVpsCpuModelForRate,
} from "../domain/vds/vps-onboarding-messages.js";

const renderMultiline = (text: string): string => text.replace(/\\n/g, "\n");

function cpuModelFromDedicatedName(name: string): string {
  return name.replace(/\s+\d+GB\s*$/i, "").trim();
}

// Note: amperDomainsMenu will be registered in broadcast-tickets-integration.ts

/**
 * Dedicated server type selection menu (Standard/Bulletproof).
 */
const buildServiceHeader = (ctx: AppContext, labelKey: string): string =>
  `${ctx.t("menu-service-for-buy-choose")}\n\n${ctx.t(labelKey)}`;

/** Apply Prime −10% discount if user has active Prime. */
async function getPriceWithPrimeDiscount(
  dataSource: AppContext["appDataSource"],
  userId: number,
  basePrice: number
): Promise<number> {
  const userRepo = dataSource.getRepository(User);
  const user = await userRepo.findOneBy({ id: userId });
  const hasPrime = user?.primeActiveUntil && new Date(user.primeActiveUntil) > new Date();
  return hasPrime ? Math.round(basePrice * 0.9 * 100) / 100 : basePrice;
}

export const dedicatedTypeMenu = new Menu<AppContext>("dedicated-type-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("dedicated-shop-btn-standard"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other.dedicatedType) {
      session.other.dedicatedType = {
        bulletproof: false,
        selectedDedicatedId: -1,
        shopTier: null,
        shopListPage: 0,
      };
    }
    session.other.dedicatedType.bulletproof = false;
    session.other.dedicatedType.shopTier = null;
    session.other.dedicatedType.shopListPage = 0;
    session.other.dedicatedType.selectedDedicatedId = -1;
    const { showDedicatedShopStep2Tier } = await import("../domain/dedicated/dedicated-shop-flow.js");
    await showDedicatedShopStep2Tier(ctx);
  })
  .text((ctx) => ctx.t("dedicated-shop-btn-bulletproof"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other.dedicatedType) {
      session.other.dedicatedType = {
        bulletproof: false,
        selectedDedicatedId: -1,
        shopTier: null,
        shopListPage: 0,
      };
    }
    session.other.dedicatedType.bulletproof = true;
    session.other.dedicatedType.shopTier = null;
    session.other.dedicatedType.shopListPage = 0;
    session.other.dedicatedType.selectedDedicatedId = -1;
    const { showDedicatedShopStep2Tier } = await import("../domain/dedicated/dedicated-shop-flow.js");
    await showDedicatedShopStep2Tier(ctx);
  })
  .row()
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.editMessageText(ctx.t("menu-service-for-buy-choose"), {
      parse_mode: "HTML",
      reply_markup: servicesMenu,
    });
  });

/**
 * VPS step 1: standard vs bulletproof → inline shop step 2 (vsh:*).
 */
export const vdsTypeMenu = new Menu<AppContext>("vds-type-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("vds-shop-btn-bulletproof"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    session.other.vdsRate.bulletproof = true;
    session.other.vdsRate.shopTier = null;
    session.other.vdsRate.shopListPage = 0;
    session.other.vdsRate.selectedRateId = -1;
    session.other.vdsRate.selectedOs = -1;
    const { showVpsShopStep2Tier } = await import("../domain/vds/vds-shop-flow.js");
    await showVpsShopStep2Tier(ctx);
  })
  .row()
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.editMessageText(ctx.t("menu-service-for-buy-choose"), {
      parse_mode: "HTML",
      reply_markup: servicesMenu,
    });
  });

export const domainsMenu = new Menu<AppContext>("domains-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("domain-shop-cat-popular"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    session.other.domains.shopAllPage = 0;
    await showDomainCategoryTlds(ctx, "popular");
  })
  .row()
  .text((ctx) => ctx.t("domain-shop-cat-business"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    await showDomainCategoryTlds(ctx, "business");
  })
  .row()
  .text((ctx) => ctx.t("domain-shop-cat-tech"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    await showDomainCategoryTlds(ctx, "tech");
  })
  .row()
  .text((ctx) => ctx.t("domain-shop-cat-geo"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    await showDomainCategoryTlds(ctx, "geo");
  })
  .row()
  .text((ctx) => ctx.t("domain-shop-cat-all"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    if (!session.other) (session as any).other = createInitialOtherSession();
    session.other.domains.shopAllPage = 0;
    await showDomainCategoryTlds(ctx, "all");
  })
  .row()
  .back(
    (ctx) => ctx.t("button-back"),
    async (ctx) => {
      await ctx.editMessageText(ctx.t("menu-service-for-buy-choose"), {
        parse_mode: "HTML",
      });
    }
  );

/** Открытие CDN из меню покупки услуг (fallback callback в index — строка CDN в меню). */
export async function openCdnPurchaseFromServicesMenu(ctx: AppContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const session = await ctx.session;
  if (!session.other) (session as any).other = createInitialOtherSession();
  if (!session.other.cdn) session.other.cdn = { step: "idle" };
  session.other.cdn.fromManage = false;
  try {
    const { showCdnTariffsScreen } = await import("../ui/menus/cdn-menu.js");
    await showCdnTariffsScreen(ctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Bot] CDN menu open error:", msg);
    const t =
      typeof (ctx as any).t === "function"
        ? (ctx as any).t.bind(ctx)
        : ((k: string, v?: { error?: string }) =>
            k === "cdn-error" && v?.error ? `Ошибка CDN: ${v.error}` : k);
    await ctx.reply(t("cdn-error", { error: msg })).catch(() => {});
  }
}

function buildServicesMenu(): Menu<AppContext> {
  return new Menu<AppContext>("services-menu", { autoAnswer: false, onMenuOutdated: false })
    .text((ctx) => ctx.t("button-vds"), async (ctx) => {
      const { openVpsTariffSelection } = await import("../domain/vds/vds-shop-flow.js");
      await openVpsTariffSelection(ctx);
    })
    .row()
    .back(
      (ctx) => ctx.t("button-back"),
      async (ctx) => {
        const session = await ctx.session;
        await ctx.editMessageText(ctx.t("welcome", { balance: session.main.user.balance }), {
          parse_mode: "HTML",
        });
      }
    );
}

export const servicesMenu = buildServicesMenu();

async function createAndBuyVDS(
  ctx: AppContext,
  osId: number,
  rateId: number,
  userId: number,
  bulletproof: boolean
) {
  const pricesList = await prices();

  const rate = pricesList.virtual_vds[rateId];

  console.log(osId);

  if (!rate) {
    await ctx.reply(ctx.t("bad-error"));
    return;
  }

  const appDataSource = await getAppDataSource();

  const usersRepo = appDataSource.getRepository(User);
  const vdsRepo = appDataSource.getRepository(VirtualDedicatedServer);

  const user = await usersRepo.findOneBy({
    id: userId,
  });

  if (!user) {
    await ctx.reply(ctx.t("bad-error"));
    return "user-not-found" as const;
  }

  const basePrice = bulletproof ? rate.price.bulletproof : rate.price.default;
  const price = await getPriceWithPrimeDiscount(appDataSource, userId, basePrice);

  // Remember this thing
  const generatedPassword = generatePassword(12);

  if (user.balance - price < 0) {
    await showTopupForMissingAmount(ctx, price - user.balance);
    return "money-not-enough" as const;
  }

  const chatId = ctx.chat?.id;
  const waitMessage = chatId
    ? await ctx.reply(ctx.t("vds-provisioning-wait"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }).catch(() => undefined)
    : undefined;

  const newVds = new VirtualDedicatedServer();

  let result: Awaited<ReturnType<typeof ctx.vmmanager.createVM>> | undefined;
  let vmHostLabel = "";

  while (result === undefined) {
    vmHostLabel = generateRandomName(13);
    result = await ctx.vmmanager.createVM(
      vmHostLabel,
      generatedPassword,
      rate.cpu,
      rate.ram,
      osId,
      `UserID:${userId},${rate.name}`,
      rate.ssd,
      1,
      rate.network,
      rate.network
    );
  }

  if (result === false) {
    if (waitMessage && chatId) {
      await ctx.api.deleteMessage(chatId, waitMessage.message_id).catch(() => {});
    }
    await ctx.reply(ctx.t("bad-error"));
    return "error-when-creating" as const;
  }

  let info;
  while (info === undefined) {
    info = await ctx.vmmanager.getInfoVM(result.id);
  }

  newVds.vdsId = result.id;
  newVds.cpuCount = rate.cpu;
  newVds.diskSize = rate.ssd;
  newVds.rateName = rate.name;
  newVds.expireAt = new Date(Date.now() + ms("30d"));
  newVds.ramSize = rate.ram;
  newVds.lastOsId = osId;
  newVds.password = generatedPassword;
  newVds.login = "root";
  newVds.networkSpeed = rate.network;
  newVds.targetUserId = userId;
  newVds.isBulletproof = bulletproof;

  let ipv4Addrs;

  while (ipv4Addrs === undefined) {
    ipv4Addrs = await ctx.vmmanager.getIpv4AddrVM(result.id);
  }

  newVds.ipv4Addr = ipv4Addrs.list[0].ip_addr;
  newVds.renewalPrice = price;
  newVds.autoRenewEnabled = true;
  newVds.adminBlocked = false;
  newVds.managementLocked = false;
  newVds.extraIpv4Count = 0;

  await vdsRepo.save(newVds);

  user.balance -= price;

  await usersRepo.save(user);

  const displayHost = (info?.name && String(info.name).trim()) || vmHostLabel;
  const osEntry = ctx.osList?.list.find((o) => o.id === osId);
  const osLabel = osEntry ? humanizeVmmOsName(osEntry.name) : `OS #${osId}`;

  const readyHtml = buildPremiumVpsReadyHtml(ctx, {
    vmName: displayHost,
    vdsId: newVds.vdsId,
    regionLabel: ctx.t("vps-premium-region-auto"),
    planName: rate.name,
    cpu: rate.cpu,
    ramGb: rate.ram,
    diskGb: rate.ssd,
    networkMbps: rate.network,
    cpuModel: getVpsCpuModelForRate(rate as { cpuModel?: string }),
    osLabel,
    ipv4: newVds.ipv4Addr,
    login: newVds.login,
    password: newVds.password,
  });

  if (waitMessage && chatId) {
    await ctx.api.deleteMessage(chatId, waitMessage.message_id).catch(() => {});
  }
  await ctx.reply(readyHtml, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: mainMenu,
  });
}

export const vdsRateOs = new Menu<AppContext>("vds-select-os").dynamic(
  async (ctx, range) => {
    const session = await ctx.session;

    const osList = ctx.osList;

    if (!osList) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }

    if (session.other.vdsRate.selectedOs != -1) {
      range.text(ctx.t("vds-select-os-next"), async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => {});
        const session = await ctx.session;

        await ctx.editMessageText(ctx.t("await-please"), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: clearedInlineKeyboard(),
        });
        // Avoid ctx.menu.close(): same handler awaits createAndBuyVDS — menu middleware would reinject buttons afterward.

        const result = await createAndBuyVDS(
          ctx,
          session.other.vdsRate.selectedOs,
          session.other.vdsRate.selectedRateId,
          session.main.user.id,
          session.other.vdsRate.bulletproof
        );

        session.other.vdsRate.selectedOs = -1;

        await ctx.deleteMessage();
      });

      range.text(ctx.t("button-back"), async (ctx) => {
        const session = await ctx.session;

        session.other.vdsRate.selectedOs = -1;

        await ctx.editMessageText(ctx.t("vds-os-select"), {
          parse_mode: "HTML",
        });
      });
      return;
    }

    let count = 0;
    const allowedOsIds = getVmManagerAllowedOsIds();
    osList.list
      .filter(
        (os) =>
          allowedOsIds.has(os.id) ||
          (!os.adminonly &&
            os.name != "NoOS" &&
            os.state == "active" &&
            os.repository != "ISPsystem LXD")
      )
      .forEach((os) => {
        const label = humanizeVmmOsName(os.name);
        range.text({ text: label, payload: `vos-${os.id}` }, async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          const session = await ctx.session;

          session.other.vdsRate.selectedOs = os.id;

          await ctx.editMessageText(
            ctx.t("vds-select-os-confirm", {
              osName: escapeUserInput(label),
            }),
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
          );
          await ctx.menu.update({ immediate: true });
        });

        count++;
        if (count % 2 === 0) {
          range.row();
        }
      });

    if (count % 2 !== 0) {
      range.row();
    }

    range.back(
      {
        text: (ctx) => ctx.t("button-back"),
        payload: session.other.vdsRate.selectedRateId.toString(),
      },
      async (ctx) => {
        if (ctx.match == "-1") {
          await ctx.deleteMessage();

          const session = await ctx.session;

          await ctx.reply(
            ctx.t("welcome", { balance: session.main.user.balance }),
            {
              reply_markup: mainMenu,
              parse_mode: "HTML",
            }
          );
          return;
        }
        const id = Number(ctx.match);
        const { showVpsShopStep4Card } = await import("../domain/vds/vds-shop-flow.js");
        await showVpsShopStep4Card(ctx, id);
      }
    );
  }
);

export const vdsRateChoose = new Menu<AppContext>("vds-selected-rate", {
  onMenuOutdated: (ctx) => {
    ctx.deleteMessage().then();
  },
})
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;

    range.submenu(
      {
        text: ctx.t("button-buy"),
        payload: session.other.vdsRate.selectedRateId.toString(),
      },
      "vds-select-os",
      async (ctx) => {
        if (ctx.match == "-1") {
          await ctx.deleteMessage();

          const session = await ctx.session;

          await ctx.reply(
            ctx.t("welcome", { balance: session.main.user.balance }),
            {
              reply_markup: mainMenu,
              parse_mode: "HTML",
            }
          );
          return;
        }

        const session = await ctx.session;
        const pricesList = await prices();

        const rate = pricesList.virtual_vds[Number(ctx.match)];

        if (rate) {
          const dataSource = await getAppDataSource();
          const basePrice = session.other.vdsRate.bulletproof
            ? rate.price.bulletproof
            : rate.price.default;
          const price = await getPriceWithPrimeDiscount(dataSource, session.main.user.id, basePrice);
          const usersRepo = dataSource.getRepository(User);
          const user = await usersRepo.findOneBy({ id: session.main.user.id });
          if (!user) {
            await ctx.menu.close();
            await ctx.reply(ctx.t("bad-error"), { parse_mode: "HTML" }).catch(() => {});
            return;
          }
          if (user.balance < price) {
            await ctx.menu.close();
            await showTopupForMissingAmount(ctx, price - user.balance);
            return;
          }
          session.main.user.balance = user.balance;
        } else {
          ctx.menu.close();
          return;
        }

        session.other.vdsRate.selectedRateId = Number(ctx.match);

        await ctx.editMessageText(ctx.t("vds-os-select"), {
          parse_mode: "HTML",
        });
      }
    );
  })
  .row()
  .back(
    (ctx) => ctx.t("button-back"),
    async (ctx) => {
      const session = await ctx.session;
      if (!session.other) (session as any).other = createInitialOtherSession();
      const { showVpsShopStep3List, showVpsShopStep2Tier } = await import("../domain/vds/vds-shop-flow.js");
      if (session.other.vdsRate.shopTier) {
        await showVpsShopStep3List(ctx, session.other.vdsRate.shopListPage ?? 0);
      } else {
        await showVpsShopStep2Tier(ctx);
      }
    }
  );

/** Legacy id for OS/rate menu chain; purchase list uses vsh:* inline flow. */
export const vdsMenu = new Menu<AppContext>("vds-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { showVpsShopStep1 } = await import("../domain/vds/vds-shop-flow.js");
    await showVpsShopStep1(ctx);
  });

/**
 * Legacy menu id kept for registration chain (dedicated-selected-server → location).
 * Purchase flow uses dedicated-shop-flow inline steps; this stub is a safe fallback.
 */
export const dedicatedServersMenu = new Menu<AppContext>("dedicated-servers-menu", { autoAnswer: false, onMenuOutdated: false })
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { showDedicatedShopStep1 } = await import("../domain/dedicated/dedicated-shop-flow.js");
    await showDedicatedShopStep1(ctx);
  });

/**
 * Function to edit message with dedicated server details.
 * @param replyMarkup - Optional keyboard (e.g. dedicatedSelectedServerMenu when returning from location menu).
 */
const editMessageDedicatedServer = async (
  ctx: AppContext,
  serverId: number,
  replyMarkup?: Menu<AppContext>
) => {
  const pricesList = await prices();
  const session = await ctx.session;
  const server = pricesList.dedicated_servers[serverId];

  if (!server) {
    await ctx.editMessageText(ctx.t("error-unknown", { error: "Server not found" }));
    return;
  }

  const isBulletproof = session.other.dedicatedType?.bulletproof || false;
  const basePrice: number =
    (isBulletproof && server.price.bulletproof
      ? server.price.bulletproof
      : server.price.default) ?? 0;
  const dataSource = ctx.appDataSource;
  const userId: number = session.main?.user?.id ?? 0;
  const price = await getPriceWithPrimeDiscount(dataSource, userId, basePrice);

  await ctx.editMessageText(
    ctx.t("dedicated-rate-full-view", {
      rateName: server.name,
      price,
      cpuModel: cpuModelFromDedicatedName(server.name ?? ""),
      cpu: server.cpu,
      cpuThreads: server.cpuThreads,
      ram: server.ram,
      storage: server.storage,
      network: server.network,
      bandwidth: server.bandwidth === "unlimited" ? ctx.t("unlimited") : server.bandwidth,
      os: server.os,
    }),
    {
      parse_mode: "HTML",
      ...(replyMarkup && { reply_markup: replyMarkup }),
    }
  );
};

/**
 * Dedicated location selection menu (after Make Order).
 * Shows only locations allowed for the selected server (server.locations in prices.json).
 */
export const dedicatedLocationMenu = new Menu<AppContext>("dedicated-location-menu")
  .dynamic(async (ctx, range) => {
    const session = await ctx.session;
    const selectedId = session.other.dedicatedType?.selectedDedicatedId ?? -1;
    const pricesList = await prices();
    const server = pricesList.dedicated_servers?.[selectedId] as { locations?: string[] } | undefined;
    const locationKeys = dedicatedLocationKeysForServer(server);

    for (const key of locationKeys) {
      const labelKey = `dedicated-location-${key}` as const;
      range
        .text((c) => c.t(labelKey), async (ctx) => {
          await ctx.answerCallbackQuery().catch(() => {});
          const session = await ctx.session;
          session.other.dedicatedOrder = session.other.dedicatedOrder ?? { step: "idle", requirements: undefined };
          session.other.dedicatedOrder.selectedLocationKey = key;
          const osKeyboard = new InlineKeyboard();
          for (const osKey of DEDICATED_OS_KEYS) {
            osKeyboard.text(ctx.t(`dedicated-os-${osKey}`), `dedicated-os:${osKey}`).row();
          }
          osKeyboard.text(ctx.t("button-return-to-main"), "dedicated-os:back");
          await ctx.editMessageText(ctx.t("dedicated-os-select-title"), {
            parse_mode: "HTML",
            reply_markup: osKeyboard,
          });
        })
        .row();
    }
  })
  .row()
  // `.text`, not `.back`: from the inline shop (`dsh:ord`) this menu has no Menu parent — `ctx.menu.back()` throws.
  .text((ctx) => ctx.t("button-back"), async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const session = await ctx.session;
    const selectedId = session.other.dedicatedType?.selectedDedicatedId ?? -1;
    const { showDedicatedShopStep4Card, showDedicatedShopStep3List } = await import(
      "../domain/dedicated/dedicated-shop-flow.js"
    );
    if (selectedId >= 0) {
      await showDedicatedShopStep4Card(ctx, selectedId);
    } else {
      await showDedicatedShopStep3List(ctx, session.other.dedicatedType?.shopListPage ?? 0);
    }
  });

/**
 * Handles dedicated OS selection: payment and contact-support message.
 * Used from callback "dedicated-os:{osKey}" when OS is chosen from manual keyboard.
 */
export async function handleDedicatedOsSelect(ctx: AppContext, osKey: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const session = await ctx.session;
  const selectedId = session.other.dedicatedType?.selectedDedicatedId ?? -1;
  const locationKey = session.other.dedicatedOrder?.selectedLocationKey;
  if (selectedId < 0 || !locationKey) {
    await ctx.reply(ctx.t("bad-error"));
    return;
  }
  const pricesList = await prices();
  const server = pricesList.dedicated_servers?.[selectedId];
  if (!server) {
    await ctx.reply(ctx.t("bad-error"));
    return;
  }
  const isBulletproof = session.other.dedicatedType?.bulletproof ?? false;
  const basePrice: number =
    (isBulletproof && server.price.bulletproof
      ? server.price.bulletproof
      : server.price.default) ?? 0;
  const dataSource = ctx.appDataSource;
  const usersRepo = dataSource.getRepository(User);
  let user: User | null = null;
  let price = 0;
  let deducted = false;
  try {
    user = await usersRepo.findOneBy({ id: session.main.user.id });
    if (!user) {
      await ctx.reply(ctx.t("bad-error"));
      return;
    }
    const userId: number = user.id ?? 0;
    price = await getPriceWithPrimeDiscount(dataSource, userId, basePrice);
    if (user.balance < price) {
      await showTopupForMissingAmount(ctx, price - user.balance);
      return;
    }
    user.balance -= price;
    await usersRepo.save(user);
    deducted = true;
    session.main.user.balance = user.balance;
    session.main.user.referralBalance = user.referralBalance ?? 0;
    session.other.dedicatedOrder = {
      step: "idle",
      requirements: undefined,
      selectedLocationKey: locationKey,
      selectedOsKey: osKey,
    };
    const provisioningService = new DedicatedProvisioningService(dataSource);
    const location = ctx.t(`dedicated-location-${locationKey}`);
    const os = ctx.t(`dedicated-os-${osKey}`);
    const idempotencyKey = ctx.callbackQuery?.id
      ? `tgcb:${ctx.callbackQuery.id}`
      : `dedicated:${session.main.user.id}:${selectedId}:${locationKey}:${osKey}:${Date.now()}`;
    const category = session.other.dedicatedType?.bulletproof ? "bulletproof" : "standard";
    const buyerIsStaff = user.role === Role.Admin || user.role === Role.Moderator;
    const created = await provisioningService.createPaidOrderAndTicket({
      userId: user.id,
      telegramUserId: ctx.from?.id ?? null,
      telegramUsername: ctx.from?.username ?? null,
      fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || null,
      customerLanguage: session.main.locale,
      paymentAmount: price,
      paymentMethod: "balance",
      paymentStatus: DedicatedOrderPaymentStatus.PAID,
      balanceUsedAmount: price,
      idempotencyKey,
      excludeFromUserStats: buyerIsStaff,
      config: {
        productId: String(selectedId),
        productName: server.name ?? `Dedicated #${selectedId}`,
        category,
        cpuModel: server.cpu != null ? String(server.cpu) : null,
        cpuThreads: Number(server.cpuThreads ?? 0) || null,
        ram: server.ram != null ? String(server.ram) : null,
        storageSize: server.storage != null ? String(server.storage) : null,
        bandwidth: server.bandwidth != null ? String(server.bandwidth) : null,
        uplinkSpeed: server.network != null ? String(server.network) : null,
        unmeteredTraffic: String(server.bandwidth ?? "").toLowerCase() === "unlimited",
        locationKey,
        locationLabel: location,
        osKey,
        osLabel: os,
        ddosProtection: session.other.dedicatedType?.bulletproof ? "enhanced" : "standard",
        deploymentNotes: null,
      },
    });

    const order = created.order;
    const ticket = created.ticket;
    await ctx.deleteMessage().catch(() => {});
    const buyerText = renderMultiline(
      ctx.t("dedicated-provisioning-ticket-created", {
        ticketId: ticket.id,
        orderId: order.id,
        serviceName: escapeHtml(server.name ?? `#${selectedId}`),
        location: escapeHtml(location),
        os: escapeHtml(os),
      })
    );
    await ctx.reply(buyerText, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    if (!buyerIsStaff) {
      const moderators = await usersRepo.find({
        where: [{ role: Role.Admin }, { role: Role.Moderator }],
      });
      const staffText = renderMultiline(ctx.t("dedicated-provisioning-staff-notification", {
        ticketId: ticket.id,
        orderId: order.id,
        userId: user.id,
        amount: price,
        serviceName: server.name ?? `#${selectedId}`,
        location,
        os,
      }));
      const staffKeyboard = new InlineKeyboard()
        .text(ctx.t("button-open"), `prov_view_${ticket.id}`)
        .text(ctx.t("button-close"), `ticket_notify_close_${ticket.id}`);
      const recipientChatIds = new Set<number>();
      for (const mod of moderators) {
        recipientChatIds.add(mod.telegramId);
      }
      const moderatorChatId = getModeratorChatId();
      if (moderatorChatId) {
        recipientChatIds.add(moderatorChatId);
      }

      for (const chatId of recipientChatIds) {
        await ctx.api
          .sendMessage(chatId, staffText, {
            parse_mode: "HTML",
            reply_markup: staffKeyboard,
          })
          .catch(() => {});
      }
    }
  } catch (error: any) {
    if (deducted && user) {
      try {
        user.balance += price;
        await usersRepo.save(user);
        session.main.user.balance = user.balance;
      } catch {
        // ignore rollback failure, original error is still returned below
      }
    }
    const errorMessage = error?.message || "Unknown error";
    await ctx.reply(ctx.t("error-unknown", { error: errorMessage }), { parse_mode: "HTML" }).catch(() => {});
  }
}

/**
 * Dedicated OS selection menu (after location). On select: pay and show contact-support message.
 * Also used when navigating from location menu (grammY nav); manual keyboard uses handleDedicatedOsSelect.
 */
export const dedicatedOsMenu = new Menu<AppContext>("dedicated-os-menu")
  .dynamic(async (ctx, range) => {
    for (const osKey of DEDICATED_OS_KEYS) {
      const labelKey = `dedicated-os-${osKey}` as const;
      range
        .text((c) => c.t(labelKey), async (ctx) => {
          await handleDedicatedOsSelect(ctx, osKey);
        })
        .row();
    }
  })
  .row()
  .text((ctx) => ctx.t("button-return-to-main"), async (ctx) => {
    const session = await ctx.session;
    await ctx.editMessageText(
      ctx.t("welcome", { balance: session.main.user.balance }),
      { parse_mode: "HTML", reply_markup: mainMenu }
    );
  });

/**
 * Dedicated server detail menu (shows server info with Order button).
 */
export const dedicatedSelectedServerMenu = new Menu<AppContext>("dedicated-selected-server", {
  onMenuOutdated: (ctx) => {
    ctx.deleteMessage().then();
  },
})
  .row()
  .submenu(
    (ctx) => ctx.t("button-order-dedicated"),
    "dedicated-location-menu",
    async (ctx) => {
      await ctx.editMessageText(ctx.t("dedicated-location-select-title"), {
        parse_mode: "HTML",
      });
    }
  )
  .row()
  .text(
    (ctx) => ctx.t("button-back"),
    async (ctx) => {
      const session = await ctx.session;
      const { showDedicatedShopStep3List } = await import("../domain/dedicated/dedicated-shop-flow.js");
      await showDedicatedShopStep3List(ctx, session.other.dedicatedType?.shopListPage ?? 0);
    }
  );

export const domainQuestion = new StatelessQuestion<AppContext>(
  "domain-pick",
  async (ctx, zone) => {
    if (!ctx.hasChatType("private")) return;
    if (!ctx.message?.text) return;
    const session = await ctx.session;

    const domain = `${ctx.message.text}${zone}`;

    const domainChecker = new DomainChecker();

    const isValid = domainChecker.domainIsValid(domain);

    if (!isValid) {
      await domainQuestion.replyWithHTML(
        ctx,
        ctx.t("domain-invalid", {
          domain: `${escapeUserInput(ctx.message.text)}${zone}`,
        }),
        zone
      );
      return;
    }

    // This code is unreachable
    const isAvailable = await domainChecker.domainIsAvailable(domain);
    if (!isAvailable) return;

    const status = await domainChecker.getStatus(domain);

    if (status === "Available") {
      session.other.domains.lastPickDomain = domain;

      await ctx.reply(
        ctx.t("domain-available", {
          domain: `${escapeUserInput(domain)}`,
        }),
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            ctx.t("button-agree"),
            "agree-buy-domain:" + domain
          ),
        }
      );
    } else {
      // Ask user again
      await domainQuestion.replyWithHTML(
        ctx,
        ctx.t("domain-not-available", {
          domain: `${escapeUserInput(ctx.message.text)}${zone}`,
        }),
        zone
      );
      // ctx.reply(
      //   ctx.t("domain-not-available", {
      //     domain: `${escapeUserInput(ctx.message.text)}${zone}`,
      //   }),
      //   {
      //     parse_mode: "HTML",
      //   }
      // );
    }
  }
);

// Domain Order Stage
export const domainOrderMenu = new Menu<AppContext>(
  "domain-order-menu"
).dynamic((ctx, range) => {});
